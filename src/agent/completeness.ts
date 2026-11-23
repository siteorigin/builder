/**
 * A cheap, deterministic check before a run may call itself finished: did it leave a page the user asked for
 * as a stub? It costs no model call. The orchestrator acts on it at most once per run.
 */
import type { PageDoc, ProjectState } from '@shared/types';

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

export function completenessNudge(stubs: StubPage[], missingRoutes: string[], macroTools: boolean, rejected: string[] = []): string {
  const lines = ['Before finishing, the app found work that looks unfinished:'];
  for (const r of rejected) lines.push(`- The page ${r} was rejected with errors and has not been built.`);
  for (const s of stubs) lines.push(`- ${s.title} (${s.route}) has ${s.sections === 0 ? 'no sections' : 'only an opening section'}.`);
  for (const r of missingRoutes) lines.push(`- Links point to ${r}, but no page uses that route yet.`);
  lines.push(
    macroTools
      ? 'Finish these now: call upsert_page_with_sections once per page with its full list of sections, and create or relink any missing page.'
      : 'Finish these now: add the sections each page needs, and create or relink any missing page.'
  );
  lines.push('If one of these is already what the user asked for, leave it and finish. You will not be asked again.');
  return lines.join('\n');
}
