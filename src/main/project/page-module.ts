import { readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { perf } from '../perf';

const exists = (path: string) => {
  perf.count('fs.syncCalls');
  try {
    statSync(path);
    return true;
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

/** Client hooks SvelteKit runs wherever a page runs its scripts, under any name it finds them by. */
const CLIENT_HOOKS = ['src/hooks.client.js', 'src/hooks.client.ts', 'src/hooks.client', 'src/hooks.client/index.js', 'src/hooks.client/index.ts'];

/** Whether a path is a page's route module of the kind SiteOrigin Builder writes for one served as plain HTML. */
export const isPageModule = (path: string): boolean => /^src\/routes\/(?:.+\/)?\+page\.js$/.test(path);

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
    const kinds = at === folder ? /^\+(?:page|layout)\b/ : /^\+layout\b/;
    for (const name of names(join(dir, ...at.split('/')))) if (kinds.test(name) && !claimed(`${at}/${name}`)) return true;
  }
  return CLIENT_HOOKS.some((hook) => exists(join(dir, ...hook.split('/'))));
}

/** Code the website runs, where a generated file kept as edited outside the app may add what needs scripts. */
export const isSourceCode = (path: string): boolean => /^src\/.+\.(?:svelte|[cm]?[jt]s)$/i.test(path);
