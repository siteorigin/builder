import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@engine': resolve('src/engine'),
      '@generator': resolve('src/generator'),
      '@catalogue': resolve('src/catalogue'),
      '@agent': resolve('src/agent'),
      '@runtime': resolve('src/runtime')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
    // A change to any of these runs the whole suite under `--changed`, as PR CI runs it (.github/workflows/ci.yml).
    forceRerunTriggers: ['**/package.json', '**/package-lock.json', '**/{vitest,vite}.config.*', 'tests/unit/setup.ts'],
    // A CI runner has a quarter of a workstation's cores, so image encoding and browser tests run several times
    // slower there: tests without a timeout of their own get more time on CI, never less anywhere.
    ...(process.env.CI ? { testTimeout: 30_000, hookTimeout: 60_000 } : {})
  }
});
