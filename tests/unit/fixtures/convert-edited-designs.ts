/**
 * The editor-built designs whose generated files the convert-edited tests turn into code (#737): a split hero with
 * two variant axes (its second puts its image first) and an image, and a grid of cards whose card is a part repeated per item. Foundation's own sections are code
 * components already, so these stand on the starter's Home as the project's own designs, the hero first.
 */
import type { ProjectState } from '@shared/types';
import { P, tok } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { projectDesign } from './packs';

export const HERO = 'foundation.test.hero.split';

/** Add the designs to the project and place each on Home, the hero first and the cards after it. */
export function withConvertibleDesigns(state: ProjectState): ProjectState {
  const hero = projectDesign(state, {
    componentId: 'test.hero.split',
    name: 'Split hero',
    category: 'hero',
    properties: { heading: P.str('Heading', 'Designed for living in'), lead: P.text('Supporting text', 'A small studio by the river.'), image: P.image('Image', 'A calm, light-filled studio') },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      media: { nodeId: 'media', label: 'Image', styleControls: ['radius'] }
    },
    variantAxes: {
      tone: { label: 'Tone', default: 'default', options: { default: { label: 'Default' }, inverse: { label: 'Dark', styles: { root: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } } } } } },
      // The image beside the text, before it on a wide screen in the second layout.
      layout: { label: 'Layout', default: 'default', options: { default: { label: 'Image last' }, 'media-start': { label: 'Image first', styles: { 'media-wrap': { desktop: { order: -1 } } } } } }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.el('inner', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1 }, desktop: { columns: 2 } } }, [
          b.el('content', 'div', { name: 'Content' }, [
            b.text('heading', 'h1', { $prop: 'heading' }, { name: 'Heading' }),
            b.text('lead', 'p', { $prop: 'lead' }, { name: 'Supporting text', when: { $prop: 'lead' } })
          ]),
          b.el('media-wrap', 'figure', { name: 'Media' }, [b.image('media', { $prop: 'image' }, { name: 'Image' })])
        ])
      ])
  });
  const cards = projectDesign(state, {
    componentId: 'test.cards',
    name: 'Cards',
    properties: {
      heading: P.str('Heading', 'What we offer'),
      items: P.list('Cards', 'Card', { title: P.str('Title', 'Card') }, [{ title: 'Planning' }, { title: 'Design' }])
    },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] }, card: { nodeId: 'card', label: 'Card', styleControls: ['color', 'background'] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading' }),
        b.el('grid', 'ul', { name: 'Card grid' }, [b.repeat('cards', 'items', [b.el('card', 'li', { name: 'Card' }, [b.text('card-title', 'h3', { $item: 'title' }, { name: 'Title' })])])])
      ])
  });
  const page = state.pages[state.site.homePageId];
  const placed = [makeInstance(hero), makeInstance(cards)];
  for (const n of placed) page.nodes[n.id] = n;
  page.rootIds.splice(0, 0, ...placed.map((n) => n.id));
  return state;
}
