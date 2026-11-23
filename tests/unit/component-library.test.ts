import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { instancesOf, placementCounts, placesOf } from '@engine/tree';
import { applyOperations } from '@engine/apply';
import { ProjectSession } from '../../src/main/project/session';
import { componentDocPath } from '../../src/main/project/documents';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const home = (s: ProjectState) => s.site.homePageId;
const page = (s: ProjectState) => ({ kind: 'page' as const, id: home(s) });

/** The issue's own steps: an Exhibitor card made from a group, a second copy, and Make unique twice. */
async function exhibitorCards() {
  const dir = mkdtempSync(join(tmpdir(), 'so-library-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('blank', 'Expo', false));
  const owner = page(s.state);
  const section = s.state.pages[home(s.state)].rootIds[0];
  const stack = await s.apply({ operations: [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'stack' }] }, { label: 'Insert stack' });
  const stackId = stack.results![0].nodeId as string;
  await s.apply({ operations: [{ type: 'node.insert', owner, parentId: stackId, primitive: 'heading', text: 'Exhibitor' }] }, { label: 'Insert heading' });
  const made = await s.apply({ operations: [{ type: 'component.createFromNode', owner, nodeId: stackId, name: 'Exhibitor card' }] }, { label: 'Create component' });
  const first = made.results![0].nodeId as string;
  const card = (s.state.pages[home(s.state)].nodes[first] as InstanceNode).definitionId;
  const again = await s.apply({ operations: [{ type: 'node.insert', owner, parentId: section, slot: 'content', definitionId: card }] }, { label: 'Insert Exhibitor card' });
  const second = again.results![0].nodeId as string;
  const forks: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await s.apply({ operations: [{ type: 'component.makeUnique', owner, nodeId: second }] }, { label: 'Make unique' });
    forks.push(r.results![0].definitionId as string);
  }
  return { dir, s, owner, first, second, card, forks };
}

describe('cleaning up component variants (#56)', () => {
  it('removes an unused variant, keeps the other placements, and undoes', async () => {
    const { dir, s, owner, first, second, card, forks } = await exhibitorCards();
    const names = [card, ...forks].map((id) => s.state.components[id].name);
    expect(names[0]).toBe('Exhibitor card');
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(n).not.toMatch(/\(unique\).*\(unique\)/);
    // The first fork lost its only placement to the second fork, so it is already unused.
    expect(instancesOf(s.state, forks[0])).toHaveLength(0);
    // Deleting the last card on the page leaves its variant unused too.
    await s.apply({ operations: [{ type: 'node.remove', owner, nodeId: second }] }, { label: 'Delete Exhibitor card' });
    expect(instancesOf(s.state, forks[1])).toHaveLength(0);
    const file = join(dir, componentDocPath(forks[0]));
    expect(existsSync(file)).toBe(true);

    const r = await s.apply({ operations: [{ type: 'component.remove', definitionId: forks[0] }] }, { label: `Delete component ${names[1]}` });
    expect(r.ok).toBe(true);
    expect(s.state.components[forks[0]]).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    // The original and the other variant are untouched, and so is the card still on the page.
    expect(s.state.components[card].name).toBe('Exhibitor card');
    expect(s.state.components[forks[1]]).toBeDefined();
    expect((s.state.pages[home(s.state)].nodes[first] as InstanceNode).definitionId).toBe(card);

    expect(s.historyInfo().undoLabel).toBe(`Delete component ${names[1]}`);
    await s.undo();
    expect(s.state.components[forks[0]].name).toBe(names[1]);
    expect(existsSync(file)).toBe(true);
    expect((s.state.pages[home(s.state)].nodes[first] as InstanceNode).definitionId).toBe(card);
  });

  it('refuses to delete a component that is still placed', async () => {
    const { s, card } = await exhibitorCards();
    const r = await s.apply({ operations: [{ type: 'component.remove', definitionId: card }] }, { label: 'Delete component' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/is used once \(Home\)|is used 1 time/);
    expect(s.state.components[card]).toBeDefined();
  });
});

describe('where a library component is used (#56)', () => {
  it('groups placements by page, shared area and component design, and counts them all', () => {
    let s = createStarterState('business', 'Places', false);
    const pageId = home(s);
    const owner = page(s);
    const stats = s.pages[pageId].rootIds.map((id) => s.pages[pageId].nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'stats.row')!;
    const def = stats.definitionId;
    const about = s.site.pageOrder.find((id) => id !== pageId)!;
    s = applyOperations(s, [
      { type: 'node.insert', owner, definitionId: def },
      { type: 'node.insert', owner: { kind: 'page', id: about }, definitionId: def },
      { type: 'node.insert', owner: { kind: 'shell', id: 'footer' }, definitionId: def }
    ]).state;
    const places = placesOf(s, def);
    expect(places.map((p) => [p.owner.kind, p.label, p.nodeIds.length])).toEqual([
      ['shell', 'Footer', 1],
      ['page', s.pages[pageId].title, 2],
      ['page', s.pages[about].title, 1]
    ]);
    expect(places[1].nodeIds).toContain(stats.id);
    expect(placementCounts(s)[def]).toBe(4);
    expect(placementCounts(s)[def]).toBe(instancesOf(s, def).length);
    // Every definition's count agrees with instancesOf, and an unused one has none.
    const counts = placementCounts(s);
    for (const id of Object.keys(s.components)) expect(counts[id] ?? 0).toBe(instancesOf(s, id).length);
    const spare = applyOperations(s, [{ type: 'component.duplicate', definitionId: def, name: 'Spare' }]);
    expect(placesOf(spare.state, spare.results[0].definitionId as string)).toEqual([]);
  });
});
