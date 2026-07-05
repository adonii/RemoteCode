import fs from 'node:fs';
import path from 'node:path';
import { REQUEST_SUMMARY_FILE } from './request-summary.mjs';
import {
  APPROVAL_APPROVE_FILE,
  APPROVAL_REQUEST_FILE,
  APPROVAL_SKIP_FILE,
  ATTACHED_FILES_DIR,
  COMPOSER_ID_FILE,
  DISPATCH_ATTEMPTS_FILE,
  FAIL_LOG_FILE,
  PROMPT_FILE,
  RESPONSE_FILE,
  REQUEST_FILE,
  SAVED_ATTACHMENT_SOURCES_FILE,
} from './task-files.mjs';
import { parseTaskState, TASK_STATE_FILE } from './task-states.mjs';

async function driveApiRequest(connection, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Drive API error (${response.status}): ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response;
}

function guessMimeType(fileName) {
  switch (path.extname(fileName).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    case '.txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

export function createFilesystemTaskFolder(taskFolderPath) {
  const statePath = path.join(taskFolderPath, TASK_STATE_FILE);

  return {
    mode: 'filesystem',
    taskFolderPath,

    listEntries() {
      return fs.readdirSync(taskFolderPath);
    },

    getState() {
      if (!fs.existsSync(statePath)) {
        return null;
      }
      try {
        return parseTaskState(fs.readFileSync(statePath, 'utf8'));
      } catch (error) {
        if (error instanceof Error && (error.code === 'EPERM' || error.code === 'EACCES')) {
          return null;
        }
        throw error;
      }
    },

    hasState(state) {
      return this.getState() === state;
    },

    setState(state) {
      fs.writeFileSync(statePath, state, 'utf8');
    },

    findRequestAudioPath() {
      const audioName = this.listEntries().find(entry => {
        if (!entry.startsWith('request.')) {
          return false;
        }
        return entry !== 'request.txt';
      });

      return audioName ? path.join(taskFolderPath, audioName) : null;
    },

    writeRequestText(text) {
      fs.writeFileSync(path.join(taskFolderPath, 'request.txt'), text, 'utf8');
    },

    writeRequestSummary(text) {
      fs.writeFileSync(
        path.join(taskFolderPath, REQUEST_SUMMARY_FILE),
        text,
        'utf8',
      );
    },

    writePromptText(text) {
      fs.writeFileSync(path.join(taskFolderPath, PROMPT_FILE), text, 'utf8');
    },

    readPromptText() {
      const promptPath = path.join(taskFolderPath, PROMPT_FILE);
      if (!fs.existsSync(promptPath)) {
        return null;
      }
      return fs.readFileSync(promptPath, 'utf8');
    },

    clearPromptText() {
      const promptPath = path.join(taskFolderPath, PROMPT_FILE);
      if (fs.existsSync(promptPath)) {
        fs.unlinkSync(promptPath);
      }
    },

    writeResponseText(text) {
      fs.writeFileSync(path.join(taskFolderPath, RESPONSE_FILE), text, 'utf8');
    },

    readResponseText() {
      const responsePath = path.join(taskFolderPath, RESPONSE_FILE);
      if (!fs.existsSync(responsePath)) {
        return null;
      }
      return fs.readFileSync(responsePath, 'utf8');
    },

    clearResponseText() {
      const responsePath = path.join(taskFolderPath, RESPONSE_FILE);
      if (fs.existsSync(responsePath)) {
        fs.unlinkSync(responsePath);
      }
    },

    readDispatchAttemptCount() {
      const attemptsPath = path.join(taskFolderPath, DISPATCH_ATTEMPTS_FILE);
      if (!fs.existsSync(attemptsPath)) {
        return 0;
      }

      const parsed = Number.parseInt(fs.readFileSync(attemptsPath, 'utf8').trim(), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    },

    writeDispatchAttemptCount(count) {
      fs.writeFileSync(
        path.join(taskFolderPath, DISPATCH_ATTEMPTS_FILE),
        String(count),
        'utf8',
      );
    },

    clearDispatchAttemptCount() {
      const attemptsPath = path.join(taskFolderPath, DISPATCH_ATTEMPTS_FILE);
      if (fs.existsSync(attemptsPath)) {
        fs.unlinkSync(attemptsPath);
      }
    },

    writeComposerId(composerId) {
      fs.writeFileSync(path.join(taskFolderPath, COMPOSER_ID_FILE), composerId, 'utf8');
    },

    readComposerId() {
      const composerIdPath = path.join(taskFolderPath, COMPOSER_ID_FILE);
      if (!fs.existsSync(composerIdPath)) {
        return null;
      }
      const value = fs.readFileSync(composerIdPath, 'utf8').trim();
      return value || null;
    },

    clearComposerId() {
      const composerIdPath = path.join(taskFolderPath, COMPOSER_ID_FILE);
      if (fs.existsSync(composerIdPath)) {
        fs.unlinkSync(composerIdPath);
      }
    },

    writeFailLog(content) {
      fs.writeFileSync(path.join(taskFolderPath, FAIL_LOG_FILE), content, 'utf8');
    },

    readFailLog() {
      const failLogPath = path.join(taskFolderPath, FAIL_LOG_FILE);
      if (!fs.existsSync(failLogPath)) {
        return null;
      }
      return fs.readFileSync(failLogPath, 'utf8');
    },

    writeArchivedFailLog(fileName, content) {
      fs.writeFileSync(path.join(taskFolderPath, fileName), content, 'utf8');
    },

    clearFailLog() {
      const failLogPath = path.join(taskFolderPath, FAIL_LOG_FILE);
      if (fs.existsSync(failLogPath)) {
        fs.unlinkSync(failLogPath);
      }
    },

    readRequestText() {
      const requestPath = path.join(taskFolderPath, REQUEST_FILE);
      if (!fs.existsSync(requestPath)) {
        return null;
      }
      return fs.readFileSync(requestPath, 'utf8');
    },

    listContextFilePaths() {
      const contextDir = path.join(taskFolderPath, 'context');
      if (!fs.existsSync(contextDir)) {
        return [];
      }

      return fs
        .readdirSync(contextDir, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => path.join(contextDir, entry.name));
    },

    listAttachedFileNames() {
      const attachedDir = path.join(taskFolderPath, ATTACHED_FILES_DIR);
      if (!fs.existsSync(attachedDir)) {
        return [];
      }

      return fs
        .readdirSync(attachedDir, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name);
    },

    writeAttachedFile(fileName, buffer) {
      const attachedDir = path.join(taskFolderPath, ATTACHED_FILES_DIR);
      fs.mkdirSync(attachedDir, { recursive: true });
      fs.writeFileSync(path.join(attachedDir, fileName), buffer);
    },

    readSavedAttachmentSources() {
      const manifestPath = path.join(taskFolderPath, SAVED_ATTACHMENT_SOURCES_FILE);
      if (!fs.existsSync(manifestPath)) {
        return null;
      }
      return fs.readFileSync(manifestPath, 'utf8');
    },

    writeSavedAttachmentSources(content) {
      fs.writeFileSync(
        path.join(taskFolderPath, SAVED_ATTACHMENT_SOURCES_FILE),
        content,
        'utf8',
      );
    },

    listAttachedFilePaths() {
      const attachedDir = path.join(taskFolderPath, ATTACHED_FILES_DIR);
      if (!fs.existsSync(attachedDir)) {
        return [];
      }

      return fs
        .readdirSync(attachedDir, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => path.join(attachedDir, entry.name));
    },

    hasApprovalRequest() {
      return fs.existsSync(path.join(taskFolderPath, APPROVAL_REQUEST_FILE));
    },

    hasApprovalApproveFile() {
      return fs.existsSync(path.join(taskFolderPath, APPROVAL_APPROVE_FILE));
    },

    hasApprovalSkipFile() {
      return fs.existsSync(path.join(taskFolderPath, APPROVAL_SKIP_FILE));
    },

    readApprovalRequest() {
      const approvalPath = path.join(taskFolderPath, APPROVAL_REQUEST_FILE);
      if (!fs.existsSync(approvalPath)) {
        return null;
      }
      return fs.readFileSync(approvalPath, 'utf8');
    },

    writeApprovalRequest(content) {
      fs.writeFileSync(
        path.join(taskFolderPath, APPROVAL_REQUEST_FILE),
        content,
        'utf8',
      );
    },

    clearApprovalFiles() {
      for (const fileName of [
        APPROVAL_REQUEST_FILE,
        APPROVAL_APPROVE_FILE,
        APPROVAL_SKIP_FILE,
      ]) {
        const filePath = path.join(taskFolderPath, fileName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    },

    async downloadRequestAudioTo(tempDir) {
      const audioPath = this.findRequestAudioPath();
      if (!audioPath) {
        return null;
      }

      const destination = path.join(tempDir, path.basename(audioPath));
      fs.copyFileSync(audioPath, destination);
      return destination;
    },
  };
}

export function createDriveApiTaskFolder(connection, parentFolderId, taskFolderName) {
  let taskFolderId = null;
  let cachedEntries = null;

  async function loadTaskFolderId() {
    if (taskFolderId) {
      return taskFolderId;
    }

    const query = [
      "mimeType='application/vnd.google-apps.folder'",
      'trashed=false',
      `name='${taskFolderName.replace(/'/g, "\\'")}'`,
      `'${parentFolderId}' in parents`,
    ].join(' and ');

    const result = await driveApiRequest(
      connection,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    );
    taskFolderId = result.files?.[0]?.id ?? null;
    return taskFolderId;
  }

  async function listFileEntries() {
    const folderId = await loadTaskFolderId();
    if (!folderId) {
      return [];
    }

    const result = await driveApiRequest(
      connection,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        `'${folderId}' in parents and trashed=false`,
      )}&fields=files(id,name,mimeType)`,
    );

    cachedEntries = result.files ?? [];
    return cachedEntries;
  }

  async function findFileByName(name) {
    const entries = await listFileEntries();
    return entries.find(entry => entry.name === name) ?? null;
  }

  async function readTextFileByName(name) {
    const file = await findFileByName(name);
    if (!file) {
      return null;
    }

    const response = await driveApiRequest(
      connection,
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
    );
    return response.text();
  }

  async function findChildFolderId(parentId, folderName) {
    const query = [
      "mimeType='application/vnd.google-apps.folder'",
      'trashed=false',
      `name='${folderName.replace(/'/g, "\\'")}'`,
      `'${parentId}' in parents`,
    ].join(' and ');

    const result = await driveApiRequest(
      connection,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    );
    return result.files?.[0]?.id ?? null;
  }

  async function readStateFileContent() {
    const stateFile = await findFileByName(TASK_STATE_FILE);
    if (!stateFile) {
      return null;
    }

    const response = await driveApiRequest(
      connection,
      `https://www.googleapis.com/drive/v3/files/${stateFile.id}?alt=media`,
    );
    return response.text();
  }

  async function writeTextFileInFolder(fileName, text) {
    const folderId = await loadTaskFolderId();
    if (!folderId) {
      throw new Error(`Task folder not found: ${taskFolderName}`);
    }

    const existing = await findFileByName(fileName);
    if (existing) {
      await driveApiRequest(
        connection,
        `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
          body: text,
        },
      );
      return;
    }

    const created = await driveApiRequest(connection, 'https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fileName,
        parents: [folderId],
        mimeType: 'text/plain',
      }),
    });

    await driveApiRequest(
      connection,
      `https://www.googleapis.com/upload/drive/v3/files/${created.id}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        body: text,
      },
    );
    cachedEntries = null;
  }

  async function ensureAttachedFilesFolderId() {
    const parentId = await loadTaskFolderId();
    if (!parentId) {
      throw new Error(`Task folder not found: ${taskFolderName}`);
    }

    const existingId = await findChildFolderId(parentId, ATTACHED_FILES_DIR);
    if (existingId) {
      return existingId;
    }

    const created = await driveApiRequest(connection, 'https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ATTACHED_FILES_DIR,
        parents: [parentId],
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });

    cachedEntries = null;
    return created.id;
  }

  async function writeBinaryFileInAttachedFolder(fileName, buffer) {
    const folderId = await ensureAttachedFilesFolderId();
    const mimeType = guessMimeType(fileName);
    const entries = await listFileEntries();
    const existing = entries.find(entry => entry.name === fileName);

    if (existing) {
      await driveApiRequest(
        connection,
        `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': mimeType },
          body: buffer,
        },
      );
      return;
    }

    const created = await driveApiRequest(connection, 'https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fileName,
        parents: [folderId],
        mimeType,
      }),
    });

    await driveApiRequest(
      connection,
      `https://www.googleapis.com/upload/drive/v3/files/${created.id}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': mimeType },
        body: buffer,
      },
    );
    cachedEntries = null;
  }

  async function deleteFileByName(name) {
    const file = await findFileByName(name);
    if (!file) {
      return;
    }

    await driveApiRequest(
      connection,
      `https://www.googleapis.com/drive/v3/files/${file.id}`,
      { method: 'DELETE' },
    );
    cachedEntries = null;
  }

  async function writeStateFileContent(state) {
    const folderId = await loadTaskFolderId();
    if (!folderId) {
      throw new Error(`Task folder not found: ${taskFolderName}`);
    }

    const existing = await findFileByName(TASK_STATE_FILE);
    if (existing) {
      await driveApiRequest(
        connection,
        `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
          body: state,
        },
      );
      return;
    }

    const created = await driveApiRequest(connection, 'https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: TASK_STATE_FILE,
        parents: [folderId],
        mimeType: 'text/plain',
      }),
    });

    await driveApiRequest(
      connection,
      `https://www.googleapis.com/upload/drive/v3/files/${created.id}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        body: state,
      },
    );
    cachedEntries = null;
  }

  return {
    mode: 'drive_api',
    taskFolderName,

    async getState() {
      const content = await readStateFileContent();
      return content === null ? null : parseTaskState(content);
    },

    async hasState(state) {
      return (await this.getState()) === state;
    },

    async setState(state) {
      await writeStateFileContent(state);
    },

    async findRequestAudioName() {
      const entries = await listFileEntries();
      return (
        entries.find(entry => {
          if (!entry.name.startsWith('request.')) {
            return false;
          }
          return entry.name !== 'request.txt';
        })?.name ?? null
      );
    },

    async writeRequestText(text) {
      await writeTextFileInFolder('request.txt', text);
    },

    async writeRequestSummary(text) {
      await writeTextFileInFolder(REQUEST_SUMMARY_FILE, text);
    },

    async writePromptText(text) {
      await writeTextFileInFolder(PROMPT_FILE, text);
    },

    async readPromptText() {
      return readTextFileByName(PROMPT_FILE);
    },

    async clearPromptText() {
      await deleteFileByName(PROMPT_FILE);
    },

    async writeResponseText(text) {
      await writeTextFileInFolder(RESPONSE_FILE, text);
    },

    async readResponseText() {
      return readTextFileByName(RESPONSE_FILE);
    },

    async clearResponseText() {
      await deleteFileByName(RESPONSE_FILE);
    },

    async readDispatchAttemptCount() {
      const content = await readTextFileByName(DISPATCH_ATTEMPTS_FILE);
      if (content === null) {
        return 0;
      }

      const parsed = Number.parseInt(content.trim(), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    },

    async writeDispatchAttemptCount(count) {
      await writeTextFileInFolder(DISPATCH_ATTEMPTS_FILE, String(count));
    },

    async clearDispatchAttemptCount() {
      await deleteFileByName(DISPATCH_ATTEMPTS_FILE);
    },

    async writeComposerId(composerId) {
      await writeTextFileInFolder(COMPOSER_ID_FILE, composerId);
    },

    async readComposerId() {
      const content = await readTextFileByName(COMPOSER_ID_FILE);
      const value = content?.trim();
      return value ? value : null;
    },

    async clearComposerId() {
      await deleteFileByName(COMPOSER_ID_FILE);
    },

    async writeFailLog(content) {
      await writeTextFileInFolder(FAIL_LOG_FILE, content);
    },

    async readFailLog() {
      return readTextFileByName(FAIL_LOG_FILE);
    },

    async writeArchivedFailLog(fileName, content) {
      await writeTextFileInFolder(fileName, content);
    },

    async clearFailLog() {
      await deleteFileByName(FAIL_LOG_FILE);
    },

    async readRequestText() {
      return readTextFileByName('request.txt');
    },

    async listContextFilePaths() {
      const folderId = await loadTaskFolderId();
      if (!folderId) {
        return [];
      }

      const contextFolderId = await findChildFolderId(folderId, 'context');
      if (!contextFolderId) {
        return [];
      }

      const result = await driveApiRequest(
        connection,
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
          `'${contextFolderId}' in parents and trashed=false`,
        )}&fields=files(name,mimeType)`,
      );

      return (result.files ?? [])
        .filter(file => file.mimeType !== 'application/vnd.google-apps.folder')
        .map(file => `${taskFolderName}/context/${file.name}`);
    },

    async listAttachedFileNames() {
      const folderId = await loadTaskFolderId();
      if (!folderId) {
        return [];
      }

      const attachedFolderId = await findChildFolderId(folderId, ATTACHED_FILES_DIR);
      if (!attachedFolderId) {
        return [];
      }

      const result = await driveApiRequest(
        connection,
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
          `'${attachedFolderId}' in parents and trashed=false`,
        )}&fields=files(name,mimeType)`,
      );

      return (result.files ?? [])
        .filter(file => file.mimeType !== 'application/vnd.google-apps.folder')
        .map(file => file.name);
    },

    async writeAttachedFile(fileName, buffer) {
      await writeBinaryFileInAttachedFolder(fileName, buffer);
    },

    async readSavedAttachmentSources() {
      return readTextFileByName(SAVED_ATTACHMENT_SOURCES_FILE);
    },

    async writeSavedAttachmentSources(content) {
      await writeTextFileInFolder(SAVED_ATTACHMENT_SOURCES_FILE, content);
    },

    async listAttachedFilePaths() {
      const names = await this.listAttachedFileNames();
      return names.map(name => `${taskFolderName}/${ATTACHED_FILES_DIR}/${name}`);
    },

    async hasApprovalRequest() {
      return Boolean(await findFileByName(APPROVAL_REQUEST_FILE));
    },

    async hasApprovalApproveFile() {
      return Boolean(await findFileByName(APPROVAL_APPROVE_FILE));
    },

    async hasApprovalSkipFile() {
      return Boolean(await findFileByName(APPROVAL_SKIP_FILE));
    },

    async readApprovalRequest() {
      return readTextFileByName(APPROVAL_REQUEST_FILE);
    },

    async writeApprovalRequest(content) {
      await writeTextFileInFolder(APPROVAL_REQUEST_FILE, content);
    },

    async clearApprovalFiles() {
      await deleteFileByName(APPROVAL_REQUEST_FILE);
      await deleteFileByName(APPROVAL_APPROVE_FILE);
      await deleteFileByName(APPROVAL_SKIP_FILE);
    },

    async downloadRequestAudioTo(tempDir) {
      const audioName = await this.findRequestAudioName();
      if (!audioName) {
        return null;
      }

      const audioFile = await findFileByName(audioName);
      if (!audioFile) {
        return null;
      }

      const response = await driveApiRequest(
        connection,
        `https://www.googleapis.com/drive/v3/files/${audioFile.id}?alt=media`,
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      const destination = path.join(tempDir, audioName);
      fs.writeFileSync(destination, buffer);
      return destination;
    },
  };
}

export function listFilesystemChildFolderNames(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return [];
  }

  return fs
    .readdirSync(folderPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

export async function listDriveApiChildFolderNames(connection, parentFolderId) {
  const result = await driveApiRequest(
    connection,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    )}&fields=files(name)`,
  );

  return (result.files ?? []).map(file => file.name);
}
