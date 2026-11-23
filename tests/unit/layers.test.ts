import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, Op, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { breadcrumb } from '../../src/renderer/src/lib/model';
import { clip, everySizeEdits, eyeAction, hideHereEdits, layerLabel, ownVisibility, rowVisibility, showHereEdits, type Size, type VisibilityEdit } from '../../src/renderer/src/lib/layers';

/** A home page whose first section holds a Grid with a paragraph in it: Section > Grid > Text. */
function nested() {
  let s: ProjectState = createStarterState('business', 'Test Studio', false);
  const pageId = s.site.homePageId;
  const owner = { kind: 'page' as const, id: pageId };
  const run = (ops: Op[]) => (s = applyOperations(s, ops).state);
  run([{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]);
  const section = s.pages[pageId].rootIds[0];
  run([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'grid' }]);
  const grid = (s.pages[pageId].nodes[section] as InstanceNode).slots!.content.at(-1)!;
  run([{ type: 'node.insert', owner, parentId: grid, primitive: 'paragraph', text: 'Meet the makers. Download the exhibitor guide.' }]);
  const para = (s.pages[pageId].nodes[grid] as { children: string[] }).children.at(-1)!;
  const at = (nodeId: string, instancePath: string[] = []): ElementRef => ({ owner, instancePath, nodeId });
  const node = (id: string) => s.pages[pageId].nodes[id];
  return { get s() { return s; }, run, owner, pageId, section, grid, para, at, node };
}

const labels = (crumbs: Array<{ label: string }>) => crumbs.map((c) => c.label);

describe('the breadcrumb shows every layer the selection sits in', () => {
  it('lists the section and the grid above a nested paragraph, in document order', () => {
    const t = nested();
    const crumbs = breadcrumb(t.s, t.at(t.para));
    expect(labels(crumbs)).toEqual(['Home', 'Section', 'Grid', 'Text · Meet the makers. Download the exhibitor…']);
    // Each crumb selects its own layer; the page itself selects nothing.
    expect(crumbs.map((c) => c.ref?.nodeId ?? null)).toEqual([null, t.section, t.grid, t.para]);
    expect(crumbs[1].component).toBe('theme');
    expect(crumbs[2].component).toBeUndefined();
  });

  it('keeps the section above the grid when the grid is selected', () => {
    const t = nested();
    expect(labels(breadcrumb(t.s, t.at(t.grid)))).toEqual(['Home', 'Section', 'Grid']);
  });

  it('marks a component made in this project, and walks into its parts', () => {
    const t = nested();
    const made = applyOperations(t.s, [{ type: 'component.createFromNode', owner: t.owner, nodeId: t.grid, name: 'Maker grid' }]);
    const card = made.results[0].nodeId as string;
    const def = made.state.components[made.results[0].definitionId as string];
    const [pid, part] = Object.entries(def.parts).find(([, p]) => def.tree!.nodes[p.nodeId]?.kind === 'text')!;
    const crumbs = breadcrumb(made.state, { owner: t.owner, instancePath: [card], nodeId: part.nodeId, partId: pid });
    expect(labels(crumbs)).toEqual(['Home', 'Section', 'Maker grid', part.label]);
    expect(crumbs[2].component).toBe('custom');
    expect(crumbs[2].full).toMatch(/made in this project/);
    expect(crumbs[2].ref).toEqual({ owner: t.owner, instancePath: [], nodeId: card });
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
    expect(atRoot.map((c) => c.ref?.nodeId ?? null)).toEqual([null, root]);
    expect(atRoot[0].label).toBe('Maker grid');
    // The root is a destination of its own: the text directly inside it can reach it.
    const inner = breadcrumb(made.state, { owner, instancePath: [], nodeId: text });
    expect(inner.map((c) => c.ref?.nodeId ?? null)).toEqual([null, root, text]);
  });

  it('keeps the repeated item for the parts inside it, and drops it above the repeat', () => {
    const t = nested();
    t.run([{ type: 'node.insert', owner: t.owner, parentId: null, index: 0, componentId: 'features.grid' }]);
    const fg = t.s.pages[t.pageId].rootIds[0];
    const crumbs = breadcrumb(t.s, { owner: t.owner, instancePath: [fg], nodeId: 'card-title', partId: 'cardTitle', itemPath: ['i1'] });
    expect(labels(crumbs)).toEqual(['Home', 'Services grid', 'Card grid', 'Card', 'Card title']);
    expect(crumbs.map((c) => c.ref?.itemPath ?? null)).toEqual([null, null, null, ['i1'], ['i1']]);
    expect(crumbs[2].ref).toMatchObject({ instancePath: [fg], nodeId: 'grid', partId: 'grid' });
  });
});

