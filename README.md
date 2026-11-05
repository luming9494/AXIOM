<div align="center">

<img src="./assets/axiom-banner.svg" alt="AXIOM — Autonomous ML Engineering Agent" width="100%" />

<br />

**Autonomous Machine Learning Engineering & Experimentation Harness**

**基于 Pi 的自主机器学习工程 Agent：从任务要求到真实模型、实验结果与可复现报告。**

[![Built on Pi](https://img.shields.io/badge/Built_on-Pi_Agent-1B756F?style=flat-square)](https://github.com/earendil-works/pi)
![Status](https://img.shields.io/badge/status-early_prototype-4B6680?style=flat-square)
![Core](https://img.shields.io/badge/core-TypeScript-3178C6?style=flat-square)

</div>

> **项目状态：Early Prototype / 需求已明确，完整执行型 Agent 尚未实现。**  
> 目前已有离线实验数据导入、简单指标来源核验、Markdown/CSV/LaTeX 导出，以及接入了 Pi SDK 的**无工具快照问答入口**（真实模型请求仍需本地验证）。另有一个未连接 Agent 后端的离线 React Web 原型。**WP-02 已验证 Pi 真实读取代码、在受限候选副本中修改 MLP 并运行 Smoke；完整训练优化、多轮实验预算与 GPU 调度仍待开发。**

## What is AXIOM?

AXIOM 旨在让 AI/ML 学习者和研究者，把一个有明确限制的机器学习任务交给 Agent：

**理解任务 → 检查基线 → 设计候选 → 修改代码 → 运行训练/评估 → 根据真实结果迭代 → 交付模型、配置和报告。**

AXIOM 不只是论文 RAG、实验管理面板或日志总结器。它的目标是**在有限时间、LLM Token 与计算预算内，尽可能自主完成真正可验证的机器学习工程任务**，并在无法达标时如实报告最好结果与失败原因。

### 三类核心使用场景（目标能力）

| 模式 | 用户会说什么 | 预期交付 |
| --- | --- | --- |
| **Optimize** · 模型优化/打榜 | “这是老师的基础模型与作业规则，在预算内尝试改进验证指标。” | 合规的代码修改、真实训练、最优有效模型与成绩报告 |
| **Reproduce** · 论文复现 | “这篇论文有配套代码，帮我尽量复现其训练或评估结果。” | 环境、运行/评估/训练复现级别、与论文差距及证据 |
| **Ablate** · 消融实验 | “已有几个模块和实验，补齐有意义的消融，形成对照报告。” | 消融组合、运行记录、可比较指标与分析报告 |

三种模式共用一个 **AXIOM Experiment Loop**；不会一开始就制造三个互不相关的 Agent。上述能力**正在规划/开发，并非现在即可完整使用**。

## 核心设计：Agent 决策 + 真实执行 + 预算控制

~~~text
TaskSpec (目标 / 作业限制 / 验收标准 / 预算)
    │
    ▼
Pi Agent (代码理解、Tool Calling、候选规划)
    │
    ▼
AXIOM Experiment Loop
    ├── 修改代码并保存可审查 Diff
    ├── L0 静态检查 / L1 Smoke Test
    ├── L2 小规模代理实验（允许时）
    ├── L3 正式训练与评估（按规则/审批）
    ├── 基于结果决定保留、回退、继续或停止
    └── 记录 Token、计算时间、任务状态与证据
    │
    ▼
代码 + 配置 + Checkpoint + 指标 + 实验报告
~~~

**Pi Agent Loop** 负责模型推理与工具调用；**AXIOM Experiment Loop** 负责实验任务层面的迭代、预算、真实训练和终止条件。实验运行时无需一直向 LLM 轮询训练是否完成。长任务和远程 GPU 后期交给独立 Runner 维护。

## 已有功能 vs. 开发目标

| 模块 | 当前状态 |
| --- | --- |
| Pi 上游源码 | ✅ 已作为 Git submodule 放在 `vendor/pi` |
| 实验 JSON 清单、指标文件数值核验和 SHA-256 记录 | ✅ 基础版已实现；不等于科研真实性审计 |
| Markdown / CSV / LaTeX 实验表格 | ✅ 已实现 |
| Pi SDK 快照问答 | 🟡 入口已接入；未验证真实模型连接；没有工具 |
| React Web 实验快照原型 | 🟡 已有离线页面，当前暂停开发 |
| Tiny PyTorch 离线训练与独立判题 | ✅ WP-01 基础版；人工 Baseline/参考改动，非 Agent 优化，见[任务说明](examples/tiny-ml-task/README.md) |
| Agent 读/改代码并运行 Smoke | ✅ WP-02 真实 Pi Tool Calling 已验证；含越界写入/非法命令拒绝，见[实测记录](docs/WP02_VALIDATION.md) |
| Agent 自主改进并完成正式训练 | ⬜ WP-03 待实现；Smoke 不等于模型优化 |
| 任务约束、预算、实验反馈与有限迭代 | ⬜ 尚未实现 |
| Optimize / Reproduce / Ablate 完整工作流 | ⬜ 尚未实现 |
| 远程 GPU Runner、审批和恢复 | ⬜ 尚未实现 |

## Quick Start：现有可运行功能

需要 **Node.js ≥22.19**。

~~~bash
git clone --recurse-submodules https://github.com/luming9494/AXIOM.git
cd AXIOM
npm ci
npm run build
npm test

# 只使用公开的合成实验数据
mkdir private
npm run axiom -- import examples/synthetic-experiment/manifest.json private/registry.json
npm run axiom -- export examples/synthetic-experiment/manifest.json private/comparison.md markdown
~~~

> `private/` 已被 Git 忽略。输出文件必须不存在。如果本地已有输出，请更换文件名。Windows PowerShell、CMD、Linux/macOS 的新建目录操作可根据环境调整。

需要配置合法的模型 API Key 后，可以尝试已有**快照问答**命令：

~~~bash
npm run axiom -- ask examples/synthetic-experiment/manifest.json "比较这两次示例实验"
~~~

该入口目前仍是**将数据快照发送给模型的单次问答**，不是能改代码/跑训练的 Agent。真实模型调用尚需在本地验证；请勿把 API Key、私有论文数据或日志提交到 GitHub。

## WP-02：真实工具调用验收

```bash
# 显式授权可信 Tiny Task 的受限代码执行；会调用模型 API 并产生费用
npm run axiom -- smoke-agent --allow-reviewed-code
```

Pi 模型会实际读取线性模型、在新的候选副本中编辑 MLP、运行 Smoke、读取独立重载结果，并测试越界写入与非法动作的拒绝。输出位于 `private/wp02-*`，含 Diff、Pi 工具事件、命令日志、权重及确定性报告。仅支持窄范围的可信 Sequential 模型，不是 OS 沙箱；不开放任意 Shell，不代表自主优化已完成。环境与实测结果见 [WP-02 记录](docs/WP02_VALIDATION.md)。

## 开发路线

**近期唯一主线：完成一项小型 PyTorch Optimize 任务的闭环**——Agent 真正读取规则、修改代码、跑 Smoke Test、执行小规模训练、客观评估、在预算内选择下一步并生成可复现实验报告。

在此基础上再扩展：
1. **Ablate / Reproduce**：消融与论文复现，共用执行内核；
2. **Reliable Runner**：远程 GPU、Job 去重、审批和状态恢复；
3. **Eval**：小型快速任务 + 少量端到端训练 + 独立真实任务，记录质量和成本；
4. **Web/Desktop（可选）**：CLI 能力稳定后再考虑。

![AXIOM CLI 交互效果概念图](./assets/axiom-cli-preview.svg)

*以上是设计概念图，不是已运行的 AXIOM CLI 截图；初期优先复用 Pi 原生 TUI。*

## 文档

- **[产品需求（PRD）](docs/PRODUCT_REQUIREMENTS.md)** — 三种任务模式、统一 Experiment Loop、预算、交付和验收。
- **[技术架构](docs/ARCHITECTURE.md)** — Pi 已有能力、自研边界、领域对象与安全约束。
- **[CLI 开发路线](docs/CLI_DEVELOPMENT_PLAN.md)** — 本地评估顺序、阶段里程碑和首批开发任务。
- **[新 MVP 实施计划](docs/IMPLEMENTATION_PLAN.md)** — WP-02 真实操作验收 → WP-03 单轮自主优化 → WP-04 多轮与预算。
- **[WP-02 实测记录](docs/WP02_VALIDATION.md)** — 真实 Pi 工具链、代码修改、Smoke 产物、权限拒绝及已知限制。
- **[低成本评测计划](docs/EVALUATION.md)** — T1/T2/T3 小任务与指标、基线、资源公平性。
- **[现有代码开发说明](docs/DEVELOPMENT.md)** — 当前实际可运行命令及 Web 原型的限制。

## 安全、课程规则与可信实验

- 任何课程作业必须遵守教师允许的 AI 工具使用范围、数据/模型限制及评估规则。
- 真实指标应来自实际训练/评估产物；L2 代理实验不得冒充 L3 正式指标。
- 任务规则由可信代码执行，不能由模型自行覆盖；付费 GPU 与破坏性操作需要用户授权。
- 陌生仓库代码、外部依赖和模型工具存在执行风险，应使用隔离工作区及最小权限。
- **公开仓库不包含未发表论文名称、私有模型代码、真实实验数据、Checkpoint 或 API Key。**
- AXIOM 不承诺每次完成任务或达到排行榜目标，所有尚未实现的能力均以 roadmap 标注。

## Pi 上游与许可

AXIOM 基于 [Pi](https://github.com/earendil-works/pi)，将官方源码以 Git submodule 接入 `vendor/pi`（固定提交 `676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d`）。后续升级需显式审查提交指针；当前 npm SDK 依赖与该 submodule 的版本独立管理。Pi 遵循其上游 MIT License，AXIOM 与 Pi 官方无隶属关系。

---

<div align="center">

**AXIOM · From Task to Experiment, From Experiment to Evidence.**

</div>
