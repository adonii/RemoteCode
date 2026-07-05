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
const DEFAULT_SQLITE_MAX_BUFFER = 32 * 1024 * 1024;
const BUBBLE_VALUE_MAX_BUFFER = 8 * 1024 * 1024;

const GENERATE_IMAGE_TOOL_NAMES = new Set(['generate_image', 'generateimage']);

const CURSOR_PROJECTS_ROOT = path.join(os.homedir(), '.cursor', 'projects');

function dbExists() {
  return fs.existsSync(GLOBAL_STATE_DB_PATH);
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

async function runSqliteJsonAsync(sql, options = {}) {
  if (!dbExists()) {
    return [];
  }

  const maxBuffer = options.maxBuffer ?? DEFAULT_SQLITE_MAX_BUFFER;

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
        maxBuffer,
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
 * @typedef {{ fileName: string, absolutePath?: string, dataUri?: string, buffer?: Buffer }} ComposerAttachmentSource
 */

/**
 * @param {unknown} uri
 * @returns {string | null}
 */
function resolveUriPath(uri) {
  if (!uri || typeof uri !== 'object') {
    return null;
  }

  const record = /** @type {Record<string, unknown>} */ (uri);
  if (typeof record.fsPath === 'string' && record.fsPath) {
    return record.fsPath;
  }
  if (typeof record.path === 'string' && record.path) {
    return record.path;
  }
  if (typeof record.external === 'string' && record.external.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(record.external).pathname);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Resolve a generated-image filename or relative path under Cursor's per-project
 * assets folder (e.g. `~/.cursor/projects/<slug>/assets/foo.png`).
 *
 * @param {string} filePathOrName
 * @returns {string | null}
 */
function resolveCursorAssetPath(filePathOrName) {
  if (typeof filePathOrName !== 'string' || !filePathOrName.trim()) {
    return null;
  }

  const trimmed = filePathOrName.trim();
  if (path.isAbsolute(trimmed)) {
    return fs.existsSync(trimmed) ? trimmed : null;
  }

  const baseName = path.basename(trimmed);
  if (!baseName) {
    return null;
  }

  try {
    for (const projectDir of fs.readdirSync(CURSOR_PROJECTS_ROOT)) {
      const candidate = path.join(CURSOR_PROJECTS_ROOT, projectDir, 'assets', baseName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Cursor projects root may not exist yet.
  }

  return null;
}

/**
 * @param {Record<string, unknown>} toolFormerRecord
 * @returns {string | null}
 */
function resolveGenerateImageFilePath(toolFormerRecord) {
  const result = parseJsonObject(toolFormerRecord.result);
  const params = parseJsonObject(toolFormerRecord.params);
  const success = result ? parseJsonObject(result.success) : null;

  const candidates = [
    success?.filePath,
    result?.filePath,
    params?.filePath,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue;
    }

    const trimmed = candidate.trim();
    const absolutePath = path.isAbsolute(trimmed)
      ? trimmed
      : resolveCursorAssetPath(trimmed);
    if (absolutePath) {
      return absolutePath;
    }
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function resolveAttachmentPath(value) {
  if (typeof value === 'string' && value) {
    if (value.startsWith('file://')) {
      try {
        return decodeURIComponent(new URL(value).pathname);
      } catch {
        return null;
      }
    }
    if (path.isAbsolute(value)) {
      return value;
    }
    return null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.fsPath === 'string' && record.fsPath) {
    return record.fsPath;
  }
  if (typeof record.path === 'string' && record.path) {
    return record.path;
  }
  if (typeof record.src === 'string' && record.src.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(record.src).pathname);
    } catch {
      return null;
    }
  }
  if (record.uri) {
    return resolveUriPath(record.uri);
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function resolveDataUri(value) {
  if (typeof value === 'string' && value.startsWith('data:')) {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  for (const field of ['data', 'src', 'dataUri', 'url']) {
    const candidate = record[field];
    if (typeof candidate === 'string' && candidate.startsWith('data:')) {
      return candidate;
    }
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function resolvePreferredFileName(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  for (const field of ['name', 'fileName', 'filename', 'altText']) {
    const candidate = record[field];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

/**
 * @param {unknown} node
 * @param {Set<string>} srcs
 */
function collectLexicalImageSrcs(node, srcs) {
  if (!node || typeof node !== 'object') {
    return;
  }

  const record = /** @type {Record<string, unknown>} */ (node);
  if (record.type === 'image' && typeof record.src === 'string' && record.src) {
    srcs.add(record.src);
  }

  const children = record.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      collectLexicalImageSrcs(child, srcs);
    }
  }
}

/**
 * @param {unknown} richText
 * @param {Set<string>} srcs
 */
function collectRichTextImageSrcs(richText, srcs) {
  if (!richText) {
    return;
  }

  let parsed = richText;
  if (typeof richText === 'string') {
    try {
      parsed = JSON.parse(richText);
    } catch {
      return;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return;
  }

  const root = /** @type {Record<string, unknown>} */ (parsed).root ?? parsed;
  collectLexicalImageSrcs(root, srcs);
}

/**
 * @param {unknown} context
 * @param {ComposerAttachmentSource[]} out
 * @param {Set<string>} seen
 */
function collectFromContext(context, out, seen) {
  if (!context || typeof context !== 'object') {
    return;
  }

  const record = /** @type {Record<string, unknown>} */ (context);
  for (const field of ['fileSelections', 'selectedImages', 'terminalFiles']) {
    const entries = record[field];
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      collectAttachmentValue(entry, out, seen);
    }
  }
}

/**
 * @param {unknown} value
 * @param {ComposerAttachmentSource[]} out
 * @param {Set<string>} seen
 */
function collectAttachmentValue(value, out, seen) {
  const absolutePath = resolveAttachmentPath(value);
  if (absolutePath) {
    const dedupeKey = `path:${absolutePath}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      out.push({
        fileName: resolvePreferredFileName(value) ?? path.basename(absolutePath),
        absolutePath,
      });
    }
    return;
  }

  const dataUri = resolveDataUri(value);
  if (dataUri) {
    const dedupeKey = `data:${dataUri.slice(0, 120)}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      out.push({
        fileName: resolvePreferredFileName(value) ?? 'attachment',
        dataUri,
      });
    }
    return;
  }

  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      const dedupeKey = `data:${value.slice(0, 120)}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        out.push({ fileName: 'attachment', dataUri: value });
      }
      return;
    }

    const stringPath = resolveAttachmentPath(value);
    if (stringPath) {
      const dedupeKey = `path:${stringPath}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        out.push({
          fileName: path.basename(stringPath),
          absolutePath: stringPath,
        });
      }
    }
  }
}

/**
 * @param {unknown} bubble
 * @param {ComposerAttachmentSource[]} out
 * @param {Set<string>} seen
 */
/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function parseJsonObject(value) {
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object'
          ? /** @type {Record<string, unknown>} */ (parsed)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} bubble
 * @param {ComposerAttachmentSource[]} out
 * @param {Set<string>} seen
 */
function collectFromToolFormerData(bubble, out, seen) {
  if (!bubble || typeof bubble !== 'object') {
    return;
  }

  const toolFormerData = /** @type {Record<string, unknown>} */ (bubble).toolFormerData;
  if (!toolFormerData || typeof toolFormerData !== 'object') {
    return;
  }

  const record = /** @type {Record<string, unknown>} */ (toolFormerData);
  const toolName = typeof record.name === 'string' ? record.name.toLowerCase() : '';
  if (!GENERATE_IMAGE_TOOL_NAMES.has(toolName)) {
    return;
  }

  const filePath = resolveGenerateImageFilePath(record);
  if (!filePath) {
    return;
  }

  // Cursor can mark the composer completed before toolFormerData.status settles.
  if (record.status !== 'completed' && !fs.existsSync(filePath)) {
    return;
  }

  collectAttachmentValue(
    {
      path: filePath,
      fileName: path.basename(filePath),
    },
    out,
    seen,
  );
}

function collectFromBubble(bubble, out, seen) {
  if (!bubble || typeof bubble !== 'object') {
    return;
  }

  const record = /** @type {Record<string, unknown>} */ (bubble);
  collectFromContext(record.context, out, seen);
  collectFromToolFormerData(record, out, seen);

  const images = record.images;
  if (Array.isArray(images)) {
    for (const image of images) {
      collectAttachmentValue(image, out, seen);
    }
  }

  const richTextSrcs = new Set();
  collectRichTextImageSrcs(record.richText, richTextSrcs);
  for (const src of richTextSrcs) {
    collectAttachmentValue(src, out, seen);
  }
}

async function readComposerHeaderBlob(composerId) {
  const key = escapeSqlString(`composerData:${composerId}`);
  const rows = await runSqliteJsonAsync(
    `SELECT value FROM cursorDiskKV WHERE key='${key}' LIMIT 1;`,
  );
  if (rows.length === 0 || typeof rows[0].value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}

/**
 * Harvest completed generate_image tool results without loading full bubble
 * bodies (those blobs can be several MB each).
 *
 * @param {string} composerId
 * @param {ComposerAttachmentSource[]} out
 * @param {Set<string>} seen
 */
async function collectGenerateImageToolAttachments(composerId, out, seen) {
  const escapedComposerId = escapeSqlString(composerId);
  const rows = await runSqliteJsonAsync(
    `SELECT json_extract(value,'$.toolFormerData.result') AS result, ` +
      `json_extract(value,'$.toolFormerData.params') AS params, ` +
      `json_extract(value,'$.toolFormerData.status') AS status ` +
      `FROM cursorDiskKV ` +
      `WHERE key LIKE 'bubbleId:${escapedComposerId}:%' ` +
      `AND value LIKE '%"name":"generate_image"%';`,
  );

  for (const row of rows) {
    const filePath = resolveGenerateImageFilePath(
      /** @type {Record<string, unknown>} */ ({
        result: row.result,
        params: row.params,
        status: row.status,
      }),
    );
    if (!filePath) {
      continue;
    }

    if (row.status !== 'completed' && !fs.existsSync(filePath)) {
      continue;
    }

    collectAttachmentValue(
      {
        path: filePath,
        fileName: path.basename(filePath),
      },
      out,
      seen,
    );
  }
}

/**
 * List bubble keys that may contain non-generate_image attachments.
 *
 * @param {string} composerId
 * @returns {Promise<string[]>}
 */
async function listAttachmentBubbleKeys(composerId) {
  const escapedComposerId = escapeSqlString(composerId);
  const prefix = `bubbleId:${escapedComposerId}:%`;
  const queries = [
    `SELECT key FROM cursorDiskKV WHERE key LIKE '${prefix}' ` +
      `AND json_extract(value,'$.toolFormerData.name')='generate_image';`,
    `SELECT key FROM cursorDiskKV WHERE key LIKE '${prefix}' ` +
      `AND COALESCE(json_array_length(json_extract(value,'$.images')),0) > 0;`,
    `SELECT key FROM cursorDiskKV WHERE key LIKE '${prefix}' ` +
      `AND value LIKE '%data:image%';`,
    `SELECT key FROM cursorDiskKV WHERE key LIKE '${prefix}' AND (` +
      `COALESCE(json_array_length(json_extract(value,'$.context.fileSelections')),0) > 0 ` +
      `OR COALESCE(json_array_length(json_extract(value,'$.context.selectedImages')),0) > 0 ` +
      `OR COALESCE(json_array_length(json_extract(value,'$.context.terminalFiles')),0) > 0);`,
  ];

  const keys = new Set();
  for (const query of queries) {
    const rows = await runSqliteJsonAsync(query);
    for (const row of rows) {
      if (typeof row.key === 'string' && row.key) {
        keys.add(row.key);
      }
    }
  }

  return [...keys];
}

/**
 * @param {string} key
 * @returns {Promise<unknown | null>}
 */
async function readBubbleBlobByKey(key) {
  const rows = await runSqliteJsonAsync(
    `SELECT value FROM cursorDiskKV WHERE key='${escapeSqlString(key)}' LIMIT 1;`,
    { maxBuffer: BUBBLE_VALUE_MAX_BUFFER },
  );
  if (rows.length === 0 || typeof rows[0].value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}

/**
 * Read bubble blobs that may contain user attachments or inline images.
 *
 * `fullConversationHeadersOnly` omits many tool bubbles, so attachment
 * harvesting scans bubble keys directly.
 *
 * @param {string} composerId
 * @returns {Promise<unknown[]>}
 */
async function readAttachmentBubbleBlobs(composerId) {
  const keys = await listAttachmentBubbleKeys(composerId);
  const blobs = [];

  for (const key of keys) {
    const blob = await readBubbleBlobByKey(key);
    if (blob) {
      blobs.push(blob);
    }
  }

  return blobs;
}

/**
 * Collect images and file attachments from a composer's chat window (composer
 * context, user message bubbles, and assistant bubbles including generate_image
 * tool results).
 *
 * @param {string} composerId
 * @returns {Promise<ComposerAttachmentSource[]>}
 */
export async function readComposerAttachmentsAsync(composerId) {
  if (!composerId) {
    return [];
  }

  /** @type {ComposerAttachmentSource[]} */
  const attachments = [];
  const seen = new Set();

  const composerBlob = await readComposerHeaderBlob(composerId);
  if (composerBlob) {
    collectFromContext(composerBlob.context, attachments, seen);
    const richTextSrcs = new Set();
    collectRichTextImageSrcs(composerBlob.richText, richTextSrcs);
    for (const src of richTextSrcs) {
      collectAttachmentValue(src, attachments, seen);
    }
  }

  await collectGenerateImageToolAttachments(composerId, attachments, seen);

  const bubbles = await readAttachmentBubbleBlobs(composerId);
  for (const bubble of bubbles) {
    collectFromBubble(bubble, attachments, seen);
  }

  return attachments;
}
