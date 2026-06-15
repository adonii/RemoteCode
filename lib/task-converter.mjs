import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRequestSummary } from './request-summary.mjs';
import {
  beginConversion,
  failConversion,
  finishConversion,
  getConversionMeta,
  runWithTranscriptionProgress,
  updateConversion,
} from './conversion-progress.mjs';
import { loadSettings } from './settings-store.mjs';
import { resolveSpeechToTextBackend, transcribeAudio } from './speech-to-text.mjs';
import { APP_SLUG, LOG_PREFIX } from './constants.mjs';

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

async function getState(taskFolder) {
  return taskFolder.getState();
}

async function setState(taskFolder, state) {
  await taskFolder.setState(state);
}

async function finalizeAfterConversion(taskFolder) {
  const finalState = await getState(taskFolder);
  if (finalState === 'stop') {
    log('Conversion finished with stop state; leaving .state unchanged.');
    return;
  }

  if (finalState === 'converting') {
    await setState(taskFolder, 'run');
    log('Updated .state from converting to run.');
  }
}

async function resetFailedConversion(taskFolder) {
  const state = await getState(taskFolder);
  if (state === 'converting') {
    await setState(taskFolder, 'convert');
  }
}

export async function processConvertTask(taskFolder) {
  const state = await getState(taskFolder);
  if (state !== 'convert') {
    return false;
  }

  const backend = await resolveSpeechToTextBackend();
  if (!backend.available) {
    throw new Error(
      `${backend.label}. Sign in to Cursor or save {"openaiApiKey":"..."} to ~/.remotecode/secrets.json before starting the task watcher.`,
    );
  }

  await setState(taskFolder, 'converting');
  const updatedState = await getState(taskFolder);
  if (updatedState !== 'converting') {
    return false;
  }

  const conversion = getConversionMeta(taskFolder);
  beginConversion(conversion.id, {
    ...conversion,
    backend: backend.label,
  });
  log(`Started conversion for ${describeTaskFolder(taskFolder)} using ${backend.label}.`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-audio-`));
  try {
    updateConversion(conversion.id, {
      backend: backend.label,
      phase: 'Downloading audio',
      percent: 12,
    });

    const audioPath = await taskFolder.downloadRequestAudioTo(tempDir);
    if (!audioPath) {
      throw new Error('convert state found but no request audio file is present.');
    }

    const transcript = await runWithTranscriptionProgress(
      conversion.id,
      audioPath,
      backend.label,
      options => transcribeAudio(audioPath, options),
    );

    updateConversion(conversion.id, {
      backend: backend.label,
      phase: 'Summarizing',
      percent: 86,
    });
    const { summaryMaxWords } = loadSettings();
    const summary = await buildRequestSummary(transcript, summaryMaxWords);

    updateConversion(conversion.id, {
      backend: backend.label,
      phase: 'Saving',
      percent: 96,
    });
    await taskFolder.writeRequestText(transcript);
    await taskFolder.writeRequestSummary(summary);
    log(
      `Wrote request.txt (${transcript.length} characters) and request_summary.txt (${summaryMaxWords} word max).`,
    );
  } catch (error) {
    failConversion(conversion.id, error);
    await resetFailedConversion(taskFolder);
    throw error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  await finalizeAfterConversion(taskFolder);
  finishConversion(conversion.id);
  return true;
}

function describeTaskFolder(taskFolder) {
  if (taskFolder.mode === 'filesystem') {
    return taskFolder.taskFolderPath;
  }
  return taskFolder.taskFolderName;
}
