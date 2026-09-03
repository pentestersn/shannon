/**
 * Fork addition (Corvus): seam tests for `start` argument parsing — `-r/--repo`
 * became optional; its absence is what selects DAST (black-box) mode upstream
 * in start().
 */
import { describe, expect, it } from 'vitest';
import { parseStartArgs } from '../src/index.js';

describe('CLI parseStartArgs optional --repo (fork seam)', () => {
  it('accepts start without -r: repo stays undefined (DAST mode)', () => {
    const args = parseStartArgs(['-u', 'https://target.example.test']);
    expect(args.url).toBe('https://target.example.test');
    expect(args.repo).toBeUndefined();
  });

  it('accepts start with -r: repo is carried for deep mode', () => {
    const args = parseStartArgs(['-u', 'https://target.example.test', '-r', '/repos/app']);
    expect(args.repo).toBe('/repos/app');
  });

  it('carries the remaining start flags unchanged', () => {
    const args = parseStartArgs([
      '-u',
      'https://target.example.test',
      '-r',
      '/repos/app',
      '-c',
      'config.yaml',
      '-w',
      'ws-1',
      '--pipeline-testing',
      '-f',
    ]);
    expect(args.config).toBe('config.yaml');
    expect(args.workspace).toBe('ws-1');
    expect(args.pipelineTesting).toBe(true);
    expect(args.follow).toBe(true);
    expect(args.keepContainer).toBe(false);
  });
});
