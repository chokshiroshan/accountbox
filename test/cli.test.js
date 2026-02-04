import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { execa } from 'execa';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const BIN = path.join(ROOT_DIR, 'bin', 'accountbox.js');
const PKG = JSON.parse(await fs.readFile(path.join(ROOT_DIR, 'package.json'), 'utf8'));

test('prints version', async () => {
  const res = await execa(process.execPath, [BIN, '--version']);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout.trim(), PKG.version);
});

test('doctor works without docker/claude in PATH', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'accountbox-test-'));
  const res = await execa(process.execPath, [BIN, 'doctor'], {
    cwd: tmp,
    env: {
      ...process.env,
      ACCOUNTBOX_HOME: path.join(tmp, '.accountbox'),
      PATH: '',
    },
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /docker runtime:/);
  assert.match(res.stdout, /claude:/);
});

test('codex list works with empty ACCOUNTBOX_HOME', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'accountbox-test-'));
  const res = await execa(process.execPath, [BIN, 'codex', 'list'], {
    cwd: tmp,
    env: { ...process.env, ACCOUNTBOX_HOME: path.join(tmp, '.accountbox') },
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /No Codex accounts found/);
});

test('run codex limits dispatches to codex helper', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'accountbox-test-'));
  const res = await execa(process.execPath, [BIN, 'run', 'codex', 'limits'], {
    cwd: tmp,
    env: { ...process.env, ACCOUNTBOX_HOME: path.join(tmp, '.accountbox') },
  });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /No Codex accounts found/);
});
