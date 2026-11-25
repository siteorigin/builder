/**
 * Editorial's components: Foundation's contracts (component IDs, properties and their defaults, parts, slots, variant
 * options and UI state) adopted unchanged, so a site moves between the two themes with every placement, item and
 * style it set still applying, and then laid out the Editorial way. Only internal node styles and the styles of
 * variant options change; every node keeps its ID and its place in the tree.
 */
import type { ComponentDefinition, ResponsiveStyles, StyleScopeKey, StyleValue } from '@shared/types';
import type { PackAuthor } from '../dsl';
import { tok } from '../dsl';

/** A style patch: a value sets the property, null removes it. */
type StylePatch = Partial<Record<StyleScopeKey, Record<string, StyleValue | null>>>;

/** A hairline rule that follows the text colour, so it reads on every tone. */
const RULE = '1px solid currentColor';

function merge(styles: ResponsiveStyles | undefined, patch: StylePatch): ResponsiveStyles {
  const out: ResponsiveStyles = structuredClone(styles ?? {});
  for (const [scope, props] of Object.entries(patch) as Array<[StyleScopeKey, Record<string, StyleValue | null>]>) {
    const next = { ...(out[scope] ?? {}) };
    for (const [prop, value] of Object.entries(props)) {
      if (value === null) delete next[prop];
      else next[prop] = value;
    }
    if (Object.keys(next).length) out[scope] = next;
    else delete out[scope];
  }
  return out;
}

function restyle(def: ComponentDefinition, nodeId: string, patch: StylePatch): void {
  const node = def.tree?.nodes[nodeId];
  if (!node) throw new Error(`Editorial: ${def.componentId} has no node "${nodeId}".`);
  node.styles = merge(node.styles, patch);
}

/** Add to (or change) the styles one option of a variant axis gives one node. */
function restyleOption(def: ComponentDefinition, axis: string, option: string, nodeId: string, patch: StylePatch): void {
  const opt = def.variantAxes?.[axis]?.options[option];
  if (!opt) throw new Error(`Editorial: ${def.componentId} has no ${axis} option "${option}".`);
  if (!def.tree?.nodes[nodeId]) throw new Error(`Editorial: ${def.componentId} has no node "${nodeId}".`);
  opt.styles = { ...(opt.styles ?? {}), [nodeId]: merge(opt.styles?.[nodeId], patch) };
}

/**
 * An editorial index: the section's container becomes a narrow column for its heading beside a wide one for what
 * follows (`1fr 2fr`), from desktop up, at the full content width. A column left on its own spans both (base CSS).
 */
function indexLayout(def: ComponentDefinition): void {
  restyle(def, 'inner', {
    base: { layout: 'grid', columns: 1, maxWidth: tok('container.content'), gap: tok('space.xl'), paddingBlockStart: tok('space.lg'), borderBlockStart: RULE },
    desktop: { gridTemplate: '1fr 2fr', gap: tok('space.3xl') }
  });
}

const PATCHES: Record<string, (def: ComponentDefinition) => void> = {
  'hero.split': (def) => {
    // Copy in the narrow column, the picture in the wide one, both standing on the same baseline.
    restyle(def, 'grid', { base: { align: 'end' }, desktop: { columns: null, gridTemplate: '2fr 3fr' } });
    restyleOption(def, 'layout', 'media-start', 'grid', { desktop: { gridTemplate: '3fr 2fr' } });
    restyle(def, 'content', { base: { paddingBlockStart: tok('space.lg'), borderBlockStart: RULE } });
  },
  'intro.page': (def) => {
    restyle(def, 'content', { base: { maxWidth: '920px' } });
  },
  'content.media': (def) => {
    // The picture leads in the wide column; moved to the end, it keeps the wide column.
    restyle(def, 'grid', { base: { align: 'start' }, desktop: { columns: null, gridTemplate: '3fr 2fr' } });
    restyleOption(def, 'layout', 'media-end', 'grid', { desktop: { gridTemplate: '2fr 3fr' } });
    restyle(def, 'content', { base: { paddingBlockStart: tok('space.lg'), borderBlockStart: RULE } });
  },
  'content.text': (def) => {
    indexLayout(def);
    restyle(def, 'body', { base: { maxWidth: tok('container.reading') } });
  },
  'faq.list': (def) => {
    indexLayout(def);
  },
  'features.grid': (def) => {
    // A numbered index (the numbers are base CSS counters): open entries under a hairline rule instead of boxed cards.
    restyle(def, 'grid', { base: { gap: tok('space.2xl'), columnGap: tok('space.xl') } });
    restyle(def, 'card', {
      base: { background: null, color: null, border: null, radius: null, paddingBlock: null, paddingInline: '0', paddingBlockStart: tok('space.md'), paddingBlockEnd: '0', borderBlockStart: RULE }
    });
    restyle(def, 'card-icon-wrap', { base: { width: '40px', minHeight: '40px', background: null, border: RULE } });
    // Open entries sit straight on the section, so on the dark tone they take its colours.
    restyleOption(def, 'tone', 'inverse', 'card-text', { base: { color: tok('color.on-inverse'), opacity: 0.78 } });
    restyleOption(def, 'tone', 'inverse', 'card-icon-wrap', { base: { color: tok('color.accent') } });
    restyleOption(def, 'tone', 'inverse', 'card-link', { base: { color: tok('color.on-inverse') } });
  },
  'stats.row': (def) => {
    restyle(def, 'figure', { base: { paddingBlockStart: tok('space.md'), borderBlockStart: RULE, gap: tok('space.sm') } });
  },
  'testimonials.grid': (def) => {
    restyle(def, 'card', { base: { shadow: null, border: tok('border.default') } });
    restyle(def, 'quote', { base: { fontFamily: tok('font.display'), fontSize: '1.3rem', lineHeight: '1.45' } });
  },
  'team.grid': (def) => {
    restyle(def, 'portrait', { base: { aspectRatio: '3/4' } });
  },
  'pricing.plans': (def) => {
    restyle(def, 'plan', { base: { borderBlockStart: tok('border.strong') } });
  },
  'blog.grid': (def) => {
    restyle(def, 'card', { base: { paddingBlockStart: tok('space.md'), borderBlockStart: RULE }, 'base:hover': { borderBlockStart: '1px solid var(--so-color-brand)' } });
  },
  'content.pages': (def) => {
    restyle(def, 'card', { base: { paddingBlockStart: tok('space.md'), borderBlockStart: RULE }, 'base:hover': { borderBlockStart: '1px solid var(--so-color-brand)' } });
  },
  'blog.list': (def) => {
    restyle(def, 'list', { base: { borderBlockStart: RULE } });
  }
};

/** Editorial's implementation of each of Foundation's components, in Foundation's catalogue order. */
export function editorialComponents(author: PackAuthor, foundation: ComponentDefinition[]): ComponentDefinition[] {
  const unknown = Object.keys(PATCHES).filter((id) => !foundation.some((c) => c.componentId === id));
  if (unknown.length) throw new Error(`Editorial restyles components Foundation does not have: ${unknown.join(', ')}.`);
  return foundation.map((d) => {
    const c = author.adopt(d);
    PATCHES[c.componentId ?? '']?.(c);
    return c;
  });
}
