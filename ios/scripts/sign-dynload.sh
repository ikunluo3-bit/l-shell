#!/bin/bash
# sign-dynload.sh — codesign the CPython lib-dynload *.so modules bundled under
# <app>/python and re-seal the app.
#
# WHY: Xcode signs the app executable, embedded .frameworks (NodeMobile, Python), and
# top-level dylibs — but NOT loose Mach-O files copied in as folder-ref RESOURCES.
# The 68 lib-dynload/*.so are exactly that. On a real device every Mach-O must carry a
# valid signature or dlopen() → "code signature invalid" (errSecCSUnsigned) the moment
# CPython imports the module (import ssl / _decimal / _hashlib / ...). Simulator is
# lax and hides this — device is not.
#
# WHEN: runs as a postBuildScript (after Xcode has signed the app). We sign each .so
# with the build's resolved identity, then re-sign the whole app bundle so its seal
# covers the now-signed .so files.
#
# NO-OP on simulator builds (they don't require signing and $EXPANDED_CODE_SIGN_IDENTITY
# is "-" / adhoc; we still ad-hoc sign so dlopen is happy under hardened checks).
set -euo pipefail

APP="${CODESIGNING_FOLDER_PATH:-}"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "sign-dynload: CODESIGNING_FOLDER_PATH unset or not a dir ($APP) — skipping" >&2
  exit 0
fi

DYNLOAD_DIR="$APP/python/lib/python3.13/lib-dynload"
if [ ! -d "$DYNLOAD_DIR" ]; then
  echo "sign-dynload: no lib-dynload at $DYNLOAD_DIR — nothing to sign" >&2
  exit 0
fi

IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY:-${CODE_SIGN_IDENTITY:--}}"
# EXPANDED_CODE_SIGN_IDENTITY is the SHA-1 hash Xcode resolved; "-" means ad-hoc.
echo "sign-dynload: identity=$IDENTITY  dir=$DYNLOAD_DIR"

# Sign each .so. --timestamp=none (device/dev builds), keep it force so re-runs work.
# No entitlements on the .so themselves (they inherit nothing; they are plain dylibs).
count=0
while IFS= read -r -d '' so; do
  /usr/bin/codesign --force --sign "$IDENTITY" --timestamp=none "$so"
  count=$((count + 1))
done < <(find "$DYNLOAD_DIR" -name '*.so' -type f -print0)
echo "sign-dynload: signed $count .so modules"

# Re-seal the app so its signature covers the freshly-signed resources. Reuse the
# app's own entitlements so we don't strip increased-memory-limit etc.
ENTITLEMENTS_ARG=()
if [ -n "${CODE_SIGN_ENTITLEMENTS:-}" ] && [ -f "${SRCROOT:-.}/$CODE_SIGN_ENTITLEMENTS" ]; then
  ENTITLEMENTS_ARG=(--entitlements "${SRCROOT}/$CODE_SIGN_ENTITLEMENTS")
fi
echo "sign-dynload: re-sealing app bundle $APP"
/usr/bin/codesign --force --sign "$IDENTITY" --timestamp=none \
  "${ENTITLEMENTS_ARG[@]}" "$APP"
echo "sign-dynload: done"
