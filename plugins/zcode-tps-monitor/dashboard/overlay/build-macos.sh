#!/usr/bin/env bash
#
# build-macos.sh —— 用 swiftc 编译 OverlayPanel.swift 并组装 OverlayPanel.app
#
# 用法:./build-macos.sh
# 产物:./build/OverlayPanel.app(Contents/MacOS/OverlayPanel 二进制 + Contents/Info.plist)
# 特性:幂等(每次全量重建,先清理旧产物);任何一步失败立即以非零码退出。

set -euo pipefail

# 定位到脚本所在目录(overlay/),保证在任意工作目录下执行都正确
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="OverlayPanel"
SWIFT_SOURCE="${APP_NAME}.swift"
APP_DIR="build/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"

# ---- 前置检查 ----
if ! command -v swiftc >/dev/null 2>&1; then
    echo "[build-macos] 错误:未找到 swiftc,请先安装 Xcode Command Line Tools(xcode-select --install)" >&2
    exit 1
fi
if [ ! -f "$SWIFT_SOURCE" ]; then
    echo "[build-macos] 错误:缺少源码文件 ${SWIFT_SOURCE}" >&2
    exit 1
fi

# ---- 幂等:先清理旧产物,再全量重建 ----
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

# ---- 1) swiftc 编译(Swift 6 语言模式;AppKit/WebKit 由 import 自动链接)----
echo "[build-macos] swiftc 编译 ${SWIFT_SOURCE}(-swift-version 6)……"
#   -parse-as-library:允许源文件使用 @main(否则单文件被当作含顶层代码的 main 文件)
#   -target arm64-apple-macos12.0:部署目标 macOS 12,与 Info.plist 的 LSMinimumSystemVersion 一致
swiftc \
    -swift-version 6 \
    -parse-as-library \
    -target arm64-apple-macos12.0 \
    -O \
    -o "${MACOS_DIR}/${APP_NAME}" \
    "$SWIFT_SOURCE"

# ---- 2) 组装 Info.plist(LSUIElement=true:无 Dock 图标、无菜单栏)----
echo "[build-macos] 生成 Info.plist……"
cat > "${CONTENTS_DIR}/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>zh_CN</string>
    <key>CFBundleExecutable</key>
    <string>OverlayPanel</string>
    <key>CFBundleIdentifier</key>
    <string>com.zcode.tps.overlay-panel</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>OverlayPanel</string>
    <key>CFBundleDisplayName</key>
    <string>ZCode TPS Overlay</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <!-- 附件型应用:无 Dock 图标、无菜单栏(代码中另有 setActivationPolicy(.accessory) 双保险) -->
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <!-- 悬浮窗服务仅为本机回环地址,显式放行本地网络 -->
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
PLIST

# ---- 3) 校验产物完整性 ----
if [ ! -x "${MACOS_DIR}/${APP_NAME}" ] || [ ! -f "${CONTENTS_DIR}/Info.plist" ]; then
    echo "[build-macos] 错误:产物校验失败(缺二进制或 Info.plist)" >&2
    exit 1
fi

echo "[build-macos] 完成:${APP_DIR}"
