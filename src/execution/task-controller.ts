import { appendFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BudgetStop, TaskBudget } from './task-budget.js';
import type { Evaluated, TaskExecutor } from './task-executor.js';
import { REVIEW_NOTES, type TaskSpec } from './task-spec.js';

export interface DecisionContext { task: TaskSpec; baseline: Evaluated; best: Evaluated; history: ExperimentRow[]; remaining: ReturnType<TaskBudget['snapshot']>; config: string }
export type Proposer = (context: DecisionContext, budget: TaskBudget, signal: AbortSignal) => Promise<{ content: string; rationale: string }>;
export interface ExperimentRow { id: string; status: 'evaluated' | 'cache_hit' | 'failed'; fingerprint?: string; accuracy?: number; best_id?: string; reused_from?: string; error?: string; rationale?: string }
export function chooseBest(current: Evaluated | undefined, candidate: Evaluated): Evaluated {
  const result = candidate.validation;
  if (result.split !== 'validation' || result.level !== 'full' || result.protocol !== 'tiny-xor-v1' || result.samples !== 512 || !Number.isFinite(result.accuracy) || result.accuracy < 0 || result.accuracy > 1 || !Number.isFinite(result.loss) || JSON.stringify(result.dataset_access_log) !== '["validation"]') throw new Error('Best selection requires valid independent validation evidence');
  return !current || result.accuracy > current.validation.accuracy ? candidate : current;
}

