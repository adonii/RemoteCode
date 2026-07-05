import path from 'node:path';

/** @type {string[] | null} */
let subprocessWorkspaceRoots = null;

export function workspaceScopeKey(workspaceRoots) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) {
    return '';
  }

  return workspaceRoots.map(root => path.resolve(String(root))).join('\0');
}

/** @param {string[] | null | undefined} roots */
export function setWorkspaceRoots(roots) {
  subprocessWorkspaceRoots =
    Array.isArray(roots) && roots.length > 0 ? roots.map(root => String(root)) : null;
}

/** @returns {string[] | null} */
export function getWorkspaceRoots() {
  return subprocessWorkspaceRoots;
}

export function initWorkspaceScopeFromEnvironment() {
  const raw = process.env.REMOTECODE_WORKSPACE_ROOTS;
  if (!raw) {
    return;
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('REMOTECODE_WORKSPACE_ROOTS must be a JSON array.');
  }

  setWorkspaceRoots(parsed);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[] | null | undefined} roots
 */
export function withWorkspaceRootsEnv(env, roots) {
  const next = { ...env };
  if (Array.isArray(roots) && roots.length > 0) {
    next.REMOTECODE_WORKSPACE_ROOTS = JSON.stringify(roots);
  }
  return next;
}
