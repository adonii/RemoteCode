import path from 'node:path';
import { loadConnection, loadProjectRecords } from './cloud-connection-store.mjs';
import {
  createTaskFolder,
  listProjectTaskFolderNames,
  uniqueProjectTargets,
} from './project-targets.mjs';
import { TASK_STATE_FILE } from './task-states.mjs';
import { loadSettings } from './settings-store.mjs';
import { debugLog } from './debug-log.mjs';
import {
  invalidateICloudListCache,
  isICloudFilesystemConnection,
  refreshICloudPaths,
} from './icloud-storage.mjs';
import { readRunTaskSignal } from './run-task-signal.mjs';
import { prepareICloudTaskListing } from './task-watch-snapshot.mjs';
import { readTaskStateFromFolder } from './task-state-read.mjs';

function log(message) {
  debugLog('orchestrator', message);
}

const INTERVAL_MS = 3_000;

let timer = null;
let tickInFlight = false;
let lastRunSignalAt = 0;

// composerIds whose tabs we've already asked Cursor to close, so we don't spam
// the close command every tick while the folder still reports done/fail.
const closedComposerIds = new Set();

async function callTaskField(taskFolder, field, ...args) {
  const value = taskFolder[field]?.(...args);
  return value instanceof Promise ? await value : value;
}

async function readState(taskFolder, connection) {
  try {
    return await readTaskStateFromFolder(taskFolder, connection);
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
    const { syncTaskComposerAttachmentsWithRetry } = await import('./task-attached-files.mjs');
    const saved = await syncTaskComposerAttachmentsWithRetry(taskFolder, composerId, {
      maxAttempts: 10,
      delayMs: 2_000,
    });
    if (saved.length > 0) {
      log(`Saved ${saved.length} attachment(s) before closing tab for ${name}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Pre-close attachment sync failed for ${name}: ${message}`);
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

    const workspaceRoots =
      vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];

    const maxParallel = loadSettings().maxParallelTasks;
    const targets = uniqueProjectTargets(loadProjectRecords());
    if (targets.length === 0) {
      return;
    }

    invalidateICloudListCache();

    const runSignal = readRunTaskSignal();
    const urgentRunTask =
      runSignal !== null &&
      runSignal.at > lastRunSignalAt &&
      Date.now() - runSignal.at < 60_000;
    if (urgentRunTask) {
      lastRunSignalAt = runSignal.at;
      log(`Run task signal received for ${runSignal.path}; forcing fresh listing.`);
    }

    if (isICloudFilesystemConnection(connection)) {
      if (urgentRunTask && runSignal?.path) {
        const statePath = path.join(runSignal.path, TASK_STATE_FILE);
        await refreshICloudPaths([runSignal.path, statePath]);
      } else {
        const listingRoots = [
          ...new Set(
            loadProjectRecords()
              .map(record => record.workspaceRoot)
              .filter(Boolean),
          ),
        ];
        await prepareICloudTaskListing(
          listingRoots.length > 0 ? listingRoots : workspaceRoots,
          {
            forceICloudRefresh: false,
          },
        );
      }
    }

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
        let state = await readState(taskFolder, connection);
        if (
          state === null &&
          target.mode === 'filesystem' &&
          isICloudFilesystemConnection(connection)
        ) {
          await refreshICloudPaths([taskFolder.taskFolderPath]);
          state = await readState(taskFolder, connection);
        }
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
  void tick(vscode);
}

export function stopTaskOrchestrator() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log('Task orchestrator stopped.');
  }
}
