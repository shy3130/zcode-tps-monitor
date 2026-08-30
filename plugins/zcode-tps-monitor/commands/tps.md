---
description: 查看 TPS 吞吐、延迟分位数、错误率与系统资源快照
---

使用 zcode-tps-monitor 插件获取吞吐指标并以中文清晰展示。

执行步骤：

1. 优先调用 MCP 工具 `tps_snapshot`(即时快照)。
2. 如果用户给了数字参数(如 `/tps 10`),改用 `tps_watch` 并把 seconds 设为该数字(2-30 之间),展示采样统计(平均/峰值)。
3. 若 MCP 工具不可用,退回运行采集脚本:插件目录下 `scripts/collect.mjs`(即本技能 base directory 的 `../../scripts/collect.mjs`),加 `--watch N` 可采样观察。

展示要求:

- 用列表或表格呈现:TPS、延迟 p50/p95/p99、错误率、CPU、内存。
- 注明数据模式:remote(真实接口)或 demo(演示数据)。若是 demo,提醒用户可在 设置 → 插件管理 → zcode-tps-monitor 中配置 metrics_url 接入真实数据源。

用户附加要求:$ARGUMENTS
