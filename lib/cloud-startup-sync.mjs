import { LOG_PREFIX } from './constants.mjs';
import { loadConnection } from './cloud-connection-store.mjs';
import { provisionWorkspaceCloudFolder } from './cloud-folder-status.mjs';
import { updateMachineAccountFile } from './machine-account.mjs';

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

async function provisionKnownWorkspaceFolders(workspaceRoots) {
  const connection = loadConnection();
  if (!connection) {
    return { skipped: true, reason: 'not_authenticated', workspaces: [] };
  }

  const roots = new Set();

  for (const root of workspaceRoots ?? []) {
    if (typeof root === 'string' && root.trim()) {
      roots.add(root.trim());
    }
  }

  const workspaces = [];

  for (const root of roots) {
    const created = await provisionWorkspaceCloudFolder([root]);
    workspaces.push({
      workspaceRoot: root,
      relativePath: created.relativePath,
    });
  }

  return {
    skipped: false,
    workspaces,
  };
}

/**
 * Ensure project-level cloud folders exist for open workspaces.
 *
 * @param {string[] | undefined} workspaceRoots
 */
export async function syncProjectCloudFolders(workspaceRoots) {
  const connection = loadConnection();
  if (!connection) {
    return { skipped: true, reason: 'not_authenticated' };
  }

  const workspaces = await provisionKnownWorkspaceFolders(workspaceRoots);
  return {
    skipped: false,
    provisionedProjects: workspaces.workspaces?.length ?? 0,
  };
}

/**
 * Run after cloud connection is available: provision project folders for open
 * workspaces and write machine account.json usage.
 *
 * @param {string[] | undefined} workspaceRoots
 */
export async function syncCloudOnStartup(workspaceRoots, options = {}) {
  const connection = loadConnection();
  if (!connection) {
    return { skipped: true, reason: 'not_authenticated' };
  }

  log('Syncing cloud storage for open workspace project folders.');

  const workspaces = await provisionKnownWorkspaceFolders(workspaceRoots);
  const account = options.skipAccountUpdate
    ? null
    : await updateMachineAccountFile();

  log(
    `Cloud startup sync complete: ${workspaces.workspaces?.length ?? 0} project folder(s)` +
      (account ? ', account.json updated.' : '.'),
  );

  return {
    skipped: false,
    provisionedProjects: workspaces.workspaces?.length ?? 0,
    workspaces: workspaces.workspaces ?? [],
    account,
  };
}
