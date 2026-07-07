import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  installSchedule,
  launchAgentPath,
  LAUNCHD_LABEL,
  launchdPlist,
  scheduleStatus,
  uninstallSchedule,
  WINDOWS_TASK,
  windowsTaskXml,
  type Period
} from '../src/scheduler.ts';

const NODE = '/opt/fnm/node-versions/v24.0.0/installation/bin/node';
const SCRIPT = '/usr/local/lib/node_modules/@refinist/ccsa/dist/cli.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-sched-'));
}
// Same isolation trick as the other test files: stub os.homedir(), not $HOME
// (Windows' homedir reads %USERPROFILE% and would ignore $HOME).
function withIsolatedHome<T>(fn: (home: string) => T): T {
  const home = tmpDir();
  const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    return fn(home);
  } finally {
    spy.mockRestore();
  }
}

/** Records every exec call; throws for commands listed in `failing`. */
function recorder(failing: string[] = []) {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (failing.some(f => [cmd, ...args].join(' ').includes(f)))
      throw new Error('exit 1');
  };
  return { calls, exec };
}

test('launchdPlist bakes absolute node + script paths and the rotate command', () => {
  const plist = launchdPlist(NODE, SCRIPT, 'day');
  expect(plist).toContain(`<string>${NODE}</string>`);
  expect(plist).toContain(`<string>${SCRIPT}</string>`);
  expect(plist).toContain('<string>rotate</string>');
  expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  expect(plist).toContain('<key>RunAtLoad</key><true/>'); // catch-up at login
});

test('launchdPlist fires per period: hourly on the hour, daily/weekly at 00:05, weeks on Monday', () => {
  expect(launchdPlist(NODE, SCRIPT, 'hour')).toContain(
    '<dict><key>Minute</key><integer>0</integer></dict>'
  );
  const day = launchdPlist(NODE, SCRIPT, 'day');
  expect(day).toContain('<key>Hour</key><integer>0</integer>');
  expect(day).toContain('<key>Minute</key><integer>5</integer>');
  expect(day).not.toContain('Weekday');
  expect(launchdPlist(NODE, SCRIPT, 'week')).toContain(
    '<key>Weekday</key><integer>1</integer>'
  );
});

test('launchdPlist expresses a custom period as StartInterval seconds', () => {
  const plist = launchdPlist(NODE, SCRIPT, { every: 90, unit: 'minute' });
  expect(plist).toContain('<key>StartInterval</key><integer>5400</integer>');
  expect(plist).not.toContain('StartCalendarInterval');
  expect(plist).toContain('<key>RunAtLoad</key><true/>'); // catch-up unchanged
  expect(launchdPlist(NODE, SCRIPT, { every: 6, unit: 'hour' })).toContain(
    '<integer>21600</integer>'
  );
});

test('windowsTaskXml custom triggers: repetition for minutes/hours, ScheduleByDay for days', () => {
  const boundary = '2026-07-06T09:30:00';
  const minutes = windowsTaskXml(
    NODE,
    SCRIPT,
    { every: 90, unit: 'minute' },
    boundary
  );
  expect(minutes).toContain(`<StartBoundary>${boundary}</StartBoundary>`);
  expect(minutes).toContain('<Interval>PT90M</Interval>');
  expect(
    windowsTaskXml(NODE, SCRIPT, { every: 6, unit: 'hour' }, boundary)
  ).toContain('<Interval>PT6H</Interval>');
  // Repetition intervals cap at 31 days — day units ride ScheduleByDay instead
  const days = windowsTaskXml(
    NODE,
    SCRIPT,
    { every: 45, unit: 'day' },
    boundary
  );
  expect(days).toContain('<DaysInterval>45</DaysInterval>');
  expect(days).not.toContain('Repetition');
});

test('installSchedule (Windows, custom period) anchors the boundary at the registration moment', () =>
  withIsolatedHome(() => {
    let xml = '';
    const r = installSchedule({
      period: { every: 3, unit: 'hour' },
      nodePath: NODE,
      scriptPath: SCRIPT,
      platform: 'win32',
      now: new Date(2026, 6, 6, 9, 30, 0),
      exec: (_cmd, args) => {
        const i = args.indexOf('/XML');
        if (i !== -1) xml = fs.readFileSync(args[i + 1], 'utf8');
      }
    });
    expect(r.installed).toBe(true);
    expect(xml).toContain('<StartBoundary>2026-07-06T09:30:00</StartBoundary>');
    expect(xml).toContain('<Interval>PT3H</Interval>');
  }));

test('cron hints: clock-dividing customs get a line, awkward ones get plain instructions', () => {
  const base = {
    nodePath: NODE,
    scriptPath: SCRIPT,
    platform: 'linux' as const
  };
  expect(
    installSchedule({ ...base, period: { every: 15, unit: 'minute' } }).hint
  ).toContain('*/15 * * * *');
  expect(
    installSchedule({ ...base, period: { every: 6, unit: 'hour' } }).hint
  ).toContain('5 */6 * * *');
  // 90 minutes has no single crontab line — fall back to instructions
  const odd = installSchedule({
    ...base,
    period: { every: 90, unit: 'minute' }
  });
  expect(odd.hint).toContain('every 90 minute');
  expect(odd.hint).not.toContain('* * *');
});

test('launchdPlist escapes XML-hostile characters in paths', () => {
  const plist = launchdPlist('/x/node', '/Users/a&b <c>/cli.js', 'day');
  expect(plist).toContain('/Users/a&amp;b &lt;c&gt;/cli.js');
  expect(plist).not.toContain('a&b');
});

