// Copyright (C) 2026 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Writes <sourceDir>/.playwright/cli.config.json with stealth defaults so
 * `playwright-cli open` auto-loads them from the agent's cwd. Skipped when a
 * config already exists so user-provided files are never clobbered.
 *
 * NOTE: Playwright's MCP browser config treats `initScript` entries as file
 * paths, not inline source. The stealth script is written alongside the config
 * and referenced by absolute path. Inline strings silently fail the daemon.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const STEALTH_INIT_SCRIPT = `delete Object.getPrototypeOf(navigator).webdriver;

Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const arr = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    arr.__proto__ = PluginArray.prototype;
    return arr;
  },
});

window.chrome = window.chrome || {};
window.chrome.runtime = window.chrome.runtime || {
  PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
  PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
  PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
  RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
  OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
  OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
};
`;

// Fork modification (Corvus): governed egress. When SHANNON_PROXY_URL is set,
// every browser the agents launch must send its traffic through that proxy —
// the Corvus EnforcingProxy re-checks each CONNECT against the run's frozen
// scope and refuses (and counts) anything else. The URL was validated before
// any Docker work began (CLI validateCredentials), so a bad value here means
// the container env is wrong: throw. A browser that silently browses direct is
// the one dishonest outcome this fork refuses.
const EGRESS_PROXY_ENV = 'SHANNON_PROXY_URL';

export function governedProxyUrl(): string | undefined {
  const raw = process.env[EGRESS_PROXY_ENV]?.trim();
  return raw === '' ? undefined : raw;
}

function proxyServerArg(url: string): string {
  return `--proxy-server=${url}`;
}

function isProxyServerArg(arg: unknown): arg is string {
  return typeof arg === 'string' && arg.startsWith('--proxy-server=');
}

function buildStealthConfig(initScriptPath: string, proxyUrl?: string) {
  const args = ['--disable-blink-features=AutomationControlled'];
  if (proxyUrl !== undefined) {
    args.push(proxyServerArg(proxyUrl));
  }
  return {
    browser: {
      browserName: 'chromium',
      launchOptions: {
        headless: true,
        args,
        ignoreDefaultArgs: ['--enable-automation'],
      },
      contextOptions: {
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      initScript: [initScriptPath],
    },
  };
}

export type StealthConfigWriteResult = 'wrote' | 'skipped-existing';

/**
 * Fork modification (Corvus): reconcile an existing config with the run's
 * egress posture. Returns true when the file was rewritten.
 *
 * - Governed: the current --proxy-server arg must be present. A config left
 *   behind by an earlier, ungoverned run of the same workspace must not
 *   silently defeat governance — a stale URL is replaced, a missing arg is
 *   added, every other key is preserved. Unparseable JSON throws: a file we
 *   cannot read is a browser we cannot vouch for.
 * - Not governed: any --proxy-server arg is stripped — it can only have come
 *   from a previous governed run of this fork (SHANNON_PROXY_URL is the one
 *   supported way to set a proxy here), and a dead ephemeral proxy URL would
 *   leave the browser unable to reach anything. Everything else is untouched.
 */
async function reconcileExistingConfig(configPath: string, proxyUrl: string | undefined): Promise<boolean> {
  let existing: unknown;
  try {
    existing = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${EGRESS_PROXY_ENV} is set but ${configPath} exists and is not valid JSON (${reason}). ` +
        'A config this code cannot read could point the browser anywhere — remove the file or fix it before re-running governed.',
    );
  }
  if (typeof existing !== 'object' || existing === null) {
    throw new Error(
      `${EGRESS_PROXY_ENV} is set but ${configPath} is not a config object. ` +
        'A config this code cannot read could point the browser anywhere — remove the file before re-running governed.',
    );
  }

  const browser = (existing as Record<string, unknown>).browser;
  const browserObj = typeof browser === 'object' && browser !== null ? (browser as Record<string, unknown>) : {};
  const launchOptions = browserObj.launchOptions;
  const launchObj =
    typeof launchOptions === 'object' && launchOptions !== null ? (launchOptions as Record<string, unknown>) : {};
  const rawArgs = launchObj.args;
  const args = Array.isArray(rawArgs) ? rawArgs.slice() : [];

  const wanted = proxyUrl !== undefined ? proxyServerArg(proxyUrl) : undefined;
  const kept = args.filter((arg) => !isProxyServerArg(arg));
  const next = wanted !== undefined ? [...kept, wanted] : kept;

  if (
    args.length === next.length &&
    args.every((arg, index) => arg === next[index]) &&
    (rawArgs !== undefined || wanted === undefined)
  ) {
    return false; // already in the run's posture
  }

  launchObj.args = next;
  browserObj.launchOptions = launchObj;
  (existing as Record<string, unknown>).browser = browserObj;
  await fs.writeFile(configPath, JSON.stringify(existing, null, 2));
  return true;
}

export async function writePlaywrightStealthConfig(
  sourceDir: string,
): Promise<{ result: StealthConfigWriteResult; configPath: string }> {
  const playwrightDir = path.join(sourceDir, '.playwright');
  const configPath = path.join(playwrightDir, 'cli.config.json');
  const proxyUrl = governedProxyUrl();
  if (await pathExists(configPath)) {
    if (proxyUrl === undefined && !(await configCarriesProxyArg(configPath))) {
      // Upstream contract: a pre-existing config is the operator's and is
      // never rewritten — except for the fork's own --proxy-server arg,
      // which reconcileExistingConfig owns (see above).
      return { result: 'skipped-existing', configPath };
    }
    const updated = await reconcileExistingConfig(configPath, proxyUrl);
    return { result: updated ? 'wrote' : 'skipped-existing', configPath };
  }
  const initScriptPath = path.join(playwrightDir, 'scripts', 'stealth.js');
  await fs.mkdir(path.dirname(initScriptPath), { recursive: true });
  await fs.writeFile(initScriptPath, STEALTH_INIT_SCRIPT);
  await fs.writeFile(configPath, JSON.stringify(buildStealthConfig(initScriptPath, proxyUrl), null, 2));
  return { result: 'wrote', configPath };
}

/** Whether an existing config already carries a --proxy-server arg (fork). */
async function configCarriesProxyArg(configPath: string): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch {
    return false; // not ours to touch when nothing governs the run
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const browser = (parsed as Record<string, unknown>).browser;
  if (typeof browser !== 'object' || browser === null) return false;
  const launchOptions = (browser as Record<string, unknown>).launchOptions;
  if (typeof launchOptions !== 'object' || launchOptions === null) return false;
  const args = (launchOptions as Record<string, unknown>).args;
  return Array.isArray(args) && args.some((arg) => isProxyServerArg(arg));
}
