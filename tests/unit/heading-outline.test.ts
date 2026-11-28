/**
 * The page heading outline (#78): the headings a page renders, in order, with their levels and where each level is
 * chosen, and Project health's review of them (one page title, no missing title, no skipped level).
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { ComponentDefinition, GraphNode, InstanceNode, ProjectState, TextNode } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { P } from '@catalogue/dsl';
import { FOUNDATION_AUTHOR, projectDesign, registerBeside, restorePacks, testPack, type DesignSpec } from './fixtures/packs';
import { FOOTER, INTRO, TEXT, centeredHero } from './fixtures/heading-outline-designs';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { blocksSaving, validateState } from '@engine/validate';
import { themeUpdates } from '@engine/theme-updates';
import { definitionHash } from '@shared/migrations';
import { headingOutline, pageHeadings } from '@generator/checks';
import { generateProject } from '@generator/index';
import { headingLevelOps, headingTarget, pageOutline } from '../../src/renderer/src/lib/outline';
import { removeRendered, serverHtml } from './generated-site';

const { managed } = FOUNDATION_AUTHOR;
afterAll(removeRendered);

/** A centered hero designed with the editor's tree, as Foundation's own: its heading's level is the placement's choice. */
const heroSpec = () => centeredHero('hero.centered');
/** The hero's heading, given by the placement rather than left to a design's default. */
const HERO_HEADING = 'Thoughtful work for people who care about the details';

const fresh = () => createStarterState('business', 'Test Studio', false);
const pageAt = (s: ProjectState, route: string) => s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.route === route)!;
const headingWarnings = (s: ProjectState) => validateState(s).filter((d) => d.code.startsWith('HEADING_'));
const own = (s: ProjectState, pageId: string) => headingOutline(s, pageId).filter((h) => h.owner.kind === 'page');
const rows = (s: ProjectState, pageId: string) => own(s, pageId).map((h) => [h.level, h.text]);

/** The project's own design of a spec, added the first time. */
const designOf = (s: ProjectState, spec: DesignSpec) => s.components[FOUNDATION_AUTHOR.definitionId(spec.componentId)] ?? projectDesign(s, spec);

/**
 * The issue's page: the Contact page's introduction followed by a Centered hero. Foundation's sections are code
 * components whose headings Builder does not read (the Release gap tests below), so the page is made of designs built
 * in the editor: an introduction saying “Let’s talk”, and the hero.
 */
function contactWithHero(s = fresh()) {
  const contact = pageAt(s, '/contact/');
  const owner = { kind: 'page' as const, id: contact.id };
  const intro = designOf(s, INTRO);
  const hero = designOf(s, centeredHero());
  withHeadings(s, contact.id, []);
  const r = applyOperations(s, [
    { type: 'node.insert', owner, definitionId: intro.id, props: { eyebrow: 'Contact', heading: 'Let’s talk' } },
    { type: 'node.insert', owner, definitionId: hero.id, index: 1, props: { heading: HERO_HEADING } }
  ]);
  return { s: r.state, pageId: contact.id, heroId: r.state.pages[contact.id].rootIds[1] };
}

/** The issue's page as the release makes it: the starter's Contact page with Foundation's Centered hero inserted second. */
function releaseContactWithHero() {
  const s = fresh();
  const contact = pageAt(s, '/contact/');
  const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: contact.id }, componentId: 'hero.centered', index: 1, props: { heading: HERO_HEADING } }]);
  return { s: r.state, pageId: contact.id };
}

/** A placement of a design added to a page's own content, last. */
function placeOn(s: ProjectState, pageId: string, spec: DesignSpec, props: Record<string, unknown>) {
  return applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: pageId }, definitionId: designOf(s, spec).id, props }]).state;
}

/** A project component with a hand-built tree, installed into the project. */
function projectDef(s: ProjectState, id: string, properties: ComponentDefinition['properties'], nodes: GraphNode[], extra: Partial<ComponentDefinition> = {}): ComponentDefinition {
  const def: ComponentDefinition = {
    schemaVersion: 1,
    id,
    componentId: id,
    contractVersion: 1,
    kind: 'managed',
    owner: 'project',
    name: id,
    description: '',
    category: 'content',
    tags: [],
    properties,
    parts: {},
    tree: { rootIds: [nodes[0].id], nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) },
    ...extra
  };
  s.components[id] = def;
  return def;
}

/** Text nodes placed at the top level of a page, in order. */
function withHeadings(s: ProjectState, pageId: string, nodes: Array<Partial<TextNode> & { id: string }>) {
  const page = s.pages[pageId];
  page.rootIds = [];
  page.nodes = {};
  for (const n of nodes) {
    page.nodes[n.id] = { kind: 'text', tag: 'p', text: '', ...n } as GraphNode;
    page.rootIds.push(n.id);
  }
}

