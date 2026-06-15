import os from 'node:os';
import path from 'node:path';
import { APP_NAME } from './constants.mjs';
import { sanitizePathSegment } from './sanitize.mjs';

function joinCloudPath(...segments) {
  return segments.filter(Boolean).join('/');
}

export function getMachineName() {
  return sanitizePathSegment(os.hostname(), 'unknown-machine');
}

export function getProjectFolder(workspaceRoots) {
  const root =
    Array.isArray(workspaceRoots) && workspaceRoots.length > 0
      ? workspaceRoots[0]
      : process.cwd();

  return sanitizePathSegment(path.basename(root), 'workspace');
}

export function buildRelativeProjectPath({ machineName, projectFolder }) {
  return joinCloudPath(
    sanitizePathSegment(APP_NAME, APP_NAME),
    machineName,
    projectFolder,
  );
}

export function buildProjectFolderPath(hookInput) {
  const machineName = getMachineName();
  const projectFolder = getProjectFolder(hookInput.workspace_roots);
  const relativePath = buildRelativeProjectPath({
    machineName,
    projectFolder,
  });

  return {
    machineName,
    projectFolder,
    relativePath,
  };
}
