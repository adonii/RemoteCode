import { debugLog } from './debug-log.mjs';
import { readComposerProgressAsync } from './composer-output.mjs';
import { isDailyCursorUsageBudgetFailure } from './response-failure.mjs';

function log(message) {
  debugLog('monitor', message);
}

// The ONLY trustworthy terminal signal for a background composer is
// status === 'completed'. Cursor's on-disk status is otherwise useless for our
// timing: it sits at a transient "aborted" during/between steps, and
// `generatingBubbleIds` is frequently empty even while the agent is actively
// progressing. So we never conclude "failed" from status + short-term stability;
// we only fail a run that has clearly stalled (no conversation growth) for a long
// grace period (a real user-abort / window reload), or that never started.

// No conversation growth for this long at a non-"completed" status => treat as a
// real abort/error. Must comfortably exceed the longest expected pause between
// agent steps / tool calls.
const STALL_FAIL_MS = 180_000;

// Never produced any conversation/output within this window => dispatch failed.
const NO_START_FAIL_MS = 120_000;

/**
 * Per-composer progress tracking, kept in memory across watcher scan cycles.
 * Keyed by composerId.
 *
 * @type {Map<string, { lastFingerprint: string | null, lastGrowthAt: number, firstSeenAt: number, sawOutput: boolean }>}
 */
const trackerByComposerId = new Map();

function getTracker(composerId) {
  let tracker = trackerByComposerId.get(composerId);
  if (!tracker) {
    const now = Date.now();
    tracker = {
      lastFingerprint: null,
      lastGrowthAt: now,
      firstSeenAt: now,
      sawOutput: false,
    };
    trackerByComposerId.set(composerId, tracker);
  }
  return tracker;
}

async function readTaskField(taskFolder, field, ...args) {
  const value = taskFolder[field]?.(...args);
  return value instanceof Promise ? value : value;
}

async function writeTaskField(taskFolder, field, ...args) {
  const value = taskFolder[field]?.(...args);
  if (value instanceof Promise) {
    await value;
  }
}

async function finalizeDone(taskFolder, composerId, responseText) {
  if (responseText) {
    await writeTaskField(taskFolder, 'writeResponseText', responseText);
  }
  // Intentionally keep .composer-id: the extension-host orchestrator reads it to
  // close the finished agent tab, then clears it. The watcher only polls tasks
  // in the 'running' state, so it won't re-process this one.
  await writeTaskField(taskFolder, 'setState', 'done');
  trackerByComposerId.delete(composerId);
  log(`Task done; saved ${responseText.length} chars from composer ${composerId}.`);
}

async function finalizeFail(
  taskFolder,
  composerId,
  responseText,
  reason,
  { saveOutputToFailLog = false } = {},
) {
  if (saveOutputToFailLog && responseText) {
    await writeTaskField(taskFolder, 'writeFailLog', responseText);
    await writeTaskField(taskFolder, 'clearResponseText');
  } else {
    if (responseText) {
      await writeTaskField(taskFolder, 'writeResponseText', responseText);
    }
    await writeTaskField(taskFolder, 'writeFailLog', reason);
  }
  await writeTaskField(taskFolder, 'setState', 'fail');
  trackerByComposerId.delete(composerId);
  log(`Task failed for composer ${composerId}: ${reason}`);
}

/**
 * Poll a single running task's tracked composer, stream its output into
 * response.txt, and finalize the task state when generation truly ends.
 *
 * Cursor's on-disk `status` is unreliable for background tabs: it starts at a
 * transient "aborted" and only settles to "completed" after the run finishes.
 * So we drive the lifecycle from the live `generatingBubbleIds` signal plus a
 * progress fingerprint (conversation length + blob size), and only act on a
 * terminal status once the composer has clearly settled.
 *
 * Reads Cursor's local state DB read-only; never writes to it.
 *
 * @param {object} taskFolder
 * @returns {Promise<boolean>} true if the task reached a terminal state
 */
export async function pollRunningTaskOutput(taskFolder) {
  const composerId = await readTaskField(taskFolder, 'readComposerId');
  if (!composerId) {
    log('Running task has no .composer-id yet; nothing to poll.');
    return false;
  }

  const { status, generating, headerCount, blobLen, responseText } =
    await readComposerProgressAsync(composerId);

  const now = Date.now();
  const tracker = getTracker(composerId);
  const fingerprint = `${headerCount}:${blobLen}:${responseText.length}`;
  const grew = fingerprint !== tracker.lastFingerprint;
  if (grew) {
    tracker.lastFingerprint = fingerprint;
    tracker.lastGrowthAt = now;
  }
  if (headerCount > 0 || responseText.length > 0) {
    tracker.sawOutput = true;
  }

  const idleMs = now - tracker.lastGrowthAt;
  log(
    `Polled composer ${composerId}: status=${status ?? 'MISSING'}, generating=${generating}, ` +
      `headers=${headerCount}, responseLen=${responseText.length}, ` +
      `idleMs=${idleMs}, sawOutput=${tracker.sawOutput}.`,
  );

  const budgetFailure = isDailyCursorUsageBudgetFailure(responseText);

  // Stream in-progress output unless this is a Cursor budget error.
  if (responseText && !budgetFailure) {
    await writeTaskField(taskFolder, 'writeResponseText', responseText);
  }

  // The one trustworthy terminal signal. It lags behind the visual end of the
  // run, so we wait for it rather than guessing from stability.
  if (status === 'completed') {
    if (budgetFailure) {
      await finalizeFail(taskFolder, composerId, responseText, 'Daily Cursor usage budget reached.', {
        saveOutputToFailLog: true,
      });
    } else {
      await finalizeDone(taskFolder, composerId, responseText);
    }
    return true;
  }

  // Produced output but has shown no growth for a long time at a non-completed
  // status: a genuine abort (user stop / window reload) or an error.
  if (tracker.sawOutput && idleMs > STALL_FAIL_MS) {
    await finalizeFail(
      taskFolder,
      composerId,
      responseText,
      `Agent run stalled with no progress for ${Math.round(STALL_FAIL_MS / 1000)}s at ` +
        `status "${status ?? 'none'}" (composer ${composerId}). Likely aborted. Partial ` +
        `output, if any, is in response.txt.`,
    );
    return true;
  }

  // Never produced anything within the grace window: dispatch likely failed.
  if (!tracker.sawOutput && now - tracker.firstSeenAt > NO_START_FAIL_MS) {
    await finalizeFail(
      taskFolder,
      composerId,
      responseText,
      `Agent never started producing output within ${Math.round(NO_START_FAIL_MS / 1000)}s ` +
        `(composer ${composerId}).`,
    );
    return true;
  }

  // Otherwise keep watching: warming up, mid-step pause, or waiting for status
  // to settle to "completed".
  return false;
}
