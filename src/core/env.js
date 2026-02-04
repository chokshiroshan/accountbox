import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

export const ACCOUNTBOX_VERSION = pkg.version;

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export const ACCOUNTBOX_HOME = process.env.ACCOUNTBOX_HOME || path.join(os.homedir(), '.accountbox');

export const CODEX_IMAGE_NAME = process.env.ACCOUNTBOX_CODEX_IMAGE_NAME || 'accountbox-codex';
export const CODEX_NPM_SPEC = process.env.ACCOUNTBOX_CODEX_NPM_SPEC || '@openai/codex@latest';
export const CODEX_HOST_NPM_SPEC = process.env.ACCOUNTBOX_CODEX_HOST_NPM_SPEC || CODEX_NPM_SPEC;
export const CODEX_DOCKERFILE_DIR = process.env.ACCOUNTBOX_CODEX_DOCKERFILE_DIR || PROJECT_ROOT;

export const XDG_CONFIG_HOME_DEFAULT = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
export const USER_TOOLS_TOML_DEFAULT =
  process.env.ACCOUNTBOX_TOOLS_TOML || path.join(XDG_CONFIG_HOME_DEFAULT, 'accountbox', 'tools.toml');
export const USER_TOOLS_TOML_LEGACY = path.join(ACCOUNTBOX_HOME, 'tools.toml');

