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
const newPage = (s: ProjectState, title: string, draft = false) => run(s, { type: 'page.create', pageId: `pg_${title.toLowerCase()}`, title, route: `/${title.toLowerCase()}/`, starter: 'empty', draft });

describe('published pages with nothing on them (#1550)', () => {
  for (const starter of ['business', 'showcase'] as const)
    it(`finds none in the ${starter} starter`, () => {
      const s = createStarterState(starter, 'Test Studio', false);
      expect(health(s)).toEqual([]);
      expect(notes(s)).toEqual([]);
    });

  it('names an empty page in Project health and the export notes', () => {
    const s = newPage(business(), 'News');
    expect(health(s)).toEqual([{ severity: 'warning', code: 'PAGE_EMPTY', message: 'News: this page has nothing on it, so visitors find it blank. Add content to it, keep it as a draft, or remove it.', owner: { kind: 'page', id: 'pg_news' } }]);
    expect(notes(s)).toEqual(['A page has nothing on it, so visitors find it blank. Add content to it, or keep it off the website:', 'News (/news/)']);
  });

  it('does not suggest drafting or removing an empty Home page', () => {
    const s = createStarterState('blank', 'Test Studio', false);
    expect(health(s).map((d) => d.message)).toEqual(['Home: this page has nothing on it, so visitors find it blank. Add content to it.']);
    expect(notes(s).slice(1)).toEqual(['Home (/)']);
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
    add({ id: 'n_text', kind: 'text', tag: 'p', text: 'Opening soon.' });
    (page.nodes.n_inner as Extract<GraphNode, { kind: 'element' }>).children = ['n_text'];
    expect(health(s)).toEqual([]);
    expect(notes(s)).toEqual([]);
  });

  it('counts a container’s background image as content', () => {
    const s = newPage(business(), 'Photo');
    const page = s.pages.pg_photo;
    page.nodes.n_photo = { id: 'n_photo', kind: 'element', tag: 'section', children: [], styles: { base: { backgroundImage: { assetId: 'a_hero' }, minHeight: '400px' } } };
    page.rootIds = ['n_photo'];
    expect(health(s)).toEqual([]);
    expect(notes(s)).toEqual([]);
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
