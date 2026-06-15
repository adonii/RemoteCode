import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICLOUD_CONTAINER_ID } from './constants.mjs';
import { loadConnection, SESSIONS_DIR } from './cloud-connection-store.mjs';

const SWIFT_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/icloud-refresh.swift',
);

const SWIFT_TIMEOUT_MS = 4_000;
const LIST_CACHE_MS = 1_500;
const REFRESH_DEBOUNCE_MS = 400;

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

function runSwift(command, args = []) {
  if (process.platform !== 'darwin') {
    return Promise.resolve(null);
  }

  return new Promise(resolve => {
    const child = spawn('swift', [SWIFT_SCRIPT, command, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, SWIFT_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
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
  await runSwift('refresh', uniquePaths);
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
 */
export async function refreshICloudStorageForScan(targets = []) {
  if (!isICloudFilesystemConnection()) {
    return;
  }

  const paths = collectRefreshPaths(targets);
  if (paths.length === 0) {
    return;
  }

  await refreshICloudPaths(paths);
}

function scheduleRefreshInternal(targets) {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }

  refreshInFlight = true;
  void (async () => {
    try {
      let resolvedTargets = targets;
      if (!resolvedTargets || resolvedTargets.length === 0) {
        const { loadProjectRecords } = await import('./cloud-connection-store.mjs');
        const { uniqueProjectTargets } = await import('./project-targets.mjs');
        resolvedTargets = uniqueProjectTargets(loadProjectRecords());
      }
      await refreshICloudStorageForScan(resolvedTargets);
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
  if (!isICloudFilesystemConnection()) {
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

  const output = await runSwift('list-children', [folderPath]);
  if (!output) {
    return [];
  }

  try {
    const parsed = JSON.parse(output);
    const names = Array.isArray(parsed)
      ? parsed.filter(name => typeof name === 'string')
      : [];
    listCache.set(folderPath, { at: Date.now(), names });
    return names;
  } catch {
    return [];
  }
}

export function invalidateICloudListCache() {
  listCache.clear();
}
