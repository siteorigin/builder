import { STICKY_BELOW_HEADER, tokenVar } from '@shared/styles';
import { NO_LINK, P, eq, item, prop, tok, uiState } from '../dsl';
import { FOUNDATION } from './pack';
import { eyebrowStyles, headingBlock, headingLevel, layoutAxis, mutedStyles, sectionShell, toneAxis } from './common';

const { managed } = FOUNDATION;

const card = { layout: 'stack', gap: tok('space.md'), paddingBlock: tok('space.xl'), paddingInline: tok('space.xl'), background: tok('color.surface'), color: tok('color.text'), border: tok('border.default'), radius: tok('radius.lg') } as const;

/** Two columns side by side, a narrower one for what stays pinned and a wider one for what scrolls. */
const STICKY_SPLIT_LAYOUT = { layout: 'grid', gridTemplate: '1fr 1.5fr', align: 'start', columnGap: tok('space.2xl') } as const;

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
    headingLevel: headingLevel('h2'),
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
  variantAxes: {
    tone: toneAxis(['lead']),
    layout: layoutAxis({
      default: { label: 'Three columns' },
      'two-columns': { label: 'Two columns', styles: { grid: { desktop: { columns: 2 } } } },
      'four-columns': { label: 'Four columns', styles: { grid: { desktop: { columns: 4 } } } },
      // From tablet width up: the heading group stays in view, below the site's sticky header, while the cards scroll
      // past beside it. Phones (and print, see base.css) show the heading above the cards as usual.
      'sticky-split': {
        label: 'Heading pinned beside cards',
        // Kept off a small model's page tool, which every layout option of the grid grows.
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
    ...P.group('Text', {
      eyebrow: P.str('Eyebrow', 'Our approach'),
      heading: P.str('Heading', 'Good projects start with listening'),
      headingLevel: headingLevel('h2'),
      body: P.rich('Text', [
        'Before we draw anything we spend time understanding how you live and work, what matters most and what you would happily leave behind.',
        'That conversation shapes **every decision** that follows, from the first sketch to the final finishes.'
      ])
    }),
    ...P.group('Media', { image: P.image('Image', 'Two people reviewing plans at a table') }),
    ...P.group('Action', {
      actionLabel: P.str('Action label', 'More about us'),
      actionLink: P.link('Action link')
    })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    body: { nodeId: 'body', label: 'Text', styleControls: ['textStyle', 'color'] },
    media: { nodeId: 'media', label: 'Image', styleControls: ['aspectRatio', 'radius', 'shadow'] },
    action: { nodeId: 'action', label: 'Action' }
  },
  variantAxes: {
    tone: toneAxis(['body']),
    layout: layoutAxis({
      default: { label: 'Image first' },
      'media-end': { label: 'Image last', styles: { 'media-wrap': { desktop: { order: 2 } } } }
    })
  },
  build: (b) =>
    sectionShell(b, [
      b.el('grid', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.2xl'), align: 'center' }, desktop: { columns: 2, gap: tok('space.3xl') } } }, [
        b.el('media-wrap', 'figure', { name: 'Media' }, [
          b.image('media', { $prop: 'image' }, { name: 'Image', styles: { aspectRatio: '4/3', radius: tok('radius.lg'), objectFit: 'cover' } })
        ]),
        b.el('content', 'div', { name: 'Content', styles: { layout: 'stack', gap: tok('space.lg'), align: 'start' } }, [
          b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
          b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h2') } }),
          b.rich('body', { $prop: 'body' }, { name: 'Text', styles: { ...mutedStyles, textStyle: tok('text.body') } }),
          b.link('action', { $prop: 'actionLink' }, { $prop: 'actionLabel' }, 'secondary', { name: 'Action', when: { $prop: 'actionLabel' }, styles: { marginBlockStart: tok('space.xs') } })
        ])
      ])
    ])
});

/** A step's button: its title, as wide as its column, read as a heading-sized line. */
const stepTrigger = { width: 'fill', textAlign: 'start', justify: 'start', textStyle: tok('text.h3'), color: tok('color.text'), paddingBlock: tok('space.xs') } as const;

/**
 * Numbered steps beside a picture: clicking a step opens its description and shows its own picture, both read from
 * one list, so a step's words and picture never drift apart. Each placement starts at the step it is set to (the
 * first); every description and picture stays in the page, so printing shows them all, one after another. From tablet
 * width up the picture stays in view, below the sticky site header, while a long list of steps scrolls.
 */
