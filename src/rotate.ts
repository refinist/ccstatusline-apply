import fs from 'node:fs';
import path from 'node:path';
import {
  applyConfig,
  atomicWrite,
  backupDir,
  defaultConfigPath,
  mergePreserve,
  readJsonIfExists,
  validateConfig,
  type CcStatusConfig
} from './apply.ts';
import {
  installSchedule,
  periodMs,
  scheduleStatus,
  uninstallSchedule,
  type CustomPeriod,
  type Exec,
  type InstallResult,
  type Period,
  type SchedulePeriod,
  type ScheduleState,
  type UninstallResult
} from './scheduler.ts';

export type Strategy = 'cycle' | 'random';

// An optional marker that tags a bundle as one of the editor's built-in plans.
// It rides ALONGSIDE the ordinary period/strategy/themes (a weekly plan really is
// a `day` + `cycle` rotation over seven themes, one per weekday) and never
// changes how the CLI rotates — it's metadata the editor stamps so it can
// recognize its own plan on re-import and restore that mode instead of showing a
// plain daily rotation. Optional and additive, so bundles stay version 1: older
// CLIs simply ignore it and rotate correctly all the same.
export type RotationPreset = 'weekly';

// Mirrors the editor's caps (rotationBundle.ts there) — a bundle that violates
// them was hand-crafted, and the limits keep pools and intervals sane.
export const MAX_CUSTOM_EVERY = 100;
export const MAX_THEMES = 20;

export interface RotationTheme {
  name: string;
  config: CcStatusConfig;
}

/** The rotation bundle the editor exports — the contract between editor and CLI. */
export interface RotationBundle {
  /**
   * Schema version — same field name and idea as ccstatusline's own config
   * `version`, just one level up. 1 is the current (and first) format; newer
   * versions make older CLIs tell the user to upgrade instead of guessing.
   */
  version: 1;
  period: SchedulePeriod;
  strategy: Strategy;
  themes: RotationTheme[];
  /** Built-in plan marker (see RotationPreset); absent for hand-built bundles. */
  preset?: RotationPreset;
}

/** What `rotate on` persists: the bundle plus the pre-rotation snapshot for `rotate off`. */
export interface RotationState extends RotationBundle {
  /** settings.json as it was before rotation was first turned on; null if none existed (or it was unreadable). */
  snapshot: Record<string, unknown> | null;
  /**
   * When rotation was turned on (ISO) — the phase origin for CUSTOM periods:
   * "every 6 hours" counts from this moment, which is both what a user expects
   * and a pure input to the slot math (a stamped config value, not a mutating
   * counter). Preset periods stay calendar-aligned and ignore it.
   */
  anchor: string | null;
}

/**
 * One file holds everything (themes inline, not a themes/ directory): a single
 * atomic write, nothing to keep in sync, and `rotate off` cleans up one path.
 * Lives in ccsa's own dir next to the backups, untouched by ccstatusline upgrades.
 */
export function rotationStatePath(): string {
  return path.join(backupDir(), 'rotation.json');
}

/** Validate a parsed rotation bundle. Throws a friendly, specific error on the first problem. */
export function validateBundle(obj: unknown): asserts obj is RotationBundle {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    throw new Error('rotation bundle must be a JSON object');
  const o = obj as Record<string, unknown>;
  if (!('themes' in o)) {
    // A plain single config pasted here is the likeliest mix-up — point at `apply`.
    if (typeof o.version === 'number' && Array.isArray(o.lines))
      throw new Error(
        'this looks like a single config, not a rotation bundle — use `ccsa apply` instead'
      );
    throw new Error(
      'not a rotation bundle — export one from the CCStatusline editor (https://ccse.refineup.com)'
    );
  }
  if (o.version !== 1)
    throw new Error(
      `rotation bundle version ${String(o.version)} is newer than this ccsa understands — run the latest: npx -y @refinist/ccsa@latest`
    );
  validatePeriod(o.period);
  if (o.strategy !== 'cycle' && o.strategy !== 'random')
    throw new Error('rotation "strategy" must be "cycle" or "random"');
  // Optional plan marker. Only validate the value; we deliberately DON'T enforce
  // that a weekly preset is day/cycle/7-themes — the preset never drives how the
  // CLI rotates (period/strategy/themes do), and a lenient check keeps a
  // hand-tweaked bundle working. The editor is the one that re-checks that shape.
  if (o.preset !== undefined && o.preset !== 'weekly')
    throw new Error('rotation "preset" must be "weekly" when present');
  if (!Array.isArray(o.themes) || o.themes.length === 0)
    throw new Error('rotation "themes" must be a non-empty array');
  if (o.themes.length > MAX_THEMES)
    throw new Error(
      `rotation "themes" holds at most ${MAX_THEMES} themes, got ${o.themes.length}`
    );
  o.themes.forEach((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t))
      throw new Error(
        `theme #${i + 1} must be an object with "name" and "config"`
      );
    const th = t as Record<string, unknown>;
    if (typeof th.name !== 'string' || th.name === '')
      throw new Error(`theme #${i + 1} is missing a "name"`);
    try {
      validateConfig(th.config);
    } catch (e) {
      throw new Error(`theme "${th.name}": ${(e as Error).message}`);
    }
  });
}

