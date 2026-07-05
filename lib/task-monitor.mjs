import fs from 'node:fs';
import os from 'node:os';
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
  isICloudFilesystemConnection,
  downloadICloudPaths,
  refreshICloudStorageForScan,
} from './icloud-storage.mjs';
import { tryClaimBackgroundScan } from './scan-coordinator.mjs';
import { signalRunTaskDetected } from './run-task-signal.mjs';
import { readTaskStateFromFolder } from './task-state-read.mjs';
import {
  consumeTaskWatchSnapshotChange,
  prepareICloudTaskListing,
  resetTaskWatchSnapshot,
  syncTaskWatchSnapshot,
} from './task-watch-snapshot.mjs';
import {
  getWorkspaceRoots,
  initWorkspaceScopeFromEnvironment,
  withWorkspaceRootsEnv,
} from './workspace-scope.mjs';

initWorkspaceScopeFromEnvironment();

const inFlight = new Set();
let scanInFlight = false;
let rescanScheduled = false;
/** @type {Set<string>} */
const watcherSpawnLocks = new Set();

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

function allKnownWorkspaceRoots() {
  return [
    ...new Set(
      loadProjectRecords()
        .map(record => record.workspaceRoot)
        .filter(Boolean)
        .map(root => path.resolve(String(root))),
    ),
  ];
}

export { allKnownWorkspaceRoots };

async function readTaskState(taskFolder, connection) {
  return readTaskStateFromFolder(taskFolder, connection);
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
      let state = await readTaskState(taskFolder, connection);
      if (state === null && isICloudFilesystemConnection(connection) && target.mode === 'filesystem') {
        const statePath = path.join(taskFolder.taskFolderPath, TASK_STATE_FILE);
        await downloadICloudPaths([target.absolutePath, taskFolder.taskFolderPath, statePath], 25);
        await refreshICloudPaths([target.absolutePath, taskFolder.taskFolderPath, statePath]);
        state = await readTaskState(taskFolder, connection);
      }
      debugLog('watcher', `Scan ${taskFolderName}: state=${state ?? 'none'}.`);
      if (state === 'run') {
        signalRunTaskDetected(taskFolder.taskFolderPath);
      }
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

export async function scanAllProjectFolders(options = {}) {
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
    if (targets.length === 0) {
      return { scanned: 0, reason: 'no_projects' };
    }

    const workspaceRoots = allKnownWorkspaceRoots();

    const forceICloudRefresh = options.forceICloudRefresh === true;
    if (isICloudFilesystemConnection(connection)) {
      const refreshed = await refreshICloudStorageForScan(targets, { force: forceICloudRefresh });
      if (refreshed) {
        invalidateICloudListCache();
      }
    }

    for (const target of targets) {
      await scanProjectTarget(target, connection);
    }

    await pollAllProjectApprovals();
    await pollAllStopRequests();

    await syncTaskWatchSnapshot(workspaceRoots);

    debugLog(
      'watcher',
      `Scan complete for ${targets.length} project(s) (${workspaceRoots?.join(', ') ?? 'no workspace'}).`,
    );

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

export async function scanIfTaskSnapshotChanged(
  workspaceRoots = getWorkspaceRoots(),
  options = {},
) {
  const roots =
    Array.isArray(workspaceRoots) && workspaceRoots.length > 0
      ? workspaceRoots
      : allKnownWorkspaceRoots();
  if (roots.length === 0 && uniqueProjectTargets(loadProjectRecords()).length === 0) {
    return { scanned: 0, reason: 'no_projects' };
  }

  if (options.forceICloudRefresh === true) {
    await prepareICloudTaskListing(roots, options);
    await syncTaskWatchSnapshot(roots);
    return scanAllProjectFolders({ forceICloudRefresh: true });
  }

  const changed = await consumeTaskWatchSnapshotChange(roots, options);
  if (!changed) {
    return { scanned: 0, reason: 'unchanged' };
  }

  return scanAllProjectFolders();
}

export function resetTaskMonitorWatchSnapshot(workspaceRoots = getWorkspaceRoots()) {
  resetTaskWatchSnapshot(workspaceRoots);
}

export function listWatchPaths(_workspaceRoots = getWorkspaceRoots()) {
  return uniqueProjectTargets(loadProjectRecords())
    .filter(target => target.mode === 'filesystem')
    .map(target => target.absolutePath)
    .filter(absolutePath => fs.existsSync(absolutePath));
}

function sanitizeWatcherScopeId(scopeId) {
  return scopeId.replace(/[^\w.-]+/g, '_');
}

function getWatcherScopeId(workspaceRoots = getWorkspaceRoots()) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) {
    return 'global';
  }

  return workspaceRoots.map(root => path.resolve(String(root))).join('\0');
}

