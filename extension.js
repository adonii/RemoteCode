const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const VIEW_ID = 'remotepromptcode.cloudConnection';
const PANEL_REFRESH_MS = 5_000;
const BACKGROUND_POLL_MS = 5_000;
const STARTUP_SYNC_MS = 20_000;
const BOOTSTRAP_RETRY_MS = 500;
const BOOTSTRAP_MAX_ATTEMPTS = 120;
const WORKSPACE_SYNC_DEBOUNCE_MS = 120_000;
const PUSH_STATE_DEBOUNCE_MS = 500;
const TASK_CHANGE_DEBOUNCE_MS = 500;

/**
 * @param {{ full?: boolean, force?: boolean } | null | undefined} left
 * @param {{ full?: boolean, force?: boolean }} right
 * @returns {{ full?: boolean, force?: boolean }}
 */
function mergePushStateOptions(left, right) {
  return {
    full: left?.full === true || right.full === true,
    force: left?.force === true || right.force === true,
  };
}

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

async function allKnownWorkspaceRootsAsync() {
  const { allKnownWorkspaceRoots } = await import('./lib/project-targets.mjs');
  return allKnownWorkspaceRoots();
}

/** @type {import('./lib/cloud-connection-service.mjs') | null} */
let cloudService = null;

/** @type {CloudConnectionViewProvider | null} */
let viewProvider = null;

/** @type {vscode.StatusBarItem | undefined} */
let connectionStatusBarItem;

/** Bumped on each extension activation to force one webview HTML reload after reload. */
let webviewHtmlEpoch = 0;

const EMPTY_QUEUE_STATS = {
  tasks: [],
  conversions: [],
  taskWatcherRunning: false,
  apiDebugLog: [],
};

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

/** @returns {Promise<void>} */
async function updateConnectionStatusBar() {
  if (!connectionStatusBarItem) {
    return;
  }

  const service = await getCloudService();
  const status = service.getConnectionStatus();
  if (!status.connected) {
    connectionStatusBarItem.text = '$(cloud) RemotePromptCode: Not connected';
    connectionStatusBarItem.tooltip = 'Open Cloud Connection settings to connect iCloud or Google Drive.';
    connectionStatusBarItem.show();
    return;
  }

  connectionStatusBarItem.text = `$(cloud) RemotePromptCode: ${status.accountEmail}`;
  connectionStatusBarItem.tooltip = `Connected via ${service.providerLabel(status.provider)}`;
  connectionStatusBarItem.show();
}

