import { createHash } from 'node:crypto';

export interface TaskSpec {
  version: 1;
  task: 'tiny-xor-v1';
  goal: string;
  target_accuracy: number | null;
  rules: { pretrained_weights: false; extra_data: false; network: false; editable: 'model.py'; evaluation: 'validation' };
  budget: { max_experiments: number; wall_seconds: number; max_tokens: number; compute_process_seconds: number; training_steps: number; cpu_threads: 1; device: 'cpu' };
}
export const DEFAULT_BUDGET = { max_experiments: 3, wall_seconds: 600, max_tokens: 100_000, compute_process_seconds: 300, training_steps: 326, cpu_threads: 1 as const, device: 'cpu' as const };
export const TASK_RULES = { pretrained_weights: false as const, extra_data: false as const, network: false as const, editable: 'model.py' as const, evaluation: 'validation' as const };
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`Expected exact fields: ${keys.join(', ')}`);
}
export function validateTaskSpec(value: unknown): TaskSpec {
  exact(value, ['version', 'task', 'goal', 'target_accuracy', 'rules', 'budget']);
  if (value.version !== 1 || value.task !== 'tiny-xor-v1' || typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > 4000) throw new Error('Only the trusted Tiny Task adapter is available; invalid goal/task');
  if (value.target_accuracy !== null && (typeof value.target_accuracy !== 'number' || !Number.isFinite(value.target_accuracy) || value.target_accuracy < 0 || value.target_accuracy > 1)) throw new Error('target_accuracy must be null or [0,1]');
  exact(value.rules, Object.keys(TASK_RULES));
  for (const [key, expected] of Object.entries(TASK_RULES)) if (value.rules[key] !== expected) throw new Error(`Unsupported rule: ${key}; cannot relax trusted policy`);
  exact(value.budget, Object.keys(DEFAULT_BUDGET));
  const ranges: Record<string, [number, number]> = { max_experiments: [1, 3], wall_seconds: [10, 1800], max_tokens: [1, 500_000], compute_process_seconds: [1, 1200], training_steps: [1, 1000] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const n = value.budget[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid budget ${key}: integer [${min},${max}] required`);
  }
  if (value.budget.cpu_threads !== 1 || value.budget.device !== 'cpu') throw new Error('Only one-thread CPU execution is supported');
  return structuredClone(value) as unknown as TaskSpec;
}

export const REVIEW_NOTES = [
  'Only trusted examples/tiny-ml-task is supported, not arbitrary current repositories. Config is fixed/read-only.',
  'max_experiments counts candidate attempts, including failures. Baseline is separate and always charged to wall/compute/training-step budgets.',
  'Each candidate reserves 82 training steps (2 Smoke + 80 full); baseline reserves 80. No automatic training retry.',
  'compute_process_seconds sums child-process elapsed time including Python startup/evaluation; conservative compute envelope, NOT measured CPU-seconds or GPU resources. CPU device and one Torch/BLAS thread are enforced.',
  'Token budget includes planning actual usage. Before every decision request reserve conservative UTF-8 context bytes + 8192 framing tokens + output cap; settle using SDK usage. Missing/over-reservation usage stops further calls. Not an absolute provider billing guarantee.',
  'Goal means validation accuracy only. Final-test and local reference implementations are never offered to the Agent.',
  'Best selection, deduplication, budgets and stop reasons are deterministic code. Delivery copies and verifies already independently evaluated weights; no model call is needed for final report.',
];
