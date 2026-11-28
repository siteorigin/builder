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
import { catalogueComponent, listThemes, registerPacks } from '@catalogue/index';
import { foundationDesign, projectDesign, restorePacks } from './fixtures/packs';
import { formFieldKey } from '@shared/form-contract';
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

/**
 * A hero built in the editor, as the project's own, with the content properties of `like` (the split hero): its
 * heading in a section whose root carries `anchor` when given one, and a tone axis that defaults to `tone`.
 */
function editorHero(s: ProjectState, componentId: string, name: string, at: { anchor?: string; tone?: string }, like: ComponentDefinition) {
  return projectDesign(s, {
    componentId,
    name,
    category: 'hero',
    properties: structuredClone(like.properties),
    parts: { root: { nodeId: 'root', label: 'Section' } },
    variantAxes: { tone: { label: 'Tone', default: at.tone ?? 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } } },
    build: (b) => b.el('root', 'section', { anchor: at.anchor }, [b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' })])
  });
}

/**
 * A copy of the split hero as code of the project's own whose markup places no `id={so_id}`, so it cannot show
 * the anchor its placement carries.
 */
function anchorlessCode(s: ProjectState): { state: ProjectState; definitionId: string } {
  const r = applyOperations(s, [{ type: 'component.duplicate', definitionId: 'foundation.hero.split', name: 'Plain hero' }]);
  const def = r.state.components[r.results[0].definitionId as string];
  expect(def.kind).toBe('code');
  def.source = def.source!.replace(/\s+id=\{\s*so_id[^}]*\}/g, '');
  expect(def.source).not.toMatch(/id=\{\s*so_id/);
  return { state: r.state, definitionId: def.id };
}

/** Errors the project has after the change that it did not have before. */
function newErrors(before: ProjectState, after: ProjectState) {
  const was = new Set(validateState(before).filter((d) => d.severity === 'error').map((d) => `${d.code}:${d.message}`));
  return validateState(after).filter((d) => d.severity === 'error' && !was.has(`${d.code}:${d.message}`));
}

describe('instance.swapComponent', () => {
  // Theme sections are code components (the anchor moving with a change of design is below, between designs built in
  // the editor).
  it('changes a split hero to a centered hero in place, keeping its words, links, name and tone', () => {
    const { s, find } = project();
    const id = find('hero.split');
    const node = inst(s, id);
    node.name = 'Opening';
    node.variants = { tone: 'muted', layout: 'media-start' };
    node.overrides = { root: { base: { paddingBlock: { token: 'space.lg' } } }, media: { base: { radius: { token: 'radius.lg' } } } };
    node.props.headingLevel = 'h2';
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
    expect(now).toMatchObject({ name: 'Opening', variants: { tone: 'muted' }, overrides: { root: { base: { paddingBlock: { token: 'space.lg' } } } } });
    // Its layout option has no counterpart in the new design.
    expect(now.variants).toEqual({ tone: 'muted' });
    expect(now.props.headingLevel).toBe('h2');
    // Styles of the section stay; those of its picture have no part to go to.
    expect(now.overrides).toEqual({ root: { base: { paddingBlock: { token: 'space.lg' } } } });
    expect(r.results[0]).toMatchObject({ nodeId: id, from: 'Opening', definitionId: 'foundation.hero.centered', dropped: [], restyled: ['Layout: Image first', 'Styles of Image'] });
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
    // Its points and text link have no place in a hero: left empty, they go without a word.
    node.props.points = [];
    node.props.linkLabel = '';
    node.variants = { tone: 'inverse', layout: 'media-end' };

    const r = swap(s, id, { componentId: 'hero.split' });
    const now = inst(r.state, id);
    expect(now.props.image).toEqual({ assetId: 'a1', alt: 'The studio at dusk' });
    // Rich text with nothing but words becomes the plain lead; the action becomes the primary button.
    expect(now.props.lead).toBe('We plan every room with you.');
    expect(now.props.primaryLabel).toBe('Book a visit');
    expect(now.props.primaryLink).toEqual({ type: 'url', target: 'https://example.com/book', newTab: true });
    expect(now.props.heading).toBe(node.props.heading);
    // Its tone stays; its layout (image at the end) is an option the split hero names differently.
    expect(now.variants).toEqual({ tone: 'inverse' });
    expect(r.results[0].restyled).toEqual(['Layout: Image last']);
    expect(newErrors(s, r.state)).toEqual([]);
  });

  it('turns plain text into literal rich text, reading nothing in it as formatting', () => {
    const { s, find } = project();
    const id = find('hero.split');
    const def = s.components[inst(s, id).definitionId].properties.lead;
    if (def.type === 'string') def.multiline = true;
    inst(s, id).props.lead = 'Two *stars* and a [bracket](here)\n\n- not a list';
    const r = swap(s, id, { componentId: 'content.text' }, true);
    expect(r.results[0].dropped).toEqual(['Primary button label', 'Primary button link', 'Secondary button label', 'Secondary button link']);
    const now = inst(r.state, id);
    expect(now.definitionId).toBe('foundation.content.text');
    expect(now.props.eyebrow).toBe(inst(s, id).props.eyebrow);
    expect(now.props.body).toEqual([
      { type: 'p', spans: [{ text: 'Two *stars* and a [bracket](here)' }] },
      { type: 'p', spans: [{ text: '- not a list' }] }
    ]);
    expect(now.props.heading).toBe(inst(s, id).props.heading);
  });

  it('refuses to drop content the new design has no place for, naming it, unless allowed', () => {
    const { s, find } = project();
    const id = find('hero.split');
    inst(s, id).props.image = { assetId: 'a1', alt: 'Living room' };
    expect(() => swap(s, id, { componentId: 'hero.centered' })).toThrow(/would drop Image: the new design has no place for it\. Pick another design, or remove that content first if it should go\.$/);
    const r = swap(s, id, { componentId: 'hero.centered' }, true);
    expect(inst(r.state, id).definitionId).toBe('foundation.hero.centered');
    expect(r.results[0].dropped).toEqual(['Image']);
    // Formatting a plain field cannot keep is named with its reason (its points and text link, which a hero has no
    // place for either, left empty).
    const media = find('content.media');
    inst(s, media).props.points = [];
    inst(s, media).props.linkLabel = '';
    inst(s, media).props.body = [{ type: 'p', spans: [{ text: 'Bold', strong: true }, { text: ' claim' }] }];
    expect(() => swap(s, media, { componentId: 'hero.centered' })).toThrow(/Text \(its formatting/);
    inst(s, media).props.body = [{ type: 'p', spans: [{ text: 'See ' }, { text: 'us', link: { type: 'url', target: 'https://example.com' } }] }];
    expect(() => swap(s, media, { componentId: 'hero.centered' })).toThrow(/Text \(its formatting, links/);
    // A paragraph broken over lines (an address) keeps its break in text that takes several lines, and has no plain
    // form in text of one line.
    inst(s, media).props.body = [{ type: 'p', spans: [{ text: '1 Main St\nCape Town' }] }];
    expect(inst(swap(s, media, { componentId: 'hero.centered' }).state, media).props.lead).toBe('1 Main St\nCape Town');
    const oneLine = applyOperations(s, [{ type: 'node.insert', owner: owner(s), componentId: 'hero.centered' }]).state;
    const lead = oneLine.components['foundation.hero.centered'].properties.lead;
    if (lead.type === 'string') lead.multiline = false;
    expect(() => swap(oneLine, media, { componentId: 'hero.centered' })).toThrow(/Text \(its formatting/);
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
    const first = (inst(s, id).props.items as ListItem[])[0];
    // Eight cards, two more than a pricing table holds.
    const items = Array.from({ length: 8 }, (_, i) => ({ ...first, id: `i_card${i}`, title: `Card ${i}`, description: `About ${i}`, linkLabel: `More ${i}`, link: { type: 'url', target: `https://example.com/${i}` } }));
    inst(s, id).props.items = items;
    expect(() => swap(s, id, { componentId: 'pricing.plans' })).toThrow(/would drop Cards \(2 items past the new limit of 6\); Cards → Icon/);
    const r = swap(s, id, { componentId: 'pricing.plans' }, true);
    const plans = inst(r.state, id).props.plans as ListItem[];
    expect(plans.map((p) => p.id)).toEqual(items.slice(0, 6).map((it) => it.id));
    for (const [i, p] of plans.entries()) expect(p).toMatchObject({ name: `Card ${i}`, description: `About ${i}`, actionLabel: `More ${i}`, actionLink: { type: 'url', target: `https://example.com/${i}` } });
    expect(r.results[0].dropped).toEqual(['Cards', 'Cards → Icon']);
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
    inst(centered, id).props.heading = 'Edited while centered';
    inst(centered, id).props.secondaryLink = { type: 'url', target: 'https://example.com/tour' };
    // The centered hero's note has no place in a split hero.
    inst(centered, id).props.note = '';
    const r = swap(centered, id, { definitionId: defId });
    expect(inst(r.state, id).definitionId).toBe(defId);
    expect(inst(r.state, id).props).toMatchObject({ heading: 'Edited while centered', primaryLink: inst(s, id).props.primaryLink, secondaryLink: { type: 'url', target: 'https://example.com/tour' } });
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
    expect(withSlot.components['foundation.hero.centered']).toBeUndefined();
    // Code that places no `id={so_id}` cannot render the anchor links on the page go to; a theme section can.
    inst(s, hero).anchor = 'top';
    const plain = anchorlessCode(s);
    expect(() => swap(plain.state, hero, { definitionId: plain.definitionId }, true)).toThrow(/can’t take the anchor #top/);
    expect(inst(swap(s, hero, { componentId: 'media.video' }, true).state, hero).anchor).toBe('top');
  });

  it('moves slot content to the new design’s slot of the same name, which must take it, and fits the slot it sits in', () => {
    const { s } = project();
    const st = applyOperations(s, [
      { type: 'node.insert', owner: owner(s), newNodeId: 'n_wrapper', componentId: 'layout.section' },
      { type: 'node.insert', owner: owner(s), parentId: 'n_wrapper', slot: 'content', newNodeId: 'n_inside', componentId: 'hero.centered' },
      { type: 'component.duplicate', definitionId: 'foundation.layout.section', name: 'Band' }
    ]);
    const band = st.results[2].definitionId as string;
    // The centered hero's note has no place in the split hero it becomes below.
    inst(st.state, 'n_inside').props.note = '';
    const r = swap(st.state, 'n_wrapper', { definitionId: band });
    expect(inst(r.state, 'n_wrapper')).toMatchObject({ definitionId: band, slots: { content: ['n_inside'] } });
    expect(newErrors(st.state, r.state)).toEqual([]);
    // A slot that takes only heroes keeps a hero in it from becoming a call to action.
    r.state.components[band].slots!.content.categories = ['hero'];
    expect(() => swap(r.state, 'n_inside', { componentId: 'cta.banner' })).toThrow(/The “Content” slot of “Band” takes hero components, not “Call to action”/);
    expect(() => swap(r.state, 'n_inside', { componentId: 'hero.split' })).not.toThrow();
  });

  it('keeps the anchor and the default look its old design gave it, and says when a list the site fills goes', () => {
    const { s, find } = project();
    const id = find('hero.split');
    // The hero shows a design built in the editor whose root carries #studio and which
    // defaults to dark, and changes to one with neither.
    const split = s.components[inst(s, id).definitionId];
    const studio = editorHero(s, 'hero.studio', 'Studio hero', { anchor: 'studio', tone: 'inverse' }, split);
    const band = editorHero(s, 'hero.band', 'Hero band', {}, split);
    inst(s, id).definitionId = studio.id;
    delete inst(s, id).variants;
    const r = swap(s, id, { definitionId: band.id });
    // Links to #studio still land, and the hero stays dark although the band defaults to light.
    expect(inst(r.state, id)).toMatchObject({ anchor: 'studio', variants: { tone: 'inverse' } });
    // A theme section, which is code placing `id={so_id}`, keeps it too; code that places no id is refused; one that
    // gives its root an anchor of its own would lose it.
    expect(inst(swap(s, id, { componentId: 'hero.centered' }, true).state, id).anchor).toBe('studio');
    // Its entrance has nowhere to land in code, so the change says it goes.
    const entering = structuredClone(s);
    inst(entering, id).appear = 'lift';
    const toCode = swap(entering, id, { componentId: 'hero.centered' }, true);
    expect(inst(toCode.state, id).anchor).toBe('studio');
    expect(inst(toCode.state, id).appear).toBeUndefined();
    expect(toCode.results[0].restyled).toContain('Entrance');
    // A design built in the editor takes it on.
    const toBand = swap(entering, id, { definitionId: band.id }, true);
    expect(inst(toBand.state, id).appear).toBe('lift');
    expect(toBand.results[0].restyled).not.toContain('Entrance');
    const plain = anchorlessCode(s);
    expect(() => swap(plain.state, id, { definitionId: plain.definitionId }, true)).toThrow(/can’t take the anchor #studio/);
    const contact = editorHero(s, 'hero.contact', 'Contact hero', { anchor: 'contact' }, split);
    expect(() => swap(s, id, { definitionId: contact.id })).toThrow(/would drop Anchor #studio \(the new design gives the section its own anchor, #contact\)/);
    expect(inst(swap(s, id, { definitionId: contact.id }, true).state, id).anchor).toBeUndefined();
    // A news list the site fills from its articles has no place in a services grid.
    const news = applyOperations(s, [{ type: 'node.insert', owner: owner(s), newNodeId: 'n_news', componentId: 'content.news' }]).state;
    expect(() => swap(news, 'n_news', { componentId: 'features.grid' })).toThrow(/would drop Articles \(the new design does not fill it from the site's dated articles\)/);
    expect(() => swap(news, 'n_news', { componentId: 'blog.list' })).toThrow(/would drop Articles/);
  });

  it('gives form fields keys of their own when a list becomes a form’s fields', () => {
    const { s } = project();
    const copy = applyOperations(s, [
      { type: 'node.insert', owner: owner(s), newNodeId: 'n_methods', componentId: 'contact.details' },
      { type: 'component.duplicate', definitionId: 'foundation.contact.details', name: 'Signup' }
    ]);
    const defId = copy.results[1].definitionId as string;
    const def = copy.state.components[defId];
    def.properties.fields = def.properties.items;
    delete def.properties.items;
    const node = inst(copy.state, 'n_methods');
    node.definitionId = defId;
    delete node.props.items;
    node.props.fields = [
      { id: 'i_f1', icon: 'mail', label: 'Email', value: '', link: { type: 'none', target: '' } },
      { id: 'i_f2', icon: 'mail', label: 'Email', value: '', link: { type: 'none', target: '' } }
    ];
    const r = swap(copy.state, 'n_methods', { componentId: 'contact.form' }, true);
    const fields = inst(r.state, 'n_methods').props.fields as ListItem[];
    expect(fields.map((f) => f.label)).toEqual(['Email', 'Email']);
    const names = fields.map((f) => f.name);
    expect(names.every((n) => typeof n === 'string' && n !== '')).toBe(true);
    expect(new Set(names).size).toBe(2);
  });

  it('keeps the keys a form’s answers were sent under, read with the old form’s defaults, when it becomes another form', () => {
    const { s } = project();
    const copy = applyOperations(s, [
      { type: 'node.insert', owner: owner(s), newNodeId: 'n_form', componentId: 'contact.form' },
      { type: 'component.duplicate', definitionId: 'foundation.contact.form', name: 'Billing form' }
    ]);
    const defId = copy.results[1].definitionId as string;
    const fields = copy.state.components[defId].properties.fields;
    if (fields.type === 'list') fields.fields.label.default = 'Billing email';
    const node = inst(copy.state, 'n_form');
    node.definitionId = defId;
    // The first field shows the old form's default label and is sent under the key made from it; the second is named "field".
    node.props.fields = [
      { id: 'i_f1', type: 'email', required: true, placeholder: '' },
      { id: 'i_f2', label: 'Other', name: 'field', type: 'text', required: false, placeholder: '' }
    ];
    const r = swap(copy.state, 'n_form', { componentId: 'contact.form' }, true);
    const after = inst(r.state, 'n_form').props.fields as ListItem[];
    expect(after.map((f) => f.label)).toEqual(['Billing email', 'Other']);
    expect(after.map((f) => f.name)).toEqual(['billing-email', 'field']);
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
    // A project component (one built in the editor: Insert offers a project's code components only in developer mode)
    // is offered by its definition ID.
    const defId = editorHero(s, 'hero.studio', 'Studio hero', {}, s.components[hero.definitionId]).id;
    expect(swapChoices(s, hero).find((c) => c.def.id === defId)).toMatchObject({ group: 'Your components', spec: { definitionId: defId } });
  });

  it('offers a block the theme’s other blocks, similar ones first, and never a section (#664)', () => {
    const { s } = project();
    const page = owner(s);
    const next = applyOperations(s, [{ type: 'node.insert', newNodeId: 'n_stat', owner: page, parentId: null, index: 2, componentId: 'layout.section' }, { type: 'node.insert', newNodeId: 'n_card', owner: page, parentId: 'n_stat', slot: 'content', componentId: 'block.stat' }]).state;
    const choices = swapChoices(next, inst(next, 'n_card'));
    expect(choices.map((c) => [c.group, c.def.componentId])).toEqual([
      ['Similar blocks', 'block.testimonial'],
      ['Other blocks', 'block.feature'],
      ['Other blocks', 'block.callout'],
      ['Other blocks', 'block.download'],
      ['Other blocks', 'block.facts'],
      ['Other blocks', 'block.signup'],
      ['Other blocks', 'block.video']
    ]);
    expect(choices.some((c) => !c.group.endsWith('blocks') && c.group !== 'Your components')).toBe(false);
    // A section is offered sections, as before.
    expect(swapChoices(next, inst(next, home(next).rootIds[0])).some((c) => c.group.endsWith('blocks'))).toBe(false);
  });

  it('keeps the keys of form fields a placement inherits from its design', () => {
    const { s } = project();
    const copy = applyOperations(s, [
      { type: 'node.insert', owner: owner(s), newNodeId: 'n_form', componentId: 'contact.form' },
      { type: 'component.duplicate', definitionId: 'foundation.contact.form', name: 'Japanese form' }
    ]);
    const defId = copy.results[1].definitionId as string;
    // A fork of the form: still the theme's contact form contract, with its own default fields.
    copy.state.components[defId].componentId = 'contact.form';
    const schema = copy.state.components[defId].properties.fields;
    if (schema.type === 'list') schema.default = [{ id: 'i_d1', label: '氏名', name: '', type: 'text', options: [], required: false, placeholder: '' }];
    const node = inst(copy.state, 'n_form');
    node.definitionId = defId;
    delete node.props.fields;
    // Its one field, labelled in words that make no key, is sent under the key its position gives it.
    const sent = formFieldKey({ name: '', label: '氏名' }, 0);
    const r = swap(copy.state, 'n_form', { componentId: 'contact.form' }, true);
    expect((inst(r.state, 'n_form').props.fields as ListItem[]).map((f) => [f.label, f.name])).toEqual([['氏名', sent]]);
  });

  it('lets slot content its old design already left out stay left out, and previews designs the theme has yet to install', () => {
    const { s, find } = project();
    // Two bands built in the editor that show their content once per row, with no rows here.
    const band = (componentId: string, name: string) =>
      projectDesign(s, {
        componentId,
        name,
        category: 'layout',
        properties: { rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [] } },
        parts: { root: { nodeId: 'root', label: 'Section' } },
        slots: { content: { label: 'Content' } },
        build: (b) => b.el('root', 'section', {}, [b.el('inner', 'div', {}, [b.repeat('n_rows', 'rows', [b.slot('content-slot', 'content')])])])
      }).id;
    const first = band('layout.band', 'Band');
    const second = band('layout.band-2', 'Band 2');
    const placed = applyOperations(s, [
      { type: 'node.insert', owner: owner(s), newNodeId: 'n_band', definitionId: first },
      { type: 'node.insert', owner: owner(s), parentId: 'n_band', slot: 'content', newNodeId: 'n_inside', primitive: 'heading', text: 'Inside' }
    ]);
    const r = swap(placed.state, 'n_band', { definitionId: second });
    expect(inst(r.state, 'n_band').slots).toEqual({ content: ['n_inside'] });
    // A theme design whose root places another theme design takes the anchor, though neither is installed yet. Both
    // are built in the editor, as only those render an anchor: the placed one is Foundation's for this test.
    const hero = inst(s, find('hero.split'));
    hero.anchor = 'welcome';
    const centered = foundationDesign({
      componentId: 'hero.anchored',
      name: 'Anchored hero',
      category: 'hero',
      properties: structuredClone(s.components[hero.definitionId].properties),
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) => b.el('root', 'section', {}, [b.text('heading', 'h1', { $prop: 'heading' })])
    });
    registerPacks(listThemes().map((p) => (p.id === s.site.themeId ? { ...p, components: [...p.components, centered] } : p)));
    const wrap = { ...structuredClone(centered), id: 'foundation.hero.wrapped', componentId: 'hero.wrapped', tree: { rootIds: ['r'], nodes: { r: { id: 'r', kind: 'instance', definitionId: centered.id, props: {} } } } } as ComponentDefinition;
    expect(s.components[centered.id]).toBeUndefined();
    expect(planSwap(s, owner(s), home(s), hero, wrap).problems).toEqual([]);
  });

  it('undoes in one step, the component it installed included, and redoes the same change', async () => {
    const { s, find } = project();
    const id = find('hero.split');
    inst(s, id).name = 'Welcome';
    const dir = mkdtempSync(join(tmpdir(), 'so-swap-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, s);
    const before = structuredClone(session.state);
    const r = await session.apply({ operations: [{ type: 'instance.swapComponent', owner: owner(s), nodeId: id, componentId: 'hero.centered' }] }, { label: 'Change section design' });
    expect(r.ok).toBe(true);
    const swapped = structuredClone(session.state);
    expect(inst(swapped, id)).toMatchObject({ definitionId: 'foundation.hero.centered', name: 'Welcome', props: { heading: inst(before, id).props.heading, lead: inst(before, id).props.lead } });
    expect(session.historyInfo().undoLabel).toBe('Change section design');
    await session.undo();
    expect(home(session.state)).toEqual(home(before));
    expect(session.state.components).toEqual(before.components);
    expect(session.state.themeLock).toEqual(before.themeLock);
    await session.redo();
    expect(home(session.state)).toEqual(home(swapped));
    expect(session.state.components).toEqual(swapped.components);
    expect(session.state.themeLock).toEqual(swapped.themeLock);
  });
});

const dirs: string[] = [];
afterEach(async () => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  await restorePacks();
});
