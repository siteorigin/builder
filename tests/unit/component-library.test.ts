import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const firstOf = (s: ProjectState, componentId: string) => {
  const p = s.pages[home(s)];
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!.definitionId;
};

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
    expect(names).toEqual(['Exhibitor card', 'Exhibitor card (unique)', 'Exhibitor card (unique 2)']);
    // Each Make unique moved the second card on, so the first copy is already unused.
    expect((s.state.pages[home(s.state)].nodes[second] as InstanceNode).definitionId).toBe(forks[1]);
    expect(instancesOf(s.state, forks[0])).toHaveLength(0);
    // Deleting the last card of that variant leaves it unused too: the library keeps it until it is deleted there.
    await s.apply({ operations: [{ type: 'node.remove', owner, nodeId: second }] }, { label: 'Delete Exhibitor card' });
    expect(instancesOf(s.state, forks[1])).toHaveLength(0);
    expect(s.state.components[forks[1]]).toBeDefined();
    const file = join(dir, componentDocPath(forks[1]));
    const saved = readFileSync(file, 'utf8');

    const r = await s.apply({ operations: [{ type: 'component.remove', definitionId: forks[1] }] }, { label: `Delete component ${names[2]}` });
    expect(r.ok).toBe(true);
    expect(s.state.components[forks[1]]).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    // The original and the other variant are untouched, and so is the card still on the page.
    expect(s.state.components[card].name).toBe('Exhibitor card');
    expect(s.state.components[forks[0]].name).toBe(names[1]);
    expect(existsSync(join(dir, componentDocPath(forks[0])))).toBe(true);
    expect((s.state.pages[home(s.state)].nodes[first] as InstanceNode).definitionId).toBe(card);

    expect(s.historyInfo().undoLabel).toBe(`Delete component ${names[2]}`);
    await s.undo();
    expect(s.state.components[forks[1]].name).toBe(names[2]);
    expect(readFileSync(file, 'utf8')).toBe(saved);
    expect((s.state.pages[home(s.state)].nodes[first] as InstanceNode).definitionId).toBe(card);
    // Undo restores the definition, not the placement deleted before it.
    expect(s.state.pages[home(s.state)].nodes[second]).toBeUndefined();
  });

  it('refuses to delete a component that is still placed, naming where', async () => {
    const { s, card } = await exhibitorCards();
    const title = s.state.pages[home(s.state)].title;
    const r = await s.apply({ operations: [{ type: 'component.remove', definitionId: card }] }, { label: 'Delete component' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe(`"Exhibitor card" is used 1 time (${title}). Remove those uses first.`);
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
    // An ID such as "constructor" with no placements has no count.
    expect(placementCounts(s).constructor).toBeUndefined();
    const about = s.site.pageOrder.find((id) => id !== pageId)!;
    const r = applyOperations(s, [
      { type: 'node.insert', owner, definitionId: def },
      { type: 'node.insert', owner: { kind: 'page', id: about }, definitionId: def },
      { type: 'node.insert', owner: { kind: 'shell', id: 'footer' }, definitionId: def },
      // A project component whose design places it too.
      { type: 'component.duplicate', definitionId: firstOf(s, 'cta.banner'), name: 'Wrapper' }
    ]);
    s = r.state;
    const again = r.results[0].nodeId as string;
    const wrapper = s.components[r.results[3].definitionId as string];
    wrapper.tree!.nodes.nested = { id: 'nested', kind: 'instance', definitionId: def, props: {} };
    (wrapper.tree!.nodes[wrapper.tree!.rootIds[0]] as { children: string[] }).children.push('nested');
    const places = placesOf(s, def);
    expect(places.map((p) => [p.owner, p.label, p.nodeIds])).toEqual([
      [{ kind: 'shell', id: 'footer' }, 'Footer', [r.results[2].nodeId]],
      [{ kind: 'page', id: pageId }, s.pages[pageId].title, [stats.id, again].sort((a, b) => s.pages[pageId].rootIds.indexOf(a) - s.pages[pageId].rootIds.indexOf(b))],
      [{ kind: 'page', id: about }, s.pages[about].title, [r.results[1].nodeId]],
      [{ kind: 'component', id: wrapper.id }, 'Wrapper', ['nested']]
    ]);
    expect(placementCounts(s)[def]).toBe(5);
    expect(placementCounts(s)[def]).toBe(instancesOf(s, def).length);
    // Every definition's count agrees with instancesOf, and an unused one has none.
    const counts = placementCounts(s);
    for (const id of Object.keys(s.components)) expect(counts[id] ?? 0).toBe(instancesOf(s, id).length);
    const spare = applyOperations(s, [{ type: 'component.duplicate', definitionId: def, name: 'Spare' }]);
    expect(placesOf(spare.state, spare.results[0].definitionId as string)).toEqual([]);
  });
});
