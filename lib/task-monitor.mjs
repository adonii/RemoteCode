import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, loadConnection, loadProjectRecords } from './cloud-connection-store.mjs';
import { refreshCursorAuthCacheSync } from './cursor-auth.mjs';
import { LOG_PREFIX } from './constants.mjs';
import { processConvertTask } from './task-converter.mjs';
import { pollRunningTaskOutput } from './task-output-monitor.mjs';
import { debugLog } from './debug-log.mjs';
import { failStaleRecoveredTask } from './task-recovery.mjs';
import { buildWatcherEnvironment } from './openai-config.mjs';
import { pollAllProjectApprovals } from './task-approval.mjs';
import { pollAllStopRequests } from './task-stop.mjs';
import {
  createTaskFolder,
  listProjectTaskFolderNames,
  uniqueProjectTargets,
} from './project-targets.mjs';
import { TASK_STATE_FILE } from './task-states.mjs';
import {
  invalidateICloudListCache,
  refreshICloudStorageForScan,
} from './icloud-storage.mjs';

const inFlight = new Set();
let scanInFlight = false;
let rescanScheduled = false;

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function taskKey(target, taskFolderName) {
  const root =
    target.mode === 'filesystem' ? target.absolutePath : target.folderId;
  return `${root}::${taskFolderName}`;
}

const STALE_CONVERTING_MS = 90_000;

async function recoverStaleConvertingTask(projectKey, taskFolder, taskFolderName) {
  if (taskFolder.mode !== 'filesystem') {
    return false;
  }

  const state = taskFolder.getState();
  if (state !== 'converting') {
    return false;
  }

  const statePath = path.join(taskFolder.taskFolderPath, TASK_STATE_FILE);
  if (!fs.existsSync(statePath)) {
    return false;
  }

  const ageMs = Date.now() - fs.statSync(statePath).mtimeMs;
  if (ageMs < STALE_CONVERTING_MS) {
    return false;
  }

  const ageSeconds = Math.round(ageMs / 1000);
  await failStaleRecoveredTask(
    projectKey,
    taskFolderName,
    `Task was stale in converting state for ${ageSeconds}s with no transcription progress.`,
  );
  log(`Marked stale converting task ${taskFolderName} as failed after ${ageSeconds}s.`);
  return true;
}

async function scanProjectTarget(target, connection) {
  let taskFolderNames = [];
  try {
    taskFolderNames = await listProjectTaskFolderNames(target, connection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to list task folders for ${target.relativePath}: ${message}`);
    return;
  }

  for (const taskFolderName of taskFolderNames) {
    const key = taskKey(target, taskFolderName);
    if (inFlight.has(key)) {
      continue;
    }

    inFlight.add(key);
    try {
      const taskFolder = createTaskFolder(target, connection, taskFolderName);
      const state = await taskFolder.getState();
      debugLog('watcher', `Scan ${taskFolderName}: state=${state ?? 'none'}.`);
      if (state === 'converting') {
        await recoverStaleConvertingTask(target.projectKey, taskFolder, taskFolderName);
      }
      if (state === 'running') {
        await pollRunningTaskOutput(taskFolder);
      }
      await processConvertTask(taskFolder);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Task conversion failed for ${taskFolderName}: ${message}`);
    } finally {
      inFlight.delete(key);
    }
  }
}

export async function scanAllProjectFolders() {
  if (scanInFlight) {
    rescanScheduled = true;
    return { scanned: 0, reason: 'busy' };
  }

  scanInFlight = true;
  try {
    const connection = loadConnection();
    if (!connection) {
      return { scanned: 0, reason: 'not_authenticated' };
    }

    const records = loadProjectRecords();
    const targets = uniqueProjectTargets(records);

    await refreshICloudStorageForScan(targets);
    invalidateICloudListCache();

    for (const target of targets) {
      await scanProjectTarget(target, connection);
    }

    await pollAllProjectApprovals();
    await pollAllStopRequests();

    return { scanned: targets.length, reason: 'ok' };
  } finally {
    scanInFlight = false;
    if (rescanScheduled) {
      rescanScheduled = false;
      setImmediate(() => {
        void scanAllProjectFolders();
      });
    }
  }
}

export function listWatchPaths() {
  return uniqueProjectTargets(loadProjectRecords())
    .filter(target => target.mode === 'filesystem')
    .map(target => target.absolutePath)
    .filter(absolutePath => fs.existsSync(absolutePath));
}

export function getWatcherPidPath() {
  return path.join(CONFIG_DIR, 'task-watcher.pid');
}

function getExpectedWatcherScriptPath() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../scripts/task-watcher.mjs',
  );
}

/**
 * @returns {{ pid: number, scriptPath: string | null } | null}
 */
export function readWatcherPidFile() {
  const pidPath = getWatcherPidPath();
  if (!fs.existsSync(pidPath)) {
    return null;
  }

  const raw = fs.readFileSync(pidPath, 'utf8').trim();
  if (!raw) {
    return null;
  }

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const pid = Number.parseInt(String(parsed.pid), 10);
      if (!Number.isFinite(pid)) {
        return null;
      }
      const scriptPath =
        typeof parsed.scriptPath === 'string' && parsed.scriptPath.trim()
          ? parsed.scriptPath.trim()
          : null;
      return { pid, scriptPath };
    } catch {
      return null;
    }
  }

  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? { pid, scriptPath: null } : null;
}

export function writeWatcherPidFile(scriptPath = getExpectedWatcherScriptPath()) {
  const pidPath = getWatcherPidPath();
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(
    pidPath,
    `${JSON.stringify({ pid: process.pid, scriptPath })}\n`,
    'utf8',
  );
}

function readWatcherPid() {
  return readWatcherPidFile()?.pid ?? null;
}

function getWatcherProcessCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

export function isTaskWatcherRunning() {
  const pid = readWatcherPid();
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isCurrentWatcherRunning() {
  const record = readWatcherPidFile();
  if (!record) {
    return false;
  }

  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }

  const expectedScript = getExpectedWatcherScriptPath();
  if (record.scriptPath) {
    return path.resolve(record.scriptPath) === path.resolve(expectedScript);
  }

  const command = getWatcherProcessCommand(record.pid);
  return command.includes(expectedScript);
}

export function stopTaskWatcher() {
  const record = readWatcherPidFile();
  if (!record) {
    return false;
  }

  try {
    process.kill(record.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export function ensureTaskWatcherRunning() {
  if (isCurrentWatcherRunning()) {
    return false;
  }

  const staleRecord = readWatcherPidFile();
  if (staleRecord && isTaskWatcherRunning()) {
    stopTaskWatcher();
  }

  const watcherScript = getExpectedWatcherScriptPath();

  refreshCursorAuthCacheSync();

  const child = spawn(process.execPath, [watcherScript], {
    detached: true,
    stdio: 'ignore',
    env: buildWatcherEnvironment(),
  });
  child.unref();
  return true;
}

export function requestBackgroundScan() {
  const scanScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../scripts/scan-once.mjs',
  );

  const child = spawn(process.execPath, [scanScript], {
    detached: true,
    stdio: 'ignore',
    env: buildWatcherEnvironment(),
  });
  child.unref();
  return true;
}
