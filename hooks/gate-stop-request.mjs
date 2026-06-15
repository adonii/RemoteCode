#!/usr/bin/env node

import fs from 'node:fs';
import { handleStopGate } from '../lib/task-stop.mjs';

async function main() {
  const inputText = fs.readFileSync(0, 'utf8');
  const hookInput = inputText ? JSON.parse(inputText) : {};

  try {
    const result = await handleStopGate(hookInput);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`);
  }
}

main();
