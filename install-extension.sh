#!/usr/bin/env bash
# Package this extension and install the .vsix into VS Code, for trying a
# development build in a real window (the README documents the same two
# commands). The .vsix itself is gitignored.
set -euo pipefail

# The repository, wherever it is checked out.
cd "$(dirname "$0")"

# The name vsce will write, asked of package.json rather than spelled out here.
# A hardcoded version is silently wrong the moment one is bumped: vsce writes
# the new file, the old one is still lying around untracked, and installing it
# succeeds while putting the previous build back — a stale window with nothing
# to say it is stale.
VSIX="$(node -p 'const p = require("./package.json"); `${p.name}-${p.version}.vsix`')"

# So that a packaging failure cannot leave yesterday's file to be installed.
rm -f "$VSIX"

npm run package:vsix

# vsce is the one that decides the filename; if this ever stops matching, say so
# rather than installing whatever else is in the directory.
if [[ ! -f "$VSIX" ]]; then
  echo "Expected $VSIX after packaging, but it is not there." >&2
  exit 1
fi

code --install-extension "$VSIX" --force

echo
echo "Installed $VSIX. Now run: Developer: Reload Window"
