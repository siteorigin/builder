/**
 * Managed designs for the generator tests: what the generator writes for a design built in the editor (its escaping,
 * part overrides, hidden parts, variant styles on a button, first-screen images, conditions and anchors). Foundation's
 * sections are code components now, whose markup is their own, so these are the slices of its old managed designs
 * those tests read.
 */
import { P, prop, tok } from '@catalogue/dsl';
import type { DesignSpec } from './packs';

/** root (section) > content > (heading, lead, actions > primary, secondary), media-wrap > media: a split hero. */
export const HERO_SPLIT: DesignSpec = {
  componentId: 'project.hero-split',
  name: 'Split hero',
  category: 'hero',
  properties: {
    heading: P.str('Heading', 'Calm, considered spaces for everyday life'),
    lead: P.text('Supporting text', 'Homes and small workplaces that feel good to live and work in.'),
    primaryLabel: P.str('Primary button label', 'Start a project'),
    primaryLink: P.link('Primary button link', { type: 'url', target: 'https://example.com/start' }),
    secondaryLabel: P.str('Secondary button label', 'About the studio'),
    secondaryLink: P.link('Secondary button link', { type: 'url', target: 'https://example.com/about' }),
    image: P.image('Image', 'A bright living room')
  },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
    heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
    media: { nodeId: 'media', label: 'Image', styleControls: ['aspectRatio', 'radius'] }
  },
  variantAxes: {
    tone: {
      label: 'Tone',
      default: 'default',
      options: {
        default: { label: 'Default' },
        // A brand panel: the primary button turns light on it.
        brand: { label: 'Brand', styles: { root: { base: { background: tok('color.brand'), color: tok('color.on-brand') } }, primary: { base: { background: tok('color.on-brand'), color: tok('color.brand-strong') } } } }
      }
    }
  },
  build: (b) =>
    b.el('root', 'section', { name: 'Section', styles: { layout: 'grid', columns: 2, gap: tok('space.2xl'), paddingBlock: tok('space.section') } }, [
      b.el('content', 'div', { name: 'Content', styles: { layout: 'stack', gap: tok('space.lg') } }, [
        b.text('heading', 'h1', prop('heading'), { name: 'Heading', when: prop('heading'), styles: { textStyle: tok('text.h1') } }),
        b.text('lead', 'p', prop('lead'), { name: 'Supporting text', when: prop('lead') }),
        b.el('actions', 'div', { name: 'Actions', collapseEmpty: true, styles: { layout: 'row', gap: tok('space.sm') } }, [
          b.link('primary', prop('primaryLink'), prop('primaryLabel'), 'primary', { name: 'Primary button', when: prop('primaryLabel') }),
          b.link('secondary', prop('secondaryLink'), prop('secondaryLabel'), 'text', { name: 'Secondary button', when: prop('secondaryLabel') })
        ])
      ]),
      b.el('media-wrap', 'figure', { name: 'Media' }, [b.image('media', prop('image'), { name: 'Image', styles: { aspectRatio: '4/3', objectFit: 'cover' } })])
    ])
};

/** root (footer) > brand > (brand-name, tagline): a footer whose Site name part is the brand's name. */
export const FOOTER: DesignSpec = {
  componentId: 'test.footer',
  name: 'Footer',
  category: 'shell',
  properties: { siteName: P.str('Site name', 'Test Studio'), tagline: P.text('Tagline', 'Thoughtful design for homes and small workplaces.') },
  parts: {
    root: { nodeId: 'root', label: 'Footer', styleControls: ['paddingBlock', 'background', 'color'] },
    brand: { nodeId: 'brand-name', label: 'Site name', styleControls: ['textStyle', 'color'] }
  },
  build: (b) =>
    b.el('root', 'footer', { name: 'Footer', styles: { paddingBlock: tok('space.2xl') } }, [
      b.el('brand', 'div', { name: 'Brand', styles: { layout: 'stack', gap: tok('space.sm') } }, [
        b.text('brand-name', 'p', prop('siteName'), { name: 'Site name', styles: { fontSize: '1.5rem' } }),
        b.text('tagline', 'p', prop('tagline'), { name: 'Tagline', when: prop('tagline'), styles: { textStyle: tok('text.small') } })
      ])
    ])
};

