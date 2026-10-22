// 单元测试:node --test test/
// 覆盖 2026-10-21 跨会话串数据修复:
//   ① 按工作目录(cwd)解析会话(session 表 directory 匹配、time_updated 最新、跳过已删除)
//   ② Stop 钩子不跨会话覆写:只更新自己会话的分状态文件,绝不写全局状态文件
//   ③ --current 守卫优先读 cwd 匹配会话分文件里的提问时刻,其他会话覆写全局不影响判定
//   ④ 同目录多会话(主会话 + 子代理 actor 共享 directory):全局状态文件里 cwd 匹配的
//     显式记录(prompt-submit 由用户本人写入)优先于 time_updated 最新的 actor 会话
// 夹具为临时 SQLite 库 + 隔离的 HOME/状态文件,不依赖真机 ~/.zcode 数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

process.removeAllListeners("warning");
process.on("warning", () => {});

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "zcode-tps-monitor");

// --- 夹具(必须在导入被测模块前就绪,模块在加载时读取路径/环境) ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tps-session-test-"));
const dbFile = path.join(tmp, "db.sqlite");
process.env.ZCODE_USAGE_DB = dbFile;
process.env.TOKEN_RATE_WINDOW = "5";
process.env.TOKEN_RATE_HIST = "10";
process.env.TOKEN_RATE_MIN_MS = "100";
process.env.TOKEN_RATE_MAX_MS = "60000";
// 全局状态文件指向夹具;分会话状态目录默认落在其同目录(tmp/tps-monitor.sessions)
process.env.TPS_MONITOR_STATE_FILE = path.join(tmp, "state.json");

const DIR_A = path.join(tmp, "proj-a"); // 本会话(如 Project)
const DIR_B = path.join(tmp, "proj-b"); // 并发会话(如 amber)
const T0 = Date.now() - 60000;

const { DatabaseSync } = await import("node:sqlite");
{
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE model_usage (
    session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER, cache_read_input_tokens INTEGER,
    first_token_at INTEGER, completed_at INTEGER, time_to_first_token_ms INTEGER, turn_id TEXT)`);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, time_deleted INTEGER)`);
  const ins = db.prepare(
    "INSERT INTO model_usage VALUES (?, 'completed', 'main_turn', 'test-model', ?, 0, 120000, 118000, ?, ?, ?, ?)"
  );
  // 会话 A 本轮两段:160 + 200 tok/s → 加权 (80+220)/(500+1100)ms = 187.5
  ins.run("sA", 80, T0 + 6500, T0 + 7000, 450, "t_a");
  ins.run("sA", 220, T0 + 9000, T0 + 10100, 600, "t_a");
  // 会话 B 更晚完成的一条:成为"全局最新完成请求"(兜底解析会指向它)
  ins.run("sB", 100, T0 + 12000, T0 + 13000, 500, "t_b");
  // 同目录多会话:sA_old 更旧、sDel 最新但已删除——都必须让位给 sA
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run("sA_old", DIR_A, T0, T0 + 1000);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run("sA", DIR_A, T0, T0 + 20000);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run("sB", DIR_B, T0, T0 + 30000);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run("sDel", DIR_A, T0, T0 + 50000, T0 + 50000);
  db.close();
}

const sessionsDir = path.join(tmp, "tps-monitor.sessions");
const globalStateFile = process.env.TPS_MONITOR_STATE_FILE;

const { resolveSessionIdByCwd, lastPromptTs } = await import(
  pathToFileURL(path.join(PLUGIN, "scripts", "lib", "session.mjs")).href
);
const { queryTurn } = await import(pathToFileURL(path.join(PLUGIN, "scripts", "token-rate.mjs")).href);

