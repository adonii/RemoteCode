import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ICLOUD_CONTAINER_ID } from './constants.mjs';
import { CONFIG_DIR, loadConnection, SESSIONS_DIR } from './cloud-connection-store.mjs';
import { tryClaimGlobalICloudRefresh } from './scan-coordinator.mjs';
import { runSwiftHelper } from './swift-runner.mjs';
import { isTaskFolderName } from './task-states.mjs';

const LIST_CACHE_MS = 1_000;
const REFRESH_DEBOUNCE_MS = 500;
const PROBE_WINDOW_MS = 45 * 60 * 1000;
const PROBE_STEP_MS = 1_000;
const MDFIND_BIN = '/usr/bin/mdfind';
const MDIMPORT_BIN = '/usr/bin/mdimport';
const SPOTLIGHT_FOLDER_QUERY = 'kMDItemContentTypeTree == "public.folder"';
export const SPOTLIGHT_TASK_MARKER_QUERY =
  '(kMDItemFSName == "request.txt" || kMDItemFSName == ".state")';

/** @type {Map<string, { at: number, names: string[] }>} */
const listCache = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let refreshDebounceTimer = null;
let refreshInFlight = false;
let refreshQueued = false;

export function isICloudFilesystemConnection(connection = loadConnection()) {
  return process.platform === 'darwin' && connection?.provider === 'icloud';
}

export function getICloudDocumentsRoot() {
  const containerFolder = ICLOUD_CONTAINER_ID.replace(/\./g, '~');
  return path.join(os.homedir(), 'Library', 'Mobile Documents', containerFolder, 'Documents');
}

/**
 * Request iCloud download + metadata refresh for the given absolute paths.
 *
 * @param {string[]} absolutePaths
 */
export async function refreshICloudPaths(absolutePaths) {
  if (!isICloudFilesystemConnection() || absolutePaths.length === 0) {
    return;
  }

  const uniquePaths = [...new Set(absolutePaths.filter(Boolean))];
  await runSwiftHelper('refresh', uniquePaths);
}

/**
 * Request iCloud download and wait briefly for files to appear locally.
 *
 * @param {string[]} absolutePaths
 * @param {number} [waitSeconds=4]
 */
export async function downloadICloudPaths(absolutePaths, waitSeconds = 4) {
  if (!isICloudFilesystemConnection() || absolutePaths.length === 0) {
    return;
  }

  const uniquePaths = [...new Set(absolutePaths.filter(Boolean))];
  const timeoutMs = Math.max(12_000, Math.round(waitSeconds * 1000) + 5_000);
  await runSwiftHelper('download', [...uniquePaths, String(waitSeconds)], timeoutMs);
}

function knownTasksPath(folderPath) {
  const slug = folderPath.replace(/[^\w.-]+/g, '_');
  return path.join(CONFIG_DIR, `known-tasks-${slug}.json`);
}

function loadKnownTaskNames(folderPath) {
  const filePath = knownTasksPath(folderPath);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(name => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

function saveKnownTaskNames(folderPath, names) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    knownTasksPath(folderPath),
    `${JSON.stringify([...names].sort())}\n`,
    'utf8',
  );
}

function formatTaskFolderName(date) {
  const pad = value => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function taskFolderExists(parentPath, name) {
  const requestPath = path.join(parentPath, name, 'request.txt');
  const statePath = path.join(parentPath, name, '.state');
  try {
    return fs.existsSync(requestPath) || fs.existsSync(statePath);
  } catch {
    return false;
  }
}

function isDiscoverableTaskFolder(parentPath, name) {
  const folderPath = path.join(parentPath, name);
  try {
    if (fs.existsSync(folderPath)) {
      return true;
    }
  } catch {
    // Fall through to marker check.
  }

  return taskFolderExists(parentPath, name);
}

/**
 * Probe timestamp-shaped folder names directly. iCloud project folders often
 * block readdir/Spotlight, but child task paths remain readable once synced.
 *
 * @param {string} folderPath
 */
function listProbedTaskFolderNames(folderPath) {
  const resolved = path.resolve(folderPath);
  const names = new Set();
  const now = Date.now();
  const start = now - PROBE_WINDOW_MS;

  for (let timestamp = start; timestamp <= now + PROBE_STEP_MS; timestamp += PROBE_STEP_MS) {
    const name = formatTaskFolderName(new Date(timestamp));
    if (!isTaskFolderName(name)) {
      continue;
    }

    if (taskFolderExists(resolved, name)) {
      names.add(name);
    }
  }

  for (const name of loadKnownTaskNames(resolved)) {
    if (isTaskFolderName(name) && taskFolderExists(resolved, name)) {
      names.add(name);
    }
  }

  return [...names];
}

function collectRefreshPaths(targets = []) {
  const paths = new Set();

  if (fs.existsSync(SESSIONS_DIR)) {
    paths.add(SESSIONS_DIR);
  }

  const appRoot = getICloudDocumentsRoot();
  if (fs.existsSync(appRoot)) {
    paths.add(appRoot);
  }

  for (const target of targets) {
    if (target?.mode === 'filesystem' && target.absolutePath) {
      paths.add(target.absolutePath);
    }
  }

  return [...paths];
}

/**
 * Refresh iCloud storage for all active watch targets before scanning.
 *
 * @param {Array<{ mode?: string, absolutePath?: string }>} [targets]
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<boolean>} whether a refresh was performed
 */
export async function refreshICloudStorageForScan(targets = [], options = {}) {
  if (!isICloudFilesystemConnection()) {
    return false;
  }

  const paths = collectRefreshPaths(targets);
  if (paths.length === 0) {
    return false;
  }

  if (options.force !== true && !tryClaimGlobalICloudRefresh()) {
    return false;
  }

  await refreshICloudPaths(paths);
  nudgeSpotlightIndex(paths);
  return true;
}

function nudgeSpotlightIndex(absolutePaths) {
  if (process.platform !== 'darwin') {
    return;
  }

  for (const folderPath of absolutePaths) {
    if (!folderPath || !fs.existsSync(folderPath)) {
      continue;
    }

    try {
      execFileSync(MDIMPORT_BIN, ['-n', folderPath], {
        timeout: 3_000,
        stdio: 'ignore',
      });
    } catch {
      // Best effort; Spotlight may still index asynchronously.
    }
  }
}

function scheduleRefreshInternal(targets) {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }

  refreshInFlight = true;
  void (async () => {
    try {
      if (!targets || targets.length === 0) {
        return;
      }
      await refreshICloudStorageForScan(targets);
    } finally {
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        scheduleRefreshInternal(targets);
      }
    }
  })();
}

