<img src="assets/icon.png" align="right" width="96" alt="zcode-tps-monitor 图标">

# zcode-tps-monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.5-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

**ZCode 会话级 Token 速率监控插件。** 每条**调用了工具**的回答,末尾都会附一行**本问**(本次提问)的即时 tok/s 统计——数据直接读取 ZCode usage 数据库,非模型自述、非估算,且有守卫保证**绝不显示上一轮**;另附实时监控大屏、斜杠命令、MCP 工具与可选的业务 TPS 监控。

> 本仓库同时是一个 ZCode 本地插件市场(marketplace 名称:`tps-local-marketplace`),插件本体位于 [`plugins/zcode-tps-monitor/`](plugins/zcode-tps-monitor/README.md)。

## 效果预览

每条回复收尾时,模型运行插件脚本自测**本次提问**的真实速率,并把统计行附在回复末尾——多段工具调用的长轮次按"总产出 / 总生成时长"加权:

![token 速率行效果](plugins/zcode-tps-monitor/docs/effect-token-rate.png)

| 字段 | 含义 |
|---|---|
| `537.3 tok/s(本轮)` | 本问即时输出速率(含思考 token;多段轮次为加权速率) |
| `首字 3.0s` | 首 token 延迟(TTFT,本问第一段) |
| `输出 223 tok / 生成 0.4s` | 本问输出 token 数与纯生成耗时(不含段间工具等待) |
| `2 段 / 峰 537.3` | 本问的请求段数与单段峰值速率(多段轮次才显示) |
| `累计 51.3k tok` | 当前会话累计输出(独立统计,不受窗口限制) |
| `⏱ 10:23:04` | 采样时刻(最近一次工具调用之后) |

数字显示规则:每问「输出」用千分位精确数字(如 `2,762 tok`);「累计」用紧凑单位——千以下原始、1k~1万一位小数(`9.8k`)、1万~100万取整(`51k`)、百万以上一位小数 M(`73.8M`)。

## 功能特性

- **真实 Token 速率(默认开启)** —— 每条调用了工具的回答末尾自动附**本问即时 tok/s**(含思考 token)、首字延迟、输出 token 数、生成耗时、段数/峰值与会话累计;`--current` 守卫保证绝不把上一轮数据当作本问显示
- **实时监控大屏** —— `/zcode-tps-monitor:dashboard` 一键拉起,浏览器深色运维风格面板,秒级自动刷新;空闲 3 小时自动退出,不留后台进程
- **斜杠命令** —— `/tps` 即时快照;`/tps 10` 采样观察 10 秒;`/tps-doctor` 环境自检
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
| 查看本问速率 | 无需操作:调用了工具的回答,末尾自动附本问统计行(纯问答不显示) |
| 即时快照 | 输入 `/tps`;或 `/tps 10` 持续采样 10 秒 |
| 打开监控大屏 | 输入 `/zcode-tps-monitor:dashboard`,或手动 `node dashboard/server.mjs` |
| 环境自检 | 速率行不见了?输入 `/tps-doctor` 逐项排查 |
| 关闭速率注入(含末尾统计行) | `~/.zcode/tps-monitor.config.json` 写入 `{"tokenRateLine": false}`,重开会话生效 |
| 桌面悬浮条 | 运行 `dashboard/overlay.ps1`(Windows) |
| agent 取数 | MCP 工具 `tps_snapshot` / `tps_watch` |

要求 Node ≥ 22.5(需内置 `node:sqlite`,Windows / macOS / Linux 相同)。

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
   │  记录提问时刻到状态文件;注入上一轮速率(仅作模型内部参考,禁止展示)
   │  并下达「本问统计指令」
   ▼
模型回复(工具调用 × N 段,每段完成即实时写入 usage 库)
   │
   ▼
回复收尾(输出最终总结之前)
   │  模型运行 token-rate.mjs --turn --current:
   │  按本次提问触发的 turn_id 圈定本问全部请求,
   │  计算即时速率(总产出 / 总纯生成时长)
   ▼
把统计行放入 Markdown 引用块,贴在回复最末尾
```

- **SessionStart 钩子**:会话启动时记录当前会话 ID 并注入使用提示
- **UserPromptSubmit 钩子**:每轮触发一次,单次为毫秒级数据库读取,开销可忽略;此刻本问尚未发生,注入的上一轮速率仅作模型上下文(标注「内部背景·勿展示」)
- **收尾自测(`--turn --current`)**:本问的各段请求在回答过程中已实时入库,收尾时统计即为完整的本问数据;`--current` 守卫把状态文件里的提问时刻与本问数据比对,本问尚无入库数据(纯问答轮)时输出为空——**结构上杜绝了"显示上一轮"**
- **Stop 钩子(兼容保留)**:`hooks/stop.mjs` 会在回复刚结束时经 `systemMessage` 直接显示本问速率,当前客户端版本暂不触发该事件,不影响上述机制;未来客户端支持后自动增强
- Token 速率与业务 TPS 相互独立:前者始终来自 ZCode 真实数据,后者取决于是否配置 `metrics_url`

## 常见问题

**Q:可以在 OpenCode / Codex / Claude Code 等其他工具中使用吗?**

A:插件机制、钩子与数据源均绑定 ZCode,token 速率功能是 ZCode 专属;其中业务 TPS 采集脚本与大屏是独立程序,可脱离 ZCode 运行,但离开 ZCode 没有速率数据来源。

**Q:显示的速率准确吗?**

A:速率由 ZCode usage 数据库中的真实 token 累计值计算得出,口径为模型输出侧 token。统计覆盖"本次提问 → 最近一次工具调用"的全部请求段,按"总产出 / 总纯生成时长"加权(段间工具等待不计入生成时长);最终总结文字在最近一次工具调用之后生成,不计入。与其他工具显示的统计数字可能因统计窗口不同而略有差异。

**Q:纯问答回复(没调用工具)为什么没有统计行?**

A:这是有意的。收尾自测发生在回复结束之前,而纯问答轮唯一的模型请求要等回复结束才写入数据库——此刻它还不可见。`--current` 守卫检测到"本问尚无入库数据"就不输出任何统计行,绝不会拿上一轮的数据充数。想看最近的统计可运行 `/tps` 或打开监控大屏。

**Q:速率行突然不见了?**

A:运行 `/tps-doctor` 自检。常见原因:Node 版本低于 22.5(需内置 `node:sqlite`)、ZCode 更新后表结构变化、升级插件后未重开会话(钩子需新会话注册)、或配置文件里关闭了注入。

**Q:macOS / Linux 支持吗?**

A:支持。钩子、命令、大屏、MCP 均为跨平台 Node 实现;usage 数据库路径按用户主目录自动解析(`~/.zcode/cli/db/db.sqlite`),特殊安装位置可用 `ZCODE_USAGE_DB` 环境变量覆盖。唯一例外是桌面悬浮条 `overlay.ps1`,它依赖 Windows API,仅限 Windows(macOS 用户用监控大屏即可)。

**Q:演示数据怎么关掉?**

A:演示数据只影响"业务 TPS"部分(Token 速率始终真实);不配置 `metrics_url` 即为演示模式,配置后自动切换为真实数据源。

## License

[MIT](LICENSE) © 2026 shy3130
