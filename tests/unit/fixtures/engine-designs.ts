/**
 * Managed stand-ins for Foundation's sections, for the engine tests of what the editor does with a design built in it:
 * forking one, editing its tree, its parts, slots, repeats and variants, converting it to code.
 *
 * Foundation now ships Svelte code components, whose designs the editor does not edit, so each stand-in is the
 * release's own contract (its name, properties, slots and variant options, so every placement of the section stays
 * valid) with a tree: the slice of the old managed design the tests traverse, under the node IDs they name.
 * `useManaged` puts one in a project in place of the release's code, as the theme's definition every placement of
 * that section then shows.
 */
import type { ComponentDefinition, PartDef, ProjectState, ResponsiveStyles, VariantAxis } from '@shared/types';
import { getTheme } from '@catalogue/index';
import { tok, type TreeBuilder } from '@catalogue/dsl';
import { definitionHash } from '@engine/install';
import { foundationDesign, type DesignSpec } from './packs';

type NodeStyles = Record<string, ResponsiveStyles>;

const muted = { color: tok('color.muted') };
const eyebrowStyles = { textStyle: tok('text.eyebrow'), color: tok('color.brand') };

/** The section and its centred container, as every old Foundation section began. */
const shell = (b: TreeBuilder, children: string[]) =>
  b.el('root', 'section', { name: 'Section', styles: { paddingBlock: tok('space.section'), paddingInline: tok('container.gutter'), background: tok('color.background'), color: tok('color.text') } }, [
    b.el('inner', 'div', { name: 'Container', styles: { layout: 'stack', gap: tok('space.2xl'), width: 'fill', maxWidth: tok('container.content'), marginInline: 'auto' } }, children)
  ]);

/** The dark tone's rules: the section dark, its eyebrow in the accent colour and the given text lightened. */
const inverse = (lightened: string[] = []): NodeStyles => ({
  root: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } },
  eyebrow: { base: { color: tok('color.accent') } },
  ...Object.fromEntries(lightened.map((id) => [id, { base: { color: tok('color.on-inverse'), opacity: 0.78 } }]))
});

/** The release's variant axes and options, with the rules each option sets on this tree. */
function axes(release: ComponentDefinition, styles: Record<string, Record<string, NodeStyles>>): Record<string, VariantAxis> {
  return Object.fromEntries(
    Object.entries(release.variantAxes ?? {}).map(([axis, { prop: _prop, ...a }]) => {
      void _prop;
      const options = Object.fromEntries(Object.entries(a.options).map(([id, o]) => [id, styles[axis]?.[id] ? { ...o, styles: styles[axis][id] } : { ...o }]));
      return [axis, { ...a, options }];
    })
  );
}

type Tree = { parts: Record<string, PartDef>; variants?: Record<string, Record<string, NodeStyles>>; build: (b: TreeBuilder) => string };

