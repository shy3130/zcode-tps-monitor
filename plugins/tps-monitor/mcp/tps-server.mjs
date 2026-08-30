#!/usr/bin/env node
// tps-monitor 的 stdio MCP server。协议实现沿用官方 example-plugin 的
// Content-Length 帧 + 换行 JSON 兼容写法,业务逻辑复用 scripts/lib/collect-core.mjs。
//
// 手工冒烟测试:
//   printf '%s\n' \
//     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
//     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
//     | node mcp/tps-server.mjs

import { snapshot, watch, formatSnapshot, formatWatch } from "../scripts/lib/collect-core.mjs";

const SERVER_INFO = { name: "tps-monitor", version: "0.1.0" };

const TOOLS = [
  {
    name: "tps_snapshot",
    description:
      "获取一次 TPS 吞吐快照:当前 TPS、延迟 p50/p95/p99、错误率,以及本机 CPU/内存使用。无需参数。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tps_watch",
    description:
      "按秒采样观察 TPS 一段时间,返回平均/最小/最大与延迟、错误率统计。seconds: 2-30,默认 5。",
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "integer", minimum: 2, maximum: 30, description: "采样秒数" },
      },
    },
  },
];

function writeMessage(message) {
  const body = JSON.stringify(message);
  // MCP stdio 帧:Content-Length 头 + 体(同时兼容简单客户端的裸 JSON 行)
  const payload = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  process.stdout.write(payload);
}

const ok = (id, result) => writeMessage({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) =>
  writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (id === undefined || id === null) {
    return; // 通知(如 initialized)直接忽略
  }

  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        if (name === "tps_snapshot") {
          const s = await snapshot();
          ok(id, { content: [{ type: "text", text: formatSnapshot(s) }], isError: false });
        } else if (name === "tps_watch") {
          const sec = Math.min(30, Math.max(2, Number(args.seconds) || 5));
          const w = await watch(sec);
          ok(id, { content: [{ type: "text", text: formatWatch(w) }], isError: false });
        } else {
          fail(id, -32601, `Unknown tool: ${name}`);
        }
      } catch (err) {
        ok(id, {
          content: [{ type: "text", text: `[tps-monitor] 采集失败: ${err.message}` }],
          isError: true,
        });
      }
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

function handleRaw(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (Array.isArray(msg)) {
    for (const item of msg) handleRequest(item);
    return;
  }
  handleRequest(msg);
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      const asText = buffer.toString("utf8");
      if (asText.includes("\n") && asText.trimStart().startsWith("{")) {
        const lines = asText.split(/\r?\n/);
        buffer = Buffer.from(lines.pop() || "", "utf8");
        for (const line of lines) handleRaw(line);
      }
      break;
    }
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) break;
    handleRaw(buffer.slice(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.slice(bodyEnd);
  }
});

process.stdin.on("end", () => {
  if (buffer.length) handleRaw(buffer.toString("utf8"));
});

process.stderr.write("[tps-monitor] stdio MCP server ready\n");
