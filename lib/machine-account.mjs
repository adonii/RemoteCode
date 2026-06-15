import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, LOG_PREFIX } from './constants.mjs';
import { loadConnection } from './cloud-connection-store.mjs';
import { getMachineName } from './cloud-path.mjs';
import { ensureCloudFolder } from './cloud-folders.mjs';
import { fetchCursorAccountBudget } from './cursor-budget.mjs';
import { sanitizePathSegment } from './sanitize.mjs';

export const MACHINE_ACCOUNT_FILE = 'account.json';

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function buildMachineRelativePath(machineName) {
  return [sanitizePathSegment(APP_NAME, APP_NAME), machineName].join('/');
}

async function driveApiRequest(connection, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
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

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response;
}

async function findDriveFileByName(connection, parentFolderId, fileName) {
  const query = [
    'trashed=false',
    `name='${fileName.replace(/'/g, "\\'")}'`,
    `'${parentFolderId}' in parents`,
  ].join(' and ');

  const result = await driveApiRequest(
    connection,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
  );

  return result.files?.[0]?.id ?? null;
}

async function writeDriveApiTextFile(connection, parentFolderId, fileName, text) {
  const existingId = await findDriveFileByName(connection, parentFolderId, fileName);
  if (existingId) {
    await driveApiRequest(
      connection,
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: text,
      },
    );
    return;
  }

  const created = await driveApiRequest(connection, 'https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: fileName,
      parents: [parentFolderId],
      mimeType: 'application/json',
    }),
  });

  await driveApiRequest(
    connection,
    `https://www.googleapis.com/upload/drive/v3/files/${created.id}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: text,
    },
  );
}

async function writeMachineAccountFile(connection, machineFolder, document) {
  const text = `${JSON.stringify(document, null, 2)}\n`;

  if (machineFolder.absolutePath) {
    const filePath = path.join(machineFolder.absolutePath, MACHINE_ACCOUNT_FILE);
    fs.writeFileSync(filePath, text, 'utf8');
    return filePath;
  }

  if (machineFolder.folderId) {
    await writeDriveApiTextFile(connection, machineFolder.folderId, MACHINE_ACCOUNT_FILE, text);
    return `${machineFolder.relativePath}/${MACHINE_ACCOUNT_FILE}`;
  }

  throw new Error('Machine folder location is missing absolutePath and folderId.');
}

export async function buildMachineAccountDocument() {
  const usage = await fetchCursorAccountBudget();

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    cursorAccount: {
      email: usage.email,
    },
    budget: usage.budget,
    onDemandUsage: usage.onDemandUsage,
    billingCycle: usage.billingCycle,
    usageError: usage.error,
  };
}

export async function updateMachineAccountFile() {
  const connection = loadConnection();
  if (!connection) {
    return { skipped: true, reason: 'not_authenticated' };
  }

  const machineName = getMachineName();
  const relativePath = buildMachineRelativePath(machineName);
  const machineFolder = await ensureCloudFolder(connection, relativePath);
  const document = await buildMachineAccountDocument();

  const target = await writeMachineAccountFile(connection, machineFolder, document);
  log(`Updated ${MACHINE_ACCOUNT_FILE} for ${relativePath}.`);

  if (document.budget === null) {
    log('Machine account budget unavailable; wrote account metadata only.');
  }

  return {
    skipped: false,
    relativePath,
    target,
    budget: document.budget,
  };
}
