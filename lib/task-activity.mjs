import path from 'node:path';
import { loadConnection, loadProjectRecords } from './cloud-connection-store.mjs';
import { getConversionMeta, listConversionProgress } from './conversion-progress.mjs';
import {
  createTaskFolder,
  getProjectTarget,
  listProjectTaskFolderNames,
  uniqueProjectTargets,
} from './project-targets.mjs';

const ACTIVE_STATES = new Set([
  'convert',
  'converting',
  'run',
  'running',
  'stop',
  'stopping',
  'stopped',
  'fail',
]);

function sortTaskFolderNames(folderNames) {
  return [...folderNames].sort((left, right) => left.localeCompare(right));
}

async function readTaskState(taskFolder) {
  const value = taskFolder.getState();
  return value instanceof Promise ? value : value;
}

function buildRemainingSteps(state, context) {
  switch (state) {
    case 'convert':
      return ['Transcribe audio', 'Queue task', 'Mark done'];
    case 'converting':
      return ['Finish transcription', 'Queue task', 'Mark done'];
    case 'run':
      return ['Wait for task execution', 'Mark done'];
    case 'running':
      if (context.pendingApproval) {
        return ['Wait for remote approval', 'Resume execution', 'Mark done'];
      }
      return ['Wait for task to finish', 'Mark done'];
    case 'stop':
    case 'stopping':
      return ['Stop task', 'Finalize task state'];
    case 'stopped':
      return ['Clear task lock', 'Ready for cleanup or retry'];
    default:
      return [];
  }
}

function describeRunningTask(project, taskFolderName) {
  const activeTaskFolderName = project.activeTaskFolderName;
  const isActive = activeTaskFolderName === taskFolderName;

  if (!isActive) {
    return {
      stage: 'Running',
      currentAction: 'Another task holds the project lock; waiting.',
    };
  }

  if (project.pendingApproval) {
    return {
      stage: 'Approval',
      currentAction: 'Waiting for remote approval before work can continue.',
      pendingApproval: true,
    };
  }

  if (project.stopAgentRequested) {
    return {
      stage: 'Stop requested',
      currentAction: 'Waiting for the task to stop.',
    };
  }

  return {
    stage: 'Running',
    currentAction: 'Task is active.',
  };
}

function describeTaskState(state, project, taskFolderName, conversionEntry) {
  switch (state) {
    case 'convert':
      return {
        stage: 'Audio queued',
        currentAction: 'Waiting for the task monitor to start transcription.',
      };
    case 'converting':
      return {
        stage: conversionEntry?.phase ?? 'Converting',
        currentAction: conversionEntry?.detail
          ? `${conversionEntry.detail}${conversionEntry.backend ? ` · ${conversionEntry.backend}` : ''}`
          : 'Transcribing audio to request.txt.',
      };
    case 'run':
      if (project.stopAgentRequested) {
        return {
          stage: 'Blocked',
          currentAction: 'Stop flag is set but no task is running — waiting for cleanup.',
        };
      }
      return {
        stage: 'Queued',
        currentAction: project.activeTaskFolderName
          ? 'Waiting for the active task to finish.'
          : 'Waiting for this task to start.',
      };
    case 'running':
      return describeRunningTask(project, taskFolderName);
    case 'paused':
      return {
        stage: 'Paused',
        currentAction: 'Task is waiting for input. See prompt.txt in the task folder.',
      };
    case 'stop':
      return {
        stage: 'Stop queued',
        currentAction: 'Stop request received; waiting for task to stop.',
      };
    case 'stopping':
      return {
        stage: 'Stopping',
        currentAction: 'Task stop in progress.',
      };
    case 'stopped':
      return {
        stage: 'Stopped',
        currentAction: 'Task was stopped before completion.',
      };
    case 'fail':
      return {
        stage: 'Failed',
        currentAction: 'Task failed. See fail.log in the task folder.',
      };
    default:
      return {
        stage: state ?? 'Unknown',
        currentAction: 'No activity details available.',
      };
  }
}

async function taskFolderHasFailLog(taskFolder) {
  const readResult = taskFolder.readFailLog?.();
  const content = readResult instanceof Promise ? await readResult : readResult;
  return typeof content === 'string' && content.trim().length > 0;
}

