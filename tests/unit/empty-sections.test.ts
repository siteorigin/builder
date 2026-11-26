import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { validateState } from '@engine/validate';
import { emptySections } from '@generator/checks';
import { emptySectionWarnings } from '../../src/main/export';

const home = (s: ProjectState) => s.pages[s.site.homePageId];

/** A blank site with each of the given catalogue components placed on Home with its defaults. */
function blankWith(...componentIds: string[]) {
  const s = createStarterState('blank', 'Test Studio', false);
  const placed: InstanceNode[] = [];
  for (const componentId of componentIds) {
    const node = makeInstance(s.components[installComponent(s, componentId)], {}) as InstanceNode;
    home(s).nodes[node.id] = node;
    home(s).rootIds.push(node.id);
    placed.push(node);
  }
  return { s, placed };
}

const FIVE = ['media.gallery', 'media.carousel', 'media.video', 'content.news', 'content.pages'];

describe('sections with no content (#881)', () => {
  it('finds every section inserted with its defaults, as Project health and the export notes report them', () => {
    const { s, placed } = blankWith(...FIVE);
    expect(emptySections(s, home(s)).map((e) => e.nodeId)).toEqual(placed.map((n) => n.id));
    const health = validateState(s).filter((d) => d.code === 'SECTION_EMPTY');
    expect(health.map((d) => d.nodeId)).toEqual(placed.map((n) => n.id));
    for (const d of health) expect(d.owner).toEqual({ kind: 'page', id: s.site.homePageId });
    const notes = emptySectionWarnings(s);
    expect(notes[0]).toMatch(/^5 sections have nothing to show/);
    expect(notes.slice(1).map((l) => l.replace(/:.*/, ''))).toEqual(['Home · Gallery', 'Home · Carousel', 'Home · Video', 'Home · News list', 'Home · Page list']);
    expect(notes[1]).toContain('“Recent projects”');
  });

  it('says nothing of a section once it has content', () => {
    const { s, placed } = blankWith('media.gallery', 'media.video');
    const [gallery, video] = placed;
    const asset = Object.values(s.assets.assets).find((a) => a.kind === 'image');
    gallery.props.images = [{ id: 'i1', image: asset ? { assetId: asset.id, alt: 'A' } : { src: 'https://example.com/a.jpg', alt: 'A' }, caption: '', action: 'none', link: { type: 'none', target: '' } }];
    video.props.url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    expect(emptySections(s, home(s))).toEqual([]);
    expect(validateState(s).filter((d) => d.code === 'SECTION_EMPTY')).toEqual([]);
    expect(emptySectionWarnings(s)).toEqual([]);
  });

  it('reports a page list whose cards all lead nowhere, and not one with a card for a page of the site', () => {
    const { s, placed } = blankWith('content.pages');
    const [list] = placed;
    list.props.items = [{ id: 'c1', pageLink: { type: 'page', target: 'p_gone' }, title: '', description: '', group: '' }];
    expect(emptySections(s, home(s)).map((e) => e.what)).toEqual(['pages']);
    list.props.items = [{ id: 'c1', pageLink: { type: 'page', target: addPage(s, 'About').id }, title: '', description: '', group: '' }];
    expect(emptySections(s, home(s))).toEqual([]);
  });

  it('reports a news list while every article is a draft or hidden from news lists, and not once one is published', () => {
    const { s } = blankWith('content.news');
    const story = addPage(s, 'Our new studio');
    story.article = { date: '2026-11-01' };
    story.draft = true;
    const other = addPage(s, 'Quiet news');
    other.article = { date: '2026-10-01', hidden: true };
    const [found] = emptySections(s, home(s));
    expect(found).toMatchObject({ name: 'News list', heading: 'Latest news', what: 'articles' });
    expect(validateState(s).find((d) => d.code === 'SECTION_EMPTY')?.message).toBe(
      'Home: the News list “Latest news” has no articles to show, so visitors see its heading with nothing under it. Publish a dated article that news lists show, or remove the section.'
    );
    delete story.draft;
    expect(emptySections(s, home(s))).toEqual([]);
  });

  it('leaves out a section visitors never see', () => {
    const { s, placed } = blankWith('media.gallery', 'media.video');
    for (const n of placed) n.styles = { base: { hidden: true } };
    expect(emptySections(s, home(s))).toEqual([]);
  });

  it('says an empty section with no heading shows as an empty section', () => {
    const { s, placed } = blankWith('media.carousel');
    placed[0].props.heading = '';
    expect(validateState(s).find((d) => d.code === 'SECTION_EMPTY')?.message).toBe(
      'Home: the Carousel has no slides to show, so visitors see an empty section. Choose its slides from Assets, or remove the section.'
    );
    expect(emptySectionWarnings(s)).toEqual(['A section has nothing to show visitors. Give it content, or remove it (Project health leads to it):', 'Home · Carousel: has no slides']);
  });

  it('finds nothing to report in the Business starter', () => {
    const s = createStarterState('business', 'Test Studio', false);
    expect(validateState(s).filter((d) => d.code === 'SECTION_EMPTY')).toEqual([]);
    expect(emptySectionWarnings(s)).toEqual([]);
  });
});

/** A published page added to the site after Home, with nothing on it. */
function addPage(s: ProjectState, title: string) {
  const id = `p_${title.toLowerCase().replace(/\W+/g, '_')}`;
  const page = { ...structuredClone(home(s)), id, title, route: `/${id}`, nodes: {}, rootIds: [] };
  delete (page as { article?: unknown }).article;
  s.pages[id] = page;
  s.site.pageOrder.push(id);
  return page;
}
