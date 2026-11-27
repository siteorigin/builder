/**
 * Managed designs of some of Foundation's contracts, for the tests of what the editor does with a design drawn from
 * data: its parts, slots, repeats, variants, item styles and fallbacks, and the canvas's selection through it.
 *
 * Foundation ships its sections as Svelte code components, so the trees here are the managed designs those sections
 * had before the theme moved to its own repository (#998), written on the loaded Foundation's tokens and stamped as
 * Foundation's. Each keeps its section's contract (properties, parts, slots, variant options), so a starter's
 * placement of the section reads the same with either. `withManaged` puts them in a project in place of the release's
 * code, and `registerManaged` in the catalogue, for a test that installs or inserts one by component ID.
 */
import type { ComponentDefinition, ProjectState, ResponsiveStyles, ScalarPropSchema, VariantAxis, VariantDef } from '@shared/types';
import { definitionHash } from '@shared/migrations';
import { STICKY_BELOW_HEADER } from '@shared/styles';
import { P, item, tok, type TreeBuilder } from '@catalogue/dsl';
import { getTheme, listThemes, registerPacks } from '@catalogue/index';
import { foundationDesign, type DesignSpec } from './packs';

const eyebrowStyles = { textStyle: tok('text.eyebrow'), color: tok('color.brand') };
const mutedStyles = { color: tok('color.muted') };

/** A full-bleed section with its centred content container (`inner`). */
function sectionShell(b: TreeBuilder, children: string[], opts: { inner?: ResponsiveStyles; root?: ResponsiveStyles } = {}): string {
  const inner = b.el(
    'inner',
    'div',
    {
      name: 'Container',
      styles: {
        base: { layout: 'stack', gap: tok('space.2xl'), width: 'fill', maxWidth: tok('container.content'), marginInline: 'auto', ...(opts.inner?.base ?? {}) },
        ...Object.fromEntries(Object.entries(opts.inner ?? {}).filter(([k]) => k !== 'base'))
      }
    },
    children
  );
  return b.el(
    'root',
    'section',
    {
      name: 'Section',
      styles: {
        base: { paddingBlock: tok('space.section'), paddingInline: tok('container.gutter'), background: tok('color.background'), color: tok('color.text'), ...(opts.root?.base ?? {}) },
        ...Object.fromEntries(Object.entries(opts.root ?? {}).filter(([k]) => k !== 'base'))
      }
    },
    [inner]
  );
}

/** A section's heading group (`intro`): eyebrow, heading and lead. */
function headingBlock(b: TreeBuilder): string {
  return b.el('intro', 'div', { name: 'Heading group', collapseEmpty: true, styles: { base: { layout: 'stack', gap: tok('space.md'), maxWidth: '760px', textAlign: 'start' } } }, [
    b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
    b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h2') } }),
    b.text('lead', 'p', { $prop: 'lead' }, { name: 'Lead', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), ...mutedStyles } })
  ]);
}

/** The tone axis most sections share: muted nodes are lightened on the dark tone. */
function toneAxis(mutedNodes: string[] = []): VariantAxis {
  const inverse: Record<string, ResponsiveStyles> = { root: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } }, eyebrow: { base: { color: tok('color.accent') } } };
  for (const id of mutedNodes) inverse[id] = { base: { color: tok('color.on-inverse'), opacity: 0.78 } };
  return {
    label: 'Tone',
    default: 'default',
    options: { default: { label: 'Default' }, muted: { label: 'Soft background', styles: { root: { base: { background: tok('color.surface-alt') } } } }, inverse: { label: 'Dark', styles: inverse } }
  };
}

const layoutAxis = (options: Record<string, VariantDef>): VariantAxis => ({ label: 'Layout', default: 'default', options });

function headingLevel(level: 'h1' | 'h2' | 'h3'): ScalarPropSchema {
  return P.choice('Heading level', level, [
    ['h1', 'Heading 1 (page title)'],
    ['h2', 'Heading 2'],
    ['h3', 'Heading 3'],
    ['h4', 'Heading 4'],
    ['h5', 'Heading 5'],
    ['h6', 'Heading 6']
  ]);
}

