import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, ListItem, ProjectState, ResponsiveScope, StyleValue } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateOperation } from '@shared/ops';
import {
  SPACING_HANDLES,
  dragLabel,
  dragValue,
  draggedSize,
  onScreen,
  planHandle,
  previewDecls,
  spaceScale,
  spaceTokens,
  spacingOp,
  spacingTarget,
  storedSpacing,
  type SpaceStop,
  type SpacingHandle,
  type SpacingTarget
} from '../../src/renderer/src/lib/spacing-drag';
import { itemReachKey } from '../../src/renderer/src/lib/item-reach';
import { spacingOf, spaceSizes } from '../../src/renderer/src/lib/payload';

// The foundation theme's spacing scale, as the page measures it at a desktop width.
const SCALE: SpaceStop[] = [
  { token: 'space.2xs', label: '2XS', px: 4 },
  { token: 'space.xs', label: 'XS', px: 8 },
  { token: 'space.sm', label: 'Small', px: 12 },
  { token: 'space.md', label: 'Medium', px: 16 },
  { token: 'space.lg', label: 'Large', px: 24 },
  { token: 'space.xl', label: 'XL', px: 32 },
  { token: 'space.2xl', label: '2XL', px: 48 },
  { token: 'space.3xl', label: '3XL', px: 72 },
  { token: 'space.section', label: 'Section', px: 120 }
];

describe('draggedSize: pointer travel at the canvas zoom', () => {
  it('takes screen pixels back through the zoom', () => {
    expect(draggedSize(24, 20, 1, 1)).toBe(44);
    expect(draggedSize(24, 20, 0.5, 1)).toBe(64);
    expect(draggedSize(24, 20, 2, 1)).toBe(34);
  });

  it('grows the way the handle faces and shrinks the other way', () => {
    const bottom = SPACING_HANDLES.find((h) => h.box === 'padding' && h.side === 'bottom')!;
    expect(draggedSize(48, -30, 1, bottom.grow)).toBe(78);
    expect(draggedSize(48, 30, 1, bottom.grow)).toBe(18);
  });

  it('never goes below zero', () => {
    expect(draggedSize(16, -200, 1, 1)).toBe(0);
  });

  it('treats a missing or broken zoom as 1', () => {
    expect(draggedSize(10, 10, 0, 1)).toBe(20);
    expect(draggedSize(10, 10, Number.NaN, 1)).toBe(20);
    expect(draggedSize(Number.NaN, 10, 1, 1)).toBe(10);
  });

  it('turns the same drag into the same page distance at a fractional fit zoom, either way', () => {
    const top = SPACING_HANDLES[0];
    expect(draggedSize(24, 30, 0.75, top.grow)).toBeCloseTo(64);
    expect(draggedSize(24, -15, 0.75, top.grow)).toBeCloseTo(4);
    expect(draggedSize(24, onScreen(40, 0.75), 0.75, top.grow)).toBeCloseTo(64);
  });

  it('lets a margin go below zero, never padding', () => {
    expect(draggedSize(-12, -10, 1, 1, true)).toBe(-22);
    expect(draggedSize(-12, -10, 1, 1)).toBe(0);
  });

  it('draws frame pixels at the zoom', () => {
    expect(onScreen(24, 0.5)).toBe(12);
    expect(onScreen(24, 1.25)).toBe(30);
    expect(onScreen(24, 0)).toBe(24);
  });
});

