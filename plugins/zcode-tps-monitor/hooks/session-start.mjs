#!/usr/bin/env node
// SessionStart hook:
// 1) 记录"用户最后所处的会话"到状态文件(供数据服务锁定当前会话)
// 2) 注入一行使用提示(严格 JSON 输出)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
if (sid) {
  try {
    const file = path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ sessionId: sid, ts: Date.now(), source: "session-start" })
    );
  } catch {}
}

const hint =
  "[zcode-tps-monitor] 已就绪。每轮用户消息都会注入【token 速率】行(真实,来自 usage 库;显示的是上一轮),请在每条回复末尾原样附上「⚡」开头的整行。命令:/tps(快照)、/tps-doctor(自检)。大屏:dashboard/server.mjs(http://127.0.0.1:7423);悬浮条(仅 Windows):dashboard/overlay.ps1;关闭速率行:~/.zcode/tps-monitor.config.json → {\"tokenRateLine\":false}。";

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: hint,
    },
  })
);
