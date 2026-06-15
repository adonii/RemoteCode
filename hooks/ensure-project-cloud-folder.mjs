#!/usr/bin/env node

import fs from 'node:fs';
import { ensureProjectFolderForHook } from '../lib/ensure-project-folder.mjs';
import { APP_NAME } from '../lib/constants.mjs';

async function main() {
  const inputText = fs.readFileSync(0, 'utf8');
  const hookInput = inputText ? JSON.parse(inputText) : {};

  try {
    const result = await ensureProjectFolderForHook(hookInput);

    const output = {
      continue: true,
      env: {},
    };

    if (!result.skipped && result.cloud) {
      if (result.cloud.absolutePath) {
        output.env.REMOTECODE_CLOUD_FOLDER = result.cloud.absolutePath;
      }
      if (result.cloud.folderId) {
        output.env.REMOTECODE_CLOUD_FOLDER_ID = result.cloud.folderId;
      }
      output.env.REMOTECODE_CLOUD_RELATIVE_PATH = result.relativePath;
      output.additional_context = `${APP_NAME} cloud folder: ${result.relativePath}`;
    }

    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stdout.write(
      `${JSON.stringify({
        continue: true,
        additional_context: `${APP_NAME} could not create the cloud folder: ${message}`,
      })}\n`,
    );
    process.exit(0);
  }
}

main();
