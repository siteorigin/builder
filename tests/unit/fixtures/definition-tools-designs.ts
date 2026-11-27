/**
 * Designs Foundation used to ship as managed trees, written again on the loaded Foundation's tokens for the tests of
 * what the editor and the assistant do with a design's tree: the Split hero (its content column of eyebrow, heading,
 * lead and two buttons, its image beside them, its parts and its Tone and Layout axes), and the slices of the Services
 * grid and Testimonials those tests read. Foundation now ships these as Svelte code components, which have no tree to
 * edit; each is stamped as Foundation's own and, put in a project, takes the place of the release's definition there.
 */
import type { ComponentDefinition, ProjectState, VariantAxis } from '@shared/types';
import { P, item, prop, tok } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { foundationDesign } from './packs';

const muted = { color: tok('color.muted') };
const onInverse = { color: tok('color.on-inverse'), opacity: 0.78 };

const tone: VariantAxis = {
  label: 'Tone',
  default: 'default',
  options: {
    default: { label: 'Default' },
    muted: { label: 'Soft background', styles: { root: { base: { background: tok('color.surface-alt') } } } },
    inverse: { label: 'Dark', styles: { root: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } }, eyebrow: { base: { color: tok('color.accent') } }, lead: { base: onInverse } } }
  }
};

/** The Split hero, as Foundation's own (`foundation.hero.split`, owned by the theme). */
export function splitHero(): ComponentDefinition {
  return foundationDesign({
    componentId: 'hero.split',
    name: 'Split hero',
    description: 'Heading, supporting copy and actions beside a large image. The image side can be swapped.',
    category: 'hero',
    icon: 'panel-right',
    properties: {
      ...P.group('Text', {
        eyebrow: P.copy(P.str('Eyebrow', 'Independent studio')),
        heading: P.copy(P.str('Heading', 'Thoughtful work for people who care about the details')),
        headingLevel: P.choice('Heading level', 'h1', [['h1', 'Heading 1 (page title)'], ['h2', 'Heading 2'], ['h3', 'Heading 3']]),
        lead: P.copy(P.text('Supporting text', 'We help small teams plan, design and deliver projects that feel considered from the first conversation to the final handover.'))
      }),
      ...P.group('Actions', {
        primaryLabel: P.str('Primary button label', 'Start a project'),
        primaryLink: P.link('Primary button link'),
        secondaryLabel: P.str('Secondary button label', 'See our work'),
        secondaryLink: P.link('Secondary button link')
      }),
      ...P.group('Media', { image: P.copy(P.image('Image', 'A calm, light-filled studio workspace')) })
    },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background', 'color', 'minHeight'] },
      container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'gap', 'align'] },
      eyebrow: { nodeId: 'eyebrow', label: 'Eyebrow', styleControls: ['textStyle', 'color'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color', 'maxWidth', 'textAlign'] },
      lead: { nodeId: 'lead', label: 'Supporting text', styleControls: ['textStyle', 'color', 'maxWidth'] },
      actions: { nodeId: 'actions', label: 'Actions', styleControls: ['gap', 'justify'] },
      media: { nodeId: 'media', label: 'Image', styleControls: ['aspectRatio', 'radius', 'shadow'] }
    },
    variantAxes: {
      tone,
      layout: { label: 'Layout', default: 'default', options: { default: { label: 'Image last' }, 'media-start': { label: 'Image first', styles: { 'media-wrap': { desktop: { order: -1 } } } } } }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section', styles: { base: { paddingBlock: tok('space.section'), paddingInline: tok('container.gutter'), background: tok('color.background'), color: tok('color.text') } } }, [
        b.el('inner', 'div', { name: 'Container', styles: { base: { layout: 'stack', gap: tok('space.2xl'), width: 'fill', maxWidth: tok('container.content'), marginInline: 'auto' } } }, [
          b.el('grid', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.2xl'), align: 'center' }, desktop: { columns: 2, gap: tok('space.3xl') } } }, [
            b.el('content', 'div', { name: 'Content', collapseEmpty: true, styles: { base: { layout: 'stack', gap: tok('space.lg'), align: 'start' } } }, [
              b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow'), styles: { textStyle: tok('text.eyebrow'), color: tok('color.brand') } }),
              b.text('heading', prop('headingLevel'), prop('heading'), { name: 'Heading', when: prop('heading'), styles: { textStyle: tok('text.h1') } }),
              b.text('lead', 'p', prop('lead'), { name: 'Supporting text', when: prop('lead'), styles: { textStyle: tok('text.lead'), ...muted, maxWidth: '560px' } }),
              b.el('actions', 'div', { name: 'Actions', collapseEmpty: true, styles: { base: { layout: 'row', wrap: true, gap: tok('space.sm'), justify: 'start', marginBlockStart: tok('space.sm') } } }, [
                b.link('primary', prop('primaryLink'), prop('primaryLabel'), 'primary', { name: 'Primary button', when: prop('primaryLabel') }),
                b.link('secondary', prop('secondaryLink'), prop('secondaryLabel'), 'secondary', { name: 'Secondary button', when: prop('secondaryLabel') })
              ])
            ]),
            b.el('media-wrap', 'figure', { name: 'Media' }, [
              b.image('media', prop('image'), { name: 'Image', styles: { aspectRatio: '4/5', radius: tok('radius.lg'), objectFit: 'cover', shadow: tok('shadow.md') } })
            ])
          ])
        ])
      ])
  });
}

