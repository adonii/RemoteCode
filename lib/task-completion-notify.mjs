import path from 'node:path';
import { loadConnection, loadProjectRecords } from './cloud-connection-store.mjs';
import {
  createTaskFolder,
  listProjectTaskFolderNames,
  resolveProjectRecords,
  resolveProjectTargets,
} from './project-targets.mjs';
import { workspaceScopeKey } from './workspace-scope.mjs';

const TERMINAL_STATES = new Set(['done', 'fail']);

function taskKey(projectKey, taskFolderName) {
  return `${projectKey}:${taskFolderName}`;
}

function previewFailLog(text, maxLength = 120) {
  if (typeof text !== 'string') {
    return null;
  }

  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const message = lines.find(line => !/^\d{4}-\d{2}-\d{2}T/.test(line)) ?? lines[0];
  if (!message) {
    return null;
  }

  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}

/** @type {Map<string, Map<string, string | null>>} */
const previousStatesByScope = new Map();
/** @type {Set<string>} */
const seededScopes = new Set();

function getScopeState(scopeKey) {
  let scopeState = previousStatesByScope.get(scopeKey);
  if (!scopeState) {
    scopeState = new Map();
    previousStatesByScope.set(scopeKey, scopeState);
  }
  return scopeState;
}

async function readTaskState(taskFolder) {
  const value = taskFolder.getState();
  return value instanceof Promise ? await value : value;
}

async function listCurrentTaskStates(workspaceRoots) {
  const connection = loadConnection();
  if (!connection) {
    return [];
  }

  const recordsByKey = new Map(
    resolveProjectRecords(loadProjectRecords(), workspaceRoots).map(record => [
      record.projectKey,
      record,
    ]),
  );
  const entries = [];

  for (const target of resolveProjectTargets(loadProjectRecords(), workspaceRoots)) {
    let taskFolderNames = [];
    try {
      taskFolderNames = await listProjectTaskFolderNames(target, connection);
    } catch {
      continue;
    }

    const record = recordsByKey.get(target.projectKey);
    const projectFolder = record?.projectFolder ?? target.relativePath ?? target.projectKey;

    for (const taskFolderName of taskFolderNames) {
      const taskFolder = createTaskFolder(target, connection, taskFolderName);
      const state = await readTaskState(taskFolder);
      if (!state) {
        continue;
      }

      entries.push({
        key: taskKey(target.projectKey, taskFolderName),
        projectKey: target.projectKey,
        projectFolder,
        taskFolderName,
        state,
        taskFolder,
      });
    }
  }

  return entries;
}

/**
 * Detect tasks that newly reached done or fail since the last poll.
 * Seeds state on first call without returning transitions.
 *
 * @param {string[] | undefined} workspaceRoots
 * @returns {Promise<Array<{ taskFolderName: string, projectFolder: string, state: 'done' | 'fail', failPreview: string | null }>>}
 */
export async function detectTaskTerminalTransitions(workspaceRoots = []) {
  const scopeKey = workspaceScopeKey(workspaceRoots);
  const previousStates = getScopeState(scopeKey);
  const current = await listCurrentTaskStates(workspaceRoots);
  const currentKeys = new Set(current.map(entry => entry.key));

  if (!seededScopes.has(scopeKey)) {
    for (const entry of current) {
      previousStates.set(entry.key, entry.state);
    }
    seededScopes.add(scopeKey);
    return [];
  }

  /** @type {Array<{ taskFolderName: string, projectFolder: string, state: 'done' | 'fail', failPreview: string | null }>} */
  const transitions = [];

  for (const entry of current) {
    const previous = previousStates.get(entry.key);
    previousStates.set(entry.key, entry.state);

    if (
      previous &&
      !TERMINAL_STATES.has(previous) &&
      (entry.state === 'done' || entry.state === 'fail')
    ) {
      let failPreview = null;
      if (entry.state === 'fail') {
        const readResult = entry.taskFolder.readFailLog?.();
        const failLog = readResult instanceof Promise ? await readResult : readResult;
        failPreview = previewFailLog(failLog);
      }

      transitions.push({
        taskFolderName: entry.taskFolderName,
        projectFolder: entry.projectFolder,
        state: entry.state,
        failPreview,
      });
    }
  }

  for (const key of [...previousStates.keys()]) {
    if (!currentKeys.has(key)) {
      previousStates.delete(key);
    }
  }

  return transitions;
}

export function resetTaskTerminalTransitionTracking(workspaceRoots) {
  if (workspaceRoots === undefined) {
    previousStatesByScope.clear();
    seededScopes.clear();
    return;
  }

  const scopeKey = workspaceScopeKey(workspaceRoots);
  previousStatesByScope.delete(scopeKey);
  seededScopes.delete(scopeKey);
}
