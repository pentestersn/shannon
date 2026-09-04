/**
 * Parsing for the single model setting, `SHANNON_AI_MODEL=<provider>:<model-id>`.
 *
 * Mirrors apps/worker/src/ai/models.ts. The CLI cannot import from the worker
 * package (it ships as a standalone bundle), so the provider list and the parse
 * rule are duplicated here deliberately and must stay in sync.
 */

/**
 * Providers Shannon curates with their own credential variables, config sections,
 * and setup flows. Any other pi provider is reachable via the generic credential
 * path. Mirrors CURATED_PROVIDERS in apps/worker/src/ai/models.ts.
 */
export const CURATED_PROVIDERS = ['anthropic', 'openai', 'xai', 'amazon-bedrock'] as const;

export type CuratedProviderId = (typeof CURATED_PROVIDERS)[number];

export function isCuratedProvider(value: string): value is CuratedProviderId {
  return (CURATED_PROVIDERS as readonly string[]).includes(value);
}

/** Generic API key, honored for any provider Shannon does not curate. Mirrors the worker. */
export const GENERIC_API_KEY_ENV = 'SHANNON_AI_API_KEY';

/**
 * Env vars carrying each curated provider's API key, in precedence order. Any one of
 * them satisfies the provider. Mirrors PROVIDER_API_KEY_ENV in apps/worker/src/ai/models.ts.
 */
export const PROVIDER_API_KEY_ENV: Readonly<Record<CuratedProviderId, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  'amazon-bedrock': ['AWS_BEARER_TOKEN_BEDROCK'],
};

/** Additional env vars a curated provider requires beyond its API key. All must be set. */
export const PROVIDER_EXTRA_ENV: Readonly<Record<CuratedProviderId, readonly string[]>> = {
  anthropic: [],
  openai: [],
  xai: [],
  'amazon-bedrock': ['AWS_REGION'],
};

/** Human-readable credential requirement, used in "nothing configured" errors. */
export const PROVIDER_CREDENTIAL_HINT: Readonly<Record<CuratedProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  'amazon-bedrock': 'AWS_REGION and AWS_BEARER_TOKEN_BEDROCK',
};

/** Model used when SHANNON_AI_MODEL is unset. */
export const DEFAULT_MODEL_SPEC = 'anthropic:claude-sonnet-4-6';

/**
 * Values SHANNON_AI_OPENAI_FORMAT accepts, selecting the wire format an
 * OpenAI-compatible gateway serves. Mirrors OPENAI_FORMATS in
 * apps/worker/src/ai/models.ts; the worker validates and applies it.
 */
export const OPENAI_FORMATS = ['chat-completions', 'responses'] as const;

export type OpenAiFormat = (typeof OPENAI_FORMATS)[number];

export interface ModelSpec {
  providerId: string;
  modelId: string;
}

/**
 * Parse a `<provider>:<model-id>` spec. Splits on the first colon only, so colons
 * inside a model ID survive (`amazon-bedrock:us.anthropic.claude-opus-4-5-20251101-v1:0`).
 * The provider id is passed through as given — the worker's preflight validates it
 * against pi. Returns an error string rather than throwing, for the CLI's flow.
 */
export function parseModelSpec(spec: string): ModelSpec | string {
  const trimmed = spec.trim();
  const separator = trimmed.indexOf(':');
  const malformed = `SHANNON_AI_MODEL must be "<provider>:<model-id>", got "${trimmed}". Example: ${DEFAULT_MODEL_SPEC}`;
  if (separator === -1) return malformed;

  const providerId = trimmed.slice(0, separator).trim();
  const modelId = trimmed.slice(separator + 1).trim();
  if (!providerId || !modelId) return malformed;

  return { providerId, modelId };
}

/** Resolve the run's model spec from the environment, or an error string. */
export function resolveModelSpec(): ModelSpec | string {
  return parseModelSpec(process.env.SHANNON_AI_MODEL || DEFAULT_MODEL_SPEC);
}

/**
 * Stage-scoped model routing (fork). Mirrors apps/worker/src/ai/models.ts: the
 * same prefixes, the same suffix rule, the same failure text — the worker's
 * preflight re-validates everything, so the CLI's job is only to fail the same
 * way, earlier (before any Docker work), and to forward the variables.
 */
export const STAGE_MODEL_ENV_PREFIX = 'SHANNON_AI_MODEL_';

export const STAGE_MAX_TOKENS_ENV_PREFIX = 'SHANNON_AI_MAX_TOKENS_';

export interface StageModelEntry {
  readonly key: string;
  readonly stage: string;
  readonly spec: ModelSpec;
}

