import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SmokeWorkspace, ValidationResult } from './smoke-workspace.js';

type Executor = Pick<SmokeWorkspace, 'root' | 'invoke' | 'verifyTrusted' | 'runFull' | 'validateFull' | 'exportSelected'>;
export const SINGLE_TASK = {
  task_id: 'wp03-single-candidate-v1', mode: 'optimize', protocol: 'tiny-xor-v1',
  objective: 'Improve validation accuracy compared to the actual linear baseline; no prescribed architecture.',
  selection: { metric: 'accuracy', direction: 'maximize', split: 'validation', min_delta: 0, rule: 'strictly greater; ties revert' },
  rules: {
    editable_files: ['model.py'], read_only_files: ['config.json'],
    max_parameters: 1024, candidate_edits: 1, full_candidate_attempts: 1,
    code_policy: 'from torch import nn; build_model() returns nn.Linear or nn.Sequential of Linear/ReLU/Tanh. Literal dimensions only; no classes, other statements, imports or dependencies.',
    forbidden: ['final-test access', 'reference implementation access', 'network', 'dependency installation', 'arbitrary shell', 'config changes'],
  },
  comparison_scope: 'One seed, fixed training config, full Tiny Task training, validation only; no statistical/generalization claim or final task target judgment.',
};

function validateEvidence(result: ValidationResult): void {
  if (result.protocol !== SINGLE_TASK.protocol || result.level !== 'full' || result.split !== 'validation' || result.samples !== 512 || !Number.isFinite(result.accuracy) || result.accuracy < 0 || result.accuracy > 1 || !Number.isFinite(result.loss) || JSON.stringify(result.dataset_access_log) !== '["validation"]') throw new Error('Selection requires independently verified full validation evidence');
}

export function decideCandidate(baseline: ValidationResult, candidate?: ValidationResult, candidateError?: string) {
  validateEvidence(baseline);
  if (!candidate) {
    if (!candidateError) throw new Error('Candidate has not been evaluated or failed');
    return { choice: 'revert' as const, outcome: 'candidate_failed', baseline_accuracy: baseline.accuracy, candidate_accuracy: null, delta: null, reason: candidateError };
  }
  validateEvidence(candidate);
  const delta = candidate.accuracy - baseline.accuracy;
  return {
    choice: delta > 0 ? 'keep' as const : 'revert' as const,
    outcome: delta > 0 ? 'validation_improved' : 'not_improved',
    baseline_accuracy: baseline.accuracy, candidate_accuracy: candidate.accuracy, delta,
    reason: delta > 0 ? 'Candidate validation accuracy is strictly higher' : 'No strict validation improvement; retain baseline',
  };
}

export class SingleOptimize {
  private queue: Promise<unknown> = Promise.resolve();
  private count = 0;
  private baselineAttempted = false;
  private baseline?: ValidationResult;
  private edited = false;
  private smokePassed = false;
  private candidateAttempted = false;
  private candidate?: ValidationResult;
  private candidateError?: string;
  private resultsRead = false;
  private final?: Record<string, unknown>;

  constructor(readonly workspace: Executor) {}

  async initialize(): Promise<void> {
    await writeFile(join(this.workspace.root, 'task-spec.json'), JSON.stringify(SINGLE_TASK, null, 2), { flag: 'wx' });
  }

  invoke(name: string, input: Record<string, unknown>, actor: 'model' | 'test' = 'model', signal?: AbortSignal): Promise<Record<string, unknown>> {
    const execute = async () => {
      signal?.throwIfAborted();
      if (++this.count > 32) throw new Error('WP-03 safety stop: maximum tool operations reached');
      try {
        await this.workspace.verifyTrusted();
        const result = await this.dispatch(name, input, actor, signal);
        await this.workspace.verifyTrusted();
        appendFileSync(join(this.workspace.root, 'experiment-events.jsonl'), JSON.stringify({ actor, name, input, result, status: 'ok', timestamp: new Date().toISOString() }) + '\n');
        return result;
      } catch (error) {
        appendFileSync(join(this.workspace.root, 'experiment-events.jsonl'), JSON.stringify({ actor, name, input, status: 'rejected_or_failed', error: String(error), timestamp: new Date().toISOString() }) + '\n');
        throw error;
      }
    };
    const result = this.queue.then(execute);
    this.queue = result.catch(() => {});
    return result;
  }

