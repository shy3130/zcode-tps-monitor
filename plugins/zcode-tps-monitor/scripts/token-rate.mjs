#!/usr/bin/env node
// Token 输出速率:从 ZCode 自身的 usage 数据库(model_usage 表)计算真实的模型生成速率。
// 用法:
//   node token-rate.mjs            最近一次请求 + 会话统计(人类可读)
//   node token-rate.mjs --turn     最新一问(本次提问触发的轮次)即时速率
//   node token-rate.mjs --turn --current
//                                  同上,但本问尚无入库数据时输出为空(--current 守卫,
//                                  绝不把上一轮数据当作本问返回)
//   node token-rate.mjs --json     JSON 输出
//   ZCODE_SESSION_ID=xxx node ...  只统计指定会话
//   ZCODE_USAGE_DB=/path/db.sqlite 指定数据库路径(默认按用户主目录解析)
//   TPS_MONITOR_STATE_FILE=/path   指定钩子全局状态文件(默认 ~/.zcode/tps-monitor.last-session.json)
//   TPS_MONITOR_SESSIONS_DIR=/path 指定分会话状态目录(默认与全局状态文件同目录的 tps-monitor.sessions)
// 未显式指定会话时按:全局状态文件(cwd 匹配的显式记录)→ process.cwd() 查 usage 库
// session 表 → 全局状态文件 → 全局最新完成请求(详见 fallbackSessionId)。只读打开 WAL 数据库,不影响运行中的客户端。

// 抑制 node:sqlite 的 ExperimentalWarning 噪音:必须在动态 import 之前接管 warning 通道
// (静态 import 的内置模块在模块体执行前就已求值,届时再监听就晚了)。
process.removeAllListeners("warning");
process.on("warning", () => {});

const { DatabaseSync } = await import("node:sqlite");
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { readGlobalState, globalSessionIdMatchingCwd, resolveSessionIdByCwd, lastPromptTs } from "./lib/session.mjs";

// --- 统计行可配置项(~/.zcode/tps-monitor.config.json 的 "statsFormat" 段)---
//   wrap: "quote"|"code"|"plain"|"italic"  包裹样式(引用块/行内代码/裸行/斜体);
//         code 包裹时脚本自动去掉 ** 加粗(代码内会显示原始星号)
//   sep:  "bar"|"dot"|"mixed"              分隔符(│ / · / 头部│其余·)
//   clock: true|false                      行尾 ⏱ 时刻
//   spark: true|false                      方块字走势条
//   sparkMax: 1-8                          走势条最多段数
function readStatsConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(process.env.TPS_MONITOR_CONFIG || path.join(os.homedir(), ".zcode", "tps-monitor.config.json"), "utf8")
    );
  } catch {
    return {};
  }
}
function normalizeStatsCfg(raw) {
  const f = raw && typeof raw === "object" && raw.statsFormat ? raw.statsFormat : {};
  return {
    wrap: ["quote", "code", "plain", "italic"].includes(f.wrap) ? f.wrap : "quote",
    sep: ["bar", "dot", "mixed"].includes(f.sep) ? f.sep : "bar",
    clock: f.clock !== false,
    spark: f.spark !== false,
    sparkMax: Math.min(8, Math.max(1, Number(f.sparkMax) || 4)),
  };
}
const STATS_CFG = normalizeStatsCfg(readStatsConfig());

// 跨平台默认路径(macOS/Linux: ~/.zcode/...;Windows: %USERPROFILE%\.zcode\...),可用 ZCODE_USAGE_DB 覆盖
const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const N = Number(process.env.TOKEN_RATE_WINDOW) || 5;           // 统计窗口(均/峰)
const HIST = Number(process.env.TOKEN_RATE_HIST) || 60;         // 曲线历史点数
const MIN_GEN_MS = Number(process.env.TOKEN_RATE_MIN_MS) || 200;      // 有效样本:最短生成耗时
const MAX_GEN_MS = Number(process.env.TOKEN_RATE_MAX_MS) || 3_600_000; // 有效样本:最长生成耗时(1h)

// 钩子状态文件(全局 + 分会话)的读写与提问时刻解析统一在 lib/session.mjs,
// 供 token-rate / 钩子 / 后续悬浮窗服务复用。

