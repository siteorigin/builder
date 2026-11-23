import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { breadcrumb } from '../../src/renderer/src/lib/model';
import { clip, everySizeEdits, eyeAction, hideHereEdits, layerLabel, ownVisibility, rowVisibility, showHereEdits, type Size, type VisibilityEdit } from '../../src/renderer/src/lib/layers';

/** A home page whose first section holds a Grid with a paragraph in it: Section > Grid > Text. */
function nested() {
  let s: ProjectState = createStarterState('business', 'Test Studio', false);
  const pageId = s.site.homePageId;
  const owner = { kind: 'page' as const, id: pageId };
  const run = (ops: EditOperation[]) => (s = applyOperations(s, ops).state);
  run([{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]);
  const section = s.pages[pageId].rootIds[0];
  run([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'grid' }]);
  const grid = (s.pages[pageId].nodes[section] as InstanceNode).slots!.content.at(-1)!;
  run([{ type: 'node.insert', owner, parentId: grid, primitive: 'paragraph', text: 'Meet the makers. Download the exhibitor guide.' }]);
  const para = (s.pages[pageId].nodes[grid] as { children: string[] }).children.at(-1)!;
  const at = (nodeId: string, instancePath: string[] = []): ElementRef => ({ owner, instancePath, nodeId });
  const node = (id: string) => s.pages[pageId].nodes[id];
  const insert = (componentId: string) => {
    run([{ type: 'node.insert', owner, parentId: null, index: 0, componentId }]);
    return s.pages[pageId].rootIds[0];
  };
  return { get s() { return s; }, run, owner, pageId, section, grid, para, at, node, insert };
}
type T = ReturnType<typeof nested>;

const labels = (crumbs: Array<{ label: string }>) => crumbs.map((c) => c.label);

