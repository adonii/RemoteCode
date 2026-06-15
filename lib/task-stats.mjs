import {
  createDriveApiTaskFolder,
  createFilesystemTaskFolder,
  listDriveApiChildFolderNames,
  listFilesystemChildFolderNames,
} from './cloud-files.mjs';
import { isICloudFilesystemConnection, listICloudChildFolderNames } from './icloud-storage.mjs';
import path from 'node:path';
import { loadConnection, loadProjectRecords } from './cloud-connection-store.mjs';
import {
  getConversionMeta,
  listConversionProgress,
} from './conversion-progress.mjs';
import { resolveSpeechToTextBackend } from './openai-config.mjs';
import { uniqueProjectTargets } from './project-targets.mjs';
import { isTaskWatcherRunning } from './task-monitor.mjs';
import { isTaskFolderName } from './task-states.mjs';
import { listTaskActivity } from './task-activity.mjs';
import { listApiDebugLog, writeTaskDebugContext } from './api-debug-log.mjs';

const DEBUG_EVENT_LIMIT = 6;

const QUEUE_STATS_LITE_CACHE_MS = 2_000;
const QUEUE_STATS_FULL_CACHE_MS = 1_500;
/** @type {{ key: string, at: number, value: Awaited<ReturnType<typeof buildTaskQueueStats>> } | null} */
let queueStatsCache = null;

function taskActivityKey(entry) {
  return `${entry.projectFolder}:${entry.taskFolderName}`;
}

function logEntryKey(entry) {
  return `${entry.timestamp ?? ''}:${entry.event ?? entry.label ?? ''}:${entry.taskFolderName ?? entry.detail ?? ''}`;
}

/** Merge keyed lists, preserving object identity for unchanged rows. */
function mergeKeyedEntries(previous, next, getKey) {
  if (next.length === 0 && previous.length > 0) {
    return previous;
  }

  if (previous.length === 0) {
    return next;
  }

  const previousByKey = new Map(previous.map(entry => [getKey(entry), entry]));
  const merged = [];
  let changed = previous.length !== next.length;

  for (const nextEntry of next) {
    const previousEntry = previousByKey.get(getKey(nextEntry));
    if (!previousEntry) {
      merged.push(nextEntry);
      changed = true;
      continue;
    }

    if (JSON.stringify(previousEntry) === JSON.stringify(nextEntry)) {
      merged.push(previousEntry);
    } else {
      merged.push(nextEntry);
      changed = true;
    }
  }

  if (!changed) {
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index] !== merged[index]) {
        changed = true;
        break;
      }
    }
  }

  return changed ? merged : previous;
}

function createTaskFolder(target, connection, taskFolderName) {
  if (target.mode === 'filesystem') {
    return createFilesystemTaskFolder(path.join(target.absolutePath, taskFolderName));
  }

  return createDriveApiTaskFolder(connection, target.folderId, taskFolderName);
}

async function listTaskFolderNames(target, connection) {
  let folderNames;
  if (target.mode === 'filesystem') {
    if (isICloudFilesystemConnection(connection)) {
      folderNames = await listICloudChildFolderNames(target.absolutePath);
      if (folderNames.length === 0) {
        folderNames = listFilesystemChildFolderNames(target.absolutePath);
      }
    } else {
      folderNames = listFilesystemChildFolderNames(target.absolutePath);
    }
  } else {
    folderNames = await listDriveApiChildFolderNames(connection, target.folderId);
  }

  return folderNames.filter(isTaskFolderName);
}

async function readTaskState(taskFolder) {
  const value = taskFolder.getState();
  return value instanceof Promise ? value : value;
}

async function listConvertingTasksWithoutProgress() {
  const connection = loadConnection();
  if (!connection) {
    return [];
  }

  const trackedIds = new Set(listConversionProgress().map(entry => entry.id));
  const extras = [];

  for (const target of uniqueProjectTargets(loadProjectRecords())) {
    let taskFolderNames = [];
    try {
      taskFolderNames = await listTaskFolderNames(target, connection);
    } catch {
      continue;
    }

    for (const taskFolderName of taskFolderNames) {
      const taskFolder = createTaskFolder(target, connection, taskFolderName);
      const state = await readTaskState(taskFolder);
      if (state !== 'converting') {
        continue;
      }

      const meta = getConversionMeta(taskFolder);
      if (trackedIds.has(meta.id)) {
        continue;
      }

      extras.push({
        id: meta.id,
        label: meta.label,
        detail: meta.detail,
        phase: 'converting',
        percent: 0,
        indeterminate: true,
        error: null,
        updatedAt: Date.now(),
      });
    }
  }

  return extras;
}

