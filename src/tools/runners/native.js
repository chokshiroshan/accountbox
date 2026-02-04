import { execa } from 'execa';
import path from 'node:path';
import { ACCOUNTBOX_HOME } from '../../core/env.js';
import { ensureDir } from '../../util/fs.js';

export async function runNativeTool({ toolId, account, command, args, cwd, isolate = true, extraEnv = {} }) {
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

