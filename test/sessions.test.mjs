// 单元测试:node --test test/(0.10.0 多会话泳道)
// 覆盖 querySessions:
//   ① 会话枚举与排序(session 表窗口内 + usage 行兜底;窗口外/已删除不出现)
//   ② 每会话独立统计:同目录的主会话与子代理 actor 互不串数据,口径 main_turn 优先、
//     actor(无 main 行)退回全部行
//   ③ status 三态:近 8s 有完成段或 part 表有 running 工具 → generating;10 分钟内 →
//     active;更旧 → idle;只有 session 表记录的新会话也占一条空泳道
//   ④ 增量缓存:首轮后新插入的行,第二次调用(非 fresh)能看到且累计正确累加
//   ⑤ 旧库无 session 表(CLI 子进程):usage 行 distinct 出泳道
// 夹具为临时 SQLite 库,不依赖真机 ~/.zcode 数据。
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tps-sessions-test-"));
const dbFile = path.join(tmp, "db.sqlite");
process.env.ZCODE_USAGE_DB = dbFile;
process.env.TOKEN_RATE_MIN_MS = "100";
process.env.TOKEN_RATE_MAX_MS = "60000";

const DIR_A = path.join(tmp, "proj-a");   // 主会话 + actor 共享目录(同目录多会话)
const DIR_B = path.join(tmp, "proj-b");
const DIR_C = path.join(tmp, "proj-c");   // 只有 session 表记录的新会话
const DIR_D = path.join(tmp, "proj-old"); // 24h 窗口外,不该出现
const NOW = Date.now();
const T0 = NOW - 15 * 60_000; // 历史行统一落在 15 分钟前(> 10 分钟 → idle 区)

const { DatabaseSync } = await import("node:sqlite");
function buildDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE model_usage (
    session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER, cache_read_input_tokens INTEGER,
    first_token_at INTEGER, completed_at INTEGER, time_to_first_token_ms INTEGER, turn_id TEXT)`);
  return db;
}
{
  const db = buildDb(dbFile);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, time_deleted INTEGER)`);
  const ins = db.prepare(
    "INSERT INTO model_usage VALUES (?, 'completed', ?, 'test-model', ?, 0, 120000, 118000, ?, ?, ?, ?)"
  );
  // sA 主会话(全 main_turn):更早一轮 + 本轮两段 → 本轮 (80+220)/(500+1100)ms = 187.5
  ins.run("sA", "main_turn", 60, T0 + 1000, T0 + 1500, 400, "t_a0");
  ins.run("sA", "main_turn", 80, T0 + 6500, T0 + 7000, 450, "t_a");
  ins.run("sA", "main_turn", 220, T0 + 9000, T0 + 10100, 600, "t_a");
  // actor:与 sA 共享 directory,但行是 subagent 来源(无 main 行 → 全部行口径)
  ins.run("sActor", "subagent", 450, T0 + 8000, T0 + 9000, 300, "t_ac");
  // sB:最近 3 秒内完成 → generating
  ins.run("sB", "main_turn", 100, NOW - 4000, NOW - 3000, 500, "t_b");
  // 24h 窗口外的行:不该进泳道
  ins.run("sOld", "main_turn", 500, NOW - 25 * 3600_000, NOW - 25 * 3600_000 + 1000, 400, "t_old");
  const sess = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)");
  sess.run("sA", DIR_A, T0, T0 + 10100, null);
  sess.run("sActor", DIR_A, T0, T0 + 9000, null);
  sess.run("sB", DIR_B, T0, NOW - 3000, null);
  sess.run("sNew", DIR_C, NOW, NOW, null);            // 新会话无任何模型请求
  sess.run("sOld", DIR_D, NOW - 25 * 3600_000, NOW - 25 * 3600_000, null);
  // part 表:sNew 有 running 的 tool part → 即使无 usage 行也判定 generating。
  // time_updated 必须近期(生产查询限定近 10 分钟更新的 part,防全表 json_extract)
  db.exec("CREATE TABLE part (session_id TEXT, time_updated INTEGER, data TEXT)");
  db.prepare("INSERT INTO part VALUES (?, ?, ?)").run(
    "sNew",
    NOW - 1000,
    JSON.stringify({ type: "tool", state: { status: "running" } })
  );
  db.close();
}

const { querySessions, queryTurn } = await import(pathToFileURL(path.join(PLUGIN, "scripts", "token-rate.mjs")).href);

test("会话枚举:窗口内全出现、窗口外不出现,按最近活动排序", () => {
  const r = querySessions({ fresh: true });
  const ids = r.sessions.map((s) => s.sessionId);
  for (const want of ["sA", "sActor", "sB", "sNew"]) assert.ok(ids.includes(want), `${want} 应在泳道中`);
  assert.ok(!ids.includes("sOld"), "24h 窗口外的会话不该出现");
  // 排序:sB(3 秒前完成)与 sNew(running part)最新在前;sA(15 分钟前+101 秒)比
  // actor(15 分钟前+90 秒)更新,actor 最旧收尾
  assert.equal(ids[0] === "sB" || ids[0] === "sNew", true, "最新活动应排第一");
  assert.equal(r.sessions[r.sessions.length - 1].sessionId, "sActor", "活动最旧的 actor 应排最后");
  assert.equal(r.total >= 4, true, "total 不少于泳道数");
});

