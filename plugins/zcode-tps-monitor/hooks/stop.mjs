#!/usr/bin/env node
// Stop hook:客户端在回复流结束/中断时触发(2026-10 起实测会触发,且时机不定——
// 曾观察到用户轮次进行中触发,而非仅在轮次结束时)。
// 职责:
// 1) 只更新**本会话**的分状态文件(~/.zcode/tps-monitor.sessions/<id>.json),且**绝不
//    覆盖 promptTs**——那是「本问统计」--current 守卫的依据;也**绝不写全局状态文件**,
//    以免覆写其他并发会话正在使用的记录(2026-10-21 串数据事故:amber 目录会话的
//    Stop 把全局 sessionId 改写后,Project 目录会话的「本轮」统计显示成了 amber 的数据)。
// 2) 可选直显(实验):配置 {"stopHookLine": true} 时经 systemMessage 显示本轮统计,
//    每个轮次最多显示一次。默认关闭——触发时机不定,避免过早/重复显示。
// 输出严格 JSON;任何异常静默退出,不影响对话。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryTurn, formatTurnLine } from "../scripts/token-rate.mjs";
import { recordStop, readSessionState, updateSessionState } from "../scripts/lib/session.mjs";

// stdin 是钩子入参 JSON(含 session_id 与 cwd);设超时兜底,客户端不给 stdin 也不挂起
function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(raw);
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", finish);
    setTimeout(finish, 1500);
  });
}

function readConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".zcode", "tps-monitor.config.json"), "utf8")
    );
  } catch {
    return {};
  }
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {}
  const sid =
    payload.session_id ||
    process.env.ZCODE_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "";
  // 只更新自己会话的分文件(sessionId/ts 跟随本次触发,promptTs 保留)
  recordStop(sid, payload.cwd);

  const cfg = readConfig();
  if (cfg.tokenRateLine === false || cfg.stopHookLine !== true) return;

  // 直显(实验):触发时机不定,等待数据就绪后按 turnId 去重,每轮最多显示一次
  let r = null;
  for (let i = 0; i < 5; i++) {
    r = queryTurn(sid || null);
    if (r && r.turn && r.turn.rated > 0) break;
    if (i < 4) await new Promise((res) => setTimeout(res, 250));
  }
  if (!r || !r.turn) return; // 无本轮数据(如中断轮)则不打扰
  const prev = readSessionState(sid) || {};
  if (prev.lastShown && prev.lastShown.turnId === r.turnId) return; // 本轮已显示过
  updateSessionState(sid, { lastShown: { turnId: r.turnId, at: Date.now() } });
  process.stdout.write(JSON.stringify({ systemMessage: formatTurnLine(r) }));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
