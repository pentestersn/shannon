/**
 * Environment variable loading and credential validation.
 *
 * Local mode: loads ./.env via dotenv.
 * NPX mode: fills gaps from ~/.shannon/config.toml (no .env).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { resolveConfig } from './config/resolver.js';
import { getMode } from './mode.js';
import {
  CURATED_PROVIDERS,
  type CuratedProviderId,
  collectStageModelSpecs,
  GENERIC_API_KEY_ENV,
  isCuratedProvider,
  PROVIDER_API_KEY_ENV,
  PROVIDER_CREDENTIAL_HINT,
  PROVIDER_EXTRA_ENV,
  resolveModelSpec,
  validateModelPriceVars,
} from './model-spec.js';

/**
 * Variables forwarded to every worker container regardless of provider. Each is
 * forwarded only when set, so an unused one never appears in the container.
 * SHANNON_AI_API_KEY rides along because it is provider-neutral.
 */
const COMMON_FORWARD_VARS = [
  'SHANNON_AI_MODEL',
  'SHANNON_AI_BASE_URL',
  'SHANNON_AI_OPENAI_FORMAT',
  // Fork modification (Corvus): gateway pass-through model limits. The worker's
  // resolveGatewayLimits reads these; without forwarding they silently miss the
  // container and a gateway id keeps its borrowed (possibly tiny) window.
  'SHANNON_AI_CONTEXT_WINDOW',
  'SHANNON_AI_MAX_TOKENS',
  // Opt-in debug flag: when set, the worker persists a bounded, sanitized snippet of a failed
  // provider turn's raw error message to error.log. Off by default; provider prose stays out of
  // durable state unless an operator deliberately enables it for a diagnosis.
  'SHANNON_DEBUG_PROVIDER_ERRORS',
  GENERIC_API_KEY_ENV,
] as const;

/**
 * Fork modification (Corvus): stage-scoped model routing and per-model prices.
 * Every well-formed stage override is forwarded by pattern — there are more
 * stages than anyone wants to list, and an unset one must never appear in the
 * container. Only upper-case stage names match; validateCredentials rejects
 * anything else up front, so a near-miss variable can never slip into a scan
 * silently. The price variables follow the same pattern-forwarding rule: the
 * worker composes them into the models.json overlay, and the CLI has no reason
 * to know which model ids the run selects.
 */
const STAGE_MODEL_VAR = /^SHANNON_AI_MODEL_[A-Z0-9_]+$/;
const STAGE_MAX_TOKENS_VAR = /^SHANNON_AI_MAX_TOKENS_[A-Z0-9_]+$/;
const MODEL_PRICE_VAR = /^SHANNON_AI_PRICE_(INPUT|OUTPUT)_[A-Z0-9_]+$/;

function stageForwardVars(): string[] {
  return Object.keys(process.env)
    .filter((key) => STAGE_MODEL_VAR.test(key) || STAGE_MAX_TOKENS_VAR.test(key) || MODEL_PRICE_VAR.test(key))
    .sort();
}

/**
 * Credential variables for one provider. Only the selected provider's entries are
 * forwarded, so a key for an unused provider never enters the scan container. An
 * uncurated provider has none — it relies on the common SHANNON_AI_API_KEY.
 */
function providerForwardVars(providerId: string): readonly string[] {
  if (!isCuratedProvider(providerId)) return [];
  return [...PROVIDER_API_KEY_ENV[providerId], ...PROVIDER_EXTRA_ENV[providerId]];
}

/**
 * Providers whose credentials the scan container needs: the run-wide model's
 * plus every stage override's (fork — a stage may run on another provider).
 * An unparseable selection contributes nothing here; validateCredentials has
 * already rejected it before Docker work begins.
 */
function scanProviders(): string[] {
  const providers = new Set<string>();
  const spec = resolveModelSpec();
  if (typeof spec !== 'string') providers.add(spec.providerId);
  const stageEntries = collectStageModelSpecs();
  if (Array.isArray(stageEntries)) {
    for (const entry of stageEntries) providers.add(entry.spec.providerId);
  }
  return [...providers];
}

/** Parse a user-facing boolean env var: `1`/`true` (any case) true, `0`/`false`/empty false, else the default. */
export function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return defaultValue;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return defaultValue;
}

// Fork modification (Corvus): governed egress. Setting SHANNON_PROXY_URL points
// the whole scan at an enforcing forward proxy (the Corvus EnforcingProxy):
// the browser launches with --proxy-server (worker playwright-config-writer),
// env-honoring clients inherit HTTP_PROXY/HTTPS_PROXY with NO_PROXY emptied,
// and /etc/hosts forwarding is disabled (docker.ts). Raw sockets remain the
// documented residual breach — this governs every client that plays by the rules.
export const EGRESS_PROXY_ENV = 'SHANNON_PROXY_URL';

