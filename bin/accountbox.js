#!/usr/bin/env node
import { Command } from 'commander';
import { execa } from 'execa';
import { findUp } from 'find-up';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import toml from 'toml';

const require = createRequire(import.meta.url);
const { version: ACCOUNTBOX_VERSION } = require('../package.json');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const ACCOUNTBOX_HOME = process.env.ACCOUNTBOX_HOME || path.join(os.homedir(), '.accountbox');

// Codex container build settings
const CODEX_IMAGE_NAME = process.env.ACCOUNTBOX_CODEX_IMAGE_NAME || 'accountbox-codex';
const CODEX_NPM_SPEC = process.env.ACCOUNTBOX_CODEX_NPM_SPEC || '@openai/codex@latest';
const CODEX_HOST_NPM_SPEC = process.env.ACCOUNTBOX_CODEX_HOST_NPM_SPEC || CODEX_NPM_SPEC;
const CODEX_DOCKERFILE_DIR = process.env.ACCOUNTBOX_CODEX_DOCKERFILE_DIR
  || path.resolve(SCRIPT_DIR, '..');

// User tool config (extensible)
const XDG_CONFIG_HOME_DEFAULT = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const USER_TOOLS_TOML_DEFAULT = process.env.ACCOUNTBOX_TOOLS_TOML || path.join(XDG_CONFIG_HOME_DEFAULT, 'accountbox', 'tools.toml');
const USER_TOOLS_TOML_LEGACY = path.join(ACCOUNTBOX_HOME, 'tools.toml');

async function resolveUserToolsTomlPath() {
  if (process.env.ACCOUNTBOX_TOOLS_TOML) return USER_TOOLS_TOML_DEFAULT;
  if (await exists(USER_TOOLS_TOML_DEFAULT)) return USER_TOOLS_TOML_DEFAULT;
  if (await exists(USER_TOOLS_TOML_LEGACY)) return USER_TOOLS_TOML_LEGACY;
  return USER_TOOLS_TOML_DEFAULT;
}

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function isErrno(e, code) {
  return Boolean(e && typeof e === 'object' && 'code' in e && e.code === code);
}

function looksLikeOption(token) {
  return typeof token === 'string' && token.startsWith('-');
}

function hasAny(args, tokens) {
  return tokens.some(t => args.includes(t));
}

function readOptionValue(args, longName, fallback = null) {
  const eqPrefix = `${longName}=`;
  const direct = args.find(a => typeof a === 'string' && a.startsWith(eqPrefix));
  if (direct) return direct.slice(eqPrefix.length);
  const idx = args.indexOf(longName);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

function readOptionNumber(args, longName, fallback) {
  const raw = readOptionValue(args, longName, null);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function disambiguateAccountArg({ account, args, knownSubcommands }) {
  let accountArg = account;
  let argsList = args || [];
  const accountIsSubcommand = Boolean(accountArg && knownSubcommands?.has(accountArg));
  const accountLooksLikeOption = looksLikeOption(accountArg);

  if (accountIsSubcommand || accountLooksLikeOption) {
    argsList = [accountArg, ...argsList];
    accountArg = undefined;
  }

  return { accountArg, argsList, accountIsSubcommand, accountLooksLikeOption };
}

async function findGitRoot(cwd) {
  const gitDir = await findUp('.git', { cwd, type: 'directory' });
  if (gitDir) return path.dirname(gitDir);

  // git worktrees/submodules often have a `.git` *file* pointing at the real gitdir.
  const gitFile = await findUp('.git', { cwd, type: 'file' });
  return gitFile ? path.dirname(gitFile) : null;
}

async function findProjectConfigToml(cwd) {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) return null;

  // walk upward from cwd to gitRoot
  let d = cwd;
  while (true) {
    // prefer new name
    const fNew = path.join(d, '.accountbox.toml');
    if (await exists(fNew)) return fNew;

    // backward compat
    const fOld = path.join(d, '.devbox.toml');
    if (await exists(fOld)) return fOld;

    if (d === gitRoot) break;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

async function readProjectConfig(cwd) {
  const f = await findProjectConfigToml(cwd);
  if (!f) return { file: null, data: {} };
  const raw = await fs.readFile(f, 'utf8');
  let data;
  try {
    data = toml.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse TOML in ${f}: ${e?.message || String(e)}`);
  }
  return { file: f, data };
}

async function readUserToolsConfig() {
  const p = await resolveUserToolsTomlPath();
  if (!(await exists(p))) return { file: null, data: {} };
  const raw = await fs.readFile(p, 'utf8');
  let data;
  try {
    data = toml.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse TOML in ${p}: ${e?.message || String(e)}`);
  }
  return { file: p, data };
}

function mergeTools(projectData, userData) {
  // User tools provide defaults; project tools can override.
  return {
    ...(userData?.tools || {}),
    ...(projectData?.tools || {}),
  };
}

async function setProjectDefault(tool, account, cwd) {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) throw new Error(`Not inside a git repo (.git not found). Run this inside the repo you want to configure (cwd: ${cwd}).`);
  const f = path.join(gitRoot, '.accountbox.toml');

  const key = tool === 'codex' ? 'codex_account'
    : tool === 'claude' ? 'claude_account'
      : `${tool}_account`;

  let lines = [];
  if (await exists(f)) lines = (await fs.readFile(f, 'utf8')).split(/\r?\n/);

  let replaced = false;
  const re = new RegExp(`^${key}\\s*=`);
  lines = lines.map(l => {
    if (re.test(l)) { replaced = true; return `${key} = \"${account}\"`; }
    return l;
  });
  if (!replaced) lines.push(`${key} = \"${account}\"`);

  const out = lines
    .filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''))
    .join('\n') + '\n';

  await fs.writeFile(f, out, 'utf8');
  return f;
}

function resolveAccountOrThrow(passed, defaultsKey, config) {
  const a = passed || config?.[defaultsKey];
  if (!a) throw new Error(`Missing account. Provide <account> or set a default in .accountbox.toml (${defaultsKey}).`);
  return a;
}

async function codexImageExists() {
  const inspect = await execa('docker', ['image', 'inspect', `${CODEX_IMAGE_NAME}:latest`], { reject: false, stdio: 'ignore' });
  return inspect.exitCode === 0;
}

async function ensureCodexImage({ forceRebuild = false } = {}) {
  await execa('docker', ['ps'], { stdio: 'ignore' });

  if (!forceRebuild && await codexImageExists()) return;

  await execa('docker', [
    'build',
    '-f', path.join(CODEX_DOCKERFILE_DIR, 'Dockerfile.codex'),
    '-t', `${CODEX_IMAGE_NAME}:latest`,
    '--build-arg', `CODEX_NPM_SPEC=${CODEX_NPM_SPEC}`,
    CODEX_DOCKERFILE_DIR,
  ], { stdio: 'inherit' });
}

