/**
 * Managed designs for the tests of buttons without a destination: the slices of the sections Foundation used to ship
 * as trees that those tests traverse (a pricing card's action, a hero's two buttons, a banner's call to action and an
 * empty section's slot), added to a project as its own designs. Foundation now ships Svelte code components, whose
 * buttons the editor cannot walk node by node.
 */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { P, item, prop } from '@catalogue/dsl';
import { projectDesign } from './packs';

const none = { type: 'none' as const, target: '' };

/** Pricing: a card per plan, its action button shown while it has a label, every plan without a destination. */
export const pricingDesign = (s: ProjectState): ComponentDefinition =>
  projectDesign(s, {
    componentId: 'project.pricing',
    name: 'Pricing',
    properties: {
      heading: P.str('Heading', 'Clear packages, no surprises'),
      plans: P.list(
        'Plans',
        'Plan',
        { name: P.str('Name', 'Plan'), price: P.str('Price', '$0'), actionLabel: P.str('Action label', 'Get started'), actionLink: P.link('Action link') },
        [
          { id: 'item-1', name: 'Consultation', price: '$350', actionLabel: 'Book a session', actionLink: none },
          { id: 'item-2', name: 'Design', price: '$4,800', actionLabel: 'Start a project', actionLink: none },
          { id: 'item-3', name: 'Full service', price: 'By quote', actionLabel: 'Talk to us', actionLink: none }
        ],
        { titleField: 'name' }
      )
    },
    parts: { root: { nodeId: 'root', label: 'Section' }, plan: { nodeId: 'plan', label: 'Card' } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading' }),
        b.el('grid', 'ul', { name: 'Grid' }, [
          b.repeat('plan-items', 'plans', [
            b.el('plan', 'li', { name: 'Card' }, [
              b.text('plan-name', 'h3', item('name'), { name: 'Name' }),
              b.text('plan-price', 'p', item('price'), { name: 'Price' }),
              b.link('plan-action', item('actionLink'), item('actionLabel'), 'primary', { name: 'Action', when: item('actionLabel') })
            ])
          ])
        ])
      ])
  });

/** Split hero: a heading and two buttons side by side, each shown while it has a label. */
export const heroDesign = (s: ProjectState): ComponentDefinition =>
  projectDesign(s, {
    componentId: 'project.hero-split',
    name: 'Split hero',
    properties: {
      heading: P.str('Heading', 'Thoughtful work'),
      primaryLabel: P.str('Primary label', 'Start a project'),
      primaryLink: P.link('Primary link'),
      secondaryLabel: P.str('Secondary label', 'About the studio'),
      secondaryLink: P.link('Secondary link')
    },
    parts: { root: { nodeId: 'root', label: 'Section' } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h1', prop('heading'), { name: 'Heading' }),
        b.el('actions', 'div', { name: 'Buttons' }, [
          b.link('primary', prop('primaryLink'), prop('primaryLabel'), 'primary', { name: 'Primary button', when: prop('primaryLabel') }),
          b.link('secondary', prop('secondaryLink'), prop('secondaryLabel'), 'secondary', { name: 'Secondary button', when: prop('secondaryLabel') })
        ])
      ])
  });

/** Call to action banner: a heading and one button, shown while it has a label. */
export const bannerDesign = (s: ProjectState): ComponentDefinition =>
  projectDesign(s, {
    componentId: 'project.banner',
    name: 'Call to action',
    properties: { heading: P.str('Heading', 'Let’s make your space work better'), primaryLabel: P.str('Primary label', 'Get in touch'), primaryLink: P.link('Primary link') },
    parts: { root: { nodeId: 'root', label: 'Section' } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading' }),
        b.link('primary', prop('primaryLink'), prop('primaryLabel'), 'primary', { name: 'Primary button', when: prop('primaryLabel') })
      ])
  });

/** An empty section: a content slot inside its container. */
export const sectionDesign = (s: ProjectState): ComponentDefinition =>
  projectDesign(s, {
    componentId: 'project.section',
    name: 'Section',
    properties: {},
    slots: { content: { label: 'Content' } },
    parts: { root: { nodeId: 'root', label: 'Section' }, container: { nodeId: 'inner', label: 'Container' } },
    build: (b) => b.el('root', 'section', { name: 'Section' }, [b.el('inner', 'div', { name: 'Container' }, [b.slot('content-slot', 'content', { name: 'Content' })])])
  });