function writeSessionState(sid, fields) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${sid}.json`), JSON.stringify(fields));
}

function writeGlobalState(fields) {
  fs.writeFileSync(globalStateFile, JSON.stringify(fields));
}

// 子进程跑钩子:stdin 喂 payload(含 session_id/cwd),HOME 隔离到夹具(防读到真机配置),
// 清掉可能残留的会话环境变量,确保钩子只能从 payload 拿到会话身份
function runHook(script, payload) {
  const env = { ...process.env };
  delete env.ZCODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  env.HOME = tmp;
  env.USERPROFILE = tmp;
  return spawnSync(process.execPath, [path.join(PLUGIN, "hooks", script)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
    timeout: 15000,
  });
}

// --- 按 cwd 解析会话 ---
test("resolveSessionIdByCwd:directory 精确匹配,取 time_updated 最新,跳过已删除行", () => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    assert.equal(resolveSessionIdByCwd(db, DIR_A), "sA"); // sDel 更新但已删除,sA_old 更旧
    assert.equal(resolveSessionIdByCwd(db, DIR_B), "sB");
    assert.equal(resolveSessionIdByCwd(db, path.join(tmp, "no-such-dir")), null);
    assert.equal(resolveSessionIdByCwd(db, null), null);
  } finally {
    db.close();
  }
});

test("resolveSessionIdByCwd:旧库无 session 表 → 返回 null 不抛错", () => {
  const legacy = new DatabaseSync(path.join(tmp, "legacy.sqlite"));
  legacy.exec("CREATE TABLE model_usage (session_id TEXT)");
  try {
    assert.equal(resolveSessionIdByCwd(legacy, DIR_A), null);
  } finally {
    legacy.close();
  }
});

test("无显式会话:process.cwd() 命中 session 表 → 优先于状态文件与全局最新", async () => {
  // 独立小库:当前测试进程的 cwd 有一条会话记录;状态文件与全局最新完成请求都指向别处
  const cwdDbFile = path.join(tmp, "cwd.sqlite");
  const db = new DatabaseSync(cwdDbFile);
  db.exec(`CREATE TABLE model_usage (
    session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER, cache_read_input_tokens INTEGER,
    first_token_at INTEGER, completed_at INTEGER, time_to_first_token_ms INTEGER, turn_id TEXT)`);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, time_deleted INTEGER)`);
  db.prepare("INSERT INTO session VALUES ('sCwd', ?, ?, ?, NULL)").run(process.cwd(), T0, T0 + 40000);
  db.close();
  writeGlobalState({ sessionId: "sB", ts: Date.now(), source: "test" }); // 状态文件指向 sB
  // DB 路径在模块加载时读取:带 query 重导入一份模块实例指向 cwd 库
  const prevDb = process.env.ZCODE_USAGE_DB;
  process.env.ZCODE_USAGE_DB = cwdDbFile;
  try {
    const mod = await import(pathToFileURL(path.join(PLUGIN, "scripts", "token-rate.mjs")).href + "?cwd");
    assert.equal(mod.queryTurn(null).sessionId, "sCwd"); // cwd 优先,不被状态文件干扰
  } finally {
    process.env.ZCODE_USAGE_DB = prevDb;
  }
});

test("无显式会话:cwd 查不到(session 表存在但无匹配)→ 回退状态文件", () => {
  // 测试进程 cwd 不在夹具 session 表里 → 走状态文件;全局最新完成请求属于 sB,必须选 sA
  writeGlobalState({ sessionId: "sA", ts: Date.now(), source: "test" });
  assert.equal(queryTurn(null).sessionId, "sA");
});

test("无显式会话:再无状态文件 → 回退全局最新完成请求", () => {
  fs.rmSync(globalStateFile, { force: true });
  assert.equal(queryTurn(null).sessionId, "sB");
});

// --- 钩子写状态文件规则 ---
test("prompt-submit 钩子:写入本会话分文件与全局文件,输出严格 JSON", () => {
  const res = runHook("prompt-submit.mjs", { session_id: "sA", cwd: DIR_A });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout); // stdout 必须是可解析的严格 JSON
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(typeof out.hookSpecificOutput.additionalContext === "string");
  const st = JSON.parse(fs.readFileSync(path.join(sessionsDir, "sA.json"), "utf8"));
  assert.equal(st.sessionId, "sA");
  assert.equal(st.source, "prompt-submit");
  assert.equal(st.cwd, DIR_A);
  assert.ok(Number.isFinite(st.promptTs) && st.promptTs <= Date.now());
  const g = JSON.parse(fs.readFileSync(globalStateFile, "utf8"));
  assert.equal(g.sessionId, "sA"); // 用户刚发消息 → 全局「最后会话」随之更新(符合语义)
});

