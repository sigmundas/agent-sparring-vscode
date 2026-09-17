#!/usr/bin/env bash
# Package this extension and install the .vsix into VS Code, for trying a
# development build in a real window (the README documents the same two
# commands). The .vsix itself is gitignored.
set -euo pipefail

# The repository, wherever it is checked out.
cd "$(dirname "$0")"

npm run package:vsix
code --install-extension agent-sparring-vscode-0.1.0.vsix --force

echo
echo "Installed. Now run: Developer: Reload Window"