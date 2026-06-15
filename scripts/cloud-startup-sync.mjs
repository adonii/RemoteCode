#!/usr/bin/env node

import { syncCloudOnStartup } from '../lib/cloud-startup-sync.mjs';

async function main() {
  const workspaceRoots = process.argv.slice(2).filter(Boolean);
  const result = await syncCloudOnStartup(workspaceRoots.length > 0 ? workspaceRoots : undefined);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
