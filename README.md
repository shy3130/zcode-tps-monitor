# tps-local-marketplace

本地 ZCode 插件市场,目前收录 `zcode-tps-monitor` 插件。在 ZCode 客户端
**设置 → 插件管理 → 发现 → +** 中添加本目录即可(选择"本地目录"来源)。

## 效果预览

收录插件 [zcode-tps-monitor](plugins/zcode-tps-monitor/README.md):每轮对话自动在回复末尾注入真实 token 速率行(读取 ZCode usage 数据库):

![token 速率行效果](plugins/zcode-tps-monitor/docs/effect-token-rate.png)

```json
{
  "name": "tps-local-marketplace",
  "owner": { "name": "Administrator" },
  "plugins": [
    {
      "name": "zcode-tps-monitor",
      "source": "./plugins/zcode-tps-monitor",
      ...
    }
  ]
}
```
