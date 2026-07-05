import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './cloud-connection-store.mjs';

export const GLOBAL_ICLOUD_REFRESH_MS = 8_000;
export const GLOBAL_SCAN_COOLDOWN_MS = 15_000;

const ICLOUD_REFRESH_STAMP = path.join(CONFIG_DIR, 'icloud-refresh-at.json');
const SCAN_REQUEST_STAMP = path.join(CONFIG_DIR, 'scan-request-at.json');

/**
 * @param {string} stampPath
 * @param {number} minIntervalMs
 */
function tryClaimStamp(stampPath, minIntervalMs) {
  const now = Date.now();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  let lastAt = 0;
  if (fs.existsSync(stampPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
      if (typeof parsed?.at === 'number') {
        lastAt = parsed.at;
      }
    } catch {
      lastAt = 0;
    }
  }

  if (now - lastAt < minIntervalMs) {
    return false;
  }

  fs.writeFileSync(
    stampPath,
    `${JSON.stringify({ at: now, pid: process.pid })}\n`,
    'utf8',
  );
  return true;
}

/** @returns {boolean} */
export function tryClaimGlobalICloudRefresh(minIntervalMs = GLOBAL_ICLOUD_REFRESH_MS) {
  return tryClaimStamp(ICLOUD_REFRESH_STAMP, minIntervalMs);
}

/** @returns {boolean} */
export function tryClaimBackgroundScan(minIntervalMs = GLOBAL_SCAN_COOLDOWN_MS) {
  return tryClaimStamp(SCAN_REQUEST_STAMP, minIntervalMs);
}
