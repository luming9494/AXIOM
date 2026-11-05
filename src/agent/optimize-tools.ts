import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { SingleOptimize } from '../execution/single-optimize.js';

export const OPTIMIZE_TOOL_NAMES = ['inspect_task', 'read_candidate_file', 'run_baseline', 'edit_candidate_file', 'run_checks', 'run_candidate', 'get_run_result', 'finalize_candidate', 'show_diff'];

export function optimizeTools(controller: SingleOptimize) {
  const execute = async (name: string, input: Record<string, unknown>, signal?: AbortSignal) => {
    const details = await controller.invoke(name, input, 'model', signal);
    return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
  };
  const empty = (name: string, label: string, description: string) => defineTool({
    name, label, description, executionMode: 'sequential',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: (_id, _params, signal) => execute(name, {}, signal),
  });
  return [
    empty('inspect_task', '读取任务约束', 'Read immutable task rules, validation selection criterion and allowed operations. No reference source or final-test data is exposed.'),
    defineTool({
      name: 'read_candidate_file', label: '读取候选代码', executionMode: 'sequential',
      description: 'Read only candidate model.py or read-only config.json. Returns exact content and sha256. No directory browsing or other files.',
      parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
      execute: (_id, params, signal) => execute('read_candidate_file', params, signal),
    }),
    empty('run_baseline', '建立真实基线', 'Train the unchanged baseline with fixed config and independently evaluate validation only. Run before editing. Repeated requests return the same baseline, not another training run.'),
    defineTool({
      name: 'edit_candidate_file', label: '提出单个候选', executionMode: 'sequential',
      description: 'Propose your own model change and rationale. Replace only model.py using its last-read sha256. Exactly one accepted edit, at most 8 KiB, no config changes. Narrow syntax: from torch import nn; def build_model(): return nn.Linear(...) or nn.Sequential(...). Only Linear/ReLU/Tanh and literal dimensions. No classes, other statements/imports, reference files, dependencies or arbitrary code.',
      parameters: Type.Object({ path: Type.String(), expectedSha256: Type.String(), content: Type.String({ maxLength: 8192 }), rationale: Type.String({ maxLength: 2000 }) }, { additionalProperties: false }),
      execute: (_id, params, signal) => execute('edit_candidate_file', params, signal),
    }),
    defineTool({
      name: 'run_checks', label: '候选自检', executionMode: 'sequential',
      description: 'Fixed actions l0 or smoke only; no command strings or custom args. Smoke uses 16 training samples and 2 updates. A successful Smoke is required before full candidate training, and is not evidence of metric improvement.',
      parameters: Type.Object({ action: Type.String() }, { additionalProperties: false }),
      execute: (_id, params, signal) => execute('run_checks', params, signal),
    }),
    empty('run_candidate', '训练并验证单个候选', 'After Smoke, perform the one allowed full candidate training attempt with the exact same config as baseline. Independently evaluate validation only. No final-test, extra candidates or retries.'),
    empty('get_run_result', '读取独立对比指标', 'Independently reload/re-evaluate baseline and candidate, return real validation metrics (or candidate failure). Read before deciding keep/revert. It does not choose the answer for you.'),
    defineTool({
      name: 'finalize_candidate', label: '依据证据保留或回退', executionMode: 'sequential',
      description: 'After reading results, propose choice keep or revert with reason. Program checks the real accuracy: keep only if strictly higher, otherwise revert (including failed candidate). A conflicting decision is rejected. Export selected loadable model without touching final-test.',
      parameters: Type.Object({ choice: Type.String(), reason: Type.String({ maxLength: 2000 }) }, { additionalProperties: false }),
      execute: (_id, params, signal) => execute('finalize_candidate', params, signal),
    }),
    empty('show_diff', '查看实际修改', 'Show the actual candidate Diff; rejected candidates remain as evidence, while selected/ contains the chosen delivery.'),
  ];
}
