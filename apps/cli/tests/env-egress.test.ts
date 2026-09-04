// Fork modification (Corvus): governed egress — the CLI side of the seam.
// SHANNON_PROXY_URL must fail loud before any Docker work when malformed,
// must reach the scan container (by name, so a credentialed URL never lands
// in the `docker run` argv) together with HTTP_PROXY/HTTPS_PROXY and an
// emptied NO_PROXY, and must switch /etc/hosts forwarding off regardless of
// the SHANNON_FORWARD_HOSTS flag.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostsForwardingEnabled } from '../src/docker.js';
import { buildEnvFlags, EGRESS_PROXY_ENV, governedProxyUrl, validateCredentials } from '../src/env.js';

const TOUCHED = [
  EGRESS_PROXY_ENV,
  'SHANNON_FORWARD_HOSTS',
  'SHANNON_AI_BASE_URL',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ANTHROPIC_API_KEY',
  'SHANNON_AI_MODEL',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of TOUCHED) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('governedProxyUrl (fork seam)', () => {
  it('returns undefined when unset and the URL when set', () => {
    delete process.env[EGRESS_PROXY_ENV];
    expect(governedProxyUrl()).toBeUndefined();
    process.env[EGRESS_PROXY_ENV] = ' http://172.18.0.1:9400 ';
    expect(governedProxyUrl()).toBe('http://172.18.0.1:9400');
  });

  it('treats whitespace as ungoverned', () => {
    process.env[EGRESS_PROXY_ENV] = '   ';
    expect(governedProxyUrl()).toBeUndefined();
  });
});

describe('validateCredentials egress URL check (fork seam)', () => {
  it('accepts a well-formed http proxy URL alongside a valid credential', () => {
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(validateCredentials()).toEqual({ valid: true });
  });

  it('rejects an unparseable URL before any Docker work', () => {
    process.env[EGRESS_PROXY_ENV] = 'not a url';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const result = validateCredentials();
    expect(result.valid).toBe(false);
    expect(result.error).toContain(EGRESS_PROXY_ENV);
  });

  it('rejects a non-http protocol', () => {
    process.env[EGRESS_PROXY_ENV] = 'ftp://172.18.0.1:9400';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const result = validateCredentials();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('http(s)');
  });

  it('rejects a URL carrying a query or fragment', () => {
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400/?route=scan';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(validateCredentials().valid).toBe(false);
  });
});

describe('buildEnvFlags governed forwarding (fork seam)', () => {
  it('forwards the proxy variables by name, both letter cases, with an infrastructure NO_PROXY', () => {
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    const flags = buildEnvFlags();
    expect(flags).toContain('-e');
    expect(flags).toContain(EGRESS_PROXY_ENV);
    // curl reads only the lowercase spelling for plain-http URLs — the
    // uppercase set alone left it ungoverned (found live).
    expect(flags).toContain('HTTP_PROXY');
    expect(flags).toContain('http_proxy');
    expect(flags).toContain('HTTPS_PROXY');
    expect(flags).toContain('https_proxy');
    // NO_PROXY is an infrastructure allowlist, never empty and never an
    // escape hatch: the Temporal control plane's gRPC client reads the
    // proxy env too (also found live) and must not be gated by a proxy
    // whose scope knows only the scan target.
    const noProxy = 'localhost,127.0.0.1,::1,shannon-temporal';
    expect(flags).toContain(`NO_PROXY=${noProxy}`);
    expect(flags).toContain(`no_proxy=${noProxy}`);
    // The proxy URL itself is staged in this process's env for docker to
    // inherit — it never appears in the argv.
    expect(process.env.HTTP_PROXY).toBe('http://172.18.0.1:9400');
    expect(process.env.http_proxy).toBe('http://172.18.0.1:9400');
    expect(process.env.HTTPS_PROXY).toBe('http://172.18.0.1:9400');
    expect(process.env.https_proxy).toBe('http://172.18.0.1:9400');
    expect(process.env.NO_PROXY).toBe(noProxy);
    expect(process.env.no_proxy).toBe(noProxy);
    expect(flags.join(' ')).not.toContain('http://172.18.0.1:9400');
  });

  it('exempts the LLM gateway host when a gateway run names one', () => {
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    process.env.SHANNON_AI_BASE_URL = 'http://llm.internal:8000/v1';
    const flags = buildEnvFlags();
    expect(process.env.NO_PROXY).toContain('llm.internal');
    expect(process.env.NO_PROXY).toContain('shannon-temporal');
    expect(flags).toContain(`NO_PROXY=${process.env.NO_PROXY}`);
  });

  it('an unparseable base URL exempts nothing beyond the fixed infrastructure', () => {
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    process.env.SHANNON_AI_BASE_URL = 'not a url';
    buildEnvFlags();
    expect(process.env.NO_PROXY).toBe('localhost,127.0.0.1,::1,shannon-temporal');
  });

  it('forwards none of the proxy variables when ungoverned', () => {
    delete process.env[EGRESS_PROXY_ENV];
    const flags = buildEnvFlags();
    expect(flags).not.toContain(EGRESS_PROXY_ENV);
    expect(flags).not.toContain('HTTP_PROXY');
    expect(flags).not.toContain('http_proxy');
    expect(flags).not.toContain('HTTPS_PROXY');
    expect(flags).not.toContain('https_proxy');
    expect(flags.every((flag) => !flag.startsWith('NO_PROXY='))).toBe(true);
    expect(flags.every((flag) => !flag.startsWith('no_proxy='))).toBe(true);
  });
});

describe('hostsForwardingEnabled (fork seam)', () => {
  it('is on by default and off when the flag says so', () => {
    delete process.env[EGRESS_PROXY_ENV];
    delete process.env.SHANNON_FORWARD_HOSTS;
    expect(hostsForwardingEnabled()).toBe(true);
    process.env.SHANNON_FORWARD_HOSTS = 'false';
    expect(hostsForwardingEnabled()).toBe(false);
  });

  it('governance wins over the flag: a set proxy URL switches forwarding off', () => {
    process.env.SHANNON_FORWARD_HOSTS = 'true';
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    expect(hostsForwardingEnabled()).toBe(false);
  });
});
