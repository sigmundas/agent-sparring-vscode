#!/usr/bin/env bash
set -euo pipefail

cd /Users/sigmundas/Documents/Code/agent-sparring-vscode

npm run package:vsix
code --install-extension agent-sparring-vscode-0.1.0.vsix --force

echo
echo "Installed. Now run: Developer: Reload Window"