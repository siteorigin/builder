/**
 * Get started (#951): a new Business site's list ticks a step only when the project has it, measured against the site
 * as the starter made it, and its record reads back from the workspace file or not at all.
 */
import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { findTheme } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import type { ProjectState } from '@shared/types';
import { FIRST_STEPS, firstStepsDone, firstStepsStart, headingTarget, readFirstSteps, type FirstStepsRecord } from '@shared/first-steps';

const fresh = () => createStarterState('business', 'Harbour Lane Studio', false);
const colorIds = (s: ProjectState) => (findTheme(s.site.themeId)?.tokens ?? []).filter((t) => t.group === 'color').map((t) => t.id);
const recordOf = (s: ProjectState): FirstStepsRecord => ({ start: firstStepsStart(s, colorIds(s)) });

describe('Get started', () => {
  it('starts with nothing done on a new Business site', () => {
    const s = fresh();
    const record = recordOf(s);
    expect(record.start.heading).toBeDefined();
    expect(record.start.colorIds.length).toBeGreaterThan(0);
    expect(Object.values(firstStepsDone(s, record)).some(Boolean)).toBe(false);
    expect(FIRST_STEPS).toHaveLength(5);
  });

  it('ticks the heading once it reads differently, and not for an edit elsewhere or a heading cleared', () => {
    const s = fresh();
    const record = recordOf(s);
    const h = record.start.heading!;
    const owner = { kind: 'page' as const, id: h.pageId };
    const elsewhere = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: h.nodeId, prop: 'eyebrow', value: 'Studio' }]).state;
    expect(firstStepsDone(elsewhere, record).heading).toBe(false);
    const cleared = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: h.nodeId, prop: 'heading', value: '' }]).state;
    expect(firstStepsDone(cleared, record).heading).toBe(false);
    const written = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: h.nodeId, prop: 'heading', value: 'Rooms that work' }]).state;
    expect(firstStepsDone(written, record).heading).toBe(true);
  });

  it('does not tick the heading for a change a visitor cannot see', () => {
    const s = fresh();
    const record = recordOf(s);
    const h = record.start.heading!;
    const owner = { kind: 'page' as const, id: h.pageId };
    const spaced = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: h.nodeId, prop: 'heading', value: `${h.value}  ` }]).state;
    expect(firstStepsDone(spaced, record).heading).toBe(false);
  });

  it('keeps the heading ticked when a section with an empty heading goes above the written one', () => {
    const s = fresh();
    const record = recordOf(s);
    const h = record.start.heading!;
    const home = s.pages[h.pageId];
    const owner = { kind: 'page' as const, id: h.pageId };
    const grid = home.rootIds.find((id) => id !== h.nodeId && (home.nodes[id] as { props?: Record<string, unknown> }).props?.heading)!;
    const written = applyOperations(s, [
      { type: 'instance.setProp', owner, nodeId: h.nodeId, prop: 'heading', value: 'Rooms that work' },
      { type: 'instance.setProp', owner, nodeId: grid, prop: 'heading', value: '' }
    ]).state;
    const page = written.pages[h.pageId];
    const moved = { ...written, pages: { ...written.pages, [h.pageId]: { ...page, rootIds: [grid, ...page.rootIds.filter((id) => id !== grid)] } } };
    expect(firstStepsDone(moved, record).heading).toBe(true);
    // The step still goes to the emptied heading that leads, so it can be written.
    expect(headingTarget(moved)?.nodeId).toBe(grid);
  });

  it('does not tick the heading when the hero is deleted and a sample heading moves up', () => {
    const s = fresh();
    const record = recordOf(s);
    const h = record.start.heading!;
    const owner = { kind: 'page' as const, id: h.pageId };
    const removed = applyOperations(s, [{ type: 'node.remove', owner, nodeId: h.nodeId }]).state;
    expect(firstStepsDone(removed, record).heading).toBe(false);
    // The step now goes to the heading that leads the home page, and ticks once that one is the author's.
    const lead = headingTarget(removed)!;
    expect(lead.nodeId).not.toBe(h.nodeId);
    const rewritten = applyOperations(removed, [{ type: 'instance.setProp', owner, nodeId: lead.nodeId, prop: 'heading', value: 'Our clients' }]).state;
    expect(firstStepsDone(rewritten, record).heading).toBe(true);
  });

  it('follows the heading that leads the home page when a section moves above the hero', () => {
    const s = fresh();
    const record = recordOf(s);
    const home = s.pages[s.site.homePageId];
    const owner = { kind: 'page' as const, id: home.id };
    // The services grid, moved to the top: its sample heading leads, and is not the author's.
    const grid = home.rootIds.find((id) => id !== record.start.heading!.nodeId && (home.nodes[id] as { props?: Record<string, unknown> }).props?.heading)!;
    const moved = { ...s, pages: { ...s.pages, [home.id]: { ...home, rootIds: [grid, ...home.rootIds.filter((id) => id !== grid)] } } };
    expect(headingTarget(moved)?.nodeId).toBe(grid);
    expect(firstStepsDone(moved, record).heading).toBe(false);
    const written = applyOperations(moved, [{ type: 'instance.setProp', owner, nodeId: grid, prop: 'heading', value: 'What we do' }]).state;
    expect(firstStepsDone(written, record).heading).toBe(true);
  });

  it('follows the home page when another page is made home', () => {
    const s = fresh();
    const record = recordOf(s);
    const about = s.site.pageOrder.find((id) => s.pages[id].route === '/about/')!;
    const moved = applyOperations(s, [{ type: 'page.setHome', pageId: about }]).state;
    const lead = headingTarget(moved);
    expect(lead?.pageId).toBe(moved.site.homePageId);
    expect(firstStepsDone(moved, record).heading).toBe(false);
    const written = applyOperations(moved, [{ type: 'instance.setProp', owner: { kind: 'page', id: lead!.pageId }, nodeId: lead!.nodeId, prop: 'heading', value: 'About the studio, in our words' }]).state;
    expect(firstStepsDone(written, record).heading).toBe(true);
  });

  it('ticks name and colors for a new site name or a colour, not for spacing', () => {
    const s = fresh();
    const record = recordOf(s);
    const renamed = applyOperations(s, [{ type: 'site.update', name: 'Harbour Lane Interiors' }]).state;
    expect(firstStepsDone(renamed, record).style).toBe(true);
    const color = record.start.colorIds[0];
    const recolored = { ...s, tokens: { ...s.tokens, overrides: { ...s.tokens.overrides, [color]: '#7a2e8f' } } };
    expect(firstStepsDone(recolored, record).style).toBe(true);
    const spaced = { ...s, tokens: { ...s.tokens, overrides: { ...s.tokens.overrides, 'space.lg': '120px' } } };
    expect(firstStepsDone(spaced, record).style).toBe(false);
  });

  it('ticks a page only for a new one, not for the starter pages reordered', () => {
    const s = fresh();
    const record = recordOf(s);
    const reordered = { ...s, site: { ...s.site, pageOrder: [...s.site.pageOrder].reverse() } };
    expect(firstStepsDone(reordered, record).page).toBe(false);
    const added = applyOperations(s, [{ type: 'page.create', title: 'Services', route: '/services/' }]).state;
    expect(firstStepsDone(added, record).page).toBe(true);
  });

  it('takes Preview and an export from the record, since the site cannot show them', () => {
    const s = fresh();
    const done = firstStepsDone(s, { ...recordOf(s), previewed: true, exported: true });
    expect(done.preview && done.export).toBe(true);
  });

  it('reads a record back from the workspace file, and nothing that is not one', () => {
    const s = fresh();
    const record = { ...recordOf(s), previewed: true, hidden: true };
    const back = readFirstSteps(JSON.parse(JSON.stringify(record)));
    expect(back?.start).toEqual(record.start);
    expect(back?.previewed).toBe(true);
    expect(back?.hidden).toBe(true);
    expect(back?.exported).toBe(false);
    expect(readFirstSteps(undefined)).toBeNull();
    expect(readFirstSteps({ start: { name: 1 } })).toBeNull();
    expect(readFirstSteps('hidden')).toBeNull();
  });
});
