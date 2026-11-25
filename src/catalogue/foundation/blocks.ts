/**
 * Foundation's blocks: compact components made to sit inside a layout (a column, a Bento grid's cell, a component's
 * slot) rather than stand as one of a page's sections. None has a section's full-bleed root, its vertical padding or
 * its page-width container: each is one card that fills the width it is given. They insert as elements
 * (`insertAs: 'element'`), so Insert puts one into the selected column, and one dropped between a page's sections
 * gets a Section of its own around it.
 */
import type { ResponsiveStyles, StyleValue, VariantAxis } from '@shared/types';
import { P, tok } from '../dsl';
import { FOUNDATION } from './pack';
import { eyebrowStyles, headingLevel, mutedStyles } from './common';

const { managed } = FOUNDATION;

/** A block's card: padded, on the surface colour, with the theme's border and corners. */
const card = { layout: 'stack', gap: tok('space.md'), width: 'fill', paddingBlock: tok('space.lg'), paddingInline: tok('space.lg'), background: tok('color.surface'), color: tok('color.text'), border: tok('border.default'), radius: tok('radius.lg') } as const;

/** The style controls a block's card offers, so a placement can restyle it to suit the layout it sits in. */
const CARD_CONTROLS = ['background', 'color', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline'];

/**
 * A block's tone: as the theme draws it, on the soft background, or dark. `muted` nodes are lightened on the dark
 * tone, and `accent` ones (an eyebrow, an icon) take the accent colour there, which stays readable. A filled tone drops
 * the card's outline, unless the block keeps its own edge (`keepBorder`, a callout's bar).
 */
function blockTone(muted: string[], accent: string[], opts: { defaultLabel?: string; keepBorder?: boolean } = {}): VariantAxis {
  const fill = (background: StyleValue, color?: StyleValue): ResponsiveStyles => ({ base: { background, ...(color ? { color } : {}), ...(opts.keepBorder ? {} : { border: '0' }) } });
  const inverse: Record<string, ResponsiveStyles> = { root: fill(tok('color.inverse'), tok('color.on-inverse')) };
  for (const id of muted) inverse[id] = { base: { color: tok('color.on-inverse'), opacity: 0.78 } };
  for (const id of accent) inverse[id] = { base: { color: tok('color.accent') } };
  return {
    label: 'Tone',
    default: 'default',
    options: {
      default: { label: opts.defaultLabel ?? 'Card' },
      muted: { label: 'Soft background', styles: { root: fill(tok('color.surface-alt')) } },
      inverse: { label: 'Dark', styles: inverse }
    }
  };
}

/** The badge an icon sits in, tinted with the brand colour. */
const iconBadge = { layout: 'row', align: 'center', justify: 'center', width: '48px', minHeight: '48px', radius: tok('radius.md'), background: 'color-mix(in srgb, var(--so-color-brand) 10%, transparent)', color: tok('color.brand'), fontSize: '1.3rem' } as const;

export const featureCard = managed({
  componentId: 'block.feature',
  name: 'Feature card',
  description: 'One card with an icon, a title, a short description and an optional link. A block: it goes inside a column, a grid cell or a component’s slot.',
  category: 'content',
  tags: ['feature', 'service', 'benefit', 'card', 'icon', 'block', 'column'],
  icon: 'square-star',
  insertAs: 'element',
  properties: {
    icon: P.icon('Icon', 'sparkles'),
    title: P.str('Title', 'Thoughtful planning'),
    headingLevel: headingLevel('h3'),
    description: P.text('Description', 'Clear priorities, a realistic budget and a schedule everyone understands before work begins.'),
    linkLabel: P.str('Link label', ''),
    link: P.link('Link')
  },
  parts: {
    root: { nodeId: 'root', label: 'Card', styleControls: CARD_CONTROLS },
    icon: { nodeId: 'icon-badge', label: 'Icon', styleControls: ['color', 'background', 'radius'] },
    title: { nodeId: 'title', label: 'Title', styleControls: ['textStyle', 'color'] },
    description: { nodeId: 'description', label: 'Description', styleControls: ['textStyle', 'color'] },
    link: { nodeId: 'link', label: 'Link' }
  },
  variantAxes: { tone: blockTone(['description'], ['icon-badge', 'link']) },
  build: (b) =>
    b.el('root', 'div', { name: 'Card', styles: card }, [
      b.el('icon-badge', 'div', { name: 'Icon badge', when: { $prop: 'icon' }, styles: iconBadge }, [b.icon('icon', { $prop: 'icon' }, { name: 'Icon' })]),
      b.text('title', { $prop: 'headingLevel' }, { $prop: 'title' }, { name: 'Title', when: { $prop: 'title' }, styles: { textStyle: tok('text.h3') } }),
      b.text('description', 'p', { $prop: 'description' }, { name: 'Description', when: { $prop: 'description' }, styles: mutedStyles }),
      b.link('link', { $prop: 'link' }, { $prop: 'linkLabel' }, 'text', { name: 'Link', when: { $prop: 'linkLabel' }, styles: { marginBlockStart: 'auto' } })
    ])
});

export const statCard = managed({
  componentId: 'block.stat',
  name: 'Stat card',
  description: 'One large figure with a short label and an optional note. A block: it goes inside a column, a grid cell or a component’s slot.',
  category: 'social-proof',
  tags: ['stat', 'statistic', 'number', 'figure', 'metric', 'result', 'fact', 'card', 'block'],
  icon: 'chart-no-axes-column',
  insertAs: 'element',
  properties: {
    value: P.str('Value', '98%'),
    label: P.str('Label', 'Clients who return'),
    note: P.text('Note', '')
  },
  parts: {
    root: { nodeId: 'root', label: 'Card', styleControls: CARD_CONTROLS },
    value: { nodeId: 'value', label: 'Value', styleControls: ['textStyle', 'color'] },
    label: { nodeId: 'label', label: 'Label', styleControls: ['textStyle', 'color'] },
    note: { nodeId: 'note', label: 'Note', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: { tone: blockTone(['label', 'note'], ['value']) },
  build: (b) =>
    b.el('root', 'div', { name: 'Card', styles: { ...card, gap: tok('space.sm') } }, [
      b.el('figure', 'dl', { name: 'Figure', styles: { layout: 'stack', gap: tok('space.xs') } }, [
        // A term comes before its description in a <dl>; `order` still shows the figure above its label.
        b.text('label', 'dt', { $prop: 'label' }, { name: 'Label', styles: { ...mutedStyles, textStyle: tok('text.small') } }),
        b.text('value', 'dd', { $prop: 'value' }, { name: 'Value', styles: { textStyle: tok('text.stat'), color: tok('color.brand'), order: -1 } })
      ]),
      b.text('note', 'p', { $prop: 'note' }, { name: 'Note', when: { $prop: 'note' }, styles: { ...mutedStyles, textStyle: tok('text.small') } })
    ])
});

export const testimonialCard = managed({
  componentId: 'block.testimonial',
  name: 'Testimonial card',
  description: 'One quote from a client with their name, role and an optional portrait. A block: it goes inside a column, a grid cell or a component’s slot.',
  category: 'social-proof',
  tags: ['testimonial', 'quote', 'review', 'client', 'feedback', 'card', 'block'],
  icon: 'message-square-quote',
  insertAs: 'element',
  properties: {
    quote: P.text('Quote', 'They listened properly, explained every option and delivered exactly what was promised.'),
    name: P.str('Name', 'Amelia Hart'),
    role: P.str('Role', 'Homeowner, Ashford'),
    portrait: P.image('Portrait')
  },
  parts: {
    root: { nodeId: 'root', label: 'Card', styleControls: CARD_CONTROLS },
    quote: { nodeId: 'quote', label: 'Quote', styleControls: ['textStyle', 'color'] },
    attribution: { nodeId: 'attribution', label: 'Attribution', styleControls: ['gap'] },
    portrait: { nodeId: 'portrait', label: 'Portrait', styleControls: ['width', 'radius'] }
  },
  variantAxes: { tone: blockTone(['role'], ['quote-mark']) },
  build: (b) =>
    b.el('root', 'figure', { name: 'Card', styles: { ...card, justify: 'space-between', gap: tok('space.lg') } }, [
      b.el('quote-block', 'blockquote', { name: 'Quote block', styles: { layout: 'stack', gap: tok('space.sm') } }, [
        b.icon('quote-mark', 'quote', { name: 'Quote mark', styles: { color: tok('color.accent'), fontSize: '1.4rem' } }),
        b.text('quote', 'p', { $prop: 'quote' }, { name: 'Quote', styles: { fontSize: '1.05rem', lineHeight: '1.6' } })
      ]),
      b.el('attribution', 'figcaption', { name: 'Attribution', collapseEmpty: true, styles: { layout: 'row', align: 'center', gap: tok('space.sm') } }, [
        b.image('portrait', { $prop: 'portrait' }, { name: 'Portrait', when: { $prop: 'portrait' }, fallbackAlt: { $prop: 'name' }, styles: { width: '44px', minHeight: '0', aspectRatio: '1/1', radius: tok('radius.pill'), objectFit: 'cover' } }),
        b.el('person', 'div', { name: 'Name and role', collapseEmpty: true, styles: { layout: 'stack' } }, [
          b.text('name', 'cite', { $prop: 'name' }, { name: 'Name', when: { $prop: 'name' }, styles: { fontWeight: '600', fontSize: '0.95rem' } }),
          b.text('role', 'span', { $prop: 'role' }, { name: 'Role', when: { $prop: 'role' }, styles: { textStyle: tok('text.small'), ...mutedStyles } })
        ])
      ])
    ])
});

export const calloutBox = managed({
  componentId: 'block.callout',
  name: 'Callout box',
  description: 'A highlighted box with a short heading, a sentence or two and an optional button, for a note, an offer or a next step. A block: it goes inside a column, a grid cell or a component’s slot.',
  category: 'conversion',
  tags: ['callout', 'note', 'notice', 'highlight', 'tip', 'offer', 'cta', 'box', 'block'],
  icon: 'badge-info',
  insertAs: 'element',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', 'Free first consultation'),
    headingLevel: headingLevel('h3'),
    text: P.text('Text', 'Tell us what you have in mind and we will suggest the next step, with no obligation.'),
    actionLabel: P.str('Button label', 'Book a call'),
    actionLink: P.link('Button link')
  },
  parts: {
    root: { nodeId: 'root', label: 'Box', styleControls: [...CARD_CONTROLS, 'borderInlineStart'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    text: { nodeId: 'text', label: 'Text', styleControls: ['textStyle', 'color'] },
    action: { nodeId: 'action', label: 'Button' }
  },
  // The bar down its leading edge marks it out on every tone.
  variantAxes: { tone: blockTone(['text'], ['eyebrow'], { defaultLabel: 'Light', keepBorder: true }) },
  build: (b) =>
    b.el('root', 'div', { name: 'Box', styles: { ...card, align: 'start', border: '0', borderInlineStart: '4px solid var(--so-color-brand)' } }, [
      b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
      b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h3') } }),
      b.text('text', 'p', { $prop: 'text' }, { name: 'Text', when: { $prop: 'text' }, styles: mutedStyles }),
      b.link('action', { $prop: 'actionLink' }, { $prop: 'actionLabel' }, 'primary', { name: 'Button', when: { $prop: 'actionLabel' }, styles: { marginBlockStart: tok('space.xs') } })
    ])
});
