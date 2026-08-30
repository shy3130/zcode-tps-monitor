---
description: 打开 TPS 实时监控大屏(浏览器页面,每秒自动刷新)
---

拉起 tps-monitor 的实时监控大屏并在浏览器中打开。

执行步骤:

1. 先探测服务是否已在运行:`curl -s -m 2 http://127.0.0.1:7423/api/metrics`。
2. 若未运行,后台启动(不要阻塞会话):
   ```
   nohup node "<插件目录>/dashboard/server.mjs" >/dev/null 2>&1 &
   ```
   插件目录 = 本插件安装位置(技能 base directory 的上两级);端口默认 7423,可用 `--port N` 调整。
3. 用系统命令打开浏览器:Windows 上 `start http://127.0.0.1:7423`。
4. 告知用户:页面每秒自动刷新;顶部标签显示数据模式;要接入真实数据源,在 设置 → 插件管理 → tps-monitor 配置 `metrics_url` 后重启大屏进程(或给 server.mjs 设置环境变量 TPS_URL)。

如需停止大屏:结束对应 node 进程即可。

用户附加要求:$ARGUMENTS
