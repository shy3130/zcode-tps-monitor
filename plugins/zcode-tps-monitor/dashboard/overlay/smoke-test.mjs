#!/usr/bin/env node
// 悬浮窗服务冒烟测试:以临时端口与 --cwd 拉起 overlay/server.mjs,断言 GET / 与
// /api/live 的字段存在且类型正确(允许 no-data,但结构必须完整),结束后杀掉子进程。
// 自带临时 usage 库夹具(用 node:sqlite 写入临时文件,字段对齐真实 model_usage/
// session/part 表中被查询的列),不依赖也不触碰真机 ~/.zcode 数据库与钩子状态文件
// (ZCODE_USAGE_DB / TPS_MONITOR_STATE_FILE / TPS_MONITOR_SESSIONS_DIR /
// TPS_MONITOR_OVERLAY_PID 全部指向临时目录)。文件名刻意不以 .test.mjs 结尾,
// 避免进入单元测试自动发现。用法:node smoke-test.mjs,退出码 0 通过 / 1 失败。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// 抑制 node:sqlite 的 ExperimentalWarning 噪音(须在动态 import 之前,同 server.mjs)
process.removeAllListeners("warning");
process.on("warning", () => {});
const { DatabaseSync } = await import("node:sqlite");

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "server.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tps-overlay-smoke-"));
const DB = path.join(TMP, "usage.sqlite");

const children = [];
let failures = 0;

// —— 夹具:三个分属不同目录的会话,覆盖 generating 的两条判定路径与 idle;场景 E 再
// 补一个与 A 同目录的 actor 会话(time_updated 更新)——
//   A:最近一段 2.5s 前完成 → completed_at 窗口内 → generating;本轮两段(模型→工具→模型)
//   B:最近完成在 60s 前(窗口外),但 part 表有 running 的 tool part → generating(part 路径)
//   C:只有 90s 前的完成记录、无 running part → idle
function buildFixture() {
  const db = new DatabaseSync(DB);
  const now = Date.now();
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, time_updated INTEGER, time_deleted INTEGER);
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, query_source TEXT,
      provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, first_token_at INTEGER, completed_at INTEGER, time_to_first_token_ms INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_input_tokens INTEGER);
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  const insSession = db.prepare(
    "INSERT INTO session (id, directory, time_created, time_updated, time_deleted) VALUES (?,?,?,?,NULL)");
  const insUsage = db.prepare(
    "INSERT INTO model_usage (id, session_id, turn_id, query_source, provider_id, model_id, status," +
    " started_at, first_token_at, completed_at, time_to_first_token_ms," +
    " input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  // 会话 A:两段均有效(gen ≥ 200ms 且有产出),本轮即时速率 = (600+700)/3.0s = 433.3
  insSession.run("smoke-a", path.join(TMP, "dirA"), now, now);
  insUsage.run("a1", "smoke-a", "turn-a", "main_turn", "p", "m", "completed",
    now - 13000, now - 12000, now - 11000, 900, 1000, 500, 100, 0);
  insUsage.run("a2", "smoke-a", "turn-a", "main_turn", "p", "m", "completed",
    now - 5000, now - 4500, now - 2500, 700, 2000, 700, 0, 0);
  // 会话 B:完成于窗口外 + running 的 tool part(json_extract 判定路径)
  insSession.run("smoke-b", path.join(TMP, "dirB"), now, now);
  insUsage.run("b1", "smoke-b", "turn-b", "main_turn", "p", "m", "completed",
    now - 62000, now - 61000, now - 60000, 800, 900, 400, 0, 0);
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)")
    .run("pb1", "msg-b1", "smoke-b", now - 30000, now - 1000,
      JSON.stringify({ type: "tool", tool: "Bash", state: { status: "running" } }));
  // 会话 C:只有久远的完成记录 → idle
  insSession.run("smoke-c", path.join(TMP, "dirC"), now, now);
  insUsage.run("c1", "smoke-c", "turn-c", "main_turn", "p", "m", "completed",
    now - 92000, now - 91000, now - 90000, 750, 800, 300, 0, 0);
  db.close();
}

// —— 工具函数 ——
function sleep(ms) {
  return new Promise(function (res) { setTimeout(res, ms); });
}

// 让内核分配一个空闲端口后立即释放(存在极小的复用竞争,失败时会以"未就绪"报错暴露)
function freePort() {
  return new Promise(function (res, rej) {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", function () {
      const p = s.address().port;
      s.close(function () { res(p); });
    });
    s.on("error", rej);
  });
}

