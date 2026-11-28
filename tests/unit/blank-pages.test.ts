/**
 * A published page with nothing on it (#1550) is named in Project health, which the Export dialog counts before an
 * export, and in the export's notes.
 */
import { describe, expect, it } from 'vitest';
import type { GraphNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { publishedState } from '@generator/index';
import { blankPageWarnings } from '../../src/main/export';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const health = (s: ProjectState) => validateState(s).filter((d) => d.code === 'PAGE_EMPTY');
const notes = (s: ProjectState) => blankPageWarnings(publishedState(s));
const business = () => createStarterState('business', 'Test Studio', false);
const newPage = (s: ProjectState, title: string, draft = false, route = `/${title.toLowerCase()}/`) => run(s, { type: 'page.create', pageId: `pg_${title.toLowerCase()}`, title, route, starter: 'empty', draft });

describe('published pages with nothing on them (#1550)', () => {
  for (const starter of ['business', 'showcase'] as const)
    it(`finds none in the ${starter} starter`, () => {
      const s = createStarterState(starter, 'Test Studio', false);
      expect(health(s)).toEqual([]);
      expect(notes(s)).toEqual([]);
    });

  it('names an empty page in Project health and the export notes', () => {
    const s = newPage(business(), 'News', false, '/latest/');
    expect(health(s)).toEqual([{ severity: 'warning', code: 'PAGE_EMPTY', message: 'News: this page has nothing on it, so visitors find it blank. Add content to it, keep it as a draft, or remove it.', owner: { kind: 'page', id: 'pg_news' } }]);
    expect(notes(s)).toEqual(['A page has nothing on it, so visitors find it blank. Add content to it, or keep it off the website:', 'News (/latest/)']);
  });

  it('does not suggest drafting or removing an empty Home page', () => {
    const s = createStarterState('blank', 'Test Studio', false);
    expect(health(s).map((d) => d.message)).toEqual(['Home: this page has nothing on it, so visitors find it blank. Add content to it.']);
    expect(notes(s)).toEqual(['A page has nothing on it, so visitors find it blank. Add content to it, or keep it off the website:', 'Home (/)']);
  });

  it('leaves out a draft, which the website does not publish', () => {
    const s = newPage(business(), 'Later', true);
    expect(health(s)).toEqual([]);
    expect(notes(s)).toEqual([]);
  });

  it('counts empty containers as nothing, and anything inside them as content', () => {
    const s = newPage(business(), 'Shell');
    const page = s.pages.pg_shell;
    const add = (n: GraphNode) => (page.nodes[n.id] = n);
    add({ id: 'n_outer', kind: 'element', tag: 'section', children: ['n_inner'] });
    add({ id: 'n_inner', kind: 'element', tag: 'div', children: [] });
    page.rootIds = ['n_outer'];
    expect(health(s)).toHaveLength(1);
    // The second of two children, beside an empty one.
    add({ id: 'n_text', kind: 'text', tag: 'p', text: 'Opening soon.' });
    add({ id: 'n_empty', kind: 'element', tag: 'div', children: [] });
    (page.nodes.n_inner as Extract<GraphNode, { kind: 'element' }>).children = ['n_empty', 'n_text'];
    expect(health(s)).toEqual([]);
    expect(notes(s)).toEqual([]);
  });

  it('counts content hidden at every size as nothing, and content some size shows as content', () => {
    const s = newPage(business(), 'Hidden');
    const page = s.pages.pg_hidden;
    page.nodes.n_text = { id: 'n_text', kind: 'text', tag: 'h1', text: 'Not yet.', styles: { base: { hidden: true } } };
    page.rootIds = ['n_text'];
    expect(health(s)).toHaveLength(1);
    page.nodes.n_text.styles = { base: { hidden: true }, phone: { hidden: false } };
    expect(health(s)).toEqual([]);
  });

  it('reads a container that holds itself without looping', () => {
    const s = newPage(business(), 'Loop');
    const page = s.pages.pg_loop;
    page.nodes.n_loop = { id: 'n_loop', kind: 'element', tag: 'div', children: ['n_loop'] };
    page.rootIds = ['n_loop'];
    expect(notes(s).slice(1)).toEqual(['Loop (/loop/)']);
  });

  it('counts a container’s background image as content', () => {
    const s = newPage(business(), 'Photo');
    const page = s.pages.pg_photo;
    page.nodes.n_photo = { id: 'n_photo', kind: 'element', tag: 'section', children: [], styles: { base: { backgroundImage: { assetId: 'a_hero' }, minHeight: '400px' } } };
    page.rootIds = ['n_photo'];
    expect(health(s)).toEqual([]);
    expect(notes(s)).toEqual([]);
    delete page.nodes.n_photo.styles!.base!.backgroundImage;
    expect(health(s)).toHaveLength(1);
  });

  it('names seven pages in full', () => {
    let s = business();
    for (const t of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) s = newPage(s, t);
    expect(notes(s)).toHaveLength(8);
    expect(notes(s).at(-1)).toBe('G (/g/)');
  });

  it('sums up the pages past the sixth', () => {
    let s = business();
    for (const t of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) s = newPage(s, t);
    const out = notes(s);
    expect(out[0]).toMatch(/^8 pages have nothing on them/);
    expect(out).toHaveLength(8);
    expect(out.at(-1)).toBe('…and 2 more.');
  });
});
