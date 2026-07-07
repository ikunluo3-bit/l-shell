#!/bin/bash
# Regression runner for the iOS Claude Code runtime shims.
# Runs JS-layer shim tests under Node 18.20.4 and the host Node with --jitless.
# This validates the fork/WASM/TTY shims, but it does not prove the embedded iOS
# framework has ICU. Use the in-app `icucheck` command on simulator/device for
# the Unicode property regexp / Intl ground truth.
#
# Usage: bash test/run-all.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

NODE24="$(command -v node)"
NODE18="${NODE18:-/private/tmp/node-v18.20.4-darwin-x64/bin/node}"

run_suite() {
  local label="$1" nodebin="$2"
  if [ ! -x "$nodebin" ]; then echo "SKIP $label (no node at $nodebin)"; return; fi
  echo "=================== $label ($($nodebin -v)) ==================="
  for t in test/test-fetch.mjs test/test-shims.mjs \
           test/test-fetch-fixes.mjs test/test-ripgrep-fixes.mjs \
           test/test-interrupt-fixes.mjs test/test-intl-fixes.mjs \
           test/test-session-fixes.mjs test/test-shell-return.mjs \
           test/test-pty.mjs; do
    echo "--- $t ---"
    "$nodebin" --jitless "$t" 2>&1 | grep -E "✓|✗|RESULT|FAIL"
  done
  echo "--- bootstrap smoke (cli.js --version) ---"
  HOME="$ROOT/scratch-home" CLAUDE_CONFIG_DIR="$ROOT/scratch-home/.claude" \
  DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 USE_BUILTIN_RIPGREP=0 \
    "$nodebin" --jitless --require "$ROOT/test/ios-env-only.js" \
    "$ROOT/node-runtime/bootstrap.js" --version 2>&1 | grep -vE "^Warning"
  echo "--- full agent loop (mock backend: stream → tool_use → real tool exec → finish) ---"
  NODE="$nodebin" node "$ROOT/test/test-agent-loop.mjs" 2>&1 | grep -E "AGENT LOOP|proof.txt (created|content)"
  echo
}

run_suite "TARGET Node 18.20.4" "$NODE18"
run_suite "HOST Node" "$NODE24"
echo "--- iOS app static checks (plist/project.yml/swiftc -parse) ---"
node test/test-ios-app.mjs 2>&1 | tail -3
echo "Done. (For an interactive TUI check: NODE=\$NODE18 node test/interactive-probe.mjs)"
