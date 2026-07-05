import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_DIR } from './cloud-connection-store.mjs';

const execFileAsync = promisify(execFile);
const SECRETS_PATH = path.join(CONFIG_DIR, 'secrets.json');
const AUTH_CACHE_PATH = path.join(CONFIG_DIR, 'cursor-auth-cache.json');

const STATE_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Cursor',
  'User',
  'globalStorage',
  'state.vscdb',
);

const SQLITE3_BIN =
  process.platform === 'darwin'
    ? '/usr/bin/sqlite3'
    : process.platform === 'win32'
      ? 'sqlite3.exe'
      : 'sqlite3';

function normalizeStateValue(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function readStateValueFromCliSync(key) {
  if (!fs.existsSync(STATE_DB_PATH)) {
    return null;
  }

  try {
    const value = execFileSync(
      SQLITE3_BIN,
      [STATE_DB_PATH, `SELECT value FROM ItemTable WHERE key='${key.replace(/'/g, "''")}' LIMIT 1;`],
      { encoding: 'utf8' },
    );
    return normalizeStateValue(value);
  } catch {
    return null;
  }
}

async function readStateValueFromCliAsync(key) {
  if (!fs.existsSync(STATE_DB_PATH)) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      SQLITE3_BIN,
      [STATE_DB_PATH, `SELECT value FROM ItemTable WHERE key='${key.replace(/'/g, "''")}' LIMIT 1;`],
      { encoding: 'utf8' },
    );
    return normalizeStateValue(stdout);
  } catch {
    return null;
  }
}

async function readStateValueAsync(key) {
  return readStateValueFromCliAsync(key);
}

function readStateValueSync(key) {
  return readStateValueFromCliSync(key);
}

function readSecretsFile() {
  if (!fs.existsSync(SECRETS_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function readConfiguredCursorApiKey() {
  const fromEnv = process.env.CURSOR_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim();
  }

  const secrets = readSecretsFile();
  const fromFile = secrets?.cursorApiKey;
  if (typeof fromFile === 'string' && fromFile.trim()) {
    return fromFile.trim();
  }

  return null;
}

export function isLikelyCursorUserApiKey(value) {
  return typeof value === 'string' && value.startsWith('cursor_');
}

/**
 * User API key for @cursor/sdk (Dashboard → Integrations).
 * Does not fall back to the IDE session access token.
 */
export function readCursorUserApiKey() {
  const configured = readConfiguredCursorApiKey();
  if (!configured) {
    return null;
  }

  if (!isLikelyCursorUserApiKey(configured)) {
    return null;
  }

  return configured;
}

export async function readCursorUserApiKeyAsync() {
  return readCursorUserApiKey();
}

export function cursorAccessTokenSetupHint() {
  return 'Sign in to Cursor in the IDE. RemotePromptCode reads the session token from cursorAuth/accessToken.';
}

function readCursorAuthCacheRecord() {
  if (!fs.existsSync(AUTH_CACHE_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(AUTH_CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function readCursorAuthCacheToken() {
  const record = readCursorAuthCacheRecord();
  return normalizeStateValue(record?.accessToken);
}

export function writeCursorAuthCache(accessToken, email = null) {
  const normalized = normalizeStateValue(accessToken);
  if (!normalized) {
    return false;
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    AUTH_CACHE_PATH,
    `${JSON.stringify(
      {
        accessToken: normalized,
        email: normalizeStateValue(email),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return true;
}

/**
 * Read Cursor IDE auth from state.vscdb and persist it for subprocesses.
 */
export async function refreshCursorAuthCache() {
  const accessToken = await readStateValueFromCliAsync('cursorAuth/accessToken');
  const email = await readStateValueFromCliAsync('cursorAuth/cachedEmail');

  if (accessToken) {
    writeCursorAuthCache(accessToken, email);
  }

  return accessToken;
}

export function refreshCursorAuthCacheSync() {
  const accessToken = readStateValueFromCliSync('cursorAuth/accessToken');
  const email = readStateValueFromCliSync('cursorAuth/cachedEmail');

  if (accessToken) {
    writeCursorAuthCache(accessToken, email);
  }

  return accessToken;
}

export async function readCursorAccessTokenAsync() {
  return readCursorAuthCacheToken() ?? (await readStateValueAsync('cursorAuth/accessToken'));
}

export async function readCursorAccountEmailAsync() {
  const cached = readCursorAuthCacheRecord();
  if (cached?.email) {
    return cached.email;
  }

  return readStateValueAsync('cursorAuth/cachedEmail');
}

export function readCursorAccessToken() {
  return readCursorAuthCacheToken() ?? readStateValueSync('cursorAuth/accessToken');
}

export function readCursorAccountEmail() {
  const cached = readCursorAuthCacheRecord();
  if (cached?.email) {
    return cached.email;
  }

  return readStateValueSync('cursorAuth/cachedEmail');
}

/**
 * Cursor credential for API calls.
 * Priority: dashboard User API Key → IDE session access token.
 */
export function resolveCursorApiKeySync() {
  return readCursorUserApiKey() ?? readCursorAccessToken();
}

export async function resolveCursorApiKeyAsync() {
  return readCursorUserApiKeyAsync() ?? (await readCursorAccessTokenAsync());
}

export function isCursorApiKeyAvailableSync() {
  return Boolean(resolveCursorApiKeySync());
}

export async function isCursorApiKeyAvailableAsync() {
  return Boolean(await resolveCursorApiKeyAsync());
}

/** @type {Promise<string | null> | null} */
let clientVersionPromise = null;

async function readCursorClientVersionAsync() {
  if (process.platform !== 'darwin') {
    return null;
  }

  if (!clientVersionPromise) {
    clientVersionPromise = (async () => {
      try {
        const plistPath = '/Applications/Cursor.app/Contents/Info.plist';
        const { stdout } = await execFileAsync(
          '/usr/libexec/PlistBuddy',
          ['-c', 'Print CFBundleShortVersionString', plistPath],
          { encoding: 'utf8' },
        );
        return stdout.trim() || null;
      } catch {
        return null;
      }
    })();
  }

  return clientVersionPromise;
}

export async function buildCursorRequestHeaders(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    'x-cursor-client-type': 'ide',
    'x-cursor-client-device-type': 'desktop',
  };

  const clientVersion = await readCursorClientVersionAsync();
  if (clientVersion) {
    headers['x-cursor-client-version'] = clientVersion;
  }

  return headers;
}
