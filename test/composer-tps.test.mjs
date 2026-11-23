import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { activate } from "../plugins/zcode-tps-monitor/extension.mjs";

test("composer shows and restores per-session TPS on ZCode 3.18.2 and later", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tps-composer-test-"));
  const app = join(root, "app.asar");
  mkdirSync(app);
  process.env.ZCODE_USAGE_DB = join(root, "usage.sqlite");
  process.env.TPS_MONITOR_STATE_FILE = join(root, "state.json");
  process.env.TPS_MONITOR_SESSIONS_DIR = join(root, "sessions");
  process.env.TOKEN_RATE_MIN_MS = "1";
  mkdirSync(process.env.TPS_MONITOR_SESSIONS_DIR);
  const db = new DatabaseSync(process.env.ZCODE_USAGE_DB);
  db.exec(`CREATE TABLE message (session_id TEXT, data TEXT);
           CREATE TABLE model_usage (
             session_id TEXT, status TEXT, query_source TEXT, model_id TEXT,
             output_tokens INTEGER, reasoning_tokens INTEGER, input_tokens INTEGER,
             cache_read_input_tokens INTEGER, first_token_at INTEGER, completed_at INTEGER,
             time_to_first_token_ms INTEGER, turn_id TEXT
           );`);
  const addMessage = db.prepare("INSERT INTO message VALUES (?, ?)");
  for (const data of [{ role: "user" }, { role: "user", synthetic: true }, { role: "assistant" }]) {
    addMessage.run("sess-a", JSON.stringify(data));
  }
  const addRequest = db.prepare(
    "INSERT INTO model_usage VALUES (?, 'completed', 'main_turn', 'fixture', ?, 0, 100, 0, ?, ?, ?, ?)"
  );
  const now = Date.now();
  addRequest.run("sess-a", 83, now - 6000, now - 5968, 750, "turn-1");
  addRequest.run("sess-a", 15, now - 5000, now - 4974, 350, "turn-1");

  Object.defineProperty(process, "resourcesPath", { value: root, configurable: true });
  t.after(() => {
    db.close();
    delete process.resourcesPath;
    rmSync(root, { recursive: true, force: true });
  });

  async function load(version, sessionId, locale = "zh-CN") {
    writeFileSync(join(app, "package.json"), JSON.stringify({ version }));
    const display = new Map();
    const tooltips = new Map();
    const commands = new Map();
    const views = new Map();
    const opened = [];
    let select, receive, changeLocale;
    await activate({
      extension: { dataPath: join(root, "data") },
      log: { warn() {} },
      env: locale == null ? undefined : {
        onDidChange(listener) {
          changeLocale = listener;
          listener({ locale });
        },
      },
      commands: { register(id, run) { commands.set(id, run); } },
      views: {
        register(id, view) { views.set(id, view); },
        async open(id, scope) { opened.push({ id, scope }); },
      },
      slots: {
        update(id, { text, tooltip }, scope) {
          display.set(scope.sessionId ?? scope, text);
          tooltips.set(scope.sessionId ?? scope, tooltip);
        },
      },
      workbench: {
        async visibleSessions() { return [{ sessionId }]; },
        onDidChange(listener) { select = listener; },
      },
      models: { onDidGenerate(listener) { receive = listener; } },
    });
    return {
      display,
      tooltips,
      commands,
      views,
      opened,
      setLocale: (locale) => changeLocale({ locale }),
      switchTo: (id) => select({ sessions: [{ sessionId: id }] }),
      generate: (id, phase, rate) => receive({ sessionId: id, requestId: "request-1", phase, outputTokensPerSecond: rate }),
    };
  }

  for (const version of ["3.17.2", "3.18.0", "3.18.1"]) {
    assert.equal((await load(version, "sess-a")).display.size, 0, version);
  }

  const current = await load("3.18.2", "sess-a");
  assert.equal(current.display.get("app"), "— tok/s");
  assert.equal(current.display.get("sess-a"), "— tok/s");
  assert.match(current.tooltips.get("sess-a"), /会话 1 轮 · 最近一轮 2 段/);
  assert.match(current.tooltips.get("sess-a"), /最近一轮 2 段\n\n输出 98 tok/);
  assert.match(current.tooltips.get("sess-a"), /峰值 \/ 均速 · 样本过短/);
  assert.match(current.tooltips.get("sess-a"), /净生成 58 毫秒/);
  current.setLocale("en-US");
  assert.match(current.tooltips.get("sess-a"), /1 turn · 2 segments last turn\n\nOutput 98 tok/);
  assert.match(current.tooltips.get("sess-a"), /Peak \/ Avg · Sample too short/);
  assert.match(current.tooltips.get("sess-a"), /TTFT 0.8 s · Net gen 58 ms/);
  assert.match(current.tooltips.get("app"), /Open TPS monitor$/);
  current.setLocale("zh-TW");
  assert.match(current.tooltips.get("sess-a"), /净生成 58 毫秒/);
  assert.equal(current.views.get("dashboard").entry, "./dashboard/index.html");
  await current.commands.get("open-dashboard")({ scope: { kind: "session", sessionId: "sess-a" } });
  assert.deepEqual(current.opened, [{ id: "dashboard", scope: { sessionId: "sess-a" } }]);
  writeFileSync(join(root, "sessions", "sess-a.json"), JSON.stringify({ ts: now, promptTs: now - 1800 }));
  addMessage.run("sess-a", JSON.stringify({ role: "user" }));
  await current.generate("sess-a", "streaming", 42.1);
  assert.equal(current.display.get("sess-a"), "42.1 tok/s");
  assert.match(current.tooltips.get("sess-a"), /^42\.1 tok\/s · 流式估算/);
  assert.match(current.tooltips.get("sess-a"), /会话 2 轮 · 本轮等待请求完成/);
  assert.doesNotMatch(current.tooltips.get("sess-a"), /输出 98 tok/);
  addRequest.run("sess-a", 1500, now - 1600, now - 1401, 200, "turn-2"); // 199 ms：仅计总量和耗时
  addRequest.run("sess-a", 80, now - 1300, now - 1100, 60, "turn-2"); // 200 ms：有效，400 tok/s
  addRequest.run("sess-a", 120, now - 1000, now - 600, 100, "turn-2"); // 400 ms：有效，300 tok/s
  await current.generate("sess-a", "final", 39.8);
  assert.match(current.tooltips.get("sess-a"), /本轮 3 段\n\n输出 1.7k tok/);
  assert.match(current.tooltips.get("sess-a"), /峰值 400.0 · 均速 333.3 tok\/s/);
  assert.match(current.tooltips.get("sess-a"), /首字 0.2 秒 · 净生成 799 毫秒/);
  addRequest.run("sess-a", 20, now - 550, now - 349, 100, "turn-2");
  await current.generate("sess-a", "final", 39.8);
  assert.match(current.tooltips.get("sess-a"), /净生成 1.0 秒/);
  await current.switchTo("sess-b");
  assert.equal(current.display.get("sess-b"), "— tok/s");
  await current.generate("sess-b", "final", 112.6);
  assert.equal(current.display.get("sess-a"), "39.8 tok/s");

  const restarted = await load("3.19.0", "sess-b");
  assert.equal(restarted.display.get("sess-b"), "112.6 tok/s");
  await restarted.switchTo("sess-a");
  assert.equal(restarted.display.get("sess-a"), "39.8 tok/s");

  for (const [rate, text] of [[999.9, "999.9"], [1000, "1k"], [999950, "1M"], [1e9, "1B"]]) {
    await current.generate("sess-large", "streaming", rate);
    assert.equal(current.display.get("sess-large"), `${text} tok/s`);
  }
  current.setLocale("en-GB");
  assert.match(current.tooltips.get("sess-large"), /^1B tok\/s · Live estimate\n/);
  assert.match(current.tooltips.get("sess-large"), /Waiting for request to finish/);
  await current.switchTo("sess-b");
  assert.match(current.tooltips.get("sess-b"), /No request stats/);
  assert.equal(current.display.get("sess-a"), "39.8 tok/s");
  current.setLocale("zh-CN");
  addMessage.run("sess-large", JSON.stringify({ role: "user" }));
  addRequest.run("sess-large", 2_500_000_000, now - 1500, now - 500, 200, "turn-large");
  db.prepare("UPDATE model_usage SET reasoning_tokens = ? WHERE session_id = ?").run(1_200_000, "sess-large");
  await current.generate("sess-large", "final", 2_500_000_000);
  const tooltip = current.tooltips.get("sess-large");
  assert.match(tooltip, /^2\.5B tok\/s · 最近一段\n/);
  assert.match(tooltip, /输出 2\.5B tok · 思考 1\.2M tok\n峰值 2\.5B · 均速 2\.5B tok\/s/);
  assert.match(tooltip, /\n\n点击打开监控面板$/);
  assert.ok(tooltip.length <= 200);

  const localized = await load("3.19.0", "sess-large", "en-US");
  const english = localized.tooltips.get("sess-large");
  assert.match(english, /^2\.5B tok\/s · Last segment\n1 turn · 1 segment last turn/);
  assert.match(english, /Output 2\.5B tok · Reasoning 1\.2M tok\nPeak 2\.5B · Avg 2\.5B tok\/s/);
  assert.match(english, /TTFT 0.2 s · Net gen 1.0 s\nTotal 1.2 s\n\nOpen TPS monitor$/);
  assert.ok(english.length <= 200);

  const system = await load("3.18.2", "sess-b", null);
  assert.equal(system.display.get("sess-b"), "112.6 tok/s");
});
