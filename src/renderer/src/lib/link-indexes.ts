import type { ProjectState } from '@shared/types';
import { linkableIndexes } from '@shared/archives';

type Indexes = ReturnType<typeof linkableIndexes>;

/**
 * What of the pages `linkableIndexes` reads: each one's key, ID, address and draft flag, in order. Archive pages give way
 * to the addresses pages hold (src/shared/archives.ts, `archivePages`), and nothing else of a page counts.
 */
function pagesRead(state: ProjectState): string {
  return JSON.stringify(Object.entries(state.pages ?? {}).map(([key, p]) => [key, p?.id, p?.route, p?.draft]));
}

/** The last list worked out for each collections record, while the record is held (an editor's copy, a draft). */
const kept = new WeakMap<object, { site: ProjectState['site']; pages: string; indexes: Indexes }>();

/**
 * The collections a link can go to the index of (`linkableIndexes`), worked out again only when what it reads has
 * changed (#967): the collections and the site, by identity (a change that does not touch them keeps them, in the main
 * process and in the editor's copy), and each page's key, ID, address and draft flag. An edit of a page's content changes
 * none of these, so a link's editor in the Inspector no longer walks every entry of every collection on each change.
 */
export function linkIndexes(state: ProjectState): Indexes {
  const collections: unknown = state.collections;
  if (typeof collections !== 'object' || collections === null) return linkableIndexes(state);
  const pages = pagesRead(state);
  const last = kept.get(collections);
  if (last && last.site === state.site && last.pages === pages) return last.indexes;
  const indexes = linkableIndexes(state);
  kept.set(collections, { site: state.site, pages, indexes });
  return indexes;
}
