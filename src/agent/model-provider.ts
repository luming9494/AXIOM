import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type ModelProvider = 'deepseek' | 'nvidia-nim';
export const NIM_PROVIDER = 'nvidia-nim';
export const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const NIM_MODEL = 'deepseek-ai/deepseek-v4.1-flash';
export function modelRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.AXIOM_MODEL_TIMEOUT_SECONDS?.trim() || '120');
  if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 180) throw new Error('AXIOM_MODEL_TIMEOUT_SECONDS 必须为 5–180 的整数');
  return seconds * 1000;
}

export function redactModelSecrets(text: string, extra: string[] = []): string {
  for (const secret of [...extra, process.env.NVIDIA_API_KEY, process.env.DEEPSEEK_API_KEY]) {
    if (secret?.trim()) text = text.replaceAll(secret.trim(), '[REDACTED]');
  }
  return text;
}

export function fallbackPolicy(env: NodeJS.ProcessEnv = process.env) {
  const flag = env.AXIOM_DEEPSEEK_FALLBACK?.trim() || 'true';
  if (!['true', 'false'].includes(flag)) throw new Error('AXIOM_DEEPSEEK_FALLBACK 必须为 true 或 false');
  return { enabled: flag === 'true', configured: !!env.DEEPSEEK_API_KEY?.trim(), provider: 'deepseek', model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash', paid: true };
}

export const NIM_PRICING_NOTE = 'NVIDIA NIM development endpoint; availability/quota/pricing unverified. SDK zero cost metadata is a placeholder, not a verified bill.';

export function modelPricingNote(provider: string): string {
  return provider === NIM_PROVIDER ? NIM_PRICING_NOTE : 'DeepSeek official paid API; SDK costs are estimates, not verified billing.';
}

export function nimSettings(env: NodeJS.ProcessEnv = process.env) {
  const baseUrl = (env.NVIDIA_NIM_BASE_URL?.trim() || NIM_BASE_URL).replace(/\/+$/, '');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('NVIDIA_NIM_BASE_URL 必须是无凭据、查询或片段的 HTTPS URL');
  const modelId = env.NVIDIA_NIM_MODEL?.trim() || NIM_MODEL;
  return { provider: NIM_PROVIDER, baseUrl, modelId };
}

export function modelSettings(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.AXIOM_MODEL_PROVIDER?.trim() || 'deepseek';
  if (provider === NIM_PROVIDER) return nimSettings(env);
  if (provider !== 'deepseek') throw new Error('AXIOM_MODEL_PROVIDER 必须为 deepseek 或 nvidia-nim');
  return { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelId: env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash' };
}

export function modelCredentials(env: NodeJS.ProcessEnv = process.env) {
  const settings = modelSettings(env);
  if (settings.provider === NIM_PROVIDER) return nimCredentials(env);
  const key = env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error('请在本地 .env 中填写 DEEPSEEK_API_KEY；当前默认使用 DeepSeek 官方接口，不自动改用 NIM');
  return { ...settings, key };
}

export function registerConfiguredModel(runtime: ModelRuntime, key: string, modelId = modelSettings().modelId, provider = modelSettings().provider) {
  if (provider === NIM_PROVIDER) return registerNim(runtime, key, modelId);
  if (provider !== 'deepseek') throw new Error('Unsupported model provider');
  runtime.registerProvider('deepseek', { apiKey: key });
  const model = runtime.getModel('deepseek', modelId);
  if (!model) throw new Error('DEEPSEEK_MODEL 不在锁定 SDK 官方模型列表内');
  return model;
}

export function nimCredentials(env: NodeJS.ProcessEnv = process.env) {
  const settings = nimSettings(env);
  const key = env.NVIDIA_API_KEY?.trim();
  if (!key) throw new Error('请在本地 .env 中填写 NVIDIA_API_KEY（NVIDIA Build 平台申请）；主 Key 缺失时不会直接使用付费备用');
  return { ...settings, key };
}

export function registerNim(runtime: ModelRuntime, key: string, modelId = nimSettings().modelId) {
  const { provider, baseUrl } = nimSettings();
  runtime.registerProvider(provider, {
    name: 'NVIDIA NIM', api: 'openai-completions', baseUrl, apiKey: key,
    models: [{
      id: modelId, name: modelId, reasoning: false, input: ['text'],
      // Conservative client limits, not claims about the server's actual maximums.
      contextWindow: 32768, maxTokens: 4096,
      // Pi requires numeric cost metadata. Actual free quota/billing is not inferred from these zeros.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error('NVIDIA NIM 模型注册失败');
  return model;
}
