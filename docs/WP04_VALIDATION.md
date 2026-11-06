# WP-04：自然语言任务、有限多轮与确定性预算

## 当前结论

已用真实 Pi SDK + DeepSeek 完成：**自然语言 → 可审核 TaskSpec → 显式批准 → Baseline → 三轮候选训练/独立验证 → 实验预算耗尽自动停止 → 交付历史最佳模型与报告**。

本阶段支持的是可信公开 Tiny Task 适配器，不是任意当前目录的通用 ML 项目优化。没有新增 GPU 调度、任意 Shell、依赖安装或 OS 沙箱，也不宣称最终测试达标。

## 1. 使用入口

在交互终端打开：

```bash
npm run axiom
```

输入自然语言任务，AXIOM 使用模型生成 TaskSpec，显示目标、规则、预算与文件 SHA-256。审核后输入 `yes` 才授权执行；取消则只保存规格，不训练。这是简单文本入口，非新建 Pi TUI；本轮自动化实测使用下面的两阶段 CLI，而非人工终端 UI 验收。

```bash
# 规划调用模型，会产生 API 费用，但不会训练
npm run axiom -- task "帮我优化当前 Tiny Task，最多三组候选，禁止预训练，验证准确率达到95%就停止，交付最佳模型和报告"

# 审核生成文件；路径和哈希以本机输出为准
npm run axiom -- task --approve private/wp04-XXXXXX/task-spec.json --sha256 <审核哈希> --allow-reviewed-code
```

- 只接受 Tiny Task、`model.py` 编辑、只读配置和 validation 反馈。
- 不支持的目标/规则不能通过改变可信策略来实现；必须人工检查自然语言翻译是否正确。模型翻译不是语义正确性的数学保证。
- 用户未指定的预算才采用默认值；不会因为想凑轮数而忽略达标停止。
- 批准时重算文件哈希并校验基线/配置未变化；`approval.lock` 防止同一计划被重复或并发启动。修改规格必须重新审核哈希。
- 锁定后不提供自动崩溃恢复或跨任务缓存，不能把删除锁后的重跑当作断点续跑。

环境沿用 WP-03：Node.js >=22.19.0、Pi SDK 1.5.0、CPU PyTorch、`.venv` 或 `AXIOM_PYTHON`、本地 `DEEPSEEK_API_KEY`。密钥不进入前端、模型上下文或训练环境。

## 2. 确定性控制，不让 LLM 掌握训练按钮

```text
模型：自然语言 → submit_task_spec
用户：审核并批准哈希
Controller：检查预算 → 真实 Baseline → 判断目标/预算
模型：根据历史指标与最佳代码 → propose_candidate(content, rationale)
Pi 会话结束并释放
执行器：AST 审查 → 去重 → 预留额度 → Smoke + Full → 新进程独立 validation
Controller：严格提升才更新 best → 判断停止或请求下一轮决策
结束：校验历史最佳证据和哈希 → 复制模型/权重 → 确定性报告
```

`submit_task_spec` 不能启动训练；`propose_candidate` 不能改规则、调用 Shell 或执行实验。每个决策使用 Pi 原有 SDK 模型/工具循环，提交有效方案后由宿主停止该会话。任务 Controller 是领域流程编排，不重新实现 Pi Agent Loop。

- `max_experiments` 限制候选训练任务的尝试次数；失败也消耗额度，不自动重试。
- Baseline 单独计数，但消耗同一任务的时间、计算和训练步数额度。
- 每轮独立评估只有 validation；没有 final-test 或 reference 读取能力。
- `best` 从 Baseline 开始，只按真实完整训练的验证 accuracy 严格提高；持平/下降不覆盖先前最佳。
- 成功结果按规范化的模型表达式 AST、固定配置、协议、解释器及可信输入指纹进行任务内缓存。注释/文档字符串/格式变化不会触发重新训练；不声称证明任意 Python 程序的语义等价。
- 缓存命中保留一条历史记录，但不增加训练次数。重复建议过多也会确定性停止，避免无效模型调用循环。
- 每轮后更新 `experiments.json`；失败、取消、预算耗尽时保留已知最佳，若没有合法模型则如实不生成权重。

## 3. 预算口径与实际边界

| 预算 | 实现 |
| --- | --- |
| 候选次数 | 1–3 次；宿主启动前检查并预留；LLM 无法绕过 |
| 墙钟 | 从批准进入执行起计，包含 Baseline、模型决策、训练、评估；deadline 取消请求并终止子进程 |
| Token | 包含规划实际 usage；每次决策请求前检查并预留上下文 UTF-8 字节数 + 8192 framing 余量 + 2048 输出上限，完成后按 SDK usage 结算 |
| usage 不明 | 未完成/缺失 usage 的请求按预留计账并停止；实际超预留也停止后续请求，不假填 0 |
| 计算时间 | 累加受控 Python 子进程 elapsed，包含初始化/审查/训练/评估；每次启动按剩余额度设置 timeout |
| 训练步数 | 默认 Baseline 80，候选每次预留 2 Smoke + 80 Full；失败不退款 |
| 资源类型 | 仅 CPU，Torch/BLAS 单线程设置，串行执行，无 GPU 入口 |

重要限制：

- Token 是保守请求准入与 usage 账本，不是供应商付费绝对硬上限；没有供应商 tokenizer/计费强制接口，不能承诺请求后永不超估算。
- 规划发生在规格批准前，使用单独有上限的规划调用；其 Token 并入执行账本，但规划与人工审核等待时间不算执行墙钟。
- 累计子进程 elapsed 是保守计算包络，不是精确 CPU-seconds；没有 OS 内存、CPU affinity 或 GPU 隔离配额。
- timeout 后仍需等待进程树退出/清理，因此账本可能包含少量终止开销；不会在耗尽后新增训练或模型请求。
- 停止后的交付只校验并复制已独立评估的模型，不再调用 LLM 或启动训练/评估。文件 I/O/清理不保证瞬时完成。
- 初始化失败、机器断电等不保证完整交付；无经过验证的模型时不会伪造 `best_model.pt`。

