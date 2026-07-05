import fs from 'node:fs';
import path from 'node:path';
import { readComposerAttachmentsAsync } from './composer-attachments.mjs';
import { debugLog } from './debug-log.mjs';

function log(message) {
  debugLog('attachments', message);
}

const MIME_EXTENSION = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function sanitizeFileName(fileName) {
  const base = path.basename(String(fileName || 'attachment'));
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return cleaned || 'attachment';
}

function extensionForMimeType(mimeType) {
  return MIME_EXTENSION[mimeType] ?? '';
}

/**
 * @param {string} dataUri
 * @returns {{ buffer: Buffer, mimeType: string, extension: string } | null}
 */
function decodeDataUri(dataUri) {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(dataUri);
  if (!match) {
    return null;
  }

  const mimeType = match[1] || 'application/octet-stream';
  const payload = match[2];
  const buffer = dataUri.includes(';base64,')
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');

  return {
    buffer,
    mimeType,
    extension: extensionForMimeType(mimeType),
  };
}

/**
 * @param {import('./composer-attachments.mjs').ComposerAttachmentSource} source
 * @returns {string | null}
 */
function sourceDedupeKey(source) {
  if (source.absolutePath) {
    return `path:${source.absolutePath}`;
  }
  if (source.dataUri) {
    return `data:${source.dataUri.slice(0, 200)}`;
  }
  if (source.buffer) {
    return `buffer:${source.fileName}:${source.buffer.length}`;
  }
  return null;
}

