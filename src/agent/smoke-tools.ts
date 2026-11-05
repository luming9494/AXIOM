import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { SmokeWorkspace } from '../execution/smoke-workspace.js';

export const SMOKE_TOOL_NAMES = ['read_candidate_file', 'edit_candidate_file', 'run_checks', 'read_smoke_result', 'show_diff'];

export function smokeTools(workspace: SmokeWorkspace) {
  const execute = async (name: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const details = await workspace.invoke(name, params, 'model', signal);
    return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
  };
  return [
    defineTool({
      name: 'read_candidate_file', label: '读取候选代码', executionMode: 'sequential',
      description: 'Read only model.py or config.json in the authorized candidate copy (8 KiB limit). Returns content and sha256; read model.py before editing.',
      parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
      execute: (_id, params, signal) => execute('read_candidate_file', params, signal),
    }),
    defineTool({
      name: 'edit_candidate_file', label: '修改授权模型', executionMode: 'sequential',
      description: 'Replace only model.py in the candidate copy, using its last-read sha256. At most 8 KiB. Narrow AST policy: from torch import nn; def build_model(): return nn.Sequential(nn.Linear(...), nn.ReLU() or nn.Tanh(), nn.Linear(...)). No classes, other imports, statements, arbitrary execution, network, or dependency installation. Returns the actual Diff. Other paths are denied.',
      parameters: Type.Object({ path: Type.String(), expectedSha256: Type.String(), content: Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
      execute: (_id, params, signal) => execute('edit_candidate_file', params, signal),
    }),
    defineTool({
      name: 'run_checks', label: '受限执行检查', executionMode: 'sequential',
      description: 'Execute only fixed action l0 or smoke. No Shell or arbitrary command. smoke reviews the model, runs L0, trains on 16 samples for 2 steps, saves weights and independently evaluates. Only one Smoke attempt. Read artifacts afterward using read_smoke_result.',
      parameters: Type.Object({ action: Type.String() }, { additionalProperties: false }),
      execute: (_id, params, signal) => execute('run_checks', params, signal),
    }),
    defineTool({
      name: 'read_smoke_result', label: '读取真实训练结果', executionMode: 'sequential',
      description: 'Read the successful Smoke artifacts and independently reload/re-evaluate checkpoint. Returns actual training scope, parameter count, validation metrics and artifact paths. Smoke is not a formal model score.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: (_id, _params, signal) => execute('read_smoke_result', {}, signal),
    }),
    defineTool({
      name: 'show_diff', label: '查看真实代码差异', executionMode: 'sequential',
      description: 'Show persisted unified Diff against the original baseline; does not execute commands.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: (_id, _params, signal) => execute('show_diff', {}, signal),
    }),
  ];
}
