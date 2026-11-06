import assert from 'node:assert/strict';
import { test } from 'node:test';
import { link, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SmokeWorkspace } from '../src/execution/smoke-workspace.js';
import { childEnvironment, runProcess } from '../src/execution/process.js';

// Offline policy tests: no model API, no Python/Torch required, no simulated training claims.
test('WP-02 exact file and command permissions fail closed', async t => {
  const workspace = await SmokeWorkspace.create(resolve('.'), process.execPath);
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  const original = await readFile(join(workspace.candidate, 'model.py'), 'utf8');
  const read = await workspace.invoke('read_candidate_file', { path: 'model.py' }, 'test');
  assert.equal(read.content, original);
  assert.match(String(read.sha256), /^[a-f0-9]{64}$/);
  for (const path of ['../outside-sentinel.txt', '../../README.md', '/tmp/model.py', 'C:\\model.py', 'config.json', './model.py', 'MODEL.py', 'model.py:stream']) {
    await assert.rejects(workspace.invoke('edit_candidate_file', { path, expectedSha256: read.sha256, content: 'no' }, 'test'), /Permission denied/);
  }
  for (const input of [{ action: 'python -c "print(123)"' }, { action: 'smoke; whoami' }, { action: 'full' }, { action: 'smoke', command: 'evil' }]) {
    await assert.rejects(workspace.invoke('run_checks', input, 'test'), /Permission denied/);
  }
  await assert.rejects(workspace.invoke('edit_candidate_file', { path: 'model.py', expectedSha256: 'stale', content: 'no' }, 'test'), /stale/);
  await assert.rejects(workspace.invoke('read_smoke_result', {}, 'test'), /No successful/);
  await assert.rejects(workspace.invoke('bash', { command: 'anything' }, 'test'), /unknown tool/);
  await workspace.verifyTrusted();
  assert.equal(await readFile(join(workspace.candidate, 'model.py'), 'utf8'), original);
  assert.equal((await workspace.invoke('show_diff', {}, 'test')).diff, '');
});

test('WP-02 hardlink aliases are refused', async t => {
  const workspace = await SmokeWorkspace.create(resolve('.'), process.execPath);
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  await link(join(workspace.candidate, 'model.py'), join(workspace.root, 'alias.py'));
  await assert.rejects(workspace.invoke('read_candidate_file', { path: 'model.py' }, 'test'), /aliases/);
});

test('child environment excludes secrets and Python injection variables', () => {
  process.env.AXIOM_TEST_SECRET = 'not-for-child';
  try {
    const env = childEnvironment(process.execPath, resolve('private'));
    assert.equal(env.AXIOM_TEST_SECRET, undefined);
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    assert.equal(env.NVIDIA_API_KEY, undefined);
    assert.equal(env.PYTHONPATH, undefined);
    assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  } finally { delete process.env.AXIOM_TEST_SECRET; }
});

test('restricted process helper captures nonzero exits and enforces output limits', async () => {
  const options = { cwd: resolve('.'), home: resolve('.'), timeoutMs: 10_000 };
  const result = await runProcess(process.execPath, ['-e', 'console.log("real-output"); process.exit(7)'], options);
  assert.equal(result.code, 7);
  assert.match(result.stdout, /real-output/);
  const limited = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000)); setInterval(()=>{},1000)'], { ...options, maxBytes: 64 });
  assert.equal(limited.stopped, 'output_limit');
  assert.ok(Buffer.byteLength(limited.stdout) <= 64);
});

test('restricted process helper waits for terminated child on timeout and abort', async () => {
  const options = { cwd: resolve('.'), home: resolve('.'), timeoutMs: 500 };
  const result = await runProcess(process.execPath, ['-e', 'console.log(process.pid); setInterval(()=>{},1000)'], options);
  assert.equal(result.stopped, 'timeout');
  const pid = Number(result.stdout.trim());
  if (pid) assert.throws(() => process.kill(pid, 0));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runProcess(process.execPath, ['-e', 'throw Error("should not run")'], { ...options, signal: controller.signal }));
});
