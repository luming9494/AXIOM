import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fallbackPolicy, NIM_PROVIDER, redactModelSecrets } from './model-provider.js';

export interface RoutingState { usingFallback: boolean }

// A bare 429 is commonly transient RPM/TPM limiting, NOT proof of exhausted credits.
// Require both an explicit quota/credit error and no generated output.
export function isQuotaRejection(message: AssistantMessage): boolean {
  if (message.provider !== NIM_PROVIDER || message.stopReason !== 'error' || message.content.length || message.usage.totalTokens > 0) return false;
  const error = (message.errorMessage || '').trim();
  // Locked Pi/OpenAI normalizer prefixes the actual HTTP status. Do not use a
  // status number merely echoed inside a validation error or user payload.
  if (!/^(?:402|429)\b/.test(error)) return false;
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.api.key|timeout|timed out|ECONN|context.length|content.filter|rate_limit_exceeded|requests per minute|tokens per minute/i.test(error)) return false;
  return /\binsufficient_quota\b|\b(?:credits?|quota|free[ -]tier|free[ -]usage|free[ -]requests?)\b.{0,70}\b(?:exhausted|depleted|used up|expired)\b|\b(?:exhausted|depleted)\b.{0,40}\b(?:credits?|quota)\b|\b(?:insufficient|no remaining)\s+credits?\b|免费额度(?:已)?(?:用完|耗尽)|积分(?:已)?耗尽/i.test(error);
}

// Install AFTER the caller's request/budget guard. Both primary and fallback
// invoke that same guarded stream; failover never retries tools or training.
export function installProviderFallback(session: AgentSession, runtime: ModelRuntime, options: {
  state?: RoutingState;
  onEvent?: (event: Record<string, unknown>) => void;
  onQuotaRejected?: () => void;
  env?: NodeJS.ProcessEnv;
} = {}): RoutingState {
  const env = options.env ?? process.env;
  const policy = fallbackPolicy(env);
  const key = env.DEEPSEEK_API_KEY?.trim();
  const state = options.state ?? { usingFallback: false };
  const guarded = session.agent.streamFunction;
  const record = (event: Record<string, unknown>) => options.onEvent?.(JSON.parse(redactModelSecrets(JSON.stringify(event), key ? [key] : [])));
  const officialModel = () => {
    if (!policy.enabled || !key) throw new Error('NIM 额度耗尽，但官方备用未启用或未配置 DEEPSEEK_API_KEY');
    runtime.registerProvider('deepseek', { apiKey: key });
    const model = runtime.getModel('deepseek', policy.model);
    if (!model) throw new Error('DEEPSEEK_MODEL 不在锁定 SDK 官方模型列表内');
    return model;
  };
  session.agent.streamFunction = async (selected, context, streamOptions) => {
    const official = async () => {
      streamOptions?.signal?.throwIfAborted();
      const model = officialModel();
      record({ type: 'provider_selected', provider: model.provider, model: model.id, paid: true });
      // Never forward the NIM Authorization override to the official endpoint.
      return guarded(model, context, { ...streamOptions, apiKey: key });
    };
    if (state.usingFallback) return official();
    if (selected.provider !== NIM_PROVIDER) return guarded(selected, context, streamOptions);
    const stream = await guarded(selected, context, streamOptions);
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    const message = await stream.result();
    const emittedContent = events.some(event => event.type !== 'start' && event.type !== 'error');
    if (isQuotaRejection(message) && !emittedContent && !streamOptions?.signal?.aborted && policy.enabled && key) {
      // Validate the fallback model before changing route or consuming another request.
      officialModel();
      options.onQuotaRejected?.();
      state.usingFallback = true;
      record({ type: 'provider_fallback', from: NIM_PROVIDER, to: 'deepseek', model: policy.model, reason: 'explicit_quota_exhaustion', paid: true, primary_error: message.errorMessage });
      return official(); // Exactly one fallback; official failure is returned, not retried.
    }
    const replay = createAssistantMessageEventStream();
    for (const event of events) replay.push(event);
    replay.end(message);
    return replay;
  };
  return state;
}