async function runCodex(account, args, cwd) {
  await ensureCodexImage();
  const volume = `accountbox_codex_${account}`;

  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  await execa('docker', [
    'run', '--rm',
    ...(interactive ? ['-it'] : ['-i']),
    '-v', `${cwd}:/work`,
    '-w', '/work',
    '-v', `${volume}:/root/.codex`,
    `${CODEX_IMAGE_NAME}:latest`,
    ...args,
  ], { stdio: 'inherit' });
}

async function codexLoginWithApiKey(account, apiKey, cwd) {
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY for api-key login.');
  await ensureCodexImage();
  const volume = `accountbox_codex_${account}`;

  await execa('docker', [
    'run', '--rm', '-i',
    '-v', `${cwd}:/work`,
    '-w', '/work',
    '-v', `${volume}:/root/.codex`,
    `${CODEX_IMAGE_NAME}:latest`,
    '--config', 'cli_auth_credentials_store="file"',
    'login', '--with-api-key',
  ], { stdio: ['pipe', 'inherit', 'inherit'], input: `${apiKey}\n` });
}

// NOTE: Browser-based Codex OAuth inside containers is brittle because the callback server
// may bind to localhost inside the container and not be reachable from the host port-forward.
// We therefore perform browser login on the host (per-account CODEX_HOME), then sync auth.json
// into the per-account Docker volume.

function codexHostHome(account) {
  return path.join(ACCOUNTBOX_HOME, 'codex', account);
}

function codexHostAuthJsonPath(account) {
  return path.join(codexHostHome(account), 'auth.json');
}

async function codexHostLogout(account) {
  const hostAuth = codexHostAuthJsonPath(account);
  if (!(await exists(hostAuth))) return null;
  const ts = timestampForFilename();
  const bak = path.join(codexHostHome(account), `auth.json.logout-bak-${ts}`);
  await fs.rename(hostAuth, bak);
  return bak;
}

function codexSnapshotsDir() {
  return path.join(ACCOUNTBOX_HOME, 'codex-snapshots');
}

function codexSnapshotAuthPath(name) {
  return path.join(codexSnapshotsDir(), name, 'auth.json');
}

async function listCodexAccounts() {
  const base = path.join(ACCOUNTBOX_HOME, 'codex');
  if (!(await exists(base))) return [];
  const entries = await fs.readdir(base, { withFileTypes: true });
  const accounts = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const a = e.name;
    const p = codexHostAuthJsonPath(a);
    const hasAuth = await exists(p);
    accounts.push({ account: a, hasAuth, authPath: p });
  }
  return accounts.sort((x, y) => x.account.localeCompare(y.account));
}

async function listCodexSnapshots() {
  const base = codexSnapshotsDir();
  if (!(await exists(base))) return [];
  const entries = await fs.readdir(base, { withFileTypes: true });
  const snaps = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const p = codexSnapshotAuthPath(name);
    const hasAuth = await exists(p);
    snaps.push({ name, hasAuth, authPath: p });
  }
  return snaps.sort((x, y) => x.name.localeCompare(y.name));
}

async function saveCodexSnapshot(fromAccount, snapshotName) {
  await ensureDir(codexSnapshotsDir());
  const src = codexHostAuthJsonPath(fromAccount);
  if (!(await exists(src))) {
    throw new Error(`No auth.json for account '${fromAccount}' at ${src}. Login first.`);
  }
  const dstDir = path.join(codexSnapshotsDir(), snapshotName);
  await ensureDir(dstDir);
  const dst = path.join(dstDir, 'auth.json');
  await fs.copyFile(src, dst);
  return dst;
}

async function applyCodexSnapshotToAccount(snapshotName, toAccount) {
  const src = codexSnapshotAuthPath(snapshotName);
  if (!(await exists(src))) {
    throw new Error(`Snapshot '${snapshotName}' not found at ${src}.`);
  }
  await ensureDir(codexHostHome(toAccount));
  const dst = codexHostAuthJsonPath(toAccount);
  await fs.copyFile(src, dst);
  await syncCodexAuthToVolume(toAccount);
  return dst;
}

async function syncCodexAuthToVolume(account) {
  await execa('docker', ['ps'], { stdio: 'ignore' });

  const hostDir = codexHostHome(account);
  const hostAuth = codexHostAuthJsonPath(account);
  if (!(await exists(hostAuth))) {
    throw new Error(`Expected ${hostAuth} but it was not found. Codex login may have failed.`);
  }

  const volume = `accountbox_codex_${account}`;

  // Copy auth.json into the volume under /root/.codex/auth.json.
  // Prefer the Codex image when it's already present; otherwise use alpine to avoid forcing an image build during login.
  const image = (await codexImageExists()) ? `${CODEX_IMAGE_NAME}:latest` : 'alpine';
  await execa('docker', [
    'run', '--rm',
    '--entrypoint', 'sh',
    '-v', `${volume}:/root/.codex`,
    '-v', `${hostDir}:/host:ro`,
    image,
    '-c',
    'set -e; mkdir -p /root/.codex; cp /host/auth.json /root/.codex/auth.json; chmod 600 /root/.codex/auth.json; ls -la /root/.codex',
  ], { stdio: 'inherit' });
}

