import { findUp } from 'find-up';
import path from 'node:path';

export async function findGitRoot(cwd) {
  const gitDir = await findUp('.git', { cwd, type: 'directory' });
  if (gitDir) return path.dirname(gitDir);

  // git worktrees/submodules often have a `.git` *file* pointing at the real gitdir.
  const gitFile = await findUp('.git', { cwd, type: 'file' });
  return gitFile ? path.dirname(gitFile) : null;
}

