import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupDir } from './apply.ts';

/** How often the rotation advances — and therefore how often the scheduled job fires. */
export type Period = 'hour' | 'day' | 'week';

/** Schema-v2 custom interval — anchored at rotate-on time (see rotate.ts). */
export type CustomPeriodUnit = 'minute' | 'hour' | 'day';
export interface CustomPeriod {
  every: number;
  unit: CustomPeriodUnit;
}
export type SchedulePeriod = Period | CustomPeriod;

const UNIT_MS: Record<CustomPeriodUnit, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000
};

/** A custom period's length in milliseconds. */
export function periodMs(p: CustomPeriod): number {
  return p.every * UNIT_MS[p.unit];
}

/** Runs a command discarding its output; throws on non-zero exit. Injectable for tests. */
export type Exec = (cmd: string, args: string[]) => void;

export interface SchedulerOptions {
  /** Defaults to process.platform — injected by tests to exercise every branch anywhere. */
  platform?: NodeJS.Platform;
  exec?: Exec;
  /** launchd gui-domain uid. Defaults to process.getuid() — injected by tests (and on Windows, where getuid doesn't exist). */
  uid?: number;
}

export interface InstallOptions extends SchedulerOptions {
  period: SchedulePeriod;
  /** Registration moment — anchors a custom period's Windows trigger. Injected by tests. */
  now?: Date;
  /**
   * Absolute path of the node binary to bake into the job. launchd starts jobs with a
   * minimal PATH (/usr/bin:/bin:…) that never contains fnm/nvm/homebrew installs, so a
   * bare `node` would silently fail — absolute paths sidestep PATH entirely.
   */
  nodePath: string;
  /** Absolute path of this CLI's entry script (dist/cli.js when installed, src/cli.ts in dev). */
  scriptPath: string;
}

export interface InstallResult {
  installed: boolean;
  /** What was registered: the plist path (macOS) or the task name (Windows); '' when unsupported. */
  detail: string;
  /** Manual-setup instructions when this platform has no supported scheduler. */
  hint: string | null;
}

export interface UninstallResult {
  removed: boolean;
  /** What was removed (plist path / task name); '' when unsupported or nothing found. */
  detail: string;
}

export type ScheduleState = 'installed' | 'not-installed' | 'unsupported';

export const LAUNCHD_LABEL = 'com.refineup.ccsa.rotate';
export const WINDOWS_TASK = 'ccsa-rotate';

const defaultExec: Exec = (cmd, args) => {
  execFileSync(cmd, args, { stdio: 'ignore' });
};

function guiUid(uid?: number): number {
  const u = uid ?? process.getuid?.();
  if (u === undefined)
    throw new Error('cannot determine the current uid for launchctl');
  return u;
}

