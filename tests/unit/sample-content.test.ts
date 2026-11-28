/**
 * Sample content in Project health (#1640): a placed component's sample-marked defaults, a basic element's first words,
 * and the Business starter's copy and photos, while the published site still shows them; each leads to its field or
 * element, and keeping one as it is quiets that value at that place alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssetRecord, ComponentDefinition, InstanceNode, ListItem, OwnerRef, ProjectState, TableProp } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { P, item, prop } from '@catalogue/dsl';
import { STARTER_ASSETS, createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { validateState, type Diagnostic } from '@engine/validate';
import { keptSampleKey, sampleContentDiagnostics, sampleFixtures, samplePlace, withoutKeptSamples } from '@engine/sample-content';
import { freshKeeper } from '@engine/validation-cache';
import { themeUpdates } from '@engine/theme-updates';
import { definitionHash } from '@shared/migrations';
import { SAMPLE_CONTACT } from '@shared/sample-contact';
import { ELEMENT_STUBS } from '@shared/element-stubs';
import { destinationForDiagnostic } from '../../src/renderer/src/lib/destinations';
import { ProjectSession } from '../../src/main/project/session';
import { projectDesign } from './fixtures/packs';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const home = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const samples = (s: ProjectState, code?: string) => validateState(s).filter((d) => d.code.startsWith('SAMPLE_') && (!code || d.code === code));
const placeOf = (d: Diagnostic) => samplePlace(d);
const none = { type: 'none' as const, target: '' };

/** Five sample plans a list starts with, and what a newly added plan's name starts as. */
const PLANS = ['Starter', 'Studio', 'Team', 'Agency', 'Enterprise'].map((name, i) => ({ id: `item-${i + 1}`, name, blurb: `${name} plan blurb.` }));

/** A design of the project's own whose every kind of copy starts as sample content, as a theme would mark it. */
function sampleDesign(s: ProjectState): ComponentDefinition {
  return projectDesign(s, {
    componentId: 'project.samples',
    name: 'Samples',
    properties: {
      heading: P.sample(P.str('Heading', 'Gardens planted to last')),
      note: P.str('Note', 'Ready to publish'),
      intro: P.sample(P.rich('Intro', ['We plan, plant and **care** for gardens.'])),
      subtitle: P.sample(P.str('Subtitle', 'An optional line')),
      email: P.sample(P.str('Email', SAMPLE_CONTACT.email)),
      action: P.object('Action', { label: P.sample(P.str('Label', 'Book a visit')), link: P.link('Link') }),
      plans: P.sample(P.list('Plans', 'Plan', { name: P.sample(P.str('Name', 'New plan')), blurb: P.str('Blurb', '') }, PLANS, { titleField: 'name' })),
      ctaLabel: P.sample(P.str('Button label', 'Talk to us')),
      ctaLink: P.link('Button link')
    },
    parts: { root: { nodeId: 'root', label: 'Section' } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading' }),
        b.text('note', 'p', prop('note'), { name: 'Note' }),
        b.rich('intro', prop('intro'), { name: 'Intro' }),
        b.text('subtitle', 'p', prop('subtitle'), { name: 'Subtitle', when: prop('subtitle') }),
        b.text('email', 'p', prop('email'), { name: 'Email' }),
        b.text('action', 'p', { $prop: 'action', field: 'label' }, { name: 'Action' }),
        b.el('list', 'ul', { name: 'Plans' }, [b.repeat('plan-items', 'plans', [b.el('plan', 'li', { name: 'Plan' }, [b.text('plan-name', 'h3', item('name'), { name: 'Name' }), b.text('plan-blurb', 'p', item('blurb'), { name: 'Blurb' })])])]),
        b.link('cta', prop('ctaLink'), prop('ctaLabel'), 'primary', { name: 'Button' })
      ])
  });
}

/** A blank site with the sample design placed on Home. */
function withSamples(): { s: ProjectState; def: ComponentDefinition; node: InstanceNode } {
  const s = createStarterState('blank', 'Garden Co', false);
  const def = sampleDesign(s);
  const node = makeInstance(def);
  s.pages[s.site.homePageId].nodes[node.id] = node;
  s.pages[s.site.homePageId].rootIds.push(node.id);
  return { s, def, node };
}

/** Set a placement's values, one property at a time, as the Inspector does. */
const setProps = (s: ProjectState, nodeId: string, props: Record<string, unknown>, owner: OwnerRef = home(s)): ProjectState =>
  run(s, ...Object.entries(props).map(([prop, value]): EditOperation => ({ type: 'instance.setProp', owner, nodeId, prop, value })));
const setContent = (s: ProjectState, nodeId: string, field: 'text' | 'link', value: unknown): ProjectState => run(s, { type: 'node.setContent', owner: home(s), nodeId, field, value });

