/**
 * Managed designs for the Component Studio tests, shaped like the sections Foundation used to ship as trees: the
 * studio previews and picks a design's own nodes, which only a design built in the editor has. Foundation now ships
 * Svelte code components, so these stand in, stamped as Foundation's (theme-owned), as an installed theme design was.
 */
import type { ComponentDefinition } from '@shared/types';
import { P, item, prop, tok } from '@catalogue/dsl';
import { foundationDesign } from './packs';

/** Services grid: a heading over a card per item (an icon, a title and a description), with a Tone axis. */
export const servicesGrid = (): ComponentDefinition =>
  foundationDesign({
    componentId: 'test.services',
    name: 'Services grid',
    properties: {
      heading: P.str('Heading', 'Services shaped around your project'),
      items: P.list(
        'Cards',
        'Card',
        { icon: P.icon('Icon', 'sparkles'), title: P.str('Title', 'Service'), description: P.text('Description', 'Describe what this service includes.') },
        [
          { icon: 'compass', title: 'Planning', description: 'Clear priorities and a realistic budget.' },
          { icon: 'pen-tool', title: 'Design', description: 'Drawings your builder can price.' },
          { icon: 'hammer', title: 'Build', description: 'We stay on site until it is done.' }
        ],
        { titleField: 'title' }
      )
    },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] }
    },
    variantAxes: {
      tone: {
        label: 'Tone',
        default: 'default',
        options: { default: { label: 'Default' }, muted: { label: 'Soft background', styles: { root: { base: { background: tok('color.surface-alt') } } } } }
      }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section', styles: { paddingBlock: tok('space.section') } }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.el('grid', 'ul', { name: 'Card grid', styles: { layout: 'grid', columns: 1, gap: tok('space.lg') } }, [
          b.repeat('cards', 'items', [
            b.el('card', 'li', { name: 'Card', styles: { layout: 'stack', gap: tok('space.md') } }, [
              b.icon('card-icon', item('icon'), { name: 'Icon' }),
              b.text('card-title', 'h3', item('title'), { name: 'Title' }),
              b.text('card-text', 'p', item('description'), { name: 'Description' })
            ])
          ])
        ])
      ])
  });

/** Content with image: a heading, a paragraph and a picture. */
export const mediaBlock = (): ComponentDefinition =>
  foundationDesign({
    componentId: 'test.media',
    name: 'Content with image',
    properties: { heading: P.str('Heading', 'Rooms planned around you'), body: P.text('Text', 'We plan every room with you.'), image: P.image('Image') },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.el('copy', 'div', { name: 'Copy' }, [b.text('heading', 'h2', prop('heading'), { name: 'Heading' }), b.text('body', 'p', prop('body'), { name: 'Text' })]),
        b.image('media', prop('image'), { name: 'Image' })
      ])
  });