test("每会话独立统计:同目录主会话与 actor 互不串数据,口径 main_turn 优先", () => {
  const r = querySessions({ fresh: true });
  const by = Object.fromEntries(r.sessions.map((s) => [s.sessionId, s]));
  // sA:main_turn 口径,累计只含自己的 3 段(60+80+220),绝不混入 actor 的 450
  const a = by.sA;
  assert.equal(a.cwd, DIR_A);
  assert.equal(a.label, "proj-a");
  assert.equal(a.session.totalOutput, 360);
  assert.equal(a.session.requests, 3);
  // 最新一轮 t_a:两段加权 187.5,与单会话 queryTurn 一致
  assert.equal(a.turn.requests, 2);
  assert.equal(a.turn.tokPerSec, 187.5);
  const q = queryTurn("sA");
  assert.equal(q.turn.tokPerSec, a.turn.tokPerSec);
  // actor:无 main 行 → 全部行口径,自己的 450 tok / 450 tok/s
  const ac = by.sActor;
  assert.equal(ac.session.totalOutput, 450);
  assert.equal(ac.turn.tokPerSec, 450);
  assert.notEqual(ac.session.totalOutput, a.session.totalOutput, "actor 与主会话统计必须隔离");
  // sB 独立
  assert.equal(by.sB.session.totalOutput, 100);
});

test("status 三态:generating(完成段 8s 内 / part running)、active、idle;新会话占空泳道", () => {
  const r = querySessions({ fresh: true });
  const by = Object.fromEntries(r.sessions.map((s) => [s.sessionId, s]));
  assert.equal(by.sB.status, "generating", "3 秒前完成段 → generating");
  assert.equal(by.sNew.status, "generating", "part 表 running 工具 → generating");
  assert.equal(by.sA.status, "idle", "15 分钟前的活动 → idle");
  assert.ok(by.sNew.session === null && by.sNew.latest === null && by.sNew.turn === null, "新会话为空泳道");
  assert.equal(by.sNew.label, "proj-c");
});

test("增量缓存:首轮后新插入的行,第二次调用可见且累计正确", () => {
  const first = querySessions(); // 走缓存路径建立水位
  const before = first.sessions.find((s) => s.sessionId === "sA");
  assert.equal(before.session.totalOutput, 360);
  // 新一轮到达:100 tok / 1000ms = 100 tok/s,刚刚完成
  const db = new DatabaseSync(dbFile);
  db.prepare(
    "INSERT INTO model_usage VALUES (?, 'completed', 'main_turn', 'test-model', ?, 0, 120000, 118000, ?, ?, ?, ?)"
  ).run("sA", 100, NOW + 10_000, NOW + 11_000, 500, "t_a2");
  db.close();
  const second = querySessions(); // 非 fresh:增量拉新行
  const after = second.sessions.find((s) => s.sessionId === "sA");
  assert.equal(after.session.totalOutput, 460, "累计应加上新段");
  assert.equal(after.session.requests, 4);
  assert.equal(after.turn.requests, 1);
  assert.equal(after.turn.tokPerSec, 100, "最新轮切换到 t_a2");
  assert.equal(after.status, "generating", "新段刚完成 → generating");
  assert.equal(second.sessions[0].sessionId, "sA", "sA 变为最新活动,排到第一");
});

test("旧库无 session 表(CLI 子进程):usage 行 distinct 出泳道,label 退化为会话号", () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "tps-sessions-nosess-"));
  const db2File = path.join(tmp2, "db.sqlite");
  const db2 = buildDb(db2File);
  db2.prepare(
    "INSERT INTO model_usage VALUES (?, 'completed', 'main_turn', 'test-model', ?, 0, 120000, 118000, ?, ?, ?, ?)"
  ).run("sX", 200, NOW - 3000, NOW - 2000, 400, "t_x");
  db2.close();
  const res = spawnSync(process.execPath, [path.join(PLUGIN, "scripts", "token-rate.mjs"), "--sessions", "--json"], {
    env: { ...process.env, ZCODE_USAGE_DB: db2File },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(res.status, 0, "CLI 应正常退出");
  const out = JSON.parse(res.stdout);
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].sessionId, "sX");
  assert.equal(out.sessions[0].label, "sX".slice(0, 13));
  assert.equal(out.sessions[0].session.totalOutput, 200);
  // 人类可读模式
  const res2 = spawnSync(process.execPath, [path.join(PLUGIN, "scripts", "token-rate.mjs"), "--sessions"], {
    env: { ...process.env, ZCODE_USAGE_DB: db2File },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.match(res2.stdout, /sX/);
  assert.match(res2.stdout, /生成中|活跃|空闲/);
});
