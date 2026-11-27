/**
 * Managed sections for the entrance tests: a hero and a banner of the project's own. Foundation's sections are code
 * components now, which take no entrance of the editor's (their markup is their own), so the tests of what an
 * entrance does to a placement and its design place these beside the starter's sections.
 */
import { P, prop, tok } from '@catalogue/dsl';
import type { DesignSpec } from './packs';

export const HERO: DesignSpec = {
  componentId: 'project.hero',
  name: 'Hero',
  category: 'hero',
  properties: { heading: P.str('Heading', 'Designed for living in'), lead: P.text('Supporting text', 'A calm studio for homes and workplaces.') },
  parts: { root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section', styles: { layout: 'stack', gap: tok('space.lg'), paddingBlock: tok('space.section') } }, [
      b.text('heading', 'h1', prop('heading'), { name: 'Heading', when: prop('heading'), styles: { textStyle: tok('text.h1') } }),
      b.text('lead', 'p', prop('lead'), { name: 'Supporting text', when: prop('lead') })
    ])
};

export const BANNER: DesignSpec = {
  componentId: 'project.banner',
  name: 'Banner',
  category: 'conversion',
  properties: { heading: P.str('Heading', 'Ready to start your project?'), label: P.str('Button label', 'Get in touch'), link: P.link('Button link') },
  parts: { root: { nodeId: 'root', label: 'Section' } },
  build: (b) =>
    b.el('root', 'section', { name: 'Section', styles: { paddingBlock: tok('space.section') } }, [
      b.el('panel', 'div', { name: 'Panel', styles: { layout: 'stack', background: tok('color.brand'), color: tok('color.on-brand') } }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.link('action', prop('link'), prop('label'), 'light', { name: 'Button', when: prop('label') })
      ])
    ])
};
