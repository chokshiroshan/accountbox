import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ACCOUNTBOX_HOME } from './core/env.js';
import { ensureDir, exists } from './util/fs.js';
import { timestampForFilename } from './util/time.js';
import { isErrno } from './util/errors.js';

export function browserProfileDir(account) {
  return path.join(ACCOUNTBOX_HOME, 'browser', account);
}

export async function resetSandboxedBrowserProfile(account) {
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

export async function openSandboxedBrowser(account, url) {
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
