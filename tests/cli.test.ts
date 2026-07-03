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
