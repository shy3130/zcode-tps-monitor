# Changelog

## 0.10.1 — 2026-10-22

### 调整:统计行默认回归 0.8.5 经典版式
- 用户反馈更喜欢原版:`·` 分隔、`(本轮)` 标注、`生成 Ns`、`N 段 / 峰`、`累计 N tok`,无加粗无走势条——**仅新增"总"用时**(`输出 … / 生成 … / 总 …`,经典版式上唯一的新字段)。
- 上一版的竖线分隔与方块字走势条降级为可选配置:`statsFormat.sep: "bar"`(竖线)、`statsFormat.spark: true`(走势条,`sparkMax` 限段数),默认全关。
- 桌面端 Gen UI 卡片、多会话大屏、会话隔离修复等 0.10.0 能力不受影响。

## 0.10.0 — 2026-10-21

### 新增:多会话监控大屏(每个会话一条泳道,零悬浮窗)
- **能力审计先行**:解剖 ZCode 主程序确认全部可用面——钩子事件实际有 **7 种**(`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`,比官方文档多两种),钩子输出支持 `additionalContext`/`systemMessage`/`continue`;`statusLine`/`statusBar` **确认不存在**(0 命中)——固定在界面布局上的监控栏依旧无 API,多会话监控的最佳载体是"单个浏览器标签页大屏 + 各会话收尾统计行"。
- **`--sessions` 多会话查询**(`token-rate.mjs` 新增 `querySessions`):枚举 24h 内有活动的全部会话(session 表窗口内未删除行 + usage 行兜底,旧库无 session 表也能出泳道),每会话给出三态 status(`generating`/`active`/`idle`;近 8s 有完成段或 part 表有 running 工具即生成中)、最新一轮 turn 聚合、latest 段速率、近 40 段速率曲线、**会话终身累计**;口径 main_turn 优先,子代理 actor 会话(无 main 行)自动退回全部行;同目录多会话(主会话 + actor)天然分成各自泳道,互不串数据。CLI:`node token-rate.mjs --sessions`(一行一会话)/`--sessions --json`。
- **性能:增量缓存 + 查询裁剪**。首轮 GROUP BY 建终身累计 + 拉窗口内整行,此后每轮只拉 `completed_at` 越过水位的新行(回看 10s 容忍乱序提交,按 `(completed_at, rowid)` 水位去重,同刻多段靠 rowid 区分);增量查询去掉 SQL 排序(`model_usage` 无 completed_at 索引,改 JS 端排少量新行);part 表探测(15 万行、data 为大 JSON)限定"近 60 分钟有活动的会话 + 近 10 分钟更新过的 part",`json_extract` 只落在个位数行上。真机实测(35k usage 行 / 155k part 行 / 46 会话):首轮 37ms,稳态 **23–37ms/次**(优化前 105–280ms)。已知边角:首轮恰有同毫秒段跨查询边界提交时累计可能重复计一段;超 10 分钟未更新 time_updated 的超长工具漏判生成中,由其结束后的下一段完成兜底。
- **大屏页面重设计**(`dashboard/index.html`):深色玻璃质感(深空底色 + 双层嵌套卡片 + 发光状态点),左栏会话泳道(状态点/项目名/迷你走势 SVG/即时速率/累计/时间)、右侧聚焦会话详情(大号速率 + 首字/输出/段数 + 指标芯片 + 全量曲线);点击泳道锁定跟随,亦可"跟随最新"。性能:泳道 DOM 按 sessionId 复用、只改文本与 SVG `d` 属性;全量曲线仅在数据签名变化时重绘;隐藏标签页自动暂停轮询。新端点 `GET /api/sessions`(旧端点保留)。
- **`/tps` 命令**新增 `--sessions` 总览入口与大屏启动指引。
- **回复结尾统计升级为会话内卡片(Gen UI),并按客户端自动适配**:钩子从 stdin 入参读 `client_mode`——`desktop` 提问注入"卡片指令"(一条命令 `--turn --current --card --out <可视化目录>/tps-turn.html` 静默落盘单张主题化卡片:大号速率 + spark 走势竖条 + 首字/输出/累计/净·总/近段均/时刻,全静态无脚本);`mobile`/`web`/`cli`/未知(手机与网页端不渲染 Gen UI,只显示"请在桌面端查看"占位)注入"单行指令"(Markdown,任何客户端可见)。可用 `{"statsStyle":"card"|"line"}` 强制指定;入参字段留档于 `~/.zcode/tps-monitor.hook-debug.log`。单行样式同步重做:细竖线 `│` 分段、速率整段加粗、峰值并入输出段、净/总与累计自动换算(秒/分/时,k/M);`--table` 保留为 CLI 可选表格输出。
- **统计行全面可配置**(`~/.zcode/tps-monitor.config.json` 新增 `statsFormat` 段,测试可用 `TPS_MONITOR_CONFIG` 覆盖路径):`wrap` 包裹样式(quote 引用块/code 行内代码/plain 裸行/italic 斜体,code 风脚本自动去 `**` 加粗——代码内星号不渲染)、`sep` 分隔符(bar `│` / dot `·` / mixed 头部`│`其余`·`)、`clock` 行尾时刻开关、`spark` 走势条开关、`sparkMax` 走势条最多段数(1-8,默认 4)。脚本按配置出裸行内容,钩子按 `wrap` 生成对应包裹指令,两侧读同一份配置。
- 新增 5 个测试(多会话夹具):枚举与排序、同目录主会话/actor 隔离与口径、三态 status(含 part 表 running 判生成中、新会话空泳道)、增量缓存二次调用、旧库无 session 表(CLI 子进程);全量 33 个测试通过。

