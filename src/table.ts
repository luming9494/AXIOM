import type { Registry } from './research.js';

// CLI 与 Web 共用的纯函数；不访问文件系统，也不重新认证导入的证据。
export function exportTable(registry: Registry, format: string): string {
  if (!['markdown', 'csv', 'latex'].includes(format)) throw new Error('格式仅支持 markdown / csv / latex');
  if (new Set(registry.runs.map((run): string => JSON.stringify([run.dataset, run.protocol]))).size > 1) throw new Error('数据集或评估协议不同，不能生成对比表');
  const rows: string[][] = [['run', 'dataset', 'protocol', 'revision', 'seed', 'config', 'metric', 'value', 'status', 'source', 'sha256', 'note']];
  for (const item of registry.evidence) {
    const run = registry.runs.find((candidate): boolean => candidate.runId === item.runId);
    if (!run) throw new Error('指标缺少对应实验');
    rows.push([run.runId, run.dataset, run.protocol, run.codeRevision, String(run.seed), JSON.stringify(run.config), item.name, String(item.value), item.status, item.artifact, item.sha256 ?? '', item.reason]);
  }
  if (format === 'csv') return rows.map((row): string => row.map((cell): string => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';
  if (format === 'latex') {
    const escaped = rows.map((row): string => row.map((cell): string => cell.replace(/[\\&%$#_{}~^]/g, (char): string => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' }[char] ?? `\\${char}`))).join(' & ') + ' \\\\');
    return `\\begin{tabular}{${'l'.repeat(rows[0]!.length)}}\n${escaped.join('\n')}\n\\end{tabular}\n`;
  }
  const lines = rows.map((row): string => '| ' + row.map((cell): string => cell.replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')).join(' | ') + ' |');
  lines.splice(1, 0, '| ' + rows[0]!.map((): string => '---').join(' | ') + ' |');
  return lines.join('\n') + '\n';
}
