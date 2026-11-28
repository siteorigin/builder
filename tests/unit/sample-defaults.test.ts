/**
 * Sample defaults (issue #1639): a design marks which of its defaults are sample content to replace or keep, the mark
 * survives the authoring DSL and the schema check every authored definition goes through, and a theme update that
 * only adds such marks changes nothing a placement holds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentDefinition, InstanceNode, ListProp, ObjectProp, ProjectState, StringProp, TableProp } from '@shared/types';
import { sampleDefaultProblem } from '@shared/sample-defaults';
import { P, item, prop } from '@catalogue/dsl';
import { listThemes, registerPacks } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { normalizePropSchema } from '@engine/schema';
import { EngineError } from '@engine/tree';
import { contractConflicts, themeUpdates } from '@engine/theme-updates';
import { definitionHash } from '@shared/migrations';
import { foundationDesign, restorePacks } from './fixtures/packs';

const table = (): TableProp => ({ type: 'table', label: 'Specs', default: { columns: [{ id: 'col_a', label: 'Size' }], rows: [{ id: 'row_a', cells: { col_a: 'Large' } }] } });

describe('marking sample defaults in the authoring DSL', () => {
  it('marks a text, rich text, list or table as sample content without changing the schema it was given', () => {
    const label = P.str('Label', 'Search');
    const marked = P.sample(label);
    expect(marked).toEqual({ ...label, sampleDefault: true });
    expect(label.sampleDefault).toBeUndefined();
    expect(P.sample(P.rich('Intro', ['Tell visitors what you do.'])).sampleDefault).toBe(true);
    expect(P.sample(table()).sampleDefault).toBe(true);
    // A mark composes with the other wrappers, in either order.
    expect(P.required(P.sample(P.str('Headline', 'Gardens planted to last')))).toMatchObject({ required: true, sampleDefault: true });
    expect(P.sample(P.required(P.str('Headline', 'Gardens planted to last')))).toEqual({ type: 'string', label: 'Headline', default: 'Gardens planted to last', required: true, sampleDefault: true });
    expect(P.group('Copy', { headline: P.sample(P.text('Headline', 'Gardens')) }).headline).toMatchObject({ group: 'Copy', sampleDefault: true });
  });

  it('marks a list’s starting items apart from what a field holds in a newly added item', () => {
    const seeded = P.sample(P.list('Plans', 'Plan', { name: P.str('Name', 'Plan'), period: P.str('Period', 'Monthly') }, [{ name: 'Starter', period: 'Monthly' }]));
    expect(seeded.sampleDefault).toBe(true);
    expect(seeded.default).toEqual([{ id: 'item-1', name: 'Starter', period: 'Monthly' }]);
    expect(seeded.fields.name.sampleDefault).toBeUndefined();
    // Both at once: the starting items, and what a new item's name starts as.
    const both = P.sample(P.list('Plans', 'Plan', { name: P.sample(P.str('Name', 'New plan')), period: P.str('Period', 'Monthly') }, [{ name: 'Starter', period: 'Monthly' }]));
    expect(both).toMatchObject({ sampleDefault: true, fields: { name: { sampleDefault: true, default: 'New plan' } }, default: [{ id: 'item-1', name: 'Starter', period: 'Monthly' }] });
    expect(both.fields.period.sampleDefault).toBeUndefined();
    const stub = P.list('Plans', 'Plan', { name: P.sample(P.str('Name', 'New plan')), period: P.str('Period', 'Monthly') }, []);
    expect(stub.sampleDefault).toBeUndefined();
    expect(stub.fields.name.sampleDefault).toBe(true);
    expect(stub.fields.period.sampleDefault).toBeUndefined();
  });

  it('marks an object field by field, with its default still built from them', () => {
    const action = P.object('Action', { label: P.sample(P.str('Label', 'Book a visit')), note: P.sample(P.rich('Note', ['No obligation.'])), link: P.link('Link') });
    expect(action.sampleDefault).toBeUndefined();
    expect(action.fields.label.sampleDefault).toBe(true);
    expect(action.fields.note.sampleDefault).toBe(true);
    expect(action.fields.link.sampleDefault).toBeUndefined();
    expect(action.default).toEqual({ label: 'Book a visit', note: P.rich('Note', ['No obligation.']).default, link: { type: 'none', target: '' } });
  });
});

describe('checking a sample-default mark', () => {
  it('accepts a mark where it can stand and says why it cannot elsewhere', () => {
    for (const type of ['string', 'richtext', 'list', 'table']) expect(sampleDefaultProblem({ type, sampleDefault: true }), type).toBeNull();
    for (const type of ['string', 'richtext']) expect(sampleDefaultProblem({ type, sampleDefault: true }, true), type).toBeNull();
    // No mark is never a problem, whatever the type.
    expect(sampleDefaultProblem({ type: 'number' })).toBeNull();
    for (const v of [false, 'true', 1, null]) expect(sampleDefaultProblem({ type: 'string', sampleDefault: v }), String(v)).toMatch(/must be true, or left out/);
    for (const type of ['number', 'boolean', 'enum', 'link', 'image', 'icon', 'choices', 'token']) expect(sampleDefaultProblem({ type, sampleDefault: true }), type).toMatch(/only a text, rich text, list or table property/);
    expect(sampleDefaultProblem({ type: 'object', sampleDefault: true })).toMatch(/mark its text fields instead/);
    expect(sampleDefaultProblem({ type: 'list', sampleDefault: true, feed: 'articles' })).toMatch(/computed list has no items/);
    expect(sampleDefaultProblem({ type: 'list', feed: 'articles', fields: { title: { type: 'string', sampleDefault: true } } })).toMatch(/the field "title" of a computed list/);
    expect(sampleDefaultProblem({ type: 'list', feed: 'articles', fields: { title: { type: 'string' } } })).toBeNull();
    // A feed setting means nothing on any other type, so it never stands in the way of a mark there.
    for (const type of ['string', 'richtext', 'table']) expect(sampleDefaultProblem({ type, sampleDefault: true, feed: 'articles' }), type).toBeNull();
    for (const type of ['boolean', 'number', 'image', 'link', 'list', 'table']) expect(sampleDefaultProblem({ type, sampleDefault: true }, true), type).toMatch(/only a text or rich text field/);
  });
});

describe('a sample-default mark in an authored property schema', () => {
  const state = () => createStarterState('blank', 'Samples', false);
  const refuses = (raw: unknown, reason: RegExp) => {
    expect(() => normalizePropSchema(raw, state(), 'p')).toThrow(EngineError);
    expect(() => normalizePropSchema(raw, state(), 'p')).toThrow(reason);
  };

  it('keeps the mark on a text, rich text, list and table, and on the text fields of a list or object', () => {
    const s = state();
    expect(normalizePropSchema({ type: 'string', label: 'Headline', default: 'Gardens', sampleDefault: true }, s, 'headline')).toMatchObject({ default: 'Gardens', sampleDefault: true });
    expect(normalizePropSchema({ type: 'richtext', label: 'Intro', sampleDefault: true }, s, 'intro').sampleDefault).toBe(true);
    expect(normalizePropSchema({ ...table(), sampleDefault: true }, s, 'specs')).toEqual({ ...table(), sampleDefault: true });
    const plans = normalizePropSchema({ type: 'list', label: 'Plans', sampleDefault: true, fields: { name: { type: 'string', label: 'Name', default: 'New plan', sampleDefault: true }, period: { type: 'string', label: 'Period', default: 'Monthly' } }, default: [{ name: 'Starter' }] }, s, 'plans') as ListProp;
    expect(plans.sampleDefault).toBe(true);
    expect(plans.fields.name.sampleDefault).toBe(true);
    expect(plans.fields.period.sampleDefault).toBeUndefined();
    const action = normalizePropSchema({ type: 'object', label: 'Action', fields: { label: { type: 'string', label: 'Label', default: 'Book', sampleDefault: true }, link: { type: 'link', label: 'Link' } } }, s, 'action') as ObjectProp;
    expect(action.sampleDefault).toBeUndefined();
    expect((action.fields.label as StringProp).sampleDefault).toBe(true);
  });

  it('drops a mark of false, as it does any setting left at its default', () => {
    expect('sampleDefault' in normalizePropSchema({ type: 'string', label: 'Search', default: 'Search', sampleDefault: false }, state(), 'search')).toBe(false);
    const list = normalizePropSchema({ type: 'list', label: 'Plans', sampleDefault: false, fields: { name: { type: 'string', label: 'Name', default: 'Plan', sampleDefault: false } }, default: [{ name: 'Starter' }] }, state(), 'plans') as ListProp;
    expect('sampleDefault' in list).toBe(false);
    expect('sampleDefault' in list.fields.name).toBe(false);
    expect(list.default).toMatchObject([{ name: 'Starter' }]);
    expect(list.fields.name.default).toBe('Plan');
  });

  it('refuses a malformed mark, or one on a property or field that holds no copy', () => {
    refuses({ type: 'string', label: 'Headline', sampleDefault: 'yes' }, /sampleDefault must be true or false/);
    refuses({ type: 'number', label: 'Count', sampleDefault: true }, /only a text, rich text, list or table property/);
    refuses({ type: 'object', label: 'Action', sampleDefault: true, fields: { label: { type: 'string', label: 'Label' } } }, /mark its text fields instead/);
    const posts = (title: Record<string, unknown> = {}) => ({ type: 'list', label: 'Posts', feed: 'articles', fields: { title: { type: 'string', label: 'Title', ...title }, pageLink: { type: 'link', label: 'Link' } } });
    expect(normalizePropSchema(posts(), state(), 'posts')).toMatchObject({ feed: 'articles' });
    refuses({ ...posts(), sampleDefault: true }, /computed list has no items/);
    refuses(posts({ sampleDefault: true }), /the field "title" of a computed list/);
    refuses({ type: 'object', label: 'Action', fields: { label: { type: 'string', label: 'Label' }, link: { type: 'link', label: 'Link', sampleDefault: true } } }, /p\.link.*only a text or rich text field/);
    refuses({ type: 'list', label: 'Gallery', fields: { image: { type: 'image', label: 'Image', sampleDefault: true } } }, /p\.image.*only a text or rich text field/);
  });

  it('leaves the mark off a collection’s fields, whose entries are all written by their authors', () => {
    const s = applyOperations(state(), [
      { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', fields: { role: { type: 'string', label: 'Role', default: 'Designer', sampleDefault: true }, bio: { type: 'richtext', label: 'Bio', default: 'Joined in spring.', sampleDefault: true } } } as never
    ]).state;
    const team = s.collections.team.settings;
    expect(team.fields.role).toMatchObject({ type: 'string', default: 'Designer' });
    expect('sampleDefault' in team.fields.role).toBe(false);
    expect(team.fields.bio).toMatchObject({ type: 'richtext' });
    expect((team.fields.bio as { default: unknown }).default).not.toEqual([]);
    expect('sampleDefault' in team.fields.bio).toBe(false);
  });
});

describe('a theme update that marks sample defaults', () => {
  afterEach(() => restorePacks());

  /** A pricing section, its headline, plans and call to action marked as sample content when `marked`. */
  const plans = (marked: boolean): ComponentDefinition => {
    const mark = <T extends StringProp | ListProp>(p: T): T => (marked ? P.sample(p) : p);
    return foundationDesign({
      componentId: 'test.plans',
      name: 'Plans',
      properties: {
        heading: mark(P.str('Heading', 'Plans for every garden')),
        plans: mark(P.list('Plans', 'Plan', { name: mark(P.str('Name', 'New plan')), period: P.str('Period', 'Monthly') }, [{ name: 'Starter', period: 'Monthly' }, { name: 'Estate', period: 'Yearly' }], { titleField: 'name' })),
        action: P.object('Action', { label: mark(P.str('Label', 'Book a visit')), link: P.link('Link') })
      },
      parts: {
        root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
        card: { nodeId: 'card', label: 'Plan', styleControls: ['background'] }
      },
      build: (b) =>
        b.el('root', 'section', { name: 'Section' }, [
          b.text('heading', 'h2', prop('heading'), { name: 'Heading' }),
          b.el('list', 'ul', { name: 'Plans' }, [
            b.repeat('rows', 'plans', [b.el('card', 'li', { name: 'Plan' }, [b.text('name', 'h3', item('name'), { name: 'Name' }), b.text('period', 'p', item('period'), { name: 'Period' })])])
          ])
        ])
    });
  };
  /** Foundation, as registered, offering this version of the design. */
  const offer = (def: ComponentDefinition) =>
    registerPacks(listThemes().map((t) => (t.id === 'foundation' ? { ...t, components: [...t.components.filter((c) => c.id !== def.id), def] } : t)));

  /** A project with the unmarked design installed and placed twice: once with its own plans, once showing the defaults. */
  function project(marked = false): { state: ProjectState; id: string } {
    offer(plans(marked));
    const state = createStarterState('business', 'Samples', false);
    const id = installComponent(state, 'test.plans');
    const def = state.components[id];
    const own = makeInstance(def, { heading: 'Our prices', plans: [{ id: 'i_own', name: 'Hedge care', period: 'Weekly' }], action: { label: 'Call us', link: { type: 'none', target: '' } } });
    const ownId = (own.props.plans as Array<{ id: string }>)[0].id;
    own.itemOverrides = { card: { list: 'plans', items: { [ownId]: { base: { background: '#dbeeff' } } } } };
    const inherited = makeInstance(def);
    delete inherited.props.plans;
    inherited.itemOverrides = { card: { list: 'plans', items: { 'item-2': { base: { background: '#ffe9db' } } } } };
    const home = state.pages[state.site.homePageId];
    for (const n of [own, inherited]) {
      home.nodes[n.id] = n;
      home.rootIds.push(n.id);
    }
    return { state, id };
  }

  it('reports no conflict and refreshes the definition, leaving every placed value, item ID and item style alone', () => {
    const { state, id } = project();
    const before = state.components[id];
    const next = plans(true);
    offer(next);
    expect(contractConflicts(state, before, next)).toEqual([]);
    expect(themeUpdates(state).available.map((u) => u.id)).toContain(id);
    const pages = JSON.stringify(state.pages);
    expect(state.themeLock.components[id].hash).toBe(definitionHash(before));
    const { state: after, results } = applyOperations(state, [{ type: 'theme.refresh', definitionIds: [id] }]);
    expect(results[0].updated).toEqual([id]);
    expect(after.themeLock.components[id].hash).toBe(definitionHash(next));
    expect(after.themeLock.components[id].hash).not.toBe(definitionHash(before));
    const props = after.components[id].properties as { heading: StringProp; plans: ListProp; action: ObjectProp };
    expect(props.heading.sampleDefault).toBe(true);
    expect(props.plans.sampleDefault).toBe(true);
    expect(props.plans.fields.name.sampleDefault).toBe(true);
    expect((props.action.fields.label as StringProp).sampleDefault).toBe(true);
    // The default items keep their IDs, so the placement showing them keeps its style on the second.
    expect(props.plans.default.map((i) => i.id)).toEqual(['item-1', 'item-2']);
    expect(JSON.stringify(after.pages)).toBe(pages);
    const placed = after.pages[after.site.homePageId].rootIds.map((n) => after.pages[after.site.homePageId].nodes[n] as InstanceNode).filter((n) => n.definitionId === id);
    expect(placed.map((n) => Object.keys(n.itemOverrides!.card.items))).toEqual([[(placed[0].props.plans as Array<{ id: string }>)[0].id], ['item-2']]);
    expect(themeUpdates(after).available.map((u) => u.id)).not.toContain(id);
  });

  it('refreshes a marked definition to one that takes the marks off, leaving placements alone', () => {
    const { state, id } = project(true);
    const before = state.components[id];
    expect((before.properties.heading as StringProp).sampleDefault).toBe(true);
    const next = plans(false);
    offer(next);
    expect(contractConflicts(state, before, next)).toEqual([]);
    const pages = JSON.stringify(state.pages);
    const { state: after, results } = applyOperations(state, [{ type: 'theme.refresh', definitionIds: [id] }]);
    expect(results[0].updated).toEqual([id]);
    const props = after.components[id].properties as { heading: StringProp; plans: ListProp; action: ObjectProp };
    expect(props.heading.sampleDefault).toBeUndefined();
    expect(props.plans.sampleDefault).toBeUndefined();
    expect(props.plans.fields.name.sampleDefault).toBeUndefined();
    expect(props.action.fields.label.sampleDefault).toBeUndefined();
    expect(props.plans.default.map((i) => i.id)).toEqual(['item-1', 'item-2']);
    expect(after.themeLock.components[id].hash).toBe(definitionHash(next));
    expect(JSON.stringify(after.pages)).toBe(pages);
  });
});