  private async dispatch(name: string, input: Record<string, unknown>, actor: 'model' | 'test', signal?: AbortSignal): Promise<Record<string, unknown>> {
    const argumentsByTool = new Map<string, string[]>([
      ['inspect_task', []], ['show_diff', []], ['read_candidate_file', ['path']],
      ['run_baseline', []], ['run_candidate', []], ['get_run_result', []],
      ['edit_candidate_file', ['path', 'expectedSha256', 'content', 'rationale']],
      ['run_checks', ['action']], ['finalize_candidate', ['choice', 'reason']],
    ]);
    const allowed = argumentsByTool.get(name);
    if (!allowed || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Permission denied: unsupported tool or arguments; split/command/path overrides are forbidden');
    if (name === 'inspect_task') return structuredClone(SINGLE_TASK);
    if (name === 'show_diff' || name === 'read_candidate_file') return this.workspace.invoke(name, input, actor, signal);
    if (this.final) throw new Error('Decision already finalized; no more experiments or edits');
    if (name === 'run_baseline') {
      if (this.baseline) return { status: 'already_evaluated', validation: this.baseline, artifact: 'baseline/' };
      if (this.baselineAttempted) throw new Error('Baseline failed; automatic retry is not enabled');
      this.baselineAttempted = true;
      this.baseline = await this.workspace.runFull('baseline', signal);
      validateEvidence(this.baseline);
      return { status: 'evaluated', validation: this.baseline, artifact: 'baseline/' };
    }
    if (!this.baseline) throw new Error('Run a valid baseline before edits or candidate experiments');
    if (name === 'edit_candidate_file') {
      if (this.edited || this.candidateAttempted) throw new Error('Only one accepted candidate edit is allowed in WP-03');
      if (typeof input.rationale !== 'string' || !input.rationale.trim() || input.rationale.length > 2000) throw new Error('Provide the independently generated rationale before editing');
      if (typeof input.content === 'string' && createHash('sha256').update(input.content).digest('hex') === input.expectedSha256) throw new Error('Candidate must differ from baseline source');
      const result = await this.workspace.invoke(name, { path: input.path, content: input.content, expectedSha256: input.expectedSha256 }, actor, signal);
      this.edited = true;
      await writeFile(join(this.workspace.root, 'proposal.json'), JSON.stringify({ author: actor, rationale: input.rationale, source: actor === 'model' ? 'model_tool_call_arguments' : 'offline_test_input', ...result }, null, 2), { flag: 'wx' });
      return result;
    }
    if (name === 'run_checks') {
      if (!this.edited) throw new Error('Propose one candidate before checks');
      if (this.candidateAttempted) throw new Error('Candidate execution finished; no further checks or training');
      const result = await this.workspace.invoke(name, input, actor, signal);
      if (input.action === 'smoke') this.smokePassed = true;
      return result;
    }
    if (name === 'run_candidate') {
      if (!this.edited || !this.smokePassed) throw new Error('One accepted edit and successful Smoke are required');
      if (this.candidateAttempted) throw new Error('Only one full candidate attempt; no search or retry');
      this.candidateAttempted = true;
      try {
        this.candidate = await this.workspace.runFull('candidate', signal);
        validateEvidence(this.candidate);
      } catch (error) {
        this.candidate = undefined;
        this.candidateError = error instanceof Error ? error.message : String(error);
        throw error;
      }
      return { status: 'evaluated', validation: this.candidate, artifact: 'candidate-run/' };
    }
    if (name === 'get_run_result') {
      if (!this.candidateAttempted) throw new Error('Candidate not attempted yet');
      this.baseline = await this.workspace.validateFull('baseline', signal);
      if (this.candidate) this.candidate = await this.workspace.validateFull('candidate', signal);
      validateEvidence(this.baseline);
      if (this.candidate) validateEvidence(this.candidate);
      this.resultsRead = true;
      // Give facts, not the keep/revert answer. The model must propose its own decision.
      return { baseline: this.baseline, candidate: this.candidate ?? { status: 'failed', error: this.candidateError }, selection_rule: SINGLE_TASK.selection, note: 'No final-test data was generated or evaluated by this workflow.' };
    }
    if (name === 'finalize_candidate') {
      if (!this.resultsRead) throw new Error('Read independent validation evidence before deciding');
      if (!['keep', 'revert'].includes(String(input.choice)) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) throw new Error('Supply choice keep/revert and an evidence-based reason');
      this.baseline = await this.workspace.validateFull('baseline', signal);
      if (this.candidate) this.candidate = await this.workspace.validateFull('candidate', signal);
      const expected = decideCandidate(this.baseline, this.candidate, this.candidateError);
      if (input.choice !== expected.choice) throw new Error(`Decision conflicts with real validation evidence: expected ${expected.choice}`);
      const selectedRole = expected.choice === 'keep' ? 'candidate' : 'baseline';
      const artifact = await this.workspace.exportSelected(selectedRole, signal);
      this.final = { ...expected, selected_role: selectedRole, selected_artifact: artifact, agent_reason: input.reason, scope: SINGLE_TASK.comparison_scope, validation_only: true, final_test_used: false };
      await writeFile(join(this.workspace.root, 'decision.json'), JSON.stringify(this.final, null, 2), { flag: 'wx' });
      return this.final;
    }
    throw new Error('Permission denied: unknown Optimize tool');
  }

  get outcome(): Record<string, unknown> | undefined { return this.final ? structuredClone(this.final) : undefined; }
}