describe('the breadcrumb shows every layer the selection sits in', () => {
  it('lists the section and the grid above a nested paragraph, in document order', () => {
    const t = nested();
    const crumbs = breadcrumb(t.s, t.at(t.para));
    expect(labels(crumbs)).toEqual(['Home', 'Section', 'Grid', 'Text · Meet the makers. Download the exhibitor…']);
    // Each crumb selects its own layer, in the page's own tree; the page itself selects nothing.
    expect(crumbs.map((c) => c.ref)).toEqual([null, t.at(t.section), t.at(t.grid), t.at(t.para)]);
    expect(crumbs[1]).toMatchObject({ component: 'theme', full: 'Section, component' });
    expect(crumbs[2].component).toBeUndefined();
  });

  it('keeps the section above the grid when the grid is selected', () => {
    const t = nested();
    expect(breadcrumb(t.s, t.at(t.grid)).map((c) => c.ref)).toEqual([null, t.at(t.section), t.at(t.grid)]);
  });

  it('marks a component made in this project, and walks into its parts', () => {
    const t = nested();
    const made = applyOperations(t.s, [{ type: 'component.createFromNode', owner: t.owner, nodeId: t.grid, name: 'Maker grid' }]);
    const card = made.results[0].nodeId as string;
    const def = made.state.components[made.results[0].definitionId as string];
    const [pid, part] = Object.entries(def.parts).find(([, p]) => def.tree!.nodes[p.nodeId]?.kind === 'text')!;
    const target: ElementRef = { owner: t.owner, instancePath: [card], nodeId: part.nodeId, partId: pid };
    const crumbs = breadcrumb(made.state, target);
    expect(labels(crumbs)).toEqual(['Home', 'Section', 'Maker grid', part.label]);
    expect(crumbs[2]).toMatchObject({ component: 'custom', full: 'Maker grid, component made in this project' });
    expect(crumbs.map((c) => c.ref)).toEqual([null, t.at(t.section), t.at(card), target]);
  });

  it('starts at the component while it is edited everywhere, then its root', () => {
    const t = nested();
    const made = applyOperations(t.s, [{ type: 'component.createFromNode', owner: t.owner, nodeId: t.grid, name: 'Maker grid' }]);
    const defId = made.results[0].definitionId as string;
    const tree = made.state.components[defId].tree!;
    const root = tree.rootIds[0];
    const text = Object.values(tree.nodes).find((n) => n.kind === 'text')!.id;
    const owner = { kind: 'component' as const, id: defId };
    const atRoot = breadcrumb(made.state, { owner, instancePath: [], nodeId: root });
    expect(atRoot.map((c) => c.ref)).toEqual([null, { owner, instancePath: [], nodeId: root }]);
    expect(atRoot[0].label).toBe('Maker grid');
    // The root is a destination of its own: the text directly inside it can reach it.
    const inner = breadcrumb(made.state, { owner, instancePath: [], nodeId: text });
    expect(inner.map((c) => c.ref)).toEqual([null, { owner, instancePath: [], nodeId: root }, { owner, instancePath: [], nodeId: text }]);
  });

  it('keeps the repeated item for the parts inside it, and drops it above the repeat', () => {
    const t = nested();
    const fg = t.insert('features.grid');
    const item = ((t.node(fg) as InstanceNode).props.items as Array<{ id: string }>)[1].id;
    const crumbs = breadcrumb(t.s, { owner: t.owner, instancePath: [fg], nodeId: 'card-title', partId: 'cardTitle', itemPath: [item] });
    expect(labels(crumbs)).toEqual(['Home', 'Services grid', 'Card grid', 'Card', 'Card title']);
    expect(crumbs.map((c) => c.ref?.itemPath ?? null)).toEqual([null, null, null, [item], [item]]);
    expect(crumbs[2].ref).toEqual({ owner: t.owner, instancePath: [fg], nodeId: 'grid', partId: 'grid' });
    expect(crumbs[3].ref).toEqual({ owner: t.owner, instancePath: [fg], nodeId: 'card', partId: 'card', itemPath: [item] });
  });

  it('keeps the outer item of nested repeats for layers between them', () => {
    const t = nested();
    const fg = t.insert('features.grid');
    const def = t.s.components[(t.node(fg) as InstanceNode).definitionId];
    // A second repeat inside each card, around its title.
    const tree = def.tree!;
    const card = tree.nodes.card as { children: string[] };
    tree.nodes.inner = { id: 'inner', kind: 'repeat', list: { $prop: 'items' }, children: ['card-title'] };
    card.children = card.children.map((c) => (c === 'card-title' ? 'inner' : c));
    const crumbs = breadcrumb(t.s, { owner: t.owner, instancePath: [fg], nodeId: 'card-title', partId: 'cardTitle', itemPath: ['outer', 'inner'] });
    expect(crumbs.find((c) => c.ref?.nodeId === 'card')?.ref?.itemPath).toEqual(['outer']);
    expect(crumbs.find((c) => c.ref?.nodeId === 'grid')?.ref?.itemPath).toBeUndefined();
    expect(crumbs.at(-1)!.ref?.itemPath).toEqual(['outer', 'inner']);
  });
});

