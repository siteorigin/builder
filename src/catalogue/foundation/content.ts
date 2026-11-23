import { P, managed, tok } from '../dsl';
import { eyebrowStyles, headingBlock, mutedStyles, sectionShell, toneVariants } from './common';

const card = { layout: 'stack', gap: tok('space.md'), paddingBlock: tok('space.xl'), paddingInline: tok('space.xl'), background: tok('color.surface'), border: tok('border.default'), radius: tok('radius.lg') } as const;

export const featuresGrid = managed({
  componentId: 'features.grid',
  name: 'Services grid',
  description: 'A heading followed by repeatable cards, each with an icon, title, description and optional link. Use for services, features or benefits.',
  category: 'content',
  tags: ['services', 'features', 'cards', 'grid', 'benefits', 'offerings', 'what we do'],
  icon: 'layout-grid',
  properties: {
    eyebrow: P.str('Eyebrow', 'What we do'),
    heading: P.str('Heading', 'Services shaped around your project'),
    lead: P.text('Supporting text', 'Every engagement is different. These are the ways we most often help.'),
    items: P.list(
      'Cards',
      'Card',
      {
        icon: P.icon('Icon', 'sparkles'),
        title: P.str('Title', 'Service'),
        description: P.text('Description', 'Describe what this service includes and who it is for.'),
        linkLabel: P.str('Link label', ''),
        link: P.link('Link')
      },
      [
        { icon: 'compass', title: 'Planning', description: 'Clear priorities, a realistic budget and a schedule everyone understands before work begins.', linkLabel: '', link: { type: 'none', target: '' } },
        { icon: 'pen-tool', title: 'Design', description: 'Considered layouts, materials and details developed with you through focused reviews.', linkLabel: '', link: { type: 'none', target: '' } },
        { icon: 'hammer', title: 'Delivery', description: 'We coordinate trusted specialists and keep you informed at every stage of the build.', linkLabel: '', link: { type: 'none', target: '' } }
      ],
      { titleField: 'title', max: 12 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
    card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline'] },
    cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
    cardIcon: { nodeId: 'card-icon', label: 'Card icon', styleControls: ['color', 'background'] }
  },
  variants: toneVariants(['lead', 'card-text'], {
    'two-columns': { label: 'Two columns', styles: { grid: { desktop: { columns: 2 } } } },
    'four-columns': { label: 'Four columns', styles: { grid: { desktop: { columns: 4 } } } }
  }),
  defaultVariant: 'default',
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('grid', 'ul', { name: 'Card grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
        b.repeat('cards', 'items', [
          b.el('card', 'li', { name: 'Card', styles: card }, [
            b.el('card-icon-wrap', 'div', { name: 'Icon badge', styles: { layout: 'row', align: 'center', justify: 'center', width: '48px', minHeight: '48px', radius: tok('radius.md'), background: 'color-mix(in srgb, var(--so-color-brand) 10%, transparent)', color: tok('color.brand'), fontSize: '1.3rem', marginBlockEnd: tok('space.xs') } }, [
              b.icon('card-icon', { $item: 'icon' }, { name: 'Icon' })
            ]),
            b.text('card-title', 'h3', { $item: 'title' }, { name: 'Title', styles: { textStyle: tok('text.h3') } }),
            b.text('card-text', 'p', { $item: 'description' }, { name: 'Description', styles: mutedStyles }),
            b.link('card-link', { $item: 'link' }, { $item: 'linkLabel' }, 'text', { name: 'Link', when: { $item: 'linkLabel' }, styles: { marginBlockStart: 'auto' } })
          ])
        ])
      ])
    ])
});

