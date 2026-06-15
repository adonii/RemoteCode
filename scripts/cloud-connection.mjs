#!/usr/bin/env node

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  connectGoogleDrive,
  connectICloud,
  getConnectionStatus,
  logout,
  syncCloudOnStartup,
} from '../lib/cloud-connection-service.mjs';

function printStatus() {
  const status = getConnectionStatus();
  if (!status.connected) {
    console.log('not_connected');
    return;
  }

  const { connected, hasAccessToken, ...safeConnection } = status;
  console.log(JSON.stringify({ ...safeConnection, hasAccessToken }));
}

async function promptConnectICloud() {
  const rl = readline.createInterface({ input, output });
  const accountEmail = (
    await rl.question('iCloud account label (email or name): ')
  ).trim();
  rl.close();
  await connectICloud(accountEmail);
}

async function promptConnectGoogleDrive() {
  const rl = readline.createInterface({ input, output });
  const accountEmail = (await rl.question('Google account email: ')).trim();
  const accessToken = (await rl.question('Google Drive access token (optional): ')).trim();
  rl.close();
  await connectGoogleDrive(accountEmail, accessToken);
}

async function main() {
  const command = process.argv[2] ?? 'status';

  switch (command) {
    case 'status':
      printStatus();
      return;
    case 'connect-icloud':
      if (process.argv[3]) {
        await connectICloud(process.argv[3]);
      } else {
        await promptConnectICloud();
      }
      await syncCloudOnStartup();
      printStatus();
      return;
    case 'connect-google':
      if (process.argv[3]) {
        await connectGoogleDrive(process.argv[3], process.argv[4]);
      } else {
        await promptConnectGoogleDrive();
      }
      await syncCloudOnStartup();
      printStatus();
      return;
    case 'provision-workspace':
    case 'sync':
      await syncCloudOnStartup(process.argv.slice(3).filter(Boolean));
      printStatus();
      return;
    case 'logout':
      logout();
      console.log('logged_out');
      return;
    default:
      throw new Error(
        `Unknown command: ${command}. Use status, connect-icloud, connect-google, or logout.`,
      );
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
