#!/usr/bin/env bash
#
# start-macos.sh —— 一键启动 macOS 悬浮面板
#
# 流程:
#   1) curl 探测悬浮窗服务 http://127.0.0.1:17873/api/live;
#      不通则以 nohup 拉起本目录 server.mjs --cwd "$PWD" --port 17873(日志写入 /tmp);
#   2) 确保面板已编译,未编译则调用同目录 build-macos.sh;
#   3) 直接执行 build/OverlayPanel.app/Contents/MacOS/OverlayPanel。
#
# 用法:./start-macos.sh [面板URL]
#       额外参数原样透传给面板二进制;不传时面板默认加载 http://127.0.0.1:17873/。

set -euo pipefail

# 脚本所在目录(overlay/);刻意不改变当前工作目录,保证 --cwd 传的是调用时的 "$PWD"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="17873"
BASE_URL="http://127.0.0.1:${PORT}"
PROBE_URL="${BASE_URL}/api/live"
SERVER_JS="${SCRIPT_DIR}/server.mjs"
SERVER_LOG="/tmp/zcode-tps-overlay-server.log"
BUILD_SCRIPT="${SCRIPT_DIR}/build-macos.sh"
PANEL_BIN="${SCRIPT_DIR}/build/OverlayPanel.app/Contents/MacOS/OverlayPanel"

probe_server() {
    curl -fsS --max-time 2 "$PROBE_URL" >/dev/null 2>&1
}

# ---- 1) 探测 / 拉起悬浮窗服务 ----
if probe_server; then
    echo "[start-macos] 悬浮窗服务已就绪:${PROBE_URL}"
else
    echo "[start-macos] 服务未响应(${PROBE_URL}),尝试拉起 ${SERVER_JS}"
    if [ ! -f "$SERVER_JS" ]; then
        echo "[start-macos] 错误:overlay/ 下不存在 server.mjs(悬浮窗服务由服务侧提供),无法自动拉起" >&2
        exit 1
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo "[start-macos] 错误:未找到 node,无法拉起悬浮窗服务" >&2
        exit 1
    fi
    # nohup 后台拉起,日志写入 /tmp
    nohup node "$SERVER_JS" --cwd "$PWD" --port "$PORT" >"$SERVER_LOG" 2>&1 &
    echo "[start-macos] 服务启动中(日志:${SERVER_LOG})……"
    # 最多等待约 8 秒,轮询 /api/live 直到就绪
    ready=0
    for _ in $(seq 1 32); do
        if probe_server; then
            ready=1
            break
        fi
        sleep 0.25
    done
    if [ "$ready" -ne 1 ]; then
        echo "[start-macos] 错误:服务在等待窗口内未就绪,请查看日志:${SERVER_LOG}" >&2
        exit 1
    fi
    echo "[start-macos] 悬浮窗服务已就绪:${PROBE_URL}"
fi

# ---- 2) 确保面板已编译(未编译则现编译)----
if [ ! -x "$PANEL_BIN" ]; then
    echo "[start-macos] 面板未编译,调用 ${BUILD_SCRIPT}……"
    bash "$BUILD_SCRIPT"
fi
if [ ! -x "$PANEL_BIN" ]; then
    echo "[start-macos] 错误:编译后仍未找到可执行文件 ${PANEL_BIN}" >&2
    exit 1
fi

# ---- 3) 直接执行面板(前台运行,关闭面板即退出)----
echo "[start-macos] 启动悬浮面板:${PANEL_BIN}"
exec "$PANEL_BIN" "$@"
