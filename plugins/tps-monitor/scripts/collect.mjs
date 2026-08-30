#!/usr/bin/env node
// CLI 采集入口:
//   node collect.mjs             即时快照(人类可读)
//   node collect.mjs --json      JSON 输出
//   node collect.mjs --watch 5   采样 5 秒(2-60)
// 环境变量 TPS_URL 指向返回 JSON 的指标接口;未设置时使用演示数据。

import { snapshot, watch, formatSnapshot, formatWatch } from "./lib/collect-core.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const watchIdx = args.indexOf("--watch");
const seconds = watchIdx !== -1 ? Number(args[watchIdx + 1]) || 5 : null;

try {
  const data = seconds ? await watch(seconds) : await snapshot();
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(seconds ? formatWatch(data) : formatSnapshot(data));
  }
} catch (err) {
  console.error(`[tps-monitor] 采集失败: ${err.message}`);
  process.exit(1);
}
