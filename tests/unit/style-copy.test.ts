import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementRef, InstanceNode, ProjectState, ResponsiveScope, StyleValue } from '@shared/types';
import { MEDIA_QUERIES, placementStyleControls } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateSiteCss, overrideClass } from '@generator/index';
import { ProjectSession } from '../../src/main/project/session';
import { captureStyle, planStylePaste, styleSelection, type StyleCopy } from '../../src/renderer/src/lib/style-copy';

const fresh = () => createStarterState('business', 'Test Studio', true);
const homeId = (s: ProjectState) => s.site.homePageId;
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: homeId(s) });
/** A blank site with one empty layout section placed on Home, to hold the elements a test places. */
const blankWithSection = () => {
  const s = createStarterState('blank', 'Blank', false);
  return applyOperations(s, [{ type: 'node.insert', owner: owner(s), componentId: 'layout.section' }]).state;
};
const placed = (s: ProjectState, componentId: string) => {
  const p = s.pages[homeId(s)];
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
};
const section = (s: ProjectState, componentId: string): ElementRef => ({ owner: owner(s), instancePath: [], nodeId: placed(s, componentId).id });
const part = (s: ProjectState, componentId: string, partId: string): ElementRef => {
  const n = placed(s, componentId);
  return { owner: owner(s), instancePath: [n.id], nodeId: s.components[n.definitionId].parts[partId].nodeId, partId };
};
const style = (s: ProjectState, ref: ElementRef, scope: ResponsiveScope, property: string, value: StyleValue | null) =>
  applyOperations(s, [{ type: 'node.setStyle', owner: ref.owner, nodeId: ref.instancePath[0] ?? ref.nodeId, ...(ref.partId ? { partId: ref.partId } : {}), scope, property, value }]).state;

/** The declarations the generated stylesheet gives one selector at one size. */
function declsAt(css: string, scope: ResponsiveScope, selector: string): string[] {
  const at = scope === 'base' ? 0 : css.indexOf(`@media ${MEDIA_QUERIES[scope]} {`);
  if (at < 0) return [];
  const end = scope === 'base' ? css.indexOf('@media') : css.indexOf('\n}\n', at);
  const block = css.slice(at, end < 0 ? undefined : end);
  const out: string[] = [];
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of block.matchAll(new RegExp(`(?:^|\\n)\\s*${esc} \\{\\n([^}]*)\\}`, 'g'))) out.push(...m[1].split('\n').map((l) => l.trim().replace(/;$/, '')).filter(Boolean));
  return out;
}

/** The Business Home example from #165: Split hero at 72px for all sizes and 16px on Phone. */
function heroPadded() {
  let s = fresh();
  const hero = section(s, 'hero.split');
  s = style(s, hero, 'base', 'paddingBlock', '72px');
  s = style(s, hero, 'phone', 'paddingBlock', '16px');
  return s;
}

