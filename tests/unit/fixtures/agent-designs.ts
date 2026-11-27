/**
 * Managed designs for the assistant's tests of what it may do with a design built in the editor: its parts, slots,
 * repeats, variants, contract and conversion to code.
 *
 * Foundation ships as Svelte code components, so these are written as Foundation's own managed designs of a few of its
 * sections (`foundation.<componentId>`, theme-owned), each with the release's properties and only the part of the old
 * editor-built tree the tests reach. `managedFoundation` puts them in a project in place of the release's code, so a
 * placement the starter made, an insert by component ID and Edit everywhere all find the managed design.
 */
import type { ComponentDefinition, ProjectState, ResponsiveStyles, VariantAxis } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { tok, type TreeBuilder } from '@catalogue/dsl';
import { foundationDesign, type DesignSpec } from './packs';

const release = (componentId: string) => structuredClone(getTheme('foundation').components.find((c) => c.componentId === componentId)!);

/** The release's identity and properties for a managed design of the same section. */
const from = (componentId: string): Pick<DesignSpec, 'componentId' | 'name' | 'description' | 'category' | 'tags' | 'icon' | 'properties'> => {
  const def = release(componentId);
  return { componentId, name: def.name, description: def.description ?? '', category: def.category, tags: def.tags ?? [], icon: def.icon ?? 'square', properties: def.properties };
};

const axis = (label: string, defaultOption: string, options: Record<string, { label: string; styles?: Record<string, ResponsiveStyles> }>): VariantAxis => ({ label, default: defaultOption, options });
const tone = (defaultOption = 'default') =>
  axis('Tone', defaultOption, {
    default: { label: 'Default' },
    muted: { label: 'Soft background', styles: { root: { base: { background: tok('color.surface-alt') } } } },
    inverse: { label: 'Dark', styles: { root: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } } } }
  });

/** The section and its container that every design here sits in. */
const shell = (b: TreeBuilder, children: string[]) =>
  b.el('root', 'section', { name: 'Section', styles: { base: { paddingBlock: tok('space.section'), paddingInline: tok('container.gutter') } } }, [
    b.el('inner', 'div', { name: 'Container', styles: { base: { layout: 'stack', gap: tok('space.2xl'), maxWidth: tok('container.content'), marginInline: 'auto' } } }, children)
  ]);

const headingBlock = (b: TreeBuilder) =>
  b.el('intro', 'div', { name: 'Heading group', collapseEmpty: true }, [
    b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' } }),
    b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
    b.text('lead', 'p', { $prop: 'lead' }, { name: 'Lead', when: { $prop: 'lead' } })
  ]);

const actions = (b: TreeBuilder) =>
  b.el('actions', 'div', { name: 'Actions', collapseEmpty: true }, [
    b.link('primary', { $prop: 'primaryLink' }, { $prop: 'primaryLabel' }, 'primary', { name: 'Primary button', when: { $prop: 'primaryLabel' } }),
    b.link('secondary', { $prop: 'secondaryLink' }, { $prop: 'secondaryLabel' }, 'secondary', { name: 'Secondary button', when: { $prop: 'secondaryLabel' } })
  ]);

