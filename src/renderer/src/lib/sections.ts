import type { ProjectState } from '@shared/types';
import { pageIds, pageSections, sharedPageIds } from '@generator/checks';
import { partsShown, type ShellPart } from '@shared/page-shell';

/** An option value for a section that has no ID yet: choosing it gives the section one. Others are `#id`. */
export const SECTION_NODE = 'node:';

/**
 * The sections a link to a page can jump to, as picker options: the page's sections by their headings (`#id`, or
 * `node:` for one without an ID yet) and the IDs of the shared header and footer the page shows. `shared` names the
 * header or footer a link "on this page" is in: only IDs every page showing that part has are kept. `ids` are the IDs
 * that work.
 */
export function sectionOptions(state: ProjectState, pageId: string | null | undefined, shared?: ShellPart): { ids: Set<string>; options: Array<{ value: string; text: string }> } {
  const page = pageId ? state.pages[pageId] : undefined;
  const ids = !page ? new Set<string>() : shared ? sharedPageIds(state, shared) : pageIds(state, page.id);
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
  for (const part of partsShown(page)) for (const n of Object.values(state.site.shell[part].nodes)) if (n.anchor && ids.has(n.anchor)) add(`#${n.anchor}`, `#${n.anchor}`);
  return { ids, options };
}