// A preset string, or the custom interval {every: 1–100, unit}.
function validatePeriod(p: unknown): asserts p is SchedulePeriod {
  if (p === 'hour' || p === 'day' || p === 'week') return;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const { every, unit } = p as Record<string, unknown>;
    if (unit !== 'minute' && unit !== 'hour' && unit !== 'day')
      throw new Error('custom period "unit" must be "minute", "hour" or "day"');
    if (
      typeof every !== 'number' ||
      !Number.isInteger(every) ||
      every < 1 ||
      every > MAX_CUSTOM_EVERY
    )
      throw new Error(
        `custom period "every" must be an integer from 1 to ${MAX_CUSTOM_EVERY}`
      );
    return;
  }
  throw new Error(
    'rotation "period" must be "hour", "day", "week" or {"every", "unit"}'
  );
}

/** Parse + validate a rotation bundle JSON string. Throws with a friendly message. */
export function parseBundle(jsonText: string): RotationBundle {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(
      `rotation bundle is not valid JSON: ${(e as Error).message}`
    );
  }
  validateBundle(obj);
  return obj;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Sequential number of the time slot `d` falls in. Everything downstream is a pure
 * function of this — no persisted "last theme" counter — so missed, late, or repeated
 * scheduler firings all converge on the same answer instead of drifting.
 */
export function slotIndex(d: Date, period: Period): number {
  if (period === 'hour') return Math.floor(d.getTime() / HOUR_MS);
  // Local calendar day number: day/week slots roll over at the user's local
  // midnight, not UTC's (Date.UTC on local Y/M/D is exactly that day count).
  const days = Math.floor(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS
  );
  // Day 0 (1970-01-01) was a Thursday; +3 aligns week slots to roll over on
  // Monday, matching the weekly triggers the schedulers register.
  return period === 'day' ? days : Math.floor((days + 3) / 7);
}