test('windowsTaskXml is a current-user, no-password, catch-up-capable task', () => {
  for (const period of ['hour', 'day', 'week'] as Period[]) {
    const xml = windowsTaskXml(NODE, SCRIPT, period);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>'); // no stored password
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>'); // no UAC
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>'); // run missed firings
    expect(xml).toContain('<LogonTrigger>'); // catch-up at login
    expect(xml).toContain(`<Command>${NODE}</Command>`);
    expect(xml).toContain(`<Arguments>"${SCRIPT}" rotate</Arguments>`);
  }
});

test('windowsTaskXml trigger matches the period', () => {
  expect(windowsTaskXml(NODE, SCRIPT, 'hour')).toContain(
    '<Interval>PT1H</Interval>'
  );
  expect(windowsTaskXml(NODE, SCRIPT, 'day')).toContain(
    '<DaysInterval>1</DaysInterval>'
  );
  const week = windowsTaskXml(NODE, SCRIPT, 'week');
  expect(week).toContain('<Monday/>');
  expect(week).toContain('<WeeksInterval>1</WeeksInterval>');
});

test('installSchedule (macOS) writes the plist and bootstraps it, unloading any old copy first', () =>
  withIsolatedHome(() => {
    const { calls, exec } = recorder(['bootout']); // first run: nothing loaded yet
    const r = installSchedule({
      period: 'day',
      nodePath: NODE,
      scriptPath: SCRIPT,
      platform: 'darwin',
      exec,
      uid: 501
    });
    expect(r.installed).toBe(true);
    expect(r.detail).toBe(launchAgentPath());
    expect(fs.readFileSync(launchAgentPath(), 'utf8')).toBe(
      launchdPlist(NODE, SCRIPT, 'day')
    );
    // bootout failing (not loaded) must not stop the bootstrap
    expect(calls).toEqual([
      ['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', launchAgentPath()]
    ]);
  }));

test('installSchedule (Windows) registers via a staged XML file and cleans it up', () =>
  withIsolatedHome(home => {
    const { calls, exec } = recorder();
    let xmlAtCreateTime = '';
    const r = installSchedule({
      period: 'hour',
      nodePath: NODE,
      scriptPath: SCRIPT,
      platform: 'win32',
      exec: (cmd, args) => {
        // capture the staged file's contents while it still exists
        const i = args.indexOf('/XML');
        if (i !== -1) xmlAtCreateTime = fs.readFileSync(args[i + 1], 'utf8');
        exec(cmd, args);
      }
    });
    expect(r.installed).toBe(true);
    expect(r.detail).toBe(WINDOWS_TASK);
    expect(calls[0].slice(0, 3)).toEqual(['schtasks.exe', '/Create', '/TN']);
    expect(calls[0]).toContain('/F');
    expect(xmlAtCreateTime).toBe(windowsTaskXml(NODE, SCRIPT, 'hour'));
    // staged under our own dir (home-isolated), removed afterwards
    const staged = path.join(home, '.config', 'ccsa', `${WINDOWS_TASK}.xml`);
    expect(fs.existsSync(staged)).toBe(false);
  }));

test('installSchedule on an unsupported platform degrades to a cron hint', () => {
  const { calls, exec } = recorder();
  const r = installSchedule({
    period: 'week',
    nodePath: NODE,
    scriptPath: SCRIPT,
    platform: 'linux',
    exec
  });
  expect(r.installed).toBe(false);
  expect(r.hint).toContain('5 0 * * 1'); // weekly cadence, Monday
  expect(r.hint).toContain(SCRIPT);
  expect(calls).toEqual([]); // nothing executed
});

test('uninstallSchedule (macOS) boots the job out and deletes the plist', () =>
  withIsolatedHome(() => {
    fs.mkdirSync(path.dirname(launchAgentPath()), { recursive: true });
    fs.writeFileSync(launchAgentPath(), 'x');
    const { calls, exec } = recorder();
    const r = uninstallSchedule({ platform: 'darwin', exec, uid: 501 });
    expect(r.removed).toBe(true);
    expect(fs.existsSync(launchAgentPath())).toBe(false);
    expect(calls).toEqual([
      ['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`]
    ]);
  }));

test('uninstallSchedule reports removed:false when nothing was registered', () =>
  withIsolatedHome(() => {
    const mac = uninstallSchedule({
      platform: 'darwin',
      exec: recorder(['bootout']).exec,
      uid: 501
    });
    expect(mac.removed).toBe(false);

    const win = uninstallSchedule({
      platform: 'win32',
      exec: recorder(['/Delete']).exec
    });
    expect(win.removed).toBe(false);
  }));

test('scheduleStatus maps the probe result per platform', () => {
  expect(
    scheduleStatus({ platform: 'darwin', exec: recorder().exec, uid: 501 })
  ).toBe('installed');
  expect(
    scheduleStatus({
      platform: 'darwin',
      exec: recorder(['print']).exec,
      uid: 501
    })
  ).toBe('not-installed');
  expect(scheduleStatus({ platform: 'win32', exec: recorder().exec })).toBe(
    'installed'
  );
  expect(
    scheduleStatus({ platform: 'win32', exec: recorder(['/Query']).exec })
  ).toBe('not-installed');
  expect(scheduleStatus({ platform: 'linux', exec: recorder().exec })).toBe(
    'unsupported'
  );
});
