import { statSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_HOOK_FILE } from '@generator/index';

/**
 * Server hooks SvelteKit finds under other names: a file without an extension, a TypeScript file, or a folder with an
 * index (a folder without one it passes by).
 */
const OTHER_HOOKS = ['src/hooks.server', 'src/hooks.server.ts', 'src/hooks.server/index.js', 'src/hooks.server/index.ts'];

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * A server hook of the project's own, if it has one: under another name than the generated hook, or at its path
 * when SiteOrigin Builder did not write it there (`claimed` says whether it did). SvelteKit runs only one server hook,
 * so the generated one is never written beside it: the not-found page then keeps the addresses it was built with, and
 * a website with pages in another language cannot be exported.
 */
export function ownServerHook(dir: string, claimed: boolean): string | undefined {
  return OTHER_HOOKS.find((p) => isFile(join(dir, ...p.split('/')))) ?? (!claimed && isFile(join(dir, ...SERVER_HOOK_FILE.split('/'))) ? SERVER_HOOK_FILE : undefined);
}
