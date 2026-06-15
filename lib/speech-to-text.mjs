import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { APP_SLUG } from './constants.mjs';
import { transcribeWithCursor } from './cursor-speech-to-text.mjs';
import { getOpenAiApiKey, resolveSpeechToTextBackend } from './openai-config.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

export { resolveSpeechToTextBackend };

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
      throw new Error(`Speech-to-text request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function getAudioDurationSeconds(audioPath) {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('afinfo', [audioPath], { timeout: 5000 });
      const match = stdout.match(/estimated duration:\s*([\d.]+)\s*sec/i);
      if (match) {
        return Number.parseFloat(match[1]);
      }
    } catch {
      // Fall through to ffprobe.
    }
  }

  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        audioPath,
      ],
      { timeout: 5000 },
    );
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

async function transcribeWithOpenAI(audioPath, { onProgress } = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    return null;
  }

  onProgress?.({ phase: 'uploading', percent: 25 });

  const buffer = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append('file', new Blob([buffer]), path.basename(audioPath));
  form.append('model', process.env.REMOTECODE_WHISPER_MODEL ?? 'whisper-1');
  form.append('response_format', 'json');

  onProgress?.({ phase: 'transcribing', percent: 45 });

  const durationSeconds = await getAudioDurationSeconds(audioPath);
  const timeoutMs = durationSeconds
    ? Math.max(30_000, Math.min(DEFAULT_FETCH_TIMEOUT_MS, durationSeconds * 15_000))
    : DEFAULT_FETCH_TIMEOUT_MS;

  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    },
    timeoutMs,
  );

  onProgress?.({ phase: 'processing', percent: 90 });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI transcription failed (${response.status}): ${body}`);
  }

  const result = await response.json();
  onProgress?.({ phase: 'complete', percent: 100 });
  return typeof result.text === 'string' ? result.text.trim() : '';
}

async function transcribeWithWhisperCli(audioPath, { onProgress } = {}) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-stt-`));
  const whisperBinary = process.env.REMOTECODE_WHISPER_BIN ?? 'whisper';

  try {
    onProgress?.({ phase: 'transcribing', percent: 30 });

    await execFileAsync(
      whisperBinary,
      [
        audioPath,
        '--model',
        process.env.REMOTECODE_WHISPER_CLI_MODEL ?? 'base',
        '--output_format',
        'txt',
        '--output_dir',
        outputDir,
      ],
      { timeout: 10 * 60 * 1000 },
    );

    onProgress?.({ phase: 'complete', percent: 100 });

    const baseName = path.basename(audioPath, path.extname(audioPath));
    const transcriptPath = path.join(outputDir, `${baseName}.txt`);
    if (!fs.existsSync(transcriptPath)) {
      throw new Error('Whisper CLI did not produce a transcript file.');
    }

    return fs.readFileSync(transcriptPath, 'utf8').trim();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

async function transcribeWithCustomCommand(audioPath, { onProgress } = {}) {
  const command = process.env.REMOTECODE_STT_COMMAND;
  if (!command) {
    return null;
  }

  onProgress?.({ phase: 'transcribing', percent: 40 });

  const outputPath = path.join(
    os.tmpdir(),
    `${APP_SLUG}-stt-${Date.now()}.txt`,
  );
  const rendered = command
    .replaceAll('{input}', audioPath)
    .replaceAll('{output}', outputPath);

  await execFileAsync('sh', ['-c', rendered], { timeout: 10 * 60 * 1000 });

  if (!fs.existsSync(outputPath)) {
    throw new Error('Custom STT command did not create an output file.');
  }

  const text = fs.readFileSync(outputPath, 'utf8').trim();
  fs.rmSync(outputPath, { force: true });
  onProgress?.({ phase: 'complete', percent: 100 });
  return text;
}

/**
 * @param {string} audioPath
 * @param {{ onProgress?: (update: { phase: string, percent: number }) => void }} [options]
 */
export async function transcribeAudio(audioPath, options = {}) {
  const backend = await resolveSpeechToTextBackend();
  if (!backend.available) {
    throw new Error(
      'No speech-to-text backend available. Sign in to Cursor, add OPENAI_API_KEY, save it in ~/.remotecode/secrets.json as {"openaiApiKey":"..."}, install whisper CLI, or set REMOTECODE_STT_COMMAND.',
    );
  }

  if (process.env.REMOTECODE_STT_COMMAND) {
    return transcribeWithCustomCommand(audioPath, options);
  }

  const cursor = await transcribeWithCursor(audioPath, options);
  if (cursor !== null) {
    return cursor;
  }

  const openAi = await transcribeWithOpenAI(audioPath, options);
  if (openAi !== null) {
    return openAi;
  }

  const whisper = await transcribeWithWhisperCli(audioPath, options);
  if (whisper !== null) {
    return whisper;
  }

  throw new Error(
    'No speech-to-text backend available. Sign in to Cursor, add OPENAI_API_KEY, save it in ~/.remotecode/secrets.json as {"openaiApiKey":"..."}, install whisper CLI, or set REMOTECODE_STT_COMMAND.',
  );
}
