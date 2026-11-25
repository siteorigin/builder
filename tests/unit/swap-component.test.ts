/**
 * Changing a placed component to another design where it is (#374): its words, links, pictures and list items move
 * to the new design's properties by name and meaning, its anchor, position and compatible tone stay, content with no
 * place is refused unless the change may drop it, and one Undo brings the old design back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, InstanceNode, ListItem, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { planSwap, swapTarget } from '@engine/swap';
import { validateState } from '@engine/validate';
import { ProjectSession } from '../../src/main/project/session';
import { swapChoices } from '../../src/renderer/src/lib/swap-choices';

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const inst = (s: ProjectState, id: string) => home(s).nodes[id] as InstanceNode;

/** The business starter, with the home page's sections found by their component. */
function project() {
  const s = createStarterState('business', 'Test', false);
  s.assets.assets.a1 = { id: 'a1', name: 'Studio', file: 'static/assets/studio.jpg', mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' };
  const find = (componentId: string) => home(s).rootIds.find((id) => s.components[inst(s, id).definitionId]?.componentId === componentId)!;
  return { s, find };
}

const swap = (s: ProjectState, nodeId: string, target: { componentId?: string; definitionId?: string }, allowDrops?: boolean) =>
  applyOperations(s, [{ type: 'instance.swapComponent', owner: owner(s), nodeId, ...target, ...(allowDrops ? { allowDrops } : {}) } as EditOperation]);

/** Errors the project has after the change that it did not have before. */
function newErrors(before: ProjectState, after: ProjectState) {
  const was = new Set(validateState(before).filter((d) => d.severity === 'error').map((d) => `${d.code}:${d.message}`));
  return validateState(after).filter((d) => d.severity === 'error' && !was.has(`${d.code}:${d.message}`));
}

describe('instance.swapComponent', () => {
  it('changes a split hero to a centered hero in place, keeping its words, links, anchor and tone', () => {
    const { s, find } = project();
    const id = find('hero.split');
    const node = inst(s, id);
    node.anchor = 'welcome';
    node.name = 'Opening';
    node.variants = { tone: 'muted', layout: 'media-start' };
    node.overrides = { root: { base: { paddingBlock: { token: 'space.lg' } } } };
    const was = structuredClone(node.props);
    const at = home(s).rootIds.indexOf(id);
    expect(s.components['foundation.hero.centered']).toBeUndefined();

    const r = swap(s, id, { componentId: 'hero.centered' });
    const now = inst(r.state, id);
    expect(now.definitionId).toBe('foundation.hero.centered');
    expect(home(r.state).rootIds.indexOf(id)).toBe(at);
    expect(home(r.state).rootIds).toEqual(home(s).rootIds);
    for (const key of ['eyebrow', 'heading', 'headingLevel', 'lead', 'primaryLabel', 'primaryLink', 'secondaryLabel', 'secondaryLink']) expect(now.props[key], key).toEqual(was[key]);
    // A centered hero has no picture: an empty one goes without a word.
    expect(now.props).not.toHaveProperty('image');
    expect(now).toMatchObject({ anchor: 'welcome', name: 'Opening', variants: { tone: 'muted' }, overrides: { root: { base: { paddingBlock: { token: 'space.lg' } } } } });
    // Its layout option has no counterpart in the new design.
    expect(now.variants).not.toHaveProperty('layout');
    expect(r.results[0]).toMatchObject({ nodeId: id, definitionId: 'foundation.hero.centered', dropped: [], restyled: ['Layout: Image first'] });
    expect(r.results[0].kept).toEqual(expect.arrayContaining(['Eyebrow', 'Heading', 'Supporting text', 'Primary button label', 'Primary button link']));
    // The new design was installed and locked, as inserting it would.
    expect(r.state.components['foundation.hero.centered']).toBeDefined();
    expect(r.state.themeLock.components['foundation.hero.centered']).toBeDefined();
    expect(newErrors(s, r.state)).toEqual([]);
  });

  it('carries a picture, a link and plain rich text to the names they go by in the new design', () => {
    const { s, find } = project();
    const id = find('content.media');
    const node = inst(s, id);
    node.props.image = { assetId: 'a1', alt: 'The studio at dusk' };
    node.props.body = [{ type: 'p', spans: [{ text: 'We plan every room with you.' }] }];
    node.props.actionLabel = 'Book a visit';
    node.props.actionLink = { type: 'url', target: 'https://example.com/book', newTab: true };

    const r = swap(s, id, { componentId: 'hero.split' });
    const now = inst(r.state, id);
    expect(now.props.image).toEqual({ assetId: 'a1', alt: 'The studio at dusk' });
    // Rich text with nothing but words becomes the plain lead; the action becomes the primary button.
    expect(now.props.lead).toBe('We plan every room with you.');
    expect(now.props.primaryLabel).toBe('Book a visit');
    expect(now.props.primaryLink).toEqual({ type: 'url', target: 'https://example.com/book', newTab: true });
    expect(now.props.heading).toBe(node.props.heading);
    // Its layout (image at the end) is an option the split hero names differently.
    expect(now.variants ?? {}).not.toHaveProperty('layout');
    expect(newErrors(s, r.state)).toEqual([]);
  });

  it('turns plain text into literal rich text, reading nothing in it as formatting', () => {
    const { s, find } = project();
    const id = find('hero.split');
    inst(s, id).props.lead = 'Two *stars* and a [bracket](here)';
    const r = swap(s, id, { componentId: 'content.text' }, true);
    expect(r.results[0].dropped).toEqual(['Eyebrow', 'Primary button label', 'Primary button link', 'Secondary button label', 'Secondary button link']);
    const now = inst(r.state, id);
    expect(now.props.body).toEqual([{ type: 'p', spans: [{ text: 'Two *stars* and a [bracket](here)' }] }]);
    expect(now.props.heading).toBe(inst(s, id).props.heading);
  });

  it('refuses to drop content the new design has no place for, naming it, unless allowed', () => {
    const { s, find } = project();
    const id = find('hero.split');
    inst(s, id).props.image = { assetId: 'a1', alt: 'Living room' };
    expect(() => swap(s, id, { componentId: 'hero.centered' })).toThrow(/would drop Image.*allowDrops/);
    const r = swap(s, id, { componentId: 'hero.centered' }, true);
    expect(inst(r.state, id).definitionId).toBe('foundation.hero.centered');
    expect(r.results[0].dropped).toEqual(['Image']);
    // Formatting a plain field cannot keep is named with its reason.
    const media = find('content.media');
    inst(s, media).props.body = [{ type: 'p', spans: [{ text: 'Bold', strong: true }, { text: ' claim' }] }];
    expect(() => swap(s, media, { componentId: 'hero.centered' })).toThrow(/Text \(its formatting/);
  });

  it('moves list items to the list of the same meaning, keeping their IDs and matching fields', () => {
    const { s, find } = project();
    const id = find('testimonials.grid');
    const items = inst(s, id).props.items as ListItem[];
    items[0].portrait = { assetId: 'a1', alt: 'Ana' };
    const r = swap(s, id, { componentId: 'team.grid' });
    const now = inst(r.state, id);
    const people = now.props.people as ListItem[];
    expect(people.map((p) => p.id)).toEqual(items.map((it) => it.id));
    for (const [i, it] of items.entries()) expect(people[i]).toMatchObject({ name: it.name, role: it.role, bio: it.quote });
    expect(people[0].portrait).toEqual({ assetId: 'a1', alt: 'Ana' });
    expect(now.props).not.toHaveProperty('items');
    expect(r.results[0].kept).toEqual(expect.arrayContaining(['People']));
    expect(newErrors(s, r.state)).toEqual([]);
  });

  it('names item fields that would be lost, and fills the new fields from defaults', () => {
    const { s, find } = project();
    const id = find('features.grid');
    const items = inst(s, id).props.items as ListItem[];
    expect(() => swap(s, id, { componentId: 'pricing.plans' })).toThrow(/would drop Cards → Icon/);
    const r = swap(s, id, { componentId: 'pricing.plans' }, true);
    const plans = inst(r.state, id).props.plans as ListItem[];
    expect(plans.map((p) => p.id)).toEqual(items.map((it) => it.id));
    expect(plans[0]).toMatchObject({ name: items[0].title, description: items[0].description });
    const field = catalogueComponent(s.site.themeId, 'pricing.plans')!.properties.plans;
    expect(plans[0].price).toEqual(field.type === 'list' ? field.fields.price.default : undefined);
    expect(newErrors(s, r.state)).toEqual([]);
  });

  it('swaps to a project component by its definition ID', () => {
    const { s, find } = project();
    const id = find('hero.split');
    const copy = applyOperations(s, [{ type: 'component.duplicate', definitionId: 'foundation.hero.split', name: 'Studio hero' }]);
    const defId = copy.results[0].definitionId as string;
    const centered = swap(copy.state, id, { componentId: 'hero.centered' }).state;
    const r = swap(centered, id, { definitionId: defId });
    expect(inst(r.state, id).definitionId).toBe(defId);
    expect(inst(r.state, id).props.heading).toBe(inst(s, id).props.heading);
    expect(() => swap(r.state, id, { definitionId: 'proj.missing' })).toThrow(/is not installed/);
    expect(() => swap(r.state, id, { definitionId: defId })).toThrow(/already shows “Studio hero”/);
  });

  it('refuses what it cannot change: the shared header, both or neither target, slots the new design lacks, an anchor it cannot show', () => {
    const { s, find } = project();
    const header = s.site.shell.header.rootIds[0];
    expect(() => applyOperations(s, [{ type: 'instance.swapComponent', owner: { kind: 'shell', id: 'header' }, nodeId: header, componentId: 'hero.split' }])).toThrow(/shared header and footer/);
    const hero = find('hero.split');
    expect(() => swap(s, hero, {})).toThrow(/either componentId or definitionId/);
    expect(() => swap(s, hero, { componentId: 'hero.centered', definitionId: 'foundation.hero.centered' })).toThrow(/either componentId or definitionId/);
    expect(() => swap(s, hero, { componentId: 'nope.nope' })).toThrow(/no component "nope.nope"/);
    expect(() => swap(s, hero, { componentId: 'shell.footer' })).toThrow(/shared header and footer/);
    // A section holding content in its slot.
    const withSlot = applyOperations(s, [
      { type: 'node.insert', owner: owner(s), newNodeId: 'n_wrapper', componentId: 'layout.section' },
      { type: 'node.insert', owner: owner(s), parentId: 'n_wrapper', slot: 'content', primitive: 'heading', text: 'Inside' }
    ]).state;
    expect(() => swap(withSlot, 'n_wrapper', { componentId: 'hero.centered' })).toThrow(/has no “Content” slot/);
    // A code component cannot render the anchor links on the page go to.
    inst(s, hero).anchor = 'top';
    expect(() => swap(s, hero, { componentId: 'media.video' }, true)).toThrow(/can’t take the anchor #top/);
    // Nothing changed on a refusal: not even the component it would have installed.
    expect(s.components['foundation.hero.centered']).toBeUndefined();
  });

  it('plans the same change it makes, before the new design is installed', () => {
    const { s, find } = project();
    const id = find('hero.split');
    inst(s, id).props.image = { assetId: 'a1', alt: 'Living room' };
    const target = swapTarget(s, { componentId: 'hero.centered' }) as ComponentDefinition;
    expect(s.components[target.id]).toBeUndefined();
    const plan = planSwap(s, owner(s), home(s), inst(s, id), target);
    expect(plan.problems).toEqual([]);
    expect(plan.dropped).toEqual([{ label: 'Image' }]);
    expect(plan.kept.map((k) => k.to)).toEqual(swap(s, id, { componentId: 'hero.centered' }, true).results[0].kept);
    expect(plan.props.heading).toBe(inst(s, id).props.heading);
  });

  it('offers the designs Insert offers there, similar ones first, without the one it shows or the shared header', () => {
    const { s, find } = project();
    const hero = inst(s, find('hero.split'));
    const choices = swapChoices(s, hero);
    const ids = choices.map((c) => c.def.componentId);
    expect(ids).not.toContain('hero.split');
    expect(ids).not.toContain('shell.header');
    expect(ids).not.toContain('shell.footer');
    // Other heroes first, then everything else in Insert's order.
    expect(choices.filter((c) => c.group === 'Similar sections').map((c) => c.def.componentId)).toEqual(expect.arrayContaining(['hero.centered', 'intro.page']));
    expect(choices.findIndex((c) => c.group !== 'Similar sections')).toBeGreaterThan(choices.findLastIndex((c) => c.group === 'Similar sections'));
    expect(choices.find((c) => c.def.componentId === 'hero.centered')?.spec).toEqual({ componentId: 'hero.centered' });
    // A project component is offered by its definition ID; code components only in Developer mode.
    const copy = applyOperations(s, [{ type: 'component.duplicate', definitionId: 'foundation.hero.split', name: 'Studio hero' }]);
    const defId = copy.results[0].definitionId as string;
    expect(swapChoices(copy.state, hero).find((c) => c.def.id === defId)).toMatchObject({ group: 'Your components', spec: { definitionId: defId } });
    expect(swapChoices(s, inst(s, find('hero.split')), false).some((c) => c.def.kind === 'code' && c.def.owner === 'project')).toBe(false);
  });

  it('undoes in one step, the component it installed included, and redoes the same change', async () => {
    const { s, find } = project();
    const id = find('hero.split');
    inst(s, id).anchor = 'welcome';
    const dir = mkdtempSync(join(tmpdir(), 'so-swap-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, s);
    const before = structuredClone(session.state);
    const r = await session.apply({ operations: [{ type: 'instance.swapComponent', owner: owner(s), nodeId: id, componentId: 'hero.centered' }] }, { label: 'Change section design' });
    expect(r.ok).toBe(true);
    const swapped = structuredClone(session.state);
    expect(inst(swapped, id).definitionId).toBe('foundation.hero.centered');
    expect(session.historyInfo().undoLabel).toBe('Change section design');
    await session.undo();
    expect(home(session.state)).toEqual(home(before));
    expect(session.state.components).toEqual(before.components);
    expect(session.state.themeLock).toEqual(before.themeLock);
    await session.redo();
    expect(home(session.state)).toEqual(home(swapped));
    expect(session.state.components).toEqual(swapped.components);
  });
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
