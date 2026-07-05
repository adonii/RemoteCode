New way of coding - doing it remoteley !
Secure remote coding over your own cloud storage.
No 3rd party servers to track your tasks and steal ideas - you own everything.
Voice or text prompts on your phone gets executed on your laptop. Easy coding with no extra luggage.
No extra cost ! Only one-time purchase of iOS app - to cover development costs. Android (comming up next) version is free.
# RemotePromptCode Cursor Plugin

Walking out your dog? No problem. You still can code.

Stuck in the bathroom with a great idea? Don't just save it to your phone notes — send it to your IDE for implementation.

Can't sleep? Then keep on coding! Your AI subscription will not pay for itself.

On a vacation half a globa away from your workstation ? You still can fix the prod issue.

All communication between your phone and your IDE runs through a secure connection and stays in your own cloud storage — iCloud or Google Drive. No third-party servers, no middlemen. Your data stays within your reach.

Cursor server app that connects to iCloud or Google Drive and orchestrates remote coding tasks from your phone or another device while you're away from your desk.

## Cloud connection (required)

RemotePromptCode stays disabled until you connect **iCloud** or **Google Drive**.

### In Cursor (no terminal)

1. Open the **RemotePromptCode** view in the activity bar (cloud sidebar icon).
2. Use the **Cloud Connection** panel to connect iCloud or Google Drive, or log out.
3. Or run **RemotePromptCode: Open Cloud Settings** / **RemotePromptCode: Connect Cloud Storage** from the Command Palette (`Cmd+Shift+P`).

On first launch, RemotePromptCode also prompts you to open Cloud Settings if nothing is connected yet.

Only one provider can be active at a time. Log out before switching providers or accounts.


## Project cloud folders

On macOS with iCloud, folders sync through the shared **RemoteCode mobile iCloud container**:

`RemoteCode/<machine_name>/<project_folder>`

On startup (and after connecting cloud storage), RemotePromptCode:

1. Provisions a cloud folder for each open workspace project
2. Writes `account.json` in `RemoteCode/<machine_name>/` with Cursor budget and on-demand usage stats

Example machine file: `RemoteCode/warezmac.local/account.json`

Project folders are refreshed when you start an Agent session or send a prompt (`sessionStart` / `beforeSubmitPrompt` hooks).

- iCloud uses iCloud Drive on macOS
- Google Drive uses the desktop sync folder, or the Drive API when `accessToken` is stored
- Illegal filename characters are stripped from every path segment


## Package with vsce

```bash
npm install
npm run package
```

Produces `remotepromptcode-<version>.vsix`. Install in Cursor:

```bash
cursor --install-extension remotepromptcode-0.3.0.vsix
```

Or use **Extensions: Install from VSIX** in the command palette.

### Plugin hooks (sessionStart, beforeSubmitPrompt, etc.)

The VSIX does not declare Cursor proposed APIs (avoids install warnings). Hooks still work if Cursor loads the plugin bundle:

1. **Recommended:** symlink the installed extension (or this repo) to `~/.cursor/plugins/local/RemotePromptCode`, then reload the window.
2. **Extension development:** open this folder and press F5 (Extension Development Host).

The Cloud Connection panel and task monitor work without hooks; hooks add cloud-folder provisioning on session start and prompt submit.
