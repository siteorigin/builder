/** A page's address as its Address field takes it: what a new one moves, or why the page can't have it. */
import type { ProjectState } from './types';
import { normalizeRoute, validateRoute } from './routes';
import { planRouteMove, type RouteMove } from './page-tree';
import { collectionRouteOwner } from './collections';

/**
 * What giving the page `pageId` the address `input` (as typed: "About Us" is "/about-us/") moves, or why it can't have
 * it, in the words of the page's Address field. The Inspector checks the field with it before anything is sent, so the
 * reason shows beside the field; `page.update` refuses with the same reason.
 */
export function planPageAddress(state: ProjectState, pageId: string, input: string): { route: string; moves: RouteMove[] } | { error: string } {
  const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  if (!page) return { error: `Page "${pageId}" does not exist.` };
  const route = normalizeRoute(input);
  const home = page.id === state.site.homePageId;
  if (home && route !== '/') return { error: 'The Home page is always at "/". Make another page Home first.' };
  if (!home && route === '/') return { error: 'Only the Home page can be at "/".' };
  const err = validateRoute(route);
  if (err) return { error: err };
  const plan = planRouteMove(state, page.id, route, validateRoute);
  if ('error' in plan) return plan;
  const owner = collectionRouteOwner(state, route);
  if (owner) return { error: `${route} is the address of ${owner.label}. Choose another address for the page.` };
  // No page moved along with it may land on an address a collection or one of its entries holds either.
  for (const m of plan.moves) {
    if (m.pageId === page.id) continue;
    const held = collectionRouteOwner(state, m.to);
    if (held) return { error: `Moving “${page.title}” would move “${state.pages[m.pageId].title}” to ${m.to}, which is the address of ${held.label}. Choose another address for the page.` };
  }
  return { route, moves: plan.moves };
}
