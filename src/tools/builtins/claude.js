import { execa } from 'execa';
import path from 'node:path';
import { ACCOUNTBOX_HOME } from '../../core/env.js';
import { ensureDir } from '../../util/fs.js';

export const CLAUDE_KNOWN_SUBCOMMANDS = new Set([
  'doctor',
  'install',
  'mcp',
  'plugin',
  'setup-token',
  'update',
]);

export function createClaudeTool() {
  return {
    id: 'claude',
    async run({ account, args, cwd }) {
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
    },
  };
}

