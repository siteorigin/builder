import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, LinkValue, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { pageLinkUses } from '@engine/page-links';
import { validateState } from '@engine/validate';
import { ProjectSession } from '../../src/main/project/session';

const business = () => createStarterState('business', 'Test Studio', false);
const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;
const headerOf = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
const header = { kind: 'shell' as const, id: 'header' };
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');

/** Removes Home leaving a blank one, and returns the new state with the new Home's ID. */
function removeHome(s: ProjectState) {
  const r = applyOperations(s, [{ type: 'page.remove', pageId: s.site.homePageId, newHome: true }]);
  const id = (r.results[0] as { newHomePageId: string }).newHomePageId;
  return { state: r.state, id };
}

/** The business starter with the header's action jumping to a section of Home, and an old address kept for Home. */
function linkedHome() {
  let s = business();
  const home = s.site.homePageId;
  s = applyOperations(s, [{ type: 'instance.setProp', owner: header, nodeId: headerOf(s).id, prop: 'ctaLink', value: { type: 'page', target: home, anchor: 'main' } }]).state;
  s.site.redirects = [{ from: '/welcome/', pageId: home }];
  expect(errors(s)).toEqual([]);
  return { s, home };
}

describe('removing Home and leaving a new blank Home', () => {
  it('makes an empty, published Home at "/" and sends every link, menu item and kept address there', () => {
    const { s, home } = linkedHome();
    const links = pageLinkUses(s, home).filter((u) => !u.card).length;
    expect(links).toBeGreaterThan(1);
    const routes = Object.fromEntries(s.site.pageOrder.filter((id) => id !== home).map((id) => [id, s.pages[id].route]));
    const { state: next, id } = removeHome(s);
    expect(next.pages[home]).toBeUndefined();
    expect(next.site.homePageId).toBe(id);
    expect(next.pages[id]).toMatchObject({ title: 'Home', route: '/', showHeader: true, showFooter: true, rootIds: [], nodes: {} });
    expect(next.pages[id].draft).toBeUndefined();
    // It stands where the old Home stood, and no other page moves.
    expect(next.site.pageOrder).toEqual(s.site.pageOrder.map((p) => (p === home ? id : p)));
    for (const [pid, route] of Object.entries(routes)) expect(next.pages[pid].route).toBe(route);
    // Every link, the menus' included, opens the top of the new Home.
    expect(pageLinkUses(next, id).filter((u) => !u.card)).toHaveLength(links);
    expect(headerOf(next).props.ctaLink as LinkValue).toEqual({ type: 'page', target: id });
    const menu = headerOf(next).props.links as Array<{ link: LinkValue }>;
    expect(menu.some((i) => i.link.target === id)).toBe(true);
    expect(JSON.stringify(next)).not.toContain(home);
    expect(next.site.redirects).toEqual([{ from: '/welcome/', pageId: id }]);
    expect(errors(next)).toEqual([]);
  });

  it('works on a one-page site', () => {
    const s = createStarterState('blank', 'Test Studio', false);
    expect(s.site.pageOrder).toHaveLength(1);
    const home = s.site.homePageId;
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: home }])).toThrow(/at least one page/);
    const { state: next, id } = removeHome(s);
    expect(next.site.pageOrder).toEqual([id]);
    expect(next.site.homePageId).toBe(id);
    expect(next.pages[home]).toBeUndefined();
    expect(next.pages[id].route).toBe('/');
    expect(errors(next)).toEqual([]);
  });

  it('works when every other page is a draft, which stay drafts at their own addresses', () => {
    const { s, home } = linkedHome();
    const others = s.site.pageOrder.filter((id) => id !== home);
    for (const id of others) s.pages[id].draft = true;
    // No published page can take Home's place.
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: home, replacementPageId: others[0] }])).toThrow(/is a draft/);
    const { state: next, id } = removeHome(s);
    expect(next.site.homePageId).toBe(id);
    for (const o of others) {
      expect(next.pages[o].draft).toBe(true);
      expect(next.pages[o].route).toBe(s.pages[o].route);
    }
    expect(next.pages[id].draft).toBeUndefined();
  });

  it('refuses the blank option off Home, or alongside a replacement page or chosen sections', () => {
    const { s, home } = linkedHome();
    const about = byTitle(s, 'About').id;
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: about, newHome: true }])).toThrow(/Only the Home page/);
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: home, newHome: true, replacementPageId: about }])).toThrow(/not both/);
    expect(() => applyOperations(s, [{ type: 'page.remove', pageId: home, newHome: true, sectionReplacements: [{ from: 'main', to: '' }] }])).toThrow(/no sections/);
  });

  it('undoes the removal and the new Home in one step, restoring the old Home, its links and its addresses', async () => {
    const { s, home } = linkedHome();
    const dir = mkdtempSync(join(tmpdir(), 'so-blank-home-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, s);
    const keep = (st: ProjectState) => JSON.parse(JSON.stringify({ site: st.site, pages: st.pages, components: st.components }));
    const before = keep(session.state);
    expect((await session.apply({ operations: [{ type: 'page.remove', pageId: home, newHome: true }], expectedRevision: session.revision }, { label: 'Delete page Home' })).ok).toBe(true);
    expect(session.state.site.homePageId).not.toBe(home);
    await session.undo();
    expect(keep(session.state)).toEqual(before);
  });
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
