/**
 * Fork addition (Corvus): seam tests for DAST prompt selection.
 *
 * loadPrompt's targetMode ternary is the one mechanism that routes an agent to
 * prompts/dast/. These tests pin the contract the rest of the fork relies on:
 * dast selects the black-box variant, pipeline-testing keeps precedence over
 * dast, shared @include files fall back to the base set when no dast override
 * exists, dast overrides win when they do, and a missing dast variant fails
 * loud instead of silently loading the white-box prompt.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadPrompt } from '../src/services/prompt-manager.js';

// Minimal behavioral logger: the tests assert on the selection lines loadPrompt
// emits, not on the rest of its logging.
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const VARIABLES = {
  webUrl: 'https://target.example.test',
  repoPath: '/workspace/source',
  AUTH_STATE_FILE: '/workspace/auth-state.json',
  assessmentDate: '2026-09-03',
  analysisClasses: ['injection', 'xss', 'auth', 'authz', 'ssrf'] as const,
};

function infoLines(logger: ReturnType<typeof makeLogger>): string[] {
  return logger.info.mock.calls.map((call) => String(call[0]));
}

describe('loadPrompt DAST selection (fork seam)', () => {
  it("targetMode 'dast' loads the black-box variant from prompts/dast/", async () => {
    const logger = makeLogger();
    const prompt = await loadPrompt('recon', VARIABLES, null, false, logger, undefined, 'dast');

    const dastLine = infoLines(logger).find((line) => line.includes('Using DAST prompt:'));
    expect(dastLine).toBeDefined();
    expect(dastLine).toMatch(/[/\\]dast[/\\]recon\.txt$/);
    // Black-box guard sentence exists only in the dast variant.
    expect(prompt).toContain('No source code exists in this engagement');
  });

  it('without targetMode, loads the base (white-box) prompt unchanged', async () => {
    const logger = makeLogger();
    const prompt = await loadPrompt('recon', VARIABLES, null, false, logger);

    expect(infoLines(logger).some((line) => line.includes('Using DAST prompt:'))).toBe(false);
    expect(prompt).not.toContain('No source code exists in this engagement');
    // The white-box recon prompt is seeded by the pre-recon code analysis; the
    // dast variant never references that deliverable.
    expect(prompt).toContain('pre_recon_deliverable.md');
  });

  it('pipeline-testing mode takes precedence over dast', async () => {
    const logger = makeLogger();
    await loadPrompt('recon', VARIABLES, null, true, logger, undefined, 'dast');

    const lines = infoLines(logger);
    expect(lines.some((line) => line.includes('Using pipeline testing prompt:'))).toBe(true);
    expect(lines.some((line) => line.includes('Using DAST prompt:'))).toBe(false);
  });

  it('a dast prompt can @include a shared file that only exists in the base set', async () => {
    const logger = makeLogger();
    // dast/exploit-auth includes shared/exploitation/_exploit-scope.txt, which has
    // no dast override — processIncludes must fall back to the base prompts dir.
    const prompt = await loadPrompt('exploit-auth', VARIABLES, null, false, logger, undefined, 'dast');

    expect(prompt).toContain('MANDATORY EXPLOITATION CONSTRAINTS');
  });

  it('a dast-specific shared include overrides the base one', async () => {
    const logger = makeLogger();
    // task-formation-* includes shared/exploitation/_task-formation-procedure.txt,
    // which DOES have a dast override — the black-box procedure must win.
    const prompt = await loadPrompt('task-formation-injection', VARIABLES, null, false, logger, undefined, 'dast');

    expect(prompt).toContain('No SAST source locations exist in this engagement');
    // The white-box procedure's jailed-source instruction must not survive the override.
    expect(prompt).not.toContain('Use the jailed source only when needed');
  });

  it('fails loud when a prompt has no dast variant (never silently loads white-box)', async () => {
    const logger = makeLogger();
    // pre-recon-code is unreachable in DAST and intentionally has no variant;
    // asking for it under dast must throw rather than fall back to the base file.
    await expect(loadPrompt('pre-recon-code', VARIABLES, null, false, logger, undefined, 'dast')).rejects.toThrow(
      /Prompt file not found/,
    );
  });
});
