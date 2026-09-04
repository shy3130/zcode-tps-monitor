#!/usr/bin/env node
// Token 输出速率:从 ZCode 自身的 usage 数据库(model_usage 表)计算真实的模型生成速率。
// 用法:
//   node token-rate.mjs            最近一次请求 + 会话统计(人类可读)
//   node token-rate.mjs --json     JSON 输出
//   ZCODE_SESSION_ID=xxx node ...  只统计指定会话
//   ZCODE_USAGE_DB=/path/db.sqlite 指定数据库路径(默认按用户主目录解析)
// 只读打开 WAL 数据库,不影响运行中的客户端。

// 抑制 node:sqlite 的 ExperimentalWarning 噪音:必须在动态 import 之前接管 warning 通道
// (静态 import 的内置模块在模块体执行前就已求值,届时再监听就晚了)。
process.removeAllListeners("warning");
process.on("warning", () => {});

const { DatabaseSync } = await import("node:sqlite");
import os from "node:os";
import path from "node:path";

// 跨平台默认路径(macOS/Linux: ~/.zcode/...;Windows: %USERPROFILE%\.zcode\...),可用 ZCODE_USAGE_DB 覆盖
const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const N = Number(process.env.TOKEN_RATE_WINDOW) || 5;           // 统计窗口(均/峰)
const HIST = Number(process.env.TOKEN_RATE_HIST) || 60;         // 曲线历史点数
const MIN_GEN_MS = Number(process.env.TOKEN_RATE_MIN_MS) || 200;      // 有效样本:最短生成耗时
const MAX_GEN_MS = Number(process.env.TOKEN_RATE_MAX_MS) || 3_600_000; // 有效样本:最长生成耗时(1h)

function query(sessionId) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    // 未显式指定会话时,取最近一次完成请求所属的会话 = 当前会话
    let sid = sessionId;
    let scoped = sessionId ? "explicit" : "auto";
    if (!sid) {
      const row = db
        .prepare("SELECT session_id FROM model_usage WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
        .get();
      sid = row ? row.session_id : null;
    }
    const args = [];
    const base =
      "SELECT model_id, output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
      " first_token_at, completed_at, time_to_first_token_ms, status" +
      " FROM model_usage WHERE status = 'completed' AND query_source = 'main_turn'";
    if (sid) {
      args.push(sid);
    }
    // 主对话优先:无 main_turn 数据时回退为全部请求
    const hasMain = db
      .prepare(base.replace(" LIMIT ?", "") + (sid ? " AND session_id = ?" : "") + " LIMIT 1")
      .get(...(sid ? [sid] : []));
    const scopeSql = hasMain
      ? base + " AND session_id = ?"
      : base.replace(" AND query_source = 'main_turn'", "") + (sid ? " AND session_id = ?" : "");
    // 曲线历史(大窗口)与统计(小窗口)分别查询,刷新/重开不丢
    const histRows = db.prepare(scopeSql + " ORDER BY completed_at DESC LIMIT ?").all(...args, HIST);
    const rows = histRows.slice(0, N);
    const items = rows.map((r) => {
      const tok = r.output_tokens ?? 0;
      const reasoning = r.reasoning_tokens ?? 0;
      // 部分行(如非流式/中断请求)缺 first_token_at,须判无效
      const hasTime = Number.isFinite(r.first_token_at) && Number.isFinite(r.completed_at) && r.completed_at > r.first_token_at;
      const genMs = hasTime ? r.completed_at - r.first_token_at : null; // 纯生成耗时(不含首 token 等待)
      // 速率分子含思考 token:思考内容同样是流式输出,ZCode 未单独记录时该列为 0,行为不变
      const rateTokens = tok + reasoning;
      const valid = genMs != null && genMs >= MIN_GEN_MS && genMs < MAX_GEN_MS && rateTokens > 0;
      return {
        model: r.model_id,
        outputTokens: tok,
        reasoningTokens: reasoning,
        inputTokens: r.input_tokens ?? 0,
        cacheRead: r.cache_read_input_tokens ?? 0,
        ttftMs: Number.isFinite(r.time_to_first_token_ms) ? r.time_to_first_token_ms : null,
        genMs,
        tokPerSec: valid ? Math.round((rateTokens / genMs) * 10000) / 10 : null,
        completedAt: r.completed_at,
      };
    });
    const rated = items.filter((i) => i.tokPerSec != null);
    // 展示用 latest 优先取最近一条"有效"记录,避免在途/缺字段行顶掉头条
    const latest = rated[0] ?? items[0] ?? null;
    // 会话累计用独立 SUM(不受展示窗口限制);速率均值/峰值仍用近 N 窗口
    const sumRow = db
      .prepare(
        "SELECT COUNT(*) n, SUM(output_tokens) o, SUM(reasoning_tokens) r," +
        " SUM(input_tokens) i, SUM(cache_read_input_tokens) c FROM (" + scopeSql + ")"
      )
      .get(...args);
    const session = rated.length
      ? {
          samples: rated.length,
          requests: sumRow.n ?? 0,
          avg: Math.round((rated.reduce((s, i) => s + i.tokPerSec, 0) / rated.length) * 10) / 10,
          max: Math.max(...rated.map((i) => i.tokPerSec)),
          min: Math.min(...rated.map((i) => i.tokPerSec)),
          totalOutput: sumRow.o ?? 0,
          totalReasoning: sumRow.r ?? 0,
          totalInput: sumRow.i ?? 0,
          totalCacheRead: sumRow.c ?? 0,
        }
      : null;
    return { sessionId: sid, scoped, latest, session, history: items.slice().reverse() };
  } finally {
    db.close();
  }
}

