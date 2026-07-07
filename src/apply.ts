import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A ccstatusline config. Only the fields we assert on are typed; the rest is open. */
export interface CcStatusConfig {
  version: number;
  lines: unknown[];
  [key: string]: unknown;
}

export interface ApplyOptions {
  /** The config as a JSON string. */
  json: string;
  /**
   * Target file (default: {@link defaultConfigPath}). Not exposed as a CLI flag — the backup
   * pool is keyed by basename only, so pointing two different real files named the same at it
   * (e.g. two `-c` targets) would silently share and shadow each other's backup history. Only
   * override this from code (e.g. tests), where the caller controls that no such collision exists.
   */
  configPath?: string;
  /** Copy the current file to a timestamped backup before writing (default: true). */
  backup?: boolean;
  /** Preserve external keys (installation, …) from the existing file (default: true). */
  merge?: boolean;
}

export interface ApplyResult {
  /** The file actually written (a symlink is resolved to its real target). */
  configPath: string;
  backupPath: string | null;
  existed: boolean;
  preserved: string[];
  wrote: boolean;
}

export interface RestoreOptions {
  /** Target file to restore onto (default: {@link defaultConfigPath}). Same caveat as {@link ApplyOptions.configPath} — not exposed as a CLI flag. */
  configPath?: string;
  /** Save the current file to a timestamped backup before restoring (default: true). */
  backup?: boolean;
}

export interface RestoreResult {
  /** The file actually restored onto (a symlink is resolved to its real target). */
  configPath: string;
  /** Absolute path of the backup that was restored. */
  restoredFrom: string;
  /** Where the current file was saved before restoring, if any. */
  savedCurrent: string | null;
  wrote: boolean;
  /** All backups found, oldest → newest (absolute paths). */
  available: string[];
}

export interface ExportOptions {
  /** Source file to read (default: {@link defaultConfigPath}). Same caveat as {@link ApplyOptions.configPath} — not exposed as a CLI flag. */
  configPath?: string;
}

export interface ExportResult {
  /** The file actually read (a symlink is resolved to its real target). */
  configPath: string;
  /** The file's raw contents, verbatim (not re-serialized) — trailing whitespace trimmed. */
  json: string;
}

export interface CleanOptions {
  /** Config file whose backup pool to clean (default: {@link defaultConfigPath}). Same caveat as {@link ApplyOptions.configPath} — not exposed as a CLI flag. */
  configPath?: string;
}

export interface CleanResult {
  /** Absolute paths of every backup removed, oldest → newest (empty if there were none). */
  removed: string[];
}

export interface ListOptions {
  /** Config file whose pool to list (default: {@link defaultConfigPath}). Same caveat as {@link ApplyOptions.configPath} — not exposed as a CLI flag. */
  configPath?: string;
}

export interface ListedBackup {
  path: string;
  size: number;
}

export interface ListResult {
  /** The live settings file (a symlink is resolved to its real target). */
  configPath: string;
  configExists: boolean;
  /** Size of the live file in bytes, or null if it doesn't exist. */
  configSize: number | null;
  /** The backup pool directory (may not exist yet). */
  backupDir: string;
  /** Backups oldest → newest — the last one is what `restore` rolls back to. */
  backups: ListedBackup[];
}

// ccstatusline reads exactly this file. Upstream (src/utils/config.ts) uses a
// hardcoded `homedir()/.config/ccstatusline/settings.json` with NO XDG_CONFIG_HOME
// or Windows/APPDATA special-casing, so we mirror that 1:1 for every platform.
export function defaultConfigPath(): string {
  const home = os.homedir();
  // os.homedir() can be "" in containers/CI where HOME is unset and the uid has
  // no passwd entry. path.join("", …) would yield a cwd-relative path and we'd
  // scribble a stray file ccstatusline never reads — fail loudly instead.
  if (!home)
    throw new Error('cannot determine your home directory — set $HOME');
  return path.join(home, '.config', 'ccstatusline', 'settings.json');
}

// Where ccsa keeps its own backups — deliberately NOT inside
// ccstatusline's own config dir. ccstatusline's writes (migrations, installation
// metadata, its own saves) only ever touch settings.json itself and never look
// here, so our backup history is never at risk from an upstream upgrade and can
// be freely managed independent of ccstatusline.
export function backupDir(): string {
  const home = os.homedir();
  if (!home)
    throw new Error('cannot determine your home directory — set $HOME');
  return path.join(home, '.config', 'ccsa');
}

// Top-level keys the editor owns and always emits authoritatively. Anything in
// the existing file that is NOT one of these — e.g. ccstatusline's own
// `installation` bookkeeping, or future tool-managed metadata — is grafted back
// when merging, so applying a new config never silently drops it.
const BUILDER_KEYS = new Set<string>([
  'version',
  'lines',
  'flexMode',
  'compactThreshold',
  'colorLevel',
  'inheritSeparatorColors',
  'globalBold',
  'gitCacheTtlSeconds',
  'minimalistMode',
  'defaultSeparator',
  'defaultPadding',
  'overrideForegroundColor',
  'overrideBackgroundColor',
  'refreshInterval',
  'powerline'
]);

