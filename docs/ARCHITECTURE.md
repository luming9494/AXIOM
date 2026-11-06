# AXIOM 技术架构与复用边界

> v0.3 · 2026-11-05 · **目标设计，不等于当前已实现。**  
> 产品需求：[PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) · 开发路线：[CLI_DEVELOPMENT_PLAN.md](CLI_DEVELOPMENT_PLAN.md)

## 1. 设计目标

AXIOM 从“实验数据助手”转向**能完成 ML 任务的执行型 Agent**。主要能力不是记录 AP 或生成表格，而是：**理解任务限制 → 读代码 → 修改候选 → 真实训练与评估 → 按反馈迭代 → 交付模型和报告**。

核心是两层循环：

- **Pi Agent Loop**：模型生成、调用工具、接收工具结果、继续推理（复用 Pi）。
- **AXIOM Experiment Loop**：候选代码、训练阶段、资源预算、评估结果、迭代和停止（AXIOM 自研）。

~~~text
                         User / TaskSpec
                        (goal, rules, budget)
                                │
                                ▼
                    AXIOM CLI / Pi TUI
                                │
                                ▼
                      Pi Agent Runtime
              (LLM, context, tools, extensions)
                                │
                                ▼
                    AXIOM Experiment Controller
            ┌───────────────────┼──────────────────────┐
            ▼                   ▼                      ▼
      Task & Policy       Candidate Workspace      Budget Manager
      (hard rules)         (Git diffs)             (wall/token/GPU)
            └───────────────────┼──────────────────────┘
                                ▼
                       Experiment Executor
               L0 checks → L1 smoke → L2 proxy
                           → L3 full
                                │
                                ▼
                      Deterministic Evaluator
                 (metrics, protocol, evidence)
                                │
                                ▼
                    Compare / Reflect / Decide
                        ├─ iterate if allowed
                        └─ stop + deliver
~~~

初期由本地受控进程执行小型 CPU 实验；后续才连接独立 Runner 与远程 Linux GPU。

## 2. 哪些直接复用 Pi，哪些自研？

| 模块 | 复用/开发 | 优先级 |
| --- | --- | --- |
| 模型接入、Agent Loop、基础 Tool Calling、流式事件 | **复用 Pi** | 已有基础 |
| CLI / TUI、会话、Skills、Extensions、MCP | **复用 Pi 并接 AXIOM** | P0 |
| Task Interpreter / TaskSpec（含课程规则） | AXIOM | P0 |
| 模型代码修改与隔离 Workspace / Diff | 复用 Git + AXIOM 策略层 | P0 |
| L0/L1/L2/L3 实验执行策略 | AXIOM | P0–P1 |
| 实验任务级 Budget / Stop Controller | AXIOM | P0–P1 |
| 独立评估脚本、指标与证据链 | 现有代码复用并增强 | P0–P1 |
| 长期 Run Registry / 报告生成 | 现有代码复用并增强 | P1 |
| Python Runner、Job 去重、Checkpoints 和恢复 | AXIOM + Python/PyTorch | P2 |
| MLflow、复杂 RAG、Pi Durable、多 Agent | 在有实际需要时集成 | 后续 |
| Web 与桌面端 | 暂缓开发，保留当前代码 | 后续 |

**不要重写 PyTorch Trainer，不要一开始自造整套 TUI，更不要让模型自己决定权限规则。**

## 3. 核心领域对象（目标契约）

| 对象 | 关键字段 |
| --- | --- |
| Task | id, mode, workspace, rules, goal, budget, state |
| Candidate | task_id, parent_revision, patch, rationale |
| Run | candidate_id, dataset, seed, config_hash, evaluation_protocol, level |
| Job | run_id, job_id, process_ref, status, resources, timings |
| Evidence | run_id, metric, value, source_path, sha256, verification_status |
| Decision | candidate_id, choice, reason, evidence_refs, budget_snapshot |
| Deliverable | task_id, model_path, patch_path, report_path, status |

目标任务生命周期：

`created → inspected → planned → awaiting_approval (if needed) → running → evaluating → iterating / completed / blocked / stopped`。

最终结果状态与阶段状态分开：`target_met / best_effort / budget_exhausted / blocked / failed / cancelled`。

## 4. 三种任务模式使用同一内核

- `optimize`：有目标指标和规则，允许在预算内尝试候选；首先验证 Tiny Task。
- `reproduce`：输入论文与代码，记录达到 Run / Evaluate / Train 哪一级。
- `ablate`：组合开关、识别已跑 Run、控制变量、补齐必要实验并分析。

三个模式共用 Workspace、Evaluator、Budget、Run Registry 和日志/产物追溯；差别是 TaskSpec、候选规划和最终报告模板。不强行拆为三个各自独立的 Agent。

## 5. 实验执行与成本控制

### Progressive execution

1. **L0**：环境/配置/Shape/单测；不能声称模型性能。
2. **L1**：极小批次、少步训练；检查 Loss、前向/反向和保存/加载。
3. **L2**：缩小数据/训练预算的 Proxy；仅用于候选初筛，不能代替正式分数。
4. **L3**：符合任务要求的数据、预算和评估协议；需审批付费或高成本执行。

是否允许 Proxy 要从作业规则中确定；若固定训练预算，不得悄悄增加额外训练。

### Budget

