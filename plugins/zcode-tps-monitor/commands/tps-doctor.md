---
description: 自检 zcode-tps-monitor 插件:数据库、依赖与运行状态排查
---

运行插件自检并以中文向用户汇报结果。

执行步骤:

1. 运行自检脚本(本命令文件所在目录的 `../../scripts/doctor.mjs`):
   ```bash
   node ../../scripts/doctor.mjs
   ```
2. 逐项解读输出(✅/❌):Node 版本、usage 数据库、会话状态文件、配置文件、大屏进程。
3. 对 ❌ 项,按脚本给出的 hint 给出修复建议(常见:Node 升级到 ≥22.5、设置 ZCODE_USAGE_DB、重装插件后重开会话)。

用户附加要求:$ARGUMENTS
