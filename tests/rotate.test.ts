import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { backupDir, defaultConfigPath } from '../src/apply.ts';
import {
  nextBoundary,
  parseBundle,
  readRotationState,
  rotateOff,
  rotateOn,
  rotateStatus,
  rotateTick,
  rotationStatePath,
  slotIndex,
  themeIndexAt,
  type RotationBundle
} from '../src/rotate.ts';
import { launchAgentPath, LAUNCHD_LABEL } from '../src/scheduler.ts';

function theme(name: string): {
  name: string;
  config: { version: number; lines: unknown[] };
} {
  return { name, config: { version: 3, lines: [[name]] } };
}

function bundle(overrides: Partial<RotationBundle> = {}): RotationBundle {
  const base: RotationBundle = {
    version: 1,
    period: 'day',
    strategy: 'cycle',
    themes: [theme('a'), theme('b'), theme('c')]
  };
  return { ...base, ...overrides };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-rotate-'));
}
// Same isolation trick as the other test files: stub os.homedir(), not $HOME.
function withIsolatedHome<T>(fn: (home: string) => T): T {
  const home = tmpDir();
  const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    return fn(home);
  } finally {
    spy.mockRestore();
  }
}

function recorder() {
  const calls: string[][] = [];
  return {
    calls,
    exec: (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
    }
  };
}

// Scheduler plumbing shared by every rotateOn/Off call in these tests.
function plumbing(exec: (cmd: string, args: string[]) => void) {
  return {
    platform: 'darwin' as const,
    exec,
    uid: 501,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/usr/local/lib/node_modules/@refinist/ccsa/dist/cli.js'
  };
}

// 2026-06-01 is a Monday; fixed clocks keep every assertion deterministic.
const MONDAY = new Date(2026, 5, 1, 12, 0, 0);
const SUNDAY = new Date(2026, 5, 7, 12, 0, 0);

test('parseBundle rejects everything that is not a valid rotation bundle, with pointed messages', () => {
  expect(() => parseBundle('{not json')).toThrow(/valid JSON/);
  expect(() => parseBundle('[]')).toThrow(/JSON object/);
  // a single config pasted where a bundle belongs → point at `apply`
  expect(() => parseBundle('{"version":3,"lines":[]}')).toThrow(/ccsa apply/);
  expect(() => parseBundle('{"foo":1}')).toThrow(/not a rotation bundle/);
  expect(() =>
    parseBundle(JSON.stringify({ ...bundle(), version: 3 }))
  ).toThrow(/npx -y @refinist\/ccsa/);
  expect(() =>
    parseBundle(JSON.stringify({ ...bundle(), period: 'month' }))
  ).toThrow(/"period"/);
  expect(() =>
    parseBundle(JSON.stringify({ ...bundle(), strategy: 'shuffle' }))
  ).toThrow(/"strategy"/);
  expect(() =>
    parseBundle(JSON.stringify({ ...bundle(), themes: [] }))
  ).toThrow(/non-empty/);
  expect(() =>
    parseBundle(
      JSON.stringify({
        ...bundle(),
        themes: [{ name: 'x', config: { nope: 1 } }]
      })
    )
  ).toThrow(/theme "x"/);
  expect(() =>
    parseBundle(
      JSON.stringify({ ...bundle(), themes: [{ config: theme('x').config }] })
    )
  ).toThrow(/missing a "name"/);
});

test('parseBundle accepts the custom period object and rejects malformed ones', () => {
  const custom = (period: unknown) => JSON.stringify({ ...bundle(), period });
  expect(() => parseBundle(custom({ every: 6, unit: 'hour' }))).not.toThrow();
  expect(() => parseBundle(custom({ every: 1, unit: 'minute' }))).not.toThrow();
  expect(() => parseBundle(custom({ every: 100, unit: 'day' }))).not.toThrow();
  expect(() => parseBundle(custom({ every: 0, unit: 'hour' }))).toThrow(
    /1 to 100/
  );
  expect(() => parseBundle(custom({ every: 101, unit: 'hour' }))).toThrow(
    /1 to 100/
  );
  expect(() => parseBundle(custom({ every: 1.5, unit: 'hour' }))).toThrow(
    /integer/
  );
  expect(() => parseBundle(custom({ every: 6, unit: 'week' }))).toThrow(
    /"unit"/
  );
  // version 2 is the future — old CLIs must say "upgrade", not guess
  expect(() =>
    parseBundle(JSON.stringify({ ...bundle(), version: 2 }))
  ).toThrow(/npx -y @refinist\/ccsa/);
});

