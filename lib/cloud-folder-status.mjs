import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_NAME } from './constants.mjs';
import { ICLOUD_CONTAINER_ID } from '../shared/constants.mjs';
import { getMachineName, getProjectFolder } from './cloud-path.mjs';
import {
  loadConnection,
  loadProjectRecords,
  PROJECTS_DIR,
  saveProjectRecord,
} from './cloud-connection-store.mjs';
import { buildProjectKey } from './project-key.mjs';
import { ensureCloudFolder } from './cloud-folders.mjs';
import { sanitizePathSegment } from './sanitize.mjs';

function joinCloudPath(...segments) {
  return segments.filter(Boolean).join('/');
}

export function buildWorkspaceRelativePath(workspaceRoots) {
  const machineName = getMachineName();
  const projectFolder = getProjectFolder(workspaceRoots);
  return joinCloudPath(
    sanitizePathSegment(APP_NAME, APP_NAME),
    machineName,
    projectFolder,
  );
}

function resolveICloudAbsolutePath(relativePath) {
  const mobileDocuments = path.join(
    os.homedir(),
    'Library',
    'Mobile Documents',
  );
  const containerFolder = ICLOUD_CONTAINER_ID.replace(/\./g, '~');
  const root = path.join(mobileDocuments, containerFolder, 'Documents');
  return path.join(root, relativePath);
}

function countProjectRecords() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return 0;
  }

  return fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json')).length;
}

const FOLDER_STATUS_CACHE_MS = 60_000;
/** @type {{ key: string, at: number, value: ReturnType<typeof buildCloudFolderStatus> } | null} */
let folderStatusCache = null;

function workspaceRootsKey(workspaceRoots) {
  return (workspaceRoots ?? []).join('\0');
}

function buildCloudFolderStatus(workspaceRoots) {
  const connection = loadConnection();
  if (!connection) {
    return { connected: false };
  }

  const machineName = getMachineName();
  const projectFolder = getProjectFolder(workspaceRoots);
  const workspaceRelativePath = buildWorkspaceRelativePath(workspaceRoots);
  const machineRelativePath = joinCloudPath(
    sanitizePathSegment(APP_NAME, APP_NAME),
    machineName,
  );

  let workspaceAbsolutePath = null;
  let workspaceExists = false;
  let machineAbsolutePath = null;
  let machineExists = false;
  let finderPath = null;

  if (connection.provider === 'icloud') {
    workspaceAbsolutePath = resolveICloudAbsolutePath(workspaceRelativePath);
    workspaceExists = fs.existsSync(workspaceAbsolutePath);
    machineAbsolutePath = resolveICloudAbsolutePath(machineRelativePath);
    machineExists = fs.existsSync(machineAbsolutePath);
    const containerFolder = ICLOUD_CONTAINER_ID.replace(/\./g, '~');
    finderPath = `~/Library/Mobile Documents/${containerFolder}/Documents/${machineRelativePath}`;
  }

  return {
    connected: true,
    provider: connection.provider,
    machineName,
    projectFolder,
    workspaceRelativePath,
    machineRelativePath,
    workspaceAbsolutePath,
    workspaceExists,
    machineAbsolutePath,
    machineExists,
    finderPath,
    projectFolderCount: countProjectRecords(),
  };
}

/**
 * @param {string[] | undefined} workspaceRoots
 * @param {{ force?: boolean }} [options]
 */
export function getCloudFolderStatus(workspaceRoots, options = {}) {
  const cacheKey = workspaceRootsKey(workspaceRoots);
  if (
    !options.force &&
    folderStatusCache &&
    folderStatusCache.key === cacheKey &&
    Date.now() - folderStatusCache.at < FOLDER_STATUS_CACHE_MS
  ) {
    return folderStatusCache.value;
  }

  const value = buildCloudFolderStatus(workspaceRoots);
  folderStatusCache = { key: cacheKey, at: Date.now(), value };
  return value;
}

export function invalidateCloudFolderStatusCache() {
  folderStatusCache = null;
}

/**
 * @param {string[] | undefined} workspaceRoots
 */
export async function provisionWorkspaceCloudFolder(workspaceRoots) {
  const connection = loadConnection();
  if (!connection) {
    throw new Error('Connect iCloud or Google Drive before creating folders.');
  }

  const relativePath = buildWorkspaceRelativePath(workspaceRoots);
  const created = await ensureCloudFolder(connection, relativePath);
  const machineName = getMachineName();
  const projectFolder = getProjectFolder(workspaceRoots);
  const projectKey = buildProjectKey(machineName, projectFolder);
  const existing = loadProjectRecords().find(record => record.projectKey === projectKey);
  const workspaceRoot =
    Array.isArray(workspaceRoots) && workspaceRoots.length > 0
      ? workspaceRoots[0]
      : existing?.workspaceRoot ?? null;

  saveProjectRecord(projectKey, {
    projectKey,
    machineName,
    projectFolder,
    relativePath,
    workspaceRoot,
    cloud: created,
    activeTaskFolderName: existing?.activeTaskFolderName ?? null,
    pendingFollowupMessage: existing?.pendingFollowupMessage ?? null,
    pendingApproval: existing?.pendingApproval ?? false,
    stopAgentRequested: existing?.stopAgentRequested ?? false,
    updatedAt: new Date().toISOString(),
  });

  return {
    ...created,
    relativePath,
  };
}