export const mediaSplit = managed({
  componentId: 'content.media',
  name: 'Content with image',
  description: 'Image beside a heading, rich text and an optional action. The image side can be swapped.',
  category: 'content',
  tags: ['image', 'text', 'about', 'story', 'media', 'split', 'feature'],
  icon: 'panel-left',
  properties: {
    eyebrow: P.str('Eyebrow', 'Our approach'),
    heading: P.str('Heading', 'Good projects start with listening'),
    body: P.rich('Text', [
      'Before we draw anything we spend time understanding how you live and work, what matters most and what you would happily leave behind.',
      'That conversation shapes **every decision** that follows, from the first sketch to the final finishes.'
    ]),
    image: P.image('Image', 'Two people reviewing plans at a table'),
    actionLabel: P.str('Action label', 'More about us'),
    actionLink: P.link('Action link')
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    body: { nodeId: 'body', label: 'Text', styleControls: ['textStyle', 'color'] },
    media: { nodeId: 'media', label: 'Image', styleControls: ['aspectRatio', 'radius', 'shadow'] },
    action: { nodeId: 'action', label: 'Action' }
  },
  variants: toneVariants(['body'], {
    'media-end': { label: 'Image last', styles: { 'media-wrap': { desktop: { order: 2 } } } }
  }),
  defaultVariant: 'default',
  build: (b) =>
    sectionShell(b, [
      b.el('grid', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.2xl'), align: 'center' }, desktop: { columns: 2, gap: tok('space.3xl') } } }, [
        b.el('media-wrap', 'figure', { name: 'Media' }, [
          b.image('media', { $prop: 'image' }, { name: 'Image', styles: { aspectRatio: '4/3', radius: tok('radius.lg'), objectFit: 'cover' } })
        ]),
        b.el('content', 'div', { name: 'Content', styles: { layout: 'stack', gap: tok('space.lg'), align: 'start' } }, [
          b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
          b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', styles: { textStyle: tok('text.h2') } }),
          b.rich('body', { $prop: 'body' }, { name: 'Text', styles: { ...mutedStyles, textStyle: tok('text.body') } }),
          b.link('action', { $prop: 'actionLink' }, { $prop: 'actionLabel' }, 'secondary', { name: 'Action', when: { $prop: 'actionLabel' }, styles: { marginBlockStart: tok('space.xs') } })
        ])
      ])
    ])
});

export const textSection = managed({
  componentId: 'content.text',
  name: 'Text section',
  description: 'A reading-width heading and rich text block for longer copy.',
  category: 'content',
  tags: ['text', 'copy', 'article', 'paragraphs', 'story', 'prose'],
  icon: 'type',
  properties: {
    heading: P.str('Heading', 'How we work'),
    body: P.rich('Text', [
      'We keep our team deliberately small so that the people you meet at the start are the people who see your project through.',
      'Each project follows the same simple rhythm: listen, plan, design, deliver. Along the way you will always know what is happening next and why.'
    ])
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    body: { nodeId: 'body', label: 'Text', styleControls: ['textStyle', 'color'] }
  },
  variants: toneVariants(['body']),
  defaultVariant: 'default',
  build: (b) =>
    sectionShell(
      b,
      [
        b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h2') } }),
        b.rich('body', { $prop: 'body' }, { name: 'Text', styles: { textStyle: tok('text.lead'), ...mutedStyles } })
      ],
      { width: 'reading', inner: { base: { gap: tok('space.lg') } } }
    )
});

