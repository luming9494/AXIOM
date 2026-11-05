# 本地开发（当前已实现功能）

> **当前文档记录的是已经存在的离线原型，不是 AXIOM 未来的完整 Agent。**  
> 项目需求已调整为自主机器学习工程 Agent：能在明确规则与资源预算下**读代码、改代码、跑训练、评估与迭代**。新目标请先看 [产品需求](PRODUCT_REQUIREMENTS.md)、[架构](ARCHITECTURE.md)、[CLI 里程碑](CLI_DEVELOPMENT_PLAN.md)、[低成本评测](EVALUATION.md)。  
> 原有 `src/agent.ts` 的 `ask` 入口仍为 `tools: []` 的快照问答；新增 `src/agent/smoke-agent.ts` 为 WP-02 受限执行验收入口，已真实验证读代码、候选编辑与 Smoke，不是完整 Optimize。之前已有的实验数据导入、表格导出和 Web 离线预览继续保留，但开发主线优先 CLI，Web 暂缓。


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

仓库仍保留 CLI 与 Web 两套已有入口，但当前研发主线为 CLI，Web 新功能暂缓。Web 使用 React + TypeScript + Vite，代码位于 `apps/web/`；表格格式化逻辑由 `src/table.ts` 供两个入口共用。

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

## Tiny PyTorch 任务（WP-01，离线训练基座）

已新增公开合成分类任务、线性 Baseline、人工 MLP 参考改动，以及真实 CPU 训练、权重保存/加载、独立指标重算与最终指标判题。完整环境说明、命令、实测结果和安全限制见 [Tiny Task 使用说明](../examples/tiny-ml-task/README.md)。

```bash
# 使用安装了 CPU PyTorch 的 Python 3.11 环境
python examples/tiny-ml-eval/checks.py --candidate examples/tiny-ml-task
python examples/tiny-ml-eval/train.py --candidate examples/tiny-ml-task --output private/tiny-demo/baseline --level full
python examples/tiny-ml-eval/evaluate.py --run private/tiny-demo/baseline --output private/tiny-demo/baseline/validation.json
npm run test:ml
```

这是真实手工训练/评估基础，不是 Agent 自动优化。独立判题目前只判模型有效性与指标，不等同于规则、预算与执行安全全部验证。尚无预算控制器和任意代码沙箱；仅运行可审查的可信样例。已有离线 Node.js 测试不要求安装 Torch，Python 测试单独运行。

## WP-02：Pi 真实操作 Tiny Task

```bash
npm run build
npm test
# 有 CPU PyTorch 的 Python 环境下运行
npm run test:ml

# 显式启动真实模型调用和受限代码执行，会产生 API 费用
npm run axiom -- smoke-agent --allow-reviewed-code
```

需要本地 `DEEPSEEK_API_KEY` 与 `.venv` Python；可用 `AXIOM_PYTHON` 指定其他解释器。候选工作区自动创建在 `private/wp02-*`。只开放五个受限工具，文件写入限于候选 `model.py`，执行动作限于 L0/Smoke，执行前以 AST 白名单限制简单 Sequential 模型；不开放任意 Shell、不继承模型密钥到训练进程。该模式不是 OS 安全沙箱，只用于可信公开任务。

运行后查看 `report.md`、`summary.json`、`patch.diff`、`pi-events.jsonl`、`operations.jsonl` 及 `smoke/`。自然语言回复可能有路径错误，产物位置以程序报告为准。验收未满足时命令失败并保留轨迹。完整说明见 [WP-02 实测记录](WP02_VALIDATION.md)。

本次仅证明真实操作链；自主优化属于 WP-03，多轮实验和预算属于 WP-04。请求/工具次数及超时上限只是该验收的防失控措施。

## Pi 问答

将 `.env.example` 复制为本地 `.env` 并填写 `DEEPSEEK_API_KEY`，默认使用官方 `deepseek-flash`（按量收费）。`.env` 已被 Git 忽略；已有本地配置时无需覆盖。然后运行：

```bash
npm run axiom -- ask examples/synthetic-experiment/manifest.json "比较实验差异"
```

此命令会把实验快照发送至配置的模型服务。会话使用内存历史，不加载扩展、Skills 或执行工具。当前是快照问答入口，尚无自定义科研工具或训练能力。

SDK 固定为 npm 1.5.0，与 `vendor/pi` 子模块源码指针独立管理。模型调用需要实际凭据，离线测试不会调用模型。