## 0.9.0 — 2026-10-21

### 修复:并发会话串数据(「本轮」统计张冠李戴)
- **实测事故**:全局状态文件 `~/.zcode/tps-monitor.last-session.json` 被所有会话共享,任何会话的 SessionStart/UserPromptSubmit/Stop 钩子都会覆写其 sessionId——amber 目录的会话在 15:57:25 覆写后,Project 目录会话的「本轮」统计显示成了 amber 的数据(累计 1.6M tok 张冠李戴)。`--current` 守卫防不住:另一会话的请求确实发生在本问提问时刻之后。
- **状态文件拆分**:新增按会话分文件 `~/.zcode/tps-monitor.sessions/<id>.json`;prompt-submit/session-start 写「分文件 + 全局」,Stop 只更新自己会话的分文件、**绝不写全局**。`TPS_MONITOR_STATE_FILE` 覆盖语义保留(分文件目录默认与其同目录,`TPS_MONITOR_SESSIONS_DIR` 可显式指定)。
- **会话解析新顺序**:未显式指定会话时:环境变量 → 全局状态文件里 cwd 与 `process.cwd()` 一致的显式记录 → 按 `process.cwd()` 查 usage 库 `session` 表(directory 精确匹配、未删除行取 time_updated 最新;只读打开,旧库无该表时静默降级)→ 全局状态文件 → 全局最新完成请求。并发会话工作目录不同,天然隔离;其他会话对全局状态文件的覆写不再串进本会话统计。已在真实库只读验证。
- **同目录多会话二次事故**(同日复审发现):主会话跑子代理(动态工作流 actor)时,actor 会话与主会话**共享 directory**且 `time_updated` 更新——仅按 cwd 取最新会误选 actor,把 actor 的 450 tok/s 当作主会话「本问」(正确 166.7);守卫因 actor 无分状态文件、回退全局 promptTs 而放行。修复:全局状态文件的显式记录(prompt-submit 由用户本人写入、带 cwd,actor 不触发用户钩子)优先于 time_updated 最新,记录缺失/过期/目录不符时仍走 cwd 解析;悬浮窗服务同步该顺序。真实库只读验证:6 个 actor 会话与主会话共享 `/Users/shy/Project`,修复后正确解析回主会话。
- **--current 守卫**:提问时刻优先读本会话分状态文件(会话由 cwd 解析),拿不到再回退全局文件——其他会话对全局文件的覆写不再影响判定。
- 新增 `scripts/lib/session.mjs`(cwd 会话解析、状态文件读写、提问时刻读取;供 token-rate/钩子/悬浮窗服务复用);三个钩子统一改从 stdin payload 取 `session_id` 与 `cwd`(环境变量仍兜底),且 prompt-submit/session-start 的状态文件路径开始尊重 `TPS_MONITOR_STATE_FILE`。
- 新增 14 个测试(临时 sqlite 夹具):按 cwd 解析(含已删除行让位、旧库无 session 表降级)、cwd 优先于状态文件、Stop 不跨会话覆写(全局文件逐字节不变)、守卫读分文件提问时刻、同目录多会话(全局显式记录优先于 actor / 目录不匹配与 TTL 过期退回 cwd);原用例全部保持通过。

### 优化:回复结尾统计行
- 头条速率加粗(`**⚡ xx tok/s(本轮)**`):统计行落在回复末尾的 Markdown 引用块里,加粗后更易扫读;配合上述会话归属修复,结尾统计行的数据在多窗口并发下不再串会话、不再凭空消失。