/** Normalize a stage name into its env suffix: `injection-vuln` -> `INJECTION_VULN`. Mirrors the worker. */
export function stageEnvSuffix(stage: string): string {
  return stage.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** The env var selecting one stage's model. Mirrors the worker. */
export function stageModelEnvName(stage: string): string {
  return `${STAGE_MODEL_ENV_PREFIX}${stageEnvSuffix(stage)}`;
}

/** The env var capping one stage's output tokens. Mirrors the worker. */
export function stageMaxTokensEnvName(stage: string): string {
  return `${STAGE_MAX_TOKENS_ENV_PREFIX}${stageEnvSuffix(stage)}`;
}

/**
 * Collect every stage-scoped model override the environment carries, in sorted
 * key order. Mirrors the worker's collectStageModelSpecs — including its
 * fail-loud rule: a near-miss variable (lower-case, or a value without a
 * provider) returns this error string instead of being silently ignored, so a
 * typo'd stage can never quietly route nothing. The worker throws the same
 * message at preflight; the CLI just surfaces it before Docker starts.
 */
export function collectStageModelSpecs(): StageModelEntry[] | string {
  const entries: StageModelEntry[] = [];
  const keys = Object.keys(process.env)
    .filter((key) => key.startsWith(STAGE_MODEL_ENV_PREFIX))
    .sort((a, b) => a.localeCompare(b));

  for (const key of keys) {
    const value = process.env[key];
    // An empty value means "unset" everywhere else in the chain, so only then is
    // a variable ignored; one that carries a value must name a valid stage.
    if (value === undefined || !value.trim()) continue;
    const suffix = key.slice(STAGE_MODEL_ENV_PREFIX.length);

    if (!/^[A-Z0-9_]+$/.test(suffix)) {
      return (
        `${key} is not a valid stage model variable. Use ${STAGE_MODEL_ENV_PREFIX}<STAGE> with an ` +
        `upper-case stage name, e.g. ${STAGE_MODEL_ENV_PREFIX}INJECTION_VULN. Stages are agent names ` +
        `(\`recon\`, \`injection-vuln\`, \`report\`, …) or model roles (\`small\`, \`medium\`, \`large\`).`
      );
    }

    const spec = parseModelSpec(value);
    if (typeof spec === 'string') return `${key}: ${spec}`;
    entries.push({ key, stage: suffix, spec });
  }
  return entries;
}

/**
 * Per-model price overrides (fork). Mirrors the worker's price machinery: the same
 * prefixes, the same suffix folding, the same failure text. The CLI only validates —
 * the worker's preflight re-checks and composes the rates into the models.json
 * overlay — so this returns undefined when every variable is well-formed, and the
 * worker's error string (naming the offending variable) when one is not.
 */
export const MODEL_PRICE_INPUT_ENV_PREFIX = 'SHANNON_AI_PRICE_INPUT_';

export const MODEL_PRICE_OUTPUT_ENV_PREFIX = 'SHANNON_AI_PRICE_OUTPUT_';

/** Must parse as a price: a plain non-negative decimal in USD per 1M tokens. Mirrors the worker. */
const PRICE_VALUE_PATTERN = /^\d+(\.\d+)?$/;

/** Fold a model id into its price-var suffix: `z-ai/glm-5.3` -> `Z_AI_GLM_5_3`. Mirrors the worker. */
export function modelPriceEnvSuffix(modelId: string): string {
  return modelId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** The env var pair naming one model's prices. Mirrors the worker. */
export function modelPriceEnvNames(modelId: string): { input: string; output: string } {
  const suffix = modelPriceEnvSuffix(modelId);
  return { input: `${MODEL_PRICE_INPUT_ENV_PREFIX}${suffix}`, output: `${MODEL_PRICE_OUTPUT_ENV_PREFIX}${suffix}` };
}

/**
 * Validate every price variable the environment carries. Returns undefined when all
 * are well-formed pairs, else the worker-identical error string. Same fail-loud rules:
 * a lower-case suffix, a non-decimal value, or a half-pair is a mispriced ceiling,
 * never a silently ignored variable.
 */
export function validateModelPriceVars(): string | undefined {
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || !value.trim()) continue;
    let prefix: string;
    if (key.startsWith(MODEL_PRICE_INPUT_ENV_PREFIX)) prefix = MODEL_PRICE_INPUT_ENV_PREFIX;
    else if (key.startsWith(MODEL_PRICE_OUTPUT_ENV_PREFIX)) prefix = MODEL_PRICE_OUTPUT_ENV_PREFIX;
    else continue;
    const suffix = key.slice(prefix.length);
    if (!/^[A-Z0-9_]+$/.test(suffix)) {
      return (
        `${key} is not a valid model price variable. Use ${prefix}<MODEL> with the ` +
        `model id uppercased and non-alphanumerics collapsed to \`_\`, e.g. ` +
        `${prefix}${modelPriceEnvSuffix('z-ai/glm-5.3')}.`
      );
    }
    if (!PRICE_VALUE_PATTERN.test(value.trim())) {
      return `${key} must be a plain non-negative decimal in USD per 1M tokens (got "${value.trim()}").`;
    }
    if (prefix === MODEL_PRICE_INPUT_ENV_PREFIX) inputs.add(suffix);
    else outputs.add(suffix);
  }
  for (const suffix of [...inputs].sort()) {
    if (!outputs.has(suffix)) {
      return (
        `Model price overrides come in pairs: ${MODEL_PRICE_INPUT_ENV_PREFIX}${suffix} and ` +
        `${MODEL_PRICE_OUTPUT_ENV_PREFIX}${suffix} must be set together. Price both sides or ` +
        `neither — pricing one side of every request would silently under-count spend against a ` +
        `USD ceiling.`
      );
    }
  }
  for (const suffix of [...outputs].sort()) {
    if (!inputs.has(suffix)) {
      return (
        `Model price overrides come in pairs: ${MODEL_PRICE_OUTPUT_ENV_PREFIX}${suffix} and ` +
        `${MODEL_PRICE_INPUT_ENV_PREFIX}${suffix} must be set together. Price both sides or ` +
        `neither — pricing one side of every request would silently under-count spend against a ` +
        `USD ceiling.`
      );
    }
  }
  return undefined;
}