/** Cheap sanity check that `obj` looks like a ccstatusline config. Throws if not. */
export function validateConfig(obj: unknown): asserts obj is CcStatusConfig {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    throw new Error('config must be a JSON object');
  const o = obj as Record<string, unknown>;
  // A rotation bundle wraps N configs under `themes` (and shares the "version"
  // key name for its own schema version) — catch the mix-up here with a
  // pointer, before the generic "missing version" error.
  if ('themes' in o)
    throw new Error(
      'this is a rotation bundle, not a single config — use `ccsa rotate on` instead'
    );
  if (typeof o.version !== 'number')
    throw new Error(
      'config is missing a numeric "version" field — is this a ccstatusline config?'
    );
  if (!Array.isArray(o.lines))
    throw new Error(
      'config is missing an array "lines" field — is this a ccstatusline config?'
    );
}

/** Parse + validate a config JSON string. Throws with a friendly message. */
export function parseConfig(jsonText: string): CcStatusConfig {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`config is not valid JSON: ${(e as Error).message}`);
  }
  validateConfig(obj);
  return obj;
}

/**
 * Merge strategy: the new config is authoritative for every key it manages
 * (so clearing an optional field in the editor actually clears it), while keys
 * the editor never emits are carried over from the old file. Preserved keys are
 * appended after the new ones, matching ccstatusline's own key ordering.
 */
export function mergePreserve(
  oldObj: Record<string, unknown> | null | undefined,
  newObj: CcStatusConfig
): { merged: Record<string, unknown>; preserved: string[] } {
  const merged: Record<string, unknown> = { ...newObj };
  const preserved: string[] = [];
  if (oldObj && typeof oldObj === 'object' && !Array.isArray(oldObj)) {
    for (const [k, v] of Object.entries(oldObj)) {
      if (!BUILDER_KEYS.has(k) && !(k in newObj)) {
        merged[k] = v;
        preserved.push(k);
      }
    }
  }
  return { merged, preserved };
}

export function readJsonIfExists(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // Corrupt/unreadable existing file: don't merge from it (we can't trust it),
    // but the caller still backs it up before overwriting so nothing is lost.
    return null;
  }
}

// ---- shared low-level helpers ----

// Local-time stamp `YYYY-MM-DD_HH-MM-SS` — colon-free so it is a valid filename on
// macOS/Windows, and lexically sortable (string order == chronological order).
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

// If the config is a symlink (dotfiles managed by stow/chezmoi are commonly
// symlinked), resolve to the real file so we write THROUGH the link and update
// its target — instead of `rename`-ing a regular file over the link entry, which
// would sever the link and silently orphan the version-controlled original.
function realTarget(configPath: string, exists: boolean): string {
  if (exists) {
    try {
      if (fs.lstatSync(configPath).isSymbolicLink())
        return fs.realpathSync(configPath);
    } catch {
      /* dangling/racy link → write configPath */
    }
  }
  return configPath;
}

// Existing file's permission bits (a user may have chmod 600'd it); a rename
// installs a new inode, so without this every write would reset to 0o644.
function fileMode(file: string, exists: boolean): number {
  if (exists) {
    try {
      return fs.statSync(file).mode & 0o777;
    } catch {
      /* keep default */
    }
  }
  return 0o644;
}