const GLOBAL_WATCHER_PID_PATH = path.join(CONFIG_DIR, 'task-watcher.pid');
const WATCHER_SPAWN_STAMP = path.join(CONFIG_DIR, 'task-watcher-spawn-at.json');
const WATCHER_SPAWN_COOLDOWN_MS = 30_000;
const LOCAL_WATCHER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/task-watcher.mjs',
);

export function getWatcherPidPath(_workspaceRoots = getWorkspaceRoots()) {
  return GLOBAL_WATCHER_PID_PATH;
}

function parseRemotepromptcodeVersion(extensionFolderName) {
  const match = extensionFolderName.match(/remotepromptcode-(\d+\.\d+\.\d+)/i);
  return match?.[1] ?? null;
}

function compareSemver(left, right) {
  const leftParts = left.split('.').map(part => Number.parseInt(part, 10));
  const rightParts = right.split('.').map(part => Number.parseInt(part, 10));

  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function findNewestInstalledWatcherScript() {
  const extensionsDir = path.join(os.homedir(), '.cursor', 'extensions');
  let newestScript = null;
  let newestVersion = null;

  let entries = [];
  try {
    entries = fs.readdirSync(extensionsDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.toLowerCase().startsWith('andreidonii.remotepromptcode-')) {
      continue;
    }

    const version = parseRemotepromptcodeVersion(entry);
    if (!version) {
      continue;
    }

    const scriptPath = path.join(extensionsDir, entry, 'scripts', 'task-watcher.mjs');
    if (!fs.existsSync(scriptPath)) {
      continue;
    }

    if (!newestVersion || compareSemver(version, newestVersion) > 0) {
      newestVersion = version;
      newestScript = scriptPath;
    }
  }

  return newestScript;
}

export function getExpectedWatcherScriptPath() {
  return path.resolve(findNewestInstalledWatcherScript() ?? LOCAL_WATCHER_SCRIPT);
}

export function isCanonicalWatcherScript(scriptPath = LOCAL_WATCHER_SCRIPT) {
  return path.resolve(scriptPath) === getExpectedWatcherScriptPath();
}

export function listInstalledExtensionVersions() {
  const extensionsDir = path.join(os.homedir(), '.cursor', 'extensions');
  const versions = [];

  try {
    for (const entry of fs.readdirSync(extensionsDir)) {
      const version = parseRemotepromptcodeVersion(entry);
      if (version) {
        versions.push(version);
      }
    }
  } catch {
    // Ignore unreadable extensions dir.
  }

  return [...new Set(versions)].sort(compareSemver);
}

export function purgeNonCanonicalWatcherProcesses() {
  const expectedScript = path.resolve(getExpectedWatcherScriptPath());
  let purged = 0;

  try {
    const output = execFileSync('pgrep', ['-f', 'task-watcher.mjs'], { encoding: 'utf8' });
    for (const pidText of output.trim().split('\n')) {
      const pid = Number.parseInt(pidText, 10);
      if (!Number.isFinite(pid)) {
        continue;
      }

      const command = getWatcherProcessCommand(pid);
      if (command.includes(expectedScript)) {
        continue;
      }

      try {
        process.kill(pid, 'SIGTERM');
        purged += 1;
      } catch {
        // Best effort.
      }
    }
  } catch {
    // No matching processes.
  }

  return purged;
}

function readWatcherPidFileAt(pidPath) {
  if (!pidPath || !fs.existsSync(pidPath)) {
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

function stopWatcherAtPidPath(pidPath) {
  const record = readWatcherPidFileAt(pidPath);
  if (!record) {
    return false;
  }

  try {
    process.kill(record.pid, 'SIGTERM');
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }
    return true;
  } catch {
    return false;
  }
}

const UNSCOPED_WATCHER_PID_PATH = GLOBAL_WATCHER_PID_PATH;

export function stopUnscopedTaskWatcher() {
  return stopWatcherAtPidPath(GLOBAL_WATCHER_PID_PATH);
}

/** Stop every task watcher pid file (legacy scoped files and the global watcher). */
export function stopAllTaskWatchers() {
  if (!fs.existsSync(CONFIG_DIR)) {
    return 0;
  }

  let stopped = 0;
  for (const entry of fs.readdirSync(CONFIG_DIR)) {
    if (!entry.startsWith('task-watcher') || !entry.endsWith('.pid')) {
      continue;
    }

    if (stopWatcherAtPidPath(path.join(CONFIG_DIR, entry))) {
      stopped += 1;
    }
  }

  return stopped;
}

export function readWatcherPidFile(workspaceRoots = getWorkspaceRoots()) {
  return readWatcherPidFileAt(getWatcherPidPath(workspaceRoots));
}

export function writeWatcherPidFile(
  scriptPath = getExpectedWatcherScriptPath(),
  _workspaceRoots = getWorkspaceRoots(),
) {
  fs.mkdirSync(path.dirname(GLOBAL_WATCHER_PID_PATH), { recursive: true });
  fs.writeFileSync(
    GLOBAL_WATCHER_PID_PATH,
    `${JSON.stringify({ pid: process.pid, scriptPath })}\n`,
    'utf8',
  );
}

function readWatcherPid(workspaceRoots = getWorkspaceRoots()) {
  return readWatcherPidFile(workspaceRoots)?.pid ?? null;
}

/** @param {string[] | undefined} _workspaceRoots */
export function isWatcherProcessAlive(_workspaceRoots = getWorkspaceRoots()) {
  return isCurrentWatcherRunning();
}

/** @param {string[] | undefined} _workspaceRoots */
export function reconcileWatcherPidFile(_workspaceRoots = getWorkspaceRoots()) {
  if (!fs.existsSync(GLOBAL_WATCHER_PID_PATH)) {
    return;
  }

  if (isCurrentWatcherRunning()) {
    return;
  }

  try {
    fs.unlinkSync(GLOBAL_WATCHER_PID_PATH);
  } catch {
    // Best effort.
  }
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

export function findRunningExpectedWatcherPid() {
  const expectedScript = path.resolve(getExpectedWatcherScriptPath());
  try {
    const output = execFileSync('pgrep', ['-f', 'task-watcher.mjs'], { encoding: 'utf8' });
    for (const pidText of output.trim().split('\n')) {
      const pid = Number.parseInt(pidText, 10);
      if (!Number.isFinite(pid)) {
        continue;
      }

      const command = getWatcherProcessCommand(pid);
      if (command.includes(expectedScript)) {
        return pid;
      }
    }
  } catch {
    // No matching processes.
  }

  return null;
}

function syncWatcherPidFileWithProcess(pid) {
  const expectedScript = path.resolve(getExpectedWatcherScriptPath());
  fs.mkdirSync(path.dirname(GLOBAL_WATCHER_PID_PATH), { recursive: true });
  fs.writeFileSync(
    GLOBAL_WATCHER_PID_PATH,
    `${JSON.stringify({ pid, scriptPath: expectedScript })}\n`,
    'utf8',
  );
}

export function isTaskWatcherRunning(_workspaceRoots = getWorkspaceRoots()) {
  return isCurrentWatcherRunning();
}

function isCurrentWatcherRunning() {
  const runningPid = findRunningExpectedWatcherPid();
  if (runningPid) {
    const record = readWatcherPidFileAt(GLOBAL_WATCHER_PID_PATH);
    if (!record || record.pid !== runningPid) {
      syncWatcherPidFileWithProcess(runningPid);
    }
    return true;
  }

  const record = readWatcherPidFileAt(GLOBAL_WATCHER_PID_PATH);
  if (!record) {
    return false;
  }

  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }

  const expectedScript = path.resolve(getExpectedWatcherScriptPath());
  if (record.scriptPath) {
    return path.resolve(record.scriptPath) === expectedScript;
  }

  const command = getWatcherProcessCommand(record.pid);
  return command.includes(expectedScript);
}

export function stopTaskWatcher(_workspaceRoots = getWorkspaceRoots()) {
  return stopWatcherAtPidPath(GLOBAL_WATCHER_PID_PATH);
}

export function stopAllStaleTaskWatchers() {
  const expectedScript = path.resolve(getExpectedWatcherScriptPath());
  let stopped = 0;

  if (!fs.existsSync(CONFIG_DIR)) {
    return stopped;
  }

  for (const entry of fs.readdirSync(CONFIG_DIR)) {
    if (!entry.startsWith('task-watcher') || !entry.endsWith('.pid')) {
      continue;
    }

    const pidPath = path.join(CONFIG_DIR, entry);
    const record = readWatcherPidFileAt(pidPath);
    if (!record) {
      continue;
    }

    const scriptPath = record.scriptPath ? path.resolve(record.scriptPath) : null;
    if (scriptPath && scriptPath === expectedScript) {
      continue;
    }

    if (stopWatcherAtPidPath(pidPath)) {
      stopped += 1;
    }
  }

  try {
    const output = execFileSync('pgrep', ['-f', 'task-watcher.mjs'], { encoding: 'utf8' });
    for (const pidText of output.trim().split('\n')) {
      const pid = Number.parseInt(pidText, 10);
      if (!Number.isFinite(pid)) {
        continue;
      }

      const command = getWatcherProcessCommand(pid);
      if (command.includes(expectedScript)) {
        continue;
      }

      try {
        process.kill(pid, 'SIGTERM');
        stopped += 1;
      } catch {
        // Best effort.
      }
    }
  } catch {
    // No matching processes.
  }

  return stopped;
}

function tryClaimWatcherSpawn() {
  const now = Date.now();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (fs.existsSync(WATCHER_SPAWN_STAMP)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(WATCHER_SPAWN_STAMP, 'utf8'));
      const lastAt = typeof parsed?.at === 'number' ? parsed.at : 0;
      if (now - lastAt < WATCHER_SPAWN_COOLDOWN_MS) {
        return false;
      }
    } catch {
      // Ignore malformed stamp and take over.
    }
  }

  fs.writeFileSync(
    WATCHER_SPAWN_STAMP,
    `${JSON.stringify({ at: now, pid: process.pid })}\n`,
    'utf8',
  );
  return true;
}

