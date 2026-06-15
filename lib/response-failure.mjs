const DAILY_CURSOR_USAGE_BUDGET_PREFIX = 'Daily Cursor usage budget reached';

/**
 * @param {string | null | undefined} responseText
 * @returns {boolean}
 */
export function isDailyCursorUsageBudgetFailure(responseText) {
  return (responseText ?? '')
    .trimStart()
    .toLowerCase()
    .startsWith(DAILY_CURSOR_USAGE_BUDGET_PREFIX.toLowerCase());
}