在每次新候选/训练提交前，由**确定性代码**检查墙钟时间、Token、实验次数和计算资源。模型无法修改限额。若 Token/成本数据不完整，要标注不确定性并采用安全的执行边界。训练运行时由 Runner 观察事件，不靠 LLM 高频轮询。

### Safety

- 代码/日志/外部论文都是不可信输入，不能覆盖 TaskSpec 或系统权限。
- 允许读写的 Workspace 必须限定真实路径，防止路径穿越和符号链接逃逸。
- 修改代码应有可审查 Diff 与可回滚 Git 记录。
- 执行第三方训练代码要考虑沙箱、网络与本地凭据访问；不能只靠 Prompt“禁止危险操作”。
- 付费 GPU、删除/覆盖产物、终止任务和云端写入，必须由工具层的人工审批机制拦截。
- 保持私有论文/训练数据本地化，并说明调用外部模型 API 可能发送的上下文。

## 6. 长任务执行的正确边界

**Pi 会话状态不等于训练进程状态。** 未来 GPU Job 必须拥有稳定 `job_id` 和可查询的进程/Checkpoint 状态；网络断连或提交结果不明确时，先核验远端已有任务，再决定是否重试，避免重复花费。恢复前检查模型/优化器状态、代码和配置兼容性。

初期的小型 CPU Task 可以直接用受控本地执行器；真正的 Runner 与 Durable 作为后续单独里程碑，不阻塞 Optimize Tiny Task。

## 7. 当前代码的复用路径

| 当前已有 | 状态 | 在新产品中的位置 |
| --- | --- | --- |
| `src/cli.ts` | 可运行的 import/export/ask 命令入口 | 保留，之后扩展任务命令 |
| `src/agent.ts` | Pi SDK 快照问答入口；未验证真实模型调用，工具列表为空 | 接真实 Tool Calling；不再一味塞全量快照 |
| `src/research.ts` | JSON 实验清单、来源数值校验、SHA-256 | Evidence / Run Registry 的起点 |
| `src/table.ts` | Markdown/CSV/LaTeX 输出 | 实验报告组件 |
| `apps/web/` | 离线前端原型，未连接后端 Agent | 代码保留，不作为近期主线 |
| `vendor/pi` | 固定提交的 Git submodule | 阅读上游与维护扩展兼容性 |

**WP-02 进度补充**：`src/agent/smoke-agent.ts` + `smoke-tools.ts` 已通过真实 Pi 工具链读取与修改候选模型，`src/execution/` 提供受限执行及轨迹；Tiny Task 已有独立指标判题。详见 [WP-02 实测记录](WP02_VALIDATION.md)。WP-02 本身只证明 Smoke 操作链，候选副本与 AST 白名单不是 OS 沙箱。

**WP-03 进度补充**：`src/agent/optimize-agent.ts` / `optimize-tools.ts` 复用 Pi SDK，`src/execution/single-optimize.ts` 负责固定 TaskSpec 与单轮状态。`run_baseline` / `run_candidate` 分开授权；`validate_only.py` 限制独立评估只生成 validation 数据。Agent 自主提出一次源码修改，在完整训练与独立重评估后提出 keep/revert，由程序核验并导出 `selected/`。首次真实运行验证准确率 0.5 → 0.998046875，另有真实 CPU 持平回退回归，见 [WP-03 记录](WP03_VALIDATION.md)。这**不代表**完整多轮 Experiment Loop、跨实验预算器、独立训练 Runner 或最终测试达标已实现；不开放任意 Python 项目或人工参考读取能力。

**WP-04 进度补充**：`task-agent.ts` / `task-decision.ts` 用 Pi SDK 完成自然语言规格和候选方案提交，审核文件哈希后才进入执行。`task-controller.ts` 在模型会话之外管理串行多轮、缓存、历史最佳和停止；`task-budget.ts` 强制执行次数、单调墙钟、保守 Token 准入/usage、累计子进程时间与训练步数。`task-executor.ts` 驱动固定 CPU worker，独立 validation 完成后才更新 best。训练时没有模型会话等待或轮询，停止交付无需再调用模型。三轮真实验收和 CPU 反例见 [WP-04 记录](WP04_VALIDATION.md)。仍无任意项目适配、跨任务恢复、精确供应商计费保证、OS 内存/硬件隔离或 GPU 调度。

## 8. 本地技术评估的开放决定

开发前应在本地跑通现有测试，然后回答：

1. 直接使用 Pi TUI + Extensions 能否满足所有真实工具事件和审批交互？还是需要 SDK 包装自己的 CLI？
2. 是否先用现有 `src/research.ts` 作为轻量 Registry，避免过早引入 MLflow/数据库？
3. L1/L2 最小 PyTorch 实验能否稳定在 CPU 上完成？其资源使用如何测量？
4. 采用 Git Worktree / 受限进程 / Docker 中的哪种隔离方式最小且足够？
5. 哪些问题确实要求修改 Pi 底层，哪些用扩展即可？

**先验证任务闭环，再确定最终模块分拆与基础设施选型。**

## 9. Pi 源码与版本

Pi 官方 [earendil-works/pi](https://github.com/earendil-works/pi) 以 Git submodule 进入 `vendor/pi`。npm SDK 与 submodule 是两套版本固定机制，**不保证完全对应**；开始开发前核对 SDK 实际导出的接口，不直接修改上游 submodule 作为业务代码。遵守 Pi 的 MIT License，AXIOM 不隶属于 Pi 上游。
