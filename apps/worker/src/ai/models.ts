// Copyright (C) 2026 Keygraph, Inc.
// Copyright (C) 2026 Corvus contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Model selection and resolution for the pi harness.
 *
 * One model runs the workflow by default. Users name it with a single setting:
 *
 *   SHANNON_AI_MODEL=<provider>:<model-id>
 *
 * The provider half decides the endpoint, the credential, and the API dialect;
 * the model half is passed to pi's registry as-is. The separator is a colon
 * because model IDs routinely contain slashes, and it is the *first* colon that
 * splits, because Bedrock model IDs contain colons of their own
 * (`amazon-bedrock:us.anthropic.claude-opus-4-5-20251101-v1:0`).
 *
 * Fork modification (Corvus): a stage may override the run-wide choice with
 * SHANNON_AI_MODEL_<STAGE> (and SHANNON_AI_MAX_TOKENS_<STAGE> for its output
 * budget). Stages are agent names and model roles; see the routing section
 * below resolveModelSpec.
 *
 * Resolution returns a pi `Model` plus the `ModelRuntime` that owns its auth,
 * built over an in-memory credential store primed from the environment.
 *
 * The CLI cannot import this module (it ships as a separate bundle), so
 * `apps/cli/src/model-spec.ts` mirrors the parse rule and the provider/credential
 * tables by hand for its own `status` rendering and setup wizard. The two copies
 * have no shared compile-time link: a provider added or renamed on one side and
 * not the other does not fail to build, it just makes the CLI's guidance or
 * guard rails disagree with what the worker actually accepts at runtime.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Api, Credential, CredentialInfo, CredentialStore, Model } from '@earendil-works/pi-ai';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';

/**
 * Providers Shannon curates with their own credential variables, config sections,
 * and setup flows. Each is a pi-ai provider id; any other pi provider is still
 * reachable through the generic credential path below.
 *
 * Kept identical to the CLI's own copy of this list (`apps/cli/src/model-spec.ts`),
 * which the CLI uses to decide whether "only one provider is configured" and to
 * gate its "Other provider" setup option. A curated provider missing from one
 * copy is silently treated as generic on that side.
 */
export const CURATED_PROVIDERS = ['anthropic', 'openai', 'xai', 'amazon-bedrock'] as const;

export type CuratedProviderId = (typeof CURATED_PROVIDERS)[number];

function isCuratedProvider(value: string): value is CuratedProviderId {
  return (CURATED_PROVIDERS as readonly string[]).includes(value);
}

/** Generic API key, honored for any provider Shannon does not curate. */
export const GENERIC_API_KEY_ENV = 'SHANNON_AI_API_KEY';

/**
 * Env vars carrying each curated provider's API key, in precedence order. Shannon
 * does not invent credential names — these are the variables each provider's own
 * tooling uses. Bedrock pairs its bearer token with AWS_REGION, which is provider
 * config rather than a credential.
 *
 * Mirrored by the CLI's own table of the same name, used there to decide which
 * env vars to forward into the worker container. A variable added here without
 * its CLI counterpart never reaches the container: the worker looks for a
 * credential the CLI never forwarded, and preflight reports it as absent.
 */
export const PROVIDER_API_KEY_ENV: Readonly<Record<CuratedProviderId, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  'amazon-bedrock': ['AWS_BEARER_TOKEN_BEDROCK'],
};

/** Model used when SHANNON_AI_MODEL is unset. */
export const DEFAULT_MODEL_SPEC = 'anthropic:claude-sonnet-4-6';

/** Browsable pi model catalogue — the source of valid `<provider>:<model-id>` ids. */
export const PI_CATALOG_URL = 'https://pi.dev/models';

/**
 * Wire formats an OpenAI-compatible gateway may serve, named by
 * SHANNON_AI_OPENAI_FORMAT. Only `openai` offers a choice: every other supported
 * provider has exactly one API in pi's registry.
 */
export const OPENAI_FORMATS = {
  'chat-completions': 'openai-completions',
  responses: 'openai-responses',
} as const;