function previewFailLog(text, maxLength = 160) {
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

function previewRequestText(text, maxLength = 120) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength).trimEnd()}…`;
}

async function readTaskRequestInfo(taskFolder) {
  const readResult = taskFolder.readRequestText?.();
  const content = readResult instanceof Promise ? await readResult : readResult;
  if (typeof content !== 'string' || !content.trim()) {
    return { hasRequestText: false, requestPreview: null };
  }

  return {
    hasRequestText: true,
    requestPreview: previewRequestText(content),
  };
}

async function taskFolderHasRequestAudio(taskFolder) {
  const findResult = taskFolder.findRequestAudioPath?.();
  const audioPath = findResult instanceof Promise ? await findResult : findResult;
  return Boolean(audioPath);
}

/**
 * @param {{ lite?: boolean }} [options]
 */
export async function listTaskActivity(options = {}) {
  const lite = options.lite === true;
  const connection = loadConnection();
  if (!connection) {
    return [];
  }

  const records = loadProjectRecords();
  const conversionsById = new Map(listConversionProgress().map(entry => [entry.id, entry]));
  const activity = [];

  for (const project of records) {
    const target = getProjectTarget(project);
    if (!target) {
      continue;
    }

    let taskFolderNames = [];
    try {
      taskFolderNames = sortTaskFolderNames(await listProjectTaskFolderNames(target, connection));
    } catch {
      continue;
    }

    const folderStates = new Map();

    for (const taskFolderName of taskFolderNames) {
      const taskFolder = createTaskFolder(target, connection, taskFolderName);
      const state = await readTaskState(taskFolder);
      folderStates.set(taskFolderName, { taskFolder, state });
    }

    const runFolderNames = taskFolderNames.filter(
      taskFolderName => folderStates.get(taskFolderName)?.state === 'run',
    );
    const runningInProject = taskFolderNames.some(
      taskFolderName => folderStates.get(taskFolderName)?.state === 'running',
    );

    for (const taskFolderName of taskFolderNames) {
      const folderState = folderStates.get(taskFolderName);
      if (!folderState) {
        continue;
      }

      const { taskFolder, state } = folderState;
      if (!state || !ACTIVE_STATES.has(state)) {
        continue;
      }

      const conversionEntry = conversionsById.get(getConversionMeta(taskFolder).id);
      const description = describeTaskState(state, project, taskFolderName, conversionEntry);

      if (
        !lite &&
        (state === 'fail' || (state === 'stopped' && (await taskFolderHasFailLog(taskFolder))))
      ) {
        description.stage = 'Failed';
        description.currentAction = 'Task failed. See fail.log in the task folder.';
      }

      let queuedAfterCount = 0;
      let queueRank = 0;
      let isNextToRun = false;
      if (state === 'run') {
        const queueIndex = runFolderNames.indexOf(taskFolderName);
        queuedAfterCount = queueIndex >= 0 ? runFolderNames.length - queueIndex - 1 : 0;
        queueRank = queueIndex >= 0 ? queueIndex + 1 : 0;
        isNextToRun = queueIndex === 0 && !runningInProject;
      }

      const conversionMeta = getConversionMeta(taskFolder);
      const requestInfo = lite
        ? { hasRequestText: false, requestPreview: null }
        : await readTaskRequestInfo(taskFolder);
      const hasRequestAudio = lite ? false : await taskFolderHasRequestAudio(taskFolder);
      let failPreview = null;
      if (state === 'fail' || state === 'stopped') {
        const readResult = taskFolder.readFailLog?.();
        const failLog = readResult instanceof Promise ? await readResult : readResult;
        failPreview = previewFailLog(failLog);
      }

      activity.push({
        taskFolderName,
        projectKey: project.projectKey,
        projectFolder: project.projectFolder ?? path.basename(target.relativePath ?? project.projectKey),
        state,
        stage: description.stage,
        currentAction: description.currentAction,
        remainingSteps: buildRemainingSteps(state, description),
        queuedAfterCount,
        queueRank,
        isNextToRun,
        hasRequestText: requestInfo.hasRequestText,
        requestPreview: requestInfo.requestPreview,
        hasRequestAudio,
        conversionId: conversionMeta.id ?? null,
        failPreview,
      });
    }
  }

  const stateOrder = {
    running: 0,
    stopping: 1,
    stop: 2,
    converting: 3,
    convert: 4,
    run: 5,
    fail: 6,
    stopped: 7,
  };

  return activity.sort((left, right) => {
    const leftOrder = stateOrder[left.state] ?? 99;
    const rightOrder = stateOrder[right.state] ?? 99;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return left.taskFolderName.localeCompare(right.taskFolderName);
  });
}
