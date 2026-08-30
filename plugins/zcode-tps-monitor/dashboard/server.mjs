#!/usr/bin/env node
// TPS 实时监控大屏服务:零依赖,Node >= 18。
//   node dashboard/server.mjs [--port 7423]
// 页面每秒轮询 /api/metrics;数据源同采集脚本(TPS_URL 环境变量,未设置时演示数据)。

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot } from "../scripts/lib/collect-core.mjs";
import { query as tokenRateQuery } from "../scripts/token-rate.mjs";

// 状态文件:钩子(SessionStart/UserPromptSubmit)记录"用户最后所处的会话"
const STATE_FILE = path.join(os.homedir(), ".zcode", "tps-monitor.last-session.json");

function followedSessionId() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (st && st.sessionId && Date.now() - (st.ts || 0) < 7 * 24 * 3600 * 1000) {
      return { id: st.sessionId, source: st.source || "hook" };
    }
  } catch {}
  return { id: null, source: "auto" };
}

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx !== -1 ? Number(args[portIdx + 1]) || 7423 : 7423;
const HOST = "127.0.0.1";
const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.join(here, "index.html"), "utf8");

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url.startsWith("/index")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(indexHtml);
    return;
  }
  if (req.url.startsWith("/api/metrics")) {
    try {
      const s = await snapshot();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(s));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (req.url.startsWith("/api/token-rate")) {
    try {
      const followed = followedSessionId();
      const r = tokenRateQuery(followed.id);
      r.follow = followed;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  const src = process.env.TPS_URL && !process.env.TPS_URL.startsWith("${")
    ? `remote: ${process.env.TPS_URL}`
    : "demo(内置演示数据)";
  console.log(`[zcode-tps-monitor] 大屏已启动: http://${HOST}:${PORT}   数据源: ${src}`);
});