describe('layer names', () => {
  it('tell unnamed text apart by its words, in full for assistive tech', () => {
    const t = nested();
    expect(layerLabel(t.s, t.node(t.para))).toEqual({
      label: 'Text · Meet the makers. Download the exhibitor…',
      kind: 'Text',
      excerpt: 'Meet the makers. Download the exhibitor…',
      full: 'Text: Meet the makers. Download the exhibitor guide.'
    });
  });

  it('name a button by its label, and cap what is read out', () => {
    const t = nested();
    t.run([{ type: 'node.insert', owner: t.owner, parentId: t.grid, primitive: 'button', text: 'Book a call' }]);
    const button = (t.node(t.grid) as { children: string[] }).children.at(-1)!;
    expect(layerLabel(t.s, t.node(button))).toMatchObject({ label: 'Button · Book a call', kind: 'Button', excerpt: 'Book a call' });
    const long = 'word '.repeat(80).trim();
    t.run([{ type: 'node.setContent', owner: t.owner, nodeId: t.para, field: 'text', value: long }]);
    const full = layerLabel(t.s, t.node(t.para)).full;
    expect(full.startsWith('Text: word word')).toBe(true);
    expect(full.endsWith('…')).toBe(true);
    expect(full.length).toBeLessThanOrEqual('Text: '.length + 201);
  });

  it('say when a paragraph is empty', () => {
    const t = nested();
    t.run([{ type: 'node.setContent', owner: t.owner, nodeId: t.para, field: 'text', value: '   ' }]);
    expect(layerLabel(t.s, t.node(t.para))).toEqual({ label: 'Text · empty', kind: 'Text', excerpt: 'empty', empty: true, full: 'Text, empty' });
  });

  it('keep a name the author gave after the copy changes', () => {
    const t = nested();
    t.run([{ type: 'node.rename', owner: t.owner, nodeId: t.para, name: 'Makers intro' }]);
    t.run([{ type: 'node.setContent', owner: t.owner, nodeId: t.para, field: 'text', value: 'Something else entirely.' }]);
    expect(layerLabel(t.s, t.node(t.para))).toEqual({ label: 'Makers intro', kind: 'Makers intro', full: 'Makers intro' });
  });

  it('cut long text at a word, or mid-word when there is no space', () => {
    expect(clip('Meet the makers. Download the exhibitor guide.', 20)).toBe('Meet the makers…');
    expect(clip('Supercalifragilisticexpialidocious', 10)).toBe('Supercalif…');
    expect(clip('short', 20)).toBe('short');
  });
});

