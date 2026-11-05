import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smokeAcceptance } from '../src/agent/smoke-agent.js';

// Synthetic event fixtures test the checker only; they are NOT live Tool Calling evidence.
const calls = () => [
  { id: '1', name: 'read_candidate_file', args: { path: 'model.py' }, isError: false },
  { id: '2', name: 'edit_candidate_file', args: { path: 'model.py' }, isError: false, result: { details: { policy: { kind: 'mlp' } } } },
  { id: '3', name: 'run_checks', args: { action: 'smoke' }, isError: false, result: { details: { status: 'executed' } } },
  { id: '4', name: 'read_smoke_result', args: {}, isError: false, result: { details: { status: 'passed', epochs: 2, train_samples: 16 } } },
  { id: '5', name: 'show_diff', args: {}, isError: false },
  { id: '6', name: 'edit_candidate_file', args: { path: '../outside-sentinel.txt' }, isError: true },
  { id: '7', name: 'run_checks', args: { action: 'python -c "print(123)"' }, isError: true },
];

test('WP-02 acceptance requires the full ordered tool chain and negative probes', () => {
  assert.ok(Object.values(smokeAcceptance(calls())).every(Boolean));
  assert.ok(Object.values(smokeAcceptance([])).every(value => !value));
  const noPermissionProbe = calls().slice(0, 5);
  assert.equal(smokeAcceptance(noPermissionProbe).outside_write_blocked, false);
  const unordered = calls();
  [unordered[0], unordered[1]] = [unordered[1]!, unordered[0]!];
  assert.equal(smokeAcceptance(unordered).ordered_read_edit_smoke_result, false);
});

test('WP-02 does not accept a successful tool label without actual result details', () => {
  const missing = calls().map(({ result: _result, ...call }) => call);
  assert.equal(smokeAcceptance(missing).mlp_edit, false);
  assert.equal(smokeAcceptance(missing).smoke_executed, false);
  assert.equal(smokeAcceptance(missing).result_read, false);
  const wrongScope = calls();
  wrongScope[3]!.result = { details: { status: 'passed', epochs: 80, train_samples: 1024 } };
  assert.equal(smokeAcceptance(wrongScope).result_read, false);
});