describe('a placed component’s sample defaults', () => {
  it('names each marked default the page shows, and leads to its field', () => {
    const { s, node } = withSamples();
    const found = samples(s, 'SAMPLE_DEFAULT');
    const at = found.map((d) => placeOf(d));
    // The heading, rich text, the optional subtitle (shown while it has words), an object's field and each of the five
    // plans; not the unmarked note, the sample email (the export reviews it), or the button that goes nowhere (the site
    // leaves it out).
    expect(at.filter((p) => p?.kind === 'prop' && !('itemId' in p && p.itemId)).map((p) => (p as { prop: string; field?: string }).field ?? (p as { prop: string }).prop)).toEqual(['heading', 'intro', 'subtitle', 'label']);
    const rows = found.filter((d) => (placeOf(d) as { itemId?: string }).itemId);
    expect(rows).toHaveLength(5);
    expect(rows[0].message).toBe('Home: Plan 1 of Samples’ Plans is still one of the sample items its design starts with, “Starter”. Write your own, remove it, or keep it as it is.');
    expect(found[0].message).toBe('Home: Samples’ Heading still shows the sample text its design starts with, “Gardens planted to last”. Write your own, or keep it as it is.');
    expect(found.every((d) => d.severity === 'warning' && d.owner?.kind === 'page' && d.nodeId === node.id)).toBe(true);
    // Each leads to its field: a row to its title field.
    const plans = node.props.plans as ListItem[];
    expect(destinationForDiagnostic(s, found[0])).toEqual({ kind: 'prop', owner: home(s), nodeId: node.id, prop: 'heading' });
    expect(destinationForDiagnostic(s, found[3])).toEqual({ kind: 'prop', owner: home(s), nodeId: node.id, prop: 'action', field: 'label' });
    expect(destinationForDiagnostic(s, rows[0])).toEqual({ kind: 'prop', owner: home(s), nodeId: node.id, prop: 'plans', itemId: plans[0].id, field: 'name' });
  });

  it('stops naming a value once it is written over, and only the plans left as they started', () => {
    const { s, node } = withSamples();
    const plans = structuredClone(node.props.plans as ListItem[]);
    plans[1] = { ...plans[1], name: 'Small garden', blurb: 'For courtyards.' };
    plans[3] = { ...plans[3], blurb: 'Our own words.' };
    const edited = setProps(s, node.id, { heading: 'Our gardens', intro: ['Our own words.'], action: { label: 'Visit us', link: none }, plans });
    const found = samples(edited, 'SAMPLE_DEFAULT');
    // Only the subtitle is left of the values; three plans as they started, the two edited (one only in its blurb) the author's.
    expect(found.filter((d) => !(placeOf(d) as { itemId?: string }).itemId).map((d) => (placeOf(d) as { prop: string }).prop)).toEqual(['subtitle']);
    expect(found.filter((d) => (placeOf(d) as { itemId?: string }).itemId).map((d) => (placeOf(d) as { itemId?: string }).itemId)).toEqual([plans[0].id, plans[2].id, plans[4].id]);
  });

  it('names a newly added item’s sample field until it is written, and a sample item copied twice once', () => {
    const { s, node } = withSamples();
    const added = applyOperations(s, [{ type: 'instance.listInsert', owner: home(s), nodeId: node.id, prop: 'plans', item: { blurb: 'Ours.' } }]);
    const id = added.results[0].itemId as string;
    const field = samples(added.state).filter((d) => (placeOf(d) as { itemId?: string }).itemId === id);
    expect(field.map((d) => d.message)).toEqual(['Home: Plan 6 of Samples’ Plans → Name still shows the sample text a new item starts with, “New plan”. Write your own, or keep it as it is.']);
    expect(placeOf(field[0])).toMatchObject({ kind: 'prop', prop: 'plans', itemId: id, field: 'name' });
    // The same sample plan twice: one of them is the sample, the other a copy of it, whichever comes first.
    const plans = structuredClone(node.props.plans as ListItem[]);
    const rowIds = (st: ProjectState) => samples(st, 'SAMPLE_DEFAULT').flatMap((d) => ((placeOf(d) as { itemId?: string }).itemId ? [(placeOf(d) as { itemId: string }).itemId] : [])).sort();
    const doubled = setProps(s, node.id, { plans: [...plans, { ...plans[0], id: 'i_copy' }] });
    expect(rowIds(doubled)).toHaveLength(5);
    const moved = setProps(s, node.id, { plans: [{ ...plans[0], id: 'i_copy' }, ...plans] });
    expect(rowIds(moved)).toEqual(rowIds(doubled));
  });

  it('reads a placement that leaves a value to its design’s default', () => {
    const { s, node } = withSamples();
    delete node.props.heading;
    delete node.props.plans;
    const found = samples(s, 'SAMPLE_DEFAULT');
    expect(found.some((d) => (placeOf(d) as { prop?: string }).prop === 'heading')).toBe(true);
    // The design's own items, by their own IDs.
    expect(found.filter((d) => (placeOf(d) as { itemId?: string }).itemId).map((d) => (placeOf(d) as { itemId: string }).itemId)).toEqual(PLANS.map((p) => p.id));
  });

  it('says nothing of a draft page, a cleared value, a button with nowhere to go, or a list its collection fills', () => {
    const { s, node } = withSamples();
    // A draft page is not on the website.
    const draft = createStarterState('blank', 'Garden Co', false);
    const other = run(draft, { type: 'page.create', pageId: 'pg_draft', title: 'Draft', route: '/draft/', draft: true } as EditOperation);
    const def = sampleDesign(other);
    const placed = makeInstance(def);
    other.pages.pg_draft.nodes[placed.id] = placed;
    other.pages.pg_draft.rootIds.push(placed.id);
    expect(samples(other)).toEqual([]);
    // Cleared, it shows nothing.
    expect(samples(setProps(s, node.id, { heading: '' })).some((d) => (placeOf(d) as { prop?: string }).prop === 'heading')).toBe(false);
    // Linked, the button shows its sample label.
    const linked = setProps(s, node.id, { ctaLink: { type: 'page', target: s.site.homePageId } });
    expect(samples(linked).some((d) => (placeOf(d) as { prop?: string }).prop === 'ctaLabel')).toBe(true);
  });

  it('says nothing of a list its collection fills, nor of the photos it still keeps', () => {
    let s = business('Riverside Studio');
    s = run(
      s,
      { type: 'collection.create', collectionId: 'team', kind: 'structured', singularName: 'Team member', hasBody: false, pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role' } } },
      { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false, values: { role: 'Architect' } }
    );
    const team = Object.values(s.pages).flatMap((p) => Object.values(p.nodes).map((n) => ({ p, n }))).find(({ n }) => n.kind === 'instance' && s.components[n.definitionId].componentId === 'team.grid')!;
    const owner: OwnerRef = { kind: 'page', id: team.p.id };
    const before = samples(s).filter((d) => d.nodeId === team.n.id);
    expect(before.length).toBeGreaterThan(0);
    s = run(s, { type: 'instance.setListSource', owner, nodeId: team.n.id, prop: 'people', source: { query: { collectionId: 'team' }, fields: { name: 'title', role: 'field.role' } } } as EditOperation);
    expect(before.some((d) => d.code === 'SAMPLE_STARTER_PHOTO')).toBe(true);
    expect(samples(s).filter((d) => d.nodeId === team.n.id && (placeOf(d) as { prop?: string }).prop === 'people')).toEqual([]);
  });

  it('says nothing of a page list’s field left empty for its page to fill, and names one written as the sample', () => {
    let s = createStarterState('blank', 'Garden Co', false);
    s = run(s, { type: 'page.create', pageId: 'pg_consult', title: 'Consultation', route: '/consultation/' });
    const def = projectDesign(s, {
      componentId: 'project.cards',
      name: 'Cards',
      properties: { items: P.list('Cards', 'Card', { pageLink: P.link('Page'), title: P.sample(P.str('Title', 'Consultation')) }, [], { titleField: 'title', pageTeaser: { link: 'pageLink', title: 'title' } }) },
      parts: { root: { nodeId: 'root', label: 'Section' } },
      build: (b) => b.el('root', 'section', { name: 'Section' }, [b.repeat('cards', 'items', [b.el('card', 'div', { name: 'Card' }, [b.text('title', 'h3', item('title'), { name: 'Title' })])])])
    });
    const node = makeInstance(def, {
      items: [
        { id: 'i_page', pageLink: { type: 'page', target: 'pg_consult' }, title: '' },
        { id: 'i_own', pageLink: { type: 'page', target: s.site.homePageId }, title: 'Consultation' },
        // Left out, the field shows its own sample default, which the page does not replace.
        { id: 'i_left', pageLink: { type: 'page', target: 'pg_consult' } }
      ]
    });
    const home0 = s.pages[s.site.homePageId];
    home0.nodes[node.id] = node;
    home0.rootIds.push(node.id);
    const items = node.props.items as ListItem[];
    expect(samples(s).map((d) => (placeOf(d) as { itemId?: string }).itemId)).toEqual([items[1].id, items[2].id]);
  });

  it('names a table its design starts with until one cell changes, and the copy Foundation’s split hero marks', () => {
    // As the release marks them (#1641): no test marks a Foundation default itself.
    const s = createStarterState('blank', 'Garden Co', false);
    const def = s.components[installComponent(s, 'data.table')];
    const hero = s.components[installComponent(s, 'hero.split')];
    const table = makeInstance(def);
    const placed = makeInstance(hero);
    for (const n of [table, placed]) (s.pages[s.site.homePageId].nodes[n.id] = n), s.pages[s.site.homePageId].rootIds.push(n.id);
    const found = samples(s, 'SAMPLE_DEFAULT');
    const at = (d: Diagnostic) => [d.nodeId, (placeOf(d) as { prop: string }).prop];
    expect(found.map(at)).toEqual([
      [table.id, 'heading'],
      [table.id, 'caption'],
      [placed.id, 'eyebrow'],
      [placed.id, 'heading'],
      [placed.id, 'lead'],
      [table.id, 'table']
    ]);
    expect(found[5].message).toMatch(/still holds the sample rows and columns its design starts with/);
    const value = structuredClone((def.properties.table as TableProp).default);
    value.rows[0].cells[value.columns[0].id] = 'Our own';
    expect(samples(setProps(s, table.id, { table: value }), 'SAMPLE_DEFAULT').map(at)).toEqual(found.slice(0, 5).map(at));
    // Made unique, the Table keeps its code, and its sample rows are still named.
    const unique = run(s, { type: 'component.makeUnique', owner: home(s), nodeId: table.id, name: 'Our table' });
    expect(samples(unique, 'SAMPLE_DEFAULT').map((d) => (placeOf(d) as { prop: string }).prop)).toContain('table');
    // A project's own code given a table may show it or not: its markup decides, and it is not named.
    const own = structuredClone(s);
    own.components[def.id] = { ...own.components[def.id], owner: 'project', componentId: 'project.hours', provenance: { createdBy: 'user' } };
    expect(samples(own, 'SAMPLE_DEFAULT').some((d) => (placeOf(d) as { prop: string }).prop === 'table')).toBe(false);
  });
});

/** A blank site with these Foundation sections inserted on Home, as Insert places them, and each one's placement. */
function withFoundation(...componentIds: string[]): { s: ProjectState; placed: Record<string, InstanceNode> } {
  let s = createStarterState('blank', 'Garden Co', false);
  s = run(s, ...componentIds.map((componentId): EditOperation => ({ type: 'node.insert', owner: home(s), parentId: null, componentId })));
  const nodes = Object.values(s.pages[s.site.homePageId].nodes).filter((n): n is InstanceNode => n.kind === 'instance');
  const placed = Object.fromEntries(componentIds.map((id) => [id, nodes.find((n) => s.components[n.definitionId]?.componentId === id)!]));
  return { s, placed };
}

/** Each placement's sample-default findings, by the field each names (`prop`, or `prop.field` for an item's). */
function namedFields(s: ProjectState, node: InstanceNode): string[] {
  return samples(s, 'SAMPLE_DEFAULT')
    .filter((d) => d.nodeId === node.id)
    .map((d) => {
      const at = placeOf(d) as { prop: string; field?: string };
      return at.field ? `${at.prop}.${at.field}` : at.prop;
    });
}

/** A definition as Foundation shipped it before it marked its sample defaults. */
function unmarked<T>(value: T): T {
  if (Array.isArray(value)) return value.map(unmarked) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'sampleDefault').map(([k, v]) => [k, unmarked(v)])) as T;
}