/** Where the launchd job definition lives — the per-user LaunchAgents dir. */
export function launchAgentPath(): string {
  const home = os.homedir();
  if (!home)
    throw new Error('cannot determine your home directory — set $HOME');
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Fire hourly on the hour; daily/weekly at 00:05 local time — five past, so a machine
// waking up right around midnight still lands after the slot boundary. Missed firings
// are not lost: launchd runs a missed StartCalendarInterval once on wake, and
// RunAtLoad covers "logged in after the scheduled time". `ccsa rotate` is idempotent,
// so the occasional extra firing is harmless.
function calendarInterval(period: Period): string {
  if (period === 'hour')
    return '<dict><key>Minute</key><integer>0</integer></dict>';
  const daily =
    '<key>Hour</key><integer>0</integer><key>Minute</key><integer>5</integer>';
  return period === 'day'
    ? `<dict>${daily}</dict>`
    : `<dict><key>Weekday</key><integer>1</integer>${daily}</dict>`; // 1 = Monday, matching the week-slot alignment in rotate.ts
}

/** The launchd job definition. Pure — exported so tests can assert on the exact XML. */
export function launchdPlist(
  nodePath: string,
  scriptPath: string,
  period: SchedulePeriod
): string {
  // Presets fire on calendar boundaries; a custom period is a plain interval,
  // which launchd expresses directly as StartInterval seconds.
  const trigger =
    typeof period === 'string'
      ? `<key>StartCalendarInterval</key>\n  ${calendarInterval(period)}`
      : `<key>StartInterval</key><integer>${periodMs(period) / 1000}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>rotate</string>
  </array>
  ${trigger}
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

// Task Scheduler triggers need a concrete StartBoundary. Presets use a fixed
// date in the past — valid forever, and it keeps the generated XML
// deterministic (testable, diffable); 2026-01-05 is a Monday, anchoring the
// weekly trigger to Monday like everywhere else. Custom periods instead take
// the registration moment as their boundary, so the firing phase matches the
// rotate-on anchor the slot math uses.
function taskTrigger(period: SchedulePeriod, startBoundary: string): string {
  if (typeof period !== 'string') {
    // Repetition intervals cap at 31 days, so day-unit periods go through
    // ScheduleByDay (which takes any DaysInterval) instead.
    if (period.unit === 'day')
      return `<CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <ScheduleByDay><DaysInterval>${period.every}</DaysInterval></ScheduleByDay>
    </CalendarTrigger>`;
    const iso =
      period.unit === 'minute' ? `PT${period.every}M` : `PT${period.every}H`;
    return `<TimeTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Repetition><Interval>${iso}</Interval></Repetition>
    </TimeTrigger>`;
  }
  if (period === 'hour')
    return `<TimeTrigger>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition><Interval>PT1H</Interval></Repetition>
    </TimeTrigger>`;
  if (period === 'day')
    return `<CalendarTrigger>
      <StartBoundary>2026-01-01T00:05:00</StartBoundary>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>`;
  return `<CalendarTrigger>
      <StartBoundary>2026-01-05T00:05:00</StartBoundary>
      <ScheduleByWeek>
        <DaysOfWeek><Monday/></DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>`;
}

// Task Scheduler's StartBoundary format: local time, no timezone suffix.
function localBoundary(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * The Windows scheduled-task definition, registered via `schtasks /Create /XML`.
 * XML instead of plain /SC flags because only XML can express what we need in ONE
 * user-level task: StartWhenAvailable (catch up after sleep), a LogonTrigger
 * (catch up at login), and InteractiveToken + LeastPrivilege (current user only,
 * no password prompt, no UAC). Pure — exported for tests.
 */
export function windowsTaskXml(
  nodePath: string,
  scriptPath: string,
  period: SchedulePeriod,
  startBoundary = '2026-01-01T00:05:00'
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Rotate the ccstatusline theme (managed by @refinist/ccsa)</Description>
  </RegistrationInfo>
  <Triggers>
    ${taskTrigger(period, startBoundary)}
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodePath)}</Command>
      <Arguments>"${xmlEscape(scriptPath)}" rotate</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// cron lines for platforms we don't manage ourselves — same cadence as the real schedulers.
const CRON_LINE: Record<Period, string> = {
  hour: '5 * * * *',
  day: '5 0 * * *',
  week: '5 0 * * 1'
};

/**
 * Register the user-level scheduled job that runs `ccsa rotate` every period.
 * macOS: a LaunchAgent plist (expect the one-time "background item added" system
 * notification on Ventura+ — informational, nothing to approve). Windows: a Task
 * Scheduler task. Elsewhere: not managed — returns a cron hint instead of failing,
 * so rotation itself still works for anyone willing to wire their own cron.
 */
export function installSchedule(opts: InstallOptions): InstallResult {
  const {
    period,
    nodePath,
    scriptPath,
    platform = process.platform,
    exec = defaultExec
  } = opts;

  if (platform === 'darwin') {
    const plist = launchAgentPath();
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, launchdPlist(nodePath, scriptPath, period));
    const uid = guiUid(opts.uid);
    // Re-registering an already-loaded label fails, so always unload first;
    // "not loaded" is the normal first-run case, hence ignored.
    try {
      exec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
    } catch {
      /* not loaded yet — fine */
    }
    exec('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    return { installed: true, detail: plist, hint: null };
  }

  if (platform === 'win32') {
    // schtasks reads the XML from a file, not stdin — stage it under our own config
    // dir (NOT os.tmpdir: keeps tests home-isolated) and clean it up right after.
    const xmlFile = path.join(backupDir(), `${WINDOWS_TASK}.xml`);
    fs.mkdirSync(path.dirname(xmlFile), { recursive: true });
    fs.writeFileSync(
      xmlFile,
      windowsTaskXml(
        nodePath,
        scriptPath,
        period,
        // Presets keep their fixed deterministic boundary (the default);
        // custom periods anchor their firing phase at the registration moment.
        typeof period === 'string'
          ? undefined
          : localBoundary(opts.now ?? new Date())
      )
    );
    try {
      exec('schtasks.exe', [
        '/Create',
        '/TN',
        WINDOWS_TASK,
        '/XML',
        xmlFile,
        '/F'
      ]);
    } finally {
      try {
        fs.unlinkSync(xmlFile);
      } catch {
        /* best-effort cleanup */
      }
    }
    return { installed: true, detail: WINDOWS_TASK, hint: null };
  }

  const command = `"${nodePath}" "${scriptPath}" rotate`;
  const cron = cronLine(period);
  return {
    installed: false,
    detail: '',
    hint: cron
      ? `no scheduler support for ${platform} — add a cron entry yourself:\n  ${cron} ${command}`
      : `no scheduler support for ${platform} — run this every ` +
        `${(period as CustomPeriod).every} ${(period as CustomPeriod).unit}(s) with your own scheduler:\n  ${command}`
  };
}

// cron can only express intervals that divide the clock evenly; anything else
// (e.g. every 90 minutes) has no single crontab line, hence the null fallback.
function cronLine(period: SchedulePeriod): string | null {
  if (typeof period === 'string') return CRON_LINE[period];
  const { every, unit } = period;
  if (unit === 'minute' && 60 % every === 0) return `*/${every} * * * *`;
  if (unit === 'hour' && 24 % every === 0) return `5 */${every} * * *`;
  // day-of-month `*/n` resets at each month's end — only n=1 is truly periodic
  if (unit === 'day' && every === 1) return '5 0 * * *';
  return null;
}

/** Unregister the scheduled job and remove its definition. Safe to call when nothing is registered. */
export function uninstallSchedule(
  opts: SchedulerOptions = {}
): UninstallResult {
  const { platform = process.platform, exec = defaultExec } = opts;

  if (platform === 'darwin') {
    const plist = launchAgentPath();
    let removed = false;
    try {
      exec('launchctl', [
        'bootout',
        `gui/${guiUid(opts.uid)}/${LAUNCHD_LABEL}`
      ]);
      removed = true;
    } catch {
      /* not loaded — still remove the file below */
    }
    if (fs.existsSync(plist)) {
      fs.unlinkSync(plist);
      removed = true;
    }
    return { removed, detail: removed ? plist : '' };
  }

  if (platform === 'win32') {
    try {
      exec('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK, '/F']);
      return { removed: true, detail: WINDOWS_TASK };
    } catch {
      return { removed: false, detail: '' };
    }
  }

  return { removed: false, detail: '' };
}

/** Whether the scheduled job is currently registered. Read-only. */
export function scheduleStatus(opts: SchedulerOptions = {}): ScheduleState {
  const { platform = process.platform, exec = defaultExec } = opts;

  if (platform === 'darwin') {
    try {
      exec('launchctl', ['print', `gui/${guiUid(opts.uid)}/${LAUNCHD_LABEL}`]);
      return 'installed';
    } catch {
      return 'not-installed';
    }
  }

  if (platform === 'win32') {
    try {
      exec('schtasks.exe', ['/Query', '/TN', WINDOWS_TASK]);
      return 'installed';
    } catch {
      return 'not-installed';
    }
  }

  return 'unsupported';
}
