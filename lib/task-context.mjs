import { loadConnection, loadProjectRecords } from './cloud-connection-store.mjs';
import {
  createTaskFolder,
  listProjectTaskFolderNames,
  uniqueProjectTargets,
} from './project-targets.mjs';
import { readComposerConversationTextAsync } from './composer-output.mjs';
import { loadSettings } from './settings-store.mjs';
import { debugLog } from './debug-log.mjs';

// Rough heuristic: ~4 characters per token. Used only to turn the user's token
// budget into a character cap for the injected context.
const CHARS_PER_TOKEN = 4;

function log(message) {
  debugLog('context', message);
}

async function callTaskField(taskFolder, field, ...args) {
  const value = taskFolder[field]?.(...args);
  return value instanceof Promise ? await value : value;
}

async function getActiveComposerId(vscode) {
  try {
    const ids = await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds');
    if (Array.isArray(ids) && ids.length > 0) {
      const first = ids[0];
      if (typeof first === 'string') {
        return first;
      }
      if (first && typeof first.composerId === 'string') {
        return first.composerId;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Could not read active composer id: ${message}`);
  }
  return null;
}

async function collectCompletedTaskHistory(maxChars, excludeTaskFolderName) {
  const connection = loadConnection();
  if (!connection) {
    return '';
  }

  /** @type {Array<{ name: string, block: string }>} */
  const entries = [];
  for (const target of uniqueProjectTargets(loadProjectRecords())) {
    let names = [];
    try {
      names = await listProjectTaskFolderNames(target, connection);
    } catch {
      continue;
    }

    for (const name of names) {
      if (name === excludeTaskFolderName) {
        continue;
      }
      const taskFolder = createTaskFolder(target, connection, name);
      let state;
      try {
        state = await callTaskField(taskFolder, 'getState');
      } catch {
        continue;
      }
      if (state !== 'done') {
        continue;
      }

      const request = ((await callTaskField(taskFolder, 'readRequestText')) ?? '').trim();
      const response = ((await callTaskField(taskFolder, 'readResponseText')) ?? '').trim();
      if (!request && !response) {
        continue;
      }
      entries.push({
        name,
        block: `Task ${name}\nRequest: ${request}\nResult: ${response}`,
      });
    }
  }

  // Most recent first (folder names are timestamp-ordered).
  entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

  let out = '';
  for (const entry of entries) {
    const candidate = out ? `${out}\n\n${entry.block}` : entry.block;
    if (candidate.length > maxChars) {
      break;
    }
    out = candidate;
  }
  return out;
}

/**
 * Build the context block to prepend to a task's prompt, honoring the user's
 * settings (active-tab context, accumulated task history) and token budget.
 * Returns '' when nothing should be injected.
 *
 * @param {import('vscode')} vscode
 * @param {object} [taskFolder] the task being dispatched (excluded from history)
 * @returns {Promise<string>}
 */
export async function buildInjectedContext(vscode, taskFolder) {
  const settings = loadSettings();
  const tokenLimit = settings.contextTokenLimit;

  // Active-tab context is the master switch: completed-task history is a
  // sub-option of it, and the token budget only applies while it's on.
  if (!settings.injectActiveTabContext || tokenLimit <= 0) {
    return '';
  }

  const maxChars = tokenLimit * CHARS_PER_TOKEN;
  const parts = [];

  if (vscode) {
    const activeId = await getActiveComposerId(vscode);
    if (activeId) {
      const text = await readComposerConversationTextAsync(activeId, { maxChars });
      if (text) {
        parts.push(`## Context from the active Cursor tab\n\n${text}`);
        log(`Injected ${text.length} chars from active tab ${activeId}.`);
      }
    }
  }

  if (settings.accumulateTaskHistory) {
    const used = parts.join('\n\n').length;
    const remaining = Math.max(0, maxChars - used);
    if (remaining > 0) {
      const taskFolderName = taskFolder?.taskFolderName ?? undefined;
      const history = await collectCompletedTaskHistory(remaining, taskFolderName);
      if (history) {
        parts.push(`## Context from previously completed tasks\n\n${history}`);
        log(`Injected ${history.length} chars from completed task history.`);
      }
    }
  }

  if (parts.length === 0) {
    return '';
  }

  let combined = parts.join('\n\n');
  if (combined.length > maxChars) {
    combined = combined.slice(combined.length - maxChars);
  }

  return (
    `# Prior context (for continuity only — do not repeat it back; ` +
    `continue as if the same conversation)\n\n${combined}`
  );
}
