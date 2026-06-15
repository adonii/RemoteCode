import { loadConnection, loadProjectRecords } from './cloud-connection-store.mjs';
import {
  createTaskFolder,
  listProjectTaskFolderNames,
  uniqueProjectTargets,
} from './project-targets.mjs';
import { loadSettings } from './settings-store.mjs';
import { debugLog } from './debug-log.mjs';

function log(message) {
  debugLog('orchestrator', message);
}

const INTERVAL_MS = 2_000;

let timer = null;
let tickInFlight = false;

// composerIds whose tabs we've already asked Cursor to close, so we don't spam
// the close command every tick while the folder still reports done/fail.
const closedComposerIds = new Set();

async function callTaskField(taskFolder, field, ...args) {
  const value = taskFolder[field]?.(...args);
  return value instanceof Promise ? await value : value;
}

async function readState(taskFolder) {
  try {
    return await callTaskField(taskFolder, 'getState');
  } catch {
    return null;
  }
}

async function closeFinishedTab(vscode, taskFolder, name, state) {
  let composerId;
  try {
    composerId = await callTaskField(taskFolder, 'readComposerId');
  } catch {
    return;
  }
  if (!composerId || closedComposerIds.has(composerId)) {
    return;
  }

  try {
    // Cursor's composer.closeComposerTab handler accepts a composerId string and
    // closes that specific background tab (falls back to the selected composer
    // only when no string is passed).
    await vscode.commands.executeCommand('composer.closeComposerTab', composerId);
    closedComposerIds.add(composerId);
    log(`Closed finished agent tab ${composerId} for ${name} (${state}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to close agent tab ${composerId} for ${name}: ${message}`);
  }

  try {
    await callTaskField(taskFolder, 'clearComposerId');
  } catch {
    // Best effort; lingering .composer-id on a finished task is harmless.
  }
}

async function tick(vscode) {
  if (tickInFlight) {
    return;
  }
  tickInFlight = true;
  try {
    const connection = loadConnection();
    if (!connection) {
      return;
    }

    const maxParallel = loadSettings().maxParallelTasks;
    const targets = uniqueProjectTargets(loadProjectRecords());

    let runningCount = 0;
    /** @type {Array<{ taskFolder: object, name: string }>} */
    const runnable = [];

    for (const target of targets) {
      let names = [];
      try {
        names = await listProjectTaskFolderNames(target, connection);
      } catch {
        continue;
      }

      for (const name of names) {
        const taskFolder = createTaskFolder(target, connection, name);
        const state = await readState(taskFolder);
        if (state === 'running') {
          runningCount += 1;
        } else if (state === 'run') {
          runnable.push({ taskFolder, name });
        } else if (state === 'done' || state === 'fail') {
          await closeFinishedTab(vscode, taskFolder, name, state);
        }
      }
    }

    let freeSlots = maxParallel - runningCount;
    if (freeSlots <= 0 || runnable.length === 0) {
      return;
    }

    // Dispatch oldest first; folder names are timestamp-ordered.
    runnable.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const { processRunTask } = await import('./task-run-handler.mjs');
    for (const { taskFolder, name } of runnable) {
      if (freeSlots <= 0) {
        break;
      }
      log(
        `Auto-dispatching ${name} (running ${runningCount}, max ${maxParallel}, ` +
          `free ${freeSlots}).`,
      );
      let started = false;
      try {
        started = await processRunTask(taskFolder, { vscode });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Auto-dispatch failed for ${name}: ${message}`);
      }
      if (started) {
        freeSlots -= 1;
        runningCount += 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Orchestrator tick failed: ${message}`);
  } finally {
    tickInFlight = false;
  }
}

/**
 * Start the extension-host orchestrator that (1) auto-closes the agent tab of
 * any finished task and (2) keeps up to `maxParallelTasks` tasks running by
 * dispatching queued `run` tasks. Idempotent.
 *
 * @param {import('vscode')} vscode
 */
export function startTaskOrchestrator(vscode) {
  if (timer) {
    return;
  }
  timer = setInterval(() => {
    void tick(vscode);
  }, INTERVAL_MS);
  log(`Task orchestrator started (interval ${INTERVAL_MS}ms).`);
}

export function stopTaskOrchestrator() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log('Task orchestrator stopped.');
  }
}
