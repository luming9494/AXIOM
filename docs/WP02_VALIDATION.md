# WP-02：Pi Agent 真实操作 ML 项目验证记录

> 2026-11-05 · 已实测，不是设计概念或模拟工具输出。  
> 范围：可信 Tiny Task 的读代码、受限修改、真实 Smoke、读取结果与权限边界。  
> **结论：该范围内 WP-02 通过；自主优化、正式模型效果与多轮预算均未完成。**

## 1. 用户任务与验收

给模型的任务是：阅读小型分类项目，将线性模型替换为小型 MLP，运行 Smoke，解释真实结果并展示 Diff 与产物。

同时要求模型通过相同工具接口发起两项无破坏探测：

- 写入 `../outside-sentinel.txt`，应被文件白名单拒绝；
- 以 `python -c "print(123)"` 作为执行动作，应被固定动作白名单拒绝。

不是开发助手在外面手动替模型修改文件，再让它总结；实际修改内容来自 DeepSeek 返回的 Pi Tool Call 参数。

## 2. 实际采用的 Pi 接入方式

- npm SDK：`@earendil-works/pi-coding-agent@1.5.0`。
- 模型：官方 `deepseek/deepseek-flash`，使用已有本地凭据。
- 使用 `createAgentSession({ customTools, tools, resourceLoader, ... })`；运行前断言工具列表恰好等于五个授权工具。
- 不开放内置 Bash、Write、Read、Edit，也不加载工作区/全局 Extensions、Skills、MCP 或上下文脚本。
- 自定义工具通过 SDK 的正式工具注册与校验路径执行，具有真实 `tool_execution_start/end` 事件。
- 使用显式资源加载与内存会话，关闭自动重试、Compaction 和缓存保温；没有替换 Agent Loop。
- 先选 SDK 而非交互 TUI，是为了本轮可重跑命令与确定性事件验收，不是发现 Pi TUI 不可用。原生 TUI/Extension 加载尚未作为本轮验收项。

已对照 vendor 子模块与安装 SDK 的 `tools/customTools` 和 `executionMode` 接口；本次使用的字段均存在。没有修改 `vendor/pi`。

## 3. 工具与执行边界

| 工具 | 行为 |
| --- | --- |
| `read_candidate_file` | 只读候选副本的 `model.py` / `config.json`，返回内容和真实 SHA-256 |
| `edit_candidate_file` | 只写 `model.py`，要求最近读取的文件哈希匹配，返回真实 Diff |
| `run_checks` | 只接受 `l0` / `smoke`，不接收任意 Shell、脚本路径或额外 argv |
| `read_smoke_result` | 新进程重载 Checkpoint、重算验证指标并返回真实训练范围 |
| `show_diff` | 展示相对原始 Baseline 的持久化 Diff |

- 候选在 `private/wp02-*/candidate/`；原始项目、配置、任务和评估器有哈希保护，运行后检查未变化。
- 精确文件名白名单，拒绝路径穿越、绝对路径、大小写别名、ADS 样式路径、符号/硬链接别名及非普通文件。
- 工具操作串行化；读取后的文件版本不一致则拒绝编辑。
- 执行前解析 AST，不导入候选。仅允许 `from torch import nn` 和单一 `build_model()` 返回简单 Linear/Sequential，层限定 Linear/ReLU/Tanh、字面量维度和参数上限。拒绝其他导入、语句、动态调用、类和装饰器。
- 子进程采用明确 argv、`shell: false`、最小环境，不继承模型密钥、PYTHONPATH 或代理变量。
- 保存每条固定命令的 stdout、stderr 和退出状态，限制输出和时长。

**这些是针对本次 Tiny Task 的窄策略，不是任意 Python 的 OS 安全沙箱。** 不支持陌生仓库或通用网络/文件访问隔离。

## 4. 两次真实运行结果

| 项目 | 首次运行 | 最新验收运行 |
| --- | --- | --- |
| 本机目录 | `private/wp02-GBEshm/` | `private/wp02-VJXk7N/` |
| 模型生成结构 | 2 → 16 → 16 → 2，Tanh | 2 → 8 → 2，Tanh |
| 参数量 | 354 | 42 |
| 模型请求次数 | 8 | 7 |
| Pi 工具调用 | 9（含 2 次预期拒绝） | 9（含 2 次预期拒绝） |
| Smoke | 16 样本，2 步更新，通过 | 16 样本，2 步更新，通过 |
| 验证准确率 | 0.501953125 | 0.3828125 |
| 验证 Loss | 0.7149826884 | 0.7509700656 |
| 端到端墙钟 | 53.569 秒 | 43.180 秒 |
| SDK 记录总 Token（含缓存口径） | 18,327 | 15,078 |
| SDK 估计费用 | USD 0.002930544 | USD 0.002285316 |
| 越界写入 / 非法动作 | 均拒绝 | 均拒绝 |
| 原始项目与保护文件 | 未变化 | 未变化 |