// 拉起一个悬浮窗服务实例:环境变量全部指向临时路径,隔离真机数据
async function startOverlay(cwd, extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, "--port", String(port), "--cwd", cwd], {
    env: Object.assign({}, process.env, {
      ZCODE_USAGE_DB: DB,
      TPS_MONITOR_STATE_FILE: path.join(TMP, "state.json"), // 不存在 → 全局状态兜底必然为空
      TPS_MONITOR_SESSIONS_DIR: path.join(TMP, "sessions"),
      TPS_MONITOR_OVERLAY_PID: path.join(TMP, "overlay-" + port + ".pid"),
    }, extraEnv || {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", function (d) { out += d; });
  child.stderr.on("data", function (d) { err += d; });
  const base = "http://127.0.0.1:" + port;
  // 轮询 / 直到就绪(最长 10s),失败时带回子进程输出便于定位
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + "/", { cache: "no-store" });
      if (r.ok) return base;
    } catch {}
    await sleep(100);
  }
  throw new Error("server 未就绪 " + base + "\nstdout: " + out + "\nstderr: " + err);
}

async function live(base) {
  const r = await fetch(base + "/api/live", { cache: "no-store" });
  assert.equal(r.status, 200, "/api/live HTTP 状态");
  assert.ok((r.headers.get("content-type") || "").includes("application/json"), "/api/live Content-Type");
  return r.json();
}

// 字段存在且类型正确:八个顶层字段齐全;ts 为有限数字;sessionId string|null;
// follow.source 为 string;status 属于三值;turn/latest/session 为 null 或对象,
// history 为数字数组(近段速率曲线,旧→新,供悬浮窗 sparkline),
// 且对象内部的关键字段类型正确(结构对齐 token-rate.mjs 的 queryTurn/query 返回)。
function assertStructure(d) {
  assert.deepEqual(Object.keys(d).sort(),
    ["follow", "history", "latest", "session", "sessionId", "status", "ts", "turn"], "顶层字段");
  assert.ok(Array.isArray(d.history) && d.history.every(function (v) { return typeof v === "number"; }),
    "history 为数字数组");
  assert.ok(Number.isFinite(d.ts), "ts 为有限数字");
  assert.ok(d.sessionId === null || typeof d.sessionId === "string", "sessionId 类型");
  assert.ok(d.follow && typeof d.follow === "object" && typeof d.follow.source === "string", "follow.source 类型");
  assert.ok(["generating", "idle", "no-data"].indexOf(d.status) !== -1, "status 取值");
  [d.turn, d.latest, d.session].forEach(function (x, i) {
    const name = ["turn", "latest", "session"][i];
    assert.ok(x === null || typeof x === "object", name + " 为 null 或对象");
  });
  if (d.turn) {
    assert.equal(typeof d.turn.requests, "number", "turn.requests");
    assert.ok(d.turn.tokPerSec === null || typeof d.turn.tokPerSec === "number", "turn.tokPerSec");
    assert.ok(d.turn.ttftMs === null || typeof d.turn.ttftMs === "number", "turn.ttftMs");
    assert.equal(typeof d.turn.totalOutput, "number", "turn.totalOutput");
  }
  if (d.latest) {
    assert.equal(typeof d.latest.outputTokens, "number", "latest.outputTokens");
    assert.ok(d.latest.tokPerSec === null || typeof d.latest.tokPerSec === "number", "latest.tokPerSec");
  }
  if (d.session) {
    assert.equal(typeof d.session.totalOutput, "number", "session.totalOutput");
    assert.equal(typeof d.session.requests, "number", "session.requests");
  }
}

// 单项检查:通过打 ✓,失败记一笔并打 ✗(继续跑完其余项,最后统一退出码)
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { console.log("  ✓ " + name); })
    .catch(function (err) {
      failures++;
      console.error("  ✗ " + name + ": " + (err && err.message ? err.message : err));
    });
}

