import type { Api, Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_CONTEXT_WINDOW_ENV,
  GATEWAY_DEFAULT_CONTEXT_WINDOW,
  GATEWAY_DEFAULT_MAX_TOKENS,
  GATEWAY_MAX_TOKENS_ENV,
  resolveGatewayLimits,
  resolveModel,
} from '../src/ai/models.js';

/** The pass-through borrow only reads these two methods — a stub is the whole contract. */
function stubRuntime(models: Model<Api>[]): unknown {
  return {
    getModel: (_providerId: string, modelId: string) => models.find((entry) => entry.id === modelId) ?? undefined,
    getModels: () => models,
  };
}

const REFERENCE: Model<Api> = {
  id: 'reference-mini',
  name: 'Reference Mini',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  // A deliberately small reference: the borrowed window is the bug this seam fixes.
  contextWindow: 8192,
  maxTokens: 8192,
} as unknown as Model<Api>;

const ENV_KEYS = [GATEWAY_CONTEXT_WINDOW_ENV, GATEWAY_MAX_TOKENS_ENV] as const;

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe('resolveGatewayLimits', () => {
  it('advertises the fork defaults when no override is set', () => {
    expect(resolveGatewayLimits()).toEqual({
      contextWindow: GATEWAY_DEFAULT_CONTEXT_WINDOW,
      maxTokens: GATEWAY_DEFAULT_MAX_TOKENS,
    });
  });

  it('honors explicit env overrides', () => {
    process.env[GATEWAY_CONTEXT_WINDOW_ENV] = '131072';
    process.env[GATEWAY_MAX_TOKENS_ENV] = '8192';
    expect(resolveGatewayLimits()).toEqual({ contextWindow: 131072, maxTokens: 8192 });
  });

  it('rejects a non-integer override loudly', () => {
    process.env[GATEWAY_CONTEXT_WINDOW_ENV] = 'big';
    expect(() => resolveGatewayLimits()).toThrow(/must be a positive integer/);
  });
});

describe('resolveModel gateway pass-through limits', () => {
  it('replaces the borrowed reference window, not just its id', () => {
    const resolved = resolveModel(
      stubRuntime([REFERENCE]) as never,
      'openai',
      'z-ai/glm-5.3',
      'https://openrouter.ai/api/v1',
      'chat-completions',
    );
    expect(resolved?.id).toBe('z-ai/glm-5.3');
    expect(resolved?.contextWindow).toBe(GATEWAY_DEFAULT_CONTEXT_WINDOW);
    expect(resolved?.maxTokens).toBe(GATEWAY_DEFAULT_MAX_TOKENS);
    // The gateway redirection itself is unchanged from upstream behavior.
    expect(resolved?.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('applies env overrides to the pass-through descriptor', () => {
    process.env[GATEWAY_CONTEXT_WINDOW_ENV] = '131072';
    const resolved = resolveModel(
      stubRuntime([REFERENCE]) as never,
      'openai',
      'z-ai/glm-5.3',
      'https://openrouter.ai/api/v1',
      'chat-completions',
    );
    expect(resolved?.contextWindow).toBe(131072);
  });

  it('never touches a catalogue model, which carries its own measured limits', () => {
    const resolved = resolveModel(stubRuntime([REFERENCE]) as never, 'openai', 'reference-mini', undefined);
    expect(resolved?.contextWindow).toBe(8192);
    expect(resolved?.maxTokens).toBe(8192);
  });

  it('returns undefined for an unknown id with no gateway', () => {
    const resolved = resolveModel(stubRuntime([REFERENCE]) as never, 'openai', 'z-ai/glm-5.3', undefined);
    expect(resolved).toBeUndefined();
  });
});
