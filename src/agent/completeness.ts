/**
 * A cheap, deterministic check before a run may call itself finished: did it leave a page the user asked for
 * as a stub? It costs no model call. The orchestrator acts on it at most once per run.
 */
import type { PageDoc, ProjectState } from '@shared/types';
import { normalizeRoute, validateRoute } from '@shared/routes';

export interface StubPage {
  pageId: string;
  title: string;
  route: string;
  sections: number;
}

/** The user asked for an empty page, so an empty page is the right result. */
const WANTS_STUB = /\b(blank|empty|placeholder|stub|skeleton|bare|just (a|the) (title|intro|heading))\b/i;
/** Words that ask for an existing page to be built out, as opposed to a small edit ("add a sentence to Services"). */
const BUILD_INTENT = /\b(build|flesh|fill|finish|complete|generate)\b/i;

/** No content yet: nothing at all, or only an opening section (a hero or page introduction). */
function isStub(state: ProjectState, page: PageDoc): boolean {
  if (!page.rootIds.length) return true;
  if (page.rootIds.length > 1) return false;
  const node = page.nodes[page.rootIds[0]];
  if (node?.kind !== 'instance') return false;
  return state.components[node.definitionId]?.category === 'hero';
}

const named = (request: string, page: PageDoc): boolean => {
  const words = [page.title, page.route.split('/').filter(Boolean).at(-1) ?? ''].filter((w) => w.length > 2);
  return words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[ -]')}\\b`, 'i').test(request));
};

/**
 * Pages this request should have filled but did not: pages the run created, and existing pages it was asked
 * by name to build.
 */
export function findStubPages(before: ProjectState, after: ProjectState, request: string): StubPage[] {
  // "Add a blank Coming Soon page and build Services": the exception covers only the clause that asks for it.
  const clauses = request.split(/[.;!?]|\band (?:then |also )?(?=build|create|make|write|add|finish)/i);
  const stubClauses = clauses.filter((c) => WANTS_STUB.test(c));
  const wantedBlank = (page: PageDoc) => stubClauses.some((c) => named(c, page)) || (stubClauses.length > 0 && !named(request, page));
  const build = BUILD_INTENT.test(request);
  const out: StubPage[] = [];
  for (const id of after.site.pageOrder) {
    const page = after.pages[id];
    if (!page || !isStub(after, page) || wantedBlank(page)) continue;
    const created = !Object.hasOwn(before.pages, id);
    if (created || (build && named(request, page))) out.push({ pageId: id, title: page.title, route: page.route, sections: page.rootIds.length });
  }
  return out;
}

/** `limitedTo`: the page a run may change, named; it cannot create the pages its links wait for. */
export function completenessNudge(stubs: StubPage[], missingRoutes: string[], macroTools: boolean, rejected: string[] = [], wanted: MissingPage[] = [], limitedTo?: string): string {
  const lines = ['Before finishing, the app found work that looks unfinished:'];
  for (const r of rejected) lines.push(`- The page ${r} was rejected with errors and has not been built.`);
  for (const w of wanted)
    lines.push(
      w.reason === 'carried'
        ? `- The page ${describePage(w)} from the earlier request has not been created yet.`
        : `- The page ${describePage(w)} has not been created: the change that would have created it was ${w.reason === 'skipped' ? 'skipped because it came second in one response' : 'rejected, so nothing in that batch was applied'}.${w.occupiedBy ? ` Give it a route of its own and leave ${w.occupiedBy} as it is.` : ''}`
    );
  for (const s of stubs) lines.push(`- ${s.title} (${s.route}) has ${s.sections === 0 ? 'no sections' : 'only an opening section'}.`);
  for (const r of missingRoutes) lines.push(`- Links point to ${r}, but no page uses that route yet.`);
  lines.push(
    limitedTo
      ? `Finish these now on ${limitedTo}, the only page this request may change: relink a link to a missing page to one that exists, or ask the user with request_clarification (widenScope: true) before creating pages.`
      : macroTools
        ? 'Finish these now: call upsert_page_with_sections once per page with its full list of sections, and create or relink any missing page.'
        : 'Finish these now: add the sections each page needs, and create or relink any missing page.'
  );
  lines.push('If one of these is already what the user asked for, leave it and finish. You will not be asked again.');
  return lines.join('\n');
}

