#!/usr/bin/env node

import { ensureTaskWatcherRunning, scanAllProjectFolders } from '../lib/task-monitor.mjs';

async function main() {
  ensureTaskWatcherRunning();
  await scanAllProjectFolders();

  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      additional_context: 'RemoteCode task monitor is running.',
    })}\n`,
  );
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
});