async function buildTaskQueueStats(options = {}) {
  const lite = options.lite === true;
  const previousStats = queueStatsCache?.value ?? null;
  const connection = loadConnection();
  if (!connection) {
    return {
      pendingAudio: 0,
      converting: 0,
      queuedRun: 0,
      running: 0,
      stopping: 0,
      taskWatcherRunning: false,
      conversions: [],
      tasks: [],
      apiDebugLog: [],
      speechToTextBackend: { id: 'none', label: 'Not connected', available: false },
    };
  }

  const tracked = listConversionProgress();
  let pendingAudio;
  let converting;
  let queuedRun;
  let running;
  let stopping;
  let tasks = [];
  let untracked = [];

  if (lite) {
    tasks = await listTaskActivity({ lite: true });
    const counts = {
      convert: tasks.filter(entry => entry.state === 'convert').length,
      converting: tasks.filter(entry => entry.state === 'converting').length,
      run: tasks.filter(entry => entry.state === 'run').length,
      running: tasks.filter(entry => entry.state === 'running').length,
      stop: tasks.filter(entry => entry.state === 'stop').length,
      stopping: tasks.filter(entry => entry.state === 'stopping').length,
    };
    // Report counts straight from the current on-disk states. We previously
    // "preserved" non-zero counts to avoid flicker, but that made finished tasks
    // appear stuck as running until a manual Sync.
    pendingAudio = counts.convert;
    converting = counts.converting;
    queuedRun = counts.run;
    running = counts.running;
    stopping = counts.stop + counts.stopping;
  } else {
    untracked = await listConvertingTasksWithoutProgress();
    tasks = await listTaskActivity();
    running = tasks.filter(entry => entry.state === 'running').length;
    stopping = tasks.filter(entry => entry.state === 'stopping' || entry.state === 'stop').length;
    pendingAudio = tasks.filter(entry => entry.state === 'convert').length;
    converting = tasks.filter(entry => entry.state === 'converting').length;
    queuedRun = tasks.filter(entry => entry.state === 'run').length;

    writeTaskDebugContext({
      runningCount: running,
      stoppingCount: stopping,
      activeTaskCount: tasks.length,
    });
  }

  const speechToTextBackend = lite
    ? { id: 'unknown', label: 'Background', available: true }
    : await resolveSpeechToTextBackend();

  const apiDebugLog = !lite
    ? mergeKeyedEntries(
        previousStats?.apiDebugLog ?? [],
        listApiDebugLog(DEBUG_EVENT_LIMIT),
        logEntryKey,
      )
    : (previousStats?.apiDebugLog ?? []);

  const conversions = lite
    ? (tracked.length > 0 ? tracked : (previousStats?.conversions ?? tracked))
    : [...tracked, ...untracked];

  const mergedTasks = mergeKeyedEntries(
    previousStats?.tasks ?? [],
    tasks,
    taskActivityKey,
  );

  return {
    pendingAudio,
    converting,
    queuedRun,
    running,
    stopping,
    taskWatcherRunning: isTaskWatcherRunning(),
    speechToTextBackend,
    conversions,
    tasks: mergedTasks,
    apiDebugLog,
  };
}

export async function getTaskQueueStats(options = {}) {
  const cacheKey = options.lite ? 'lite' : 'full';
  const cacheMs = options.lite ? QUEUE_STATS_LITE_CACHE_MS : QUEUE_STATS_FULL_CACHE_MS;
  if (
    !options.force &&
    queueStatsCache &&
    queueStatsCache.key === cacheKey &&
    Date.now() - queueStatsCache.at < cacheMs
  ) {
    return queueStatsCache.value;
  }

  const value = await buildTaskQueueStats(options);
  queueStatsCache = { key: cacheKey, at: Date.now(), value };
  return value;
}

export function invalidateTaskQueueStatsCache() {
  queueStatsCache = null;
}