async function listDockerContainersUsingHostPort(port) {
  let res;
  try {
    res = await execa('docker', [
      'ps',
      '--filter', `publish=${port}`,
      '--format', '{{.ID}}\t{{.Names}}\t{{.Ports}}'
    ], { reject: false });
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return [];
    return [];
  }
  if (!res || res.exitCode !== 0) return [];
  const lines = String(res.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  return lines.map(l => {
    const [id, name, ports] = l.split('\t');
    return { id, name, ports };
  });
}

async function canBindTcpPort(port, host = '127.0.0.1') {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once('error', (err) => {
      if (err && typeof err === 'object' && err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        // Treat unknown errors as "not free" to avoid false negatives.
        resolve(false);
      }
    });

    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function ensureCodexLoginPortFree(port = 1455) {
  // First check Docker containers publishing the port
  const containers = await listDockerContainersUsingHostPort(port);
  if (containers.length) {
    const autoStop = process.env.ACCOUNTBOX_CODEX_AUTO_STOP_PORT === '1';
    if (autoStop) {
      for (const c of containers) {
        await execa('docker', ['stop', c.id], { stdio: 'inherit' });
      }
      return;
    }

    const details = containers.map(c => `- ${c.name} (${c.id}) ${c.ports}`).join('\n');
    throw new Error(
      `Port ${port} is already published by Docker container(s):\n${details}\n` +
      `Stop them (docker stop <id>) or set ACCOUNTBOX_CODEX_AUTO_STOP_PORT=1 to auto-stop during login.`
    );
  }

  // Fallback: any other process listening on the port (cross-platform check).
  if (!(await canBindTcpPort(port, '127.0.0.1'))) {
    throw new Error(
      `Port ${port} is already in use by another process. Free it, then retry login.`
    );
  }
}

async function resolveHostCodexRunner() {
  try {
    const res = await execa('codex', ['-V'], { reject: false, stdio: 'ignore' });
    if (res.exitCode === 0) return { kind: 'path', command: 'codex', args: [] };
  } catch (e) {
    if (!isErrno(e, 'ENOENT')) throw e;
  }

  try {
    const res = await execa('npx', ['--version'], { reject: false, stdio: 'ignore' });
    if (res.exitCode === 0) return { kind: 'npx', command: 'npx', args: ['-y', CODEX_HOST_NPM_SPEC] };
  } catch (e) {
    if (!isErrno(e, 'ENOENT')) throw e;
  }

  throw new Error(
    'Codex CLI not found on host. Install it with: npm i -g @openai/codex (or ensure npm/npx is available).'
  );
}

async function codexHostLoginAndSync(account, { method = 'device', openBrowser = true, force = false } = {}) {
  // Ensure host state dir exists
  await ensureDir(codexHostHome(account));

  if (force) {
    const hostAuth = codexHostAuthJsonPath(account);
    if (await exists(hostAuth)) {
      const ts = timestampForFilename();
      const bak = path.join(codexHostHome(account), `auth.json.bak-${ts}`);
      await fs.rename(hostAuth, bak);
      console.log(`Moved existing auth.json -> ${bak}`);
    }
  }

  // Ensure Codex OAuth callback port is free (browser login)
  if (method === 'browser') {
    await ensureCodexLoginPortFree(1455);
  }

  // Force file-based credential storage so we can sync auth.json.
  const baseArgs = ['--config', 'cli_auth_credentials_store="file"'];

  const urlRe = /(https:\/\/auth\.openai\.com\/(?:oauth\/authorize\?[^\s]+|[^\s]+))/;
  let opened = false;

  // Prevent Codex from launching the system default browser. We'll open ourselves.
  const env = {
    ...process.env,
    CODEX_HOME: codexHostHome(account),
    BROWSER: process.env.BROWSER || '/usr/bin/true',
  };

  const args = [...baseArgs, 'login', ...(method === 'device' ? ['--device-auth'] : [])];

  const runner = await resolveHostCodexRunner();
  if (runner.kind === 'npx') {
    console.log(`Using npx to run Codex on host (${CODEX_HOST_NPM_SPEC}).`);
  }
  const child = execa(runner.command, [...runner.args, ...args], { env, stdout: 'pipe', stderr: 'pipe' });

  const onChunk = async (chunk) => {
    const s = String(chunk);
    process.stdout.write(s);

    if (!opened) {
      const m = s.match(urlRe);
      if (m?.[1] && openBrowser) {
        opened = true;
        try {
          await openSandboxedBrowser(account, m[1]);
        } catch (e) {
          const msg = e?.message || String(e);
          console.error(`Could not open sandboxed browser automatically: ${msg}`);
        }
      }
    }
  };

  child.stdout?.on('data', (c) => { void onChunk(c); });
  child.stderr?.on('data', (c) => { void onChunk(c); });

  await child;

  // After success, sync credentials into container volume.
  await syncCodexAuthToVolume(account);
}

async function codexLoginStatus(account) {
  await ensureCodexImage();
  const volume = `accountbox_codex_${account}`;
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  // Codex exits non-zero when not logged in; treat that as a status, not an exception.
  const res = await execa('docker', [
    'run', '--rm',
    ...(interactive ? ['-it'] : ['-i']),
    '-v', `${process.cwd()}:/work`,
    '-w', '/work',
    '-v', `${volume}:/root/.codex`,
    `${CODEX_IMAGE_NAME}:latest`,
    'login', 'status',
  ], { reject: false, stdio: 'inherit' });

  return res.exitCode;
}

async function runClaude(account, args, cwd) {
  const base = path.join(ACCOUNTBOX_HOME, 'claude', account);
  await ensureDir(path.join(base, 'config'));
  await ensureDir(path.join(base, 'data'));
  await ensureDir(path.join(base, 'state'));

  await execa('claude', args, {
    stdio: 'inherit',
    cwd,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(base, 'config'),
      XDG_DATA_HOME: path.join(base, 'data'),
      XDG_STATE_HOME: path.join(base, 'state'),
    },
  });
}

async function runNativeTool({ toolId, account, command, args, cwd, isolate = true, extraEnv = {} }) {
  const env = { ...process.env, ...extraEnv };

  if (isolate) {
    const base = path.join(ACCOUNTBOX_HOME, 'tools', toolId, account);
    await ensureDir(path.join(base, 'config'));
    await ensureDir(path.join(base, 'data'));
    await ensureDir(path.join(base, 'state'));
    env.XDG_CONFIG_HOME = path.join(base, 'config');
    env.XDG_DATA_HOME = path.join(base, 'data');
    env.XDG_STATE_HOME = path.join(base, 'state');
  }

  await execa(command, args, { stdio: 'inherit', cwd, env });
}

async function runContainerTool({ toolId, account, image, args, cwd, workdir = '/work', configMountPath }) {
  await execa('docker', ['ps'], { stdio: 'ignore' });

  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  const mounts = [
    '-v', `${cwd}:${workdir}`,
    '-w', workdir,
  ];

  if (configMountPath) {
    const volume = `accountbox_${toolId}_${account}`;
    mounts.push('-v', `${volume}:${configMountPath}`);
  }

  await execa('docker', [
    'run', '--rm',
    ...(interactive ? ['-it'] : ['-i']),
    ...mounts,
    image,
    ...args,
  ], { stdio: 'inherit' });
}

async function openSandboxedBrowser(account, url) {
  const profileDir = browserProfileDir(account);
  await ensureDir(profileDir);

  const chromeArgs = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Codex binds its localhost OAuth callback on IPv4 (127.0.0.1).
    // Some setups prefer IPv6 for `localhost` and fail; force IPv4 mapping.
    '--host-resolver-rules=MAP localhost 127.0.0.1',
    url,
  ];

  if (process.platform === 'darwin') {
    const chromeApp = '/Applications/Google Chrome.app';
    if (await exists(chromeApp)) {
      await execa('open', ['-na', chromeApp, '--args', ...chromeArgs], { stdio: 'ignore' });
      return;
    }
    await execa('open', [url], { stdio: 'ignore' });
    return;
  }

  // Best-effort sandboxing on Linux: launch chrome/chromium detached.
  if (process.platform === 'linux') {
    const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
    for (const c of candidates) {
      try {
        const v = await execa(c, ['--version'], { reject: false, stdio: 'ignore' });
        if (v.exitCode !== 0) continue;

        const child = execa(c, chromeArgs, { detached: true, stdio: 'ignore' });
        child.unref();
        child.catch(() => {});
        return;
      } catch (e) {
        if (isErrno(e, 'ENOENT')) continue;
        break;
      }
    }

    // Fallback: open default browser.
    try {
      await execa('xdg-open', [url], { stdio: 'ignore' });
      return;
    } catch {
      // fall through
    }
  }

  // Fallback: open the default browser without sandboxing.
  if (process.platform === 'win32') {
    const child = execa('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    child.unref();
    child.catch(() => {});
    return;
  }

  throw new Error('Could not open a browser automatically. Copy/paste the login URL into your browser instead.');
}

function browserProfileDir(account) {
  return path.join(ACCOUNTBOX_HOME, 'browser', account);
}

async function findCodexAppBundlePath() {
  const candidates = [
    '/Applications/Codex.app',
    path.join(os.homedir(), 'Applications', 'Codex.app'),
  ];
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return null;
}

async function isCodexAppRunning() {
  if (process.platform !== 'darwin') return false;
  const res = await execa('osascript', ['-e', 'application "Codex" is running'], { reject: false });
  return res.exitCode === 0 && String(res.stdout || '').trim().toLowerCase() === 'true';
}

async function quitCodexApp() {
  if (process.platform !== 'darwin') return;
  await execa('osascript', ['-e', 'tell application "Codex" to quit'], { reject: false, stdio: 'ignore' });
}

function codexAppUserDataDir(account) {
  return path.join(ACCOUNTBOX_HOME, 'codex-app', account);
}

async function openCodexApp(account, { quitFirst = false, multi = false } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('Codex app is macOS-only.');
  }

  const bundle = await findCodexAppBundlePath();
  if (!bundle) {
    throw new Error('Codex.app not found in /Applications or ~/Applications. Install the Codex app and retry.');
  }

  const bin = path.join(bundle, 'Contents', 'MacOS', 'Codex');
  if (!(await exists(bin))) {
    throw new Error(`Codex.app binary not found at ${bin}.`);
  }

  if (quitFirst) {
    await quitCodexApp();
    await new Promise(r => setTimeout(r, 800));
  } else if (await isCodexAppRunning()) {
    console.log('Note: Codex app is already running. To switch profiles, quit it first and re-run with: accountbox codex <label> app --quit');
  }

  const codexHome = codexHostHome(account);
  await ensureDir(codexHome);

  const args = [];
  if (multi) {
    const userDataDir = codexAppUserDataDir(account);
    await ensureDir(userDataDir);
    args.push(`--user-data-dir=${userDataDir}`);
  }

  const env = { ...process.env, CODEX_HOME: codexHome };
  const child = spawn(bin, args, { env, detached: true, stdio: 'ignore' });
  const started = await new Promise((resolve, reject) => {
    child.once('error', reject);
    setTimeout(resolve, 120);
  });
  void started;
  child.unref();

  console.log(`Launched Codex app with CODEX_HOME=${codexHome}${multi ? ` and --user-data-dir=${codexAppUserDataDir(account)}` : ''}`);
}

