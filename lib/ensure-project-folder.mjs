import { buildProjectFolderPath } from './cloud-path.mjs';
import {
  loadConnection,
  loadProjectRecord,
  loadProjectRecords,
  loadSessionRecord,
  saveProjectRecord,
  saveSessionRecord,
  updateProjectRecord,
} from './cloud-connection-store.mjs';
import { ensureCloudFolder } from './cloud-folders.mjs';
import { buildProjectKey } from './project-key.mjs';

function getSessionId(hookInput) {
  return (
    hookInput.session_id ||
    hookInput.conversation_id ||
    hookInput.generation_id ||
    null
  );
}

function shouldSkipSession(hookInput) {
  if (hookInput.is_background_agent === true) {
    return true;
  }

  const mode = hookInput.composer_mode;
  if (mode && mode !== 'agent') {
    return true;
  }

  return false;
}

function buildSessionRecord(sessionId, pathInfo, projectKey, cloud, existing = null) {
  return {
    ...(existing ?? {}),
    sessionId,
    projectKey,
    machineName: pathInfo.machineName,
    projectFolder: pathInfo.projectFolder,
    relativePath: pathInfo.relativePath,
    cloud,
    updatedAt: new Date().toISOString(),
  };
}

function buildProjectRecord(pathInfo, cloud, workspaceRoot = null) {
  const projectKey = buildProjectKey(pathInfo.machineName, pathInfo.projectFolder);
  const existing = loadProjectRecord(projectKey);

  return {
    projectKey,
    machineName: pathInfo.machineName,
    projectFolder: pathInfo.projectFolder,
    relativePath: pathInfo.relativePath,
    workspaceRoot: workspaceRoot ?? existing?.workspaceRoot ?? null,
    cloud,
    activeTaskFolderName: existing?.activeTaskFolderName ?? null,
    pendingApproval: existing?.pendingApproval ?? false,
    stopAgentRequested: existing?.stopAgentRequested ?? false,
    updatedAt: new Date().toISOString(),
  };
}

export function resolveProjectKeyFromSession(sessionId) {
  const session = loadSessionRecord(sessionId);
  if (session?.projectKey) {
    return session.projectKey;
  }

  for (const record of loadProjectRecords()) {
    if (record.lastActiveSessionId === sessionId) {
      return record.projectKey ?? null;
    }
  }

  return null;
}

export async function ensureProjectFolderForHook(hookInput) {
  const connection = loadConnection();
  if (!connection) {
    return { skipped: true, reason: 'not_authenticated' };
  }

  const sessionId = getSessionId(hookInput);
  if (!sessionId) {
    return { skipped: true, reason: 'missing_session_id' };
  }

  if (shouldSkipSession(hookInput)) {
    return { skipped: true, reason: 'non_agent_session' };
  }

  const pathInfo = buildProjectFolderPath(hookInput);
  const projectKey = buildProjectKey(pathInfo.machineName, pathInfo.projectFolder);
  const existingProject = loadProjectRecord(projectKey);
  const workspaceRoot =
    Array.isArray(hookInput.workspace_roots) && hookInput.workspace_roots.length > 0
      ? hookInput.workspace_roots[0]
      : existingProject?.workspaceRoot ?? null;

  if (existingProject?.cloud && existingProject.relativePath === pathInfo.relativePath) {
    const existingSession = loadSessionRecord(sessionId);
    const sessionRecord = buildSessionRecord(
      sessionId,
      pathInfo,
      projectKey,
      existingProject.cloud,
      existingSession,
    );
    saveSessionRecord(sessionId, sessionRecord);
    updateProjectRecord(projectKey, { workspaceRoot });

    return {
      skipped: true,
      reason: 'already_provisioned',
      projectKey,
      ...sessionRecord,
    };
  }

  const created = await ensureCloudFolder(connection, pathInfo.relativePath);
  const projectRecord = buildProjectRecord(pathInfo, created, workspaceRoot);
  saveProjectRecord(projectKey, projectRecord);

  const sessionRecord = buildSessionRecord(sessionId, pathInfo, projectKey, created);
  saveSessionRecord(sessionId, sessionRecord);
  updateProjectRecord(projectKey, { workspaceRoot });

  return {
    skipped: false,
    reason: existingProject?.cloud ? 'recreated' : 'created',
    projectKey,
    ...sessionRecord,
  };
}
