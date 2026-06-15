const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const VIEW_ID = 'remotecode.cloudConnection';
const PANEL_REFRESH_MS = 3_000;
const ICLOUD_BACKGROUND_REFRESH_MS = 2_000;
const STARTUP_WATCHER_MS = 500;
const STARTUP_SYNC_MS = 20_000;
const WORKSPACE_SYNC_DEBOUNCE_MS = 120_000;
const PUSH_STATE_DEBOUNCE_MS = 500;
const TASK_CHANGE_DEBOUNCE_MS = 300;

/**
 * @param {( ...args: unknown[]) => void} fn
 * @param {number} delayMs
 */
function createDebounced(fn, delayMs) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  return (...args) => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
}

/** @returns {string[]} */
function getWorkspaceRoots() {
  return vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
}

/** @type {import('./lib/cloud-connection-service.mjs') | null} */
let cloudService = null;

/** @type {CloudConnectionViewProvider | null} */
let viewProvider = null;

/** @type {{ value: boolean, at: number } | null} */
let icloudSignedInCache = null;
const ICLOUD_CHECK_CACHE_MS = 60_000;

/** @param {{ type?: string, projectKey?: string, taskFolderName?: string }} message */
function taskActionKey(message) {
  return `${message.type}:${message.projectKey}:${message.taskFolderName}`;
}

/** @type {Set<string>} */
const globalTaskActionInFlight = new Set();

/** @type {Map<string, number>} */
const recentTaskMessages = new Map();
const TASK_MESSAGE_DEDUPE_MS = 3000;

/** @type {WeakMap<import('vscode').Webview, import('vscode').Disposable>} */
const webviewMessageBindings = new WeakMap();

/**
 * @param {import('vscode').Webview} webview
 * @param {(message: unknown) => void | Promise<void>} handler
 */
function bindWebviewMessageHandler(webview, handler) {
  webviewMessageBindings.get(webview)?.dispose();
  const disposable = webview.onDidReceiveMessage(message => {
    void handler(message);
  });
  webviewMessageBindings.set(webview, disposable);
  return disposable;
}

/** @param {{ type?: string, projectKey?: string, taskFolderName?: string }} message */
function isDuplicateTaskMessage(message) {
  const taskTypes = new Set(['runTask', 'stopTask', 'resumeTask', 'removeTask']);
  if (!message.type || !taskTypes.has(message.type)) {
    return false;
  }

  const key = taskActionKey(message);
  const now = Date.now();
  const lastSeen = recentTaskMessages.get(key) ?? 0;
  if (now - lastSeen < TASK_MESSAGE_DEDUPE_MS) {
    return true;
  }

  recentTaskMessages.set(key, now);
  return false;
}

/** @returns {Promise<import('./lib/cloud-connection-service.mjs')>} */
async function getCloudService() {
  if (!cloudService) {
    cloudService = await import('./lib/cloud-connection-service.mjs');
  }
  return cloudService;
}

/** @returns {Promise<unknown>} */
async function runProjectFolderSync() {
  const service = await getCloudService();
  if (!service.getConnectionStatus().connected) {
    return null;
  }

  return service.syncProjectCloudFolders(getWorkspaceRoots());
}

/** @returns {Promise<unknown>} */
async function updateAccountUsageInBackground(viewProvider) {
  try {
    const { updateMachineAccountFile } = await import('./lib/machine-account.mjs');
    await updateMachineAccountFile();
  } catch {
    // Usage stats are optional; folder sync already succeeded.
  }

  await viewProvider?.pushState({ full: false, force: true });
}

/** @returns {Promise<unknown>} */
async function runCloudStartupSync(options = {}) {
  const service = await getCloudService();
  if (!service.getConnectionStatus().connected) {
    return null;
  }

  const { syncCloudOnStartup } = await import('./lib/cloud-startup-sync.mjs');
  return syncCloudOnStartup(getWorkspaceRoots(), options);
}

class CloudConnectionViewProvider {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /** @type {vscode.WebviewView | undefined} */
    this.view = undefined;
    this.viewVisible = false;
    /** @type {string | null} */
    this.lastPostedState = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.panelRefreshTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.icloudRefreshTimer = null;
    /** @type {import('vscode').Disposable | undefined} */
    this.messageDisposable = undefined;
    /** @type {import('vscode').Disposable | undefined} */
    this.visibilityDisposable = undefined;
    /** @type {import('vscode').Disposable | undefined} */
    this.webviewDisposeDisposable = undefined;
    /** @type {import('vscode').Webview | undefined} */
    this.boundWebview = undefined;
    /** @type {Set<string>} */
    this.taskActionInFlight = new Set();
    this.pushStateInFlight = false;
    this.pendingPushState = false;
    this.startupComplete = false;

