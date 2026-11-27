/**
 * Managed designs for the tests of what the editor does with a design built in the editor (its tree, parts, repeats,
 * slots and variants): copy and paste, anchors, Layers, spacing drags, Turn into slot. Foundation ships only code
 * components, so these are slices of its old managed Services grid, Split hero, Statistics and Section, with the node
 * IDs, part IDs and names those tests read, on the loaded Foundation's tokens.
 */
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { P, item, prop, tok } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { foundationDesign, type DesignSpec } from './packs';

/** A section's root and its centred Container, around `children`. */
const shell = (b: Parameters<DesignSpec['build']>[0], children: string[]) =>
  b.el('root', 'section', { name: 'Section', styles: { base: { paddingBlock: tok('space.3xl') } } }, [
    b.el('inner', 'div', { name: 'Container', styles: { base: { layout: 'stack', gap: tok('space.2xl'), maxWidth: tok('container.content'), marginInline: 'auto' } } }, children)
  ]);

/** Cards repeated over a list, each with an icon badge, a title and a description, under a heading. */
export const servicesGrid = (componentId = 'test.grid'): DesignSpec => ({
  componentId,
  name: 'Services grid',
  properties: {
    heading: P.str('Heading', 'Services shaped around your project'),
    items: P.list(
      'Cards',
      'Card',
      { icon: P.icon('Icon', 'sparkles'), title: P.str('Title', 'Service'), description: P.text('Description', 'What this service includes.') },
      [
        { icon: 'compass', title: 'Planning', description: 'Clear priorities and a realistic budget.' },
        { icon: 'pen-tool', title: 'Design', description: 'Considered layouts developed with you.' },
        { icon: 'hammer', title: 'Delivery', description: 'Trusted specialists at every stage.' }
      ],
      { titleField: 'title', max: 12 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
    card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'paddingBlock', 'paddingInline'] },
    cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
    cardIcon: { nodeId: 'card-icon', label: 'Card icon', styleControls: ['color', 'background'] }
  },
  variantAxes: {
    tone: { label: 'Tone', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background', styles: { root: { base: { background: tok('color.surface-alt') } } } } } },
    layout: {
      label: 'Layout',
      default: 'default',
      options: {
        default: { label: 'Three columns' },
        'two-columns': { label: 'Two columns', styles: { grid: { desktop: { columns: 2 } } } },
        'four-columns': { label: 'Four columns', styles: { grid: { desktop: { columns: 4 } } } }
      }
    }
  },
  build: (b) =>
    shell(b, [
      b.text('heading', 'h2', prop('heading'), { name: 'Heading', styles: { textStyle: tok('text.h2') } }),
      b.el('grid', 'ul', { name: 'Card grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, desktop: { columns: 3 } } }, [
        b.repeat('cards', 'items', [
          b.el('card', 'li', { name: 'Card', styles: { layout: 'stack', gap: tok('space.md') } }, [
            b.el('card-icon-wrap', 'div', { name: 'Icon badge', styles: { layout: 'row', width: '48px', minHeight: '48px' } }, [b.icon('card-icon', item('icon'), { name: 'Icon' })]),
            b.text('card-title', 'h3', item('title'), { name: 'Title', styles: { textStyle: tok('text.h3') } }),
            b.text('card-text', 'p', item('description'), { name: 'Description' })
          ])
        ])
      ])
    ])
});

/** A heading and supporting text in a wrapper that is no part, beside an image bound to the `image` property. */
export const splitHero = (componentId = 'test.hero'): DesignSpec => ({
  componentId,
  name: 'Split hero',
  properties: {
    heading: P.str('Heading', 'Homes designed around the way you live'),
    lead: P.text('Supporting text', 'Architecture and interiors for considered living.'),
    image: P.image('Image', 'A bright living room')
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'gap'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    media: { nodeId: 'media', label: 'Image', styleControls: ['radius'] }
  },
  build: (b) =>
    shell(b, [
      b.el('copy', 'div', { name: 'Copy', styles: { layout: 'stack', gap: tok('space.md') } }, [
        b.text('heading', 'h1', prop('heading'), { name: 'Heading', styles: { textStyle: tok('text.h1') } }),
        b.text('lead', 'p', prop('lead'), { name: 'Supporting text' })
      ]),
      b.image('media', prop('image'), { name: 'Image' })
    ])
});

/** Large figures with short labels, repeated over a list. */
export const statsRow = (componentId = 'test.stats'): DesignSpec => ({
  componentId,
  name: 'Statistics',
  properties: {
    items: P.list('Figures', 'Figure', { value: P.str('Value', '100+'), label: P.str('Label', 'Projects completed') }, [
      { value: '15', label: 'Years in practice' },
      { value: '240+', label: 'Projects completed' }
    ], { titleField: 'label', max: 8 })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    grid: { nodeId: 'grid', label: 'Grid', styleControls: ['columns', 'gap'] }
  },
  build: (b) =>
    shell(b, [
      b.el('grid', 'dl', { name: 'Grid', styles: { layout: 'grid', columns: 2 } }, [
        b.repeat('figures', 'items', [
          b.el('figure', 'div', { name: 'Figure' }, [b.text('label', 'dt', item('label'), { name: 'Label' }), b.text('value', 'dd', item('value'), { name: 'Value' })])
        ])
      ])
    ])
});

/** An empty section whose Container holds its Content slot, with the column controls the theme's Section offers. */
export const contentSection = (componentId = 'test.section'): DesignSpec => ({
  componentId,
  name: 'Section',
  category: 'layout',
  properties: {},
  slots: { content: { label: 'Content', description: 'Headings, text, images, buttons and components placed inside the section.' } },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'paddingInline', 'background', 'color', 'minHeight'] },
    container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'layout', 'columns', 'gridTemplate', 'gridAutoFlow', 'gridAutoRows', 'gap', 'rowGap', 'columnGap', 'align', 'justify', 'textAlign'] }
  },
  build: (b) => shell(b, [b.slot('content-slot', 'content', { name: 'Content' })])
});

/** Add these designs to the project as Foundation's own installed sections, and return them as added. */
export function installThemeDesigns(state: ProjectState, ...specs: DesignSpec[]): ComponentDefinition[] {
  return specs.map((spec) => {
    const def = foundationDesign(spec);
    state.components[def.id] = def;
    return def;
  });
}

/** Place a design on the home page, at `index` (the end by default), and return the placement. */
export function placeOnHome(state: ProjectState, def: ComponentDefinition, index?: number): InstanceNode {
  const page = state.pages[state.site.homePageId];
  const node = makeInstance(def);
  page.nodes[node.id] = node;
  page.rootIds.splice(index ?? page.rootIds.length, 0, node.id);
  return node;
}
