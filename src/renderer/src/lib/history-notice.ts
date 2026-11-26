/**
 * What an Undo or Redo says when its change is not on the page the editor shows (#903). Undo and Redo take back the
 * newest change wherever it was made, so one made on Contact is undone while Home is shown: without a word, Home
 * shows nothing and the next press undoes something else unseen. So the notice names the change, and offers the page
 * it changed when that page is still there.
 */
import type { ProjectState } from '@shared/types';
import { activeWorkspace } from './workspace';
import type { PostRef } from './posts';

/** The page documents a step wrote are `siteorigin/pages/{id}.json`. */
const PAGE_DOC = /^siteorigin\/pages\/([A-Za-z0-9_-]+)\.json$/;

/** The pages a step changed, by the documents it wrote, in the order it wrote them. */
export function changedPages(changed: readonly string[] | undefined): string[] {
  const ids: string[] = [];
  for (const path of changed ?? []) {
    const id = PAGE_DOC.exec(path)?.[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Where the editor is: the page it has open, and whatever is in front of that page. */
export interface ShownPlace {
  pageId: string | null;
  definitionMode: unknown;
  templateMode: unknown;
  leftTab: string | null;
  postView: 'write' | 'preview';
  mode: 'edit' | 'preview';
  post: PostRef | null;
}

/** Whether the page `pageId` is on the canvas now: open, and no component, layout, post or SEO view in front of it. */
export function pageInSight(s: ShownPlace, pageId: string): boolean {
  return s.pageId === pageId && !s.definitionMode && !s.templateMode && !activeWorkspace(s);
}

export interface HistoryNotice {
  text: string;
  /** The page to offer to show: one the step changed and the project still has. */
  show?: { pageId: string; title: string };
}

const titleOf = (state: ProjectState | undefined, id: string) => state?.pages[id]?.title?.trim() || undefined;

/**
 * The notice for an Undo or Redo of `label` that wrote `changed`, or null when there is nothing to say: it changed no
 * page but the one on screen, where the author sees it happen. `before` is the project as it stood when
 * the step was asked for and `after` as it stands once the step is shown, so a page the step removed is still named
 * (an undone page addition) but never offered, and one it brought back is offered.
 */
export function historyNotice(
  direction: 'undo' | 'redo',
  label: string | undefined,
  changed: readonly string[] | undefined,
  place: ShownPlace,
  before: ProjectState | undefined,
  after: ProjectState | undefined
): HistoryNotice | null {
  // Only the pages out of sight: one changed on the page shown too may look no different there (a link's destination).
  const pages = changedPages(changed).filter((id) => !pageInSight(place, id));
  if (!pages.length) return null;
  const titles = pages.map((id) => titleOf(after, id) ?? titleOf(before, id)).filter((t): t is string => !!t);
  const verb = direction === 'undo' ? 'Undid' : 'Redid';
  const said = label?.trim() ?? '';
  const what = said ? `“${said}”` : 'a change';
  // An editor label already ends with where it was made ("Duplicate Split hero on Contact"), by the page's title then;
  // an AI turn's does not, nor one that only names a page as a link's destination ("Change link to Contact").
  const named = pages.length === 1 && [titleOf(before, pages[0]), titleOf(after, pages[0])].some((t) => !!t && said.endsWith(` on ${t}`));
  const where = titles.length && !named ? ` on ${listed(titles)}` : '';
  const target = pages.find((id) => after?.pages[id]);
  return { text: `${verb} ${what}${where}.`, ...(target ? { show: { pageId: target, title: titleOf(after, target) ?? 'page' } } : {}) };
}

function listed(titles: string[]): string {
  if (titles.length <= 2) return titles.join(' and ');
  return `${titles.slice(0, 2).join(', ')} and ${titles.length - 2 === 1 ? 'one more page' : `${titles.length - 2} more pages`}`;
}
