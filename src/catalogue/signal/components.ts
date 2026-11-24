/**
 * Signal's components: Foundation's definitions, adopted whole (the same component IDs, properties, parts, slots,
 * variant options, UI state and examples, so a site switches between the two without losing anything), with Signal's
 * own look written over their trees: mono eyebrow labels in soft pills, tinted tiles with generous corners that rise
 * on hover, an asymmetric split hero, and a featured first card in the Services grid (laid out by the stylesheet,
 * see ./base.css). Every change names the node and the variant option it styles, and a change to a node or option
 * the definition no longer has stops the build, so a change to Foundation cannot silently drop Signal's look.
 */
import type { ComponentDefinition, ResponsiveStyles, StyleScopeKey, StyleValue } from '@shared/types';
import { parseStyleScopeKey } from '@shared/types';
import { tok } from '../dsl';

/** Style rules by scope (`base`, `desktop`, `base:hover`); a property set to null is taken off. */
export type StylePatch = Partial<Record<StyleScopeKey, Record<string, StyleValue | null>>>;

/** What Signal changes in one definition: its nodes' styles, and the styles its variant options add. */
export interface Restyle {
  nodes?: Record<string, StylePatch>;
  /** Axis → option → node → rules, merged into what the option already styles. */
  variants?: Record<string, Record<string, Record<string, StylePatch>>>;
}

/** `styles` with `patch` merged in, scope by scope, so the rules a patch does not name stay as they were. */
export function mergeStyles(styles: ResponsiveStyles | undefined, patch: StylePatch): ResponsiveStyles {
  const out: ResponsiveStyles = structuredClone(styles ?? {});
  for (const [key, props] of Object.entries(patch) as Array<[StyleScopeKey, Record<string, StyleValue | null>]>) {
    if (!parseStyleScopeKey(key)) throw new Error(`"${key}" is not a style scope.`);
    const rules: Record<string, StyleValue> = { ...(out[key] ?? {}) };
    for (const [prop, value] of Object.entries(props)) {
      if (value === null) delete rules[prop];
      else rules[prop] = value;
    }
    if (Object.keys(rules).length) out[key] = rules;
    else delete out[key];
  }
  return out;
}

/** Apply a restyle to a definition (an adopted copy, which this changes in place). */
export function restyle(def: ComponentDefinition, r: Restyle): ComponentDefinition {
  const nodes = def.tree?.nodes;
  if (!nodes) throw new Error(`${def.componentId} has no tree to restyle.`);
  for (const [nodeId, patch] of Object.entries(r.nodes ?? {})) {
    const node = nodes[nodeId];
    if (!node) throw new Error(`${def.componentId} has no node "${nodeId}" to restyle.`);
    node.styles = mergeStyles(node.styles, patch);
  }
  for (const [axis, options] of Object.entries(r.variants ?? {})) {
    for (const [optionId, byNode] of Object.entries(options)) {
      const option = def.variantAxes?.[axis]?.options[optionId];
      if (!option) throw new Error(`${def.componentId} has no ${axis} option "${optionId}" to restyle.`);
      const styles = { ...(option.styles ?? {}) };
      for (const [nodeId, patch] of Object.entries(byNode)) {
        if (!nodes[nodeId]) throw new Error(`${def.componentId} has no node "${nodeId}" for its ${axis} option "${optionId}".`);
        styles[nodeId] = mergeStyles(styles[nodeId], patch);
      }
      option.styles = styles;
    }
  }
  return def;
}

/** Signal's section label: a mono eyebrow in a pill tinted with its own colour, so it reads on every tone. */
export const EYEBROW_PILL: StylePatch = {
  base: {
    width: 'fit',
    paddingBlock: '5px',
    paddingInline: '12px',
    radius: tok('radius.pill'),
    background: 'color-mix(in srgb, currentColor 8%, transparent)',
    border: '1px solid color-mix(in srgb, currentColor 22%, transparent)'
  }
};

