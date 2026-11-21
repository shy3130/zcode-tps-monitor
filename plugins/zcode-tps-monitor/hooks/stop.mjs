#!/usr/bin/env node
// Stop hook: 更新本会话状态，不覆盖提问时间或全局状态。
import { recordStop } from "../scripts/lib/session.mjs";

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
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
