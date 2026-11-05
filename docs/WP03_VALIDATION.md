# WP-03：单候选自主优化验证记录

> 2026-11-05 · 真实运行记录，不是人工参考模型成绩。
> 范围：一个由 Agent 提出的候选、一次完整候选训练、独立验证与保留/回退。
> **结论：首次真实运行通过流程验收，并观察到验证集提升；不代表最终测试达标、统计显著性或完整多轮 Optimize 已实现。**

## 1. 进入本阶段前的 Git 基线

- WP-01：`a5dfec9 feat:WP-01（机器学习任务环境与独立评测器）`。
- WP-02：`fcda0a7 feat(agent): 完成 WP-02 真实模型编辑与受限 Smoke 验收`。
- WP-02 使用明确文件列表单独提交。提交前扫描暂存区，确认没有 `private/`、虚拟环境、权重、`.env`、凭据文件或已配置 API Key 的实际值。
- 本文记录的 WP-03 代码与上述历史提交分开，不把运行日志/权重加入版本管理。

## 2. 用户给 Agent 的任务

> 请在任务规则内，尝试提高这个小型分类项目相对于线性 Baseline 的验证准确率。先检查规则、代码和真实基线，自行提出且只执行一个候选改动，进行必要自检、训练与独立验证。根据真实验证指标决定保留还是回退。如果没有提升或候选失败，就如实保留 Baseline；不要进行第二轮尝试，也不要读取最终测试集或人工参考答案。

任务没有要求“必须改成 MLP”，也没有给隐藏层宽度、层数或激活函数的参考答案。为延续 WP-02 的安全边界，只允许简单 Linear/Sequential 语法与 Linear/ReLU/Tanh 层；**这是受限候选空间，不是任意 PyTorch 项目优化能力**。

本阶段只允许编辑 `model.py`，配置固定为 epochs=80、learning_rate=0.03、seed=42。这是针对首个对照实验收紧的允许范围，不代表未来永远禁止配置优化。

## 3. 三项核心验收的证据

### 3.1 方案由 Agent 生成，而非读取本地参考答案

- Pi SDK 实际接入官方 `deepseek/deepseek-flash`，不是模拟模型。
- 五个原有受限工具扩展为九个单轮工具；无原生文件浏览、Shell、网络或任意读取工具。
- 读取入口仍只有候选 `model.py` / `config.json`；候选目录不包含 README、论文、人工参考实现或它们的路径。
- `inspect_task` 返回安全任务摘要，不把仓库根目录或原始任务 JSON 全量塞给模型。
- `request.txt` / `system.txt` 保存实际任务和约束，`proposal.json` 保存模型的理由、模型 Tool Call 写入的源码哈希与 Diff。
- Pi 轨迹中只有一次成功候选编辑，没有成功读取参考文件的调用，执行命令也没有引用参考目录。

这证明本次没有把本地人工参考文件直接作为答案交给 Agent，不是对模型训练知识或算法思想原创性的声明。

### 3.2 独立验证，不使用最终测试集

- Baseline 和候选都使用相同的训练配置与 `tiny-xor-v1` 数据切分。
- 正式训练使用 train 1024 样本；选择候选使用 validation 512 样本。
- 新增固定入口 `validate_only.py`，不接受 `--split` 参数。其实际数据生成调用被限制为 validation，并输出 `dataset_access_log: ["validation"]`。
- 模型保存后由新进程加载 Checkpoint、重算数值；训练是否成功与验证是否提升分开。
- Controller 不提供 judge/final-test 工具，也不允许 split、路径或命令覆盖参数。
- 本次 21 条命令记录中，没有 `judge.py`、`final-test` 或 `--split` 调用，独立评估全部经过 validation-only 入口。
- 导出 selected 后再次独立加载核验，仍然只使用 validation。

“未使用最终测试集”限定为本次 WP-03 工作流；不表示该公开数据生成器是 OS 层面不可访问的隐藏测试系统。之前 WP-01 的人工校准使用过最终测试，不进入本次 Agent 上下文。

### 3.3 用真实指标决定保留，而不是“训练成功就保留”

Controller 固定选择规则：

```text
candidate.validation_accuracy > baseline.validation_accuracy → keep
相等 / 更低 / 完整候选训练失败 → revert
```

- Agent 必须先 `get_run_result` 读取独立重评估结果。
- 再由 Agent 提出 `finalize_candidate(choice, reason)`。
- 程序重新检查真实证据；Agent 的决定与规则冲突则拒绝，不会照模型解释强行保留。
- 回退表示交付原 Baseline 到 `selected/`；不删除候选和 Diff，以保留失败证据。
- 状态使用 `validation_improved / not_improved / candidate_failed`，不使用需要最终评估的 `target_met`。

## 4. 首次真实运行结果

本机产物：`private/wp03-CGdlAh/`。

| 项目 | Baseline | Agent 唯一候选 |
| --- | --- | --- |
| 模型 | Linear(2, 2) | Linear(2,16) → Tanh → Linear(16,16) → ReLU → Linear(16,2) |
| 参数量 | 6 | 354 |
| 训练配置 | 80 epochs / lr 0.03 / seed 42 | 完全相同 |
| 训练样本 | 1024 | 1024 |
| 独立验证样本 | 512 | 512 |
| 验证 accuracy | 0.500000000 | 0.998046875 |
| 验证 loss | 0.6929060817 | 0.0040558139 |