describe('dragValue: snapping to the spacing scale', () => {
  it('snaps to the nearest spacing site style', () => {
    expect(dragValue(25, SCALE, false)).toEqual({ value: { token: 'space.lg' }, px: 24, stop: SCALE[4] });
    expect(dragValue(60, SCALE, false).value).toEqual({ token: 'space.2xl' });
    expect(dragValue(61, SCALE, false).value).toEqual({ token: 'space.3xl' });
    expect(dragValue(500, SCALE, false).value).toEqual({ token: 'space.section' });
  });

  it('takes the smaller style on an even split', () => {
    expect(dragValue(20, SCALE, false).value).toEqual({ token: 'space.md' });
    expect(dragValue(96, SCALE, false).value).toEqual({ token: 'space.3xl' });
  });

  it('writes no space when zero is nearer than the smallest style', () => {
    expect(dragValue(1.9, SCALE, false)).toEqual({ value: '0', px: 0 });
    expect(dragValue(2, SCALE, false)).toEqual({ value: '0', px: 0 });
    expect(dragValue(2.1, SCALE, false).value).toEqual({ token: 'space.2xs' });
  });

  it('works from the sizes the page measured, in any order, whatever the styles are called', () => {
    const shuffled = [SCALE[8], SCALE[0], SCALE[5], SCALE[3]];
    expect(dragValue(30, shuffled, false).value).toEqual({ token: 'space.xl' });
    const custom = [{ token: 'space.roomy', label: 'Roomy', px: 40 }];
    expect(dragValue(35, custom, false).value).toEqual({ token: 'space.roomy' });
  });

  it('keeps the first of two styles the same size', () => {
    const alias = [...SCALE, { token: 'space.gutter', label: 'Gutter', px: 24 }];
    expect(dragValue(24, alias, false).value).toEqual({ token: 'space.lg' });
    expect(spaceScale(alias).map((s) => s.token)).not.toContain('space.gutter');
  });

  it('ignores a style the page could not measure', () => {
    const broken = [{ token: 'space.bad', label: 'Bad', px: Number.NaN }, { token: 'space.none', label: 'None', px: 0 }, SCALE[4]];
    expect(spaceScale(broken).map((s) => s.token)).toEqual(['space.lg']);
    expect(dragValue(3, broken, false)).toEqual({ value: '0', px: 0 });
    expect(dragValue(20, broken, false).value).toEqual({ token: 'space.lg' });
  });

  it('writes whole pixels for an exact margin below zero, and snaps one to zero at most', () => {
    expect(dragValue(-12.4, SCALE, true, true)).toEqual({ value: '-12px', px: -12 });
    expect(dragValue(-12.4, SCALE, false, true)).toEqual({ value: '0', px: 0 });
    expect(dragValue(-12.4, SCALE, true)).toEqual({ value: '0', px: 0 });
  });

  it('falls back to whole pixels when no style could be measured', () => {
    const none = [{ token: 'space.bad', label: 'Bad', px: Number.NaN }];
    expect(dragValue(30.2, none, false)).toEqual({ value: '30px', px: 30 });
  });

  it('writes whole pixels when dragged exactly, or with no styles to snap to', () => {
    expect(dragValue(37.4, SCALE, true)).toEqual({ value: '37px', px: 37 });
    expect(dragValue(37.6, [], false)).toEqual({ value: '38px', px: 38 });
    expect(dragValue(0.3, SCALE, true)).toEqual({ value: '0', px: 0 });
  });

  it('labels the HUD with the style and its size, or the size alone', () => {
    expect(dragLabel(dragValue(25, SCALE, false))).toBe('Large · 24px');
    expect(dragLabel(dragValue(37.4, SCALE, true))).toBe('37px');
    expect(dragLabel(dragValue(1, SCALE, false))).toBe('0px');
    expect(dragLabel(dragValue(100, [{ token: 'space.section', label: 'Section', px: 101.25 }], false))).toBe('Section · 101.3px');
  });
});

