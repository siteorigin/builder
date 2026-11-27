/**
 * A managed Section, for the tests of what the editor does with the parts of a placed section's design: a full-bleed
 * root around a centred Container that shows the one Content slot. Foundation's Section is a code component now, with
 * no parts to pick inside it, so this is the slice of its old managed design those tests walk: the two parts, the
 * content width the Container keeps, and the slot.
 */
import { tok } from '@catalogue/dsl';
import type { DesignSpec } from './packs';

export const SECTION: DesignSpec = {
  componentId: 'project.section',
  name: 'Section',
  category: 'layout',
  properties: {},
  slots: { content: { label: 'Content', description: 'Headings, text, images, buttons and components placed inside the section.' } },
  parts: {
    root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'paddingInline', 'background', 'color', 'minHeight'] },
    container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'layout', 'columns', 'gridTemplate', 'gap', 'align', 'justify', 'textAlign'] }
  },
  build: (b) =>
    b.el('root', 'section', { name: 'Section', styles: { paddingBlock: tok('space.section'), paddingInline: tok('container.gutter'), background: tok('color.background'), color: tok('color.text') } }, [
      b.el('inner', 'div', { name: 'Container', styles: { layout: 'stack', gap: tok('space.lg'), width: 'fill', maxWidth: tok('container.content'), marginInline: 'auto' } }, [
        b.slot('content-slot', 'content', { name: 'Content' })
      ])
    ])
};
