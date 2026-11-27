/**
 * Managed designs for the tests of how the editor addresses an element of a placement: the slices of the Services grid
 * and the Call to action Foundation used to ship as trees (a heading group above a grid of cards, and a banner with a
 * heading), added to a project as its own designs and placed on Home. Foundation now ships Svelte code components,
 * whose markup the editor does not address element by element.
 */
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { P, item, prop, tok } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { projectDesign } from './packs';

/** Services grid: an eyebrow and heading in a group, then a card per item with an icon, a title and a description. */
export const servicesGrid = (s: ProjectState): ComponentDefinition =>
  projectDesign(s, {
    componentId: 'project.features',
    name: 'Services grid',
    properties: {
      eyebrow: P.str('Eyebrow', 'What we do'),
      heading: P.str('Heading', 'Services shaped around your project'),
      items: P.list(
        'Cards',
        'Card',
        { icon: P.icon('Icon', 'sparkles'), title: P.str('Title', 'Service'), description: P.text('Description', 'Describe what this service includes.') },
        [
          { icon: 'compass', title: 'Planning', description: 'Clear priorities and a realistic budget.' },
          { icon: 'pen-tool', title: 'Design', description: 'Considered layouts, materials and details.' },
          { icon: 'hammer', title: 'Delivery', description: 'Trusted specialists, kept informed.' }
        ],
        { titleField: 'title' }
      )
    },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'color'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.el('inner', 'div', { name: 'Container' }, [
          b.el('intro', 'div', { name: 'Heading group' }, [
            b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow') }),
            b.text('heading', 'h2', prop('heading'), { name: 'Heading', when: prop('heading') })
          ]),
          b.el('grid', 'ul', { name: 'Card grid' }, [
            b.repeat('cards', 'items', [
              b.el('card', 'li', { name: 'Card', styles: { background: tok('color.surface') } }, [
                b.icon('card-icon', item('icon'), { name: 'Icon' }),
                b.text('card-title', 'h3', item('title'), { name: 'Title' }),
                b.text('card-text', 'p', item('description'), { name: 'Description' })
              ])
            ])
          ])
        ])
      ])
  });

/** Call to action: a heading and supporting text on a band. */
export const ctaBanner = (s: ProjectState): ComponentDefinition =>
  projectDesign(s, {
    componentId: 'project.banner',
    name: 'Call to action',
    properties: { heading: P.str('Heading', 'Let’s make your space work better'), lead: P.text('Supporting text', 'Tell us about your project.') },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] }, heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.el('panel', 'div', { name: 'Panel' }, [b.text('heading', 'h2', prop('heading'), { name: 'Heading' }), b.text('lead', 'p', prop('lead'), { name: 'Supporting text' })])
      ])
  });

/** Place a design at the end of Home. */
export function placeOnHome(s: ProjectState, def: ComponentDefinition, props: Record<string, unknown> = {}): InstanceNode {
  const node = makeInstance(def, props);
  const home = s.pages[s.site.homePageId];
  home.nodes[node.id] = node;
  home.rootIds.push(node.id);
  return node;
}