/** The Split hero: a heading, copy and two buttons beside a picture. */
export const SPLIT_HERO: DesignSpec = {
  componentId: 'hero.split',
  name: 'Split hero',
  category: 'hero',
  properties: {
    ...P.group('Text', {
      eyebrow: P.copy(P.str('Eyebrow', 'Independent studio')),
      heading: P.copy(P.str('Heading', 'Thoughtful work for people who care about the details')),
      headingLevel: headingLevel('h1'),
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
    tone: toneAxis(['lead']),
    layout: layoutAxis({ default: { label: 'Image last' }, 'media-start': { label: 'Image first', styles: { 'media-wrap': { desktop: { order: -1 } } } } })
  },
  build: (b) =>
    sectionShell(b, [
      b.el('grid', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.2xl'), align: 'center' }, desktop: { columns: 2, gap: tok('space.3xl') } } }, [
        b.el('content', 'div', { name: 'Content', collapseEmpty: true, styles: { base: { layout: 'stack', gap: tok('space.lg'), align: 'start' } } }, [
          b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
          b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h1') } }),
          b.text('lead', 'p', { $prop: 'lead' }, { name: 'Supporting text', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), ...mutedStyles, maxWidth: '560px' } }),
          b.el('actions', 'div', { name: 'Actions', collapseEmpty: true, styles: { base: { layout: 'row', wrap: true, gap: tok('space.sm'), justify: 'start', marginBlockStart: tok('space.sm') } } }, [
            b.link('primary', { $prop: 'primaryLink' }, { $prop: 'primaryLabel' }, 'primary', { name: 'Primary button', when: { $prop: 'primaryLabel' } }),
            b.link('secondary', { $prop: 'secondaryLink' }, { $prop: 'secondaryLabel' }, 'secondary', { name: 'Secondary button', when: { $prop: 'secondaryLabel' } })
          ])
        ]),
        b.el('media-wrap', 'figure', { name: 'Media' }, [
          b.image('media', { $prop: 'image' }, { name: 'Image', styles: { aspectRatio: '4/5', radius: tok('radius.lg'), objectFit: 'cover', shadow: tok('shadow.md') } })
        ])
      ])
    ])
};

const card = { layout: 'stack', gap: tok('space.md'), paddingBlock: tok('space.xl'), paddingInline: tok('space.xl'), background: tok('color.surface'), color: tok('color.text'), border: tok('border.default'), radius: tok('radius.lg') } as const;
const STICKY_SPLIT_LAYOUT = { layout: 'grid', gridTemplate: '1fr 1.5fr', align: 'start', columnGap: tok('space.2xl') } as const;

/** The Services grid: a heading group and a grid of repeated cards. */
export const SERVICES_GRID: DesignSpec = {
  componentId: 'features.grid',
  name: 'Services grid',
  properties: {
    eyebrow: P.str('Eyebrow', 'What we do'),
    heading: P.str('Heading', 'Services shaped around your project'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', 'Every engagement is different. These are the ways we most often help.'),
    items: P.list(
      'Cards',
      'Card',
      { icon: P.icon('Icon', 'sparkles'), title: P.str('Title', 'Service'), description: P.text('Description', 'Describe what this service includes and who it is for.'), linkLabel: P.str('Link label', ''), link: P.link('Link') },
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
    grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gridAutoFlow', 'gridAutoRows', 'gap'] },
    card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline'] },
    cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
    cardIcon: { nodeId: 'card-icon', label: 'Card icon', styleControls: ['color', 'background'] }
  },
  variantAxes: {
    tone: toneAxis(['lead']),
    layout: layoutAxis({
      default: { label: 'Three columns' },
      'two-columns': { label: 'Two columns', styles: { grid: { desktop: { columns: 2 } } } },
      'four-columns': { label: 'Four columns', styles: { grid: { desktop: { columns: 4 } } } },
      'sticky-split': {
        label: 'Heading pinned beside cards',
        fullListingOnly: true,
        styles: {
          inner: { tablet: STICKY_SPLIT_LAYOUT, desktop: { ...STICKY_SPLIT_LAYOUT, columnGap: tok('space.3xl') } },
          intro: { tablet: STICKY_BELOW_HEADER, desktop: STICKY_BELOW_HEADER },
          grid: { tablet: { columns: 1 }, desktop: { columns: 1 } }
        }
      }
    })
  },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('grid', 'ul', { name: 'Card grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
        b.repeat('cards', 'items', [
          b.el('card', 'li', { name: 'Card', styles: card }, [
            b.el('card-icon-wrap', 'div', { name: 'Icon badge', styles: { layout: 'row', align: 'center', justify: 'center', width: '48px', minHeight: '48px', radius: tok('radius.md'), color: tok('color.brand'), fontSize: '1.3rem', marginBlockEnd: tok('space.xs') } }, [
              b.icon('card-icon', { $item: 'icon' }, { name: 'Icon' })
            ]),
            b.text('card-title', 'h3', { $item: 'title' }, { name: 'Title', styles: { textStyle: tok('text.h3') } }),
            b.text('card-text', 'p', { $item: 'description' }, { name: 'Description', styles: mutedStyles }),
            b.link('card-link', { $item: 'link' }, { $item: 'linkLabel' }, 'text', { name: 'Link', when: { $item: 'linkLabel' }, styles: { marginBlockStart: 'auto' } })
          ])
        ])
      ])
    ])
};