export type OpenAiFormat = keyof typeof OPENAI_FORMATS;

/** Format assumed when a gateway is configured but no format is named. */
export const DEFAULT_OPENAI_FORMAT: OpenAiFormat = 'chat-completions';

/**
 * Fork modification (Corvus): context window and output ceiling advertised for a
 * gateway pass-through model — an id the catalogue does not know, described by
 * borrowing a reference model's descriptor. The borrow gives an unseen id a
 * shape; its window and ceiling are the reference's, and pi clamps every
 * request's output budget to `contextWindow - context - 4096` (pi-ai
 * `clampMaxTokensToContext`). A small borrowed window starves the agent: a
 * gateway run whose reference carried an 8192-token window left 16 output
 * tokens, so the model died mid-sentence on its first turn with no room for a
 * tool call and the pipeline failed output validation on every retry. A gateway
 * id names a model the catalogue never measured, so the fork advertises
 * generous defaults — the serving endpoint enforces the real limit — with env
 * overrides for operators whose gateway model has a genuinely small window.
 */
export const GATEWAY_CONTEXT_WINDOW_ENV = 'SHANNON_AI_CONTEXT_WINDOW';
export const GATEWAY_MAX_TOKENS_ENV = 'SHANNON_AI_MAX_TOKENS';
export const GATEWAY_DEFAULT_CONTEXT_WINDOW = 200_000;
export const GATEWAY_DEFAULT_MAX_TOKENS = 32_768;

export interface GatewayLimits {
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/** Read a positive-integer env var. Unset is undefined; garbage fails loud. */
function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

/** Limits a gateway pass-through model advertises, from env or the fork defaults. */
export function resolveGatewayLimits(): GatewayLimits {
  return {
    contextWindow: positiveIntEnv(GATEWAY_CONTEXT_WINDOW_ENV) ?? GATEWAY_DEFAULT_CONTEXT_WINDOW,
    maxTokens: positiveIntEnv(GATEWAY_MAX_TOKENS_ENV) ?? GATEWAY_DEFAULT_MAX_TOKENS,
  };
}

function isOpenAiFormat(value: string): value is OpenAiFormat {
  return value in OPENAI_FORMATS;
}

/**
 * Read SHANNON_AI_OPENAI_FORMAT. Unset returns undefined, which lets the caller
 * distinguish "not configured" from an explicit choice and reject the variable
 * where it has no effect.
 */
export function resolveOpenAiFormat(): OpenAiFormat | undefined {
  const raw = process.env.SHANNON_AI_OPENAI_FORMAT?.trim();
  if (!raw) return undefined;

  if (!isOpenAiFormat(raw)) {
    throw new Error(
      `SHANNON_AI_OPENAI_FORMAT must be one of: ${Object.keys(OPENAI_FORMATS).join(', ')}. Got "${raw}".`,
    );
  }
  return raw;
}

export interface ModelSpec {
  providerId: string;
  modelId: string;
}

/**
 * Parse a `<provider>:<model-id>` spec. Splits on the first colon only, so colons
 * inside a model ID survive. The provider id is passed through as given — pi's
 * registry validates it later — so this throws only on a malformed spec.
 */
export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim();
  const separator = trimmed.indexOf(':');
  if (separator === -1) {
    throw new Error(
      `SHANNON_AI_MODEL must be "<provider>:<model-id>", got "${trimmed}". Example: ${DEFAULT_MODEL_SPEC}`,
    );
  }

  const providerId = trimmed.slice(0, separator).trim();
  const modelId = trimmed.slice(separator + 1).trim();

  if (!providerId || !modelId) {
    throw new Error(
      `SHANNON_AI_MODEL must be "<provider>:<model-id>", got "${trimmed}". Example: ${DEFAULT_MODEL_SPEC}`,
    );
  }

  return { providerId, modelId };
}

/** Resolve the run's model from SHANNON_AI_MODEL, falling back to the default. */
export function resolveModelSpec(): ModelSpec {
  return parseModelSpec(process.env.SHANNON_AI_MODEL || DEFAULT_MODEL_SPEC);
}

