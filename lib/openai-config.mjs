import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { CONFIG_DIR } from './cloud-connection-store.mjs';
import { resolveCursorApiKeySync } from './cursor-auth.mjs';
import { isCursorSpeechToTextAvailable } from './cursor-speech-to-text.mjs';

const execFileAsync = promisify(execFile);
const SECRETS_PATH = path.join(CONFIG_DIR, 'secrets.json');

let whisperCliCache = null;

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

export function getOpenAiApiKey() {
  const fromEnv = process.env.OPENAI_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim();
  }

  const secrets = readSecretsFile();
  const fromFile = secrets?.openaiApiKey;
  if (typeof fromFile === 'string' && fromFile.trim()) {
    return fromFile.trim();
  }

  return null;
}

async function isWhisperCliAvailable() {
  if (whisperCliCache !== null) {
    return whisperCliCache;
  }

  const whisperBinary = process.env.REMOTECODE_WHISPER_BIN ?? 'whisper';

  try {
    await execFileAsync(whisperBinary, ['--help'], { timeout: 5000 });
    whisperCliCache = true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      whisperCliCache = false;
    } else {
      whisperCliCache = true;
    }
  }

  return whisperCliCache;
}

export async function resolveSpeechToTextBackend() {
  if (process.env.REMOTECODE_STT_COMMAND) {
    return {
      id: 'custom-command',
      label: 'Custom STT command',
      available: true,
    };
  }

  if (isCursorSpeechToTextAvailable()) {
    return {
      id: 'cursor-voice',
      label: 'Cursor agent voice',
      available: true,
    };
  }

  if (getOpenAiApiKey()) {
    return {
      id: 'openai-whisper',
      label: 'OpenAI Whisper API',
      available: true,
    };
  }

  if (await isWhisperCliAvailable()) {
    return {
      id: 'whisper-cli',
      label: 'Whisper CLI',
      available: true,
    };
  }

  return {
    id: 'none',
    label: 'No speech-to-text backend configured',
    available: false,
  };
}

export function buildWatcherEnvironment() {
  const env = { ...process.env };
  const apiKey = getOpenAiApiKey();
  if (apiKey) {
    env.OPENAI_API_KEY = apiKey;
  }

  const cursorApiKey = resolveCursorApiKeySync();
  if (cursorApiKey) {
    env.CURSOR_API_KEY = cursorApiKey;
  }

  return env;
}