export async function executeTask(options: { root: string; spec: TaskSpec; budget: TaskBudget; executor: TaskExecutor; propose: Proposer; signal?: AbortSignal }) {
  const { root, spec, budget, executor, propose } = options;
  const rows: ExperimentRow[] = [];
  const cache = new Map<string, Evaluated>();
  let baseline: Evaluated | undefined, best: Evaluated | undefined;
  let status = 'failed', stopReason = 'not_started', failure: string | undefined;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new BudgetStop('wall_budget_exhausted')), Math.max(1, budget.remainingWallMs));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const event = (type: string, detail: unknown) => appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ type, detail, timestamp: new Date().toISOString() }) + '\n');
  const persist = async () => {
    const contents = JSON.stringify({ task: spec, status, stop_reason: stopReason, failure, baseline: baseline && { id: baseline.id, validation: baseline.validation }, best: best && { id: best.id, validation: best.validation }, experiments: rows, budget: budget.snapshot(), final_test_used: false }, null, 2);
    await writeFile(join(root, 'experiments.json.tmp'), contents);
    await rename(join(root, 'experiments.json.tmp'), join(root, 'experiments.json'));
  };
  try {
    budget.check(); signal.throwIfAborted();
    event('baseline_start', {});
    baseline = await executor.run(await executor.prepare('baseline', executor.original, 'Unchanged actual baseline', signal), true, signal);
    best = chooseBest(undefined, baseline);
    cache.set(baseline.fingerprint, baseline);
    await persist();
    for (let decision = 1; ; decision++) {
      signal.throwIfAborted();
      // Stop before another model call, not merely before training.
      if (spec.target_accuracy !== null && best.validation.accuracy >= spec.target_accuracy) { status = 'target_reached'; stopReason = 'validation_target_reached'; break; }
      budget.check();
      if (budget.experiments >= spec.budget.max_experiments) throw new BudgetStop('experiment_budget_exhausted');
      if (budget.trainingSteps + JSON.parse(executor.config).epochs + 2 > spec.budget.training_steps) throw new BudgetStop('training_step_budget_exhausted');
      if (budget.computeMs >= spec.budget.compute_process_seconds * 1000) throw new BudgetStop('compute_budget_exhausted');
      if (decision > spec.budget.max_experiments * 2) { status = 'stopped'; stopReason = 'duplicate_decision_limit'; break; }
      const id = `exp-${decision}`;
      event('decision_requested', { id, best_id: best.id });
      const proposal = await propose({ task: structuredClone(spec), baseline: structuredClone(baseline), best: structuredClone(best), history: structuredClone(rows), remaining: budget.snapshot(), config: executor.config }, budget, signal);
      signal.throwIfAborted(); budget.check();
      const row: ExperimentRow = { id, status: 'failed', rationale: proposal.rationale };
      rows.push(row);
      try {
        const prepared = await executor.prepare(id, proposal.content, proposal.rationale, signal);
        row.fingerprint = prepared.fingerprint;
        const existing = cache.get(prepared.fingerprint);
        if (existing) {
          row.status = 'cache_hit'; row.reused_from = existing.id; row.accuracy = existing.validation.accuracy;
          event('experiment_reused', { id, reused_from: existing.id });
        } else {
          event('experiment_start', { id });
          const result = await executor.run(prepared, false, signal);
          best = chooseBest(best, result);
          cache.set(result.fingerprint, result);
          row.status = 'evaluated'; row.accuracy = result.validation.accuracy;
          event('experiment_evaluated', { id, validation: result.validation, best_id: best.id });
        }
        row.best_id = best.id;
        await persist();
      } catch (error) { row.error = String(error); row.best_id = best.id; await persist(); throw error; }
    }
  } catch (error) {
    const reason = signal.aborted ? signal.reason : error;
    if (reason instanceof BudgetStop) { status = 'budget_exhausted'; stopReason = reason.reason; }
    else if (options.signal?.aborted) { status = 'cancelled'; stopReason = 'user_cancelled'; }
    else { status = 'failed'; stopReason = 'execution_or_agent_failure'; failure = String(reason); }
  } finally { clearTimeout(timer); }
  let delivery: Record<string, unknown> | undefined;
  // No training, evaluation or LLM calls after stop. Verify/copy the already evaluated best.
  if (best) {
    try { delivery = await executor.deliver(best); }
    catch (error) { status = 'failed'; stopReason = 'delivery_integrity_failure'; failure = String(error); }
  }
  await persist();
  const summary = { status, stop_reason: stopReason, failure, delivery, budget: budget.snapshot(), final_test_used: false };
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
  await writeFile(join(root, 'report.md'), [
    '# AXIOM 任务交付', `状态：${status}；停止原因：${stopReason}`, `目标：${spec.goal}`,
    `验证目标：${spec.target_accuracy ?? '未设置'}；最终测试：未使用。`,
    '## 真实实验', '| ID | 状态 | 验证准确率 | 历史最佳 | 复用来源 |', '| --- | --- | --- | --- | --- |',
    `| baseline | ${baseline ? 'evaluated' : 'failed'} | ${baseline?.validation.accuracy ?? '未知'} | baseline | — |`,
    ...rows.map(row => `| ${row.id} | ${row.status} | ${row.accuracy ?? '未知'} | ${row.best_id ?? '未知'} | ${row.reused_from ?? '—'} |`),
    '## 最佳交付', '```json', JSON.stringify(delivery ?? { reason: '没有经过独立评估且可安全交付的模型；不会伪造 best_model.pt' }, null, 2), '```',
    'best_model.pt 是 state_dict，配合 model.py/config.json 使用；best/ 保留完整独立评估快照。',
    '重算命令：python examples/tiny-ml-eval/validate_only.py --run <本工作区>/best（需原评估器与 CPU Torch）。',
    '## 预算账本', '```json', JSON.stringify(budget.snapshot(), null, 2), '```',
    '## 方案与失败分析', '下列理由是模型提交时的方案假设，不是独立核验结论；参数量与执行范围以对应 run.json / 审查结果为准。', ...rows.map(row => `- ${row.id}: ${row.rationale ?? ''}${row.error ? `；错误：${row.error}` : ''}`),
    ...(failure ? [`失败：${failure}`] : []), '## 范围与局限', ...REVIEW_NOTES.map(note => `- ${note}`),
    '单种子验证比较，不是最终测试达标或统计显著性结论。失败候选不会覆盖历史最佳；持平保留先前最佳。',
  ].join('\n\n'), { flag: 'wx' });
  return summary;
}
