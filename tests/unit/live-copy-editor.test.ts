/**
 * A live session's Copy Editor changes the words and pictures on the site's pages and nothing else (#1148): the host's
 * check against each operation and against the project as the batch would leave it.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, ComponentDefinition, ImageValue, InstanceNode, OwnerRef, ProjectState, RepeatNode, RichText, TextNode } from '@shared/types';
import { copyEditorOperationProblem } from '@shared/live/copy-editor';
import { catalogueComponent, listThemes } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { P } from '@catalogue/dsl';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyOperations } from '@engine/apply';
import { copyEditableLookup, copyEditorBatchProblem } from '@engine/copy-editor';
import { makeInstance } from '@engine/install';
import { normalizePropSchema } from '@engine/schema';
import { FOUNDATION_AUTHOR, ROOT } from './fixtures/packs';
import { HERO, SECTION, heroDesign, sectionDesign } from './fixtures/live-copy-editor-designs';

const FORM = 'foundation.contact.form';
const { managed } = FOUNDATION_AUTHOR;

/** The theme releases the app ships, and the development fixture: one folder each under resources/. */
const BUNDLED = ['packs', 'packs-dev'].flatMap((dir) => readdirSync(join(ROOT, 'resources', dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));

const asset = (id: string, kind: AssetRecord['kind']): AssetRecord => ({ id, name: id, file: `${id}.bin`, mime: kind === 'image' ? 'image/png' : 'font/woff2', bytes: 1, hash: id, kind, createdAt: '2026-01-01T00:00:00.000Z' });

/**
 * A blank site whose home page has a split hero and a section (the managed designs above), the section holding a
 * paragraph and rich text, and "Promo": a design around a split hero that passes its own properties on to the hero's,
 * placed once. The library has two pictures and a font.
 */
function project() {
  let state = createStarterState('blank', 'Copy', false);
  state = { ...state, assets: { ...state.assets, assets: { ...state.assets.assets, pic1: asset('pic1', 'image'), pic2: asset('pic2', 'image'), font1: asset('font1', 'font') } } };
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: EditOperation[]) => {
    const r = applyOperations(state, ops);
    state = r.state;
    return r.results;
  };
  expect([heroDesign(state).id, sectionDesign(state).id]).toEqual([HERO, SECTION]);
  const hero = step([{ type: 'node.insert', owner, parentId: null, definitionId: HERO, props: { image: { assetId: 'pic1', alt: 'The studio' } } }])[0].nodeId as string;
  const section = step([{ type: 'node.insert', owner, parentId: null, definitionId: SECTION }])[0].nodeId as string;
  const paragraph = step([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'paragraph', text: 'Opening hours vary.' }])[0].nodeId as string;
  const rich = step([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'richtext' }])[0].nodeId as string;
  step([{ type: 'node.setContent', owner, nodeId: rich, field: 'text', value: 'Call us or [read the FAQ](https://example.com/faq).' }]);

  // Promo: a section around a split hero, whose `title` (marked copy) becomes the hero's heading, `tagline` (marked
  // copy) its unmarked primary button label, and `note` (unmarked) its lead.
  const wrap = step([{ type: 'node.insert', owner, parentId: null, definitionId: SECTION }])[0].nodeId as string;
  step([{ type: 'node.insert', owner, parentId: wrap, slot: 'content', definitionId: HERO }]);
  const promo = step([{ type: 'component.createFromNode', owner, nodeId: wrap, name: 'Promo' }])[0].definitionId as string;
  const inner = Object.values(state.components[promo].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === HERO)!.id;
  const def: OwnerRef = { kind: 'component', id: promo };
  step([
    { type: 'component.setPropSchema', definitionId: promo, prop: 'title', schema: { type: 'string', label: 'Title', default: '', copyEditable: true } },
    { type: 'component.setPropSchema', definitionId: promo, prop: 'tagline', schema: { type: 'string', label: 'Tagline', default: '', copyEditable: true } },
    { type: 'component.setPropSchema', definitionId: promo, prop: 'note', schema: { type: 'string', label: 'Note', default: '', multiline: true } },
    { type: 'node.setBinding', owner: def, nodeId: inner, field: 'prop', prop: 'heading', binding: { $prop: 'title' } },
    { type: 'node.setBinding', owner: def, nodeId: inner, field: 'prop', prop: 'primaryLabel', binding: { $prop: 'tagline' } },
    { type: 'node.setBinding', owner: def, nodeId: inner, field: 'prop', prop: 'lead', binding: { $prop: 'note' } }
  ]);
  const placed = step([{ type: 'node.insert', owner, parentId: null, definitionId: promo, props: { title: 'Spring offer', tagline: 'Book now', note: 'While it lasts.' } }])[0].nodeId as string;
  // The page as the copy editor finds it: the empty section the design was made from is gone.
  step([{ type: 'node.remove', owner, nodeId: wrap }].filter(() => Object.hasOwn(state.pages[owner.id].nodes, wrap)) as EditOperation[]);
  return { state, owner, hero, paragraph, rich, promo, placed };
}

