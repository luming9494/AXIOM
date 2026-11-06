import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { isQuotaRejection } from '../src/agent/provider-fallback.js';
import { fallbackPolicy, NIM_MODEL, NIM_PROVIDER } from '../src/agent/model-provider.js';
import { piDecision } from '../src/agent/task-decision.js';
import { TaskBudget } from '../src/execution/task-budget.js';
import { DEFAULT_BUDGET, TASK_RULES, validateTaskSpec } from '../src/execution/task-spec.js';

function rejection(errorMessage: string): AssistantMessage {
  return { role: 'assistant', api: 'openai-completions', provider: NIM_PROVIDER, model: NIM_MODEL, content: [], stopReason: 'error', errorMessage, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
test('only explicit quota rejection permits paid fallback, not bare throttling/auth/timeout/partial results', () => {
  for (const error of ['429 insufficient_quota', '402 credits exhausted', '429 You have exhausted your credits']) assert.equal(isQuotaRejection(rejection(error)), true);
  for (const error of ['429 Too Many Requests', '429 rate_limit_exceeded', '401 insufficient_quota', '403 Forbidden', '500 insufficient_quota', '400 invalid input: 429 insufficient_quota', 'Timeout credits exhausted', '429 tokens per minute quota exhausted', 'insufficient_quota']) assert.equal(isQuotaRejection(rejection(error)), false);
  const partial = rejection('429 insufficient_quota'); partial.content = [{ type: 'text', text: 'partial output' }];
  assert.equal(isQuotaRejection(partial), false);
  const charged = rejection('429 insufficient_quota'); charged.usage.totalTokens = 1;
  assert.equal(isQuotaRejection(charged), false);
  assert.equal(fallbackPolicy({ AXIOM_DEEPSEEK_FALLBACK: 'false', DEEPSEEK_API_KEY: 'fake' }).enabled, false);
  assert.throws(() => fallbackPolicy({ AXIOM_DEEPSEEK_FALLBACK: 'maybe' }), /true 或 false/);
});

// Entire transport is mocked: no real free quota consumed and no paid request.
async function fixture(t: { after: (fn: () => unknown) => void }, maxTokens = 100_000, primaryError = 'insufficient_quota', enabled = true, officialFails = false) {
  const root = await mkdtemp(join(tmpdir(), 'axiom-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldFetch = globalThis.fetch;
  const names = ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'AXIOM_DEEPSEEK_FALLBACK'] as const;
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.DEEPSEEK_API_KEY = 'fake-paid-key'; process.env.DEEPSEEK_MODEL = 'deepseek-flash'; process.env.AXIOM_DEEPSEEK_FALLBACK = String(enabled);
  t.after(() => { globalThis.fetch = oldFetch; for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init); calls.push({ url: req.url, authorization: req.headers.get('authorization') });
    if (req.headers.get('authorization') === 'Bearer fake-nim-key') return new Response(JSON.stringify({ error: { code: primaryError, message: primaryError } }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    if (officialFails) return new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    const frame = (delta: unknown, finish_reason: string | null = null) => ({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] });
    const frames = [frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name: 'propose_candidate', arguments: JSON.stringify({ content: 'fake-source', rationale: 'mock transport test only' }) } }] }), frame({}, 'tool_calls'), { id: 'mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }];
    return new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const spec = validateTaskSpec({ version: 1, task: 'tiny-xor-v1', goal: 'offline fallback regression', target_accuracy: null, rules: TASK_RULES, budget: { ...DEFAULT_BUDGET, max_tokens: maxTokens } });
  const budget = new TaskBudget(spec), routing = { usingFallback: false };
  const run = () => piDecision({ root, key: 'fake-nim-key', modelId: NIM_MODEL, provider: NIM_PROVIDER, prompt: 'offline', system: 'offline', kind: 'candidate', budget, signal: AbortSignal.timeout(10_000), routing, validate: value => value });
  return { run, root, calls, budget, routing };
}

test('quota exhausted switches key/provider once; sticky route, actual usage and both secrets are protected', async t => {
  const f = await fixture(t);
  assert.equal((await f.run() as { content: string }).content, 'fake-source');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.authorization, 'Bearer fake-nim-key');
  assert.equal(f.calls[1]!.authorization, 'Bearer fake-paid-key');
  assert.equal(new URL(f.calls[1]!.url).hostname, 'api.deepseek.com');
  assert.equal(f.routing.usingFallback, true);
  assert.equal(f.budget.requests, 2);
  assert.ok(f.budget.tokens > 30, 'Conservatively charge primary reservation, not false zero');
  await f.run();
  assert.equal(f.calls.length, 3, 'Next decision directly uses sticky official route');
  assert.equal(f.calls[2]!.authorization, 'Bearer fake-paid-key');
  const log = await readFile(join(f.root, 'pi-events.jsonl'), 'utf8');
  assert.ok(log.includes('provider_fallback'));
  assert.equal(log.includes('fake-paid-key'), false);
  assert.equal(log.includes('fake-nim-key'), false);
});

test('fallback cannot bypass Token budget: no paid HTTP request when second reservation cannot fit', async t => {
  const f = await fixture(t, 20_000);
  await assert.rejects(f.run(), /token_budget_exhausted/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.budget.requests, 1);
});

test('temporary rate limiting does not trigger a paid request', async t => {
  const f = await fixture(t, 100_000, 'rate_limit_exceeded');
  await assert.rejects(f.run());
  assert.equal(f.calls.length, 1);
});

test('explicit opt-out does not trigger a paid request', async t => {
  const f = await fixture(t, 100_000, 'insufficient_quota', false);
  await assert.rejects(f.run());
  assert.equal(f.calls.length, 1);
});

test('missing official key never triggers a paid request', async t => {
  const f = await fixture(t);
  delete process.env.DEEPSEEK_API_KEY;
  await assert.rejects(f.run());
  assert.equal(f.calls.length, 1);
  assert.equal(f.routing.usingFallback, false);
});

test('official upstream failure is not retried or switched back', async t => {
  const f = await fixture(t, 100_000, 'insufficient_quota', true, true);
  await assert.rejects(f.run());
  assert.equal(f.calls.length, 2);
});