// Tiny deterministic PRNG (mulberry32). Seeded with the slot index so "random"
// picks a stable theme for the whole slot — every status-line refresh, scheduler
// firing, and `rotate status` within the slot agrees — and Math.random never
// enters the picture.
function mulberry32(seed: number): number {
  let a = seed >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// The anchor's epoch millis; a missing/corrupt anchor degrades to the epoch —
// still deterministic, just not phase-aligned to the rotate-on moment.
function anchorMs(anchor: string | null | undefined): number {
  const t = anchor ? Date.parse(anchor) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// Interval slot for a custom period, counted from the anchor. Clamped at 0 so
// a clock stepping backwards past the anchor can't produce a negative index.
function customSlot(d: Date, period: CustomPeriod, anchor?: string | null) {
  return Math.max(
    0,
    Math.floor((d.getTime() - anchorMs(anchor)) / periodMs(period))
  );
}

/** Which theme is current at `d` — pure function of time, the bundle, and (for custom periods) the anchor. */
export function themeIndexAt(
  d: Date,
  bundle: RotationBundle & { anchor?: string | null }
): number {
  const n = bundle.themes.length;
  const slot =
    typeof bundle.period === 'string'
      ? slotIndex(d, bundle.period)
      : customSlot(d, bundle.period, bundle.anchor);
  return bundle.strategy === 'cycle'
    ? slot % n
    : Math.floor(mulberry32(slot) * n);
}

/** When the next slot starts (local time) — display-only, for `rotate status`. */
export function nextBoundary(
  d: Date,
  period: SchedulePeriod,
  anchor?: string | null
): Date {
  if (typeof period !== 'string')
    return new Date(
      anchorMs(anchor) + (customSlot(d, period, anchor) + 1) * periodMs(period)
    );
  if (period === 'hour')
    return new Date((Math.floor(d.getTime() / HOUR_MS) + 1) * HOUR_MS);
  if (period === 'day')
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const sinceMonday = (d.getDay() + 6) % 7;
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + (7 - sinceMonday)
  );
}

// Key-order-insensitive equality, for "is this theme already applied". Plain
// JSON.stringify comparison would re-apply (and re-back-up) forever on a file
// whose keys were merely reordered by hand.
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map(
        k =>
          `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`
      )
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Read the persisted rotation state; null when rotation is off. Throws on a corrupt file. */
export function readRotationState(
  file: string = rotationStatePath()
): RotationState | null {
  if (!fs.existsSync(file)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(
      `${file} is corrupt — re-run \`ccsa rotate on\` with your bundle (or delete the file)`
    );
  }
  validateBundle(obj);
  // A missing snapshot (hand-edited state) degrades to null rather than erroring —
  // it only costs `rotate off` its restore step.
  const snap = (obj as { snapshot?: unknown }).snapshot ?? null;
  if (snap !== null && (typeof snap !== 'object' || Array.isArray(snap)))
    throw new Error(
      `${file} has a corrupt snapshot — re-run \`ccsa rotate on\` with your bundle`
    );
  // Like the snapshot, a missing anchor degrades instead of erroring: custom
  // periods just fall back to epoch alignment (see anchorMs).
  const rawAnchor = (obj as { anchor?: unknown }).anchor;
  return {
    ...obj,
    snapshot: snap as Record<string, unknown> | null,
    anchor: typeof rawAnchor === 'string' ? rawAnchor : null
  };
}

export interface RotateTickOptions {
  configPath?: string;
  stateFile?: string;
  /** The moment to rotate for (default: now). Injected by tests. */
  now?: Date;
  /**
   * Back up the target before writing (default: false — the opposite of `apply`).
   * Tick writes are machine-generated and reproducible from rotation.json, and an
   * hourly rotation would otherwise flood the pool with 24 useless backups a day.
   * The human-made pre-rotation config is protected by the state's snapshot instead.
   */
  backup?: boolean;
}

export interface RotateTickResult {
  /** false when rotation is off (no state file) — the scheduler race case, not an error. */
  active: boolean;
  /** false when the live file already shows the right theme (idempotent skip). */
  applied: boolean;
  themeName: string | null;
  themeIndex: number | null;
  themeCount: number | null;
}

/** What the scheduled job runs: apply the current slot's theme, or do nothing if it's already live. */
export function rotateTick(opts: RotateTickOptions = {}): RotateTickResult {
  const {
    configPath = defaultConfigPath(),
    stateFile = rotationStatePath(),
    now = new Date(),
    backup = false
  } = opts;

  const state = readRotationState(stateFile);
  if (!state)
    return {
      active: false,
      applied: false,
      themeName: null,
      themeIndex: null,
      themeCount: null
    };

  const idx = themeIndexAt(now, state);
  const theme = state.themes[idx];
  const done = {
    active: true,
    themeName: theme.name,
    themeIndex: idx,
    themeCount: state.themes.length
  };

  // Skip when a write would change nothing: compare against what applyConfig WOULD
  // produce (theme + preserved external keys), so `installation` etc. never count
  // as a difference.
  const current = readJsonIfExists(configPath);
  if (current) {
    const { merged } = mergePreserve(current, theme.config);
    if (stableStringify(merged) === stableStringify(current))
      return { ...done, applied: false };
  }

  applyConfig({ json: JSON.stringify(theme.config), configPath, backup });
  return { ...done, applied: true };
}

// npx runs ccsa out of a cache dir (~/.npm/_npx/<hash>/…) that npm can prune at any
// time — a scheduled job pointing straight there would silently die the moment the
// cache is cleared. So on an npx-cache run, snapshot the CLI into ccsa's own dir
// (next to rotation.json, which nothing prunes) and point the schedule at the copy.
// The published CLI is a single zero-dependency bundle, so one file IS the whole
// program. A normal global/dev install already sits on a stable path — pass through.
function isNpxRun(scriptPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(scriptPath);
}

// Lifted out of the package whose "type":"module" marked it ESM, the copy needs a
// `.mjs` extension or Node would load it as CommonJS and throw on its import syntax.
function pinnedRuntimePath(stateFile: string): string {
  return path.join(path.dirname(stateFile), 'runtime', 'ccsa.mjs');
}

function pinRuntime(scriptPath: string, stateFile: string): string {
  // Version managers (fnm's per-shell ~/.local/state/fnm_multishells/<pid>_<ts>/bin
  // being the live example) put SESSION-scoped symlink dirs on PATH, so argv[1] can
  // point into a directory that dies with the shell that ran `rotate on` — baked
  // into the schedule as-is, the job silently stops the day that link is cleaned
  // up. realpath resolves through every such indirection to the file's stable
  // location; on failure (dangling link, fake test path) keep the given path — no
  // worse than before.
  let real = scriptPath;
  try {
    real = fs.realpathSync(scriptPath);
  } catch {
    /* unresolvable — keep as-is */
  }
  if (!isNpxRun(real)) return real;
  try {
    const dest = pinnedRuntimePath(stateFile);
    atomicWrite(dest, fs.readFileSync(real, 'utf8'), 0o644);
    return dest;
  } catch {
    // Unreadable source, read-only disk… — fall back to the original path so
    // rotation still gets set up. No worse than before pinning existed.
    return real;
  }
}

export interface RotateOnOptions {
  /** The rotation bundle as a JSON string. */
  json: string;
  configPath?: string;
  stateFile?: string;
  now?: Date;
  /** Scheduler plumbing — defaulted from the running process, injected by tests. */
  nodePath?: string;
  scriptPath?: string;
  platform?: NodeJS.Platform;
  exec?: Exec;
  uid?: number;
}

export interface RotateOnResult {
  stateFile: string;
  period: SchedulePeriod;
  strategy: Strategy;
  /** The plan marker this bundle carried, if any (drives the CLI's display only). */
  preset: RotationPreset | null;
  themeCount: number;
  /** The theme applied for the current slot. */
  themeName: string;
  themeIndex: number;
  schedule: InstallResult;
  /** true when this call took the pre-rotation snapshot (vs. an update keeping the original). */
  firstOn: boolean;
  /**
   * Absolute path the scheduled job was pointed at — normally the running CLI's own
   * path, or the pinned copy in ccsa's dir when it ran from an npx cache (see pinRuntime).
   */
  runtimePath: string;
}

/** Turn rotation on (or update it) from an editor bundle — one shot: state, schedule, first apply. */
export function rotateOn(opts: RotateOnOptions): RotateOnResult {
  const {
    json,
    configPath = defaultConfigPath(),
    stateFile = rotationStatePath(),
    now = new Date(),
    nodePath = process.execPath,
    scriptPath = path.resolve(process.argv[1] ?? ''),
    platform = process.platform,
    exec,
    uid
  } = opts;

  const bundle = parseBundle(json);

  // The snapshot is taken exactly once, on the FIRST `rotate on`: a re-run (updated
  // bundle from the editor) keeps the original, otherwise `off` would "restore"
  // whatever rotated theme happened to be live at re-setup time.
  let snapshot: Record<string, unknown> | null = null;
  let firstOn = true;
  let prev: RotationState | null = null;
  try {
    prev = readRotationState(stateFile);
  } catch {
    /* corrupt previous state — a fresh setup overwrites it */
  }
  if (prev) {
    snapshot = prev.snapshot;
    firstOn = false;
  } else {
    const current = readJsonIfExists(configPath);
    try {
      // Only a real ccstatusline config is worth restoring later; a corrupt or
      // foreign file stays snapshot-less (off will just leave the last theme).
      if (current) validateConfig(current);
      snapshot = current;
    } catch {
      snapshot = null;
    }
  }

  // The anchor is re-stamped on every `rotate on` — turning rotation (back) on
  // IS the "count from now" moment a custom period promises. Presets ignore it.
  const state: RotationState = {
    ...bundle,
    snapshot,
    anchor: now.toISOString()
  };
  atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o644);

  // Point the scheduled job at a stable path: an npx-cache run gets pinned into
  // ccsa's own dir first (see pinRuntime); every other install is already stable.
  const runtimePath = pinRuntime(scriptPath, stateFile);

  const schedule = installSchedule({
    period: bundle.period,
    nodePath,
    scriptPath: runtimePath,
    platform,
    exec,
    uid,
    now
  });

  // Apply the current slot's theme right away — NO pool backup. The pre-rotation
  // config is already saved in the snapshot (in rotation.json), which is exactly
  // what `rotate off` restores from, so a second copy in the backup pool would be
  // redundant. It would also be actively unhelpful on a re-run: with `apply`
  // blocked while rotation is on, the live file is only ever a machine-generated
  // theme by then, so backing it up would just be pool noise.
  const tick = rotateTick({ configPath, stateFile, now, backup: false });

  return {
    stateFile,
    period: bundle.period,
    strategy: bundle.strategy,
    preset: bundle.preset ?? null,
    themeCount: bundle.themes.length,
    themeName: tick.themeName!,
    themeIndex: tick.themeIndex!,
    schedule,
    firstOn,
    runtimePath
  };
}

