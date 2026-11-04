import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importRuns, exportTable, parseRuns, type Run } from '../src/research.js';

// 合成样例覆盖来源一致性和三种导出格式，不需要网络或模型密钥。
test('synthetic import and export', async (): Promise<void> => {
  const registry = await importRuns('examples/synthetic-experiment/manifest.json');
  assert.equal(registry.evidence.length, 2);
  assert.ok(registry.evidence.every((item): boolean => item.status === 'verified' && item.sha256?.length === 64));
  for (const format of ['markdown', 'csv', 'latex']) assert.match(exportTable(registry, format), /synthetic-baseline/);
  registry.runs[1]!.protocol = 'different';
  assert.throws(() => exportTable(registry, 'csv'), /评估协议/);
});

// 每次导出重新核验文件；缺失、值不匹配和目录越界都不得获得 verified。
test('invalid evidence and changed artifacts remain unverified', async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'axiom-'));
  try {
    const run: Run = { runId: 'test', dataset: 'test', protocol: 'v1', codeRevision: 'abc', seed: 1, config: {}, metrics: [{ name: 'score', value: 1, artifact: 'source.json', key: 'score' }] };
    const manifest = join(dir, 'manifest.json');
    await writeFile(manifest, JSON.stringify([run]));
    assert.equal((await importRuns(manifest)).evidence[0]!.status, 'unverified');
    await writeFile(join(dir, 'source.json'), '{"score":1}');
    assert.equal((await importRuns(manifest)).evidence[0]!.status, 'verified');
    await writeFile(join(dir, 'source.json'), '{"score":2}');
    assert.equal((await importRuns(manifest)).evidence[0]!.status, 'unverified');
    run.metrics[0]!.artifact = '../outside.json';
    await writeFile(manifest, JSON.stringify([run]));
    assert.equal((await importRuns(manifest)).evidence[0]!.status, 'unverified');
    assert.throws(() => parseRuns([run, run]), /重复 runId/);
    assert.throws(() => parseRuns([{ ...run, seed: '1' }]), /seed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
