// Fork modification (Corvus): the usage block of `shannon status --json`. The
// spend figures cross from a worker container this process does not control, so
// the projection is fail-closed: a figure that is not a finite non-negative
// number is omitted, never emitted as a lie. The budget_exhausted reason must
// survive the closed-set message filter — the safe-fields switch decides which
// reasons status --json shows at all.

import { describe, expect, it } from 'vitest';
import type { PipelineState, PipelineSummary } from '../src/scan/pipeline.js';
import type { RenderInput } from '../src/scan/render.js';
import { type StatusJson, toStatusJson } from '../src/scan/status-json.js';

const BUDGET_MESSAGE =
  'The scan reached its configured spending ceiling, so the remaining analysis work was skipped. Findings proven before the ceiling are in the report. Re-running this workspace with a higher ceiling retries the skipped work.';

function stateWith(summary: PipelineSummary | null): PipelineState {
  return {
    status: 'partial',
    currentPhase: null,
    currentAgent: null,
    completedAgents: [],
    expectedAgents: [],
    participatingClasses: [],
    failedPipelines: [],
    failedReconciliations: [],
    failedAgent: null,
    error: null,
    startTime: 1_000,
    agentMetrics: {},
    operationalMetrics: {},
    operationalStages: {},
    partialReasons: [{ code: 'budget_exhausted', message: BUDGET_MESSAGE }],
    summary,
  };
}

function inputFor(state: PipelineState | null): RenderInput {
  return {
    workspace: 'demo-scan',
    temporalStatus: 'COMPLETED',
    state,
    running: [],
    startedAt: 1_000,
    endedAt: 61_000,
  };
}

describe('toStatusJson — the fork usage block', () => {
  it('exposes usage_usd, usage_prompt_tokens and usage_accounting_complete from the summary', () => {
    const json = toStatusJson(
      inputFor(
        stateWith({
          totalCostUsd: 5.5,
          totalDurationMs: 60_000,
          totalTurns: 3,
          totalPromptTokens: 12_345,
          agentCount: 2,
          usageAccountingComplete: true,
        }),
      ),
      61_000,
    ) as StatusJson & { usage_usd?: number; usage_prompt_tokens?: number; usage_accounting_complete?: boolean };

    expect(json.status).toBe('partial');
    expect(json.usage_usd).toBe(5.5);
    expect(json.usage_prompt_tokens).toBe(12_345);
    expect(json.usage_accounting_complete).toBe(true);
  });

  it('omits every usage key when there is no summary rather than inventing zero', () => {
    const json = toStatusJson(inputFor(stateWith(null)), 61_000);
    expect('usage_usd' in json).toBe(false);
    expect('usage_prompt_tokens' in json).toBe(false);
    expect('usage_accounting_complete' in json).toBe(false);
  });

  it('omits a figure the worker reported as garbage — NaN and negatives never cross', () => {
    const json = toStatusJson(
      inputFor(
        stateWith({
          totalCostUsd: Number.NaN,
          totalDurationMs: 60_000,
          totalTurns: 0,
          totalPromptTokens: -1,
          agentCount: 0,
          usageAccountingComplete: false,
        }),
      ),
      61_000,
    );
    expect('usage_usd' in json).toBe(false);
    expect('usage_prompt_tokens' in json).toBe(false);
    // The accounting flag is a closed boolean, not an amount: it survives.
    expect(json.usageAccountingComplete).toBe(false);
  });

  it('omits usage_prompt_tokens when the summary predates the field', () => {
    const json = toStatusJson(
      inputFor(
        stateWith({
          totalCostUsd: 1,
          totalDurationMs: 60_000,
          totalTurns: 0,
          agentCount: 0,
          usageAccountingComplete: true,
        }),
      ),
      61_000,
    ) as StatusJson & { usage_usd?: number; usage_prompt_tokens?: number };
    expect(json.usage_usd).toBe(1);
    expect('usage_prompt_tokens' in json).toBe(false);
  });

  it('keeps the budget_exhausted reason and its exact safe sentence in the JSON', () => {
    const json = toStatusJson(
      inputFor(
        stateWith({
          totalCostUsd: 0,
          totalDurationMs: 60_000,
          totalTurns: 0,
          totalPromptTokens: 0,
          agentCount: 0,
          usageAccountingComplete: true,
        }),
      ),
      61_000,
    );
    expect(json.partialReasons).toEqual([{ code: 'budget_exhausted', message: BUDGET_MESSAGE }]);
  });

  it('drops a reason whose code the closed message set does not know', () => {
    const state = stateWith(null);
    const json = toStatusJson(
      inputFor({
        ...state,
        partialReasons: [{ code: 'made_up_code', message: 'never rendered' }],
      }),
      61_000,
    );
    expect(json.partialReasons).toBeUndefined();
  });
});
