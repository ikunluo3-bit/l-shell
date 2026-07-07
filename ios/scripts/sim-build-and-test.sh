#!/bin/bash
# 下完 Xcode 后一键：构建模拟器版 → 启动模拟器 → 装 App → 拉起 → 截图。
# 用法：bash ios/scripts/sim-build-and-test.sh
set -euo pipefail
export HTTPS_PROXY="${HTTPS_PROXY:-}" HTTP_PROXY="${HTTP_PROXY:-}" ALL_PROXY="${ALL_PROXY:-}"

HERE="$(cd "$(dirname "$0")" && pwd)"; IOS_DIR="$(dirname "$HERE")"; cd "$IOS_DIR"
PROJ=ClaudeTerminal.xcodeproj
SCHEME=ClaudeTerminal
BUNDLE_ID=com.example.claudeterminal
DERIVED=/tmp/claude-derived
BUILD_LOG=/tmp/claude-sim-build.log
LAUNCH_LOG=/tmp/claude-sim-launch.log

echo "== 0. Xcode 就位检查 =="
xcodebuild -version || { echo "Xcode 未装好"; exit 1; }

echo "== 1. 选一个 iPhone 模拟器 =="
DEV=$(xcrun simctl list devices booted | grep -oE "iPhone [0-9][0-9A-Za-z ]*\([0-9A-F-]{36}\)" | head -1 || true)
if [ -z "$DEV" ]; then
  DEV=$(xcrun simctl list devices available | grep -oE "iPhone [0-9][0-9A-Za-z ]*\([0-9A-F-]{36}\)" | head -1 || true)
fi
UDID=$(echo "$DEV" | grep -oE "[0-9A-F-]{36}")
echo "  设备: $DEV"
if [ -z "$UDID" ]; then
  echo "  无可用模拟器运行时！需要先装：xcodes runtimes install 'iOS 27' （或 xcrun simctl runtime）"
  xcrun simctl list runtimes; exit 2
fi

echo "== 2. 生成工程（确保最新） =="
command -v xcodegen >/dev/null && xcodegen generate >/dev/null 2>&1

echo "== 3. 构建模拟器版（免签名） =="
rm -rf "$DERIVED"
xcodebuild -project "$PROJ" -scheme "$SCHEME" \
  -sdk iphonesimulator -configuration Debug \
  -destination "id=$UDID" -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build >"$BUILD_LOG" 2>&1 || { tail -120 "$BUILD_LOG"; exit 3; }
APP=$(find "$DERIVED/Build/Products" -name "*.app" -maxdepth 3 2>/dev/null | head -1)
[ -z "$APP" ] && { echo "构建失败：未产出 .app"; exit 3; }
echo "  产物: $APP"
echo "  构建日志: $BUILD_LOG"

echo "== 3.5 模拟器 ad-hoc 签名（否则 dyld 会拒绝加载嵌入 framework） =="
if command -v codesign >/dev/null; then
  if [ -d "$APP/Frameworks" ]; then
    find "$APP/Frameworks" -maxdepth 1 -name "*.framework" -type d -print0 |
      while IFS= read -r -d '' fw; do
        codesign --force --sign - --timestamp=none "$fw" >/dev/null
      done
  fi
  codesign --force --deep --sign - --timestamp=none "$APP" >/dev/null
  codesign --verify --deep --strict "$APP"
  echo "  OK"
fi

echo "== 4. 启动模拟器 + 装 + 拉起 =="
xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator 2>/dev/null || true
sleep 3
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch --console-pty "$UDID" "$BUNDLE_ID" >"$LAUNCH_LOG" 2>&1 &
LAUNCH_PID=$!
sleep 6
if grep -q "Library not loaded\\|not valid for use in process\\|Terminating app" "$LAUNCH_LOG"; then
  echo "启动失败日志:"
  cat "$LAUNCH_LOG"
  exit 4
fi
echo "== 5. 截图 =="
xcrun simctl io "$UDID" screenshot /tmp/claude-sim-shot.png && echo "  截图: /tmp/claude-sim-shot.png"
echo "  启动日志: $LAUNCH_LOG"
echo "  启动 PID: $LAUNCH_PID"
echo "== 完成。查看 /tmp/claude-sim-shot.png 看首屏。=="