function removeStaleWatcherPidFile() {
  const record = readWatcherPidFileAt(GLOBAL_WATCHER_PID_PATH);
  if (!record) {
    return;
  }

  try {
    process.kill(record.pid, 0);
  } catch {
    try {
      fs.unlinkSync(GLOBAL_WATCHER_PID_PATH);
    } catch {
      // Best effort.
    }
  }
}

function buildScopedWatcherEnvironment(_workspaceRoots = getWorkspaceRoots()) {
  return withWorkspaceRootsEnv(buildWatcherEnvironment(), allKnownWorkspaceRoots());
}

export function ensureTaskWatcherRunning(_workspaceRoots = getWorkspaceRoots()) {
  reconcileWatcherPidFile();

  if (isCurrentWatcherRunning()) {
    return false;
  }

  if (watcherSpawnLocks.has('global')) {
    return false;
  }

  if (!tryClaimWatcherSpawn()) {
    return false;
  }

  watcherSpawnLocks.add('global');
  try {
    reconcileWatcherPidFile();

    if (isCurrentWatcherRunning()) {
      return false;
    }

    removeStaleWatcherPidFile();

    refreshCursorAuthCacheSync();

    const child = spawn(process.execPath, [getExpectedWatcherScriptPath()], {
      detached: true,
      stdio: 'ignore',
      env: buildScopedWatcherEnvironment(),
    });
    child.unref();
    return true;
  } finally {
    setTimeout(() => {
      watcherSpawnLocks.delete('global');
    }, 10_000);
  }
}

