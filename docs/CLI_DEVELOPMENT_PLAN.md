# AXIOM CLI-first 开发路线

> v0.3 · 2026-11-05 · **新的开发顺序**：能读/改代码并跑出真实结果的 Agent → 预算约束的 Optimize → Ablate / Reproduce → GPU Runner → 可选 Web。
>
> **执行进度更新**：WP-02 真实读/改代码、Smoke 与权限拒绝已通过；WP-03 单候选自主优化也已实测通过（独立 validation 提升与程序核验的保留决定，无最终测试）。见 [WP-02](WP02_VALIDATION.md) / [WP-03](WP03_VALIDATION.md)。下一工作包 WP-04 做多轮与预算；具体以 [实施计划](IMPLEMENTATION_PLAN.md) 为准，下文“阶段”编号不是 WP 编号。
> 完整产品边界：[PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) · 测试：[EVALUATION.md](EVALUATION.md)

## 0. CLI 体验目标

![AXIOM CLI 交互概念图](../assets/axiom-cli-preview.svg)

> **图为设计概念，不是 AXIOM 当前真实运行截图。** 初期不自研终端 TUI，先复用 Pi CLI，并通过 Extensions/Skills 提供真实科研任务能力。图中的右侧信息栏不代表 Pi 目前已有该 UI。

最终想要的交互：

~~~text
$ axiom                         # 目标命令，尚未实现
> 请在合法修改范围和预算内优化这个小型分类模型。

AXIOM → 读取任务规则/仓库 → 建立基线
      → 提出代码改动并展示 Diff
      → L0/L1 检查
      → 小规模训练与验证
      → 根据真实结果保留/回退候选
      → 输出代码、模型和实验报告
~~~

核心不是“会画终端 UI”，而是工具和训练**真的执行过**。

## 1. 当前仓库状态（依据 2026-11-05 代码）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| Pi 官方源码 | 已引入 | `vendor/pi` Git submodule |
| JSON Run 清单导入 | 已实现 | `src/research.ts` / `src/cli.ts` |
| 来源数值验证和 SHA-256 记录 | 已实现基础版 | 不代表完整科研真实性验证 |
| Markdown / CSV / LaTeX 导出 | 已实现 | `src/table.ts` |
| Pi SDK 快照问答入口 | 已接入但未验证真实模型调用 | `src/agent.ts`，当前 `tools: []` |
| React 离线 Web 原型 | 已存在，当前暂缓 | `apps/web/`，无 Web Agent 后端 |
| 自定义 Tool Calling / Agent 编辑代码 | **WP-02 已实测** | 受限模型编辑 + Smoke + 结果读取，不是完整优化 |
| 单候选模型训练/验证/选择 | **WP-03 已实测** | `optimize-once`；自主方案、验证提升与真实 CPU 无提升回退回归，不是完整多轮 MVP |
| Budgeted Experiment Loop | **未实现** | 主要 Harness 自研模块 |
| GPU Runner / 恢复 | **未实现** | 后续任务 |

**注意：旧“导入实验并导出表格”的 MVP 已成为基础能力，不再是新的项目验收终点。**

## 2. 阶段 0：本地基线和源码熟悉（先做）

- [ ] `npm ci` / `npm run build` / `npm test` 回归已有功能；
- [ ] 使用合成数据验证 `import`、`export`，确认输出来自真实文件；
- [ ] 配置本地私有模型密钥，核验 `ask` 的成功、报错与密钥脱敏；
- [ ] 阅读 Pi Agent Loop、SDK 与 Extensions 的最小调用链；
- [ ] 验证 Pi TUI 能否加载 AXIOM 的自定义工具与 Skill；
- [ ] 写下与 npm SDK 版本不一致的上游子模块接口差异。

**验收**：工具确实被模型调用（有可核对的事件记录），而不是模型口头说调用了。无需先读完全部 Pi 源码。

## 3. 阶段 1：最小可运行 ML Agent（最高优先级）

- [ ] 设计 Tiny PyTorch Task：固定小数据、弱 Baseline、可检查的规则；
- [ ] 在不调用模型时运行 Baseline / 单测 / 训练脚本，取得实际耗时；
- [ ] 注册授权工作区的读文件、代码编辑、运行测试、读取指标工具；
- [ ] 实现改动隔离与 Git Diff / 回滚；
- [ ] 让 Agent 读取作业规则、理解代码、提出一个合法候选；
- [ ] 真正执行 L0 静态/单测和 L1 Smoke，返回失败日志与训练输出。

**验收**：Agent 能对给定项目完成至少一次有意义的**真实文件修改**，并执行训练最小闭环，而不是只生成建议。

## 4. 阶段 2：Optimize Tiny Task + Budget（新 MVP）

- [ ] TaskSpec：目标指标、允许修改范围、禁止行为、成功条件；
- [ ] Budget Controller：墙钟、模型 Token、实验次数和 CPU/GPU 资源；
- [ ] 实现 L2 小数据真实训练与独立评估；L3 只在需要且被允许时执行；
- [ ] 最多进行任务预算允许的有限轮候选调整；
- [ ] 每轮保存代码 Diff、参数、运行命令、指标与执行成本；
- [ ] 实现 `target_met / best_effort / budget_exhausted / blocked / failed`；
- [ ] 输出最优有效候选、结果对比表、完整执行报告和复现说明。

