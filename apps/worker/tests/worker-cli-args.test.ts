/**
 * Fork addition (Corvus): seam tests for the worker's `--mode <deep|dast>` CLI
 * parsing — the switch the container CLI passes so the workflow knows whether
 * the run is white-box (deep) or black-box (DAST).
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/temporal/worker.js';

const BASE_ARGV = ['https://target.example.test', '/repos/target-source', '--task-queue', 'shannon-task-queue'];

describe('worker parseCliArgs --mode parsing (fork seam)', () => {
  it('defaults to deep (no targetMode) when --mode is absent', () => {
    const args = parseCliArgs([...BASE_ARGV]);
    expect(args.webUrl).toBe('https://target.example.test');
    expect(args.repoPath).toBe('/repos/target-source');
    expect(args.targetMode).toBeUndefined();
  });

  it('parses --mode dast', () => {
    const args = parseCliArgs([...BASE_ARGV, '--mode', 'dast']);
    expect(args.targetMode).toBe('dast');
  });

  it('parses --mode deep explicitly', () => {
    const args = parseCliArgs([...BASE_ARGV, '--mode', 'deep']);
    expect(args.targetMode).toBe('deep');
  });

  it('parses --pipeline-testing alongside --mode dast', () => {
    const args = parseCliArgs([...BASE_ARGV, '--mode', 'dast', '--pipeline-testing']);
    expect(args.targetMode).toBe('dast');
    expect(args.pipelineTestingMode).toBe(true);
  });
});
