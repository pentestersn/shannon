// Fork modification (Corvus): governed egress — the stealth config writer is
// the injection point that points every agent browser at the enforcing proxy.
// These tests pin the writer's posture rules: the arg appears only when
// SHANNON_PROXY_URL is set, a stale config from an earlier run can never keep
// the browser ungoverned (or pointed at a dead proxy) silently, and upstream's
// never-clobber-an-existing-config contract survives for everything the fork
// does not own.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { governedProxyUrl, writePlaywrightStealthConfig } from '../src/ai/playwright-config-writer.js';

const EGRESS_PROXY_ENV = 'SHANNON_PROXY_URL';

let sourceDir: string;
let saved: string | undefined;

beforeEach(() => {
  sourceDir = mkdtempSync(path.join(tmpdir(), 'shannon-playwright-'));
  saved = process.env[EGRESS_PROXY_ENV];
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
  if (saved === undefined) delete process.env[EGRESS_PROXY_ENV];
  else process.env[EGRESS_PROXY_ENV] = saved;
});

function configPath(): string {
  return path.join(sourceDir, '.playwright', 'cli.config.json');
}

function readConfig(): { args: string[] } {
  const parsed = JSON.parse(readFileSync(configPath(), 'utf-8')) as {
    browser: { launchOptions: { args: string[] } };
  };
  return { args: parsed.browser.launchOptions.args };
}

function seedConfig(args: string[] | undefined): void {
  mkdirSync(path.join(sourceDir, '.playwright'), { recursive: true });
  const config = {
    browser: {
      browserName: 'chromium',
      launchOptions: {
        headless: true,
        ...(args === undefined ? {} : { args }),
      },
      initScript: ['/operator/kept/script.js'],
    },
  };
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

describe('governedProxyUrl (fork seam)', () => {
  it('returns undefined when the variable is unset', () => {
    delete process.env[EGRESS_PROXY_ENV];
    expect(governedProxyUrl()).toBeUndefined();
  });

  it('treats an empty value as ungoverned', () => {
    process.env[EGRESS_PROXY_ENV] = '   ';
    expect(governedProxyUrl()).toBeUndefined();
  });

  it('returns the trimmed URL when set', () => {
    process.env[EGRESS_PROXY_ENV] = '  http://172.18.0.1:9400 ';
    expect(governedProxyUrl()).toBe('http://172.18.0.1:9400');
  });
});

describe('writePlaywrightStealthConfig egress posture (fork seam)', () => {
  it('writes the upstream stealth shape with no proxy arg when ungoverned', async () => {
    delete process.env[EGRESS_PROXY_ENV];
    const { result } = await writePlaywrightStealthConfig(sourceDir);
    expect(result).toBe('wrote');
    expect(readConfig().args).toEqual(['--disable-blink-features=AutomationControlled']);
  });

  it('appends --proxy-server when SHANNON_PROXY_URL is set', async () => {
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    await writePlaywrightStealthConfig(sourceDir);
    expect(readConfig().args).toEqual([
      '--disable-blink-features=AutomationControlled',
      '--proxy-server=http://172.18.0.1:9400',
    ]);
  });

  it('leaves an existing config untouched when nothing governs the run', async () => {
    delete process.env[EGRESS_PROXY_ENV];
    seedConfig(['--disable-blink-features=AutomationControlled']);
    const before = readFileSync(configPath(), 'utf-8');
    const { result } = await writePlaywrightStealthConfig(sourceDir);
    expect(result).toBe('skipped-existing');
    expect(readFileSync(configPath(), 'utf-8')).toBe(before);
  });

  it('adds the proxy arg to an existing config from an earlier ungoverned run', async () => {
    seedConfig(['--disable-blink-features=AutomationControlled']);
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    const { result } = await writePlaywrightStealthConfig(sourceDir);
    expect(result).toBe('wrote');
    const config = JSON.parse(readFileSync(configPath(), 'utf-8')) as {
      browser: { launchOptions: { args: string[] }; initScript: string[] };
    };
    expect(config.browser.launchOptions.args).toEqual([
      '--disable-blink-features=AutomationControlled',
      '--proxy-server=http://172.18.0.1:9400',
    ]);
    // The operator's keys survive the merge.
    expect(config.browser.initScript).toEqual(['/operator/kept/script.js']);
  });

  it('creates the args array for an existing config that has none', async () => {
    seedConfig(undefined);
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    const { result } = await writePlaywrightStealthConfig(sourceDir);
    expect(result).toBe('wrote');
    expect(readConfig().args).toEqual(['--proxy-server=http://172.18.0.1:9400']);
  });

  it('replaces a stale proxy URL with the current one', async () => {
    seedConfig(['--disable-blink-features=AutomationControlled', '--proxy-server=http://old:1']);
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    const { result } = await writePlaywrightStealthConfig(sourceDir);
    expect(result).toBe('wrote');
    expect(readConfig().args).toEqual([
      '--disable-blink-features=AutomationControlled',
      '--proxy-server=http://172.18.0.1:9400',
    ]);
  });

  it('reports skipped-existing when the current arg is already in place', async () => {
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    seedConfig(['--disable-blink-features=AutomationControlled', '--proxy-server=http://172.18.0.1:9400']);
    const { result } = await writePlaywrightStealthConfig(sourceDir);
    expect(result).toBe('skipped-existing');
  });

  it('strips a stale proxy arg when the run is no longer governed', async () => {
    delete process.env[EGRESS_PROXY_ENV];
    seedConfig(['--disable-blink-features=AutomationControlled', '--proxy-server=http://old:1']);
    const { result } = await writePlaywrightStealthConfig(sourceDir);
    expect(result).toBe('wrote');
    expect(readConfig().args).toEqual(['--disable-blink-features=AutomationControlled']);
  });

  it('throws on an unparseable existing config when governed — never a browser it cannot vouch for', async () => {
    mkdirSync(path.join(sourceDir, '.playwright'), { recursive: true });
    writeFileSync(configPath(), '{not json');
    process.env[EGRESS_PROXY_ENV] = 'http://172.18.0.1:9400';
    await expect(writePlaywrightStealthConfig(sourceDir)).rejects.toThrow(/not valid JSON/);
  });
});