function describeSource(source) {
  if (source.absolutePath) {
    return source.absolutePath;
  }
  if (source.dataUri) {
    return `${source.fileName || 'attachment'} (inline data)`;
  }
  return source.fileName || 'attachment';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readSavedSourceKeys(taskFolder) {
  const value = taskFolder.readSavedAttachmentSources?.();
  const raw = value instanceof Promise ? await value : value;
  if (typeof raw !== 'string' || !raw.trim()) {
    return new Set();
  }

  return new Set(
    raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  );
}

async function writeSavedSourceKeys(taskFolder, keys) {
  const body = `${[...keys].sort().join('\n')}\n`;
  const value = taskFolder.writeSavedAttachmentSources?.(body);
  if (value instanceof Promise) {
    await value;
  }
}

/**
 * @param {import('./composer-attachments.mjs').ComposerAttachmentSource} source
 * @returns {{ buffer: Buffer, fileName: string } | null}
 */
function resolveAttachmentBuffer(source) {
  if (source.buffer) {
    return {
      buffer: source.buffer,
      fileName: sanitizeFileName(source.fileName),
    };
  }

  if (source.dataUri) {
    const decoded = decodeDataUri(source.dataUri);
    if (!decoded) {
      return null;
    }

    let fileName = sanitizeFileName(source.fileName);
    if (!path.extname(fileName) && decoded.extension) {
      fileName = `${fileName}${decoded.extension}`;
    }

    return { buffer: decoded.buffer, fileName };
  }

  if (source.absolutePath) {
    if (!fs.existsSync(source.absolutePath)) {
      log(`Chat attachment path missing: ${source.absolutePath}`);
      return null;
    }

    const stat = fs.statSync(source.absolutePath);
    if (!stat.isFile()) {
      return null;
    }

    return {
      buffer: fs.readFileSync(source.absolutePath),
      fileName: sanitizeFileName(source.fileName || path.basename(source.absolutePath)),
    };
  }

  return null;
}

async function listExistingAttachedNames(taskFolder) {
  const value = taskFolder.listAttachedFileNames?.();
  const names = value instanceof Promise ? await value : value;
  return Array.isArray(names) ? names : [];
}

function chooseUniqueFileName(existingNames, desiredName) {
  const taken = new Set(existingNames);
  if (!taken.has(desiredName)) {
    return desiredName;
  }

  const ext = path.extname(desiredName);
  const stem = ext ? desiredName.slice(0, -ext.length) : desiredName;
  let index = 2;
  while (taken.has(`${stem}-${index}${ext}`)) {
    index += 1;
  }

  return `${stem}-${index}${ext}`;
}

async function getActiveComposerId(vscode) {
  try {
    const ids = await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds');
    if (Array.isArray(ids) && ids.length > 0) {
      const first = ids[0];
      if (typeof first === 'string') {
        return first;
      }
      if (first && typeof first.composerId === 'string') {
        return first.composerId;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Could not read active composer id: ${message}`);
  }
  return null;
}

async function writeAttachedFile(taskFolder, fileName, buffer) {
  const value = taskFolder.writeAttachedFile?.(fileName, buffer);
  if (value instanceof Promise) {
    await value;
  }
}

/**
 * Copy images and files from a composer's chat window into the task folder's
 * `attached_files` subfolder.
 *
 * @param {object} taskFolder
 * @param {string} composerId
 * @returns {Promise<string[]>} saved file names
 */
export async function uploadComposerAttachmentsToTask(taskFolder, composerId) {
  if (!composerId) {
    return [];
  }

  const sources = await readComposerAttachmentsAsync(composerId);
  if (sources.length === 0) {
    return [];
  }

  const existingNames = await listExistingAttachedNames(taskFolder);
  const savedSourceKeys = await readSavedSourceKeys(taskFolder);
  /** @type {string[]} */
  const saved = [];

  for (const source of sources) {
    const dedupeKey = sourceDedupeKey(source);
    if (dedupeKey && savedSourceKeys.has(dedupeKey)) {
      continue;
    }

    const resolved = resolveAttachmentBuffer(source);
    if (!resolved) {
      log(
        `Chat attachment not ready for composer ${composerId}: ${describeSource(source)}.`,
      );
      continue;
    }

    const fileName = chooseUniqueFileName([...existingNames, ...saved], resolved.fileName);
    await writeAttachedFile(taskFolder, fileName, resolved.buffer);
    saved.push(fileName);
    if (dedupeKey) {
      savedSourceKeys.add(dedupeKey);
    }
    log(`Saved chat attachment ${fileName} for composer ${composerId}.`);
  }

  if (savedSourceKeys.size > 0) {
    await writeSavedSourceKeys(taskFolder, savedSourceKeys);
  }

  if (saved.length > 0) {
    log(`Uploaded ${saved.length} chat attachment(s) to attached_files.`);
  }

  return saved;
}

/**
 * Copy images and files from a task's tracked composer into attached_files.
 *
 * @param {object} taskFolder
 * @param {string} composerId
 * @returns {Promise<string[]>}
 */
export async function syncTaskComposerAttachments(taskFolder, composerId) {
  if (!composerId) {
    return [];
  }

  try {
    return await uploadComposerAttachmentsToTask(taskFolder, composerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Attachment sync skipped for composer ${composerId}: ${message}`);
    return [];
  }
}

/**
 * List composer attachments that are visible in Cursor state but not yet copied
 * into the task folder.
 *
 * @param {object} taskFolder
 * @param {string} composerId
 * @returns {Promise<import('./composer-attachments.mjs').ComposerAttachmentSource[]>}
 */
export async function listUnresolvedComposerAttachments(taskFolder, composerId) {
  if (!composerId) {
    return [];
  }

  const sources = await readComposerAttachmentsAsync(composerId);
  if (sources.length === 0) {
    return [];
  }

  const savedSourceKeys = await readSavedSourceKeys(taskFolder);
  /** @type {import('./composer-attachments.mjs').ComposerAttachmentSource[]} */
  const unresolved = [];

  for (const source of sources) {
    const dedupeKey = sourceDedupeKey(source);
    if (dedupeKey && savedSourceKeys.has(dedupeKey)) {
      continue;
    }

    const resolved = resolveAttachmentBuffer(source);
    if (!resolved) {
      unresolved.push(source);
    }
  }

  return unresolved;
}

/**
 * Retry attachment sync until assets are saved, confirmed absent, or the retry
 * budget is exhausted. Used before closing the agent tab so ephemeral Cursor
 * asset files are copied into the task folder first.
 *
 * @param {object} taskFolder
 * @param {string} composerId
 * @param {{ maxAttempts?: number, delayMs?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function syncTaskComposerAttachmentsWithRetry(
  taskFolder,
  composerId,
  options = {},
) {
  if (!composerId) {
    return [];
  }

  const maxAttempts = options.maxAttempts ?? 6;
  const delayMs = options.delayMs ?? 1_500;
  /** @type {string[]} */
  const allSaved = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const saved = await syncTaskComposerAttachments(taskFolder, composerId);
    allSaved.push(...saved);

    let unresolved = [];
    try {
      unresolved = await listUnresolvedComposerAttachments(taskFolder, composerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Attachment readiness check failed for composer ${composerId}: ${message}`);
    }

    if (unresolved.length === 0) {
      return allSaved;
    }

    if (attempt < maxAttempts) {
      log(
        `Waiting for ${unresolved.length} attachment(s) on composer ${composerId} ` +
          `(attempt ${attempt}/${maxAttempts}): ` +
          `${unresolved.map(describeSource).join(', ')}.`,
      );
      await sleep(delayMs);
      continue;
    }

    log(
      `Could not save ${unresolved.length} attachment(s) before giving up on composer ` +
        `${composerId}: ${unresolved.map(describeSource).join(', ')}.`,
    );
  }

  return allSaved;
}

/**
 * Copy images and files from the active Cursor chat tab into the task folder's
 * `attached_files` subfolder.
 *
 * @param {import('vscode')} vscode
 * @param {object} taskFolder
 * @returns {Promise<string[]>} saved file names
 */
export async function uploadActiveComposerAttachmentsToTask(vscode, taskFolder) {
  const composerId = await getActiveComposerId(vscode);
  if (!composerId) {
    return [];
  }

  return uploadComposerAttachmentsToTask(taskFolder, composerId);
}
