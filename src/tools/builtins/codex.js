import { execa } from 'execa';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import {
  ACCOUNTBOX_HOME,
  CODEX_DOCKERFILE_DIR,
  CODEX_HOST_NPM_SPEC,
  CODEX_IMAGE_NAME,
  CODEX_NPM_SPEC,
} from '../../core/env.js';
import { openSandboxedBrowser, resetSandboxedBrowserProfile } from '../../browser.js';
import { exists, ensureDir } from '../../util/fs.js';
import { isErrno } from '../../util/errors.js';
import { timestampForFilename } from '../../util/time.js';
import { decodeJwtPayload, formatCredits, formatRateLimit, maskEmail, maskId, sanitizeWhamUsage } from '../../util/format.js';
import { hasAny, readOptionNumber } from '../../util/args.js';

export const CODEX_HELPER_SUBCOMMANDS = new Set([
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

async function codexImageExists() {
  const inspect = await execa('docker', ['image', 'inspect', `${CODEX_IMAGE_NAME}:latest`], { reject: false, stdio: 'ignore' });
  return inspect.exitCode === 0;
}

export async function ensureCodexImage({ forceRebuild = false } = {}) {
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

export async function runCodexInContainer(account, args, cwd) {
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

export async function codexLoginWithApiKey(account, apiKey, cwd) {
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

  if (method === 'browser') {
    await ensureCodexLoginPortFree(1455);
  }

  const baseArgs = ['--config', 'cli_auth_credentials_store="file"'];

  const urlRe = /(https:\/\/auth\.openai\.com\/(?:oauth\/authorize\?[^\s]+|[^\s]+))/;
  let opened = false;

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

  await syncCodexAuthToVolume(account);
}

async function codexLoginStatus(account) {
  await ensureCodexImage();
  const volume = `accountbox_codex_${account}`;
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

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

export function createCodexTool() {
  return {
    id: 'codex',
    async run({ account, args, cwd }) {
      await runCodexInContainer(account, args, cwd);
    },

    async app({ account, args }) {
      const quitFirst = args.includes('--quit') || args.includes('--quit-first') || args.includes('--restart');
      const multi = args.includes('--multi');
      await openCodexApp(account, { quitFirst, multi });
    },

    async login({ account, args, cwd }) {
      const wantsApiKey = hasAny(args, ['api-key', '--api-key', 'with-api-key', '--with-api-key']);
      const wantsBrowser = hasAny(args, ['browser', '--browser']);
      const wantsDevice = hasAny(args, ['device', '--device', '--device-auth']);
      const force = hasAny(args, ['force', '--force']);
      const freshBrowser = hasAny(args, ['fresh-browser', '--fresh-browser', 'reset-browser', '--reset-browser']);
      const method = wantsBrowser ? 'browser' : (wantsDevice ? 'device' : 'device');

      if (wantsApiKey) {
        const key = process.env.OPENAI_API_KEY;
        if (!key) {
          throw new Error('OPENAI_API_KEY env var is required for api-key login. Example: OPENAI_API_KEY=... accountbox codex <account> login --api-key');
        }
        await codexLoginWithApiKey(account, key, cwd);
        try { await codexLoginStatus(account); } catch {}
        return;
      }

      if (method === 'browser' && freshBrowser) {
        const bak = await resetSandboxedBrowserProfile(account);
        if (bak) console.log(`Reset sandboxed browser profile: moved -> ${bak}`);
      }

      await codexHostLoginAndSync(account, { method, openBrowser: true, force });
      try { await codexLoginStatus(account); } catch {}
    },

    async logout({ account, cwd }) {
      await runCodexInContainer(account, ['logout'], cwd);
      const bak = await codexHostLogout(account);
      if (bak) console.log(`Moved host auth.json -> ${bak}`);
    },

    async status({ account }) {
      await codexLoginStatus(account);
    },

    async whoami({ account }) {
      await codexWhoami(account);
    },

    async limits({ account, args, allAccounts = false }) {
      const json = args.includes('--json');
      const raw = args.includes('--raw');
      const timeoutMs = Math.max(1, Math.trunc(readOptionNumber(args, '--timeout-ms', 10_000)));
      const concurrency = Math.max(1, Math.min(8, Math.trunc(readOptionNumber(args, '--concurrency', 4))));

      if (allAccounts) {
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

      const r = await codexLimitsForAccount(account, { timeoutMs });
      if (json) {
        console.log(JSON.stringify({
          account,
          ok: r.ok,
          ...(r.ok ? { usage: raw ? r.usage : sanitizeWhamUsage(r.usage) } : { error: r.error }),
        }, null, 2));
        return;
      }
      if (!r.ok) {
        console.log(`${account}: ${r.error}`);
        return;
      }
      const u = r.usage || {};
      console.log(`${account}: plan=${u.plan_type || 'n/a'} email=${maskEmail(u.email) || 'n/a'} rate=${formatRateLimit(u.rate_limit)} review=${formatRateLimit(u.code_review_rate_limit)} credits=${formatCredits(u.credits)}`);
    },

    async rebuild() {
      await ensureCodexImage({ forceRebuild: true });
      const v = await execa('docker', ['run', '--rm', `${CODEX_IMAGE_NAME}:latest`, '-V'], { reject: false });
      if (v.exitCode === 0) console.log(v.stdout.trim());
    },

    async list() {
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
    },

    async snapshots() {
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
    },

    async save({ account, args }) {
      const snapshotName = args[1];
      if (!snapshotName) throw new Error('Usage: accountbox codex <account> save <snapshotName>');
      const dst = await saveCodexSnapshot(account, snapshotName);
      console.log(`Saved snapshot '${snapshotName}' from account '${account}' -> ${dst}`);
    },

    async switch({ account, args, defaultAccount }) {
      const snapshotName = args[1];
      const toAccount = args[2] || account || defaultAccount;
      if (!snapshotName) throw new Error('Usage: accountbox codex [account] switch <snapshotName> [toAccount]');
      const dst = await applyCodexSnapshotToAccount(snapshotName, toAccount);
      console.log(`Applied snapshot '${snapshotName}' -> account '${toAccount}' (${dst}) and synced to Docker volume.`);
    },

    async use({ args, cwd, setProjectDefault }) {
      const toAccount = args[1];
      if (!toAccount) throw new Error('Usage: accountbox codex use <account> (writes .accountbox.toml in current repo)');
      const f = await setProjectDefault('codex', toAccount, cwd);
      console.log(`Updated ${f} (codex_account = "${toAccount}")`);
    },
  };
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
