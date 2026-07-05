import fs from 'node:fs';
import path from 'node:path';
import { loadConnection } from './cloud-connection-store.mjs';
import { isICloudFilesystemConnection, refreshICloudPaths, downloadICloudPaths } from './icloud-storage.mjs';
import { runSwiftHelper } from './swift-runner.mjs';
import { parseTaskState, TASK_STATE_FILE } from './task-states.mjs';

function readStateFromDisk(statePath) {
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    return parseTaskState(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error instanceof Error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      return undefined;
    }
    throw error;
  }
}

async function readStateViaSwift(statePath) {
  const content = await runSwiftHelper('read-file', [statePath]);
  if (content === null) {
    return null;
  }
  return parseTaskState(content);
}

async function readStateViaGetState(taskFolder) {
  const getState = taskFolder.getState?.bind(taskFolder);
  if (typeof getState !== 'function') {
    return null;
  }

  let state = getState();
  if (state instanceof Promise) {
    state = await state;
  }
  return state;
}

/**
 * Read a task `.state` file, including Swift fallback when iCloud blocks Node reads.
 *
 * @param {{ taskFolderPath: string, getState?: () => string | null | Promise<string | null> }} taskFolder
 * @param {ReturnType<typeof loadConnection>} [connection]
 */
export async function readTaskStateFromFolder(taskFolder, connection = loadConnection()) {
  const statePath = path.join(taskFolder.taskFolderPath, TASK_STATE_FILE);

  if (isICloudFilesystemConnection(connection)) {
    const swiftState = await readStateViaSwift(statePath);
    if (swiftState !== null) {
      return swiftState;
    }
  }

  let state = await readStateViaGetState(taskFolder);
  if (state !== null) {
    return state;
  }

  if (!isICloudFilesystemConnection(connection)) {
    return null;
  }

  await downloadICloudPaths([taskFolder.taskFolderPath, statePath], 20);

  const initialDisk = readStateFromDisk(statePath);
  if (initialDisk !== undefined && initialDisk !== null) {
    return initialDisk;
  }

  state = await readStateViaSwift(statePath);
  if (state !== null) {
    return state;
  }

  await refreshICloudPaths([taskFolder.taskFolderPath, statePath]);

  state = await readStateViaGetState(taskFolder);
  if (state !== null) {
    return state;
  }

  const refreshedDisk = readStateFromDisk(statePath);
  if (refreshedDisk !== undefined && refreshedDisk !== null) {
    return refreshedDisk;
  }

  await downloadICloudPaths([taskFolder.taskFolderPath, statePath], 20);
  state = await readStateViaSwift(statePath);
  if (state !== null) {
    return state;
  }

  const finalDisk = readStateFromDisk(statePath);
  if (finalDisk !== undefined) {
    return finalDisk;
  }

  return null;
}
