import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoRegistry, parseRegistry } from '../apps/web/src/registry.js';
import { importRuns } from '../src/research.js';
import { exportTable } from '../src/table.js';

test('web demo is synthetic and does not claim source verification', () => {
  const demo = demoRegistry();
  assert.equal(demo.runs.length, 2);
  assert.ok(demo.evidence.every(item => item.status === 'unverified' && !item.sha256));
  assert.deepEqual(parseRegistry(JSON.parse(JSON.stringify(demo))), demo);
  demo.runs[0]!.config.learningRate = 99;
  assert.equal(demoRegistry().runs[0]!.config.learningRate, 0.001);
});

test('web accepts CLI registry, preserves provenance and shares table formatter', async () => {
  const registry = await importRuns('examples/synthetic-experiment/manifest.json');
  const imported = parseRegistry(JSON.parse(JSON.stringify(registry)));
  assert.deepEqual(imported, registry);
  for (const format of ['markdown', 'csv', 'latex']) assert.equal(exportTable(imported, format), exportTable(registry, format));
});

test('web rejects malformed structures and broken evidence associations', () => {
  for (const input of [null, [], {}, { schemaVersion: 2 }, { schemaVersion: 1, runs: [], evidence: [] }]) assert.throws(() => parseRegistry(input));
  const invalid = [
    (r: ReturnType<typeof demoRegistry>) => { r.runs.push(r.runs[0]!); },
    (r: ReturnType<typeof demoRegistry>) => { r.evidence.pop(); },
    (r: ReturnType<typeof demoRegistry>) => { r.evidence[0]!.value = 900; },
    (r: ReturnType<typeof demoRegistry>) => { r.evidence[0]!.artifact = 'fake.json'; },
    (r: ReturnType<typeof demoRegistry>) => { r.evidence[0]!.status = 'verified'; },
    (r: ReturnType<typeof demoRegistry>) => { r.evidence[0]!.sha256 = 'bad-hash'; },
    (r: ReturnType<typeof demoRegistry>) => { r.evidence[0]!.runId = 'missing'; },
    (r: ReturnType<typeof demoRegistry>) => { r.evidence.push(r.evidence[0]!); },
  ];
  for (const mutate of invalid) { const registry = demoRegistry(); mutate(registry); assert.throws(() => parseRegistry(registry)); }
});
