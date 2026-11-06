import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { DEFAULT_BUDGET, REVIEW_NOTES, sha256, TASK_RULES, validateTaskSpec } from '../execution/task-spec.js';
import { TaskBudget } from '../execution/task-budget.js';
import { CpuTaskExecutor } from '../execution/task-executor.js';
import { executeTask, type Proposer } from '../execution/task-controller.js';
import { piDecision } from './task-decision.js';
import { modelCredentials, modelPricingNote, fallbackPolicy, redactModelSecrets, modelRequestTimeoutMs } from './model-provider.js';

import type { RoutingState } from './provider-fallback.js';

function credentials(repo: string) {
  if (existsSync(join(repo, '.env'))) loadEnvFile(join(repo, '.env'));
  return modelCredentials();
}
async function privateDirectory(repo: string) {
  const path = join(repo, 'private'); await mkdir(path, { recursive: true });
  const actual = await realpath(path), rel = relative(await realpath(repo), actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('private must remain within repository');
  return actual;
}
async function inputs(repo: string) {
  return { model: sha256(await readFile(join(repo, 'examples/tiny-ml-task/model.py'))), config: sha256(await readFile(join(repo, 'examples/tiny-ml-task/config.json'))) };
}
export async function planTask(repo: string, request: string) {
  const { key, modelId, provider, baseUrl } = credentials(repo);
  if (!request.trim() || request.length > 8000 || redactModelSecrets(request, [key]) !== request) throw new Error('任务为空、过长或包含凭据；不会发送给模型');
  const root = await mkdtemp(join(await privateDirectory(repo), 'wp04-'));
  const example = { version: 1, task: 'tiny-xor-v1', goal: request, target_accuracy: null, rules: TASK_RULES, budget: DEFAULT_BUDGET };
  const planningBudget = new TaskBudget(validateTaskSpec(example));
  console.log(`规划工作区：${root}\n正在使用模型将自然语言转换为可审核 TaskSpec（供应商 ${provider}，官方接口按量计费）；此阶段不会训练。`);
  const signal = AbortSignal.timeout(Math.min(modelRequestTimeoutMs() * 2, planningBudget.remainingWallMs));
  const routing: RoutingState = { usingFallback: false };
  const spec = await piDecision({ root, key, modelId, provider, kind: 'plan', budget: planningBudget, signal, routing,
    system: '你是任务规格翻译器，不执行实验。将用户目标与规则转为精确 TaskSpec，用 submit_task_spec 提交 {spec:...}。只支持公开 CPU tiny-xor-v1，禁止预训练/额外数据/网络/最终测试，配置只读。用户指定的预算/目标优先，未指定才用默认值。最多3个候选，baseline另外计入时间/计算/训练步数。不要擅自降低目标或增加轮数。百分比转为[0,1]；明确不设目标则null。不支持或矛盾的要求须解释而不是生成假方案。',
    prompt: JSON.stringify({ request, exact_spec_shape_and_defaults: example, notes: REVIEW_NOTES }),
    validate: value => validateTaskSpec(value.spec),
  });
  const envelope = { request, spec, planning: { provider, baseUrl, model: modelId, fallback_policy: fallbackPolicy(), routing, pricing_note: modelPricingNote(provider), usage: planningBudget.snapshot() }, inputs: await inputs(repo), review_notes: REVIEW_NOTES };
  const content = JSON.stringify(envelope, null, 2) + '\n';
  const path = join(root, 'task-spec.json');
  await writeFile(path, content, { flag: 'wx' });
  console.log(`\n待审核 TaskSpec：\n${content}\n文件：${path}\nSHA-256：${sha256(content)}\n尚未执行训练。`);
  return { path, hash: sha256(content), envelope };
}

export async function approveTask(repo: string, path: string, hash: string) {
  const { key, modelId, provider, baseUrl } = credentials(repo);
  const privateRoot = await privateDirectory(repo);
  const actual = await realpath(resolve(path));
  const rel = relative(privateRoot, actual);
  const stat = await lstat(resolve(path));
  if (rel.startsWith('..') || isAbsolute(rel) || !actual.endsWith('task-spec.json') || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('Approval must reference a regular private task-spec.json');
  const bytes = await readFile(actual);
  const projectFiles = await Promise.all(['model.py', 'config.json'].map(name => readFile(join(repo, 'examples/tiny-ml-task', name))));
  if ([bytes, ...projectFiles].some(value => redactModelSecrets(value.toString('utf8'), [key]) !== value.toString('utf8'))) throw new Error('任务规格或项目包含配置的凭据；不会发送给模型');
  if (sha256(bytes) !== hash) throw new Error('TaskSpec hash changed; review it again before approving');
  const envelope = JSON.parse(bytes.toString('utf8'));
  const spec = validateTaskSpec(envelope.spec);
  if (envelope.planning?.provider !== provider || envelope.planning?.baseUrl !== baseUrl || envelope.planning?.model !== modelId) throw new Error('模型供应商、端点或模型已改变，请重新生成并审核 TaskSpec');
  if (JSON.stringify(envelope.planning?.fallback_policy) !== JSON.stringify(fallbackPolicy())) throw new Error('官方付费备用配置已改变，请重新生成并审核 TaskSpec');
  const routing: RoutingState = { usingFallback: envelope.planning?.routing?.usingFallback === true };
  if (typeof envelope.request !== 'string' || JSON.stringify(envelope.inputs) !== JSON.stringify(await inputs(repo))) throw new Error('Project baseline/config changed since planning; generate a new plan');
  const planningTokens = envelope.planning?.usage?.tokens_charged;
  if (!Number.isSafeInteger(planningTokens) || planningTokens < 0 || envelope.planning?.usage?.usage_uncertain !== false) throw new Error('Planning token usage is missing/uncertain');
  const root = resolve(actual, '..');
  const python = await realpath(process.env.AXIOM_PYTHON || join(repo, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  await writeFile(join(root, 'approval.lock'), JSON.stringify({ approved_sha256: hash, pid: process.pid, timestamp: new Date().toISOString() }), { flag: 'wx' });
  const budget = new TaskBudget(spec, planningTokens);
  const executor = new CpuTaskExecutor(repo, root, python, budget);
  await executor.initialize();
  const cancelled = new AbortController();
  const onCancel = () => cancelled.abort(new Error('user_cancelled'));
  process.once('SIGINT', onCancel); process.once('SIGTERM', onCancel);
  const propose: Proposer = async (context, ledger, signal) => {
    const result = await piDecision({ root, key, modelId, provider, budget: ledger, signal, kind: 'candidate', routing,
      system: '你是自主 ML 工程 Agent。根据可信 TaskSpec、实际验证反馈与历史最佳，自行提出下一个候选，仅用 propose_candidate 提交完整 model.py 和中文 rationale。不能调用训练或改变规则，Harness 管理执行与停止。源码只允许 from torch import nn 与零参数 build_model() 单个return；返回 nn.Linear 或 nn.Sequential，层只限 Linear/ReLU/Tanh，无类/其他语句/关键字参数。维度为1..64整数字面量，输入2输出2，参数最多1024，层最多7。不要照搬已完成的结构；相同结构/配置会复用而不重训。禁止预训练、网络、额外数据、参考答案与最终测试。Smoke不是性能证据，比较用完整训练的validation准确率。不得宣称正式最终目标或统计显著性。',
      prompt: JSON.stringify({ task: context.task, config: context.config, baseline: { model: context.baseline.model, validation: context.baseline.validation }, best: { id: context.best.id, model: context.best.model, validation: context.best.validation }, history: context.history, budget: context.remaining }),
      validate: value => {
        if (Object.keys(value).sort().join() !== 'content,rationale' || typeof value.content !== 'string' || Buffer.byteLength(value.content) > 8192 || typeof value.rationale !== 'string' || !value.rationale.trim() || value.rationale.length > 2000) throw new Error('Invalid candidate decision');
        return { content: value.content, rationale: value.rationale };
      },
    });
    return result as { content: string; rationale: string };
  };
  try {
    const summary = await executeTask({ root, spec, budget, executor, propose, signal: cancelled.signal });
    console.log(`\n任务停止：${summary.status} / ${summary.stop_reason}\n报告：${join(root, 'report.md')}\n交付：${JSON.stringify(summary.delivery ?? '无有效模型')}`);
    if (summary.status === 'failed') throw new Error(`任务失败，已有证据保留于 ${root}`);
    return summary;
  } finally { process.removeListener('SIGINT', onCancel); process.removeListener('SIGTERM', onCancel); }
}
