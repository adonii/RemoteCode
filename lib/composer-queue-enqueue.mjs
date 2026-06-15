import { randomUUID } from 'node:crypto';
import { debugLog } from './debug-log.mjs';
import { readComposerSignalsAsync } from './composer-output.mjs';

const REGISTRATION_POLL_INTERVAL_MS = 100;
const REGISTRATION_MAX_WAIT_MS = 8_000;
const RESTORE_DELAYS_MS = [250, 500, 1_000];

function log(message) {
  debugLog('dispatch', message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    log(`Could not read active composer id: ${errorMessage(error)}`);
  }
  return null;
}

async function restoreComposerView(vscode, composerId) {
  try {
    await vscode.commands.executeCommand('composer.openComposer', composerId, {
      skipFocus: true,
    });
    log(`Restored composer view to ${composerId}.`);
  } catch (error) {
    log(`Failed to restore composer view to ${composerId}: ${errorMessage(error)}`);
  }
}

/**
 * Poll until Cursor persists the composer row, or until we hit the cap.
 * Uses the cheap signals query only (no bubble text reads).
 *
 * @param {string} composerId
 * @returns {Promise<{ signals: Awaited<ReturnType<typeof readComposerSignalsAsync>>, waitedMs: number }>}
 */
async function waitForComposerRegistration(composerId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < REGISTRATION_MAX_WAIT_MS) {
    const signals = await readComposerSignalsAsync(composerId);
    if (signals.present) {
      return { signals, waitedMs: Date.now() - startedAt };
    }
    await sleep(REGISTRATION_POLL_INTERVAL_MS);
  }

  const signals = await readComposerSignalsAsync(composerId);
  return { signals, waitedMs: Date.now() - startedAt };
}

/**
 * createNew briefly selects the new tab while it mounts. Restore the user's
 * previous composer on a short schedule so slow mounts still recover focus.
 *
 * @param {import('vscode')} vscode
 * @param {string | null} previousComposerId
 * @param {string} composerId
 * @returns {() => void} cancel scheduled restores
 */
function scheduleComposerViewRestore(vscode, previousComposerId, composerId) {
  if (!previousComposerId || previousComposerId === composerId) {
    return () => {};
  }

  const timers = RESTORE_DELAYS_MS.map(delay =>
    setTimeout(() => {
      void restoreComposerView(vscode, previousComposerId);
    }, delay),
  );

  return () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  };
}

/**
 * Dispatch a task prompt by creating a fresh Agent composer and auto-submitting
 * it. This is the only in-process Cursor primitive that reliably submits and
 * runs a prompt: `composer.createNew` with `autoSubmit`.
 *
 * The `composer.createNew` command handler does not return the created
 * composer, so we pre-assign the composerId ourselves: Cursor's createComposer
 * uses `partialState.composerId` when provided. A fresh UUID is never a
 * duplicate, so this is safe and lets us track the agent for output capture.
 *
 * It deliberately does NOT write to the focused conversation's storage row.
 * Doing so (json_set on the live, often large composerData blob in the shared
 * state.vscdb) contends with Cursor's own UI-thread writes and freezes the
 * window. A new empty agent tab avoids that entirely.
 *
 * The agent must mount in a background tab for Cursor to keep the stream alive;
 * a fully headless composer (skipShowAndFocus / skipSelect) gets aborted
 * mid-generation. We open a new tab with skipFocus, then immediately restore
 * the user's previous composer so the UI does not stay switched.
 *
 * @param {import('vscode')} vscode
 * @param {string} prompt
 * @returns {Promise<{
 *   composerId: string,
 *   dispatched: boolean,
 *   dispatchReason: string,
 *   registered: boolean,
 *   registrationWaitMs: number,
 *   createCommandRejected: boolean,
 * }>}
 */
export async function enqueuePromptOnFocusedAgentTab(vscode, prompt) {
  const trimmed = prompt?.trim();
  if (!trimmed) {
    throw new Error('Task has no prompt text to dispatch.');
  }

  const previousComposerId = await getActiveComposerId(vscode);
  const composerId = randomUUID();

  log(
    `Dispatching task via composer.createNew autoSubmit ` +
      `(composerId ${composerId}, previous ${previousComposerId ?? 'none'}, ` +
      `prompt length ${trimmed.length}).`,
  );

  // Fire-and-forget: composer.createNew with autoSubmit does NOT resolve promptly
  // (it awaits the chat submission / generation). Awaiting it as a gate caused an
  // 8s timeout that discarded a perfectly good running agent. We pre-assigned the
  // composerId, so we can track the agent purely from the DB regardless of when
  // (or whether) the command's promise settles.
  let createCommandRejected = false;
  const cancelScheduledRestores = scheduleComposerViewRestore(
    vscode,
    previousComposerId,
    composerId,
  );

  // NOTE: the composer's view must mount for Cursor to keep the chat stream
  // alive; a fully headless composer (skipShowAndFocus/skipSelect) gets aborted
  // mid-generation. So we open it as a background tab (it mounts + runs to
  // completion) but keep skipFocus so it never steals the user's keyboard focus.
  Promise.resolve(
    vscode.commands.executeCommand('composer.createNew', {
      partialState: {
        composerId,
        text: trimmed,
        richText: trimmed,
        unifiedMode: 'agent',
      },
      autoSubmit: true,
      openInNewTab: true,
      skipFocus: true,
    }),
  ).then(
    () => log(`composer.createNew settled for ${composerId}.`),
    error => {
      createCommandRejected = true;
      log(`composer.createNew rejected for ${composerId}: ${errorMessage(error)}`);
    },
  );

  const { signals, waitedMs } = await waitForComposerRegistration(composerId);

  if (previousComposerId && previousComposerId !== composerId) {
    cancelScheduledRestores();
    await restoreComposerView(vscode, previousComposerId);
  }

  log(
    `Post-create DB read for ${composerId}: status=${signals.status ?? 'MISSING'}, ` +
      `generatingCount=${signals.generatingCount}, headers=${signals.headerCount}, ` +
      `registered=${signals.present}, waitedMs=${waitedMs}, ` +
      `createRejected=${createCommandRejected}.`,
  );

  log(`Created agent composer ${composerId}; task is now tracked for output.`);

  return {
    composerId,
    dispatched: true,
    dispatchReason: 'created-new-agent',
    registered: signals.present,
    registrationWaitMs: waitedMs,
    createCommandRejected,
  };
}
