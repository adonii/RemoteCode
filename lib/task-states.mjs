export const TASK_STATES = [
  'convert',
  'converting',
  'run',
  'running',
  'paused',
  'stop',
  'stopping',
  'stopped',
  'fail',
  'done',
];

export const TASK_STATE_FILE = '.state';

export function parseTaskState(content) {
  const trimmed = (content ?? '').trim();
  return TASK_STATES.includes(trimmed) ? trimmed : null;
}

const TASK_FOLDER_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

export function isTaskFolderName(folderName) {
  return TASK_FOLDER_NAME_PATTERN.test(folderName);
}

export function resolveRetryTaskState(options) {
  return options.hasAudio && !options.hasRequestText ? 'convert' : 'run';
}

export function resolveResumeTaskState(options) {
  if (options.wasPaused && options.hasRequestText) {
    return 'run';
  }

  return resolveRetryTaskState(options);
}
