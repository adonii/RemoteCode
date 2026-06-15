#!/usr/bin/env node

import { scanAllProjectFolders } from '../lib/task-monitor.mjs';

await scanAllProjectFolders();
