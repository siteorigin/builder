/**
 * The managed design the style tests lay their rules on: Foundation's sections are code, whose placement styles are
 * written important, so how a design's own styles, its variant options and a placement's overrides layer is shown on
 * a card grid of the project's own, shaped like the services grid Foundation once authored as a tree.
 */
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { P, item, prop, tok } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { projectDesign } from './packs';

/** The grid's class prefix, from its definition ID. */
export const GRID_CLASS = 'so-foundation-styles-grid';

/**
 * Add the card grid to the project and place it at the end of Home: a heading, a grid of cards (three columns on a
 * desktop, two on a tablet, one on a phone) and a button, with a Layout axis whose two-columns option sets nothing yet.
 */
export function placeGrid(s: ProjectState): { def: ComponentDefinition; inst: InstanceNode } {
  const def = projectDesign(s, {
    componentId: 'styles.grid',
    name: 'Card grid',
    properties: {
      heading: P.str('Heading', 'Services'),
      linkLabel: P.str('Button label', 'Get in touch'),
      link: P.link('Button link', { type: 'url', target: 'https://example.com' }),
      items: P.list('Cards', 'Card', { title: P.str('Title', 'Service') }, [{ title: 'Planning' }, { title: 'Design' }, { title: 'Delivery' }])
    },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border'] }
    },
    variantAxes: { layout: { label: 'Layout', default: 'default', options: { default: { label: 'Three columns' }, 'two-columns': { label: 'Two columns' } } } },
    build: (b) =>
      b.el('root', 'section', { styles: { paddingBlock: tok('space.3xl') } }, [
        b.text('heading', 'h2', prop('heading'), { styles: { textStyle: tok('text.h2') } }),
        b.el('grid', 'ul', { styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
          b.repeat('cards', 'items', [b.el('card', 'li', {}, [b.text('card-title', 'h3', item('title'))])])
        ]),
        b.link('action', prop('link'), prop('linkLabel'), 'primary')
      ])
  });
  const inst = makeInstance(def);
  const home = s.pages[s.site.homePageId];
  home.nodes[inst.id] = inst;
  home.rootIds.push(inst.id);
  return { def, inst };
}