export const stats = managed({
  componentId: 'stats.row',
  name: 'Statistics',
  description: 'A row of large figures with short labels.',
  category: 'social-proof',
  tags: ['stats', 'numbers', 'figures', 'metrics', 'results', 'facts'],
  icon: 'chart-line',
  properties: {
    heading: P.str('Heading', ''),
    items: P.list(
      'Figures',
      'Figure',
      { value: P.str('Value', '100+'), label: P.str('Label', 'Projects completed') },
      [
        { value: '15', label: 'Years in practice' },
        { value: '240+', label: 'Projects completed' },
        { value: '98%', label: 'Clients who return' },
        { value: '6', label: 'Industry awards' }
      ],
      { titleField: 'label', max: 8 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    grid: { nodeId: 'grid', label: 'Grid', styleControls: ['columns', 'gap'] },
    value: { nodeId: 'value', label: 'Value', styleControls: ['textStyle', 'color'] },
    label: { nodeId: 'label', label: 'Label', styleControls: ['textStyle', 'color'] }
  },
  variants: toneVariants(['label']),
  defaultVariant: 'default',
  build: (b) =>
    sectionShell(b, [
      b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h2') } }),
      b.el('grid', 'dl', { name: 'Grid', styles: { base: { layout: 'grid', columns: 2, gap: tok('space.xl') }, desktop: { columns: 4 } } }, [
        b.repeat('figures', 'items', [
          b.el('figure', 'div', { name: 'Figure', styles: { layout: 'stack', gap: tok('space.xs'), paddingInline: '0', border: '0', marginBlockStart: '0' } }, [
            b.text('value', 'dd', { $item: 'value' }, { name: 'Value', styles: { textStyle: tok('text.stat'), color: tok('color.brand'), order: -1 } }),
            b.text('label', 'dt', { $item: 'label' }, { name: 'Label', styles: { ...mutedStyles, textStyle: tok('text.small') } })
          ])
        ])
      ])
    ])
});

export const gallery = managed({
  componentId: 'media.gallery',
  name: 'Gallery',
  description: 'A responsive grid of images with optional captions.',
  category: 'media',
  tags: ['gallery', 'images', 'photos', 'portfolio', 'work', 'grid'],
  icon: 'images',
  properties: {
    eyebrow: P.str('Eyebrow', 'Selected work'),
    heading: P.str('Heading', 'Recent projects'),
    lead: P.text('Supporting text', ''),
    images: P.list(
      'Images',
      'Image',
      { image: P.image('Image'), caption: P.str('Caption', '') },
      [
        { image: { assetId: null, alt: '' }, caption: 'Garden room, Ashford' },
        { image: { assetId: null, alt: '' }, caption: 'Kitchen, Millbrook' },
        { image: { assetId: null, alt: '' }, caption: 'Studio, Harbour Lane' },
        { image: { assetId: null, alt: '' }, caption: 'Living room, Westfield' },
        { image: { assetId: null, alt: '' }, caption: 'Library, Old Mill' },
        { image: { assetId: null, alt: '' }, caption: 'Courtyard, Elm Street' }
      ],
      { titleField: 'caption', max: 24 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    grid: { nodeId: 'grid', label: 'Grid', styleControls: ['columns', 'gap'] },
    image: { nodeId: 'image', label: 'Image', styleControls: ['aspectRatio', 'radius'] },
    caption: { nodeId: 'caption', label: 'Caption', styleControls: ['textStyle', 'color'] }
  },
  variants: toneVariants(['lead', 'caption']),
  defaultVariant: 'default',
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('grid', 'ul', { name: 'Grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
        b.repeat('photos', 'images', [
          b.el('photo', 'li', { name: 'Photo' }, [
            b.el('photo-figure', 'figure', { name: 'Figure', styles: { layout: 'stack', gap: tok('space.sm') } }, [
              b.image('image', { $item: 'image' }, { name: 'Image', styles: { aspectRatio: '4/3', radius: tok('radius.md'), objectFit: 'cover' } }),
              b.text('caption', 'figcaption', { $item: 'caption' }, { name: 'Caption', when: { $item: 'caption' }, styles: { textStyle: tok('text.small'), ...mutedStyles } })
            ])
          ])
        ])
      ])
    ])
});

export const container = managed({
  componentId: 'layout.section',
  name: 'Section',
  description: 'A flexible empty section with a content area. Add headings, text, images and buttons inside it.',
  category: 'layout',
  tags: ['section', 'container', 'empty', 'blank', 'layout', 'custom'],
  icon: 'square-dashed',
  properties: {},
  slots: { content: { label: 'Content' } },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'paddingInline', 'background', 'color', 'minHeight'] },
    container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'gap', 'layout', 'columns', 'align', 'justify', 'textAlign'] }
  },
  variants: toneVariants([]),
  defaultVariant: 'default',
  build: (b) => sectionShell(b, [b.slot('content-slot', 'content', { name: 'Content' })], { inner: { base: { gap: tok('space.lg') } } })
});

// Figures switch to the accent color on the dark tone for contrast.
stats.variants!.inverse.styles!.value = { base: { color: tok('color.accent') } };