describe('copy style', () => {
  it('lists what a section, a part and an element carry, with the controls the inspector offers', () => {
    const s = fresh();
    const hero = styleSelection(s, section(s, 'hero.split'))!;
    expect(hero.kind).toBe('section');
    expect(hero.label).toBe('Split hero');
    expect(hero.where).toBe('on the Home page');
    const root = hero.targets.find((t) => t.part === 'root')!;
    expect(root.offered).toEqual(['paddingBlock', 'background', 'color', 'minHeight', 'hidden']);
    // An image part that can be cropped also offers its focal point.
    expect(hero.targets.find((t) => t.part === 'media')!.offered).toEqual(['aspectRatio', 'objectPosition', 'radius', 'shadow']);
    const heading = styleSelection(s, part(s, 'content.media', 'heading'))!;
    expect(heading).toMatchObject({ kind: 'single', label: 'Heading in Content with image' });
    expect(heading.targets).toHaveLength(1);
    expect(heading.targets[0]).toMatchObject({ part: null, partId: 'heading', offered: ['textStyle', 'color'] });
    // A card part is styled once for every card.
    expect(styleSelection(s, part(s, 'features.grid', 'card'))!.targets[0].reach).toBe('every card');
  });

  it('matches the inspector: Hidden on a section and on code parts, a part’s own list elsewhere', () => {
    const s = fresh();
    const media = s.components[placed(s, 'content.media').definitionId];
    expect(placementStyleControls(media, 'root', false)).toEqual(['paddingBlock', 'background', 'hidden']);
    expect(placementStyleControls(media, 'heading', false)).toEqual(['textStyle', 'color']);
    expect(placementStyleControls(media, 'nope', false)).toBeNull();
    const header = s.components[(s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode).definitionId];
    expect(placementStyleControls(header, 'root', false)).toBeNull();
    expect(placementStyleControls(header, 'root', true)).toContain('hidden');
    // A code component's parts: their own list with Hidden, or the fixed list when they name none.
    const code = { kind: 'code' as const, parts: { root: { nodeId: 'r', label: 'Badge' }, label: { nodeId: 'l', label: 'Label', styleControls: ['color'] } } };
    expect(placementStyleControls(code, 'label', true)).toEqual(['color', 'hidden']);
    expect(placementStyleControls(code, 'root', true)).toEqual(['paddingBlock', 'background', 'color', 'border', 'radius', 'shadow', 'opacity', 'hidden']);
    // A managed root with no list offers everything, as the inspector does.
    expect(placementStyleControls({ kind: 'managed', parts: { root: { nodeId: 'r', label: 'Section' } } }, 'root', false)).toBeUndefined();
  });

  it('keeps a part picked by name on its component’s root element as that part, and drops a part that moved', () => {
    let s = blankWithSection();
    const page = s.pages[homeId(s)];
    const holder = page.nodes[page.rootIds[0]] as InstanceNode;
    const ins = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: holder.id, slot: 'content', primitive: 'heading', text: 'Hello' }]);
    s = ins.state;
    const made = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: ins.results[0].nodeId as string, name: 'Title' }]);
    s = made.state;
    const inst = Object.values(s.pages[homeId(s)].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.name === 'Title') as InstanceNode;
    const def = s.components[inst.definitionId];
    const [named] = Object.entries(def.parts).filter(([id, p]) => id !== 'root' && p.nodeId === def.parts.root.nodeId);
    expect(named).toBeDefined();
    const pick = styleSelection(s, { owner: owner(s), instancePath: [inst.id], nodeId: named[1].nodeId, partId: named[0] })!;
    expect(pick.kind).toBe('single');
    expect(pick.targets[0]).toMatchObject({ partId: named[0], nodeId: inst.id });
    // The name now belongs to another element than the one picked.
    const media = fresh();
    expect(styleSelection(media, part(media, 'content.media', 'heading'))).not.toBeNull();
    expect(styleSelection(media, { ...part(media, 'content.media', 'heading'), nodeId: 'body' })).toBeNull();
  });

  it('takes nothing from a component’s design or from a part of a component nested inside a section', () => {
    const s = fresh();
    const def = placed(s, 'hero.split').definitionId;
    expect(styleSelection(s, { owner: { kind: 'component', id: def }, instancePath: [], nodeId: 'heading' })).toBeNull();
    const hero = placed(s, 'hero.split');
    // The hero has a heading part too, so only the depth tells this one apart.
    expect(styleSelection(s, { owner: owner(s), instancePath: [hero.id, 'nested'], nodeId: 'heading', partId: 'heading' })).toBeNull();
  });

  it('keeps the copy as it was when copied', () => {
    let s = heroPadded();
    const copy = captureStyle(s, section(s, 'hero.split'))!;
    // Even an edit made in place, to the very objects copied from.
    (s.pages[homeId(s)].nodes[placed(s, 'hero.split').id] as InstanceNode).overrides!.root.phone!.paddingBlock = '40px';
    expect(copy.sets).toEqual([{ part: 'root', label: 'Section', styles: { base: { paddingBlock: '72px' }, phone: { paddingBlock: '16px' } } }]);
    // A selection with no style changes of its own has nothing to paste.
    expect(captureStyle(s, section(s, 'content.media'))!.sets).toEqual([]);
  });
});

