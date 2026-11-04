import { writeFile } from 'node:fs/promises';
import { exportTable, importRuns } from './research.js';

// 默认离线运行，每次重新读取来源文件，避免沿用过期的验证状态。
async function main(args: string[]): Promise<void> {
  const [command, manifest, output, format = 'markdown'] = args;
  if (command === 'ask' && manifest && output) {
    // 在加载 SDK 前检查版本，避免旧 Node 在依赖初始化期间直接崩溃。
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('Pi SDK 需要 Node.js >=22.19.0');
    const { ask } = await import('./agent.js');
    console.log(await ask(manifest, args.slice(2).join(' ')));
    return;
  }
  if (!['import', 'export'].includes(command ?? '') || !manifest || !output || args.length > 4) {
    throw new Error('用法: npm run axiom -- import <manifest.json> <registry.json> | export <manifest.json> <table> [markdown|csv|latex] | ask <manifest.json> <问题>');
  }
  const registry = await importRuns(manifest);
  await writeFile(output, command === 'import' ? JSON.stringify(registry, null, 2) + '\n' : exportTable(registry, format), { encoding: 'utf8', flag: 'wx' });
  console.log(`已生成 ${output}；${registry.evidence.filter((item): boolean => item.status === 'unverified').length} 项指标未验证`);
}

// 集中处理异常并返回失败退出码，便于脚本和 CI 判断执行结果。
main(process.argv.slice(2)).catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