async function resetSandboxedBrowserProfile(account) {
  const profileDir = browserProfileDir(account);
  if (!(await exists(profileDir))) return null;

  const ts = timestampForFilename();
  const bak = `${profileDir}.bak-${ts}`;
  try {
    await fs.rename(profileDir, bak);
  } catch (e) {
    const msg = e && typeof e.message === 'string' ? e.message : String(e);
    throw new Error(`Failed to reset sandboxed browser profile for '${account}'. Close Chrome windows using this profile and retry. (${msg})`);
  }
  return bak;
}

function maskEmail(email) {
  if (typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at === -1) return email.length <= 2 ? `${email[0]}…` : `${email[0]}…${email[email.length - 1]}`;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localMasked = local.length <= 2 ? `${local[0]}…` : `${local[0]}…${local[local.length - 1]}`;
  return `${localMasked}@${domain}`;
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
  try {
    const json = Buffer.from(raw + pad, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function codexWhoami(account) {
  const hostAuth = codexHostAuthJsonPath(account);
  if (!(await exists(hostAuth))) {
    throw new Error(
      `No host Codex auth.json found for '${account}' (${hostAuth}). ` +
      `Run: accountbox codex ${account} login (or --browser). ` +
      `If you used api-key login, credentials live only in the Docker volume; use: accountbox codex ${account} status.`
    );
  }

  let obj;
  try {
    obj = JSON.parse(await fs.readFile(hostAuth, 'utf8'));
  } catch {
    throw new Error(`Failed to parse JSON at ${hostAuth}.`);
  }

  const authMode = obj?.auth_mode;
  const tokens = obj?.tokens || {};
  const accountId = tokens?.account_id;
  const idToken = tokens?.id_token;
  const payload = decodeJwtPayload(idToken);
  const openaiAuth = payload?.['https://api.openai.com/auth'];
  const emailMasked = maskEmail(payload?.email);
  const sub = typeof payload?.sub === 'string' ? payload.sub : null;

  console.log(`Account label: ${account}`);
  if (authMode) console.log(`Auth mode: ${authMode}`);
  if (emailMasked) console.log(`Email: ${emailMasked}`);
  if (sub) console.log(`Subject: ${maskId(sub, 18)}`);
  if (accountId) console.log(`Account ID: ${maskId(String(accountId), 12)}`);
  if (openaiAuth?.chatgpt_plan_type) console.log(`ChatGPT plan: ${openaiAuth.chatgpt_plan_type}`);
  if (Array.isArray(openaiAuth?.organizations) && openaiAuth.organizations.length) {
    console.log('Organizations:');
    for (const o of openaiAuth.organizations) {
      if (!o || typeof o !== 'object') continue;
      const id = maskId(o.id, 8) || undefined;
      const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : undefined;
      const role = typeof o.role === 'string' ? o.role : undefined;
      const isDefault = o.is_default === true;
      const parts = [];
      if (id) parts.push(id);
      if (title) parts.push(title);
      if (role) parts.push(`role=${role}`);
      if (isDefault) parts.push('default');
      console.log(`- ${parts.join(' | ')}`);
    }
  }
  console.log(`Auth file: ${hostAuth}`);
  console.log('Tip: if this is the wrong OpenAI account, re-run login with: accountbox codex login --browser --force --fresh-browser');
}

function formatDurationShort(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 'n/a';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function formatRateLimit(rl) {
  if (!rl) return 'n/a';
  if (rl.allowed === false) return 'blocked';

  const parts = [];
  if (rl.primary_window) {
    const w = rl.primary_window;
    parts.push(`${w.used_percent}%/${formatDurationShort(w.reset_after_seconds ?? w.limit_window_seconds)}`);
  }
  if (rl.secondary_window) {
    const w = rl.secondary_window;
    parts.push(`${w.used_percent}%/${formatDurationShort(w.reset_after_seconds ?? w.limit_window_seconds)}`);
  }
  let out = parts.join(' + ') || 'n/a';
  if (rl.limit_reached) out += ' (LIMIT)';
  return out;
}

function formatCredits(c) {
  if (!c) return 'n/a';
  if (c.unlimited) return 'unlimited';
  if (!c.has_credits) return 'none';
  if (typeof c.balance === 'number') return String(c.balance);
  return 'has';
}

function maskId(id, keep = 8) {
  if (typeof id !== 'string') return null;
  const n = Math.max(4, keep);
  return id.length <= n ? id : `${id.slice(0, n)}…`;
}

function sanitizeWhamUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const out = { ...u };
  if ('email' in out) out.email = maskEmail(out.email);
  if ('user_id' in out) out.user_id = maskId(out.user_id, 10);
  if ('account_id' in out) out.account_id = maskId(out.account_id, 8);
  return out;
}

async function fetchChatgptWhamUsage({ accessToken, chatgptAccountId, timeoutMs = 10_000 } = {}) {
  if (!accessToken) throw new Error('Missing access token.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(chatgptAccountId ? { 'ChatGPT-Account-Id': String(chatgptAccountId) } : {}),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 220).replace(/\s+/g, ' ').trim();
      throw new Error(`HTTP ${res.status} from wham/usage${snippet ? `: ${snippet}` : ''}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error('wham/usage returned non-JSON.');
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function codexLimitsForAccount(account, { timeoutMs = 10_000 } = {}) {
  const hostAuth = codexHostAuthJsonPath(account);
  if (!(await exists(hostAuth))) {
    return { ok: false, error: `missing auth.json (${hostAuth})` };
  }

  let obj;
  try {
    obj = JSON.parse(await fs.readFile(hostAuth, 'utf8'));
  } catch {
    return { ok: false, error: `failed to parse auth.json (${hostAuth})` };
  }

  const tokens = obj?.tokens || {};
  const accessToken = tokens?.access_token;

  const idPayload = decodeJwtPayload(tokens?.id_token);
  const openaiAuth = idPayload?.['https://api.openai.com/auth'];
  const chatgptAccountId = openaiAuth?.chatgpt_account_id || tokens?.account_id;

  if (!accessToken) {
    const hasApiKey = Boolean(obj?.OPENAI_API_KEY);
    return { ok: false, error: hasApiKey ? 'api-key auth: limits fetch not implemented yet' : 'missing access_token (not logged in?)' };
  }

  const usage = await fetchChatgptWhamUsage({ accessToken, chatgptAccountId, timeoutMs });
  return { ok: true, usage };
}

async function codexLimitsAllAccounts({ timeoutMs = 10_000, concurrency = 4 } = {}) {
  const accounts = await listCodexAccounts();
  if (!accounts.length) return [];

  const results = new Array(accounts.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, accounts.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= accounts.length) break;
      const a = accounts[i];
      try {
        const r = await codexLimitsForAccount(a.account, { timeoutMs });
        results[i] = { account: a.account, ...r };
      } catch (e) {
        results[i] = { account: a.account, ok: false, error: e?.message || String(e) };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

function normalizeToolId(s) {
  return String(s || '').trim();
}

async function promptYesNo(rl, message, def = true) {
  const suffix = def ? "[Y/n]" : "[y/N]";
  while (true) {
    const ans = (await rl.question(`${message} ${suffix} `)).trim().toLowerCase();
    if (!ans) return def;
    if (['y', 'yes'].includes(ans)) return true;
    if (['n', 'no'].includes(ans)) return false;
  }
}

async function promptText(rl, message, def = '') {
  const suffix = def ? `(${def})` : '';
  const ans = (await rl.question(`${message} ${suffix} `)).trim();
  return ans || def;
}

async function ensureBrewOrThrow() {
  try {
    const res = await execa('brew', ['--version'], { reject: false, stdio: 'ignore' });
    if (res.exitCode !== 0) {
      throw new Error('Homebrew (brew) is required for auto-install on macOS. Install from https://brew.sh and re-run accountbox install.');
    }
  } catch (e) {
    if (isErrno(e, 'ENOENT')) {
      throw new Error('Homebrew (brew) is required for auto-install on macOS. Install from https://brew.sh and re-run accountbox install.');
    }
    throw e;
  }
}

async function dockerReachable() {
  try {
    const res = await execa('docker', ['ps'], { reject: false, stdio: 'ignore' });
    return res.exitCode === 0;
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return false;
    return false;
  }
}

function makeLogger({ serious, quiet }) {
  return {
    info: (s) => { if (!quiet) console.log(s); },
    say: (s) => console.log(s),
    fun: (s) => { if (!serious && !quiet) console.log(s); },
  };
}

async function readInstallState() {
  try {
    const f = path.join(ACCOUNTBOX_HOME, 'install-state.json');
    const raw = await fs.readFile(f, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeInstallState(patch) {
  const f = path.join(ACCOUNTBOX_HOME, 'install-state.json');
  await ensureDir(path.dirname(f));
  const cur = await readInstallState();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await fs.writeFile(f, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

async function cmdInstall({ serious = false, quiet = false } = {}) {
  const log = makeLogger({ serious, quiet });
  const rl = readline.createInterface({ input, output });
  try {
    await ensureDir(ACCOUNTBOX_HOME);
    const prev = await readInstallState();

    log.say('Accountbox installer');
    log.say('-------------------');
    log.fun('Boot sequence: preparing your account multiverse.');
    if (prev?.updatedAt) log.fun(`Resume data found (last run: ${prev.updatedAt}).`);

    const platform = process.platform;
    if (platform !== 'darwin') {
      log.info(`OS: ${platform}`);
      log.info('Auto-install currently focuses on macOS. I can still configure project defaults and tool config.');
    } else {
      log.fun('macOS detected. We go fast and we keep it tidy.');
    }

    // Choose tools
    const setupCodex = await promptYesNo(rl, 'Set up Codex (containerized, multi-account)?', prev.setupCodex ?? true);
    const setupClaude = await promptYesNo(rl, 'Set up Claude Code (native, multi-account via XDG isolation)?', prev.setupClaude ?? true);
    await writeInstallState({ setupCodex, setupClaude });

    if (setupCodex) {
      if (!(await dockerReachable())) {
        log.info('Docker runtime not available/reachable.');
        log.fun('No container engine detected. Time to summon one.');
        if (platform === 'darwin') {
          const ok = await promptYesNo(rl, 'Install OrbStack via Homebrew? (recommended for performance)', true);
          if (ok) {
            await ensureBrewOrThrow();
            await execa('brew', ['install', '--cask', 'orbstack'], { stdio: 'inherit' });
            log.say('OrbStack installed. Please open OrbStack once to start the Docker runtime.');
            log.fun('OrbStack installed. Containers are now within reach—once you open the app.');
          } else {
            log.info('Skipping OrbStack install. You must provide a Docker-compatible runtime for Codex.');
          }
        } else {
          console.log('Please install Docker/Podman for your OS, then re-run accountbox install.');
        }
      }

      if (await dockerReachable()) {
        const imageAlready = await codexImageExists();
        if (imageAlready) {
          log.fun('Codex image already exists — no rebuild needed.');
        }

        const buildNow = imageAlready
          ? await promptYesNo(rl, 'Codex image exists. Rebuild anyway?', false)
          : await promptYesNo(rl, `Build Codex container image now? (npm spec: ${CODEX_NPM_SPEC})`, true);

        if (buildNow) {
          log.fun('Forging Codex container image…');
          await ensureCodexImage({ forceRebuild: imageAlready });
          log.fun('Codex container image ready.');
          await writeInstallState({ codexImageBuilt: true });
        } else {
          await writeInstallState({ codexImageBuilt: imageAlready });
        }

        const doLogin = await promptYesNo(rl, 'Log into Codex now?', false);
        if (doLogin) {
          const acct = await promptText(rl, 'Codex account name (label):', prev.codexAccount || 'default');
          await writeInstallState({ codexAccount: acct });

          const method = (await promptText(
            rl,
            'Codex login method (device|browser|api-key):',
            prev.codexLoginMethod || 'device'
          )).toLowerCase();
          await writeInstallState({ codexLoginMethod: method });

          // NOTE: This starts a fresh ephemeral container each run, but auth persists in a Docker volume per account.
          if (method === 'device') {
            log.say('Starting: codex login --device-auth (host) + sync to container volume');
            log.fun('No localhost callback server, no container Cloudflare weirdness.');
            await codexHostLoginAndSync(acct, { method: 'device', openBrowser: true });
            log.say('Codex login synced to container volume.');
            log.fun('Diagnostic: checking login status inside the container…');
            try { await codexLoginStatus(acct); } catch {}
            return;
          }

          if (method === 'api-key' || method === 'apikey') {
            log.say('API-key login selected. Paste your API key now (input hidden not supported yet).');
            // Read a single line; user can paste key.
            const key = await promptText(rl, 'OPENAI_API_KEY:', '');
            if (!key) {
              log.info('No key provided. Skipping API-key login.');
              return;
            }
            await codexLoginWithApiKey(acct, key, process.cwd());
            return;
          }

          // browser
          log.say('Starting: codex login (browser flow, host) + sandboxed browser + volume sync');
          log.fun('We’ll open the auth URL in a sandboxed Chrome profile and then sync tokens into the container volume.');

          const openNow = await promptYesNo(rl, 'Open login URL in sandboxed browser profile automatically?', true);
          await codexHostLoginAndSync(acct, { method: 'browser', openBrowser: openNow });

          log.say('Codex login synced to container volume.');
          log.fun('Diagnostic: checking login status inside the container…');
          try { await codexLoginStatus(acct); } catch {}
          log.fun('Passport stamped.');
        }
      } else {
        log.info('Codex setup incomplete (Docker not reachable). You can finish later by starting OrbStack and running accountbox install again.');
      }
    }

    if (setupClaude) {
      let claudeOk = false;
      try {
        const res = await execa('claude', ['--version'], { reject: false, stdio: 'ignore' });
        claudeOk = res.exitCode === 0;
      } catch (e) {
        if (!isErrno(e, 'ENOENT')) throw e;
      }
      if (!claudeOk) {
        log.info('Claude Code (claude) not found in PATH.');
        log.info('Install Claude Code first, then rerun installer. (You can usually run: claude install latest)');
      } else {
        log.fun('Claude detected. Native mode: fast, clean, and no container gymnastics.');
        const doDoctor = await promptYesNo(rl, 'Run `claude doctor` now?', true);
        if (doDoctor) {
          await execa('claude', ['doctor'], { stdio: 'inherit' });
        }
      }
    }

    // Repo defaults
    const inRepo = await findGitRoot(process.cwd());
    if (inRepo) {
      const setDefaults = await promptYesNo(rl, 'Set per-project defaults for this repo (.accountbox.toml)?', true);
      if (setDefaults) {
        const codexAcct = setupCodex ? await promptText(rl, 'Default codex_account:', prev.codexAccount || 'default') : null;
        const claudeAcct = setupClaude ? await promptText(rl, 'Default claude_account:', prev.claudeAccount || 'default') : null;
        if (codexAcct) await setProjectDefault('codex', codexAcct, process.cwd());
        if (claudeAcct) await setProjectDefault('claude', claudeAcct, process.cwd());
        await writeInstallState({ codexAccount: codexAcct || prev.codexAccount, claudeAccount: claudeAcct || prev.claudeAccount });
        log.info('Done writing .accountbox.toml defaults.');
      }
    } else {
      log.info('Not in a git repo; skipping per-project defaults.');
    }

    log.fun('Quest complete.');
    log.say('\nInstall complete. Try:');
    log.say('  accountbox doctor');
    log.say('  accountbox codex <account>');
    log.say('  accountbox claude <account>');
    log.say('  abox doctor');
  } finally {
    rl.close();
  }
}

const CODEX_HELPER_SUBCOMMANDS = new Set([
  'app',
  'login',
  'logout',
  'status',
  'whoami',
  'limits',
  'rebuild',
  'list',
  'snapshots',
  'save',
  'switch',
  'use',
]);

const CLAUDE_KNOWN_SUBCOMMANDS = new Set([
  'doctor',
  'install',
  'mcp',
  'plugin',
  'setup-token',
  'update',
]);

const program = new Command();
program
  .name('accountbox')
  .description('Per-account wrappers for Codex + Claude Code, with per-project defaults and extensible tool runners')
  .version(ACCOUNTBOX_VERSION)
  .option('--serious', 'Disable playful installer output')
  .option('--quiet', 'Reduce non-essential output');

program.enablePositionalOptions();

program
  .command('codex')
  .allowUnknownOption(true)
  .argument('[account]')
  .argument('[args...]')
  .description('Run Codex in a container with per-account isolation (helpers: app/login/logout/status/whoami/limits/rebuild/list/snapshots/save/switch/use)')
  .action(async (account, args) => {
    const cwd = process.cwd();
    const { data } = await readProjectConfig(cwd);

    const {
      accountArg,
      argsList: normArgs,
      accountIsSubcommand,
    } = disambiguateAccountArg({ account, args, knownSubcommands: CODEX_HELPER_SUBCOMMANDS });

    // Resolve account label.
    // - If the account was omitted because the user invoked a helper subcommand (e.g. `accountbox codex limits`),
    //   we fall back to `codex_account` or "default".
    // - Otherwise, require an explicit account or a configured `codex_account`.
    const resolved = accountArg
      ? resolveAccountOrThrow(accountArg, 'codex_account', data)
      : accountIsSubcommand
        ? (data?.codex_account || 'default')
        : resolveAccountOrThrow(undefined, 'codex_account', data);

    const cmd = normArgs[0];

    if (cmd === 'app') {
      const target = accountIsSubcommand ? (normArgs[1] || resolved) : resolved;
      const quitFirst = normArgs.includes('--quit') || normArgs.includes('--quit-first') || normArgs.includes('--restart');
      const multi = normArgs.includes('--multi');
      await openCodexApp(target, { quitFirst, multi });
      return;
    }

    if (cmd === 'login') {
      // Default to host-based device auth, then sync into the account volume.
      const wantsApiKey = hasAny(normArgs, ['api-key', '--api-key', 'with-api-key', '--with-api-key']);
      const wantsBrowser = hasAny(normArgs, ['browser', '--browser']);
      const wantsDevice = hasAny(normArgs, ['device', '--device', '--device-auth']);
      const force = hasAny(normArgs, ['force', '--force']);
      const freshBrowser = hasAny(normArgs, ['fresh-browser', '--fresh-browser', 'reset-browser', '--reset-browser']);
      const method = wantsBrowser ? 'browser' : (wantsDevice ? 'device' : 'device');

      if (wantsApiKey) {
        const key = process.env.OPENAI_API_KEY;
        if (!key) {
          throw new Error('OPENAI_API_KEY env var is required for api-key login. Example: OPENAI_API_KEY=... accountbox codex <account> login --api-key');
        }
        await codexLoginWithApiKey(resolved, key, cwd);
        try { await codexLoginStatus(resolved); } catch {}
        return;
      }

      if (method === 'browser' && freshBrowser) {
        const bak = await resetSandboxedBrowserProfile(resolved);
        if (bak) console.log(`Reset sandboxed browser profile: moved -> ${bak}`);
      }

      await codexHostLoginAndSync(resolved, { method, openBrowser: true, force });
      // Print a quick diagnostic
      try {
        await codexLoginStatus(resolved);
      } catch {
        // ignore; status already prints on failure
      }
      return;
    }

    if (cmd === 'logout') {
      await runCodex(resolved, ['logout'], cwd);
      const bak = await codexHostLogout(resolved);
      if (bak) console.log(`Moved host auth.json -> ${bak}`);
      return;
    }

    if (cmd === 'status') {
      await codexLoginStatus(resolved);
      return;
    }

    if (cmd === 'whoami') {
      await codexWhoami(resolved);
      return;
    }

    if (cmd === 'limits') {
      const json = normArgs.includes('--json');
      const raw = normArgs.includes('--raw');
      const timeoutMs = Math.max(1, Math.trunc(readOptionNumber(normArgs, '--timeout-ms', 10_000)));
      const concurrency = Math.max(1, Math.min(8, Math.trunc(readOptionNumber(normArgs, '--concurrency', 4))));

      if (accountIsSubcommand) {
        const rows = await codexLimitsAllAccounts({ timeoutMs, concurrency });
        if (json) {
          const out = rows.map(r => ({
            ...r,
            usage: raw ? r.usage : sanitizeWhamUsage(r.usage),
          }));
          console.log(JSON.stringify(out, null, 2));
          return;
        }
        if (!rows.length) {
          console.log('No Codex accounts found under ~/.accountbox/codex yet.');
          return;
        }
        console.log('Codex limits (ChatGPT wham/usage):');
        for (const r of rows) {
          if (!r?.ok) {
            console.log(`- ${r.account}: ${r?.error || 'unknown error'}`);
            continue;
          }
          const u = r.usage || {};
          console.log(`- ${r.account}: plan=${u.plan_type || 'n/a'} email=${maskEmail(u.email) || 'n/a'} rate=${formatRateLimit(u.rate_limit)} review=${formatRateLimit(u.code_review_rate_limit)} credits=${formatCredits(u.credits)}`);
        }
        return;
      }

      const r = await codexLimitsForAccount(resolved, { timeoutMs });
      if (json) {
        console.log(JSON.stringify({
          account: resolved,
          ok: r.ok,
          ...(r.ok ? { usage: raw ? r.usage : sanitizeWhamUsage(r.usage) } : { error: r.error }),
        }, null, 2));
        return;
      }
      if (!r.ok) {
        console.log(`${resolved}: ${r.error}`);
        return;
      }
      const u = r.usage || {};
      console.log(`${resolved}: plan=${u.plan_type || 'n/a'} email=${maskEmail(u.email) || 'n/a'} rate=${formatRateLimit(u.rate_limit)} review=${formatRateLimit(u.code_review_rate_limit)} credits=${formatCredits(u.credits)}`);
      return;
    }

    if (cmd === 'rebuild') {
      await ensureCodexImage({ forceRebuild: true });
      const v = await execa('docker', ['run', '--rm', `${CODEX_IMAGE_NAME}:latest`, '-V'], { reject: false });
      if (v.exitCode === 0) console.log(v.stdout.trim());
      return;
    }

    if (cmd === 'list') {
      const accounts = await listCodexAccounts();
      if (!accounts.length) {
        console.log('No Codex accounts found under ~/.accountbox/codex yet.');
        console.log('Run: accountbox codex <account> login');
        return;
      }
      console.log('Codex accounts:');
      for (const a of accounts) {
        console.log(`- ${a.account}${a.hasAuth ? '' : ' (no auth.json yet)'}`);
      }
      return;
    }

    if (cmd === 'snapshots') {
      const snaps = await listCodexSnapshots();
      if (!snaps.length) {
        console.log('No Codex snapshots found under ~/.accountbox/codex-snapshots yet.');
        console.log('Create one: accountbox codex <account> save <snapshotName>');
        return;
      }
      console.log('Codex snapshots:');
      for (const s of snaps) {
        console.log(`- ${s.name}${s.hasAuth ? '' : ' (missing auth.json)'}`);
      }
      return;
    }

    if (cmd === 'save') {
      const snapshotName = normArgs[1];
      if (!snapshotName) throw new Error('Usage: accountbox codex <account> save <snapshotName>');
      const dst = await saveCodexSnapshot(resolved, snapshotName);
      console.log(`Saved snapshot '${snapshotName}' from account '${resolved}' -> ${dst}`);
      return;
    }

    if (cmd === 'switch') {
      const snapshotName = normArgs[1];
      const toAccount = normArgs[2] || resolved;
      if (!snapshotName) throw new Error('Usage: accountbox codex [account] switch <snapshotName> [toAccount]');
      const dst = await applyCodexSnapshotToAccount(snapshotName, toAccount);
      console.log(`Applied snapshot '${snapshotName}' -> account '${toAccount}' (${dst}) and synced to Docker volume.`);
      return;
    }

    if (cmd === 'use') {
      const toAccount = normArgs[1];
      if (!toAccount) throw new Error('Usage: accountbox codex use <account> (writes .accountbox.toml in current repo)');
      const f = await setProjectDefault('codex', toAccount, cwd);
      console.log(`Updated ${f} (codex_account = "${toAccount}")`);
      return;
    }

    await runCodex(resolved, normArgs, cwd);
  });

program
  .command('claude')
  .allowUnknownOption(true)
  .argument('[account]')
  .argument('[args...]')
  .description('Run Claude Code natively with per-account XDG isolation')
  .action(async (account, args) => {
    const cwd = process.cwd();
    const { data } = await readProjectConfig(cwd);

    const {
      accountArg,
      argsList,
      accountIsSubcommand,
      accountLooksLikeOption,
    } = disambiguateAccountArg({ account, args, knownSubcommands: CLAUDE_KNOWN_SUBCOMMANDS });

    const resolved = accountArg
      ? resolveAccountOrThrow(accountArg, 'claude_account', data)
      : (accountIsSubcommand || accountLooksLikeOption)
        ? (data?.claude_account || 'default')
        : resolveAccountOrThrow(undefined, 'claude_account', data);

    await runClaude(resolved, argsList, cwd);
  });

program
  .command('run')
  .allowUnknownOption(true)
  .argument('<tool>')
  .argument('[account]')
  .argument('[args...]')
  .description('Run an arbitrary tool from config (extensible)')
  .action(async (tool, account, args) => {
    const cwd = process.cwd();
    const toolId = normalizeToolId(tool);

    const { accountArg, argsList } = disambiguateAccountArg({ account, args, knownSubcommands: null });

    // Built-ins remain available via run
    if (toolId === 'codex') {
      const argv = ['codex'];
      if (accountArg) argv.push(accountArg);
      argv.push(...argsList);
      await program.parseAsync(argv, { from: 'user' });
      return;
    }
    if (toolId === 'claude') {
      const argv = ['claude'];
      if (accountArg) argv.push(accountArg);
      argv.push(...argsList);
      await program.parseAsync(argv, { from: 'user' });
      return;
    }

    const proj = await readProjectConfig(cwd);
    const user = await readUserToolsConfig();
    const tools = mergeTools(proj.data, user.data);
    const def = tools?.[toolId];
    if (!def) {
      throw new Error(`Unknown tool '${toolId}'. Define it in ${USER_TOOLS_TOML_DEFAULT} under [tools.${toolId}] (or set ACCOUNTBOX_TOOLS_TOML), or in .accountbox.toml under [tools.${toolId}].`);
    }

    const defaultsKey = `${toolId}_account`;
    const resolved = resolveAccountOrThrow(accountArg, defaultsKey, proj.data);

    const mode = def.mode || 'native';
    if (mode === 'native') {
      const command = def.command;
      if (!command) throw new Error(`Tool '${toolId}' is native but missing 'command' in config.`);

      const isolate = def.isolate !== false; // default true
      const extraEnv = def.env || {};
      await runNativeTool({ toolId, account: resolved, command, args: argsList, cwd, isolate, extraEnv });
      return;
    }

    if (mode === 'container') {
      const image = def.image;
      if (!image) throw new Error(`Tool '${toolId}' is container but missing 'image' in config.`);

      const workdir = def.workdir || '/work';
      const configMountPath = def.configMountPath; // optional
      await runContainerTool({ toolId, account: resolved, image, args: argsList, cwd, workdir, configMountPath });
      return;
    }

    throw new Error(`Tool '${toolId}' has unsupported mode '${mode}'. Use 'native' or 'container'.`);
  });

program
  .command('set')
  .argument('<tool>', 'codex|claude|<toolId>')
  .argument('<account>')
  .description('Set per-project default account in .accountbox.toml (writes at repo root)')
  .action(async (tool, account) => {
    const f = await setProjectDefault(tool, account, process.cwd());
    console.log(`Updated ${f}`);
  });

program
  .command('browser')
  .argument('<account>')
  .argument('<url>')
  .description('Open a URL in a sandboxed browser profile for an account (Chrome if available)')
  .action(async (account, url) => {
    await openSandboxedBrowser(account, url);
  });

program
  .command('doctor')
  .description('Show runtime status and key paths')
  .action(async () => {
    const cwd = process.cwd();
    const gitRoot = await findGitRoot(cwd);
    const project = await readProjectConfig(cwd);

    console.log(`cwd: ${cwd}`);
    console.log(`git root: ${gitRoot || 'n/a'}`);
    console.log(`project config: ${project.file || 'n/a'}`);
    console.log(`default codex_account: ${project.data?.codex_account || 'n/a'}`);
    console.log(`default claude_account: ${project.data?.claude_account || 'n/a'}`);
    console.log(`accountbox home: ${ACCOUNTBOX_HOME}`);
    console.log(`user tools config: ${await resolveUserToolsTomlPath()}`);
    console.log(`codex image: ${CODEX_IMAGE_NAME}:latest (npm spec: ${CODEX_NPM_SPEC})`);

    let dockerStatus = 'missing';
    try {
      const dockerOk = await execa('docker', ['ps'], { reject: false, stdio: 'ignore' });
      dockerStatus = dockerOk.exitCode === 0 ? 'OK' : 'NOT REACHABLE';
    } catch (e) {
      dockerStatus = isErrno(e, 'ENOENT') ? 'missing' : 'NOT REACHABLE';
    }
    console.log(`docker runtime: ${dockerStatus}`);

    let claudeStatus = 'missing';
    try {
      const claudeV = await execa('claude', ['--version'], { reject: false });
      claudeStatus = claudeV.exitCode === 0 ? claudeV.stdout.trim() : 'missing';
    } catch (e) {
      claudeStatus = isErrno(e, 'ENOENT') ? 'missing' : 'error';
    }
    console.log(`claude: ${claudeStatus}`);
  });

program
  .command('install')
  .alias('i')
  .description('Interactive installer (auto-runs installs with confirmation)')
  .action(async () => {
    const opts = program.opts();
    await cmdInstall({ serious: !!opts.serious, quiet: !!opts.quiet });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
