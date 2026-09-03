/**
 * Fork addition (Corvus): minimal vitest rig.
 *
 * Scope is deliberately narrow — it covers the fork's own seams (DAST prompt
 * selection, target-mode CLI parsing), not the upstream pipeline. Upstream has
 * no test infrastructure and we do not pretend to cover what we did not test.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/tests/**/*.test.ts'],
  },
});
