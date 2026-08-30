#!/usr/bin/env node
// Token 输出速率:从 ZCode 自身的 usage 数据库(model_usage 表)计算真实的模型生成速率。
// 用法:
//   node token-rate.mjs            最近一次请求 + 会话统计(人类可读)
//   node token-rate.mjs --json     JSON 输出
//   ZCODE_SESSION_ID=xxx node ...   只统计指定会话
// 只读打开 WAL 数据库,不影响运行中的客户端。

import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.ZCODE_USAGE_DB || "C:/Users/Administrator/.zcode/cli/db/db.sqlite";
const N = process.env.TOKEN_RATE_WINDOW ? Number(process.env.TOKEN_RATE_WINDOW) : 5;   // 统计窗口(均/峰)
const HIST = Number(process.env.TOKEN_RATE_HIST) || 60;                                // 曲线历史点数

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
      // 部分行(如非流式/中断请求)缺 first_token_at,须判无效
      const hasTime = Number.isFinite(r.first_token_at) && Number.isFinite(r.completed_at) && r.completed_at > r.first_token_at;
      const genMs = hasTime ? r.completed_at - r.first_token_at : null; // 纯生成耗时(不含首 token 等待)
      const valid = genMs != null && genMs >= 200 && genMs < 600000 && tok > 0;
      return {
        model: r.model_id,
        outputTokens: tok,
        reasoningTokens: r.reasoning_tokens ?? 0,
        inputTokens: r.input_tokens ?? 0,
        cacheRead: r.cache_read_input_tokens ?? 0,
        ttftMs: Number.isFinite(r.time_to_first_token_ms) ? r.time_to_first_token_ms : null,
        genMs,
        tokPerSec: valid ? Math.round((tok / genMs) * 10000) / 10 : null,
        completedAt: r.completed_at,
      };
    });
    const rated = items.filter((i) => i.tokPerSec != null);
    // 展示用 latest 优先取最近一条"有效"记录,避免在途/缺字段行顶掉头条
    const latest = rated[0] ?? items[0] ?? null;
    const session = rated.length
      ? {
          samples: rated.length,
          avg: Math.round((rated.reduce((s, i) => s + i.tokPerSec, 0) / rated.length) * 10) / 10,
          max: Math.max(...rated.map((i) => i.tokPerSec)),
          min: Math.min(...rated.map((i) => i.tokPerSec)),
          totalOutput: items.reduce((s, i) => s + i.outputTokens, 0),
        }
      : null;
    return { sessionId: sid, scoped, latest, session, history: items.slice().reverse() };
  } finally {
    db.close();
  }
}

function formatLine(r) {
  const l = r.latest;
  if (!l) return "暂无已完成的模型请求";
  const t = new Date(l.completedAt).toLocaleTimeString("zh-CN", { hour12: false });
  const parts = [
    `⚡ ${l.tokPerSec ?? "-"} tok/s`,
    `首字 ${l.ttftMs != null ? (l.ttftMs / 1000).toFixed(1) : "-"}s`,
    `输出 ${l.outputTokens} tok / 生成 ${l.genMs != null ? (l.genMs / 1000).toFixed(1) : "-"}s`,
  ];
  if (r.session) parts.push(`近${r.session.samples}次均 ${r.session.avg} / 峰 ${r.session.max}`);
  parts.push(`⏱ ${t}`);
  return parts.join(" · ");
}

// --- CLI ---
if (process.argv[1] && process.argv[1].endsWith("token-rate.mjs")) {
  const json = process.argv.includes("--json");
  const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  const r = query(sid);
  console.log(json ? JSON.stringify(r, null, 2) : formatLine(r));
}

export { query, formatLine };
