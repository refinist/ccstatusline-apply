import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  applyConfig,
  backupDir,
  cleanBackups,
  defaultConfigPath,
  exportConfig,
  listBackups,
  mergePreserve,
  parseConfig,
  restoreConfig,
  validateConfig,
  type CcStatusConfig
} from '../src/apply.ts';

const CONFIG: CcStatusConfig = {
  version: 3,
  lines: [[]],
  powerline: { enabled: false }
};
const JSON_STR = JSON.stringify(CONFIG);
// Trailing letter is the same-second collision suffix (see uniqueBackupPath).
const BACKUP_RE = /^settings\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}[a-z]?\.json$/;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-apply-'));
}
function backupsIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(n => BACKUP_RE.test(n));
  } catch {
    return [];
  }
}

// backupDir() resolves from os.homedir() — stub it (not $HOME: Windows'
// os.homedir() reads %USERPROFILE%, not $HOME, so an env-var override
// silently no-ops there and every test ends up sharing the real home dir).
function withIsolatedHome<T>(fn: () => T): T {
  const spy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir());
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

test('defaultConfigPath points at ~/.config/ccstatusline/settings.json', () => {
  expect(defaultConfigPath()).toBe(
    path.join(os.homedir(), '.config', 'ccstatusline', 'settings.json')
  );
});

test('validateConfig accepts a valid config and rejects junk', () => {
  expect(() => validateConfig(CONFIG)).not.toThrow();
  expect(() => validateConfig(null)).toThrow();
  expect(() => validateConfig([])).toThrow();
  expect(() => validateConfig({ lines: [] })).toThrow(/version/);
  expect(() => validateConfig({ version: 3 })).toThrow(/lines/);
});

test('parseConfig throws a friendly error on bad JSON', () => {
  expect(() => parseConfig('{not json')).toThrow(/valid JSON/);
});

test('mergePreserve keeps external keys and lets new config win', () => {
  const old = {
    version: 3,
    lines: [['old']],
    installation: { method: 'auto-update' },
    defaultSeparator: '|'
  };
  const next: CcStatusConfig = {
    version: 3,
    lines: [['new']],
    powerline: { enabled: true }
  };
  const { merged, preserved } = mergePreserve(old, next);
  // new config is authoritative for managed keys...
  expect(merged.lines).toEqual([['new']]);
  expect('defaultSeparator' in merged).toBe(false); // cleared in new → not carried over
  // ...but unknown/external keys are preserved
  expect(merged.installation).toEqual({ method: 'auto-update' });
  expect(preserved).toEqual(['installation']);
  // preserved keys are appended last (matches ccstatusline ordering)
  expect(Object.keys(merged).at(-1)).toBe('installation');
});

test('applyConfig writes a fresh file with no backup', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  const r = applyConfig({ json: JSON_STR, configPath: target });
  expect(r.wrote).toBe(true);
  expect(r.backupPath).toBe(null);
  expect(r.existed).toBe(false);
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(CONFIG);
});

test('applyConfig backs up an existing file (timestamped) into the pool dir and preserves installation', () =>
  withIsolatedHome(() => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    const existing = {
      version: 3,
      lines: [['x']],
      powerline: { enabled: false },
      installation: { method: 'auto-update', packageManager: 'npm' }
    };
    fs.writeFileSync(target, JSON.stringify(existing, null, 2));

    const r = applyConfig({ json: JSON_STR, configPath: target });
    expect(r.wrote).toBe(true);
    expect(path.dirname(r.backupPath!)).toBe(backupDir()); // pool dir, NOT next to the target
    expect(path.basename(r.backupPath!)).toMatch(BACKUP_RE);
    expect(r.preserved).toEqual(['installation']);

    // backup holds the old config verbatim
    expect(JSON.parse(fs.readFileSync(r.backupPath!, 'utf8'))).toEqual(
      existing
    );
    // new file is our config + preserved installation
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(written.lines).toEqual(CONFIG.lines);
    expect(written.installation).toEqual(existing.installation);
  }));

