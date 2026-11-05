# Tiny XOR Optimize：第一个真实训练任务

这是 WP-01 的**离线任务与独立评估基座**，不是 Agent 自动优化演示。无需 LLM、GPU、外部数据集或模型权重。

## 任务与规则

- 协议：`tiny-xor-v1`，规则位于 `../tiny-ml-eval/task.json`。
- 四个二维高斯簇组成非线性二分类；train / validation / final-test 分别使用独立固定种子。
- 数据量：1024 / 512 / 512，类别平衡；运行时生成，不联网下载。
- Baseline：`model.py` 中的线性分类器，6 个参数。
- 允许候选修改：`model.py` 与 `config.json`；模型输出必须是 `[batch, 2]` logits，参数不超过 1024。
- 配置仅允许 epochs（1–120）、learning_rate（0.0001–0.1）、seed；任务与评估器不能作为候选修改。
- 正式目标：`full` 协议训练后，独立 final-test accuracy ≥ 0.95。
- 禁止额外数据、预训练权重、测试集调参、修改评估器、运行中安装依赖或联网。

此处 `full` 是**完整 Tiny Task 协议**，并不代表真实课程/论文的大规模实验。Proxy 的成绩不能替代正式成绩。目标阈值是在公开校准后固定的教学任务条件，不是任何真实业务的效果保证。

## 环境

建议 Python 3.11、CPU PyTorch 2.2.0。新环境示例：

```bash
# 在仓库根目录执行；已有 .venv 时不要覆盖
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# Linux / macOS：source .venv/bin/activate
python -m pip install -r examples/tiny-ml-eval/requirements-cpu.txt --index-url https://download.pytorch.org/whl/cpu
```

依赖安装需要网络；训练与评估不需要。`requirements-cpu.txt` 固定核心 PyTorch 版本，不是全依赖锁文件。

本次本机验证使用 Python 3.11.9 / torch 2.2.0+cpu。为了不下载或修改全局依赖，本地 `.venv` 使用 `uv venv --system-site-packages` 创建，复用了既有 Torch；**这不是依赖完全隔离的全新安装验证**。若不激活环境，可将以下 `python` 换成 `.venv/Scripts/python.exe`。

## 运行 L0 和 L1

所有输出目录/JSON 文件必须是新路径，已有文件不会被覆盖。

```bash
python examples/tiny-ml-eval/checks.py --candidate examples/tiny-ml-task
python examples/tiny-ml-eval/train.py --candidate examples/tiny-ml-task --output private/tiny-demo/smoke --level smoke
python examples/tiny-ml-eval/evaluate.py --run private/tiny-demo/smoke --output private/tiny-demo/smoke/validation.json
```

L0 检查配置、模型构造、参数量与输出 Shape；L1 使用 16 个样本、2 次梯度更新，并保存真实 Checkpoint。两者均不能证明正式模型成绩。

## 运行完整 Baseline

```bash
python examples/tiny-ml-eval/train.py --candidate examples/tiny-ml-task --output private/tiny-demo/baseline --level full
python examples/tiny-ml-eval/evaluate.py --run private/tiny-demo/baseline --output private/tiny-demo/baseline/validation.json
```

每次 Run 包括：

```text
candidate/model.py       # 当次候选源文件快照
candidate/config.json
checkpoint.pt            # CPU state_dict，不保存整个 Python 对象
history.json             # 每个 epoch 的真实训练 Loss
run.json                 # 配置、实际训练范围、版本、哈希与墙钟耗时
validation.json          # 独立评估后生成，不由 train.py 自报
```

评估器在新进程中实例化快照模型，以 `weights_only=True` 加载权重并重算指标；不读取或相信已有 `metrics.json`。源快照、权重、任务/评估代码或 Torch 版本变化时拒绝静默复用。哈希只能检测与元数据不一致的变化，不是防恶意篡改的数字签名。

## 人工合法参考改动

`tests/fixtures/tiny-ml-reference/` 是人工编写的 82 参数 MLP，用于证明任务可改善，**不是 Agent 生成的候选，也不是未来 Agent 的默认输入**。训练配置与 Baseline 相同。

```bash
python examples/tiny-ml-eval/train.py --candidate tests/fixtures/tiny-ml-reference --output private/tiny-demo/reference --level full
python examples/tiny-ml-eval/evaluate.py --run private/tiny-demo/reference --output private/tiny-demo/reference/validation.json
```

只根据 validation 选择候选。确定最终候选、停止优化后，才调用独立判题：

```bash
python examples/tiny-ml-eval/judge.py --run private/tiny-demo/reference --output private/tiny-demo/reference/judgment.json
```

判题报告包含 `metric_status: target_met | best_effort` 和真实最终指标。`compliance_status` 固定为 `not_fully_verified`：当前只判定模型可加载与客观指标，**不代表已检查所有规则和预算**。Smoke/Proxy 不能进入正式 final-test 判题。

当前 final-test 数据是公开生成的，不是攻击者不可访问的隐藏测试；脚本也尚未实现最终测试只准调用一次的门禁。独立评估用于可信样例，后续接 Agent 时需由 Controller 隔离最终反馈并限制访问。

## 本机实测校准（2026-11-05）

使用默认 seed 42、80 epochs（Smoke 为 2 epochs）：

| 候选 | 验证准确率 | 最终测试准确率 | 训练进程墙钟耗时 |
| --- | --- | --- | --- |
| Baseline Smoke | 45.5078% | 不允许正式判题 | 约 10.86 秒 |
| 线性 Baseline full | 50.0000% | 此次校准未测 | 约 10.61 秒 |
| 人工 MLP full | 99.8047% | 99.8047% | 约 10.54 秒 |

这是该机器上的单次校准，不是 Agent 成功率或通用性能指标。训练进程时间包括 Python/Torch 启动；`run.json.wall_seconds` 从训练函数入口计时，不包含 Python 导入；两者不能当作精确 CPU 时间。首次优化器初始化开销明显，不能拿热进程训练耗时冒充完整命令耗时。

本次完整校准产物位于本机被忽略的 `private/tiny-task-wp01-v1/`，包含独立验证结果、参考模型判题和 `calibration.json`。早期开发产物可能因评估代码更新而校验失败，应另建 Run 重跑，不能修改旧哈希来绕过检查。

## 测试

```bash
# 激活 Python 环境后执行
npm run test:ml
# 或
python -m unittest discover -s tests/python -v
```

覆盖真实训练、模型重载、确定性、数据切分、配置拒绝、指标独立重算、源文件/权重变更、输出防覆盖以及 Proxy/Smoke 的正式成绩限制。测试只在临时目录写入产物，不调用 LLM。

## 当前限制与下一步

- 还没有 Agent 工具调用、候选自动修改、Experiment Controller 或跨实验优化。
- JSON 中的候选数/墙钟预算是下一阶段的控制器约定，当前脚本**不执行预算门禁**。
- 文件白名单只约束未来编辑入口；执行 `model.py` 仍是任意 Python 执行，**不是沙箱**。
- 不要对未知候选执行这些脚本，不要在带敏感凭据的环境中运行不可信代码。
- 未实现自动进程树取消、独立 Runner、远程 GPU 或故障恢复。
- 本任务只提供可信公开代码的训练/判题基础；下一步是 WP-02 的真实 Pi 工具接入验证。
