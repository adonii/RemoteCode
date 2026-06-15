import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GLOBAL_STATE_DB_PATH = path.join(
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

const SQLITE_BUSY_TIMEOUT_MS = 1000;
const SQLITE_EXEC_TIMEOUT_MS = 8000;

// Bubble header types in fullConversationHeadersOnly.
const BUBBLE_TYPE_USER = 1;
const BUBBLE_TYPE_ASSISTANT = 2;

function dbExists() {
  return fs.existsSync(GLOBAL_STATE_DB_PATH);
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Run a read-only query and parse JSON rows. Uses -readonly so we never contend
 * with Cursor's writers on the shared state DB.
 *
 * @param {string} sql
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function runSqliteJsonAsync(sql) {
  if (!dbExists()) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync(
      SQLITE3_BIN,
      [
        '-readonly',
        '-json',
        '-cmd',
        `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`,
        GLOBAL_STATE_DB_PATH,
        sql,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: SQLITE_EXEC_TIMEOUT_MS,
      },
    );

    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    return JSON.parse(trimmed);
  } catch {
    return [];
  }
}

/**
 * Read the cheap, structural signals from a composer's data blob in one query:
 * the persisted status, how many bubbles are actively generating right now, the
 * conversation length, and the raw blob size. The last two form a "fingerprint"
 * the monitor uses to detect progress, since `status` on disk is unreliable for
 * background tabs (it lags and sits at a transient "aborted" early on).
 *
 * @param {string} composerId
 * @returns {Promise<{ status: string | null, generatingCount: number, headerCount: number, blobLen: number, present: boolean }>}
 */
export async function readComposerSignalsAsync(composerId) {
  const empty = {
    status: null,
    generatingCount: 0,
    headerCount: 0,
    blobLen: 0,
    present: false,
  };

  if (!composerId) {
    return empty;
  }

  const key = escapeSqlString(`composerData:${composerId}`);
  const rows = await runSqliteJsonAsync(
    `SELECT json_extract(value,'$.status') AS status, ` +
      `json_array_length(value,'$.generatingBubbleIds') AS gen, ` +
      `json_array_length(value,'$.fullConversationHeadersOnly') AS headers, ` +
      `length(value) AS blobLen ` +
      `FROM cursorDiskKV WHERE key='${key}' LIMIT 1;`,
  );

  if (rows.length === 0) {
    return empty;
  }

  const row = rows[0];
  return {
    status: typeof row.status === 'string' ? row.status : null,
    generatingCount: Number.isFinite(row.gen) ? Number(row.gen) : 0,
    headerCount: Number.isFinite(row.headers) ? Number(row.headers) : 0,
    blobLen: Number.isFinite(row.blobLen) ? Number(row.blobLen) : 0,
    present: true,
  };
}

/**
 * @param {string} composerId
 * @returns {Promise<Array<{ bubbleId: string, type: number }>>}
 */
async function readConversationHeadersAsync(composerId) {
  const key = escapeSqlString(`composerData:${composerId}`);
  const rows = await runSqliteJsonAsync(
    `SELECT json_extract(value,'$.fullConversationHeadersOnly') AS headers ` +
      `FROM cursorDiskKV WHERE key='${key}' LIMIT 1;`,
  );

  if (rows.length === 0 || typeof rows[0].headers !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(rows[0].headers);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Extract the assistant's visible response text for the latest turn (everything
 * after the last user message). Returns the joined text, or '' if none yet.
 *
 * @param {string} composerId
 * @returns {Promise<string>}
 */
export async function readComposerResponseTextAsync(composerId) {
  if (!composerId) {
    return '';
  }

  const headers = await readConversationHeadersAsync(composerId);
  if (headers.length === 0) {
    return '';
  }

  let lastUserIndex = -1;
  for (let i = headers.length - 1; i >= 0; i -= 1) {
    if (headers[i]?.type === BUBBLE_TYPE_USER) {
      lastUserIndex = i;
      break;
    }
  }

  const assistantBubbleIds = [];
  for (let i = lastUserIndex + 1; i < headers.length; i += 1) {
    const header = headers[i];
    if (header?.type === BUBBLE_TYPE_ASSISTANT && typeof header.bubbleId === 'string') {
      assistantBubbleIds.push(header.bubbleId);
    }
  }

  if (assistantBubbleIds.length === 0) {
    return '';
  }

  const inList = assistantBubbleIds
    .map(bubbleId => `'${escapeSqlString(`bubbleId:${composerId}:${bubbleId}`)}'`)
    .join(',');

  const rows = await runSqliteJsonAsync(
    `SELECT key, json_extract(value,'$.text') AS text FROM cursorDiskKV WHERE key IN (${inList});`,
  );

  /** @type {Map<string, string>} */
  const textByBubbleId = new Map();
  for (const row of rows) {
    if (typeof row.key !== 'string') {
      continue;
    }
    const bubbleId = row.key.slice(`bubbleId:${composerId}:`.length);
    const text = typeof row.text === 'string' ? row.text : '';
    textByBubbleId.set(bubbleId, text);
  }

  return assistantBubbleIds
    .map(bubbleId => textByBubbleId.get(bubbleId) ?? '')
    .filter(text => text.trim().length > 0)
    .join('\n\n')
    .trim();
}

/**
 * Read the full conversation (user + assistant turns, in order) of a composer as
 * plain text, optionally trimmed to the most recent `maxChars`. Used to carry an
 * open tab's context into a freshly dispatched task.
 *
 * @param {string} composerId
 * @param {{ maxChars?: number }} [options]
 * @returns {Promise<string>}
 */
export async function readComposerConversationTextAsync(composerId, options = {}) {
  if (!composerId) {
    return '';
  }

  const headers = await readConversationHeadersAsync(composerId);
  const turns = headers.filter(
    header =>
      (header?.type === BUBBLE_TYPE_USER || header?.type === BUBBLE_TYPE_ASSISTANT) &&
      typeof header.bubbleId === 'string',
  );
  if (turns.length === 0) {
    return '';
  }

  const inList = turns
    .map(header => `'${escapeSqlString(`bubbleId:${composerId}:${header.bubbleId}`)}'`)
    .join(',');

  const rows = await runSqliteJsonAsync(
    `SELECT key, json_extract(value,'$.text') AS text FROM cursorDiskKV WHERE key IN (${inList});`,
  );

  /** @type {Map<string, string>} */
  const textByBubbleId = new Map();
  for (const row of rows) {
    if (typeof row.key !== 'string') {
      continue;
    }
    const bubbleId = row.key.slice(`bubbleId:${composerId}:`.length);
    textByBubbleId.set(bubbleId, typeof row.text === 'string' ? row.text : '');
  }

  const lines = [];
  for (const header of turns) {
    const text = (textByBubbleId.get(header.bubbleId) ?? '').trim();
    if (!text) {
      continue;
    }
    const role = header.type === BUBBLE_TYPE_USER ? 'User' : 'Assistant';
    lines.push(`${role}: ${text}`);
  }

  let text = lines.join('\n\n');
  const maxChars = options.maxChars;
  if (typeof maxChars === 'number' && maxChars > 0 && text.length > maxChars) {
    // Keep the most recent content.
    text = `…\n\n${text.slice(text.length - maxChars)}`;
  }
  return text;
}

/**
 * Full progress snapshot for a tracked composer. `generating` here is derived
 * from the live `generatingBubbleIds` array (reliable), NOT from `status` (which
 * lags on disk for background tabs).
 *
 * @param {string} composerId
 * @returns {Promise<{ status: string | null, generating: boolean, generatingCount: number, headerCount: number, blobLen: number, present: boolean, responseText: string }>}
 */
export async function readComposerProgressAsync(composerId) {
  const signals = await readComposerSignalsAsync(composerId);
  const responseText = await readComposerResponseTextAsync(composerId);
  return {
    ...signals,
    generating: signals.generatingCount > 0,
    responseText,
  };
}