// Atomic write: stage into a temp file in the same dir, then rename over the
// target (a same-filesystem rename is atomic). `beforeRename` runs once the temp
// is fully written but before it replaces the target — used to copy the file
// being overwritten to a backup, so the original survives until the last step.
export function atomicWrite(
  target: string,
  content: string,
  mode: number,
  beforeRename?: () => void
): void {
  const dir = path.dirname(target);
  const base = path.basename(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.chmodSync(tmp, mode);
    beforeRename?.();
    fs.renameSync(tmp, target);
  } finally {
    if (fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// All timestamped backups for `base` in `dir`, oldest → newest (lexical == chrono).
// The optional trailing letter is the same-second collision suffix from uniqueBackupPath.
function backupFiles(dir: string, base: string): string[] {
  const re = new RegExp(
    `^${escapeRe(
      base
    )}\\.\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}[a-z]?\\.json$`
  );
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(n => re.test(n))
    .sort()
    .map(n => path.join(dir, n));
}

// Backup filename for `base` at `d`. Two applies/restores within the same wall-clock
// second (a scripted loop, a fast redo) would otherwise compute the identical filename
// and the second copyFileSync would silently clobber the first — so on collision, append
// a single letter right after the stamp: the bare name (no letter) always sorts before
// any lettered one, and 'a' < 'b' < … among lettered ones, so lexical order stays
// creation order all the way through (backupFiles relies on that).
function uniqueBackupPath(dir: string, base: string, d: Date): string {
  const s = stamp(d);
  for (let n = 0; n <= 26; n++) {
    const suffix = n === 0 ? '' : String.fromCharCode(96 + n); // '', 'a', 'b', … 'z'
    const candidate = path.join(dir, `${base}.${s}${suffix}.json`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `too many backups for ${base} in the same second — try again`
  );
}

/** Apply `json` to a ccstatusline settings file. */
export function applyConfig(opts: ApplyOptions): ApplyResult {
  const {
    json,
    configPath = defaultConfigPath(),
    backup = true,
    merge = true
  } = opts;

  const newObj = parseConfig(json);

  const exists = fs.existsSync(configPath);
  const target = realTarget(configPath, exists);

  // Graft external keys from the existing file (installation, …) onto the new config.
  let finalObj: Record<string, unknown> = newObj;
  let preserved: string[] = [];
  if (merge && exists) {
    const oldObj = readJsonIfExists(target);
    if (oldObj)
      ({ merged: finalObj, preserved } = mergePreserve(oldObj, newObj));
  }

  const content = `${JSON.stringify(finalObj, null, 2)}\n`;

  const base = path.basename(target).replace(/\.json$/i, '');
  const willBackup = exists && backup;
  // A fresh, collision-free filename per apply → backups accumulate, never overwrite each other.
  const backupPath = willBackup
    ? uniqueBackupPath(backupDir(), base, new Date())
    : null;

  const mode = fileMode(target, exists);
  // The pool dir may not exist yet (first backup ever) — atomicWrite only
  // creates the TARGET's directory, so this needs its own mkdir.
  if (backupPath) fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  let backedUp: string | null = null;
  atomicWrite(target, content, mode, () => {
    if (backupPath) {
      fs.copyFileSync(target, backupPath);
      backedUp = backupPath;
    }
  });
  return {
    configPath: target,
    backupPath: backedUp,
    existed: exists,
    preserved,
    wrote: true
  };
}

/** Roll the settings file back to the most recent timestamped backup. */
export function restoreConfig(opts: RestoreOptions = {}): RestoreResult {
  const { configPath = defaultConfigPath(), backup = true } = opts;

  const exists = fs.existsSync(configPath);
  const target = realTarget(configPath, exists);
  const dir = backupDir();
  const base = path.basename(target).replace(/\.json$/i, '');

  const available = backupFiles(dir, base);
  if (available.length === 0) {
    throw new Error(`no backup found in ${dir} — nothing to restore`);
  }
  // Newest backup = the state captured just before the last apply.
  const restoredFrom = available[available.length - 1];
  const content = fs.readFileSync(restoredFrom, 'utf8');

  // Save the current file first (a redo point), so the rollback is itself undoable.
  // uniqueBackupPath only ever returns a name not already on disk, so this can never
  // collide with (and overwrite) restoredFrom itself.
  const curExists = fs.existsSync(target);
  const mode = fileMode(target, curExists);
  let savedCurrent: string | null = null;
  atomicWrite(target, content, mode, () => {
    if (curExists && backup) {
      const savePath = uniqueBackupPath(dir, base, new Date());
      fs.copyFileSync(target, savePath);
      savedCurrent = savePath;
    }
  });
  return {
    configPath: target,
    restoredFrom,
    savedCurrent,
    wrote: true,
    available
  };
}

/** Read the current settings file back out, for round-tripping into the editor. */
export function exportConfig(opts: ExportOptions = {}): ExportResult {
  const { configPath = defaultConfigPath() } = opts;

  const exists = fs.existsSync(configPath);
  const target = realTarget(configPath, exists);
  if (!exists) {
    throw new Error(`no config found at ${target} — nothing to export`);
  }

  const content = fs.readFileSync(target, 'utf8');
  // Fail fast on a corrupt/foreign file instead of handing back garbage to paste
  // into the editor. Returned verbatim (not re-serialized) so formatting/key order
  // survive the round trip untouched.
  parseConfig(content);
  return { configPath: target, json: content.trim() };
}

/** Delete every timestamped backup this config's basename has in the backup pool. */
export function cleanBackups(opts: CleanOptions = {}): CleanResult {
  const { configPath = defaultConfigPath() } = opts;

  const target = realTarget(configPath, fs.existsSync(configPath));
  const base = path.basename(target).replace(/\.json$/i, '');
  const removed = backupFiles(backupDir(), base);
  for (const f of removed) fs.unlinkSync(f);
  return { removed };
}

// A file's size, or 0 if it vanished between listing and stat'ing (racy but harmless
// for a read-only overview — better a 0 than the whole `list` blowing up).
function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Overview of the live config file and every backup in the pool. Read-only. */
export function listBackups(opts: ListOptions = {}): ListResult {
  const { configPath = defaultConfigPath() } = opts;

  const exists = fs.existsSync(configPath);
  const target = realTarget(configPath, exists);
  const base = path.basename(target).replace(/\.json$/i, '');
  const dir = backupDir();
  return {
    configPath: target,
    configExists: exists,
    configSize: exists ? sizeOf(target) : null,
    backupDir: dir,
    backups: backupFiles(dir, base).map(p => ({ path: p, size: sizeOf(p) }))
  };
}
