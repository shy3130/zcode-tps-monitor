# Changelog

## 0.7.0 — 2026-08-30

### 修复
- **严重**:prompt-submit 钩子把算好的速率行弄丢了(`line` 计算后未拼进 additionalContext),自 v0.6.1 起新安装的插件不会显示速率行。0.7.0 修复。
- usage 数据库路径不再硬编码具体机器,按用户主目录解析(Windows/macOS/Linux),可用 `ZCODE_USAGE_DB` 覆盖。

### 变更
- 速率分子纳入思考 token(`reasoning_tokens`;ZCode 未记录时为 0,行为不变)。注入行在存在思考 token 时显示「(+N 思考)」。
- 速率行明确标注「(上轮)」——行在发送消息瞬间采样,描述的是上一条已完成回复。
- 注入行新增「会话累计 N tok」;`token-rate.mjs` 人类可读模式追加输入/缓存读/请求数明细(累计用独立 SQL SUM,不受展示窗口限制)。
- 有效样本判定可配置:`TOKEN_RATE_MIN_MS`(默认 200)、`TOKEN_RATE_MAX_MS`(默认 1 小时,原固定 10 分钟)。

### 新增
- 自检命令 `/tps-doctor`(`scripts/doctor.mjs`):检查 Node 版本、usage 数据库与表结构、最近样本时间、会话状态文件、配置文件、大屏进程;支持 `--json`,失败时退出码为 1。
- 注入开关:`~/.zcode/tps-monitor.config.json` 写入 `{"tokenRateLine": false}` 关闭每轮速率行注入。
- 大屏生命周期:`--idle-exit`(默认 180 分钟)空闲自退;处理 SIGINT/SIGTERM;写 PID 文件(`~/.zcode/tps-monitor.dashboard.pid`)供 doctor 探测并给出停止命令。
- 单元测试(`node --test`,临时库夹具)与 GitHub Actions CI(Node 22/24 × Ubuntu/Windows/macOS)。
- MCP server 版本号自动读取 plugin.json,不再与插件版本脱节;本文件(CHANGELOG)。

### 清理
- CLI 与钩子不再向 stderr 输出 `node:sqlite` 的 ExperimentalWarning 噪音。

## 0.6.1 — 2026-08-30
- 插件更名 tps-monitor → zcode-tps-monitor,明确 ZCode 专属定位;技能目录同步更名。

## 0.6.0 — 2026-08-30
- 首个公开版本:每轮真实 token 速率注入、/tps 命令、MCP 工具、实时大屏、业务 TPS(demo/remote)。
