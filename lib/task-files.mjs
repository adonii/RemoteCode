export const REQUEST_SUMMARY_FILE = 'request_summary.txt';
export const REQUEST_FILE = 'request.txt';
export const RESPONSE_FILE = 'response.txt';
export const RESPONSE_SUMMARY_FILE = 'response_summary.txt';
export const PROMPT_FILE = 'prompt.txt';
export const FAIL_LOG_FILE = 'fail.log';
export const DISPATCH_ATTEMPTS_FILE = '.dispatch-attempts';
export const COMPOSER_ID_FILE = '.composer-id';

export function archivedFailLogFileName(sequence) {
  return `failed.${sequence}.log`;
}
export const APPROVAL_REQUEST_FILE = 'approval.request';
export const APPROVAL_APPROVE_FILE = '.approve';
export const APPROVAL_SKIP_FILE = '.skip';
