import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piDecision } from '../src/agent/task-decision.js';
import { NIM_MODEL } from '../src/agent/model-provider.js';
import { TaskBudget } from '../src/execution/task-budget.js';
import { DEFAULT_BUDGET, TASK_RULES, validateTaskSpec } from '../src/execution/task-spec.js';

test('Pi request is refused before network when token reservation does not fit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'axiom-token-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Offline test forbids all network calls'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const spec = validateTaskSpec({ version: 1, task: 'tiny-xor-v1', goal: 'offline admission test', target_accuracy: null, rules: TASK_RULES, budget: { ...DEFAULT_BUDGET, max_tokens: 1 } });
  const budget = new TaskBudget(spec);
  await assert.rejects(piDecision({ root, key: 'offline-not-a-real-key', modelId: NIM_MODEL, provider: 'nvidia-nim', prompt: 'offline test', system: 'offline test', kind: 'candidate', budget, signal: new AbortController().signal, validate: value => value }), /token_budget_exhausted/);
  assert.equal(networkCalls, 0);
  assert.equal(budget.requests, 0);
  assert.equal(budget.tokens, 0);
  const events = await readFile(join(root, 'pi-events.jsonl'), 'utf8');
  assert.equal(events.includes('"type":"model_request"'), false);
});
