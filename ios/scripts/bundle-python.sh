#!/bin/bash
# bundle-python.sh — assemble the merged CPython PYTHONHOME that ships inside the app
# bundle at Resources/python (a blue folder ref → copied to <app>/python).
#
# BeeWare's Python.xcframework splits the stdlib in two places (verified layout):
#   • pure-Python stdlib (arch-independent):  <xcframework>/lib/python3.13/**.py
#   • device C-extensions (arch-specific):    <xcframework>/ios-arm64/lib-arm64/
#                                               python3.13/lib-dynload/*.so
#                                             + _sysconfigdata__ios_arm64-iphoneos.py
# CPython's PyConfig.home derives module_search_paths = [home/lib/python3.13,
# home/lib/python3.13/lib-dynload], so BOTH halves must live under one merged home:
#
#   Resources/python/lib/python3.13/**.py                 (pure stdlib)
#   Resources/python/lib/python3.13/lib-dynload/*.so       (device .so)
#   Resources/python/lib/python3.13/_sysconfigdata__*.py   (sysconfig)
#
# Run from anywhere; paths resolve relative to the repo. Idempotent (rebuilds DST).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"       # ios/scripts
IOS_DIR="$(dirname "$HERE")"                # ios

# Source Python.xcframework. Override with LSHELL_PY_XCFRAMEWORK if it lives elsewhere.
PY_XC="${LSHELL_PY_XCFRAMEWORK:-$IOS_DIR/Frameworks/Python.xcframework}"
SLICE="$PY_XC/ios-arm64"

PURE_STDLIB="$PY_XC/lib/python3.13"                        # arch-independent .py
DYNLOAD="$SLICE/lib-arm64/python3.13/lib-dynload"          # device .so
SYSCONFIG="$SLICE/lib-arm64/python3.13/_sysconfigdata__ios_arm64-iphoneos.py"

DST="$IOS_DIR/Resources/python"
DST_STDLIB="$DST/lib/python3.13"

echo "Assembling PYTHONHOME:"
echo "  pure stdlib : $PURE_STDLIB"
echo "  lib-dynload : $DYNLOAD"
echo "  into        : $DST"

for p in "$PURE_STDLIB" "$DYNLOAD" "$SYSCONFIG"; do
  [ -e "$p" ] || { echo "ERROR: missing source: $p" >&2; exit 1; }
done

rm -rf "$DST"
mkdir -p "$DST_STDLIB"

# 1) Pure-Python stdlib. Exclude the multi-MB test tree, __pycache__, and idlelib/
#    turtledemo/tkinter (no Tk on iOS) to keep the bundle lean. Keep everything else.
#    (Adjust the excludes if you need `test`, e.g. for running CPython's own suite.)
rsync -a \
  --exclude 'test/' \
  --exclude 'tests/' \
  --exclude '__pycache__/' \
  --exclude 'idlelib/' \
  --exclude 'turtledemo/' \
  --exclude 'tkinter/' \
  --exclude 'lib2to3/tests/' \
  "$PURE_STDLIB"/ "$DST_STDLIB"/

# 2) Device C-extensions.
mkdir -p "$DST_STDLIB/lib-dynload"
cp -R "$DYNLOAD"/. "$DST_STDLIB/lib-dynload"/

# 3) sysconfig data (import sysconfig needs it on device).
cp "$SYSCONFIG" "$DST_STDLIB/"

# Drop caches / VCS noise.
find "$DST" -name '.DS_Store' -delete 2>/dev/null || true
find "$DST" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo "PYTHONHOME assembled:"
du -sh "$DST"
echo "Sanity: os.py + encodings + a .so present?"
ls "$DST_STDLIB/os.py" >/dev/null
ls -d "$DST_STDLIB/encodings" >/dev/null
ls "$DST_STDLIB/lib-dynload"/*.so >/dev/null && echo "  OK ($(ls "$DST_STDLIB/lib-dynload"/*.so | wc -l | tr -d ' ') .so modules)"