export const stepsMedia = managed({
  componentId: 'content.steps-media',
  name: 'Steps with pictures',
  description: 'A list of steps beside a picture: choosing a step opens its description and shows its own picture. Use for a process, how it works, or a product tour.',
  category: 'content',
  tags: ['steps', 'process', 'how it works', 'accordion', 'tabs', 'tour', 'media', 'split', 'showcase'],
  icon: 'list-ordered',
  // Its steps, pictures and item state cost a small model's page tool about 1 KB: offered there once a project has it.
  fullListingOnly: true,
  properties: {
    ...P.group('Text', {
      eyebrow: P.str('Eyebrow', 'How it works'),
      heading: P.str('Heading', 'From first call to finished project'),
      headingLevel: headingLevel('h2'),
      lead: P.text('Supporting text', 'Three clear stages, each with a picture of what it looks like in practice.')
    }),
    steps: P.list(
      'Steps',
      'Step',
      {
        title: P.str('Title', 'Step'),
        description: P.text('Description', 'Describe what happens at this step and what the client gets from it.'),
        image: P.image('Picture', 'A picture of this step')
      },
      [
        { title: 'Plan together', description: 'We walk the site with you, agree priorities and a budget, and set a schedule everyone understands.', image: { assetId: null, alt: 'Planning a project at a table' } },
        { title: 'Design the details', description: 'Layouts, materials and finishes take shape through a few focused reviews, so nothing surprises you later.', image: { assetId: null, alt: 'Material samples laid out for review' } },
        { title: 'Build and hand over', description: 'Trusted specialists build it while we keep you informed, then we walk you through every finished detail.', image: { assetId: null, alt: 'A finished room ready for handover' } }
      ],
      { titleField: 'title', max: 8 }
    )
  },
  state: { activeStep: { type: 'item', label: 'Active step', list: 'steps', initial: 0 } },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    step: { nodeId: 'step', label: 'Step', styleControls: ['background', 'border', 'radius', 'paddingBlock', 'paddingInline'] },
    stepTitle: { nodeId: 'step-trigger', label: 'Step title', styleControls: ['textStyle', 'color'] },
    stepText: { nodeId: 'step-text', label: 'Step description', styleControls: ['textStyle', 'color'] },
    picture: { nodeId: 'step-image', label: 'Picture', styleControls: ['aspectRatio', 'radius', 'shadow'] }
  },
  variantAxes: {
    tone: toneAxis(['lead']),
    layout: layoutAxis({
      default: { label: 'Steps first' },
      'media-first': { label: 'Picture first', styles: { 'steps-stage': { tablet: { order: 2 }, desktop: { order: 2 } } } }
    })
  },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('steps-layout', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.xl') }, tablet: { columns: 2, align: 'start', gap: tok('space.2xl') }, desktop: { columns: 2, align: 'start', gap: tok('space.3xl') } } }, [
        b.el('steps-stage', 'ol', { name: 'Steps', styles: { layout: 'stack', gap: tok('space.sm') } }, [
          b.repeat('step-items', 'steps', [
            b.el('step', 'li', { name: 'Step', styles: { layout: 'stack', gap: tok('space.xs'), paddingBlock: tok('space.md'), paddingInline: tok('space.lg'), border: tok('border.default'), radius: tok('radius.lg'), background: tok('color.surface') } }, [
              b.link('step-trigger', { type: 'none', target: '' }, { $item: 'title' }, 'plain', { name: 'Step title', stateAction: { state: 'activeStep', op: 'select' }, styles: stepTrigger }),
              b.el('step-details', 'div', { name: 'Step details', when: uiState('activeStep') }, [b.text('step-text', 'p', { $item: 'description' }, { name: 'Description', styles: { ...mutedStyles, textStyle: tok('text.body') } })])
            ])
          ])
        ]),
        b.el('media-stage', 'div', { name: 'Picture', styles: { tablet: STICKY_BELOW_HEADER, desktop: STICKY_BELOW_HEADER } }, [
          b.repeat('media-items', 'steps', [
            b.el('step-media', 'figure', { name: 'Step picture', when: uiState('activeStep') }, [
              b.image('step-image', { $item: 'image' }, { name: 'Picture', styles: { aspectRatio: '4/3', radius: tok('radius.lg'), objectFit: 'cover' } })
            ])
          ])
        ])
      ])
    ])
});

/** Icons a showcase tab can show beside its label, or none. */
const TAB_ICONS: Array<[string, string]> = [
  ['', 'None'],
  ...(
    [
      ['sparkles', 'Sparkles'], ['compass', 'Compass'], ['pen-tool', 'Pen'], ['ruler', 'Ruler'], ['hammer', 'Hammer'], ['paintbrush', 'Paintbrush'],
      ['leaf', 'Leaf'], ['house', 'House'], ['layers', 'Layers'], ['lightbulb', 'Light bulb'], ['rocket', 'Rocket'], ['target', 'Target'],
      ['chart-line', 'Chart'], ['shield-check', 'Shield'], ['users', 'People'], ['calendar', 'Calendar'], ['clock', 'Clock'], ['camera', 'Camera'],
      ['heart', 'Heart'], ['star', 'Star']
    ] as Array<[string, string]>
  )
];

