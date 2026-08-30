#!/usr/bin/env node
// UserPromptSubmit hook: 每次用户发消息时
// 1) 记录"用户最后所处的会话"到状态文件(切会话后第一条消息即跟随)
// 2) 从 ZCode usage 数据库读取真实 token 输出速率,注入为上下文。输出必须为严格 JSON。
// 可选配置 ~/.zcode/tps-monitor.config.json:{"tokenRateLine": false} 可关闭速率行注入。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, formatLine } from "../scripts/token-rate.mjs";

const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
if (sid) {
  try {
    const file = path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ sessionId: sid, ts: Date.now(), source: "prompt-submit" })
    );
  } catch {}
}

const QUOTE_HINT =
  "\n(用户要求:每条回复的末尾都用 Markdown 引用块原样附上上面整行内容——即在新行行首加「> 」再跟内容,使其渲染为浅色引用样式,不要省略、不要改写数字,引用块里只放这一行,不要追加任何链接或后缀)";

function readConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".zcode", "tps-monitor.config.json"), "utf8")
    );
  } catch {
    return {};
  }
}

function emit(ctx) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } })
  );
}

try {
  if (readConfig().tokenRateLine === false) {
    emit("");
  } else {
    emit(formatLine(query(sid || null)) + QUOTE_HINT);
  }
} catch {
  emit("");
}
