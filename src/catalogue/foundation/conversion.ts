import { NO_LINK, P, TreeBuilder, eq, item, prop, tok, uiState } from '../dsl';
import { FOUNDATION } from './pack';
import { headingBlock, headingLevel, mutedStyles, sectionShell, toneAxis } from './common';
import { SAMPLE_CONTACT } from '@shared/sample-contact';

const { managed } = FOUNDATION;

export const pricing = managed({
  componentId: 'pricing.plans',
  name: 'Pricing',
  description: 'Simple static pricing plans with features and a call to action. There is no checkout.',
  category: 'conversion',
  tags: ['pricing', 'plans', 'packages', 'rates', 'fees', 'cost'],
  icon: 'tag',
  properties: {
    eyebrow: P.str('Eyebrow', 'Packages'),
    heading: P.str('Heading', 'Clear packages, no surprises'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', 'Every project starts with a free consultation. Fixed fees are agreed before work begins.'),
    plans: P.list(
      'Plans',
      'Plan',
      {
        name: P.str('Name', 'Plan'),
        price: P.str('Price', '$0'),
        period: P.str('Period', ''),
        description: P.text('Description', ''),
        badge: P.str('Badge', ''),
        features: P.rich('Features', ['A feature'], { plainAs: 'check' }),
        actionLabel: P.str('Action label', 'Get started'),
        actionLink: P.link('Action link')
      },
      [
        { name: 'Consultation', price: '$350', period: 'one session', description: 'A focused session to explore ideas and priorities.', badge: '', features: ['Two-hour site visit', 'Written summary', 'Budget guidance'], actionLabel: 'Book a session', actionLink: { type: 'none', target: '' } },
        { name: 'Design', price: '$4,800', period: 'from', description: 'A complete design package ready for builders to quote.', badge: 'Most popular', features: ['Concept and detailed design', 'Materials and finishes', 'Drawings for tender', 'Three review meetings'], actionLabel: 'Start a project', actionLink: { type: 'none', target: '' } },
        { name: 'Full service', price: 'Custom', period: '', description: 'Design plus coordination through to handover.', badge: '', features: ['Everything in Design', 'Contractor coordination', 'Weekly site reports'], actionLabel: 'Talk to us', actionLink: { type: 'none', target: '' } }
      ],
      { titleField: 'name', max: 6 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    grid: { nodeId: 'grid', label: 'Grid', styleControls: ['columns', 'gap'] },
    plan: { nodeId: 'plan', label: 'Plan card', styleControls: ['background', 'border', 'radius', 'shadow'] },
    price: { nodeId: 'price', label: 'Price', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: { tone: toneAxis(['lead']) },
  build: (b) =>
    sectionShell(b, [
      headingBlock(b),
      b.el('grid', 'ul', { name: 'Grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg'), align: 'stretch' }, desktop: { columns: 3 } } }, [
        b.repeat('plan-items', 'plans', [
          b.el('plan', 'li', { name: 'Plan card', styles: { layout: 'stack', gap: tok('space.lg'), paddingBlock: tok('space.xl'), paddingInline: tok('space.xl'), background: tok('color.surface'), color: tok('color.text'), border: tok('border.default'), radius: tok('radius.lg') } }, [
            b.el('plan-head', 'div', { name: 'Plan header', styles: { layout: 'stack', gap: tok('space.xs') } }, [
              b.el('plan-title-row', 'div', { name: 'Title row', styles: { layout: 'row', justify: 'space-between', align: 'center', gap: tok('space.sm') } }, [
                b.text('plan-name', 'h3', { $item: 'name' }, { name: 'Name', styles: { textStyle: tok('text.h3') } }),
                b.text('badge', 'span', { $item: 'badge' }, { name: 'Badge', when: { $item: 'badge' }, styles: { fontSize: '0.75rem', fontWeight: '600', paddingBlock: '4px', paddingInline: '10px', radius: tok('radius.pill'), background: tok('color.brand'), color: tok('color.on-brand') } })
              ]),
              b.text('plan-text', 'p', { $item: 'description' }, { name: 'Description', when: { $item: 'description' }, styles: { ...mutedStyles, textStyle: tok('text.small') } })
            ]),
            b.el('price-row', 'p', { name: 'Price row', styles: { layout: 'row', align: 'baseline', gap: tok('space.xs'), wrap: true } }, [
              b.text('price', 'span', { $item: 'price' }, { name: 'Price', styles: { textStyle: tok('text.stat') } }),
              b.text('period', 'span', { $item: 'period' }, { name: 'Period', when: { $item: 'period' }, styles: { ...mutedStyles, textStyle: tok('text.small') } })
            ]),
            b.divider('plan-divider', { name: 'Divider' }),
            b.rich('features', { $item: 'features' }, { name: 'Features', styles: { textStyle: tok('text.small') } }),
            b.link('plan-action', { $item: 'actionLink' }, { $item: 'actionLabel' }, 'primary', { name: 'Action', when: { $item: 'actionLabel' }, styles: { marginBlockStart: 'auto', width: 'fill' } })
          ])
        ])
      ])
    ])
});

/** A plan card's price and its billing note for one period, shown while the billing switch chooses that period. */
function periodPrice(b: TreeBuilder, period: 'monthly' | 'annual') {
  return b.el(`${period}-price-row`, 'p', { name: period === 'monthly' ? 'Monthly price' : 'Annual price', when: eq(uiState('billing'), period), styles: { layout: 'row', align: 'baseline', gap: tok('space.xs'), wrap: true } }, [
    b.text(`${period}-price`, 'span', item(`${period}Price`), { name: 'Price', styles: { textStyle: tok('text.stat') } }),
    b.text(`${period}-note`, 'span', item(`${period}Note`), { name: 'Billing note', when: item(`${period}Note`), styles: { ...mutedStyles, textStyle: tok('text.small') } })
  ]);
}

export const pricingToggle = managed({
  componentId: 'pricing.toggle',
  name: 'Pricing with billing switch',
  description: 'Subscription plans with a Monthly and Annual switch that changes every plan’s price and billing note. There is no checkout.',
  category: 'conversion',
  tags: ['pricing', 'plans', 'subscription', 'monthly', 'annual', 'yearly', 'billing', 'toggle', 'switch', 'membership'],
  icon: 'toggle-right',
  properties: {
    ...P.group('Text', {
      eyebrow: P.str('Eyebrow', 'Memberships'),
      heading: P.str('Heading', 'Train on your schedule'),
      headingLevel: headingLevel('h2'),
      lead: P.text('Supporting text', 'Pay month to month, or pay for the year and get two months free.')
    }),
    ...P.group('Billing switch', {
      monthlyLabel: P.str('Monthly button', 'Monthly'),
      annualLabel: P.str('Annual button', 'Annual'),
      switchLabel: { ...P.str('Switch name', 'Billing period'), description: 'What screen readers call the pair of buttons.' }
    }),
    plans: P.list(
      'Plans',
      'Plan',
      {
        name: P.str('Name', 'Plan'),
        description: P.text('Description', ''),
        badge: P.str('Badge', ''),
        monthlyPrice: P.str('Monthly price', '$0'),
        monthlyNote: P.str('Monthly billing note', 'per month'),
        annualPrice: P.str('Annual price', '$0'),
        annualNote: P.str('Annual billing note', 'per year'),
        features: P.rich('Features', ['A feature'], { plainAs: 'check' }),
        actionLabel: P.str('Action label', 'Get started'),
        actionLink: P.link('Action link')
      },
      [
        { name: 'Off-peak', description: 'Weekday daytime access for flexible schedules.', badge: '', monthlyPrice: '$29', monthlyNote: 'per month', annualPrice: '$290', annualNote: 'per year, billed once', features: ['Gym floor 9am – 4pm', 'Two classes a week', 'Locker and towel'], actionLabel: 'Join off-peak', actionLink: { type: 'none', target: '' } },
        { name: 'Anytime', description: 'Every class and every hour we are open.', badge: 'Most popular', monthlyPrice: '$49', monthlyNote: 'per month', annualPrice: '$490', annualNote: 'per year, billed once', features: ['Open 5am – 11pm', 'Unlimited classes', 'One guest pass a month', 'Locker and towel'], actionLabel: 'Join anytime', actionLink: { type: 'none', target: '' } },
        { name: 'Coached', description: 'Anytime access with a coach in your corner.', badge: '', monthlyPrice: '$119', monthlyNote: 'per month', annualPrice: '$1,190', annualNote: 'per year, billed once', features: ['Everything in Anytime', 'Two personal sessions a month', 'A training plan reviewed monthly'], actionLabel: 'Meet a coach', actionLink: { type: 'none', target: '' } }
      ],
      { titleField: 'name', max: 6 }
    )
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    switch: { nodeId: 'switch', label: 'Billing switch', styleControls: ['gap', 'background', 'radius'] },
    grid: { nodeId: 'grid', label: 'Grid', styleControls: ['columns', 'gap'] },
    plan: { nodeId: 'plan', label: 'Plan card', styleControls: ['background', 'border', 'radius', 'shadow'] }
  },
  state: {
    billing: { type: 'enum', label: 'Billing period', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }], initial: 'monthly' }
  },
  variantAxes: { tone: toneAxis(['lead']) },
  build: (b) =>
    sectionShell(b, [
      b.el('top', 'div', { name: 'Heading and switch', styles: { layout: 'stack', gap: tok('space.xl'), align: 'start' } }, [
        headingBlock(b),
        // Two buttons that say which period is on, grouped and named for screen readers. Printed, the switch is left
        // out: each price says which period it is for.
        b.el('switch', 'div', { name: 'Billing switch', ariaLabel: prop('switchLabel'), styles: { layout: 'row', wrap: true, gap: tok('space.xs') } }, [
          b.link('monthly-button', NO_LINK, prop('monthlyLabel'), 'secondary', { name: 'Monthly button', stateAction: { state: 'billing', op: 'set', value: 'monthly' } }),
          b.link('annual-button', NO_LINK, prop('annualLabel'), 'secondary', { name: 'Annual button', stateAction: { state: 'billing', op: 'set', value: 'annual' } })
        ])
      ]),
      b.el('grid', 'ul', { name: 'Grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg'), align: 'stretch' }, desktop: { columns: 3 } } }, [
        b.repeat('plan-items', 'plans', [
          b.el('plan', 'li', { name: 'Plan card', styles: { layout: 'stack', gap: tok('space.lg'), paddingBlock: tok('space.xl'), paddingInline: tok('space.xl'), background: tok('color.surface'), color: tok('color.text'), border: tok('border.default'), radius: tok('radius.lg') } }, [
            b.el('plan-head', 'div', { name: 'Plan header', styles: { layout: 'stack', gap: tok('space.xs') } }, [
              b.el('plan-title-row', 'div', { name: 'Title row', styles: { layout: 'row', justify: 'space-between', align: 'center', gap: tok('space.sm') } }, [
                b.text('plan-name', 'h3', item('name'), { name: 'Name', styles: { textStyle: tok('text.h3') } }),
                b.text('badge', 'span', item('badge'), { name: 'Badge', when: item('badge'), styles: { fontSize: '0.75rem', fontWeight: '600', paddingBlock: '4px', paddingInline: '10px', radius: tok('radius.pill'), background: tok('color.brand'), color: tok('color.on-brand') } })
              ]),
              b.text('plan-text', 'p', item('description'), { name: 'Description', when: item('description'), styles: { ...mutedStyles, textStyle: tok('text.small') } })
            ]),
            periodPrice(b, 'monthly'),
            periodPrice(b, 'annual'),
            b.divider('plan-divider', { name: 'Divider' }),
            b.rich('features', item('features'), { name: 'Features', styles: { textStyle: tok('text.small') } }),
            b.link('plan-action', item('actionLink'), item('actionLabel'), 'primary', { name: 'Action', when: item('actionLabel'), styles: { marginBlockStart: 'auto', width: 'fill' } })
          ])
        ])
      ])
    ])
});

