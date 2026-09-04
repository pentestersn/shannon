// Fork modification (Corvus): the spend ceiling — the guard's arithmetic, the
// durable budget_exhausted reason, the closed config schema for `budget:`, the
// fail-loud coercion, the per-model price overrides, and the cost they write into
// the materialized models.json overlay.
//
// The terminal contract those units compose into (un dépassement → partial +
// budget_exhausted, jamais un completed silencieux) is proven end-to-end by a
// live pipeline-testing run; here each unit is pinned to the behavior the seam
// depends on.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectModelPriceRates, materializeGatewayModelsJson, modelPriceEnvSuffix } from '../src/ai/models.js';
import { distributeConfig, parseConfigYAML } from '../src/config-parser.js';
import { budgetExhaustedFor, budgetExhaustedMessage, pipelineSpend, promptTokensOf } from '../src/temporal/budget.js';
import type { AgentMetrics } from '../src/types/metrics.js';
import {
  appendPartialReasons,
  comparePartialReasons,
  isOrderedPartialReasonSet,
  PARTIAL_REASON_SAFE_MESSAGES,
  type PartialReason,
  projectPartialReasons,
} from '../src/types/run-state.js';

function metric(overrides: Partial<AgentMetrics>): AgentMetrics {
  return {
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    numTurns: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The guard's arithmetic.
// ---------------------------------------------------------------------------

describe('promptTokensOf', () => {
  it('counts input plus cache read plus cache write, the figures pi prices', () => {
    expect(promptTokensOf(metric({ inputTokens: 1000, cacheReadTokens: 300, cacheWriteTokens: 200 }))).toBe(1500);
  });

  it('treats a null figure as unknown spend, never as zero claimed from nothing', () => {
    expect(promptTokensOf(metric())).toBe(0);
    expect(promptTokensOf(metric({ inputTokens: 700 }))).toBe(700);
  });
});

describe('pipelineSpend', () => {
  it('accumulates cost and tokens across agent and operational metrics alike', () => {
    const spend = pipelineSpend([
      metric({ costUsd: 1.25, inputTokens: 1000 }),
      metric({ costUsd: 0.75, inputTokens: 500, cacheReadTokens: 500 }),
    ]);
    expect(spend.costUsd).toBe(2);
    expect(spend.promptTokens).toBe(2000);
  });

  it('omits unknown cost instead of inventing it, so the total stays a floor', () => {
    const spend = pipelineSpend([metric({ inputTokens: 100 }), metric({ costUsd: 1 })]);
    expect(spend.costUsd).toBe(1);
    expect(spend.promptTokens).toBe(100);
  });
});

describe('budgetExhaustedFor', () => {
  it('never trips without a budget — the default run stays unbounded', () => {
    expect(budgetExhaustedFor({ costUsd: 1e9, promptTokens: 1e12 }, undefined)).toBe(false);
  });

  it('trips at the USD bound, not only beyond it — a paid-up ceiling starts nothing new', () => {
    expect(budgetExhaustedFor({ costUsd: 4.99, promptTokens: 0 }, { maxUsd: 5 })).toBe(false);
    expect(budgetExhaustedFor({ costUsd: 5, promptTokens: 0 }, { maxUsd: 5 })).toBe(true);
    expect(budgetExhaustedFor({ costUsd: 5.01, promptTokens: 0 }, { maxUsd: 5 })).toBe(true);
  });

  it('trips at the token bound independently of the USD bound', () => {
    expect(budgetExhaustedFor({ costUsd: 0, promptTokens: 999 }, { maxPromptTokens: 1000 })).toBe(false);
    expect(budgetExhaustedFor({ costUsd: 0, promptTokens: 1000 }, { maxPromptTokens: 1000 })).toBe(true);
  });

  it('either bound alone is enough — the other stays unbounded', () => {
    expect(budgetExhaustedFor({ costUsd: 1e6, promptTokens: 0 }, { maxPromptTokens: 100 })).toBe(false);
    expect(budgetExhaustedFor({ costUsd: 0, promptTokens: 1e9 }, { maxUsd: 100 })).toBe(false);
  });
});

describe('budgetExhaustedMessage', () => {
  it('names both bounds and both totals when both are set', () => {
    const message = budgetExhaustedMessage(
      { costUsd: 5.5, promptTokens: 12000 },
      { maxUsd: 5, maxPromptTokens: 20000 },
    );
    expect(message).toBe(
      'Spend ceiling reached ($5.50 of $5.00, 12000 of 20000 prompt tokens); remaining analysis work was skipped.',
    );
  });

  it('names only the bound that exists', () => {
    const message = budgetExhaustedMessage({ costUsd: 5, promptTokens: 0 }, { maxPromptTokens: 1000 });
    expect(message).toBe('Spend ceiling reached (0 of 1000 prompt tokens); remaining analysis work was skipped.');
  });
});

// ---------------------------------------------------------------------------
// The durable reason: code-only identity, idempotent append, safe message.
// ---------------------------------------------------------------------------

describe('the budget_exhausted partial reason', () => {
  const reason: PartialReason = { code: 'budget_exhausted' };

  it('is valid on its own and survives resume validation', () => {
    expect(isOrderedPartialReasonSet([reason])).toBe(true);
  });

  it('is appended once no matter how many seams trip — the identity is code-only', () => {
    const once = appendPartialReasons([], [reason]);
    const twice = appendPartialReasons(once, [reason, reason]);
    expect(twice).toEqual([reason]);
    expect(twice).toHaveLength(1);
  });

  it('sorts after every other reason code, so resume merges never reorder history', () => {
    const merged = appendPartialReasons([{ code: 'report_sarif_failed' }], [reason]);
    expect(merged.map((entry) => entry.code)).toEqual(['report_sarif_failed', 'budget_exhausted']);
    expect(comparePartialReasons(merged[0] as PartialReason, merged[1] as PartialReason)).toBeLessThan(0);
  });

  it('projects the fixed safe sentence — no template token survives unsubstituted', () => {
    const [view] = projectPartialReasons([reason]);
    expect(view?.message).toBe(PARTIAL_REASON_SAFE_MESSAGES.budget_exhausted);
    expect(view?.vulnerabilityClass).toBeUndefined();
    expect(view?.stage).toBeUndefined();
  });

  it('keeps the message honest: the skipped work is named, the proven findings are named', () => {
    expect(PARTIAL_REASON_SAFE_MESSAGES.budget_exhausted).toContain('spending ceiling');
    expect(PARTIAL_REASON_SAFE_MESSAGES.budget_exhausted).toContain('skipped');
    expect(PARTIAL_REASON_SAFE_MESSAGES.budget_exhausted).not.toContain('{Class}');
  });
});

// ---------------------------------------------------------------------------
// The closed config schema and the fail-loud coercion.
// ---------------------------------------------------------------------------

describe('budget config parsing', () => {
  it('accepts both bounds and coerces them to numbers', () => {
    const config = parseConfigYAML('budget:\n  max_usd: "5.50"\n  max_prompt_tokens: "1000"\n');
    const distributed = distributeConfig(config);
    expect(distributed.budget).toEqual({ maxUsd: 5.5, maxPromptTokens: 1000 });
  });

  it('accepts the bareword YAML form Corvus writes — FAILSAFE_SCHEMA delivers strings either way', () => {
    const config = parseConfigYAML('budget:\n  max_usd: 5\n  max_prompt_tokens: 1000\n');
    expect(distributeConfig(config).budget).toEqual({ maxUsd: 5, maxPromptTokens: 1000 });
  });

  it('accepts one bound alone', () => {
    expect(distributeConfig(parseConfigYAML('budget:\n  max_usd: "2"\n')).budget).toEqual({ maxUsd: 2 });
    expect(distributeConfig(parseConfigYAML('budget:\n  max_prompt_tokens: "9"\n')).budget).toEqual({
      maxPromptTokens: 9,
    });
  });

  it('leaves the distributed config without a budget key when the block is absent', () => {
    expect(distributeConfig(parseConfigYAML('description: target app\n')).budget).toBeUndefined();
  });

  it('rejects an unknown field inside the closed budget object', () => {
    expect(() => parseConfigYAML('budget:\n  max_tokens: "5"\n')).toThrow(/Unknown field.*max_tokens/);
  });

  it('rejects an empty budget object — a ceiling of nothing is not a ceiling', () => {
    expect(() => parseConfigYAML('budget: {}\n')).toThrow(/budget/);
  });

  it('rejects a non-decimal value at the schema, before any coercion runs', () => {
    expect(() => parseConfigYAML('budget:\n  max_usd: "abc"\n')).toThrow(/max_usd/);
  });

  it('rejects a negative value at the schema', () => {
    expect(() => parseConfigYAML('budget:\n  max_usd: "-5"\n')).toThrow(/max_usd/);
  });

  it('rejects exponent notation — a pattern-passing string the coercion would still mishandle', () => {
    expect(() => parseConfigYAML('budget:\n  max_usd: "1e3"\n')).toThrow(/max_usd/);
  });

  it('fails loud in coercion when a bound is zero — nobody means “skip all analysis”', () => {
    expect(() => distributeConfig(parseConfigYAML('budget:\n  max_usd: "0"\n'))).toThrow(
      /max_usd must be a positive number/,
    );
  });
});

// ---------------------------------------------------------------------------
// Per-model price overrides, and the overlay cost they produce.
// ---------------------------------------------------------------------------

const PRICE_ENV_KEYS = ['SHANNON_AI_MODEL', 'SHANNON_AI_BASE_URL', 'SHANNON_AI_OPENAI_FORMAT'] as const;
let savedPriceEnv: Record<string, string | undefined> = {};
let priceKeys: string[] = [];

function setPriceEnv(key: string, value: string | undefined): void {
  if (key.startsWith('SHANNON_AI_PRICE_') && !priceKeys.includes(key)) priceKeys.push(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  savedPriceEnv = {};
  for (const key of PRICE_ENV_KEYS) {
    savedPriceEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedPriceEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of priceKeys) delete process.env[key];
  priceKeys = [];
});

describe('modelPriceEnvSuffix', () => {
  it('folds a gateway model id the same way stage names fold', () => {
    expect(modelPriceEnvSuffix('z-ai/glm-5.3')).toBe('Z_AI_GLM_5_3');
    expect(modelPriceEnvSuffix('openai/gpt-4o-mini')).toBe('OPENAI_GPT_4O_MINI');
  });
});

describe('collectModelPriceRates', () => {
  it('collects well-formed pairs in sorted key order', () => {
    setPriceEnv('SHANNON_AI_PRICE_INPUT_Z_AI_GLM_5_3', '0.60');
    setPriceEnv('SHANNON_AI_PRICE_OUTPUT_Z_AI_GLM_5_3', '2.20');
    const entries = collectModelPriceRates();
    expect(entries).toEqual([
      { key: 'SHANNON_AI_PRICE_INPUT_Z_AI_GLM_5_3', modelSuffix: 'Z_AI_GLM_5_3', rates: { input: 0.6, output: 2.2 } },
    ]);
  });

  it('ignores a variable whose value is empty', () => {
    setPriceEnv('SHANNON_AI_PRICE_INPUT_Z_AI_GLM_5_3', '');
    setPriceEnv('SHANNON_AI_PRICE_OUTPUT_Z_AI_GLM_5_3', '');
    expect(collectModelPriceRates()).toEqual([]);
  });

  it('fails loud on a lower-case suffix — a near-miss can never price nothing silently', () => {
    setPriceEnv('SHANNON_AI_PRICE_INPUT_z_ai_glm_5_3', '0.60');
    expect(() => collectModelPriceRates()).toThrow(/SHANNON_AI_PRICE_INPUT_z_ai_glm_5_3/);
  });

  it('fails loud on a value that is not a plain decimal', () => {
    setPriceEnv('SHANNON_AI_PRICE_INPUT_Z_AI_GLM_5_3', '1e-3');
    expect(() => collectModelPriceRates()).toThrow(/plain non-negative decimal/);
  });

  it('fails loud naming both keys when only one side of a pair is set', () => {
    setPriceEnv('SHANNON_AI_PRICE_INPUT_Z_AI_GLM_5_3', '0.60');
    expect(() => collectModelPriceRates()).toThrow(/must be set together/);
    setPriceEnv('SHANNON_AI_PRICE_INPUT_Z_AI_GLM_5_3', undefined);
    setPriceEnv('SHANNON_AI_PRICE_OUTPUT_Z_AI_GLM_5_3', '2.20');
    expect(() => collectModelPriceRates()).toThrow(/must be set together/);
  });
});

describe('materializeGatewayModelsJson — priced entries', () => {
  let dir: string;
  const target = (): string => path.join(dir, 'agent', 'models.json');

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'shannon-budget-overlay-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the declared rates into the overlay cost in pi per-million shape', () => {
    setPriceEnv('SHANNON_AI_MODEL', 'openai:z-ai/glm-5.3');
    setPriceEnv('SHANNON_AI_BASE_URL', 'http://127.0.0.1:9/v1');
    setPriceEnv('SHANNON_AI_PRICE_INPUT_Z_AI_GLM_5_3', '0.60');
    setPriceEnv('SHANNON_AI_PRICE_OUTPUT_Z_AI_GLM_5_3', '2.20');

    expect(materializeGatewayModelsJson(target())).toBe(target());

    const document = JSON.parse(readFileSync(target(), 'utf8'));
    expect(document.providers.openai.models).toEqual([
      {
        id: 'z-ai/glm-5.3',
        api: 'openai-completions',
        contextWindow: expect.any(Number),
        maxTokens: expect.any(Number),
        cost: { input: 0.6, output: 2.2, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it('leaves cost absent for a model with no price pair — an honest zero, not a guessed price', () => {
    setPriceEnv('SHANNON_AI_MODEL', 'openai:z-ai/glm-5.3');
    setPriceEnv('SHANNON_AI_BASE_URL', 'http://127.0.0.1:9/v1');
    setPriceEnv('SHANNON_AI_PRICE_INPUT_OTHER_MODEL', '1');
    setPriceEnv('SHANNON_AI_PRICE_OUTPUT_OTHER_MODEL', '1');

    materializeGatewayModelsJson(target());

    const document = JSON.parse(readFileSync(target(), 'utf8'));
    expect(document.providers.openai.models[0].cost).toBeUndefined();
  });

  it('fails the whole materialization when a selected model’s price pair is a half-pair', () => {
    setPriceEnv('SHANNON_AI_MODEL', 'openai:z-ai/glm-5.3');
    setPriceEnv('SHANNON_AI_BASE_URL', 'http://127.0.0.1:9/v1');
    setPriceEnv('SHANNON_AI_PRICE_INPUT_Z_AI_GLM_5_3', '0.60');
    mkdirSync(path.dirname(target()), { recursive: true });

    expect(() => materializeGatewayModelsJson(target())).toThrow(/must be set together/);
  });
});
