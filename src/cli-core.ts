import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyConfig,
  cleanBackups,
  exportConfig,
  listBackups,
  restoreConfig
} from './apply.ts';
import {
  rotateOff,
  rotateOn,
  rotateStatus,
  rotateTick,
  rotationStatePath,
  type RotationPreset
} from './rotate.ts';
import type { SchedulePeriod } from './scheduler.ts';

const pkg = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };

export const HELP: string = `ccsa v${pkg.version} — write a config to ~/.config/ccstatusline/settings.json

USAGE
  ccsa apply <json|base64>      apply a config (raw JSON, or base64)
  ccsa apply -f <path>          apply a config from a JSON file
  <cmd> | ccsa apply --stdin    apply a config from stdin
  ccsa list                     show the current config and every backup
  ccsa restore                  roll back to the most recent backup
  ccsa export                   print the current config (and copy it)
  ccsa clean                    delete every backup
  ccsa rotate on <bundle>       turn on theme rotation (bundle from the editor)
  ccsa rotate off               turn it off and restore your previous config
  ccsa rotate status            current theme, next switch, schedule state

\`apply\` is the default command, so it may be omitted: \`ccsa '<json>'\` works too.

OPTIONS
  -f, --file <path>     read config from a JSON file
      --stdin           read config from stdin
      --no-backup       skip the timestamped backup
      --no-merge        replace the whole file (drop "installation" & unknown keys)
      --force           apply/restore even while rotation is on (it gets reverted on the next switch)
  -h, --help            show this help
  -v, --version         print version

Every write backs up the current file to ~/.config/ccsa/settings.<date>.json first (own
directory, untouched by ccstatusline upgrades), merges in ccstatusline-managed keys like
"installation" (skip with --no-merge), and follows symlinks while preserving permissions.
\`restore\` rolls back to the newest backup — itself backed up first, so it's undoable too.
Changes apply on the next status line refresh, no restart needed.

\`export\` prints the current config to stdout (pipe/redirect it like any command) and,
when run directly in a terminal, also copies it to the clipboard — paste it back into
the CCStatusline editor (https://ccse.refineup.com) to keep adjusting.

\`clean\` deletes every backup for this config — irreversible, and \`restore\` then has
nothing left to roll back to. The live settings.json itself is never touched.

\`rotate on\` takes a rotation bundle (same -f/--stdin inputs as apply), saves your
current config, registers a user-level scheduled job (launchd on macOS, Task Scheduler
on Windows) that re-runs \`ccsa rotate\` every hour/day/week, and applies the current
theme immediately. \`rotate off\` unregisters the job and puts your saved config back —
a full undo. Bare \`ccsa rotate\` is what the scheduler runs; it is idempotent and
never touches the file when the right theme is already showing.

While rotation is on, \`apply\` and \`restore\` are blocked: rotation owns settings.json, so
either write would be reverted at the next switch and can't touch rotation's saved config.
Run \`ccsa rotate off\` first (the clean way), or pass \`--force\` to write anyway.`;

export interface Options {
  /** Defaults to 'apply' when no command word is given — the tool's main job. */
  command: 'apply' | 'list' | 'restore' | 'export' | 'clean' | 'rotate';
  /** rotate's subcommand; null for the bare `ccsa rotate` tick the scheduler runs. */
  sub: 'on' | 'off' | 'status' | null;
  file: string | null;
  stdin: boolean;
  backup: boolean;
  merge: boolean;
  /** Override the "rotation is on" guard on apply/restore. */
  force: boolean;
  help: boolean;
  version: boolean;
  _: string[];
}