/** @returns {Promise<unknown>} */
async function runProjectFolderSync(workspaceRoots) {
  const service = await getCloudService();
  if (!service.getConnectionStatus().connected) {
    return null;
  }

  return service.syncProjectCloudFolders(workspaceRoots);
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
async function runCloudStartupSync(workspaceRoots, options = {}) {
  const service = await getCloudService();
  if (!service.getConnectionStatus().connected) {
    return null;
  }

  const { syncCloudOnStartup } = await import('./lib/cloud-startup-sync.mjs');
  return syncCloudOnStartup(workspaceRoots, options);
}

class CloudConnectionViewProvider {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /** @type {string[]} */
    this.workspaceRoots = this.readWorkspaceRoots();
    /** @type {vscode.WebviewView | undefined} */
    this.view = undefined;
    this.viewVisible = false;
    /** @type {string | null} */
    this.lastPostedState = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.panelRefreshTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.backgroundPollTimer = null;
    /** @type {import('vscode').Disposable | undefined} */
    this.messageDisposable = undefined;
    /** @type {import('vscode').Disposable | undefined} */
    this.visibilityDisposable = undefined;
    /** @type {import('vscode').Disposable | undefined} */
    this.webviewDisposeDisposable = undefined;
    /** @type {import('vscode').Webview | undefined} */
    this.boundWebview = undefined;
    /** @type {number | undefined} */
    this.loadedHtmlEpoch = undefined;
    /** @type {unknown} */
    this.lastQueueStatsPayload = null;
    /** @type {Set<string>} */
    this.taskActionInFlight = new Set();
    this.pushStateInFlight = false;
    /** @type {{ full?: boolean, force?: boolean } | null} */
    this.pendingPushStateOptions = null;

    this.debouncedPushState = createDebounced(() => {
      void this.pushState({ full: false, force: true });
    }, PUSH_STATE_DEBOUNCE_MS);

    this.debouncedTaskChangeRefresh = createDebounced(() => {
      void this.refreshAfterTaskFolderChange();
    }, TASK_CHANGE_DEBOUNCE_MS);

    this.debouncedWorkspaceSync = createDebounced(() => {
      void runCloudStartupSync(this.workspaceRoots, { skipAccountUpdate: true });
    }, WORKSPACE_SYNC_DEBOUNCE_MS);

    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.handleWorkspaceFoldersChanged();
      }),
    );
  }

  readWorkspaceRoots() {
    return vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
  }

  syncWorkspaceRoots() {
    this.workspaceRoots = this.readWorkspaceRoots();
  }

  /** Workspace folders for the current window, falling back to saved project records. */
  async getEffectiveWorkspaceRootsAsync() {
    this.syncWorkspaceRoots();
    if (this.workspaceRoots.length > 0) {
      return this.workspaceRoots;
    }

    return allKnownWorkspaceRootsAsync();
  }

  async handleWorkspaceFoldersChanged() {
    this.syncWorkspaceRoots();
    this.lastPostedState = null;
    const { invalidateTaskQueueStatsCache } = await import('./lib/task-stats.mjs');
    invalidateTaskQueueStatsCache();
    const { resetTaskTerminalTransitionTracking } = await import(
      './lib/task-completion-notify.mjs'
    );
    const { resetTaskMonitorWatchSnapshot } = await import('./lib/task-monitor.mjs');
    const { resetTaskWatchSnapshot } = await import('./lib/task-watch-snapshot.mjs');
    resetTaskTerminalTransitionTracking(this.workspaceRoots);
    resetTaskWatchSnapshot(this.workspaceRoots);
    resetTaskMonitorWatchSnapshot(this.workspaceRoots);
    await this.ensureBackgroundServicesRunning();
    this.debouncedWorkspaceSync();
    this.debouncedPushState();
  }

  /** @param {vscode.WebviewView} webviewView */
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.viewVisible = webviewView.visible;
    this.visibilityDisposable?.dispose();
    this.visibilityDisposable = webviewView.onDidChangeVisibility(visible => {
      this.viewVisible = visible;
      if (visible) {
        void this.pushConnectionState({ force: true });
        void this.pushState({ full: false, force: true });
      }
    });
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
    };

    const webview = webviewView.webview;
    const htmlPath = path.join(this.context.extensionPath, 'media', 'cloud-connection-panel.html');
    const isNewWebview = this.boundWebview !== webview;
    this.boundWebview = webview;

    this.messageDisposable = bindWebviewMessageHandler(webview, message => {
      return this.handleWebviewMessage(message);
    });

    // Reload when the webview instance changes or after extension activation.
    // Avoid reloading on every resolve — that resets the panel to "Not connected"
    // until a slow iCloud queue scan finishes.
    const needsHtmlReload = isNewWebview || this.loadedHtmlEpoch !== webviewHtmlEpoch;
    if (needsHtmlReload) {
      this.loadedHtmlEpoch = webviewHtmlEpoch;
      this.lastPostedState = null;
      webview.html = fs.readFileSync(htmlPath, 'utf8');
    }

    this.webviewDisposeDisposable?.dispose();
    this.webviewDisposeDisposable = webviewView.onDidDispose(() => {
      this.disposeWebviewBindings();
      this.view = undefined;
      this.stopPanelRefresh();
    });

    if (this.viewVisible) {
      void this.pushConnectionState({ force: true });
    }
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
        await this.pushConnectionState({ force: true });
        void this.pushState({ full: false, force: true });
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
        const { debugLog } = await import('./lib/debug-log.mjs');
        debugLog('extension', `connectICloud requested (label=${payload.accountEmail ?? ''}).`);
        try {
          await service.connectICloud(payload.accountEmail ?? '');
          this.lastPostedState = null;
          await this.pushConnectionState({ force: true });
          await this.ensureBackgroundServicesRunning();
          const sync = await runCloudStartupSync(this.workspaceRoots, {
            skipAccountUpdate: true,
          });
          void updateAccountUsageInBackground(this);
          const status = service.getConnectionStatus();
          if (status.connected) {
            vscode.window.showInformationMessage(
              `RemotePromptCode connected to iCloud. Synced ${sync?.provisionedProjects ?? 0} project folder(s).`,
            );
          }
          void updateConnectionStatusBar();
          await this.pushState({ full: false, force: true });
        } finally {
          this.postMessage({ type: 'busy', value: false });
        }
        return;
      }

      if (payload.type === 'connectGoogleDrive') {
        try {
          await service.connectGoogleDrive(payload.accountEmail ?? '', payload.accessToken ?? '');
          this.lastPostedState = null;
          await this.pushConnectionState({ force: true });
          await this.ensureBackgroundServicesRunning();
          const sync = await runCloudStartupSync(this.workspaceRoots);
          vscode.window.showInformationMessage(
            `RemotePromptCode connected to Google Drive. Synced ${sync?.provisionedProjects ?? 0} project folder(s).`,
          );
          await this.pushState({ full: false, force: true });
        } finally {
          this.postMessage({ type: 'busy', value: false });
        }
        return;
      }

      if (payload.type === 'provisionWorkspace') {
        const sync = await runProjectFolderSync(this.workspaceRoots);
        const { invalidateCloudFolderStatusCache } = await import('./lib/cloud-folder-status.mjs');
        invalidateCloudFolderStatusCache();
        vscode.window.showInformationMessage(
          `RemotePromptCode synced ${sync?.provisionedProjects ?? 0} project folder(s). Updating account.json in the background.`,
        );
        await this.pushState({ full: false, force: true });
        this.postMessage({ type: 'busy', value: false });
        void updateAccountUsageInBackground(this);
        return;
      }

      if (payload.type === 'revealWorkspaceFolder') {
        const folders = await service.getCloudFolderStatus(this.workspaceRoots);
        const revealPath = folders.workspaceAbsolutePath;
        if (revealPath && fs.existsSync(revealPath)) {
          await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(revealPath),
          );
        } else {
          throw new Error('Project cloud folder does not exist yet. Sync folders first.');
        }
        return;
      }

      if (payload.type === 'logout') {
        service.logout();
        const { invalidateCloudFolderStatusCache } = await import('./lib/cloud-folder-status.mjs');
        const { invalidateTaskQueueStatsCache } = await import('./lib/task-stats.mjs');
        const { resetTaskTerminalTransitionTracking } = await import(
          './lib/task-completion-notify.mjs'
        );
        invalidateCloudFolderStatusCache();
        invalidateTaskQueueStatsCache();
        resetTaskTerminalTransitionTracking();
        this.lastPostedState = null;
        vscode.window.showInformationMessage('RemotePromptCode cloud connection removed.');
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
      void this.pushState({ full: false, force: true });
    }, PANEL_REFRESH_MS);
  }

  stopPanelRefresh() {
    if (this.panelRefreshTimer) {
      clearInterval(this.panelRefreshTimer);
      this.panelRefreshTimer = null;
    }
  }

  startBackgroundPolling() {
    if (this.backgroundPollTimer) {
      return;
    }

    this.backgroundPollTimer = setInterval(() => {
      void this.backgroundPollTick();
    }, BACKGROUND_POLL_MS);
  }

  stopBackgroundPolling() {
    if (this.backgroundPollTimer) {
      clearInterval(this.backgroundPollTimer);
      this.backgroundPollTimer = null;
    }
  }

  /** @returns {Promise<boolean>} */
  async ensureBackgroundServicesRunning() {
    this.syncWorkspaceRoots();

    const service = await getCloudService();
    if (!service.getConnectionStatus().connected) {
      return false;
    }

    const { loadProjectRecords } = await import('./lib/cloud-connection-store.mjs');
    const effectiveRoots = await this.getEffectiveWorkspaceRootsAsync();
    if (effectiveRoots.length === 0 && loadProjectRecords().length === 0) {
      return false;
    }

    const { ensureTaskWatcherRunning, isTaskWatcherRunning, purgeNonCanonicalWatcherProcesses } = await import('./lib/task-monitor.mjs');
    purgeNonCanonicalWatcherProcesses();
    if (!isTaskWatcherRunning()) {
      ensureTaskWatcherRunning();
    }

    const { startTaskOrchestrator } = await import('./lib/task-orchestrator.mjs');
    startTaskOrchestrator(vscode);
    const { startTaskChangeWatcher } = await import('./lib/task-change-watch.mjs');
    startTaskChangeWatcher(() => {
      this.debouncedTaskChangeRefresh();
    }, effectiveRoots.length > 0 ? effectiveRoots : null);
    void updateConnectionStatusBar();
    return true;
  }

  async backgroundPollTick() {
    if (!(await this.ensureBackgroundServicesRunning())) {
      return;
    }

    const service = await getCloudService();
    if (service.getConnectionStatus().connected) {
      const { isICloudFilesystemConnection, scheduleICloudStorageRefresh } = await import(
        './lib/icloud-storage.mjs'
      );
      if (isICloudFilesystemConnection()) {
        const { loadProjectRecords } = await import('./lib/cloud-connection-store.mjs');
        const { uniqueProjectTargets } = await import('./lib/project-targets.mjs');
        const targets = uniqueProjectTargets(loadProjectRecords());
        if (targets.length > 0) {
          scheduleICloudStorageRefresh(targets);
        }
      }
    }

    const effectiveRoots = await this.getEffectiveWorkspaceRootsAsync();
    const { requestBackgroundScan } = await import('./lib/task-monitor.mjs');
    requestBackgroundScan(effectiveRoots, { forceICloudRefresh: true });

    await this.notifyTaskTerminalTransitions();

    if (this.view) {
      void this.pushState({ full: false, force: true });
    }
  }

  async notifyTaskTerminalTransitions() {
    const service = await getCloudService();
    if (!service.getConnectionStatus().connected) {
      return;
    }

    const { detectTaskTerminalTransitions } = await import('./lib/task-completion-notify.mjs');
    const transitions = await detectTaskTerminalTransitions(this.workspaceRoots);
    for (const transition of transitions) {
      const label = `${transition.taskFolderName} (${transition.projectFolder})`;
      if (transition.state === 'done') {
        vscode.window.showInformationMessage(`RemotePromptCode task completed: ${label}.`);
      } else {
        const detail = transition.failPreview ? ` ${transition.failPreview}` : '';
        vscode.window.showWarningMessage(`RemotePromptCode task failed: ${label}.${detail}`);
      }
    }
  }

  async refreshAfterTaskFolderChange() {
    try {
      const service = await getCloudService();
      if (!service.getConnectionStatus().connected) {
        return;
      }

      const { requestBackgroundScan } = await import('./lib/task-monitor.mjs');
      requestBackgroundScan(this.workspaceRoots, { force: true, forceICloudRefresh: true });

      const { scheduleICloudStorageRefresh } = await import('./lib/icloud-storage.mjs');
      const { loadProjectRecords } = await import('./lib/cloud-connection-store.mjs');
      const { resolveProjectTargets } = await import('./lib/project-targets.mjs');
      const targets = resolveProjectTargets(loadProjectRecords(), this.workspaceRoots);
      if (targets.length > 0) {
        scheduleICloudStorageRefresh(targets);
      }

      const { invalidateTaskQueueStatsCache } = await import('./lib/task-stats.mjs');
      invalidateTaskQueueStatsCache();
      await this.pushState({ full: false, force: true });
    } catch {
      // Best effort; the task watcher subprocess still scans on its interval.
    }
  }

  startBackgroundServices() {
    this.startBackgroundPolling();
    void this.bootstrapConnectedExtensionWithRetry();
  }

  /** @returns {Promise<boolean>} */
  async bootstrapConnectedExtension() {
    const effectiveRoots = await this.getEffectiveWorkspaceRootsAsync();
    if (effectiveRoots.length === 0) {
      const { loadProjectRecords } = await import('./lib/cloud-connection-store.mjs');
      if (loadProjectRecords().length === 0) {
        return false;
      }
    }

    const service = await getCloudService();
    if (!service.getConnectionStatus().connected) {
      return false;
    }

    const { loadProjectRecords } = await import('./lib/cloud-connection-store.mjs');
    const { debugLog } = await import('./lib/debug-log.mjs');
    debugLog(
      'extension',
      `Restoring saved ${service.getConnectionStatus().provider} connection ` +
        `for ${effectiveRoots.length || loadProjectRecords().length} known project(s).`,
    );

    await this.ensureBackgroundServicesRunning();

    const { ensureTaskWatcherCurrent } = await import('./lib/task-monitor.mjs');
    ensureTaskWatcherCurrent(effectiveRoots);

    const { uniqueProjectTargets } = await import('./lib/project-targets.mjs');
    const { isICloudFilesystemConnection, refreshICloudStorageForScan } = await import(
      './lib/icloud-storage.mjs'
    );
    const targets = uniqueProjectTargets(loadProjectRecords());
    if (isICloudFilesystemConnection() && targets.length > 0) {
      await refreshICloudStorageForScan(targets, { force: true });
    }

    const { requestBackgroundScan } = await import('./lib/task-monitor.mjs');
    requestBackgroundScan(effectiveRoots, { force: true, forceICloudRefresh: true });

    try {
      await runCloudStartupSync(effectiveRoots, { skipAccountUpdate: true });
    } catch {
      // iCloud paths can fail intermittently during startup.
    }

    debugLog('extension', 'Saved cloud connection bootstrap complete.');
    void updateConnectionStatusBar();
    return true;
  }

  async bootstrapConnectedExtensionWithRetry() {
    for (let attempt = 0; attempt < BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
      if (await this.bootstrapConnectedExtension()) {
        if (this.view) {
          await this.pushConnectionState({ force: true });
        }
        void updateConnectionStatusBar();
        return;
      }

      await new Promise(resolve => {
        setTimeout(resolve, BOOTSTRAP_RETRY_MS);
      });
    }
  }

  scheduleDeferredAccountUpdate() {
    setTimeout(async () => {
      try {
        const service = await getCloudService();
        if (!service.getConnectionStatus().connected) {
          return;
        }
        const { updateMachineAccountFile } = await import('./lib/machine-account.mjs');
        await updateMachineAccountFile();
      } catch {
        // Usage stats are optional.
      }
    }, STARTUP_SYNC_MS);
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

    this.stopPanelRefresh();
    this.stopBackgroundPolling();
  }

  /** @param {{ force?: boolean }} [options] */
  async pushConnectionState(options = {}) {
    if (!this.view) {
      return;
    }

    this.syncWorkspaceRoots();
    const workspaceRoots = this.workspaceRoots;
    const service = await getCloudService();
    const status = service.getConnectionStatus();

    let icloudAvailable = false;
    if (icloudSignedInCache && Date.now() - icloudSignedInCache.at < ICLOUD_CHECK_CACHE_MS) {
      icloudAvailable = icloudSignedInCache.value;
    } else {
      icloudAvailable = await service.checkMacICloudSignedIn();
      icloudSignedInCache = { value: icloudAvailable, at: Date.now() };
    }

    const { loadSettings } = await import('./lib/settings-store.mjs');
    const settings = loadSettings();

    /** @type {{ connected: true, provider: string, accountEmail: string, connectedAt: string, hasAccessToken: boolean, providerLabel: string } | { connected: false }} */
    let panelStatus = { connected: false };
    if (status.connected) {
      panelStatus = {
        ...status,
        providerLabel: service.providerLabel(status.provider),
      };
    }

    const folders = service.getCloudFolderStatus(workspaceRoots, {
      force: options.force === true,
    });

    const payload = {
      type: 'state',
      platform: process.platform,
      icloudAvailable,
      status: panelStatus,
      folders,
      queueStats: this.lastQueueStatsPayload ?? EMPTY_QUEUE_STATS,
      settings,
    };

    const serialized = JSON.stringify(payload);
    if (options.force !== true && serialized === this.lastPostedState) {
      return;
    }

    this.lastPostedState = serialized;
    this.postMessage(payload);
  }

  /** @param {{ full?: boolean, force?: boolean }} [options] */
  async pushState(options = {}) {
    const full = options.full === true;
    if (!full && !this.view) {
      return;
    }

    if (this.pushStateInFlight) {
      this.pendingPushStateOptions = mergePushStateOptions(
        this.pendingPushStateOptions,
        options,
      );
      return;
    }

    this.pushStateInFlight = true;
    try {
      this.syncWorkspaceRoots();
      const workspaceRoots = this.workspaceRoots;

      const service = await getCloudService();
      const initialStatus = service.getConnectionStatus();
      let icloudAvailable = false;
      if (icloudSignedInCache && Date.now() - icloudSignedInCache.at < ICLOUD_CHECK_CACHE_MS) {
        icloudAvailable = icloudSignedInCache.value;
      } else if (full || !initialStatus.connected) {
        icloudAvailable = await service.checkMacICloudSignedIn();
        icloudSignedInCache = { value: icloudAvailable, at: Date.now() };
      }

      const { getTaskQueueStats } = await import('./lib/task-stats.mjs');
      const { loadSettings } = await import('./lib/settings-store.mjs');
      const queueStats = await getTaskQueueStats({
        lite: !full,
        force: options.force === true,
        workspaceRoots,
      });
      const settings = loadSettings();

      if (!this.view) {
        return;
      }

      // Re-read connection after slow queue scan — connect/disconnect may have changed mid-flight.
      const status = service.getConnectionStatus();

      /** @type {{ connected: true, provider: string, accountEmail: string, connectedAt: string, hasAccessToken: boolean, providerLabel: string } | { connected: false }} */
      let panelStatus = { connected: false };

      if (status.connected) {
        panelStatus = {
          ...status,
          providerLabel: service.providerLabel(status.provider),
        };
      }

      const folders = service.getCloudFolderStatus(workspaceRoots, {
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
      this.lastQueueStatsPayload = queueStats;
      this.postMessage(payload);

      if (options.force === true && status.connected) {
        try {
          await this.notifyTaskTerminalTransitions();
        } catch {
          // UI already updated; notifications are best-effort.
        }
      }
    } finally {
      this.pushStateInFlight = false;
      const pending = this.pendingPushStateOptions;
      this.pendingPushStateOptions = null;
      if (pending) {
        void this.pushState(pending);
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
      `RemotePromptCode is connected to ${service.providerLabel(status.provider)} (${status.accountEmail}).`,
      'Open Cloud Settings',
      'Log out',
    );
    if (choice === 'Open Cloud Settings') {
      viewProvider?.reveal();
    } else if (choice === 'Log out') {
      service.logout();
      vscode.window.showInformationMessage('RemotePromptCode cloud connection removed.');
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
    { placeHolder: 'Choose a cloud provider for RemotePromptCode' },
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
      await viewProvider?.pushConnectionState({ force: true });
      await viewProvider?.ensureBackgroundServicesRunning();
      const sync = await runCloudStartupSync(viewProvider?.workspaceRoots ?? getWorkspaceRoots());
      vscode.window.showInformationMessage(
        `RemotePromptCode connected to iCloud. Synced ${sync?.provisionedProjects ?? 0} project folder(s).`,
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
      await viewProvider?.pushConnectionState({ force: true });
      await viewProvider?.ensureBackgroundServicesRunning();
      const sync = await runCloudStartupSync(viewProvider?.workspaceRoots ?? getWorkspaceRoots());
      vscode.window.showInformationMessage(
        `RemotePromptCode connected to Google Drive. Synced ${sync?.provisionedProjects ?? 0} project folder(s).`,
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
      '[RemotePromptCode] vscode.cursor.plugins.registerPath unavailable; hooks will not auto-register. ' +
        'Symlink this extension to ~/.cursor/plugins/local/RemotePromptCode to enable hooks, or run in extension development mode.',
    );
    return false;
  }

  try {
    cursorApi.plugins.registerPath(context.extensionPath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[RemotePromptCode] Failed to register plugin hooks: ${message}`);
    return false;
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  webviewHtmlEpoch += 1;
  registerCursorPlugin(context);

  connectionStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  connectionStatusBarItem.command = 'remotepromptcode.openCloudSettings';
  context.subscriptions.push(connectionStatusBarItem);
  void updateConnectionStatusBar();

  void import('./lib/task-monitor.mjs').then(({ ensureTaskWatcherCurrent, listInstalledExtensionVersions }) => {
    ensureTaskWatcherCurrent();
    const versions = listInstalledExtensionVersions();
    if (versions.length > 1) {
      void vscode.window.showWarningMessage(
        `RemotePromptCode has ${versions.length} versions installed (${versions.join(', ')}). ` +
          'Uninstall all except the newest or task pickup will be unreliable.',
        'Open Extensions',
      ).then(choice => {
        if (choice === 'Open Extensions') {
          void vscode.commands.executeCommand('workbench.view.extensions', 'andreidonii.remotepromptcode');
        }
      });
    }
  });
  viewProvider = new CloudConnectionViewProvider(context);
  viewProvider.startBackgroundServices();
  viewProvider.scheduleDeferredAccountUpdate();

  void getCloudService().then(async service => {
    if (!service.getConnectionStatus().connected) {
      return;
    }
    viewProvider?.syncWorkspaceRoots();
    await viewProvider?.ensureBackgroundServicesRunning();
  });

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
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand('remotepromptcode.openCloudSettings', () => {
      viewProvider?.reveal();
    }),
    vscode.commands.registerCommand('remotepromptcode.connectCloud', () => {
      void promptConnectFlow();
    }),
    vscode.commands.registerCommand('remotepromptcode.logoutCloud', async () => {
      const service = await getCloudService();
      if (!service.getConnectionStatus().connected) {
        vscode.window.showInformationMessage('RemotePromptCode is not connected to a cloud provider.');
        return;
      }
      service.logout();
      const { resetTaskTerminalTransitionTracking } = await import(
        './lib/task-completion-notify.mjs'
      );
      resetTaskTerminalTransitionTracking();
      vscode.window.showInformationMessage('RemotePromptCode cloud connection removed.');
      await viewProvider?.pushState();
    }),
    { dispose: () => viewProvider?.dispose() },
  );

  void getCloudService().then(service => {
    if (service.getConnectionStatus().connected) {
      return;
    }

    void vscode.window
      .showInformationMessage(
        'RemotePromptCode needs iCloud or Google Drive before project folders can sync.',
        'Open Cloud Settings',
      )
      .then(choice => {
        if (choice === 'Open Cloud Settings') {
          viewProvider?.reveal();
        }
      });
  });
}

function deactivate() {
  viewProvider?.dispose();
  viewProvider = null;
  cloudService = null;
  connectionStatusBarItem?.dispose();
  connectionStatusBarItem = undefined;
}

module.exports = { activate, deactivate };
