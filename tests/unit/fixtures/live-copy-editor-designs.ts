/**
 * The managed designs a copy editor's tests edit: the slice of the old managed Foundation split hero the copy editor
 * reads, and a section that shows what is put in it once. Foundation's own Section is code, whose slot the copy editor
 * cannot read (the Release gap tests in live-copy-editor.test.ts and live-host-controller.test.ts).
 */
import type { ProjectState } from '@shared/types';
import { P } from '@catalogue/dsl';
import { projectDesign } from './packs';

/**
 * A split hero as a managed design of the project's own, the slice of the old managed Foundation hero the copy editor
 * reads: its eyebrow, heading, lead and picture marked as copy, its heading level, button and tone left to the host.
 */
export const heroDesign = (state: ProjectState) =>
  projectDesign(state, {
    componentId: 'test.split-hero',
    name: 'Split hero',
    properties: {
      eyebrow: P.copy(P.str('Eyebrow', 'Independent studio')),
      heading: P.copy(P.str('Heading', 'Thoughtful work')),
      headingLevel: P.choice('Heading level', 'h1', [['h1', 'Heading 1'], ['h2', 'Heading 2']]),
      lead: P.copy(P.text('Supporting text', 'We help small teams.')),
      primaryLabel: P.str('Primary button label', 'Start a project'),
      primaryLink: P.link('Primary button link'),
      image: P.copy(P.image('Image', 'A calm studio'))
    },
    parts: {},
    variantAxes: { tone: { label: 'Tone', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background', styles: { root: { base: { background: '#f4f1ea' } } } } } } },
    build: (b) =>
      b.el('root', 'section', {}, [
        b.el('content', 'div', {}, [
          b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { when: { $prop: 'eyebrow' } }),
          b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { when: { $prop: 'heading' } }),
          b.text('lead', 'p', { $prop: 'lead' }, { when: { $prop: 'lead' } }),
          b.link('primary', { $prop: 'primaryLink' }, { $prop: 'primaryLabel' }, 'primary', { when: { $prop: 'primaryLabel' } })
        ]),
        b.el('media-wrap', 'figure', {}, [b.image('media', { $prop: 'image' })])
      ])
  });
export const HERO = 'foundation.test.split-hero';

/**
 * A section that shows what is put in it once, as a managed design of the project's own.
 */
export const sectionDesign = (state: ProjectState) =>
  projectDesign(state, { componentId: 'test.section', name: 'Section', properties: {}, parts: {}, slots: { content: { label: 'Content' } }, build: (b) => b.el('root', 'section', {}, [b.slot('slot', 'content')]) });
export const SECTION = 'foundation.test.section';
