// Copyright (C) 2026 Keygraph, Inc.
// Copyright (C) 2026 Corvus contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Fork addition (Corvus): the spend-ceiling decision core.
 *
 * Pure functions over plain records — this module deliberately imports nothing but a
 * type, so the vitest rig exercises the guard's arithmetic directly without loading
 * Temporal or the workflow bundle. `workflows.ts` keeps the orchestration policy
 * (where the guard runs, what a trip skips); everything numeric lives here.
 *
 * Honesty rules baked into the arithmetic:
 *  - A metric whose figure is null is UNKNOWN spend, never zero. It is omitted from
 *    the sums, so every total is a floor, never an invention.
 *  - The trip comparison is `>=` on the accumulated total: a scan that has already
 *    paid the ceiling must not start new billable work. A bound of exactly the
 *    spend so far trips at the next seam, which is the honest reading of a cap.
 */

import type { AgentMetrics } from '../types/metrics.js';

/**
 * The run's spend ceiling, already coerced from the YAML `budget:` block by
 * `distributeConfig`. Both bounds are optional; a missing bound is no bound, so an
 * absent budget object and an empty one behave identically at this layer.
 */
export interface PipelineBudget {
  /** Maximum accumulated model spend in USD. */
  readonly maxUsd?: number;
  /** Maximum accumulated prompt tokens (input + cache read + cache write). */
  readonly maxPromptTokens?: number;
}

/** What one metric record contributes to the spend a ceiling is measured against. */
export type SpendRecord = AgentMetrics;

/** The two accumulated totals the ceiling is measured against. */
export interface PipelineSpend {
  /** Sum of every record's known cost; unknown costs are omitted, never zero-filled. */
  readonly costUsd: number;
  /** Sum of input + cache-read + cache-write tokens, mirroring pi's tier math. */
  readonly promptTokens: number;
}

/**
 * One record's prompt-token count: input plus cache read plus cache write, the same
 * three figures pi's `calculateCost` adds to price a request's input side. A null
 * figure contributes nothing — unknown spend is a floor, not zero.
 */
export function promptTokensOf(record: SpendRecord): number {
  return (record.inputTokens ?? 0) + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0);
}

/**
 * Accumulate every record into the two totals a ceiling is measured against.
 * Deterministic by construction: a plain sum in iteration order, safe to replay.
 */
export function pipelineSpend(records: readonly SpendRecord[]): PipelineSpend {
  let costUsd = 0;
  let promptTokens = 0;
  for (const record of records) {
    costUsd += record.costUsd ?? 0;
    promptTokens += promptTokensOf(record);
  }
  return { costUsd, promptTokens };
}

/**
 * Whether the accumulated spend has reached the ceiling. True means the next billable
 * phase or lane must be skipped; false means work may continue. A budget with no
 * bounds (or no budget at all) never trips — the default run is unbounded, exactly
 * as upstream, and the guard costs one comparison.
 */
export function budgetExhaustedFor(spend: PipelineSpend, budget: PipelineBudget | undefined): boolean {
  if (budget === undefined) return false;
  if (budget.maxUsd !== undefined && spend.costUsd >= budget.maxUsd) return true;
  if (budget.maxPromptTokens !== undefined && spend.promptTokens >= budget.maxPromptTokens) return true;
  return false;
}

/**
 * The bounded journal sentence recorded once, on the first seam that trips. Pure
 * number formatting only (`toFixed` — deterministic across replays, unlike
 * locale-aware formatting); nothing free-text from outside crosses into it.
 */
export function budgetExhaustedMessage(spend: PipelineSpend, budget: PipelineBudget): string {
  const parts: string[] = [];
  if (budget.maxUsd !== undefined) {
    parts.push(`$${spend.costUsd.toFixed(2)} of $${budget.maxUsd.toFixed(2)}`);
  }
  if (budget.maxPromptTokens !== undefined) {
    parts.push(`${String(spend.promptTokens)} of ${String(budget.maxPromptTokens)} prompt tokens`);
  }
  return `Spend ceiling reached (${parts.join(', ')}); remaining analysis work was skipped.`;
}