test('applyConfig disambiguates backups within the same second (regression: silent overwrite)', () =>
  withIsolatedHome(() => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2024, 0, 1, 0, 0, 0));
      const dir = tmpDir();
      const target = path.join(dir, 'settings.json');
      fs.writeFileSync(
        target,
        JSON.stringify({ version: 3, lines: [['original']] })
      );

      const r1 = applyConfig({
        json: JSON.stringify({ version: 3, lines: [['call1']] }),
        configPath: target
      });
      const r2 = applyConfig({
        json: JSON.stringify({ version: 3, lines: [['call2']] }),
        configPath: target
      });

      expect(r1.backupPath).not.toBe(r2.backupPath); // distinct files, second didn't clobber the first
      expect(JSON.parse(fs.readFileSync(r1.backupPath!, 'utf8')).lines).toEqual(
        [['original']]
      );
      expect(JSON.parse(fs.readFileSync(r2.backupPath!, 'utf8')).lines).toEqual(
        [['call1']]
      );
      // both stay visible to `restore`, in creation order
      expect(backupsIn(backupDir())).toEqual([
        path.basename(r1.backupPath!),
        path.basename(r2.backupPath!)
      ]);
    } finally {
      vi.useRealTimers();
    }
  }));

test('applyConfig --no-merge drops installation', () =>
  withIsolatedHome(() => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    fs.writeFileSync(
      target,
      JSON.stringify({ version: 3, lines: [], installation: { method: 'x' } })
    );
    const r = applyConfig({ json: JSON_STR, configPath: target, merge: false });
    expect(r.preserved).toEqual([]);
    expect('installation' in JSON.parse(fs.readFileSync(target, 'utf8'))).toBe(
      false
    );
  }));

test('applyConfig backs up a corrupt existing file but does not merge from it', () =>
  withIsolatedHome(() => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    fs.writeFileSync(target, '{ this is not valid json');
    const r = applyConfig({ json: JSON_STR, configPath: target });
    expect(r.wrote).toBe(true);
    expect(r.preserved).toEqual([]); // couldn't read old → nothing preserved
    expect(fs.readFileSync(r.backupPath!, 'utf8')).toBe(
      '{ this is not valid json'
    ); // still backed up
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(CONFIG);
  }));

test('applyConfig rejects an invalid config without touching the target', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, JSON.stringify({ version: 3, lines: [] }));
  const before = fs.readFileSync(target, 'utf8');
  expect(() =>
    applyConfig({ json: '{"nope":true}', configPath: target })
  ).toThrow(/version/);
  expect(fs.readFileSync(target, 'utf8')).toBe(before);
  expect(backupsIn(dir).length).toBe(0);
});

test('applyConfig writes through a symlinked config and keeps the link', () =>
  withIsolatedHome(() => {
    const linkDir = tmpDir();
    const realDir = tmpDir(); // stand-in for a dotfiles repo
    const realFile = path.join(realDir, 'settings.json');
    const link = path.join(linkDir, 'settings.json');
    const existing = {
      version: 3,
      lines: [['old']],
      installation: { method: 'x' }
    };
    fs.writeFileSync(realFile, JSON.stringify(existing));
    fs.symlinkSync(realFile, link);

    const r = applyConfig({ json: JSON_STR, configPath: link });
    expect(r.wrote).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true); // link preserved, not clobbered
    const written = JSON.parse(fs.readFileSync(realFile, 'utf8'));
    expect(written.lines).toEqual(CONFIG.lines); // real target updated…
    expect(written.installation).toEqual(existing.installation); // …with installation preserved
    // backup goes to the pool dir, NOT next to the real (symlinked-to) target
    expect(backupsIn(realDir).length).toBe(0);
    const backups = backupsIn(backupDir());
    expect(backups.length).toBe(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(backupDir(), backups[0]), 'utf8'))
    ).toEqual(existing);
  }));