describe('visibility at the previewed size', () => {
  type Scope = 'base' | Size;
  const hide = (t: T, nodeId: string, scope: Scope, value: boolean | null = true, partId?: string) =>
    t.run([{ type: 'node.setStyle', owner: t.owner, nodeId, ...(partId ? { partId } : {}), scope, property: 'hidden', value }]);
  const apply = (t: T, nodeId: string, edits: VisibilityEdit[]) => edits.forEach((e) => hide(t, nodeId, e.scope, e.value, e.partId));
  const row = (t: T, nodeId: string, size: Size, partId?: string) => rowVisibility(t.s, t.s.pages[t.pageId], t.node(nodeId), size, partId);
  const hiddenAt = (t: T, nodeId: string, partId?: string) => ownVisibility(t.s, t.node(nodeId), partId).hiddenAt;

  it('tells "hidden on phone" apart from a hide at every size', () => {
    const t = nested();
    hide(t, t.para, 'phone');
    const onPhone = row(t, t.para, 'phone');
    expect(onPhone.hiddenHere).toBe(true);
    expect(onPhone.own).toEqual({ hiddenAt: ['phone'], by: { phone: 'size' } });
    expect(onPhone.note).toBe('hidden on phone');
    const onDesktop = row(t, t.para, 'desktop');
    expect(onDesktop.hiddenHere).toBe(false);
    // Still said on desktop, so the row explains what the phone preview shows.
    expect(onDesktop.note).toBe('hidden on phone');

    hide(t, t.para, 'phone', null);
    hide(t, t.para, 'base');
    const everywhere = row(t, t.para, 'desktop');
    expect(everywhere.own).toEqual({ hiddenAt: ['phone', 'tablet', 'desktop'], by: { phone: 'base', tablet: 'base', desktop: 'base' } });
    expect(everywhere.note).toBe('hidden at every size');
  });

  it('lets a size show what every size hides', () => {
    const t = nested();
    hide(t, t.para, 'base');
    hide(t, t.para, 'phone', false);
    expect(hiddenAt(t, t.para)).toEqual(['tablet', 'desktop']);
    expect(row(t, t.para, 'phone')).toMatchObject({ hiddenHere: false, note: 'hidden on tablet and desktop' });
  });

  it('keeps a layer hidden at every size where a size arranges it its own way, as the generated CSS does', () => {
    const t = nested();
    t.run([{ type: 'node.setStyle', owner: t.owner, nodeId: t.grid, scope: 'phone', property: 'layout', value: 'stack' }]);
    hide(t, t.grid, 'base');
    expect(hiddenAt(t, t.grid)).toEqual(['phone', 'tablet', 'desktop']);
  });

  it('shows a layer again on one size only, leaving the other sizes as they were', () => {
    const t = nested();
    hide(t, t.para, 'phone');
    // Hidden on phone alone: the phone setting is taken away.
    expect(showHereEdits(t.s, t.node(t.para), 'phone')).toEqual([{ scope: 'phone', value: null }]);
    expect(showHereEdits(t.s, t.node(t.para), 'desktop')).toEqual([]);
    // Hidden at every size as well: phone shows it, the other sizes keep hiding it.
    hide(t, t.para, 'base');
    expect(showHereEdits(t.s, t.node(t.para), 'phone')).toEqual([{ scope: 'phone', value: false }]);
    apply(t, t.para, showHereEdits(t.s, t.node(t.para), 'desktop'));
    expect(t.node(t.para).styles?.desktop?.hidden).toBe(false);
    expect(hiddenAt(t, t.para)).toEqual(['phone', 'tablet']);
  });

  it('hides a layer on one size only, taking away that size’s own exception first', () => {
    const t = nested();
    expect(hideHereEdits(t.s, t.node(t.para), 'phone')).toEqual([{ scope: 'phone', value: true }]);
    apply(t, t.para, hideHereEdits(t.s, t.node(t.para), 'phone'));
    expect(hiddenAt(t, t.para)).toEqual(['phone']);
    expect(hideHereEdits(t.s, t.node(t.para), 'phone')).toEqual([]);
    hide(t, t.para, 'phone', null);
    hide(t, t.para, 'base');
    hide(t, t.para, 'phone', false);
    expect(hideHereEdits(t.s, t.node(t.para), 'phone')).toEqual([{ scope: 'phone', value: null }]);
  });

  it('hides and shows at every size, taking each size’s own setting with it', () => {
    const t = nested();
    expect(everySizeEdits(t.s, t.node(t.para), false)).toEqual([]);
    apply(t, t.para, everySizeEdits(t.s, t.node(t.para), true));
    expect(hiddenAt(t, t.para)).toEqual(['phone', 'tablet', 'desktop']);
    expect(everySizeEdits(t.s, t.node(t.para), true)).toEqual([]);
    apply(t, t.para, everySizeEdits(t.s, t.node(t.para), false));
    expect(t.node(t.para).styles?.base?.hidden).toBeUndefined();
    // "At every size" means it: a size's own hide goes too, and so does a size's own exception.
    hide(t, t.para, 'phone');
    hide(t, t.para, 'base');
    expect(everySizeEdits(t.s, t.node(t.para), false)).toEqual([{ scope: 'phone', value: null }, { scope: 'base', value: null }]);
    hide(t, t.para, 'phone', false);
    apply(t, t.para, everySizeEdits(t.s, t.node(t.para), true));
    expect(hiddenAt(t, t.para)).toEqual(['phone', 'tablet', 'desktop']);
  });

  it('shows a placement its design hides by saying so on the placement', () => {
    const t = nested();
    const def = t.s.components[(t.node(t.section) as InstanceNode).definitionId];
    const root = def.tree!.rootIds[0];
    def.tree!.nodes[root].styles = { ...def.tree!.nodes[root].styles, base: { ...def.tree!.nodes[root].styles?.base, hidden: true } };
    expect(hiddenAt(t, t.section)).toEqual(['phone', 'tablet', 'desktop']);
    expect(everySizeEdits(t.s, t.node(t.section), false)).toEqual([{ partId: 'root', scope: 'base', value: false }]);
  });

  it('explains a hide inherited from a container, only at the size it applies to, naming the nearest', () => {
    const t = nested();
    hide(t, t.grid, 'phone');
    hide(t, t.section, 'phone', true, 'root');
    const onPhone = row(t, t.para, 'phone');
    expect(onPhone.hiddenHere).toBe(false);
    expect(onPhone.hiddenBy).toEqual({ id: t.grid, name: 'Grid', sizes: ['phone'] });
    expect(onPhone.note).toBe('hidden on phone because Grid is hidden on phone');
    expect(row(t, t.para, 'desktop')).toMatchObject({ hiddenHere: false, hiddenBy: null, note: '' });
  });

  it('finds a section’s Container part hiding what is placed in its slot, even over a child’s own exception', () => {
    const t = nested();
    hide(t, t.para, 'base');
    hide(t, t.para, 'phone', false);
    expect(row(t, t.para, 'phone')).toMatchObject({ hiddenHere: false, hiddenBy: null });
    hide(t, t.section, 'phone', true, 'container');
    const onPhone = row(t, t.para, 'phone');
    expect(onPhone.hiddenBy).toEqual({ id: t.section, part: { id: 'container', nodeId: 'inner' }, name: 'Section › Container', sizes: ['phone'] });
    expect(row(t, t.grid, 'phone').hiddenBy?.part?.id).toBe('container');
    // The section itself still shows on phone: only what its Container holds is hidden.
    expect(hiddenAt(t, t.section)).toEqual([]);
  });

  it('reads a placed component’s hide from its root override, and edits that override', () => {
    const t = nested();
    hide(t, t.section, 'tablet', true, 'root');
    expect(hiddenAt(t, t.section)).toEqual(['tablet']);
    expect(showHereEdits(t.s, t.node(t.section), 'tablet')).toEqual([{ partId: 'root', scope: 'tablet', value: null }]);
    expect(row(t, t.grid, 'tablet').hiddenBy?.id).toBe(t.section);
  });

  it('finds a part hidden by a wrapper inside its placement', () => {
    const t = nested();
    const fg = t.insert('features.grid');
    hide(t, fg, 'phone', true, 'grid');
    const title = row(t, fg, 'phone', 'cardTitle');
    expect(title.hiddenHere).toBe(false);
    expect(title.hiddenBy).toEqual({ id: fg, part: { id: 'grid', nodeId: 'grid' }, name: 'Services grid › Card grid', sizes: ['phone'] });
    expect(row(t, fg, 'desktop', 'cardTitle').hiddenBy).toBeNull();
  });

  it('counts the option a placement chose: one can show a part its design hides on phone', () => {
    const t = nested();
    const fg = t.insert('features.grid');
    const def = t.s.components[(t.node(fg) as InstanceNode).definitionId];
    def.tree!.nodes.grid.styles = { ...def.tree!.nodes.grid.styles, phone: { hidden: true } };
    def.variantAxes!.layout.options['two-columns'].styles = { grid: { base: { hidden: false } } };
    expect(hiddenAt(t, fg, 'grid')).toEqual(['phone']);
    (t.node(fg) as InstanceNode).variants = { layout: 'four-columns' };
    expect(hiddenAt(t, fg, 'grid')).toEqual(['phone']);
    (t.node(fg) as InstanceNode).variants = { layout: 'two-columns' };
    expect(hiddenAt(t, fg, 'grid')).toEqual([]);
  });

  it('lets one option’s rule for a size beat another option’s rule for every size, as the stylesheet orders them', () => {
    const t = nested();
    const fg = t.insert('features.grid');
    const def = t.s.components[(t.node(fg) as InstanceNode).definitionId];
    const tone = Object.keys(def.variantAxes!).find((a) => a !== 'layout')!;
    const toneOption = Object.keys(def.variantAxes![tone].options)[0];
    def.variantAxes!.layout.options['two-columns'].styles = { grid: { phone: { hidden: false } } };
    def.variantAxes![tone].options[toneOption].styles = { grid: { base: { hidden: true } } };
    (t.node(fg) as InstanceNode).variants = { layout: 'two-columns', [tone]: toneOption };
    expect(hiddenAt(t, fg, 'grid')).toEqual(['tablet', 'desktop']);
  });

  it('never counts a repeat as hiding what it repeats', () => {
    const t = nested();
    const fg = t.insert('features.grid');
    const def = t.s.components[(t.node(fg) as InstanceNode).definitionId];
    const repeat = Object.values(def.tree!.nodes).find((n) => n.kind === 'repeat')!;
    repeat.styles = { phone: { hidden: true } };
    expect(row(t, fg, 'phone', 'cardTitle').hiddenBy).toBeNull();
  });
});

