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

test('tools list/show/validate work with user tools.toml', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'accountbox-test-'));
  const home = path.join(tmp, '.accountbox');
  const toolsToml = path.join(tmp, 'tools.toml');
  await fs.writeFile(toolsToml, `
[tools.aider]
mode = "native"
command = "aider"
isolate = true

[tools.gh]
mode = "native"
command = "gh"
isolate = false
`.trim() + '\n', 'utf8');

  const env = { ...process.env, ACCOUNTBOX_HOME: home, ACCOUNTBOX_TOOLS_TOML: toolsToml };

  const list = await execa(process.execPath, [BIN, 'tools', 'list'], { cwd: tmp, env });
  assert.equal(list.exitCode, 0);
  assert.match(list.stdout, /^aider\tnative/m);
  assert.match(list.stdout, /^gh\tnative/m);
  assert.match(list.stdout, /^codex\tbuilt-in/m);
  assert.match(list.stdout, /^claude\tbuilt-in/m);

  const show = await execa(process.execPath, [BIN, 'tools', 'show', 'aider', '--json'], { cwd: tmp, env });
  assert.equal(show.exitCode, 0);
  const showObj = JSON.parse(show.stdout);
  assert.equal(showObj.id, 'aider');
  assert.equal(showObj.kind, 'configured');
  assert.equal(showObj.merged.command, 'aider');

  const validate = await execa(process.execPath, [BIN, 'tools', 'validate'], { cwd: tmp, env });
  assert.equal(validate.exitCode, 0);
});

test('resolve codex works in a git dir with .accountbox.toml', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'accountbox-test-'));
  await fs.mkdir(path.join(tmp, '.git'));
  await fs.writeFile(path.join(tmp, '.accountbox.toml'), 'codex_account = "try1"\n', 'utf8');

  const res = await execa(process.execPath, [BIN, 'resolve', 'codex', '--json'], {
    cwd: tmp,
    env: { ...process.env, ACCOUNTBOX_HOME: path.join(tmp, '.accountbox') },
  });
  assert.equal(res.exitCode, 0);
  const obj = JSON.parse(res.stdout);
  assert.equal(obj.ok, true);
  assert.equal(obj.toolId, 'codex');
  assert.equal(obj.account, 'try1');
});

test('doctor --json prints machine-readable output', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'accountbox-test-'));
  const res = await execa(process.execPath, [BIN, 'doctor', '--json'], {
    cwd: tmp,
    env: { ...process.env, ACCOUNTBOX_HOME: path.join(tmp, '.accountbox'), PATH: '' },
  });
  assert.equal(res.exitCode, 0);
  const obj = JSON.parse(res.stdout);
  assert.equal(await fs.realpath(obj.cwd), await fs.realpath(tmp));
  assert.ok('docker' in obj);
  assert.ok('claude' in obj);
});
