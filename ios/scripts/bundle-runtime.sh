#!/bin/bash
# Copy the validated Node runtime (bootstrap + preload shims + bundled Claude Code +
# just-bash) into the app's Resources so it ships inside the .app bundle at "nodejs/".
# Run from anywhere; paths are resolved relative to the repo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # ios/scripts
IOS_DIR="$(dirname "$HERE")"                    # ios
REPO="$(dirname "$IOS_DIR")"                    # repo root
SRC="$REPO/node-runtime"
DST="$IOS_DIR/Resources/nodejs"

echo "Bundling Node runtime:"
echo "  from: $SRC"
echo "  into: $DST"

rm -rf "$DST"
mkdir -p "$DST"

# Core runtime.
cp "$SRC/bootstrap.js" "$DST/"
cp "$SRC/shell.js" "$DST/"
cp "$SRC/package.json" "$DST/"
cp -R "$SRC/preload" "$DST/"
cp -R "$SRC/vendor" "$DST/"

# Dependencies. Copy whole for correctness. Self-heal ssh2's poly1305 (WASM → pure-JS
# stub) BEFORE bundling — SSH aborts on jitless iOS otherwise. No `|| true`: if the patch
# fails loudly (ssh2 moved the file), the whole bundle must stop, not ship broken SSH.
bash "$(dirname "$0")/patch-ssh2-poly1305.sh"

mkdir -p "$DST/node_modules"
cp -R "$SRC/node_modules/." "$DST/node_modules/"

# Prune native-addon packages that can never load in the jitless single-process runtime
# (binding.gyp / prebuilt .node). All are optional deps of ssh2 / just-bash — try/caught
# or lazy — so dropping them is safe; this is the actual "dead weight" removal.
for dead in cpu-features nan @mongodb-js/zstd node-liblzma; do
  rm -rf "$DST/node_modules/$dead"
done

# Assert the poly1305 stub actually landed — a live-WASM ssh2 aborts every SSH connection
# on device. Fail the bundle if the marker is missing rather than shipping broken SSH.
POLY_BUNDLED="$DST/node_modules/ssh2/lib/protocol/crypto/poly1305.js"
if [ -f "$POLY_BUNDLED" ] && ! grep -q "LSHELL_POLY1305_PUREJS_STUB" "$POLY_BUNDLED"; then
  echo "ERROR: bundled ssh2 poly1305 is not the pure-JS stub — SSH would abort on device." >&2
  exit 1
fi

# Drop caches / VCS / non-runtime files.
find "$DST" -name ".DS_Store" -delete 2>/dev/null || true
find "$DST" -type d -name ".git" -prune -exec rm -rf {} + 2>/dev/null || true

echo "Bundled size:"
du -sh "$DST"
echo "Sanity: bootstrap + cli present?"
ls -la "$DST/bootstrap.js" "$DST/vendor/claude-code/cli.js" >/dev/null && echo "  OK"
