#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  getWatcherPidPath,
  listWatchPaths,
  scanAllProjectFolders,
  writeWatcherPidFile,
} from '../lib/task-monitor.mjs';
import { SESSIONS_DIR } from '../lib/cloud-connection-store.mjs';
import { LOG_PREFIX } from '../lib/constants.mjs';
import { debugLog, getDebugLogPath } from '../lib/debug-log.mjs';

const POLL_INTERVAL_MS = Number(process.env.REMOTECODE_TASK_POLL_MS ?? 2_000);
const pidPath = getWatcherPidPath();

function removePidFile() {
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }
}

function watchFilesystemTabs() {
  const watchers = new Map();
  let scanScheduled = false;

  const scheduleScan = () => {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      void scanAllProjectFolders();
    }, 250);
  };

  const refresh = () => {
    const paths = [...listWatchPaths()];
    if (fs.existsSync(SESSIONS_DIR)) {
      paths.push(SESSIONS_DIR);
    }

    for (const [watchPath, watcher] of watchers.entries()) {
      if (!paths.includes(watchPath)) {
        watcher.close();
        watchers.delete(watchPath);
      }
    }

    for (const watchPath of paths) {
      if (watchers.has(watchPath)) {
        continue;
      }

      try {
        const watcher = fs.watch(watchPath, { persistent: true }, () => {
          scheduleScan();
        });
        watchers.set(watchPath, watcher);
      } catch {
        // iCloud paths can fail fs.watch intermittently; polling still covers them.
      }
    }
  };

  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
}

async function main() {
  writeWatcherPidFile();
  debugLog(
    'watcher',
    `Task watcher started (pid ${process.pid}, interval ${POLL_INTERVAL_MS}ms, ` +
      `log ${getDebugLogPath()}).`,
  );

  const shutdown = () => {
    debugLog('watcher', `Task watcher stopping (pid ${process.pid}).`);
    removePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  watchFilesystemTabs();
  await scanAllProjectFolders();
  setInterval(() => {
    void scanAllProjectFolders();
  }, POLL_INTERVAL_MS);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${LOG_PREFIX} Task watcher failed: ${message}\n`);
  removePidFile();
  process.exit(1);
});
