import { afterAll, describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState, SlotNode } from '@shared/types';
import { validateOperation, type EditOperation } from '@shared/ops';
import { PREVIEW_MODULE } from '@shared/component-preview';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { slotAccepts, slotDeclProblem, slotFill, takesComponent } from '@engine/slots';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { generateComponentPreview } from '@generator/preview';
import { checkSvelteSource } from '../../src/main/codecheck';
import { addPoints, fitting, offeredAt, quickItems, resolvePoint } from '../../src/renderer/src/lib/inline-insert';
import { slotRefuses } from '../../src/renderer/src/lib/insert-at';
import { removeRendered, serverHtml } from './generated-site';

/**
 * A slot can take components by name (#660): a catalogue contract ID, the same in every compatible theme, or a
 * project definition ID, beside the categories and element kinds it takes.
 */

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const slotOf = (s: ProjectState, nodeId: string, slot = 'content') => (home(s).nodes[nodeId] as InstanceNode).slots?.[slot] ?? [];

/** A blank site whose Section is the project's own, placed once on Home and empty; and a card component of the project's. */
function bento() {
  let s = createStarterState('blank', 'Bento', false);
  const page: OwnerRef = { kind: 'page', id: s.site.homePageId };
  const run = (ops: EditOperation[]) => {
    const r = applyOperations(s, ops);
    s = r.state;
    return r.results;
  };
  const [{ nodeId: scratch }] = run([{ type: 'node.insert', owner: page, parentId: null, componentId: 'layout.section' }]);
  const [{ nodeId: stack }] = run([{ type: 'node.insert', owner: page, parentId: scratch as string, slot: 'content', primitive: 'stack' }]);
  run([{ type: 'node.insert', owner: page, parentId: stack as string, primitive: 'heading', text: 'Card' }]);
  const [{ definitionId: card }] = run([{ type: 'component.createFromNode', owner: page, nodeId: stack as string, name: 'Feature card' }]);
  const [{ definitionId: section }] = run([{ type: 'component.fork', definitionId: (home(s).nodes[scratch as string] as InstanceNode).definitionId }]);
  run([{ type: 'node.remove', owner: page, nodeId: scratch as string }]);
  const [{ nodeId: grid }] = run([
    { type: 'node.insert', owner: page, parentId: null, definitionId: section as string },
    { type: 'component.setSlot', definitionId: section as string, slot: 'content', label: 'Content', description: null }
  ]);
  return { s, page, section: section as string, card: card as string, grid: grid as string };
}