describe('heading outline', () => {
  it('lists a page introduction and a second hero as two page titles, each selectable', () => {
    const { s, pageId, heroId } = contactWithHero();
    const main = own(s, pageId);
    expect(main.slice(0, 2).map((h) => [h.level, h.text])).toEqual([
      [1, 'Let’s talk'],
      [1, HERO_HEADING]
    ]);
    // The hero's heading is a part of a section placed on the page, and its level is that placement's choice.
    expect(main[1]).toMatchObject({ owner: { kind: 'page', id: pageId }, nodeId: heroId, defNodeId: 'heading', direct: true, levelSource: { kind: 'prop', prop: 'headingLevel' }, levels: [1, 2, 3, 4, 5, 6] });
  });

  it('lists the release’s page introduction and centered hero by their headings', () => {
    const { s, pageId } = releaseContactWithHero();
    expect(rows(s, pageId).slice(0, 2)).toEqual([
      [1, 'Let’s talk'],
      [1, HERO_HEADING]
    ]);
    // Both are read through the designs standing for their markup, each level its placement's choice.
    for (const h of own(s, pageId).slice(0, 2)) expect(h).toMatchObject({ defNodeId: 'heading', direct: true, levelSource: { kind: 'prop', prop: 'headingLevel' } });
  });

  it('flags the release’s centered hero as a second page title (#1404)', () => {
    const { s, pageId } = releaseContactWithHero();
    const heroId = s.pages[pageId].rootIds[1];
    const outline = pageOutline(s, pageId);
    // Foundation's sections are read through their markup: nothing on the page is unknown code.
    expect(outline.uninspected).toBe(false);
    expect(outline.review.extraTitles).toBe(true);
    // The hero's level is its placement's choice, changed from the outline on the placement itself.
    const hero = own(s, pageId)[1];
    expect(hero).toMatchObject({ level: 1, nodeId: heroId, levelSource: { kind: 'prop', prop: 'headingLevel' } });
    expect(headingTarget(s, hero)).toEqual({ owner: { kind: 'page', id: pageId }, instancePath: [], nodeId: heroId });
    expect(headingLevelOps(hero, 2)).toEqual([{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId: heroId, prop: 'headingLevel', value: 'h2' }]);
    expect(headingWarnings(s)).toEqual([expect.objectContaining({ code: 'HEADING_MULTIPLE_H1', owner: { kind: 'page', id: pageId }, nodeId: heroId })]);
    // The outline's row offers the fix in one step.
    const row = outline.rows[outline.review.titles[1]];
    expect(row).toMatchObject({ extraTitle: true, fix: 2 });
    // At Heading 2, the page has one title again.
    const fixed = applyOperations(s, headingLevelOps(row.heading, row.fix!)!).state;
    expect(rows(fixed, pageId).slice(0, 2)).toEqual([
      [1, 'Let’s talk'],
      [2, HERO_HEADING]
    ]);
    expect(headingWarnings(fixed)).toEqual([]);
  });

  it('leaves out the release hero’s heading where its words are only spaces or its part is hidden at every size', () => {
    const { s, pageId } = releaseContactWithHero();
    const heroId = s.pages[pageId].rootIds[1];
    const owner = { kind: 'page' as const, id: pageId };
    const firsts = (st: ProjectState) => rows(st, pageId).filter(([level]) => level === 1);
    // `{#if has(heading)}`: a heading of spaces renders nothing.
    const blank = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: heroId, prop: 'heading', value: '   ' }]).state;
    expect(firsts(blank)).toEqual([[1, 'Let’s talk']]);
    expect(headingWarnings(blank)).toEqual([]);
    // Its heading part hidden at every size by the placement: no screen reader reaches it.
    const hero = s.pages[pageId].nodes[heroId] as InstanceNode;
    hero.overrides = { ...hero.overrides, heading: { base: { hidden: true } } };
    expect(firsts(s)).toEqual([[1, 'Let’s talk']]);
    // Shown again on phones, it is in the outline.
    hero.overrides = { ...hero.overrides, heading: { base: { hidden: true }, phone: { hidden: false } } };
    expect(firsts(s)).toEqual([
      [1, 'Let’s talk'],
      [1, HERO_HEADING]
    ]);
  });

  it('reads the release’s step tour titles as the buttons they are, and its layouts as holding no headings', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    const owner = { kind: 'page' as const, id: about.id };
    withHeadings(s, about.id, [{ id: 'n_title', tag: 'h1', text: 'About' }]);
    const r = applyOperations(s, [
      { type: 'node.insert', owner, componentId: 'content.steps-media', props: { heading: 'Our process', steps: [{ id: 'a', title: 'Plan', description: 'First.' }] } },
      { type: 'node.insert', owner, componentId: 'content.steps', props: { heading: 'Steps', steps: [{ id: 'b', title: 'Visit', description: 'Then.' }, { id: 'c', title: 'Build', description: 'Last.' }] } },
      { type: 'node.insert', owner, componentId: 'layout.section', props: {} },
      { type: 'node.insert', owner, componentId: 'layout.split', props: {} }
    ]).state;
    // The tour's step titles are buttons; the steps section's are headings.
    expect(rows(r, about.id)).toEqual([
      [1, 'About'],
      [2, 'Our process'],
      [2, 'Steps'],
      [3, 'Visit'],
      [3, 'Build']
    ]);
    expect(headingWarnings(r)).toEqual([]);
    expect(pageOutline(r, about.id).uninspected).toBe(false);
    // A layout whose code was changed from the release's decides in that code what it shows.
    const split = r.pages[about.id].nodes[r.pages[about.id].rootIds.at(-1)!] as InstanceNode;
    r.components[split.definitionId] = { ...r.components[split.definitionId], source: `${r.components[split.definitionId].source}\n<h1>Changed</h1>` };
    expect(pageOutline(r, about.id).uninspected).toBe(true);
  });

  it('reads the release’s tabs as they open, with only the first tab’s panel shown', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    withHeadings(s, about.id, [{ id: 'n_title', tag: 'h1', text: 'About' }]);
    const tabs = [
      { id: 'a', label: 'One', heading: '', copy: '' },
      { id: 'b', label: 'Two', heading: 'Second tab', copy: '' }
    ];
    const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: about.id }, componentId: 'tabs.showcase', props: { heading: '', tabs } }]).state;
    // The second tab's heading is hidden until it is chosen, so it leaves no skipped level after the page's title.
    expect(rows(r, about.id)).toEqual([[1, 'About']]);
    expect(headingWarnings(r)).toEqual([]);
    const [, placed] = r.pages[about.id].rootIds;
    const first = applyOperations(r, [{ type: 'instance.setProp', owner: { kind: 'page', id: about.id }, nodeId: placed, prop: 'tabs', value: [{ ...tabs[0], heading: 'First tab' }, tabs[1]] }]).state;
    expect(rows(first, about.id)).toEqual([
      [1, 'About'],
      [3, 'First tab']
    ]);
  });

  it('selects a shipped section placed inside a design through that design’s placement', () => {
    const { s, pageId } = releaseContactWithHero();
    const heroDef = s.components[(s.pages[pageId].nodes[s.pages[pageId].rootIds[1]] as InstanceNode).definitionId];
    const wrapper = projectDef(s, 'wrap_hero', {}, [makeInstance(heroDef, { heading: 'Inner title', headingLevel: 'h2' })]);
    const placed = makeInstance(wrapper, {});
    s.pages[pageId].nodes[placed.id] = placed;
    s.pages[pageId].rootIds.push(placed.id);
    const inner = own(s, pageId).find((h) => h.text === 'Inner title')!;
    expect(inner).toMatchObject({ level: 2, nodeId: placed.id, direct: false });
    expect(inner.instancePath).toBeUndefined();
    expect(headingTarget(s, inner)).toEqual({ owner: { kind: 'page', id: pageId }, instancePath: [], nodeId: placed.id });
  });

  it('lists the release footer’s column headings only over columns with something in them', () => {
    const s = fresh();
    const [placed] = s.site.shell.footer.rootIds;
    const owner = { kind: 'shell' as const, id: 'footer' };
    const footerWords = (st: ProjectState) => headingOutline(st, pageAt(st, '/about/').id).filter((h) => h.owner.kind === 'shell').map((h) => h.text);
    expect(footerWords(applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'contact', value: [] }]).state)).toEqual(['Explore']);
    expect(footerWords(applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: placed, prop: 'links', value: [] }, { type: 'instance.setProp', owner, nodeId: placed, prop: 'contactHeading', value: 'Find us' }]).state)).toEqual(['Find us']);
    // Its one-row layout hides both headings at every size.
    (s.site.shell.footer.nodes[placed] as InstanceNode).variants = { layout: 'minimal' };
    expect(footerWords(s)).toEqual([]);
  });

  it('lists the headings of the release’s feature grid, FAQ and plan comparison', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    const owner = { kind: 'page' as const, id: about.id };
    withHeadings(s, about.id, [{ id: 'n_title', tag: 'h1', text: 'About' }]);
    const r = applyOperations(s, [
      { type: 'node.insert', owner, componentId: 'features.grid', props: { heading: 'Services', items: [{ id: 'a', title: 'Design', description: 'Pages.' }, { id: 'b', title: 'Build', description: 'Sites.' }] } },
      { type: 'node.insert', owner, componentId: 'faq.list', props: { heading: 'Questions' } },
      { type: 'node.insert', owner, componentId: 'pricing.compare', props: { heading: 'Compare plans', headingLevel: 'h1' } }
    ]).state;
    expect(rows(r, about.id).slice(-5)).toEqual([
      [2, 'Services'],
      [3, 'Design'],
      [3, 'Build'],
      [2, 'Questions'],
      [1, 'Compare plans']
    ]);
    expect(pageOutline(r, about.id).uninspected).toBe(false);
    expect(headingWarnings(r).map((d) => d.code)).toEqual(['HEADING_MULTIPLE_H1']);
    // The comparison's level is its placement's choice, set from the outline.
    const compare = own(r, about.id).at(-1)!;
    expect(compare.levels).toEqual([1, 2, 3, 4, 5, 6]);
    // Its heading part hidden at every size leaves it out.
    const hidden = structuredClone(r);
    (hidden.pages[about.id].nodes[compare.nodeId] as InstanceNode).overrides = { heading: { base: { hidden: true } } };
    expect(rows(hidden, about.id).at(-1)).toEqual([2, 'Questions']);
    const fixed = applyOperations(r, headingLevelOps(compare, 2)!).state;
    expect(rows(fixed, about.id).at(-1)).toEqual([2, 'Compare plans']);
    expect(headingWarnings(fixed)).toEqual([]);
  });

  it('reads the shared header and footer around the page, unless the page leaves them out', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    withHeadings(s, about.id, [{ id: 'n_title', tag: 'h1', text: 'About' }]);
    // A footer designed in the editor, whose column heading the outline reads.
    const footer = makeInstance(designOf(s, FOOTER), {});
    s.site.shell.footer = { rootIds: [footer.id], nodes: { [footer.id]: footer } };
    expect(headingOutline(s, about.id).filter((h) => h.owner.kind === 'shell').map((h) => [h.owner.id, h.level, h.text])).toEqual([['footer', 2, 'Visit the studio']]);
    // The footer's headings come after the page's own.
    expect(headingOutline(s, about.id).map((h) => h.owner.kind)).toEqual(['page', 'shell']);
    s.pages[about.id].showFooter = false;
    expect(headingOutline(s, about.id).map((h) => h.owner.kind)).toEqual(['page']);
  });

  it('reads the headings of the release’s footer', () => {
    const s = fresh();
    const footer = headingOutline(s, pageAt(s, '/about/').id).filter((h) => h.owner.kind === 'shell' && h.owner.id === 'footer');
    expect(footer.map((h) => [h.level, h.text])).toEqual([
      [2, 'Explore'],
      [2, 'Contact']
    ]);
    // A column heading cleared of its words is left out, as the footer's markup leaves it out.
    const [placed] = s.site.shell.footer.rootIds;
    const r = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: placed, prop: 'linksHeading', value: ' ' }]).state;
    expect(headingOutline(r, pageAt(r, '/about/').id).filter((h) => h.owner.kind === 'shell' && h.owner.id === 'footer').map((h) => h.text)).toEqual(['Contact']);
  });

  it('leaves out a heading whose words are cleared, as the site does', () => {
    const { s, pageId, heroId } = contactWithHero();
    const r = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId: heroId, prop: 'heading', value: '' }]).state;
    expect(rows(r, pageId).filter(([level]) => level === 1)).toEqual([[1, 'Let’s talk']]);
    expect(headingWarnings(r)).toEqual([]);
  });

  it('lists subheadings written in rich text, and the contact form’s and data table’s headings', () => {
    let s = fresh();
    const about = pageAt(s, '/about/');
    const owner = { kind: 'page' as const, id: about.id };
    withHeadings(s, about.id, [{ id: 'n_title', tag: 'h1', text: 'About' }]);
    s = placeOn(s, about.id, TEXT, { heading: 'How we work', body: [{ type: 'h3', spans: [{ text: 'Listening first' }] }, { type: 'p', spans: [{ text: 'Words.' }] }] });
    let r = applyOperations(s, [{ type: 'node.insert', owner, componentId: 'contact.form', props: { heading: 'Write to us' } }]);
    r = applyOperations(r.state, [{ type: 'node.insert', owner, componentId: 'data.table', props: { heading: 'Opening hours' } }]);
    const tail = own(r.state, about.id).slice(-4);
    expect(tail.map((h) => [h.level, h.text, !!h.rich, !!h.levelSource])).toEqual([
      [2, 'How we work', false, true],
      [3, 'Listening first', true, false],
      [2, 'Write to us', false, false],
      [2, 'Opening hours', false, false]
    ]);
    // Shipped code whose markup is known leaves the review able to judge the page.
    expect(pageOutline(r.state, about.id).uninspected).toBe(false);
  });

  it('lists subheadings written in the release’s text section', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: about.id }, componentId: 'content.text', props: { heading: 'How the studio works', body: [{ type: 'h3', spans: [{ text: 'Listening first' }] }, { type: 'p', spans: [{ text: 'Words.' }] }] } }]);
    expect(own(r.state, about.id).slice(-2).map((h) => [h.level, h.text, !!h.rich])).toEqual([
      [2, 'How the studio works', false],
      [3, 'Listening first', true]
    ]);
  });

  it('marks a page’s own heading as changed by its tag, and an older design’s fixed heading as not changeable', () => {
    const s = fresh();
    const home = s.site.homePageId;
    withHeadings(s, home, [{ id: 'n_title', tag: 'h1', text: 'Welcome' }]);
    expect(own(s, home)[0]).toMatchObject({ level: 1, text: 'Welcome', nodeId: 'n_title', levelSource: { kind: 'node' } });
    // A hero designed before its heading level could be chosen keeps a fixed Heading 1.
    const withHero = fresh();
    const heroHome = withHero.site.homePageId;
    withHeadings(withHero, heroHome, [{ id: 'n_intro', tag: 'h2', text: 'Intro' }]);
    const hero = FOUNDATION_AUTHOR.managed(heroSpec());
    delete hero.properties.headingLevel;
    (hero.tree!.nodes.heading as TextNode).tag = 'h1';
    withHero.components[hero.id] = hero;
    const placed = makeInstance(hero, {});
    withHero.pages[heroHome].nodes[placed.id] = placed;
    withHero.pages[heroHome].rootIds.push(placed.id);
    expect(own(withHero, heroHome)[1]).toMatchObject({ level: 1, defNodeId: 'heading' });
    expect(own(withHero, heroHome)[1].levelSource).toBeUndefined();
  });

  it('counts a page title shown more than once from one place, such as slot content a list repeats', () => {
    const s = fresh();
    const home = s.site.homePageId;
    const def: ComponentDefinition = {
      ...managed({
        componentId: 'test.repeater',
        name: 'Repeater',
        description: '',
        category: 'content',
        tags: [],
        icon: 'sparkles',
        properties: { items: P.list('Items', 'Item', { label: P.str('Label', 'x') }, [{ label: 'One' }, { label: 'Two' }]) },
        parts: {},
        slots: { content: { label: 'Content' } },
        build: (b) => b.el('root', 'div', {}, [b.repeat('each', 'items', [b.slot('slot', 'content')])])
      }),
      owner: 'project'
    };
    s.components[def.id] = def;
    const inst: InstanceNode = { ...makeInstance(def, {}), slots: { content: ['n_slot_title'] } };
    withHeadings(s, home, []);
    s.pages[home].nodes = { [inst.id]: inst, n_slot_title: { id: 'n_slot_title', kind: 'text', tag: 'h1', text: 'Twice' } };
    s.pages[home].rootIds = [inst.id];
    const { outline, review } = pageHeadings(s, home);
    expect(outline.filter((h) => h.owner.kind === 'page')).toEqual([expect.objectContaining({ level: 1, text: 'Twice', repeated: true })]);
    expect(review.extraTitles).toBe(true);
    expect(headingWarnings(s).map((d) => d.code)).toEqual(['HEADING_MULTIPLE_H1']);
    expect(headingWarnings(s)[0].message).toMatch(/the Heading 1 “Twice” is shown more than once/);
  });
});

