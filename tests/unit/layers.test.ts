import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, Op, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { breadcrumb } from '../../src/renderer/src/lib/model';
import { clip, layerLabel, ownVisibility, rowVisibility, showHereOp } from '../../src/renderer/src/lib/layers';

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

  it('starts at the component while it is edited everywhere, without repeating its root', () => {
    const t = nested();
    const made = applyOperations(t.s, [{ type: 'component.createFromNode', owner: t.owner, nodeId: t.grid, name: 'Maker grid' }]);
    const defId = made.results[0].definitionId as string;
    const tree = made.state.components[defId].tree!;
    const root = tree.rootIds[0];
    const text = Object.values(tree.nodes).find((n) => n.kind === 'text')!.id;
    const owner = { kind: 'component' as const, id: defId };
    expect(labels(breadcrumb(made.state, { owner, instancePath: [], nodeId: root }))).toEqual(['Maker grid']);
    const inner = breadcrumb(made.state, { owner, instancePath: [], nodeId: text });
    expect(inner[0].label).toBe('Maker grid');
    expect(inner.at(-1)!.ref?.nodeId).toBe(text);
    expect(inner.map((c) => c.ref?.nodeId)).not.toContain(root);
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
  const hide = (t: ReturnType<typeof nested>, nodeId: string, scope: 'base' | 'phone' | 'tablet' | 'desktop', value: boolean | null = true) =>
    t.run([{ type: 'node.setStyle', owner: t.owner, nodeId, scope, property: 'hidden', value }]);

  it('tells "hidden on phone" apart from a hide at every size', () => {
    const t = nested();
    hide(t, t.para, 'phone');
    const tree = t.s.pages[t.pageId];
    const onPhone = rowVisibility(t.s, tree, t.node(t.para), 'phone');
    expect(onPhone.hiddenHere).toBe(true);
    expect(onPhone.own).toMatchObject({ hiddenAt: ['phone'], everywhere: false });
    expect(onPhone.note).toBe('hidden on phone');
    const onDesktop = rowVisibility(t.s, tree, t.node(t.para), 'desktop');
    expect(onDesktop.hiddenHere).toBe(false);
    // Still said, so the row explains what the phone preview will show.
    expect(onDesktop.note).toBe('hidden on phone');

    hide(t, t.para, 'phone', null);
    hide(t, t.para, 'base');
    const everywhere = rowVisibility(t.s, t.s.pages[t.pageId], t.node(t.para), 'desktop');
    expect(everywhere.own).toMatchObject({ hiddenAt: ['phone', 'tablet', 'desktop'], everywhere: true });
    expect(everywhere.note).toBe('hidden at every size');
  });

  it('lets a size show what every size hides', () => {
    const t = nested();
    hide(t, t.para, 'base');
    hide(t, t.para, 'phone', false);
    const v = ownVisibility(t.node(t.para));
    expect(v.hiddenAt).toEqual(['tablet', 'desktop']);
    expect(rowVisibility(t.s, t.s.pages[t.pageId], t.node(t.para), 'phone').hiddenHere).toBe(false);
  });

  it('shows a layer again on one size only, leaving the other sizes as they were', () => {
    const t = nested();
    hide(t, t.para, 'phone');
    // Hidden on phone alone: the phone setting is taken away.
    expect(showHereOp(t.node(t.para), 'phone')).toEqual({ scope: 'phone', value: null });
    expect(showHereOp(t.node(t.para), 'desktop')).toBeNull();
    // Hidden at every size: phone shows it, the other sizes keep hiding it.
    hide(t, t.para, 'base');
    expect(showHereOp(t.node(t.para), 'phone')).toEqual({ scope: 'phone', value: false });
    expect(showHereOp(t.node(t.para), 'desktop')).toEqual({ scope: 'desktop', value: false });
    const op = showHereOp(t.node(t.para), 'desktop')!;
    t.run([{ type: 'node.setStyle', owner: t.owner, nodeId: t.para, scope: op.scope, property: 'hidden', value: op.value }]);
    expect(ownVisibility(t.node(t.para)).hiddenAt).toEqual(['phone', 'tablet']);
  });

  it('explains a hide inherited from a container, only at the size it applies to', () => {
    const t = nested();
    hide(t, t.grid, 'phone');
    const tree = t.s.pages[t.pageId];
    const onPhone = rowVisibility(t.s, tree, t.node(t.para), 'phone');
    expect(onPhone.hiddenHere).toBe(true);
    expect(onPhone.hiddenBy).toMatchObject({ id: t.grid, name: 'Grid', sizes: ['phone'] });
    expect(onPhone.note).toBe('hidden on phone because Grid is hidden on phone');
    expect(rowVisibility(t.s, tree, t.node(t.para), 'desktop')).toMatchObject({ hiddenHere: false, hiddenBy: null, note: '' });
  });

  it('reads a placed component’s hide from its root override', () => {
    const t = nested();
    t.run([{ type: 'node.setStyle', owner: t.owner, nodeId: t.section, partId: 'root', scope: 'tablet', property: 'hidden', value: true }]);
    expect(ownVisibility(t.node(t.section)).hiddenAt).toEqual(['tablet']);
    expect(showHereOp(t.node(t.section), 'tablet')).toEqual({ partId: 'root', scope: 'tablet', value: null });
    const child = rowVisibility(t.s, t.s.pages[t.pageId], t.node(t.grid), 'tablet');
    expect(child.hiddenBy?.id).toBe(t.section);
  });
});
