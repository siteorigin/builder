/**
 * The managed designs the Wrap, Ungroup and Delete-keeping-content tests edit. Foundation's sections are code
 * components now, so these are the slices of its old managed Services grid and Call to action those tests walk: the
 * section shell, the heading group that hides when empty, the repeated card and the elements inside it, the parts,
 * and the tone and layout options that style some of them.
 */
import { P, item, prop, tok } from '@catalogue/dsl';
import { STICKY_BELOW_HEADER } from '@shared/styles';
import type { DesignSpec } from './packs';

const SPLIT = { layout: 'grid', gridTemplate: '1fr 1.5fr', align: 'start', columnGap: tok('space.2xl') } as const;

/** root > inner > (intro > eyebrow, heading, lead; grid > cards (repeat) > card (li) > icon wrap > icon, title, text, link). */
export const FEATURES: DesignSpec = {
  componentId: 'project.features',
  name: 'Services grid',
  properties: {
    eyebrow: P.str('Eyebrow', 'What we do'),
    heading: P.str('Heading', 'Services shaped around your project'),
    lead: P.text('Supporting text', 'Every engagement is different. These are the ways we most often help.'),
    items: P.list(
      'Cards',
      'Card',
      { icon: P.icon('Icon', 'sparkles'), title: P.str('Title', 'Service'), description: P.text('Description', 'What this service includes.'), linkLabel: P.str('Link label', ''), link: P.link('Link') },
      [
        { icon: 'compass', title: 'Planning', description: 'Clear priorities and a realistic budget.', linkLabel: '', link: { type: 'none', target: '' } },
        { icon: 'pen-tool', title: 'Design', description: 'Considered layouts, materials and details.', linkLabel: '', link: { type: 'none', target: '' } }
      ],
      { titleField: 'title', max: 12 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
    card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius'] },
    cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
    cardIcon: { nodeId: 'card-icon', label: 'Card icon', styleControls: ['color', 'background'] }
  },
  variantAxes: {
    tone: {
      label: 'Tone',
      default: 'default',
      options: {
        default: { label: 'Default' },
        muted: { label: 'Soft background', styles: { root: { base: { background: tok('color.surface-alt') } } } },
        inverse: {
          label: 'Dark',
          styles: {
            root: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } },
            eyebrow: { base: { color: tok('color.accent') } },
            lead: { base: { color: tok('color.on-inverse'), opacity: 0.78 } }
          }
        }
      }
    },
    layout: {
      label: 'Layout',
      default: 'default',
      options: {
        default: { label: 'Three columns' },
        'two-columns': { label: 'Two columns', styles: { grid: { desktop: { columns: 2 } } } },
        // The heading group stays in view beside the cards: it styles the group and the container it pins them in.
        'sticky-split': {
          label: 'Heading pinned beside cards',
          styles: {
            inner: { tablet: SPLIT, desktop: SPLIT },
            intro: { tablet: STICKY_BELOW_HEADER, desktop: STICKY_BELOW_HEADER },
            grid: { tablet: { columns: 1 }, desktop: { columns: 1 } }
          }
        }
      }
    }
  },
  build: (b) =>
    b.el('root', 'section', { name: 'Section', styles: { paddingBlock: tok('space.section'), paddingInline: tok('container.gutter') } }, [
      b.el('inner', 'div', { name: 'Container', styles: { layout: 'stack', gap: tok('space.2xl'), width: 'fill', maxWidth: tok('container.content'), marginInline: 'auto' } }, [
        // Cleared eyebrow, heading and lead leave no empty box behind.
        b.el('intro', 'div', { name: 'Heading group', collapseEmpty: true, styles: { layout: 'stack', gap: tok('space.md') } }, [
          b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow'), styles: { textStyle: tok('text.eyebrow'), color: tok('color.brand') } }),
          b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading'), styles: { textStyle: tok('text.h2') } }),
          b.text('lead', 'p', prop('lead'), { name: 'Lead', when: prop('lead'), styles: { textStyle: tok('text.lead'), color: tok('color.muted') } })
        ]),
        b.el('grid', 'ul', { name: 'Card grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, desktop: { columns: 3 } } }, [
          b.repeat('cards', 'items', [
            b.el('card', 'li', { name: 'Card', styles: { layout: 'stack', gap: tok('space.md'), background: tok('color.surface') } }, [
              b.el('card-icon-wrap', 'div', { name: 'Icon badge', styles: { layout: 'row', width: '48px', minHeight: '48px' } }, [b.icon('card-icon', item('icon'), { name: 'Icon' })]),
              b.text('card-title', 'h3', item('title'), { name: 'Title', styles: { textStyle: tok('text.h3') } }),
              b.text('card-text', 'p', item('description'), { name: 'Description', styles: { color: tok('color.muted') } }),
              b.link('card-link', item('link'), item('linkLabel'), 'text', { name: 'Link', when: item('linkLabel'), styles: { marginBlockStart: 'auto' } })
            ])
          ])
        ])
      ])
    ])
};

/** root > panel (styled by the tone) > heading, actions > primary: the panel keeps the tone when detached. */
export const CTA: DesignSpec = {
  componentId: 'cta.banner',
  name: 'Call to action',
  category: 'conversion',
  properties: { heading: P.str('Heading', 'Ready to start your project?'), primaryLabel: P.str('Button label', 'Get in touch'), primaryLink: P.link('Button link') },
  parts: { root: { nodeId: 'root', label: 'Section' }, panel: { nodeId: 'panel', label: 'Panel', styleControls: ['background', 'color'] } },
  variantAxes: {
    tone: {
      label: 'Tone',
      default: 'default',
      options: {
        default: { label: 'Brand panel' },
        inverse: { label: 'Dark panel', styles: { panel: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } } } }
      }
    }
  },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.el('panel', 'div', { name: 'Panel', styles: { layout: 'stack', background: tok('color.brand'), color: tok('color.on-brand') } }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.el('actions', 'div', { name: 'Actions', collapseEmpty: true, styles: { layout: 'row', gap: tok('space.sm') } }, [
          b.link('primary', prop('primaryLink'), prop('primaryLabel'), 'light', { name: 'Primary button', when: prop('primaryLabel') })
        ])
      ])
    ])
};
