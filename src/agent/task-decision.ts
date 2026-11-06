import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, createExtensionRuntime, defineTool, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { BudgetStop, TaskBudget } from '../execution/task-budget.js';
import { registerConfiguredModel, modelPricingNote, redactModelSecrets, modelRequestTimeoutMs } from './model-provider.js';
import { installProviderFallback, type RoutingState } from './provider-fallback.js';

// Pi owns the model/tool loop. The domain controller only requests one decision,
// then runs the CPU worker with no active model session or polling requests.
export async function piDecision(options: { root: string; key: string; modelId: string; provider?: string; prompt: string; system: string; kind: 'plan' | 'candidate'; budget: TaskBudget; signal: AbortSignal; routing?: RoutingState; validate: (value: Record<string, unknown>) => unknown }): Promise<unknown> {
  const { root, key, budget, signal } = options;
  const requestTimeoutMs = modelRequestTimeoutMs();
  const redact = (value: unknown) => redactModelSecrets(JSON.stringify(value), [key]);
  const record = (event: unknown) => appendFileSync(join(root, 'pi-events.jsonl'), redact({ phase: options.kind, timestamp: new Date().toISOString(), event }) + '\n');
  signal.throwIfAborted(); budget.check();
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const model = registerConfiguredModel(runtime, key, options.modelId, options.provider);
  let captured: unknown;
  const name = options.kind === 'plan' ? 'submit_task_spec' : 'propose_candidate';
  const tool = defineTool({
    name, label: name, description: 'Submit exactly one host-validated decision. This tool cannot train, read files, change budgets or access network.', executionMode: 'sequential',
    parameters: options.kind === 'plan' ? Type.Object({ spec: Type.Unknown() }, { additionalProperties: false }) : Type.Object({ content: Type.String({ maxLength: 8192 }), rationale: Type.String({ maxLength: 2000 }) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      if (captured !== undefined) throw new Error('One decision only');
      captured = options.validate(params as Record<string, unknown>);
      return { content: [{ type: 'text', text: 'Decision received; host takes control.' }], details: { accepted: true } };
    },
  });
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.system, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd: root, agentDir: join(root, 'pi'), modelRuntime: runtime, model, thinkingLevel: 'off', resourceLoader: loader,
    tools: [name], customTools: [tool], sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: requestTimeoutMs } } }),
  });
  let pending = false, localRequests = 0;
  let blocked: BudgetStop | undefined;
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (selected, context, streamOptions) => {
    if (captured !== undefined) throw new Error('Host decision already received');
    signal.throwIfAborted();
    if (++localRequests > 2) { blocked = new BudgetStop('decision_request_limit'); throw blocked; }
    const bound = Buffer.byteLength(JSON.stringify(context), 'utf8') + 8192;
    try { budget.reserveTokens(bound, 2048); }
    catch (error) { if (error instanceof BudgetStop) blocked = error; throw error; }
    pending = true;
    record({ type: 'model_request', provider: selected.provider, model: selected.id, timeoutMs: requestTimeoutMs, reserved: bound + 2048, budget: budget.snapshot() });
    return stream(selected, context, { ...streamOptions, maxTokens: 2048 });
  };
  installProviderFallback(session, runtime, {
    state: options.routing, onEvent: record,
    onQuotaRejected: () => {
      budget.chargeQuotaRejection(); pending = false;
      record({ type: 'quota_rejection_charged', accounting: 'full_request_reservation', budget: budget.snapshot() });
      console.warn('NVIDIA NIM 额度耗尽，尝试 DeepSeek 官方备用（按量计费，仍受任务预算限制）。');
    },
  });
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      if (pending) {
        const usage = event.message.usage;
        const actual = event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted' && usage && usage.totalTokens > 0 ? usage.totalTokens : undefined;
        budget.settleTokens(actual); pending = false;
      }
      record({ type: 'assistant_message', message: { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage, content: event.message.content.filter(block => block.type !== 'thinking'), usage: event.message.usage }, budget: budget.snapshot() });
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      record(event);
      if (event.type === 'tool_execution_end' && !event.isError && captured !== undefined) { record({ type: 'host_decision_received' }); void session.abort(); }
    }
  });
  const abort = () => { void session.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, Math.min(requestTimeoutMs * 2, budget.remainingWallMs)));
  try {
    if (JSON.stringify(session.getActiveToolNames()) !== JSON.stringify([name])) throw new Error('Unexpected active tools');
    record({ type: 'decision_start', prompt: options.prompt, system: options.system, tools: [name], provider: model.provider, baseUrl: model.baseUrl, model: options.modelId, pricing_note: modelPricingNote(model.provider) });
    await session.prompt(options.prompt);
    signal.throwIfAborted();
    if (blocked) throw blocked;
    if (budget.uncertain) throw new BudgetStop('token_usage_uncertain');
    if (captured === undefined) throw new Error('Agent did not submit a valid decision');
    return captured;
  } catch (error) {
    if (error instanceof BudgetStop) throw error;
    throw new Error(redactModelSecrets(String(error), [key]));
  } finally {
    if (pending) budget.settleTokens(undefined);
    clearTimeout(timer); signal.removeEventListener('abort', abort); unsubscribe(); session.dispose();
    record({ type: 'decision_session_disposed', budget: budget.snapshot() });
  }
}
