<p align="center">
  <img src="logo.png" alt="ccsa logo" width="300" />
</p>

<h1 align="center">@refinist/ccsa</h1>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  Apply a <a href="https://github.com/refinist/ccstatusline-editor">ccstatusline-editor</a> config to
  <code>~/.config/ccstatusline/settings.json</code>, with an automatic backup of the old file.
</p>

<p align="center">
  <a href="https://ccse.refineup.com"><strong>Build a config in the editor →</strong></a>
</p>

## Usage

```sh
# Paste the JSON the editor gives you (single-quoted, one line) — `apply` is
# the default command, so it can be omitted:
npx -y @refinist/ccsa@latest '{"version":3,"lines":[[]]}'

# …or point it at a downloaded config file:
npx -y @refinist/ccsa@latest -f ./ccstatusline-settings.json

# …or pipe JSON in:
cat ccstatusline-settings.json | npx -y @refinist/ccsa@latest --stdin

# See the current config and every backup:
npx -y @refinist/ccsa@latest list

# Undo — roll back to the most recent backup:
npx -y @refinist/ccsa@latest restore

# Pull your current config back out (auto-copies to your clipboard), to keep
# adjusting it in the editor:
npx -y @refinist/ccsa@latest export

# Delete every backup ccsa has made for this config:
npx -y @refinist/ccsa@latest clean
```

## What it does

Apply a [ccstatusline](https://github.com/sirmalloc/ccstatusline) config produced by
[**ccstatusline-editor**](https://github.com/refinist/ccstatusline-editor) straight to your
local `~/.config/ccstatusline/settings.json` — with an automatic, timestamped backup of the
previous file.

The editor runs in the browser, which can't write to disk. This tiny CLI is the bridge:
copy one command from the editor, run it, done. The next status line refresh picks it up —
no restart, no wrapper script, no editing `~/.claude/settings.json`.

1. Parses and sanity-checks the config (must be a JSON object with `version` + `lines`).
2. Locates `~/.config/ccstatusline/settings.json` (creating the folder if needed).
3. Copies the current file to a timestamped `~/.config/ccsa/settings.<YYYY-MM-DD_HH-MM-SS>.json`
   backup — a directory of its own, separate from ccstatusline's config dir, so an upstream
   ccstatusline upgrade never touches your backup history.
4. **Preserves** keys ccstatusline manages itself — notably `installation` — so applying a new
   config never drops the tool's own bookkeeping. Everything the editor manages is replaced.
5. Writes the new file atomically (temp file + rename), **preserving the file's permission bits**.

Each apply keeps its own backup — they're never overwritten, so you can always go back.
`restore` rolls the settings file back to the **newest** backup, saving the current file
first, so the rollback is itself undoable — which means each `restore` adds one more backup
of its own rather than just toggling between two files; the pool only shrinks if you run
`clean`.

`export` reads the current settings file back out and prints it verbatim (not
reformatted) to stdout — the other direction of the bridge, for when you want to keep
adjusting an already-applied config in the editor. Run in a terminal, it also tries to
copy the JSON straight to your clipboard (`pbcopy` / `clip` / `wl-copy` / `xclip` / `xsel`,
whichever the platform has); piped or redirected (`export | pbcopy`, `export > out.json`),
only stdout carries the JSON so it composes like any other Unix command.

`clean` deletes every backup in the pool for this config — irreversible, and `restore` has
nothing left afterward. The live `settings.json` itself is never touched.

Extra safety:

- If the config is a **symlink** (dotfiles managed by stow/chezmoi), it's written _through_ the
  link — the link is kept and its real target is updated, not replaced by a regular file.
- If the existing file is corrupt, it's still backed up but not merged from.
- stdin is opt-in: it's only read with `--stdin` (never auto-detected).

## Commands

| Command                | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `apply <json\|base64>` | Apply a config (raw JSON or base64)                               |
| `list`                 | Show the current config and every backup in the pool              |
| `restore`              | Roll back to the newest `settings.<date>.json` backup             |
| `export`               | Print the current config to stdout (and copy it to the clipboard) |
| `clean`                | Delete every backup in the pool for this config                   |

`apply` is the default command, so the word itself may be omitted:
`ccsa '<json>'` does the same thing. A command word, if given, must come
first: `ccsa restore`, not `ccsa --restore`.

## Options

| Option              | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `-f, --file <path>` | Read config from a JSON file (for `apply`)                                |
| `--stdin`           | Read config from stdin (for `apply`)                                      |
| `--no-backup`       | Skip the timestamped backup (for `apply` / `restore`)                     |
| `--no-merge`        | Replace the whole file (drop `installation` & unknown keys) (for `apply`) |
| `-h, --help`        | Show help                                                                 |
| `-v, --version`     | Print version                                                             |

The positional argument is treated as raw JSON if it starts with `{`, otherwise as base64.

## Config location

`ccstatusline` reads a hardcoded `~/.config/ccstatusline/settings.json` on every platform —
there is no `XDG_CONFIG_HOME` or Windows `APPDATA` special-casing — so this tool always targets
that exact path (there's no `--config` override: a config written anywhere else is a file
ccstatusline would never read anyway). Backups live in their own `~/.config/ccsa/`
directory (same `homedir()/.config/…` scheme, just a different folder), independent of
ccstatusline. To test against a throwaway path, override `$HOME` for the invocation (see
"Local development" below).

## Local development

No build or `npx` needed — Node 24 runs the TypeScript sources directly:

```sh
node src/cli.ts --help                                              # run the CLI
HOME=/tmp/ccsl-test node src/cli.ts '{"version":3,"lines":[[]]}'     # safe test, doesn't touch the real config
pnpm dev -- --help                                                  # same, with --watch
pnpm test                                                            # vitest on the .ts sources
pnpm build                                                           # tsc → dist/ (what gets published)
```

Always override `$HOME` for manual testing so you never clobber your real
`~/.config/ccstatusline/settings.json`.

## License

[MIT](./LICENSE)

Copyright (c) 2026-present, [REFINIST](https://github.com/refinist)
