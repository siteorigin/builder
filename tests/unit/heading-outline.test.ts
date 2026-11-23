/**
 * The page heading outline (#78): the headings a page renders, in order, with their levels and where each level is
 * chosen, and Project health's review of them (one page title, no missing title, no skipped level).
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, GraphNode, InstanceNode, ProjectState, TextNode } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { P, managed } from '@catalogue/dsl';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { blocksSaving, validateState } from '@engine/validate';
import { themeUpdates } from '@engine/theme-updates';
import { definitionHash } from '@shared/migrations';
import { headingOutline, pageHeadings } from '@generator/checks';
import { generateProject } from '@generator/index';

const fresh = () => createStarterState('business', 'Test Studio', false);
const pageAt = (s: ProjectState, route: string) => s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.route === route)!;
const headingWarnings = (s: ProjectState) => validateState(s).filter((d) => d.code.startsWith('HEADING_'));
const own = (s: ProjectState, pageId: string) => headingOutline(s, pageId).filter((h) => h.owner.kind === 'page');
const rows = (s: ProjectState, pageId: string) => own(s, pageId).map((h) => [h.level, h.text]);

/** The issue's page: the Contact page's introduction followed by a Centered hero. */
function contactWithHero(s = fresh()) {
  const contact = pageAt(s, '/contact/');
  const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: contact.id }, componentId: 'hero.centered', index: 1 }]);
  return { s: r.state, pageId: contact.id, heroId: r.state.pages[contact.id].rootIds[1] };
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
      [1, 'Thoughtful work for people who care about the details']
    ]);
    // The hero's heading is a part of a section placed on the page, and its level is that placement's choice.
    expect(main[1]).toMatchObject({ owner: { kind: 'page', id: pageId }, nodeId: heroId, defNodeId: 'heading', direct: true, levelSource: { kind: 'prop', prop: 'headingLevel' }, levels: [1, 2, 3, 4, 5, 6] });
  });

  it('reads the shared header and footer around the page, unless the page leaves them out', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    const footer = headingOutline(s, about.id).filter((h) => h.owner.kind === 'shell');
    expect(footer.length).toBeGreaterThan(0);
    expect(footer.every((h) => h.owner.id === 'footer' && h.level === 2)).toBe(true);
    s.pages[about.id].shell = 'none';
    expect(headingOutline(s, about.id).every((h) => h.owner.kind === 'page')).toBe(true);
  });

  it('leaves out a heading whose words are cleared, as the site does', () => {
    const { s, pageId, heroId } = contactWithHero();
    const r = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId: heroId, prop: 'heading', value: '' }]).state;
    expect(rows(r, pageId).filter(([level]) => level === 1)).toEqual([[1, 'Let’s talk']]);
    expect(headingWarnings(r)).toEqual([]);
  });

  it('lists subheadings written in rich text, and the contact form’s heading', () => {
    const s = fresh();
    const about = pageAt(s, '/about/');
    const owner = { kind: 'page' as const, id: about.id };
    let r = applyOperations(s, [{ type: 'node.insert', owner, componentId: 'content.text', props: { heading: 'How we work', body: [{ type: 'h3', spans: [{ text: 'Listening first' }] }, { type: 'p', spans: [{ text: 'Words.' }] }] } }]);
    r = applyOperations(r.state, [{ type: 'node.insert', owner, componentId: 'contact.form', props: { heading: 'Write to us' } }]);
    const tail = own(r.state, about.id).slice(-3);
    expect(tail.map((h) => [h.level, h.text, !!h.rich, !!h.levelSource])).toEqual([
      [2, 'How we work', false, true],
      [3, 'Listening first', true, false],
      [2, 'Write to us', false, false]
    ]);
  });

  it('marks a page’s own heading as changed by its tag, and an older design’s fixed heading as not changeable', () => {
    const s = fresh();
    const home = s.site.homePageId;
    withHeadings(s, home, [{ id: 'n_title', tag: 'h1', text: 'Welcome' }]);
    expect(own(s, home)[0]).toMatchObject({ level: 1, text: 'Welcome', nodeId: 'n_title', levelSource: { kind: 'node' } });
    // A hero installed before its heading level could be chosen keeps a fixed Heading 1.
    const { s: withHero, pageId } = contactWithHero();
    const hero = withHero.components['foundation.hero.centered'];
    delete hero.properties.headingLevel;
    (hero.tree!.nodes.heading as TextNode).tag = 'h1';
    expect(own(withHero, pageId)[1]).toMatchObject({ level: 1, defNodeId: 'heading' });
    expect(own(withHero, pageId)[1].levelSource).toBeUndefined();
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

describe('heading review in Project health', () => {
  it('warns about a second page title without blocking saving or export, and keeps the unlinked button warnings', () => {
    const { s, pageId, heroId } = contactWithHero();
    const found = headingWarnings(s);
    expect(found).toEqual([expect.objectContaining({ severity: 'warning', code: 'HEADING_MULTIPLE_H1', owner: { kind: 'page', id: pageId }, nodeId: heroId })]);
    expect(found[0].message).toBe(
      'Contact: 2 headings are Heading 1s (“Let’s talk” and “Thoughtful work for people who care about the details”), so screen readers announce more than one page title. Keep the page’s title as Heading 1 and make the others Heading 2, unless they are meant to be titles.'
    );
    expect(found.some(blocksSaving)).toBe(false);
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toHaveLength(2);
    // Save gates skip the review: it can never block a change.
    expect(validateState(s, { sectionLinks: false }).filter((d) => d.code.startsWith('HEADING_'))).toEqual([]);
  });

  it('clears the warning once the hero is a Heading 2, which keeps its look and renders an h2', () => {
    const { s, pageId, heroId } = contactWithHero();
    const before = structuredClone(s.pages[pageId].nodes[heroId]);
    const r = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId: heroId, prop: 'headingLevel', value: 'h2' }]).state;
    expect(rows(r, pageId).slice(0, 2)).toEqual([
      [1, 'Let’s talk'],
      [2, 'Thoughtful work for people who care about the details']
    ]);
    expect(headingWarnings(r)).toEqual([]);
    // Only the level changed: no style override, variant or other content.
    expect(r.pages[pageId].nodes[heroId]).toEqual({ ...before, props: { ...(before as InstanceNode).props, headingLevel: 'h2' } });
    const hero = [...generateProject(r).entries()].find(([path]) => path.endsWith('hero-centered.svelte'))?.[1] ?? '';
    expect(hero).toMatch(/headingLevel === "h2"|headingLevel === 'h2'/);
  });

  it('warns when a page has no Heading 1, but not when the page is empty', () => {
    const s = fresh();
    const contact = pageAt(s, '/contact/');
    const intro = s.pages[contact.id].rootIds[0];
    const r = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId: intro, prop: 'headingLevel', value: 'h2' }]).state;
    expect(headingWarnings(r)).toEqual([
      expect.objectContaining({ code: 'HEADING_MISSING_H1', owner: { kind: 'page', id: contact.id }, message: 'Contact: no heading is a Heading 1, so the page has no title for screen readers to announce. Make the page’s main heading Heading 1.' })
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
      { id: 'n_e', tag: 'h2', text: 'Contact' }
    ]);
    expect(pageHeadings(s, home).review.skips).toEqual([{ index: 2, after: 2, suggest: 3 }]);
    expect(headingWarnings(s)).toEqual([
      expect.objectContaining({ code: 'HEADING_LEVEL_SKIP', nodeId: 'n_c', message: 'Home: “Planning” is a Heading 4 right after a Heading 2, so the outline skips a level. Make it Heading 3.' })
    ]);
  });

  it('finds nothing to review on the starter sites', () => {
    expect(headingWarnings(fresh())).toEqual([]);
    expect(headingWarnings(createStarterState('blank', 'Blank', false))).toEqual([]);
  });

  it('offers a heading level once an older installed hero is updated from the theme', () => {
    const { s, pageId } = contactWithHero();
    const hero = s.components['foundation.hero.centered'];
    // The hero as installed before its heading level could be chosen.
    delete hero.properties.headingLevel;
    (hero.tree!.nodes.heading as TextNode).tag = 'h1';
    s.themeLock.components[hero.id].hash = definitionHash(hero);
    expect(own(s, pageId)[1].levelSource).toBeUndefined();
    expect(themeUpdates(s).available.map((u) => u.id)).toContain(hero.id);
    const next = applyOperations(s, [{ type: 'theme.refresh' }]).state;
    expect(own(next, pageId)[1]).toMatchObject({ level: 1, levelSource: { kind: 'prop', prop: 'headingLevel' } });
  });
});
