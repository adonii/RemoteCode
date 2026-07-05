import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './cloud-connection-store.mjs';

const SWIFT_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/icloud-refresh.swift',
);
const SWIFT_CACHE_DIR = path.join(CONFIG_DIR, 'swift-cache');
const SWIFT_BINARY = path.join(SWIFT_CACHE_DIR, 'icloud-refresh');

const COMPILE_TIMEOUT_MS = 60_000;
const DEFAULT_RUN_TIMEOUT_MS = 8_000;

/** @type {Promise<string | null> | null} */
let compilePromise = null;
/** @type {Promise<unknown>} */
let swiftQueueTail = Promise.resolve();

/**
 * Serialize every Swift helper invocation so only one process runs at a time.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withSwiftSemaphore(fn) {
  const run = swiftQueueTail.then(() => fn());
  swiftQueueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function binaryIsFresh() {
  if (!fs.existsSync(SWIFT_BINARY)) {
    return false;
  }

  const binMtime = fs.statSync(SWIFT_BINARY).mtimeMs;
  const srcMtime = fs.statSync(SWIFT_SCRIPT).mtimeMs;
  return binMtime >= srcMtime;
}

function compileSwiftBinary() {
  return new Promise((resolve, reject) => {
    const tmpBinary = `${SWIFT_BINARY}.tmp-${process.pid}`;
    const child = spawn('swiftc', ['-O', '-o', tmpBinary, SWIFT_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, COMPILE_TIMEOUT_MS);

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `swiftc exited with code ${code}`));
        return;
      }

      try {
        fs.renameSync(tmpBinary, SWIFT_BINARY);
        fs.chmodSync(SWIFT_BINARY, 0o755);
        resolve(SWIFT_BINARY);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function ensureSwiftBinary() {
  if (process.platform !== 'darwin') {
    return null;
  }

  if (binaryIsFresh()) {
    return SWIFT_BINARY;
  }

  if (!compilePromise) {
    compilePromise = (async () => {
      fs.mkdirSync(SWIFT_CACHE_DIR, { recursive: true });
      if (binaryIsFresh()) {
        return SWIFT_BINARY;
      }
      await compileSwiftBinary();
      return SWIFT_BINARY;
    })().finally(() => {
      compilePromise = null;
    });
  }

  return compilePromise;
}

/**
 * Run a compiled Swift helper command.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {number} [timeoutMs]
 * @param {string | null} [stdin]
 * @returns {Promise<string | null>}
 */
export function runSwiftHelper(
  command,
  args = [],
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  stdin = null,
) {
  if (process.platform !== 'darwin') {
    return Promise.resolve(null);
  }

  return withSwiftSemaphore(async () => {
    const binary = await ensureSwiftBinary();
    if (!binary) {
      return null;
    }

    return new Promise(resolve => {
      const child = spawn(binary, [command, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });

      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      });

      if (stdin != null) {
        child.stdin.write(stdin);
      }
      child.stdin.end();
    });
  });
}
