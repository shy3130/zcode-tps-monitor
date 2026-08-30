#!/usr/bin/env node
// 自检:检查插件运行依赖的各个环节,定位"速率行不见了"之类的问题。
// 用法:
//   node scripts/doctor.mjs           人类可读
//   node scripts/doctor.mjs --json    JSON(供程序消费)
// 退出码:存在 ❌ 项时为 1,否则 0。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.removeAllListeners("warning");
process.on("warning", () => {});

const HOME = os.homedir();
const DB_PATH =
  process.env.ZCODE_USAGE_DB || path.join(HOME, ".zcode", "cli", "db", "db.sqlite");
const STATE_FILE = path.join(HOME, ".zcode", "tps-monitor.last-session.json");
const CONFIG_FILE = path.join(HOME, ".zcode", "tps-monitor.config.json");
const PID_FILE = path.join(HOME, ".zcode", "tps-monitor.dashboard.pid");

// 钩子查询依赖的列(model_usage 表)
const REQUIRED_COLS = [
  "session_id", "status", "query_source", "model_id",
  "output_tokens", "reasoning_tokens", "input_tokens", "cache_read_input_tokens",
  "first_token_at", "completed_at", "time_to_first_token_ms",
];

function nodeVersionCheck() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  const ok = maj > 22 || (maj === 22 && min >= 5);
  return {
    name: "Node 版本",
    ok,
    detail: `当前 ${process.versions.node},需要 ≥ 22.5(内置 node:sqlite)`,
    hint: ok ? null : "升级 Node 后重试:nvm install 22 / 官网安装最新 LTS",
  };
}

async function dbCheck() {
  if (!fs.existsSync(DB_PATH)) {
    return {
      name: "usage 数据库",
      ok: false,
      detail: `未找到 ${DB_PATH}`,
      hint: "若 ZCode 数据不在默认位置,设置环境变量 ZCODE_USAGE_DB 指向 db.sqlite",
    };
  }
  let db;
  try {
    // 动态加载,避免不支持 node:sqlite 的 Node 在 import 阶段就崩
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (e) {
    return {
      name: "usage 数据库",
      ok: false,
      detail: `无法只读打开 ${DB_PATH}: ${e.message}`,
      hint: "确认文件为 SQLite 格式且未被独占锁定",
    };
  }
  try {
    const cols = db.prepare("PRAGMA table_info(model_usage)").all().map((c) => c.name);
    if (!cols.length) {
      return { name: "usage 数据库", ok: false, detail: "model_usage 表不存在", hint: "ZCode 版本过旧或尚未产生用量数据;发一条消息后再试" };
    }
    const missing = REQUIRED_COLS.filter((c) => !cols.includes(c));
    if (missing.length) {
      return {
        name: "usage 数据库", ok: false,
        detail: `model_usage 缺少列: ${missing.join(", ")}`,
        hint: "ZCode 版本变更了表结构,请升级插件或反馈 issue",
      };
    }
    const last = db
      .prepare("SELECT completed_at FROM model_usage WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
      .get();
    const ageMin = last ? Math.round((Date.now() - last.completed_at) / 60000) : null;
    return {
      name: "usage 数据库",
      ok: true,
      detail: `表结构完整;最近完成样本 ${ageMin == null ? "无" : ageMin + " 分钟前"}`,
      hint: null,
    };
  } finally {
    db.close();
  }
}

function stateFileCheck() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const age = Math.round((Date.now() - (st.ts || 0)) / 60000);
    return {
      name: "会话状态文件",
      ok: true,
      detail: `存在,sessionId=${String(st.sessionId).slice(0, 8)}…,更新于 ${age} 分钟前`,
      hint: null,
    };
  } catch {
    return {
      name: "会话状态文件",
      ok: false,
      detail: "不存在或不可读",
      hint: "钩子未运行过:确认插件已安装且会话已重开(钩子在安装/更新后需新会话才注册)",
    };
  }
}

function configCheck() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const off = cfg.tokenRateLine === false;
    return {
      name: "配置文件",
      ok: true,
      detail: off ? "tokenRateLine=false,速率行注入已关闭(属预期)" : "已读取,注入开启",
      hint: off ? "如需恢复注入,删除该文件或改回 true" : null,
    };
  } catch {
    return { name: "配置文件", ok: true, detail: "未配置(默认注入开启)", hint: null };
  }
}

function dashboardCheck() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    process.kill(pid, 0); // 探活
    const stopCmd = process.platform === "win32" ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
    return {
      name: "大屏进程",
      ok: true,
      detail: `运行中(PID ${pid})`,
      hint: `如需停止:${stopCmd}`,
    };
  } catch {
    return { name: "大屏进程", ok: true, detail: "未运行", hint: null };
  }
}

export async function runDoctor() {
  const results = [];
  results.push(nodeVersionCheck());
  results.push(await dbCheck());
  results.push(stateFileCheck());
  results.push(configCheck());
  results.push(dashboardCheck());
  return { checks: results, failed: results.filter((r) => !r.ok).length };
}

// --- CLI ---
if (process.argv[1] && process.argv[1].endsWith("doctor.mjs")) {
  const report = await runDoctor();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const c of report.checks) {
      console.log(`${c.ok ? "✅" : "❌"} ${c.name}:${c.detail}`);
      if (c.hint) console.log(`   ↳ ${c.hint}`);
    }
    console.log(report.failed ? `\n${report.failed} 项未通过` : "\n全部通过");
  }
  process.exitCode = report.failed ? 1 : 0;
}