const TREES: Record<string, Tree> = {
  'features.grid': {
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gridAutoFlow', 'gridAutoRows', 'gap'] },
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] },
      cardIcon: { nodeId: 'card-icon', label: 'Card icon', styleControls: ['color', 'background'] }
    },
    variants: {
      tone: { muted: { root: { base: { background: tok('color.surface-alt') } } }, inverse: inverse(['lead']) },
      layout: { 'two-columns': { grid: { desktop: { columns: 2 } } }, 'four-columns': { grid: { desktop: { columns: 4 } } } }
    },
    build: (b) =>
      shell(b, [
        b.el('intro', 'div', { name: 'Heading group', collapseEmpty: true, styles: { layout: 'stack', gap: tok('space.md'), maxWidth: '760px' } }, [
          b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
          b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h2') } }),
          b.text('lead', 'p', { $prop: 'lead' }, { name: 'Lead', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), ...muted } })
        ]),
        b.el('grid', 'ul', { name: 'Card grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
          b.repeat('cards', 'items', [
            b.el('card', 'li', { name: 'Card', styles: { layout: 'stack', gap: tok('space.md'), paddingBlock: tok('space.xl'), paddingInline: tok('space.xl'), background: tok('color.surface'), radius: tok('radius.lg') } }, [
              b.el('card-icon-wrap', 'div', { name: 'Icon badge', styles: { width: '48px', minHeight: '48px', radius: tok('radius.md'), color: tok('color.brand') } }, [b.icon('card-icon', { $item: 'icon' }, { name: 'Icon' })]),
              b.text('card-title', 'h3', { $item: 'title' }, { name: 'Title', styles: { textStyle: tok('text.h3') } }),
              b.text('card-text', 'p', { $item: 'description' }, { name: 'Description', styles: muted }),
              b.link('card-link', { $item: 'link' }, { $item: 'linkLabel' }, 'text', { name: 'Link', when: { $item: 'linkLabel' }, styles: { marginBlockStart: 'auto' } })
            ])
          ])
        ])
      ])
  },
  'hero.split': {
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background', 'color', 'minHeight'] },
      container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'gap', 'align'] },
      eyebrow: { nodeId: 'eyebrow', label: 'Eyebrow', styleControls: ['textStyle', 'color'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color', 'maxWidth', 'textAlign'] },
      lead: { nodeId: 'lead', label: 'Supporting text', styleControls: ['textStyle', 'color', 'maxWidth'] },
      actions: { nodeId: 'actions', label: 'Actions', styleControls: ['gap', 'justify'] },
      media: { nodeId: 'media', label: 'Image', styleControls: ['aspectRatio', 'radius', 'shadow'] }
    },
    variants: {
      tone: { muted: { root: { base: { background: tok('color.surface-alt') } } }, inverse: inverse(['lead']) },
      layout: { 'media-start': { 'media-wrap': { desktop: { order: -1 } } } }
    },
    build: (b) =>
      shell(b, [
        b.el('grid', 'div', { name: 'Layout', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.2xl'), align: 'center' }, desktop: { columns: 2, gap: tok('space.3xl') } } }, [
          b.el('content', 'div', { name: 'Content', collapseEmpty: true, styles: { layout: 'stack', gap: tok('space.lg'), align: 'start' } }, [
            b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow', when: { $prop: 'eyebrow' }, styles: eyebrowStyles }),
            b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h1') } }),
            b.text('lead', 'p', { $prop: 'lead' }, { name: 'Supporting text', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), ...muted, maxWidth: '560px' } }),
            b.el('actions', 'div', { name: 'Actions', collapseEmpty: true, styles: { layout: 'row', wrap: true, gap: tok('space.sm') } }, [
              b.link('primary', { $prop: 'primaryLink' }, { $prop: 'primaryLabel' }, 'primary', { name: 'Primary button', when: { $prop: 'primaryLabel' } }),
              b.link('secondary', { $prop: 'secondaryLink' }, { $prop: 'secondaryLabel' }, 'secondary', { name: 'Secondary button', when: { $prop: 'secondaryLabel' } })
            ])
          ]),
          b.el('media-wrap', 'figure', { name: 'Media' }, [b.image('media', { $prop: 'image' }, { name: 'Image', styles: { aspectRatio: '4/5', radius: tok('radius.lg'), objectFit: 'cover' } })])
        ])
      ])
  },
  'cta.banner': {
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      panel: { nodeId: 'panel', label: 'Panel', styleControls: ['background', 'color', 'radius', 'paddingBlock', 'paddingInline'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      lead: { nodeId: 'lead', label: 'Supporting text', styleControls: ['textStyle', 'color'] }
    },
    variants: {
      tone: { muted: { panel: { base: { background: tok('color.surface-alt'), color: tok('color.text') } } }, inverse: { panel: { base: { background: tok('color.inverse'), color: tok('color.on-inverse') } } } },
      layout: { start: { panel: { base: { align: 'start', textAlign: 'start' } } } }
    },
    build: (b) =>
      shell(b, [
        b.el('panel', 'div', { name: 'Panel', styles: { layout: 'stack', align: 'center', textAlign: 'center', gap: tok('space.lg'), paddingInline: tok('space.xl'), background: tok('color.brand'), color: tok('color.on-brand'), radius: tok('radius.lg') } }, [
          b.text('heading', { $prop: 'headingLevel' }, { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.h2') } }),
          b.text('lead', 'p', { $prop: 'lead' }, { name: 'Supporting text', when: { $prop: 'lead' }, styles: { textStyle: tok('text.lead'), opacity: 0.85 } }),
          b.el('actions', 'div', { name: 'Actions', collapseEmpty: true, styles: { layout: 'row', wrap: true, justify: 'center', gap: tok('space.sm') } }, [
            b.link('primary', { $prop: 'primaryLink' }, { $prop: 'primaryLabel' }, 'light', { name: 'Primary button', when: { $prop: 'primaryLabel' } }),
            b.link('secondary', { $prop: 'secondaryLink' }, { $prop: 'secondaryLabel' }, 'secondary', { name: 'Secondary button', when: { $prop: 'secondaryLabel' } })
          ])
        ])
      ])
  },
  'layout.section': {
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'paddingInline', 'background', 'color', 'minHeight'] },
      container: { nodeId: 'inner', label: 'Container', styleControls: ['maxWidth', 'layout', 'columns', 'gridTemplate', 'gridAutoFlow', 'gridAutoRows', 'gap', 'rowGap', 'columnGap', 'align', 'justify', 'textAlign'] }
    },
    variants: { tone: { muted: { root: { base: { background: tok('color.surface-alt') } } }, inverse: inverse() } },
    build: (b) => shell(b, [b.slot('content-slot', 'content', { name: 'Content' })])
  },
  'logos.strip': {
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color', 'textAlign'] },
      row: { nodeId: 'row', label: 'Logo row', styleControls: ['gap', 'justify'] },
      wordmark: { nodeId: 'wordmark', label: 'Wordmark', styleControls: ['textStyle', 'color', 'fontFamily'] }
    },
    variants: { tone: { muted: { root: { base: { background: tok('color.surface-alt') } } }, inverse: inverse(['heading', 'wordmark']) } },
    build: (b) =>
      shell(b, [
        b.text('heading', 'p', { $prop: 'heading' }, { name: 'Heading', when: { $prop: 'heading' }, styles: { textStyle: tok('text.small'), ...muted, textAlign: 'center' } }),
        b.el('row', 'ul', { name: 'Logo row', styles: { layout: 'row', wrap: true, justify: 'center', align: 'center', gap: tok('space.xl') } }, [
          b.repeat('logo-items', 'logos', [
            b.el('logo-item', 'li', { name: 'Logo', styles: { layout: 'row', align: 'center' } }, [
              // A logo without alternative text is named by the company name its wordmark would show.
              b.image('logo-image', { $item: 'logo' }, { name: 'Logo image', when: { $item: 'logo' }, fallbackAlt: { $item: 'name' }, styles: { maxWidth: '140px', objectFit: 'contain' } }),
              b.text('wordmark', 'span', { $item: 'name' }, { name: 'Wordmark', unless: { $item: 'logo' }, styles: { fontFamily: tok('font.display'), color: tok('color.muted') } })
            ])
          ])
        ])
      ])
  }
};

/** A managed Foundation design with the release's contract for this section, and the tree the tests read. */
export function managedFoundation(componentId: string): ComponentDefinition {
  const tree = TREES[componentId];
  if (!tree) throw new Error(`No managed stand-in for ${componentId}.`);
  const release = getTheme('foundation').components.find((c) => c.componentId === componentId)!;
  const spec: DesignSpec = {
    componentId,
    name: release.name,
    description: release.description,
    category: release.category,
    tags: release.tags,
    icon: release.icon,
    properties: structuredClone(release.properties),
    ...(release.slots ? { slots: structuredClone(release.slots) } : {}),
    parts: tree.parts,
    variantAxes: axes(release, tree.variants ?? {}),
    build: tree.build
  };
  return foundationDesign(spec);
}

/**
 * Put the managed stand-in for a Foundation section into the project in place of the release's code, as the theme's
 * definition (with its lock entry) that every placement of the section shows. Returns the definition in the project.
 */
export function useManaged(state: ProjectState, componentId: string): ComponentDefinition {
  const def = managedFoundation(componentId);
  state.components[def.id] = def;
  state.themeLock.components[def.id] = { componentId, version: getTheme('foundation').version, hash: definitionHash(def) };
  return def;
}
