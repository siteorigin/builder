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
  test: { include: ['tests/unit/**/*.test.ts', 'scripts/**/*.test.mjs'], environment: 'node' }
});