describe('headings as the generated site renders them', () => {
  it('reads a level a design hands on the way the nested heading renders it, and offers only levels it can render', () => {
    const s = fresh();
    const home = s.site.homePageId;
    const level = (def: string, opts: string[]) => P.choice('Level', def, opts.map((o) => [o, o.toUpperCase()] as [string, string]));
    // The inner heading renders Heading 2 or 3, Heading 3 by default; its wrapper offers 1, 2 or 3 and forwards its choice.
    projectDef(s, 'p_inner', { lvl: level('h3', ['h2', 'h3']), year: P.num('Year', 2026) }, [{ id: 'title', kind: 'text', tag: { $prop: 'lvl' }, text: { $prop: 'year' } }]);
    const wrapper = projectDef(s, 'p_wrap', { level: level('h2', ['h1', 'h2', 'h3']) }, [
      { id: 'root', kind: 'element', tag: 'div', children: ['first', 'second'] },
      { id: 'first', kind: 'instance', definitionId: 'p_inner', props: { lvl: { $prop: 'level' } } },
      { id: 'second', kind: 'instance', definitionId: 'p_inner', props: { lvl: 'h2' } }
    ]);
    const placed: InstanceNode = { ...makeInstance(wrapper, {}), props: { level: 'h1' } };
    withHeadings(s, home, []);
    s.pages[home].nodes = { [placed.id]: placed };
    s.pages[home].rootIds = [placed.id];
    const [first, second] = own(s, home);
    // "h1" is not one of the inner heading's levels: the site renders its default, Heading 3.
    expect(first).toMatchObject({ level: 3, text: '2026', levelSource: { kind: 'prop', prop: 'level' }, levels: [2, 3], instancePath: [placed.id, 'first'] });
    expect(second).toMatchObject({ level: 2, instancePath: [placed.id, 'second'] });
    expect(second.levelSource).toBeUndefined();
    // Each nested heading selects itself, not the wrapper they share.
    expect(headingTarget(s, first)).toEqual({ owner: { kind: 'page', id: home }, instancePath: [placed.id, 'first'], nodeId: 'title' });
    expect(headingTarget(s, second)).toEqual({ owner: { kind: 'page', id: home }, instancePath: [placed.id, 'second'], nodeId: 'title' });
    expect(headingWarnings(s).map((d) => d.code)).toEqual(['HEADING_MISSING_H1']);
  });

  it('leaves out a heading hidden at every size, but not one hidden at some sizes', () => {
    const s = fresh();
    const home = s.site.homePageId;
    withHeadings(s, home, [
      { id: 'n_old', tag: 'h1', text: 'Old title', styles: { base: { hidden: true } } },
      { id: 'n_new', tag: 'h1', text: 'New title' }
    ]);
    expect(rows(s, home)).toEqual([[1, 'New title']]);
    expect(headingWarnings(s)).toEqual([]);
    // Shown again on phones, it is a second title there.
    (s.pages[home].nodes.n_old as TextNode).styles = { base: { hidden: true }, phone: { hidden: false } };
    expect(headingWarnings(s).map((d) => d.code)).toEqual(['HEADING_MULTIPLE_H1']);
    // A layout set for one size gives the element a display there, which shows it again.
    (s.pages[home].nodes.n_old as TextNode).styles = { base: { hidden: true, layout: 'stack' }, tablet: { layout: 'row' } };
    expect(headingWarnings(s).map((d) => d.code)).toEqual(['HEADING_MULTIPLE_H1']);
    (s.pages[home].nodes.n_old as TextNode).styles = { base: { hidden: true }, tablet: { layout: 'row', hidden: true } };
    expect(headingWarnings(s)).toEqual([]);
    // Custom CSS shows it only by setting a display; a size's styles that are not an object (a hand-edited file) change nothing.
    (s.pages[home].nodes.n_old as TextNode).styles = { base: { hidden: true }, phone: { customCss: 'color: red;' }, desktop: 'legacy' as never };
    expect(headingWarnings(s)).toEqual([]);
    (s.pages[home].nodes.n_old as TextNode).styles = { base: { hidden: true }, phone: { customCss: 'color: red; display: block;' } };
    expect(headingWarnings(s).map((d) => d.code)).toEqual(['HEADING_MULTIPLE_H1']);
    // A container hidden at every size hides the headings inside it.
    s.pages[home].nodes.n_box = { id: 'n_box', kind: 'element', tag: 'div', children: ['n_new'], styles: { base: { hidden: true } } };
    s.pages[home].rootIds = ['n_old', 'n_box'];
    (s.pages[home].nodes.n_old as TextNode).styles = {};
    expect(rows(s, home)).toEqual([[1, 'Old title']]);
    // A section hidden at every size hides its headings: the Contact page's hero, here.
    const { s: withHero, pageId, heroId } = contactWithHero();
    (withHero.pages[pageId].nodes[heroId] as InstanceNode).overrides = { root: { base: { hidden: true } } };
    expect(headingWarnings(withHero)).toEqual([]);
  });

  it('cannot say a page with custom code has no title, since the code’s headings are unknown', () => {
    const s = fresh();
    const home = s.site.homePageId;
    s.components.code_banner = { ...projectDef(s, 'code_banner', {}, [{ id: 'x', kind: 'divider' }]), kind: 'code', tree: undefined, source: '<h1>Welcome</h1>' };
    const code = makeInstance(s.components.code_banner, {});
    withHeadings(s, home, [{ id: 'n_a', tag: 'h2', text: 'Services' }]);
    expect(headingWarnings(s).map((d) => d.code)).toEqual(['HEADING_MISSING_H1']);
    s.pages[home].nodes[code.id] = code;
    s.pages[home].rootIds.unshift(code.id);
    expect(pageOutline(s, home).uninspected).toBe(true);
    expect(headingWarnings(s)).toEqual([]);
  });

  it('counts slot content a design shows twice through two slots of one name', () => {
    const s = fresh();
    const home = s.site.homePageId;
    const def = projectDef(
      s,
      'p_twice',
      {},
      [
        { id: 'root', kind: 'element', tag: 'div', children: ['a', 'b'] },
        { id: 'a', kind: 'slot', slot: 'content' },
        { id: 'b', kind: 'slot', slot: 'content' }
      ],
      { slots: { content: { label: 'Content' } } }
    );
    const inst: InstanceNode = { ...makeInstance(def, {}), slots: { content: ['n_title'] } };
    withHeadings(s, home, []);
    s.pages[home].nodes = { [inst.id]: inst, n_title: { id: 'n_title', kind: 'text', tag: 'h1', text: 'Twice' } };
    s.pages[home].rootIds = [inst.id];
    expect(own(s, home)).toEqual([expect.objectContaining({ text: 'Twice', repeated: true })]);
    expect(headingWarnings(s).map((d) => d.code)).toEqual(['HEADING_MULTIPLE_H1']);
  });
});

