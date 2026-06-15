/** @type {'RemoteCode'} */
export const APP_NAME = 'RemoteCode';

export const APP_SLUG = APP_NAME.toLowerCase();

/** Cursor plugin identifier and display name */
export const PLUGIN_NAME = APP_NAME;

export const CONFIG_DIR_NAME = `.${APP_SLUG}`;

/** Shared iCloud container for server + mobile client folder sync */
export const ICLOUD_CONTAINER_ID = `iCloud.com.${APP_SLUG}.mobile`;

export const LOG_PREFIX = `[${APP_NAME}]`;

export const TASK_PROMPT_PREFIX = `[${APP_NAME} Task:`;

/** @type {readonly ['cursor', 'claude']} */
export const SERVER_APPS = ['cursor', 'claude'];

/** @type {readonly ['mobile', 'iwatch', 'garmin']} */
export const CLIENT_APPS = ['mobile', 'iwatch', 'garmin'];
