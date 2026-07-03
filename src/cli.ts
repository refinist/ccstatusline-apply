#!/usr/bin/env node
import { makeStyle, run } from './cli-core.ts';

try {
  run(process.argv.slice(2));
} catch (err) {
  const s = makeStyle(process.stderr);
  console.error(`${s.bad('✗')} ${(err as Error).message}`);
  process.exitCode = 1;
}
