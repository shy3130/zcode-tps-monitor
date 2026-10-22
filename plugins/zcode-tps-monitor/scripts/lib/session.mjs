// 会话解析与钩子状态读写:供 scripts/token-rate.mjs、hooks/* 与后续悬浮窗服务复用。
// usage 库查询一律只读;状态文件仅由钩子侧写入。
// 状态文件分两层:
//   全局   ~/.zcode/tps-monitor.last-session.json     「用户最后所处的会话」(大屏跟随/兜底)
//   分会话 ~/.zcode/tps-monitor.sessions/<id>.json    每个会话独立的提问时刻(--current 守卫依据)
// 跨会话串数据事故(2026-10-21 实测):全局文件被所有会话共享,任何会话的钩子都会覆写
// 其 sessionId,导致并发会话的「本轮」统计张冠李戴——修复后守卫优先读 cwd 匹配会话的
// 分文件,Stop 钩子不再触碰全局文件。
// 同日二次事故(同目录多会话):主会话跑子代理时,actor 会话与主会话共享 directory,
// 按 cwd 取 time_updated 最新会误选 actor,把 actor 的速率当作主会话「本问」——修复为
// 全局记录(cwd 匹配,prompt-submit 由用户本人显式写入)优先,见 globalSessionIdMatchingCwd。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 过旧的状态文件视为失效(与大屏跟随逻辑一致)
export const STATE_TTL_MS = 7 * 24 * 3600 * 1000;

// 全局状态文件:TPS_MONITOR_STATE_FILE 可覆盖(多实例/测试)
export function globalStateFile() {
  return (
    process.env.TPS_MONITOR_STATE_FILE ||
    path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json")
  );
}

// 分会话状态目录:默认与全局状态文件同目录(<dir>/tps-monitor.sessions/<id>.json),
// 使 TPS_MONITOR_STATE_FILE 的覆盖天然隔离测试与多实例;TPS_MONITOR_SESSIONS_DIR 可显式指定
export function sessionsDir() {
  return (
    process.env.TPS_MONITOR_SESSIONS_DIR ||
    path.join(path.dirname(globalStateFile()), "tps-monitor.sessions")
  );
}

export function sessionStateFile(sid) {
  return path.join(sessionsDir(), `${sid}.json`);
}

// 读状态文件(全局/分会话共用):不存在、非 JSON、缺 ts 或超过 TTL 均视为无记录
function readJsonTtl(file, ttlMs) {
  try {
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!st || !Number.isFinite(st.ts) || Date.now() - st.ts > ttlMs) return null;
    return st;
  } catch {
    return null;
  }
}

export function readGlobalState(ttlMs = STATE_TTL_MS) {
  return readJsonTtl(globalStateFile(), ttlMs);
}

// 指定会话的分状态文件(不存在/过旧 → null)
export function readSessionState(sid, ttlMs = STATE_TTL_MS) {
  if (!sid) return null;
  return readJsonTtl(sessionStateFile(sid), ttlMs);
}

function writeJson(file, fields) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fields));
  } catch {}
}

// 分状态文件浅合并写(Stop 的去重记录等附加字段;不触碰全局文件)
export function updateSessionState(sid, patch) {
  if (!sid) return null;
  const prev = readSessionState(sid) || {};
  const next = { ...prev, ...patch };
  writeJson(sessionStateFile(sid), next);
  return next;
}

// prompt-submit / session-start:记录提问时刻。写本会话分文件 + 全局文件(全局仅表达
// 「用户最后所处的会话」,供大屏跟随与旧路径兜底;这两个事件都来自用户本人,语义成立)
export function recordPrompt(sid, cwd, source) {
  if (!sid) return;
  const now = Date.now();
  // promptTs:本次提问时刻,--current 守卫的唯一依据;Stop 更新分文件时会保留它而非覆盖
  const fields = { sessionId: sid, cwd: cwd || null, ts: now, promptTs: now, source };
  writeJson(sessionStateFile(sid), fields);
  writeJson(globalStateFile(), fields);
}

// Stop:只更新自己会话的分文件,绝不写全局——正在被其他会话使用的全局记录不受干扰
// (Stop 覆写全局 sessionId 正是 2026-10-21 串数据事故的根因)。promptTs 保留提问时刻
// (来源须是 prompt-submit/session-start),缺失时以当前时刻兜底,下一条消息即自愈。
export function recordStop(sid, cwd) {
  if (!sid) return;
  const prev = readSessionState(sid) || {};
  let promptTs = Date.now();
  if (Number.isFinite(prev.promptTs)) promptTs = prev.promptTs;
  updateSessionState(sid, {
    sessionId: sid,
    cwd: cwd || prev.cwd || null,
    ts: Date.now(),
    promptTs,
    source: "stop",
  });
}

// 全局状态文件里「用户显式记在本目录的会话」:prompt-submit / session-start 都来自
// 用户本人,写入时带上 cwd——若目录与当前一致,说明本目录的会话身份有明确记录,应优先
// 信任。同目录多会话(主会话跑子代理,actor 会话与主会话共享 directory)时这是唯一能把
// 两者分开的依据:actor 不触发用户钩子、不覆写该记录,而按 time_updated 取最新会误选
// 刚跑完的 actor(2026-10-21 二次串数据事故:主会话收尾把 actor 的 450 tok/s 当作本问,
// 正确值 166.7)。记录缺失/过期(TTL)/缺 cwd/目录不匹配时返回 null,交回 cwd 解析。
export function globalSessionIdMatchingCwd(cwd) {
  if (!cwd) return null;
  const st = readGlobalState();
  if (!st || !st.sessionId || !st.cwd) return null;
  try {
    if (path.resolve(st.cwd) !== path.resolve(cwd)) return null;
  } catch {
    return null;
  }
  return st.sessionId;
}

// 按工作目录解析会话:session 表 directory 精确匹配,未删除的行里取 time_updated 最新
// (会话有活动时 usage 库持续刷新 time_updated,最新行即该目录下的活跃会话)。缺陷:
// 同目录多会话(主会话 + 子代理 actor)时「最新」可能是 actor 而非主会话,故只作为
// globalSessionIdMatchingCwd 之后的次级手段。
// 旧版客户端的库没有 session 表/列时返回 null,由上层回退其他解析方式。全部只读。
export function resolveSessionIdByCwd(db, cwd) {
  if (!cwd) return null;
  try {
    const row = db
      .prepare(
        "SELECT id FROM session" +
          " WHERE directory = ? AND (time_deleted IS NULL OR time_deleted = 0)" +
          " ORDER BY time_updated DESC LIMIT 1"
      )
      .get(cwd);
    return row ? row.id : null;
  } catch {
    return null;
  }
}

// 本问提问时刻(--current 守卫依据):优先本会话的分状态文件(会话由全局显式记录或
// cwd 匹配解析),拿不到再回退全局文件;两级都先取 promptTs,旧格式缺失时退化为 ts。
export function lastPromptTs(sid) {
  const per = readSessionState(sid);
  if (per) {
    const t = Number.isFinite(per.promptTs) ? per.promptTs : per.ts;
    if (Number.isFinite(t)) return t;
  }
  const g = readGlobalState();
  if (g) {
    const t = Number.isFinite(g.promptTs) ? g.promptTs : g.ts;
    if (Number.isFinite(t)) return t;
  }
  return null;
}
