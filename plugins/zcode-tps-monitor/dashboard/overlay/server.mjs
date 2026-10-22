#!/usr/bin/env node
// DSH 风格 TPS 悬浮窗服务:零第三方依赖,Node >= 22.5(node:sqlite)。
//   node dashboard/overlay/server.mjs [--port 17873] [--cwd <工作目录>] [--idle-exit 480]
// 供悬浮窗页面(WKWebView 加载 overlay.html)每秒轮询 /api/live;数据源同 token-rate.mjs,
// usage 库只读打开,不影响运行中的客户端。
// 会话解析(修复跨会话串数据,2026-10-21 事故):优先全局状态文件里 cwd 匹配的显式记录
// (同目录多会话时区分主会话与子代理 actor),其次按 --cwd 匹配 usage 库 session 表
// (directory 精确匹配、未删除行里 time_updated 最新)——并发会话工作目录不同,天然隔离,
// 其他会话的钩子对全局状态文件的覆写不再串进本悬浮窗;拿不到才回退全局状态文件 →
// 全局最新完成请求,follow.source 字段如实标注数据来自哪条路径。
// 环境变量同 token-rate.mjs:ZCODE_USAGE_DB 覆盖库路径,TPS_MONITOR_STATE_FILE /
// TPS_MONITOR_SESSIONS_DIR 覆盖钩子状态文件(测试隔离);另加 TPS_MONITOR_OVERLAY_PID
// 覆盖 PID 文件路径(冒烟测试不污染 ~/.zcode)。

// 抑制 node:sqlite 的 ExperimentalWarning 噪音:必须在动态 import 之前接管 warning 通道
// (静态 import 的内置模块在模块体执行前就已求值,届时再监听就晚了)。
process.removeAllListeners("warning");
process.on("warning", () => {});

const { DatabaseSync } = await import("node:sqlite");
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readGlobalState, globalSessionIdMatchingCwd, resolveSessionIdByCwd } from "../../scripts/lib/session.mjs";
import { query as tokenRateQuery, queryTurn as tokenRateTurnQuery } from "../../scripts/token-rate.mjs";

// 与 token-rate.mjs 一致的默认库路径(macOS/Linux: ~/.zcode/...;Windows: %USERPROFILE%\.zcode\...)
const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
// 生成态窗口:该会话最近一次 completed_at 落在窗口内视为"生成中"
// (model_usage 每段请求完成后才整行写入,秒级轮询下刚完成的段即代表轮次仍在推进)
const GENERATING_WINDOW_MS = 8000;

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx !== -1 ? Number(args[portIdx + 1]) || 17873 : 17873; // 避开大屏的 7423
const cwdIdx = args.indexOf("--cwd");
const CWD = path.resolve(cwdIdx !== -1 ? args[cwdIdx + 1] : process.cwd());
const HOST = "127.0.0.1";
// 空闲自退:连续无 HTTP 请求超过该分钟数则自动退出,避免关闭悬浮窗后残留后台进程
// (悬浮窗定位常驻,阈值比大屏的 3 小时宽,默认 8 小时;0 = 不自退)
const idleIdx = args.indexOf("--idle-exit");
const IDLE_EXIT_MIN = idleIdx !== -1 ? Number(args[idleIdx + 1]) : 480;
const here = path.dirname(fileURLToPath(import.meta.url));
const overlayHtml = fs.readFileSync(path.join(here, "overlay.html"), "utf8");

// PID 文件:供 /tps-doctor 探测运行状态并提供停止方式(与大屏的 .dashboard.pid 分开)
const PID_FILE =
  process.env.TPS_MONITOR_OVERLAY_PID ||
  path.join(os.homedir(), ".zcode", "tps-monitor.overlay.pid");
