import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readCursorAccessToken } from './cursor-auth.mjs';
import { buildCursorRequestHeaders } from './cursor-auth.mjs';

const execFileAsync = promisify(execFile);

const CURSOR_TRANSCRIBE_URL =
  'https://api2.cursor.sh/aiserver.v1.AiService/TranscribeAudio';
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

const MIME_BY_EXTENSION = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.webm': 'audio/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/mp4',
};

/** Cursor accepts webm (agent mic) and wav reliably; legacy iOS AAC/m4a may return 500. */
const CURSOR_NATIVE_MIME_TYPES = new Set(['audio/webm', 'audio/wav']);

export function isCursorSpeechToTextAvailable() {
  return Boolean(readCursorAccessToken());
}

export function resolveAudioMimeType(audioPath) {
  const extension = path.extname(audioPath).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? 'audio/mp4';
}

function needsConversionForCursor(audioPath) {
  return !CURSOR_NATIVE_MIME_TYPES.has(resolveAudioMimeType(audioPath));
}

async function convertAudioToWav(sourcePath) {
  const outputPath = path.join(
    os.tmpdir(),
    `remotecode-cursor-stt-${process.pid}-${Date.now()}.wav`,
  );

  if (process.platform === 'darwin') {
    await execFileAsync(
      'afconvert',
      [sourcePath, outputPath, '-d', 'LEI16', '-f', 'WAVE'],
      { timeout: 60_000 },
    );
    return outputPath;
  }

  await execFileAsync(
    'ffmpeg',
    ['-y', '-i', sourcePath, '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '1', outputPath],
    { timeout: 120_000 },
  );
  return outputPath;
}

/**
 * Legacy mobile uploads may still be AAC/m4a; convert those to WAV before upload.
 *
 * @param {string} audioPath
 * @returns {Promise<{ path: string, mimeType: string, cleanup: () => void }>}
 */
export async function prepareAudioForCursorTranscription(audioPath) {
  const mimeType = resolveAudioMimeType(audioPath);
  if (!needsConversionForCursor(audioPath)) {
    return {
      path: audioPath,
      mimeType,
      cleanup: () => {},
    };
  }

  const convertedPath = await convertAudioToWav(audioPath);
  return {
    path: convertedPath,
    mimeType: 'audio/wav',
    cleanup: () => {
      fs.rmSync(convertedPath, { force: true });
    },
  };
}

export function readCursorVoiceInputLanguage() {
  const settingsPath = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'settings.json',
  );

  if (!fs.existsSync(settingsPath)) {
    return DEFAULT_LANGUAGE;
  }

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const language = settings['cursor.voiceInputLanguage'] ?? settings.voiceInputLanguage;
    return typeof language === 'string' && language.trim()
      ? language.trim()
      : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Cursor transcription timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatCursorTranscriptionError(status, body) {
  if (status === 401 || status === 403) {
    return `Cursor transcription unauthorized (${status}). Sign in to Cursor and reload the extension.`;
  }

  let message = body;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.message === 'string') {
      message = parsed.message;
    }
  } catch {
    // Keep raw body.
  }

  return `Cursor transcription failed (${status}): ${message}`;
}

/**
 * Transcribe audio using the same Cursor API as the agent window microphone.
 *
 * @param {string} audioPath
 * @param {{ onProgress?: (update: { phase: string, percent: number }) => void, language?: string, timeoutMs?: number }} [options]
 */
export async function transcribeWithCursor(audioPath, options = {}) {
  const accessToken = readCursorAccessToken();
  if (!accessToken) {
    return null;
  }

  options.onProgress?.({ phase: 'uploading', percent: 25 });

  const prepared = await prepareAudioForCursorTranscription(audioPath);

  try {
    const audio = fs.readFileSync(prepared.path);
    const language = options.language ?? readCursorVoiceInputLanguage();

    options.onProgress?.({ phase: 'transcribing', percent: 55 });

    const response = await fetchWithTimeout(
      CURSOR_TRANSCRIBE_URL,
      {
        method: 'POST',
        headers: await buildCursorRequestHeaders(accessToken),
        body: JSON.stringify({
          audio: audio.toString('base64'),
          mimeType: prepared.mimeType,
          language,
        }),
      },
      options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    );

    const body = await response.text();

    if (!response.ok) {
      throw new Error(formatCursorTranscriptionError(response.status, body));
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error('Cursor transcription returned an invalid response.');
    }

    options.onProgress?.({ phase: 'complete', percent: 100 });

    return typeof payload.text === 'string' ? payload.text.trim() : '';
  } finally {
    prepared.cleanup();
  }
}