/** root > panel > (heading, actions (hides when empty) > primary, secondary): a banner with one or two buttons. */
export const BANNER: DesignSpec = {
  componentId: 'project.cta-banner',
  name: 'Call to action',
  category: 'conversion',
  properties: {
    heading: P.str('Heading', 'Ready to start your project?'),
    primaryLabel: P.str('Primary button label', 'Get in touch'),
    primaryLink: P.link('Primary button link'),
    secondaryLabel: P.str('Secondary button label', ''),
    secondaryLink: P.link('Secondary button link')
  },
  parts: { root: { nodeId: 'root', label: 'Section' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.el('panel', 'div', { name: 'Panel', styles: { layout: 'stack' } }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.el('actions', 'div', { name: 'Actions', collapseEmpty: true, styles: { layout: 'row' } }, [
          b.link('primary', prop('primaryLink'), prop('primaryLabel'), 'light', { name: 'Primary button', when: prop('primaryLabel') }),
          b.link('secondary', prop('secondaryLink'), prop('secondaryLabel'), 'secondary', { name: 'Secondary button', when: prop('secondaryLabel') })
        ])
      ])
    ])
};

/** root > content (anchored) > (intro (hides when empty) > eyebrow, heading, lead; action): nested collapsing wrappers. */
export const DETAILS: DesignSpec = {
  componentId: 'project.contact-details',
  name: 'Contact details',
  category: 'conversion',
  properties: {
    eyebrow: P.str('Eyebrow', 'Contact'),
    heading: P.str('Heading', 'Let’s talk about your project'),
    lead: P.text('Supporting text', 'We reply to every inquiry within two working days.'),
    actionLabel: P.str('Action label', 'Email us'),
    actionLink: P.link('Action link', { type: 'email', target: 'hello@example.com' })
  },
  parts: { root: { nodeId: 'root', label: 'Section' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.el('content', 'div', { name: 'Content', collapseEmpty: true, styles: { layout: 'stack' } }, [
        b.el('intro', 'div', { name: 'Heading group', collapseEmpty: true, styles: { layout: 'stack' } }, [
          b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow') }),
          b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
          b.text('lead', 'p', prop('lead'), { name: 'Lead', when: prop('lead') })
        ]),
        b.link('action', prop('actionLink'), prop('actionLabel'), 'primary', { name: 'Action', when: prop('actionLabel') })
      ])
    ])
};

/** root (section) > (eyebrow, heading): a page introduction, its heading a Heading 1. */
export const INTRO: DesignSpec = {
  componentId: 'project.intro',
  name: 'Page introduction',
  category: 'hero',
  properties: { eyebrow: P.str('Eyebrow', 'About us'), heading: P.str('Heading', 'A small team with a long view') },
  parts: { root: { nodeId: 'root', label: 'Section' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow') }),
      b.text('heading', 'h1', prop('heading'), { name: 'Heading', when: prop('heading') })
    ])
};

/** root (section) > (heading, questions > item > (question, answer)): a list of questions. */
export const FAQ: DesignSpec = {
  componentId: 'project.faq',
  name: 'FAQ',
  properties: {
    heading: P.str('Heading', 'Frequently asked questions'),
    items: P.list('Questions', 'Question', { question: P.str('Question', 'Question?'), answer: P.text('Answer', 'Answer.') }, [{ question: 'How long does a project take?', answer: 'Most take six to ten weeks.' }], { titleField: 'question' })
  },
  parts: { root: { nodeId: 'root', label: 'Section' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
      b.repeat('questions', 'items', [b.el('item', 'div', { name: 'Question' }, [b.text('question', 'h3', { $item: 'question' }, { name: 'Question text' }), b.text('answer', 'p', { $item: 'answer' }, { name: 'Answer' })])])
    ])
};

/** root (section) > heading (a paragraph): a logo strip, whose Heading property names it though no heading shows. */
export const LOGOS: DesignSpec = {
  componentId: 'project.logos',
  name: 'Logo strip',
  properties: { heading: P.str('Heading', 'Trusted by') },
  parts: { root: { nodeId: 'root', label: 'Section' } },
  build: (b) => b.el('root', 'section', { name: 'Section' }, [b.text('heading', 'p', prop('heading'), { name: 'Heading', when: prop('heading') })])
};