test('parseBundle caps the pool at 20 themes, mirroring the editor', () => {
  const many = bundle({
    themes: Array.from({ length: 21 }, (_, i) => theme(`t${i}`))
  });
  expect(() => parseBundle(JSON.stringify(many))).toThrow(/at most 20/);
});

test('parseBundle accepts the optional "weekly" preset marker and rejects other values', () => {
  // absent (ordinary bundle) and "weekly" both pass
  expect(parseBundle(JSON.stringify(bundle())).preset).toBeUndefined();
  const weekly = parseBundle(JSON.stringify(bundle({ preset: 'weekly' })));
  expect(weekly.preset).toBe('weekly');
  // any other marker is a hand-edit mistake — reject it
  expect(() =>
    parseBundle(JSON.stringify({ ...bundle(), preset: 'monthly' }))
  ).toThrow(/"preset"/);
});

test('custom periods slot from the anchor: stable within, advancing across', () => {
  const b = {
    ...bundle({ period: { every: 2, unit: 'hour' } }),
    anchor: new Date(2026, 5, 1, 12, 0, 0).toISOString()
  };
  const inSlot0a = themeIndexAt(new Date(2026, 5, 1, 12, 5, 0), b);
  const inSlot0b = themeIndexAt(new Date(2026, 5, 1, 13, 59, 0), b);
  const inSlot1 = themeIndexAt(new Date(2026, 5, 1, 14, 0, 0), b);
  const inSlot3 = themeIndexAt(new Date(2026, 5, 1, 18, 0, 0), b);
  expect(inSlot0a).toBe(0); // cycle starts at the anchor with themes[0]
  expect(inSlot0b).toBe(0);
  expect(inSlot1).toBe(1);
  expect(inSlot3).toBe(0); // 3 themes → wrapped a full lap
  // before the anchor (clock stepped back): clamped, never a negative index
  expect(themeIndexAt(new Date(2026, 5, 1, 8, 0, 0), b)).toBe(0);
});

test('nextBoundary for a custom period lands on anchor + (slot+1) intervals', () => {
  const anchor = new Date(2026, 5, 1, 12, 0, 0);
  const period = { every: 90, unit: 'minute' } as const;
  expect(
    nextBoundary(new Date(2026, 5, 1, 12, 40, 0), period, anchor.toISOString())
  ).toEqual(new Date(2026, 5, 1, 13, 30, 0));
  expect(
    nextBoundary(new Date(2026, 5, 1, 13, 40, 0), period, anchor.toISOString())
  ).toEqual(new Date(2026, 5, 1, 15, 0, 0));
});

test('slotIndex advances by exactly 1 per period and rolls weeks over on Monday', () => {
  const d = new Date(2026, 5, 3, 10, 30, 0); // Wednesday
  expect(slotIndex(new Date(2026, 5, 3, 11, 0, 0), 'hour')).toBe(
    slotIndex(d, 'hour') + 1
  );
  expect(slotIndex(new Date(2026, 5, 4, 10, 30, 0), 'day')).toBe(
    slotIndex(d, 'day') + 1
  );
  // same week Sunday vs next-Monday: the week slot flips between them
  expect(slotIndex(SUNDAY, 'week')).toBe(slotIndex(d, 'week'));
  expect(slotIndex(new Date(2026, 5, 8), 'week')).toBe(
    slotIndex(d, 'week') + 1
  );
});

test('themeIndexAt: cycle walks the list one step per slot, wrapping around', () => {
  const b = bundle(); // 3 themes, daily
  const i0 = themeIndexAt(MONDAY, b);
  const i1 = themeIndexAt(new Date(2026, 5, 2), b);
  const i3 = themeIndexAt(new Date(2026, 5, 4), b);
  expect(i1).toBe((i0 + 1) % 3);
  expect(i3).toBe(i0); // wrapped a full lap
});

