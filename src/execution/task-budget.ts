import type { TaskSpec } from './task-spec.js';

export class BudgetStop extends Error {
  constructor(readonly reason: string) { super(reason); }
}
export class TaskBudget {
  readonly started: number;
  experiments = 0;
  trainingSteps = 0;
  computeMs = 0;
  tokens = 0;
  requests = 0;
  uncertain = false;
  private held = 0;
  constructor(readonly spec: TaskSpec, planningTokens = 0, private now: () => number = () => performance.now()) {
    this.started = now();
    this.tokens = planningTokens;
  }
  get remainingWallMs() { return this.spec.budget.wall_seconds * 1000 - (this.now() - this.started); }
  check(): void {
    if (this.remainingWallMs <= 0) throw new BudgetStop('wall_budget_exhausted');
    if (this.uncertain) throw new BudgetStop('token_usage_uncertain');
    if (this.tokens + this.held >= this.spec.budget.max_tokens) throw new BudgetStop('token_budget_exhausted');
  }
  experiment(): void {
    this.check();
    if (this.experiments >= this.spec.budget.max_experiments) throw new BudgetStop('experiment_budget_exhausted');
    this.experiments++;
  }
  steps(count: number): void {
    this.check();
    if (this.trainingSteps + count > this.spec.budget.training_steps) throw new BudgetStop('training_step_budget_exhausted');
    this.trainingSteps += count; // Reserve on launch; failures do not refund.
  }
  processTimeout(): number {
    this.check();
    const remaining = Math.min(this.remainingWallMs, this.spec.budget.compute_process_seconds * 1000 - this.computeMs, 60_000);
    if (remaining <= 0) throw new BudgetStop('compute_budget_exhausted');
    return Math.max(1, Math.floor(remaining));
  }
  reserveTokens(inputBound: number, maxOutput: number): number {
    this.check();
    if (this.held) throw new Error('Concurrent model calls forbidden');
    const reservation = inputBound + maxOutput;
    if (this.tokens + reservation > this.spec.budget.max_tokens) throw new BudgetStop('token_budget_exhausted');
    this.held = reservation;
    this.requests++;
    return reservation;
  }
  chargeQuotaRejection(): void {
    if (!this.held) throw new Error('No model reservation');
    // Explicit pre-generation rejection: conservatively charge the WHOLE bound,
    // not an invented zero usage; fallback must reserve from what remains.
    this.tokens += this.held;
    this.held = 0;
  }
  settleTokens(actual?: number): void {
    if (!this.held) throw new Error('No model reservation');
    if (actual === undefined || !Number.isSafeInteger(actual) || actual < 0 || actual > this.held) this.uncertain = true;
    this.tokens += actual !== undefined && Number.isSafeInteger(actual) && actual >= 0 ? actual : this.held;
    this.held = 0;
  }
  snapshot() {
    return { experiments: this.experiments, training_steps_reserved: this.trainingSteps, compute_process_seconds: this.computeMs / 1000, tokens_charged: this.tokens, tokens_reserved: this.held, model_requests: this.requests, usage_uncertain: this.uncertain, wall_seconds: (this.now() - this.started) / 1000 };
  }
}