## 4. 真实端到端验收

本机目录：`private/wp04-BRbiK2/`。

实际自然语言明确要求：最多三组候选、不用预训练/额外数据/网络、只比较独立验证集；**本次为了验收多轮控制，不设提前停止准确率目标**；墙钟 600 秒、Token 100000、累计子进程 300 秒、训练步数 326。

Pi 生成的 TaskSpec 正确保留这些规则，审核后批准执行。没有人为指定候选结构。

| 实验 | 模型 | 独立验证 accuracy | 当轮之后的最佳 |
| --- | --- | --- | --- |
| Baseline | Linear(2,2) | 0.5 | baseline |
| exp-1 | 2→8 Tanh→2 | 0.998046875 | exp-1 |
| exp-2 | 2→6 ReLU→6 Tanh→2 | 0.998046875 | exp-1 |
| exp-3 | 2→4 Tanh→4 Tanh→2 | 0.998046875 | exp-1 |

- 自动停止：`budget_exhausted / experiment_budget_exhausted`，没有第 4 个候选请求。
- 真实训练任务 4 个：Baseline + 3 个候选；三个候选内部各有一次 Smoke。
- 4 次新进程独立 validation，无最终测试或 split 覆盖参数。
- 总共 4 次真实模型请求：规划 1 次 + 候选决策 3 次；执行账本 `model_requests=3` 只计批准后的决策，Token 合并了规划 usage。
- Token 合计 7717；累计子进程 112.494 秒；执行墙钟约 129.8 秒；训练步数预留 326。
- SDK 合计估算 USD 0.003043692，不是实付账单核对。
- 对比模型请求时间戳与 worker 起止事件，没有训练期间模型请求或轮询。
- 交付 `best_model.pt` 的 SHA-256 与 `runs/exp-1/checkpoint.pt` 一致，另行在新 Python 进程重算 `best/`，准确率仍为 0.998046875。这个额外验收检查不属于已结束任务的预算消耗。
- 原始项目与 Pi 上游未修改；本次本地运行文件扫描未发现配置的 API Key 实际值。

三轮是持平，不是每轮持续升高；模型关于容量、收敛、参数数量的解释可能有误，原话作为方案假设保留。事实以审查输出、`run.json` 和独立验证为准。单种子/单切分不证明统计显著性。

## 5. 反例回归：不能冒充真实 Agent 成绩

### 默认 Node 单测（无训练、无 API）

当前默认 28 项 Node 回归全部通过，包括 TaskSpec 拒绝放宽策略、预算范围、请求前 Token 拒绝（实际 Pi 会话、拦截所有 fetch 并断言网络调用为零）、usage 不明、墙钟/训练步数/计算/次数耗尽、三轮后停止、退化/持平保留最佳、达标后不再调用模型、失败计费/无重试、训练期间不调用模型，以及缓存复用。

### 显式真实 CPU 集成（无 LLM）

```bash
npm run test:task-executor
```

本次 4 项通过：

1. 人工给执行器一个合法小网络，再给它仅注释变化的重复结构，最后给一个更差的线性候选。重复不重训；第二个真实候选独立分数从 0.998046875 降到 0.5，交付仍是第一个最佳模型，输出权重哈希一致。
2. 把验证目标设为低于真实 Baseline 的值；Baseline 达标后立即停止，零候选、零模型请求。
3. 仅给 1 秒累计子进程额度，实际终止未完成 worker，状态为计算预算耗尽；没有完整 Baseline 就不生成伪造权重。
4. 给 10 秒执行墙钟，实际 deadline 终止执行或等待中的决策，停止原因为墙钟预算耗尽，不增加候选。等待决策分支使用无 LLM 的可取消等待，不浪费 API。

这四项是执行器故障/反例验证，不是 Agent 自主设计出的第二组端到端成绩。候选达标后的停止、失败后的保留等另有控制器单测。审批哈希不匹配与重复批准也已实测在执行前被拒绝。

## 6. 交付与复算

```text
private/wp04-*/
  task-spec.json         自然语言、规格、规划 usage、输入哈希与审核说明
  approval.lock          一次性批准记录
  trusted-inputs.json    受保护输入指纹
  sources/               每次方案原文、审查结果和 Diff
  runs/                  Baseline/候选/Smoke 的真实 Checkpoint 与记录
  best_model.pt          历史最佳 state_dict
  model.py / config.json 与该权重匹配的源码和配置
  best/                  最佳 Run 的完整可重算快照
  experiments.json       真实历史、状态、最佳、预算和停止原因
  summary.json           确定性交付摘要
  report.md              确定性分析报告，模型理由不是已验证事实
  pi-events.jsonl        规划/候选调用及 usage
  events.jsonl           执行器与 Controller 事件
  commands/              固定 argv、timeout、退出与输出
```

`best_model.pt` 不是 pickle 整模型，需结合交付的 `model.py` / `config.json` 加载 state_dict。完整指标复算：

```bash
python examples/tiny-ml-eval/validate_only.py --run private/wp04-XXXXXX/best
```

运行产物、权重和密钥均保持 Git 忽略。后续 WP-05 再完善更全面的取消/恢复/故障交付评测与完整任务状态，不因本次 Tiny Task 通过就宣称通用自主 ML 工程已经完成。
