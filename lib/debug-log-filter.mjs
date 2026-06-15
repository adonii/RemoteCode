export const DEBUG_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * @param {{ timestamp?: number | string }} entry
 * @returns {number}
 */
export function entryTimestampMs(entry) {
  const value = entry?.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

/**
 * @template T extends { timestamp?: number | string }
 * @param {T[]} entries
 * @param {number} limit
 * @param {number} [maxAgeMs]
 * @returns {T[]}
 */
export function filterRecentLogEntries(entries, limit, maxAgeMs = DEBUG_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;

  return entries
    .filter(entry => entryTimestampMs(entry) >= cutoff)
    .sort((left, right) => entryTimestampMs(right) - entryTimestampMs(left))
    .slice(0, limit);
}
