import fs from 'node:fs/promises';
import toml from 'toml';
import { USER_TOOLS_TOML_DEFAULT, USER_TOOLS_TOML_LEGACY } from '../core/env.js';
import { exists } from '../util/fs.js';

export async function resolveUserToolsTomlPath() {
  if (process.env.ACCOUNTBOX_TOOLS_TOML) return USER_TOOLS_TOML_DEFAULT;
  if (await exists(USER_TOOLS_TOML_DEFAULT)) return USER_TOOLS_TOML_DEFAULT;
  if (await exists(USER_TOOLS_TOML_LEGACY)) return USER_TOOLS_TOML_LEGACY;
  return USER_TOOLS_TOML_DEFAULT;
}

export async function readUserToolsConfig() {
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

