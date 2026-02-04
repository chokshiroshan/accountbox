import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { ACCOUNTBOX_HOME, CODEX_IMAGE_NAME, CODEX_NPM_SPEC } from '../core/env.js';
import { findGitRoot } from '../config/git.js';
import { setProjectDefault } from '../config/project.js';
import { ensureDir } from '../util/fs.js';
import { isErrno } from '../util/errors.js';
import { ensureCodexImage, codexLoginWithApiKey } from '../tools/builtins/codex.js';

async function promptYesNo(rl, message, def = true) {
  const suffix = def ? '[Y/n]' : '[y/N]';
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

async function codexImageExists() {
  const inspect = await execa('docker', ['image', 'inspect', `${CODEX_IMAGE_NAME}:latest`], { reject: false, stdio: 'ignore' });
  return inspect.exitCode === 0;
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

export async function cmdInstall({ serious = false, quiet = false, codexTool } = {}) {
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

          if (method === 'api-key' || method === 'apikey') {
            log.say('API-key login selected. Paste your API key now (input hidden not supported yet).');
            const key = await promptText(rl, 'OPENAI_API_KEY:', '');
            if (!key) {
              log.info('No key provided. Skipping API-key login.');
              return;
            }
            await codexLoginWithApiKey(acct, key, process.cwd());
            return;
          }

          if (!codexTool) throw new Error('Internal error: codexTool not provided to installer.');
          const loginArgs = method === 'browser' ? ['--browser'] : ['--device'];

          log.say(`Starting: codex login (${method} flow, host) + sync to container volume`);
          await codexTool.login({ account: acct, args: loginArgs, cwd: process.cwd() });
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

