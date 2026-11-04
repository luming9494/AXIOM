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

## Web 前端

CLI 与 Web 并行保留。Web 使用 React + TypeScript + Vite，代码位于 `apps/web/`；表格格式化逻辑由 `src/table.ts` 供两个入口共用。

```bash
npm run dev:web
# 默认访问 http://127.0.0.1:5173，端口被占用时以终端输出为准
npm run build:web
npm run preview:web
```

当前前端支持工作台概览、实验搜索与状态筛选、多选导出、指标证据详情、Registry JSON 导入，以及移动端导航。默认加载仓库中的两个公开合成实验，不代表真实研究结果。

导入步骤：先使用上文 CLI `import` 生成 `private/registry.json`，再点击页面的“导入实验”选择该文件。不是直接导入 manifest；文件上限 5 MB。导入数据只存在浏览器内存中，刷新会恢复示例，不会上传服务器、调用模型或执行文件内容。

**证据边界：**Web 无法根据来源路径读取本地原始实验文件。页面中的 `verified` 仅表示导入快照的声明，不是浏览器重新核验，也不是实验真实性认证。演示数据统一标为待核验。Web 导出保留快照状态，并在每条记录的说明中附加未重新核验提示；需要新鲜校验结果时使用 CLI 导出。不同数据集或协议仍拒绝合并导出。

研究助手目前仅提供能力边界与 CLI 命令说明，尚未连接 Web 后端。API、持久化、身份认证、Web 模型问答和 GPU 执行都不在此版本中；不要把 API Key 写入前端或 `VITE_*` 环境变量。开发服务器仅绑定本机地址，不用于生产部署。

```bash
npm test                         # CLI / Web 数据与共享导出单元测试
npx playwright install chromium  # 首次运行浏览器测试时安装
npm run test:web                 # 桌面与移动端交互测试，自动启动测试服务器
```

构建输出为 `dist/web/`；浏览器测试截图位于 `test-results/`，均不提交 Git。

## Pi 问答

将 `.env.example` 复制为本地 `.env` 并填写 `DEEPSEEK_API_KEY`，默认使用官方 `deepseek-flash`（按量收费）。`.env` 已被 Git 忽略；已有本地配置时无需覆盖。然后运行：

```bash
npm run axiom -- ask examples/synthetic-experiment/manifest.json "比较实验差异"
```

此命令会把实验快照发送至配置的模型服务。会话使用内存历史，不加载扩展、Skills 或执行工具。当前是快照问答入口，尚无自定义科研工具或训练能力。

SDK 固定为 npm 1.5.0，与 `vendor/pi` 子模块源码指针独立管理。模型调用需要实际凭据，离线测试不会调用模型。