/** The run's enforcing proxy URL, or undefined when egress is ungoverned. */
export function governedProxyUrl(): string | undefined {
  const raw = process.env[EGRESS_PROXY_ENV]?.trim();
  return raw === '' ? undefined : raw;
}

/**
 * Validate the egress proxy URL: it must parse as an http(s) URL with a host.
 * Runs before any Docker work (validateCredentials step 1d) — a typo'd URL
 * would otherwise surface as a browser that can reach nothing mid-scan.
 */
function validateEgressProxyUrl(): string | undefined {
  const raw = governedProxyUrl();
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `${EGRESS_PROXY_ENV} is set but "${raw}" does not parse as a URL. Set it to the proxy's http(s) URL, e.g. http://172.18.0.1:9400.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${EGRESS_PROXY_ENV} must be an http(s) URL, got protocol "${parsed.protocol}".`;
  }
  if (parsed.hash !== '' || parsed.search !== '') {
    return `${EGRESS_PROXY_ENV} must be a bare proxy URL — no query or fragment.`;
  }
  if (parsed.hostname === '') {
    return `${EGRESS_PROXY_ENV} is set but carries no host.`;
  }
  return undefined;
}

const USE_PI_AUTH_ENV = 'SHANNON_USE_PI_AUTH';

/** Where the host's auth.json is mounted: pi's standard location (worker HOME is /tmp), read natively. */
export const PI_AUTH_CONTAINER_PATH = '/tmp/.pi/agent/auth.json';

/** Host path to pi's credential file. */
export function resolveHostPiAuthPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'auth.json');
}

export function piAuthFlagEnabled(): boolean {
  return envBool(USE_PI_AUTH_ENV, false);
}

/** Opted into pi auth via the flag, and the auth file exists to mount. */
export function shouldUsePiAuth(): boolean {
  return piAuthFlagEnabled() && fs.existsSync(resolveHostPiAuthPath());
}

/**
 * Load credentials into process.env.
 * Local mode: loads ./.env via dotenv.
 * NPX mode: fills gaps from ~/.shannon/config.toml.
 * Exported env vars always take precedence in both modes.
 */
export function loadEnv(): void {
  if (getMode() === 'local') {
    dotenv.config({ path: '.env', quiet: true });
  } else {
    resolveConfig();
  }
}

/**
 * Build `-e` flags for docker run. Forwards the common vars plus the
 * credentials of every provider the scan will use (the run-wide model's plus
 * each stage override's — fork), passed by name (`-e KEY`) so secret values
 * stay out of the `docker run` argv; docker inherits them from this process's env.
 */
/**
 * Fork modification (Corvus): the NO_PROXY allowlist for a governed run —
 * exactly the infrastructure hosts, never the scan target. The Temporal
 * control plane is always the compose service name the CLI forwards as
 * TEMPORAL_ADDRESS (shannon-temporal:7233); its gRPC client reads the
 * lowercase proxy variables, so without an exclusion the worker's own
 * control plane gets gated by a scope proxy that only knows the scan
 * target (found live). The LLM gateway host, when a gateway run names one
 * (SHANNON_AI_BASE_URL), is infrastructure the same way — a scan never
 * targets its own model gateway. Loopback inside the container is the
 * container itself; a target URL never names it (the CLI rewrites loopback
 * targets to the host gateway before the container sees them).
 */
function infraNoProxyList(): string {
  const hosts = new Set(['localhost', '127.0.0.1', '::1', 'shannon-temporal']);
  const baseUrl = process.env.SHANNON_AI_BASE_URL?.trim();
  if (baseUrl !== undefined && baseUrl !== '') {
    try {
      const host = new URL(baseUrl).hostname;
      if (host !== '') hosts.add(host);
    } catch {
      // An unparseable base URL contributes no exclusion — there is no
      // hostname to exempt, and the proxy env governs everything else.
    }
  }
  return [...hosts].join(',');
}

