#!/bin/bash
set -euo pipefail

CONFIG_PATH="${HOME}/.remotecode/cloud-connection.json"

if [[ -f "$CONFIG_PATH" ]]; then
  provider="$(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(data.provider||'');" "$CONFIG_PATH" 2>/dev/null || true)"
  email="$(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(data.accountEmail||'');" "$CONFIG_PATH" 2>/dev/null || true)"

  if [[ "$provider" == "icloud" || "$provider" == "google_drive" ]] && [[ -n "$email" ]]; then
    echo '{ "permission": "allow" }'
    exit 0
  fi
fi

cat <<'EOF'
{
  "permission": "deny",
  "user_message": "RemotePromptCode is disabled until you connect iCloud or Google Drive. Open the RemotePromptCode sidebar → Cloud Connection, or run RemotePromptCode: Open Cloud Settings from the Command Palette.",
  "agent_message": "Cloud connection is required. Ask the user to open RemotePromptCode → Cloud Connection in the activity bar, run RemotePromptCode: Open Cloud Settings, or use /connect-cloud. Only one provider may be active at a time; log out before switching."
}
EOF
exit 2
