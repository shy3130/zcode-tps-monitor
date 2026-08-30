# zcode-tps-monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

**ZCode 会话级 Token 速率监控插件。** 每轮对话自动在回复末尾显示真实 tok/s —— 数据直接读取 ZCode usage 数据库,非模型自述、非估算;另附实时监控大屏、斜杠命令、MCP 工具与可选的业务 TPS 监控。

> 本仓库同时是一个 ZCode 本地插件市场(marketplace 名称:`tps-local-marketplace`),插件本体位于 [`plugins/zcode-tps-monitor/`](plugins/zcode-tps-monitor/README.md)。

## 效果预览

每轮回复末尾自动注入一行速率指标,无需任何手动操作:

![token 速率行效果](plugins/zcode-tps-monitor/docs/effect-token-rate.png)

| 字段 | 含义 |
|---|---|
| `537.3 tok/s` | 本轮输出速率 |
| `首字 3.0s` | 首 token 延迟(TTFT) |
| `输出 223 tok / 生成 0.4s` | 本轮输出 token 数与生成耗时 |
| `近3次均 494.9` | 最近数轮滑动平均 |
| `峰 537.3` | 当前会话峰值 |
| `⏱ 10:23:04` | 记录时间 |

## 功能特性

- **真实 Token 速率注入(默认开启)** —— 每轮回复末尾自动显示 tok/s、首字延迟、输出 token 数、生成耗时、近几轮均值与会话峰值
- **实时监控大屏** —— `/zcode-tps-monitor:dashboard` 一键拉起,浏览器深色运维风格面板,秒级自动刷新
- **斜杠命令** —— `/tps` 即时快照;`/tps 10` 采样观察 10 秒
- **MCP 工具** —— `tps_snapshot` / `tps_watch`,供 agent 程序化取数
- **悬浮条(Windows)** —— 桌面常驻文字悬浮条,随时可见当前速率
- **业务 TPS 监控(可选)** —— 配置 `metrics_url` 接入真实业务指标接口,或使用内置演示数据

## 安装

### 方式一:从 GitHub 添加(推荐)

在 ZCode 中执行:

```text
/plugin marketplace add shy3130/zcode-tps-monitor
/plugin install zcode-tps-monitor@tps-local-marketplace
```

### 方式二:本地目录

克隆本仓库后,在 ZCode 中打开 **设置 → 插件管理 → 发现 → +**,来源选择"本地目录",指向仓库根目录即可。

### 更新

```text
/plugin marketplace update tps-local-marketplace
```

更新后重装/升级插件,并重开会话使钩子重新注册。

## 使用

| 场景 | 操作 |
|---|---|
| 查看每轮速率 | 无需操作,每轮回复末尾自动显示 |
| 即时快照 | 输入 `/tps`;或 `/tps 10` 持续采样 10 秒 |
| 打开监控大屏 | 输入 `/zcode-tps-monitor:dashboard`,或手动 `node dashboard/server.mjs` |
| 桌面悬浮条 | 运行 `dashboard/overlay.ps1`(Windows) |
| agent 取数 | MCP 工具 `tps_snapshot` / `tps_watch` |

要求 Node ≥ 18。

## 配置:接入业务 TPS(可选)

插件默认提供演示数据;若要监控真实业务吞吐,在 **设置 → 插件管理 → zcode-tps-monitor** 中配置 `metrics_url`,指向任意返回 JSON 的指标接口。字段自动兼容(支持最多三层嵌套):

| 指标 | 识别的字段名 |
|---|---|
| 吞吐 | `tps` / `qps` / `throughput` / `transactionsPerSecond` |
| 延迟 | `p50` / `p95` / `p99`(或 `latency_p50` 等) |
| 错误率 | `error_rate` / `errorRate` / `err_rate` |

示例接口返回:

```json
{"data":{"tps":1240,"p50":11,"p95":28,"p99":46,"error_rate":0.05}}
```

## 工作原理

```
用户发送消息
   │
   ▼
UserPromptSubmit 钩子
   │  读取 ZCode usage 数据库(model_usage 表),
   │  按当前会话计算本轮/均值/峰值速率
   ▼
将速率行注入模型上下文 → 回复末尾原样展示
```

- **SessionStart 钩子**:会话启动时记录当前会话 ID 并注入使用提示
- **UserPromptSubmit 钩子**:每轮触发一次,单次为毫秒级数据库读取,开销可忽略
- Token 速率与业务 TPS 相互独立:前者始终来自 ZCode 真实数据,后者取决于是否配置 `metrics_url`

## 常见问题

**Q:可以在 OpenCode / Codex / Claude Code 等其他工具中使用吗?**

A:插件机制、钩子与数据源均绑定 ZCode,token 速率功能是 ZCode 专属;其中业务 TPS 采集脚本与大屏是独立程序,可脱离 ZCode 运行,但离开 ZCode 没有速率数据来源。

**Q:显示的速率准确吗?**

A:速率由 ZCode usage 数据库中的真实 token 累计值计算得出,口径为模型输出侧 token;与其他工具显示的统计数字可能因统计窗口不同而略有差异。

**Q:演示数据怎么关掉?**

A:演示数据只影响"业务 TPS"部分(Token 速率始终真实);不配置 `metrics_url` 即为演示模式,配置后自动切换为真实数据源。

## License

[MIT](LICENSE) © 2026 shy3130