// Split `--flag=value` into `--flag value` so both spellings work.
export function normalize(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--') && a.includes('=')) {
      const i = a.indexOf('=');
      out.push(a.slice(0, i), a.slice(i + 1));
    } else {
      out.push(a);
    }
  }
  return out;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    command: 'apply',
    sub: null,
    file: null,
    stdin: false,
    backup: true,
    merge: true,
    force: false,
    help: false,
    version: false,
    _: []
  };
  // Consume the next token as a flag's value, refusing a missing one or another
  // flag. Without this, `-f` at the end silently falls back to no file, and
  // `-f --no-merge` would eat the --no-merge flag — both defeat the tool's safety.
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || (v.length > 1 && v.startsWith('-')))
      throw new Error(`option ${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        o.help = true;
        break;
      case '-v':
      case '--version':
        o.version = true;
        break;
      case '--stdin':
        o.stdin = true;
        break;
      case '--no-backup':
        o.backup = false;
        break;
      case '--no-merge':
        o.merge = false;
        break;
      case '--force':
        o.force = true;
        break;
      case '-f':
      case '--file':
        o.file = value(++i, a);
        break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
        // The command word, if any, is always argv[0] — `ccsa restore`,
        // not `ccsa --restore`. Anywhere else, a bare word is the
        // positional JSON/base64 for the default `apply` command (so a raw config
        // that happens to start with neither `{` nor a flag still passes through).
        if (
          i === 0 &&
          (a === 'apply' ||
            a === 'list' ||
            a === 'restore' ||
            a === 'export' ||
            a === 'clean' ||
            a === 'rotate')
        ) {
          o.command = a;
          break;
        }
        // rotate's subcommand is the first bare word after it (`ccsa rotate on <json>`);
        // anything after that — the bundle — is a positional like everywhere else.
        if (
          o.command === 'rotate' &&
          o.sub === null &&
          o._.length === 0 &&
          (a === 'on' || a === 'off' || a === 'status')
        ) {
          o.sub = a;
          break;
        }
        o._.push(a);
    }
  }
  return o;
}

// Resolve the config JSON text from (in priority order): --file, a positional
// arg (raw JSON if it starts with "{", else base64), or explicit --stdin.
// stdin is opt-in: auto-detecting it via isTTY is unreliable (mintty) and can
// throw an opaque EAGAIN, so we never read fd 0 unless asked.
export function resolveInput(o: Options): string | null {
  if (o.file) return fs.readFileSync(o.file, 'utf8');
  const pos = o._[0];
  if (pos != null && pos !== '') {
    const t = pos.trim();
    return t.startsWith('{') ? t : Buffer.from(t, 'base64').toString('utf8');
  }
  if (o.stdin) return fs.readFileSync(0, 'utf8');
  return null;
}

// Zero-dep ANSI styling, decided per stream: `export` pipes its JSON through
// stdout while its status goes to stderr, so each stream checks its own TTY.
// NO_COLOR (https://no-color.org) turns everything off.
export interface Style {
  ok: (s: string) => string;
  bad: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
}
export function makeStyle(stream: { isTTY?: boolean }): Style {
  const on = Boolean(stream.isTTY) && !process.env.NO_COLOR;
  const wrap = (open: number, close: number) => (s: string) =>
    on ? `\u001b[${open}m${s}\u001b[${close}m` : s;
  return {
    ok: wrap(32, 39), // green
    bad: wrap(31, 39), // red
    bold: wrap(1, 22),
    dim: wrap(2, 22)
  };
}

// Shorten "/Users/you/…" to "~/…" — every path this tool prints lives under
// the home directory, so the long prefix is pure noise.
function tildify(p: string): string {
  const home = os.homedir();
  return home && (p === home || p.startsWith(home + path.sep))
    ? `~${p.slice(home.length)}`
    : p;
}

// One aligned detail line: a dim label column, then the value.
const detail = (s: Style, label: string, value: string): string =>
  `  ${s.dim(label.padEnd(10))}${value}`;

// Human file size. These are small JSON files — B/kB is all we'll ever need.
const fmtSize = (n: number): string =>
  n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;

// Local "2026-07-04 15:00" for `rotate status` — same locale-free style as the
// backup stamps, minutes are plenty for slot boundaries.
function fmtWhen(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const PERIOD_LABEL = {
  hour: 'every hour',
  day: 'every day',
  week: 'every week'
} as const;

// Human label for either period shape: a preset string or {every, unit}.
function periodLabel(p: SchedulePeriod): string {
  if (typeof p === 'string') return PERIOD_LABEL[p];
  return `every ${p.every} ${p.unit}${p.every === 1 ? '' : 's'}`;
}

// The dim one-liner after "rotation on" for both `rotate on` and `rotate status`.
// A weekly plan reads as "weekly plan · N themes, cycle strategy" (its period is
// always `day`, so spelling out "every day" would only be noise); every other
// bundle keeps the full "N themes, <period>, <strategy> strategy" shape.
function rotationSummary(
  preset: RotationPreset | null,
  themeCount: number,
  period: SchedulePeriod,
  strategy: string
): string {
  const themes = `${themeCount} theme${themeCount === 1 ? '' : 's'}`;
  return preset === 'weekly'
    ? `— weekly plan · ${themes}, ${strategy} strategy`
    : `— ${themes}, ${periodLabel(period)}, ${strategy} strategy`;
}

// Best-effort clipboard copy via whatever native utility the platform has —
// zero npm deps, matches this package's design. Silently gives up if none is
// found or the copy fails; `export`'s stdout output is the reliable fallback
// (`ccsa export | pbcopy`) either way.
function copyToClipboard(text: string): boolean {
  const candidates: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']]
          ];
  for (const [cmd, args] of candidates) {
    try {
      execFileSync(cmd, args, {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore']
      });
      return true;
    } catch {
      /* try the next candidate, or give up */
    }
  }
  return false;
}

// apply/restore mutate the live settings.json, but while rotation is on that file
// belongs to the rotation: the next scheduled tick would revert either write, and
// neither goes through rotation's own snapshot — so a `restore` here is not even a
// real undo of rotation (that's `rotate off`). Block by default with a pointer to
// the clean exit; --force is the escape hatch for a deliberate, will-be-overwritten
// write. Existence of the state file (not a full parse) is the signal — a corrupt
// rotation.json still means the scheduler is registered and would clobber the write.
// The guard lives HERE, at the CLI command layer, not in applyConfig/restoreConfig:
// rotation's own internals (rotateTick, rotateOn, rotateOff) call those library
// functions directly and must stay unguarded, or rotation could never write at all.
function blockedByRotation(command: string, force: boolean, err: Style): boolean {
  if (force || !fs.existsSync(rotationStatePath())) return false;
  console.error(
    `${err.bad('✗')} rotation is on — ${err.bold(`ccsa ${command}`)} would be reverted at the next theme switch.`
  );
  console.error(
    `  Run ${err.bold('ccsa rotate off')} first to restore your pre-rotation config, or add ${err.bold('--force')} to write anyway.`
  );
  process.exitCode = 1;
  return true;
}

/** Run the CLI. Throws on bad args / write failure; the bin entry prints & sets exit code. */
export function run(argv: string[]): void {
  if (argv.length === 0) {
    console.log(HELP);
    return;
  }
  const o = parseArgs(normalize(argv));
  if (o.help) {
    console.log(HELP);
    return;
  }
  if (o.version) {
    console.log(pkg.version);
    return;
  }

  const out = makeStyle(process.stdout);
  const err = makeStyle(process.stderr);

  if (o.command === 'export') {
    const r = exportConfig();
    // stdout carries ONLY the JSON, so this stays pipeable/redirectable
    // (`export | pbcopy`, `export > out.json`); all status goes to stderr.
    console.log(r.json);
    if (process.stdout.isTTY) {
      // Piping already IS the copy step, so only auto-copy for an interactive run.
      if (copyToClipboard(r.json))
        console.error(`${err.ok('✓')} copied to clipboard`);
    }
    console.error(detail(err, 'source', tildify(r.configPath)));
    console.error(
      err.dim(
        '  Paste it into the CCStatusline editor (https://ccse.refineup.com) to keep adjusting your config.'
      )
    );
    return;
  }

  if (o.command === 'list') {
    const r = listBackups();
    console.log(
      `${out.ok('✓')} ${out.dim('current'.padEnd(10))}${
        r.configExists
          ? `${out.bold(tildify(r.configPath))}  ${out.dim(fmtSize(r.configSize ?? 0))}`
          : out.dim('(none — nothing applied yet)')
      }`
    );
    if (r.backups.length === 0) {
      console.log(
        detail(out, 'backups', out.dim(`(none in ${tildify(r.backupDir)})`))
      );
      console.log(
        out.dim(
          '  A backup is created automatically each time you apply a config.'
        )
      );
    } else {
      console.log(
        detail(
          out,
          'backups',
          `${r.backups.length} in ${tildify(r.backupDir)}, oldest first`
        )
      );
      for (const b of r.backups)
        console.log(
          `    ${path.basename(b.path).padEnd(36)}${out.dim(fmtSize(b.size))}`
        );
      console.log(
        out.dim(
          '  The newest backup is what `ccsa restore` rolls back to; `ccsa clean` deletes them all.'
        )
      );
    }
    return;
  }

  if (o.command === 'restore') {
    if (blockedByRotation('restore', o.force, err)) return;
    const r = restoreConfig({ backup: o.backup });
    console.log(`${out.ok('✓')} restored ${out.bold(tildify(r.configPath))}`);
    console.log(detail(out, 'from', tildify(r.restoredFrom)));
    if (r.savedCurrent)
      console.log(detail(out, 'saved', tildify(r.savedCurrent)));
    console.log(
      out.dim(
        '  Takes effect on the next status line refresh — run `ccsa restore` again to go one step further back.'
      )
    );
    return;
  }

  if (o.command === 'clean') {
    const r = cleanBackups();
    if (r.removed.length === 0) {
      console.log(`${out.ok('✓')} nothing to clean — no backups found`);
    } else {
      console.log(
        `${out.ok('✓')} removed ${r.removed.length} backup${r.removed.length === 1 ? '' : 's'}`
      );
      for (const f of r.removed) console.log(out.dim(`  ${tildify(f)}`));
    }
    return;
  }

  if (o.command === 'rotate') {
    runRotate(o, out, err);
    return;
  }

  if (blockedByRotation('apply', o.force, err)) return;

  const json = resolveInput(o);
  if (json == null || json.trim() === '') {
    console.error(
      `${err.bad('✗')} no config provided — see ${err.bold('ccsa --help')} for usage`
    );
    process.exitCode = 1;
    return;
  }

  const r = applyConfig({
    json,
    backup: o.backup,
    merge: o.merge
  });

  console.log(`${out.ok('✓')} wrote ${out.bold(tildify(r.configPath))}`);
  if (r.backupPath) console.log(detail(out, 'backup', tildify(r.backupPath)));
  if (r.preserved.length)
    console.log(detail(out, 'preserved', r.preserved.join(', ')));
  console.log(
    out.dim(
      '  Takes effect on the next status line refresh — undo anytime with `ccsa restore`.'
    )
  );
}

function runRotate(o: Options, out: Style, err: Style): void {
  if (o.sub === 'on') {
    const json = resolveInput(o);
    if (json == null || json.trim() === '') {
      console.error(
        `${err.bad('✗')} no rotation bundle provided — export one from the CCStatusline editor (https://ccse.refineup.com)`
      );
      process.exitCode = 1;
      return;
    }
    const r = rotateOn({ json });
    console.log(
      `${out.ok('✓')} rotation on ${out.dim(
        rotationSummary(r.preset, r.themeCount, r.period, r.strategy)
      )}`
    );
    console.log(
      detail(
        out,
        'applied',
        `${r.themeName} (${r.themeIndex + 1}/${r.themeCount})`
      )
    );
    console.log(detail(out, 'state', tildify(r.stateFile)));
    console.log(
      detail(
        out,
        'schedule',
        r.schedule.installed
          ? tildify(r.schedule.detail)
          : out.dim('(not registered)')
      )
    );
    if (r.schedule.hint) console.log(out.dim(`  ${r.schedule.hint}`));
    console.log(
      out.dim(
        '  Themes now switch automatically — undo everything with `ccsa rotate off`.'
      )
    );
    return;
  }

  if (o.sub === 'off') {
    const r = rotateOff();
    console.log(`${out.ok('✓')} rotation off`);
    if (r.restored)
      console.log(
        detail(
          out,
          'restored',
          `${tildify(r.configPath)} (pre-rotation config)`
        )
      );
    else
      console.log(
        detail(out, 'restored', out.dim('(no pre-rotation config to restore)'))
      );
    console.log(detail(out, 'removed', tildify(r.stateFile)));
    console.log(
      out.dim(
        '  The scheduled job is unregistered — turn it back on anytime with `ccsa rotate on`.'
      )
    );
    return;
  }

  if (o.sub === 'status') {
    const r = rotateStatus();
    if (!r.active) {
      console.log(
        `${out.dim('rotation is off')} — turn it on with a bundle from the editor: ${out.bold('ccsa rotate on -f <file>')}`
      );
      return;
    }
    console.log(
      `${out.ok('✓')} rotation on ${out.dim(
        rotationSummary(r.preset, r.themeCount!, r.period!, r.strategy!)
      )}`
    );
    console.log(
      detail(
        out,
        'current',
        `${r.themeName} (${r.themeIndex! + 1}/${r.themeCount})`
      )
    );
    console.log(
      detail(out, 'next', `${fmtWhen(r.nextSwitch!)} → ${r.nextThemeName}`)
    );
    console.log(detail(out, 'schedule', r.scheduler));
    console.log(detail(out, 'state', tildify(r.stateFile)));
    return;
  }

  // Bare `ccsa rotate` — the tick the scheduler fires.
  if (o._.length > 0)
    throw new Error(
      `unknown rotate subcommand: ${o._[0]} (expected on, off or status)`
    );
  const r = rotateTick();
  if (!r.active) {
    // Not an error: a straggler firing after `rotate off` should exit 0 quietly.
    console.log(out.dim('rotation is off — nothing to do'));
    return;
  }
  if (r.applied)
    console.log(
      `${out.ok('✓')} switched to ${out.bold(r.themeName!)} (${r.themeIndex! + 1}/${r.themeCount})`
    );
  else
    console.log(out.dim(`${r.themeName} is already showing — nothing to do`));
}