describe('layer names', () => {
  it('tell unnamed text apart by its words, in full for assistive tech', () => {
    const t = nested();
    const l = layerLabel(t.s, t.node(t.para));
    expect(l.label).toBe('Text · Meet the makers. Download the exhibitor…');
    expect(l.full).toBe('Text: Meet the makers. Download the exhibitor guide.');
  });

  it('say when a paragraph is empty', () => {
    const t = nested();
    t.run([{ type: 'node.setContent', owner: t.owner, nodeId: t.para, field: 'text', value: '' }]);
    const l = layerLabel(t.s, t.node(t.para));
    expect(l.empty).toBe(true);
    expect(l.label).toBe('Text · empty');
    expect(l.full).toBe('Text, empty');
  });

  it('keep a name the author gave after the copy changes', () => {
    const t = nested();
    t.run([{ type: 'node.rename', owner: t.owner, nodeId: t.para, name: 'Makers intro' }]);
    t.run([{ type: 'node.setContent', owner: t.owner, nodeId: t.para, field: 'text', value: 'Something else entirely.' }]);
    expect(layerLabel(t.s, t.node(t.para))).toMatchObject({ label: 'Makers intro', full: 'Makers intro' });
  });

  it('cut long text at a word', () => {
    expect(clip('Meet the makers. Download the exhibitor guide.', 20)).toBe('Meet the makers…');
    expect(clip('short', 20)).toBe('short');
  });
});

describe('visibility at the previewed size', () => {
  type Scope = 'base' | 'phone' | 'tablet' | 'desktop';
  const hide = (t: ReturnType<typeof nested>, nodeId: string, scope: Scope, value: boolean | null = true, partId?: string) =>
    t.run([{ type: 'node.setStyle', owner: t.owner, nodeId, ...(partId ? { partId } : {}), scope, property: 'hidden', value }]);
  const apply = (t: ReturnType<typeof nested>, nodeId: string, edits: VisibilityEdit[]) => edits.forEach((e) => hide(t, nodeId, e.scope, e.value, e.partId));
  const row = (t: ReturnType<typeof nested>, nodeId: string, size: Size, partId?: string) => rowVisibility(t.s, t.s.pages[t.pageId], t.node(nodeId), size, partId);

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
    expect(ownVisibility(t.s, t.node(t.para)).hiddenAt).toEqual(['tablet', 'desktop']);
    expect(row(t, t.para, 'phone')).toMatchObject({ hiddenHere: false, note: 'hidden on tablet and desktop' });
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
    expect(ownVisibility(t.s, t.node(t.para)).hiddenAt).toEqual(['phone', 'tablet']);
  });

  it('hides a layer on one size only, undoing a size’s own exception first', () => {
    const t = nested();
    apply(t, t.para, hideHereEdits(t.s, t.node(t.para), 'phone'));
    expect(ownVisibility(t.s, t.node(t.para)).hiddenAt).toEqual(['phone']);
    expect(hideHereEdits(t.s, t.node(t.para), 'phone')).toEqual([]);
    hide(t, t.para, 'phone', null);
    hide(t, t.para, 'base');
    hide(t, t.para, 'phone', false);
    expect(hideHereEdits(t.s, t.node(t.para), 'phone')).toEqual([{ scope: 'phone', value: null }]);
  });

  it('hides and shows at every size, as the eye always has', () => {
    const t = nested();
    apply(t, t.para, everySizeEdits(t.s, t.node(t.para), true));
    expect(ownVisibility(t.s, t.node(t.para)).hiddenAt).toEqual(['phone', 'tablet', 'desktop']);
    apply(t, t.para, everySizeEdits(t.s, t.node(t.para), false));
    expect(t.node(t.para).styles?.base?.hidden).toBeUndefined();
    // A size with its own hide keeps it.
    hide(t, t.para, 'phone');
    apply(t, t.para, everySizeEdits(t.s, t.node(t.para), true));
    apply(t, t.para, everySizeEdits(t.s, t.node(t.para), false));
    expect(ownVisibility(t.s, t.node(t.para)).hiddenAt).toEqual(['phone']);
  });

  it('explains a hide inherited from a container, only at the size it applies to', () => {
    const t = nested();
    hide(t, t.grid, 'phone');
    const onPhone = row(t, t.para, 'phone');
    expect(onPhone.hiddenHere).toBe(false);
    expect(onPhone.hiddenBy).toEqual({ id: t.grid, name: 'Grid', sizes: ['phone'] });
    expect(onPhone.note).toBe('hidden on phone because Grid is hidden on phone');
    expect(row(t, t.para, 'desktop')).toMatchObject({ hiddenHere: false, hiddenBy: null, note: '' });
  });

  it('finds a section’s Container part hiding what is placed in its slot, even over a child’s own "show"', () => {
    const t = nested();
    hide(t, t.section, 'phone', true, 'container');
    hide(t, t.para, 'phone', false);
    const onPhone = row(t, t.para, 'phone');
    expect(onPhone.hiddenBy).toEqual({ id: t.section, part: { id: 'container', nodeId: 'inner' }, name: 'Section › Container', sizes: ['phone'] });
    expect(row(t, t.grid, 'phone').hiddenBy?.part?.id).toBe('container');
    expect(row(t, t.para, 'desktop').hiddenBy).toBeNull();
    // The section itself still shows on phone: only what its Container holds is hidden.
    expect(ownVisibility(t.s, t.node(t.section)).hiddenAt).toEqual([]);
  });

  it('reads a placed component’s hide from its root override, and edits that override', () => {
    const t = nested();
    hide(t, t.section, 'tablet', true, 'root');
    expect(ownVisibility(t.s, t.node(t.section)).hiddenAt).toEqual(['tablet']);
    expect(showHereEdits(t.s, t.node(t.section), 'tablet')).toEqual([{ partId: 'root', scope: 'tablet', value: null }]);
    expect(row(t, t.grid, 'tablet').hiddenBy?.id).toBe(t.section);
  });

  it('counts the option a placement chose: one can show a part its design hides on phone', () => {
    const t = nested();
    t.run([{ type: 'node.insert', owner: t.owner, parentId: null, index: 0, componentId: 'features.grid' }]);
    const fg = t.s.pages[t.pageId].rootIds[0];
    const def = t.s.components[(t.node(fg) as InstanceNode).definitionId];
    def.tree!.nodes.grid.styles = { ...def.tree!.nodes.grid.styles, phone: { hidden: true } };
    def.variantAxes!.layout.options['two-columns'].styles = { grid: { base: { hidden: false } } };
    expect(ownVisibility(t.s, t.node(fg), 'grid').hiddenAt).toEqual(['phone']);
    (t.node(fg) as InstanceNode).variants = { layout: 'two-columns' };
    expect(ownVisibility(t.s, t.node(fg), 'grid').hiddenAt).toEqual([]);
  });
});

