# zcode-tps-monitor

项目介绍、安装与使用说明见[仓库首页 README](../../README.md)。本文件面向插件内部结构与开发测试。

## 能力一览

| 形态 | 入口 | 说明 |
|---|---|---|
| Token 速率注入 | `hooks/prompt-submit.mjs` | 每轮对话读取 ZCode usage 数据库,在回复末尾注入真实速率行 |
| 会话提示 | `hooks/session-start.mjs` | 会话启动时记录会话 ID,并注入一行使用提示 |
| 实时大屏 | `dashboard/server.mjs` | 浏览器监控面板,秒级自动刷新:`/zcode-tps-monitor:dashboard` 拉起,或手动运行 |
| 悬浮条 | `dashboard/overlay.ps1` | Windows 桌面常驻文字悬浮条 |
| 斜杠命令 | `/zcode-tps-monitor:tps` | 即时快照;`/zcode-tps-monitor:tps 10` 采样观察 10 秒 |
| 技能 | `zcode-tps-monitor` | 用户询问速率/TPS 相关问题时自动触发 |
| MCP 工具 | `tps_snapshot` / `tps_watch` | stdio MCP server(`mcp/tps-server.mjs`),供 agent 程序化取数 |

## 数据源

### Token 速率(真实,默认开启)

由钩子读取 ZCode usage 数据库(`model_usage` 表)计算,可手动验证:

```bash
node scripts/token-rate.mjs          # 人类可读
node scripts/token-rate.mjs --json   # JSON
```

可设置 `ZCODE_SESSION_ID` 环境变量只统计当前会话(钩子已自动设置)。

### 业务 TPS(demo / remote)

- **demo(默认)**:内置模拟数据(随机游走,数值连续逼真),开箱即可看到效果。
- **remote(真实)**:在 **设置 → 插件管理 → zcode-tps-monitor** 中配置 `metrics_url`,
  指向任何返回 JSON 的指标接口。字段兼容(支持最多三层嵌套):
  - 吞吐:`tps` / `qps` / `throughput` / `transactionsPerSecond`
  - 延迟:`p50` / `p95` / `p99`(或 `latency_p50` 等)
  - 错误率:`error_rate` / `errorRate` / `err_rate`

  例:`{"data":{"tps":1240,"p50":11,"p95":28,"p99":46,"error_rate":0.05}}`

## 开发与测试

```bash
# 实时大屏(默认 http://127.0.0.1:7423)
node dashboard/server.mjs
node dashboard/server.mjs --port 8080
TPS_URL=http://host/metrics node dashboard/server.mjs   # 接真实数据源

# 业务 TPS 采集 CLI
node scripts/collect.mjs            # 人类可读快照
node scripts/collect.mjs --json     # JSON
node scripts/collect.mjs --watch 5  # 采样 5 秒

# MCP server 冒烟
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp/tps-server.mjs
```

## 目录结构

```
zcode-tps-monitor/
├── .zcode-plugin/plugin.json   # 插件清单(name / userConfig)
├── .claude-plugin/plugin.json  # 兼容清单
├── .mcp.json                   # MCP server 注册(${ZCODE_PLUGIN_ROOT})
├── commands/tps.md             # /zcode-tps-monitor:tps
├── commands/dashboard.md       # /zcode-tps-monitor:dashboard
├── skills/zcode-tps-monitor/SKILL.md  # 自动触发技能
├── hooks/hooks.json            # 钩子注册(SessionStart + UserPromptSubmit)
├── hooks/session-start.mjs     # 会话启动:记录会话 ID + 使用提示
├── hooks/prompt-submit.mjs     # 每轮:计算并注入 token 速率行
├── mcp/tps-server.mjs          # stdio MCP server
├── dashboard/
│   ├── server.mjs              # HTTP 服务(页面 + /api/metrics)
│   ├── index.html              # 大屏布局(纯原生,无外部依赖)
│   └── overlay.ps1             # Windows 悬浮条
├── scripts/
│   ├── token-rate.mjs          # token 速率 CLI(人类可读 / --json)
│   ├── collect.mjs             # 业务 TPS CLI 入口
│   └── lib/collect-core.mjs    # 采集核心(CLI/MCP 共用,零依赖)
└── docs/
    └── effect-token-rate.png   # 效果截图
```

## 修改后生效

在 **设置 → 插件管理** 中重新安装/刷新插件,并重开会话使钩子重新注册。要求 Node ≥ 18。

## License

[MIT](../../LICENSE)
