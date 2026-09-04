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
