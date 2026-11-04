import type { Registry, Run } from '../../../src/research';
import manifest from '../../../examples/synthetic-experiment/manifest.json' with { type: 'json' };

// 演示不附带校验状态：浏览器没有访问原始来源文件，不能冒充 CLI 核验。
export function demoRegistry(): Registry {
  const runs: Run[] = structuredClone(manifest);
  return { schemaVersion: 1, runs, evidence: runs.flatMap(run => run.metrics.map(metric => ({
    runId: run.runId, name: metric.name, value: metric.value, artifact: metric.artifact,
    status: 'unverified' as const, reason: '公开合成示例；浏览器尚未核验来源文件',
  }))) };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && !!value.trim(); }

// 对整个结构及关联做校验，拒绝不完整 Registry，绝不执行导入内容。
export function parseRegistry(value: unknown): Registry {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.runs) || !value.runs.length || !Array.isArray(value.evidence)) throw new Error('需要 schemaVersion: 1 的 Registry JSON，请先使用 CLI import 生成。');
  const ids = new Set<string>();
  for (const run of value.runs) {
    if (!object(run) || !text(run.runId) || !text(run.dataset) || !text(run.protocol) || !text(run.codeRevision) || !Number.isInteger(run.seed) || !object(run.config) || !Array.isArray(run.metrics) || !run.metrics.length) throw new Error('实验结构无效，请检查元信息与 metrics。');
    if (ids.has(run.runId)) throw new Error('存在重复 runId。');
    ids.add(run.runId);
    const names = new Set<string>();
    for (const metric of run.metrics) {
      if (!object(metric) || !text(metric.name) || !text(metric.artifact) || !text(metric.key) || typeof metric.value !== 'number' || !Number.isFinite(metric.value) || names.has(metric.name)) throw new Error('指标结构无效或名称重复。');
      names.add(metric.name);
    }
  }
  const registry = value as unknown as Registry;
  const pairs = new Set<string>();
  for (const item of value.evidence) {
    if (!object(item) || !text(item.runId) || !text(item.name) || !text(item.artifact) || typeof item.value !== 'number' || !Number.isFinite(item.value) || !['verified', 'unverified'].includes(String(item.status)) || typeof item.reason !== 'string' || (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)))) throw new Error('证据记录无效。');
    const run = registry.runs.find(run => run.runId === item.runId);
    const metric = run?.metrics.find(metric => metric.name === item.name);
    const pair = JSON.stringify([item.runId, item.name]);
    if (!metric || metric.value !== item.value || metric.artifact !== item.artifact || pairs.has(pair) || (item.status === 'verified' && !item.sha256)) throw new Error('证据与实验不匹配、重复或缺少哈希。');
    pairs.add(pair);
  }
  if (pairs.size !== registry.runs.reduce((sum, run) => sum + run.metrics.length, 0)) throw new Error('Registry 缺少指标对应的证据记录。');
  return registry;
}

export function download(content: string, name: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