describe('a slot that names the components it takes', () => {
  it('takes the components it names, by contract or definition ID, and refuses others and elements it does not list', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card, 'media.gallery'] }]).state;
    expect(s.components[section].slots!.content).toEqual({ label: 'Cards', componentIds: [card, 'media.gallery'] });
    // Named by its definition ID, and by the contract every compatible theme's gallery shares.
    let next = applyOperations(s, [
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', definitionId: card },
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', componentId: 'media.gallery' }
    ]).state;
    expect(slotOf(next, grid)).toHaveLength(2);
    expect(errors(next)).toEqual([]);
    // Another component, of whatever category, or an element, is refused, and the message names what it takes.
    const gallery = Object.values(next.components).find((d) => d.componentId === 'media.gallery')!.name;
    expect(() => applyOperations(next, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'content', componentId: 'features.grid' }])).toThrow(
      new RegExp(`“Cards” slot of “Section” takes “Feature card” and “${gallery}”, not “Services grid” \\(a content component\\)`)
    );
    expect(() => applyOperations(next, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'content', primitive: 'heading' }])).toThrow(/takes “Feature card” and .*, not text/);
    // With element kinds listed too, it takes either.
    next = applyOperations(next, [
      { type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', primitives: ['text'] },
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', primitive: 'heading' }
    ]).state;
    expect(slotOf(next, grid)).toHaveLength(3);
    expect(() => applyOperations(next, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'content', primitive: 'image' }])).toThrow(/takes “Feature card”, “.*” and text, not an image/);
  });

  it('takes a component of a category it lists or one it names, and calls a component the project lacks by its ID', () => {
    const { s, card } = bento();
    const def = s.components[card];
    expect(takesComponent({ label: 'x', componentIds: [card] }, def)).toBe(true);
    expect(takesComponent({ label: 'x', componentIds: [def.componentId] }, def)).toBe(true);
    expect(takesComponent({ label: 'x', categories: [def.category] }, def)).toBe(true);
    expect(takesComponent({ label: 'x', componentIds: ['pricing.plans'], categories: ['hero'] }, def)).toBe(false);
    expect(takesComponent({ label: 'x', primitives: ['text'] }, def)).toBe(false);
    expect(takesComponent({ label: 'x' }, def)).toBe(true);
    expect(slotAccepts({ label: 'x', componentIds: ['studio.bento-card'] }, s)).toBe('“studio.bento-card”');
    expect(slotAccepts({ label: 'x', componentIds: [] })).toBe('nothing');
    expect(slotAccepts({ label: 'x', categories: ['media'], componentIds: [card], primitives: ['image'] }, s)).toBe('media components, “Feature card” and images');
  });

  it('refuses tightening a contract its content no longer fits, keeps the list a relabel leaves out, and clears it with null', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [
      { type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card, card, ` ${card} `] },
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', definitionId: card }
    ]).state;
    // Named once, however often it was sent.
    expect(s.components[section].slots!.content.componentIds).toEqual([card]);
    expect(applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Tiles' }]).state.components[section].slots!.content).toEqual({ label: 'Tiles', componentIds: [card] });
    expect(applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: null }]).state.components[section].slots!.content).toEqual({ label: 'Cards' });
    expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: ['media.gallery'] }])).toThrow(/already holds “Feature card” \(a custom component\), which it would no longer take/);
    expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: ['  '] }])).toThrow(/by its ID/);
    expect(validateOperation({ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'x', componentIds: [''] }).ok).toBe(false);
    expect(validateOperation({ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'x', componentIds: Array.from({ length: 51 }, (_, i) => `c${i}`) }).ok).toBe(false);
    expect(validateOperation({ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'x', componentIds: [card] }).ok).toBe(true);
  });

  it('reports content it does not take, and a list damaged by hand, when the project is opened', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'content', definitionId: card }]).state;
    s.components[section].slots!.content = { label: 'Cards', componentIds: ['media.gallery'] };
    expect(errors(s).map((d) => [d.code, d.message])).toEqual([['SLOT_REFUSED', expect.stringMatching(/the “Cards” slot of Section takes “.*”, but holds “Feature card” \(a custom component\)\./)]]);
    for (const damaged of ['media.gallery', [''], [42], Array.from({ length: 51 }, (_, i) => `c${i}`)]) {
      expect(slotDeclProblem({ label: 'Cards', componentIds: damaged })).toMatch(/names components by something other than up to 50 component IDs/);
      s.components[section].slots!.content = { label: 'Cards', componentIds: damaged as string[] };
      expect(errors(s).map((d) => d.code)).toEqual(['SLOT_INVALID']);
    }
  });

  it('takes a slot passed on from outside only when every component that slot names is one it takes too', () => {
    const { s: base, section, card } = bento();
    const own: OwnerRef = { kind: 'component', id: section };
    // The Section's inner box becomes a component of its own, which takes the Section's content straight on.
    let s = applyOperations(base, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card] }]).state;
    const w = applyOperations(s, [{ type: 'component.createFromNode', owner: own, nodeId: 'inner', name: 'Inner' }]);
    const inner = w.results[0].definitionId as string;
    s = w.state;
    expect(s.components[inner].slots!.content).toEqual({ label: 'Cards', componentIds: [card] });
    expect(errors(s)).toEqual([]);
    // The inner slot can take the card by its category instead.
    s = applyOperations(s, [{ type: 'component.setSlot', definitionId: inner, slot: 'content', label: 'Cards', componentIds: null, categories: ['custom'] }]).state;
    expect(errors(s)).toEqual([]);
    // Not when it takes neither the card nor its category.
    expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: inner, slot: 'content', label: 'Cards', categories: ['media'] }])).toThrow(/already holds the content of “Cards”, which can be “Feature card”/);
    // Nor when the outer slot names a component the project lacks, which only a slot naming it too can take.
    s = applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card, 'studio.missing'] }]).state;
    expect(errors(s).map((d) => d.code)).toEqual(['SLOT_REFUSED']);
    s = applyOperations(s, [{ type: 'component.setSlot', definitionId: inner, slot: 'content', label: 'Cards', componentIds: ['studio.missing'] }]).state;
    expect(errors(s)).toEqual([]);
  });

  it('changes a placement in the slot to another design only when the slot takes that design', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [
      { type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card, 'media.gallery'] },
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', definitionId: card }
    ]).state;
    const placed = slotOf(s, grid)[0];
    expect(() => applyOperations(s, [{ type: 'instance.swapComponent', owner: page, nodeId: placed, componentId: 'features.grid' }])).toThrow(/takes “Feature card” and “.*”, not “Services grid” \(a content component\)/);
  });

  it('refuses making a placement in the slot unique when the slot names the original, which the copy is not', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [
      { type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card] },
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', definitionId: card }
    ]).state;
    const placed = slotOf(s, grid)[0];
    expect(() => applyOperations(s, [{ type: 'component.makeUnique', owner: page, nodeId: placed }])).toThrow(/“Cards” slot of “Section” takes “Feature card”, not a copy of “Feature card”/);
    // Taken by its category instead, the copy goes too.
    const open = applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: null, categories: ['custom'] }]).state;
    const r = applyOperations(open, [{ type: 'component.makeUnique', owner: page, nodeId: placed }]);
    expect(errors(r.state)).toEqual([]);
  });

  it('offers the canvas’s Add list inside the slot only the components it names', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card] }]).state;
    const ref: ElementRef = { owner: page, instancePath: [], nodeId: grid };
    const inside = addPoints(s, page, ref).find((p) => p.side === 'inside')!;
    const offered = fitting(s, resolvePoint(s, inside)!, 'element', quickItems(s, 'element'));
    expect(offered.map((it) => it.spec.definitionId ?? it.name)).toEqual([card]);
  });
});