/** How many tabs a showcase can have: the first two always show, the rest while their labels are filled in. */
const SHOWCASE_TABS = [1, 2, 3, 4, 5, 6] as const;
type ShowcaseTab = (typeof SHOWCASE_TABS)[number];

/** A showcase tab's content as one property, starting as `sample` (blank, and so left out unless it is tab 1 or 2). */
function showcaseTab(n: ShowcaseTab, sample: { label: string; icon: string; heading: string; copy: string[]; actionLabel?: string; alt: string } | null) {
  return P.object(
    `Tab ${n}`,
    {
      label: P.str('Tab label', sample?.label ?? ''),
      icon: P.choice('Tab icon', sample?.icon ?? '', TAB_ICONS),
      heading: P.str('Heading', sample?.heading ?? ''),
      copy: P.rich('Text', sample?.copy ?? []),
      actionLabel: P.str('Action label', sample?.actionLabel ?? ''),
      actionLink: P.link('Action link'),
      image: P.image('Image', sample?.alt ?? '')
    },
    { description: n <= 2 ? `Always shown. ${n === 1 ? 'Open when the page loads.' : ''}`.trim() : 'Shown while its tab label is filled in; clear the label to leave the tab out.' }
  );
}

/**
 * The showcase's tones. On the dark one a text action reads in the tone's own ink, as the base stylesheet draws a text
 * button in a dark section, rather than the brand colour it has on a light one.
 */
function showcaseTone() {
  const axis = toneAxis(['lead', ...SHOWCASE_TABS.map((n) => `copy-${n}`)]);
  const inverse = axis.options.inverse;
  const actions = Object.fromEntries(SHOWCASE_TABS.map((n) => [`action-${n}`, { base: { color: tok('color.on-inverse') } }]));
  return { ...axis, options: { ...axis.options, inverse: { ...inverse, styles: { ...inverse.styles, ...actions } } } };
}

