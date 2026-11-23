import type { ProjectState } from '@shared/types';
import { pageIds, pageSections, sharedPageIds } from '@generator/checks';

/** An option value for a section that has no ID yet: choosing it gives the section one. Others are `#id`. */
export const SECTION_NODE = 'node:';

/**
 * The sections a link to a page can jump to, as picker options: the page's sections by their headings (`#id`, or
 * `node:` for one without an ID yet) and the shared header and footer's IDs when the page shows them. `shared` keeps
 * only IDs every page with the header has, for a header or footer link "on this page". `ids` are the IDs that work.
 */
export function sectionOptions(state: ProjectState, pageId: string | null | undefined, shared = false): { ids: Set<string>; options: Array<{ value: string; text: string }> } {
  const page = pageId ? state.pages[pageId] : undefined;
  const ids = !page ? new Set<string>() : shared ? sharedPageIds(state) : pageIds(state, page.id);
  const options: Array<{ value: string; text: string }> = [];
  const add = (value: string, text: string) => {
    if (!options.some((o) => o.value === value)) options.push({ value, text });
  };
  const seen = new Map<string, number>();
  for (const x of page ? pageSections(state, page.id) : []) {
    if (shared && !(x.anchor && ids.has(x.anchor))) continue;
    // Sections with the same heading are told apart by their order on the page.
    const n = (seen.get(x.label) ?? 0) + 1;
    seen.set(x.label, n);
    add(x.anchor ? `#${x.anchor}` : `${SECTION_NODE}${x.nodeId}`, `${x.nested ? ' ' : ''}${x.label}${n > 1 ? ` (${n})` : ''}`);
  }
  if (page && page.shell !== 'none')
    for (const t of [state.site.shell.header, state.site.shell.footer]) for (const n of Object.values(t.nodes)) if (n.anchor && ids.has(n.anchor)) add(`#${n.anchor}`, `#${n.anchor}`);
  return { ids, options };
}