describe('heading review in Project health', () => {
  it('warns about a second page title without blocking saving or export, and keeps the unlinked button warnings', () => {
    const { s, pageId, heroId } = contactWithHero();
    const found = headingWarnings(s);
    expect(found).toEqual([expect.objectContaining({ severity: 'warning', code: 'HEADING_MULTIPLE_H1', owner: { kind: 'page', id: pageId }, nodeId: heroId })]);
    expect(found[0].message).toBe(
      `Contact: 2 headings are Heading 1s (“Let’s talk” and “${HERO_HEADING}”), so screen readers announce more than one page title. Keep the page’s title as Heading 1 and make the others Heading 2, unless they are meant to be titles.`
    );
    expect(found.some(blocksSaving)).toBe(false);
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toHaveLength(2);
    // Save gates skip the review: it can never block a change.
    expect(validateState(s, { sectionLinks: false }).filter((d) => d.code.startsWith('HEADING_'))).toEqual([]);
  });

  it('clears the warning once the hero is a Heading 2, which keeps its look and renders an h2', async () => {
    const { s, pageId, heroId } = contactWithHero();
    const before = structuredClone(s.pages[pageId].nodes[heroId]);
    const r = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId: heroId, prop: 'headingLevel', value: 'h2' }]).state;
    expect(rows(r, pageId).slice(0, 2)).toEqual([
      [1, 'Let’s talk'],
      [2, HERO_HEADING]
    ]);
    expect(headingWarnings(r)).toEqual([]);
    // Only the level changed: no style override, variant or other content.
    expect(r.pages[pageId].nodes[heroId]).toEqual({ ...before, props: { ...(before as InstanceNode).props, headingLevel: 'h2' } });
    // The exported Contact page renders the hero's heading as an h2, and only the introduction's as an h1.
    const html = (await serverHtml(generateProject(r), 'heading-outline-', 'src/routes/contact/+page.svelte')).replace(/<!--[\s\S]*?-->/g, '');
    expect(html).toMatch(new RegExp(`<h2[^>]*>${HERO_HEADING}</h2>`));
    expect([...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/g)].map((m) => m[1])).toEqual(['Let’s talk']);
  });

  it('warns when a page has no Heading 1, but not when the page is empty', () => {
    const { s: withHero, pageId, heroId } = contactWithHero();
    const contact = { id: pageId };
    const s = applyOperations(withHero, [{ type: 'node.remove', owner: { kind: 'page', id: pageId }, nodeId: heroId }]).state;
    const intro = s.pages[contact.id].rootIds[0];
    const r = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId: intro, prop: 'headingLevel', value: 'h2' }]).state;
    expect(headingWarnings(r)).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'HEADING_MISSING_H1', owner: { kind: 'page', id: contact.id }, message: 'Contact: no heading is a Heading 1, so the page has no title for screen readers to announce. Make the page’s main heading Heading 1.' })
    ]);
    withHeadings(r, contact.id, []);
    expect(headingWarnings(r)).toEqual([]);
  });

  it('warns about a skipped level and names the level that follows on', () => {
    const s = fresh();
    const home = s.site.homePageId;
    withHeadings(s, home, [
      { id: 'n_a', tag: 'h1', text: 'Home' },
      { id: 'n_b', tag: 'h2', text: 'Services' },
      { id: 'n_c', tag: 'h4', text: 'Planning' },
      { id: 'n_d', tag: 'h3', text: 'Delivery' },
      { id: 'n_e', tag: 'h2', text: 'Contact' },
      { id: 'n_f', tag: 'h5', text: 'Hours' }
    ]);
    expect(pageHeadings(s, home, { shell: false }).review.skips).toEqual([
      { index: 2, after: 2, suggest: 3 },
      { index: 5, after: 2, suggest: 3 }
    ]);
    expect(headingWarnings(s)).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'HEADING_LEVEL_SKIP', nodeId: 'n_c', message: 'Home: “Planning” is a Heading 4 right after a Heading 2, so the outline skips a level. Make it Heading 3.' }),
      expect.objectContaining({ code: 'HEADING_LEVEL_SKIP', nodeId: 'n_f', message: 'Home: “Hours” is a Heading 5 right after a Heading 2, so the outline skips a level. Make it Heading 3.' })
    ]);
  });

  it('finds nothing to review on the starter sites', () => {
    expect(headingWarnings(fresh())).toEqual([]);
    expect(headingWarnings(createStarterState('blank', 'Blank', false))).toEqual([]);
  });

  it('offers a heading level once an older installed hero is updated from the theme', async () => {
    // Foundation's sections under another theme's name, with its centered hero a design (Foundation's is code, whose
    // headings are not read here), and a site on that theme.
    const author = testPack('outline-theme');
    const others = getTheme('foundation').components.filter((c) => c.componentId !== 'hero.centered').map((c) => author.adopt(c));
    registerBeside(author.define([...others, author.managed(heroSpec())]));
    try {
      const site = createStarterState('blank', 'Test Studio', false, 'outline-theme');
      const pageId = site.site.homePageId;
      withHeadings(site, pageId, [{ id: 'n_intro', tag: 'h1', text: 'Let’s talk' }]);
      const s = applyOperations(site, [{ type: 'node.insert', owner: { kind: 'page', id: pageId }, componentId: 'hero.centered', index: 1 }]).state;
      const hero = s.components['outline-theme.hero.centered'];
      // The hero as installed before its heading level could be chosen.
      delete hero.properties.headingLevel;
      (hero.tree!.nodes.heading as TextNode).tag = 'h1';
      s.themeLock.components[hero.id].hash = definitionHash(hero);
      expect(own(s, pageId)[1].levelSource).toBeUndefined();
      expect(themeUpdates(s).available.map((u) => u.id)).toContain(hero.id);
      const next = applyOperations(s, [{ type: 'theme.refresh' }]).state;
      expect(own(next, pageId)[1]).toMatchObject({ level: 1, levelSource: { kind: 'prop', prop: 'headingLevel' } });
    } finally {
      await restorePacks();
    }
  });
});

