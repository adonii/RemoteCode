import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './cloud-connection-store.mjs';
import { getAudioDurationSeconds } from './speech-to-text.mjs';

export const CONVERSION_PROGRESS_PATH = path.join(CONFIG_DIR, 'conversion-progress.json');

const STALE_ENTRY_MS = 15 * 60 * 1000;
const FAILED_DISPLAY_MS = 60 * 1000;
const READ_RETRY_COUNT = 3;
const READ_RETRY_DELAY_MS = 25;

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function syncDelay(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait for short read retries after concurrent writes.
  }
}

function parseStore(raw) {
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed.items === 'object' && parsed.items !== null) {
    return parsed;
  }
  return { items: {} };
}

function readStoreSync() {
  if (!fs.existsSync(CONVERSION_PROGRESS_PATH)) {
    return { items: {} };
  }

  for (let attempt = 0; attempt < READ_RETRY_COUNT; attempt += 1) {
    try {
      return parseStore(fs.readFileSync(CONVERSION_PROGRESS_PATH, 'utf8'));
    } catch {
      if (attempt < READ_RETRY_COUNT - 1) {
        syncDelay(READ_RETRY_DELAY_MS);
      }
    }
  }

  return { items: {} };
}

function writeStore(store) {
  ensureConfigDir();
  const tempPath = `${CONVERSION_PROGRESS_PATH}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  fs.writeFileSync(tempPath, payload, 'utf8');
  fs.renameSync(tempPath, CONVERSION_PROGRESS_PATH);
}

function normalizeEntry(id, patch) {
  return {
    id,
    label: patch.label ?? id,
    detail: patch.detail ?? '',
    backend: patch.backend ?? '',
    phase: patch.phase ?? 'starting',
    percent: typeof patch.percent === 'number' ? Math.max(0, Math.min(100, patch.percent)) : 0,
    indeterminate: patch.indeterminate === true,
    error: typeof patch.error === 'string' ? patch.error : null,
    failedAt: typeof patch.failedAt === 'number' ? patch.failedAt : null,
    updatedAt: Date.now(),
  };
}

export function beginConversion(id, meta = {}) {
  const store = readStoreSync();
  store.items[id] = normalizeEntry(id, {
    label: meta.label ?? id,
    detail: meta.detail ?? '',
    backend: meta.backend ?? '',
    phase: 'starting',
    percent: 5,
    indeterminate: false,
  });
  writeStore(store);
}

export function updateConversion(id, patch) {
  const store = readStoreSync();
  const existing = store.items[id] ?? normalizeEntry(id, { label: id });
  store.items[id] = normalizeEntry(id, {
    ...existing,
    ...patch,
    label: patch.label ?? existing.label,
    detail: patch.detail ?? existing.detail,
    backend: patch.backend ?? existing.backend,
  });
  writeStore(store);
}

export function finishConversion(id) {
  const store = readStoreSync();
  const existing = store.items[id];
  if (existing) {
    store.items[id] = normalizeEntry(id, {
      ...existing,
      phase: 'complete',
      percent: 100,
      indeterminate: false,
      error: null,
      failedAt: null,
    });
    writeStore(store);
  }

  setTimeout(() => {
    const latest = readStoreSync();
    if (latest.items[id]?.phase === 'complete') {
      delete latest.items[id];
      writeStore(latest);
    }
  }, 2500).unref?.();
}

export function failConversion(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const store = readStoreSync();
  const existing = store.items[id] ?? normalizeEntry(id, { label: id });
  store.items[id] = normalizeEntry(id, {
    ...existing,
    phase: 'failed',
    percent: 100,
    indeterminate: false,
    error: message,
    failedAt: Date.now(),
  });
  writeStore(store);

  setTimeout(() => {
    const latest = readStoreSync();
    const entry = latest.items[id];
    if (entry?.phase === 'failed' && entry.failedAt === store.items[id].failedAt) {
      delete latest.items[id];
      writeStore(latest);
    }
  }, FAILED_DISPLAY_MS).unref?.();
}

export function listConversionProgress() {
  const store = readStoreSync();
  const now = Date.now();
  let changed = false;

  for (const [id, entry] of Object.entries(store.items)) {
    if (entry.phase === 'failed' && entry.failedAt) {
      if (now - entry.failedAt > FAILED_DISPLAY_MS) {
        delete store.items[id];
        changed = true;
      }
      continue;
    }

    if (entry.phase === 'complete') {
      if (now - (entry.updatedAt ?? 0) > 2500) {
        delete store.items[id];
        changed = true;
      }
      continue;
    }

    if (now - (entry.updatedAt ?? 0) > STALE_ENTRY_MS) {
      delete store.items[id];
      changed = true;
    }
  }

  if (changed) {
    writeStore(store);
  }

  return Object.values(store.items).sort((left, right) => {
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });
}

function mapTranscriptionPhase(phase) {
  switch (phase) {
    case 'uploading':
      return 'Uploading audio';
    case 'transcribing':
      return 'Transcribing';
    case 'processing':
      return 'Processing transcript';
    case 'complete':
      return 'Transcription complete';
    default:
      return phase;
  }
}

/**
 * @param {string} conversionId
 * @param {string} audioPath
 * @param {string} backendLabel
 * @param {() => Promise<string>} transcribeFn
 */
export async function runWithTranscriptionProgress(
  conversionId,
  audioPath,
  backendLabel,
  transcribeFn,
) {
  const startedAt = Date.now();
  const durationSeconds = await getAudioDurationSeconds(audioPath);
  const estimatedMs = durationSeconds
    ? Math.max(8000, Math.min(120_000, durationSeconds * 6000))
    : 45_000;

  updateConversion(conversionId, {
    backend: backendLabel,
    phase: 'transcribing',
    percent: 20,
    indeterminate: false,
  });

  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const ratio = Math.min(elapsed / estimatedMs, 0.95);
    const percent = Math.round(20 + ratio * 65);
    updateConversion(conversionId, {
      backend: backendLabel,
      phase: 'transcribing',
      percent,
      indeterminate: false,
    });
  }, 750);

  try {
    return await transcribeFn({
      onProgress: update => {
        const percent =
          typeof update.percent === 'number'
            ? Math.max(20, Math.min(95, update.percent))
            : 50;
        updateConversion(conversionId, {
          backend: backendLabel,
          phase: mapTranscriptionPhase(update.phase),
          percent,
          indeterminate: false,
        });
      },
    });
  } finally {
    clearInterval(timer);
  }
}

export function getConversionMeta(taskFolder) {
  if (taskFolder.mode === 'filesystem') {
    const taskFolderPath = taskFolder.taskFolderPath;
    const taskFolderName = path.basename(taskFolderPath);
    const projectFolderName = path.basename(path.dirname(taskFolderPath));

    return {
      id: taskFolderPath,
      label: taskFolderName,
      detail: projectFolderName,
    };
  }

  return {
    id: `drive:${taskFolder.taskFolderName}`,
    label: taskFolder.taskFolderName,
    detail: 'Google Drive',
  };
}
