#!/usr/bin/env node
// UserPromptSubmit hook: 每次用户发消息时
// 1) 记录提问时刻:本会话分状态文件(~/.zcode/tps-monitor.sessions/<id>.json,--current
//    守卫的首选依据)+ 全局状态文件(「用户最后所处的会话」,大屏跟随/兜底;
//    读写统一在 scripts/lib/session.mjs)
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
import { recordPrompt } from "../scripts/lib/session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RATE_SCRIPT = path.join(HERE, "..", "scripts", "token-rate.mjs");

// stdin 是钩子入参 JSON(含 session_id 与 cwd);设超时兜底,客户端不给 stdin 也不挂起
function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(raw);
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", finish);
    setTimeout(finish, 1500);
  });
}

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

// 本问统计指令,按客户端形态二选一:
//   desktop → 会话内统计卡片(Gen UI,仅桌面端渲染);
//   其余(mobile/web/cli/未知)→ Markdown 引用块单行(任何客户端都可见)。
// 可用 ~/.zcode/tps-monitor.config.json 的 {"statsStyle":"card"|"line"} 强制指定。
// 防折叠约束(2026-09 实测)通用:客户端把带工具调用的消息折叠进「模型轨迹」区,
// 只有轮次最后一条纯文字消息默认展开——故严格规定"先跑脚本,再写正文,引用收尾"。
// 统计行包裹指令:按 statsFormat.wrap 生成对应的"怎么放"说明(脚本已按配置出裸行内容)
function wrapDirective(wrap) {
  if (wrap === "code") return "把脚本输出的那一行整体包进一对反引号(行内代码)单独成行,附在这条回复的最末尾;不要使用引用块";
  if (wrap === "plain") return "把脚本输出的那一行原样作为这条回复的最后一行,不加引用块也不加反引号";
  if (wrap === "italic") return "把脚本输出的那一行整体包进一对星号(斜体)单独成行,附在这条回复的最末尾";
  return "把脚本输出的那一行原样放入 Markdown 引用块(新行行首加「> 」)附在这条回复的最末尾";
}

function turnStatsInstruction(style, statsCfg, sid) {
  // 会话号烘焙进命令:模型侧的 shell 工作目录不可控(常在仓库子目录),cwd 解析会
  // 匹配不到本会话而回退全局文件——并发会话刚覆写全局时即串数据/判空(实测)。
  // env 前缀让脚本一步锁定本会话,彻底绕开解析链。
  const envPrefix = sid ? `ZCODE_SESSION_ID="${sid}" ` : "";
  const f = statsCfg && typeof statsCfg === "object" ? statsCfg : {};
  const wrap = ["quote", "code", "plain", "italic"].includes(f.wrap) ? f.wrap : "quote";
  if (style === "card") {
    return [
      "",
      "【本轮统计指令】若你在本次回答中已经调用过工具,请严格按以下顺序收尾:",
      `1. 在开始写最终回复正文之前,运行一次(把 <可视化目录> 替换为本会话系统提示给出的可视化片段目录;本会话没有该目录则直接走下方回退):${envPrefix}node "${RATE_SCRIPT}" --turn --current --card --out <可视化目录>/tps-turn.html`,
      "2. 脚本静默落盘卡片后,输出完整的最终回复正文,并以 tps-turn.html 的 ::visualize 引用(绝对路径,独占最后一行)收尾。不要自己改写卡片内容。",
      "关键约束:卡片引用必须与完整回复正文在同一条消息里;绝不能在写完正文之后再调用任何工具——客户端会折叠之前带工具调用的消息,用户将只能看到一张卡片。",
      `回退规则:①会话无可视化目录(无 Gen UI)时,改运行 ${envPrefix}node "${RATE_SCRIPT}" --turn --current(不带 --card),把输出单行原样放入 Markdown 引用块(行首「> 」)附在回复最末尾;②脚本无输出且卡片未更新(纯问答轮)则什么都不加。`,
      "注意:上面【内部背景·勿展示】行是上一条提问的历史数据,仅供你了解背景,绝不展示给用户。",
      "最终规则(最高优先级)::visualize 引用(或回退时的引用块)就是这条回复的终点,其后不得再有任何字符——禁止括号注释与收尾话。",
    ].join("\n");
  }
  return [
    "",
    "【本轮统计指令】若你在本次回答中已经调用过工具,请严格按以下顺序收尾:",
    `1. 在开始写最终回复正文之前,运行一次:${envPrefix}node "${RATE_SCRIPT}" --turn --current`,
    `2. 然后输出完整的最终回复正文(用户需要的全部内容),并${wrapDirective(wrap)};不要改写数字、不要追加任何其他内容。`,
    "关键约束:统计行必须与完整回复正文在同一条消息里。绝不能让统计行(或只含统计行的短消息)单独成为你最后一条消息,也绝不能在写完全部回复正文之后再调用任何工具——客户端会折叠之前带工具调用的消息,用户将只能看到一行统计。",
    "降级规则:若你已经写完回复正文才发现没运行统计脚本,就直接省略统计行结束回答,不要事后补调用工具。",
    "注意:①上面【内部背景·勿展示】行是上一条提问的历史数据,仅供你了解背景,绝不展示给用户;②若脚本没有输出任何统计行,或本次回答你没有调用过任何工具,则不要显示任何统计行、也不要为此额外调用工具。",
    "最终规则(最高优先级):统计行(含其包裹格式)就是这条回复的终点,其后不得再有任何字符——禁止追加模型名、脚本运行方式、数据来源等任何括号注释,也禁止任何收尾话。",
  ].join("\n");
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {}
  const sid =
    payload.session_id ||
    process.env.ZCODE_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "";
  // promptTs:本次提问时刻,--current 守卫的首选依据;写在解析顺序见 lib/session.mjs
  recordPrompt(sid, payload.cwd, "prompt-submit");

  const cfg = readConfig();
  if (cfg.tokenRateLine === false) {
    emit("");
  } else {
    // 样式选择:配置强制 → 按提交端 client_mode(仅 desktop 渲染 Gen UI 卡片,
    // 手机/网页/CLI 一律单行);字段缺失时保守取单行。入参字段名留档于调试日志。
    const style =
      cfg.statsStyle === "card" || cfg.statsStyle === "line"
        ? cfg.statsStyle
        : payload.client_mode === "desktop"
          ? "card"
          : "line";
    try {
      fs.appendFileSync(
        path.join(os.homedir(), ".zcode", "tps-monitor.hook-debug.log"),
        JSON.stringify({ at: new Date().toISOString(), keys: Object.keys(payload), client_mode: payload.client_mode ?? null, style }) + "\n"
      );
    } catch {}
    // 上一轮行仅作模型上下文(加【内部背景·勿展示】前缀,明确禁止展示);本问统计由模型收尾时按指令自测
    emit("【内部背景·勿展示】上一条回复:" + formatLine(query(sid || null)) + turnStatsInstruction(style, cfg.statsFormat, sid));
  }
}

main()
  .catch(() => emit(""))
  .finally(() => process.exit(0));
