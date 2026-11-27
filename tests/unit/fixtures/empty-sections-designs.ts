/**
 * Managed stand-ins for Foundation's Gallery, Carousel, News list and Page list, for the tests of sections that have
 * nothing to show visitors and of the links a gallery's photos follow: the same definition IDs, names and properties
 * as the release's (so their default headings and list schemas, a feed or page teaser included, are the release's),
 * with a tree whose content list is a repeat in a container that collapses while it is empty, as the managed
 * Foundation drew them. The release's are Svelte code components, whose lists emptySections cannot find and whose
 * photos' actions publicationPlan cannot read (the Release gap tests in empty-sections.test.ts and draft-pages.test.ts).
 */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { item, prop } from '@catalogue/dsl';
import { foundationDesign, type DesignSpec } from './packs';

type Build = DesignSpec['build'];

/** The release's definition with its tree drawn as a managed design, under the same ID, name and properties. */
function managedLike(release: ComponentDefinition, build: Build): ComponentDefinition {
  const def = foundationDesign({ componentId: release.componentId, name: release.name, category: release.category, properties: structuredClone(release.properties), parts: {}, build });
  if (def.id !== release.id) throw new Error(`The managed ${release.componentId} is ${def.id}, not the release's ${release.id}.`);
  return def;
}

/** A section with its heading and, in a container that collapses while empty, a repeat of `list` showing `card`. */
const listSection =
  (list: string, card: (b: Parameters<Build>[0]) => string[], each: Parameters<Parameters<Build>[0]['el']>[2] = {}): Build =>
  (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
      b.el('grid', 'ul', { name: 'List', collapseEmpty: true }, [b.repeat('cards', list, [b.el('card', 'li', { name: 'Card', ...each }, card(b))])])
    ]);

/** The designs by component ID: a picture and its caption per image or slide, a link per article, a card per page. */
const DESIGNS: Record<string, Build> = {
  // A photo's action wraps its figure in one link (to the full-size image, or its destination) while it is not none.
  'media.gallery': listSection('images', (b) => [
    b.el('figure', 'figure', { name: 'Figure', action: item('action'), link: item('link') }, [b.image('image', item('image'), { name: 'Image' }), b.text('caption', 'p', item('caption'), { name: 'Caption', when: item('caption') })])
  ]),
  'media.carousel': listSection('slides', (b) => [b.image('image', item('image'), { name: 'Image' }), b.text('caption', 'p', item('caption'), { name: 'Caption', when: item('caption') })]),
  'content.news': listSection('items', (b) => [b.link('title', item('pageLink'), item('title'), 'plain', { name: 'Title' })]),
  // A card shows only for a page of the site, and with a title.
  'content.pages': listSection('items', (b) => [b.el('teaser', 'div', { name: 'Teaser', when: item('title') }, [b.link('title', item('pageLink'), item('title'), 'plain', { name: 'Title' })])], { when: item('pageLink'), collapseEmpty: true })
};

/** The project with the release's Gallery, Carousel, News list and Page list, wherever it has them, drawn as the managed designs above. */
export function withManagedLists(state: ProjectState): ProjectState {
  for (const [id, def] of Object.entries(state.components)) {
    const build = Object.hasOwn(DESIGNS, def.componentId) ? DESIGNS[def.componentId] : undefined;
    if (build && def.kind === 'code') state.components[id] = managedLike(def, build);
  }
  return state;
}
