# 本地开发（当前已实现功能）

> **当前文档记录已有离线基础与 Tiny Task 执行入口，不是通用完整 Agent 的能力承诺。**
> 项目需求已调整为自主机器学习工程 Agent：能在明确规则与资源预算下**读代码、改代码、跑训练、评估与迭代**。新目标请先看 [产品需求](PRODUCT_REQUIREMENTS.md)、[架构](ARCHITECTURE.md)、[CLI 里程碑](CLI_DEVELOPMENT_PLAN.md)、[低成本评测](EVALUATION.md)。  
> 原有 `src/agent.ts` 的 `ask` 入口仍为 `tools: []` 的快照问答；`src/agent/smoke-agent.ts` 为 WP-02 受限 Smoke 验收入口，`src/agent/optimize-agent.ts` 为已实测的 WP-03 单候选自主训练/验证入口；`src/agent/task-agent.ts` 为 WP-04 自然语言审核/有限多轮入口，已在可信 Tiny Task 实测，尚非通用项目 Optimize。之前已有的实验数据导入、表格导出和 Web 离线预览继续保留，但开发主线优先 CLI，Web 暂缓。


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

# 显式启动模型调用和受限代码执行，默认官方按量计费
npm run axiom -- smoke-agent --allow-reviewed-code
```

需要本地 `DEEPSEEK_API_KEY`（默认官方）与 `.venv` Python；可用 `AXIOM_PYTHON` 指定其他解释器。候选工作区自动创建在 `private/wp02-*`。只开放五个受限工具，文件写入限于候选 `model.py`，执行动作限于 L0/Smoke，执行前以 AST 白名单限制简单 Sequential 模型；不开放任意 Shell、不继承模型密钥到训练进程。该模式不是 OS 安全沙箱，只用于可信公开任务。

运行后查看 `report.md`、`summary.json`、`patch.diff`、`pi-events.jsonl`、`operations.jsonl` 及 `smoke/`。自然语言回复可能有路径错误，产物位置以程序报告为准。验收未满足时命令失败并保留轨迹。完整说明见 [WP-02 实测记录](WP02_VALIDATION.md)。

WP-02 本身仅证明真实操作链；单候选自主优化见下一节，多轮实验和预算属于 WP-04。请求/工具次数及超时上限只是该验收的防失控措施。

## WP-03：单候选自主优化

```bash
# 有真实 CPU 训练开销，无 LLM/API 调用，默认 npm test 不执行此项
npm run test:optimize-executor

# 默认调用官方付费接口；显式授权可信 Tiny Task 的受限代码执行
npm run axiom -- optimize-once --allow-reviewed-code
```

环境与 WP-02 相同，需要 Node.js >=22.19.0、CPU PyTorch、`.venv` 或 `AXIOM_PYTHON`，真实模型调用还需本地密钥。`test:ml` 使用当前激活的 `python`；未激活虚拟环境时可直接运行 `.venv/Scripts/python.exe -m unittest discover -s tests/python -v`（Windows）或 `.venv/bin/python -m unittest discover -s tests/python -v`（POSIX）。不要为测试修改全局 Python。

WP-03 只允许一次接受的 `model.py` 编辑，配置固定只读。先训练真实 Baseline，再由模型自行提出候选，经 Smoke 后完整训练一次。工具只开放 validation 评估；先独立重载、读指标，再由模型提出 keep/revert，程序复核严格提升规则，错误决定会被拒绝。

真实运行目录为 `private/wp03-*`。查看 `proposal.json`、`baseline/validation.json`、`candidate-run/validation.json`、`decision.json`、`selected/`、`patch.diff`、`pi-events.jsonl` 和 `report.md`。`selected/` 是最终交付；回退时为原 Baseline，不删除失败候选证据。失败工作流保留已有日志，但不保证所有失败阶段都能生成完整交付。

首次真实验收验证准确率 0.5 → 0.998046875，程序保留模型；另有真实 CPU 持平回退回归。不是最终测试达标声明，也未验证统计显著性。不做多轮、GPU、完整预算或任意代码沙箱。详见 [WP-03 实测记录](WP03_VALIDATION.md)。

## WP-04：自然语言与预算任务

```bash
# 交互终端输入任务，先审查规格再确认执行
npm run axiom
# 非交互规划（默认官方按量计费，但不训练）
npm run axiom -- task "优化 Tiny Task，最多三组候选，禁止预训练，验证达到95%就停，交付最佳模型和报告"
# 审核路径与哈希后才执行
npm run axiom -- task --approve private/wp04-XXXXXX/task-spec.json --sha256 <审核哈希> --allow-reviewed-code

