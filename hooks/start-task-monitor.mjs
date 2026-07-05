#!/usr/bin/env node

import fs from 'node:fs';
import { ensureTaskWatcherRunning, scanAllProjectFolders } from '../lib/task-monitor.mjs';
import { setWorkspaceRoots } from '../lib/workspace-scope.mjs';

async function main() {
  const inputText = fs.readFileSync(0, 'utf8');
  const hookInput = inputText ? JSON.parse(inputText) : {};
  const workspaceRoots = Array.isArray(hookInput.workspace_roots)
    ? hookInput.workspace_roots.filter(root => typeof root === 'string' && root.trim())
    : [];

  setWorkspaceRoots(workspaceRoots);
  ensureTaskWatcherRunning(workspaceRoots);
  await scanAllProjectFolders({ forceICloudRefresh: true });

  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      additional_context: 'RemotePromptCode task monitor is running.',
    })}\n`,
  );
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
});
