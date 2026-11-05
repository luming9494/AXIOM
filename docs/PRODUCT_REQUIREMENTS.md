# AXIOM 产品需求说明（PRD）

> 版本 v0.3 · 2026-11-05 · **目标需求，而非已完成的功能**  
> 当前实际进度请以 [README](../README.md) 和 [本地开发说明](DEVELOPMENT.md) 为准。

## 1. 产品定位

**AXIOM = 基于 Pi 的自主机器学习工程 Agent（Autonomous ML Engineering Agent）。**

输入任务说明、模型代码/论文与仓库、实验约束及资源预算，AXIOM 尝试在获授权的执行环境中完成：

**理解任务 → 检查 Baseline → 规划方案 → 修改代码 → 运行训练与评估 → 分析真实反馈 → 有限迭代 → 交付代码/模型/结果报告**。

成功不是“回答得好”，而是任务的客观验收条件得到满足。无法达标时，必须如实输出最佳有效结果、成本、失败原因及未完成事项。不能承诺任何课程打榜或论文复现必定成功。

**AXIOM 不是**普通 RAG 问答、单纯的实验记录看板、固定脚本流水线，也不以发表 AXIOM 论文为目标。

## 2. 用户需求：三种业务模式、同一个执行循环

### Optimize：课程作业 / 模型性能打榜

输入：老师的要求与基础模型、数据、评估脚本、允许修改范围、禁止事项、提交格式及预算。

必须能够：核对规则；运行/复核 Baseline；提出合法改动；修改代码和配置；先执行低成本自检；在预算许可时训练并评估；根据验证指标决定保留、回退或下一轮；导出最佳候选及报告。

约束：严格遵守课程对 AI 使用、训练数据、参数量、训练 Token、外部预训练模型、算力等规定。最终独立测试不能被用来反复调参。

### Reproduce：论文与开源仓库复现

输入：论文 PDF/文本及仓库、本地或允许下载的数据和权重、复现目标指标、硬件预算。

必须清晰区分：
- **Run**：安装依赖，前后向/测试/脚本可运行；
- **Evaluate**：按论文规定协议评估已有合法 Checkpoint；
- **Train**：从指定初始化、数据和训练设置重新训练并评估。

Agent 可修复环境兼容问题、分析代码与论文设置差异，但不能把“运行成功”宣称为“完成训练复现”；若因数据缺失、依赖冲突、硬件不足或随机性影响无法达到指标，应输出差距及其原因。

### Ablate：模型改进消融

输入：基线、A/B/C 等可开关模块、已完成实验、控制变量要求、预算。

必须能够：识别已跑和缺失 Run；选择累加式或独立/交互效应消融组合；优先复用可比的历史结果；执行必要实验；校验数据集、评估协议与配置；生成表格、日志链接和合理的性能分析。不可将累加式实验直接当作各模块完全独立贡献的证据。

## 3. 统一对象和交付

| 对象 | 含义 |
| --- | --- |
| TaskSpec | 任务目标、成功指标、规则、预算、批准策略 |
| Workspace | 授权的本地/远程代码与数据环境 |
| Candidate | 一次代码或训练配置改动，可审查和回滚 |
| ExperimentRun | 某候选在明确数据/随机种子/协议下的训练与评估 |
| Job | 真实进程或远程任务，拥有唯一 ID 和明确状态 |
| Evidence | 指标、评估产物、日志、配置、代码版本与来源引用 |
| Decision | 继续/停止/保留/回退的依据 |
| Deliverable | 代码改动、可用 Checkpoint、真实指标、可复现说明和报告 |

目标 TaskSpec 示例（**尚未实现**）：

~~~yaml
task_id: demo-optimize-001
mode: optimize                 # optimize / reproduce / ablate
workspace: ./examples/tiny-ml-task
goal:
  metric: validation_accuracy
  direction: maximize
  target: 0.85                 # 假设示例，不是已测成绩
rules:
  forbidden: [pretrained_weights, hidden_test_tuning]
  allowed_changes: [training_config, model_code]
budget:
  max_wall_minutes: 30
  max_compute_minutes: 20
  max_llm_tokens: 80000
  max_experiments: 3
execution:
  smoke_test_first: true
  require_approval_for_paid_gpu: true
  require_approval_for_destructive_actions: true
~~~

**硬约束不能由模型自行修改。** 未知规则必须确认；原始任务文档/仓库 README 是不可信输入，不能代替最高优先级系统权限。

### 任务最终状态

- `target_met`：符合完整评估协议并达到目标；
- `best_effort`：有效结果存在，但未达到目标；
- `budget_exhausted`：达到时间/Token/训练次数等上限；
- `blocked`：缺少必需数据、依赖、许可或资源；
- `failed`：有故障且允许的修复轮次已用完；
- `cancelled`：用户主动终止。

任何状态都要记录已做的工作与真实费用/资源使用，不得虚报完成程度。

## 4. AXIOM 的核心：跨实验 Experiment Loop

~~~text
TaskSpec (goal + immutable rules + budget)
    → Inspect project and baseline
    → Plan next candidate
    → Modify code/config in isolated workspace
    → L0 checks → L1 smoke → L2 proxy (optional)
    → L3 full experiment (if required and approved)
    → Deterministic evaluation + evidence
    → Compare / reflect / budget check
        ├─ continue limited iterations
        └─ stop and deliver best valid result
