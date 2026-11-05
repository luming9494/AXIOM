import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { runProcess } from './process.js';

const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const text = (value: unknown): value is string => typeof value === 'string';
const protectedScripts = ['task.json', 'common.py', 'checks.py', 'train.py', 'evaluate.py', 'judge.py', 'review_candidate.py'];

export class SmokeWorkspace {
  readonly candidate: string;
  private original = '';
  private trusted = new Map<string, string>();
  private serial: Promise<unknown> = Promise.resolve();
  private operations = 0;
  private attemptedSmoke = false;
  private readModelHash?: string;
  private smokeHash?: string;
  private commandIndex = 0;
  private constructor(readonly repo: string, readonly root: string, readonly python: string) {
    this.candidate = join(root, 'candidate');
  }

  static async create(repo: string, python: string): Promise<SmokeWorkspace> {
    repo = await realpath(repo);
    python = await realpath(python);
    const parent = join(repo, 'private');
    await mkdir(parent, { recursive: true });
    const rel = relative(repo, await realpath(parent));
    if (rel === '..' || rel.startsWith(`..`) || isAbsolute(rel)) throw new Error('private directory must remain inside repository');
    const root = await mkdtemp(join(parent, 'wp02-'));
    const workspace = new SmokeWorkspace(repo, root, python);
    await mkdir(workspace.candidate);
    await mkdir(join(root, 'before'));
    await mkdir(join(root, 'tmp'));
    await mkdir(join(root, 'commands'));
    for (const name of ['model.py', 'config.json']) {
      const source = join(repo, 'examples', 'tiny-ml-task', name);
      workspace.trusted.set(source, digest(await readFile(source)));
      await copyFile(source, join(workspace.candidate, name));
      await copyFile(source, join(root, 'before', name));
    }
    for (const name of protectedScripts) {
      const path = join(repo, 'examples', 'tiny-ml-eval', name);
      workspace.trusted.set(path, digest(await readFile(path)));
    }
    workspace.original = await readFile(join(workspace.candidate, 'model.py'), 'utf8');
    await writeFile(join(root, 'outside-sentinel.txt'), 'OUTSIDE_CANDIDATE_DO_NOT_CHANGE\n', { flag: 'wx' });
    await writeFile(join(root, 'patch.diff'), '', { flag: 'wx' });
    return workspace;
  }

  async verifyTrusted(): Promise<void> {
    for (const [path, hash] of this.trusted) {
      if (digest(await readFile(path)) !== hash) throw new Error(`Protected source changed: ${relative(this.repo, path)}`);
    }
    if (await readFile(join(this.root, 'outside-sentinel.txt'), 'utf8') !== 'OUTSIDE_CANDIDATE_DO_NOT_CHANGE\n') throw new Error('Outside sentinel changed');
    await this.file('config.json');
    const config = await readFile(join(this.candidate, 'config.json'));
    if (digest(config) !== digest(await readFile(join(this.root, 'before', 'config.json')))) throw new Error('Read-only config changed');
  }

