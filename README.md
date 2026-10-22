<img src="assets/icon.png" align="right" width="96" alt="zcode-tps-monitor 图标">

# zcode-tps-monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.5-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

**ZCode 会话级 Token 速率监控插件。** 每条**调用了工具**的回答,末尾自动附上**本问**(本次提问)的即时 tok/s 统计——数据直接读取 ZCode usage 数据库,非模型自述、非估算,且有守卫保证**绝不显示上一轮**;另配**每个会话一条泳道**的多会话实时大屏、全会话总览命令、MCP 工具与可选的业务 TPS 监控。

> 本仓库同时是一个 ZCode 本地插件市场(marketplace 名称:`tps-local-marketplace`),插件本体位于 [`plugins/zcode-tps-monitor/`](plugins/zcode-tps-monitor/README.md)。

## 效果预览

### ① 回复结尾统计(自动,按客户端自适应)

桌面端提问 → 回复末尾渲染**会话内统计卡片**(速率大数字、各段走势竖条、指标组):

![回复结尾统计卡片(桌面端)](plugins/zcode-tps-monitor/docs/effect-turn-card.png)

手机 / 网页 / CLI 提问(不渲染会话内卡片)→ 同样的数据以**单行引用块**收尾(经典版式 + 总用时):

```text
⚡ 71.2 tok/s(本轮) · 首字 9.9s · 输出 15,150 tok / 生成 3m26s / 总 2m32s · 4 段 / 峰 108.1 · 累计 273k tok · ⏱ 09:50:45
```

| 字段 | 含义 |
|---|---|
| `⚡ 71.2 tok/s(本轮)` | 本问即时速率(含思考 token;多段轮次为"总产出 / 总纯生成时长"的加权值) |
| `首字 9.9s` | 首 token 延迟(TTFT,本问第一段) |
| `输出 15,150 tok / 生成 3m26s / 总 2m32s` | 本问输出 token 数(千分位);生成 = 各段纯生成时长之和;总 = 提问到最后的墙钟(含工具等待);秒/分/时自动换算 |
| `4 段 / 峰 108.1` | 本问请求段数与单段峰值速率(多段轮次才显示) |
| `累计 273k tok` | 会话终身累计输出(紧凑单位:1.9k / 51k / 1.2M) |
| `⏱ 09:50:45` | 采样时刻 |

