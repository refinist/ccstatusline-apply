import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { normalize, parseArgs, resolveInput, run } from '../src/cli-core.ts';

test('parseArgs reads flags and the positional', () => {
  const o = parseArgs(['eyJ', '--no-backup', '--no-merge']);
  expect(o._[0]).toBe('eyJ');
  expect(o.backup).toBe(false);
  expect(o.merge).toBe(false);
});

test('parseArgs reads the apply/list/restore/export/clean commands', () => {
  expect(parseArgs(['apply']).command).toBe('apply');
  expect(parseArgs(['list']).command).toBe('list');
  expect(parseArgs(['restore']).command).toBe('restore');
  expect(parseArgs(['export']).command).toBe('export');
  expect(parseArgs(['clean']).command).toBe('clean');
  expect(parseArgs([]).command).toBe('apply'); // no command word → default
});

test('parseArgs accepts an explicit apply command word before the positional and flags', () => {
  const raw = '{"version":3,"lines":[]}';
  const o = parseArgs(['apply', raw, '--no-backup']);
  expect(o.command).toBe('apply');
  expect(o._).toEqual([raw]); // the word itself is consumed, not treated as input
  expect(o.backup).toBe(false);
  expect(resolveInput(o)).toBe(raw);
});

test('parseArgs only recognizes restore/export as the command word at position 0 (regression: `-f x restore` silently restoring instead of applying)', () => {
  const o = parseArgs(['-f', '/tmp/a.json', 'restore']);
  expect(o.command).toBe('apply');
  expect(o.file).toBe('/tmp/a.json');
  expect(o._).toEqual(['restore']); // falls through as an (unused) positional, not a command switch
});

test('parseArgs reads rotate and its subcommands, keeping the bundle as a positional', () => {
  const raw = '{"version":1}';
  expect(parseArgs(['rotate'])).toMatchObject({ command: 'rotate', sub: null });
  expect(parseArgs(['rotate', 'on', raw])).toMatchObject({
    command: 'rotate',
    sub: 'on',
    _: [raw]
  });
  expect(parseArgs(['rotate', 'off'])).toMatchObject({
    command: 'rotate',
    sub: 'off'
  });
  expect(parseArgs(['rotate', 'status'])).toMatchObject({
    command: 'rotate',
    sub: 'status'
  });
  // flags mix in like everywhere else
  expect(parseArgs(['rotate', 'on', '-f', '/tmp/b.json'])).toMatchObject({
    command: 'rotate',
    sub: 'on',
    file: '/tmp/b.json'
  });
  // once a positional has been seen, on/off/status are no longer subcommand words
  expect(parseArgs(['rotate', raw, 'on'])).toMatchObject({
    command: 'rotate',
    sub: null,
    _: [raw, 'on']
  });
  // "rotate" anywhere but argv[0] is a plain positional, like the other commands
  expect(parseArgs(['-f', '/tmp/a.json', 'rotate'])).toMatchObject({
    command: 'apply',
    _: ['rotate']
  });
});

test('parseArgs accepts flags after the restore command', () => {
  expect(parseArgs(['restore', '--no-backup'])).toMatchObject({
    command: 'restore',
    backup: false
  });
});

test('parseArgs supports --flag=value via normalize, alongside a boolean flag', () => {
  const o = parseArgs(normalize(['--file=/tmp/a.json', '--no-merge']));
  expect(o.file).toBe('/tmp/a.json');
  expect(o.merge).toBe(false);
});

test('parseArgs throws when a value-flag has no value (regression: silent fallback to no file)', () => {
  expect(() => parseArgs(['{}', '-f'])).toThrow(/requires a value/);
  expect(() => parseArgs(['{}', '--file'])).toThrow(/requires a value/);
});

test('parseArgs throws when a value-flag is followed by another flag (regression: `-f --no-merge` ate --no-merge)', () => {
  expect(() => parseArgs(['{}', '-f', '--no-merge'])).toThrow(
    /requires a value/
  );
  expect(() => parseArgs(['{}', '-f', '--stdin'])).toThrow(/requires a value/);
});

test('parseArgs rejects unknown options', () => {
  expect(() => parseArgs(['--nope'])).toThrow(/unknown option/);
});

test('resolveInput decodes base64 and passes raw JSON through', () => {
  const raw = '{"version":3,"lines":[]}';
  const b64 = Buffer.from(raw).toString('base64');
  expect(resolveInput(parseArgs([b64]))).toBe(raw); // base64 → decoded
  expect(resolveInput(parseArgs([raw]))).toBe(raw); // starts with "{" → passed through
});

test('resolveInput returns null when no input source is given (no stdin auto-read)', () => {
  expect(resolveInput(parseArgs([]))).toBe(null);
});

test('run(["clean"]) deletes the backup pool and reports what it removed', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-cli-home-'));
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  const configDir = path.join(fakeHome, '.config', 'ccstatusline');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ version: 3, lines: [] })
  );
  const poolDir = path.join(fakeHome, '.config', 'ccsa');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.writeFileSync(
    path.join(poolDir, 'settings.2020-01-01_10-00-00.json'),
    '{}'
  );

  const logs: unknown[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(s => {
    logs.push(s);
  });
  try {
    run(['clean']);
    expect(String(logs[0])).toMatch(/removed 1 backup/);
    expect(fs.readdirSync(poolDir)).toEqual([]);
  } finally {
    logSpy.mockRestore();
    homeSpy.mockRestore();
  }
});