function openDb() {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

// 未显式指定会话时的解析顺序:
//   ① 全局状态文件里 cwd 与 process.cwd() 一致的 sessionId——prompt-submit 已由用户本人
//      为本目录显式记下会话(子代理 actor 等后台会话不触发该钩子,不会覆写);同目录
//      多会话(主会话与共享 directory 的 actor)时,这是唯一能区分两者的依据,须放在
//      time_updated 最新之前(2026-10-21 二次串数据事故:主会话收尾把 actor 的 450 tok/s
//      当作本问,正确值 166.7);
//   ② 按 process.cwd() 查 usage 库 session 表(directory 精确匹配、未删除行里
//      time_updated 最新)——全局记录缺失/过期/目录不匹配时的并发隔离手段
//      (2026-10-21 首次串数据事故的修复,跨目录场景仍然有效);
//   ③ 全局状态文件里「用户最后所处的会话」(切会话即跟随,旧路径兜底);
//   ④ 全局最近一次完成请求所属的会话
function fallbackSessionId(db) {
  const fromGlobal = globalSessionIdMatchingCwd(process.cwd());
  if (fromGlobal) return fromGlobal;
  const byCwd = resolveSessionIdByCwd(db, process.cwd());
  if (byCwd) return byCwd;
  const st = readGlobalState();
  if (st && st.sessionId) return st.sessionId;
  const row = db
    .prepare("SELECT session_id FROM model_usage WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
    .get();
  return row ? row.session_id : null;
}

function resolveSession(db, sessionId) {
  const sid = sessionId || fallbackSessionId(db);
  return { sid, scoped: sessionId ? "explicit" : "auto" };
}

// 主对话优先的过滤范围:有 main_turn 数据时只统计 main_turn,否则回退为全部请求
function scopeFor(db, sid) {
  const base =
    "SELECT model_id, output_tokens, reasoning_tokens, input_tokens, cache_read_input_tokens," +
    " first_token_at, completed_at, time_to_first_token_ms, status" +
    " FROM model_usage WHERE status = 'completed' AND query_source = 'main_turn'";
  const args = sid ? [sid] : [];
  const hasMain = db
    .prepare(base + (sid ? " AND session_id = ?" : "") + " LIMIT 1")
    .get(...args);
  const scopeSql = hasMain
    ? base + " AND session_id = ?"
    : base.replace(" AND query_source = 'main_turn'", "") + (sid ? " AND session_id = ?" : "");
  return { scopeSql, args };
}

function toItem(r) {
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
}

// 会话累计用独立 SUM(不受展示窗口限制);速率均值/峰值由调用方按窗口传入
function sessionAggregate(db, scopeSql, args, rated) {
  if (!rated.length) return null;
  const sumRow = db
    .prepare(
      "SELECT COUNT(*) n, SUM(output_tokens) o, SUM(reasoning_tokens) r," +
      " SUM(input_tokens) i, SUM(cache_read_input_tokens) c FROM (" + scopeSql + ")"
    )
    .get(...args);
  return {
    samples: rated.length,
    requests: sumRow.n ?? 0,
    avg: Math.round((rated.reduce((s, i) => s + i.tokPerSec, 0) / rated.length) * 10) / 10,
    max: Math.max(...rated.map((i) => i.tokPerSec)),
    min: Math.min(...rated.map((i) => i.tokPerSec)),
    totalOutput: sumRow.o ?? 0,
    totalReasoning: sumRow.r ?? 0,
    totalInput: sumRow.i ?? 0,
    totalCacheRead: sumRow.c ?? 0,
  };
}

function query(sessionId) {
  const db = openDb();
  try {
    const { sid, scoped } = resolveSession(db, sessionId);
    const { scopeSql, args } = scopeFor(db, sid);
    // 曲线历史(大窗口)与统计(小窗口)分别查询,刷新/重开不丢
    const histRows = db.prepare(scopeSql + " ORDER BY completed_at DESC LIMIT ?").all(...args, HIST);
    const items = histRows.slice(0, N).map(toItem);
    const rated = items.filter((i) => i.tokPerSec != null);
    // 展示用 latest 优先取最近一条"有效"记录,避免在途/缺字段行顶掉头条
    const latest = rated[0] ?? items[0] ?? null;
    const session = sessionAggregate(db, scopeSql, args, rated);
    return { sessionId: sid, scoped, latest, session, history: items.slice().reverse() };
  } finally {
    db.close();
  }
}

// 本轮 = 会话里最新的 turn_id(一次用户消息触发的全部请求共享同一个 turn_id,
// 含"模型→工具→模型"的每一段)。回复收尾时(模型运行 --turn --current)本轮已完成
// 的各段均已实时入库,因此能给出真正的"本问即时速率";而 prompt-submit 时刻本问
// 尚未发生,只能看到上一轮。
function latestTurnId(db, sid) {
  try {
    const row = db
      .prepare("SELECT turn_id FROM model_usage WHERE session_id = ? AND turn_id IS NOT NULL ORDER BY completed_at DESC LIMIT 1")
      .get(sid);
    return row ? row.turn_id : null;
  } catch {
    return null; // 旧版客户端的库没有 turn_id 列
  }
}

// 本问提问时刻(--current 守卫依据)的解析在 lib/session.mjs:lastPromptTs(sid)——
// 优先本会话的分状态文件(会话由全局显式记录或 cwd 匹配解析),拿不到再回退全局文件;
// 其他会话对全局文件的覆写不再影响守卫判定。

function queryTurn(sessionId, opts = {}) {
  const db = openDb();
  try {
    const sid = sessionId || fallbackSessionId(db);
    if (!sid) return { sessionId: null, turnId: null, turn: null, session: null };
    const { scopeSql, args } = scopeFor(db, sid);
    const winRows = db.prepare(scopeSql + " ORDER BY completed_at DESC LIMIT ?").all(...args, N);
    const session = sessionAggregate(db, scopeSql, args, winRows.map(toItem).filter((i) => i.tokPerSec != null));
    const turnId = latestTurnId(db, sid);
    if (!turnId) return { sessionId: sid, turnId: null, turn: null, session };
    let turnRows;
    try {
      turnRows = db.prepare(scopeSql + " AND turn_id = ? ORDER BY completed_at ASC").all(...args, turnId);
    } catch {
      return { sessionId: sid, turnId: null, turn: null, session };
    }
    if (!turnRows.length) return { sessionId: sid, turnId, turn: null, session };
    // --current 守卫:最新 turn 的行全部早于本次提问时刻 → 本问还没有任何模型请求
    // (典型场景:纯问答轮在回答结束前),绝不把上一轮数据冒充"本问"返回。
    if (opts.current) {
      const ts = lastPromptTs(sid);
      const lastAt = Math.max(...turnRows.map((r) => r.completed_at ?? 0));
      if (ts && lastAt < ts) {
        return { sessionId: sid, turnId, turn: null, noCurrentTurnData: true, session };
      }
    }
    const items = turnRows.map(toItem);
    const rated = items.filter((i) => i.tokPerSec != null);
    const totalTok = rated.reduce((s, i) => s + i.outputTokens + i.reasoningTokens, 0);
    const genMs = rated.reduce((s, i) => s + i.genMs, 0);
    // 总用时(墙钟):提问时刻 → 最后一段完成;提问时刻不可用/不合理时退回首段请求
    // 开始(首 token 时刻 - TTFT)。与净生成时长(genMs,各段纯输出时间之和)互补,
    // 两者之差 ≈ 首字等待 + 段间工具执行等待。
    const lastAtMs = items[items.length - 1].completedAt;
    const pTs = lastPromptTs(sid);
    let startTs = pTs && pTs < lastAtMs && lastAtMs - pTs < 6 * 3600_000 ? pTs : null;
    if (startTs == null) {
      const r0 = turnRows[0];
      if (Number.isFinite(r0.first_token_at)) {
        const est = Number.isFinite(r0.time_to_first_token_ms)
          ? r0.first_token_at - r0.time_to_first_token_ms
          : r0.first_token_at;
        if (est < lastAtMs) startTs = est;
      }
    }
    // 近 ≤sparkMax 段速率的方块字走势(▁▂▃▄▅▆▇█):段多了成噪音,默认只留最近 4 段;
    // statsFormat.spark=false 可整体关闭(段数与峰值仍在卡片/峰值字段里)
    const sparkRates = rated.slice(-STATS_CFG.sparkMax).map((i) => i.tokPerSec);
    const turn = {
      requests: items.length,
      rated: rated.length,
      ttftMs: items[0].ttftMs, // 本轮第一段的首字延迟
      firstAt: items[0].completedAt,
      lastAt: items[items.length - 1].completedAt,
      genMs,
      totalMs: startTs != null ? lastAtMs - startTs : null,
      totalOutput: items.reduce((s, i) => s + i.outputTokens, 0),
      totalReasoning: items.reduce((s, i) => s + i.reasoningTokens, 0),
      // 本轮即时速率:总产出 / 总纯生成时长(按段加权,排除段间工具等待),单段时即该段速率
      tokPerSec: genMs >= MIN_GEN_MS && totalTok > 0 ? Math.round((totalTok / genMs) * 10000) / 10 : null,
      peak: rated.length ? Math.max(...rated.map((i) => i.tokPerSec)) : null,
      spark: STATS_CFG.spark ? sparkBars(sparkRates) : "",
    };
    return { sessionId: sid, turnId, turn, session };
  } finally {
    db.close();
  }
}

// --- 多会话泳道(大屏「每个会话」视图,0.10.0) ---
// 枚举近 SESSIONS_WITHIN_MS 内有活动的全部会话,每会话给出 status / 最新一轮 turn /
// latest 段速率 / 近若干段速率曲线 / 会话终身累计,供大屏泳道与 CLI --sessions 使用。
// 性能(1s 轮询的长驻进程):状态全量增量维护——首轮拉窗口内整行 + GROUP BY 建终身
// 累计,此后每轮只拉 completed_at 越过水位的新行(回看 OVERLAP 容忍乱序提交,按
// (completed_at, rowid) 水位去重);数据库端常量次查询,JS 端 O(新增行)。
const SESSIONS_WITHIN_MS = Number(process.env.TPS_SESSIONS_WITHIN_MS) || 24 * 3600 * 1000;
const SESSIONS_HIST = Number(process.env.TPS_SESSIONS_HIST) || 40; // 曲线点数上限
const SESSIONS_RING = 64;                    // 每会话速率样本环形上限(曲线/均峰窗口)
const SESSIONS_ACTIVE_MS = 10 * 60 * 1000;   // 最近一次活动在该窗口内 → active
const SESSIONS_GENERATING_MS = 8000;         // 与悬浮窗 live 判定一致 → generating
const SESSIONS_OVERLAP_MS = 10000;           // 增量回看窗口(容忍乱序/迟到提交)

const sessionsStore = new Map(); // DB_PATH -> 增量缓存(键含库路径,多库/测试互不污染)

function newSubsetState() {
  return { lastAt: 0, lastItem: null, ring: [], totals: { n: 0, o: 0, r: 0, i: 0, c: 0 }, turn: null };
}
function newLaneState(cwd) {
  // main/all 两套并行口径:main_turn 行进 main,全部行进 all;读取时 main 有量则用
  // main(与会话视图一致),子代理 actor 会话(无 main 行)退回 all——免掉口径翻转时
  // 的整体重建,代价只是双份环形缓冲(行对象很小,窗口内)
  return { cwd: cwd || null, main: newSubsetState(), all: newSubsetState() };
}

// 单行并入子集状态:latest/曲线/累计/最新轮聚合全部增量更新
function ingestRow(st, row) {
  const t = toItem(row);
  st.lastItem = t;
  if (row.completed_at > st.lastAt) st.lastAt = row.completed_at;
  if (t.tokPerSec != null) {
    st.ring.push(t.tokPerSec);
    if (st.ring.length > SESSIONS_RING) st.ring.splice(0, st.ring.length - SESSIONS_RING);
  }
  st.totals.n += 1;
  st.totals.o += row.output_tokens ?? 0;
  st.totals.r += row.reasoning_tokens ?? 0;
  st.totals.i += row.input_tokens ?? 0;
  st.totals.c += row.cache_read_input_tokens ?? 0;
  // 最新轮:turn_id 变化即开新轮;turn_id 缺失(旧库)不臆造,latest 兜底展示
  const tid = row.turn_id ?? null;
  if (!st.turn || st.turn.id !== tid) {
    st.turn = { id: tid, requests: 0, rated: 0, ttftMs: t.ttftMs, firstAt: t.completedAt, lastAt: t.completedAt, genMs: 0, totalOutput: 0, totalReasoning: 0, peak: null };
  }
  st.turn.requests += 1;
  st.turn.lastAt = t.completedAt;
  if (t.genMs != null) st.turn.genMs += t.genMs;
  st.turn.totalOutput += t.outputTokens;
  st.turn.totalReasoning += t.reasoningTokens;
  if (t.tokPerSec != null) {
    st.turn.rated += 1;
    st.turn.peak = Math.max(st.turn.peak ?? 0, t.tokPerSec);
  }
}

function turnView(st) {
  const t = st.turn;
  if (!t || t.id == null || t.requests === 0) return null;
  const totalTok = t.totalOutput + t.totalReasoning;
  return {
    requests: t.requests,
    rated: t.rated,
    ttftMs: t.ttftMs,
    firstAt: t.firstAt,
    lastAt: t.lastAt,
    genMs: t.genMs,
    totalOutput: t.totalOutput,
    totalReasoning: t.totalReasoning,
    // 与 queryTurn 同式:总产出 / 总纯生成时长(段间工具等待不计)
    tokPerSec: t.genMs >= MIN_GEN_MS && totalTok > 0 ? Math.round((totalTok / t.genMs) * 10000) / 10 : null,
    peak: t.peak,
  };
}

// 多会话查询:opts.fresh 绕过增量缓存(测试);opts.withinMs/histMax/laneMax 覆盖默认
function querySessions(opts = {}) {
  const withinMs = opts.withinMs ?? SESSIONS_WITHIN_MS;
  const histMax = Math.min(opts.histMax ?? SESSIONS_HIST, SESSIONS_RING);
  const laneMax = opts.laneMax ?? 12;
  const db = openDb();
  try {
    const now = Date.now();
    const cache = opts.fresh ? { lastSeenAt: 0, lastRid: 0, initialized: false, lanes: new Map() } : sessionsStore.get(DB_PATH) || { lastSeenAt: 0, lastRid: 0, initialized: false, lanes: new Map() };

    // ① 会话清单:session 表(近窗口、未删除、带 directory);旧库无该表时仅靠 usage 行
    const known = new Map(); // sid -> { cwd, timeUpdated }
    try {
      const rows = db
        .prepare(
          "SELECT id, directory, time_updated FROM session" +
            " WHERE (time_deleted IS NULL OR time_deleted = 0) AND time_updated > ?"
        )
        .all(now - withinMs);
      for (const r of rows) known.set(r.id, { cwd: r.directory, timeUpdated: r.time_updated });
    } catch {}

    // ② 增量拉行:首轮全窗口,此后只拉越过水位的新行(乱序/迟到提交靠回看窗口补齐)。
    //    不在 SQL 侧 ORDER BY(model_usage 无 completed_at 索引,3.5 万行排序是每秒
    //    固定开销),改成 JS 端给少量新增行排序,水位去重逻辑依赖的顺序不变
    const since = cache.lastSeenAt ? cache.lastSeenAt - SESSIONS_OVERLAP_MS : now - withinMs;
    const rows = db
      .prepare(
        "SELECT rowid AS rid, session_id, query_source, model_id, output_tokens, reasoning_tokens," +
          " input_tokens, cache_read_input_tokens, first_token_at, completed_at, time_to_first_token_ms, turn_id" +
          " FROM model_usage WHERE status = 'completed' AND completed_at > ?"
      )
      .all(since)
      .sort((a, b) => a.completed_at - b.completed_at || a.rid - b.rid);
    for (const row of rows) {
      // 水位去重:早于水位、或同刻但 rowid 已见过的行是回看窗口里的重复,跳过
      if (row.completed_at < cache.lastSeenAt || (row.completed_at === cache.lastSeenAt && row.rid <= cache.lastRid)) continue;
      let lane = cache.lanes.get(row.session_id);
      if (!lane) {
        lane = newLaneState(known.get(row.session_id)?.cwd || null);
        cache.lanes.set(row.session_id, lane);
      }
      ingestRow(lane.all, row);
      if (row.query_source === "main_turn") ingestRow(lane.main, row);
      if (row.completed_at >= cache.lastSeenAt) {
        cache.lastRid = row.completed_at === cache.lastSeenAt ? Math.max(cache.lastRid, row.rid) : row.rid;
        cache.lastSeenAt = row.completed_at;
      }
    }

    // ③ 首轮用 GROUP BY 建会话终身累计(窗口行只覆盖近期);此后轮询只做增量加法。
    //    已知边角:首轮流式提交夹在窗口查询与 GROUP BY 之间的行可能被两端各计一次
    //    (同毫秒多段且跨查询边界才触发),对累计展示差一段,不再为此做全量对账。
    if (!cache.initialized) {
      const bySrc = (src) => {
        try {
          return db
            .prepare(
              "SELECT session_id, COUNT(*) n, SUM(output_tokens) o, SUM(reasoning_tokens) r," +
                " SUM(input_tokens) i, SUM(cache_read_input_tokens) c FROM model_usage WHERE status = 'completed'" +
                src +
                " GROUP BY session_id"
            )
            .all();
        } catch {
          return [];
        }
      };
      const mainTot = new Map(bySrc(" AND query_source = 'main_turn'").map((r) => [r.session_id, r]));
      const allTot = new Map(bySrc("").map((r) => [r.session_id, r]));
      for (const [sid, lane] of cache.lanes) {
        const m = mainTot.get(sid);
        if (m) lane.main.totals = { n: m.n, o: m.o, r: m.r, i: m.i, c: m.c };
        const a = allTot.get(sid);
        if (a) lane.all.totals = { n: a.n, o: a.o, r: a.r, i: a.i, c: a.c };
      }
      cache.initialized = true;
    }

    // ④ 物化全部泳道:session 表里无 usage 行的新会话(刚打开还没发消息)也占位,
    //    part 探测与视图汇总都要覆盖它们
    const sidsAll = [...new Set([...cache.lanes.keys(), ...known.keys()])];
    for (const sid of sidsAll) {
      if (!cache.lanes.has(sid)) cache.lanes.set(sid, newLaneState(known.get(sid)?.cwd || null));
    }

    // ⑤ 生成中迹象之二:part 表有 running 的 tool part(首段在途时 usage 尚无行)。
    //    性能:part 表十几万行且 data 是大 JSON,绝不能全表 json_extract——先限定
    //    "近 60 分钟有活动的会话"(session_id IN 可走 part_session_idx),再限定
    //    "近 10 分钟更新过的 part"(整数比较廉价,json_extract 只落在个位数的行上)。
    //    代价:跑超过 10 分钟未更新 time_updated 的超长工具会漏判,由其结束后的
    //    下一段完成兜底,可接受。
    const generatingSids = new Set();
    try {
      const cand = [...cache.lanes.entries()]
        .filter(([sid, l]) => Math.max(l.all.lastAt, known.get(sid)?.timeUpdated || 0) > now - 60 * 60 * 1000)
        .map(([sid]) => sid);
      if (cand.length) {
        const ph = cand.map(() => "?").join(",");
        for (const r of db
          .prepare(
            "SELECT DISTINCT session_id FROM part WHERE session_id IN (" + ph + ")" +
              " AND time_updated > ?" +
              " AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.state.status') = 'running'"
          )
          .all(...cand, now - 10 * 60 * 1000)) {
          generatingSids.add(r.session_id);
        }
      }
    } catch {} // 旧版客户端的库没有 part 表

    // ⑥ 汇总泳道视图(按最近活动排序)
    const lanes = [];
    for (const sid of sidsAll) {
      const lane = cache.lanes.get(sid);
      const st = lane.main.totals.n > 0 ? lane.main : lane.all; // main_turn 优先口径
      const lastAt = Math.max(lane.all.lastAt, known.get(sid)?.timeUpdated || 0);
      const status =
        (lane.all.lastAt > 0 && now - lane.all.lastAt <= SESSIONS_GENERATING_MS) || generatingSids.has(sid)
          ? "generating"
          : lastAt > 0 && now - lastAt <= SESSIONS_ACTIVE_MS
            ? "active"
            : "idle";
      const rated = st.ring;
      const session = st.totals.n
        ? {
            requests: st.totals.n,
            totalOutput: st.totals.o,
            totalReasoning: st.totals.r,
            totalInput: st.totals.i,
            totalCacheRead: st.totals.c,
            avg: rated.length ? Math.round((rated.reduce((s, v) => s + v, 0) / rated.length) * 10) / 10 : null,
            max: rated.length ? Math.max(...rated) : null,
          }
        : null;
      const cwd = lane.cwd;
      lanes.push({
        sessionId: sid,
        cwd,
        label: cwd ? path.basename(cwd) : sid.slice(0, 13),
        model: st.lastItem ? st.lastItem.model : null,
        status,
        lastAt: lastAt || null,
        latest: st.lastItem,
        turn: turnView(st),
        history: st.ring.slice(-histMax),
        session,
      });
    }
    lanes.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

    if (!opts.fresh) sessionsStore.set(DB_PATH, cache);
    return { ts: now, withinMs, sessions: lanes.slice(0, laneMax), total: lanes.length };
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

// 方块字走势:数值归一化到 8 级柱高;不足两点(无从谈趋势)返回空串
function sparkBars(vals) {
  if (!vals || vals.length < 2) return "";
  const min = Math.min(...vals), max = Math.max(...vals);
  const bars = "▁▂▃▄▅▆▇█";
  return vals.map((v) => bars[Math.round(((v - min) / (max - min || 1)) * 7)]).join("");
}

// 时长展示:秒级一位小数,分钟/小时取整紧凑写法(总用时可能远大于净生成)
function fmtDur(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + String(Math.round(s % 60)).padStart(2, "0") + "s";
  return Math.floor(s / 3600) + "h" + String(Math.floor(((s % 3600) / 60))).padStart(2, "0") + "m";
}

// 本问统计行(回复收尾自测、Stop 钩子共用;可配置项见文件头 statsFormat 说明):
// 分隔符 sep(bar│/dot·/mixed 头│尾·),wrap=code 时去加粗(代码内星号不渲染),
// clock=false 去 ⏱,spark 已在 queryTurn 按 sparkMax/spark 裁剪
function formatTurnLine(r, cfg = STATS_CFG) {
  const t = r.turn;
  if (!t) return "暂无本轮请求记录";
  const time = new Date(t.lastAt).toLocaleTimeString("zh-CN", { hour12: false });
  const rate = `${t.tokPerSec ?? "-"} tok/s`;
  const head = [`⚡ ${cfg.wrap === "code" ? rate : `**${rate}**`}`];
  if (cfg.spark && t.spark) head.push(t.spark);
  const seg = [
    `首字 ${t.ttftMs != null ? (t.ttftMs / 1000).toFixed(1) + "s" : "-"}`,
    `输出 ${fmtNum(t.totalOutput)}${t.totalReasoning ? `(+${fmtNum(t.totalReasoning)} 思考)` : ""} tok${t.requests > 1 ? ` · 峰 ${t.peak ?? "-"}` : ""}`,
  ];
  if (r.session) seg.push(`累计 ${fmtCompact(r.session.totalOutput + r.session.totalReasoning)}`);
  seg.push(`净 ${t.genMs > 0 ? fmtDur(t.genMs) : "-"} / 总 ${t.totalMs != null ? fmtDur(t.totalMs) : "-"}`);
  if (cfg.clock) seg.push(`⏱ ${time}`);
  const tail = cfg.sep === "dot" ? " · " : cfg.sep === "mixed" ? " · " : " │ ";
  const headSep = cfg.sep === "dot" ? " · " : " │ ";
  return head.join(" ") + headSep + seg.join(tail);
}

// 本问统计表格(回复收尾注入用):GFM 表格在客户端渲染成真表格,比引用块一行字
// 更易读;CLI 加 --table 输出,Stop 钩子的 systemMessage 仍用单行(瞬时消息不渲染表格)
function formatTurnTable(r) {
  const t = r.turn;
  if (!t) return "";
  const time = new Date(t.lastAt).toLocaleTimeString("zh-CN", { hour12: false });
  const head = ["⚡ 本轮", "走势", "首字", "输出", "峰值", "净 / 总", "会话累计", "⏱"];
  const row = [
    `**${t.tokPerSec ?? "-"}** tok/s`,
    t.spark ? `${t.spark}${t.requests > 1 ? ` ×${t.requests}` : ""}` : "—",
    t.ttftMs != null ? (t.ttftMs / 1000).toFixed(1) + "s" : "-",
    fmtNum(t.totalOutput) + (t.totalReasoning ? ` +${fmtNum(t.totalReasoning)}思考` : "") + " tok",
    t.requests > 1 ? String(t.peak ?? "-") : "—",
    `${t.genMs > 0 ? fmtDur(t.genMs) : "-"} / ${t.totalMs != null ? fmtDur(t.totalMs) : "-"}`,
    r.session ? fmtCompact(r.session.totalOutput + r.session.totalReasoning) + " tok" : "-",
    time,
  ];
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(head), "|" + head.map(() => ":---:").join("|") + "|", line(row)].join("\n");
}

// 本问统计卡片(Gen UI,桌面端渲染):全静态片段,竖条高度与时刻都在 Node 侧算好,
// 无内联脚本;CLI --card --out 直接落盘,模型侧只需一条命令 + ::visualize 引用。
// 样式契约:单张 .card 横条,宿主主题变量(--viz-series-1/--card/--muted),禁止硬编码色。
function buildTurnCard(r) {
  const t = r.turn;
  if (!t) return "";
  const time = new Date(t.lastAt).toLocaleTimeString("zh-CN", { hour12: false });
  const LV = { "▁": 16, "▂": 29, "▃": 42, "▄": 55, "▅": 68, "▆": 81, "▇": 90, "█": 100 };
  const bars = t.spark
    ? [...t.spark]
        .map((c) => {
          const h = LV[c] ?? 50;
          return `<div style="width:7px;height:${h}%;border-radius:2px;background:var(--viz-series-1);opacity:${(0.45 + (h / 100) * 0.55).toFixed(2)}"></div>`;
        })
        .join("")
    : `<div style="width:7px;height:100%;border-radius:2px;background:var(--viz-series-1);opacity:.9"></div>`;
  const chip = (k, v) =>
    `<div><div class="text-small text-muted">${k}</div><div class="tabular-nums">${v}</div></div>`;
  return `<div id="tps-turn-stats">
  <div class="card" style="padding:14px 18px;display:flex;align-items:center;gap:22px;flex-wrap:wrap;">
    <div style="display:flex;align-items:center;gap:12px;">
      <i data-lucide="zap" aria-hidden="true" style="color:var(--viz-series-1)"></i>
      <div>
        <div class="text-small text-muted">本轮速率</div>
        <div style="display:flex;align-items:baseline;gap:6px;">
          <span class="viz-stat-value tabular-nums">${t.tokPerSec ?? "-"}</span>
          <span class="text-small text-muted">tok/s</span>
        </div>
        <div class="text-small text-muted">${t.requests} 段${t.requests > 1 && t.peak != null ? ` · 峰 ${t.peak}` : ""}</div>
      </div>
    </div>
    <div style="display:flex;align-items:flex-end;gap:3px;height:40px" role="img" aria-label="本轮各段速率走势">${bars}</div>
    <div style="flex:1"></div>
    <div class="viz-row" style="gap:18px;align-items:center">
      ${chip("首字", t.ttftMs != null ? (t.ttftMs / 1000).toFixed(1) + "s" : "-")}
      ${chip("输出", fmtNum(t.totalOutput) + (t.totalReasoning ? ` +${fmtNum(t.totalReasoning)}思考` : "") + ' <span class="text-small text-muted">tok</span>')}
      ${r.session ? chip("累计", fmtCompact(r.session.totalOutput + r.session.totalReasoning)) : ""}
      ${chip("净 / 总", `${t.genMs > 0 ? fmtDur(t.genMs) : "-"} / ${t.totalMs != null ? fmtDur(t.totalMs) : "-"}`)}
      ${r.session && r.session.avg != null ? chip("近段均", String(r.session.avg)) : ""}
      ${chip("时刻", time)}
    </div>
  </div>
</div>`;
}

// --- CLI ---
if (process.argv[1] && process.argv[1].endsWith("token-rate.mjs")) {
  const json = process.argv.includes("--json");
  const turnOnly = process.argv.includes("--turn");
  const current = process.argv.includes("--current");
  const sessionsMode = process.argv.includes("--sessions");
  const table = process.argv.includes("--table");
  const card = process.argv.includes("--card");
  const outIdx = process.argv.indexOf("--out");
  const outFile = outIdx !== -1 ? process.argv[outIdx + 1] : null;
  const sid = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  if (sessionsMode) {
    // 多会话总览:每个近期会话一行,○ 生成中 / ◦ 活跃 / · 空闲
    const r = querySessions();
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      for (const s of r.sessions) {
        const icon = s.status === "generating" ? "●" : s.status === "active" ? "◦" : "·";
        const state = s.status === "generating" ? "生成中" : s.status === "active" ? "活跃" : "空闲";
        const rate =
          s.turn && s.turn.tokPerSec != null
            ? `本轮 ${s.turn.tokPerSec} tok/s${s.turn.requests > 1 ? `(${s.turn.requests} 段)` : ""}`
            : s.latest && s.latest.tokPerSec != null
              ? `最近 ${s.latest.tokPerSec} tok/s`
              : "暂无速率样本";
        const cum = s.session ? `累计 ${fmtCompact(s.session.totalOutput + s.session.totalReasoning)} tok` : "无数据";
        const t = s.lastAt ? new Date(s.lastAt).toLocaleTimeString("zh-CN", { hour12: false }) : "--:--:--";
        console.log(`${icon} ${s.label}  ${rate} · ${cum} · ${state}${s.cwd ? ` · ${s.cwd}` : ""} · ${t}`);
      }
    }
  } else if (turnOnly) {
    const r = queryTurn(sid, { current });
    if (json) console.log(JSON.stringify(r, null, 2));
    else if (card) {
      // --card --out <file>:有本问数据才落盘卡片(静默成功/失败,无输出即"无统计")
      if (r.turn && outFile) {
        try {
          fs.mkdirSync(path.dirname(outFile), { recursive: true });
          fs.writeFileSync(outFile, buildTurnCard(r));
        } catch {}
      }
    }
    else if (table && r.turn) console.log(formatTurnTable(r));
    else if (r.turn) console.log(formatTurnLine(r));
    // --current 且本问尚无数据:不输出任何行,调用方据此不显示统计(绝不回退到上一轮)
  } else {
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
}

export { query, queryTurn, querySessions, formatLine, formatTurnLine, formatTurnTable, buildTurnCard, fmtCompact, fmtNum };