test("session-start 钩子:同样写分文件+全局,输出严格 JSON", () => {
  const res = runHook("session-start.mjs", { session_id: "sB", cwd: DIR_B });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const st = JSON.parse(fs.readFileSync(path.join(sessionsDir, "sB.json"), "utf8"));
  assert.equal(st.sessionId, "sB");
  assert.equal(st.source, "session-start");
  assert.ok(Number.isFinite(st.promptTs));
  assert.equal(JSON.parse(fs.readFileSync(globalStateFile, "utf8")).sessionId, "sB");
});

test("Stop 钩子:只更新本会话分文件,绝不覆写全局状态文件", () => {
  // 复现事故前置:B(amber)刚写过全局文件;A(Project)分文件记录着本问提问时刻
  const PROMPT_AT = Date.now() - 5000;
  writeGlobalState({
    sessionId: "sB", cwd: DIR_B, ts: Date.now() - 1000,
    promptTs: Date.now() - 1000, source: "prompt-submit",
  });
  const before = fs.readFileSync(globalStateFile, "utf8");
  writeSessionState("sA", {
    sessionId: "sA", cwd: DIR_A, ts: PROMPT_AT, promptTs: PROMPT_AT, source: "prompt-submit",
  });
  const res = runHook("stop.mjs", { session_id: "sA", cwd: DIR_A });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), ""); // 未开 stopHookLine → 不直显,输出为空(客户端契约)
  assert.equal(fs.readFileSync(globalStateFile, "utf8"), before); // 全局文件逐字节不变,B 不被覆写
  const st = JSON.parse(fs.readFileSync(path.join(sessionsDir, "sA.json"), "utf8"));
  assert.equal(st.sessionId, "sA");
  assert.equal(st.source, "stop");
  assert.equal(st.promptTs, PROMPT_AT); // 提问时刻保留,不被 Stop 改写
  assert.ok(st.ts >= PROMPT_AT);
});

// --- --current 守卫 ---
test("--current 守卫:提问时刻取本会话分文件,其他会话覆写全局文件不影响判定", () => {
  // 复现串数据事故:全局文件已被 B 覆写且其 promptTs 早于 A 的数据(旧实现读全局 →
  // 守卫放行,把 A 的上一轮冒充"本问");A 自己的分文件记录着更晚的提问时刻
  // (本问尚无入库数据)→ 必须拦截
  writeGlobalState({
    sessionId: "sB", cwd: DIR_B, ts: Date.now(), promptTs: T0 - 30000, source: "prompt-submit",
  });
  writeSessionState("sA", {
    sessionId: "sA", cwd: DIR_A, ts: Date.now(), promptTs: Date.now(), source: "prompt-submit",
  });
  const r = queryTurn("sA", { current: true });
  assert.equal(r.noCurrentTurnData, true);
  assert.equal(r.turn, null);
});

test("--current 守卫:分文件 promptTs 早于本问数据 → 正常返回(全局文件更晚也不拦截)", () => {
  writeGlobalState({
    sessionId: "sB", cwd: DIR_B, ts: Date.now(), promptTs: Date.now() + 60000, source: "prompt-submit",
  });
  writeSessionState("sA", {
    sessionId: "sA", cwd: DIR_A, ts: Date.now(), promptTs: T0 - 30000, source: "prompt-submit",
  });
  const r = queryTurn("sA", { current: true });
  assert.equal(r.noCurrentTurnData, undefined);
  assert.equal(r.turn.tokPerSec, 187.5);
});

test("lastPromptTs:无分文件时回退全局文件(向后兼容)", () => {
  fs.rmSync(path.join(sessionsDir, "sB.json"), { force: true });
  writeGlobalState({ sessionId: "sB", ts: Date.now(), promptTs: T0 + 123, source: "test" });
  assert.equal(lastPromptTs("sB"), T0 + 123);
});