/** The Gallery: a heading group and a grid of pictures, each doing what its item says when clicked. */
export const GALLERY: DesignSpec = {
  componentId: 'media.gallery',
  name: 'Gallery',
  category: 'media',
  properties: {
    eyebrow: P.str('Eyebrow', 'Selected work'),
    heading: P.str('Heading', 'Recent projects'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', ''),
    images: P.list(
      'Images',
      'Image',
      {
        image: P.image('Image'),
        caption: P.str('Caption', ''),
        action: P.choice('When clicked', 'none', [
          ['none', 'Nothing'],
          ['image', 'Show full image'],
          ['link', 'Follow link']
        ]),
        link: P.link('Link')
      },
      [],
      { titleField: 'caption', max: 24 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    grid: { nodeId: 'grid', label: 'Grid', styleControls: ['columns', 'gridAutoFlow', 'gridAutoRows', 'gap'] },
    image: { nodeId: 'image', label: 'Image', styleControls: ['aspectRatio', 'radius'] },
    caption: { nodeId: 'caption', label: 'Caption', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: { tone: toneAxis(['lead', 'caption']) },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('grid', 'ul', { name: 'Grid', collapseEmpty: true, styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
        b.repeat('photos', 'images', [
          b.el('photo', 'li', { name: 'Photo' }, [
            b.el('photo-figure', 'figure', { name: 'Figure', action: item('action'), link: item('link'), styles: { layout: 'stack', gap: tok('space.sm') } }, [
              b.image('image', { $item: 'image' }, { name: 'Image', styles: { aspectRatio: '4/3', radius: tok('radius.md'), objectFit: 'cover' } }),
              b.text('caption', 'figcaption', { $item: 'caption' }, { name: 'Caption', when: { $item: 'caption' }, styles: { textStyle: tok('text.small'), ...mutedStyles } })
            ])
          ])
        ])
      ])
    ])
};

/** The Carousel: a heading group and a row of slides that scrolls sideways. */
export const CAROUSEL: DesignSpec = {
  componentId: 'media.carousel',
  name: 'Carousel',
  category: 'media',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', 'Featured projects'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', ''),
    slides: P.list('Slides', 'Slide', { image: P.image('Image'), caption: P.str('Caption', ''), link: P.link('Link') }, [], { titleField: 'caption', max: 24 })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    slide: { nodeId: 'slide-card', label: 'Slide', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline'] },
    image: { nodeId: 'image', label: 'Image', styleControls: ['aspectRatio', 'radius'] },
    caption: { nodeId: 'caption', label: 'Caption', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: {
    tone: toneAxis(['lead', 'caption']),
    layout: layoutAxis({ default: { label: 'Three at a time' }, 'two-columns': { label: 'Two at a time' }, 'one-column': { label: 'One at a time' } })
  },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('track', 'ul', { name: 'Slides', carousel: true, collapseEmpty: true, ariaLabel: { $prop: 'heading' }, styles: { layout: 'row', gap: tok('space.lg') } }, [
        b.repeat('slides', 'slides', [
          b.el('slide', 'li', { name: 'Slide', styles: { base: { width: '85%' } } }, [
            b.el('slide-card', 'div', { name: 'Slide card', link: item('link'), styles: { layout: 'stack' } }, [
              b.el('figure', 'figure', { name: 'Figure', styles: { layout: 'stack', gap: tok('space.sm') } }, [
                b.image('image', { $item: 'image' }, { name: 'Image', fallbackAlt: 'Slide', styles: { aspectRatio: '4/3', radius: tok('radius.md'), objectFit: 'cover' } }),
                b.text('caption', 'figcaption', { $item: 'caption' }, { name: 'Caption', when: { $item: 'caption' }, styles: { textStyle: tok('text.small'), ...mutedStyles } })
              ])
            ])
          ])
        ])
      ])
    ])
};

/** The Section: an empty section whose container holds its one slot. */
export const SECTION: DesignSpec = {
  componentId: 'layout.section',
  name: 'Section',
  category: 'layout',
  properties: {},
  slots: { content: { label: 'Content', description: 'Headings, text, images, buttons and components placed inside the section.' } },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'paddingInline', 'background', 'color', 'minHeight'] },
    container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'layout', 'columns', 'gridTemplate', 'gridAutoFlow', 'gridAutoRows', 'gap', 'rowGap', 'columnGap', 'align', 'justify', 'textAlign'] }
  },
  variantAxes: { tone: toneAxis([]) },
  build: (b) => sectionShell(b, [b.slot('content-slot', 'content', { name: 'Content' })], { inner: { base: { gap: tok('space.lg') } } })
};

