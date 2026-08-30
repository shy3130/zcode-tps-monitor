# zcode-tps-monitor

ZCode 插件:在会话里按需查看 TPS 吞吐、延迟分位数、错误率与本机系统资源。

## 提供的能力

| 形态 | 名称 | 说明 |
|---|---|---|
| **实时大屏** | `dashboard/server.mjs` | 浏览器监控面板,每秒自动刷新:`/zcode-tps-monitor:dashboard` 一键拉起,或手动 `node dashboard/server.mjs` |
| 斜杠命令 | `/zcode-tps-monitor:tps` | 即时快照;`/zcode-tps-monitor:tps 10` 采样观察 10 秒 |
| 技能 | `zcode-tps-monitor` | 问"当前 TPS 多少 / 打开监控面板"时自动触发 |
| MCP 工具 | `tps_snapshot` / `tps_watch` | 供 agent 调用取数 |
| 钩子 | SessionStart | 会话启动时输出一行使用提示 |

### 实时大屏

```bash
node dashboard/server.mjs             # 默认 http://127.0.0.1:7423
node dashboard/server.mjs --port 8080 # 自定义端口
TPS_URL=http://host/metrics node dashboard/server.mjs   # 接真实数据源
```

深色运维风格布局:TPS/p95/p99/错误率指标卡(带涨跌箭头)、吞吐曲线(均值虚线)、
延迟分位三线图、CPU/内存进度条,保留最近 3 分钟历史,断流时顶部红点提示。

## 数据源

- **demo(默认)**:内置模拟数据(随机游走,数值连续逼真),开箱即可看到效果。
- **remote(真实)**:在 设置 → 插件管理 → zcode-tps-monitor 中配置 `metrics_url`,
  指向任何返回 JSON 的指标接口。字段兼容(支持最多三层嵌套):
  - TPS:`tps` / `qps` / `throughput` / `transactionsPerSecond`
  - 延迟:`p50` / `p95` / `p99`(或 `latency_p50` 等)
  - 错误率:`error_rate` / `errorRate` / `err_rate`

  例:`{"data":{"tps":1240,"p50":11,"p95":28,"p99":46,"error_rate":0.05}}`

## 单独测试脚本

```bash
node scripts/collect.mjs            # 人类可读快照
node scripts/collect.mjs --json     # JSON
node scripts/collect.mjs --watch 5  # 采样 5 秒
TPS_URL=http://localhost:8080/metrics node scripts/collect.mjs   # 真实接口
```

MCP server 冒烟:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp/tps-server.mjs
```

## 目录结构

```
zcode-tps-monitor/
├── .zcode-plugin/plugin.json   # 插件清单(name/userConfig)
├── .claude-plugin/plugin.json  # 兼容清单
├── .mcp.json                   # MCP server 注册(${ZCODE_PLUGIN_ROOT})
├── commands/tps.md             # /zcode-tps-monitor:tps
├── skills/zcode-tps-monitor/SKILL.md # 自动触发技能
├── hooks/hooks.json            # SessionStart 提示
├── mcp/tps-server.mjs          # stdio MCP server
├── dashboard/                  # 实时监控大屏
│   ├── server.mjs              # HTTP 服务(页面 + /api/metrics)
│   └── index.html              # 大屏布局(纯原生,无外部依赖)
└── scripts/
    ├── collect.mjs             # CLI 入口
    └── lib/collect-core.mjs    # 采集核心(CLI/MCP 共用,零依赖)
```

要求 Node ≥ 18。修改代码后在插件管理里重新安装/刷新即可生效。