// 紧凑单位(注入行等需一眼扫读处):千以下原始、千~万一位小数 k、万~百万取整 k、百万以上一位小数 M
function fmtCompact(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// 千分位精确数字(每轮输出与 CLI 明细):2,762
function fmtNum(n) {
  return n.toLocaleString("en-US");
}

function formatLine(r) {
  const l = r.latest;
  if (!l) return "暂无已完成的模型请求";
  const t = new Date(l.completedAt).toLocaleTimeString("zh-CN", { hour12: false });
  const parts = [
    // 采样发生在发送消息的瞬间,头条描述的是上一条已完成回复
    `⚡ ${l.tokPerSec ?? "-"} tok/s(上轮)`,
    `首字 ${l.ttftMs != null ? (l.ttftMs / 1000).toFixed(1) : "-"}s`,
    `输出 ${fmtNum(l.outputTokens)}${l.reasoningTokens ? `(+${fmtNum(l.reasoningTokens)} 思考)` : ""} tok / 生成 ${l.genMs != null ? (l.genMs / 1000).toFixed(1) : "-"}s`,
  ];
  if (r.session) {
    parts.push(`近${r.session.samples}次均 ${r.session.avg} / 峰 ${r.session.max}`);
    parts.push(`累计 ${fmtCompact(r.session.totalOutput + r.session.totalReasoning)} tok`);
  }
  parts.push(`⏱ ${t}`);
  return parts.join(" · ");
}

// --- CLI ---
if (process.argv[1] && process.argv[1].endsWith("token-rate.mjs")) {
  const json = process.argv.includes("--json");
  const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const r = query(sid);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const s = r.session;
    console.log(formatLine(r));
    if (s) {
      // CLI 明细面向细读,全部千分位精确数字
      console.log(`会话累计:输出 ${fmtNum(s.totalOutput)}${s.totalReasoning ? `(+${fmtNum(s.totalReasoning)} 思考)` : ""} tok · 输入 ${fmtNum(s.totalInput)} tok(其中缓存读 ${fmtNum(s.totalCacheRead)}) · 请求 ${s.requests} 次`);
    }
  }
}

export { query, formatLine, fmtCompact, fmtNum };