describe('Foundation’s sample defaults, as its release marks them (#1641)', () => {
  it('names the illustrative copy of testimonials, logos, a split hero and a table, and a new FAQ row', () => {
    const { s, placed } = withFoundation('testimonials.grid', 'logos.strip', 'hero.split', 'data.table', 'faq.list');
    // A sample row is named by its title field.
    expect(namedFields(s, placed['testimonials.grid'])).toEqual(expect.arrayContaining(['heading', 'lead', 'items.name']));
    expect(namedFields(s, placed['logos.strip'])).toEqual(expect.arrayContaining(['heading', 'logos.name']));
    expect(namedFields(s, placed['hero.split'])).toEqual(['eyebrow', 'heading', 'lead']);
    expect(namedFields(s, placed['data.table'])).toContain('table');
    expect(samples(s, 'SAMPLE_DEFAULT').every((d) => d.severity === 'warning')).toBe(true);
    // A row added to the FAQ starts as the release's stub question and answer, and is named until it is written.
    const faq = placed['faq.list'];
    const added = applyOperations(s, [{ type: 'instance.listInsert', owner: home(s), nodeId: faq.id, prop: 'items', item: {} }]);
    const id = added.results[0].itemId as string;
    const row = samples(added.state, 'SAMPLE_DEFAULT').filter((d) => d.nodeId === faq.id && (placeOf(d) as { itemId?: string }).itemId === id);
    expect(row.map((d) => (placeOf(d) as { field?: string }).field).sort()).toEqual(['answer', 'question']);
  });

  it('names none of the reusable words of search, a contact form’s fields and button, or a feed', () => {
    const { s, placed } = withFoundation('site.search', 'contact.form', 'content.news', 'blog.grid', 'blog.list', 'content.pages');
    for (const id of ['site.search', 'content.news', 'blog.grid', 'blog.list', 'content.pages']) expect(namedFields(s, placed[id]), id).toEqual([]);
    // The form's lead is the house business's; its standard fields and its submit label are the visitor's to read as they are.
    expect(namedFields(s, placed['contact.form'])).toEqual(['lead']);
  });

  it('offers a project’s older, unmarked Foundation sections as Updates, which keep their content and single-item styles', () => {
    const { s: placedState, placed } = withFoundation('pricing.plans', 'testimonials.grid');
    const plans = placed['pricing.plans'];
    const featured = (plans.props.plans as ListItem[])[1].id;
    let s = run(
      placedState,
      { type: 'instance.setProp', owner: home(placedState), nodeId: plans.id, prop: 'heading', value: 'Garden care plans' },
      { type: 'node.setStyle', owner: home(placedState), nodeId: plans.id, partId: 'plan', itemId: featured, scope: 'base', property: 'border', value: { token: 'border.strong' } }
    );
    const before = structuredClone(s.pages[s.site.homePageId].nodes);
    // The project installed these before the release marked them: the lock names those older definitions.
    const older = [plans.definitionId, placed['testimonials.grid'].definitionId];
    for (const id of older) {
      s.components[id] = unmarked(s.components[id]);
      s.themeLock.components[id].hash = definitionHash(s.components[id]);
    }
    expect(samples(s, 'SAMPLE_DEFAULT').filter((d) => d.nodeId === plans.id || d.nodeId === placed['testimonials.grid'].id)).toEqual([]);
    expect(themeUpdates(s).available.map((a) => a.id).sort()).toEqual([...older].sort());
    s = run(s, { type: 'theme.refresh' });
    expect(themeUpdates(s)).toEqual({ available: [], kept: [] });
    expect(s.pages[s.site.homePageId].nodes).toEqual(before);
    expect((s.pages[s.site.homePageId].nodes[plans.id] as InstanceNode).itemOverrides).toEqual({ plan: { list: 'plans', items: { [featured]: { base: { border: { token: 'border.strong' } } } } } });
    // Now current, the sections name the sample copy left as it started, and not the heading written over.
    expect(namedFields(s, plans)).not.toContain('heading');
    expect(namedFields(s, plans)).toEqual(expect.arrayContaining(['lead', 'plans.name']));
    expect(namedFields(s, placed['testimonials.grid'])).toEqual(expect.arrayContaining(['heading', 'items.name']));
  });
});

