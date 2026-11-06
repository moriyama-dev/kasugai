#!/usr/bin/env bash
# Build the release files: kasugai-ssh-<version>.vsix and SHA256SUMS.
# The in-editor updater refuses a .vsix that does not match SHA256SUMS.
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(node -p "require('./package.json').version")"
out="dist"
rm -rf "$out"
mkdir -p "$out"

npm run build
npx vsce package --no-dependencies -o "$out/kasugai-ssh-$version.vsix"
(cd "$out" && sha256sum "kasugai-ssh-$version.vsix" > SHA256SUMS)

cat "$out/SHA256SUMS"
