import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BUDGET, TASK_RULES, validateTaskSpec, type TaskSpec } from '../src/execution/task-spec.js';
import { TaskBudget } from '../src/execution/task-budget.js';
import { chooseBest, executeTask } from '../src/execution/task-controller.js';
import type { Evaluated, TaskExecutor } from '../src/execution/task-executor.js';

const spec = (patch: Partial<TaskSpec> = {}) => validateTaskSpec({ version: 1, task: 'tiny-xor-v1', goal: 'unit fixture, not real training', target_accuracy: null, rules: TASK_RULES, budget: DEFAULT_BUDGET, ...patch });
function result(id: string, accuracy: number, fingerprint = id): Evaluated {
  return { id, model: fingerprint, fingerprint, run: 'unit-fixture', validation: { protocol: 'tiny-xor-v1', level: 'full', split: 'validation', samples: 512, accuracy, loss: 0.5, checkpoint_sha256: 'a'.repeat(64), dataset_access_log: ['validation'] } };
}

test('TaskSpec rejects relaxed policy, unknown fields and unbounded budgets', () => {
  assert.throws(() => spec({ rules: { ...TASK_RULES, pretrained_weights: true } as never }), /Unsupported rule/);
  assert.throws(() => spec({ target_accuracy: NaN }), /target_accuracy/);
  for (const value of [0, 4, Infinity, 1.5]) assert.throws(() => spec({ budget: { ...DEFAULT_BUDGET, max_experiments: value } }), /max_experiments/);
  assert.throws(() => validateTaskSpec({ ...spec(), command: 'evil' }), /exact fields/);
  assert.throws(() => spec({ budget: { ...DEFAULT_BUDGET, device: 'cuda' } as never }), /CPU/);
});

test('token reservation is enforced before request and uncertain usage stops further work', () => {
  const budget = new TaskBudget(spec({ budget: { ...DEFAULT_BUDGET, max_tokens: 100 } }));
  assert.throws(() => budget.reserveTokens(80, 21), /token_budget_exhausted/);
  assert.equal(budget.requests, 0);
  budget.reserveTokens(60, 20);
  budget.settleTokens(10);
  assert.equal(budget.tokens, 10);
  budget.reserveTokens(60, 20);
  budget.settleTokens(undefined);
  assert.equal(budget.tokens, 90);
  assert.throws(() => budget.check(), /token_usage_uncertain/);
  const exceeded = new TaskBudget(spec()); exceeded.reserveTokens(1, 1); exceeded.settleTokens(3);
  assert.equal(exceeded.uncertain, true);
});

test('wall, training-step, compute and candidate limits are deterministic', () => {
  let now = 0;
  const budget = new TaskBudget(spec({ budget: { ...DEFAULT_BUDGET, max_experiments: 1, training_steps: 80, compute_process_seconds: 1 } }), 0, () => now);
  budget.steps(80); assert.throws(() => budget.steps(1), /training_step_budget_exhausted/);
  budget.experiment(); assert.throws(() => budget.experiment(), /experiment_budget_exhausted/);
  budget.computeMs = 1000; assert.throws(() => budget.processTimeout(), /compute_budget_exhausted/);
  now = DEFAULT_BUDGET.wall_seconds * 1000; assert.throws(() => budget.check(), /wall_budget_exhausted/);
});

test('best selection rejects smoke/final-test and keeps history best on ties and declines', () => {
  const first = result('first', 0.9);
  assert.equal(chooseBest(first, result('second', 0.6)).id, 'first');
  assert.equal(chooseBest(first, result('tie', 0.9)).id, 'first');
  assert.equal(chooseBest(first, result('better', 0.95)).id, 'better');
  const invalid = result('fake', 1); invalid.validation.level = 'smoke' as never;
  assert.throws(() => chooseBest(first, invalid), /independent validation/);
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }, task: TaskSpec, scores: number[], proposals?: string[], fail = false) {
  const root = await mkdtemp(join(tmpdir(), 'axiom-budget-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const budget = new TaskBudget(task);
  const trained: string[] = [], observed: string[] = [];
  let running = false, decisions = 0, delivered: string | undefined;
  const executor: TaskExecutor = {
    original: 'baseline', config: JSON.stringify({ epochs: 80 }),
    prepare: async (id, content, rationale) => ({ id, content, rationale, fingerprint: content }),
    run: async (prepared, baseline) => {
      if (!baseline) budget.experiment(); budget.steps(baseline ? 80 : 82);
      trained.push(prepared.id); running = true; await Promise.resolve(); running = false;
      if (!baseline && fail) throw new Error('unit injected worker failure');
      return result(prepared.id, baseline ? 0.5 : scores.shift()!, prepared.fingerprint);
    },
    deliver: async best => { delivered = best.id; return { best_id: best.id }; },
  };
  const summary = await executeTask({ root, spec: task, budget, executor, propose: async context => {
    assert.equal(running, false, 'No model calls during training');
    observed.push(context.best.id); decisions++;
    return { content: proposals?.[decisions - 1] ?? `candidate-${decisions}`, rationale: 'unit fixture only' };
  } });
  const ledger = JSON.parse(await readFile(join(root, 'experiments.json'), 'utf8'));
  return { summary, trained, delivered, decisions, observed, ledger };
}

test('three attempts stop automatically; worse second round cannot replace historical best', async t => {
  const f = await fixture(t, spec(), [0.9, 0.6, 0.8]);
  assert.deepEqual(f.trained, ['baseline', 'exp-1', 'exp-2', 'exp-3']);
  assert.equal(f.decisions, 3); assert.equal(f.delivered, 'exp-1');
  assert.deepEqual(f.observed, ['baseline', 'exp-1', 'exp-1']);
  assert.equal(f.summary.stop_reason, 'experiment_budget_exhausted');
  assert.equal(f.summary.budget.training_steps_reserved, 326);
});

test('same conditions reuse completed results without charging another training attempt', async t => {
  const f = await fixture(t, spec({ budget: { ...DEFAULT_BUDGET, max_experiments: 2 } }), [0.9, 0.6], ['same', 'same', 'different']);
  assert.deepEqual(f.trained, ['baseline', 'exp-1', 'exp-3']);
  assert.equal(f.ledger.experiments[1].status, 'cache_hit');
  assert.equal(f.summary.budget.experiments, 2); assert.equal(f.delivered, 'exp-1');
});

test('target stops before another decision, even when experiments remain', async t => {
  const f = await fixture(t, spec({ target_accuracy: 0.8 }), [0.9]);
  assert.equal(f.summary.status, 'target_reached'); assert.equal(f.decisions, 1);
  const base = await fixture(t, spec({ target_accuracy: 0.4 }), []);
  assert.equal(base.decisions, 0); assert.equal(base.delivered, 'baseline');
});

test('failure is charged and stops with baseline delivery, no retry or fake successful row', async t => {
  const f = await fixture(t, spec(), [], undefined, true);
  assert.equal(f.summary.status, 'failed'); assert.equal(f.summary.budget.experiments, 1);
  assert.equal(f.delivered, 'baseline'); assert.equal(f.decisions, 1);
  assert.equal(f.ledger.experiments[0].status, 'failed');
});

test('insufficient step budget stops before asking Agent to propose a candidate', async t => {
  const f = await fixture(t, spec({ budget: { ...DEFAULT_BUDGET, training_steps: 80 } }), []);
  assert.equal(f.summary.stop_reason, 'training_step_budget_exhausted');
  assert.equal(f.decisions, 0); assert.equal(f.delivered, 'baseline');
});