### 新增:macOS 常驻 TPS 悬浮窗
- **一键启动**:`bash dashboard/overlay/start-macos.sh [面板URL]` —— 自动探测并以 nohup 拉起 17873 端口悬浮窗服务(日志写入 /tmp)→ 面板未编译则现编译 → 前台执行 OverlayPanel;URL 可选,默认 `http://127.0.0.1:17873/`。
- **置顶小窗**(`OverlayPanel.swift`,swiftc 编译):无边框 NSPanel + `.floating` 层级、跨所有空间、点击不抢焦点;**按住面板左侧可拖动**——WKWebView 的 `mouseDownCanMoveWindow` 为 false(实测),仅靠 `isMovableByWindowBackground` 拖不动,故在 WebView 之上叠一层透明拖动层(`mouseDownCanMoveWindow` 显式返回 true + `performDrag(with:)` 双保险);右侧留 120pt 按钮交互区不覆盖(页面按钮可点击)。支持 `--size 宽x高` 与 `--pos x,y` 参数;编译需 Xcode Command Line Tools(`xcode-select --install`)。
- **悬浮窗服务**(`overlay/server.mjs`,零依赖):端口 17873(避开大屏 7423);会话按启动时工作目录锁定(`--cwd`,与大屏的全局跟随不同;目录内多会话时优先全局状态文件的 cwd 匹配显式记录)——多窗口并发会话各自独立统计;空闲 8 小时自退(`--idle-exit` 可调,0 = 常驻),PID 文件 `~/.zcode/tps-monitor.overlay.pid` 供 /tps-doctor 探测;路由剥离查询串(带参数 URL 不再 404)。
- **页面**(`overlay.html`):每秒刷新,状态分 生成中 / 空闲 / 无数据 三态,数据粒度为每段请求完成即刷新;**交互按钮**(右上/单行模式右端):↻ 立即刷新、⏸/▶ 暂停与恢复自动刷新、📈 速率曲线开关(卡片模式,数据取 `/api/live` 新增的 `history` 字段);**单行模式** `?style=line` 配合面板 `--size 620x40` 呈现为细横条,可贴在输入框上方常驻。
- Windows 桌面悬浮条 `overlay.ps1` 不变,两端各自独立。

## 0.8.5 — 2026-10-04

### 修复:Stop 钩子触发导致「本问统计」消失
- **实测发现**:客户端已开始触发 Stop 事件(此前版本从不触发),且**时机不定**——曾观察到在用户轮次进行中触发。旧 stop.mjs 每次触发都把状态文件的时间戳改写为当前时刻,`--current` 守卫据此误判"本问数据全部早于提问时刻",统计行凭空消失(本日在真实会话中复现并定位)。
- **promptTs 字段**:prompt-submit / session-start 钩子写入 `promptTs`(提问时刻);Stop 钩子更新 `ts` 时**保留 promptTs**;守卫只认 `promptTs`。任何一方覆盖状态文件都不再影响守卫判定。
- **Stop 直显改为默认关闭(实验性可选)**:因触发时机不定,直显可能过早或重复;`{"stopHookLine": true}` 可开启,并按 turnId 去重、每轮最多显示一次。0.8.3 曾把该键标记废弃,现重新定义为实验开关。
- 新增回归测试:状态文件被 Stop 更新后守卫仍以 promptTs 为准。
- doctor / READMEs 同步新语义。

## 0.8.4 — 2026-09-25

### 修复:回答正文被折叠、只剩一行统计
- **现象**:开启插件后,不少回答的正文被客户端收进折叠区,可见的只剩最后一行 `> ⚡ … tok/s(本轮)`。
- **根因**(会话数据库 + 客户端代码双重定位):客户端把带工具调用的消息折叠进「模型轨迹」区,仅轮次最后一条纯文字消息默认展开。旧指令只说"在输出最终总结之前运行脚本",但模型常执行成"先写完正文 → 再补跑统计脚本 → 单独发一条统计行"——正文被降级进折叠区,孤零零的统计行成了唯一可见内容。
- **指令改为防折叠的严格顺序**:①先运行脚本,②再输出完整回复正文,统计行附在该条回复末尾;明确禁止统计行单独成条、禁止正文写完后再调用任何工具,并说明原因。
- **降级规则**:已写完正文才发现没跑脚本 → 直接省略统计行结束回答,绝不事后补调用工具。
- SessionStart 提示语与 SKILL.md 展示规范同步该规则。

### 其他
- 补齐缺失的版本 tag(v0.6.0、v0.6.1、v0.8.0~v0.8.4),tag 与插件版本号一一对应。

## 0.8.3 — 2026-09-25

### 修复:全部文档与指令对齐「收尾自测」机制(0.8.2 遗留的口径分裂)
- **SessionStart 欢迎语重写**:旧文案宣称「本轮速率由 Stop 钩子自动显示,无需转发」——当前客户端版本不触发 Stop 钩子,该表述会在每个会话开始时误导模型收尾时什么都不做。新文案与 prompt-submit 的「本问统计指令」完全一致。
- **SKILL.md 展示规范修正**:删除「原样附上注入的 📊 指标行」旧要求(正是它曾让模型把「(上轮)」行贴到回复里),改为按【本轮统计指令】收尾自测、【内部背景】行绝不展示。
- **两份 README、插件清单描述重写**:工作原理流程图、效果预览、功能特性、使用表与 FAQ 全部改为真实机制;Stop 钩子明确标注「兼容保留,当前客户端不触发」。效果截图按现行输出格式重新生成。