describe('basic elements’ first words', () => {
  const SECTION = 'n_section01';
  const start = () => {
    const s = createStarterState('blank', 'Garden Co', false);
    return run(s, { type: 'node.insert', newNodeId: SECTION, owner: home(s), parentId: null, componentId: 'layout.section' });
  };
  const insert = (s: ProjectState, op: Partial<Extract<EditOperation, { type: 'node.insert' }>>) => {
    const r = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: SECTION, slot: 'content', ...op } as EditOperation]);
    return { s: r.state, id: r.results[0].nodeId as string };
  };

  it('names a heading, paragraph, rich text, badge, caption and linked button still saying what they were added with', () => {
    let s = start();
    for (const primitive of ['heading', 'paragraph', 'richtext', 'badge', 'figure', 'button'] as const) s = insert(s, { primitive }).s;
    const button = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'link')!;
    // Unlinked, the site leaves the button out.
    expect(samples(s, 'SAMPLE_ELEMENT_STUB').map((d) => d.message.replace(/^Home: /, '').split(' still')[0])).toEqual(['a heading', 'a paragraph', 'a text block', 'a badge', 'a caption']);
    s = setContent(s, button.id, 'link', { type: 'page', target: s.site.homePageId });
    const found = samples(s, 'SAMPLE_ELEMENT_STUB');
    expect(found).toHaveLength(6);
    expect(found[5].message).toBe(`Home: a button still says “${ELEMENT_STUBS.button}”, the words it was added with. Write your own, or keep it as it is.`);
    // The badge's and figure's words are their text, which the row leads to.
    const badge = found[3];
    expect(s.pages[s.site.homePageId].nodes[badge.nodeId!]).toMatchObject({ kind: 'text', text: 'New', name: 'Label' });
    expect(destinationForDiagnostic(s, badge)).toEqual({ kind: 'element', owner: home(s), nodeId: badge.nodeId });
  });

  it('stops naming one once its words change, and keeps one badge without quieting another', () => {
    let s = start();
    const a = insert(s, { primitive: 'heading' });
    s = a.s;
    s = setContent(s, a.id, 'text', 'Our gardens');
    expect(samples(s)).toEqual([]);
    s = insert(s, { primitive: 'badge' }).s;
    s = insert(s, { primitive: 'badge' }).s;
    const both = samples(s);
    expect(both).toHaveLength(2);
    // A badge that says "New" on purpose is kept; the second still says it was never written.
    const kept = new Set([keptSampleKey(both[0])]);
    expect(withoutKeptSamples(validateState(s), kept, new Set()).filter((d) => d.code.startsWith('SAMPLE_'))).toEqual([both[1]]);
    // A word anywhere else, typed by the author, is no stub: a paragraph saying "New", "New heading" or "Add a caption.".
    for (const text of ['New', ELEMENT_STUBS.heading, ELEMENT_STUBS.caption]) expect(samples(insert(s, { primitive: 'paragraph', text }).s), text).toHaveLength(2);
  });

  it('names a button by its words only when it goes somewhere, and leaves out what the site hides at every size', () => {
    let s = start();
    const b = insert(s, { primitive: 'button' });
    s = run(b.s, { type: 'node.setContent', owner: home(b.s), nodeId: b.id, field: 'appearance', value: 'link' });
    // A plain link with nowhere to go shows its words, but is no button anyone follows.
    expect(samples(s)).toEqual([]);
    const h = insert(s, { primitive: 'heading' });
    expect(samples(h.s)).toHaveLength(1);
    const hidden = run(h.s, { type: 'node.setStyle', owner: home(h.s), nodeId: h.id, scope: 'base', property: 'hidden', value: true });
    expect(samples(hidden)).toEqual([]);
    // Hidden with the section it is in, too.
    expect(samples(run(h.s, { type: 'node.setStyle', owner: home(h.s), nodeId: SECTION, scope: 'base', property: 'hidden', value: true }))).toEqual([]);
  });
});

