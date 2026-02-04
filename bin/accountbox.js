#!/usr/bin/env node
import process from 'node:process';
import { main } from '../src/cli/main.js';

try {
  await main(process.argv);
} catch (e) {
  const msg = e && typeof e === 'object' && 'message' in e ? e.message : String(e);
  console.error(msg);
  process.exitCode = 1;
}