准确率差为 `+0.498046875`，即 **+49.8046875 个百分点**。Agent 提出 keep，程序核验后产生：

```json
{
  "choice": "keep",
  "outcome": "validation_improved",
  "selected_role": "candidate",
  "selected_artifact": "selected/",
  "validation_only": true,
  "final_test_used": false
}
```

本次是 **1 次 Baseline 完整训练 + 1 次候选 Smoke + 1 次候选完整训练**；重复独立评估不是重新训练。不是“整个流程只训练一次”。

- 9 次模型请求、10 次工具调用。
- 端到端墙钟 128.186 秒，包括模型请求、Python/Torch 初始化、训练及多次独立重载。
- SDK 累计 Token 30,173（包含其缓存统计口径），SDK 估计费用 USD 0.003453984；`totalFromProvider: false`，不是实付账单核对。
- 原始项目、配置与受保护脚本未变化；扫描该次本地运行文件，未发现配置的 API Key 实际值。

只有一个种子、一次候选运行与一个验证切分；没有测最终测试效果，也没有检验统计显著性。Agent 关于“容量足够、不易过拟合”等理由只是待检验假设，不能因本次高验证准确率就视为已证明。

## 5. 实际 Pi 调用顺序

```text
inspect_task
read_candidate_file(model.py)
read_candidate_file(config.json)
run_baseline
edit_candidate_file(model.py, rationale=Agent 自己的方案理由)
run_checks(smoke)
run_candidate
get_run_result
finalize_candidate(keep, reason=真实验证指标对比)
show_diff
```

模型实际写入：

```python
from torch import nn


def build_model():
    return nn.Sequential(
        nn.Linear(2, 16),
        nn.Tanh(),
        nn.Linear(16, 16),
        nn.ReLU(),
        nn.Linear(16, 2),
    )
```

实际修改的文件还有一行模型自行改写的 docstring，完整内容以 `patch.diff` 为准。

## 6. 没有提升时是否真的会回退

验证分三层，不能混为真实 Agent 的多次成绩：

1. **离线控制器单测（模拟数值）**：覆盖提升、持平、下降、候选失败、错误保留请求、第二次编辑/训练与最终测试参数拒绝。只测试控制逻辑，不当成训练成绩。
2. **真实 CPU 执行器回归，无 LLM**：给线性模型加不影响行为的注释，实际完成 Baseline/Smoke/候选完整训练与独立验证。分数持平；程序拒绝 keep，然后接受 revert，导出的 `selected/` 是 Baseline，并成功重载验证。该测试通过，约 102 秒，不调用 API。
3. **真实 Pi Agent**：本次只进行上文的一次自主优化，观察到提升并 keep；没有为了演示失败再消耗 API 重跑，也不把 CPU 回归冒充 Agent 自主失败案例。

## 7. 命令与证据位置

```bash
npm run build
npm test
# 激活有 CPU PyTorch 的 Python 环境
npm run test:ml

# 真实 CPU 回退回归；不调用 LLM，有训练计算开销
npm run test:optimize-executor

# 显式发起真实模型单候选优化，会产生 API 费用
npm run axiom -- optimize-once --allow-reviewed-code
```

需要本地 `DEEPSEEK_API_KEY`、锁定 SDK 支持的 `DEEPSEEK_MODEL` 和 `.venv` Python（或指定 `AXIOM_PYTHON`）。真实模型入口每次新建 `private/wp03-*`，失败也保留轨迹；日常 `npm test` 不启动 Python 训练或付费模型调用。

```text
request.txt / system.txt        实际用户请求与系统约束
task-spec.json                  可信单轮规则快照
proposal.json                   Agent 生成的理由、源码哈希与 Diff
patch.diff                      唯一候选的真实改动
baseline/                       实际 Baseline 权重/训练记录/验证结果
smoke/                          候选两步训练的产物
candidate-run/                  唯一完整候选训练与独立验证
selected/                       程序选择并重载核验的交付模型
decision.json                   模型提出、程序核验的最终选择
pi-events.jsonl                 Pi 调用 ID、参数、结果与 usage
experiment-events.jsonl         Controller 状态操作（区分 model/test）
commands/                       argv、退出状态和 stdout/stderr
summary.json / report.md        程序生成的验收与产物索引
assistant.md                    模型原话，不作为事实权威
```

所有运行产物保持私有并被 Git 忽略。公开文档只记录可再分发合成任务的摘要，不提交权重、日志或密钥。

## 8. 当前边界与后续

- 没有多轮搜索、GPU 调度、MLflow 或跨实验预算系统。
- 只接受一次合法候选编辑和一次完整候选训练；静态拒绝不开放额外训练次数。
- 单轮仍有 16 次模型请求、单次 2048 输出 Token、32 次 Controller 操作、300 秒 deadline 和子进程时限等防失控约束；不是完整费用/Token 预算承诺。
- 保留 WP-02 的 AST、文件与固定命令边界，不是通用任意代码沙箱。
- 正式训练失败后的回退路径有单元测试，本轮真实故障验证是“没有提升”回退；不宣称所有环境故障均已实测。
- 下一阶段 WP-04 才引入多轮候选、明确实验预算、Token/资源记账与停止策略。