// ---------------------------------------------------------------------------
// Fork modification (Corvus): per-stage model routing and output budgets.
//
// Upstream runs one model for the whole workflow. The fork lets an operator
// route a different model per stage: SHANNON_AI_MODEL_<STAGE> overrides
// SHANNON_AI_MODEL for that stage alone. A stage is an agent name
// (`recon`, `injection-vuln`, `report`, `validate-authentication`, …) or a
// model-role name (`small`, `medium`, `large` — the ModelHost seam shared by
// task formation and Capella). The env suffix is the stage uppercased with
// runs of non-alphanumerics collapsed to `_`, so `injection-vuln` reads
// SHANNON_AI_MODEL_INJECTION_VULN. Sub-agents (`task` tool) inherit their
// parent's model, as upstream.
//
// Output budgets follow the same shape: SHANNON_AI_MAX_TOKENS_<STAGE> replaces
// the advertised output ceiling for that stage's model descriptor.
// ---------------------------------------------------------------------------

/** Prefix of every stage-scoped model env var (`SHANNON_AI_MODEL_<STAGE>`). */
export const STAGE_MODEL_ENV_PREFIX = 'SHANNON_AI_MODEL_';

/** Prefix of every stage-scoped output-budget env var (`SHANNON_AI_MAX_TOKENS_<STAGE>`). */
export const STAGE_MAX_TOKENS_ENV_PREFIX = 'SHANNON_AI_MAX_TOKENS_';