Token 与费用按 SDK 返回 usage 汇总；费用字段 `totalFromProvider: false`，**不是账单核对或准确实付承诺**。两次运行是开发验证，不是统计成功率或效果基准。

Smoke 的验证准确率不能用来宣称模型改进。本轮没有正式 Full 训练，没有调用最终测试集，也没有完成自主优化。

## 5. 最新运行的真实调用顺序

```text
read_candidate_file(model.py)          完成
read_candidate_file(config.json)       完成
edit_candidate_file(model.py)          完成：模型自行给出 42 参数 MLP
edit_candidate_file(../outside-...)    拒绝：文件不在白名单
run_checks(python -c "print(123)")     拒绝：动作不在白名单
run_checks(l0)                        完成
run_checks(smoke)                     完成：真实训练、保存和独立评估
read_smoke_result                     完成：再次独立重载/重算
show_diff                             完成
```

最新模型实际改动：

```diff
 def build_model():
-    return nn.Linear(2, 2)
+    return nn.Sequential(
+        nn.Linear(2, 8),
+        nn.Tanh(),
+        nn.Linear(8, 2),
+    )
```

`summary.json` 中八个验收项全部为 true：读取、MLP 修改、Smoke 执行、结果读取、Diff 查看、有序调用链、越界写拒绝、非法动作拒绝；原始与保护文件检查也通过。

## 6. 如何重跑与检查

```bash
npm run build
npm test
# 使用有 CPU PyTorch 的 Python 环境
npm run test:ml

# 以下才会实际调用模型 API，产生费用，并执行受窄策略约束的模型代码
npm run axiom -- smoke-agent --allow-reviewed-code
```

前提：Node.js ≥22.19、本地 `.env` 的 `DEEPSEEK_API_KEY`、默认 `.venv` Python。可用 `DEEPSEEK_MODEL` 选择 SDK 支持的官方 DeepSeek 模型；`AXIOM_PYTHON` 可显式指定 Python 解释器。

每次创建新的 `private/wp02-*`，不会覆盖已有运行。命令失败时返回非零退出码并保留失败轨迹，不能把未完成验收当作通过。

运行目录：

```text
candidate/model.py            模型真正编辑的文件
candidate/config.json         只读配置副本
before/                       原始输入快照
patch.diff                    根目录中的真实差异
pi-events.jsonl               Pi 事件：调用参数、工具结果、ID、模型最终消息与 usage
operations.jsonl              工具层执行/拒绝记录（区分 model/test 来源）
commands/                     每条命令的 argv、退出状态、stdout、stderr
smoke/checkpoint.pt           真实权重
smoke/history.json            两步真实 Loss
smoke/run.json                训练范围和版本/哈希
smoke/validation.json         独立评估结果
assistant.md                  模型原始解释，非事实权威
summary.json                  程序生成的验收项与结果索引
report.md                     最新实现生成的确定性人类可读报告
```

首次运行早于 `report.md` 功能加入，仍保留原始证据；最新运行包含完整确定性报告。运行产物、权重、凭据不提交 Git；公开文档只记录可公开合成任务的结果。

## 7. 发现的问题与已知限制

1. **模型自然语言中仍会写错路径**：两次都出现把根目录 `patch.diff` 或 `smoke/checkpoint.pt` 错写到 `candidate/` 下的情况。保留原始回复，不静默美化。已加入程序生成的 report/summary，产物路径以真实文件索引为准。
2. WP-02 的网络错误、空正文和中止有代码处理；本轮真实 API 运行只验证了成功路径及工具层预期错误，不能声称覆盖了所有供应商超时/故障。
3. 本机离线测试包括进程超时、终止、输出上限、过期编辑、配置保护、链接别名和 AST 拒绝；不是对所有 OS/恶意代码的安全证明。
4. 固定的调用次数、180 秒 deadline、单次输出上限和一次 Smoke 只作防失控保护，**不等于 WP-04 的跨实验预算控制**。
5. 当前任务指令明确要求 MLP；模型没有自主决定改进方向，也没有用正式训练结果做保留/回退。

## 8. 下一阶段

- **WP-03**：让模型在规则内自主选择一次改动，真实训练并与 Baseline 比较，完成保留/回退与交付。
- **WP-04**：多轮候选、任务级预算、资源与 Token 记账、停止策略。

不把本次 Smoke 通过包装成完整 Optimize MVP 已完成。
