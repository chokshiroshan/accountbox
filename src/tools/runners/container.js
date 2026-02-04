import { execa } from 'execa';

export async function runContainerTool({ toolId, account, image, args, cwd, workdir = '/work', configMountPath }) {
  await execa('docker', ['ps'], { stdio: 'ignore' });

  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  const mounts = [
    '-v', `${cwd}:${workdir}`,
    '-w', workdir,
  ];

  if (configMountPath) {
    const volume = `accountbox_${toolId}_${account}`;
    mounts.push('-v', `${volume}:${configMountPath}`);
  }

  await execa('docker', [
    'run', '--rm',
    ...(interactive ? ['-it'] : ['-i']),
    ...mounts,
    image,
    ...args,
  ], { stdio: 'inherit' });
}
