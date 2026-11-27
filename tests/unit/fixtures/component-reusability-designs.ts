/**
 * Managed designs shaped like the sections Foundation used to ship as trees, for the reusability checks: a heading
 * bound to a property and a repeated card with its parts, each the slice of the old design the checks read. Foundation
 * now ships Svelte code components, which the checks leave alone, so these stand in as the designs a person makes.
 */
import type { ComponentDefinition, PartDef } from '@shared/types';
import { P, item, prop, tok, type TreeBuilder } from '@catalogue/dsl';
import { foundationDesign } from './packs';

const muted = { color: tok('color.muted') };

/** The section, its container and its heading, as every old Foundation section began. */
const shell = (b: TreeBuilder, children: string[]) =>
  b.el('root', 'section', { name: 'Section', styles: { paddingBlock: tok('space.3xl') } }, [
    b.el('inner', 'div', { name: 'Container', styles: { layout: 'stack', gap: tok('space.2xl') } }, [
      b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading'), styles: { textStyle: tok('text.h2') } }),
      ...children
    ])
  ]);

const sectionParts: Record<string, PartDef> = {
  root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
  heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
  grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] }
};

const grid = (b: TreeBuilder, children: string[]) => b.el('grid', 'ul', { name: 'Card grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, desktop: { columns: 3 } } }, children);

/** Services grid: an icon, a title and a description on a bordered card. */
export const featuresGrid = (): ComponentDefinition =>
  foundationDesign({
    componentId: 'features.grid',
    name: 'Services grid',
    properties: {
      heading: P.str('Heading', 'Services shaped around your project'),
      items: P.list('Cards', 'Card', { icon: P.icon('Icon', 'sparkles'), title: P.str('Title', 'Service'), description: P.text('Description', 'Describe what this service includes.') }, [], { titleField: 'title' })
    },
    parts: {
      ...sectionParts,
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
      cardIcon: { nodeId: 'card-icon', label: 'Card icon', styleControls: ['color', 'background'] }
    },
    build: (b) =>
      shell(b, [
        grid(b, [
          b.repeat('cards', 'items', [
            b.el('card', 'li', { name: 'Card', styles: { layout: 'stack', gap: tok('space.md'), paddingBlock: tok('space.xl'), paddingInline: tok('space.xl'), background: tok('color.surface'), color: tok('color.text'), border: tok('border.default'), radius: tok('radius.lg') } }, [
              b.el('card-icon-wrap', 'div', { name: 'Icon badge', styles: { width: '48px', minHeight: '48px', radius: tok('radius.md'), color: tok('color.brand') } }, [b.icon('card-icon', item('icon'), { name: 'Icon' })]),
              b.text('card-title', 'h3', item('title'), { name: 'Title', styles: { textStyle: tok('text.h3') } }),
              b.text('card-text', 'p', item('description'), { name: 'Description', styles: muted })
            ])
          ])
        ])
      ])
  });

/** Page list: a card per page, with the page's image above its title. */
export const pageList = (): ComponentDefinition =>
  foundationDesign({
    componentId: 'content.pages',
    name: 'Page list',
    properties: {
      heading: P.str('Heading', 'Selected work'),
      items: P.list('Pages', 'Page', { pageLink: P.link('Page'), title: P.str('Title', ''), description: P.text('Description', ''), image: P.image('Image') }, [], { titleField: 'title', min: 0 })
    },
    parts: {
      ...sectionParts,
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'gap'] },
      cardImage: { nodeId: 'card-image', label: 'Card image', styleControls: ['aspectRatio', 'radius'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
      cardText: { nodeId: 'card-text', label: 'Card description', styleControls: ['textStyle', 'color'] }
    },
    build: (b) =>
      shell(b, [
        grid(b, [
          b.repeat('cards', 'items', [
            b.el('card-item', 'li', { name: 'Card item', when: item('pageLink'), collapseEmpty: true }, [
              b.el('card', 'div', { name: 'Card', when: item('title'), styles: { layout: 'stack', gap: tok('space.sm') } }, [
                b.image('card-image', item('image'), { name: 'Image', when: item('image'), styles: { aspectRatio: '4/3', radius: tok('radius.md'), objectFit: 'cover' } }),
                b.link('card-title', item('pageLink'), item('title'), 'plain', { name: 'Title', styles: { textStyle: tok('text.h3') } }),
                b.text('card-text', 'p', item('description'), { name: 'Description', when: item('description'), styles: muted })
              ])
            ])
          ])
        ])
      ])
  });

/** News list: an article named Card per dated article, with only a gap of its own. */
export const newsList = (): ComponentDefinition =>
  foundationDesign({
    componentId: 'content.news',
    name: 'News list',
    properties: {
      heading: P.str('Heading', 'Latest news'),
      items: P.list('Articles', 'Article', { pageLink: P.link('Article'), title: P.str('Title', ''), dateLabel: P.str('Date as shown', ''), excerpt: P.text('Excerpt', '') }, [], { titleField: 'title', min: 0, feed: 'articles' })
    },
    parts: {
      ...sectionParts,
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'gap'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
      cardMeta: { nodeId: 'card-meta', label: 'Date', styleControls: ['textStyle', 'color'] },
      cardText: { nodeId: 'card-text', label: 'Card excerpt', styleControls: ['textStyle', 'color'] }
    },
    build: (b) =>
      shell(b, [
        grid(b, [
          b.repeat('cards', 'items', [
            b.el('card-item', 'li', { name: 'Card item', when: item('pageLink') }, [
              b.el('card', 'article', { name: 'Card', styles: { layout: 'stack', gap: tok('space.sm') } }, [
                b.link('card-title', item('pageLink'), item('title'), 'plain', { name: 'Title', styles: { textStyle: tok('text.h3') } }),
                b.text('card-meta', 'p', item('dateLabel'), { name: 'Date', when: item('dateLabel'), styles: { textStyle: tok('text.small'), ...muted } }),
                b.text('card-text', 'p', item('excerpt'), { name: 'Excerpt', when: item('excerpt'), styles: muted })
              ])
            ])
          ])
        ])
      ])
  });

/** Team: a 4:5 portrait above each person's name, the card's picture. */
export const team = (): ComponentDefinition =>
  foundationDesign({
    componentId: 'team.grid',
    name: 'Team',
    properties: {
      heading: P.str('Heading', 'The people you will work with'),
      people: P.list('People', 'Person', { portrait: P.image('Portrait'), name: P.required(P.str('Name', 'Name')), role: P.str('Role', '') }, [], { titleField: 'name' })
    },
    parts: {
      ...sectionParts,
      portrait: { nodeId: 'portrait', label: 'Portrait', styleControls: ['aspectRatio', 'radius'] },
      name: { nodeId: 'name', label: 'Name', styleControls: ['textStyle', 'color'] }
    },
    build: (b) =>
      shell(b, [
        grid(b, [
          b.repeat('members', 'people', [
            b.el('member', 'li', { name: 'Person', styles: { layout: 'stack', gap: tok('space.xs') } }, [
              b.image('portrait', item('portrait'), { name: 'Portrait', when: item('portrait'), styles: { aspectRatio: '4/5', radius: tok('radius.lg'), objectFit: 'cover' } }),
              b.text('name', 'h3', item('name'), { name: 'Name', styles: { textStyle: tok('text.h3') } }),
              b.text('role', 'p', item('role'), { name: 'Role', when: item('role'), styles: { color: tok('color.brand') } })
            ])
          ])
        ])
      ])
  });

/** Testimonials: a quote on a card, with a 44px round portrait beside the name, which is a detail and not a part. */
export const testimonials = (): ComponentDefinition =>
  foundationDesign({
    componentId: 'testimonials.grid',
    name: 'Testimonials',
    properties: {
      heading: P.str('Heading', 'What our clients say'),
      items: P.list('Testimonials', 'Testimonial', { quote: P.required(P.text('Quote', 'A short quote.')), name: P.str('Name', 'Client name'), portrait: P.image('Portrait') }, [], { titleField: 'name' })
    },
    parts: {
      ...sectionParts,
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow'] },
      quote: { nodeId: 'quote', label: 'Quote', styleControls: ['textStyle', 'color'] }
    },
    build: (b) =>
      shell(b, [
        grid(b, [
          b.repeat('quotes', 'items', [
            b.el('card', 'li', { name: 'Card', styles: { layout: 'stack', gap: tok('space.xl'), paddingBlock: tok('space.xl'), background: tok('color.surface'), radius: tok('radius.lg'), shadow: tok('shadow.sm') } }, [
              b.text('quote', 'p', item('quote'), { name: 'Quote', styles: { fontSize: '1.08rem', lineHeight: '1.6' } }),
              b.el('person', 'div', { name: 'Attribution', styles: { layout: 'row', align: 'center', gap: tok('space.sm') } }, [
                b.image('portrait', item('portrait'), { name: 'Portrait', when: item('portrait'), styles: { width: '44px', minHeight: '0', aspectRatio: '1/1', radius: tok('radius.pill'), objectFit: 'cover' } }),
                b.text('name', 'cite', item('name'), { name: 'Name', styles: { fontWeight: '600' } })
              ])
            ])
          ])
        ])
      ])
  });

/** Every design above, in the order the checks read them. */
export const reusabilityDesigns = (): ComponentDefinition[] => [featuresGrid(), pageList(), newsList(), team(), testimonials()];
