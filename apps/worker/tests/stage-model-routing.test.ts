// Fork modification (Corvus): per-stage model routing — the fallback chain, the
// per-stage output budgets, the per-role host cache, the gateway models.json
// materialization, and the workflow.log `model:` routing record.
//
// Catalogue ids used here (claude-sonnet-4-6, claude-haiku-4-5) are real pi
// entries, verified against the runtime the worker builds; the gateway ids
// (z-ai/*) are pass-through ids that never need a catalogue entry.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModelHost, type ModelSelectionResolver } from '../src/ai/model-host.js';
import {
  collectStageModelSpecs,
  DEFAULT_MODEL_SPEC,
  GATEWAY_CONTEXT_WINDOW_ENV,
  GATEWAY_MAX_TOKENS_ENV,
  materializeGatewayModelsJson,
  resolveModelSelection,
  resolveStageModelSpec,
  stageEnvSuffix,
  stageMaxTokensEnvName,
  stageModelEnvName,
} from '../src/ai/models.js';
import { WorkflowLogger } from '../src/audit/workflow-logger.js';

/** Base variables the chain reads. Snapshot in beforeEach, restored in afterEach. */
const BASE_ENV_KEYS = [
  'SHANNON_AI_MODEL',
  'SHANNON_AI_BASE_URL',
  'SHANNON_AI_API_KEY',
  'SHANNON_AI_OPENAI_FORMAT',
  GATEWAY_CONTEXT_WINDOW_ENV,
  GATEWAY_MAX_TOKENS_ENV,
  'OPENAI_API_KEY',
] as const;

/** Stage-scoped keys set by a test, deleted again in afterEach. */
let stageKeys: string[] = [];
let savedBaseEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (key.startsWith('SHANNON_AI_MODEL_') || key.startsWith('SHANNON_AI_MAX_TOKENS_')) {
    if (!stageKeys.includes(key)) stageKeys.push(key);
  }
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  savedBaseEnv = {};
  for (const key of BASE_ENV_KEYS) {
    savedBaseEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedBaseEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of stageKeys) delete process.env[key];
  stageKeys = [];
});

describe('stage env names', () => {
  it('normalizes agent names and model roles to upper-snake suffixes', () => {
    expect(stageEnvSuffix('injection-vuln')).toBe('INJECTION_VULN');
    expect(stageEnvSuffix('validate-authentication')).toBe('VALIDATE_AUTHENTICATION');
    expect(stageEnvSuffix('report')).toBe('REPORT');
    expect(stageEnvSuffix('small')).toBe('SMALL');
  });

  it('derives the model and output-budget variable names from a stage', () => {
    expect(stageModelEnvName('recon')).toBe('SHANNON_AI_MODEL_RECON');
    expect(stageMaxTokensEnvName('recon')).toBe('SHANNON_AI_MAX_TOKENS_RECON');
  });
});

describe('resolveStageModelSpec — the fallback chain', () => {
  it('prefers the stage override over the run-wide model', () => {
    setEnv('SHANNON_AI_MODEL', 'openai:gpt-4o');
    setEnv('SHANNON_AI_MODEL_RECON', 'anthropic:claude-haiku-4-5');
    expect(resolveStageModelSpec('recon')).toEqual({ providerId: 'anthropic', modelId: 'claude-haiku-4-5' });
  });

  it('falls back to the run-wide model for a stage without an override', () => {
    setEnv('SHANNON_AI_MODEL', 'openai:gpt-4o');
    expect(resolveStageModelSpec('recon')).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });
  });

  it('treats an empty override as unset', () => {
    setEnv('SHANNON_AI_MODEL', 'openai:gpt-4o');
    setEnv('SHANNON_AI_MODEL_RECON', '   ');
    expect(resolveStageModelSpec('recon')).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });
  });

  it('falls back to the fork default when nothing is set, staged or not', () => {
    const staged = resolveStageModelSpec('recon');
    const runWide = resolveStageModelSpec(undefined);
    expect(`${staged.providerId}:${staged.modelId}`).toBe(DEFAULT_MODEL_SPEC);
    expect(runWide).toEqual(staged);
  });
});