// --- 同目录多会话:主会话与子代理 actor 共享 directory(2026-10-21 二次串数据事故) ---
// 事故:模型工具进程环境无 ZCODE_SESSION_ID,主会话收尾跑 --turn --current 时,
// actor 会话 time_updated 更新 → 旧逻辑按 cwd 取最新误选 actor,把 actor 的 450 tok/s
// 当作主会话「本问」显示(正确 166.7);actor 无分状态文件,守卫回退全局 promptTs 拦不住。
test("同目录多会话:全局显式记录(cwd 匹配)优先于 time_updated 最新的 actor 会话", async () => {
  // 独立夹具库:sMain 与 sActor 的 directory 都是测试进程 cwd(actor 刚跑完,更新)
  const sharedDbFile = path.join(tmp, "shared-dir.sqlite");
  const NOW = Date.now();
  {
    const db = new DatabaseSync(sharedDbFile);
    db.exec(`CREATE TABLE model_usage (
      session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
      output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER, cache_read_input_tokens INTEGER,
      first_token_at INTEGER, completed_at INTEGER, time_to_first_token_ms INTEGER, turn_id TEXT)`);
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_deleted INTEGER)`);
    const insU = db.prepare(
      "INSERT INTO model_usage VALUES (?, 'completed', 'main_turn', 'test-model', ?, 0, 120000, 118000, ?, ?, ?, ?)");
    // 主会话本轮:500 tok / 3000ms → 166.7 tok/s(事故中的正确值)
    insU.run("sMain", 500, NOW - 5000, NOW - 2000, 500, "t_main");
    // actor 会话更晚完成:900 tok / 2000ms → 450 tok/s(事故中被误显的值)
    insU.run("sActor", 900, NOW - 1000, NOW + 1000, 400, "t_actor");
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run("sMain", process.cwd(), T0, NOW - 6000);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run("sActor", process.cwd(), T0, NOW);
    db.close();
  }
  // 前置自检:cwd 解析在该夹具下确实会误选 actor(保证测试复现的是事故路径)
  {
    const db = new DatabaseSync(sharedDbFile, { readOnly: true });
    try {
      assert.equal(resolveSessionIdByCwd(db, process.cwd()), "sActor");
    } finally {
      db.close();
    }
  }
  // prompt-submit 已由用户本人在主会话触发,为本目录显式记下会话;actor 不写全局/分文件
  writeGlobalState({
    sessionId: "sMain", cwd: process.cwd(),
    ts: NOW - 10000, promptTs: NOW - 10000, source: "prompt-submit",
  });
  writeSessionState("sMain", {
    sessionId: "sMain", cwd: process.cwd(),
    ts: NOW - 10000, promptTs: NOW - 10000, source: "prompt-submit",
  });
  // DB 路径在模块加载时读取:带 query 重导入一份模块实例指向共享目录夹具库
  const prevDb = process.env.ZCODE_USAGE_DB;
  process.env.ZCODE_USAGE_DB = sharedDbFile;
  let sharedMod;
  try {
    sharedMod = await import(pathToFileURL(path.join(PLUGIN, "scripts", "token-rate.mjs")).href + "?shared");
  } finally {
    process.env.ZCODE_USAGE_DB = prevDb;
  }
  const r = sharedMod.queryTurn(null, { current: true });
  assert.equal(r.sessionId, "sMain");     // 不再被 time_updated 更新的 actor 顶掉
  assert.equal(r.turn.tokPerSec, 166.7);  // 本问速率来自主会话,而非 actor 的 450
});

test("同目录多会话:全局记录目录不匹配 → 退回 cwd 解析(跨目录隔离不变)", async () => {
  // 用户最后的显式记录属于别的目录:不能拿来当本目录会话 → 保留原 cwd 解析行为
  writeGlobalState({
    sessionId: "sB", cwd: DIR_B, ts: Date.now(), promptTs: Date.now(), source: "prompt-submit",
  });
  const sharedMod = await import(pathToFileURL(path.join(PLUGIN, "scripts", "token-rate.mjs")).href + "?shared");
  assert.equal(sharedMod.queryTurn(null).sessionId, "sActor"); // cwd 路径:time_updated 最新
});

test("同目录多会话:全局记录过期(TTL)→ 退回 cwd 解析", async () => {
  writeGlobalState({
    sessionId: "sMain", cwd: process.cwd(),
    ts: Date.now() - 8 * 24 * 3600 * 1000, promptTs: Date.now() - 8 * 24 * 3600 * 1000,
    source: "prompt-submit",
  });
  const sharedMod = await import(pathToFileURL(path.join(PLUGIN, "scripts", "token-rate.mjs")).href + "?shared");
  assert.equal(sharedMod.queryTurn(null).sessionId, "sActor"); // 过期记录不作数
});