**验收**：同一个完整 Tiny Task 可从任务输入跑到最终真实产物；不达标、超预算或失败也能正确交付与停止。不能把 L2 代理结果冒充完整任务分数。

## 5. 阶段 3：通用性验证

- [ ] Ablate：实现两个可开关模块的最小消融任务；
- [ ] Reproduce：先完成公开轻量仓库的 Run / Evaluate，再探索 Train；
- [ ] 不重新造三个 Agent，尽可能共用 TaskSpec、Runner、Evaluator、Registry；
- [ ] 对工具失败、依赖冲突、不可比指标和中断进行故障注入；
- [ ] 记录 Token、训练时间、任务完成质量，并与同资源原生 Pi 对照。

**验收**：同一 Harness 可完成至少两类不同 ML 任务，且报告明确指出达标等级和依据。

## 6. 阶段 4：远程 GPU 与可靠执行（后续）

- [ ] 设计 Python Runner：`submit / status / logs / cancel / reconcile`；
- [ ] 先本地长任务模拟，再连接远程 Linux GPU（Windows 本地管理）；
- [ ] 给任务生成稳定 Job ID，超时/断线时先查状态再重试；
- [ ] 记录 Checkpoint/权重与训练配置，验证恢复兼容性；
- [ ] 付费 GPU、危险 Shell、删除产物等动作有确定性审批；
- [ ] 实现异常事件通知，让 LLM 只在需要决策时被唤醒。

**验收**：客户端退出不等于训练消失；重连后可核验远程状态；重复提交不会重复启动收费任务。

## 7. 阶段 5：评测与产品化

- [ ] T1：短小故障修复任务；
- [ ] T2：真实小规模训练（目标 10–30 分钟，硬件相关）；
- [ ] T3：真实科研任务另行安排预算，不进入日常测试；
- [ ] 记录成功率、有效模型、约束违规、Token、GPU/CPU 时长和来源可靠性；
- [ ] 补齐使用文档、README、可复现实例、隐私边界与失败案例；
- [ ] 核心 CLI 工作流稳定后，才评估是否恢复 Web/桌面开发。

**验收**：公开合成任务可让第三方复现，评测不依赖未发表私人项目。

## 8. 第一批开发任务（建议编号，不是已创建的 GitHub Issues）

| 优先级 | 编号 | 待办 | 产出 |
| --- | --- | --- | --- |
| P0 | AX-01 | 跑通现有仓库与 Pi SDK | 确认真实调用/版本 |
| P0 | AX-02 | 构建 Tiny PyTorch Task + 判题器 | CPU 可重复的任务环境 |
| P0 | AX-03 | 工具执行与代码修改 | 真实工具轨迹与 Diff |
| P0 | AX-04 | L0/L1 训练链 | 运行日志与自动验收 |
| P0 | AX-05 | TaskSpec 与 Budget Controller | 强制规则、明确停止 |
| P0 | AX-06 | L2 小实验 + Evaluate + Report | 新 MVP 端到端完成 |
| P1 | AX-07 | Ablate / Reproduce 任务适配 | 复用同一个 Loop |
| P1 | AX-08 | 低成本 T1/T2 对照评测 | 真实开销和质量数据 |
| P2 | AX-09 | GPU Runner / 审批 / 恢复 | 稳定远程训练 |

## 9. 推荐本地评估顺序

1. **先用已有仓库回归当前代码**，不要先大范围重构。
2. 明确第一个 Tiny Task 的输入、固定模型、允许修改范围、评价脚本和 CPU 预算。
3. 选择 Pi Extension 或 SDK 集成路径，验证工具能真实执行。
4. 先只跑**一轮**真实模型修改与训练；证明评估闭环后再加多轮优化。
5. 评估实际 Token/时间/GPU 成本，决定下一步架构拆分和远程执行计划。

### 可以直接运行的现有命令

~~~bash
git clone --recurse-submodules https://github.com/luming9494/AXIOM.git
cd AXIOM
npm ci
npm run build
npm test

# 先创建私有输出目录；输出文件必须不存在
mkdir private
npm run axiom -- import examples/synthetic-experiment/manifest.json private/registry.json
npm run axiom -- export examples/synthetic-experiment/manifest.json private/comparison.md markdown

# 需要在本地 .env 中有合法模型密钥；真实模型调用尚未核验
npm run axiom -- ask examples/synthetic-experiment/manifest.json "比较这两次示例实验"
~~~

以上是**现有命令**。`axiom optimize / axiom reproduce / axiom ablate` 均为未来目标，不得当作已实现的 CLI 命令。

## 10. DoD：什么才叫真正完成 AXIOM 第一个 MVP？

- Agent 真实调用工具、读代码并产生有效修改；
- 训练和评估真实发生，不靠伪造/模拟的日志宣称性能提升；
- 预算规则能强制执行、越权操作会被阻止；
- 有独立判题器确认最终模型与任务指标；
- 能解释每一轮选择，保留可追溯产物；
- 即使没有提高成绩，依然能按 `best_effort` 正确停止。

**核心方向：先做出一个在有限预算内能自主完成小型 ML 工程任务的 AXIOM，然后再扩展论文复现、消融和远程 GPU。**
