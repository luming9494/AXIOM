# 本地开发

要求 Node.js >=22.19.0，安装依赖后运行：

```bash
npm ci
npm run build
npm test
npm run axiom -- import examples/synthetic-experiment/manifest.json private/registry.json
npm run axiom -- export examples/synthetic-experiment/manifest.json private/comparison.md markdown
npm run axiom -- export examples/synthetic-experiment/manifest.json private/comparison.csv csv
npm run axiom -- export examples/synthetic-experiment/manifest.json private/comparison.tex latex
```

请先创建 `private/` 目录，输出文件必须不存在。离线命令不需要模型密钥或初始化 Pi 子模块。来源 JSON 仅支持顶层数值字段，路径相对于实验清单目录且不能越界。

`verified` 表示来源数值匹配，SHA-256 记录导入时文件状态，不代表实验真实性已审计。缺失、不匹配或越界的指标标为 `unverified`。导出时重新校验来源；不同数据集或评估协议拒绝汇总。代码版本、种子和配置会保留在表格中，其余可比性需人工判断。

## Pi 问答

将 `.env.example` 复制为本地 `.env` 并填写 `DEEPSEEK_API_KEY`，默认使用官方 `deepseek-flash`（按量收费）。`.env` 已被 Git 忽略；已有本地配置时无需覆盖。然后运行：

```bash
npm run axiom -- ask examples/synthetic-experiment/manifest.json "比较实验差异"
```

此命令会把实验快照发送至配置的模型服务。会话使用内存历史，不加载扩展、Skills 或执行工具。当前是快照问答入口，尚无自定义科研工具或训练能力。

SDK 固定为 npm 1.5.0，与 `vendor/pi` 子模块源码指针独立管理。模型调用需要实际凭据，离线测试不会调用模型。
