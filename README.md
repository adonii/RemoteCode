# RemoteCode Cursor Plugin

Cursor **server app** for [RemoteCode](https://github.com/adonii/RemoteCode).

Client apps (mobile, watch, etc.) live in the [RemoteCode monorepo](https://github.com/remotecode/RemoteCode).

## Cloud connection (required)

RemoteCode stays disabled until you connect **iCloud** or **Google Drive**.

### In Cursor (no terminal)

1. Open the **RemoteCode** view in the activity bar (cloud sidebar icon).
2. Use the **Cloud Connection** panel to connect iCloud or Google Drive, or log out.
3. Or run **RemoteCode: Open Cloud Settings** / **RemoteCode: Connect Cloud Storage** from the Command Palette (`Cmd+Shift+P`).

On first launch, RemoteCode also prompts you to open Cloud Settings if nothing is connected yet.

Only one provider can be active at a time. Log out before switching providers or accounts.

### CLI (optional)

```bash
node scripts/cloud-connection.mjs status
node scripts/cloud-connection.mjs connect-icloud
node scripts/cloud-connection.mjs connect-google
node scripts/cloud-connection.mjs logout
```

Use `/connect-cloud` in Cursor chat for the guided connect flow.

Connection state is stored in `~/.remotecode/cloud-connection.json` (derived from `APP_SLUG` in `shared/constants.mjs`).

## Project cloud folders

On macOS with iCloud, folders sync through the shared **RemoteCode mobile iCloud container**:

`RemoteCode/<machine_name>/<project_folder>`

On startup (and after connecting cloud storage), RemoteCode:

1. Provisions a cloud folder for each open workspace project
2. Writes `account.json` in `RemoteCode/<machine_name>/` with Cursor budget and on-demand usage stats

Example machine file: `RemoteCode/warezmac.local/account.json`

Project folders are refreshed when you start an Agent session or send a prompt (`sessionStart` / `beforeSubmitPrompt` hooks).

- iCloud uses iCloud Drive on macOS
- Google Drive uses the desktop sync folder, or the Drive API when `accessToken` is stored
- Illegal filename characters are stripped from every path segment

## Local development

1. Symlink or copy this folder to `~/.cursor/plugins/local/RemoteCode` (plugin name matches `APP_NAME` in `shared/constants.mjs`)
2. Reload the Cursor window
3. Connect a cloud provider before using plugin features

When developing inside the RemoteCode monorepo, `npm run sync-shared` copies `../shared/constants.mjs` into this repo. In a standalone checkout, `shared/constants.mjs` is committed here.

## Package with vsce

```bash
npm install
npm run package
```

Produces `remotecode-<version>.vsix`. Install in Cursor:

```bash
cursor --install-extension remotecode-0.3.0.vsix
```

Or use **Extensions: Install from VSIX** in the command palette.

### Plugin hooks (sessionStart, beforeSubmitPrompt, etc.)

The VSIX does not declare Cursor proposed APIs (avoids install warnings). Hooks still work if Cursor loads the plugin bundle:

1. **Recommended:** symlink the installed extension (or this repo) to `~/.cursor/plugins/local/RemoteCode`, then reload the window.
2. **Extension development:** open this folder and press F5 (Extension Development Host).

The Cloud Connection panel and task monitor work without hooks; hooks add cloud-folder provisioning on session start and prompt submit.
