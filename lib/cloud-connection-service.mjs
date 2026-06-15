import { spawn } from 'node:child_process';
import {
  clearConnection,
  loadConnection,
  saveConnection,
} from './cloud-connection-store.mjs';
import { invalidateCloudFolderStatusCache } from './cloud-folder-status.mjs';

/** @returns {Promise<boolean>} */
export async function checkMacICloudSignedIn() {
  if (process.platform !== 'darwin') {
    return false;
  }

  return new Promise(resolve => {
    const child = spawn('swift', [
      '-e',
      `
      import Foundation
      print(FileManager.default.ubiquityIdentityToken != nil ? "yes" : "no")
    `,
    ]);
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.on('close', () => resolve(stdout.trim() === 'yes'));
  });
}

/** @returns {{ connected: false } | { connected: true, provider: string, accountEmail: string, connectedAt: string, hasAccessToken: boolean }} */
export function getConnectionStatus() {
  const connection = loadConnection();
  if (!connection) {
    return { connected: false };
  }

  const { accessToken, ...safeConnection } = connection;
  return {
    connected: true,
    ...safeConnection,
    hasAccessToken: Boolean(accessToken),
  };
}

/**
 * @param {string} accountEmail
 */
export async function connectICloud(accountEmail) {
  if (loadConnection()) {
    throw new Error('Log out before connecting a different cloud account.');
  }

  const label = accountEmail.trim();
  if (!label) {
    throw new Error('An account label is required.');
  }

  const signedIn = await checkMacICloudSignedIn();
  if (!signedIn) {
    throw new Error(
      'iCloud is not available. Sign in to iCloud in macOS System Settings first.',
    );
  }

  saveConnection({
    provider: 'icloud',
    accountEmail: label,
    connectedAt: new Date().toISOString(),
  });
  invalidateCloudFolderStatusCache();
}

/**
 * @param {string} accountEmail
 * @param {string} [accessToken]
 */
export async function connectGoogleDrive(accountEmail, accessToken) {
  if (loadConnection()) {
    throw new Error('Log out before connecting a different cloud account.');
  }

  const email = accountEmail.trim();
  if (!email) {
    throw new Error('Google account email is required.');
  }

  /** @type {{ provider: 'google_drive', accountEmail: string, connectedAt: string, accessToken?: string }} */
  const connection = {
    provider: 'google_drive',
    accountEmail: email,
    connectedAt: new Date().toISOString(),
  };

  const token = accessToken?.trim();
  if (token) {
    connection.accessToken = token;
  }

  saveConnection(connection);
  invalidateCloudFolderStatusCache();
}

export function logout() {
  clearConnection();
  invalidateCloudFolderStatusCache();
}

/** @param {'icloud' | 'google_drive'} provider */
export function providerLabel(provider) {
  return provider === 'icloud' ? 'iCloud' : 'Google Drive';
}

export {
  getCloudFolderStatus,
  provisionWorkspaceCloudFolder,
} from './cloud-folder-status.mjs';

export { syncCloudOnStartup, syncProjectCloudFolders } from './cloud-startup-sync.mjs';