export interface RotateOffOptions {
  configPath?: string;
  stateFile?: string;
  platform?: NodeJS.Platform;
  exec?: Exec;
  uid?: number;
}

export interface RotateOffResult {
  configPath: string;
  stateFile: string;
  /** false when there was no snapshot to restore (rotation started from a blank/foreign file). */
  restored: boolean;
  schedule: UninstallResult;
}

/** Turn rotation off: unregister the schedule, restore the pre-rotation config, delete the state. */
export function rotateOff(opts: RotateOffOptions = {}): RotateOffResult {
  const {
    configPath = defaultConfigPath(),
    stateFile = rotationStatePath(),
    platform = process.platform,
    exec,
    uid
  } = opts;

  if (!fs.existsSync(stateFile))
    throw new Error('rotation is not on — nothing to turn off');

  // A corrupt state file must not block turning rotation off — we then still
  // unregister and delete, just with nothing to restore.
  let snapshot: Record<string, unknown> | null = null;
  try {
    snapshot = readRotationState(stateFile)?.snapshot ?? null;
  } catch {
    /* corrupt — proceed without a restore */
  }

  // Unregister FIRST so no tick fires between the restore below and the state
  // file's removal and immediately re-applies a theme over the restored config.
  const schedule = uninstallSchedule({ platform, exec, uid });

  let restored = false;
  let target = configPath;
  if (snapshot) {
    // Restored through applyConfig — atomic write, symlink- and permission-safe —
    // but with NO pool backup: rotation never writes to the pool (matching rotate
    // on and the ticks). What we overwrite here is just the last rotated theme, a
    // machine artifact; the config we're putting back (the snapshot) is exactly
    // what the user wants, so there is nothing worth pooling.
    const r = applyConfig({
      json: JSON.stringify(snapshot),
      configPath,
      backup: false
    });
    target = r.configPath;
    restored = true;
  }

  fs.unlinkSync(stateFile);
  // Drop the pinned runtime copy too — best-effort, and absent on installs that
  // never needed pinning (rmSync with force ignores a missing dir).
  fs.rmSync(path.join(path.dirname(stateFile), 'runtime'), {
    recursive: true,
    force: true
  });
  return { configPath: target, stateFile, restored, schedule };
}