export const tabsShowcase = managed({
  componentId: 'tabs.showcase',
  name: 'Tabbed showcase',
  description: 'Two to six tabs, each opening an image beside a heading, rich text and an optional action. Tabs 3 to 6 show while their labels are filled in.',
  category: 'content',
  tags: ['tabs', 'tabbed', 'showcase', 'services', 'features', 'process', 'steps', 'switcher', 'product tour'],
  icon: 'layout-panel-top',
  // Six tabs of image, copy and action cost a small model's page tool about 1.3 KB: offered there once a project has it.
  fullListingOnly: true,
  properties: {
    ...P.group('Text', {
      eyebrow: P.str('Eyebrow', 'How we work'),
      heading: P.str('Heading', 'From first sketch to finished room'),
      headingLevel: headingLevel('h2'),
      lead: P.text('Supporting text', 'Every project moves through the same three stages. Choose one to see what it involves.')
    }),
    tab1: showcaseTab(1, {
      label: 'Design',
      icon: 'pen-tool',
      heading: 'Plans drawn around how you live',
      copy: ['We measure, listen and sketch until the layout feels right, then turn it into **drawings builders can price**.'],
      actionLabel: 'See recent projects',
      alt: 'Sketches and material samples spread across a desk'
    }),
    tab2: showcaseTab(2, {
      label: 'Build',
      icon: 'hammer',
      heading: 'One team from demolition to handover',
      copy: ['Our own carpenters, plumbers and electricians work to one schedule, with a site lead you can always reach.'],
      alt: 'A carpenter fitting a kitchen cabinet'
    }),
    tab3: showcaseTab(3, {
      label: 'Care',
      icon: 'shield-check',
      heading: 'Looked after long after we leave',
      copy: ['Every project comes with a two-year workmanship guarantee and a check-in visit after the first winter.'],
      alt: 'A finished living room in afternoon light'
    }),
    tab4: showcaseTab(4, null),
    tab5: showcaseTab(5, null),
    tab6: showcaseTab(6, null)
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    list: { nodeId: 'tab-list', label: 'Tab list', styleControls: ['gap', 'justify'] },
    panels: { nodeId: 'panels', label: 'Panels', styleControls: ['background', 'radius', 'paddingBlock', 'paddingInline'] }
  },
  state: {
    tab: { type: 'enum', label: 'Tabs', options: SHOWCASE_TABS.map((n) => ({ value: `tab${n}`, label: `Tab ${n}` })), initial: 'tab1' }
  },
  variantAxes: { tone: showcaseTone() },
  build: (b) => {
    const field = (n: ShowcaseTab, name: string) => ({ $prop: `tab${n}`, field: name });
    // Tabs 3 to 6 are there while their labels are; each one's panel is the only child of a wrapper shown on the same
    // condition, so a placement has both or neither.
    const shownIf = (n: ShowcaseTab) => (n > 2 ? { when: field(n, 'label') } : {});
    const tabs = SHOWCASE_TABS.map((n) =>
      b.link(`tab-${n}`, NO_LINK, field(n, 'label'), 'secondary', {
        name: `Tab ${n}`,
        icon: field(n, 'icon'),
        stateAction: { state: 'tab', op: 'set', value: `tab${n}` },
        ...shownIf(n),
        styles: { flexShrink: 0 }
      })
    );
    const panels = SHOWCASE_TABS.map((n) =>
      b.el(`panel-wrap-${n}`, 'div', { name: `Tab ${n}`, collapseEmpty: true, ...shownIf(n) }, [
        b.el(`panel-${n}`, 'div', { name: `Tab ${n} panel`, when: eq(uiState('tab'), `tab${n}`), styles: { base: { layout: 'grid', columns: 1, gap: tok('space.2xl'), align: 'center' }, desktop: { columns: 2, gap: tok('space.3xl') } } }, [
          b.el(`media-${n}`, 'figure', { name: 'Media' }, [b.image(`image-${n}`, field(n, 'image'), { name: 'Image', styles: { aspectRatio: '4/3', radius: tok('radius.lg'), objectFit: 'cover' } })]),
          b.el(`content-${n}`, 'div', { name: 'Content', styles: { layout: 'stack', gap: tok('space.lg'), align: 'start' } }, [
            b.text(`heading-${n}`, 'h3', field(n, 'heading'), { name: 'Heading', when: field(n, 'heading'), styles: { textStyle: tok('text.h3') } }),
            b.rich(`copy-${n}`, field(n, 'copy'), { name: 'Text', styles: { ...mutedStyles, textStyle: tok('text.body') } }),
            b.link(`action-${n}`, field(n, 'actionLink'), field(n, 'actionLabel'), 'text', { name: 'Action', when: field(n, 'actionLabel') })
          ])
        ])
      ])
    );
    return sectionShell(b, [
      headingBlock(b),
      b.el('showcase', 'div', { name: 'Showcase', styles: { layout: 'stack', gap: tok('space.xl') } }, [
        // On a phone the tabs stay on one line and scroll sideways; from a tablet up they wrap. The padding keeps the
        // focus ring of a tab inside the scrolling row.
        b.el(
          'tab-list',
          'div',
          {
            name: 'Tab list',
            ariaLabel: prop('heading'),
            styles: { base: { layout: 'row', wrap: false, gap: tok('space.xs'), align: 'center', paddingBlock: tok('space.2xs'), paddingInline: tok('space.2xs'), marginInline: `calc(-1 * var(${tokenVar('space.2xs')}))`, customCss: 'overflow-x: auto' }, tablet: { wrap: true }, desktop: { wrap: true } }
          },
          tabs
        ),
        b.el('panels', 'div', { name: 'Panels', styles: { layout: 'stack', gap: tok('space.2xl') } }, panels)
      ])
    ]);
  }
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
    headingLevel: headingLevel('h2'),
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
  variantAxes: { tone: toneAxis(['body']) },
  build: (b) =>
    sectionShell(
      b,
      [
        b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h2') } }),
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
    headingLevel: headingLevel('h2'),
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
  variantAxes: { tone: toneAxis(['label']) },
  build: (b) =>
    sectionShell(b, [
      b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h2') } }),
      b.el('grid', 'dl', { name: 'Grid', styles: { base: { layout: 'grid', columns: 2, gap: tok('space.xl') }, desktop: { columns: 4 } } }, [
        b.repeat('figures', 'items', [
          b.el('figure', 'div', { name: 'Figure', styles: { layout: 'stack', gap: tok('space.xs'), paddingInline: '0', border: '0', marginBlockStart: '0' } }, [
            // A term comes before its description in a <dl>; `order` still shows the figure above its label.
            b.text('label', 'dt', { $item: 'label' }, { name: 'Label', styles: { ...mutedStyles, textStyle: tok('text.small') } }),
            b.text('value', 'dd', { $item: 'value' }, { name: 'Value', styles: { textStyle: tok('text.stat'), color: tok('color.brand'), order: -1 } })
          ])
        ])
      ])
    ])
});

export const gallery = managed({
  componentId: 'media.gallery',
  name: 'Gallery',
  description: 'A responsive grid of images with optional captions. Each image can do nothing when clicked, open full size, or link to a page such as a case study.',
  category: 'media',
  tags: ['gallery', 'images', 'photos', 'portfolio', 'work', 'grid'],
  icon: 'images',
  properties: {
    eyebrow: P.str('Eyebrow', 'Selected work'),
    heading: P.str('Heading', 'Recent projects'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', ''),
    // A new gallery starts empty: the author chooses its pictures from Assets (see lib/gallery-picks), rather than
    // replacing invented ones.
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
    grid: { nodeId: 'grid', label: 'Grid', styleControls: ['columns', 'gap'] },
    image: { nodeId: 'image', label: 'Image', styleControls: ['aspectRatio', 'radius'] },
    caption: { nodeId: 'caption', label: 'Caption', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: { tone: toneAxis(['lead', 'caption']) },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      // An empty gallery leaves no empty <ul> behind.
      b.el('grid', 'ul', { name: 'Grid', collapseEmpty: true, styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
        b.repeat('photos', 'images', [
          b.el('photo', 'li', { name: 'Photo' }, [
            // A working action wraps the whole figure, image and caption, in one link: to the full-size image (which
            // opens in a viewer) or to the item's destination.
            b.el('photo-figure', 'figure', { name: 'Figure', action: item('action'), link: item('link'), styles: { layout: 'stack', gap: tok('space.sm') } }, [
              b.image('image', { $item: 'image' }, { name: 'Image', styles: { aspectRatio: '4/3', radius: tok('radius.md'), objectFit: 'cover' } }),
              b.text('caption', 'figcaption', { $item: 'caption' }, { name: 'Caption', when: { $item: 'caption' }, styles: { textStyle: tok('text.small'), ...mutedStyles } })
            ])
          ])
        ])
      ])
    ])
});

/** The space between slides, a site style, which the widths below allow for. */
const SLIDE_GAP = 'space.lg';
/** A slide's width when `n` show at once. */
const slidesAcross = (n: number) => (n === 1 ? '100%' : `calc((100% - ${n - 1} * var(${tokenVar(SLIDE_GAP)})) / ${n})`);

/**
 * A row of images that scrolls sideways a slide at a time: a portfolio, a product tour or the photos of one project.
 * Its list is a carousel track (`ElementNode.carousel`): it scrolls and snaps to each slide with CSS alone, so every
 * slide is reachable without the page's script and prints as a stack, and the runtime helper adds Previous and Next
 * buttons and the count of the slides showing. A phone shows one slide and the edge of the next.
 */
export const carousel = managed({
  componentId: 'media.carousel',
  name: 'Carousel',
  description:
    'Images with optional captions in a row that scrolls sideways a slide at a time, by swiping or with Previous and Next buttons. Each slide can link to a page, such as a case study. Shows one, two or three slides at once on a desktop. Use for a portfolio, a product tour or the photos of one project.',
  category: 'media',
  tags: ['carousel', 'slider', 'slides', 'slideshow', 'swipe', 'images', 'photos', 'portfolio', 'case study', 'product tour', 'tour', 'work'],
  icon: 'gallery-horizontal-end',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', 'Featured projects'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', ''),
    // A new carousel starts empty, like a Gallery: the author chooses its pictures from Assets.
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
    layout: layoutAxis({
      default: { label: 'Three at a time' },
      'two-columns': { label: 'Two at a time', styles: { slide: { desktop: { width: slidesAcross(2) } } } },
      'one-column': { label: 'One at a time', styles: { slide: { tablet: { width: slidesAcross(1) }, desktop: { width: slidesAcross(1) } } } }
    })
  },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      // Named by the heading. An empty carousel leaves no empty list (and no buttons) behind.
      // A row of its own, so a copy that hides the list and shows it again shows it as a row.
      b.el('track', 'ul', { name: 'Slides', carousel: true, collapseEmpty: true, ariaLabel: { $prop: 'heading' }, styles: { layout: 'row', gap: tok(SLIDE_GAP) } }, [
        b.repeat('slides', 'slides', [
          b.el('slide', 'li', { name: 'Slide', styles: { base: { width: '85%' }, tablet: { width: slidesAcross(2) }, desktop: { width: slidesAcross(3) } } }, [
            // A slide with a destination is one link around its picture and caption.
            b.el('slide-card', 'div', { name: 'Slide card', link: item('link'), styles: { layout: 'stack' } }, [
              b.el('figure', 'figure', { name: 'Figure', styles: { layout: 'stack', gap: tok('space.sm') } }, [
                // A decorative or missing picture still says “Slide”, so a slide that links somewhere is never unnamed.
                b.image('image', { $item: 'image' }, { name: 'Image', fallbackAlt: 'Slide', styles: { aspectRatio: '4/3', radius: tok('radius.md'), objectFit: 'cover' } }),
                b.text('caption', 'figcaption', { $item: 'caption' }, { name: 'Caption', when: { $item: 'caption' }, styles: { textStyle: tok('text.small'), ...mutedStyles } })
              ])
            ])
          ])
        ])
      ])
    ])
});

