# tps-local-marketplace

本地 ZCode 插件市场,目前收录 `tps-monitor` 插件。在 ZCode 客户端
**设置 → 插件管理 → 发现 → +** 中添加本目录即可(选择"本地目录"来源)。

```json
{
  "name": "tps-local-marketplace",
  "owner": { "name": "Administrator" },
  "plugins": [
    {
      "name": "tps-monitor",
      "source": "./plugins/tps-monitor",
      ...
    }
  ]
}
```
