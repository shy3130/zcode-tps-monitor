---
name: tps-monitor
description: Token 输出速率与吞吐监控。当用户询问 token 速率、生成速度、tok/s、模型输出快慢、TTFT(首 token 延迟),或 TPS、QPS、吞吐、接口延迟、想看实时监控大屏时使用。Token 速率读取 ZCode usage 数据库,是真实数据;业务 TPS 支持指标接口或演示数据。
---

# TPS Monitor(token 速率 + 业务吞吐)

两类指标:

- **Token 输出速率(真实)** — 从 ZCode 自身 usage 数据库(`model_usage` 表)计算:每轮的 tok/s、输出 token 数、生成耗时、TTFT、会话平均/峰值。用户问"生成速度/token 速率/tok/s"时用这个。
- **业务 TPS(demo/remote)** — 未配置接口时为演示数据;配置 `metrics_url` 后为真实业务吞吐。

## 取数方式

1. Token 速率(推荐,真实数据):
   ```
   node <插件目录>/scripts/token-rate.mjs           # 人类可读
   node <插件目录>/scripts/token-rate.mjs --json    # JSON
   ```
   可设 `ZCODE_SESSION_ID` 环境变量只统计当前会话;钩子已自动这么做。
2. 业务 TPS:MCP 工具 `tps_snapshot`/`tps_watch`,或 `node <插件目录>/scripts/collect.mjs [--watch N]`。
3. 实时大屏(浏览器,含 token 速率面板):
   ```
   node <插件目录>/dashboard/server.mjs   # http://127.0.0.1:7423
   ```

## 展示规范

- 中文回复,指标用表格或列表;回复末尾附 📊 指标行(若上下文有【token 速率】注入,原样附上)。
- token 速率需注明模型名;TTFT 明显偏高(>5s)或速率骤降时可一句简评。
- demo 模式的业务 TPS 要主动标注,并提示可配置 `metrics_url`。
