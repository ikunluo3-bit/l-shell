#!/bin/bash
# Build the N-API addon directly with clang (no node-gyp needed — we have the
# 18.20.4 headers). macOS loadable module: -bundle -undefined dynamic_lookup
# (addon symbols like napi_* resolve from the host node process at load time).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INC="${NODE_INCLUDE:-$(node -e 'console.log(require("path").join(process.execPath,"..","..","include","node"))' 2>/dev/null)}"
mkdir -p "$HERE/build"
# Universal (arm64 + x86_64): loads in the x64 node18 binary (under Rosetta) AND
# in native arm64 node — arm64 being the actual iOS/nodejs-mobile target arch.
# Includes the minimal ios_system runtime + REAL BSD coreutils sources (cat/wc),
# unmodified from the ios_system tree, so a real command runs through the bridge.
# grep is built with fastmatch/lzma/bzip2/NLS stripped -> pure libc regcomp/regexec
# path (still real grep logic; only the literal fast-matcher optimization is off).
# zlib stays (gzip input) -> link -lz.
GREP_DEFS="-DWITHOUT_FASTMATCH -DWITHOUT_LZMA -DWITHOUT_BZIP2 -DWITHOUT_NLS"
clang -O2 -fPIC -bundle -undefined dynamic_lookup \
  -arch arm64 -arch x86_64 \
  -DNODE_GYP_MODULE_NAME=native_bridge \
  -DNO_UDOM_SUPPORT $GREP_DEFS \
  -I"$INC" -I"$HERE/ios-cmds" \
  -o "$HERE/build/native_bridge.node" \
  "$HERE/native_bridge.c" \
  "$HERE/ios-cmds/ios_runtime.c" \
  "$HERE/ios-cmds/cat.c" \
  "$HERE/ios-cmds/wc.c" \
  "$HERE/ios-cmds/grep.c" \
  "$HERE/ios-cmds/util.c" \
  "$HERE/ios-cmds/file.c" \
  "$HERE/ios-cmds/queue.c" \
  -lz
echo "built: $HERE/build/native_bridge.node"
file "$HERE/build/native_bridge.node"
