import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type * as Notices from './build/notices.cjs';

// Each build records the packages compiled into it, for the app's third-party notices (build/notices.cjs).
const { bundledPackagesPlugin } = createRequire(import.meta.url)('./build/notices.cjs') as typeof Notices;
const notices = (target: 'main' | 'preload' | 'renderer') => bundledPackagesPlugin(target, resolve('.tmp/notices', `${target}.json`));

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
    plugins: [notices('main')],
    build: {
      externalizeDeps: { exclude: ['zod'] },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'runtime-worker': resolve('src/runtime/worker.ts'),
          'media-worker': resolve('src/main/project/media-worker.ts'),
          'posts-import-worker': resolve('src/main/posts-import/worker.ts'),
          'source-sync-worker': resolve('src/main/sources/worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    plugins: [notices('preload')],
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
    plugins: [react(), notices('renderer')],
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
});