test('run(["list"]) prints the live config and each backup in the pool', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-cli-home-'));
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  const configDir = path.join(fakeHome, '.config', 'ccstatusline');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ version: 3, lines: [] })
  );
  const poolDir = path.join(fakeHome, '.config', 'ccsa');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.writeFileSync(
    path.join(poolDir, 'settings.2020-01-01_10-00-00.json'),
    '{}'
  );

  const logs: unknown[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(s => {
    logs.push(s);
  });
  try {
    run(['list']);
    const text = logs.join('\n');
    expect(text).toContain(
      path.join('.config', 'ccstatusline', 'settings.json')
    );
    expect(text).toMatch(/1 in /); // backup count
    expect(text).toContain('settings.2020-01-01_10-00-00.json');
    expect(fs.readdirSync(poolDir)).toHaveLength(1); // read-only: nothing touched
  } finally {
    logSpy.mockRestore();
    homeSpy.mockRestore();
  }
});

test('parseArgs reads --force (default false)', () => {
  expect(parseArgs(['restore', '--force']).force).toBe(true);
  expect(parseArgs(['restore']).force).toBe(false);
});

test('run(["apply", …]) is blocked while rotation is on and leaves settings.json untouched', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-cli-home-'));
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  const configDir = path.join(fakeHome, '.config', 'ccstatusline');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  const original = JSON.stringify({ version: 3, lines: [['a']] });
  fs.writeFileSync(configPath, original);
  // rotation is on: its state file exists (contents don't matter — existence is the signal)
  const poolDir = path.join(fakeHome, '.config', 'ccsa');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.writeFileSync(path.join(poolDir, 'rotation.json'), '{}');

  const errs: unknown[] = [];
  const errSpy = vi.spyOn(console, 'error').mockImplementation(s => {
    errs.push(s);
  });
  const savedExit = process.exitCode;
  try {
    run(['apply', JSON.stringify({ version: 9, lines: [] })]);
    const text = errs.join('\n');
    expect(text).toMatch(/rotation is on/);
    expect(text).toMatch(/rotate off/); // points at the clean exit
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original); // never written
  } finally {
    process.exitCode = savedExit;
    errSpy.mockRestore();
    homeSpy.mockRestore();
  }
});

test('run(["apply", …, "--force"]) writes even while rotation is on', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-cli-home-'));
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  const configDir = path.join(fakeHome, '.config', 'ccstatusline');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({ version: 3, lines: [] }));
  const poolDir = path.join(fakeHome, '.config', 'ccsa');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.writeFileSync(path.join(poolDir, 'rotation.json'), '{}');

  const logs: unknown[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(s => {
    logs.push(s);
  });
  try {
    run(['apply', JSON.stringify({ version: 9, lines: [['z']] }), '--force']);
    expect(logs.join('\n')).toMatch(/wrote/);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
      version: 9
    });
  } finally {
    logSpy.mockRestore();
    homeSpy.mockRestore();
  }
});

test('run(["restore"]) is blocked while rotation is on, never touching the config or pool', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-cli-home-'));
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  const configDir = path.join(fakeHome, '.config', 'ccstatusline');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  const original = JSON.stringify({ version: 3, lines: [] });
  fs.writeFileSync(configPath, original);
  const poolDir = path.join(fakeHome, '.config', 'ccsa');
  fs.mkdirSync(poolDir, { recursive: true });
  // a backup exists (so restore would otherwise have something to roll back to)…
  fs.writeFileSync(
    path.join(poolDir, 'settings.2020-01-01_10-00-00.json'),
    '{"version":1,"lines":[]}'
  );
  // …but rotation is on, so restore must refuse
  fs.writeFileSync(path.join(poolDir, 'rotation.json'), '{}');

  const errs: unknown[] = [];
  const errSpy = vi.spyOn(console, 'error').mockImplementation(s => {
    errs.push(s);
  });
  const savedExit = process.exitCode;
  try {
    run(['restore']);
    expect(errs.join('\n')).toMatch(/rotation is on/);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original); // untouched
    // and no redo-point backup was written — restore never ran
    expect(
      fs.readdirSync(poolDir).filter(f => f.startsWith('settings.'))
    ).toHaveLength(1);
  } finally {
    process.exitCode = savedExit;
    errSpy.mockRestore();
    homeSpy.mockRestore();
  }
});

test('run(["export"]) prints only the JSON to stdout (pipeable), status to stderr', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-cli-home-'));
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  const configDir = path.join(fakeHome, '.config', 'ccstatusline');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'settings.json');
  const config = { version: 3, lines: [['x']] };
  fs.writeFileSync(configPath, JSON.stringify(config));

  const logs: unknown[] = [];
  const errs: unknown[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(s => {
    logs.push(s);
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(s => {
    errs.push(s);
  });
  try {
    run(['export']);
    expect(logs).toHaveLength(1); // only the JSON — nothing else on stdout
    expect(JSON.parse(String(logs[0]))).toEqual(config);
    // status went to stderr instead (paths are printed ~-shortened)
    expect(
      errs.some(e =>
        String(e).includes(
          path.join('.config', 'ccstatusline', 'settings.json')
        )
      )
    ).toBe(true);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    homeSpy.mockRestore();
  }
});
