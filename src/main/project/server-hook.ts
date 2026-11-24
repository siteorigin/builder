import { statSync } from 'node:fs';
import { join } from 'node:path';
import { HOOKS_SERVER_FILE } from '@generator/index';

/** Server hooks SvelteKit finds under other names: a file without an extension, a TypeScript file, or a folder with an index. */
const OTHER_HOOKS = ['src/hooks.server', 'src/hooks.server.ts', 'src/hooks.server/index.js', 'src/hooks.server/index.ts'];

export const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * A server hook of the project's own, if it has one: under another name than the generated hook, or at its path
 * when SiteOrigin Builder did not write it there (`claimed` says whether it did). SvelteKit runs only one server hook,
 * so the generated one is never written beside it, and a website that needs the generated one cannot be exported.
 */
export function ownServerHook(dir: string, claimed: boolean): string | undefined {
  return OTHER_HOOKS.find((p) => isFile(join(dir, ...p.split('/')))) ?? (!claimed && isFile(join(dir, ...HOOKS_SERVER_FILE.split('/'))) ? HOOKS_SERVER_FILE : undefined);
}