    this.debouncedPushState = createDebounced(() => {
      void this.pushState({ full: false, force: true });
    }, PUSH_STATE_DEBOUNCE_MS);

    this.debouncedTaskChangeRefresh = createDebounced(() => {
      void this.refreshAfterTaskFolderChange();
    }, TASK_CHANGE_DEBOUNCE_MS);

    this.debouncedWorkspaceSync = createDebounced(() => {
      void runCloudStartupSync({ skipAccountUpdate: true });
    }, WORKSPACE_SYNC_DEBOUNCE_MS);
  }

  /** @param {vscode.WebviewView} webviewView */
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.viewVisible = webviewView.visible;
    this.visibilityDisposable?.dispose();
    this.visibilityDisposable = webviewView.onDidChangeVisibility(visible => {
      this.viewVisible = visible;
    });
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
    };

    const webview = webviewView.webview;
    const htmlPath = path.join(this.context.extensionPath, 'media', 'cloud-connection-panel.html');
    const isNewWebview = this.boundWebview !== webview;
    this.boundWebview = webview;

    if (!webviewMessageBindings.has(webview)) {
      this.messageDisposable = bindWebviewMessageHandler(webview, message => {
        return this.handleWebviewMessage(message);
      });
    }

    // Always load HTML when the webview instance changes (e.g. after extension reload).
    // Skipping reload leaves a stale service worker ID and breaks the panel.
    if (isNewWebview) {
      webview.html = fs.readFileSync(htmlPath, 'utf8');
    }

    this.webviewDisposeDisposable?.dispose();
    this.webviewDisposeDisposable = webviewView.onDidDispose(() => {
      this.disposeWebviewBindings();
      this.view = undefined;
      this.stopPanelRefresh();
    });
  }

  disposeWebviewBindings() {
    if (this.boundWebview) {
      webviewMessageBindings.get(this.boundWebview)?.dispose();
      webviewMessageBindings.delete(this.boundWebview);
    }
    this.messageDisposable?.dispose();
    this.messageDisposable = undefined;
    this.visibilityDisposable?.dispose();
    this.visibilityDisposable = undefined;
    this.webviewDisposeDisposable?.dispose();
    this.webviewDisposeDisposable = undefined;
    this.boundWebview = undefined;
    this.taskActionInFlight.clear();
  }

  /**
   * @param {{ type?: string, projectKey?: string, taskFolderName?: string }} message
   * @param {() => Promise<void>} handler
   */
  async handleTaskAction(message, handler) {
    const key = taskActionKey(message);
    if (!message.type || !message.projectKey || !message.taskFolderName) {
      return;
    }

    if (this.taskActionInFlight.has(key)) {
      return;
    }

    if (globalTaskActionInFlight.has(key)) {
      return;
    }

    this.taskActionInFlight.add(key);
    globalTaskActionInFlight.add(key);
    try {
      await handler();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showWarningMessage(text);
    } finally {
      this.taskActionInFlight.delete(key);
      globalTaskActionInFlight.delete(key);
      this.postMessage({ type: 'busy', value: false });
    }
  }

  /** @param {unknown} message */
  async handleWebviewMessage(message) {
    try {
      if (!message || typeof message !== 'object' || !('type' in message)) {
        return;
      }

      /** @type {{ type: string, projectKey?: string, taskFolderName?: string, accountEmail?: string, accessToken?: string, preventSleep?: boolean }} */
      const payload = message;

      if (payload.type === 'ready') {
        this.startPanelRefresh();
        await this.pushState({ full: false, force: true });
        return;
      }

      if (payload.type === 'updateSettings') {
        const { updateSettings } = await import('./lib/settings-store.mjs');
        const { applyPreventSleep } = await import('./lib/prevent-sleep.mjs');
        const patch = {};
        if (payload.preventSleep !== undefined) {
          patch.preventSleep = payload.preventSleep === true;
        }
        if (payload.maxParallelTasks !== undefined) {
          patch.maxParallelTasks = payload.maxParallelTasks;
        }
        if (payload.injectActiveTabContext !== undefined) {
          patch.injectActiveTabContext = payload.injectActiveTabContext === true;
        }
        if (payload.accumulateTaskHistory !== undefined) {
          patch.accumulateTaskHistory = payload.accumulateTaskHistory === true;
        }
        if (payload.contextTokenLimit !== undefined) {
          patch.contextTokenLimit = payload.contextTokenLimit;
        }
        const settings = updateSettings(patch);
        applyPreventSleep(settings.preventSleep);
        await this.pushState({ full: false, force: true });
        return;
      }

      if (payload.type === 'refreshDebug') {
        try {
          await this.pushState({ full: true, force: true });
        } finally {
          this.postMessage({ type: 'busy', value: false });
        }
        return;
      }

      if (payload.type === 'runTask') {
        if (isDuplicateTaskMessage(payload)) {
          return;
        }
        await this.handleTaskAction(payload, async () => {
          const { debugLog } = await import('./lib/debug-log.mjs');
          debugLog(
            'extension',
            `runTask received for project=${payload.projectKey}, task=${payload.taskFolderName}.`,
          );
          const { runTaskFromServer } = await import('./lib/task-control.mjs');
          const result = await runTaskFromServer(
            payload.projectKey,
            payload.taskFolderName,
            vscode,
            { workspaceStorageUri: this.context.storageUri },
          );
          vscode.window.showInformationMessage(
            result.started
              ? `Started ${payload.taskFolderName}.`
              : `Start invoked for ${payload.taskFolderName} (no state change).`,
          );
          await this.pushState({ full: false, force: true });
        });
        return;
      }

      if (payload.type === 'stopTask') {
        if (isDuplicateTaskMessage(payload)) {
          return;
        }
        await this.handleTaskAction(payload, async () => {
          const { stopTaskFromServer } = await import('./lib/task-control.mjs');
          await stopTaskFromServer(payload.projectKey, payload.taskFolderName);
          vscode.window.showInformationMessage(`Stop requested for ${payload.taskFolderName}.`);
          await this.pushState({ full: false, force: true });
        });
        return;
      }

      if (payload.type === 'resumeTask') {
        if (isDuplicateTaskMessage(payload)) {
          return;
        }
        await this.handleTaskAction(payload, async () => {
          const { resumeFailedTaskFromServer } = await import('./lib/task-control.mjs');
          const result = await resumeFailedTaskFromServer(
            payload.projectKey,
            payload.taskFolderName,
          );
          vscode.window.showInformationMessage(
            `Resumed ${payload.taskFolderName} (${result.nextState}).`,
          );
          await this.pushState({ full: false, force: true });
        });
        return;
      }

      if (payload.type === 'removeTask') {
        if (isDuplicateTaskMessage(payload)) {
          return;
        }
        await this.handleTaskAction(payload, async () => {
          const { removeTaskFromServer } = await import('./lib/task-control.mjs');
          await removeTaskFromServer(payload.projectKey, payload.taskFolderName);
          vscode.window.showInformationMessage(`Removed ${payload.taskFolderName}.`);
          await this.pushState({ full: false, force: true });
        });
        return;
      }

      const service = await getCloudService();

      if (payload.type === 'connectICloud') {
        await service.connectICloud(payload.accountEmail ?? '');
        const sync = await runCloudStartupSync();
        vscode.window.showInformationMessage(
          `RemoteCode connected to iCloud. Synced ${sync?.provisionedProjects ?? 0} project folder(s).`,
        );
        await this.pushState({ full: false, force: true });
        return;
      }

      if (payload.type === 'connectGoogleDrive') {
        await service.connectGoogleDrive(payload.accountEmail ?? '', payload.accessToken ?? '');
        const sync = await runCloudStartupSync();
        vscode.window.showInformationMessage(
          `RemoteCode connected to Google Drive. Synced ${sync?.provisionedProjects ?? 0} project folder(s).`,
        );
        await this.pushState({ full: false, force: true });
        return;
      }

      if (payload.type === 'provisionWorkspace') {
        const sync = await runProjectFolderSync();
        const { invalidateCloudFolderStatusCache } = await import('./lib/cloud-folder-status.mjs');
        invalidateCloudFolderStatusCache();
        vscode.window.showInformationMessage(
          `RemoteCode synced ${sync?.provisionedProjects ?? 0} project folder(s). Updating account.json in the background.`,
        );
        await this.pushState({ full: false, force: true });
        this.postMessage({ type: 'busy', value: false });
        void updateAccountUsageInBackground(this);
        return;
      }

      if (payload.type === 'revealWorkspaceFolder') {
        const folders = await service.getCloudFolderStatus(getWorkspaceRoots());
        const revealPath =
          folders.machineAbsolutePath && fs.existsSync(folders.machineAbsolutePath)
            ? folders.machineAbsolutePath
            : folders.workspaceAbsolutePath;
        if (revealPath && fs.existsSync(revealPath)) {
          await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(revealPath),
          );
        } else {
          throw new Error('Machine folder does not exist yet. Sync folders first.');
        }
        return;
      }

      if (payload.type === 'logout') {
        service.logout();
        const { invalidateCloudFolderStatusCache } = await import('./lib/cloud-folder-status.mjs');
        const { invalidateTaskQueueStatsCache } = await import('./lib/task-stats.mjs');
        invalidateCloudFolderStatusCache();
        invalidateTaskQueueStatsCache();
        this.lastPostedState = null;
        vscode.window.showInformationMessage('RemoteCode cloud connection removed.');
        await this.pushState();
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.postMessage({ type: 'error', message: text });
    }
  }

  startPanelRefresh() {
    if (this.panelRefreshTimer) {
      return;
    }

    this.panelRefreshTimer = setInterval(() => {
      if (!this.viewVisible) {
        return;
      }
      // Force a fresh read each cycle: task state is changed on disk by the
      // watcher subprocess and the orchestrator, so the in-memory stats cache
      // would otherwise mask completed/new tasks until a manual Sync.
      void this.pushState({ full: false, force: true });
    }, PANEL_REFRESH_MS);
  }

  stopPanelRefresh() {
    if (this.panelRefreshTimer) {
      clearInterval(this.panelRefreshTimer);
      this.panelRefreshTimer = null;
    }
  }

  async refreshAfterTaskFolderChange() {
    try {
      const service = await getCloudService();
      if (!service.getConnectionStatus().connected) {
        return;
      }

      const { invalidateTaskQueueStatsCache } = await import('./lib/task-stats.mjs');
      invalidateTaskQueueStatsCache();
      const { invalidateICloudListCache, refreshICloudStorageForScan } = await import(
        './lib/icloud-storage.mjs'
      );
      const { uniqueProjectTargets } = await import('./lib/project-targets.mjs');
      const { loadProjectRecords } = await import('./lib/cloud-connection-store.mjs');
      await refreshICloudStorageForScan(uniqueProjectTargets(loadProjectRecords()));
      invalidateICloudListCache();
      const { requestBackgroundScan } = await import('./lib/task-monitor.mjs');
      requestBackgroundScan();
      await this.pushState({ full: false, force: true });
    } catch {
      // Best effort; polling still covers missed events.
    }
  }

  startBackgroundServices() {
    if (this.startupComplete) {
      return;
    }

    this.startupComplete = true;

    setTimeout(async () => {
      try {
        const service = await getCloudService();
        if (!service.getConnectionStatus().connected) {
          return;
        }
        const { ensureTaskWatcherRunning } = await import('./lib/task-monitor.mjs');
        ensureTaskWatcherRunning();
        const { startTaskOrchestrator } = await import('./lib/task-orchestrator.mjs');
        startTaskOrchestrator(vscode);
        const { startTaskChangeWatcher } = await import('./lib/task-change-watch.mjs');
        startTaskChangeWatcher(() => {
          this.debouncedTaskChangeRefresh();
        });
        this.startICloudBackgroundRefresh();
      } catch {
        // Task watcher handles conversion in a subprocess.
      }
    }, STARTUP_WATCHER_MS);

    setTimeout(async () => {
      try {
        const service = await getCloudService();
        if (!service.getConnectionStatus().connected) {
          return;
        }
        await runCloudStartupSync({ skipAccountUpdate: true });
      } catch {
        // iCloud paths can fail intermittently.
      }
    }, STARTUP_SYNC_MS);
  }

  startICloudBackgroundRefresh() {
    if (this.icloudRefreshTimer) {
      return;
    }

    this.icloudRefreshTimer = setInterval(() => {
      void (async () => {
        try {
          const service = await getCloudService();
          if (!service.getConnectionStatus().connected) {
            return;
          }

          const { isICloudFilesystemConnection, scheduleICloudStorageRefresh } = await import(
            './lib/icloud-storage.mjs'
          );
          if (!isICloudFilesystemConnection()) {
            return;
          }

          scheduleICloudStorageRefresh();
          this.debouncedTaskChangeRefresh();
        } catch {
          // Best effort; task watcher polling still covers missed refreshes.
        }
      })();
    }, ICLOUD_BACKGROUND_REFRESH_MS);
  }

  stopICloudBackgroundRefresh() {
    if (this.icloudRefreshTimer) {
      clearInterval(this.icloudRefreshTimer);
      this.icloudRefreshTimer = null;
    }
  }

  dispose() {
    void import('./lib/prevent-sleep.mjs').then(({ stopPreventSleep }) => {
      stopPreventSleep();
    });

    void import('./lib/task-orchestrator.mjs').then(({ stopTaskOrchestrator }) => {
      stopTaskOrchestrator();
    });

    void import('./lib/task-change-watch.mjs').then(({ stopTaskChangeWatcher }) => {
      stopTaskChangeWatcher();
    });

    this.disposeWebviewBindings();

    if (this.panelRefreshTimer) {
      clearInterval(this.panelRefreshTimer);
      this.panelRefreshTimer = null;
    }

    this.stopPanelRefresh();
    this.stopICloudBackgroundRefresh();
  }

  /** @param {{ full?: boolean, force?: boolean }} [options] */
  async pushState(options = {}) {
    const full = options.full === true;
    if (!full && !this.view) {
      return;
    }

    if (this.pushStateInFlight) {
      this.pendingPushState = true;
      return;
    }

    this.pushStateInFlight = true;
    try {
      const service = await getCloudService();
      const status = service.getConnectionStatus();
      let icloudAvailable = false;
      if (icloudSignedInCache && Date.now() - icloudSignedInCache.at < ICLOUD_CHECK_CACHE_MS) {
        icloudAvailable = icloudSignedInCache.value;
      } else if (full || !status.connected) {
        icloudAvailable = await service.checkMacICloudSignedIn();
        icloudSignedInCache = { value: icloudAvailable, at: Date.now() };
      }

      const { getTaskQueueStats } = await import('./lib/task-stats.mjs');
      const { loadSettings } = await import('./lib/settings-store.mjs');
      const queueStats = await getTaskQueueStats({
        lite: !full,
        force: options.force === true,
      });
      const settings = loadSettings();

      if (!this.view) {
        return;
      }

      /** @type {{ connected: true, provider: string, accountEmail: string, connectedAt: string, hasAccessToken: boolean, providerLabel: string } | { connected: false }} */
      let panelStatus = { connected: false };

      if (status.connected) {
        panelStatus = {
          ...status,
          providerLabel: service.providerLabel(status.provider),
        };
      }

      const folders = service.getCloudFolderStatus(getWorkspaceRoots(), {
        force: full || options.force === true,
      });

      const payload = {
        type: 'state',
        platform: process.platform,
        icloudAvailable,
        status: panelStatus,
        folders,
        queueStats,
        settings,
      };

      const serialized = JSON.stringify(payload);
      if (!full && !options.force && serialized === this.lastPostedState) {
        return;
      }

      this.lastPostedState = serialized;
      this.postMessage(payload);
    } finally {
      this.pushStateInFlight = false;
      if (this.pendingPushState) {
        this.pendingPushState = false;
        this.debouncedPushState();
      }
    }
  }

  /** @param {unknown} message */
  postMessage(message) {
    this.view?.webview.postMessage(message);
  }

  reveal() {
    void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }
}