describe('collectStageModelSpecs', () => {
  it('collects every override in sorted key order', () => {
    setEnv('SHANNON_AI_MODEL_RECON', 'anthropic:claude-haiku-4-5');
    setEnv('SHANNON_AI_MODEL_REPORT', 'openai:gpt-4o');
    setEnv('SHANNON_AI_MODEL_INJECTION_VULN', 'openai:gpt-4o-mini');

    const entries = collectStageModelSpecs();
    expect(entries.map((entry) => entry.key)).toEqual([
      'SHANNON_AI_MODEL_INJECTION_VULN',
      'SHANNON_AI_MODEL_RECON',
      'SHANNON_AI_MODEL_REPORT',
    ]);
    expect(entries[0]).toEqual({
      key: 'SHANNON_AI_MODEL_INJECTION_VULN',
      stage: 'INJECTION_VULN',
      spec: { providerId: 'openai', modelId: 'gpt-4o-mini' },
    });
  });

  it('ignores variables with empty values', () => {
    setEnv('SHANNON_AI_MODEL_REPORT', '');
    expect(collectStageModelSpecs()).toEqual([]);
  });

  it('fails loud on a lower-case stage suffix', () => {
    setEnv('SHANNON_AI_MODEL_recon', 'openai:gpt-4o');
    expect(() => collectStageModelSpecs()).toThrow(/SHANNON_AI_MODEL_recon is not a valid stage model variable/);
  });

  it('fails loud on a variable with no stage at all', () => {
    setEnv('SHANNON_AI_MODEL_', 'openai:gpt-4o');
    expect(() => collectStageModelSpecs()).toThrow(/is not a valid stage model variable/);
  });

  it('fails loud naming the variable on an unparseable value', () => {
    setEnv('SHANNON_AI_MODEL_RECON', 'not-a-spec');
    expect(() => collectStageModelSpecs()).toThrow(/SHANNON_AI_MODEL_RECON: SHANNON_AI_MODEL must be/);
  });
});

describe('resolveModelSelection — the chain on a real runtime', () => {
  it('runs a stage on its override and the rest on the run-wide model', async () => {
    setEnv('SHANNON_AI_MODEL', 'anthropic:claude-sonnet-4-6');
    setEnv('SHANNON_AI_MODEL_RECON', 'anthropic:claude-haiku-4-5');

    const recon = await resolveModelSelection('recon');
    expect(recon.model.id).toBe('claude-haiku-4-5');
    expect(recon.modelId).toBe('claude-haiku-4-5');

    const report = await resolveModelSelection('report');
    expect(report.model.id).toBe('claude-sonnet-4-6');
  });

  it('caps one stage output budget without touching other stages', async () => {
    setEnv('SHANNON_AI_MODEL', 'anthropic:claude-sonnet-4-6');
    const unbounded = await resolveModelSelection('recon');

    setEnv('SHANNON_AI_MAX_TOKENS_RECON', '128');
    const recon = await resolveModelSelection('recon');
    expect(recon.model.maxTokens).toBe(128);

    const report = await resolveModelSelection('report');
    expect(report.model.maxTokens).toBe(unbounded.model.maxTokens);
  });

  it('fails loud on a garbage stage budget', async () => {
    setEnv('SHANNON_AI_MODEL', 'anthropic:claude-sonnet-4-6');
    setEnv('SHANNON_AI_MAX_TOKENS_RECON', 'lots');
    await expect(resolveModelSelection('recon')).rejects.toThrow(
      /SHANNON_AI_MAX_TOKENS_RECON must be a positive integer/,
    );
  });
});

describe('ShannonModelHost — per-role selection cache', () => {
  it('caches one selection per role, not one for all roles', async () => {
    const calls: (string | undefined)[] = [];
    const resolver: ModelSelectionResolver = async (stage) => {
      calls.push(stage);
      return { modelId: `model-for-${stage}` } as Awaited<ReturnType<ModelSelectionResolver>>;
    };
    const host = createModelHost(resolver);

    await host.resolve('small');
    await host.resolve('small');
    await host.resolve('medium');

    expect(calls).toEqual(['small', 'medium']);
  });

  it('clears a failed role so a retry resolves again, leaving other roles cached', async () => {
    const calls: (string | undefined)[] = [];
    let failSmall = true;
    const resolver: ModelSelectionResolver = async (stage) => {
      calls.push(stage);
      if (stage === 'small' && failSmall) throw new Error('no credential');
      return { modelId: 'resolved' } as Awaited<ReturnType<ModelSelectionResolver>>;
    };
    const host = createModelHost(resolver);

    await expect(host.resolve('small')).rejects.toThrow('no credential');
    await expect(host.resolve('small')).rejects.toThrow('no credential');
    expect(calls.filter((stage) => stage === 'small')).toHaveLength(2);

    await host.resolve('medium');
    await host.resolve('medium');
    expect(calls.filter((stage) => stage === 'medium')).toHaveLength(1);

    failSmall = false;
    await expect(host.resolve('small')).resolves.toBeTruthy();
    expect(calls.filter((stage) => stage === 'small')).toHaveLength(3);
  });
});