function writePid() {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {}
}
function cleanup() {
  try {
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
}
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("exit", cleanup);

// 会话解析(仅 --cwd 一处与大屏不同:大屏跟随全局状态文件,悬浮窗按目录锁定):
//   ① 全局状态文件里 cwd 与 --cwd 一致的 sessionId——prompt-submit 由用户本人显式写入,
//      同目录多会话(主会话 + 共享 directory 的子代理 actor)时唯一能区分两者的依据,
//      优先于 time_updated 最新(actor 刚跑完会最新,但不是悬浮窗要跟随的主会话);
//   ② --cwd 匹配 session 表(directory 精确、未删除、time_updated 最新)——跨会话隔离
//      的关键(全局记录缺失/过期/目录不匹配时);
//   ③ 全局状态文件里「用户最后所处的会话」(目录匹配不到时的跟随兜底);
//   ④ 全局最近一次完成请求所属的会话。
// follow.source 字段如实标注数据来自哪条路径。
function resolveFollowedSession(db, cwd) {
  const fromGlobal = globalSessionIdMatchingCwd(cwd);
  if (fromGlobal) return { sid: fromGlobal, source: "global-state" };
  const byCwd = resolveSessionIdByCwd(db, cwd);
  if (byCwd) return { sid: byCwd, source: "cwd" };
  const st = readGlobalState();
  if (st && st.sessionId) return { sid: st.sessionId, source: "global-state" };
  try {
    const row = db
      .prepare("SELECT session_id FROM model_usage WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
      .get();
    if (row) return { sid: row.session_id, source: "latest-request" };
  } catch {}
  return { sid: null, source: "auto" };
}

// 生成态判定:usage 库无流式增量(model_usage 整行后写、part 段完成后才可见),"生成中"
// 只能由两个迹象推断——
//   ① 该会话最近一次 completed_at 在 8 秒窗口内(刚有一段完成,轮次大概率仍在走);
//   ② part 表存在该会话 state.status 为 running 的 tool part(工具调用正在执行,json_extract 查询)。
function isGenerating(db, sid, now) {
  try {
    const row = db
      .prepare("SELECT completed_at FROM model_usage WHERE session_id = ? ORDER BY completed_at DESC LIMIT 1")
      .get(sid);
    if (row && Number.isFinite(row.completed_at) && now - row.completed_at <= GENERATING_WINDOW_MS) {
      return true;
    }
  } catch {}
  try {
    const row = db
      .prepare(
        "SELECT 1 FROM part WHERE session_id = ?" +
          " AND json_extract(data, '$.type') = 'tool'" +
          " AND json_extract(data, '$.state.status') = 'running' LIMIT 1"
      )
      .get(sid);
    if (row) return true;
  } catch {} // 旧版客户端的库没有 part 表
  return false;
}

// /api/live 载荷:turn/session 取 token-rate.mjs 的 queryTurn 返回、latest 取 query 返回,
// 无数据时为 null;status 取值 generating|idle|no-data——生成中判定优先(首段在途时
// turn/latest 尚为 null 但 part 已 running),否则有任意数据为 idle、全空为 no-data。
function livePayload() {
  const now = Date.now();
  const empty = {
    ts: now,
    sessionId: null,
    follow: { source: "auto" },
    status: "no-data",
    turn: null,
    latest: null,
    session: null,
    history: [],
  };
  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    return empty; // usage 库不存在/无法打开 → 返回结构完整的 no-data
  }
  try {
    const { sid, source } = resolveFollowedSession(db, CWD);
    if (!sid) return empty;
    const generating = isGenerating(db, sid, now);
    // 会话由上方按 cwd 解析后显式传入,query/queryTurn 不再落回其内部的 process.cwd() 兜底
    let turn = null;
    let session = null;
    let latest = null;
    // 近段速率曲线(旧→新,无效样本剔除),供悬浮窗页面绘制 sparkline
    let history = [];
    try {
      const q = tokenRateTurnQuery(sid);
      turn = q.turn || null;
      session = q.session || null;
    } catch {}
    try {
      const q = tokenRateQuery(sid);
      latest = q.latest || null;
      history = (q.history || []).map((i) => i.tokPerSec).filter((v) => v != null);
    } catch {}
    const status = generating
      ? "generating"
      : turn || latest || session
        ? "idle"
        : "no-data";
    return { ts: now, sessionId: sid, follow: { source }, status, turn, latest, session, history };
  } finally {
    db.close();
  }
}

let lastRequestAt = Date.now();
const server = http.createServer((req, res) => {
  lastRequestAt = Date.now();
  // 路由只看路径,剥掉查询串(如 /?style=line 的单行模式参数由页面自行读取)
  const path = (req.url || "/").split("?")[0];
  if (path === "/" || path.startsWith("/overlay")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(overlayHtml);
    return;
  }
  if (path.startsWith("/api/live")) {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(livePayload()));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[zcode-tps-monitor] 悬浮窗服务已启动: http://${HOST}:${PORT}   跟随目录: ${CWD}`);
  if (IDLE_EXIT_MIN > 0) {
    console.log(`[zcode-tps-monitor] ${IDLE_EXIT_MIN} 分钟无访问将自动退出(--idle-exit 0 关闭该行为)`);
  }
  writePid();
});

// 空闲自退巡检:取空闲阈值的一半作为巡检间隔(夹紧在 1s~60s)
if (IDLE_EXIT_MIN > 0) {
  const tick = Math.min(60000, Math.max(1000, (IDLE_EXIT_MIN * 60 * 1000) / 2));
  const timer = setInterval(() => {
    if (Date.now() - lastRequestAt > IDLE_EXIT_MIN * 60 * 1000) {
      console.log("[zcode-tps-monitor] 长时间无访问,悬浮窗服务自动退出");
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    }
  }, tick);
  timer.unref();
}
