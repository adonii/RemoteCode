#!/usr/bin/env node

import fs from 'node:fs';
import { ensureProjectFolderForHook } from '../lib/ensure-project-folder.mjs';
import { countRunTasks, getSessionIdFromHook } from '../lib/hook-utils.mjs';
import { APP_NAME } from '../lib/constants.mjs';

async function main() {
  const inputText = fs.readFileSync(0, 'utf8');
  const hookInput = inputText ? JSON.parse(inputText) : {};

  const output = {
    continue: true,
    env: {},
  };

  try {
    await ensureProjectFolderForHook(hookInput);
    const sessionId = getSessionIdFromHook(hookInput);
    if (sessionId) {
      const pendingCount = await countRunTasks(sessionId);
      if (pendingCount > 0) {
        output.additional_context =
          `${APP_NAME} has ${pendingCount} queued mobile task(s) for this project.`;
      }
    }
  } catch {
    // Session provisioning failures are handled elsewhere.
  }

  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
});