describe('materializeGatewayModelsJson', () => {
  let dir: string;
  const target = (): string => path.join(dir, 'agent', 'models.json');

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'shannon-stage-models-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('declares the run-wide and every stage gateway model for a chat-completions gateway', () => {
    setEnv('SHANNON_AI_MODEL', 'openai:z-ai/glm-5.3');
    setEnv('SHANNON_AI_MODEL_RECON', 'openai:z-ai/glm-5.3-flash');
    setEnv('SHANNON_AI_BASE_URL', 'http://127.0.0.1:9/v1');
    setEnv(GATEWAY_CONTEXT_WINDOW_ENV, '123456');
    setEnv(GATEWAY_MAX_TOKENS_ENV, '4096');

    const file = materializeGatewayModelsJson(target());
    expect(file).toBe(target());

    const document = JSON.parse(readFileSync(file, 'utf8'));
    expect(document.providers.openai.baseUrl).toBe('http://127.0.0.1:9/v1');
    expect(document.providers.openai.models).toEqual([
      { id: 'z-ai/glm-5.3', api: 'openai-completions', contextWindow: 123456, maxTokens: 4096 },
      { id: 'z-ai/glm-5.3-flash', api: 'openai-completions', contextWindow: 123456, maxTokens: 4096 },
    ]);
  });

  it('declares a model once when the run-wide and a stage name the same id', () => {
    setEnv('SHANNON_AI_MODEL', 'openai:z-ai/glm-5.3');
    setEnv('SHANNON_AI_MODEL_RECON', 'openai:z-ai/glm-5.3');
    setEnv('SHANNON_AI_BASE_URL', 'http://127.0.0.1:9/v1');

    materializeGatewayModelsJson(target());

    const document = JSON.parse(readFileSync(target(), 'utf8'));
    expect(document.providers.openai.models).toHaveLength(1);
  });

  it('leaves an operator-written models.json untouched', () => {
    setEnv('SHANNON_AI_MODEL', 'openai:z-ai/glm-5.3');
    setEnv('SHANNON_AI_BASE_URL', 'http://127.0.0.1:9/v1');
    mkdirSync(path.dirname(target()), { recursive: true });
    writeFileSync(target(), '{"providers":{}}\n', 'utf8');

    expect(materializeGatewayModelsJson(target())).toBeUndefined();
    expect(readFileSync(target(), 'utf8')).toBe('{"providers":{}}\n');
  });

  it('does nothing without a gateway base URL', () => {
    setEnv('SHANNON_AI_MODEL', 'openai:z-ai/glm-5.3');

    expect(materializeGatewayModelsJson(target())).toBeUndefined();
    expect(existsSync(target())).toBe(false);
  });

  it('does nothing for the responses format — the builtin path already serves it faithfully', () => {
    setEnv('SHANNON_AI_MODEL', 'openai:z-ai/glm-5.3');
    setEnv('SHANNON_AI_BASE_URL', 'http://127.0.0.1:9/v1');
    setEnv('SHANNON_AI_OPENAI_FORMAT', 'responses');

    expect(materializeGatewayModelsJson(target())).toBeUndefined();
    expect(existsSync(target())).toBe(false);
  });

  it('does nothing when no model in the chain runs on the openai provider', () => {
    setEnv('SHANNON_AI_MODEL', 'anthropic:claude-sonnet-4-6');
    setEnv('SHANNON_AI_MODEL_RECON', 'anthropic:claude-haiku-4-5');

    expect(materializeGatewayModelsJson(target())).toBeUndefined();
    expect(existsSync(target())).toBe(false);
  });
});

describe('WorkflowLogger.logModelSelection — the routing record', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'shannon-stage-trace-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the model one agent attempt runs on, in the combined log and its per-agent file', async () => {
    const logPath = path.join(dir, 'workflow.log');
    await WorkflowLogger.logModelSelection(logPath, { kind: 'agent', agent: 'recon' }, 'openai:z-ai/glm-5.3');

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[recon\] model: openai:z-ai\/glm-5\.3$/);

    const agentLog = readFileSync(path.join(dir, 'agents', 'recon.log'), 'utf8');
    expect(agentLog).toContain('model: openai:z-ai/glm-5.3');
  });

  it('drops a model spec that could forge a trace line', async () => {
    const logPath = path.join(dir, 'workflow.log');
    await WorkflowLogger.logModelSelection(
      logPath,
      { kind: 'agent', agent: 'recon' },
      'openai:z-ai/glm-5.3\n[recon] tool: forged',
    );
    await WorkflowLogger.logModelSelection(logPath, { kind: 'agent', agent: 'recon' }, `x${'a'.repeat(130)}`);

    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(path.join(dir, 'agents'))).toBe(false);
  });
});