describe('the Insert panel and the canvas’s Add list inside a slot that names what it takes', () => {
  it('leave out the basic elements and components the slot refuses, and offer the theme’s components it names', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card, 'media.gallery'], primitives: ['text'] }]).state;
    const at = { owner: page, parentId: grid, slot: 'content' };
    expect(slotRefuses(s, at, { primitive: 'heading' })).toBe(false);
    expect(slotRefuses(s, at, { primitive: 'image' })).toBe(true);
    expect(slotRefuses(s, at, { primitive: 'badge' })).toBe(true);
    expect(slotRefuses(s, at, { definitionId: card })).toBe(false);
    // A theme component the project has not installed yet is known by the theme's own design.
    expect(slotRefuses(s, at, { componentId: 'media.gallery' })).toBe(false);
    expect(slotRefuses(s, at, { componentId: 'features.grid' })).toBe(true);
    // Beside the sections, or in a slot that takes anything, nothing is refused.
    expect(slotRefuses(s, { owner: page, parentId: null }, { primitive: 'image' })).toBe(false);
    const open = applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: null, primitives: null }]).state;
    expect(slotRefuses(open, at, { primitive: 'image' })).toBe(false);
    // The + inside it offers the gallery it names, which a container's + offers nowhere else.
    const keys = offeredAt(s, at, 'element').map((it) => it.key);
    expect(keys).toContain('s:media.gallery');
    expect(keys).toContain(`c:${card}`);
    expect(keys).not.toContain('s:features.grid');
    expect(offeredAt(open, at, 'element').some((it) => it.key.startsWith('s:'))).toBe(false);
  });
});

