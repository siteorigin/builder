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
  previewMedia,
  spaceScale,
  spaceSignature,
  spaceTokens,
  spacingOp,
  spacingTarget,
  storedSpacing,
  type SpaceStop,
  type SpacingHandle,
  type SpacingTarget
} from '../../src/renderer/src/lib/spacing-drag';
import { chosenReach, itemReachKey, reachByItem, showReach } from '../../src/renderer/src/lib/item-reach';
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

  it('treats a missing or broken zoom as 1, and broken travel as none', () => {
    expect(draggedSize(10, 10, 0, 1)).toBe(20);
    expect(draggedSize(10, 10, -2, 1)).toBe(20);
    expect(draggedSize(10, 10, Number.NaN, 1)).toBe(20);
    expect(draggedSize(Number.NaN, 10, 1, 1)).toBe(10);
    expect(draggedSize(10, Number.NaN, 1, 1)).toBe(10);
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
    // Larger first: an even split still goes to the smaller.
    expect(dragValue(20, [SCALE[4], SCALE[3]], false).value).toEqual({ token: 'space.md' });
    const custom = [{ token: 'space.roomy', label: 'Roomy', px: 40 }];
    expect(dragValue(35, custom, false).value).toEqual({ token: 'space.roomy' });
  });

  it('keeps stops at least half a pixel apart, measured from the last one kept', () => {
    const close = [8, 8.25, 8.49, 8.5].map((px) => ({ token: `space.s${px}`, label: String(px), px }));
    expect(spaceScale(close).map((s) => s.px)).toEqual([8, 8.5]);
    expect(spaceScale([{ token: 'space.inf', label: 'Inf', px: Infinity }, SCALE[0]]).map((s) => s.token)).toEqual(['space.2xs']);
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
    expect(dragValue(-12.6, SCALE, true, true)).toEqual({ value: '-13px', px: -13 });
    expect(dragValue(-0.4, SCALE, true, true)).toEqual({ value: '0', px: 0 });
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
  it('write padding on four sides and margin above and below, growing away from the content', () => {
    expect(SPACING_HANDLES.map((h) => [h.box, h.side, h.edge, h.pair, h.axis, h.grow])).toEqual([
      ['padding', 'top', 'paddingBlockStart', 'paddingBlock', 'y', 1],
      ['padding', 'bottom', 'paddingBlockEnd', 'paddingBlock', 'y', -1],
      ['padding', 'left', 'paddingInlineStart', 'paddingInline', 'x', 1],
      ['padding', 'right', 'paddingInlineEnd', 'paddingInline', 'x', -1],
      ['margin', 'top', 'marginBlockStart', null, 'y', -1],
      ['margin', 'bottom', 'marginBlockEnd', null, 'y', 1]
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

  it('writes a part shown once to its placement alone, and a card picked from Layers to every card', () => {
    const s = fresh();
    const g = placed(s, 'features.grid');
    expect(spacingTarget(s, part(s, 'hero.split', 'container'))).toMatchObject({ nodeId: placed(s, 'hero.split').id, partId: 'container', everyItem: false });
    const fromLayers = spacingTarget(s, part(s, 'features.grid', 'card'))!;
    expect(fromLayers).toMatchObject({ nodeId: g.id, partId: 'card', everyItem: true });
    expect(fromLayers.itemId).toBeUndefined();
  });

  it('shows an article card\u2019s change on every article of a news list, which it styles all at once', () => {
    let s = fresh();
    s = apply(s, [{ type: 'node.insert', owner: owner(s), componentId: 'content.news' }]);
    const t = spacingTarget(s, part(s, 'content.news', 'card', 'pg_article'))!;
    expect(t).toMatchObject({ partId: 'card', everyItem: true });
    expect(t.itemId).toBeUndefined();
  });

  it('follows the reach the inspector shows for a card over the one last chosen', () => {
    const s = fresh();
    const g = placed(s, 'features.grid');
    const first = (g.props.items as ListItem[])[0].id;
    const key = itemReachKey(owner(s), g.id, first);
    expect(key).toBe(JSON.stringify(['page', homeId(s), g.id, first]));
    reachByItem.set(key, 'all');
    const hide = showReach(key, 'item');
    expect(chosenReach(key)).toBe('item');
    expect(spacingTarget(s, part(s, 'features.grid', 'card', first), chosenReach)).toMatchObject({ itemId: first });
    hide();
    expect(chosenReach(key)).toBe('all');
    // Taking back an older registration leaves a newer one in place.
    const older = showReach(key, 'item');
    const newer = showReach(key, 'all');
    older();
    expect(chosenReach(key)).toBe('all');
    newer();
    reachByItem.delete(key);
    expect(chosenReach(key)).toBeUndefined();
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

  it('marks a measured scale stale when a spacing style\u2019s value changes, and only then', () => {
    const s = fresh();
    const sig = spaceSignature(s);
    expect(spaceSignature({ ...s, tokens: { ...s.tokens, overrides: { ...s.tokens.overrides, 'space.lg': '64px' } } })).not.toBe(sig);
    expect(spaceSignature({ ...s, tokens: { ...s.tokens, overrides: { ...s.tokens.overrides, 'color.brand': '#123456' } } })).toBe(sig);
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

  it('shows no handle for a side the size shown sets on its own, and keeps the other side\u2019s', () => {
    const t = element(EDGES, { phone: { paddingBlockStart: '16px' } });
    expect(plan('padding', 'top', t, 'base', 'phone')).toBeNull();
    expect(plan('padding', 'bottom', t, 'base', 'phone')).toMatchObject({ property: 'paddingBlockEnd' });
  });

  it('shows no handle where Custom CSS sets the side, since it is written after the named styles', () => {
    expect(plan('padding', 'top', element(EDGES, { base: { customCss: 'padding-block-start: 60px' } }))).toBeNull();
    expect(plan('padding', 'top', element(EDGES, { base: { customCss: 'opacity: 0.9; padding-block-start: 60px' } }))).toBeNull();
    expect(plan('padding', 'top', element(EDGES, { base: { customCss: 'padding: 60px' } }))).toBeNull();
    expect(plan('padding', 'top', element(EDGES, { base: { customCss: 'padding-block: 60px' } }))).toBeNull();
    expect(plan('padding', 'top', element(EDGES, { phone: { customCss: 'padding-block-start: 60px' } }), 'base', 'phone')).toBeNull();
    expect(plan('padding', 'bottom', element(EDGES, { base: { customCss: 'padding-block-start: 60px' } }))).toMatchObject({ property: 'paddingBlockEnd' });
    expect(plan('margin', 'top', element(EDGES, { base: { customCss: 'padding-block-start: 60px' } }))).toMatchObject({ property: 'marginBlockStart' });
    expect(plan('margin', 'top', element(EDGES, { base: { customCss: 'margin-block-start: 0' } }))).toBeNull();
    expect(plan('padding', 'left', element(EDGES, { base: { customCss: 'padding-inline-end: 4px' } }), 'base', 'desktop', true)).toBeNull();
    // Custom CSS never writes physical names, so one there leaves the handle.
    expect(plan('padding', 'top', element(EDGES, { base: { customCss: 'padding-top: 60px' } }))).toMatchObject({ property: 'paddingBlockStart' });
  });

  it('leaves a change to every card to the inspector when some card keeps a moving side of its own', () => {
    const shared = (items: SpacingTarget['items']) => ({ ...element(['paddingBlock']), everyItem: true, items });
    expect(plan('padding', 'top', shared({ a: { phone: { paddingBlock: '48px' } } }), 'phone', 'phone')).toBeNull();
    expect(plan('padding', 'top', shared({ a: { base: { paddingBlock: '48px' } } }), 'phone', 'phone')).toBeNull();
    // Its own bottom is moved by the pair too.
    expect(plan('padding', 'top', shared({ a: { base: { paddingBlockEnd: '2px' } } }))).toBeNull();
    expect(plan('padding', 'top', shared({ a: { base: { customCss: 'padding-block-end: 2px' } } }))).toBeNull();
    expect(plan('padding', 'top', shared({ a: { base: { background: '#fff' } }, b: { base: { paddingBlockStart: '2px' } } }))).toBeNull();
    // Nothing of its own on these sides at the size shown, or nothing to do with spacing: the handle stays.
    expect(plan('padding', 'top', shared({ a: { tablet: { paddingBlock: '9px' } } }), 'base', 'phone')).toMatchObject({ property: 'paddingBlock', sides: ['top', 'bottom'] });
    expect(plan('padding', 'top', shared({ a: { base: { background: '#fff' } } }))).toMatchObject({ property: 'paddingBlock' });
    expect(plan('margin', 'top', { ...element(EDGES), everyItem: true, items: { a: { base: { paddingBlock: '4px' } } } })).toMatchObject({ property: 'marginBlockStart' });
    // A card styled on its own writes its own styles: other cards' values don't matter.
    expect(plan('padding', 'top', { ...shared({ a: { base: { paddingBlock: '48px' } } }), everyItem: false })).toMatchObject({ property: 'paddingBlock' });
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
    // Where a line starts: the left on a left-to-right page, the right on a right-to-left one.
    const ltrLeft = planHandle(handle('padding', 'left'), element(EDGES), 'base', 'desktop', false)!;
    const rtlRight = planHandle(handle('padding', 'right'), element(EDGES), 'base', 'desktop', true)!;
    expect(previewDecls(ltrLeft, '8px', false)).toEqual([['padding-inline-start', '8px']]);
    expect(previewDecls(rtlRight, '8px', true)).toEqual([['padding-inline-start', '8px']]);
    const ltrRight = planHandle(handle('padding', 'right'), element(EDGES), 'base', 'desktop', false)!;
    expect(previewDecls(ltrRight, '8px', false)).toEqual([['padding-inline-end', '8px']]);
    const below = planHandle(handle('margin', 'bottom'), element(EDGES), 'base', 'desktop', false)!;
    expect(previewDecls(below, { token: 'space.xl' }, false)).toEqual([['margin-block-end', 'var(--so-space-xl)']]);
  });

  it('applies only at the size being edited', () => {
    expect(previewMedia('base')).toBeNull();
    expect(previewMedia('phone')).toBe('(max-width: 767.98px)');
    expect(previewMedia('tablet')).toBe('(min-width: 768px) and (max-width: 1023.98px)');
    expect(previewMedia('desktop')).toBe('(min-width: 1024px)');
  });
});

describe('the frame\u2019s spacing report', () => {
  const sides = { top: 1, right: 2, bottom: 3, left: 4 };
  const desc = { ctx: 'page:p', node: 'n', items: '' };
  it('reads padding, border and margin with what it measured, and drops anything malformed', () => {
    expect(spacingOf({ padding: sides, border: sides, margin: { ...sides, top: -8 }, rtl: true, ...desc })).toEqual({ padding: sides, border: sides, margin: { ...sides, top: -8 }, rtl: true, desc });
    expect(spacingOf({ padding: sides, border: sides, margin: sides, ...desc })?.rtl).toBe(false);
    expect(spacingOf({ padding: { ...sides, top: 0 }, border: sides, margin: sides, ...desc })?.padding.top).toBe(0);
    expect(spacingOf({ padding: { ...sides, top: -1 }, border: sides, margin: sides, ...desc })).toBeNull();
    expect(spacingOf({ padding: sides, border: { ...sides, left: -1 }, margin: sides, ...desc })).toBeNull();
    expect(spacingOf({ padding: { ...sides, top: Infinity }, border: sides, margin: sides, ...desc })).toBeNull();
    expect(spacingOf({ padding: { ...sides, top: 100000 }, border: sides, margin: sides, ...desc })).toBeNull();
    expect(spacingOf({ padding: sides, border: sides, margin: { ...sides, left: 'x' }, ...desc })).toBeNull();
    expect(spacingOf({ padding: sides, border: sides, margin: sides, ctx: 'page:p', node: 'n' })).toBeNull();
    expect(spacingOf({ padding: sides, border: sides, margin: sides, node: 'n', items: '' })).toBeNull();
    expect(spacingOf(null)).toBeNull();
  });

  it('reads the measured scale in request order', () => {
    expect(spaceSizes([4, null, 'x', -1, 24], 5)).toEqual([4, null, null, null, 24]);
    expect(spaceSizes([4], 2)).toBeNull();
  });
});
