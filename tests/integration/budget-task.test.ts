import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_BUDGET, TASK_RULES, sha256, validateTaskSpec } from '../../src/execution/task-spec.js';
import { TaskBudget } from '../../src/execution/task-budget.js';
import { CpuTaskExecutor } from '../../src/execution/task-executor.js';
import { executeTask } from '../../src/execution/task-controller.js';

// Real CPU training/evaluation. These deliberately supplied candidates are NOT Agent results.
const mlp = 'from torch import nn\n\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 8), nn.Tanh(), nn.Linear(8, 2))\n';
const weak = 'from torch import nn\n\ndef build_model():\n    return nn.Sequential(nn.Linear(2, 2))\n';
async function fixture(t: { after: (fn: () => Promise<void>) => void }, budgetPatch = {}, target: number | null = null) {
  const python = process.env.AXIOM_PYTHON || resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.ok(existsSync(python), 'CPU Torch Python required');
  await mkdir(resolve('private'), { recursive: true });
  const root = await mkdtemp(resolve('private/wp04-cpu-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = validateTaskSpec({ version: 1, task: 'tiny-xor-v1', goal: 'Explicit CPU regression, no LLM', target_accuracy: target, rules: TASK_RULES, budget: { ...DEFAULT_BUDGET, ...budgetPatch } });
  const budget = new TaskBudget(spec), executor = new CpuTaskExecutor(resolve('.'), root, python, budget);
  await executor.initialize();
  return { root, spec, budget, executor };
}

test('real dedup and degraded second experiment preserve first best and loadable delivery', { timeout: 240_000 }, async t => {
  const f = await fixture(t, { max_experiments: 2 });
  let decisions = 0;
  const candidates = [mlp, '# Formatting-only duplicate\n' + mlp, weak];
  const summary = await executeTask({ ...f, propose: async context => {
    if (decisions > 0) assert.equal(context.best.id, 'exp-1');
    return { content: candidates[decisions++]!, rationale: 'CPU regression: good, duplicate, then deliberately weak' };
  } });
  assert.equal(summary.stop_reason, 'experiment_budget_exhausted');
  assert.equal(summary.budget.experiments, 2);
  const ledger = JSON.parse(await readFile(join(f.root, 'experiments.json'), 'utf8'));
  assert.equal(ledger.experiments[1].status, 'cache_hit');
  assert.ok(ledger.experiments[0].accuracy > ledger.experiments[2].accuracy);
  t.diagnostic(`Real validation: first=${ledger.experiments[0].accuracy}, later=${ledger.experiments[2].accuracy}; duplicate=${ledger.experiments[1].status}`);
  assert.equal(ledger.best.id, 'exp-1');
  assert.equal(summary.delivery?.best_id, 'exp-1');
  assert.equal(sha256(await readFile(join(f.root, 'best_model.pt'))), ledger.best.validation.checkpoint_sha256);
  assert.equal(await readFile(join(f.root, 'model.py'), 'utf8'), mlp);
  const commands = await Promise.all((await readdir(join(f.root, 'commands'))).map(async name => JSON.parse(await readFile(join(f.root, 'commands', name), 'utf8'))));
  assert.equal(commands.filter(c => c.script === 'experiment.py').length, 3, 'baseline + 2 actual jobs, no duplicate job');
  assert.equal(commands.filter(c => c.script === 'validate_only.py').length, 3);
  assert.ok(commands.every(c => !c.args.includes('final-test') && !c.args.includes('--split')));
  await writeFile(join(f.root, 'runs/exp-1/validation.json'), JSON.stringify({ ...ledger.best.validation, accuracy: 0.1 }));
  await assert.rejects(f.executor.deliver({ id: 'exp-1', model: mlp, fingerprint: ledger.experiments[0].fingerprint, validation: ledger.best.validation, run: join(f.root, 'runs/exp-1') }), /validation record changed/);
});

test('real baseline target stops before any candidate or model call', { timeout: 90_000 }, async t => {
  const f = await fixture(t, {}, 0.4);
  const summary = await executeTask({ ...f, propose: async () => { throw new Error('Must not ask Agent after target reached'); } });
  assert.equal(summary.status, 'target_reached');
  assert.equal(summary.budget.experiments, 0);
  assert.equal(summary.delivery?.best_id, 'baseline');
});

test('real wall deadline stops execution or waiting decision without another experiment', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { wall_seconds: 10 });
  const summary = await executeTask({ ...f, propose: async (_context, _budget, signal) => {
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    });
    throw new Error('unreachable');
  } });
  assert.equal(summary.status, 'budget_exhausted');
  assert.equal(summary.stop_reason, 'wall_budget_exhausted');
  assert.equal(summary.budget.experiments, 0);
});

test('real compute deadline kills worker; no fake best checkpoint if baseline incomplete', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { compute_process_seconds: 1 });
  const summary = await executeTask({ ...f, propose: async () => { throw new Error('Must not ask Agent'); } });
  assert.equal(summary.status, 'budget_exhausted');
  assert.equal(summary.stop_reason, 'compute_budget_exhausted');
  assert.equal(existsSync(join(f.root, 'best_model.pt')), false);
  const commands = await Promise.all((await readdir(join(f.root, 'commands'))).map(async name => JSON.parse(await readFile(join(f.root, 'commands', name), 'utf8'))));
  assert.ok(commands.some(c => c.stopped === 'timeout'));
});
