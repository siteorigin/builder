import { describe, expect, it, vi } from 'vitest';
import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { breadcrumb, createComponentTarget, definitionPick, descOf, placedSlot, refExists, refLabel, selectionFromChain, type BridgeDesc } from '../../src/renderer/src/lib/model';
import { insertAt } from '../../src/renderer/src/lib/insert-at';
import { addPoints } from '../../src/renderer/src/lib/inline-insert';
import { placeToKeep, readPlaces } from '../../src/renderer/src/lib/page-place';
import { chainOf, slotBoxes } from '../../src/renderer/src/lib/payload';
import { toggle } from '../../src/renderer/src/lib/layer-set';
import { styleSelection } from '../../src/renderer/src/lib/style-copy';
import { composerScope } from '../../src/renderer/src/lib/chatTarget';

// The editor's actions read the store, which reads the preload's API; loaded untyped, as other tests load them, so
// the node project's type check never takes in the renderer's own files.
vi.stubGlobal('window', { builder: {} });
const load = (path: string) => import(/* @vite-ignore */ path);
const { detachable, structuralTarget } = (await load('../../src/renderer/src/lib/actions')) as {
  detachable: (state: ProjectState, ref: ElementRef | null) => ElementRef | null;
  structuralTarget: (ref: ElementRef | null, opts?: { state?: ProjectState }) => ElementRef | null;
};

/**
 * A slot of a placed component picked on the canvas by its empty box (#652): a Split with Main and Sidebar, both
 * empty, in a Section at the top of Home.
 */
function split() {
  let state: ProjectState = createStarterState('blank', 'Cafe', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: Parameters<typeof applyOperations>[1]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results;
  };
  const [{ nodeId: section }] = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
  const [{ definitionId }] = step([
    {
      type: 'component.upsert',
      name: 'Split',
      insertAs: 'element',
      properties: {},
      nodes: [
        { kind: 'element', id: 'root', children: ['mainCol', 'sideCol'], styles: { base: { layout: 'grid', columns: 2 } } },
        { kind: 'element', id: 'mainCol', children: ['main'] },
        { kind: 'slot', id: 'main', slot: 'main' },
        { kind: 'element', id: 'sideCol', children: ['side'] },
        { kind: 'slot', id: 'side', slot: 'sidebar' }
      ],
      slots: { main: { label: 'Main' }, sidebar: { label: 'Sidebar' } }
    }
  ]);
  const [{ nodeId: placed }] = step([{ type: 'node.insert', owner, parentId: section as string, slot: 'content', definitionId: definitionId as string }]);
  const id = placed as string;
  const placement: ElementRef = { owner, instancePath: [], nodeId: id };
  const slot = (name: string): ElementRef => ({ ...placement, slot: name });
  /** What the bridge reports for a click on a slot's empty box: the box itself, then the design's column and root. */
  const chainTo = (name: string): BridgeDesc[] => [
    { ctx: `page:${owner.id}`, node: id, items: '', slot: name },
    descOf(state, { owner, instancePath: [id], nodeId: name === 'main' ? 'mainCol' : 'sideCol' }),
    descOf(state, placement),
    descOf(state, { owner, instancePath: [], nodeId: section as string })
  ];
  return { state: () => state, step, owner, section: section as string, definitionId: definitionId as string, id, placement, slot, chainTo };
}