### 新增
- **监控大屏「最新一问(本问)」实时卡片**:usage 库按 turn 逐段实时入库,大屏秒级轮询,提问进行中即可看到本问速率、段数与输出量爬升(`/api/token-rate` 新增 `turn` 字段)。
- 会话解析兜底:未显式指定会话时,优先使用状态文件里「用户最后所处的会话」(切会话即跟随),再退回全局最近完成请求;`TPS_MONITOR_STATE_FILE` 环境变量可覆盖状态文件路径(多实例/测试)。
- `/tps-doctor` 新增检测:状态文件缺少提问时间戳时提示「--current 守卫不可用」;配置含已废弃的 `stopHookLine` 时提示可删除。

### 变更
- 注入的上一轮速率行加【内部背景·勿展示】前缀,从措辞上根除模型误展示的可能。
- `stopHookLine` 配置键废弃(0.8.2 起已无实际作用),文档同步移除;`tokenRateLine` 仍是唯一总开关。

### 测试
- 补齐 `--current` 守卫(0.8.2 旗舰特性此前无测试):提问时刻晚于本问全部数据 → 不返回本问;本问已有数据 → 正常返回;无显式会话时优先状态文件。夹具时间戳改为真实纪元毫秒与守卫同量纲。

## 0.8.2 — 2026-09-12

### 修复:每条回复显示「本问」统计,不再出现「上轮」
- **本问统计指令**:UserPromptSubmit 注入新增指令——模型在回答收尾时运行 `token-rate.mjs --turn --current`,把输出行原样引用在回复末尾。它统计的是**本次提问**从提出到最近一次工具调用的真实速率(usage 数据库按 turn 逐段实时入库)。
- **--current 守卫**:最新 turn 的数据若全部早于本次提问时刻(纯问答轮尚无本问数据),脚本不输出任何统计行——**任何情况下都不把上一轮数据当作本问显示**,并明确禁止模型引用「(上轮)」上下文行。
- 注入的「(上轮)」行降级为纯模型上下文并标注禁止引用。
- 说明:统计覆盖到最近一次工具调用为止;最终总结文字在其后生成,不计入。纯问答(无工具调用)的回答没有可靠的「本问」数据,按守卫不显示统计行。

## 0.8.1 — 2026-09-12

### 新增
- **插件图标**:新增 `assets/icon.png`(256×256 速度仪表盘 + 吞吐柱,`node assets/generate-icon.mjs` 可再生成),并在市场清单中为插件声明 `icon` 字段——客户端「发现 / 已安装」列表可显示插件图标。
- 仓库 README 顶部展示图标。

## 0.8.0 — 2026-09-12

### 新增
- **本轮即时速率(Stop 钩子)**:新增 `hooks/stop.mjs` 并注册 `Stop` 事件。回复刚结束、本轮全部请求已入库的瞬间,按最新 `turn_id` 圈定本轮(含"模型→工具→模型"多段),以"总产出 / 总纯生成时长"计算加权即时速率,经 `systemMessage` 由客户端直接显示——不再依赖模型转发,消除"回复完成时统计的却是上一轮"的滞后。
- `token-rate.mjs` 新增 `queryTurn` / `formatTurnLine` 与 `--turn` CLI;多段轮次显示「N 段 / 峰值」。

### 变更
- `prompt-submit` 默认不再附加"回复末尾转发速率行"指令,注入的上一轮速率仅作模型上下文;新配置 `{"stopHookLine": false}` 可停用 Stop 行为、完整恢复 v0.7.x 模型转发旧行为。
- SessionStart 提示语区分新旧两种展示模式。

### 兼容
- 旧版客户端 usage 库无 `turn_id` 列时,本轮查询优雅降级(不抛错,退回单段口径)。

## 0.7.1 — 2026-09-04

### 变更
- 数字显示规则化:每轮「输出」用千分位精确数字(`2,762 tok`);「累计」紧凑单位新增 M 档——千以下原始、1k~1万一位小数(`9.8k`)、1万~100万取整(`51k`)、≥100万一位小数(`73.8M`),修复百万级显示成 `73818k` 的问题。
- CLI 明细行全部改为千分位精确数字(输出/输入/缓存读/请求次数)。
- 监控大屏「上轮输出」卡片与悬浮信息同步千分位。
- 新增 `fmtCompact` / `fmtNum` 换算单测(累计 7 项)。

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
