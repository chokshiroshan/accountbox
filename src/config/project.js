import fs from 'node:fs/promises';
import path from 'node:path';
import toml from 'toml';
import { exists } from '../util/fs.js';
import { findGitRoot } from './git.js';

export async function findProjectConfigToml(cwd) {
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

export async function readProjectConfig(cwd) {
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

export function resolveAccountOrThrow(passed, defaultsKey, config) {
  const a = passed || config?.[defaultsKey];
  if (!a) throw new Error(`Missing account. Provide <account> or set a default in .accountbox.toml (${defaultsKey}).`);
  return a;
}

export async function setProjectDefault(tool, account, cwd) {
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

