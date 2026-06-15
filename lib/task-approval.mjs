import {
  createDriveApiTaskFolder,
  createFilesystemTaskFolder,
} from './cloud-files.mjs';
import fs from 'node:fs';
import {
  loadConnection,
  loadProjectRecord,
  loadProjectRecords,
  PROJECTS_DIR,
  updateProjectRecord,
} from './cloud-connection-store.mjs';
import { resolveProjectKeyFromSession } from './ensure-project-folder.mjs';
import { getSessionIdFromHook } from './hook-utils.mjs';
import { getProjectTarget, createTaskFolder } from './project-targets.mjs';
import { handleStopGate } from './task-stop.mjs';
import path from 'node:path';
import { APP_NAME, LOG_PREFIX } from './constants.mjs';

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

async function readTaskField(taskFolder, field) {
  const value = taskFolder[field]();
  return value instanceof Promise ? value : value;
}

function getActiveTaskFolder(projectKey, connection) {
  const project = loadProjectRecord(projectKey);
  const target = getProjectTarget(project);
  if (!target || !project?.activeTaskFolderName) {
    return null;
  }

  if (target.mode === 'filesystem') {
    return createFilesystemTaskFolder(
      path.join(target.absolutePath, project.activeTaskFolderName),
    );
  }

  return createDriveApiTaskFolder(
    connection,
    target.folderId,
    project.activeTaskFolderName,
  );
}

function resolveProjectKey(sessionId) {
  return resolveProjectKeyFromSession(sessionId);
}

export async function hasActiveRunningTask(sessionId) {
  const connection = loadConnection();
  const projectKey = resolveProjectKey(sessionId);
  const project = projectKey ? loadProjectRecord(projectKey) : null;
  if (!connection || !projectKey || !project?.activeTaskFolderName) {
    return false;
  }

  const taskFolder = getActiveTaskFolder(projectKey, connection);
  if (!taskFolder) {
    return false;
  }

  return (await readTaskField(taskFolder, 'getState')) === 'running';
}

export function buildShellApprovalContent(hookInput) {
  const command = hookInput.command ?? '(unknown command)';
  const cwd = hookInput.cwd ? `\nWorking directory: ${hookInput.cwd}` : '';
  return `Shell command:\n${command}${cwd}`;
}

export function buildMcpApprovalContent(hookInput) {
  const server = hookInput.server ?? hookInput.command ?? 'unknown-server';
  const toolName = hookInput.tool_name ?? 'unknown-tool';
  const toolInput =
    typeof hookInput.tool_input === 'string'
      ? hookInput.tool_input
      : JSON.stringify(hookInput.tool_input ?? {}, null, 2);
  return `MCP tool:\n${server} / ${toolName}\n\nInput:\n${toolInput}`;
}

export async function createApprovalRequest(sessionId, content) {
  const connection = loadConnection();
  const projectKey = resolveProjectKey(sessionId);
  const project = projectKey ? loadProjectRecord(projectKey) : null;
  if (!connection || !projectKey || !project?.activeTaskFolderName) {
    return false;
  }

  const taskFolder = getActiveTaskFolder(projectKey, connection);
  if (!taskFolder) {
    return false;
  }

  if (await readTaskField(taskFolder, 'hasApprovalRequest')) {
    return true;
  }

  const writeResult = taskFolder.writeApprovalRequest(content);
  if (writeResult instanceof Promise) {
    await writeResult;
  }
  updateProjectRecord(projectKey, { pendingApproval: true });
  log(`Created approval.request for task ${project.activeTaskFolderName}.`);
  return true;
}

export async function hasPendingApprovalRequest(sessionId) {
  const connection = loadConnection();
  const projectKey = resolveProjectKey(sessionId);
  const project = projectKey ? loadProjectRecord(projectKey) : null;
  if (!connection || !projectKey || !project?.activeTaskFolderName) {
    return false;
  }

  const taskFolder = getActiveTaskFolder(projectKey, connection);
  if (!taskFolder) {
    return false;
  }

  return readTaskField(taskFolder, 'hasApprovalRequest');
}

function buildApprovedFollowup(content) {
  return [
    `The user approved this action in the ${APP_NAME} mobile app:`,
    '',
    content.trim(),
    '',
    'Please proceed with this action now.',
  ].join('\n');
}

function buildSkippedFollowup(content) {
  return [
    `The user skipped this action in the ${APP_NAME} mobile app:`,
    '',
    content.trim(),
    '',
    'Continue the task without performing this action.',
  ].join('\n');
}

export async function pollApprovalResponse(sessionId) {
  const connection = loadConnection();
  const projectKey = resolveProjectKey(sessionId);
  const project = projectKey ? loadProjectRecord(projectKey) : null;
  if (!connection || !projectKey || !project?.activeTaskFolderName) {
    return null;
  }

  const taskFolder = getActiveTaskFolder(projectKey, connection);
  if (!taskFolder) {
    return null;
  }

  const hasRequest = await readTaskField(taskFolder, 'hasApprovalRequest');
  if (!hasRequest) {
    return null;
  }

  const approved = await readTaskField(taskFolder, 'hasApprovalApproveFile');
  const skipped = await readTaskField(taskFolder, 'hasApprovalSkipFile');
  if (!approved && !skipped) {
    return null;
  }

  const content = (await readTaskField(taskFolder, 'readApprovalRequest')) ?? '';
  const clearResult = taskFolder.clearApprovalFiles();
  if (clearResult instanceof Promise) {
    await clearResult;
  }

  const followupMessage = approved
    ? buildApprovedFollowup(content)
    : buildSkippedFollowup(content);

  updateProjectRecord(projectKey, {
    pendingApproval: false,
    pendingFollowupMessage: followupMessage,
  });

  log(
    `Processed ${approved ? 'approve' : 'skip'} response for task ${project.activeTaskFolderName}.`,
  );
  return followupMessage;
}

export async function handleApprovalGate(hookInput) {
  const stopGate = await handleStopGate(hookInput);
  if (stopGate.permission === 'deny') {
    return stopGate;
  }

  const sessionId = getSessionIdFromHook(hookInput);
  if (!sessionId || !(await hasActiveRunningTask(sessionId))) {
    return { permission: 'allow' };
  }

  const content =
    hookInput.hook_event_name === 'beforeMCPExecution'
      ? buildMcpApprovalContent(hookInput)
      : buildShellApprovalContent(hookInput);

  await createApprovalRequest(sessionId, content);

  return {
    permission: 'deny',
    user_message:
      `This action requires approval in the ${APP_NAME} mobile app.`,
    agent_message:
      `This action requires approval in the ${APP_NAME} mobile app. Waiting for the user to approve or skip before continuing.`,
  };
}

export async function pollAllProjectApprovals() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return;
  }

  for (const project of loadProjectRecords()) {
    const sessionId = project.lastActiveSessionId;
    if (!sessionId) {
      continue;
    }

    try {
      await pollApprovalResponse(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Approval polling failed for project ${project.projectKey}: ${message}`);
    }
  }
}