/** The FAQ: a heading group and a list of questions, each a disclosure with its answer and a divider after it. */
export const FAQ: DesignSpec = {
  componentId: 'faq.list',
  name: 'FAQ',
  category: 'conversion',
  properties: {
    eyebrow: P.str('Eyebrow', 'Questions'),
    heading: P.str('Heading', 'Frequently asked questions'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', 'Cannot find what you are looking for? Get in touch and we will be happy to help.'),
    items: P.list(
      'Questions',
      'Question',
      { question: P.required(P.str('Question', 'Question?')), answer: P.required(P.text('Answer', 'Answer.')) },
      [
        { question: 'How long does a typical project take?', answer: 'Most design projects take six to ten weeks from the first meeting to final drawings.' },
        { question: 'Do you work outside the local area?', answer: 'Yes. We regularly work across the region and can arrange remote consultations for early planning.' },
        { question: 'How are your fees calculated?', answer: 'We quote a fixed fee for each stage once we understand the scope.' }
      ],
      { titleField: 'question', max: 30 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    item: { nodeId: 'item', label: 'Question', styleControls: ['background', 'border', 'radius'] },
    question: { nodeId: 'question', label: 'Question text', styleControls: ['textStyle', 'color'] },
    answer: { nodeId: 'answer', label: 'Answer', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: { tone: toneAxis(['lead', 'answer']) },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('list', 'div', { name: 'Questions', styles: { layout: 'stack', gap: '0', border: '0' } }, [
        b.repeat('questions', 'items', [
          b.el('item', 'details', { name: 'Question' }, [
            b.el('summary', 'summary', { name: 'Summary', styles: { layout: 'row', justify: 'space-between', align: 'center', gap: tok('space.lg'), paddingBlock: tok('space.lg'), border: '0' } }, [
              b.text('question', 'span', { $item: 'question' }, { name: 'Question text', styles: { textStyle: tok('text.h3') } }),
              b.icon('toggle-icon', 'plus', { name: 'Toggle icon', styles: { color: tok('color.brand'), fontSize: '1.3rem' } })
            ]),
            b.text('answer', 'p', { $item: 'answer' }, { name: 'Answer', styles: { ...mutedStyles, paddingBlock: '0', marginBlockEnd: tok('space.lg'), maxWidth: '68ch' } })
          ]),
          b.divider('item-divider', { name: 'Divider' })
        ])
      ])
    ])
};

const DESIGNS: Record<string, DesignSpec> = Object.fromEntries([SPLIT_HERO, SERVICES_GRID, GALLERY, CAROUSEL, SECTION, FAQ].map((d) => [d.componentId, d]));

/** Foundation's section `componentId` as the managed design above, a theme definition with the release's ID. */
export function managedSection(componentId: string): ComponentDefinition {
  const spec = DESIGNS[componentId];
  if (!spec) throw new Error(`No managed design of ${componentId} here.`);
  return foundationDesign(spec);
}

/**
 * Put the managed designs of these sections in the project in place of the release's code (adding any it lacks), each
 * recorded as installed as it now is, so the starter's placements of them draw from data. Returns the project.
 */
export function withManaged(s: ProjectState, ...componentIds: string[]): ProjectState {
  for (const componentId of componentIds) {
    const def = managedSection(componentId);
    s.components[def.id] = def;
    s.themeLock.components[def.id] = { componentId, version: getTheme('foundation').version, hash: definitionHash(def) };
  }
  return s;
}

/**
 * Register Foundation with the managed designs of these sections in place of its code, so installing or inserting one
 * by component ID gets the design. A test that calls this restores the releases afterwards (`restorePacks`).
 */
export function registerManaged(...componentIds: string[]): void {
  const foundation = getTheme('foundation');
  const swapped = { ...foundation, components: foundation.components.map((c) => (componentIds.includes(c.componentId!) ? managedSection(c.componentId!) : c)) };
  registerPacks(listThemes().map((t) => (t.id === 'foundation' ? swapped : t)));
}