export const faq = managed({
  componentId: 'faq.list',
  name: 'FAQ',
  description: 'Frequently asked questions with accessible expandable answers.',
  category: 'conversion',
  tags: ['faq', 'questions', 'answers', 'accordion', 'help', 'support'],
  icon: 'circle-question-mark',
  properties: {
    eyebrow: P.str('Eyebrow', 'Questions'),
    heading: P.str('Heading', 'Frequently asked questions'),
    headingLevel: headingLevel('h2'),
    lead: P.text('Supporting text', 'Cannot find what you are looking for? Get in touch and we will be happy to help.'),
    items: P.list(
      'Questions',
      'Question',
      { question: P.str('Question', 'Question?'), answer: P.text('Answer', 'Answer.') },
      [
        { question: 'How long does a typical project take?', answer: 'Most design projects take six to ten weeks from the first meeting to final drawings. We agree a schedule with you at the start.' },
        { question: 'Do you work outside the local area?', answer: 'Yes. We regularly work across the region and can arrange remote consultations for early planning.' },
        { question: 'How are your fees calculated?', answer: 'We quote a fixed fee for each stage once we understand the scope, so you always know the cost before work begins.' },
        { question: 'Can you recommend builders?', answer: 'We work with a small group of trusted contractors and are happy to introduce them, or to work with your own builder.' }
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
    sectionShell(
      b,
      [
        headingBlock(b),
        b.el('list', 'div', { name: 'Questions', styles: { layout: 'stack', gap: '0', border: '0' } }, [
          b.repeat('questions', 'items', [
            b.el('item', 'details', { name: 'Question' }, [
              b.el('summary', 'summary', { name: 'Summary', styles: { layout: 'row', justify: 'space-between', align: 'center', gap: tok('space.lg'), paddingBlock: tok('space.lg'), border: '0' } }, [
                b.text('question', 'span', { $item: 'question' }, { name: 'Question text', styles: { textStyle: tok('text.h3'), fontWeight: '550' } }),
                b.icon('toggle-icon', 'plus', { name: 'Toggle icon', styles: { color: tok('color.brand'), fontSize: '1.3rem' } })
              ]),
              b.text('answer', 'p', { $item: 'answer' }, { name: 'Answer', styles: { ...mutedStyles, paddingBlock: '0', marginBlockEnd: tok('space.lg'), maxWidth: '68ch' } })
            ]),
            b.divider('item-divider', { name: 'Divider' })
          ])
        ])
      ],
      { width: 'reading' }
    )
});
// The toggle icon switches to the accent colour on the dark tone for contrast.
faq.variantAxes!.tone.options.inverse.styles!['toggle-icon'] = { base: { color: tok('color.accent') } };

export const cta = managed({
  componentId: 'cta.banner',
  name: 'Call to action',
  description: 'A prominent banner with a heading, short copy and one or two actions.',
  category: 'conversion',
  tags: ['cta', 'call to action', 'banner', 'contact', 'sign up', 'book', 'conversion'],
  icon: 'megaphone',
  properties: {
    ...P.group('Text', {
      heading: P.str('Heading', 'Ready to start your project?'),
      headingLevel: headingLevel('h2'),
      lead: P.text('Supporting text', 'Tell us a little about what you have in mind and we will be in touch within two working days.')
    }),
    ...P.group('Actions', {
      primaryLabel: P.str('Primary button label', 'Get in touch'),
      primaryLink: P.link('Primary button link'),
      secondaryLabel: P.str('Secondary button label', ''),
      secondaryLink: P.link('Secondary button link')
    })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    panel: { nodeId: 'panel', label: 'Panel', styleControls: ['background', 'color', 'radius', 'paddingBlock', 'paddingInline'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    lead: { nodeId: 'lead', label: 'Supporting text', styleControls: ['textStyle', 'color'] }
  },
  variantAxes: {
    tone: {
      label: 'Tone',
      default: 'default',
      options: {
        default: { label: 'Brand panel' },
        muted: { label: 'Soft panel', styles: { panel: { base: { background: tok('color.surface-alt'), color: tok('color.text') } }, lead: { base: { color: tok('color.muted'), opacity: 1 } }, primary: { base: { background: tok('color.brand'), color: tok('color.on-brand') } } } },
        inverse: { label: 'Dark panel', styles: { panel: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } } } }
      }
    }
  },
  build: (b) =>
    sectionShell(b, [
      b.el('panel', 'div', { name: 'Panel', styles: { base: { layout: 'stack', align: 'center', textAlign: 'center', gap: tok('space.lg'), paddingBlock: 'clamp(3rem, 2rem + 4vw, 5.5rem)', paddingInline: tok('space.xl'), background: tok('color.brand'), color: tok('color.on-brand'), radius: tok('radius.lg') } } }, [
        b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h2'), maxWidth: '760px' } }),
        b.text('lead', 'p', { $prop: 'lead' }, { name: 'Supporting text', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), maxWidth: '620px', opacity: 0.85 } }),
        b.el('actions', 'div', { name: 'Actions', collapseEmpty: true, styles: { layout: 'row', wrap: true, justify: 'center', gap: tok('space.sm'), marginBlockStart: tok('space.xs') } }, [
          b.link('primary', { $prop: 'primaryLink' }, { $prop: 'primaryLabel' }, 'light', { name: 'Primary button', when: { $prop: 'primaryLabel' } }),
          b.link('secondary', { $prop: 'secondaryLink' }, { $prop: 'secondaryLabel' }, 'secondary', { name: 'Secondary button', when: { $prop: 'secondaryLabel' } })
        ])
      ])
    ])
});

export const contact = managed({
  componentId: 'contact.details',
  name: 'Contact details',
  description: 'Email, telephone, address and opening hours with an optional action. There is no form.',
  category: 'conversion',
  tags: ['contact', 'email', 'phone', 'address', 'location', 'hours', 'get in touch'],
  icon: 'contact',
  properties: {
    ...P.group('Text', {
      eyebrow: P.str('Eyebrow', 'Contact'),
      heading: P.str('Heading', 'Let’s talk about your project'),
      headingLevel: headingLevel('h2'),
      lead: P.text('Supporting text', 'The quickest way to reach us is by email or phone. We reply to every enquiry within two working days.')
    }),
    items: P.list(
      'Contact methods',
      'Contact method',
      { icon: P.icon('Icon', 'mail'), label: P.str('Label', 'Email'), value: P.str('Value', SAMPLE_CONTACT.email), link: P.link('Link') },
      [
        { icon: 'mail', label: 'Email', value: SAMPLE_CONTACT.email, link: { type: 'email', target: SAMPLE_CONTACT.email } },
        { icon: 'phone', label: 'Phone', value: SAMPLE_CONTACT.phone, link: { type: 'tel', target: SAMPLE_CONTACT.phoneDial } },
        { icon: 'map-pin', label: 'Studio', value: SAMPLE_CONTACT.address, link: { type: 'none', target: '' } },
        { icon: 'clock', label: 'Hours', value: 'Monday to Friday, 9am – 5pm', link: { type: 'none', target: '' } }
      ],
      { titleField: 'label', max: 8 }
    ),
    ...P.group('Action', {
      actionLabel: P.str('Action label', 'Email us'),
      actionLink: P.link('Action link', { type: 'email', target: SAMPLE_CONTACT.email })
    })
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    list: { nodeId: 'list', label: 'Contact list', styleControls: ['gap', 'columns'] },
    method: { nodeId: 'method', label: 'Contact method', styleControls: ['background', 'border', 'radius'] }
  },
  variantAxes: { tone: toneAxis(['lead']) },
  build: (b) =>
    sectionShell(b, [
      b.el('grid', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.2xl') }, desktop: { columns: 2, gap: tok('space.3xl') } } }, [
        b.el('content', 'div', { name: 'Content', collapseEmpty: true, styles: { layout: 'stack', gap: tok('space.lg'), align: 'start' } }, [
          headingBlock(b),
          b.link('action', { $prop: 'actionLink' }, { $prop: 'actionLabel' }, 'primary', { name: 'Action', when: { $prop: 'actionLabel' } })
        ]),
        b.el('list', 'ul', { name: 'Contact list', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.md') }, tablet: { columns: 2 } } }, [
          b.repeat('methods', 'items', [
            b.el('method', 'li', { name: 'Contact method', styles: { layout: 'row', align: 'start', gap: tok('space.md'), paddingBlock: tok('space.lg'), paddingInline: tok('space.lg'), background: tok('color.surface'), color: tok('color.text'), border: tok('border.default'), radius: tok('radius.md') } }, [
              b.el('method-icon-wrap', 'div', { name: 'Icon badge', styles: { layout: 'row', align: 'center', justify: 'center', width: '40px', minHeight: '40px', radius: tok('radius.pill'), background: 'color-mix(in srgb, var(--so-color-brand) 10%, transparent)', color: tok('color.brand') } }, [
                b.icon('method-icon', { $item: 'icon' }, { name: 'Icon' })
              ]),
              b.el('method-text', 'div', { name: 'Text', styles: { layout: 'stack', gap: '2px' } }, [
                b.text('method-label', 'span', { $item: 'label' }, { name: 'Label', styles: { textStyle: tok('text.small'), ...mutedStyles } }),
                b.link('method-value', { $item: 'link' }, { $item: 'value' }, 'plain', { name: 'Value', styles: { fontWeight: '550', color: tok('color.text') } })
              ])
            ])
          ])
        ])
      ])
    ])
});
