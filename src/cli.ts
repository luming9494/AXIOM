import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportTable, importRuns } from './research.js';

// 默认离线运行，每次重新读取来源文件，避免沿用过期的验证状态。
async function main(args: string[]): Promise<void> {
  const [command, manifest, output, format = 'markdown'] = args;
  if (command === 'task' || (!command && process.stdin.isTTY)) {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (major < 22 || major === 22 && minor < 19) throw new Error('Pi SDK 需要 Node.js >=22.19.0');
    const { planTask, approveTask } = await import('./agent/task-agent.js');
    if (args[1] === '--approve') {
      if (args.length !== 6 || args[3] !== '--sha256' || args[5] !== '--allow-reviewed-code' || !args[2] || !args[4]) throw new Error('用法: task --approve <task-spec.json> --sha256 <审核文件哈希> --allow-reviewed-code');
      await approveTask(resolve('.'), args[2], args[4]);
      return;
    }
    if (args.slice(1).some(arg => arg.startsWith('--'))) throw new Error('未知任务参数');
    if (args.length > 1) {
      const plan = await planTask(resolve('.'), args.slice(1).join(' '));
      console.log(`审核后执行：npm run axiom -- task --approve "${plan.path.replaceAll('\\', '/')}" --sha256 ${plan.hash} --allow-reviewed-code`);
      return;
    }
    if (!process.stdin.isTTY) throw new Error('非交互环境请使用 task "自然语言任务"；先生成规格，再显式批准');
    const { createInterface } = await import('node:readline/promises');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('AXIOM · 当前支持可信 Tiny Task；按配置调用模型（默认 DeepSeek 官方，按量计费），训练前需审核。');
      const request = await terminal.question('你希望 AXIOM 完成什么任务？\n> ');
      const plan = await planTask(resolve('.'), request);
      const answer = await terminal.question('审核以上目标、规则和预算。输入 yes 授权模型 API 调用与受限 CPU 代码执行（官方按量计费）（不是 OS 沙箱），其他输入取消：');
      if (answer.trim().toLowerCase() === 'yes') await approveTask(resolve('.'), plan.path, plan.hash);
      else console.log('未执行训练；TaskSpec 已保存，可稍后审核批准。');
    } finally { terminal.close(); }
    return;
  }
  if (command === 'smoke-agent' || command === 'optimize-once') {
    if (args.length !== 2 || manifest !== '--allow-reviewed-code') throw new Error(`用法: npm run axiom -- ${command} --allow-reviewed-code；授权可信 Tiny Task 的受限代码执行和 模型 API 调用（官方按量计费），不是 OS 沙箱`);
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('Pi SDK 需要 Node.js >=22.19.0');
    if (command === 'smoke-agent') {
      const { runSmokeAgent } = await import('./agent/smoke-agent.js');
      await runSmokeAgent(resolve('.'));
    } else {
      const { runOptimizeAgent } = await import('./agent/optimize-agent.js');
      await runOptimizeAgent(resolve('.'));
    }
    return;
  }
  if (command === 'ask' && manifest && output) {
    // 在加载 SDK 前检查版本，避免旧 Node 在依赖初始化期间直接崩溃。
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('Pi SDK 需要 Node.js >=22.19.0');
    const { ask } = await import('./agent.js');
    console.log(await ask(manifest, args.slice(2).join(' ')));
    return;
  }
  if (!['import', 'export'].includes(command ?? '') || !manifest || !output || args.length > 4) {
    throw new Error('用法: npm run axiom -- import <manifest.json> <registry.json> | export <manifest.json> <table> [markdown|csv|latex] | ask <manifest.json> <问题> | task "自然语言任务"（先审核再执行）；交互终端可直接运行 npm run axiom');
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
