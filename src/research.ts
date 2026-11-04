import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

export interface Run {
  runId: string;
  codeRevision: string;
  dataset: string;
  protocol: string;
  seed: number;
  config: Record<string, unknown>;
  metrics: Array<{ name: string; value: number; artifact: string; key: string }>;
}
export interface Evidence {
  runId: string; name: string; value: number; artifact: string;
  status: 'verified' | 'unverified'; reason: string; sha256?: string;
}
export interface Registry { schemaVersion: 1; runs: Run[]; evidence: Evidence[] }

// 只接受明确的实验结构，避免把缺失元信息当成有效实验记录。
export function parseRuns(value: unknown): Run[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('实验清单必须是非空数组');
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new Error('实验记录必须是对象');
    const run = item as Run;
    for (const field of ['runId', 'codeRevision', 'dataset', 'protocol'] as const) {
      if (typeof run[field] !== 'string' || !run[field].trim()) throw new Error(`缺少字段 ${field}`);
    }
    if (ids.has(run.runId)) throw new Error(`重复 runId: ${run.runId}`);
    ids.add(run.runId);
    if (!Number.isInteger(run.seed) || !run.config || typeof run.config !== 'object' || Array.isArray(run.config)) throw new Error('seed 或 config 无效');
    if (!Array.isArray(run.metrics) || run.metrics.length === 0) throw new Error('缺少 metrics');
    const names = new Set<string>();
    for (const metric of run.metrics) {
      if (!metric || !['name', 'artifact', 'key'].every((key: string): boolean => typeof (metric as unknown as Record<string, unknown>)[key] === 'string' && String((metric as unknown as Record<string, unknown>)[key]).trim().length > 0) || !Number.isFinite(metric.value)) throw new Error('指标结构无效');
      if (names.has(metric.name)) throw new Error(`重复指标: ${metric.name}`);
      names.add(metric.name);
    }
  }
  return value as Run[];
}

// 对真实路径做边界检查，同时阻止相对路径穿越和符号链接越界。
export async function importRuns(manifest: string): Promise<Registry> {
  const root = await realpath(dirname(resolve(manifest)));
  const runs = parseRuns(JSON.parse(await readFile(manifest, 'utf8')) as unknown);
  const evidence: Evidence[] = [];
  for (const run of runs) {
    for (const metric of run.metrics) {
      const entry: Evidence = { runId: run.runId, name: metric.name, value: metric.value, artifact: metric.artifact, status: 'unverified', reason: '' };
      try {
        const path = await realpath(resolve(root, metric.artifact));
        const offset = relative(root, path);
        if (offset === '..' || offset.startsWith('../') || offset.startsWith('..\\') || isAbsolute(offset)) throw new Error('来源文件超出实验目录');
        const bytes = await readFile(path);
        const source = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        if (source[metric.key] !== metric.value) throw new Error('来源指标与清单不一致');
        entry.status = 'verified';
        entry.sha256 = createHash('sha256').update(bytes).digest('hex');
        entry.reason = '已核对来源数值；不代表实验真实性已审计';
      } catch (error: unknown) {
        entry.reason = error instanceof Error ? error.message : String(error);
      }
      evidence.push(entry);
    }
  }
  return { schemaVersion: 1, runs, evidence };
}

// 数据集与评估协议不同则拒绝汇总；代码、种子和配置保留给读者检查。
export function exportTable(registry: Registry, format: string): string {
  if (!['markdown', 'csv', 'latex'].includes(format)) throw new Error('格式仅支持 markdown / csv / latex');
  if (new Set(registry.runs.map((run: Run): string => JSON.stringify([run.dataset, run.protocol]))).size > 1) throw new Error('数据集或评估协议不同，不能生成对比表');
  const rows: string[][] = [['run', 'dataset', 'protocol', 'revision', 'seed', 'config', 'metric', 'value', 'status', 'source', 'sha256', 'note']];
  for (const item of registry.evidence) {
    const run = registry.runs.find((candidate: Run): boolean => candidate.runId === item.runId);
    if (!run) throw new Error('指标缺少对应实验');
    rows.push([run.runId, run.dataset, run.protocol, run.codeRevision, String(run.seed), JSON.stringify(run.config), item.name, String(item.value), item.status, item.artifact, item.sha256 ?? '', item.reason]);
  }
  if (format === 'csv') return rows.map((row: string[]): string => row.map((cell: string): string => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';
  if (format === 'latex') {
    const escaped = rows.map((row: string[]): string => row.map((cell: string): string => cell.replace(/[\\&%$#_{}~^]/g, (char: string): string => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' }[char] ?? `\\${char}`))).join(' & ') + ' \\\\');
    return `\\begin{tabular}{${'l'.repeat(rows[0]!.length)}}\n${escaped.join('\n')}\n\\end{tabular}\n`;
  }
  const lines = rows.map((row: string[]): string => '| ' + row.map((cell: string): string => cell.replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')).join(' | ') + ' |');
  lines.splice(1, 0, '| ' + rows[0]!.map((): string => '---').join(' | ') + ' |');
  return lines.join('\n') + '\n';
}