export function buildEnvFlags(): string[] {
  const flags: string[] = ['-e', 'TEMPORAL_ADDRESS=shannon-temporal:7233'];

  const providerVars = scanProviders().flatMap((providerId) => providerForwardVars(providerId));

  for (const key of [...COMMON_FORWARD_VARS, ...providerVars, ...stageForwardVars()]) {
    if (process.env[key]) {
      flags.push('-e', key);
    }
  }

  // Fork modification (Corvus): governed egress — forward the proxy URL plus
  // the conventional proxy variables. The values are set in this process's
  // env and passed by name (`-e KEY`): a proxy URL may carry credentials and
  // must not appear in the `docker run` argv.
  //
  // BOTH letter cases are set and forwarded: curl deliberately ignores
  // uppercase HTTP_PROXY for plain-http URLs (a CGI safety carve-out) and
  // reads only the lowercase spelling — found live when a scan's own curl
  // bypassed the gate. The Temporal client is the same kind of reader (its
  // gRPC stack reads lowercase too — also found live), which is exactly why
  // NO_PROXY below names the infrastructure hosts and nothing else: the
  // worker's control plane (shannon-temporal) and the LLM gateway are
  // infrastructure, never the scan target, and a scope proxy that sees them
  // must not gate them. Everything else in the container — the scan target
  // first — stays governed: NO_PROXY is an allowlist of infrastructure, not
  // an escape hatch, and it is never empty.
  const proxyUrl = governedProxyUrl();
  if (proxyUrl !== undefined) {
    const noProxy = infraNoProxyList();
    for (const key of ['HTTP_PROXY', 'http_proxy']) process.env[key] = proxyUrl;
    for (const key of ['HTTPS_PROXY', 'https_proxy']) process.env[key] = proxyUrl;
    process.env.NO_PROXY = noProxy;
    process.env.no_proxy = noProxy;
    flags.push(
      '-e',
      EGRESS_PROXY_ENV,
      '-e',
      'HTTP_PROXY',
      '-e',
      'http_proxy',
      '-e',
      'HTTPS_PROXY',
      '-e',
      'https_proxy',
    );
    flags.push('-e', `NO_PROXY=${noProxy}`, '-e', `no_proxy=${noProxy}`);
  }

  return flags;
}

interface CredentialValidation {
  valid: boolean;
  error?: string;
}

/**
 * Whether the shell environment already carries a usable credential — the host's
 * pi login, or an API key for the selected provider. Reads process.env only.
 */
export function hasExportedCredentials(): boolean {
  if (shouldUsePiAuth()) return true;
  const spec = resolveModelSpec();
  if (typeof spec === 'string') return false;
  return hasCredential(spec.providerId);
}

/** Whether a curated provider has its own named credential set (API key plus any extra var). */
function hasNamedCredential(providerId: CuratedProviderId): boolean {
  const apiKeys = PROVIDER_API_KEY_ENV[providerId];
  if (!apiKeys.some((name) => Boolean(process.env[name]))) return false;
  return PROVIDER_EXTRA_ENV[providerId].every((name) => Boolean(process.env[name]));
}

/** Whether the selected provider has a credential. Bedrock needs its AWS_ vars; the generic key never stands in for it. */
function hasCredential(providerId: string): boolean {
  if (providerId === 'amazon-bedrock') return hasNamedCredential('amazon-bedrock');
  if (isCuratedProvider(providerId) && hasNamedCredential(providerId)) return true;
  return Boolean(process.env[GENERIC_API_KEY_ENV]);
}

/** Curated providers with a named credential. The generic key is neutral, so it never counts toward ambiguity. */
function configuredProviders(): CuratedProviderId[] {
  return CURATED_PROVIDERS.filter((providerId) => hasNamedCredential(providerId));
}

/** Whether SHANNON_AI_MODEL was set by the user, rather than falling back to the default. */
function modelExplicitlySelected(): boolean {
  return Boolean(process.env.SHANNON_AI_MODEL?.trim());
}

/**
 * Explain why the selected provider has no usable credential. With no model chosen
 * the provider is only the default (anthropic), so the real state is "nothing
 * configured" — or, if another provider's key is set, an unselected model.
 * `source` names the variable that picked the provider (fork: a stage override).
 */
function describeMissingCredential(providerId: string, source?: string): string {
  if (source !== undefined || modelExplicitlySelected()) {
    const requirement = isCuratedProvider(providerId) ? PROVIDER_CREDENTIAL_HINT[providerId] : GENERIC_API_KEY_ENV;
    const hint =
      getMode() === 'local'
        ? `Set ${requirement} in .env or export it.`
        : `Export the variables or run 'npx @keygraph/shannon setup'.`;
    const origin = source !== undefined ? ` (selected by ${source})` : '';
    return `No credentials found for provider "${providerId}"${origin}. ${hint}`;
  }

  const [provider] = configuredProviders();
  if (provider) {
    return `A credential for "${provider}" is set, but no model is selected. Set SHANNON_AI_MODEL=${provider}:<model-id> to use it.`;
  }

  const hint =
    getMode() === 'local'
      ? 'Set a provider API key in .env (for example ANTHROPIC_API_KEY).'
      : "Run 'npx @keygraph/shannon setup' to get started.";
  return `No credentials configured. ${hint}`;
}

