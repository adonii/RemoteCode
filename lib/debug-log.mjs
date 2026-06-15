import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR_NAME, LOG_PREFIX } from '../shared/constants.mjs';

const DEBUG_LOG_PATH = path.join(os.homedir(), CONFIG_DIR_NAME, 'remotecode-debug.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function getDebugLogPath() {
  return DEBUG_LOG_PATH;
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(DEBUG_LOG_PATH);
    if (stat.size > MAX_LOG_BYTES) {
      fs.renameSync(DEBUG_LOG_PATH, `${DEBUG_LOG_PATH}.1`);
    }
  } catch {
    // No existing log file yet; nothing to rotate.
  }
}

/**
 * Append a timestamped line to the shared debug log AND mirror it to stderr.
 * The watcher runs detached with stdio ignored, so the file is the only place
 * its logs survive.
 *
 * @param {string} scope short tag, e.g. 'dispatch', 'monitor', 'watcher'
 * @param {string} message
 */
export function debugLog(scope, message) {
  const line = `${new Date().toISOString()} [${scope}] ${message}`;

  process.stderr.write(`${LOG_PREFIX} ${line}\n`);

  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(DEBUG_LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // Logging must never throw into the caller.
  }
}
