import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR_NAME, ICLOUD_CONTAINER_ID } from './constants.mjs';
import { sanitizePathSegment } from './sanitize.mjs';

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

function ensureLocalDirectory(absolutePath) {
  fs.mkdirSync(absolutePath, { recursive: true });
  return absolutePath;
}

function getICloudDriveRoot() {
  const mobileDocuments = path.join(
    os.homedir(),
    'Library',
    'Mobile Documents',
  );
  const containerFolder = ICLOUD_CONTAINER_ID.replace(/\./g, '~');
  const root = path.join(mobileDocuments, containerFolder, 'Documents');

  if (!fs.existsSync(root)) {
    throw new Error(
      'iCloud Drive is not available. Enable iCloud Drive in System Settings and open the RemoteCode mobile app once to initialize its iCloud container.',
    );
  }

  return root;
}

function findGoogleDriveRoot(accountEmail) {
  const cloudStorage = path.join(os.homedir(), 'Library', 'CloudStorage');
  if (!fs.existsSync(cloudStorage)) {
    return null;
  }

  const entries = fs.readdirSync(cloudStorage, { withFileTypes: true });
  const candidates = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name.toLowerCase().includes('google drive'));

  if (candidates.length === 0) {
    return null;
  }

  if (accountEmail) {
    const emailMatch = candidates.find(name =>
      name.toLowerCase().includes(accountEmail.toLowerCase()),
    );
    if (emailMatch) {
      return path.join(cloudStorage, emailMatch);
    }
  }

  return path.join(cloudStorage, candidates[0]);
}

async function driveApiRequest(connection, url, options = {}) {
  const accessToken = connection.accessToken;
  if (!accessToken) {
    throw new Error(
      `Google Drive API token missing. Set accessToken in ~/${CONFIG_DIR_NAME}/cloud-connection.json or install Google Drive for desktop.`,
    );
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Drive API error (${response.status}): ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function findDriveChildFolder(connection, parentId, folderName) {
  const query = [
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    `name='${folderName.replace(/'/g, "\\'")}'`,
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ].join(' and ');

  const result = await driveApiRequest(
    connection,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
  );

  return result.files?.[0] ?? null;
}

async function createDriveFolder(connection, parentId, folderName) {
  const existing = await findDriveChildFolder(connection, parentId, folderName);
  if (existing) {
    return existing.id;
  }

  const created = await driveApiRequest(connection, 'https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    body: JSON.stringify({
      name: folderName,
      mimeType: GOOGLE_FOLDER_MIME,
      parents: parentId ? [parentId] : ['root'],
    }),
  });

  return created.id;
}

async function ensureGoogleDriveApiPath(connection, relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  let parentId = null;

  for (const segment of segments) {
    parentId = await createDriveFolder(connection, parentId, segment);
  }

  return {
    provider: 'google_drive',
    mode: 'api',
    folderId: parentId,
    relativePath,
  };
}

function ensureFilesystemCloudPath(rootDir, relativePath) {
  const absolutePath = ensureLocalDirectory(path.join(rootDir, relativePath));
  return {
    provider: 'filesystem',
    absolutePath,
    relativePath,
  };
}

export async function ensureCloudFolder(connection, relativePath) {
  const safeRelativePath = relativePath
    .split(/[\\/]+/)
    .map(segment => sanitizePathSegment(segment, 'folder'))
    .join('/');

  if (connection.provider === 'icloud') {
    const root = getICloudDriveRoot();
    return ensureFilesystemCloudPath(root, safeRelativePath);
  }

  if (connection.provider === 'google_drive') {
    const desktopRoot = findGoogleDriveRoot(connection.accountEmail);
    if (desktopRoot) {
      const myDrive = fs.existsSync(path.join(desktopRoot, 'My Drive'))
        ? path.join(desktopRoot, 'My Drive')
        : desktopRoot;
      return {
        ...ensureFilesystemCloudPath(myDrive, safeRelativePath),
        provider: 'google_drive',
        mode: 'desktop_sync',
      };
    }

    if (connection.accessToken) {
      return ensureGoogleDriveApiPath(connection, safeRelativePath);
    }

    throw new Error(
      `Google Drive is not available. Install Google Drive for desktop or add accessToken to ~/${CONFIG_DIR_NAME}/cloud-connection.json.`,
    );
  }

  throw new Error(`Unsupported cloud provider: ${connection.provider}`);
}

async function listDriveChildFolders(connection, parentId) {
  const query = [
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ].join(' and ');

  const result = await driveApiRequest(
    connection,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
  );

  return (result.files ?? []).map(file => ({
    folderId: file.id,
    name: file.name,
  }));
}

async function deleteDriveFolder(connection, folderId) {
  await driveApiRequest(
    connection,
    `https://www.googleapis.com/drive/v3/files/${folderId}`,
    { method: 'DELETE' },
  );
}

/**
 * Recursively delete a cloud folder (filesystem or Drive API).
 *
 * @param {object} connection
 * @param {{ absolutePath?: string, folderId?: string }} cloud
 */
export async function deleteCloudFolder(connection, cloud) {
  if (cloud.absolutePath && fs.existsSync(cloud.absolutePath)) {
    fs.rmSync(cloud.absolutePath, { recursive: true, force: true });
    return;
  }

  if (cloud.folderId && connection.provider === 'google_drive' && connection.accessToken) {
    await deleteDriveFolder(connection, cloud.folderId);
  }
}

export { listDriveChildFolders };
