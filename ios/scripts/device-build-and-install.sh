#!/bin/bash
# 真机自签：bundle runtime -> 构建 iphoneos Debug -> 自动签名 -> 安装 -> 启动。
#
# 用法：
#   DEVELOPMENT_TEAM=ABCDE12345 \
#   BUNDLE_ID=com.yourname.lshell \
#   bash ios/scripts/device-build-and-install.sh
#
# 可选：
#   DEVICE_ID=<UDID>       指定手机；不填则自动选择第一台已连接 iPhone
#   CONFIGURATION=Debug    Debug/Release，默认 Debug
set -euo pipefail

export HTTPS_PROXY="${HTTPS_PROXY:-}"
export HTTP_PROXY="${HTTP_PROXY:-}"
export ALL_PROXY="${ALL_PROXY:-}"

HERE="$(cd "$(dirname "$0")" && pwd)"
IOS_DIR="$(dirname "$HERE")"
cd "$IOS_DIR"

PROJ=ClaudeTerminal.xcodeproj
SCHEME=ClaudeTerminal
CONFIGURATION="${CONFIGURATION:-Debug}"
DERIVED="${DERIVED_DATA_PATH:-/tmp/claude-device-derived}"
BUILD_LOG="${BUILD_LOG:-/tmp/claude-device-build.log}"
INSTALL_LOG="${INSTALL_LOG:-/tmp/claude-device-install.log}"
LAUNCH_LOG="${LAUNCH_LOG:-/tmp/claude-device-launch.log}"

TEAM="${DEVELOPMENT_TEAM:-${TEAM_ID:-}}"
DEFAULT_BUNDLE_SUFFIX="$(id -un | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | cut -c1-20)"
[ -n "$DEFAULT_BUNDLE_SUFFIX" ] || DEFAULT_BUNDLE_SUFFIX="local"
BUNDLE_ID="${BUNDLE_ID:-com.lshell.${DEFAULT_BUNDLE_SUFFIX}.claudeterminal}"
DEVICE_ID="${DEVICE_ID:-${UDID:-}}"

echo "== 0. Xcode 就位检查 =="
xcodebuild -version || { echo "Xcode 未装好"; exit 1; }
xcrun devicectl --version >/dev/null

echo "== 1. 选择真机 =="
if [ -z "$DEVICE_ID" ]; then
  DEVICE_LINE="$(
    xcrun xctrace list devices 2>/dev/null |
      awk '/== Devices ==/{flag=1; next} /== Simulators ==/{flag=0} flag {print}' |
      grep -E '\([0-9A-Fa-f-]{8,40}(-[0-9A-Fa-f-]{4,40})*\)' |
      grep -viE 'Mac|MacBook|Simulator' |
      head -1 || true
  )"
  DEVICE_ID="$(printf '%s\n' "$DEVICE_LINE" | sed -E 's/.*\(([0-9A-Fa-f-]{8,40}(-[0-9A-Fa-f-]{4,40})*)\).*/\1/')"
else
  DEVICE_LINE="$DEVICE_ID"
fi

if [ -z "$DEVICE_ID" ]; then
  echo "未检测到已连接 iPhone。请："
  echo "  1) 用 USB 连接 iPhone，并在手机上点“信任此电脑”"
  echo "  2) 关闭锁屏，保持解锁"
  echo "  3) 如设备未自动出现，可手动传 DEVICE_ID=<UDID>"
  echo
  xcrun xctrace list devices || true
  exit 2
fi
echo "  设备: $DEVICE_LINE"

echo "== 2. 生成 runtime / 工程 =="
bash scripts/bundle-runtime.sh
if command -v xcodegen >/dev/null; then
  xcodegen generate >/dev/null
fi

echo "== 3. 真机自动签名构建 =="
echo "  Bundle ID: $BUNDLE_ID"
if [ -n "$TEAM" ]; then
  echo "  Team ID:   $TEAM"
else
  echo "  Team ID:   (未指定，交给 Xcode 从已登录账号推断)"
fi
rm -rf "$DERIVED"

SIGN_ARGS=(
  CODE_SIGN_STYLE=Automatic
  CODE_SIGN_IDENTITY="Apple Development"
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID"
)
if [ -n "$TEAM" ]; then
  SIGN_ARGS+=(DEVELOPMENT_TEAM="$TEAM")
fi

xcodebuild -project "$PROJ" -scheme "$SCHEME" \
  -sdk iphoneos -configuration "$CONFIGURATION" \
  -destination "id=$DEVICE_ID" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  "${SIGN_ARGS[@]}" \
  build >"$BUILD_LOG" 2>&1 || {
    echo "构建失败，最后日志："
    tail -160 "$BUILD_LOG"
    echo "完整日志: $BUILD_LOG"
    exit 3
  }

APP="$(
  find "$DERIVED/Build/Products" -maxdepth 4 -path "*-iphoneos/*.app" 2>/dev/null |
    head -1 || true
)"
if [ -z "$APP" ]; then
  echo "构建结束但未找到 .app；完整日志: $BUILD_LOG"
  exit 4
fi
echo "  产物: $APP"
echo "  构建日志: $BUILD_LOG"

echo "== 4. 安装到 iPhone =="
xcrun devicectl device install app --device "$DEVICE_ID" "$APP" >"$INSTALL_LOG" 2>&1 || {
  echo "安装失败，日志："
  cat "$INSTALL_LOG"
  exit 5
}
cat "$INSTALL_LOG"

echo "== 5. 启动 App =="
xcrun devicectl device process launch \
  --device "$DEVICE_ID" \
  --terminate-existing \
  "$BUNDLE_ID" >"$LAUNCH_LOG" 2>&1 || {
    echo "启动失败，日志："
    cat "$LAUNCH_LOG"
    exit 6
  }
cat "$LAUNCH_LOG"

echo "== 完成 =="
echo "App 已安装并启动。"
