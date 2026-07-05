import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './cloud-connection-store.mjs';

const SIGNAL_PATH = path.join(CONFIG_DIR, 'run-task-detected-at.json');

/**
 * Watcher subprocess calls this when it finds a task in `run` state so the
 * extension-host orchestrator can react without waiting for the next poll.
 *
 * @param {string} taskFolderPath
 */
export function signalRunTaskDetected(taskFolderPath) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    SIGNAL_PATH,
    `${JSON.stringify({ at: Date.now(), path: taskFolderPath })}\n`,
    'utf8',
  );
}

/** @returns {{ at: number, path: string } | null} */
export function readRunTaskSignal() {
  if (!fs.existsSync(SIGNAL_PATH)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SIGNAL_PATH, 'utf8'));
    if (typeof parsed?.at === 'number' && typeof parsed?.path === 'string') {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}
