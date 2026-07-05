import fs from 'node:fs';
import { loadProjectRecords } from './cloud-connection-store.mjs';
import { resolveProjectTargets } from './project-targets.mjs';
import { listWatchPaths } from './task-monitor.mjs';
import {
  consumeTaskWatchSnapshotChange,
  resetTaskWatchSnapshot,
} from './task-watch-snapshot.mjs';

const WATCH_REFRESH_MS = 5_000;
const DEBOUNCE_MS = 500;

/** @type {Map<string, fs.FSWatcher>} */
const watchers = new Map();
/** @type {ReturnType<typeof setInterval> | null} */
let refreshTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let debounceTimer = null;
/** @type {(() => void) | null} */
let onChangeCallback = null;
/** @type {string[] | null} */
let activeWorkspaceRoots = null;
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
    void notifyIfTaskSnapshotChanged();
  }, DEBOUNCE_MS);
}

async function notifyIfTaskSnapshotChanged() {
  const roots =
    Array.isArray(activeWorkspaceRoots) && activeWorkspaceRoots.length > 0
      ? activeWorkspaceRoots
      : null;

  const changed = await consumeTaskWatchSnapshotChange(roots, {
    forceICloudRefresh: true,
  });
  if (changed) {
    onChangeCallback?.();
  }
}

function getScopedWatchPaths() {
  if (!activeWorkspaceRoots || activeWorkspaceRoots.length === 0) {
    return [];
  }

  return [...listWatchPaths(activeWorkspaceRoots)];
}

function refreshWatchers() {
  const paths = getScopedWatchPaths();

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

/**
 * Watch project task folders and notify when task folders or `.state` change.
 * Idempotent; safe to call more than once.
 *
 * @param {() => void} onChange debounced callback
 * @param {string[] | null} workspaceRoots null watches all saved cloud projects
 */
export function startTaskChangeWatcher(onChange, workspaceRoots) {
  onChangeCallback = onChange;
  activeWorkspaceRoots =
    Array.isArray(workspaceRoots) && workspaceRoots.length > 0 ? [...workspaceRoots] : null;
  resetTaskWatchSnapshot(activeWorkspaceRoots);
  refreshWatchers();

  if (!refreshTimer) {
    refreshTimer = setInterval(refreshWatchers, WATCH_REFRESH_MS);
  }
}

export function stopTaskChangeWatcher() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  notifyScheduled = false;
  onChangeCallback = null;
  activeWorkspaceRoots = null;

  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
}