test('applyConfig preserves the existing file permission bits', () =>
  withIsolatedHome(() => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    fs.writeFileSync(target, JSON.stringify({ version: 3, lines: [] }));
    fs.chmodSync(target, 0o600);
    applyConfig({ json: JSON_STR, configPath: target });
    // Windows has no POSIX permission bits — chmod/stat only round-trip the
    // read-only attribute there, so 0o600 doesn't survive as a literal value.
    if (process.platform !== 'win32')
      expect(fs.statSync(target).mode & 0o777).toBe(0o600); // not reset to 0o644
  }));

test('restoreConfig rolls back to the newest backup and saves the current first', () =>
  withIsolatedHome(() => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    const older = { version: 3, lines: [['older']] };
    const newer = { version: 3, lines: [['newer']] };
    const current = { version: 3, lines: [['current']] };
    fs.mkdirSync(backupDir(), { recursive: true });
    // Fixed past timestamps so "newest" is deterministic and never collides with now.
    fs.writeFileSync(
      path.join(backupDir(), 'settings.2020-01-01_10-00-00.json'),
      JSON.stringify(older)
    );
    fs.writeFileSync(
      path.join(backupDir(), 'settings.2020-01-01_11-00-00.json'),
      JSON.stringify(newer)
    );
    fs.writeFileSync(target, JSON.stringify(current));

    const r = restoreConfig({ configPath: target });
    expect(r.wrote).toBe(true);
    expect(path.basename(r.restoredFrom)).toBe(
      'settings.2020-01-01_11-00-00.json'
    ); // newest wins
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(newer); // rolled back
    expect(r.savedCurrent).toBeTruthy(); // redo point saved
    expect(JSON.parse(fs.readFileSync(r.savedCurrent!, 'utf8'))).toEqual(
      current
    );
  }));

test('restoreConfig disambiguates the "save current" backup when it collides with restoredFrom (regression: silent overwrite)', () =>
  withIsolatedHome(() => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2024, 0, 1, 0, 0, 0));
      const dir = tmpDir();
      const target = path.join(dir, 'settings.json');
      const older = { version: 3, lines: [['older']] };
      const current = { version: 3, lines: [['current']] };
      fs.mkdirSync(backupDir(), { recursive: true });
      // Same second the "now" clock is frozen at, so the save-current step below would
      // (pre-fix) compute this exact filename for its own backup.
      const restoredFromPath = path.join(
        backupDir(),
        'settings.2024-01-01_00-00-00.json'
      );
      fs.writeFileSync(restoredFromPath, JSON.stringify(older));
      fs.writeFileSync(target, JSON.stringify(current));

      const r = restoreConfig({ configPath: target });
      expect(r.restoredFrom).toBe(restoredFromPath);
      expect(r.savedCurrent).not.toBe(restoredFromPath); // didn't clobber what it just restored from
      expect(JSON.parse(fs.readFileSync(r.restoredFrom, 'utf8'))).toEqual(
        older
      ); // still intact
      expect(JSON.parse(fs.readFileSync(r.savedCurrent!, 'utf8'))).toEqual(
        current
      ); // current safely saved
    } finally {
      vi.useRealTimers();
    }
  }));

test('restoreConfig throws when there is no backup', () =>
  withIsolatedHome(() => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    fs.writeFileSync(target, JSON.stringify({ version: 3, lines: [] }));
    expect(() => restoreConfig({ configPath: target })).toThrow(/no backup/);
  }));

test('cleanBackups deletes every backup for this config and reports what it removed', () =>
  withIsolatedHome(() => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    fs.mkdirSync(backupDir(), { recursive: true });
    const a = path.join(backupDir(), 'settings.2020-01-01_10-00-00.json');
    const b = path.join(backupDir(), 'settings.2020-01-01_11-00-00.json');
    fs.writeFileSync(a, JSON_STR);
    fs.writeFileSync(b, JSON_STR);
    fs.writeFileSync(target, JSON_STR);

    const r = cleanBackups({ configPath: target });
    expect(r.removed.sort()).toEqual([a, b].sort());
    expect(backupsIn(backupDir())).toEqual([]);
    expect(fs.existsSync(target)).toBe(true); // the live file itself is never touched
  }));

