import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve('src/shared'),
  '@engine': resolve('src/engine'),
  '@generator': resolve('src/generator'),
  '@catalogue': resolve('src/catalogue'),
  '@agent': resolve('src/agent'),
  '@runtime': resolve('src/runtime')
};

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      externalizeDeps: { exclude: ['zod'] },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'runtime-worker': resolve('src/runtime/worker.ts'),
          'media-worker': resolve('src/main/project/media-worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { ...alias, '@renderer': resolve('src/renderer/src') } },
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
});