/** A tile that rises on hover: its shadow (and, given one, its ground) eases in. Movement is left to the stylesheet. */
const rises = (hover: Record<string, StyleValue> = {}): StylePatch => ({
  base: { transition: 'common', transitionDuration: 220, transitionEasing: 'smooth' },
  'base:hover': { shadow: tok('shadow.md'), ...hover }
});

/** A soft tinted tile: the alternate background, no outline, large corners. */
const tile = (radius = 'radius.lg'): StylePatch => ({ base: { background: tok('color.surface-alt'), border: null, shadow: null, radius: tok(radius) } });

/** Two patches for one node, the second's rules after the first's. */
const both = (a: StylePatch, b: StylePatch): StylePatch => {
  const out: StylePatch = { ...a };
  for (const [k, v] of Object.entries(b) as Array<[StyleScopeKey, Record<string, StyleValue | null>]>) out[k] = { ...(out[k] ?? {}), ...v };
  return out;
};

/** On a soft section (whose ground is the tint), tiles turn white so they still stand off it. */
const onSoft = (nodeIds: string[]): Record<string, Record<string, Record<string, StylePatch>>> => ({
  tone: { muted: Object.fromEntries(nodeIds.map((id) => [id, { base: { background: tok('color.surface') } }])) }
});

/** Signal's changes, by component ID. Components it does not list are Foundation's design in Signal's tokens. */
export const SIGNAL_RESTYLES: Record<string, Restyle> = {
  'hero.split': {
    // Copy a little wider than the picture, and the picture lifted off the page.
    nodes: { grid: { desktop: { gridTemplate: '1.15fr 1fr' } }, media: { base: { shadow: tok('shadow.lg') } } }
  },
  'features.grid': {
    nodes: {
      card: both(both(tile(), { base: { gap: tok('space.sm') } }), rises({ background: tok('color.surface') })),
      'card-icon-wrap': {
        base: {
          radius: tok('radius.sm'),
          background: 'color-mix(in srgb, var(--so-color-brand) 12%, var(--so-color-surface))',
          border: '1px solid color-mix(in srgb, var(--so-color-brand) 20%, transparent)',
          marginBlockEnd: tok('space.sm')
        }
      }
    },
    variants: onSoft(['card'])
  },
  'testimonials.grid': { nodes: { card: tile() }, variants: onSoft(['card']) },
  'pricing.plans': {
    nodes: {
      plan: rises({ border: '1px solid color-mix(in srgb, var(--so-color-brand) 45%, var(--so-color-border))' }),
      badge: { base: { textStyle: tok('text.eyebrow'), fontSize: null, fontWeight: null } }
    }
  },
  'faq.list': {
    // Each question is its own tile instead of a row between hairlines.
    nodes: {
      list: { base: { gap: tok('space.sm') } },
      item: { base: { paddingInline: tok('space.lg'), background: tok('color.surface-alt'), radius: tok('radius.md') } },
      'item-divider': { base: { hidden: true } }
    },
    variants: {
      tone: {
        muted: { item: { base: { background: tok('color.surface') } } },
        // On the dark tone the tile is a lift of the section's own ink, so its text keeps the dark tone's colours.
        inverse: { item: { base: { background: 'color-mix(in srgb, currentColor 8%, transparent)' } } }
      }
    }
  },
  'contact.details': { nodes: { method: tile('radius.md') }, variants: onSoft(['method']) },
  'cta.banner': { nodes: { panel: { base: { shadow: tok('shadow.lg') } } } }
};

/** Restyle an adopted definition with Signal's look: its pill eyebrow wherever it has one, then its own changes. */
export function signalRestyle(def: ComponentDefinition): ComponentDefinition {
  if (def.kind !== 'managed') return def;
  if (def.tree?.nodes.eyebrow) restyle(def, { nodes: { eyebrow: EYEBROW_PILL } });
  const own = SIGNAL_RESTYLES[def.componentId ?? ''];
  return own ? restyle(def, own) : def;
}