/**
 * A curated list of the site's own pages: a portfolio, case studies, a project index or a directory of services.
 * Each card links to its page by ID, so it follows the page's renames and address changes, and shows the page's
 * title, description and sharing image while its own fields are empty. Typed copy on a card is kept as it is.
 * The whole title is the card's link, so every link reads as the page it opens.
 */
export const pageList = managed({
  componentId: 'content.pages',
  name: 'Page list',
  description: "Cards linking to pages of this site in the order you choose. Each card shows its page's title, description and sharing image unless you give it its own. Use for a portfolio, case studies, a project index or a directory of services.",
  category: 'content',
  tags: ['portfolio', 'projects', 'case study', 'case studies', 'directory', 'index', 'page list', 'pages', 'work', 'teasers', 'listing'],
  icon: 'layout-list',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', 'Selected work'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', ''),
    items: P.list(
      'Pages',
      'Page',
      {
        pageLink: P.link('Page'),
        title: P.str('Title', ''),
        description: P.text('Description', ''),
        image: P.image('Image'),
        // A card's category: once the cards name two or more, buttons above them show one category at a time.
        group: P.str('Category', '')
      },
      [],
      { titleField: 'title', min: 0, max: 24, pageTeaser: { link: 'pageLink', title: 'title', description: 'description', image: 'image' } }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
    card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline', 'gap'] },
    cardImage: { nodeId: 'card-image', label: 'Card image', styleControls: ['aspectRatio', 'radius'] },
    cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
    cardText: { nodeId: 'card-text', label: 'Card description', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: {
    tone: toneAxis(['lead', 'card-text']),
    layout: layoutAxis({
      default: { label: 'Three columns' },
      'two-columns': { label: 'Two columns', styles: { grid: { desktop: { columns: 2 } } } }
    })
  },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      // An empty list leaves no empty <ul> behind.
      b.el('grid', 'ul', { name: 'Card grid', collapseEmpty: true, styles: { base: { layout: 'grid', columns: 1, gap: tok('space.xl') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
        b.repeat('cards', 'items', [
          // A card shows only with somewhere to go and a title to click: one whose page has gone, that links nowhere,
          // or that links outside the site without a title of its own is left out, list item and all.
          b.el('card-item', 'li', { name: 'Card item', when: { $item: 'pageLink' }, collapseEmpty: true }, [
            b.el('card', 'div', { name: 'Card', when: { $item: 'title' }, styles: { layout: 'stack', gap: tok('space.sm') } }, [
              b.image('card-image', { $item: 'image' }, { name: 'Image', when: { $item: 'image' }, styles: { aspectRatio: '4/3', radius: tok('radius.md'), objectFit: 'cover', marginBlockEnd: tok('space.xs') } }),
              b.link('card-title', { $item: 'pageLink' }, { $item: 'title' }, 'plain', { name: 'Title', styles: { textStyle: tok('text.h3') } }),
              b.text('card-text', 'p', { $item: 'description' }, { name: 'Description', when: { $item: 'description' }, styles: mutedStyles })
            ])
          ])
        ], { filter: { field: 'group' } })
      ])
    ])
});

/** The fields a computed article row fills (see shared/articles.ts), as a list's item fields. */
const articleFields = () => ({
  pageLink: P.link('Article'),
  title: P.str('Title', ''),
  date: P.str('Date', ''),
  dateLabel: P.str('Date as shown', ''),
  byline: P.str('Byline', ''),
  excerpt: P.text('Excerpt', '')
});

const metaStyles = { layout: 'row', wrap: true, gap: tok('space.sm'), textStyle: tok('text.small'), ...mutedStyles } as const;

/**
 * The site's dated articles, newest first, worked out when the site is generated: an article added, redated,
 * renamed, hidden from news lists or deleted changes every News list with nothing to edit here. Each card links to
 * its article by page ID and states its date in a `<time>` element.
 */
export const newsList = managed({
  componentId: 'content.news',
  name: 'News list',
  description:
    "The site's dated articles, newest first, filled in automatically: each card shows an article's title (its link), publication date, byline and excerpt. A new article appears on its own; one kept as a draft or hidden from news lists does not. Use for news, announcements, updates or a blog index.",
  category: 'content',
  tags: ['news', 'articles', 'article list', 'posts', 'blog', 'announcements', 'updates', 'latest', 'recent', 'journal', 'press', 'dated'],
  icon: 'newspaper',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    heading: P.str('Heading', 'Latest news'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', ''),
    items: P.list('Articles', 'Article', articleFields(), [], { titleField: 'title', min: 0, max: 12, feed: 'articles' })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
    card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline', 'gap'] },
    cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
    cardMeta: { nodeId: 'card-meta', label: 'Date and byline', styleControls: ['textStyle', 'color'] },
    cardText: { nodeId: 'card-text', label: 'Card excerpt', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: {
    tone: toneAxis(['lead', 'card-meta', 'card-text']),
    layout: layoutAxis({
      default: { label: 'Three columns' },
      'two-columns': { label: 'Two columns', styles: { grid: { desktop: { columns: 2 } } } },
      'one-column': { label: 'One column', styles: { grid: { tablet: { columns: 1 }, desktop: { columns: 1 } } } }
    })
  },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      // No articles yet leaves no empty <ul> behind.
      b.el('grid', 'ul', { name: 'Card grid', collapseEmpty: true, styles: { base: { layout: 'grid', columns: 1, gap: tok('space.xl') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
        b.repeat('cards', 'items', [
          b.el('card-item', 'li', { name: 'Card item', when: { $item: 'pageLink' } }, [
            b.el('card', 'article', { name: 'Card', styles: { layout: 'stack', gap: tok('space.sm') } }, [
              b.link('card-title', { $item: 'pageLink' }, { $item: 'title' }, 'plain', { name: 'Title', styles: { textStyle: tok('text.h3') } }),
              b.el('card-meta', 'p', { name: 'Date and byline', styles: metaStyles }, [
                b.text('card-date', 'span', { $item: 'dateLabel' }, { name: 'Date', datetime: { $item: 'date' }, when: { $item: 'dateLabel' } }),
                b.text('card-byline', 'span', { $item: 'byline' }, { name: 'Byline', when: { $item: 'byline' } })
              ]),
              b.text('card-text', 'p', { $item: 'excerpt' }, { name: 'Excerpt', when: { $item: 'excerpt' }, styles: mutedStyles })
            ])
          ])
        ])
      ])
    ])
});

/**
 * The top of a dated article: the page's title as its Heading 1, its publication date in a `<time>` element, its
 * byline and its excerpt, all read from the page's article settings where it is placed, so the article and every
 * News list always agree. On a page that is not an article it shows the page's title alone.
 */
export const articleHeader = managed({
  componentId: 'content.article',
  name: 'Article header',
  description:
    "The top of a dated article: the page's title, publication date, byline and excerpt, taken from the page's article settings so they always match the News lists. Place it first on a news item or announcement, with a Text section below for the body.",
  category: 'hero',
  tags: ['article', 'news', 'news item', 'post', 'blog post', 'announcement', 'article header', 'byline', 'publication date', 'published', 'dated'],
  icon: 'file-text',
  properties: {
    eyebrow: P.str('Eyebrow', ''),
    article: P.list('Article', 'Article', articleFields(), [], { titleField: 'title', min: 0, max: 1, feed: 'currentPage' })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    eyebrow: { nodeId: 'eyebrow', label: 'Eyebrow', styleControls: ['textStyle', 'color'] },
    heading: { nodeId: 'heading', label: 'Title', styleControls: ['textStyle', 'color'] },
    meta: { nodeId: 'meta', label: 'Date and byline', styleControls: ['textStyle', 'color'] },
    lead: { nodeId: 'lead', label: 'Excerpt', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: { tone: toneAxis(['meta', 'lead'], {}, 'muted') },
  build: (b) =>
    sectionShell(
      b,
      [
        b.el('content', 'div', { name: 'Content', styles: { base: { layout: 'stack', gap: tok('space.md'), maxWidth: '780px' } } }, [
          b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
          b.repeat('page', 'article', [
            b.text('heading', 'h1', { $item: 'title' }, { name: 'Title', when: { $item: 'title' }, styles: { textStyle: tok('text.h1') } }),
            b.el('meta', 'p', { name: 'Date and byline', collapseEmpty: true, styles: metaStyles }, [
              b.text('date', 'span', { $item: 'dateLabel' }, { name: 'Date', datetime: { $item: 'date' }, when: { $item: 'dateLabel' } }),
              b.text('byline', 'span', { $item: 'byline' }, { name: 'Byline', when: { $item: 'byline' } })
            ]),
            b.text('lead', 'p', { $item: 'excerpt' }, { name: 'Excerpt', when: { $item: 'excerpt' }, styles: { textStyle: tok('text.lead'), ...mutedStyles } })
          ])
        ])
      ],
      { root: { base: { paddingBlock: 'clamp(3.5rem, 2.5rem + 4vw, 6rem)' } } }
    )
});

export const container = managed({
  componentId: 'layout.section',
  name: 'Section',
  description: 'A flexible empty section with a content area. Add headings, text, images and buttons inside it.',
  category: 'layout',
  tags: ['section', 'container', 'empty', 'blank', 'layout', 'custom'],
  icon: 'square-dashed',
  properties: {},
  slots: { content: { label: 'Content', description: 'Headings, text, images, buttons and components placed inside the section.' } },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'paddingInline', 'background', 'color', 'minHeight'] },
    container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'layout', 'columns', 'gridTemplate', 'gap', 'rowGap', 'columnGap', 'align', 'justify', 'textAlign'] }
  },
  variantAxes: { tone: toneAxis([]) },
  build: (b) => sectionShell(b, [b.slot('content-slot', 'content', { name: 'Content' })], { inner: { base: { gap: tok('space.lg') } } })
});

