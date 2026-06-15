import { loadConnection, loadProjectRecord, updateProjectRecord } from './cloud-connection-store.mjs';
import { LOG_PREFIX } from './constants.mjs';
import { createTaskFolder, getProjectTarget } from './project-targets.mjs';

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function buildFailLogContent(message) {
  return [new Date().toISOString(), message].join('\n');
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

function clearProjectTaskLock(projectKey) {
  updateProjectRecord(projectKey, {
    activeTaskFolderName: null,
    pendingApproval: false,
    pendingFollowupMessage: null,
    stopAgentRequested: false,
  });
}

export async function failTaskWithLog(
  projectKey,
  taskFolderName,
  message,
  options = {},
) {
  const connection = loadConnection();
  const project = loadProjectRecord(projectKey);
  const target = getProjectTarget(project);
  if (!connection || !target) {
    if (options.clearProjectLock !== false) {
      clearProjectTaskLock(projectKey);
    }
    return;
  }

  const taskFolder = createTaskFolder(target, connection, taskFolderName);
  await writeTaskField(taskFolder, 'writeFailLog', buildFailLogContent(message));
  await writeTaskField(taskFolder, 'setState', 'fail');
  await writeTaskField(taskFolder, 'clearDispatchAttemptCount');
  if (options.clearProjectLock !== false) {
    clearProjectTaskLock(projectKey);
  }
}

export async function failStaleRecoveredTask(projectKey, taskFolderName, message) {
  const project = loadProjectRecord(projectKey);
  const isActiveTask = project?.activeTaskFolderName === taskFolderName;

  await failTaskWithLog(projectKey, taskFolderName, message, {
    clearProjectLock: isActiveTask,
  });
  if (isActiveTask) {
    log(`Marked stale task ${taskFolderName} as failed for project ${projectKey}.`);
  }
  return true;
}
