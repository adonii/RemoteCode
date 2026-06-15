import { debugLog } from './debug-log.mjs';

function log(message) {
  debugLog('run', message);
}

/** @type {Set<string>} */
const runTaskInFlight = new Set();

function taskFolderKey(taskFolder) {
  if (typeof taskFolder.taskFolderPath === 'string' && taskFolder.taskFolderPath) {
    return taskFolder.taskFolderPath;
  }

  return String(taskFolder.taskFolderName ?? '');
}

async function tryClaimRunningState(taskFolder) {
  let state = taskFolder.getState?.();
  if (state instanceof Promise) {
    state = await state;
  }

  if (state !== 'run') {
    return false;
  }

  const setResult = taskFolder.setState?.('running');
  if (setResult instanceof Promise) {
    await setResult;
  }

  return true;
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

async function buildTaskDispatchText(taskFolder) {
  const parts = [];

  const requestText = (await readTaskField(taskFolder, 'readRequestText')) ?? '';
  if (requestText.trim()) {
    parts.push(requestText.trim());
  }

  const promptText = (await readTaskField(taskFolder, 'readPromptText')) ?? '';
  if (promptText.trim()) {
    parts.push(promptText.trim());
  }

  return parts.join('\n\n');
}

/**
 * Handle a task folder in run state.
 *
 * @param {object} taskFolder
 * @param {{ vscode?: import('vscode'), workspaceStorageUri?: import('vscode').Uri }} [options]
 * @returns {Promise<boolean>}
 */
export async function processRunTask(taskFolder, options = {}) {
  const key = taskFolderKey(taskFolder);
  if (runTaskInFlight.has(key)) {
    log(`Skipping duplicate processRunTask for ${key}.`);
    return false;
  }

  runTaskInFlight.add(key);
  log(`processRunTask start for ${key}.`);
  try {
    if (!(await tryClaimRunningState(taskFolder))) {
      log(`Could not claim running state for ${key} (state not 'run').`);
      return false;
    }
    log(`Claimed running state for ${key}.`);

    const prompt = await buildTaskDispatchText(taskFolder);
    if (!prompt) {
      log(`Task ${key} has no request text to dispatch.`);
      await taskFolder.setState?.('run');
      return false;
    }
    log(`Built dispatch prompt for ${key} (length ${prompt.length}).`);

    const vscode = options.vscode;
    if (!vscode) {
      log(`Task dispatch for ${key} requires the RemoteCode extension host.`);
      await taskFolder.setState?.('run');
      return false;
    }

    let dispatchPrompt = prompt;
    try {
      const { buildInjectedContext } = await import('./task-context.mjs');
      const context = await buildInjectedContext(vscode, taskFolder);
      if (context) {
        dispatchPrompt = `${context}\n\n# Task\n\n${prompt}`;
        log(`Prepended ${context.length} chars of prior context for ${key}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Context injection skipped for ${key}: ${message}`);
    }

    try {
      const { enqueuePromptOnFocusedAgentTab } = await import('./composer-queue-enqueue.mjs');
      const result = await enqueuePromptOnFocusedAgentTab(vscode, dispatchPrompt);
      await writeTaskField(taskFolder, 'writeComposerId', result.composerId);
      log(
        `Dispatched task ${key} on new agent composer ${result.composerId} ` +
          `(reason ${result.dispatchReason}); wrote .composer-id, tracking for output.`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Task queue dispatch failed for ${key}: ${message}`);
      await taskFolder.setState?.('run');
      return false;
    }
  } finally {
    runTaskInFlight.delete(key);
  }
}
