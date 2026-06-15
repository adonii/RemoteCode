---
name: connect-cloud
description: Connect RemoteCode to iCloud or Google Drive in plugin settings
---

# Connect cloud storage

RemoteCode requires exactly one active cloud provider: **iCloud** or **Google Drive**.

## UI (preferred)

1. Open the **RemoteCode** activity bar view.
2. In **Cloud Connection**, connect iCloud or Google Drive, or log out.
3. Or use Command Palette → **RemoteCode: Open Cloud Settings** / **RemoteCode: Connect Cloud Storage**.

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

Until a provider is connected, RemoteCode plugin functionality stays disabled.

## Project folders

After authentication, each open workspace project gets a cloud folder:

`RemoteCode/<machine_name>/<project_folder>`

Folders are provisioned on connect, startup, and when an Agent session starts.