/**
 * Validate that the model selection parses and its provider has a credential.
 * Runs before any Docker work so mistakes fail immediately.
 */
export function validateCredentials(): CredentialValidation {
  // 1. Model selection must parse into a provider and model id
  const spec = resolveModelSpec();
  if (typeof spec === 'string') {
    return { valid: false, error: spec };
  }

  // 1b. Fork: every stage-scoped override must parse too. The worker re-checks at
  //     preflight, but by then a container is already up; a typo'd or malformed
  //     SHANNON_AI_MODEL_<STAGE> fails here instead, before any Docker work. This
  //     needs no credentials, so it also runs under pi-auth.
  const stageEntries = collectStageModelSpecs();
  if (typeof stageEntries === 'string') {
    return { valid: false, error: stageEntries };
  }

  // 1c. Fork: the per-model price variables must be well-formed pairs — a half-pair
  //     or malformed rate would make a USD budget ceiling count the wrong spend.
  //     Same rule as 1b: fail here, before any Docker work.
  const priceError = validateModelPriceVars();
  if (priceError !== undefined) {
    return { valid: false, error: priceError };
  }

  // 1d. Fork: a set egress proxy URL must parse as a bare http(s) URL — the
  //     whole scan is pointed at it, so a typo fails here, before any Docker
  //     work, not as a browser that can reach nothing mid-scan.
  const proxyError = validateEgressProxyUrl();
  if (proxyError !== undefined) {
    return { valid: false, error: proxyError };
  }

  // Pi-auth: skip the API-key checks, but the host auth file must exist to mount.
  if (piAuthFlagEnabled()) {
    const authPath = resolveHostPiAuthPath();
    if (!fs.existsSync(authPath)) {
      return {
        valid: false,
        error: `${USE_PI_AUTH_ENV} is set but no pi credentials were found at ${authPath}. Authenticate with pi first.`,
      };
    }
    return { valid: true };
  }

  // 2. The selected provider must have a credential
  if (!hasCredential(spec.providerId)) {
    return { valid: false, error: describeMissingCredential(spec.providerId) };
  }

  // 2b. Fork: each stage override's provider needs a credential too — same rule
  //     as the base: the named provider's own key, or the generic one.
  for (const entry of stageEntries) {
    if (!hasCredential(entry.spec.providerId)) {
      return { valid: false, error: describeMissingCredential(entry.spec.providerId, entry.key) };
    }
  }

  // 3. A configured provider nothing selects is ambiguous. Upstream allowed exactly
  //    one provider because a second complete credential made the run's provider
  //    depend on SHANNON_AI_MODEL alone — too easy to misread as "both are in play".
  //    The fork's stage routing makes a second provider legitimate when a
  //    SHANNON_AI_MODEL_<STAGE> override names it; one no model variable references
  //    is still the ambiguity upstream rejected.
  const configured = configuredProviders();
  const selectedProviders = new Set<string>([spec.providerId, ...stageEntries.map((entry) => entry.spec.providerId)]);
  const unreferenced = configured.filter((id) => !selectedProviders.has(id));
  if (configured.length > 1 && unreferenced.length > 0) {
    const setKeys = (id: CuratedProviderId): string[] =>
      PROVIDER_API_KEY_ENV[id].filter((name) => Boolean(process.env[name]));
    const list = configured.map((id) => `${id} (${setKeys(id).join(', ')})`).join(' and ');
    const extraVars = unreferenced.flatMap(setKeys);

    const dropHint =
      getMode() === 'local'
        ? 'remove them from .env or unset them in your shell:'
        : "unset them in your shell, or reconfigure with 'npx @keygraph/shannon setup':";

    const lines = [`Credentials for more than one provider are set: ${list}.`];
    if (extraVars.length > 0) {
      lines.push(
        `Shannon runs the providers its model variables select: SHANNON_AI_MODEL ("${spec.providerId}:...") plus any SHANNON_AI_MODEL_<STAGE> override.`,
        `Nothing selects ${unreferenced.join(', ')} — ${dropHint}`,
        `  unset ${extraVars.join(' ')}`,
      );
    }
    return { valid: false, error: lines.join('\n') };
  }

  return { valid: true };
}
