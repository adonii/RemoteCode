#!/usr/bin/env node

import { updateMachineAccountFile } from '../lib/machine-account.mjs';
import { LOG_PREFIX } from '../lib/constants.mjs';

async function main() {
  try {
    await updateMachineAccountFile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${LOG_PREFIX} Failed to update machine account file: ${message}\n`);
  }

  process.stdout.write('{}\n');
}

main();
