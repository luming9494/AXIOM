# 模型供应商：默认 DeepSeek 官方，NIM 可选

按用户最新决定，所有入口默认 `deepseek`，直接使用官方 Key，按量计费；不会先尝试 NIM，也不会因官方请求失败而自动切换到 NIM。此后文档中的“NIM → 官方备用”仅在显式选用 NIM 时生效。

NIM 的普通对话已连通，但真实工具验收约60秒失败，第二次尝试被用户中止，未完成真实 Agent 工作流。失败证据在本地 `private/nim-tool-yTHXoq/`，另一次尝试在 `private/nim-tool-HbwKie/`；不能把这些当作通过记录。

## 配置

只在本地 `.env` 填 Key，不提交凭据，不覆盖已有本地配置：

```dotenv
AXIOM_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
AXIOM_MODEL_TIMEOUT_SECONDS=120

# 以下仅在显式设 AXIOM_MODEL_PROVIDER=nvidia-nim 时使用
NVIDIA_API_KEY=
NVIDIA_NIM_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_NIM_MODEL=deepseek-ai/deepseek-v4.1-flash

AXIOM_DEEPSEEK_FALLBACK=true
```

选择 NIM 时仍保留用户之前授权的“免费额度用完再使用官方”。该可选模式的备用开关默认 true，但必须配置官方 Key 才能调用付费接口。设 false 可禁用。之前本地保存的官方 Key 现在可重新作为备用使用；代码不会改写 `.env` 或输出两把 Key。

主接口是 OpenAI-compatible Chat Completions，Pi 通过 `openai-completions` 处理文本、流式工具调用和 usage；官方接口复用锁定 SDK 的内置 DeepSeek 模型注册。`@earendil-works/pi-ai@1.5.0` 现在声明为直接依赖，用于转发 SDK 原有流事件，不实现新的模型协议或 Agent Loop。

## 回退条件（保守识别）

必须同时满足：

1. 当前供应商为 NVIDIA NIM，返回 error，错误中有 HTTP 402/429。
2. 错误明确包含 `insufficient_quota`、credits/quota exhausted 等额度/积分耗尽含义。
3. 没有文本、思考或工具调用内容，SDK 也没有报告已生成的 Token。
4. 没有取消；用户启用备用并已配置官方 Key。
5. 官方模型存在于锁定 SDK；新的请求仍通过原有预算门禁。

普通 `429 Too Many Requests`、RPM/TPM 临时限流、401/403 认证/授权、超时、网络/服务故障、内容过滤、上下文错误以及生成到一半的失败，都不会自动切换付费接口。无法确定错误含义时宁可停止；未知 NIM 额度错误需拿脱敏错误另行确认，不能靠猜测启用付费。

## 执行与预算

- 各入口使用同一回退器，安装在已有请求/预算检查器外层，因此主接口和备用各占一次请求准入。
- NIM 明确拒绝且没有生成内容时，不向 Agent 转发其失败消息/工具；只把同一个决策上下文交给官方模型。不会重放任何工具、Smoke 或已完成训练。
- 当前任务一旦切换，就保持官方路线，避免每轮重复撞已耗尽的 NIM；新建任务仍先尝试 NIM。
- WP-04 在规划与各轮之间共享路线。TaskSpec 显示备用是否开启、是否配置、官方模型及付费标记；批准时检查政策未改变，变化后需重新规划审核。
- 对明确额度拒绝，不虚构“实际 Token=0”：把 NIM 完整请求预留保守计入账本，再为官方请求预留。剩余 Token/墙钟/请求次数不够时不调用官方。
- 其他 usage 不明仍按既有策略停止；官方请求取消/失败时也保守记账。不承诺供应商绝对计费上限。
- 官方失败不由回退器重试，也不切回 NIM。各模型入口禁用自动服务重试。
- 记录 `provider_fallback`、付费标记、官方选择及实际请求的 provider/model；会话说明仍可能显示初始配置，实际供应商以消息和事件为准。
- 脱敏覆盖两把 Key；执行子进程继续使用最小环境，不继承任何供应商密钥。

## 验证状态

- 真实 NIM 普通对话：HTTP 200，返回 `AXIOM_OK`，约59.5秒，59 Token。另一次请求在60秒处超时；该超时不能被当作免费额度耗尽。
- 真实 NIM Function Calling / 真实额度耗尽 / 官方付费回退：本轮没有联网验证，未故意耗尽免费额度或产生备用费用。
- 离线模拟通过真实 Pi SDK 验证：额度拒绝后两次请求分别携带正确 Key，后续决策沿用官方；两次尝试都走预算，备用额度不足时官方 HTTP 请求为零；临时限流/禁用备用不付费；官方503不重试。
- 成功的 NIM 仍可走原有流式工具链。SDK 为 NIM 配置的零费率只是开发端点占位，不是账单确认；官方成本仍以供应商账单为准。

单请求超时默认120秒，可用 `AXIOM_MODEL_TIMEOUT_SECONDS` 在5–180秒间配置；WP-04 决策阶段最多两次请求且继续受任务剩余墙钟限制。底层错误信息会脱敏写入事件，不能因为超时就改用其他供应商。

修改前已生成的 TaskSpec 可能缺少备用政策字段，不再直接批准；重新生成并审核，避免沿用一份未披露付费备用的计划。
