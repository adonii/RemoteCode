import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './cloud-connection-store.mjs';

export const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  summaryMaxWords: 10,
  preventSleep: false,
  useLlmSummaries: false,
  maxParallelTasks: 3,
  injectActiveTabContext: false,
  accumulateTaskHistory: false,
  contextTokenLimit: 6000,
};

const MAX_PARALLEL_TASKS_LIMIT = 20;
const CONTEXT_TOKEN_LIMIT_MAX = 200_000;

function normalizeParallelTasks(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, MAX_PARALLEL_TASKS_LIMIT);
}

function normalizeContextTokenLimit(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, CONTEXT_TOKEN_LIMIT_MAX);
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return fallback;
}

function normalizeUseLlmSummaries(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return normalizeBoolean(value, fallback);
}

function normalizeWordLimit(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, 100);
}

export function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return {
      summaryMaxWords: normalizeWordLimit(
        parsed.summaryMaxWords,
        DEFAULT_SETTINGS.summaryMaxWords,
      ),
      preventSleep: normalizeBoolean(parsed.preventSleep, DEFAULT_SETTINGS.preventSleep),
      useLlmSummaries: normalizeUseLlmSummaries(
        parsed.useLlmSummaries,
        DEFAULT_SETTINGS.useLlmSummaries,
      ),
      maxParallelTasks: normalizeParallelTasks(
        parsed.maxParallelTasks,
        DEFAULT_SETTINGS.maxParallelTasks,
      ),
      injectActiveTabContext: normalizeBoolean(
        parsed.injectActiveTabContext,
        DEFAULT_SETTINGS.injectActiveTabContext,
      ),
      accumulateTaskHistory: normalizeBoolean(
        parsed.accumulateTaskHistory,
        DEFAULT_SETTINGS.accumulateTaskHistory,
      ),
      contextTokenLimit: normalizeContextTokenLimit(
        parsed.contextTokenLimit,
        DEFAULT_SETTINGS.contextTokenLimit,
      ),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  const normalized = {
    summaryMaxWords: normalizeWordLimit(
      settings.summaryMaxWords,
      DEFAULT_SETTINGS.summaryMaxWords,
    ),
    preventSleep: normalizeBoolean(settings.preventSleep, DEFAULT_SETTINGS.preventSleep),
    useLlmSummaries: normalizeUseLlmSummaries(
      settings.useLlmSummaries,
      DEFAULT_SETTINGS.useLlmSummaries,
    ),
    maxParallelTasks: normalizeParallelTasks(
      settings.maxParallelTasks,
      DEFAULT_SETTINGS.maxParallelTasks,
    ),
    injectActiveTabContext: normalizeBoolean(
      settings.injectActiveTabContext,
      DEFAULT_SETTINGS.injectActiveTabContext,
    ),
    accumulateTaskHistory: normalizeBoolean(
      settings.accumulateTaskHistory,
      DEFAULT_SETTINGS.accumulateTaskHistory,
    ),
    contextTokenLimit: normalizeContextTokenLimit(
      settings.contextTokenLimit,
      DEFAULT_SETTINGS.contextTokenLimit,
    ),
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

export function updateSettings(patch) {
  const current = loadSettings();
  return saveSettings({ ...current, ...patch });
}
