import { appendFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { runProcess } from './process.js';
import { BudgetStop, TaskBudget } from './task-budget.js';
import { sha256 } from './task-spec.js';
import type { ValidationResult } from './smoke-workspace.js';

export interface Prepared { id: string; fingerprint: string; content: string; rationale: string }
export interface Evaluated { validation: ValidationResult; run: string; model: string; fingerprint: string; id: string }
export interface TaskExecutor {
  original: string; config: string;
  prepare(id: string, content: string, rationale: string, signal: AbortSignal): Promise<Prepared>;
  run(prepared: Prepared, baseline: boolean, signal: AbortSignal): Promise<Evaluated>;
  deliver(best: Evaluated): Promise<Record<string, unknown>>;
}
const scripts = ['task.json', 'common.py', 'train.py', 'evaluate.py', 'judge.py', 'review_candidate.py', 'validate_only.py', 'experiment.py'];
export class CpuTaskExecutor implements TaskExecutor {
  original = ''; config = '';
  private trusted = new Map<string, string>();
  private prepared = new Map<string, Prepared>();
  private launched = new Set<string>();
  private counter = 0;
  private identity = '';
  constructor(readonly repo: string, readonly root: string, readonly python: string, readonly budget: TaskBudget) {}
  async initialize() {
    for (const name of ['sources', 'runs', 'commands', 'tmp']) await mkdir(join(this.root, name));
    this.original = await readFile(join(this.repo, 'examples/tiny-ml-task/model.py'), 'utf8');
    this.config = await readFile(join(this.repo, 'examples/tiny-ml-task/config.json'), 'utf8');
    for (const path of [...scripts.map(name => join(this.repo, 'examples/tiny-ml-eval', name)), ...['model.py', 'config.json'].map(name => join(this.repo, 'examples/tiny-ml-task', name)), await realpath(this.python)]) this.trusted.set(path, sha256(await readFile(path)));
    this.identity = sha256(JSON.stringify([...this.trusted]));
    await writeFile(join(this.root, 'trusted-inputs.json'), JSON.stringify([...this.trusted], null, 2), { flag: 'wx' });
  }
  private async verify() {
    for (const [path, hash] of this.trusted) {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || sha256(await readFile(path)) !== hash) throw new Error('Trusted input or candidate snapshot changed');
    }
  }
  private async command(script: string, args: string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    await this.verify();
    const wallRemaining = this.budget.remainingWallMs;
    const computeRemaining = this.budget.spec.budget.compute_process_seconds * 1000 - this.budget.computeMs;
    const timeoutMs = this.budget.processTimeout();
    const argv = [join(this.repo, 'examples/tiny-ml-eval', script), ...args];
    const start = performance.now();
    const id = String(++this.counter).padStart(3, '0');
    appendFileSync(join(this.root, 'events.jsonl'), JSON.stringify({ type: 'process_start', script, args, timestamp: new Date().toISOString() }) + '\n');
    let result;
    try { result = await runProcess(this.python, argv, { cwd: this.root, home: join(this.root, 'tmp'), signal, timeoutMs }); }
    finally { this.budget.computeMs += performance.now() - start; }
    await writeFile(join(this.root, 'commands', `${id}.json`), JSON.stringify({ script, args: argv, timeoutMs, ...result }, null, 2), { flag: 'wx' });
    appendFileSync(join(this.root, 'events.jsonl'), JSON.stringify({ type: 'process_end', script, code: result.code, stopped: result.stopped, timestamp: new Date().toISOString() }) + '\n');
    if (result.code !== 0 || result.stopped) {
      if (signal.aborted) signal.throwIfAborted();
      if (result.stopped === 'timeout' && Math.min(wallRemaining, computeRemaining) <= 60_000) throw new BudgetStop(wallRemaining <= computeRemaining ? 'wall_budget_exhausted' : 'compute_budget_exhausted');
      if (this.budget.remainingWallMs <= 0) throw new BudgetStop('wall_budget_exhausted');
      if (this.budget.computeMs >= this.budget.spec.budget.compute_process_seconds * 1000) throw new BudgetStop('compute_budget_exhausted');
      throw new Error(`Fixed worker ${script} failed (${result.stopped ?? result.code}); see commands/${id}.json`);
    }
    await this.verify();
    return result.stdout;
  }
  async prepare(id: string, content: string, rationale: string, signal: AbortSignal): Promise<Prepared> {
    if (!/^(baseline|exp-[1-9][0-9]*)$/.test(id) || this.prepared.has(id) || typeof content !== 'string' || Buffer.byteLength(content) > 8192 || !rationale.trim() || rationale.length > 2000) throw new Error('Invalid candidate proposal');
    const source = join(this.root, 'sources', id);
    await mkdir(source);
    await writeFile(join(source, 'model.py'), content, { flag: 'wx' });
    await writeFile(join(source, 'config.json'), this.config, { flag: 'wx' });
    const review = JSON.parse(await this.command('review_candidate.py', ['--candidate', source], signal));
    if (typeof review.architecture_sha256 !== 'string') throw new Error('Missing architecture identity');
    const fingerprint = sha256(JSON.stringify({ architecture: review.architecture_sha256, config: this.config, protocol: 'tiny-xor-v1', trusted: this.identity, device: 'cpu', threads: 1 }));
    const prepared = { id, fingerprint, content, rationale };
    this.prepared.set(id, structuredClone(prepared));
    for (const name of ['model.py', 'config.json']) this.trusted.set(join(source, name), sha256(await readFile(join(source, name))));
    await writeFile(join(source, 'proposal.json'), JSON.stringify({ ...prepared, policy: review }, null, 2), { flag: 'wx' });
    await writeFile(join(source, 'patch.diff'), createTwoFilesPatch('baseline/model.py', `${id}/model.py`, this.original, content), { flag: 'wx' });
    return prepared;
  }
  async run(prepared: Prepared, baseline: boolean, signal: AbortSignal): Promise<Evaluated> {
    if (JSON.stringify(this.prepared.get(prepared.id)) !== JSON.stringify(prepared) || baseline !== (prepared.id === 'baseline')) throw new Error('Unknown immutable candidate');
    if (this.launched.has(prepared.fingerprint)) throw new Error('Completed or attempted identical experiment cannot be retrained');
    const run = join(this.root, 'runs', prepared.id);
    const source = join(this.root, 'sources', prepared.id);
    const epochs = JSON.parse(this.config).epochs;
    if (!Number.isSafeInteger(epochs) || epochs < 1 || epochs > 120) throw new Error('Invalid fixed training config');
    if (!baseline) this.budget.experiment();
    this.budget.steps(epochs + (baseline ? 0 : 2));
    this.launched.add(prepared.fingerprint);
    const args = ['--candidate', source, '--output', run];
    if (!baseline) args.push('--smoke-output', join(this.root, 'runs', `${prepared.id}-smoke`));
    await this.command('experiment.py', args, signal);
    const validation = JSON.parse(await this.command('validate_only.py', ['--run', run, '--output', join(run, 'validation.json')], signal)) as ValidationResult;
    if (validation.protocol !== 'tiny-xor-v1' || validation.split !== 'validation' || validation.level !== 'full' || validation.samples !== 512 || !Number.isFinite(validation.accuracy) || validation.accuracy < 0 || validation.accuracy > 1 || !Number.isFinite(validation.loss) || JSON.stringify(validation.dataset_access_log) !== '["validation"]') throw new Error('Invalid independent validation evidence');
    const result = { validation, run, model: prepared.content, fingerprint: prepared.fingerprint, id: prepared.id };
    return result;
  }
  async deliver(best: Evaluated): Promise<Record<string, unknown>> {
    await this.verify();
    const checkpoint = await readFile(join(best.run, 'checkpoint.pt'));
    if (sha256(checkpoint) !== best.validation.checkpoint_sha256) throw new Error('Best checkpoint changed since independent evaluation');
    const savedValidation = JSON.parse(await readFile(join(best.run, 'validation.json'), 'utf8'));
    if (JSON.stringify(savedValidation) !== JSON.stringify(best.validation)) throw new Error('Independent validation record changed');
    const metadata = JSON.parse(await readFile(join(best.run, 'run.json'), 'utf8'));
    if (sha256(await readFile(join(best.run, 'run.json'))) !== best.validation.run_metadata_sha256) throw new Error('Best run metadata changed');
    for (const name of ['model.py', 'config.json']) if (sha256(await readFile(join(best.run, 'candidate', name))) !== metadata.candidate_sha256[name]) throw new Error('Best model snapshot changed');
    const destination = join(this.root, 'best');
    await mkdir(destination);
    await mkdir(join(destination, 'candidate'));
    for (const name of ['checkpoint.pt', 'run.json', 'history.json', 'validation.json', 'candidate/model.py', 'candidate/config.json']) await copyFile(join(best.run, name), join(destination, name));
    await copyFile(join(destination, 'checkpoint.pt'), join(this.root, 'best_model.pt'));
    await copyFile(join(destination, 'candidate/model.py'), join(this.root, 'model.py'));
    await copyFile(join(destination, 'candidate/config.json'), join(this.root, 'config.json'));
    if (sha256(await readFile(join(this.root, 'best_model.pt'))) !== best.validation.checkpoint_sha256) throw new Error('Delivery checkpoint hash mismatch');
    return { best_id: best.id, accuracy: best.validation.accuracy, checkpoint_sha256: best.validation.checkpoint_sha256, model: 'model.py', config: 'config.json', checkpoint: 'best_model.pt', independently_evaluated_run: 'best/' };
  }
}
