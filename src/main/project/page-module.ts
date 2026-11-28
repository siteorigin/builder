import { readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { perf } from '../perf';

const isFile = (path: string) => {
  perf.count('fs.syncCalls');
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const names = (path: string): string[] => {
  perf.count('fs.syncCalls');
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

/**
 * Client hooks SvelteKit runs wherever a page runs its scripts, under any name it finds them by: a file without an
 * extension, a JavaScript or TypeScript file, or a folder's index.
 */
const CLIENT_HOOKS = ['src/hooks.client', 'src/hooks.client.js', 'src/hooks.client.ts', 'src/hooks.client/index.js', 'src/hooks.client/index.ts'];

/**
 * SvelteKit's page and layout files, as it takes them (`+page.svelte`, `+layout@group.ts`, `+page.server.js`), under any
 * one extension: a project's own config may add module extensions (`.mjs`). A name with two (`+page.test.ts`,
 * `+layout.svelte.bak`) is one SvelteKit passes by.
 */
const PAGE_OR_LAYOUT = /^\+(?:page|layout)(?:@[^./]*)?(?:\.server)?\.[a-z0-9]+$/i;
const LAYOUT = /^\+layout(?:@[^./]*)?(?:\.server)?\.[a-z0-9]+$/i;

/**
 * Whether a path is a page's route module of the kind SiteOrigin Builder writes for one served as plain HTML: one under
 * src/routes, every folder on the way a real name (no `.`, `..` or empty segment).
 */
export const isPageModule = (path: string): boolean => /^src\/routes\/(?:[^/]+\/)*\+page\.js$/.test(path) && !path.split('/').some((seg) => seg === '.' || seg === '..');

/**
 * Whether a page has SvelteKit files of the project's own that decide how it runs, where SiteOrigin Builder would write
 * the route module that serves it as plain HTML (`path`, a `+page.js`; see generator/static-pages.ts): a page or layout
 * file in its folder, a layout in a folder above it, or a client hook, that SiteOrigin Builder did not write (`claimed`
 * says which files it did). The generated module is never written then: SvelteKit takes one universal module per page,
 * and the project's own files may turn server rendering off or run code that needs the page's scripts. The page then
 * runs as those files say, with its scripts unless they say otherwise.
 */
export function ownRouteFiles(dir: string, path: string, claimed: (path: string) => boolean): boolean {
  const folder = posix.dirname(path);
  for (let at = folder; at === 'src/routes' || at.startsWith('src/routes/'); at = posix.dirname(at)) {
    const kinds = at === folder ? PAGE_OR_LAYOUT : LAYOUT;
    // A folder by such a name is no route file: SvelteKit reads files alone.
    for (const name of names(join(dir, ...at.split('/')))) if (kinds.test(name) && !claimed(`${at}/${name}`) && isFile(join(dir, ...at.split('/'), name))) return true;
  }
  return CLIENT_HOOKS.some((hook) => isFile(join(dir, ...hook.split('/'))));
}

/** Code the website runs, where a generated file kept as edited outside the app may add what needs scripts. */
export const isSourceCode = (path: string): boolean => /^src\/.+\.(?:svelte|[cm]?[jt]s)$/i.test(path);