/** One of a Split layout's two columns: a stack of whatever the placement puts in its slot. */
const splitColumn = { layout: 'stack', gap: tok('space.md'), minWidth: '0px' } as const;

/**
 * Two named slots side by side, from tablet up; phones show Primary above Secondary. Both columns stay in the grid
 * while empty, so what is in Secondary keeps its side (base.css drops an empty column on phones, where it would
 * only add a gap).
 */
export const splitLayout = managed({
  componentId: 'layout.split',
  name: 'Split layout',
  description:
    'A section with two side-by-side areas, Primary and Secondary, in a choice of proportions. Add headings, text, images, buttons and components to each, such as an article beside a newsletter sign-up or callout. Phones show Primary above Secondary.',
  category: 'layout',
  tags: ['split', 'side by side', 'aside', 'layout', 'container', 'slots'],
  icon: 'columns-2',
  properties: {},
  slots: {
    primary: { label: 'Primary', description: 'The first column: on the left, and on top on phones.' },
    secondary: { label: 'Secondary', description: 'The second column: on the right, and underneath on phones.' }
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'paddingInline', 'background', 'color', 'minHeight'] },
    container: { nodeId: 'inner', label: 'Columns', styleControls: ['maxWidth', 'gap', 'rowGap', 'columnGap', 'align'] },
    primary: { nodeId: 'split-primary', label: 'Primary column', styleControls: ['gap', 'background', 'color', 'border', 'radius', 'paddingBlock', 'paddingInline'] },
    secondary: { nodeId: 'split-secondary', label: 'Secondary column', styleControls: ['gap', 'background', 'color', 'border', 'radius', 'paddingBlock', 'paddingInline'] }
  },
  variantAxes: {
    ratio: {
      label: 'Proportions',
      default: 'equal',
      options: {
        equal: { label: 'Equal (1:1)' },
        'wide-left': { label: 'Wide left (2:1)', styles: { inner: { base: { gridTemplate: '2fr 1fr' } } } },
        'wide-right': { label: 'Wide right (1:2)', styles: { inner: { base: { gridTemplate: '1fr 2fr' } } } }
      }
    },
    tone: toneAxis([]),
    sticky: {
      label: 'Secondary column',
      default: 'flow',
      options: {
        flow: { label: 'Scrolls with the page' },
        // From tablet up, below the site's sticky header while a taller Primary column scrolls past.
        'pin-secondary': { label: 'Stays in view (sticky)', styles: { 'split-secondary': { tablet: STICKY_BELOW_HEADER, desktop: STICKY_BELOW_HEADER } } }
      }
    }
  },
  // The page tool cannot fill named slots, so a small model is offered this only once the project has it.
  fullListingOnly: true,
  build: (b) =>
    sectionShell(
      b,
      [
        b.el('split-primary', 'div', { name: 'Primary column', styles: splitColumn }, [b.slot('primary-slot', 'primary', { name: 'Primary' })]),
        b.el('split-secondary', 'div', { name: 'Secondary column', styles: splitColumn }, [b.slot('secondary-slot', 'secondary', { name: 'Secondary' })])
      ],
      // Column sizes set for all sizes apply from tablet up; the one column is the phone's.
      { inner: { base: { layout: 'grid', columns: 1, gridTemplate: '1fr 1fr', align: 'start', rowGap: tok('space.lg'), columnGap: tok('space.2xl') } } }
    )
});

// Figures switch to the accent color on the dark tone for contrast.
stats.variantAxes!.tone.options.inverse.styles!.value = { base: { color: tok('color.accent') } };