# 无 LLM 的真实 CPU 去重/退化/达标/计算时限回归，默认 npm test 不执行
npm run test:task-executor
```

只支持可信 Tiny Task，配置只读；自然语言不能解除代码策略。不支持的需求应拒绝，翻译错误由用户在 TaskSpec 审核时发现并修正。审批哈希绑定内容，一次性锁防止重复启动；未实现跨任务缓存或崩溃恢复。

`max_experiments` 只计候选尝试，Baseline 也消耗时间、计算与训练步数。模型只交候选源码/理由，预算、去重、最佳和停止由宿主决定。Token 采用请求前保守预留与 SDK usage 结算，缺失/超预留则停止，不承诺供应商绝对计费硬上限。计算额度是单线程 CPU 子进程 elapsed 与训练步数，不是精确 CPU-seconds、内存隔离或 GPU 配额。

产物位于 `private/wp04-*`：`best_model.pt`、匹配的 `model.py/config.json`、完整 `best/` 快照、`experiments.json`、`report.md` 与调用/命令证据。无合法结果时不伪造权重。真实三轮运行与反例边界见 [WP-04 实测记录](WP04_VALIDATION.md)。

## Pi 问答

默认模型接口已恢复为 DeepSeek 官方，所有入口直接调用官方，不先尝试 NIM。新建本地 `.env` 时可参考 `.env.example`；已有文件请手动追加，保留其他配置：

```dotenv
AXIOM_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=填写官方Key
DEEPSEEK_MODEL=deepseek-flash
AXIOM_MODEL_TIMEOUT_SECONDS=120
```

所有模型入口复用 `src/agent/model-provider.ts`，使用 Pi 的 `openai-completions` 实现，无需 Python `openai` 包。默认官方按量计费；如确需 NIM，显式设 `AXIOM_MODEL_PROVIDER=nvidia-nim` 并提供 `NVIDIA_API_KEY`。该可选模式仍支持明确额度耗尽后的官方备用，可设 `AXIOM_DEEPSEEK_FALLBACK=false` 禁用。官方模式不自动切回 NIM。临时限流/超时/认证失败不切换；回退受原请求/Token/墙钟门禁控制，明确拒绝按预留保守计账，详见 [供应商回退](MODEL_PROVIDERS.md)。`.env` 已被 Git 忽略，子进程不继承 API Key。免费开发额度、限流与模型可用性以 NVIDIA 平台为准；SDK 零成本字段是占位，不是实付账单。NIM 普通对话曾返回 HTTP 200 / AXIOM_OK；真实工具尝试约60秒失败，随后另一次尝试被用户中止，没有完成 NIM 端到端验收。单请求默认120秒并脱敏记录底层错误，仍受总任务预算约束。历史 WP 实测仍代表原官方接口。模型供应商/地址/模型/付费备用配置变化后，应重新生成并审核 TaskSpec。然后运行：

```bash
npm run axiom -- ask examples/synthetic-experiment/manifest.json "比较实验差异"
```

此命令会把实验快照发送至配置的模型服务。会话使用内存历史，不加载扩展、Skills 或执行工具。`ask` 本身是快照问答入口，没有工具或训练能力；需要执行任务时使用上面的独立授权入口。

SDK 固定为 npm 1.5.0，与 `vendor/pi` 子模块源码指针独立管理。模型调用需要实际凭据，离线测试不会调用模型。
