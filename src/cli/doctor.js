import { execa } from 'execa';
import process from 'node:process';
import { CODEX_IMAGE_NAME, CODEX_NPM_SPEC, ACCOUNTBOX_HOME } from '../core/env.js';
import { findGitRoot } from '../config/git.js';
import { readProjectConfig } from '../config/project.js';
import { resolveUserToolsTomlPath } from '../config/userTools.js';
import { isErrno } from '../util/errors.js';

export async function getDoctorInfo({ cwd } = {}) {
  const effectiveCwd = cwd || process.cwd();
  const gitRoot = await findGitRoot(effectiveCwd);
  const project = await readProjectConfig(effectiveCwd);

  let dockerStatus = { status: 'missing' };
  try {
    const dockerOk = await execa('docker', ['ps'], { reject: false, stdio: 'ignore' });
    dockerStatus = dockerOk.exitCode === 0 ? { status: 'OK' } : { status: 'NOT_REACHABLE' };
  } catch (e) {
    dockerStatus = isErrno(e, 'ENOENT') ? { status: 'missing' } : { status: 'NOT_REACHABLE' };
  }

  let claudeStatus = { status: 'missing' };
  try {
    const claudeV = await execa('claude', ['--version'], { reject: false });
    claudeStatus = claudeV.exitCode === 0 ? { status: 'OK', version: claudeV.stdout.trim() } : { status: 'missing' };
  } catch (e) {
    claudeStatus = isErrno(e, 'ENOENT') ? { status: 'missing' } : { status: 'error' };
  }

  return {
    cwd: effectiveCwd,
    gitRoot,
    projectConfig: project.file,
    defaults: {
      codex_account: project.data?.codex_account || null,
      claude_account: project.data?.claude_account || null,
    },
    accountboxHome: ACCOUNTBOX_HOME,
    userToolsConfig: await resolveUserToolsTomlPath(),
    codex: {
      image: `${CODEX_IMAGE_NAME}:latest`,
      npmSpec: CODEX_NPM_SPEC,
    },
    docker: dockerStatus,
    claude: claudeStatus,
  };
}

export function printDoctorInfo(info) {
  console.log(`cwd: ${info.cwd}`);
  console.log(`git root: ${info.gitRoot || 'n/a'}`);
  console.log(`project config: ${info.projectConfig || 'n/a'}`);
  console.log(`default codex_account: ${info.defaults.codex_account || 'n/a'}`);
  console.log(`default claude_account: ${info.defaults.claude_account || 'n/a'}`);
  console.log(`accountbox home: ${info.accountboxHome}`);
  console.log(`user tools config: ${info.userToolsConfig}`);
  console.log(`codex image: ${info.codex.image} (npm spec: ${info.codex.npmSpec})`);
  console.log(`docker runtime: ${info.docker.status === 'OK' ? 'OK' : info.docker.status === 'NOT_REACHABLE' ? 'NOT REACHABLE' : 'missing'}`);
  console.log(`claude: ${info.claude.status === 'OK' ? info.claude.version : info.claude.status}`);
}

