/**
 * The Section the canvas's Add-button tests place, as a managed design of the theme's, installed in the project: a
 * section around a Container that holds its one Content slot, shown once. Foundation's own Section is code now, and
 * the canvas offers no Add button in a code component's slot (its code decides how often the slot shows), so these
 * tests of how the buttons read a design's slots place this one instead.
 *
 * Theme-owned, it is not one of the project's own components the Add lists offer.
 */
import type { ProjectState } from '@shared/types';
import { tok } from '@catalogue/dsl';
import { foundationDesign } from './packs';

/** Install the Section in `state` and return its definition ID. */
export function installSection(state: ProjectState): string {
  const def = foundationDesign({
    componentId: 'test.section',
    name: 'Section',
    category: 'layout',
    properties: {},
    slots: { content: { label: 'Content', description: 'Headings, text, images, buttons and components placed inside the section.' } },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'layout', 'columns', 'gap'] }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section', styles: { paddingBlock: tok('space.section'), background: tok('color.background') } }, [
        b.el('inner', 'div', { name: 'Container', styles: { layout: 'stack', gap: tok('space.lg'), maxWidth: tok('container.content') } }, [b.slot('content-slot', 'content', { name: 'Content' })])
      ])
  });
  state.components[def.id] = def;
  return def.id;
}