test('themeIndexAt: random is stable within a slot and in range across slots', () => {
  const b = bundle({ strategy: 'random' });
  const morning = new Date(2026, 5, 1, 8, 0, 0);
  const evening = new Date(2026, 5, 1, 22, 0, 0);
  expect(themeIndexAt(morning, b)).toBe(themeIndexAt(evening, b)); // same day = same theme
  const seen = new Set<number>();
  for (let day = 1; day <= 30; day++) {
    const i = themeIndexAt(new Date(2026, 5, day), b);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(3);
    seen.add(i);
  }
  expect(seen.size).toBeGreaterThan(1); // it does actually vary day to day
});

test('nextBoundary lands on the next hour / local midnight / Monday midnight', () => {
  const d = new Date(2026, 5, 3, 10, 30, 0); // Wednesday
  expect(nextBoundary(d, 'hour')).toEqual(new Date(2026, 5, 3, 11, 0, 0));
  expect(nextBoundary(d, 'day')).toEqual(new Date(2026, 5, 4));
  expect(nextBoundary(d, 'week')).toEqual(new Date(2026, 5, 8)); // next Monday
});

test('rotateTick applies the slot theme, then skips while it is already showing', () =>
  withIsolatedHome(() => {
    const configPath = defaultConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 3,
        lines: [['before']],
        installation: { method: 'npm' }
      })
    );
    fs.mkdirSync(backupDir(), { recursive: true });
    fs.writeFileSync(
      rotationStatePath(),
      JSON.stringify({ ...bundle(), snapshot: null })
    );

    const first = rotateTick({ now: MONDAY });
    expect(first.active).toBe(true);
    expect(first.applied).toBe(true);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(written.lines).toEqual([[first.themeName]]);
    expect(written.installation).toEqual({ method: 'npm' }); // merge-preserve still applies

    // Same slot again → idempotent skip: no write, no backup churn.
    const before = fs.statSync(configPath).mtimeMs;
    const second = rotateTick({ now: MONDAY });
    expect(second.applied).toBe(false);
    expect(second.themeName).toBe(first.themeName);
    expect(fs.statSync(configPath).mtimeMs).toBe(before);

    // Tick writes are backup-less: rotation never touches the pool (the pre-rotation
    // config is protected by the snapshot instead).
    const backups = fs
      .readdirSync(backupDir())
      .filter(n => n.startsWith('settings.'));
    expect(backups).toEqual([]);
  }));

test('rotateTick reports inactive (not an error) when rotation is off', () =>
  withIsolatedHome(() => {
    expect(rotateTick().active).toBe(false);
  }));

test('rotateOn snapshots the current config, schedules, and applies — one shot', () =>
  withIsolatedHome(() => {
    const configPath = defaultConfigPath();
    const before = {
      version: 3,
      lines: [['hand-made']],
      installation: { method: 'npm' }
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(before));

    const { calls, exec } = recorder();
    const r = rotateOn({
      json: JSON.stringify(bundle()),
      now: MONDAY,
      ...plumbing(exec)
    });

    expect(r.firstOn).toBe(true);
    expect(r.themeCount).toBe(3);
    expect(r.schedule.installed).toBe(true);
    // A normal install path is already stable — nothing gets pinned.
    expect(r.runtimePath).toBe(
      '/usr/local/lib/node_modules/@refinist/ccsa/dist/cli.js'
    );
    expect(fs.existsSync(path.join(backupDir(), 'runtime'))).toBe(false);

    // state file: the bundle + the pre-rotation snapshot + the phase anchor
    const state = readRotationState()!;
    expect(state.snapshot).toEqual(before);
    expect(state.themes.map(t => t.name)).toEqual(['a', 'b', 'c']);
    expect(state.anchor).toBe(MONDAY.toISOString());

    // schedule registered through launchctl with the baked absolute paths
    expect(fs.existsSync(launchAgentPath())).toBe(true);
    expect(calls.at(-1)).toEqual([
      'launchctl',
      'bootstrap',
      'gui/501',
      launchAgentPath()
    ]);

    // today's theme is live; the pre-rotation config is kept ONLY in the snapshot
    // (asserted above) — rotate on takes no pool backup, so the pool stays empty.
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).lines).toEqual([
      [r.themeName]
    ]);
    const backups = fs
      .readdirSync(backupDir())
      .filter(n => n.startsWith('settings.'));
    expect(backups).toHaveLength(0);
  }));

