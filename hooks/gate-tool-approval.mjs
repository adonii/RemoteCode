#!/usr/bin/env node

import fs from 'node:fs';
import { handleApprovalGate } from '../lib/task-approval.mjs';

async function main() {
  const inputText = fs.readFileSync(0, 'utf8');
  const hookInput = inputText ? JSON.parse(inputText) : {};

  try {
    const result = await handleApprovalGate(hookInput);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`);
  }
}

main();
