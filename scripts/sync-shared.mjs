#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const monorepoSource = path.resolve(root, '../shared/constants.mjs');
const targetDir = path.join(root, 'shared');
const target = path.join(targetDir, 'constants.mjs');

if (fs.existsSync(monorepoSource)) {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(monorepoSource, target);
  console.log(`sync-shared: copied ${path.relative(root, monorepoSource)} -> shared/constants.mjs`);
} else if (fs.existsSync(target)) {
  console.log('sync-shared: using committed shared/constants.mjs');
} else {
  console.error('sync-shared: missing shared/constants.mjs');
  process.exit(1);
}