describe('a slot picked by its empty box (#652)', () => {
  it('is named apart from its placement and from its placement’s other slots', () => {
    const p = split();
    expect(new Set([refKey(p.placement), refKey(p.slot('main')), refKey(p.slot('sidebar'))]).size).toBe(3);
    expect(sameRef(p.slot('main'), p.placement)).toBe(false);
    // The page finds it by its box, which names the placement where it is placed, never through the design's root.
    expect(descOf(p.state(), p.slot('sidebar'))).toEqual({ ctx: `page:${p.owner.id}`, node: p.id, items: '', slot: 'sidebar' });
    expect(refLabel(p.state(), p.slot('sidebar'))).toBe('Sidebar');
    expect(breadcrumb(p.state(), p.slot('sidebar')).slice(-2).map((c) => c.label)).toEqual(['Split', 'Sidebar']);
  });

  it('is selected by the first click on its box, whatever was selected before', () => {
    const p = split();
    const st = p.state();
    expect(selectionFromChain(st, p.chainTo('main'), null, false)).toEqual(p.slot('main'));
    expect(selectionFromChain(st, p.chainTo('sidebar'), p.placement, false)).toEqual(p.slot('sidebar'));
    expect(selectionFromChain(st, p.chainTo('sidebar'), p.slot('main'), false)).toEqual(p.slot('sidebar'));
    // A modifier or double-click picks the slot too.
    expect(selectionFromChain(st, p.chainTo('main'), null, true)).toEqual(p.slot('main'));
    // A box naming a slot the component does not declare is not a slot: the click steps in as anywhere else.
    const stale = [{ ...p.chainTo('main')[0], slot: 'footer' }, ...p.chainTo('main').slice(1)];
    expect(selectionFromChain(st, stale, null, false)).toEqual({ owner: p.owner, instancePath: [], nodeId: p.section });
    // The bridge's report keeps the slot's name.
    expect(chainOf(p.chainTo('sidebar'))[0]).toMatchObject({ node: p.id, slot: 'sidebar' });
  });

  it('takes what a tile inserts, where the placement itself takes it into its first slot', () => {
    const p = split();
    const st = p.state();
    expect(insertAt(st, p.owner, 'element', p.slot('sidebar'))).toEqual({ owner: p.owner, parentId: p.id, slot: 'sidebar' });
    expect(insertAt(st, p.owner, 'element', p.slot('main'))).toEqual({ owner: p.owner, parentId: p.id, slot: 'main' });
    expect(insertAt(st, p.owner, 'element', p.placement)).toEqual({ owner: p.owner, parentId: p.id, slot: 'main' });
    // Another Split, or any other component, goes into the slot picked, not beside the placement or in its first slot.
    expect(insertAt(st, p.owner, 'element', p.slot('sidebar'), p.definitionId)).toEqual({ owner: p.owner, parentId: p.id, slot: 'sidebar' });
    const sectionDef = (st.pages[p.owner.id].nodes[p.section] as { definitionId: string }).definitionId;
    expect(insertAt(st, p.owner, 'element', p.slot('sidebar'), sectionDef)).toEqual({ owner: p.owner, parentId: p.id, slot: 'sidebar' });
    // A slot picked in the shared header is not on this page: nothing goes anywhere.
    expect(insertAt(st, p.owner, 'element', { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: p.id, slot: 'sidebar' })).toBeNull();
    // A section still goes after the section holding it.
    expect(insertAt(st, p.owner, 'section', p.slot('sidebar'))).toEqual({ owner: p.owner, parentId: null, index: 1 });
  });

  it('holds while its placement declares it, filled or not, and is let go once it does not', () => {
    const p = split();
    // Filled from elsewhere (Place on page, the AI, an Undo), it stays the place things go, so what was put there is
    // still selected by the change that put it there.
    const [{ nodeId: para }] = p.step([{ type: 'node.insert', owner: p.owner, parentId: p.id, slot: 'sidebar', primitive: 'paragraph', text: 'Open daily' }]);
    expect(refExists(p.state(), p.slot('sidebar'))).toBe(true);
    expect(placeToKeep(p.state(), p.owner.id, p.slot('sidebar'))).toEqual(p.slot('sidebar'));
    p.step([{ type: 'node.remove', owner: p.owner, nodeId: para as string }]);
    p.step([{ type: 'component.removeSlot', definitionId: p.definitionId, slot: 'sidebar' }]);
    expect(placedSlot(p.state(), p.slot('sidebar'))).toBeNull();
    expect(refExists(p.state(), p.slot('sidebar'))).toBe(false);
    // A tile inserts nowhere rather than somewhere the author did not pick.
    expect(insertAt(p.state(), p.owner, 'element', p.slot('sidebar'))).toBeNull();
  });

  it('is never the placement to move, remove, detach, package or add beside', () => {
    const p = split();
    const st = p.state();
    expect(structuralTarget(p.slot('sidebar'), { state: st })).toBeNull();
    expect(structuralTarget(p.placement, { state: st })).toEqual(p.placement);
    expect(detachable(st, p.slot('sidebar'))).toBeNull();
    expect(createComponentTarget({ state: st }, p.slot('sidebar'))).toBeNull();
    // Only an Add button inside the slot itself (#657), never one beside its placement.
    expect(addPoints(st, p.owner, p.slot('sidebar')).map((x) => [x.side, x.slot, x.role])).toEqual([['inside', 'sidebar', 'element']]);
    // The section's own Content slot: none of the section's Add buttons above or below it, which it has as a placement.
    const sectionSlot: ElementRef = { owner: p.owner, instancePath: [], nodeId: p.section, slot: 'content' };
    expect(addPoints(st, p.owner, { ...sectionSlot, slot: undefined }).length).toBeGreaterThan(0);
    expect(addPoints(st, p.owner, sectionSlot).map((x) => [x.side, x.slot, x.role])).toEqual([['inside', 'content', 'element']]);
    // No styles of its own to copy or paste.
    expect(styleSelection(st, p.slot('sidebar'))).toBeNull();
    expect(styleSelection(st, p.placement)).not.toBeNull();
  });

  it('is never taken into a range of layers with its placement', () => {
    const p = split();
    const [{ nodeId: note }] = p.step([{ type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', primitive: 'paragraph', text: 'Note' }]);
    const sibling: ElementRef = { owner: p.owner, instancePath: [], nodeId: note as string };
    // With the placement selected, a Cmd-click on its sibling selects both; with its slot selected, the sibling alone.
    const both = toggle(p.state().pages[p.owner.id], p.placement, null, sibling);
    expect('layerSet' in both && both.layerSet?.ids).toEqual([p.id, note]);
    expect(toggle(p.state().pages[p.owner.id], p.slot('sidebar'), null, sibling)).toEqual({ selection: sibling, layerSet: null });
  });

  it('asks the AI about its placement, named as the placement', () => {
    const p = split();
    const scope = composerScope(p.state(), { pageId: p.owner.id, selection: p.slot('sidebar'), definitionMode: null });
    expect(scope).toMatchObject({ selection: p.placement, selectionLabel: 'Split' });
    expect(scope.selection?.slot).toBeUndefined();
  });

  it('is remembered on its page as that slot', () => {
    const p = split();
    const st = p.state();
    expect(placeToKeep(st, p.owner.id, p.slot('sidebar'))).toEqual(p.slot('sidebar'));
    expect(readPlaces(st, JSON.parse(JSON.stringify({ [p.owner.id]: p.slot('sidebar') })))).toEqual({ [p.owner.id]: p.slot('sidebar') });
    expect(readPlaces(st, { [p.owner.id]: { ...p.slot('sidebar'), slot: 'footer' } })).toEqual({});
  });

  it('is filled on its page, not in the design edited everywhere', () => {
    const p = split();
    expect(definitionPick(p.state(), p.definitionId, p.chainTo('sidebar'))?.ref).toEqual({ owner: { kind: 'component', id: p.definitionId }, instancePath: [], nodeId: 'sideCol' });
  });
});

describe('the empty slots’ boxes a page reports (#657)', () => {
  it('keeps each well-formed slot and its box, and drops anything else', () => {
    const desc = { ctx: 'page:p', node: 'split', items: '', slot: 'main' };
    const box = { x: 1, y: 2, width: 30, height: 40 };
    expect(slotBoxes([{ desc: { ...desc, tag: 'span' }, box: { ...box, extra: 1 } }])).toEqual([{ desc, box }]);
    expect(slotBoxes([{ desc: { ...desc, slot: undefined }, box }, { desc, box: { ...box, width: -1 } }, { desc }, null, 'x'])).toEqual([]);
    expect(slotBoxes([{ desc: { ...desc, ctx: 7 }, box }, { desc: { ...desc, node: null }, box }, { desc: { ...desc, items: undefined }, box }])).toEqual([]);
    expect(slotBoxes('nope')).toEqual([]);
    // An array carrying a `slice` of its own (a page's own payload) is read all the same.
    expect(slotBoxes(Object.assign([{ desc, box }], { slice: 1 }))).toEqual([{ desc, box }]);
    expect(slotBoxes(Array.from({ length: 80 }, () => ({ desc, box }))).length).toBe(50);
  });
});
