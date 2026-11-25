/**
 * How the Posts writer reads back the links it shows, apart from its DOM so it can be checked without one.
 */
import type { LinkValue, ProjectState } from '@shared/types';
import { ENTRY_LINK_PREFIX, linkFromTarget } from '@shared/richtext';
import { findEntry } from '@shared/collections';
import { withRels } from '@shared/link-rel';
import type { ArticleRead } from '@shared/richtext-tree';

/**
 * A link the writer shows carries the destination it was stored with (`data-link`) beside the address it showed for it
 * (`data-href`): a page whose address changes since is still that page, and a link to an address another page has
 * taken since never moves to it. Read back as `so-link:` and the stored link. What a web address says about its
 * site is its anchor's own rel, which the link dialog changes, so that is read from the anchor every time.
 */
export const KEPT_LINK = 'so-link:';

function keptLink(json: string, state: ProjectState): LinkValue | null {
  let l: unknown;
  try {
    l = JSON.parse(json);
  } catch {
    return null;
  }
  if (!l || typeof l !== 'object') return null;
  const { type, target } = l as LinkValue;
  if (typeof target !== 'string') return null;
  if (type === 'page') return Object.hasOwn(state.pages, target) ? (l as LinkValue) : null;
  if (type === 'entry') return findEntry(state, target) ? (l as LinkValue) : null;
  return type === 'url' || type === 'email' || type === 'tel' || type === 'anchor' ? (l as LinkValue) : null;
}

/** How the writer reads a link it shows: a page or post of this project, or an address of anywhere else. */
export function articleLinks(state: ProjectState): ArticleRead {
  return {
    link: (href, newTab, rel) => {
      const t = href.trim();
      if (t.startsWith(KEPT_LINK)) {
        const kept = keptLink(t.slice(KEPT_LINK.length), state);
        return kept && withRels(kept, rel);
      }
      if (t.startsWith(ENTRY_LINK_PREFIX)) {
        const id = t.slice(ENTRY_LINK_PREFIX.length);
        return findEntry(state, id) ? { type: 'entry', target: id, ...(newTab ? { newTab: true } : {}) } : null;
      }
      return linkFromTarget(t, state.pages, newTab, rel);
    }
  };
}

