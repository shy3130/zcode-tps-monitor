#!/usr/bin/env node
// UserPromptSubmit hook: 记录提问时刻，并替换旧会话里的自动收尾指令。
import { recordPrompt } from "../scripts/lib/session.mjs";

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

function emit() {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "【TPS 显示】取消之前的自动收尾统计指令。速率由 ZCode 底栏显示。仅在用户明确要求查询时调用 TPS 工具或附加统计。",
      },
    })
  );
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
  // promptTs:本次提问时刻,--current 守卫的首选依据;写在解析顺序见 lib/session.mjs
  recordPrompt(sid, payload.cwd, "prompt-submit");

  emit();
}

main()
  .catch(emit)
  .finally(() => process.exit(0));
