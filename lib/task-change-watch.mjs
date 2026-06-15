import fs from 'node:fs';
import { SESSIONS_DIR } from './cloud-connection-store.mjs';
import {
  isICloudFilesystemConnection,
  scheduleICloudStorageRefresh,
} from './icloud-storage.mjs';
import { listWatchPaths } from './task-monitor.mjs';

const WATCH_REFRESH_MS = 5_000;
const ICLOUD_POLL_MS = 2_000;
const DEBOUNCE_MS = 250;

/** @type {Map<string, fs.FSWatcher>} */
const watchers = new Map();
/** @type {ReturnType<typeof setInterval> | null} */
let refreshTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let icloudPollTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let debounceTimer = null;
/** @type {(() => void) | null} */
let onChangeCallback = null;
let notifyScheduled = false;

function scheduleNotify() {
  if (notifyScheduled) {
    return;
  }

  notifyScheduled = true;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    notifyScheduled = false;
    onChangeCallback?.();
  }, DEBOUNCE_MS);
}

function refreshWatchers() {
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
      const watcher = fs.watch(watchPath, { persistent: false }, () => {
        scheduleNotify();
      });
      watchers.set(watchPath, watcher);
    } catch {
      // iCloud paths can fail fs.watch intermittently; polling still covers them.
    }
  }
}

function pollICloudStorage() {
  if (!isICloudFilesystemConnection()) {
    return;
  }

  scheduleICloudStorageRefresh();
  scheduleNotify();
}

/**
 * Watch project task folders and notify when anything changes on disk.
 * Idempotent; safe to call more than once.
 *
 * @param {() => void} onChange debounced callback
 */
export function startTaskChangeWatcher(onChange) {
  onChangeCallback = onChange;
  refreshWatchers();

  if (!refreshTimer) {
    refreshTimer = setInterval(refreshWatchers, WATCH_REFRESH_MS);
  }

  if (!icloudPollTimer && isICloudFilesystemConnection()) {
    pollICloudStorage();
    icloudPollTimer = setInterval(pollICloudStorage, ICLOUD_POLL_MS);
  }
}

export function stopTaskChangeWatcher() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  if (icloudPollTimer) {
    clearInterval(icloudPollTimer);
    icloudPollTimer = null;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  notifyScheduled = false;
  onChangeCallback = null;

  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
}
