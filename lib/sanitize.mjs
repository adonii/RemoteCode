const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g;
const WHITESPACE = /\s+/g;

/**
 * Sanitize a single path segment for iCloud / Google Drive folder names.
 */
export function sanitizePathSegment(value, fallback = 'untitled') {
  if (typeof value !== 'string') {
    return fallback;
  }

  let sanitized = value
    .normalize('NFKC')
    .replace(INVALID_CHARS, '')
    .replace(WHITESPACE, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '');

  if (!sanitized) {
    return fallback;
  }

  return sanitized.slice(0, 120);
}