describe('page outline rows and fixes', () => {
  it('names the page title, flags the second Heading 1, and fixes it in one edit that selects nothing new', () => {
    const { s, pageId, heroId } = contactWithHero();
    const { rows, review, titleFix } = pageOutline(s, pageId);
    expect(review.extraTitles).toBe(true);
    expect(titleFix).toBeUndefined();
    expect(rows[0]).toMatchObject({ title: true, heading: { text: 'Let’s talk' } });
    expect(rows[0].fix).toBeUndefined();
    expect(rows[1]).toMatchObject({ extraTitle: true, fix: 2 });
    // Selecting the row selects the heading part of the hero placed on the page.
    expect(headingTarget(s, rows[1].heading)).toEqual({ owner: { kind: 'page', id: pageId }, instancePath: [heroId], nodeId: 'heading', partId: 'heading' });
    const ops = headingLevelOps(rows[1].heading, rows[1].fix!)!;
    expect(ops).toEqual([{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId: heroId, prop: 'headingLevel', value: 'h2' }]);
    const after = applyOperations(s, ops).state;
    const next = pageOutline(after, pageId);
    expect(next.rows[1]).toMatchObject({ heading: { level: 2 } });
    expect(next.rows[1].extraTitle).toBeUndefined();
    expect(next.review.extraTitles).toBe(false);
    expect(headingWarnings(after)).toEqual([]);
  });

  it('offers the first heading as the page title when there is none, and fixes a skipped level on a page’s own heading', () => {
    const s = fresh();
    const home = s.site.homePageId;
    withHeadings(s, home, [
      { id: 'n_a', tag: 'h2', text: 'Welcome' },
      { id: 'n_b', tag: 'h4', text: 'Planning' }
    ]);
    const { rows, titleFix } = pageOutline(s, home);
    expect(titleFix?.heading.nodeId).toBe('n_a');
    expect(headingTarget(s, titleFix!.heading)).toEqual({ owner: { kind: 'page', id: home }, instancePath: [], nodeId: 'n_a' });
    const own = rows.filter((r) => r.heading.owner.kind === 'page');
    expect(own[1]).toMatchObject({ skip: { after: 2, suggest: 3 }, fix: 3 });
    const fixed = applyOperations(s, [...headingLevelOps(titleFix!.heading, 1)!, ...headingLevelOps(own[1].heading, 3)!]).state;
    expect(rows.length).toBe(pageOutline(fixed, home).rows.length);
    // Now a Heading 1 then a Heading 3: the skip moved, and its fix follows on from the new title.
    expect(pageOutline(fixed, home).rows.filter((r) => r.heading.owner.kind === 'page').map((r) => [r.heading.level, r.fix ?? null])).toEqual([
      [1, null],
      [3, 2]
    ]);
  });

  it('offers no one-step fix for a level several headings share, which would change them all', () => {
    const s = fresh();
    const home = s.site.homePageId;
    const def = projectDef(s, 'p_pair', { level: P.choice('Level', 'h1', [['h1', 'H1'], ['h2', 'H2']]) }, [
      { id: 'root', kind: 'element', tag: 'div', children: ['one', 'two'] },
      { id: 'one', kind: 'text', tag: { $prop: 'level' }, text: 'One' },
      { id: 'two', kind: 'text', tag: { $prop: 'level' }, text: 'Two' }
    ]);
    const inst = makeInstance(def, {});
    withHeadings(s, home, []);
    s.pages[home].nodes = { [inst.id]: inst };
    s.pages[home].rootIds = [inst.id];
    const { rows } = pageOutline(s, home);
    expect(rows.filter((r) => r.heading.owner.kind === 'page').map((r) => [r.title ?? false, r.extraTitle ?? false, r.fix ?? null])).toEqual([
      [true, false, null],
      [false, true, null]
    ]);
    // Below a title of the page's own, both skip a level at Heading 3, and still neither offers a fix.
    s.pages[home].nodes.n_top = { id: 'n_top', kind: 'text', tag: 'h1', text: 'Top' };
    s.pages[home].rootIds.unshift('n_top');
    def.properties.level = P.choice('Level', 'h1', [['h1', 'H1'], ['h2', 'H2'], ['h3', 'H3']]);
    (s.pages[home].nodes[inst.id] as InstanceNode).props.level = 'h3';
    const skipped = pageOutline(s, home).rows.filter((r) => r.heading.owner.kind === 'page');
    expect(skipped.map((r) => [r.heading.level, r.skip?.suggest ?? null, r.fix ?? null])).toEqual([
      [1, null, null],
      [3, 2, null],
      [3, null, null]
    ]);
  });

  it.each(['h1', 'h2'])('offers no one-step fix for a level a design also reads to decide what shows (shown for %s)', (shownFor) => {
    const s = fresh();
    const home = s.site.homePageId;
    // Shown now (h1), or shown only once the fix were made (h2).
    const def = projectDef(s, 'p_cond', { level: P.choice('Level', 'h1', [['h1', 'H1'], ['h2', 'H2']]) }, [
      { id: 'root', kind: 'element', tag: 'div', children: ['note', 'title'] },
      { id: 'note', kind: 'text', tag: 'p', text: 'Shown for one level only', when: { ref: { $prop: 'level' }, eq: shownFor } },
      { id: 'title', kind: 'text', tag: { $prop: 'level' }, text: 'Second' }
    ]);
    const inst = makeInstance(def, {});
    withHeadings(s, home, [{ id: 'n_a', tag: 'h1', text: 'First' }]);
    s.pages[home].nodes[inst.id] = inst;
    s.pages[home].rootIds.push(inst.id);
    const row = pageOutline(s, home).rows.find((r) => r.heading.text === 'Second')!;
    expect(row).toMatchObject({ extraTitle: true, heading: { levelConditions: true } });
    expect(row.fix).toBeUndefined();
  });

  it('keys each row apart, even headings a list shows through one nested placement', () => {
    const s = fresh();
    const home = s.site.homePageId;
    projectDef(s, 'p_card', { t: P.str('Title', 'x') }, [{ id: 'title', kind: 'text', tag: 'h2', text: { $prop: 't' } }]);
    const list = projectDef(s, 'p_list', { items: P.list('Items', 'Item', { title: P.str('Title', 'x') }, [{ title: 'One' }, { title: 'Two' }]) }, [
      { id: 'root', kind: 'element', tag: 'div', children: ['each'] },
      { id: 'each', kind: 'repeat', list: { $prop: 'items' }, children: ['card'] },
      { id: 'card', kind: 'instance', definitionId: 'p_card', props: { t: { $item: 'title' } } }
    ]);
    const inst = makeInstance(list, {});
    withHeadings(s, home, [{ id: 'n_a', tag: 'h1', text: 'Top' }]);
    s.pages[home].nodes[inst.id] = inst;
    s.pages[home].rootIds.push(inst.id);
    const own = pageOutline(s, home).rows.filter((r) => r.heading.owner.kind === 'page');
    expect(own.map((r) => r.heading.text)).toEqual(['Top', 'One', 'Two']);
    expect(new Set(own.map((r) => r.key)).size).toBe(3);
    // Inside a list, a nested heading selects its placement on the page.
    expect(own[1].heading.instancePath).toBeUndefined();
  });

  it('offers no fix where the level is fixed: rich text, the contact form, an older design', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    withHeadings(s, about.id, [{ id: 'n_a', tag: 'h1', text: 'About' }]);
    const r = placeOn(s, about.id, TEXT, { heading: '', body: [{ type: 'h4', spans: [{ text: 'Deep' }] }] });
    const deep = pageOutline(r, about.id).rows.find((x) => x.heading.text === 'Deep')!;
    expect(deep).toMatchObject({ skip: { after: 1, suggest: 2 } });
    expect(deep.fix).toBeUndefined();
    expect(headingLevelOps(deep.heading, 2)).toBeNull();
  });
});
