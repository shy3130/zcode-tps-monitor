#!/usr/bin/env node
// UserPromptSubmit hook: 每次用户发消息时
// 1) 记录"用户最后所处的会话"与提问时间戳到状态文件(--current 守卫依赖该时间戳)
// 2) 注入上一轮速率作为模型上下文,并下达"本问统计"指令:
//    模型在回答收尾时运行 token-rate.mjs --turn --current,把输出的"本问"速率行
//    原样引用在回复末尾。--current 保证绝不把上一轮数据冒充本问(纯问答轮无输出)。
// 输出必须为严格 JSON。
// 可选配置 ~/.zcode/tps-monitor.config.json:
//   {"tokenRateLine": false} 关闭全部速率注入。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, formatLine } from "../scripts/token-rate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RATE_SCRIPT = path.join(HERE, "..", "scripts", "token-rate.mjs");

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

// 本问统计指令:模型在收尾时自测当前提问的速率并引用。
// --current 守卫确保:最新 turn 的数据早于本次提问时刻时脚本输出为空,
// 此时模型不显示任何统计行 —— 任何情况下都不把上一轮数据当作本问展示。
const TURN_STATS_INSTRUCTION = [
  "",
  "【本轮统计指令】若你在本次回答中已经调用过工具,请在收尾时(所有其他工作完成之后、输出最终总结文字之前)运行一次:",
  `node "${RATE_SCRIPT}" --turn --current`,
  "它会输出一行「本提问从提出到最近一次工具调用」的真实 token 速率统计。把该行原样放入 Markdown 引用块(在新行行首加「> 」)贴在回复最末尾;不要改写数字、不要追加任何其他内容。",
  "注意:①上面【内部背景·勿展示】行是上一条提问的历史数据,仅供你了解背景,绝不展示给用户;②若脚本没有输出任何统计行,或本次回答你没有调用过任何工具,则不要显示任何统计行、也不要为此额外调用工具。",
].join("\n");

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
  const cfg = readConfig();
  if (cfg.tokenRateLine === false) {
    emit("");
  } else {
    // 上一轮行仅作模型上下文(加【内部背景·勿展示】前缀,明确禁止展示);本问统计由模型收尾时按指令自测
    emit("【内部背景·勿展示】上一条回复:" + formatLine(query(sid || null)) + TURN_STATS_INSTRUCTION);
  }
} catch {
  emit("");
}
