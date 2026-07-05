import {
  loadConnection,
  loadProjectRecord,
  loadProjectRecords,
  updateProjectRecord,
} from './cloud-connection-store.mjs';
import { resolveProjectKeyFromSession } from './ensure-project-folder.mjs';
import { getSessionIdFromHook } from './hook-utils.mjs';
import {
  createTaskFolder,
  getProjectTarget,
  listProjectTaskFolderNames,
  resolveProjectRecords,
  resolveProjectTargets,
} from './project-targets.mjs';
import { APP_NAME, LOG_PREFIX } from './constants.mjs';
import { getWorkspaceRoots } from './workspace-scope.mjs';

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

const STOP_DENY_RESPONSE = {
  permission: 'deny',
  user_message: `Task stopped from ${APP_NAME} mobile.`,
  agent_message:
    `This task was stopped by the user via ${APP_NAME} mobile. Stop all work on this task immediately and do not continue.`,
};

async function readTaskField(taskFolder, field) {
  const value = taskFolder[field]();
  return value instanceof Promise ? value : value;
}

function findProjectForActiveTask(target, taskFolderName, records) {
  for (const project of records) {
    if (project.activeTaskFolderName !== taskFolderName) {
      continue;
    }

    const projectTarget = getProjectTarget(project);
    if (!projectTarget) {
      continue;
    }

    const targetKey = target.mode === 'filesystem' ? target.absolutePath : target.folderId;
    const projectKey =
      projectTarget.mode === 'filesystem'
        ? projectTarget.absolutePath
        : projectTarget.folderId;

    if (targetKey === projectKey) {
      return project;
    }
  }

  return null;
}

async function clearApprovalFiles(taskFolder) {
  const hasRequest = await readTaskField(taskFolder, 'hasApprovalRequest');
  if (!hasRequest) {
    return;
  }

  const clearResult = taskFolder.clearApprovalFiles();
  if (clearResult instanceof Promise) {
    await clearResult;
  }
}

async function handleStopState(taskFolder, project, taskFolderName) {
  const state = await readTaskField(taskFolder, 'getState');
  if (state !== 'stop') {
    return false;
  }

  await taskFolder.setState('stopped');

  const wasActive = project?.activeTaskFolderName === taskFolderName;
  if (!wasActive || !project?.projectKey) {
    log(`Task ${taskFolderName} stopped before it started.`);
    return true;
  }

  await clearApprovalFiles(taskFolder);

  updateProjectRecord(project.projectKey, {
    stopAgentRequested: true,
    pendingApproval: false,
    pendingFollowupMessage: null,
  });

  log(`Stop requested for active task ${taskFolderName}; halting agent.`);

  return true;
}

async function pollStopStatesForTarget(target, connection, records) {
  let taskFolderNames = [];
  try {
    taskFolderNames = await listProjectTaskFolderNames(target, connection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to list task folders for stop polling (${target.relativePath}): ${message}`);
    return;
  }

  for (const taskFolderName of taskFolderNames) {
    try {
      const taskFolder = createTaskFolder(target, connection, taskFolderName);
      const state = await readTaskField(taskFolder, 'getState');
      if (state !== 'stop') {
        continue;
      }

      const project = findProjectForActiveTask(target, taskFolderName, records);
      await handleStopState(taskFolder, project, taskFolderName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Stop polling failed for ${taskFolderName}: ${message}`);
    }
  }
}

export async function pollAllStopRequests() {
  const connection = loadConnection();
  if (!connection) {
    return;
  }

  const records = resolveProjectRecords(loadProjectRecords(), getWorkspaceRoots());
  const targets = resolveProjectTargets(records, getWorkspaceRoots());

  for (const target of targets) {
    await pollStopStatesForTarget(target, connection, records);
  }
}

export function isStopAgentRequested(sessionId) {
  const projectKey = resolveProjectKeyFromSession(sessionId);
  if (!projectKey) {
    return false;
  }

  return loadProjectRecord(projectKey)?.stopAgentRequested === true;
}

export async function handleStopGate(hookInput) {
  const sessionId = getSessionIdFromHook(hookInput);
  if (!sessionId || !isStopAgentRequested(sessionId)) {
    return { permission: 'allow' };
  }

  return STOP_DENY_RESPONSE;
}
