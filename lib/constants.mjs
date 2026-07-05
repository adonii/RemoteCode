/** @type {'RemotePromptCode'} */
export const APP_NAME = 'RemotePromptCode';

export const APP_SLUG = APP_NAME.toLowerCase();

/** @type {'RemoteCode'} */
export const CLOUD_APP_NAME = 'RemoteCode';

export const CLOUD_APP_SLUG = CLOUD_APP_NAME.toLowerCase();

/** Local config dir — unchanged from RemoteCode installs */
export const CONFIG_DIR_NAME = `.${CLOUD_APP_SLUG}`;

/** Shared iCloud container for server + mobile client folder sync */
export const ICLOUD_CONTAINER_ID = `iCloud.com.${CLOUD_APP_SLUG}.mobile`;

/** Top-level folder inside the iCloud container / Google Drive sync root */
export const CLOUD_ROOT_FOLDER = CLOUD_APP_NAME;

export const LOG_PREFIX = `[${APP_NAME}]`;