/** The Business starter with its sample photos in the library, as a new project made with them has. */
function business(name = 'Test Studio'): ProjectState {
  const s = createStarterState('business', name, true);
  for (const a of STARTER_ASSETS) s.assets.assets[a.id] = { id: a.id, name: a.name, kind: 'image', file: `static/assets/${a.source}`, mime: 'image/jpeg', width: 1600, height: 1067, bytes: 1000 } as unknown as AssetRecord;
  return s;
}

describe('the Business starter’s copy and photos', () => {
  it('names the copy and photos a new project still shows, each leading to its field', () => {
    const s = business();
    const copy = samples(s, 'SAMPLE_STARTER_COPY');
    const photos = samples(s, 'SAMPLE_STARTER_PHOTO');
    expect(copy.map((d) => d.message)).toContain('Home: Split hero’s Heading still shows sample text, “Calm, considered spaces for everyday life”. Write your own, or keep it as it is.');
    // Copy the starter gives a section even where it is the section's own default, a team member's name, and the footer's tagline.
    expect(copy.some((d) => /Eyebrow still shows sample text, “Interior design studio”/.test(d.message))).toBe(true);
    expect(copy.some((d) => /Person 1 of Team’s People → Name still shows sample text, “Hannah Wells”/.test(d.message))).toBe(true);
    expect(copy.some((d) => d.message.startsWith('Footer: Footer’s Tagline'))).toBe(true);
    // Not the site's own name, its menus or its copyright line.
    expect(copy.filter((d) => ['siteName', 'links', 'copyright'].includes((placeOf(d) as { prop?: string }).prop ?? ''))).toEqual([]);
    // The site's description and each page's search description.
    expect(copy.filter((d) => placeOf(d)?.kind === 'site' || placeOf(d)?.kind === 'pageSeo').map((d) => placeOf(d))).toEqual([
      { kind: 'site', field: 'description' },
      ...s.site.pageOrder.map((pageId) => ({ kind: 'pageSeo', pageId, field: 'description' }))
    ]);
    expect(destinationForDiagnostic(s, copy.find((d) => placeOf(d)?.kind === 'site')!)).toEqual({ kind: 'site', field: 'description' });
    // Every photo it places: the hero's, the studio's, the gallery's three and the team's three portraits.
    expect(photos.map((d) => d.message.match(/sample photo “([^”]+)”/)![1]).sort()).toEqual(STARTER_ASSETS.map((a) => a.name).sort());
    const hero = photos.find((d) => d.message.includes('“Hero interior”'))!;
    expect(hero.message).toBe('Home: Split hero’s Image still shows the sample photo “Hero interior”. Replace it with a picture of your own, or keep it as it is.');
    const portrait = photos.find((d) => d.message.includes('“Portrait 1”'))!;
    expect(placeOf(portrait)).toMatchObject({ kind: 'prop', prop: 'people', field: 'portrait' });
  });

  it('takes a section’s own defaults for the design’s, and a project the starter did not make for the author’s', () => {
    // A Contact section's "Contact" eyebrow, or a hero's "Get in touch", is the same words as the starter's, but not its copy.
    for (const s of [business(), createStarterState('blank', 'Test Studio', false)]) {
      const before = samples(s, 'SAMPLE_STARTER_COPY').length;
      let next = s;
      for (const componentId of ['contact.details', 'cta.banner', 'hero.centered']) next = run(next, { type: 'node.insert', owner: home(next), parentId: null, componentId });
      expect(samples(next, 'SAMPLE_STARTER_COPY')).toHaveLength(before);
    }
    // Nor anything at all in a project the starter did not make, though its words are the starter's.
    const blank = createStarterState('blank', 'Test Studio', false);
    const placed = run(blank, { type: 'node.insert', owner: home(blank), parentId: null, componentId: 'hero.split', props: { heading: 'Calm, considered spaces for everyday life' } } as EditOperation);
    expect(samples(placed, 'SAMPLE_STARTER_COPY')).toEqual([]);
  });

  it('still knows the starter’s copy once its section changes design', () => {
    const s = business();
    const hero = samples(s, 'SAMPLE_STARTER_COPY').find((d) => d.message.includes('“Calm, considered spaces for everyday life”'))!;
    const swapped = run(s, { type: 'instance.swapComponent', owner: hero.owner as OwnerRef, nodeId: hero.nodeId!, componentId: 'hero.centered', allowDrops: true });
    const after = samples(swapped, 'SAMPLE_STARTER_COPY').filter((d) => d.message.includes('“Calm, considered spaces for everyday life”'));
    expect(after).toHaveLength(1);
    expect(after[0].message).not.toMatch(/Split hero/);
  });

  it('stops naming a photo replaced on the page, though the photo stays in Assets, and one given a file of the author’s', () => {
    let s = business();
    const hero = samples(s, 'SAMPLE_STARTER_PHOTO').find((d) => d.message.includes('“Hero interior”'))!;
    s.assets.assets.a_own = { ...s.assets.assets.a_hero, id: 'a_own', name: 'Our shop', file: 'static/assets/own.jpg', originalName: 'own.jpg' } as AssetRecord;
    s = setPropsAt(s, hero, { image: { assetId: 'a_own', alt: 'Our shop' } });
    expect(Object.hasOwn(s.assets.assets, 'a_hero')).toBe(true);
    const left = samples(s, 'SAMPLE_STARTER_PHOTO');
    expect(left.some((d) => d.message.includes('“Hero interior”'))).toBe(false);
    expect(left).toHaveLength(STARTER_ASSETS.length - 1);
    // The studio photo given another file, from the author's disk, under the same ID.
    s.assets.assets.a_studio = { ...s.assets.assets.a_studio, originalName: 'studio-own.jpg' } as AssetRecord;
    expect(samples(s, 'SAMPLE_STARTER_PHOTO').some((d) => d.message.includes('“Studio table”'))).toBe(false);
    // Unused, the photos in the library say nothing; a sharing image that is one does.
    s.site.socialImage = 'a_kitchen';
    expect(samples(s, 'SAMPLE_STARTER_PHOTO').filter((d) => placeOf(d)?.kind === 'site').map((d) => d.message)).toEqual(['The site’s sharing image is still the sample photo “Kitchen”. Choose a picture of your own in Site details, or keep it as it is.']);
  });

  it('still knows the copy that names the site after the site is renamed, and stops once it is written over', () => {
    let s = business('Alder Studio');
    s = run(s, { type: 'site.update', name: 'Birch & Co' });
    // A duplicated project names its copy afresh: the starter's name still reads the sentences written with it.
    s.manifest.name = 'Birch & Co';
    const about = s.site.pageOrder[1];
    expect(samples(s, 'SAMPLE_STARTER_COPY').some((d) => placeOf(d)?.kind === 'pageSeo' && (placeOf(d) as { pageId: string }).pageId === about)).toBe(true);
    expect(samples(s).some((d) => /“Alder Studio designs homes/.test(d.message))).toBe(true);
    // A sentence written with the site's new name is the author's own, and "Contact anything." is never the starter's
    // "Contact Alder Studio.".
    const contact = s.site.pageOrder[2];
    s = run(s, { type: 'page.update', pageId: about, description: 'Meet the team behind Birch & Co.' }, { type: 'page.update', pageId: contact, description: 'Contact us today.' });
    const pages = samples(s, 'SAMPLE_STARTER_COPY').flatMap((d) => (placeOf(d)?.kind === 'pageSeo' ? [(placeOf(d) as { pageId: string }).pageId] : []));
    expect(pages).toEqual([s.site.homePageId]);
    // Nor in a project the starter did not make, whatever it is called.
    const blank = createStarterState('blank', 'Alder Studio', false);
    expect(samples(run(blank, { type: 'site.update', description: 'Alder Studio is an independent interior design studio creating calm, practical homes and small workplaces.' }))).toEqual([]);
  });

  it('never names a sample contact detail, which the export reviews, however it is written', () => {
    const s = business();
    expect(samples(s).some((d) => [SAMPLE_CONTACT.email, SAMPLE_CONTACT.phone, SAMPLE_CONTACT.address].some((v) => d.message.includes(v)))).toBe(false);
    // Marked sample defaults that are the sample details, as the review finds them, are its to name; a mailbox that only
    // ends like the sample one is no sample detail, and is named here.
    const { s: own, node } = withSamples();
    const of = (st: ProjectState) => samples(st).filter((d) => (placeOf(d) as { prop?: string }).prop === 'email');
    expect(of(own)).toEqual([]);
    /** The design's sample email made `value`, which the placement shows as its default. */
    const starting = (value: string) => {
      const marked = structuredClone(own);
      const def = marked.components[node.definitionId];
      def.properties.email = { ...def.properties.email, default: value } as typeof def.properties.email;
      delete (marked.pages[marked.site.homePageId].nodes[node.id] as InstanceNode).props.email;
      return marked;
    };
    for (const value of ['Call +1 (555) 0134 today', '12 Harbor Lane,Millbrook']) expect(of(starting(value)), value).toEqual([]);
    expect(of(starting('myhello@example.com'))).toHaveLength(1);
    // Only on the pages, and the shared header and footer a page shows, which the export reviews: in a footer only
    // other pages show (a collection's index, say), or a collection's layout, which it does not, the email is named here.
    const footer = (st: ProjectState) => sampleContentDiagnostics(st, st, [{ owner: { kind: 'shell', id: 'footer' }, tree: st.pages[st.site.homePageId], label: 'Footer' }], freshKeeper(st)).filter((d) => (placeOf(d) as { prop?: string }).prop === 'email');
    expect(footer(own)).toEqual([]);
    const hidden = structuredClone(own);
    for (const pg of Object.values(hidden.pages)) pg.showFooter = false;
    expect(footer(hidden)).toHaveLength(1);
    const page = own.pages[own.site.homePageId];
    const inLayout = sampleContentDiagnostics(own, own, [{ owner: { kind: 'template', id: 'notes' }, tree: page, label: 'Notes layout' }], freshKeeper(own));
    expect(inLayout.filter((d) => (placeOf(d) as { prop?: string }).prop === 'email').map((d) => d.message)).toEqual([
      `Notes layout: Samples’ Email still shows the sample text its design starts with, “${SAMPLE_CONTACT.email}”. Write your own, or keep it as it is.`
    ]);
  });
});