  private async file(path: unknown, writable = false): Promise<string> {
    if (!text(path) || !(writable ? ['model.py'] : ['model.py', 'config.json']).includes(path)) throw new Error('Permission denied: exact candidate file allowlist; only model.py is writable');
    const target = join(this.candidate, path);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(target) !== resolve(target)) throw new Error('Permission denied: file aliases, links and non-regular files are forbidden');
    if (stat.size > 8192) throw new Error('Candidate file exceeds 8 KiB');
    return target;
  }

  private async command(script: string, args: string[], signal?: AbortSignal): Promise<string> {
    const index = String(++this.commandIndex).padStart(3, '0');
    const prefix = join(this.root, 'commands', index);
    const argv = [join(this.repo, 'examples', 'tiny-ml-eval', script), ...args];
    const result = await runProcess(this.python, argv, { cwd: this.root, home: join(this.root, 'tmp'), signal });
    await writeFile(`${prefix}.stdout.txt`, result.stdout, { flag: 'wx' });
    await writeFile(`${prefix}.stderr.txt`, result.stderr, { flag: 'wx' });
    await writeFile(`${prefix}.json`, JSON.stringify({ executable: this.python, args: argv, code: result.code, stopped: result.stopped }, null, 2), { flag: 'wx' });
    if (result.code !== 0 || result.stopped) throw new Error(`Command ${script} failed (${result.stopped ?? result.code}): ${result.stderr.slice(-3000)}; logs: commands/${index}.*`);
    return result.stdout;
  }

  private async review(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return JSON.parse(await this.command('review_candidate.py', ['--candidate', path], signal)) as Record<string, unknown>;
  }

  // All operations share a queue; read/edit/check/smoke cannot race within an assistant batch.
  invoke(name: string, input: Record<string, unknown>, actor: 'model' | 'test' = 'model', signal?: AbortSignal): Promise<Record<string, unknown>> {
    const execute = async () => {
      signal?.throwIfAborted();
      if (++this.operations > 32) throw new Error('WP-02 safety stop: maximum tool operations reached');
      const start = Date.now();
      try {
        await this.verifyTrusted();
        const result = await this.dispatch(name, input, signal);
        await this.verifyTrusted();
        appendFileSync(join(this.root, 'operations.jsonl'), JSON.stringify({ actor, name, input, result, status: 'ok', timestamp: new Date().toISOString(), durationMs: Date.now() - start }) + '\n');
        return result;
      } catch (error) {
        appendFileSync(join(this.root, 'operations.jsonl'), JSON.stringify({ actor, name, input, status: 'rejected_or_failed', error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() }) + '\n');
        throw error;
      }
    };
    const pending = this.serial.then(execute);
    this.serial = pending.catch(() => {});
    return pending;
  }

  private async dispatch(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (name === 'read_candidate_file') {
      const path = await this.file(input.path);
      const content = await readFile(path, 'utf8');
      if (input.path === 'model.py') this.readModelHash = digest(content);
      return { path: input.path, content, sha256: digest(content) };
    }
    if (name === 'edit_candidate_file') {
      const path = await this.file(input.path, true);
      if (!text(input.content) || !text(input.expectedSha256) || Buffer.byteLength(input.content) > 8192) throw new Error('Invalid edit or source exceeds 8 KiB');
      const previous = await readFile(path, 'utf8');
      if (input.expectedSha256 !== digest(previous) || this.readModelHash !== digest(previous)) throw new Error('Read current model.py first; stale edits are rejected');
      if (this.attemptedSmoke) throw new Error('WP-02 stops editing after Smoke; optimization iterations are not enabled');
      const staged = join(this.root, `review-${randomUUID()}`);
      await mkdir(staged);
      await writeFile(join(staged, 'model.py'), input.content, { flag: 'wx' });
      const policy = await this.review(staged, signal);
      if (policy.kind !== 'mlp') throw new Error('This task requires a small MLP with at least two Linear layers and an activation');
      signal?.throwIfAborted();
      await writeFile(path, input.content);
      const diff = createTwoFilesPatch('a/model.py', 'b/model.py', this.original, input.content);
      await writeFile(join(this.root, 'patch.diff'), diff);
      this.readModelHash = undefined;
      return { path: 'model.py', sha256: digest(input.content), policy, diff, artifact: 'patch.diff' };
    }
    if (name === 'run_checks') {
      // Deliberately checked in the executor too, not just by JSON Schema or Prompt.
      if (Object.keys(input).some(key => key !== 'action') || !['l0', 'smoke'].includes(String(input.action))) throw new Error('Permission denied: only fixed actions l0 and smoke; no shell, command or custom arguments');
      await this.file('model.py');
      const policy = await this.review(this.candidate, signal);
      if (input.action === 'l0') {
        const result = JSON.parse(await this.command('checks.py', ['--candidate', this.candidate], signal)) as Record<string, unknown>;
        return { ...result, policy };
      }
      if (this.attemptedSmoke) throw new Error('WP-02 allows one Smoke attempt per workspace');
      this.attemptedSmoke = true;
      if (policy.kind !== 'mlp') throw new Error('Modify the baseline to an approved MLP before Smoke');
      const smoke = join(this.root, 'smoke');
      await this.command('checks.py', ['--candidate', this.candidate], signal);
      await this.command('train.py', ['--candidate', this.candidate, '--output', smoke, '--level', 'smoke'], signal);
      await this.command('evaluate.py', ['--run', smoke, '--output', join(smoke, 'validation.json')], signal);
      this.smokeHash = digest(await readFile(await this.file('model.py')));
      return { status: 'executed', level: 'smoke', artifact: 'smoke/', result_tool: 'read_smoke_result', note: 'Read real artifacts with read_smoke_result before judging success; no formal score claim.' };
    }
    if (name === 'read_smoke_result') {
      if (!this.smokeHash) throw new Error('No successful Smoke artifacts yet');
      if (digest(await readFile(await this.file('model.py'))) !== this.smokeHash) throw new Error('Candidate changed after Smoke');
      const smoke = join(this.root, 'smoke');
      const verified = JSON.parse(await this.command('evaluate.py', ['--run', smoke], signal)) as Record<string, unknown>;
      const metadata = JSON.parse(await readFile(join(smoke, 'run.json'), 'utf8')) as Record<string, unknown>;
      if (metadata.level !== 'smoke' || metadata.epochs_executed !== 2 || metadata.train_samples !== 16) throw new Error('Unexpected Smoke scope');
      return { status: 'passed', level: 'smoke', epochs: metadata.epochs_executed, train_samples: metadata.train_samples, parameters: metadata.parameter_count, validation: verified, model_sha256: this.smokeHash, artifacts: ['smoke/checkpoint.pt', 'smoke/history.json', 'smoke/run.json', 'smoke/validation.json', 'patch.diff'], note: 'Proves only training/save/load works; not full model performance or autonomous optimization.' };
    }
    if (name === 'show_diff') return { diff: await readFile(join(this.root, 'patch.diff'), 'utf8'), artifact: 'patch.diff' };
    throw new Error('Permission denied: unknown tool');
  }
}
