import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR_NAME } from './constants.mjs';

export const CONFIG_DIR = path.join(os.homedir(), CONFIG_DIR_NAME);
export const CONFIG_PATH = path.join(CONFIG_DIR, 'cloud-connection.json');
export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
export const PROJECTS_DIR = path.join(CONFIG_DIR, 'projects');

export function loadConnection() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (
      (parsed.provider === 'icloud' || parsed.provider === 'google_drive') &&
      typeof parsed.accountEmail === 'string' &&
      parsed.accountEmail.length > 0
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export function saveConnection(connection) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(connection, null, 2)}\n`, 'utf8');
}

export function clearConnection() {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
}

export function loadSessionRecord(sessionId) {
  const sessionPath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(sessionPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveSessionRecord(sessionId, record) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const sessionPath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  fs.writeFileSync(sessionPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function updateSessionRecord(sessionId, patch) {
  const existing = loadSessionRecord(sessionId) ?? {};
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveSessionRecord(sessionId, next);
  return next;
}

export function deleteSessionRecord(sessionId) {
  const sessionPath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}

function projectRecordPath(projectKey) {
  return path.join(PROJECTS_DIR, `${projectKey.replace(/\//g, '_')}.json`);
}

export function loadProjectRecord(projectKey) {
  const recordPath = projectRecordPath(projectKey);
  if (!fs.existsSync(recordPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveProjectRecord(projectKey, record) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(projectRecordPath(projectKey), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function updateProjectRecord(projectKey, patch) {
  const existing = loadProjectRecord(projectKey) ?? {};
  const next = {
    ...existing,
    ...patch,
    projectKey,
    updatedAt: new Date().toISOString(),
  };
  saveProjectRecord(projectKey, next);
  return next;
}

export function loadProjectRecords() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(PROJECTS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
