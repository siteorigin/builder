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

/** A published page added to the site after Home, with nothing on it. */
function addPage(s: ProjectState, title: string) {
  const id = `p_${title.toLowerCase().replace(/\W+/g, '_')}`;
  const page = { ...structuredClone(home(s)), id, title, route: `/${id}/`, nodes: {}, rootIds: [] };
  delete (page as { article?: unknown }).article;
  s.pages[id] = page;
  s.site.pageOrder.push(id);
  return page;
}

const health = (s: ProjectState) => validateState(s).filter((d) => d.code === 'SECTION_EMPTY');

const FIVE = ['media.gallery', 'media.carousel', 'media.video', 'content.news', 'content.pages'];

describe('sections with no content (#881)', () => {
  it('reports every section inserted with its defaults in Project health, leading to it, and in the export notes', () => {
    const { s, placed } = blankWith(...FIVE);
    expect(emptySections(s, home(s)).map((e) => e.nodeId)).toEqual(placed.map((n) => n.id));
    const found = health(s);
    expect(found.map((d) => [d.severity, d.nodeId, d.owner])).toEqual(placed.map((n) => ['warning', n.id, { kind: 'page', id: s.site.homePageId }]));
    expect(found.map((d) => d.message)).toEqual([
      'Home: the Gallery “Recent projects” has no images to show visitors. Choose its images from Assets, or remove the section.',
      'Home: the Carousel “Featured projects” has no slides to show visitors. Choose its slides from Assets, or remove the section.',
      'Home: the Video “Take a look around” has no video to show visitors. Paste the address of a YouTube or Vimeo video, or remove the section.',
      'Home: the News list “Latest news” has no articles to show visitors. Publish a dated article that news lists show, or remove the section.',
      'Home: the Page list “Selected work” has no pages to show visitors. Choose the pages it links to, or remove the section.'
    ]);
    expect(emptySectionWarnings(s)).toEqual([
      '5 sections have nothing to show visitors. Give each one content, or remove it (Project health leads to each):',
      'Home · Gallery: “Recent projects” has no images',
      'Home · Carousel: “Featured projects” has no slides',
      'Home · Video: “Take a look around” has no video',
      'Home · News list: “Latest news” has no articles',
      'Home · Page list: “Selected work” has no pages'
    ]);
  });

  it('sums up the sections past the sixth', () => {
    const { s } = blankWith(...FIVE, ...FIVE);
    const notes = emptySectionWarnings(s);
    expect(notes[0]).toMatch(/^10 sections have nothing to show visitors\./);
    expect(notes.slice(1)).toHaveLength(7);
    expect(notes.at(-1)).toBe('…and 4 more.');
  });

  it('says nothing of a section once it has content', () => {
    const { s, placed } = blankWith('media.gallery', 'media.video');
    const [gallery, video] = placed;
    gallery.props.images = [{ id: 'i1', image: { src: 'https://example.com/a.jpg', alt: 'A' }, caption: '', action: 'none', link: { type: 'none', target: '' } }];
    video.props.url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    expect(emptySections(s, home(s))).toEqual([]);
    expect(health(s)).toEqual([]);
    expect(emptySectionWarnings(s)).toEqual([]);
  });

  it('reports a Video whose address is not one its player can play', () => {
    const { s, placed } = blankWith('media.video');
    placed[0].props.url = 'https://example.com/our-tour.mp4';
    expect(emptySections(s, home(s)).map((e) => [e.nodeId, e.what])).toEqual([[placed[0].id, 'video']]);
  });

  it('reports a page list whose cards all lead nowhere, and not one with a card for a page of the site', () => {
    const { s, placed } = blankWith('content.pages');
    const [list] = placed;
    // Titled, so only its missing page hides the card.
    list.props.items = [{ id: 'c1', pageLink: { type: 'page', target: 'p_gone' }, title: 'Old project', description: '', group: '' }];
    expect(emptySections(s, home(s)).map((e) => e.fix)).toEqual(['Choose the pages it links to']);
    list.props.items = [{ id: 'c1', pageLink: { type: 'page', target: addPage(s, 'About').id }, title: '', description: '', group: '' }];
    expect(emptySections(s, home(s))).toEqual([]);
  });

  it('reports a news list while every article is a draft or hidden from news lists, and not once one shows', () => {
    const { s } = blankWith('content.news');
    const story = addPage(s, 'Our new studio');
    story.article = { date: '2026-11-01' };
    story.draft = true;
    const quiet = addPage(s, 'Quiet news');
    quiet.article = { date: '2026-10-01', hidden: true };
    expect(emptySections(s, home(s)).map((e) => e.what)).toEqual(['articles']);
    // Shown in news lists while the other stays a draft.
    delete quiet.article.hidden;
    expect(emptySections(s, home(s))).toEqual([]);
    quiet.article.hidden = true;
    delete story.draft;
    expect(emptySections(s, home(s))).toEqual([]);
  });

  it('leaves out a section visitors never see, and still reports the one beside it', () => {
    const { s, placed } = blankWith('media.gallery', 'media.carousel', 'media.video');
    placed[0].styles = { base: { hidden: true } };
    placed[2].styles = { base: { hidden: true } };
    expect(emptySections(s, home(s)).map((e) => e.nodeId)).toEqual([placed[1].id]);
  });

  it('names an empty section with no heading by what it is', () => {
    const { s, placed } = blankWith('media.carousel');
    placed[0].props.heading = '';
    expect(health(s).map((d) => d.message)).toEqual(['Home: the Carousel has no slides to show visitors. Choose its slides from Assets, or remove the section.']);
    expect(emptySectionWarnings(s)).toEqual(['A section has nothing to show visitors. Give it content, or remove it (Project health leads to it):', 'Home · Carousel: has no slides']);
  });

  it('finds nothing to report in the Business starter', () => {
    const s = createStarterState('business', 'Test Studio', false);
    expect(health(s)).toEqual([]);
    expect(emptySectionWarnings(s)).toEqual([]);
  });
});
