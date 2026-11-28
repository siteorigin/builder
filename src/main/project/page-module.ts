import { statSync } from 'node:fs';
import { join } from 'node:path';
import { perf } from '../perf';

const isFile = (path: string) => {
  perf.count('fs.syncCalls');
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Whether a page has a route module of the project's own where SiteOrigin Builder writes the one that serves it as
 * plain HTML (`path`, a `+page.js`; see generator/static-pages.ts): a TypeScript one beside it, or one at its path that
 * SiteOrigin Builder did not write (`claimed` says whether it did). SvelteKit takes one such module per page, so the
 * generated one is never written beside it: the page then runs as the project's own module says.
 */
export function ownPageModule(dir: string, path: string, claimed: boolean): boolean {
  return isFile(join(dir, ...path.replace(/\.js$/, '.ts').split('/'))) || (!claimed && isFile(join(dir, ...path.split('/'))));
}

/** Code the website runs, where a generated file kept as edited outside the app may add what needs scripts. */
export const isSourceCode = (path: string): boolean => /^src\/.+\.(?:svelte|[cm]?[jt]s)$/i.test(path);
