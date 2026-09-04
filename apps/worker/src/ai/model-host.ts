// Copyright (C) 2026 Keygraph, Inc.
// Copyright (C) 2026 Corvus contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import { classifyProviderFailure } from '../services/error-handling.js';
import type { ProviderFailure } from '../types/errors.js';
import { type ModelSelection, resolveModelSelection } from './models.js';

/** Intended cost/capability role for a model call. All roles use the run's one selected model. */
export type ModelRole = 'small' | 'medium' | 'large';

/** Credential-preserving model selection and provider-failure classification boundary. */
export interface ModelHost {
  resolve(role: ModelRole): Promise<ModelSelection>;
  classify(error: unknown, contextWindow?: number): ProviderFailure;
}

export type ModelSelectionResolver = (stage?: string) => Promise<ModelSelection>;

class ShannonModelHost implements ModelHost {
  /**
   * One cached selection per role. Upstream cached a single selection because
   * every role resolved the same run-wide model; the fork's per-stage routing
   * (SHANNON_AI_MODEL_SMALL/MEDIUM/LARGE) lets roles differ, so the cache is
   * keyed by role — otherwise the first role to resolve would decide the model
   * for the others. Each entry clears itself on rejection so a retried activity
   * can resolve again instead of replaying the first failure forever; the
   * identity guard leaves a newer in-flight selection in place if one already
   * replaced this one.
   */
  private readonly selections = new Map<ModelRole, Promise<ModelSelection>>();

  constructor(private readonly resolver: ModelSelectionResolver) {}

  resolve(role: ModelRole): Promise<ModelSelection> {
    const cached = this.selections.get(role);
    if (cached) return cached;

    const selection = Promise.resolve()
      .then(() => this.resolver(role))
      .catch((error: unknown) => {
        if (this.selections.get(role) === selection) this.selections.delete(role);
        throw error;
      });
    this.selections.set(role, selection);
    return selection;
  }

  classify(error: unknown, contextWindow?: number): ProviderFailure {
    return classifyProviderFailure(error, contextWindow);
  }
}

/** Create an isolated host, primarily for callers with an explicit lifecycle or focused verification. */
export function createModelHost(resolver: ModelSelectionResolver = resolveModelSelection): ModelHost {
  return new ShannonModelHost(resolver);
}

/** Process-local model host shared by production model callers. */
export const modelHost: ModelHost = createModelHost();