describe('the handles', () => {
  it('write padding on four sides and margin above and below', () => {
    expect(SPACING_HANDLES.map((h) => `${h.box}:${h.side}:${h.edge}`)).toEqual([
      'padding:top:paddingBlockStart',
      'padding:bottom:paddingBlockEnd',
      'padding:left:paddingInlineStart',
      'padding:right:paddingInlineEnd',
      'margin:top:marginBlockStart',
      'margin:bottom:marginBlockEnd'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Where a drag writes
// ---------------------------------------------------------------------------

const fresh = () => createStarterState('business', 'Test Studio', true);
const homeId = (s: ProjectState) => s.site.homePageId;
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: homeId(s) });
const placed = (s: ProjectState, componentId: string) => {
  const p = s.pages[homeId(s)];
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
};
const section = (s: ProjectState, componentId: string): ElementRef => ({ owner: owner(s), instancePath: [], nodeId: placed(s, componentId).id });
const part = (s: ProjectState, componentId: string, partId: string, itemId?: string): ElementRef => {
  const n = placed(s, componentId);
  return { owner: owner(s), instancePath: [n.id], nodeId: s.components[n.definitionId].parts[partId].nodeId, partId, ...(itemId ? { itemPath: [itemId] } : {}) };
};
const handle = (box: SpacingHandle['box'], side: SpacingHandle['side']) => SPACING_HANDLES.find((h) => h.box === box && h.side === side)!;
const apply = (s: ProjectState, ops: Parameters<typeof applyOperations>[1]) => applyOperations(s, ops).state;
const element = (offered: string[], styles: SpacingTarget['styles'] = {}): SpacingTarget => ({ owner: { kind: 'page', id: 'p' }, nodeId: 'n', styles, offered, everyItem: false });
const EDGES = ['paddingBlockStart', 'paddingBlockEnd', 'paddingInlineStart', 'paddingInlineEnd', 'marginBlockStart', 'marginBlockEnd', 'paddingBlock', 'paddingInline'];

describe('spacingTarget: the styles a drag writes', () => {
  it('writes a section to its own styles, as the inspector does', () => {
    const s = fresh();
    const t = spacingTarget(s, section(s, 'hero.split'))!;
    expect(t).toMatchObject({ owner: owner(s), nodeId: placed(s, 'hero.split').id, partId: 'root', everyItem: false });
    expect(t.offered).toContain('paddingBlock');
  });

  it('writes a section picked by its design\u2019s root element to the section', () => {
    const s = fresh();
    const n = placed(s, 'hero.split');
    const root = s.components[n.definitionId].tree!.rootIds[0];
    expect(spacingTarget(s, { owner: owner(s), instancePath: [n.id], nodeId: root, partId: 'root' })).toMatchObject({ nodeId: n.id, partId: 'root' });
  });

  it('writes a part to the placement\u2019s styles for it, and every card of a list by default', () => {
    const s = fresh();
    const g = placed(s, 'features.grid');
    const first = (g.props.items as ListItem[])[0].id;
    expect(spacingTarget(s, part(s, 'features.grid', 'card', first))).toMatchObject({ nodeId: g.id, partId: 'card', everyItem: true });
    expect(spacingTarget(s, part(s, 'features.grid', 'card', first))?.itemId).toBeUndefined();
  });

  it('writes one card on its own once "This card" is chosen for it, or when it has styles of its own', () => {
    let s = fresh();
    const g = placed(s, 'features.grid');
    const [first, second] = (g.props.items as ListItem[]).map((i) => i.id);
    const chosen = spacingTarget(s, part(s, 'features.grid', 'card', first), (k) => (k === itemReachKey(owner(s), g.id, first) ? 'item' : undefined))!;
    expect(chosen).toMatchObject({ partId: 'card', itemId: first, everyItem: false });
    expect(spacingOp(chosen, 'base', 'paddingBlock', { token: 'space.lg' })).toEqual({ type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', itemId: first, scope: 'base', property: 'paddingBlock', value: { token: 'space.lg' } });
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', itemId: second, scope: 'base', property: 'background', value: '#dbeeff' }]);
    expect(spacingTarget(s, part(s, 'features.grid', 'card', second))).toMatchObject({ itemId: second, styles: { base: { background: '#dbeeff' } } });
    expect(spacingTarget(s, part(s, 'features.grid', 'card', second), () => 'all')).toMatchObject({ everyItem: true });
  });

  it('writes nothing for an element inside a section that is not one of its parts', () => {
    const s = fresh();
    const n = placed(s, 'hero.split');
    const def = s.components[n.definitionId];
    const named = new Set(Object.values(def.parts).map((p) => p.nodeId));
    const inner = Object.keys(def.tree!.nodes).find((id) => !named.has(id) && id !== def.tree!.rootIds[0])!;
    expect(inner).toBeDefined();
    expect(spacingTarget(s, { owner: owner(s), instancePath: [n.id], nodeId: inner })).toBeNull();
  });

  it('builds one valid node.setStyle edit for a section', () => {
    const s = fresh();
    const t = spacingTarget(s, section(s, 'hero.split'))!;
    const op = spacingOp(t, 'phone', 'paddingBlock', { token: 'space.lg' });
    expect(validateOperation(op).ok).toBe(true);
    const after = apply(s, [op]);
    expect((after.pages[homeId(s)].nodes[t.nodeId] as InstanceNode).overrides?.root?.phone).toEqual({ paddingBlock: { token: 'space.lg' } });
    expect(storedSpacing(spacingTarget(after, section(after, 'hero.split'))!, 'phone', 'paddingBlock')).toEqual({ token: 'space.lg' });
  });

  it('snaps to the theme\u2019s spacing styles, by the CSS variable the page holds each in', () => {
    const tokens = spaceTokens(fresh());
    expect(tokens.find((t) => t.token === 'space.lg')).toEqual({ token: 'space.lg', label: 'Large', cssVar: '--so-space-lg' });
    expect(tokens.every((t) => t.token.startsWith('space.'))).toBe(true);
  });
});

describe('planHandle: what each handle writes', () => {
  const plan = (box: SpacingHandle['box'], side: SpacingHandle['side'], t: SpacingTarget, scope: ResponsiveScope = 'base', shown: Exclude<ResponsiveScope, 'base'> = 'desktop', rtl = false) =>
    planHandle(handle(box, side), t, scope, shown, rtl);

  it('writes the dragged side alone when that is offered', () => {
    expect(plan('padding', 'top', element(EDGES))).toMatchObject({ property: 'paddingBlockStart', label: 'Padding top', sides: ['top'] });
    expect(plan('padding', 'right', element(EDGES))).toMatchObject({ property: 'paddingInlineEnd', sides: ['right'] });
    expect(plan('margin', 'bottom', element(EDGES))).toMatchObject({ property: 'marginBlockEnd', label: 'Space below', sides: ['bottom'] });
  });

  it('writes both sides when only the pair is offered, as the Split hero offers Vertical padding', () => {
    const s = fresh();
    const t = spacingTarget(s, section(s, 'hero.split'))!;
    expect(t.offered).not.toContain('paddingBlockStart');
    expect(plan('padding', 'top', t)).toMatchObject({ property: 'paddingBlock', label: 'Vertical padding', sides: ['top', 'bottom'] });
    expect(plan('padding', 'bottom', element(['paddingBlock']))).toMatchObject({ property: 'paddingBlock', sides: ['bottom', 'top'] });
  });

  it('shows no handle for what is not offered', () => {
    expect(plan('padding', 'left', element(['paddingBlock']))).toBeNull();
    expect(plan('margin', 'top', element(['paddingBlock']))).toBeNull();
  });

  it('shows no handle while another size is edited than the canvas shows', () => {
    expect(plan('padding', 'top', element(EDGES), 'phone', 'desktop')).toBeNull();
    expect(plan('padding', 'top', element(EDGES), 'phone', 'phone')).toMatchObject({ property: 'paddingBlockStart' });
    expect(plan('padding', 'top', element(EDGES), 'base', 'phone')).toMatchObject({ property: 'paddingBlockStart' });
  });

  it('shows no handle when a value the size shown has of its own would keep the side where it is', () => {
    const phonePadded = element(EDGES, { phone: { paddingBlock: '16px' } });
    expect(plan('padding', 'top', phonePadded, 'base', 'phone')).toBeNull();
    expect(plan('padding', 'top', phonePadded, 'base', 'desktop')).toMatchObject({ property: 'paddingBlockStart' });
    expect(plan('padding', 'top', phonePadded, 'phone', 'phone')).toMatchObject({ property: 'paddingBlockStart' });
  });

  it('moves only the side a pair reaches past a side\u2019s own value', () => {
    const t = element(['paddingBlock'], { base: { paddingBlockEnd: '8px' } });
    expect(plan('padding', 'top', t)).toMatchObject({ property: 'paddingBlock', sides: ['top'] });
    expect(plan('padding', 'bottom', t)).toBeNull();
  });

  it('writes the side where a line starts on a right-to-left page', () => {
    expect(plan('padding', 'left', element(EDGES), 'base', 'desktop', true)).toMatchObject({ property: 'paddingInlineEnd', sides: ['left'] });
    expect(plan('padding', 'right', element(EDGES), 'base', 'desktop', true)).toMatchObject({ property: 'paddingInlineStart', sides: ['right'] });
  });
});

describe('previewDecls: what the page shows while dragging', () => {
  it('gives each moving side the dragged value, as the stylesheet names it', () => {
    const top = planHandle(handle('padding', 'top'), element(['paddingBlock']), 'base', 'desktop', false)!;
    expect(previewDecls(top, { token: 'space.lg' }, false)).toEqual([
      ['padding-block-start', 'var(--so-space-lg)'],
      ['padding-block-end', 'var(--so-space-lg)']
    ]);
    const left = planHandle(handle('padding', 'left'), element(EDGES), 'base', 'desktop', true)!;
    expect(previewDecls(left, '37px', true)).toEqual([['padding-inline-end', '37px']]);
    const above = planHandle(handle('margin', 'top'), element(EDGES), 'base', 'desktop', false)!;
    expect(previewDecls(above, '-12px' as StyleValue, false)).toEqual([['margin-block-start', '-12px']]);
  });
});

describe('the frame\u2019s spacing report', () => {
  const sides = { top: 1, right: 2, bottom: 3, left: 4 };
  it('reads padding, border and margin, and drops anything malformed', () => {
    expect(spacingOf({ padding: sides, border: sides, margin: { ...sides, top: -8 }, rtl: true })).toEqual({ padding: sides, border: sides, margin: { ...sides, top: -8 }, rtl: true });
    expect(spacingOf({ padding: { ...sides, top: -1 }, border: sides, margin: sides })).toBeNull();
    expect(spacingOf({ padding: sides, border: sides, margin: { ...sides, left: 'x' } })).toBeNull();
    expect(spacingOf(null)).toBeNull();
  });

  it('reads the measured scale in request order', () => {
    expect(spaceSizes([4, null, 'x', -1, 24], 5)).toEqual([4, null, null, null, 24]);
    expect(spaceSizes([4], 2)).toBeNull();
  });
});