const DESIGNS: Record<string, () => DesignSpec> = {
  'hero.split': () => ({
    ...from('hero.split'),
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background', 'color', 'minHeight'] },
      container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'gap', 'align'] },
      eyebrow: { nodeId: 'eyebrow', label: 'Eyebrow', styleControls: ['textStyle', 'color'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color', 'maxWidth', 'textAlign'] },
      lead: { nodeId: 'lead', label: 'Supporting text', styleControls: ['textStyle', 'color', 'maxWidth'] },
      actions: { nodeId: 'actions', label: 'Actions', styleControls: ['gap', 'justify'] },
      media: { nodeId: 'media', label: 'Image', styleControls: ['aspectRatio', 'radius', 'shadow'] }
    },
    variantAxes: {
      tone: tone(),
      layout: axis('Layout', 'default', { default: { label: 'Image last' }, 'media-start': { label: 'Image first', styles: { 'media-wrap': { desktop: { order: -1 } } } } })
    },
    build: (b) =>
      shell(b, [
        b.el('grid', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1 }, desktop: { columns: 2 } } }, [
          b.el('content', 'div', { name: 'Content', collapseEmpty: true }, [
            b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' } }),
            b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
            b.text('lead', 'p', { $prop: 'lead' }, { name: 'Supporting text', when: { $prop: 'lead' } }),
            actions(b)
          ]),
          b.el('media-wrap', 'figure', { name: 'Media' }, [b.image('media', { $prop: 'image' }, { name: 'Image' })])
        ])
      ])
  }),
  'intro.page': () => ({
    ...from('intro.page'),
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      eyebrow: { nodeId: 'eyebrow', label: 'Eyebrow', styleControls: ['textStyle', 'color'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      lead: { nodeId: 'lead', label: 'Description', styleControls: ['textStyle', 'color'] }
    },
    variantAxes: { tone: tone('muted') },
    build: (b) => shell(b, [headingBlock(b)])
  }),
  'features.grid': () => ({
    ...from('features.grid'),
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'paddingBlock', 'paddingInline'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
      cardIcon: { nodeId: 'card-icon', label: 'Card icon', styleControls: ['color', 'background'] }
    },
    variantAxes: { tone: tone() },
    build: (b) =>
      shell(b, [
        headingBlock(b),
        b.el('grid', 'ul', { name: 'Card grid', styles: { base: { layout: 'grid', columns: 1 }, desktop: { columns: 3 } } }, [
          b.repeat('cards', 'items', [
            b.el('card', 'li', { name: 'Card' }, [
              b.icon('card-icon', { $item: 'icon' }, { name: 'Icon' }),
              b.text('card-title', 'h3', { $item: 'title' }, { name: 'Title' }),
              b.text('card-text', 'p', { $item: 'description' }, { name: 'Description' }),
              b.link('card-link', { $item: 'link' }, { $item: 'linkLabel' }, 'text', { name: 'Link', when: { $item: 'linkLabel' } })
            ])
          ])
        ])
      ])
  }),
  'content.pages': () => ({
    ...from('content.pages'),
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'gap'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
      cardText: { nodeId: 'card-text', label: 'Card description', styleControls: ['textStyle', 'color'] }
    },
    variantAxes: { tone: tone() },
    build: (b) =>
      shell(b, [
        headingBlock(b),
        b.el('grid', 'ul', { name: 'Card grid', collapseEmpty: true }, [
          b.repeat('cards', 'items', [
            // A card shows only with somewhere to go and a title to click.
            b.el('card-item', 'li', { name: 'Card item', when: { $item: 'pageLink' }, collapseEmpty: true }, [
              b.el('card', 'div', { name: 'Card', when: { $item: 'title' } }, [
                b.link('card-title', { $item: 'pageLink' }, { $item: 'title' }, 'plain', { name: 'Title' }),
                b.text('card-text', 'p', { $item: 'description' }, { name: 'Description', when: { $item: 'description' } })
              ])
            ])
          ])
        ])
      ])
  }),
  'layout.section': () => ({
    ...from('layout.section'),
    slots: { content: { label: 'Content', description: 'Headings, text, images, buttons and components placed inside the section.' } },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'paddingInline', 'background', 'color', 'minHeight'] },
      container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'layout', 'gap', 'align', 'justify', 'textAlign'] }
    },
    variantAxes: { tone: tone() },
    build: (b) => shell(b, [b.slot('content-slot', 'content', { name: 'Content' })])
  }),
  'cta.banner': () => ({
    ...from('cta.banner'),
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      panel: { nodeId: 'panel', label: 'Panel', styleControls: ['background', 'color', 'radius', 'paddingBlock', 'paddingInline'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      lead: { nodeId: 'lead', label: 'Supporting text', styleControls: ['textStyle', 'color'] }
    },
    variantAxes: { tone: tone() },
    build: (b) =>
      shell(b, [
        b.el('panel', 'div', { name: 'Panel' }, [
          b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' } }),
          b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' } }),
          b.text('lead', 'p', { $prop: 'lead' }, { name: 'Supporting text', when: { $prop: 'lead' } }),
          actions(b)
        ])
      ])
  })
};

/** Foundation's managed design of a section, theme-owned, as `foundation.<componentId>`. */
export function managedDesign(componentId: keyof typeof DESIGNS | string): ComponentDefinition {
  const spec = DESIGNS[componentId] ?? (() => { throw new Error(`No managed design of ${componentId} for the assistant's tests.`); })();
  return foundationDesign(spec());
}

/**
 * Put Foundation's managed designs of these sections in the project in place of the release's code (same IDs, so the
 * starter's placements and an insert by component ID use them). The starter's hero, the home page's first section, is
 * the one most tests select, copy, fork or convert.
 */
export function managedFoundation(state: ProjectState, componentIds: string[] = ['hero.split']): ProjectState {
  for (const componentId of componentIds) {
    const def = managedDesign(componentId);
    state.components[def.id] = def;
  }
  return state;
}

/** The business starter with the managed designs of these sections in place of the release's code. */
export function managedStarter(componentIds?: string[]): ProjectState {
  return managedFoundation(createStarterState('business', 'Test', false), componentIds);
}
