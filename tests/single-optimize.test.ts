import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideCandidate, SingleOptimize } from '../src/execution/single-optimize.js';
import type { ValidationResult } from '../src/execution/smoke-workspace.js';
import { optimizeAcceptance } from '../src/agent/optimize-agent.js';

// Synthetic results test controller logic only; not model calls or training evidence.
function evidence(accuracy: number): ValidationResult {
  return { protocol: 'tiny-xor-v1', split: 'validation', level: 'full', accuracy, loss: 0.5, samples: 512, checkpoint_sha256: 'a'.repeat(64), dataset_access_log: ['validation'] };
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, score = 0.8, failCandidate = false) {
  const root = await mkdtemp(join(tmpdir(), 'axiom-wp03-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trained: string[] = [], exported: string[] = [];
  const baseline = evidence(0.5), candidate = evidence(score);
  const controller = new SingleOptimize({
    root, verifyTrusted: async () => {},
    invoke: async name => name === 'edit_candidate_file' ? { status: 'edited' } : { status: 'executed' },
    runFull: async role => { trained.push(role); if (role === 'candidate' && failCandidate) throw new Error('real executor failed (unit fixture)'); return role === 'baseline' ? baseline : candidate; },
    validateFull: async role => role === 'baseline' ? baseline : candidate,
    exportSelected: async role => { exported.push(role); return 'selected/'; },
  });
  await controller.initialize();
  return { controller, trained, exported };
}
async function runToResults(controller: SingleOptimize) {
  await controller.invoke('run_baseline', {}, 'test');
  await controller.invoke('edit_candidate_file', { path: 'model.py', expectedSha256: 'old', content: 'new', rationale: 'unit fixture only' }, 'test');
  await controller.invoke('run_checks', { action: 'smoke' }, 'test');
  await controller.invoke('run_candidate', {}, 'test');
  await controller.invoke('get_run_result', {}, 'test');
}

test('strict validation improvement keeps; ties, declines and candidate failure revert', () => {
  assert.equal(decideCandidate(evidence(0.5), evidence(0.8)).choice, 'keep');
  assert.equal(decideCandidate(evidence(0.5), evidence(0.5)).choice, 'revert');
  assert.equal(decideCandidate(evidence(0.5), evidence(0.2)).choice, 'revert');
  assert.equal(decideCandidate(evidence(0.5), undefined, 'failed').outcome, 'candidate_failed');
  assert.throws(() => decideCandidate(evidence(0.5)), /not been evaluated/);
  for (const invalid of [{ ...evidence(0.8), split: 'final-test' }, { ...evidence(0.8), level: 'smoke' }, { ...evidence(0.8), accuracy: NaN }, { ...evidence(0.8), accuracy: 2 }, { ...evidence(0.8), dataset_access_log: ['validation', 'final-test'] }]) {
    assert.throws(() => decideCandidate(evidence(0.5), invalid as ValidationResult), /independently verified/);
  }
});

test('single-candidate workflow requires baseline, Smoke, metrics and a correct decision', async t => {
  const { controller, trained, exported } = await fixture(t);
  await assert.rejects(controller.invoke('run_candidate', {}, 'test'), /baseline/);
  await controller.invoke('run_baseline', {}, 'test');
  await controller.invoke('run_baseline', {}, 'test');
  assert.deepEqual(trained, ['baseline']);
  await controller.invoke('edit_candidate_file', { path: 'model.py', expectedSha256: 'old', content: 'new', rationale: 'unit fixture' }, 'test');
  await assert.rejects(controller.invoke('edit_candidate_file', { path: 'model.py' }, 'test'), /one accepted/);
  await assert.rejects(controller.invoke('run_candidate', {}, 'test'), /Smoke/);
  await controller.invoke('run_checks', { action: 'smoke' }, 'test');
  await controller.invoke('run_candidate', {}, 'test');
  await assert.rejects(controller.invoke('run_candidate', {}, 'test'), /one full/);
  await assert.rejects(controller.invoke('finalize_candidate', { choice: 'keep', reason: 'guessed' }, 'test'), /Read independent/);
  await controller.invoke('get_run_result', {}, 'test');
  await assert.rejects(controller.invoke('finalize_candidate', { choice: 'revert', reason: 'wrong' }, 'test'), /conflicts/);
  assert.deepEqual(exported, []);
  const final = await controller.invoke('finalize_candidate', { choice: 'keep', reason: '0.8 > 0.5' }, 'test');
  assert.equal(final.outcome, 'validation_improved');
  assert.deepEqual(trained, ['baseline', 'candidate']);
  assert.deepEqual(exported, ['candidate']);
  await assert.rejects(controller.invoke('run_candidate', {}, 'test'), /finalized/);
});

test('no improvement is a valid completed workflow that delivers baseline', async t => {
  const { controller, exported } = await fixture(t, 0.5);
  await runToResults(controller);
  await assert.rejects(controller.invoke('finalize_candidate', { choice: 'keep', reason: 'training succeeded' }, 'test'), /conflicts/);
  const final = await controller.invoke('finalize_candidate', { choice: 'revert', reason: 'No validation improvement' }, 'test');
  assert.equal(final.outcome, 'not_improved');
  assert.equal(final.delta, 0);
  assert.deepEqual(exported, ['baseline']);
});

test('failed candidate may truthfully revert but cannot be retried', async t => {
  const { controller, exported } = await fixture(t, 0.8, true);
  await controller.invoke('run_baseline', {}, 'test');
  await controller.invoke('edit_candidate_file', { path: 'model.py', expectedSha256: 'old', content: 'new', rationale: 'unit fixture' }, 'test');
  await controller.invoke('run_checks', { action: 'smoke' }, 'test');
  await assert.rejects(controller.invoke('run_candidate', {}, 'test'), /executor failed/);
  await assert.rejects(controller.invoke('run_candidate', {}, 'test'), /one full/);
  const result = await controller.invoke('get_run_result', {}, 'test');
  assert.equal((result.candidate as { status: string }).status, 'failed');
  const final = await controller.invoke('finalize_candidate', { choice: 'revert', reason: 'Candidate failed; retain valid baseline' }, 'test');
  assert.equal(final.outcome, 'candidate_failed');
  assert.deepEqual(exported, ['baseline']);
});

test('final-test, arbitrary command and external path overrides are rejected before execution', async t => {
  const { controller, trained } = await fixture(t);
  for (const [name, input] of [
    ['run_baseline', { split: 'final-test' }], ['run_candidate', { command: 'evil' }],
    ['get_run_result', { path: 'tests/fixtures/reference' }], ['judge', {}],
  ] as const) await assert.rejects(controller.invoke(name, input, 'test'), /Permission denied/);
  assert.deepEqual(trained, []);
});

test('acceptance does not confuse a correctly handled failed candidate with a broken workflow', () => {
  const fixtureCalls = [
    { id: '0', name: 'inspect_task', args: {}, isError: false },
    { id: '1', name: 'read_candidate_file', args: { path: 'model.py' }, isError: false },
    { id: '2', name: 'run_baseline', args: {}, isError: false },
    { id: '3', name: 'edit_candidate_file', args: { rationale: 'own proposal' }, isError: false },
    { id: '4', name: 'run_checks', args: { action: 'smoke' }, isError: false },
    { id: '5', name: 'run_candidate', args: {}, isError: true },
    { id: '6', name: 'get_run_result', args: {}, isError: false },
    { id: '7', name: 'finalize_candidate', args: { choice: 'revert' }, isError: false },
    { id: '8', name: 'show_diff', args: {}, isError: false },
  ];
  assert.ok(Object.values(optimizeAcceptance(fixtureCalls, { choice: 'revert', validation_only: true, final_test_used: false })).every(Boolean));
  assert.equal(optimizeAcceptance([], undefined).one_agent_candidate, false);
});
