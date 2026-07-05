#!/usr/bin/env node

import { scanAllProjectFolders } from '../lib/task-monitor.mjs';
import { initWorkspaceScopeFromEnvironment } from '../lib/workspace-scope.mjs';

initWorkspaceScopeFromEnvironment();
const forceICloudRefresh = process.env.REMOTECODE_FORCE_ICLOUD_REFRESH === '1';
await scanAllProjectFolders({ forceICloudRefresh });
