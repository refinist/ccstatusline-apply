import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

// Smoke-test the BUILT bundle from a bare directory — the exact situation the
// pinned runtime copy (~/.config/ccsa/runtime/ccsa.mjs, see rotate.ts) lives in:
// no package.json neighbor, no node_modules, nothing but the one file. The unit
// tests all import from src/ and can never catch a bundle that only breaks when
// separated from the package (as the import-time package.json read once did:
// every scheduled tick crashed while every test stayed green).

const require = createRequire(import.meta.url);

// Run tsdown through its resolved JS entry with process.execPath — spawning the
// .bin shim breaks on Windows (a .CMD can't be execFile'd without a shell).
function buildDist(): void {
  const pkg = require.resolve('tsdown/package.json');
  const bin = (
    JSON.parse(fs.readFileSync(pkg, 'utf8')) as { bin: { tsdown: string } }
  ).bin.tsdown;
  execFileSync(process.execPath, [path.join(path.dirname(pkg), bin)], {
    cwd: path.join(import.meta.dirname, '..'),
    stdio: 'ignore'
  });
}

test('the built bundle runs from a bare directory, like the pinned runtime copy', () => {
  buildDist();

  // A bare dir: just the bundle, renamed the way pinRuntime installs it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-dist-'));
  const copy = path.join(dir, 'ccsa.mjs');
  fs.copyFileSync(
    path.join(import.meta.dirname, '..', 'dist', 'cli.js'),
    copy
  );

  // Isolate the child's home so a real machine's live rotation state can never
  // leak in (or be written to). HOME for POSIX os.homedir(), USERPROFILE for
  // Windows'.
  const env = { ...process.env, HOME: dir, USERPROFILE: dir };

  // --version must not crash without a package.json neighbor — it degrades.
  const version = execFileSync(process.execPath, [copy, '--version'], {
    env
  })
    .toString()
    .trim();
  expect(version).toBe('unknown');

  // What the scheduler actually runs. No rotation state in the bare home, so
  // this must exit 0 with the quiet "off" message — not throw at import time.
  const tick = execFileSync(process.execPath, [copy, 'rotate'], { env })
    .toString()
    .trim();
  expect(tick).toContain('rotation is off');
});