/**
 * A page the request tried to create in a change that never landed: a batch that was rejected, or a second
 * change in one model response that was skipped. Nothing in the project records it, so the run remembers it
 * and checks the project for it before it may call itself finished.
 */
export interface WantedPage {
  title: string;
  /** Normalized; absent when the model let the app choose the route from the title. */
  route?: string;
  reason: 'rejected' | 'skipped' | 'carried';
  /** Carried: pages that already had the route (or, without one, the title) when it was saved, which do not count. */
  existing?: string[];
}

/** The page.create operations in a change's raw arguments. A bad sibling operation never hides a valid one. */
export function pageCreatesIn(rawArgs: string): Array<Omit<WantedPage, 'reason'>> {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return [];
  }
  const ops = (args as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(ops)) return [];
  const out: Array<Omit<WantedPage, 'reason'>> = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object' || (op as { type?: unknown }).type !== 'page.create') continue;
    const { title, route } = op as { title?: unknown; route?: unknown };
    if (typeof title !== 'string' || !title.trim()) continue;
    const r = typeof route === 'string' && route.trim() ? normalizeRoute(route) : undefined;
    out.push({ title: title.trim().slice(0, 80), ...(r && r !== '/' && !validateRoute(r) ? { route: r } : {}) });
  }
  return out;
}

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A wanted page the project still lacks; `occupiedBy` names the page that already had its route. */
export type MissingPage = WantedPage & { occupiedBy?: string };

/**
 * The wanted pages the project still lacks, read from the project as it is now, so a page created and then
 * removed again is still missing. A route the model named must be met by a page this run created at that
 * route, since the user may have asked for two pages with one title and an old page moved there is not new.
 * Only a route that already belonged to another page when the request started cannot be: then a new page with
 * the title, at any route, is what was wanted. A page carried over from an earlier request is met by any page
 * at its route, or with its title, that was not there when it was saved (the user may have made it by hand).
 */
export function missingPages(wanted: WantedPage[], before: ProjectState, after: ProjectState): MissingPage[] {
  const pages = Object.values(after.pages);
  const created = pages.filter((p) => !Object.hasOwn(before.pages, p.id));
  const out: MissingPage[] = [];
  for (const w of wanted) {
    let met: boolean;
    let occupant: PageDoc | undefined;
    if (w.reason === 'carried') met = pages.some((p) => (w.route ? p.route === w.route : sameTitle(p.title, w.title)) && !w.existing?.includes(p.id));
    else {
      occupant = w.route ? Object.values(before.pages).find((p) => p.route === w.route) : undefined;
      const atRoute = created.some((p) => p.route === w.route);
      const byTitle = created.some((p) => sameTitle(p.title, w.title));
      met = !w.route ? byTitle : occupant ? byTitle || atRoute : atRoute;
    }
    if (!met && !out.some((o) => (o.route ?? '') === (w.route ?? '') && sameTitle(o.title, w.title))) out.push({ ...w, ...(occupant ? { occupiedBy: occupant.title } : {}) });
  }
  return out;
}

/**
 * How a missing page is saved with an unfinished result, for a "continue" to check again, with the pages that
 * already have its route or title and so are not it (an old page moved onto the route, for one). A route
 * another page had before the request cannot be met there, so that page is saved by its title.
 */
export function savedPage(w: MissingPage, state: ProjectState): { title: string; route?: string; existing?: string[] } {
  const route = w.route && !w.occupiedBy ? w.route : undefined;
  const existing = Object.values(state.pages)
    .filter((p) => (route ? p.route === route : sameTitle(p.title, w.title)))
    .map((p) => p.id);
  return { title: w.title, ...(route ? { route } : {}), ...(existing.length || !route ? { existing } : {}) };
}

/** Remember a page once, keeping the first reason it was seen for. */
export function rememberPage(list: WantedPage[], page: WantedPage) {
  if (!list.some((w) => (w.route && w.route === page.route) || (!w.route && !page.route && sameTitle(w.title, page.title)))) list.push(page);
}

export const describePage = (w: Pick<MissingPage, 'title' | 'route' | 'occupiedBy'>) => (w.route ? `${w.title} (${w.route}${w.occupiedBy ? `, which ${w.occupiedBy} already uses` : ''})` : w.title);
