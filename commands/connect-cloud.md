---
name: connect-cloud
description: Connect RemotePromptCode to iCloud or Google Drive in plugin settings
---

# Connect cloud storage

RemotePromptCode requires exactly one active cloud provider: **iCloud** or **Google Drive**.

## UI (preferred)

1. Open the **RemotePromptCode** activity bar view.
2. In **Cloud Connection**, connect iCloud or Google Drive, or log out.
3. Or use Command Palette → **RemotePromptCode: Open Cloud Settings** / **RemotePromptCode: Connect Cloud Storage**.

## Rules

- Only one provider can be connected at a time.
- To switch providers or change accounts, log out first.

## CLI (optional)

```bash
node scripts/cloud-connection.mjs status
node scripts/cloud-connection.mjs connect-icloud
node scripts/cloud-connection.mjs connect-google
node scripts/cloud-connection.mjs logout
```

Until a provider is connected, RemotePromptCode plugin functionality stays disabled.

## Project folders

After authentication, each open workspace project gets a cloud folder:

`RemoteCode/<machine_name>/<project_folder>`

Folders are provisioned on connect, startup, and when an Agent session starts.