/** The Services grid, as Foundation's own: a card per item with an icon badge, a title, a description and a link. */
export function servicesGrid(): ComponentDefinition {
  return foundationDesign({
    componentId: 'features.grid',
    name: 'Services grid',
    properties: {
      heading: P.str('Heading', 'Services shaped around your project'),
      items: P.list(
        'Cards',
        'Card',
        { icon: P.icon('Icon', 'sparkles'), title: P.str('Title', 'Service'), description: P.text('Description', 'Describe what this service includes.'), linkLabel: P.str('Link label', ''), link: P.link('Link') },
        [{ icon: 'compass', title: 'Planning', description: 'Clear priorities and a realistic budget.', linkLabel: '', link: { type: 'none', target: '' } }],
        { titleField: 'title' }
      )
    },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
      cardIcon: { nodeId: 'card-icon', label: 'Card icon', styleControls: ['color', 'background'] }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.el('grid', 'ul', { name: 'Card grid' }, [
          b.repeat('cards', 'items', [
            b.el('card', 'li', { name: 'Card', styles: { background: tok('color.surface') } }, [
              b.el('card-icon-wrap', 'div', { name: 'Icon badge' }, [b.icon('card-icon', item('icon'), { name: 'Icon' })]),
              b.text('card-title', 'h3', item('title'), { name: 'Title' }),
              b.text('card-text', 'p', item('description'), { name: 'Description', styles: muted }),
              b.link('card-link', item('link'), item('linkLabel'), 'text', { name: 'Link', when: item('linkLabel') })
            ])
          ])
        ])
      ])
  });
}

/** Testimonials, as Foundation's own: a quote on each card behind a quote mark fixed in the design. */
export function testimonials(): ComponentDefinition {
  return foundationDesign({
    componentId: 'testimonials.grid',
    name: 'Testimonials',
    properties: { items: P.list('Testimonials', 'Testimonial', { quote: P.text('Quote', 'A short quote from a happy client.'), name: P.str('Name', 'Client name') }, [{ quote: 'They listened properly.', name: 'Amelia Hart' }], { titleField: 'name' }) },
    parts: { root: { nodeId: 'root', label: 'Section' }, card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'radius'] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.el('grid', 'ul', { name: 'Grid' }, [
          b.repeat('quotes', 'items', [
            b.el('card', 'li', { name: 'Card' }, [
              b.icon('quote-mark', 'quote', { name: 'Quote mark', styles: { color: tok('color.accent') } }),
              b.text('quote', 'p', item('quote'), { name: 'Quote' }),
              b.text('name', 'cite', item('name'), { name: 'Name' })
            ])
          ])
        ])
      ])
  });
}

/**
 * Put the Split hero in the project as the theme's design and place it first on Home, in place of the starter's own
 * first section, with its buttons going to Contact and About as the starter's hero did. Returns the placement.
 */
export function placeSplitHero(s: ProjectState, props: Record<string, unknown> = {}) {
  const def = splitHero();
  s.components[def.id] = def;
  const home = s.pages[s.site.homePageId];
  const page = (route: string) => Object.values(s.pages).find((p) => p.route === route)?.id ?? s.site.homePageId;
  const node = makeInstance(def, { primaryLink: { type: 'page', target: page('/contact/') }, secondaryLink: { type: 'page', target: page('/about/') }, ...props });
  const first = home.rootIds[0];
  if (first) {
    home.rootIds[0] = node.id;
    delete home.nodes[first];
  } else home.rootIds.push(node.id);
  home.nodes[node.id] = node;
  return { def, node };
}
