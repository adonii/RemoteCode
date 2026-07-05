import { spawn } from 'node:child_process';

/** @type {import('node:child_process').ChildProcess | null} */
let blockerProcess = null;

function startBlocker() {
  if (blockerProcess) {
    return;
  }

  if (process.platform === 'darwin') {
    blockerProcess = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
  } else if (process.platform === 'linux') {
    blockerProcess = spawn(
      'systemd-inhibit',
      ['--what=sleep:idle', '--who=RemotePromptCode', '--why=Remote task server', 'sleep', 'infinity'],
      { stdio: 'ignore' },
    );
  } else {
    return;
  }

  blockerProcess.on('exit', () => {
    blockerProcess = null;
  });
  blockerProcess.on('error', () => {
    blockerProcess = null;
  });
}

export function applyPreventSleep(enabled) {
  if (enabled) {
    startBlocker();
    return;
  }

  stopPreventSleep();
}

export function stopPreventSleep() {
  if (!blockerProcess) {
    return;
  }

  blockerProcess.kill();
  blockerProcess = null;
}