test('cleanBackups is a no-op when there are no backups', () =>
  withIsolatedHome(() => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    fs.writeFileSync(target, JSON_STR);
    const r = cleanBackups({ configPath: target });
    expect(r.removed).toEqual([]);
  }));

test("cleanBackups only removes backups matching this config's basename", () =>
  withIsolatedHome(() => {
    const dir = tmpDir();
    const target = path.join(dir, 'settings.json');
    fs.mkdirSync(backupDir(), { recursive: true });
    const mine = path.join(backupDir(), 'settings.2020-01-01_10-00-00.json');
    const other = path.join(backupDir(), 'other.2020-01-01_10-00-00.json');
    fs.writeFileSync(mine, JSON_STR);
    fs.writeFileSync(other, JSON_STR);
    fs.writeFileSync(target, JSON_STR);

    const r = cleanBackups({ configPath: target });
    expect(r.removed).toEqual([mine]);
    expect(fs.existsSync(other)).toBe(true); // a different config's backups are untouched
  }));

test('exportConfig reads the current file back out verbatim', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  const raw = '{\n  "version":   3,\n  "lines": []\n}'; // odd spacing, on purpose
  fs.writeFileSync(target, raw);
  const r = exportConfig({ configPath: target });
  expect(r.configPath).toBe(target);
  expect(r.json).toBe(raw); // verbatim — not re-serialized, no reformatting
});

test('exportConfig resolves a symlinked config to its real target', () => {
  const linkDir = tmpDir();
  const realDir = tmpDir();
  const realFile = path.join(realDir, 'settings.json');
  const link = path.join(linkDir, 'settings.json');
  fs.writeFileSync(realFile, JSON_STR);
  fs.symlinkSync(realFile, link);
  const r = exportConfig({ configPath: link });
  expect(r.configPath).toBe(fs.realpathSync(realFile)); // e.g. macOS /var -> /private/var
  expect(r.json).toBe(JSON_STR);
});

test('exportConfig throws when there is no config to export', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  expect(() => exportConfig({ configPath: target })).toThrow(/no config found/);
});

test('exportConfig throws on a corrupt/foreign file instead of exporting garbage', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{ this is not valid json');
  expect(() => exportConfig({ configPath: target })).toThrow(/valid JSON/);

  fs.writeFileSync(target, JSON.stringify({ notACcstatuslineConfig: true }));
  expect(() => exportConfig({ configPath: target })).toThrow(/version/);
});

test('defaultConfigPath throws when the home directory is empty', () => {
  const saved = process.env.HOME;
  try {
    process.env.HOME = '';
    // Only assert where an empty HOME actually yields an empty homedir (POSIX).
    if (os.homedir() === '')
      expect(() => defaultConfigPath()).toThrow(/home directory/);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
});

test('listBackups reports the live config and the pool, oldest → newest', () => {
  withIsolatedHome(() => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'settings.json');

    // Nothing applied yet: no config, empty pool.
    let r = listBackups({ configPath });
    expect(r.configExists).toBe(false);
    expect(r.configSize).toBe(null);
    expect(r.backups).toEqual([]);
    expect(r.backupDir).toBe(backupDir());

    // Two applies → the first has nothing to back up, the second backs up the first.
    applyConfig({ json: JSON_STR, configPath });
    applyConfig({
      json: JSON.stringify({ version: 3, lines: [] }),
      configPath
    });

    r = listBackups({ configPath });
    expect(r.configExists).toBe(true);
    expect(r.configSize).toBeGreaterThan(0);
    expect(r.backups).toHaveLength(1);
    expect(path.basename(r.backups[0].path)).toMatch(BACKUP_RE);
    expect(r.backups[0].size).toBeGreaterThan(0);
  });
});
