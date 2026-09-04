// 单元测试:node --test test/
// 用临时 SQLite 库做夹具,在导入被测模块前设置 ZCODE_USAGE_DB。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.removeAllListeners("warning");
process.on("warning", () => {});

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "zcode-tps-monitor");

// --- 夹具库(必须在导入 token-rate.mjs 之前就绪,模块在加载时读取路径/环境) ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tps-test-"));
const dbFile = path.join(tmp, "db.sqlite");
process.env.ZCODE_USAGE_DB = dbFile;
process.env.TOKEN_RATE_WINDOW = "5";
process.env.TOKEN_RATE_HIST = "10";
process.env.TOKEN_RATE_MIN_MS = "100";
process.env.TOKEN_RATE_MAX_MS = "60000";

const { DatabaseSync } = await import("node:sqlite");
{
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE model_usage (
    session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
    output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER, cache_read_input_tokens INTEGER,
    first_token_at INTEGER, completed_at INTEGER, time_to_first_token_ms INTEGER)`);
  const ins = db.prepare(
    "INSERT INTO model_usage VALUES (?, 'completed', 'main_turn', 'test-model', ?, ?, 120000, 118000, ?, ?, ?)"
  );
  // 速率 = (output + reasoning) / genMs
  ins.run("s1", 500, 100, 1000, 2000, 800);  // gen 1000ms → 600 tok/s(验证思考 token 计入分子)
  ins.run("s1", 900, 0, 2000, 5000, 700);    // gen 3000ms → 300 tok/s
  ins.run("s1", 80, 0, 6500, 7000, 450);     // gen 500ms  → 160 tok/s(最近有效 = 头条)
  ins.run("s1", 20, 0, 7550, 7600, 100);     // gen 50ms < MIN → 无速率,但计入累计
  // 非 main_turn:主对话存在时必须被排除
  db.exec("INSERT INTO model_usage VALUES ('s1', 'completed', 'sub', 'test-model', 999, 0, 120000, 118000, 8000, 9000, 500)");
  db.close();
}

const { query, formatLine, fmtCompact, fmtNum } = await import(pathToFileURL(path.join(PLUGIN, "scripts", "token-rate.mjs")).href);

// --- 换算规则 ---
test("fmtCompact 分档:<1k 原始、1k~1w 一位小数、1w~100w 取整 k、≥100w 一位小数 M", () => {
  assert.equal(fmtCompact(999), "999");
  assert.equal(fmtCompact(1600), "1.6k");
  assert.equal(fmtCompact(9800), "9.8k");
  assert.equal(fmtCompact(51300), "51k");
  assert.equal(fmtCompact(128600), "129k");
  assert.equal(fmtCompact(73818000), "73.8M");
  assert.equal(fmtCompact(2000000), "2.0M");
});

test("fmtNum 千分位", () => {
  assert.equal(fmtNum(2762), "2,762");
  assert.equal(fmtNum(128643), "128,643");
  assert.equal(fmtNum(275), "275");
});

test("速率含思考 token:600 = (500+100)/1s", () => {
  const r = query("s1");
  const first = r.history[0]; // 最早一条
  assert.equal(first.outputTokens, 500);
  assert.equal(first.tokPerSec, 600);
});

test("头条取最近有效样本,且排除无效与非主对话行", () => {
  const r = query("s1");
  assert.equal(r.latest.tokPerSec, 160);       // 最近有效是 gen 500ms 那条,而非 gen 50ms / sub 行
  assert.ok(r.history.every((h) => h.outputTokens !== 999)); // sub 行被过滤
  const invalid = r.history.find((h) => h.outputTokens === 20);
  assert.equal(invalid.tokPerSec, null);        // 过短生成无速率
});

test("窗口统计与会话累计(独立 SUM,不受窗口限制)", () => {
  const r = query("s1");
  assert.equal(r.session.samples, 3);
  assert.equal(r.session.avg, 353.3);          // (600+300+160)/3
  assert.equal(r.session.max, 600);
  assert.equal(r.session.totalOutput, 1500);   // 500+900+80+20(含无效速率行)
  assert.equal(r.session.totalReasoning, 100);
  assert.equal(r.session.requests, 4);         // 4 条 main_turn(sub 不计)
});

test("行文案:上轮标注、思考 token、会话累计", () => {
  const line = formatLine(query("s1"));
  assert.match(line, /\(上轮\)/);
  assert.match(line, /近3次均 353\.3 \/ 峰 600/);
  assert.match(line, /累计 1\.6k tok/);         // 1500+100
});

// --- doctor:对夹具环境应全绿 ---
test("doctor:夹具环境全部通过", async () => {
  fs.mkdirSync(path.join(tmp, ".zcode"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".zcode", "tps-monitor.last-session.json"),
    JSON.stringify({ sessionId: "sess_test", ts: Date.now(), source: "test" }));
  process.env.ZCODE_USAGE_DB = dbFile; // doctor 同样在加载时读取该变量
  const { runDoctor } = await import(pathToFileURL(path.join(PLUGIN, "scripts", "doctor.mjs")).href);
  const report = await runDoctor();
  assert.equal(report.failed, 0, JSON.stringify(report.checks, null, 2));
});
