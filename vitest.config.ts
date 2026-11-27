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
    // A change to any of these runs the whole suite under `--changed`, as PR CI runs it (.github/workflows/ci.yml). The
    // committed theme releases and their lock are read from disk, not imported, so `--changed` would not follow them.
    forceRerunTriggers: [
      '**/package.json',
      '**/package-lock.json',
      '**/{vitest,vite}.config.*',
      '**/tests/unit/setup.ts',
      '**/resources/packs.lock.json',
      '**/resources/packs/foundation/**',
      '**/resources/packs-dev/foundation-alt/**'
    ],
    // Native file watchers and media workers share this machine's filesystem and event queues across test files.
    // Keep the general suite parallel; the filesystem-sensitive files run serially in scripts/test-unit.mjs.
    maxWorkers: 6,
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
});