describe('paste style', () => {
  it('gives Content with image the hero’s padding at every size and nothing else, in one undoable batch (#165)', async () => {
    let s = heroPadded();
    const dest = section(s, 'content.media');
    // The destination has a Desktop padding of its own, which would otherwise win at desktop, and a background.
    s = style(s, dest, 'desktop', 'paddingBlock', '96px');
    s = style(s, dest, 'tablet', 'paddingBlock', '48px');
    s = style(s, dest, 'base', 'background', { token: 'color.surface-alt' });
    const copy = captureStyle(s, section(s, 'hero.split'))!;
    const plan = planStylePaste(s, copy, dest, 'every');
    const id = dest.nodeId;
    expect(plan.operations).toEqual([
      { type: 'node.setStyle', owner: owner(s), nodeId: id, partId: 'root', scope: 'base', property: 'paddingBlock', value: '72px' },
      { type: 'node.setStyle', owner: owner(s), nodeId: id, partId: 'root', scope: 'phone', property: 'paddingBlock', value: '16px' },
      { type: 'node.setStyle', owner: owner(s), nodeId: id, partId: 'root', scope: 'tablet', property: 'paddingBlock', value: null },
      { type: 'node.setStyle', owner: owner(s), nodeId: id, partId: 'root', scope: 'desktop', property: 'paddingBlock', value: null }
    ]);
    expect(plan.rows).toEqual([
      {
        part: 'root',
        target: 'Section',
        property: 'paddingBlock',
        label: 'Vertical padding',
        status: 'change',
        changes: [
          { scope: 'base', from: undefined, to: '72px' },
          { scope: 'phone', from: undefined, to: '16px' },
          { scope: 'tablet', from: '48px' },
          { scope: 'desktop', from: '96px' }
        ]
      }
    ]);
    const before = s.pages[homeId(s)].nodes[id] as InstanceNode;
    const after = applyOperations(s, plan.operations).state;
    const pasted = after.pages[homeId(s)].nodes[id] as InstanceNode;
    expect(pasted.overrides).toEqual({ root: { base: { paddingBlock: '72px', background: { token: 'color.surface-alt' } }, phone: { paddingBlock: '16px' } } });
    // Its copy, photo, link and design choices are its own still; the hero is untouched.
    expect(pasted.props).toEqual(before.props);
    expect(pasted.variants).toEqual(before.variants);
    expect(after.pages[homeId(s)].rootIds).toEqual(s.pages[homeId(s)].rootIds);
    expect(placed(after, 'hero.split')).toEqual(placed(s, 'hero.split'));

    // The exported site gives the destination 72px at desktop and 16px on phones.
    const css = generateSiteCss(after);
    const sel = `.${overrideClass(id, 'root')}.${overrideClass(id, 'root')}`;
    expect(declsAt(css, 'base', sel)).toContain('padding-block: 72px');
    expect(declsAt(css, 'phone', sel)).toEqual(['padding-block: 16px']);
    expect(declsAt(css, 'desktop', sel)).toEqual([]);
    expect(declsAt(css, 'tablet', sel)).toEqual([]);
    expect(declsAt(generateSiteCss(s), 'desktop', sel)).toEqual(['padding-block: 96px']);

    // Pasting again changes nothing.
    const again = planStylePaste(after, copy, dest, 'every');
    expect(again.operations).toEqual([]);
    expect(again.rows.map((r) => r.status)).toEqual(['same']);

    // In the app the batch is one history entry: one Undo takes the whole paste back, one Redo brings it again.
    const dir = mkdtempSync(join(tmpdir(), 'so-style-paste-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, s);
    const prior = JSON.stringify(session.state.pages[homeId(s)]);
    const r = await session.apply({ operations: plan.operations }, { label: 'Paste style' });
    expect(r.ok).toBe(true);
    expect((session.state.pages[homeId(s)].nodes[id] as InstanceNode).overrides?.root.phone).toEqual({ paddingBlock: '16px' });
    await session.undo();
    expect(JSON.stringify(session.state.pages[homeId(s)])).toBe(prior);
    await session.redo();
    expect((session.state.pages[homeId(s)].nodes[id] as InstanceNode).overrides).toEqual(pasted.overrides);
    await session.close();
  });

  it('writes only one size’s changes when asked, and leaves the other sizes alone', () => {
    let s = heroPadded();
    const dest = section(s, 'content.media');
    s = style(s, dest, 'desktop', 'paddingBlock', '96px');
    const copy = captureStyle(s, section(s, 'hero.split'))!;
    s = style(s, section(s, 'hero.split'), 'tablet', 'background', { token: 'color.brand' });
    const tabletCopy = captureStyle(s, section(s, 'hero.split'))!;
    expect(planStylePaste(s, tabletCopy, dest, 'tablet').operations).toEqual([
      { type: 'node.setStyle', owner: owner(s), nodeId: dest.nodeId, partId: 'root', scope: 'tablet', property: 'background', value: { token: 'color.brand' } }
    ]);
    const ops = (scope: 'base' | 'phone' | 'desktop') => planStylePaste(s, copy, dest, scope).operations.map((o) => (o.type === 'node.setStyle' ? [o.scope, o.value] : null));
    expect(ops('phone')).toEqual([['phone', '16px']]);
    expect(ops('base')).toEqual([['base', '72px']]);
    // The hero has no Desktop padding of its own: there is nothing to paste for Desktop, and the reason is given.
    const desktop = planStylePaste(s, copy, dest, 'desktop');
    expect(desktop.operations).toEqual([]);
    expect(desktop.rows).toEqual([expect.objectContaining({ property: 'paddingBlock', status: 'skip', reason: 'The copy sets it for All sizes, Phone, not Desktop.' })]);
    expect(planStylePaste(s, copy, dest, 'phone').operations).toHaveLength(1);
  });

  it('shows what can’t be applied between different section types, and why', () => {
    let s = heroPadded();
    const hero = section(s, 'hero.split');
    s = style(s, hero, 'base', 'minHeight', '80vh');
    s = style(s, hero, 'base', 'customCss', 'filter: saturate(1.2)');
    s = style(s, part(s, 'hero.split', 'heading'), 'base', 'textStyle', { token: 'text.h2' });
    s = style(s, part(s, 'hero.split', 'lead'), 'base', 'color', { token: 'color.muted' });
    const copy = captureStyle(s, hero)!;
    const plan = planStylePaste(s, copy, section(s, 'content.media'), 'every');
    const row = (property: string, target: string) => plan.rows.find((r) => r.property === property && r.target === target)!;
    expect(row('paddingBlock', 'Section').status).toBe('change');
    expect(row('minHeight', 'Section')).toMatchObject({ status: 'skip', reason: 'Content with image’s section doesn’t offer min height.' });
    expect(row('customCss', 'Section')).toMatchObject({ status: 'skip' });
    // The same part on both keeps its site style link; a part the destination doesn't have is named.
    expect(row('textStyle', 'Heading')).toMatchObject({ status: 'change', changes: [{ scope: 'base', to: { token: 'text.h2' } }] });
    expect(row('color', 'Supporting text')).toMatchObject({ status: 'skip', reason: 'Content with image has no supporting text part to take it.' });
    // What is shown as not pasted is not pasted.
    expect(plan.operations.map((o) => (o.type === 'node.setStyle' ? `${o.partId}.${o.scope}.${o.property}` : ''))).toEqual(['root.base.paddingBlock', 'root.phone.paddingBlock', 'heading.base.textStyle']);
    const heading = s.pages[homeId(s)].nodes[placed(s, 'content.media').id] as InstanceNode;
    const after = applyOperations(s, plan.operations).state;
    expect((after.pages[homeId(s)].nodes[heading.id] as InstanceNode).overrides?.heading).toEqual({ base: { textStyle: { token: 'text.h2' } } });
  });

  it('pastes a part onto another part, and onto a section’s own style', () => {
    let s = fresh();
    s = style(s, part(s, 'hero.split', 'heading'), 'base', 'textStyle', { token: 'text.h3' });
    s = style(s, part(s, 'hero.split', 'heading'), 'phone', 'color', { token: 'color.brand' });
    const copy = captureStyle(s, part(s, 'hero.split', 'heading'))!;
    expect(copy.kind).toBe('single');
    const onBody = planStylePaste(s, copy, part(s, 'content.media', 'body'), 'every');
    const media = placed(s, 'content.media').id;
    expect(onBody.operations).toEqual([
      { type: 'node.setStyle', owner: owner(s), nodeId: media, partId: 'body', scope: 'base', property: 'textStyle', value: { token: 'text.h3' } },
      { type: 'node.setStyle', owner: owner(s), nodeId: media, partId: 'body', scope: 'phone', property: 'color', value: { token: 'color.brand' } }
    ]);
    // A section's own style offers neither, so nothing lands, and each says so.
    const onSection = planStylePaste(s, copy, section(s, 'content.media'), 'every');
    expect(onSection.operations).toEqual([]);
    expect(onSection.rows.map((r) => [r.target, r.status])).toEqual([
      ['Section', 'skip'],
      ['Section', 'skip']
    ]);
    // A card's padding is a section's too: it lands on the section's own style.
    s = style(s, part(s, 'features.grid', 'card'), 'phone', 'paddingBlock', { token: 'space.md' });
    const card = captureStyle(s, part(s, 'features.grid', 'card'))!;
    expect(planStylePaste(s, card, section(s, 'content.media'), 'every').operations).toEqual([
      { type: 'node.setStyle', owner: owner(s), nodeId: media, partId: 'root', scope: 'phone', property: 'paddingBlock', value: { token: 'space.md' } }
    ]);
  });

  it('pastes only a section’s own style onto a single part', () => {
    let s = heroPadded();
    s = style(s, part(s, 'hero.split', 'heading'), 'base', 'color', { token: 'color.brand' });
    const copy = captureStyle(s, section(s, 'hero.split'))!;
    const plan = planStylePaste(s, copy, part(s, 'content.media', 'heading'), 'every');
    expect(plan.operations).toEqual([]);
    // A card takes vertical padding, so there the section's own style lands, and only that.
    const onCard = planStylePaste(s, copy, part(s, 'features.grid', 'card'), 'every');
    expect(onCard.operations).toEqual([
      { type: 'node.setStyle', owner: owner(s), nodeId: placed(s, 'features.grid').id, partId: 'card', scope: 'base', property: 'paddingBlock', value: '72px' },
      { type: 'node.setStyle', owner: owner(s), nodeId: placed(s, 'features.grid').id, partId: 'card', scope: 'phone', property: 'paddingBlock', value: '16px' }
    ]);
    expect(plan.rows).toEqual([
      expect.objectContaining({ target: 'Heading', property: 'paddingBlock', status: 'skip', reason: 'Heading in Content with image doesn’t offer vertical padding.' }),
      expect.objectContaining({ target: 'Heading', property: 'color', status: 'skip', reason: 'Only the section’s own style can go onto Heading in Content with image.' })
    ]);
  });

  it('pastes between elements placed on a page, within what the destination offers', () => {
    let s = blankWithSection();
    const page = s.pages[homeId(s)];
    const holder = page.nodes[page.rootIds[0]] as InstanceNode;
    const ins = applyOperations(s, [
      { type: 'node.insert', owner: owner(s), parentId: holder.id, slot: 'content', primitive: 'stack' },
      { type: 'node.insert', owner: owner(s), parentId: holder.id, slot: 'content', primitive: 'heading', text: 'Hello' }
    ]);
    s = ins.state;
    const [stack, heading] = ins.results.map((r) => ({ owner: owner(s), instancePath: [], nodeId: r.nodeId as string }));
    s = style(s, stack, 'base', 'gap', { token: 'space.lg' });
    s = style(s, stack, 'tablet', 'marginBlockEnd', '24px');
    s = style(s, stack, 'base', 'customCss', 'filter: saturate(1.2)');
    s = style(s, heading, 'base', 'opacity', 0.5);
    // A hand-edited document can hold a value no edit would write; it must never read as "remove".
    const stackNode = s.pages[homeId(s)].nodes[stack.nodeId];
    (stackNode.styles!.base as Record<string, unknown>).opacity = null;
    (stackNode.styles!.base as Record<string, unknown>).fontFamily = 'Plus Jakarta Sans';
    const plan = planStylePaste(s, captureStyle(s, stack)!, heading, 'every');
    expect(plan.rows.find((r) => r.property === 'gap')).toMatchObject({ status: 'skip' });
    // The heading offers Custom CSS, but it is never pasted.
    expect(plan.rows.find((r) => r.property === 'customCss')).toMatchObject({ status: 'skip', reason: expect.stringContaining('Custom CSS') });
    expect(plan.rows.find((r) => r.property === 'opacity')).toMatchObject({ status: 'skip', reason: 'The copied value isn’t one the builder can paste.' });
    const font = plan.operations.find((o) => o.type === 'node.setStyle' && o.property === 'fontFamily');
    expect(plan.operations.filter((o) => o !== font)).toEqual([{ type: 'node.setStyle', owner: owner(s), nodeId: heading.nodeId, scope: 'tablet', property: 'marginBlockEnd', value: '24px' }]);
    // A font named on its own is written as copied; the edit stores its full stack, and pasting again finds nothing to change.
    expect(font).toMatchObject({ scope: 'base', value: 'Plus Jakarta Sans' });
    const after = applyOperations(s, plan.operations).state;
    expect(after.pages[homeId(s)].nodes[heading.nodeId].styles?.base?.fontFamily).toContain('Plus Jakarta Sans Variable');
    expect(planStylePaste(after, captureStyle(s, stack)!, heading, 'every').operations).toEqual([]);
    // A stack the edit lengthens past what may be written is still written as copied, so the paste goes through.
    let long = 'Arial, Plus Jakarta Sans';
    for (let i = 0; long.length < 185; i++) long += `, Fallback ${i}`;
    (stackNode.styles!.base as Record<string, unknown>).fontFamily = long;
    const longPlan = planStylePaste(s, captureStyle(s, stack)!, heading, 'every');
    expect(longPlan.operations.find((o) => o.type === 'node.setStyle' && o.property === 'fontFamily')).toMatchObject({ value: long });
    expect(() => applyOperations(s, longPlan.operations)).not.toThrow();
  });

  it('holds back a property whose site style was removed since copying, and only that property', () => {
    let s = heroPadded();
    const made = applyOperations(s, [{ type: 'token.create', group: 'space', label: 'Roomy', value: '88px' }]);
    s = made.state;
    const token = s.tokens.custom[0].id;
    s = style(s, section(s, 'hero.split'), 'tablet', 'paddingBlock', { token });
    s = style(s, section(s, 'hero.split'), 'base', 'background', { token: 'color.surface-alt' });
    const copy: StyleCopy = captureStyle(s, section(s, 'hero.split'))!;
    s = applyOperations(s, [{ type: 'token.remove', tokenId: token, detach: true }]).state;
    const plan = planStylePaste(s, copy, section(s, 'content.media'), 'every');
    expect(plan.rows.find((r) => r.property === 'paddingBlock')).toMatchObject({ status: 'skip', reason: expect.stringContaining('has been removed') });
    const media = placed(s, 'content.media').id;
    expect(plan.operations).toEqual([{ type: 'node.setStyle', owner: owner(s), nodeId: media, partId: 'root', scope: 'base', property: 'background', value: { token: 'color.surface-alt' } }]);
    // Phone alone does not reach the removed style, so it still pastes.
    expect(planStylePaste(s, copy, section(s, 'content.media'), 'phone').operations).toEqual([
      { type: 'node.setStyle', owner: owner(s), nodeId: media, partId: 'root', scope: 'phone', property: 'paddingBlock', value: '16px' }
    ]);
    expect(() => applyOperations(s, plan.operations)).not.toThrow();
  });

  it('holds back a value that names a removed site style in its CSS text', () => {
    let s = heroPadded();
    s = applyOperations(s, [{ type: 'token.create', group: 'color', label: 'Sea', value: '#2a7f9e' }]).state;
    const token = s.tokens.custom[0].id;
    const hero = section(s, 'hero.split');
    s = style(s, hero, 'base', 'background', `linear-gradient(var(--so-${token.replace('.', '-')}), #ffffff)`);
    const copy = captureStyle(s, hero)!;
    expect(planStylePaste(s, copy, section(s, 'content.media'), 'every').rows.find((r) => r.property === 'background')).toMatchObject({ status: 'change' });
    // A variable that was never a site style is the author's own: it pastes.
    const own = style(s, hero, 'tablet', 'background', 'linear-gradient(var(--so-color-optional), #ffffff)');
    expect(planStylePaste(own, captureStyle(own, hero)!, section(own, 'content.media'), 'tablet').operations).toHaveLength(1);
    // Its own use is cleared (the style can't be removed while CSS names it), then the style is removed.
    s = style(s, hero, 'base', 'background', null);
    s = applyOperations(s, [{ type: 'token.remove', tokenId: token }]).state;
    const plan = planStylePaste(s, copy, section(s, 'content.media'), 'every');
    expect(plan.rows.find((r) => r.property === 'background')).toMatchObject({ status: 'skip', reason: expect.stringContaining('has been removed') });
    expect(plan.operations.map((o) => (o.type === 'node.setStyle' ? o.property : ''))).toEqual(['paddingBlock', 'paddingBlock']);
    // CSS reads var() in any case, and a text style through one variable per metric.
    const sea = `--so-${token.replace('.', '-')}`;
    const upper: StyleCopy = { ...copy, sets: [{ ...copy.sets[0], styles: { base: { background: `linear-gradient(VAR(${sea}), #ffffff)` } } }] };
    expect(planStylePaste(s, upper, section(s, 'content.media'), 'every').rows[0]).toMatchObject({ status: 'skip', reason: expect.stringContaining('has been removed') });
    const metric: StyleCopy = { kind: 'single', label: 'Text', vars: [...copy.vars, '--so-text-custom-callout'], sets: [{ part: null, label: 'Text', styles: { base: { maxWidth: 'var(--so-text-custom-callout-size)' } } }] };
    expect(planStylePaste(s, metric, part(s, 'hero.split', 'heading'), 'every').rows[0]).toMatchObject({ property: 'maxWidth', status: 'skip', reason: expect.stringContaining('text-custom-callout') });
  });
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