test('the weekly preset marker survives rotateOn → state → rotateStatus', () =>
  withIsolatedHome(() => {
    const { exec } = recorder();
    const r = rotateOn({
      json: JSON.stringify(bundle({ preset: 'weekly' })),
      now: MONDAY,
      ...plumbing(exec)
    });
    expect(r.preset).toBe('weekly');
    // persisted in the state file...
    expect(readRotationState()!.preset).toBe('weekly');
    // ...and reported back by status (so the CLI can show "weekly plan")
    expect(rotateStatus({ now: MONDAY }).preset).toBe('weekly');
  }));

test('rotateOn re-run keeps the ORIGINAL snapshot (off must restore the pre-rotation config)', () =>
  withIsolatedHome(() => {
    const configPath = defaultConfigPath();
    const original = { version: 3, lines: [['original']] };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(original));

    const { exec } = recorder();
    rotateOn({
      json: JSON.stringify(bundle()),
      now: MONDAY,
      ...plumbing(exec)
    });
    // now a theme is live; user re-runs with an updated bundle
    const r2 = rotateOn({
      json: JSON.stringify(bundle({ themes: [theme('x'), theme('y')] })),
      now: MONDAY,
      ...plumbing(exec)
    });
    expect(r2.firstOn).toBe(false);
    expect(readRotationState()!.snapshot).toEqual(original); // NOT the rotated theme
  }));

test("rotateOn pins the CLI into ccsa's dir when it runs from an npx cache", () =>
  withIsolatedHome(home => {
    // Stand in for the prunable npx cache: a real bundle file under ~/.npm/_npx/.
    const npxScript = path.join(
      home,
      '.npm',
      '_npx',
      '0a1b',
      'node_modules',
      '@refinist',
      'ccsa',
      'dist',
      'cli.js'
    );
    fs.mkdirSync(path.dirname(npxScript), { recursive: true });
    fs.writeFileSync(npxScript, '#!/usr/bin/env node\n// ccsa bundle\n');

    const { exec } = recorder();
    const r = rotateOn({
      json: JSON.stringify(bundle()),
      now: MONDAY,
      ...plumbing(exec),
      scriptPath: npxScript
    });

    // The CLI was copied into ccsa's own dir (.mjs, so it still loads as ESM)...
    const pinned = path.join(backupDir(), 'runtime', 'ccsa.mjs');
    expect(r.runtimePath).toBe(pinned);
    expect(fs.readFileSync(pinned, 'utf8')).toBe(
      '#!/usr/bin/env node\n// ccsa bundle\n'
    );
    // ...and the LaunchAgent points at that stable copy, not the prunable npx path.
    const plist = fs.readFileSync(launchAgentPath(), 'utf8');
    expect(plist).toContain(pinned);
    expect(plist).not.toContain('_npx');
  }));