const WATCHER_CODE_FILES = [
  'cloud-files.mjs',
  'icloud-storage.mjs',
  'project-targets.mjs',
  'scan-coordinator.mjs',
  'swift-runner.mjs',
  'task-watch-snapshot.mjs',
  'task-state-read.mjs',
  'task-monitor.mjs',
  'task-output-monitor.mjs',
  'task-attached-files.mjs',
  'composer-attachments.mjs',
  'composer-output.mjs',
  'workspace-scope.mjs',
];

function getWatcherCodeStamp() {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const parts = [];

  for (const fileName of WATCHER_CODE_FILES) {
    const filePath = path.join(libDir, fileName);
    try {
      const stat = fs.statSync(filePath);
      parts.push(`${fileName}:${stat.mtimeMs}`);
    } catch {
      parts.push(`${fileName}:missing`);
    }
  }

  return parts.join('|');
}

function getWatcherCodeStampPath(workspaceRoots = getWorkspaceRoots()) {
  const scopeId = getWatcherScopeId(workspaceRoots);
  if (!scopeId) {
    return null;
  }

  return path.join(CONFIG_DIR, `task-watcher-code-${sanitizeWatcherScopeId(scopeId)}.stamp`);
}

export function ensureTaskWatcherAlive(workspaceRoots = getWorkspaceRoots()) {
  return ensureTaskWatcherRunning(workspaceRoots);
}

export function ensureTaskWatcherCurrent(workspaceRoots = getWorkspaceRoots()) {
  purgeNonCanonicalWatcherProcesses();
  stopAllStaleTaskWatchers();
  return ensureTaskWatcherRunning(workspaceRoots);
}

export function requestBackgroundScan(
  _workspaceRoots = getWorkspaceRoots(),
  options = {},
) {
  if (!loadConnection()) {
    return false;
  }

  if (!options.force && !tryClaimBackgroundScan()) {
    return false;
  }

  const scanScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../scripts/scan-once.mjs',
  );

  const env = buildScopedWatcherEnvironment(allKnownWorkspaceRoots());
  if (options.forceICloudRefresh === true) {
    env.REMOTECODE_FORCE_ICLOUD_REFRESH = '1';
  }

  const child = spawn(process.execPath, [scanScript], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  return true;
}
