#!/usr/bin/env node

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadSettings, saveSettings, updateSettings } from '../lib/settings-store.mjs';

function printSettings(settings) {
  console.log(JSON.stringify(settings, null, 2));
}

async function promptNumber(label, currentValue) {
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question(`${label} [${currentValue}]: `)).trim();
  rl.close();

  if (!answer) {
    return currentValue;
  }

  return Number.parseInt(answer, 10);
}

async function main() {
  const command = process.argv[2] ?? 'status';
  const key = process.argv[3];
  const value = process.argv[4];

  switch (command) {
    case 'status':
      printSettings(loadSettings());
      return;
    case 'set':
      if (key === 'summaryMaxWords' && value) {
        printSettings(updateSettings({ summaryMaxWords: value }));
        return;
      }
      if (key === 'preventSleep' && value) {
        printSettings(updateSettings({ preventSleep: value === 'true' || value === '1' }));
        return;
      }
      throw new Error(
        'Usage: settings.mjs set summaryMaxWords <number> | preventSleep true|false',
      );
    case 'configure': {
      const current = loadSettings();
      const summaryMaxWords = await promptNumber(
        'Request summary max words',
        current.summaryMaxWords,
      );
      printSettings(saveSettings({ ...current, summaryMaxWords }));
      return;
    }
    default:
      throw new Error(
        'Unknown command. Use status, set summaryMaxWords <number>, or configure.',
      );
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
