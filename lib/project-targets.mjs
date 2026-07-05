import path from 'node:path';
import {
  createDriveApiTaskFolder,
  createFilesystemTaskFolder,
  listDriveApiChildFolderNames,
  listFilesystemChildFolderNames,
} from './cloud-files.mjs';
import { isICloudFilesystemConnection, listICloudChildFolderNames } from './icloud-storage.mjs';
import { isTaskFolderName } from './task-states.mjs';

export function getProjectTarget(projectRecord) {
  const cloud = projectRecord?.cloud;
  if (!cloud) {
    return null;
  }

  if (cloud.absolutePath) {
    return {
      mode: 'filesystem',
      absolutePath: cloud.absolutePath,
      relativePath: projectRecord.relativePath,
      projectKey: projectRecord.projectKey,
    };
  }

  if (cloud.folderId) {
    return {
      mode: 'drive_api',
      folderId: cloud.folderId,
      relativePath: projectRecord.relativePath,
      projectKey: projectRecord.projectKey,
    };
  }

  return null;
}

export function projectTargetKey(target) {
  return target.mode === 'filesystem' ? target.absolutePath : target.folderId;
}

export function createTaskFolder(target, connection, taskFolderName) {
  if (target.mode === 'filesystem') {
    return createFilesystemTaskFolder(path.join(target.absolutePath, taskFolderName));
  }

  return createDriveApiTaskFolder(connection, target.folderId, taskFolderName);
}

export async function listProjectTaskFolderNames(target, connection) {
  let folderNames;
  if (target.mode === 'filesystem') {
    if (isICloudFilesystemConnection(connection)) {
      folderNames = await listICloudChildFolderNames(target.absolutePath);
    } else {
      folderNames = listFilesystemChildFolderNames(target.absolutePath);
    }
  } else {
    folderNames = await listDriveApiChildFolderNames(connection, target.folderId);
  }

  return folderNames.filter(isTaskFolderName);
}

export function uniqueProjectTargets(projectRecords) {
  const targets = new Map();

  for (const record of projectRecords) {
    const target = getProjectTarget(record);
    if (!target) {
      continue;
    }

    targets.set(projectTargetKey(target), target);
  }

  return [...targets.values()];
}

export function allKnownWorkspaceRoots(projectRecords = loadProjectRecords()) {
  return [
    ...new Set(
      projectRecords
        .map(record => record.workspaceRoot)
        .filter(Boolean)
        .map(root => path.resolve(String(root))),
    ),
  ];
}

export function resolveScopedProjectTargets(projectRecords, workspaceRoots) {
  if (Array.isArray(workspaceRoots) && workspaceRoots.length > 0) {
    return resolveProjectTargets(projectRecords, workspaceRoots);
  }

  return uniqueProjectTargets(projectRecords);
}

export function filterProjectRecordsForWorkspace(projectRecords, workspaceRoots) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) {
    return [];
  }

  const normalizedRoots = new Set(workspaceRoots.map(root => path.resolve(String(root))));

  return projectRecords.filter(record => {
    if (!record.workspaceRoot) {
      return false;
    }

    return normalizedRoots.has(path.resolve(String(record.workspaceRoot)));
  });
}

export function resolveProjectRecords(projectRecords, workspaceRoots) {
  return filterProjectRecordsForWorkspace(projectRecords, workspaceRoots);
}

export function resolveProjectTargets(projectRecords, workspaceRoots) {
  return uniqueProjectTargets(resolveProjectRecords(projectRecords, workspaceRoots));
}