async function main() {
  buildFixture();
  console.log("[smoke] 夹具库: " + DB);

  // 场景 A:completed_at 落在 8s 窗口内 → generating;turn/latest/session 数据齐全
  const A = await startOverlay(path.join(TMP, "dirA"));
  await check("GET / 返回 overlay.html", async function () {
    const r = await fetch(A + "/", { cache: "no-store" });
    assert.equal(r.status, 200);
    assert.ok((r.headers.get("content-type") || "").includes("text/html"), "Content-Type html");
    const html = await r.text();
    assert.ok(html.indexOf("/api/live") !== -1 && html.indexOf("tok/s") !== -1, "页面包含轮询与单位");
  });
  await check("会话 A:cwd 解析 + completed_at 窗口 → generating", async function () {
    const d = await live(A);
    assertStructure(d);
    assert.equal(d.sessionId, "smoke-a", "按 --cwd 定位会话");
    assert.equal(d.follow.source, "cwd", "follow.source=cwd");
    assert.equal(d.status, "generating", "最近完成在 8s 内");
    assert.ok(d.turn, "turn 非空");
    assert.equal(d.turn.requests, 2, "本轮两段");
    assert.equal(d.turn.tokPerSec, 433.3, "本轮即时速率 (600+700)/3.0s");
    assert.equal(d.turn.totalOutput, 1200, "本轮输出");
    assert.ok(d.session, "session 非空");
    assert.equal(d.session.totalOutput, 1200, "会话累计输出");
    assert.equal(d.session.requests, 2, "会话请求段数");
    assert.ok(d.latest, "latest 非空");
    assert.equal(d.latest.outputTokens, 700, "latest 为最近一段");
  });

  // 场景 B:completed_at 在窗口外 + running tool part → generating(json_extract 判定路径)
  const B = await startOverlay(path.join(TMP, "dirB"));
  await check("会话 B:running tool part → generating", async function () {
    const d = await live(B);
    assertStructure(d);
    assert.equal(d.sessionId, "smoke-b");
    assert.equal(d.follow.source, "cwd");
    assert.equal(d.status, "generating", "60s 前完成,靠 part 判定");
    assert.ok(d.turn, "turn 非空");
    assert.equal(d.turn.requests, 1);
  });

  // 场景 C:数据久远且无 running part → idle
  const C = await startOverlay(path.join(TMP, "dirC"));
  await check("会话 C:无近期活动 → idle", async function () {
    const d = await live(C);
    assertStructure(d);
    assert.equal(d.sessionId, "smoke-c");
    assert.equal(d.status, "idle");
    assert.ok(d.turn, "idle 仍保留最近一轮数据");
  });

  // 场景 D:库不存在 → 结构完整的 no-data
  const D = await startOverlay(TMP, { ZCODE_USAGE_DB: path.join(TMP, "missing.sqlite") });
  await check("库缺失 → 结构完整的 no-data", async function () {
    const d = await live(D);
    assertStructure(d);
    assert.equal(d.sessionId, null);
    assert.equal(d.status, "no-data");
    assert.equal(d.turn, null);
    assert.equal(d.latest, null);
    assert.equal(d.session, null);
    assert.equal(typeof d.follow.source, "string");
  });

  // 场景 E:同目录多会话(主会话 + 子代理 actor)——全局状态文件里 cwd 匹配的显式记录
  // (prompt-submit 由用户本人写入,actor 不触发用户钩子)须优先于 time_updated 最新的
  // actor 会话;否则主会话跑过子代理后,悬浮窗会跟着 actor 显示别人的速率
  {
    const db = new DatabaseSync(DB);
    const now = Date.now();
    // actor 与 A 共享 directory 且 time_updated 更新:cwd 解析(次级手段)会误选它
    db.prepare("INSERT INTO session (id, directory, time_created, time_updated, time_deleted) VALUES (?,?,?,?,NULL)")
      .run("smoke-a-actor", path.join(TMP, "dirA"), now, now + 1000);
    db.close();
    fs.writeFileSync(path.join(TMP, "state.json"), JSON.stringify({
      sessionId: "smoke-a", cwd: path.join(TMP, "dirA"),
      ts: Date.now(), promptTs: Date.now(), source: "prompt-submit",
    }));
  }
  const E = await startOverlay(path.join(TMP, "dirA"));
  await check("同目录多会话:全局显式记录优先于 time_updated 最新的 actor", async function () {
    const d = await live(E);
    assertStructure(d);
    assert.equal(d.sessionId, "smoke-a", "跟随用户显式记录的主会话");
    assert.equal(d.follow.source, "global-state", "follow.source=global-state");
    assert.ok(d.turn, "turn 非空");
    assert.equal(d.turn.tokPerSec, 433.3, "主会话本轮速率,而非被 actor 顶掉");
  });
}

function cleanup() {
  children.forEach(function (c) {
    try { c.kill("SIGTERM"); } catch {}
  });
}

main()
  .then(function () {
    cleanup();
    // 给子进程一点时间退出并触发其 PID 清理
    return sleep(300);
  })
  .then(function () {
    if (failures) {
      console.error("[smoke] 失败 " + failures + " 项");
      process.exit(1);
    }
    console.log("[smoke] 全部通过");
    process.exit(0);
  })
  .catch(function (err) {
    console.error("[smoke] 运行出错: " + (err && err.stack ? err.stack : err));
    cleanup();
    process.exit(1);
  });

// 兜底清理:异常路径也要杀干净子进程并删除临时目录
process.on("exit", function () {
  children.forEach(function (c) {
    try { c.kill("SIGKILL"); } catch {}
  });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
