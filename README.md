<img src="assets/icon.png" align="right" width="72" alt="ZCode TPS Monitor 图标">

# ZCode TPS Monitor

在 ZCode 输入框底部实时查看当前会话的 `tok/s`。悬停查看统计，点击打开多会话监控面板。

## 效果预览

| 中文 | English |
| --- | --- |
| <img src="assets/tps-hover-zh.png" width="320" alt="ZCode 中文悬停卡片与波形底栏"> | <img src="assets/tps-hover-en.png" width="320" alt="English TPS tooltip and composer status in ZCode"> |

卡片跟随 ZCode 的界面语言。ZCode 设为「跟随系统」时，卡片采用系统语言。

## 安装与更新

需要 **ZCode 桌面端 3.18.2+** 和 **Node.js 22.5+**。在 ZCode 中按用户范围安装。

```text
/plugin marketplace add shy3130/zcode-tps-monitor
/plugin install zcode-tps-monitor@tps-local-marketplace
```

已安装时，刷新插件市场中的 GitHub 源，再更新插件。

```text
/plugin marketplace update tps-local-marketplace
/plugin update zcode-tps-monitor@tps-local-marketplace
```

## 使用

- 底栏速率随会话切换，带 `≈` 的读数为流式估算。
- 卡片展示轮次、请求段数、首字延迟、输出、峰值、均速和耗时。大数用 `k/M/B` 显示。峰值和均速使用净生成至少 200 ms 的请求计算。
- 点击波形或速率打开监控面板。`/tps` 查看快照，`/tps 10` 采样 10 秒，`/tps-doctor` 检查环境。

[插件文档](plugins/zcode-tps-monitor/README.md) · [更新记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