describe('the eye in Layers', () => {
  const set = (t: T, scope: 'base' | Size, value: boolean | null) => t.run([{ type: 'node.setStyle', owner: t.owner, nodeId: t.para, scope, property: 'hidden', value }]);
  const click = (t: T, size: Size) => eyeAction(t.s, t.node(t.para), size).edits.forEach((e) => set(t, e.scope, e.value));
  const hiddenAt = (t: T) => ownVisibility(t.s, t.node(t.para)).hiddenAt;

  it('is pressed for a phone-only hide in the phone preview, and takes that hide away', () => {
    const t = nested();
    set(t, 'phone', true);
    expect(eyeAction(t.s, t.node(t.para), 'phone')).toEqual({ pressed: true, action: 'Show on phone', edits: [{ scope: 'phone', value: null }] });
    expect(eyeAction(t.s, t.node(t.para), 'desktop')).toMatchObject({ pressed: false, action: 'Hide at every size' });
    click(t, 'phone');
    expect(t.node(t.para).styles?.phone?.hidden).toBeUndefined();
    expect(hiddenAt(t)).toEqual([]);
  });

  it('still hides at every size from the default preview, and shows it everywhere again', () => {
    const t = nested();
    click(t, 'desktop');
    expect(hiddenAt(t)).toEqual(['phone', 'tablet', 'desktop']);
    expect(eyeAction(t.s, t.node(t.para), 'phone')).toEqual({ pressed: true, action: 'Show at every size', edits: [{ scope: 'base', value: null }] });
    click(t, 'phone');
    expect(hiddenAt(t)).toEqual([]);
  });

  it('shows it on this size alone when this size has its own hide, whatever every size says', () => {
    const t = nested();
    set(t, 'phone', true);
    set(t, 'base', true);
    expect(eyeAction(t.s, t.node(t.para), 'phone')).toMatchObject({ pressed: true, action: 'Show on phone' });
    click(t, 'phone');
    expect(hiddenAt(t)).toEqual(['tablet', 'desktop']);
  });

  it('hides it everywhere when it showed here only as an exception', () => {
    const t = nested();
    set(t, 'base', true);
    set(t, 'phone', false);
    expect(eyeAction(t.s, t.node(t.para), 'phone')).toEqual({ pressed: false, action: 'Hide at every size', edits: [{ scope: 'phone', value: null }] });
    click(t, 'phone');
    expect(hiddenAt(t)).toEqual(['phone', 'tablet', 'desktop']);
  });

  it('shows a placement its design hides on this size when every size is shown again', () => {
    const t = nested();
    const def = t.s.components[(t.node(t.section) as InstanceNode).definitionId];
    const root = def.tree!.rootIds[0];
    def.tree!.nodes[root].styles = { ...def.tree!.nodes[root].styles, phone: { hidden: true } };
    t.run([{ type: 'node.setStyle', owner: t.owner, nodeId: t.section, partId: 'root', scope: 'base', property: 'hidden', value: true }]);
    const eye = eyeAction(t.s, t.node(t.section), 'phone');
    expect(eye).toMatchObject({ pressed: true, action: 'Show at every size' });
    expect(eye.edits).toEqual([{ partId: 'root', scope: 'base', value: false }]);
  });
});