test('rotateOn resolves a per-shell symlink (fnm multishell) to its real target before baking it into the schedule', () =>
  withIsolatedHome(home => {
    // The stable file a version manager's session symlink points at…
    const realScript = path.join(
      home,
      'lib',
      'node_modules',
      '@refinist',
      'ccsa',
      'dist',
      'cli.js'
    );
    fs.mkdirSync(path.dirname(realScript), { recursive: true });
    fs.writeFileSync(realScript, '#!/usr/bin/env node\n');
    // …and the session-scoped link fnm puts on PATH (dies with that shell).
    const shellLink = path.join(
      home,
      '.local',
      'state',
      'fnm_multishells',
      '95854_1783357952366',
      'bin',
      'ccsa'
    );
    fs.mkdirSync(path.dirname(shellLink), { recursive: true });
    fs.symlinkSync(realScript, shellLink);

    const { exec } = recorder();
    const r = rotateOn({
      json: JSON.stringify(bundle()),
      now: MONDAY,
      ...plumbing(exec),
      scriptPath: shellLink
    });

    // The schedule points at the resolved stable path, never the session link.
    // (realpathSync on the expectation too: os.tmpdir() is itself a symlink on macOS.)
    expect(r.runtimePath).toBe(fs.realpathSync(realScript));
    const plist = fs.readFileSync(launchAgentPath(), 'utf8');
    expect(plist).toContain(fs.realpathSync(realScript));
    expect(plist).not.toContain('fnm_multishells');
    // Not an npx run — nothing gets pinned either.
    expect(fs.existsSync(path.join(backupDir(), 'runtime'))).toBe(false);
  }));

test('rotateOff removes the pinned runtime copy', () =>
  withIsolatedHome(home => {
    const npxScript = path.join(
      home,
      '.npm',
      '_npx',
      '0a1b',
      'node_modules',
      '@refinist',
      'ccsa',
      'dist',
      'cli.js'
    );
    fs.mkdirSync(path.dirname(npxScript), { recursive: true });
    fs.writeFileSync(npxScript, '// ccsa\n');

    const { exec } = recorder();
    rotateOn({
      json: JSON.stringify(bundle()),
      now: MONDAY,
      ...plumbing(exec),
      scriptPath: npxScript
    });
    const runtime = path.join(backupDir(), 'runtime');
    expect(fs.existsSync(runtime)).toBe(true);

    rotateOff({ ...plumbing(exec) });
    expect(fs.existsSync(runtime)).toBe(false);
  }));

test('rotateOff restores the snapshot, unregisters, and removes the state file', () =>
  withIsolatedHome(() => {
    const configPath = defaultConfigPath();
    const original = { version: 3, lines: [['original']] };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(original));

    const { calls, exec } = recorder();
    rotateOn({
      json: JSON.stringify(bundle()),
      now: MONDAY,
      ...plumbing(exec)
    });
    calls.length = 0;

    const r = rotateOff({ ...plumbing(exec) });
    expect(r.restored).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(original);
    expect(fs.existsSync(rotationStatePath())).toBe(false);
    expect(fs.existsSync(launchAgentPath())).toBe(false);
    // rotation touched the pool zero times over its whole lifecycle: neither the
    // `on` write nor this `off` restore takes a pool backup (the snapshot covers it).
    expect(
      fs.readdirSync(backupDir()).filter(n => n.startsWith('settings.'))
    ).toEqual([]);
    expect(calls[0]).toEqual([
      'launchctl',
      'bootout',
      `gui/501/${LAUNCHD_LABEL}`
    ]);
  }));

test('rotateOff throws when rotation is not on', () =>
  withIsolatedHome(() => {
    expect(() => rotateOff({ ...plumbing(recorder().exec) })).toThrow(/not on/);
  }));

test('rotateStatus reports the current and next theme while on, and off otherwise', () =>
  withIsolatedHome(() => {
    const probe = { ...plumbing(recorder().exec) };
    expect(rotateStatus({ now: MONDAY, ...probe }).active).toBe(false);

    fs.mkdirSync(backupDir(), { recursive: true });
    fs.writeFileSync(
      rotationStatePath(),
      JSON.stringify({ ...bundle(), snapshot: null })
    );
    const r = rotateStatus({ now: MONDAY, ...probe });
    expect(r.active).toBe(true);
    expect(r.period).toBe('day');
    expect(r.themeCount).toBe(3);
    expect(r.themeName).toBe(bundle().themes[r.themeIndex!].name);
    expect(r.nextSwitch).toEqual(new Date(2026, 5, 2)); // tomorrow, local midnight
    // daily cycle: tomorrow is deterministically the next theme in the list
    expect(r.nextThemeName).toBe(bundle().themes[(r.themeIndex! + 1) % 3].name);
    expect(r.scheduler).toBe('installed'); // probe exec succeeded
  }));
