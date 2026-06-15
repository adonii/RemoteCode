import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './cloud-connection-store.mjs';
import { LOG_PREFIX } from './constants.mjs';
import { filterRecentLogEntries } from './debug-log-filter.mjs';

export const API_DEBUG_LOG_PATH = path.join(CONFIG_DIR, 'api-debug-log.json');
export const TASK_DEBUG_CONTEXT_PATH = path.join(CONFIG_DIR, 'task-debug-context.json');

const MAX_ENTRIES = 150;
const MAX_BODY_CHARS = 4096;
const CONTEXT_STALE_MS = 30_000;

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function truncate(value) {
  if (value == null) {
    return value;
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_BODY_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_BODY_CHARS)}… [truncated ${text.length - MAX_BODY_CHARS} chars]`;
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return headers;
  }

  const copy = { ...headers };
  for (const key of Object.keys(copy)) {
    if (/authorization|token|cookie|secret/i.test(key)) {
      copy[key] = '[redacted]';
    }
  }

  return copy;
}

function readStore() {
  if (!fs.existsSync(API_DEBUG_LOG_PATH)) {
    return { entries: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(API_DEBUG_LOG_PATH, 'utf8'));
    if (Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch {
    // Ignore corrupt log files.
  }

  return { entries: [] };
}

function writeStore(store) {
  ensureConfigDir();
  const tempPath = `${API_DEBUG_LOG_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, API_DEBUG_LOG_PATH);
}

function appendEntry(entry) {
  const store = readStore();
  store.entries.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...entry,
  });

  if (store.entries.length > MAX_ENTRIES) {
    store.entries.length = MAX_ENTRIES;
  }

  writeStore(store);
}

function log(message) {
  process.stderr.write(`${LOG_PREFIX} [api-debug] ${message}\n`);
}

export function writeTaskDebugContext(context) {
  ensureConfigDir();
  fs.writeFileSync(
    TASK_DEBUG_CONTEXT_PATH,
    `${JSON.stringify({ ...context, updatedAt: Date.now() }, null, 2)}\n`,
    'utf8',
  );
}

export function isApiDebugActive() {
  if (!fs.existsSync(TASK_DEBUG_CONTEXT_PATH)) {
    return false;
  }

  try {
    const context = JSON.parse(fs.readFileSync(TASK_DEBUG_CONTEXT_PATH, 'utf8'));
    if (Date.now() - (context.updatedAt ?? 0) > CONTEXT_STALE_MS) {
      return false;
    }

    return (context.runningCount ?? 0) > 0 || (context.stoppingCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * @param {{ label?: string, method?: string, url?: string, requestBody?: unknown, requestHeaders?: Record<string, string>, responseStatus?: number, responseBody?: unknown, detail?: string }} entry
 */
export function logApiExchange(entry) {
  const record = {
    kind: 'http',
    label: entry.label ?? entry.url ?? 'HTTP request',
    method: entry.method ?? 'GET',
    url: entry.url ?? '',
    requestBody: truncate(entry.requestBody),
    requestHeaders: redactHeaders(entry.requestHeaders),
    responseStatus: entry.responseStatus ?? null,
    responseBody: truncate(entry.responseBody),
    detail: entry.detail ?? null,
  };

  appendEntry(record);

  if (isApiDebugActive()) {
    const status = record.responseStatus ?? 'pending';
    log(
      `${record.method} ${record.url} -> ${status}` +
        (record.responseBody ? ` (${String(record.responseBody).length} chars)` : ''),
    );
  }
}

/**
 * @param {{ label: string, detail?: string, data?: unknown }} entry
 */
export function logDebugStep(entry) {
  const record = {
    kind: 'step',
    label: entry.label,
    detail: entry.detail ?? null,
    data: truncate(entry.data),
  };

  appendEntry(record);

  if (isApiDebugActive()) {
    log(`${entry.label}${entry.detail ? `: ${entry.detail}` : ''}`);
  }
}

export function listApiDebugLog(limit = 40) {
  return filterRecentLogEntries(readStore().entries, limit);
}

/**
 * Fetch wrapper that records request/response when API debug is active or forced.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {{ label?: string, forceLog?: boolean }} [meta]
 */
export async function loggedFetch(url, options = {}, meta = {}) {
  const method = options.method ?? 'GET';
  let requestBody = options.body;
  if (typeof requestBody === 'string') {
    try {
      requestBody = JSON.parse(requestBody);
    } catch {
      // Keep raw string bodies.
    }
  }

  const shouldLog = meta.forceLog || isApiDebugActive();
  const label = meta.label ?? url;

  const response = await fetch(url, options);
  const responseText = await response.text();

  if (shouldLog) {
    let responseBody = responseText;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Keep raw text bodies.
    }

    logApiExchange({
      label,
      method,
      url,
      requestBody,
      requestHeaders: options.headers,
      responseStatus: response.status,
      responseBody,
    });
  }

  return new Response(responseText, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
