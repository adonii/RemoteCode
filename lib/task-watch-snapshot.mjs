import fs from 'node:fs';
import path from 'node:path';
import { loadConnection, loadProjectRecords } from './cloud-connection-store.mjs';
import {
  invalidateICloudListCache,
  isICloudFilesystemConnection,
  refreshICloudStorageForScan,
} from './icloud-storage.mjs';
import {
  createTaskFolder,
  listProjectTaskFolderNames,
  resolveScopedProjectTargets,
} from './project-targets.mjs';
import { TASK_STATE_FILE } from './task-states.mjs';
import { workspaceScopeKey } from './workspace-scope.mjs';

/** @type {Map<string, string>} */
const snapshotsByScope = new Map();

async function readTaskMarker(target, connection, taskFolderName) {
  const taskFolder = createTaskFolder(target, connection, taskFolderName);
  if (target.mode === 'filesystem') {
    const statePath = path.join(taskFolder.taskFolderPath, TASK_STATE_FILE);
    if (!fs.existsSync(statePath)) {
      return 'none';
    }

    return String(fs.statSync(statePath).mtimeMs);
  }

  const state = taskFolder.getState();
  return (state instanceof Promise ? await state : state) ?? 'none';
}

/**
 * Serialize task folder names and `.state` markers for the scoped workspace.
 *
 * @param {string[] | null | undefined} workspaceRoots
 */
export async function collectTaskWatchSnapshot(workspaceRoots) {
  const connection = loadConnection();
  if (!connection) {
    return '';
  }

  const parts = [];
  for (const target of resolveScopedProjectTargets(loadProjectRecords(), workspaceRoots)) {
    let taskFolderNames = [];
    try {
      taskFolderNames = await listProjectTaskFolderNames(target, connection);
    } catch {
      continue;
    }

    taskFolderNames.sort();
    for (const taskFolderName of taskFolderNames) {
      const marker = await readTaskMarker(target, connection, taskFolderName);
      parts.push(`${target.projectKey}\0${taskFolderName}\0${marker}`);
    }
  }

  return parts.join('\n');
}

export async function prepareICloudTaskListing(workspaceRoots, options = {}) {
  const connection = loadConnection();
  if (!isICloudFilesystemConnection(connection)) {
    return;
  }

  const targets = resolveScopedProjectTargets(loadProjectRecords(), workspaceRoots);
  if (targets.length === 0) {
    return;
  }

  const refreshed = await refreshICloudStorageForScan(targets, {
    force: options.forceICloudRefresh === true,
  });
  if (refreshed) {
    invalidateICloudListCache();
  }
}

/**
 * Returns true when task folders or `.state` markers changed since the last check.
 *
 * @param {string[] | null | undefined} workspaceRoots
 * @param {{ forceICloudRefresh?: boolean }} [options]
 */
export async function consumeTaskWatchSnapshotChange(workspaceRoots, options = {}) {
  if (options.forceICloudRefresh === true) {
    await prepareICloudTaskListing(workspaceRoots, options);
  }

  const scopeKey = workspaceScopeKey(workspaceRoots ?? []);
  const next = await collectTaskWatchSnapshot(workspaceRoots);
  const previous = snapshotsByScope.get(scopeKey);
  if (previous === next) {
    return false;
  }

  snapshotsByScope.set(scopeKey, next);
  return true;
}

/** @param {string[] | null | undefined} workspaceRoots */
export function resetTaskWatchSnapshot(workspaceRoots) {
  snapshotsByScope.delete(workspaceScopeKey(workspaceRoots ?? []));
}

/** @param {string[] | null | undefined} workspaceRoots */
export async function syncTaskWatchSnapshot(workspaceRoots) {
  const scopeKey = workspaceScopeKey(workspaceRoots ?? []);
  snapshotsByScope.set(scopeKey, await collectTaskWatchSnapshot(workspaceRoots));
}