/** The bento Section with an Aside slot (text only, at most one) whose design shows a Default badge heading while it is empty. */
function badged() {
  const b = bento();
  const own: OwnerRef = { kind: 'component', id: b.section };
  let r = applyOperations(b.s, [
    { type: 'component.setSlot', definitionId: b.section, slot: 'aside', label: 'Aside', primitives: ['text'], max: 1 },
    { type: 'node.insert', owner: own, parentId: 'inner', primitive: 'slot', bind: 'aside' }
  ]);
  const outlet = r.results[1].nodeId as string;
  r = applyOperations(r.state, [{ type: 'node.insert', owner: own, parentId: outlet, primitive: 'heading', text: 'Default badge' }]);
  return { ...b, s: r.state, own, outlet, badge: r.results[0].nodeId as string };
}
const tree = (s: ProjectState, id: string) => s.components[id].tree!;
const EDITOR = /so_editing|data-so-|so-slot-empty|data-so-editor-only/;

describe('a slot’s fallback content', () => {
  afterAll(removeRendered);

  it('is the design’s own content inside the slot, edited, copied and removed with it', () => {
    const { s, own, section, outlet, badge } = badged();
    expect((tree(s, section).nodes[outlet] as SlotNode).children).toEqual([badge]);
    expect(errors(s)).toEqual([]);
    // A slot inside the fallback is not a thing: the fallback has no slots of its own.
    expect(() => applyOperations(s, [{ type: 'node.insert', owner: own, parentId: outlet, slot: 'aside', primitive: 'heading' }])).toThrow(/fallback content has no slots/);
    // Moved in and out like any container's content.
    const moved = applyOperations(s, [{ type: 'node.move', owner: own, nodeId: badge, parentId: 'inner', index: 0 }]).state;
    expect((tree(moved, section).nodes[outlet] as SlotNode).children).toEqual([]);
    const back = applyOperations(moved, [{ type: 'node.move', owner: own, nodeId: badge, parentId: outlet, index: 0 }]).state;
    expect((tree(back, section).nodes[outlet] as SlotNode).children).toEqual([badge]);
    // Removing the slot takes its fallback with it, and the parts that named it.
    const parted = applyOperations(s, [{ type: 'component.setPart', definitionId: section, partId: 'badge', nodeId: badge, label: 'Badge' }]).state;
    const gone = applyOperations(parted, [{ type: 'component.removeSlot', definitionId: section, slot: 'aside' }]).state;
    expect(tree(gone, section).nodes[badge]).toBeUndefined();
    expect(gone.components[section].parts.badge).toBeUndefined();
    expect(errors(gone)).toEqual([]);
  });

  it('is copied with the design when the design is copied, pointing at its own copies', () => {
    const { s, own, section, outlet, badge } = badged();
    // Duplicating the element holding the slot copies the slot and its fallback under new IDs.
    const r = applyOperations(s, [{ type: 'node.insert', owner: own, parentId: outlet, primitive: 'paragraph', text: 'Second' }]);
    const t = tree(r.state, section);
    const removedBadge = applyOperations(r.state, [{ type: 'node.remove', owner: own, nodeId: badge }]).state;
    expect((tree(removedBadge, section).nodes[outlet] as SlotNode).children).toEqual([r.results[0].nodeId]);
    expect(Object.keys(t.nodes)).toContain(badge);
    const dup = applyOperations(s, [{ type: 'component.duplicate', definitionId: section, name: 'Twin' }]);
    const twin = dup.state.components[dup.results[0].definitionId as string];
    const twinOutlet = Object.values(twin.tree!.nodes).find((n): n is SlotNode => n.kind === 'slot' && n.slot === 'aside')!;
    expect(twinOutlet.children?.every((c) => Object.hasOwn(twin.tree!.nodes, c))).toBe(true);
    expect(errors(dup.state)).toEqual([]);
  });

  it('is reported when a hand edit leaves it something other than a list of elements that exist', () => {
    const { s, section, outlet } = badged();
    (tree(s, section).nodes[outlet] as { children: unknown }).children = 'oops';
    expect(errors(s).map((d) => d.code)).toEqual(['SLOT_INVALID']);
    expect(() => generateProject(s)).not.toThrow();
    (tree(s, section).nodes[outlet] as { children: unknown }).children = ['ghost'];
    expect(errors(s).map((d) => d.code)).toContain('NODE_MISSING');
  });

  it('shows on the website and in Preview while the placement leaves the slot empty, and gives way as soon as it has content', async () => {
    const { s, page, grid } = badged();
    const files = generateProject(s);
    const design = [...files.values()].find((src) => src.includes('Default badge') && src.includes('so_in_aside'))!;
    expect(design).toMatch(/\{#if so_in_aside\}\s*\{@render so_in_aside\(\)\}\s*\{:else\}[\s\S]*Default badge[\s\S]*\{\/if\}/);
    expect(design).toContain('slot_aside: so_in_aside = undefined');
    for (const [path, src] of files) expect(src, path).not.toMatch(EDITOR);
    expect(await serverHtml(files, 'slot-fallback-')).toContain('Default badge');
    const filled = applyOperations(s, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'aside', primitive: 'paragraph', text: 'Book now' }]).state;
    const html = await serverHtml(generateProject(filled), 'slot-fallback-');
    expect(html).toContain('Book now');
    expect(html).not.toContain('Default badge');
    const emptied = applyOperations(filled, [{ type: 'node.remove', owner: page, nodeId: slotOf(filled, grid, 'aside')[0] }]).state;
    expect(await serverHtml(generateProject(emptied), 'slot-fallback-')).toContain('Default badge');
  });

  it('gives way to the editor’s placeholder only while editing, and shows in Component Studio’s preview of the design', () => {
    const { s, section } = badged();
    const home = generateProject(s, { instrument: true }).get('src/routes/+page.svelte')!;
    expect(home).toMatch(/slot_aside=\{so_editing \? so_slot_empty_\d+ : undefined\}/);
    expect(() => compile(home, { filename: 'page.svelte', generate: 'client', runes: true })).not.toThrow();
    expect(() => compile(home, { filename: 'page.svelte', generate: 'server', runes: true })).not.toThrow();
    // In Component Studio the fallback itself shows, to select and edit; a slot without one still shows its placeholder.
    const preview = generateComponentPreview(s, { definitionId: section });
    if (!('files' in preview)) throw new Error(preview.error);
    const module = preview.files.get(PREVIEW_MODULE)!;
    expect(module).not.toContain('slot_aside=');
    expect(module).toMatch(/slot_content=\{so_editing \? so_slot_empty_\d+ : undefined\}/);
    expect([...preview.files.values()].some((src) => src.includes('Default badge') && /data-so-node="[^"]+"/.test(src))).toBe(true);
  });

  it('renders content handed on through a component made from part of the design, which once called itself without end', async () => {
    const { s: base, page, section, grid } = bento();
    const w = applyOperations(base, [{ type: 'component.createFromNode', owner: { kind: 'component', id: section }, nodeId: 'inner', name: 'Inner' }]);
    const s = applyOperations(w.state, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'content', primitive: 'heading', text: 'Handed on' }]).state;
    expect(await serverHtml(generateProject(s), 'slot-forward-')).toContain('Handed on');
  });

  it('still shows once the element holding the slot becomes a component of its own, until the placement gives the slot content', async () => {
    const { s: base, own, page, grid } = badged();
    const w = applyOperations(base, [{ type: 'component.createFromNode', owner: own, nodeId: 'inner', name: 'Inner' }]);
    expect(errors(w.state)).toEqual([]);
    expect(await serverHtml(generateProject(w.state), 'slot-extract-')).toContain('Default badge');
    const filled = applyOperations(w.state, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'aside', primitive: 'paragraph', text: 'Book now' }]).state;
    const html = await serverHtml(generateProject(filled), 'slot-extract-');
    expect(html).toContain('Book now');
    expect(html).not.toContain('Default badge');
  });

  it('counts, where the design hands the slot on, as content the receiving slot must take, whichever of the two shows', () => {
    const s = bento().s;
    const text = (id: string): GraphNode => ({ id, kind: 'text', tag: 'p', text: id });
    const t: NodeTree = { rootIds: ['o'], nodes: { o: { id: 'o', kind: 'slot', slot: 'aside', children: ['a', 'b'] }, a: text('a'), b: text('b') } };
    const design = (aside: object) => ({ id: 'd', slots: { aside: { label: 'Aside', ...aside } } }) as unknown as ComponentDefinition;
    // One item passed on, or two of the fallback's: two is what can show.
    expect(slotFill(s, t, ['o'], { label: 'Inner', primitives: ['text'], max: 1 }, design({ primitives: ['text'], max: 1 })).count).toBe(2);
    // The fallback's paragraphs are refused by a slot that takes only images.
    expect(slotFill(s, t, ['o'], { label: 'Inner', primitives: ['image'] }, design({ primitives: ['image'], max: 1 })).refusedAll.map((r) => r.nodeId)).toEqual(['a', 'b']);
    // A slot closed to content brings only its fallback.
    expect(slotFill(s, t, ['o'], { label: 'Inner', primitives: ['text'] }, design({ max: 0 }))).toEqual({ count: 2, refusedAll: [] });
  });

  it('is made the page’s own when a placement that leaves the slot empty is detached', () => {
    const { s, page, grid } = badged();
    const r = applyOperations(s, [{ type: 'component.detachInstance', owner: page, nodeId: grid } as EditOperation]);
    expect(Object.values(home(r.state).nodes).some((n) => n.kind === 'text' && n.text === 'Default badge')).toBe(true);
    expect(errors(r.state)).toEqual([]);
    const filled = applyOperations(s, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'aside', primitive: 'paragraph', text: 'Book now' }]).state;
    const d = applyOperations(filled, [{ type: 'component.detachInstance', owner: page, nodeId: grid } as EditOperation]);
    expect(Object.values(home(d.state).nodes).some((n) => n.kind === 'text' && n.text === 'Default badge')).toBe(false);
  });

  it('is kept by a design written whole, with the components its slots name, and by a copy converted to code', async () => {
    const { s, page, grid, section } = badged();
    const r = applyOperations(s, [
      {
        type: 'component.upsert',
        name: 'Bento',
        category: 'layout',
        properties: {},
        nodes: [
          { kind: 'element', id: 'root', children: ['cards', 'side'] },
          { kind: 'slot', id: 'cards', slot: 'cards' },
          { kind: 'slot', id: 'side', slot: 'side', children: ['hint'] },
          { kind: 'text', id: 'hint', tag: 'p', text: 'Nothing here yet' }
        ],
        slots: { cards: { label: 'Cards', componentIds: ['media.gallery', ' media.gallery'] }, side: { label: 'Side' } }
      } as EditOperation
    ]);
    const def = r.state.components[r.results[0].definitionId as string];
    expect(def.slots).toEqual({ cards: { label: 'Cards', componentIds: ['media.gallery'] }, side: { label: 'Side' } });
    expect(def.tree!.nodes.side).toEqual({ id: 'side', kind: 'slot', slot: 'side', children: ['hint'] });
    expect(errors(r.state)).toEqual([]);
    // Converted to code, the fallback is the code's own {#if}…{:else}, which the code check takes.
    const converted = applyOperations(s, [{ type: 'component.convertToCode', owner: page, nodeId: grid }]);
    const code = converted.state.components[converted.results[0].definitionId as string];
    expect(code.source).toMatch(/\{#if so_in_aside\}[\s\S]*Default badge/);
    const problems = await checkSvelteSource(code.source!, { contract: { slots: code.slots, parts: code.parts } });
    expect(problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(s.components[section].kind).toBe('managed');
  });
});