describe('the eye in Layers', () => {
  const t0 = () => nested();
  const set = (t: ReturnType<typeof nested>, scope: 'base' | Size, value: boolean | null) => t.run([{ type: 'node.setStyle', owner: t.owner, nodeId: t.para, scope, property: 'hidden', value }]);
  const click = (t: ReturnType<typeof nested>, size: Size) => eyeAction(t.s, t.node(t.para), size).edits.forEach((e) => set(t, e.scope, e.value));
  const hiddenAt = (t: ReturnType<typeof nested>) => ownVisibility(t.s, t.node(t.para)).hiddenAt;

  it('is pressed for a phone-only hide in the phone preview, and shows it again on phone alone', () => {
    const t = t0();
    set(t, 'phone', true);
    expect(eyeAction(t.s, t.node(t.para), 'phone')).toMatchObject({ pressed: true, action: 'Show on phone' });
    expect(eyeAction(t.s, t.node(t.para), 'desktop')).toMatchObject({ pressed: false, action: 'Hide at every size' });
    click(t, 'phone');
    expect(hiddenAt(t)).toEqual([]);
  });

  it('still hides at every size from the default preview, and shows it everywhere again', () => {
    const t = t0();
    click(t, 'desktop');
    expect(hiddenAt(t)).toEqual(['phone', 'tablet', 'desktop']);
    expect(eyeAction(t.s, t.node(t.para), 'phone')).toMatchObject({ pressed: true, action: 'Show at every size' });
    click(t, 'phone');
    expect(hiddenAt(t)).toEqual([]);
  });

  it('shows it on this size alone when this size has its own hide, whatever every size says', () => {
    const t = t0();
    set(t, 'phone', true);
    set(t, 'base', true);
    expect(eyeAction(t.s, t.node(t.para), 'phone')).toMatchObject({ pressed: true, action: 'Show on phone' });
    click(t, 'phone');
    expect(hiddenAt(t)).toEqual(['tablet', 'desktop']);
  });

  it('shows a placement its design hides on this size when every size is shown again', () => {
    const t = t0();
    const def = t.s.components[(t.node(t.section) as InstanceNode).definitionId];
    const root = def.tree!.rootIds[0];
    def.tree!.nodes[root].styles = { ...def.tree!.nodes[root].styles, phone: { hidden: true } };
    t.run([{ type: 'node.setStyle', owner: t.owner, nodeId: t.section, partId: 'root', scope: 'base', property: 'hidden', value: true }]);
    const eye = eyeAction(t.s, t.node(t.section), 'phone');
    expect(eye).toMatchObject({ pressed: true, action: 'Show at every size' });
    expect(eye.edits).toEqual([{ partId: 'root', scope: 'base', value: null }, { partId: 'root', scope: 'phone', value: false }]);
  });

  it('hides it here when it showed here only as an exception', () => {
    const t = t0();
    set(t, 'base', true);
    set(t, 'phone', false);
    expect(eyeAction(t.s, t.node(t.para), 'phone')).toMatchObject({ pressed: false, action: 'Hide on phone' });
    click(t, 'phone');
    expect(hiddenAt(t)).toEqual(['phone', 'tablet', 'desktop']);
  });
});