/** Change a placement's values where a finding names it. */
function setPropsAt(s: ProjectState, d: Diagnostic, props: Record<string, unknown>): ProjectState {
  return setProps(s, d.nodeId!, props, d.owner as OwnerRef);
}

describe('the Component showcase', () => {
  it('names none of what it placed on purpose, and what the author adds to it', () => {
    const s = business();
    const showcase = createStarterState('showcase', 'Showcase', true);
    for (const a of STARTER_ASSETS) showcase.assets.assets[a.id] = structuredClone(s.assets.assets[a.id]);
    const fixtures = new Set(sampleFixtures(showcase));
    const def = sampleDesign(showcase);
    const shown = validateState(showcase);
    // Its own placements show the sample photos, which the exemption alone keeps out of Project health.
    expect(shown.filter((d) => d.code === 'SAMPLE_STARTER_PHOTO').length).toBeGreaterThan(0);
    expect(withoutKeptSamples(shown, new Set(), fixtures).filter((d) => d.code.startsWith('SAMPLE_'))).toEqual([]);
    const added = makeInstance(def);
    showcase.pages[showcase.site.homePageId].nodes[added.id] = added;
    showcase.pages[showcase.site.homePageId].rootIds.push(added.id);
    const after = withoutKeptSamples(validateState(showcase), new Set(), fixtures).filter((d) => d.code.startsWith('SAMPLE_'));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((d) => d.nodeId === added.id)).toBe(true);
    void s;
  });
});

