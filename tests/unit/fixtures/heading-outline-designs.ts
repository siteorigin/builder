/**
 * Managed designs for the heading outline's tests (heading-outline.test.ts): the slices of the page introduction,
 * centered hero, text section and footer Foundation used to ship as trees, whose headings the outline reads node by
 * node. Foundation now ships Svelte code components, whose headings Builder does not read (see the Release gap tests).
 * page-navigation.test.ts reads the same introduction and hero.
 */
import { P, prop, type ComponentSpec } from '@catalogue/dsl';
import type { DesignSpec } from './packs';

/** The heading levels a placement may choose, Heading 1 by default. */
const headingLevel = (def = 'h1') => P.choice('Heading level', def, [['h1', 'Heading 1 (page title)'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'], ['h5', 'Heading 5'], ['h6', 'Heading 6']]);

/** A centered hero: its heading's level is the placement's choice, and its two buttons show while they have labels. */
export const centeredHero = (componentId = 'test.hero-centered'): ComponentSpec => ({
  componentId,
  name: 'Centered hero',
  description: '',
  category: 'hero',
  tags: [],
  icon: 'sparkles',
  properties: {
    heading: P.str('Heading', 'Thoughtful work for people who care about the details'),
    headingLevel: headingLevel(),
    primaryLabel: P.str('Primary button label', 'Start a project'),
    primaryLink: P.link('Primary button link'),
    secondaryLabel: P.str('Secondary button label', 'See our work'),
    secondaryLink: P.link('Secondary button link')
  },
  parts: { root: { nodeId: 'root', label: 'Section' }, heading: { nodeId: 'heading', label: 'Heading' } },
  build: (b) =>
    b.el('root', 'section', {}, [
      b.text('heading', prop('headingLevel'), prop('heading'), { name: 'Heading', when: prop('heading') }),
      b.el('actions', 'div', { name: 'Buttons' }, [
        b.link('primary', prop('primaryLink'), prop('primaryLabel'), 'primary', { name: 'Primary button', when: prop('primaryLabel') }),
        b.link('secondary', prop('secondaryLink'), prop('secondaryLabel'), 'secondary', { name: 'Secondary button', when: prop('secondaryLabel') })
      ])
    ])
});

/** A page introduction: an eyebrow, a heading whose level the placement chooses, and a description. */
export const pageIntro = (componentId = 'test.intro'): ComponentSpec => ({
  componentId,
  name: 'Page introduction',
  description: '',
  category: 'hero',
  tags: [],
  icon: 'heading',
  properties: { eyebrow: P.str('Eyebrow', 'About us'), heading: P.str('Heading', 'A small team with a long view'), headingLevel: headingLevel(), lead: P.text('Description', '') },
  parts: { root: { nodeId: 'root', label: 'Section' }, heading: { nodeId: 'heading', label: 'Heading' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow') }),
      b.text('heading', prop('headingLevel'), prop('heading'), { name: 'Heading', when: prop('heading') }),
      b.text('lead', 'p', prop('lead'), { name: 'Description', when: prop('lead') })
    ])
});
export const INTRO: DesignSpec = pageIntro();

/** A text section: a heading whose level the placement chooses, over rich text whose subheadings are its own. */
export const TEXT: DesignSpec = {
  componentId: 'test.text',
  name: 'Text',
  properties: { heading: P.str('Heading', 'How we work'), headingLevel: headingLevel('h2'), body: P.rich('Text', ['We keep our team small.']) },
  parts: { root: { nodeId: 'root', label: 'Section' }, heading: { nodeId: 'heading', label: 'Heading' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('heading', prop('headingLevel'), prop('heading'), { name: 'Heading', when: prop('heading') }),
      b.rich('body', prop('body'), { name: 'Text' })
    ])
};

/** A footer with a heading over its column. */
export const FOOTER: DesignSpec = {
  componentId: 'test.footer',
  name: 'Footer',
  category: 'shell',
  properties: { heading: P.str('Column heading', 'Visit the studio'), note: P.text('Note', 'Open Tuesday to Saturday.') },
  parts: { root: { nodeId: 'root', label: 'Footer' } },
  build: (b) => b.el('root', 'footer', { name: 'Footer' }, [b.text('heading', 'h2', prop('heading'), { name: 'Column heading' }), b.text('note', 'p', prop('note'), { name: 'Note' })])
};
