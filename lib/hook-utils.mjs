import { loadConnection, loadProjectRecord } from './cloud-connection-store.mjs';
import { resolveProjectKeyFromSession } from './ensure-project-folder.mjs';
import {
  createTaskFolder,
  getProjectTarget,
  listProjectTaskFolderNames,
} from './project-targets.mjs';

export function getSessionIdFromHook(hookInput) {
  return (
    hookInput.session_id ||
    hookInput.conversation_id ||
    hookInput.generation_id ||
    null
  );
}

async function readTaskState(taskFolder) {
  const value = taskFolder.getState();
  return value instanceof Promise ? value : value;
}

export async function countRunTasksForProject(projectKey) {
  const connection = loadConnection();
  const project = loadProjectRecord(projectKey);
  const target = getProjectTarget(project);
  if (!connection || !target) {
    return 0;
  }

  const folderNames = await listProjectTaskFolderNames(target, connection);
  let count = 0;

  for (const folderName of folderNames) {
    const taskFolder = createTaskFolder(target, connection, folderName);
    const state = await readTaskState(taskFolder);
    if (state === 'run') {
      count += 1;
    }
  }

  return count;
}

export async function countRunTasks(sessionId) {
  const projectKey = resolveProjectKeyFromSession(sessionId);
  if (!projectKey) {
    return 0;
  }

  return countRunTasksForProject(projectKey);
}