describe('keeping sample content as it is', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('leaves the project’s diagnostics, which Project health and the AI read, for that value at that place alone', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-sample-keep-')));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, createStarterState('business', 'Keep Studio', false));
    try {
      const all = session.diagnostics();
      // Nothing kept: the very list validation made.
      expect(session.diagnostics()).toBe(all);
      const found = all.filter((d) => d.code === 'SAMPLE_STARTER_COPY');
      const [first, second] = found;
      session.keepSamples([keptSampleKey(first)], []);
      const left = session.diagnostics();
      expect(left).not.toContainEqual(first);
      expect(left).toContainEqual(second);
      expect(left).toHaveLength(all.length - 1);
      // A kept value written over and then back is still kept; another value at the same place is named again.
      const node = first.nodeId!;
      const prop = (placeOf(first) as { prop: string }).prop;
      const owner = first.owner as OwnerRef;
      const tree = session.state.pages[owner.id];
      const was = (tree.nodes[node] as InstanceNode).props[prop];
      await session.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: node, prop, value: 'Our own words' }] }, { label: 'Edit', source: 'user' });
      // Only sample findings have a place: another finding on the same section (#1633's) has none.
      expect(session.diagnostics().some((d) => d.nodeId === node && (placeOf(d) as { prop?: string } | null)?.prop === prop)).toBe(false);
      await session.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: node, prop, value: was }] }, { label: 'Edit back', source: 'user' });
      expect(session.diagnostics()).not.toContainEqual(first);
      // Another sample value at that place is named again: an eyebrow kept as "About" set to the starter's "Contact".
      const eyebrow = session.diagnostics().find((d) => d.code === 'SAMPLE_STARTER_COPY' && / Eyebrow still shows sample text, “About”/.test(d.message))!;
      session.keepSamples([keptSampleKey(first), keptSampleKey(eyebrow)], []);
      expect(session.diagnostics()).not.toContainEqual(eyebrow);
      await session.apply({ operations: [{ type: 'instance.setProp', owner: eyebrow.owner as OwnerRef, nodeId: eyebrow.nodeId!, prop: 'eyebrow', value: 'Contact' }] }, { label: 'Edit', source: 'user' });
      expect(session.diagnostics().some((d) => d.nodeId === eyebrow.nodeId && / Eyebrow still shows sample text, “Contact”/.test(d.message))).toBe(true);
      // The showcase's own placements, remembered as it is made, are never named.
      session.keepSamples([], sampleFixtures(session.state));
      expect(session.diagnostics().filter((d) => d.code.startsWith('SAMPLE_') && d.nodeId)).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
