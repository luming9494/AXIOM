import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { nimCredentials, nimSettings, registerNim, NIM_BASE_URL, NIM_MODEL, NIM_PROVIDER, modelCredentials, modelSettings, registerConfiguredModel, modelRequestTimeoutMs } from '../src/agent/model-provider.js';
import { piDecision } from '../src/agent/task-decision.js';
import { TaskBudget } from '../src/execution/task-budget.js';
import { DEFAULT_BUDGET, TASK_RULES, validateTaskSpec } from '../src/execution/task-spec.js';

test('official is the default; NIM requires explicit selection and credentials are isolated', () => {
  assert.deepEqual(modelSettings({}), { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-flash' });
  assert.equal(modelCredentials({ DEEPSEEK_API_KEY: 'fake-official', NVIDIA_API_KEY: 'fake-nim' }).key, 'fake-official');
  assert.equal(modelCredentials({ AXIOM_MODEL_PROVIDER: 'nvidia-nim', NVIDIA_API_KEY: 'fake-nim' }).provider, NIM_PROVIDER);
  assert.throws(() => modelCredentials({ NVIDIA_API_KEY: 'fake-nim' }), /DEEPSEEK_API_KEY/);
  assert.throws(() => modelSettings({ AXIOM_MODEL_PROVIDER: 'unknown' }), /AXIOM_MODEL_PROVIDER/);
  assert.equal(modelRequestTimeoutMs({}), 120000);
  for (const seconds of ['0', '181', 'NaN', '1.5']) assert.throws(() => modelRequestTimeoutMs({ AXIOM_MODEL_TIMEOUT_SECONDS: seconds }), /AXIOM_MODEL_TIMEOUT_SECONDS/);
});

test('NIM defaults and credentials never fall back to official DeepSeek', () => {
  assert.deepEqual(nimSettings({}), { provider: NIM_PROVIDER, baseUrl: NIM_BASE_URL, modelId: NIM_MODEL });
  assert.throws(() => nimCredentials({ DEEPSEEK_API_KEY: 'old-key', DEEPSEEK_MODEL: 'deepseek-flash' }), /NVIDIA_API_KEY/);
  assert.equal(nimCredentials({ NVIDIA_API_KEY: ' fake-nim-key ' }).key, 'fake-nim-key');
  for (const base of ['http://example.com/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret']) assert.throws(() => nimSettings({ NVIDIA_NIM_BASE_URL: base }), /HTTPS URL/);
});

test('NIM model is explicitly registered as OpenAI Chat Completions without network discovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'axiom-nim-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const model = registerNim(runtime, 'fake-test-key');
  assert.equal(model.provider, NIM_PROVIDER);
  assert.equal(model.id, process.env.NVIDIA_NIM_MODEL?.trim() || NIM_MODEL);
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.baseUrl, nimSettings().baseUrl);
  const official = registerConfiguredModel(runtime, 'fake-official', 'deepseek-flash', 'deepseek');
  assert.equal(official.provider, 'deepseek');
  assert.equal(official.id, 'deepseek-flash');
  assert.equal(new URL(official.baseUrl).hostname, 'api.deepseek.com');
});

test('mock NIM SSE function call travels through real Pi SDK; no external API call', async t => {
  const root = await mkdtemp(join(tmpdir(), 'axiom-nim-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, any>; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: JSON.parse(await request.text()), authorization: request.headers.get('authorization') });
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: NIM_MODEL, choices: [{ index: 0, delta, finish_reason }] });
    const frames = [
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'mock-call', type: 'function', function: { name: 'propose_candidate', arguments: JSON.stringify({ content: 'offline-source', rationale: 'offline mock, not a real model result' }) } }] }),
      chunk({}, 'tool_calls'),
      { id: 'mock-completion', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    ];
    return new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  t.after(() => { globalThis.fetch = original; });
  const task = validateTaskSpec({ version: 1, task: 'tiny-xor-v1', goal: 'offline wire test', target_accuracy: null, rules: TASK_RULES, budget: DEFAULT_BUDGET });
  const budget = new TaskBudget(task);
  const result = await piDecision({ root, key: 'fake-test-key', modelId: NIM_MODEL, provider: NIM_PROVIDER, prompt: 'offline test', system: 'Submit the candidate tool', kind: 'candidate', budget, signal: AbortSignal.timeout(10_000), validate: value => value });
  assert.equal((result as { content: string }).content, 'offline-source');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, nimSettings().baseUrl + '/chat/completions');
  assert.equal(requests[0]!.authorization, 'Bearer fake-test-key');
  assert.equal(requests[0]!.body.model, NIM_MODEL);
  assert.equal(requests[0]!.body.tools[0].function.name, 'propose_candidate');
  assert.equal(budget.tokens, 30);
});
