import { P, managed, tok } from '../dsl';
import { headingBlock, mutedStyles, sectionShell, toneVariants } from './common';

const img = { assetId: null, alt: '' };

export const logoStrip = managed({
  componentId: 'logos.strip',
  name: 'Logo strip',
  description: 'A row of client or partner logos. Logos without an image show the name as a wordmark.',
  category: 'social-proof',
  tags: ['logos', 'clients', 'partners', 'brands', 'trusted by', 'press'],
  icon: 'gallery-horizontal',
  properties: {
    heading: P.str('Heading', 'Trusted by local businesses and families'),
    logos: P.list(
      'Logos',
      'Logo',
      { name: P.str('Name', 'Company'), logo: P.image('Logo image') },
      [
        { name: 'Fernhill', logo: img },
        { name: 'Copperline', logo: img },
        { name: 'Marlow & Co', logo: img },
        { name: 'Bright Harbour', logo: img },
        { name: 'Oakhurst', logo: img }
      ],
      { titleField: 'name', max: 12 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color', 'textAlign'] },
    row: { nodeId: 'row', label: 'Logo row', styleControls: ['gap', 'justify'] },
    wordmark: { nodeId: 'wordmark', label: 'Wordmark', styleControls: ['textStyle', 'color', 'fontFamily'] }
  },
  variants: toneVariants(['heading', 'wordmark']),
  defaultVariant: 'default',
  build: (b) =>
    sectionShell(
      b,
      [
        b.text('heading', 'p', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.small'), ...mutedStyles, textAlign: 'center' } }),
        b.el('row', 'ul', { name: 'Logo row', styles: { base: { layout: 'row', wrap: true, justify: 'center', align: 'center', gap: tok('space.xl') }, desktop: { justify: 'space-between' } } }, [
          b.repeat('logo-items', 'logos', [
            b.el('logo-item', 'li', { name: 'Logo', styles: { layout: 'row', align: 'center' } }, [
              b.image('logo-image', { $item: 'logo' }, { name: 'Logo image', when: { $item: 'logo' }, styles: { width: 'auto', maxWidth: '140px', minHeight: '0', opacity: 0.75 } }),
              b.text('wordmark', 'span', { $item: 'name' }, { name: 'Wordmark', unless: { $item: 'logo' }, styles: { fontFamily: tok('font.display'), fontSize: '1.4rem', fontWeight: '500', letterSpacing: '-0.02em', color: tok('color.muted') } })
            ])
          ])
        ])
      ],
      { root: { base: { paddingBlock: tok('space.2xl') } }, inner: { base: { gap: tok('space.lg') } } }
    )
});

export const testimonials = managed({
  componentId: 'testimonials.grid',
  name: 'Testimonials',
  description: 'Quotes from clients with attribution and an optional portrait.',
  category: 'social-proof',
  tags: ['testimonials', 'reviews', 'quotes', 'clients', 'feedback', 'social proof'],
  icon: 'quote',
  properties: {
    eyebrow: P.str('Eyebrow', 'Kind words'),
    heading: P.str('Heading', 'What our clients say'),
    lead: P.text('Supporting text', ''),
    items: P.list(
      'Testimonials',
      'Testimonial',
      { quote: P.text('Quote', 'A short quote from a happy client.'), name: P.str('Name', 'Client name'), role: P.str('Role', ''), portrait: P.image('Portrait') },
      [
        { quote: 'They listened properly, explained every option and delivered exactly what was promised. The house finally works for us.', name: 'Amelia Hart', role: 'Homeowner, Ashford', portrait: img },
        { quote: 'Calm, organised and genuinely good company. We would not hesitate to work with the team again.', name: 'Daniel Okafor', role: 'Owner, Copperline Café', portrait: img },
        { quote: 'The attention to detail is remarkable. Every visitor asks who designed our new studio.', name: 'Priya Raman', role: 'Founder, Fernhill Yoga', portrait: img }
      ],
      { titleField: 'name', max: 12 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    grid: { nodeId: 'grid', label: 'Grid', styleControls: ['columns', 'gap'] },
    card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow'] },
    quote: { nodeId: 'quote', label: 'Quote', styleControls: ['textStyle', 'color'] }
  },
  variants: toneVariants(['lead', 'role']),
  defaultVariant: 'muted',
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('grid', 'ul', { name: 'Grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, desktop: { columns: 3 } } }, [
        b.repeat('quotes', 'items', [
          b.el('card', 'li', { name: 'Card', styles: { layout: 'stack', justify: 'space-between', gap: tok('space.xl'), paddingBlock: tok('space.xl'), paddingInline: tok('space.xl'), background: tok('color.surface'), color: tok('color.text'), radius: tok('radius.lg'), shadow: tok('shadow.sm') } }, [
            b.el('quote-block', 'blockquote', { name: 'Quote block', styles: { layout: 'stack', gap: tok('space.md') } }, [
              b.icon('quote-mark', 'quote', { name: 'Quote mark', styles: { color: tok('color.accent'), fontSize: '1.6rem' } }),
              b.text('quote', 'p', { $item: 'quote' }, { name: 'Quote', styles: { fontSize: '1.08rem', lineHeight: '1.6' } })
            ]),
            b.el('person', 'div', { name: 'Attribution', styles: { layout: 'row', align: 'center', gap: tok('space.sm') } }, [
              b.image('portrait', { $item: 'portrait' }, { name: 'Portrait', when: { $item: 'portrait' }, styles: { width: '44px', minHeight: '0', aspectRatio: '1/1', radius: tok('radius.pill'), objectFit: 'cover' } }),
              b.el('person-text', 'div', { name: 'Name and role', styles: { layout: 'stack' } }, [
                b.text('name', 'cite', { $item: 'name' }, { name: 'Name', styles: { fontWeight: '600', fontSize: '0.95rem' } }),
                b.text('role', 'span', { $item: 'role' }, { name: 'Role', when: { $item: 'role' }, styles: { textStyle: tok('text.small'), ...mutedStyles } })
              ])
            ])
          ])
        ])
      ])
    ])
});

export const team = managed({
  componentId: 'team.grid',
  name: 'Team',
  description: 'People with portraits, names, roles and a short bio.',
  category: 'social-proof',
  tags: ['team', 'people', 'staff', 'about', 'founders', 'employees'],
  icon: 'users',
  properties: {
    eyebrow: P.str('Eyebrow', 'The team'),
    heading: P.str('Heading', 'The people you will work with'),
    lead: P.text('Supporting text', 'A small, experienced team who care about getting the details right.'),
    people: P.list(
      'People',
      'Person',
      { portrait: P.image('Portrait'), name: P.str('Name', 'Name'), role: P.str('Role', 'Role'), bio: P.text('Bio', '') },
      [
        { portrait: img, name: 'Hannah Wells', role: 'Founder & lead designer', bio: 'Fifteen years designing homes and small workplaces.' },
        { portrait: img, name: 'Marcus Lee', role: 'Project manager', bio: 'Keeps every schedule, budget and contractor on track.' },
        { portrait: img, name: 'Sofia Alvarez', role: 'Interior designer', bio: 'Specialises in materials, colour and lighting.' }
      ],
      { titleField: 'name', max: 16 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    grid: { nodeId: 'grid', label: 'Grid', styleControls: ['columns', 'gap'] },
    portrait: { nodeId: 'portrait', label: 'Portrait', styleControls: ['aspectRatio', 'radius'] },
    name: { nodeId: 'name', label: 'Name', styleControls: ['textStyle', 'color'] }
  },
  variants: toneVariants(['lead', 'role', 'bio']),
  defaultVariant: 'default',
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('grid', 'ul', { name: 'Grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.xl') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
        b.repeat('members', 'people', [
          b.el('member', 'li', { name: 'Person', styles: { layout: 'stack', gap: tok('space.xs') } }, [
            b.image('portrait', { $item: 'portrait' }, { name: 'Portrait', styles: { aspectRatio: '4/5', radius: tok('radius.lg'), objectFit: 'cover', marginBlockEnd: tok('space.sm') } }),
            b.text('name', 'h3', { $item: 'name' }, { name: 'Name', styles: { textStyle: tok('text.h3') } }),
            b.text('role', 'p', { $item: 'role' }, { name: 'Role', styles: { color: tok('color.brand'), fontWeight: '500', fontSize: '0.95rem' } }),
            b.text('bio', 'p', { $item: 'bio' }, { name: 'Bio', when: { $item: 'bio' }, styles: { ...mutedStyles, textStyle: tok('text.small') } })
          ])
        ])
      ])
    ])
});