export interface RotateStatusOptions {
  stateFile?: string;
  now?: Date;
  platform?: NodeJS.Platform;
  exec?: Exec;
  uid?: number;
}

export interface RotateStatusResult {
  active: boolean;
  stateFile: string;
  period: SchedulePeriod | null;
  strategy: Strategy | null;
  /** The active bundle's plan marker, if any (display only). */
  preset: RotationPreset | null;
  themeCount: number | null;
  themeIndex: number | null;
  themeName: string | null;
  /** When the next slot starts; what it will show (cycle/random are deterministic, so we can tell). */
  nextSwitch: Date | null;
  nextThemeName: string | null;
  scheduler: ScheduleState;
}

/** Read-only overview of the rotation: on/off, current + next theme, scheduler registration. */
export function rotateStatus(
  opts: RotateStatusOptions = {}
): RotateStatusResult {
  const {
    stateFile = rotationStatePath(),
    now = new Date(),
    platform = process.platform,
    exec,
    uid
  } = opts;

  const scheduler = scheduleStatus({ platform, exec, uid });
  const state = readRotationState(stateFile);
  if (!state)
    return {
      active: false,
      stateFile,
      period: null,
      strategy: null,
      preset: null,
      themeCount: null,
      themeIndex: null,
      themeName: null,
      nextSwitch: null,
      nextThemeName: null,
      scheduler
    };

  const idx = themeIndexAt(now, state);
  const next = nextBoundary(now, state.period, state.anchor);
  return {
    active: true,
    stateFile,
    period: state.period,
    strategy: state.strategy,
    preset: state.preset ?? null,
    themeCount: state.themes.length,
    themeIndex: idx,
    themeName: state.themes[idx].name,
    nextSwitch: next,
    nextThemeName: state.themes[themeIndexAt(next, state)].name,
    scheduler
  };
}