/** Suffix a stage contributes to its env vars: uppercased, non-alphanumerics collapsed to `_`. */
export function stageEnvSuffix(stage: string): string {
  return stage.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Env var carrying a stage's model override. */
export function stageModelEnvName(stage: string): string {
  return `${STAGE_MODEL_ENV_PREFIX}${stageEnvSuffix(stage)}`;
}

/** Env var carrying a stage's output-budget override. */
export function stageMaxTokensEnvName(stage: string): string {
  return `${STAGE_MAX_TOKENS_ENV_PREFIX}${stageEnvSuffix(stage)}`;
}

/**
 * Every stage-scoped model var the environment carries, as `{ key, stage, spec }`
 * in sorted key order. Keys under the fork's SHANNON_AI_MODEL_ namespace that do
 * not match the `_<UPPER_SNAKE>` shape fail loud rather than being silently
 * ignored — a near-miss variable (a typo'd stage) must never quietly route
 * nothing. The stage string is the uppercase suffix; whether a stage actually
 * exists is judged by the caller (preflight warns about unknown names).
 */
export function collectStageModelSpecs(): ReadonlyArray<{
  readonly key: string;
  readonly stage: string;
  readonly spec: ModelSpec;
}> {
  const entries: { key: string; stage: string; spec: ModelSpec }[] = [];
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(STAGE_MODEL_ENV_PREFIX)) continue;
    const value = process.env[key];
    // An empty value means "unset" everywhere else in the chain, so only then is
    // a variable ignored; one that carries a value must name a valid stage.
    if (value === undefined || !value.trim()) continue;
    const suffix = key.slice(STAGE_MODEL_ENV_PREFIX.length);

    if (!/^[A-Z0-9_]+$/.test(suffix)) {
      throw new Error(
        `${key} is not a valid stage model variable. Use ${STAGE_MODEL_ENV_PREFIX}<STAGE> with an ` +
          `upper-case stage name, e.g. ${STAGE_MODEL_ENV_PREFIX}INJECTION_VULN. Stages are agent names ` +
          `(\`recon\`, \`injection-vuln\`, \`report\`, …) or model roles (\`small\`, \`medium\`, \`large\`).`,
      );
    }
    // The parser's own message blames SHANNON_AI_MODEL; re-throw naming this key so
    // the operator fixes the variable that is actually wrong.
    try {
      entries.push({ key, stage: suffix, spec: parseModelSpec(value) });
    } catch (error) {
      throw new Error(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}

/**
 * The model spec one stage runs on: its SHANNON_AI_MODEL_<STAGE> override when
 * set, otherwise the run-wide SHANNON_AI_MODEL (or the fork default).
 */
export function resolveStageModelSpec(stage: string | undefined): ModelSpec {
  if (stage !== undefined) {
    const raw = process.env[stageModelEnvName(stage)]?.trim();
    if (raw) return parseModelSpec(raw);
  }
  return resolveModelSpec();
}

export interface ProviderCredentials {
  /** Endpoint override, applied whatever the provider (proxies, gateways). */
  baseUrl?: string;
  /** Runtime API key primed into the ModelRuntime's credential store. */
  apiKey?: string;
}

/**
 * Collect the API key and optional endpoint override for a provider. A curated
 * provider's own variables win, then the generic SHANNON_AI_API_KEY. Bedrock is
 * excluded — it authenticates through its AWS_ variables, which pi reads directly.
 */
export function resolveProviderCredentials(providerId: string): ProviderCredentials {
  const credentials: ProviderCredentials = {};

  const namedVars = isCuratedProvider(providerId) ? PROVIDER_API_KEY_ENV[providerId] : [];
  for (const name of namedVars) {
    const value = process.env[name];
    if (value) {
      credentials.apiKey = value;
      break;
    }
  }
  if (!credentials.apiKey && providerId !== 'amazon-bedrock' && process.env[GENERIC_API_KEY_ENV]) {
    credentials.apiKey = process.env[GENERIC_API_KEY_ENV];
  }
  if (process.env.SHANNON_AI_BASE_URL) credentials.baseUrl = process.env.SHANNON_AI_BASE_URL;

  return credentials;
}

/**
 * In-memory credential store holding the selected provider's API key.
 *
 * pi ships the `CredentialStore` interface but no in-memory implementation — its
 * own store reads `auth.json` from disk. Shannon's credentials arrive as env vars
 * in an ephemeral container, so nothing may be read from or written to disk.
 */
class RuntimeCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();

  constructor(providerId: string, apiKey: string | undefined) {
    if (apiKey) {
      this.credentials.set(providerId, { type: 'api_key', key: apiKey });
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.credentials.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  /** Serialized read-modify-write. `fn` returning undefined leaves the entry alone. */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await fn(this.credentials.get(providerId));
    if (next !== undefined) {
      this.credentials.set(providerId, next);
    }
    return this.credentials.get(providerId);
  }

  async delete(providerId: string): Promise<void> {
    this.credentials.delete(providerId);
  }
}

/** The file pi reads credentials from: the agent dir's auth.json. */
function piAuthPath(): string {
  return path.join(getAgentDir(), 'auth.json');
}

/** Whether the host's pi credentials are mounted (auth.json present in the agent dir). */
export function piAuthPresent(): boolean {
  return existsSync(piAuthPath());
}

/**
 * Build a ModelRuntime whose only credential is the one supplied. Model catalogs
 * stay offline (`allowModelNetwork` defaults to false) so a scan never blocks on
 * a catalog refresh.
 *
 * When the host's pi auth.json is present, the runtime reads it instead: pi's
 * disk-backed store resolves the credential. The mount is writable so OAuth
 * refreshes persist to the host for subsequent runs.
 */
export async function createModelRuntime(providerId: string, apiKey: string | undefined): Promise<ModelRuntime> {
  if (piAuthPresent()) {
    return ModelRuntime.create({ authPath: piAuthPath() });
  }
  return ModelRuntime.create({ credentials: new RuntimeCredentialStore(providerId, apiKey) });
}

export interface ModelSelection {
  readonly model: Model<Api>;
  readonly modelRuntime: ModelRuntime;
  readonly modelId: string;
  readonly providerId: string;
  readonly credentialSource: 'api-key' | 'pi-auth' | 'ambient';
}

/**
 * Point a model descriptor at a gateway.
 *
 * An OpenAI gateway may serve either wire format, named by
 * SHANNON_AI_OPENAI_FORMAT and defaulting to chat completions, which is what
 * most gateway software exposes. Switching to completions also drops the stored
 * `compat` block: the catalogue's block describes Responses, and an explicit
 * entry outranks pi's `detectCompat`, so leaving it would apply Responses
 * settings to a completions request. Staying on Responses keeps it, since it
 * then describes the format in use. Every other provider has one API and only
 * changes address.
 */
function pointAtGateway(model: Model<Api>, providerId: string, baseUrl: string, format: OpenAiFormat): Model<Api> {
  if (providerId !== 'openai') return { ...model, baseUrl };
  if (format === 'responses') return { ...model, baseUrl, api: OPENAI_FORMATS.responses };

  const { compat: _responsesCompat, ...withoutCompat } = model;
  return { ...withoutCompat, baseUrl, api: OPENAI_FORMATS['chat-completions'] };
}

/**
 * Resolve a model against a runtime.
 *
 * Direct to a provider, the model must exist in the catalogue. Behind a custom
 * endpoint it need not: a gateway may serve models under its own names, so an
 * unknown id is passed through on a descriptor borrowed from the provider's
 * catalogue for its API dialect. Cost and context window on such a descriptor
 * are the reference model's, so spend figures are approximate there.
 *
 * Returns undefined when the id is unresolvable — unknown with no endpoint
 * override, or a provider carrying no models at all.
 */
export function resolveModel(
  modelRuntime: ModelRuntime,
  providerId: string,
  modelId: string,
  baseUrl: string | undefined,
  format: OpenAiFormat = DEFAULT_OPENAI_FORMAT,
): Model<Api> | undefined {
  const found = modelRuntime.getModel(providerId, modelId);
  if (found) {
    return baseUrl ? pointAtGateway(found, providerId, baseUrl, format) : found;
  }
  if (!baseUrl) return undefined;

  const reference = modelRuntime.getModels(providerId)[0];
  if (!reference) return undefined;

  // Fork modification (Corvus): the pass-through borrows the reference's shape
  // but not its output headroom — the borrowed window feeds pi's output clamp
  // and a small one starves the agent (see resolveGatewayLimits). Only ids the
  // catalogue does not know land here; a known id carries its own measured limits.
  const limits = resolveGatewayLimits();
  return pointAtGateway(
    {
      ...reference,
      id: modelId,
      name: modelId,
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxTokens,
    },
    providerId,
    baseUrl,
    format,
  );
}

/**
 * Validate SHANNON_AI_OPENAI_FORMAT against the rest of the configuration and
 * return the format a gateway run should use.
 *
 * The variable only reaches a request when both an OpenAI model and a gateway
 * are configured, so it is rejected outside that combination rather than
 * silently ignored.
 */
export function resolveGatewayFormat(providerId: string, baseUrl: string | undefined): OpenAiFormat {
  const configured = resolveOpenAiFormat();
  if (!configured) return DEFAULT_OPENAI_FORMAT;

  if (providerId !== 'openai') {
    throw new Error(
      `SHANNON_AI_OPENAI_FORMAT applies to openai models only, but SHANNON_AI_MODEL selects "${providerId}". ` +
        `${providerId} serves a single API, so there is no format to choose.`,
    );
  }
  if (!baseUrl) {
    throw new Error(
      'SHANNON_AI_OPENAI_FORMAT applies to gateway runs only. Set SHANNON_AI_BASE_URL, or unset the format to call OpenAI directly.',
    );
  }
  return configured;
}

/**
 * Where pi reads its provider/model overlay from: the agent dir's models.json.
 */
export function gatewayModelsJsonPath(): string {
  return path.join(getAgentDir(), 'models.json');
}

/**
 * Fork modification (Corvus): make SHANNON_AI_OPENAI_FORMAT authoritative on the
 * ModelRuntime path by declaring the run's gateway models in pi's models.json.
 *
 * Why: without an overlay for a provider, pi's ModelRuntime uses the builtin
 * provider untouched, whose one stream implementation serves the Responses API
 * for every openai model — the descriptor's `api: "openai-completions"` is
 * carried but never consulted, so a chat-completions gateway is silently called
 * over /responses. With an overlay pi composes the provider, and its dispatch
 * honors the model's `api` (a `openai-completions` model with no
 * completions-tagged builtin falls through to the registered completions API).
 * Declaring the model also puts it in the catalogue, so resolution stops
 * borrowing a reference descriptor and the entry carries the fork's gateway
 * limits directly. Verified on the wire: the same run reaches /chat/completions
 * with the overlay and /responses without it.
 *
 * Scope: only an OpenAI provider behind a gateway in chat-completions format
 * needs this — the responses format is served faithfully by the builtin path,
 * and every other provider has exactly one API. An existing models.json is left
 * untouched: an operator who wrote one owns the composition (their entry wins,
 * and the format variable is then advisory). Cost on a declared entry is zero —
 * a gateway id has no measured pricing; the serving provider's own usage
 * figures are the honest source until per-run price overrides exist.
 *
 * The write is atomic (temp file + rename) so parallel lane activities that
 * resolve models concurrently can never read a half-written file, and identical
 * concurrent writes are last-wins with the same content.
 */
export function materializeGatewayModelsJson(target: string = gatewayModelsJsonPath()): string | undefined {
  const openAiSpecs = [resolveModelSpec(), ...collectStageModelSpecs().map((entry) => entry.spec)]
    .filter((spec) => spec.providerId === 'openai')
    .filter((spec, index, all) => all.findIndex((other) => other.modelId === spec.modelId) === index);
  if (openAiSpecs.length === 0) return undefined;

  const baseUrl = resolveProviderCredentials('openai').baseUrl;
  if (!baseUrl) return undefined;

  const format = resolveGatewayFormat('openai', baseUrl);
  if (format !== 'chat-completions') return undefined;

  if (existsSync(target)) return undefined;

  const limits = resolveGatewayLimits();
  const document = {
    providers: {
      openai: {
        baseUrl,
        models: openAiSpecs.map((spec) => ({
          id: spec.modelId,
          api: OPENAI_FORMATS['chat-completions'],
          contextWindow: limits.contextWindow,
          maxTokens: limits.maxTokens,
        })),
      },
    },
  };

  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
  renameSync(temporary, target);
  return target;
}

/**
 * Resolve the model one stage runs on, build a ModelRuntime primed with the
 * provider's credential, and look the model up in it. `stage` is an agent name
 * or model role; without one this is the run-wide selection.
 */
export async function resolveModelSelection(stage?: string): Promise<ModelSelection> {
  const { providerId, modelId } = resolveStageModelSpec(stage);
  const credentials = resolveProviderCredentials(providerId);
  const format = resolveGatewayFormat(providerId, credentials.baseUrl);

  materializeGatewayModelsJson();

  const mountedPiAuth = piAuthPresent();
  const modelRuntime = await createModelRuntime(providerId, credentials.apiKey);

  let model = resolveModel(modelRuntime, providerId, modelId, credentials.baseUrl, format);
  if (!model) {
    throw new Error(
      `Model not found in pi registry: provider="${providerId}" model="${modelId}". Browse valid providers and models at ${PI_CATALOG_URL}.`,
    );
  }

  // Stage output budget: replaces the descriptor's advertised ceiling. The
  // serving endpoint still enforces the model's real limit, and pi still clamps
  // the request to the context window — this only shapes the headroom an agent
  // asks for (e.g. cap a cheap stage, widen a reasoning-heavy one).
  const stageMaxTokens = stage !== undefined ? positiveIntEnv(stageMaxTokensEnvName(stage)) : undefined;
  if (stageMaxTokens !== undefined) {
    model = { ...model, maxTokens: stageMaxTokens };
  }

  let credentialSource: ModelSelection['credentialSource'] = 'ambient';
  if (mountedPiAuth) {
    credentialSource = 'pi-auth';
  } else if (credentials.apiKey) {
    credentialSource = 'api-key';
  }

  return {
    model,
    modelRuntime,
    modelId,
    providerId,
    credentialSource,
  };
}
