import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { SmokeWorkspace } from '../../src/execution/smoke-workspace.js';
import { SingleOptimize } from '../../src/execution/single-optimize.js';

// Actual CPU training and independent evaluation, but deliberately NO LLM/API call.
// A comment-only change preserves the linear model, testing real non-improvement/revert.
test('real executor reverts a non-improving candidate and delivers loadable baseline', { timeout: 180_000 }, async t => {
  const python = process.env.AXIOM_PYTHON || resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.ok(existsSync(python), 'Requires .venv Python with CPU Torch or AXIOM_PYTHON');
  const workspace = await SmokeWorkspace.create(resolve('.'), python, 'optimize');
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  const controller = new SingleOptimize(workspace);
  await controller.initialize();
  const read = await controller.invoke('read_candidate_file', { path: 'model.py' }, 'test');
  await controller.invoke('run_baseline', {}, 'test');
  await controller.invoke('edit_candidate_file', {
    path: 'model.py', expectedSha256: read.sha256,
    content: `${read.content}\n# Offline regression: same architecture, no intended improvement.\n`,
    rationale: 'Offline executor regression, not an Agent-generated optimization result',
  }, 'test');
  await controller.invoke('run_checks', { action: 'smoke' }, 'test');
  await controller.invoke('run_candidate', {}, 'test');
  const results = await controller.invoke('get_run_result', {}, 'test');
  assert.equal((results.baseline as { accuracy: number }).accuracy, (results.candidate as { accuracy: number }).accuracy);
  await assert.rejects(controller.invoke('finalize_candidate', { choice: 'keep', reason: 'training ran' }, 'test'), /conflicts/);
  const decision = await controller.invoke('finalize_candidate', { choice: 'revert', reason: 'Actual validation accuracy did not improve' }, 'test');
  assert.equal(decision.outcome, 'not_improved');
  assert.equal(decision.selected_role, 'baseline');
  assert.equal(decision.final_test_used, false);
  assert.equal(await readFile(join(workspace.root, 'selected', 'candidate', 'model.py'), 'utf8'), read.content);
  const proposal = JSON.parse(await readFile(join(workspace.root, 'proposal.json'), 'utf8'));
  assert.equal(proposal.author, 'test');
  assert.equal(proposal.source, 'offline_test_input');
  const commands = await Promise.all((await readdir(join(workspace.root, 'commands'))).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(workspace.root, 'commands', name), 'utf8')) as { args: string[] }));
  const fullTrains = commands.filter(c => basename(c.args[0]!) === 'train.py' && c.args.includes('full'));
  assert.equal(fullTrains.length, 2, 'Only one baseline and one full candidate training');
  assert.ok(commands.every(c => !c.args.includes('--split') && basename(c.args[0]!) !== 'judge.py'));
  await workspace.verifyTrusted();
});
