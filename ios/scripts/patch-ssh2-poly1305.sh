#!/bin/bash
# patch-ssh2-poly1305.sh — replace ssh2's Emscripten poly1305 module (embedded WASM,
# loaded EAGERLY at ssh2's crypto init on every connection) with a pure-JS stub.
# The jitless iOS runtime has no WebAssembly, so the original abort()s the whole SSH
# connection. L Shell negotiates only aes-ctr (ssh-command.js), so poly1305 (chacha20-
# poly1305 only) is never invoked — the stub just lets the eager init succeed.
# Idempotent + self-healing: safe to run after every `npm install`. Called by
# bundle-runtime.sh so a dependency reinstall can't silently re-break SSH on device.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"          # ios/scripts
REPO="$(cd "$HERE/../.." && pwd)"
SSH2_DIR="$REPO/node-runtime/node_modules/ssh2"
POLY="$SSH2_DIR/lib/protocol/crypto/poly1305.js"
# ssh2 not installed at all → nothing to patch (SSH simply won't work; separate concern).
[ -d "$SSH2_DIR" ] || { echo "patch-ssh2: ssh2 not installed — skipping"; exit 0; }
# ssh2 IS installed but poly1305 isn't where we expect → it moved (ssh2 upgraded). Do NOT
# fail open: shipping the un-stubbed WASM poly1305 aborts EVERY SSH connection on the
# jitless device. Fail loud so the build stops and someone re-points this patch.
if [ ! -f "$POLY" ]; then
  echo "patch-ssh2: ERROR — ssh2 is installed but poly1305 is not at the expected path:" >&2
  echo "    $POLY" >&2
  echo "    (ssh2 likely upgraded and relocated it). SSH would ship with live WASM and" >&2
  echo "    abort on device. Refusing to continue — re-point patch-ssh2-poly1305.sh." >&2
  exit 1
fi
# Already the pure-JS stub? (our stub has this marker; WASM original does not)
if grep -q "LSHELL_POLY1305_PUREJS_STUB" "$POLY"; then echo "patch-ssh2: poly1305 already stubbed"; exit 0; fi
cat > "$POLY" << 'JSEOF'
'use strict';
// LSHELL_POLY1305_PUREJS_STUB — pure-JS replacement for ssh2's Emscripten poly1305.
// The original embeds a WASM binary loaded EAGERLY at ssh2's crypto init (every
// connection, before cipher negotiation). The jitless iOS runtime has no
// WebAssembly, so it abort()s the SSH connection. L Shell negotiates only aes-ctr
// ciphers (ssh-command.js), so poly1305 — used solely by chacha20-poly1305 — is
// never invoked. This stub satisfies the module shape so the eager init succeeds
// without WebAssembly; the auth fn throws only if some path ever calls it (it won't).
module.exports = function initPoly1305() {
  const HEAPU8 = new Uint8Array(64);
  return Promise.resolve({
    _malloc() { return 0; },
    HEAPU8,
    cwrap() {
      return function poly1305_auth_unavailable() {
        throw new Error('chacha20-poly1305 needs WebAssembly (unavailable in jitless iOS); L Shell uses aes-ctr');
      };
    },
  });
};
JSEOF
echo "patch-ssh2: replaced poly1305 WASM module with pure-JS stub"