/**
 * Debounced iCloud refresh for background polling loops.
 *
 * @param {Array<{ mode?: string, absolutePath?: string }>} [targets]
 */
export function scheduleICloudStorageRefresh(targets = []) {
  if (!isICloudFilesystemConnection() || targets.length === 0) {
    return;
  }

  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
  }

  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null;
    scheduleRefreshInternal(targets);
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * Extract direct child folder names from mdfind result lines under parentPath.
 *
 * @param {string} parentPath
 * @param {string} stdout
 */
function childFolderNamesFromSpotlightPaths(parentPath, stdout) {
  const resolved = path.resolve(parentPath);
  const parentPrefix = `${resolved}${path.sep}`;
  const names = new Set();

  for (const line of stdout.split('\n')) {
    const childPath = line.trim();
    if (!childPath.startsWith(parentPrefix)) {
      continue;
    }

    const remainder = childPath.slice(parentPrefix.length);
    if (!remainder) {
      continue;
    }

    const firstComponent = remainder.split(path.sep)[0];
    if (firstComponent) {
      names.add(firstComponent);
    }
  }

  return names;
}

/**
 * List direct child folders via Spotlight. Required for iCloud project folders
 * protected by com.apple.macl, where readdir returns EPERM but mdfind still works.
 *
 * @param {string} folderPath
 */
function listSpotlightChildFolderNames(folderPath) {
  if (process.platform !== 'darwin') {
    return [];
  }

  const resolved = path.resolve(folderPath);
  if (!fs.existsSync(resolved)) {
    return [];
  }

  const names = new Set();

  try {
    const folderStdout = execFileSync(
      MDFIND_BIN,
      ['-onlyin', resolved, SPOTLIGHT_FOLDER_QUERY],
      { encoding: 'utf8', timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
    );
    for (const name of childFolderNamesFromSpotlightPaths(resolved, folderStdout)) {
      names.add(name);
    }
  } catch {
    // Ignore folder query failures.
  }

  try {
    const markerStdout = execFileSync(
      MDFIND_BIN,
      ['-onlyin', resolved, SPOTLIGHT_TASK_MARKER_QUERY],
      { encoding: 'utf8', timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
    );
    for (const name of childFolderNamesFromSpotlightPaths(resolved, markerStdout)) {
      names.add(name);
    }
  } catch {
    // Ignore marker query failures.
  }

  return [...names];
}

/**
 * Find task folders via marker files indexed anywhere under the iCloud app root
 * but belonging to this project folder. Catches new mobile tasks before the
 * parent folder entry is indexed locally.
 *
 * @param {string} folderPath
 */
function listSpotlightTaskFoldersFromAppRoot(folderPath) {
  if (process.platform !== 'darwin') {
    return [];
  }

  const resolved = path.resolve(folderPath);
  const documentsRoot = path.resolve(getICloudDocumentsRoot());
  if (!resolved.startsWith(`${documentsRoot}${path.sep}`)) {
    return [];
  }

  try {
    const stdout = execFileSync(
      MDFIND_BIN,
      ['-onlyin', documentsRoot, SPOTLIGHT_TASK_MARKER_QUERY],
      { encoding: 'utf8', timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return [...childFolderNamesFromSpotlightPaths(resolved, stdout)];
  } catch {
    return [];
  }
}

/**
 * List child folder names for an iCloud-backed directory, including items that
 * are visible in metadata but not yet fully downloaded.
 *
 * @param {string} folderPath
 */
export async function listICloudChildFolderNames(folderPath) {
  const cached = listCache.get(folderPath);
  if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
    return cached.names;
  }

  const names = new Set(listSpotlightChildFolderNames(folderPath));
  for (const name of listSpotlightTaskFoldersFromAppRoot(folderPath)) {
    names.add(name);
  }
  for (const name of listProbedTaskFolderNames(folderPath)) {
    names.add(name);
  }

  if (names.size === 0) {
    const output = await runSwiftHelper('list-children', [folderPath]);
    if (output) {
      try {
        const parsed = JSON.parse(output);
        if (Array.isArray(parsed)) {
          for (const name of parsed) {
            if (typeof name === 'string') {
              names.add(name);
            }
          }
        }
      } catch {
        // Ignore malformed Swift output.
      }
    }
  }

  const result = [...names]
    .filter(name => isTaskFolderName(name) && isDiscoverableTaskFolder(folderPath, name))
    .sort();
  saveKnownTaskNames(folderPath, result);
  listCache.set(folderPath, { at: Date.now(), names: result });
  return result;
}

export function invalidateICloudListCache() {
  listCache.clear();
}