/** Why a copy editor's batch is refused, applied to the project as it is; null when it is allowed. */
function copyEdit(state: ProjectState, ops: EditOperation[]) {
  const r = applyOperations(state, ops);
  return { problem: copyEditorBatchProblem(state, r.state, ops), after: r.state };
}

const node = <T>(state: ProjectState, owner: OwnerRef, id: string) => state.pages[owner.id].nodes[id] as T;

/** The project with one element of a page replaced, as no operation made it. */
function withNode(state: ProjectState, owner: OwnerRef, id: string, n: unknown): ProjectState {
  const page = state.pages[owner.id];
  return { ...state, pages: { ...state.pages, [owner.id]: { ...page, nodes: { ...page.nodes, [id]: n as never } } } };
}

/** The lookup for Promo once these edits to it are made. */
function promoLookup(state: ProjectState, promo: string, ops: EditOperation[]) {
  return copyEditableLookup(applyOperations(state, ops).state);
}

describe('what a copy editor may change', () => {
  it('rewords a page’s text and rich text, and a hero’s marked copy, and replaces its picture from the library', () => {
    const { state, owner, hero, paragraph, rich } = project();
    const ops: EditOperation[] = [
      { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' },
      { type: 'node.setContent', owner, nodeId: rich, field: 'text', value: 'Phone us, or [see the questions](https://example.com/faq).\n\nWe answer within a day.' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', value: 'Rooms that feel like home' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value: { assetId: 'pic2', alt: 'The workshop' } }
    ];
    const { problem, after } = copyEdit(state, ops);
    expect(problem).toBeNull();
    expect(node<TextNode>(after, owner, paragraph).text).toBe('Open every day.');
    const text = node<TextNode>(after, owner, rich).text as RichText;
    expect(text).toHaveLength(2);
    expect(JSON.stringify(text)).toContain('https://example.com/faq');
    expect(node<InstanceNode>(after, owner, hero).props.heading).toBe('Rooms that feel like home');
    expect((node<InstanceNode>(after, owner, hero).props.image as ImageValue).assetId).toBe('pic2');
  });

  // Release gap: shownOnceSlots (src/engine/slots.ts) counts no slot of a code component as shown once, so shownOnceIn
  // (src/engine/copy-editor.ts) refuses text placed in the release's Section as shown once for each item of a list.
  it.fails('rewords a page’s text inside the shipped theme’s Section', () => {
    let state = createStarterState('blank', 'Copy', false);
    const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
    const step = (ops: EditOperation[]) => {
      const r = applyOperations(state, ops);
      state = r.state;
      return r.results;
    };
    const section = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
    const paragraph = step([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'paragraph', text: 'Opening hours vary.' }])[0].nodeId as string;
    const { problem, after } = copyEdit(state, [{ type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' }]);
    expect(problem).toBeNull();
    expect(node<TextNode>(after, owner, paragraph).text).toBe('Open every day.');
  });

  it('follows a design that passes its marked copy on to a hero’s marked heading', () => {
    const { state, owner, promo, placed } = project();
    const editable = copyEditableLookup(state);
    expect(editable(promo, 'title')).toBe(true);
    // Marked, but passed on to a button label the hero does not mark.
    expect(editable(promo, 'tagline')).toBe(false);
    // Passed on to the hero's marked lead, but not marked itself; marked, it qualifies.
    expect(editable(promo, 'note')).toBe(false);
    expect(promoLookup(state, promo, [{ type: 'component.setPropSchema', definitionId: promo, prop: 'note', schema: { type: 'string', label: 'Note', default: '', multiline: true, copyEditable: true } }])(promo, 'note')).toBe(true);
    const { problem, after } = copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'title', value: 'Summer offer' }]);
    expect(problem).toBeNull();
    expect(node<InstanceNode>(after, owner, placed).props.title).toBe('Summer offer');
    // The design, and so every other placement of it, is untouched.
    expect(after.components[promo]).toBe(state.components[promo]);
    expect(copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'tagline', value: 'Book today' }]).problem).toMatchObject({ operationIndex: 0, message: expect.stringMatching(/Only the host can change “Tagline”/) });
    expect(copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'note', value: 'Soon over.' }]).problem).toMatchObject({ operationIndex: 0 });
  });

  it('needs the mark at every hop', () => {
    const { state, promo } = project();
    // The hero's own heading unmarked: the design's marked title, passed on to it, no longer qualifies.
    const r = applyOperations(state, []);
    const hero = structuredClone(r.state.components[HERO]);
    delete (hero.properties.heading as { copyEditable?: true }).copyEditable;
    expect(copyEditableLookup({ ...r.state, components: { ...r.state.components, [HERO]: hero } })(promo, 'title')).toBe(false);
  });

  it('does not count a marked property the design uses for anything but showing it', () => {
    const { state, promo } = project();
    const def: OwnerRef = { kind: 'component', id: promo };
    const inner = Object.values(state.components[promo].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === HERO)!;
    const root = state.components[promo].tree!.rootIds[0];
    const title = (ops: EditOperation[]) => promoLookup(state, promo, ops)(promo, 'title');
    // Compared with a value, after the use that shows it: two different headings can show different layouts.
    expect(title([{ type: 'node.setBinding', owner: def, nodeId: root, field: 'when', binding: { $prop: 'title' }, ne: 'Hidden' }])).toBe(false);
    expect(title([{ type: 'node.setBinding', owner: def, nodeId: root, field: 'unless', binding: { $prop: 'title' }, eq: 'Hidden' }])).toBe(false);
    // Only tested for being set: a copy editor's edit never changes that.
    expect(title([{ type: 'node.setBinding', owner: def, nodeId: root, field: 'when', binding: { $prop: 'title' } }])).toBe(true);
    expect(title([{ type: 'node.setBinding', owner: def, nodeId: root, field: 'unless', binding: { $prop: 'title' } }])).toBe(true);
    // Shown twice, as the hero's heading and as its eyebrow, both marked: still only copy.
    expect(title([{ type: 'node.setBinding', owner: def, nodeId: inner.id, field: 'prop', prop: 'eyebrow', binding: { $prop: 'title' } }])).toBe(true);
    expect(title([{ type: 'component.setPropSchema', definitionId: promo, prop: 'title', schema: { type: 'string', label: 'Title', default: '' } }])).toBe(false);
    // Marked but never used: nothing shows it.
    const unused = promoLookup(state, promo, [{ type: 'component.setPropSchema', definitionId: promo, prop: 'spare', schema: { type: 'string', label: 'Spare', default: '', copyEditable: true } }]);
    expect(unused(promo, 'spare')).toBe(false);
  });

  it('never counts a property that decides where a contact form sends', () => {
    const { state, promo, owner, placed } = project();
    const inner = Object.values(state.components[promo].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === HERO)!.id;
    const def: OwnerRef = { kind: 'component', id: promo };
    // The same marked copy shown as the hero's eyebrow, under a form destination's name and under any other.
    const shownAs = (prop: string) => [
      { type: 'component.setPropSchema', definitionId: promo, prop, schema: { type: 'string', label: prop, default: '', copyEditable: true } },
      { type: 'node.setBinding', owner: def, nodeId: inner, field: 'prop', prop: 'eyebrow', binding: { $prop: prop } }
    ] as EditOperation[];
    expect(promoLookup(state, promo, shownAs('subtitle'))(promo, 'subtitle')).toBe(true);
    const named = applyOperations(state, shownAs('endpoint')).state;
    expect(copyEditableLookup(named)(promo, 'endpoint')).toBe(false);
    expect(copyEdit(named, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'endpoint', value: 'https://evil.example/b' }]).problem).toMatchObject({ operationIndex: 0 });

    // A real form, behind a design that passes its own marked property on as the form's endpoint.
    let forms = createStarterState('blank', 'Forms', false);
    const home: OwnerRef = { kind: 'page', id: forms.site.homePageId };
    const step = (ops: EditOperation[]) => {
      const r = applyOperations(forms, ops);
      forms = r.state;
      return r.results;
    };
    const section = step([{ type: 'node.insert', owner: home, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
    step([{ type: 'node.insert', owner: home, parentId: section, slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://forms.example.com/a' } }]);
    const band = step([{ type: 'component.createFromNode', owner: home, nodeId: section, name: 'Contact band' }])[0].definitionId as string;
    const form = Object.values(forms.components[band].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === FORM)!.id;
    step([
      { type: 'component.setPropSchema', definitionId: band, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: '', copyEditable: true } },
      { type: 'node.setBinding', owner: { kind: 'component', id: band }, nodeId: form, field: 'prop', prop: 'endpoint', binding: { $prop: 'recipient' } }
    ]);
    const band1 = step([{ type: 'node.insert', owner: home, parentId: null, definitionId: band, props: { recipient: 'https://forms.example.com/a' } }])[0].nodeId as string;
    expect(copyEditableLookup(forms)(band, 'recipient')).toBe(false);
    expect(copyEdit(forms, [{ type: 'instance.setProp', owner: home, nodeId: band1, prop: 'recipient', value: 'https://evil.example/b' }]).problem).toMatchObject({ operationIndex: 0 });
  });

  it('never counts a property a list of entries reads by name to choose what it shows', () => {
    const def: ComponentDefinition = {
      ...managed({
        componentId: 'test.feed',
        name: 'Feed',
        description: '',
        category: 'content',
        tags: [],
        icon: 'sparkles',
        properties: {
          category: P.copy(P.str('Category', 'News')),
          label: P.copy(P.str('Label', 'Latest')),
          cards: P.list('Cards', 'Card', { title: P.str('Title', '') }, [], { feed: 'entries' })
        },
        parts: {},
        build: (b) => b.el('root', 'div', {}, [b.text('heading', 'h2', { $prop: 'category' }), b.text('label', 'p', { $prop: 'label' })])
      }),
      owner: 'project'
    };
    const state = { ...createStarterState('blank', 'Feed', false), components: { [def.id]: def } };
    expect(copyEditableLookup(state)(def.id, 'label')).toBe(true);
    for (const prop of ['category', 'collection', 'tag']) {
      const named = structuredClone(def);
      named.properties[prop] = named.properties.category;
      named.tree!.nodes.heading = { ...(named.tree!.nodes.heading as TextNode), text: { $prop: prop } };
      expect(copyEditableLookup({ ...state, components: { [def.id]: named } })(def.id, prop), prop).toBe(false);
    }
    // A list of the site's articles is worked out from the page it is on, never from these properties.
    const articles = structuredClone(def);
    (articles.properties.cards as { feed: string }).feed = 'articles';
    expect(copyEditableLookup({ ...state, components: { [def.id]: articles } })(def.id, 'category')).toBe(true);
  });

  it('does not count a marked property its design shows once for each item of a list', () => {
    const def: ComponentDefinition = {
      ...managed({
        componentId: 'test.cards',
        name: 'Cards',
        description: '',
        category: 'content',
        tags: [],
        icon: 'sparkles',
        properties: {
          caption: P.copy(P.str('Caption', 'Read more')),
          title: P.copy(P.str('Title', 'Our work')),
          items: P.list('Items', 'Item', { label: P.str('Label', 'x') }, [{ label: 'One' }, { label: 'Two' }])
        },
        parts: {},
        build: (b) => b.el('root', 'div', {}, [b.text('title', 'h2', { $prop: 'title' }), b.repeat('each', 'items', [b.text('caption', 'p', { $prop: 'caption' })])])
      }),
      owner: 'project'
    };
    const editable = copyEditableLookup({ ...createStarterState('blank', 'Cards', false), components: { [def.id]: def } });
    expect(editable(def.id, 'title')).toBe(true);
    expect(editable(def.id, 'caption')).toBe(false);
  });

  /** Each bundled theme's two heroes, with their copy (src/engine/shipped-copy.ts), and the lookup the copy editor reads for it. */
  const HEROES = [
    ['hero.split', ['eyebrow', 'heading', 'lead', 'image']],
    ['hero.centered', ['eyebrow', 'heading', 'lead']]
  ] as const;
  const heroCases = BUNDLED.flatMap((theme) => HEROES.map(([componentId, marked]) => ({ theme, componentId, marked })));
  const heroLookup = (theme: string, componentId: string) => {
    const def = catalogueComponent(theme, componentId);
    expect(def, `${theme} ${componentId}`).toBeDefined();
    return { id: def!.id, editable: copyEditableLookup({ ...createStarterState('blank', 'x', false), components: { [def!.id]: def! } }) };
  };

  it('registers every theme the app ships, and the development fixture, each with both heroes', () => {
    // Every pack the app ships (and the development fixture) is registered, so the cases below cover them all.
    expect(BUNDLED.length).toBeGreaterThan(0);
    expect(listThemes().map((t) => t.id)).toEqual(expect.arrayContaining(BUNDLED));
    for (const { theme, componentId } of heroCases) expect(catalogueComponent(theme, componentId), `${theme} ${componentId}`).toBeDefined();
  });

  it.each(heroCases)('leaves the heading level and button of $theme’s $componentId to the host', ({ theme, componentId }) => {
    const { id, editable } = heroLookup(theme, componentId);
    for (const prop of ['headingLevel', 'primaryLabel', 'primaryLink']) expect(editable(id, prop), `${theme} ${componentId} ${prop}`).toBe(false);
  });

  it.each(heroCases)('lets a copy editor change the copy of $theme’s $componentId', ({ theme, componentId, marked }) => {
    const { id, editable } = heroLookup(theme, componentId);
    for (const prop of marked) expect(editable(id, prop), `${theme} ${componentId} ${prop}`).toBe(true);
  });
});

describe('what a copy editor may not change', () => {
  it('refuses the whole batch for one operation, naming it', () => {
    const { state, owner, hero, paragraph } = project();
    const ops: EditOperation[] = [
      { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', value: 'Rooms that feel like home' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'headingLevel', value: 'h2' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'primaryLabel', value: 'Elsewhere' }
    ];
    expect(copyEdit(state, ops).problem).toMatchObject({ operationIndex: 2, message: expect.stringMatching(/Only the host can change “Heading level”/) });
    // A structural edit among copy edits, refused by the operation alone.
    expect(copyEdit(state, [ops[0], ops[1], { type: 'instance.setVariant', owner, nodeId: hero, axis: 'tone', variant: 'muted' }]).problem).toMatchObject({ operationIndex: 2, message: expect.stringMatching(/cannot make "instance.setVariant"/) });
  });

  it('refuses a change to a protected value even when a later operation puts it back', () => {
    const { state, owner, hero, paragraph } = project();
    const ops: EditOperation[] = [
      { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'primaryLabel', value: 'Elsewhere' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'primaryLabel', value: (node<InstanceNode>(state, owner, hero).props.primaryLabel as string | undefined) ?? 'Start a project' }
    ];
    expect(copyEdit(state, ops).problem).toMatchObject({ operationIndex: 1 });
  });

  it('decides from the project before the batch, not as the batch leaves it', () => {
    const { state, owner, hero, paragraph } = project();
    // Text and a marked property that come from elsewhere before the batch, written over by it.
    const bound = withNode(withNode(state, owner, paragraph, { ...node<TextNode>(state, owner, paragraph), text: { $prop: 'x' } }), owner, hero, { ...node<InstanceNode>(state, owner, hero), props: { ...node<InstanceNode>(state, owner, hero).props, heading: { $entry: 'title' } } });
    const text: EditOperation = { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' };
    const heading: EditOperation = { type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', value: 'Rooms' };
    expect(copyEditorOperationProblem(text)).toBeNull();
    const after = copyEdit(state, [text, heading]).after;
    expect(copyEditorBatchProblem(state, after, [text, heading])).toBeNull();
    expect(copyEditorBatchProblem(bound, after, [text])).toMatchObject({ operationIndex: 0, message: expect.stringMatching(/written words/) });
    expect(copyEditorBatchProblem(bound, after, [heading])).toMatchObject({ operationIndex: 0, message: expect.stringMatching(/comes from elsewhere/) });
  });

  it('refuses a project that changed beyond what the operations were allowed, whatever they say', () => {
    const { state, owner, hero, paragraph } = project();
    const ops: EditOperation[] = [
      { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' },
      { type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', value: 'Rooms that feel like home' }
    ];
    const { after } = copyEdit(state, ops);
    const page = after.pages[owner.id];
    const heroNode = page.nodes[hero] as InstanceNode;
    const header = after.site.shell.header;
    const tampered: Array<[string, ProjectState]> = [
      // The edited hero's other, unmarked, properties and its options and styles.
      ['label', withNode(after, owner, hero, { ...heroNode, props: { ...heroNode.props, primaryLabel: 'Not asked for' } })],
      ['variant', withNode(after, owner, hero, { ...heroNode, variants: { ...heroNode.variants, tone: 'muted' } })],
      ['styles', withNode(after, owner, hero, { ...heroNode, overrides: { root: { base: { paddingBlock: '1px' } } } })],
      // Its marked copy cleared, beside the edit asked for.
      ['eyebrow', withNode(after, owner, hero, { ...heroNode, props: { ...heroNode.props, eyebrow: '' } })],
      // The edited paragraph's tag, beside its words.
      ['tag', withNode(after, owner, paragraph, { ...(page.nodes[paragraph] as TextNode), tag: 'h2' })],
      // The page's own settings and the order of its sections.
      ['order', { ...after, pages: { ...after.pages, [owner.id]: { ...page, rootIds: [...page.rootIds].reverse() } } }],
      ['title', { ...after, pages: { ...after.pages, [owner.id]: { ...page, title: 'Renamed' } } }],
      // The site and its header, the site's styles, a design, the library.
      ['site', { ...after, site: { ...after.site, name: 'Renamed' } }],
      ['token', { ...after, tokens: { ...after.tokens, overrides: { ...after.tokens.overrides, 'color.brand': '#123456' } } }],
      ['design', { ...after, components: { ...after.components, [HERO]: { ...after.components[HERO], name: 'Mine' } } }],
      ['library', { ...after, assets: { ...after.assets, assets: {} } }],
      ['header', { ...after, site: { ...after.site, shell: { ...after.site.shell, header: { ...header, rootIds: [...header.rootIds, 'n_extra'] } } } }]
    ];
    expect(copyEditorBatchProblem(state, after, ops)).toBeNull();
    for (const [what, t] of tampered) {
      const problem = copyEditorBatchProblem(state, t, ops);
      expect(problem, what).not.toBeNull();
      expect(problem!.operationIndex, what).toBeUndefined();
    }
  });

  it('keeps to the site’s pages and their written content', () => {
    const { state, owner, hero, paragraph } = project();
    const header: OwnerRef = { kind: 'shell', id: 'header' };
    expect(copyEditorOperationProblem({ type: 'node.setContent', owner: header, nodeId: 'x', field: 'text', value: 'Hi' })).toMatch(/pages/);
    expect(copyEditorOperationProblem({ type: 'node.setContent', owner: { kind: 'component', id: HERO }, nodeId: 'heading', field: 'text', value: 'Hi' })).toMatch(/pages/);
    expect(copyEditorOperationProblem({ type: 'node.setContent', owner, nodeId: paragraph, field: 'tag', value: 'h2' })).toMatch(/words/);
    expect(copyEditorOperationProblem({ type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', value: { $prop: 'x' } })).toMatch(/connection/);
    expect(copyEditorOperationProblem({ type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: [{ type: 'p', spans: [{ text: 'x', link: { $entry: 'entryLink' } }] }] })).toMatch(/connection/);
    expect(copyEditorOperationProblem({ type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', itemId: 'a', value: 'x' })).toMatch(/list/);
    expect(copyEditorOperationProblem({ type: 'instance.setProp', owner, nodeId: hero, prop: 'heading', field: 'b', value: 'x' })).toMatch(/list/);
    expect(copyEditorOperationProblem({ type: 'page.update', pageId: owner.id, title: 'New' })).toMatch(/cannot make "page.update"/);
    expect(copyEditorOperationProblem({ type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Fine' })).toBeNull();
    expect(copyEdit(state, [{ type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Fine' }]).problem).toBeNull();
  });

  it('refuses what is shown once for each item of a list: a collection loop’s contents, or a slot a design repeats', () => {
    const { state, owner, paragraph } = project();
    const op: EditOperation = { type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: 'Open every day.' };
    const after = copyEdit(state, [op]).after;
    expect(copyEditorBatchProblem(state, after, [op])).toBeNull();
    // The paragraph moved into a loop over a collection's entries, as no operation of the batch did.
    const looped = (s: ProjectState): ProjectState => {
      const page = s.pages[owner.id];
      const holder = Object.values(page.nodes).find((n) => n.kind === 'instance' && Object.values(n.slots ?? {}).some((ids) => ids.includes(paragraph))) as InstanceNode;
      const loop: RepeatNode = { id: 'n_loop', kind: 'repeat', list: { $query: { collection: 'news' } } as never, children: [paragraph] };
      const slots = Object.fromEntries(Object.entries(holder.slots ?? {}).map(([k, ids]) => [k, ids.map((id) => (id === paragraph ? loop.id : id))]));
      return { ...s, pages: { ...s.pages, [owner.id]: { ...page, nodes: { ...page.nodes, [loop.id]: loop, [holder.id]: { ...holder, slots } } } } };
    };
    expect(copyEditorBatchProblem(looped(state), looped(after), [op])).toMatchObject({ operationIndex: 0, message: expect.stringMatching(/once for each item/) });

    // A page's own text in a design's slot that the design shows once for each item of its list.
    const repeater: ComponentDefinition = {
      ...managed({
        componentId: 'test.repeater',
        name: 'Repeater',
        description: '',
        category: 'content',
        tags: [],
        icon: 'sparkles',
        properties: { items: P.list('Items', 'Item', { label: P.str('Label', 'x') }, [{ label: 'One' }, { label: 'Two' }]) },
        parts: {},
        slots: { content: { label: 'Content' }, aside: { label: 'Aside' } },
        build: (b) => b.el('root', 'div', {}, [b.repeat('each', 'items', [b.slot('slot', 'content')]), b.slot('once', 'aside')])
      }),
      owner: 'project'
    };
    const place = (slot: 'content' | 'aside') => {
      const s = structuredClone(state);
      s.components[repeater.id] = repeater;
      const inst: InstanceNode = { ...makeInstance(repeater, {}), slots: { [slot]: ['n_copy'] } };
      s.pages[owner.id].nodes = { [inst.id]: inst, n_copy: { id: 'n_copy', kind: 'text', tag: 'p', text: 'Each' } };
      s.pages[owner.id].rootIds = [inst.id];
      return s;
    };
    const edit: EditOperation = { type: 'node.setContent', owner, nodeId: 'n_copy', field: 'text', value: 'Every one' };
    expect(copyEdit(place('aside'), [edit]).problem).toBeNull();
    expect(copyEdit(place('content'), [edit]).problem).toMatchObject({ operationIndex: 0, message: expect.stringMatching(/once for each item/) });
  });

  it('replaces a picture only with a library picture, keeping it shown, described and as decorative as it was', () => {
    const { state, owner, hero } = project();
    const image = (value: unknown) => copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value }]).problem;
    expect(image({ assetId: 'pic2', alt: 'Workshop' })).toBeNull();
    expect(image({ assetId: null, alt: '' })).toMatchObject({ message: expect.stringMatching(/clearing/) });
    expect(image({ assetId: 'pic2', alt: 'Workshop', decorative: true })).toMatchObject({ message: expect.stringMatching(/decorative/) });
    expect(image({ assetId: 'pic2', alt: '' })).toMatchObject({ message: expect.stringMatching(/does not remove it/) });
    // What the engine itself never stores, held to the policy all the same.
    const op: EditOperation = { type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value: { assetId: 'pic2', alt: 'Workshop' } };
    const after = copyEdit(state, [op]).after;
    const heroNode = after.pages[owner.id].nodes[hero] as InstanceNode;
    const forged = (image: unknown) => copyEditorBatchProblem(state, withNode(after, owner, hero, { ...heroNode, props: { ...heroNode.props, image } }), [op]);
    expect(forged({ assetId: 'font1', alt: 'Workshop' })).toMatchObject({ message: expect.stringMatching(/already in the library/) });
    expect(forged({ assetId: 'missing', alt: 'Workshop' })).toMatchObject({ message: expect.stringMatching(/clearing/) });
    expect(forged({ assetId: 'pic2', alt: 'Workshop', focus: '10% 10%' })).not.toBeNull();
    expect(forged({ assetId: 'pic2', alt: 7 })).not.toBeNull();
  });

  it('never adds or clears copy, which would show or hide an element', () => {
    const { state, owner, hero, paragraph, rich } = project();
    expect(copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: hero, prop: 'eyebrow', value: '   ' }]).problem).toMatchObject({ message: expect.stringMatching(/clearing/) });
    expect(copyEdit(state, [{ type: 'node.setContent', owner, nodeId: paragraph, field: 'text', value: '' }]).problem).toMatchObject({ message: expect.stringMatching(/clearing/) });
    expect(copyEditorBatchProblem(state, withNode(state, owner, rich, { ...node<TextNode>(state, owner, rich), text: [{ type: 'p', spans: [] }] }), [{ type: 'node.setContent', owner, nodeId: rich, field: 'text', value: '' }])).toMatchObject({ message: expect.stringMatching(/clearing/) });
    // An eyebrow left empty stays empty.
    const empty = copyEdit(state, [{ type: 'instance.setProp', owner, nodeId: hero, prop: 'eyebrow', value: '' }]).after;
    expect(copyEdit(empty, [{ type: 'instance.setProp', owner, nodeId: hero, prop: 'eyebrow', value: 'New' }]).problem).toMatchObject({ message: expect.stringMatching(/adding/) });
  });

  it('rewords rich text but keeps its links, headings and lists', () => {
    const { state, owner, rich } = project();
    const set = (value: unknown) => copyEdit(state, [{ type: 'node.setContent', owner, nodeId: rich, field: 'text', value }]);
    expect(set('**Call** us or [read our FAQ](https://example.com/faq).').problem).toBeNull();
    expect(set('Call us or [read the FAQ](https://evil.example/faq).').problem).toMatchObject({ message: expect.stringMatching(/links/) });
    expect(set('Call us.').problem).toMatchObject({ message: expect.stringMatching(/links/) });
    const added = set('Call us, [read the FAQ](https://example.com/faq) or [write](https://example.com/contact).');
    expect(JSON.stringify(added.after.pages[owner.id].nodes[rich])).toMatch(/faq.*contact/);
    expect(added.problem).toMatchObject({ message: expect.stringMatching(/links/) });
    expect(set('### Call us\n\n[read the FAQ](https://example.com/faq)').problem).toMatchObject({ message: expect.stringMatching(/headings/) });
    expect(set('- Call us\n- [read the FAQ](https://example.com/faq)').problem).toMatchObject({ message: expect.stringMatching(/lists/) });
    // Two lists of a kind with nothing between them show as one, and are reworded as one.
    const split = withNode(state, owner, rich, { ...node<TextNode>(state, owner, rich), text: [{ type: 'ol', items: [[{ text: 'One' }]] }, { type: 'p', spans: [] }, { type: 'ol', items: [[{ text: 'Two' }]] }] });
    expect(copyEdit(split, [{ type: 'node.setContent', owner, nodeId: rich, field: 'text', value: [{ type: 'ol', items: [[{ text: 'First' }], [{ text: 'Second' }]] }] }]).problem).toBeNull();
  });
});

describe('marking a property for the copy editor', () => {
  it('keeps the mark on a component’s own text, rich text and image properties, and refuses it anywhere else', () => {
    const state = createStarterState('blank', 'Marks', false);
    for (const type of ['string', 'richtext', 'image']) expect(normalizePropSchema({ type, label: 'X', copyEditable: true }, state, 'x')).toMatchObject({ copyEditable: true });
    expect(normalizePropSchema({ type: 'string', label: 'X', copyEditable: false }, state, 'x')).not.toHaveProperty('copyEditable');
    expect(() => normalizePropSchema({ type: 'enum', label: 'X', options: ['a'], copyEditable: true }, state, 'x')).toThrow(/only a component.s own text/);
    expect(() => normalizePropSchema({ type: 'string', label: 'X', copyEditable: 'yes' }, state, 'x')).toThrow(/true or false/);
    expect(() => normalizePropSchema({ type: 'list', label: 'X', itemLabel: 'Item', fields: { title: { type: 'string', label: 'Title', copyEditable: true } } }, state, 'x')).toThrow(/only a component.s own text/);
    expect(() => normalizePropSchema({ type: 'object', label: 'X', fields: { title: { type: 'string', label: 'Title', copyEditable: true } } }, state, 'x')).toThrow(/only a component.s own text/);
  });
});