/** @param {vscode.ExtensionContext} context */
async function promptConnectFlow() {
  const service = await getCloudService();

  if (service.getConnectionStatus().connected) {
    const status = service.getConnectionStatus();
    const choice = await vscode.window.showInformationMessage(
      `RemoteCode is connected to ${service.providerLabel(status.provider)} (${status.accountEmail}).`,
      'Open Cloud Settings',
      'Log out',
    );
    if (choice === 'Open Cloud Settings') {
      viewProvider?.reveal();
    } else if (choice === 'Log out') {
      service.logout();
      vscode.window.showInformationMessage('RemoteCode cloud connection removed.');
      await viewProvider?.pushState();
    }
    return;
  }

  const provider = await vscode.window.showQuickPick(
    [
      {
        label: 'iCloud',
        description: 'macOS — uses iCloud Drive',
        pick: 'icloud',
      },
      {
        label: 'Google Drive',
        description: 'Desktop sync folder or API token',
        pick: 'google_drive',
      },
    ],
    { placeHolder: 'Choose a cloud provider for RemoteCode' },
  );

  if (!provider) {
    return;
  }

  try {
    if (provider.pick === 'icloud') {
      const accountEmail = await vscode.window.showInputBox({
        prompt: 'iCloud account label (email or name)',
        placeHolder: 'you@icloud.com',
        ignoreFocusOut: true,
      });
      if (!accountEmail) {
        return;
      }
      await service.connectICloud(accountEmail);
      const sync = await runCloudStartupSync();
      vscode.window.showInformationMessage(
        `RemoteCode connected to iCloud. Synced ${sync?.provisionedProjects ?? 0} project folder(s).`,
      );
    } else {
      const accountEmail = await vscode.window.showInputBox({
        prompt: 'Google account email',
        placeHolder: 'you@gmail.com',
        ignoreFocusOut: true,
      });
      if (!accountEmail) {
        return;
      }
      const accessToken = await vscode.window.showInputBox({
        prompt: 'Google Drive access token (optional)',
        placeHolder: 'Leave blank to use the desktop sync folder',
        password: true,
        ignoreFocusOut: true,
      });
      await service.connectGoogleDrive(accountEmail, accessToken ?? '');
      const sync = await runCloudStartupSync();
      vscode.window.showInformationMessage(
        `RemoteCode connected to Google Drive. Synced ${sync?.provisionedProjects ?? 0} project folder(s).`,
      );
    }

    await viewProvider?.pushState({ full: false, force: true });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(text);
  }
}

