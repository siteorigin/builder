import { P, managed, tok } from '../dsl';
import { eyebrowStyles, mutedStyles, layoutAxis, sectionShell, toneAxis } from './common';

const actions = (b: import('../dsl').TreeBuilder, align: 'start' | 'center') =>
  b.el('actions', 'div', { name: 'Actions', collapseEmpty: true, styles: { base: { layout: 'row', wrap: true, gap: tok('space.sm'), justify: align, marginBlockStart: tok('space.sm') } } }, [
    b.link('primary', { $prop: 'primaryLink' }, { $prop: 'primaryLabel' }, 'primary', { name: 'Primary button', when: { $prop: 'primaryLabel' } }),
    b.link('secondary', { $prop: 'secondaryLink' }, { $prop: 'secondaryLabel' }, 'secondary', { name: 'Secondary button', when: { $prop: 'secondaryLabel' } })
  ]);

const heroProps = {
  eyebrow: P.str('Eyebrow', 'Independent studio'),
  heading: P.str('Heading', 'Thoughtful work for people who care about the details'),
  lead: P.text('Supporting text', 'We help small teams plan, design and deliver projects that feel considered from the first conversation to the final handover.'),
  primaryLabel: P.str('Primary button label', 'Start a project'),
  primaryLink: P.link('Primary button link'),
  secondaryLabel: P.str('Secondary button label', 'See our work'),
  secondaryLink: P.link('Secondary button link')
};

const heroParts = {
  root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background', 'color', 'minHeight'] },
  container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'gap', 'align'] },
  eyebrow: { nodeId: 'eyebrow', label: 'Eyebrow', styleControls: ['textStyle', 'color'] },
  heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color', 'maxWidth', 'textAlign'] },
  lead: { nodeId: 'lead', label: 'Supporting text', styleControls: ['textStyle', 'color', 'maxWidth'] },
  actions: { nodeId: 'actions', label: 'Actions', styleControls: ['gap', 'justify'] }
};

export const heroCentered = managed({
  componentId: 'hero.centered',
  name: 'Centered hero',
  description: 'A centered introduction with a large heading, supporting copy and up to two actions.',
  category: 'hero',
  tags: ['hero', 'banner', 'intro', 'headline', 'landing', 'top'],
  icon: 'text-align-center',
  properties: heroProps,
  parts: heroParts,
  variantAxes: { tone: toneAxis(['lead'], {
    brand: { label: 'Brand', styles: { root: { base: { background: tok('color.brand'), color: tok('color.on-brand') } }, eyebrow: { base: { color: tok('color.on-brand'), opacity: 0.8 } }, lead: { base: { color: tok('color.on-brand'), opacity: 0.85 } }, primary: { base: { background: tok('color.on-brand'), color: tok('color.brand-strong') } } } }
  }) },
  build: (b) =>
    sectionShell(
      b,
      [
        b.el('content', 'div', { name: 'Content', styles: { base: { layout: 'stack', gap: tok('space.lg'), align: 'center', textAlign: 'center', maxWidth: '880px', marginInline: 'auto' } } }, [
          b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
          b.text('heading', 'h1', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.display') } }),
          b.text('lead', 'p', { $prop: 'lead' }, { name: 'Supporting text', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), ...mutedStyles, maxWidth: '640px' } }),
          actions(b, 'center')
        ])
      ],
      { root: { base: { paddingBlock: 'clamp(5rem, 3.5rem + 7vw, 10rem)' } } }
    ),
  examples: [{ description: 'Home page introduction for a design studio', props: { heading: 'Spaces that feel like home', primaryLabel: 'Book a consultation' } }]
});

export const heroSplit = managed({
  componentId: 'hero.split',
  name: 'Split hero',
  description: 'Heading, supporting copy and actions beside a large image. The image side can be swapped.',
  category: 'hero',
  tags: ['hero', 'banner', 'image', 'media', 'split', 'intro', 'photo'],
  icon: 'panel-right',
  properties: { ...heroProps, image: P.image('Image', 'A calm, light-filled studio workspace') },
  parts: {
    ...heroParts,
    media: { nodeId: 'media', label: 'Image', styleControls: ['aspectRatio', 'radius', 'shadow'] }
  },
  variantAxes: {
    tone: toneAxis(['lead']),
    layout: layoutAxis({
      default: { label: 'Image last' },
      'media-start': { label: 'Image first', styles: { 'media-wrap': { desktop: { order: -1 } } } }
    })
  },
  build: (b) =>
    sectionShell(b, [
      b.el(
        'grid',
        'div',
        {
          name: 'Layout',
          styles: {
            base: { layout: 'grid', columns: 1, gap: tok('space.2xl'), align: 'center' },
            desktop: { columns: 2, gap: tok('space.3xl') }
          }
        },
        [
          b.el('content', 'div', { name: 'Content', styles: { base: { layout: 'stack', gap: tok('space.lg'), align: 'start' } } }, [
            b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
            b.text('heading', 'h1', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h1') } }),
            b.text('lead', 'p', { $prop: 'lead' }, { name: 'Supporting text', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), ...mutedStyles, maxWidth: '560px' } }),
            actions(b, 'start')
          ]),
          b.el('media-wrap', 'figure', { name: 'Media' }, [
            b.image('media', { $prop: 'image' }, { name: 'Image', styles: { aspectRatio: '4/5', radius: tok('radius.lg'), objectFit: 'cover', shadow: tok('shadow.md') } })
          ])
        ]
      )
    ])
});

export const pageIntro = managed({
  componentId: 'intro.page',
  name: 'Page introduction',
  description: 'A compact title and description for the top of inner pages.',
  category: 'hero',
  tags: ['intro', 'title', 'page header', 'heading', 'inner page'],
  icon: 'heading-1',
  properties: {
    eyebrow: P.str('Eyebrow', 'About us'),
    heading: P.str('Heading', 'A small team with a long view'),
    lead: P.text('Description', 'Learn how we work, what we value and the people behind every project.')
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    eyebrow: { nodeId: 'eyebrow', label: 'Eyebrow', styleControls: ['textStyle', 'color'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    lead: { nodeId: 'lead', label: 'Description', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: { tone: toneAxis(['lead'], {}, 'muted') },
  build: (b) =>
    sectionShell(
      b,
      [
        b.el('content', 'div', { name: 'Content', styles: { base: { layout: 'stack', gap: tok('space.md'), maxWidth: '780px' } } }, [
          b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
          b.text('heading', 'h1', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h1') } }),
          b.text('lead', 'p', { $prop: 'lead' }, { name: 'Description', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), ...mutedStyles } })
        ])
      ],
      { root: { base: { paddingBlock: 'clamp(3.5rem, 2.5rem + 4vw, 6rem)' } } }
    )
});
