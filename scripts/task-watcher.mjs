#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection } from '../lib/cloud-connection-store.mjs';
import {
  getICloudDocumentsRoot,
  isICloudFilesystemConnection,
  SPOTLIGHT_TASK_MARKER_QUERY,
} from '../lib/icloud-storage.mjs';
import {
  findRunningExpectedWatcherPid,
  getExpectedWatcherScriptPath,
  getWatcherPidPath,
  isCanonicalWatcherScript,
  listWatchPaths,
  readWatcherPidFile,
  scanAllProjectFolders,
  writeWatcherPidFile,
} from '../lib/task-monitor.mjs';
import { LOG_PREFIX } from '../lib/constants.mjs';
import { debugLog, getDebugLogPath } from '../lib/debug-log.mjs';
import { initWorkspaceScopeFromEnvironment, getWorkspaceRoots } from '../lib/workspace-scope.mjs';

const MDFIND_BIN = '/usr/bin/mdfind';

initWorkspaceScopeFromEnvironment();

const POLL_INTERVAL_MS = Number(process.env.REMOTECODE_TASK_POLL_MS ?? 5_000);
const pidPath = getWatcherPidPath();

function removePidFile() {
  if (pidPath && fs.existsSync(pidPath)) {
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
      void scanAllProjectFolders({ forceICloudRefresh: true });
    }, 250);
  };

  const refresh = () => {
    const paths = [...listWatchPaths(getWorkspaceRoots())];

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
  startSpotlightLiveWatch(scheduleScan);
}

function startSpotlightLiveWatch(scheduleScan) {
  if (process.platform !== 'darwin' || !isICloudFilesystemConnection(loadConnection())) {
    return;
  }

  const documentsRoot = getICloudDocumentsRoot();
  if (!fs.existsSync(documentsRoot)) {
    return;
  }

  const child = spawn(
    MDFIND_BIN,
    ['-live', '-onlyin', documentsRoot, SPOTLIGHT_TASK_MARKER_QUERY],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );

  child.stdout.on('data', () => {
    scheduleScan();
  });

  child.on('error', error => {
    const message = error instanceof Error ? error.message : String(error);
    debugLog('watcher', `Spotlight live watch failed: ${message}`);
  });

  child.on('close', code => {
    debugLog('watcher', `Spotlight live watch exited (${code}); restarting in 5s.`);
    setTimeout(() => {
      startSpotlightLiveWatch(scheduleScan);
    }, 5_000);
  });

  debugLog('watcher', `Spotlight live watch started on ${documentsRoot}.`);
}

async function main() {
  const thisScript = path.resolve(fileURLToPath(import.meta.url));
  if (!isCanonicalWatcherScript(thisScript)) {
    process.exit(0);
  }

  const expectedScript = path.resolve(getExpectedWatcherScriptPath());
  const runningPid = findRunningExpectedWatcherPid();
  if (runningPid && runningPid !== process.pid) {
    process.exit(0);
  }

  const existing = readWatcherPidFile();
  if (existing?.pid && existing.pid !== process.pid) {
    try {
      process.kill(existing.pid, 0);
      const existingScript = existing.scriptPath ? path.resolve(existing.scriptPath) : null;
      if (existingScript === expectedScript) {
        process.exit(0);
      }
    } catch {
      // Stale pid file — this process will take over below.
    }
  }

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
  await scanAllProjectFolders({ forceICloudRefresh: true });
  setInterval(() => {
    void scanAllProjectFolders({ forceICloudRefresh: true });
  }, POLL_INTERVAL_MS);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${LOG_PREFIX} Task watcher failed: ${message}\n`);
  removePidFile();
  process.exit(1);
});