/** @param {vscode.ExtensionContext} context */
function registerCursorPlugin(context) {
  const cursorApi = vscode.cursor;
  if (!cursorApi?.plugins?.registerPath) {
    console.warn(
      '[RemoteCode] vscode.cursor.plugins.registerPath unavailable; hooks will not auto-register. ' +
        'Symlink this extension to ~/.cursor/plugins/local/RemoteCode to enable hooks, or run in extension development mode.',
    );
    return false;
  }

  try {
    cursorApi.plugins.registerPath(context.extensionPath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[RemoteCode] Failed to register plugin hooks: ${message}`);
    return false;
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  registerCursorPlugin(context);
  viewProvider = new CloudConnectionViewProvider(context);
  viewProvider.startBackgroundServices();

  void import('./lib/cursor-auth.mjs').then(({ refreshCursorAuthCacheSync }) => {
    refreshCursorAuthCacheSync();
  });

  void import('./lib/settings-store.mjs').then(({ loadSettings }) =>
    import('./lib/prevent-sleep.mjs').then(({ applyPreventSleep }) => {
      applyPreventSleep(loadSettings().preventSleep);
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('remotecode.openCloudSettings', () => {
      viewProvider?.reveal();
    }),
    vscode.commands.registerCommand('remotecode.connectCloud', () => {
      void promptConnectFlow();
    }),
    vscode.commands.registerCommand('remotecode.logoutCloud', async () => {
      const service = await getCloudService();
      if (!service.getConnectionStatus().connected) {
        vscode.window.showInformationMessage('RemoteCode is not connected to a cloud provider.');
        return;
      }
      service.logout();
      vscode.window.showInformationMessage('RemoteCode cloud connection removed.');
      await viewProvider?.pushState();
    }),
    { dispose: () => viewProvider?.dispose() },
  );

  void getCloudService().then(service => {
    if (!service.getConnectionStatus().connected) {
      void vscode.window
        .showInformationMessage(
          'RemoteCode needs iCloud or Google Drive before project folders can sync.',
          'Open Cloud Settings',
        )
        .then(choice => {
          if (choice === 'Open Cloud Settings') {
            viewProvider?.reveal();
          }
        });
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      viewProvider?.debouncedWorkspaceSync();
      viewProvider?.debouncedPushState();
    }),
  );
}

function deactivate() {
  viewProvider?.dispose();
  viewProvider = null;
  cloudService = null;
}

module.exports = { activate, deactivate };