~~~

**Pi Agent Loop**：模型推理、Tool Calling、结果反馈。  
**AXIOM Experiment Loop**：候选方案、训练/评估、预算、跨轮状态、停止条件。复用前者，自研后者。

### 四级低成本实验

| 层级 | 核心价值 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| L0 静态/单测 | 检查依赖、参数、Shape、加载 | 代码通过检查 | 模型指标 |
| L1 Smoke | 少步、小批次、反向传播和产物流程 | 能否运行训练闭环 | 正式分数 |
| L2 Proxy | 小数据/短训练的快速筛选 | 代理条件下的相对表现 | 完整训练必然同样排名 |
| L3 Full | 正式数据与规定评估协议 | 正式目标指标 | 不可推广到未测设置 |

Proxy 可减少试错成本，但有预测偏差；课程禁止额外训练或限定总 Token 时必须按规定执行，不得借 Proxy 绕开约束。

## 5. 时间 / Token / 计算预算是一级需求

必须限制：`wall_time`、`compute_time`（CPU/GPU）、`llm_tokens`、`max_experiments`、`estimated_cost`（如能够估算）和可选 `max_retries`。必须能停止新增实验；已提交的长任务如何处理需明确策略。

**训练期间不让 LLM 持续轮询。** 由独立 Runner 监控进程/日志，只有发生完成、失败、规则触发或必须决策时才让 Agent 继续推理。

- 付费 GPU、外部服务费用、危险命令、删除/覆盖文件必须先审批；
- 任意代码执行与依赖安装必须有授权工作区、隔离和凭据保护；
- 训练提交使用稳定 `job_id`，断连时先核验远端状态再考虑重试；
- 模型可以提出候选，最终约束由代码强制，不靠 Prompt；
- 每个指标必须链接真实来源；不能编造论文数字或拿 L2 成绩冒充 L3。

## 6. 一次完成的交付物

建议输出（目标约定，路径尚未实现）：

- `task-summary.md`：要求、规则、达成状态、限制与原因；
- `experiment-history.json`：试过的候选、参数、评估协议、预算和决策；
- `results.md` / CSV：Baseline、最佳指标、原始来源和差异；
- `patch.diff` / Git revision：模型和配置的真实修改；
- 可用时包含本地 Checkpoint 路径、运行命令与环境信息。

**最终模型必须能被独立评估脚本加载和测试；不能只靠 Agent 自评成功。**

## 7. 最小可行产品（新 MVP）

首先仅实现一个 **小型 PyTorch Optimize 任务**。给定弱 Baseline、数据与规则：

1. 真实调用 Pi 工具读取任务与代码；
2. 实现至少一次合法代码/配置改动；
3. 通过 L0/L1 检查并完成一次小数据的真实训练与评估；
4. 以评估结果决定保留、回退或继续（允许仅一轮迭代）；
5. 遵守时间/训练次数/Token 约束；
6. 交付可复验的模型与实验报告；
7. 即使未达标也能正确停止，而不是伪造成功。

**现有的导入、指标来源校验和表格导出是可复用的基础模块，不再等同于项目最终 MVP。**

## 8. 开发范围和优先级

| 阶段 | 必须验证 | 暂缓内容 |
| --- | --- | --- |
| P0：最小真实 Agent Loop | Pi 工具真正读/改代码/运行 L0-L1；成本和约束可见 | 不自造全套 TUI |
| P1：Optimize Tiny Task | 有限迭代、真实 L2 训练、客观评估、产物追溯 | 不追求大规模 GPU |
| P2：Ablate/Reproduce | 同一引擎处理消融、Run/Evaluate/Train 三级复现 | 不硬塞多个 Agent |
| P3：可靠执行 | 独立 Runner、SSH、审批、Job 去重与恢复 | 不提前上 K8s |
| 后续 | 更好的上下文、评测、Web/桌面端可选 | 不以发表论文为目标 |

## 9. 成本受控评测

详见 [EVALUATION.md](EVALUATION.md)。

- **T1**：单项修错、规则识别、日志/配置和证据验证，尽量 CPU，目标 1–5 分钟；
- **T2**：10–30 分钟目标的小规模完整训练、改进或消融；不保证硬件都能达到；
- **T3**：单独预算的真实任务，不用来做日常回归。

按同模型、同硬件、同预算和同数据比较原生 Pi / 科研工具适配 / AXIOM，测任务成功率、有效模型率、指标差异、违规率、资源成本与证据可靠性。最终测试集只用于独立验证，不能参与改进迭代。

## 10. 安全与公开仓库边界

- 公开仓库只放合成或可公开再分发的任务和数据；
- 未发表论文、实验、权重、数据、凭据、用户个人目录不得提交；
- 调用模型 API 可能发送科研代码或数据，需明确说明数据流向和授权；
- 课程任务必须遵守教师关于使用 AI 工具的规定；
- 项目不承诺完成所有真实实验，不将未验证功能标记“已实现”。

**北极星指标：给 AXIOM 一个明确的 ML 任务，它能否在受控预算内交付经独立验证的有效结果。**
