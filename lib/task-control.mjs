import { loadConnection, loadProjectRecord, updateProjectRecord } from './cloud-connection-store.mjs';
import { deleteCloudFolder, listDriveChildFolders } from './cloud-folders.mjs';
import { refreshCursorAuthCacheSync } from './cursor-auth.mjs';
import { LOG_PREFIX } from './constants.mjs';
import { createTaskFolder, getProjectTarget } from './project-targets.mjs';
import { archivedFailLogFileName } from './task-files.mjs';
import { resolveResumeTaskState } from './task-states.mjs';
import { invalidateTaskQueueStatsCache } from './task-stats.mjs';

const STOPPABLE_STATES = new Set(['run', 'running', 'convert', 'converting']);

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

async function readTaskField(taskFolder, field) {
  const value = taskFolder[field]?.();
  return value instanceof Promise ? value : value;
}

async function writeTaskField(taskFolder, field, ...args) {
  const value = taskFolder[field]?.(...args);
  if (value instanceof Promise) {
    await value;
  }
}

function nextArchivedFailLogFileName(taskFolder) {
  if (taskFolder.mode !== 'filesystem') {
    return `failed.${Date.now()}.log`;
  }

  let sequence = 1;
  const entries = taskFolder.listEntries?.() ?? [];
  while (entries.includes(archivedFailLogFileName(sequence))) {
    sequence += 1;
  }

  return archivedFailLogFileName(sequence);
}

async function archiveFailLogIfPresent(taskFolder) {
  const content = await readTaskField(taskFolder, 'readFailLog');
  if (!content?.trim()) {
    return;
  }

  const archiveName = nextArchivedFailLogFileName(taskFolder);
  await writeTaskField(taskFolder, 'writeArchivedFailLog', archiveName, content);
  await writeTaskField(taskFolder, 'clearFailLog');
}

async function taskFolderHasRequestAudio(taskFolder) {
  if (taskFolder.mode === 'filesystem') {
    return Boolean(taskFolder.findRequestAudioPath?.());
  }

  const audioName = await readTaskField(taskFolder, 'findRequestAudioName');
  return Boolean(audioName);
}

async function loadTaskFolder(projectKey, taskFolderName) {
  const connection = loadConnection();
  const project = loadProjectRecord(projectKey);
  const target = getProjectTarget(project);
  if (!connection || !target || !project) {
    throw new Error('Cloud connection or project folder is not available.');
  }

  return {
    connection,
    project,
    target,
    taskFolder: createTaskFolder(target, connection, taskFolderName),
  };
}

async function refreshTaskQueueAfterControlChange(options = {}) {
  invalidateTaskQueueStatsCache();
  if (options.skipBackgroundScan === true) {
    return;
  }

  const { requestBackgroundScan } = await import('./task-monitor.mjs');
  requestBackgroundScan();
}

/**
 * @param {import('vscode') | undefined} vscode
 * @returns {Promise<{ ok: true, started: boolean }>}
 */
export async function runTaskFromServer(projectKey, taskFolderName, vscode, options = {}) {
  const { taskFolder } = await loadTaskFolder(projectKey, taskFolderName);
  const state = await readTaskField(taskFolder, 'getState');

  if (state !== 'run') {
    throw new Error(`Task ${taskFolderName} is not ready to run (state: ${state ?? 'idle'}).`);
  }

  refreshCursorAuthCacheSync();

  const { processRunTask } = await import('./task-run-handler.mjs');
  const started = await processRunTask(taskFolder, {
    vscode,
    workspaceStorageUri: options.workspaceStorageUri,
  });
  log(`Manual run invoked from server panel for task ${taskFolderName}.`);
  await refreshTaskQueueAfterControlChange({ skipBackgroundScan: true });
  return { ok: true, started };
}

/**
 * @returns {Promise<{ ok: true, alreadyStopping?: boolean }>}
 */
export async function stopTaskFromServer(projectKey, taskFolderName) {
  const { taskFolder } = await loadTaskFolder(projectKey, taskFolderName);
  const state = await readTaskField(taskFolder, 'getState');

  if (state === 'stop' || state === 'stopping') {
    return { ok: true, alreadyStopping: true };
  }

  if (!state || !STOPPABLE_STATES.has(state)) {
    throw new Error(`Task ${taskFolderName} cannot be stopped while ${state ?? 'idle'}.`);
  }

  await writeTaskField(taskFolder, 'setState', 'stop');
  log(`Stop requested from server panel for task ${taskFolderName}.`);
  await refreshTaskQueueAfterControlChange();
  return { ok: true };
}

/**
 * @returns {Promise<{ ok: true, nextState: string }>}
 */
export async function resumeFailedTaskFromServer(projectKey, taskFolderName) {
  const { taskFolder } = await loadTaskFolder(projectKey, taskFolderName);
  const state = await readTaskField(taskFolder, 'getState');
  const failLog = await readTaskField(taskFolder, 'readFailLog');
  const hasFailLog = Boolean(failLog?.trim());
  const resumable = state === 'fail' || (state === 'stopped' && hasFailLog);

  if (!resumable) {
    throw new Error(`Task ${taskFolderName} is not in a failed state.`);
  }

  const requestText = (await readTaskField(taskFolder, 'readRequestText')) ?? '';
  const hasRequestText = Boolean(requestText.trim());
  const hasAudio = await taskFolderHasRequestAudio(taskFolder);
  const nextState = resolveResumeTaskState({
    hasAudio,
    hasRequestText,
    wasPaused: state === 'paused',
  });

  await archiveFailLogIfPresent(taskFolder);
  await writeTaskField(taskFolder, 'clearDispatchAttemptCount');
  await writeTaskField(taskFolder, 'setState', nextState);
  log(`Resumed failed task ${taskFolderName} from server panel to ${nextState}.`);
  await refreshTaskQueueAfterControlChange();
  return { ok: true, nextState };
}

const REMOVABLE_TASK_STATES = new Set(['stopped', 'fail']);

/**
 * @returns {Promise<{ ok: true }>}
 */
export async function removeTaskFromServer(projectKey, taskFolderName) {
  const { connection, project, target, taskFolder } = await loadTaskFolder(
    projectKey,
    taskFolderName,
  );
  const state = await readTaskField(taskFolder, 'getState');

  if (!state || !REMOVABLE_TASK_STATES.has(state)) {
    throw new Error(`Task ${taskFolderName} cannot be removed while ${state ?? 'idle'}.`);
  }

  if (target.mode === 'filesystem') {
    await deleteCloudFolder(connection, { absolutePath: taskFolder.taskFolderPath });
  } else {
    const childFolders = await listDriveChildFolders(connection, target.folderId);
    const match = childFolders.find(entry => entry.name === taskFolderName);
    if (!match?.folderId) {
      throw new Error(`Task folder not found: ${taskFolderName}`);
    }
    await deleteCloudFolder(connection, { folderId: match.folderId });
  }

  if (project.activeTaskFolderName === taskFolderName) {
    updateProjectRecord(projectKey, {
      activeTaskFolderName: null,
      stopAgentRequested: false,
    });
  }

  log(`Removed task ${taskFolderName} from server panel.`);
  await refreshTaskQueueAfterControlChange();
  return { ok: true };
}