单行的包裹样式、分隔符、走势条、时钟均可配置(见[配置](#配置统计行样式可选))。

### ② 多会话实时大屏(一个标签页看全部会话)

`/zcode-tps-monitor:dashboard` 一键拉起。**每个会话一条泳道**(生成中 / 活跃 / 空闲三态、迷你走势、即时速率、终身累计),点击聚焦任一会话查看详情与全量速率曲线;秒级刷新,隐藏标签页自动暂停:

![多会话监控大屏](plugins/zcode-tps-monitor/docs/effect-dashboard-sessions.png)

### ③ 全会话总览(命令行)

```text
$ node plugins/zcode-tps-monitor/scripts/token-rate.mjs --sessions
● Project  本轮 66.6 tok/s(9 段) · 累计 145k tok · 生成中 · /Users/shy/Project · 21:22:19
● tick-stock-panel  本轮 75.4 tok/s(10 段) · 累计 91k tok · 生成中 · /Users/shy/Project/tick-stock-panel · 21:12:29
· wshy-lab  本轮 361.4 tok/s(10 段) · 累计 1.1M tok · 空闲 · /Users/shy/Project/wshy-lab · 18:16:53
```

## 功能特性

- **真实 Token 速率(默认开启)** —— 每条调用了工具的回答末尾自动附本问统计;`--current` 守卫保证绝不把上一轮数据当作本问显示
- **统计样式按客户端自适应** —— 桌面端渲染会话内卡片(Gen UI),手机/网页/CLI 用 Markdown 单行;`statsStyle` / `statsFormat` 可强制指定或微调
- **多会话实时大屏** —— 每会话一条泳道 + 聚焦详情,增量缓存稳态查询 23–37ms,空闲 3 小时自动退出
- **全会话总览** —— `--sessions` 一行一会话,亦集成于 `/tps` 命令
- **斜杠命令** —— `/tps` 即时快照;`/tps 10` 采样观察;`/tps-doctor` 环境自检
- **MCP 工具** —— `tps_snapshot` / `tps_watch`,供 agent 程序化取数
- **桌面悬浮窗(可选)** —— macOS 置顶常驻小窗 / Windows 文字悬浮条
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
| 查看本问速率 | 无需操作:调用了工具的回答,末尾自动附统计(纯问答不显示) |
| 即时快照 | `/tps`;`/tps 10` 持续采样 10 秒 |
| 全会话总览 | `/tps` 说明词里带"各会话/哪些在跑"即触发 `--sessions`;或直接运行 `node (插件目录)/scripts/token-rate.mjs --sessions` |
| 打开监控大屏 | `/zcode-tps-monitor:dashboard`,或手动 `node dashboard/server.mjs` 后浏览器访问 `http://127.0.0.1:7423` |
| 环境自检 | 速率不见了?`/tps-doctor` 逐项排查 |
| 关闭速率注入 | `~/.zcode/tps-monitor.config.json` 写 `{"tokenRateLine": false}`,重开会话生效 |
| agent 取数 | MCP 工具 `tps_snapshot` / `tps_watch` |

要求 Node ≥ 22.5(需内置 `node:sqlite`,Windows / macOS / Linux 相同)。

## 配置:统计行样式(可选)

`~/.zcode/tps-monitor.config.json`:

```json
{
  "statsStyle": "card",
  "statsFormat": {
    "wrap": "quote",
    "sep": "dot",
    "clock": true,
    "spark": false,
    "sparkMax": 4
  }
}
```

- **`statsStyle`**:`card`(桌面端 Gen UI 卡片)/ `line`(单行)。不配置时按提交端自动——桌面端用卡片,手机/网页/CLI 用单行
- **`statsFormat`(微调单行,默认即经典版式)**:
  - `wrap`:`quote` 引用块 / `code` 代码胶囊 / `plain` 裸行 / `italic` 斜体
  - `sep`:`dot` 中点 `·`(默认)/ `bar` 竖线 `│`
  - `clock`:行尾 ⏱ 时刻开关
  - `spark`:走势条开关(默认关);开启后 `sparkMax` 限段数(1–8,默认 4)

改完即时生效(下一轮回复即按新配置),无需重装。

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
   │  记录提问时刻到本会话状态文件;读取提交端 client_mode;
   │  把本会话 ZCODE_SESSION_ID 与统计指令(卡片/单行按端别与配置)注入模型上下文
   ▼
模型回复(工具调用 × N 段,每段完成即实时写入 usage 库)
   │
   ▼
回复收尾(写最终总结之前)
   │  桌面端:token-rate.mjs --turn --current --card --out <可视化目录>/tps-turn.html
   │         (脚本静默落盘卡片,回复以 ::visualize 引用收尾)
   │  其他端:token-rate.mjs --turn --current(按 statsFormat 出单行,引用块收尾)
   │  均按 turn_id 圈定本问全部请求,--current 守卫杜绝"显示上一轮"
   ▼
统计(卡片/单行)与完整回复正文同处最后一条消息
```

- **SessionStart 钩子**:记录会话身份并注入使用提示
- **UserPromptSubmit 钩子**:毫秒级;注入的上一轮速率仅作模型内部背景(标注「勿展示」);指令中的 `ZCODE_SESSION_ID` 直接烘焙进命令行——模型侧 shell 目录不可控,不依赖 cwd 解析,并发会话(含同目录子代理)不串数据
- **收尾自测**:本问各段在回答过程中已实时入库;`--current` 守卫比对提问时刻(本会话分状态文件优先),纯问答轮无数据则不输出任何统计
- **多会话查询**(`--sessions` / 大屏):session 表窗口内枚举 + usage 行兜底;增量缓存——首轮 GROUP BY 建终身累计,此后只查越过水位的新行;part 表探测限定"近 60 分钟活跃会话 + 近 10 分钟更新"避免全表 json_extract
- **Stop 钩子(实验)**:时机不定,默认只维护本会话分状态文件、绝不写全局;`{"stopHookLine": true}` 可开启直显
- Token 速率与业务 TPS 相互独立:前者始终来自 ZCode 真实数据,后者取决于 `metrics_url`

## 常见问题

**Q:手机上为什么是单行而不是卡片?**

A:ZCode 的手机/网页端不渲染会话内 HTML 卡片(Gen UI 为桌面端能力),插件按钩子入参的 `client_mode` 自动切换;也可用 `statsStyle` 强制单行。

**Q:可以在 OpenCode / Codex / Claude Code 等其他工具中使用吗?**

A:插件机制、钩子与数据源均绑定 ZCode,token 速率功能是 ZCode 专属;业务 TPS 采集脚本与大屏是独立程序,可脱离 ZCode 运行,但离开 ZCode 没有速率数据来源。

**Q:显示的速率准确吗?**

A:速率由 ZCode usage 数据库中的真实 token 累计值计算得出,口径为模型输出侧 token(含思考 token)。多段轮次按"总产出 / 总纯生成时长"加权(段间工具等待计入「总」、不计入「净」);与其他工具的统计窗口不同可能略有差异。

**Q:纯问答回复(没调用工具)为什么没有统计行?**

A:这是有意的。收尾自测发生在回复结束之前,而纯问答轮唯一的模型请求要等回复结束才写入数据库——`--current` 守卫检测到"本问尚无入库数据"就不输出,绝不拿上一轮充数。想看最近统计可运行 `/tps` 或打开大屏。

**Q:速率行突然不见了?**

A:运行 `/tps-doctor` 自检。常见原因:Node < 22.5、ZCode 更新后表结构变化、升级插件后未重开会话、或配置里关闭了注入。

**Q:多个窗口并发使用,统计会互相串吗?**

A:不会。钩子指令把本会话 `ZCODE_SESSION_ID` 烘焙进命令行,统计一步锁定本会话;状态文件按会话分文件(`~/.zcode/tps-monitor.sessions/<id>.json`),Stop 只更新自己的分文件、绝不写全局。悬浮窗按启动目录锁定会话,解析顺序相同。

**Q:macOS / Linux 支持吗?**

A:支持。钩子、命令、大屏、MCP 均为跨平台 Node 实现;usage 数据库路径按主目录自动解析(`ZCODE_USAGE_DB` 可覆盖)。桌面悬浮:macOS `bash dashboard/overlay/start-macos.sh`(首次自动编译,需 Xcode CLT);Windows `overlay.ps1`;Linux 用大屏即可。

**Q:演示数据怎么关掉?**

A:演示数据只影响"业务 TPS"部分(Token 速率始终真实);不配置 `metrics_url` 即为演示模式,配置后自动切换。

## License

[MIT](LICENSE) © 2026 shy3130
