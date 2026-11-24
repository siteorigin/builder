/**
 * Small authoring helpers for catalogue component definitions.
 * The helpers only build plain static data; nothing here runs when a pack is loaded into a project.
 */
import type {
  Bindable,
  Binding,
  ButtonAppearance,
  Comparison,
  Condition,
  ConditionValue,
  ComponentCategory,
  ElementAction,
  ComponentDefinition,
  ElementTag,
  GraphNode,
  IconPosition,
  ImageValue,
  LinkValue,
  ListItem,
  ListProp,
  PartDef,
  PropSchema,
  ResponsiveStyles,
  ScalarPropSchema,
  StyleProps,
  TextTag,
  VariantAxis
} from '@shared/types';
import { SCHEMA_VERSION, isBinding } from '@shared/types';
import { toRichText, type RichListType } from '@shared/richtext';

export const prop = (name: string): Binding => ({ $prop: name });
export const item = (name: string): Binding => ({ $item: name });
export const tok = (token: string) => ({ token });
/** A condition that holds when the bound value equals `value` (`when: eq(item('featured'), true)`). */
export const eq = (ref: Binding, value: ConditionValue): Comparison => ({ ref, eq: value });
/** A condition that holds when the bound value differs from `value`. */
export const ne = (ref: Binding, value: ConditionValue): Comparison => ({ ref, ne: value });

type NodeOpts = { styles?: ResponsiveStyles | StyleProps; when?: Condition; unless?: Condition; name?: string; anchor?: string };
/** Options of nodes that take an accessible name. */
type NamedOpts = NodeOpts & { ariaLabel?: Bindable<string> };

function normStyles(s?: ResponsiveStyles | StyleProps): ResponsiveStyles | undefined {
  if (!s) return undefined;
  const keys = Object.keys(s);
  if (keys.length && keys.every((k) => ['base', 'phone', 'tablet', 'desktop'].includes(k))) return s as ResponsiveStyles;
  return { base: s as StyleProps };
}

export class TreeBuilder {
  nodes: Record<string, GraphNode> = {};

  private add<T extends GraphNode>(node: T, opts?: NodeOpts): string {
    if (this.nodes[node.id]) throw new Error(`Duplicate node id ${node.id}`);
    const styles = normStyles(opts?.styles);
    const n = { ...node } as GraphNode;
    if (styles) n.styles = styles;
    if (opts?.when) n.when = opts.when;
    if (opts?.unless) n.unless = opts.unless;
    if (opts?.name) n.name = opts.name;
    if (opts?.anchor) n.anchor = opts.anchor;
    this.nodes[node.id] = n;
    return node.id;
  }

  /**
   * A container. With `link` the whole container is one link (a card), so nothing inside it may be interactive.
   * With `action` as well, clicking it does what the action says: nothing, open its image full size, or follow `link`.
   */
  el(id: string, tag: Bindable<ElementTag>, opts: NamedOpts & { collapseEmpty?: boolean; link?: Bindable<LinkValue>; action?: Bindable<ElementAction> }, children: string[]): string {
    return this.add(
      {
        id,
        kind: 'element',
        tag,
        children,
        ...(opts.collapseEmpty ? { collapseEmpty: true } : {}),
        ...(opts.link !== undefined ? { link: opts.link } : {}),
        ...(opts.action !== undefined ? { action: opts.action } : {}),
        ...(opts.ariaLabel !== undefined ? { ariaLabel: opts.ariaLabel } : {})
      },
      opts
    );
  }
  /** Plain text. A bound tag takes an enum property whose options are all text tags, such as h1 and h2. */
  text(id: string, tag: Bindable<TextTag>, text: string | Binding, opts: NodeOpts = {}): string {
    return this.add({ id, kind: 'text', tag, text }, opts);
  }
  rich(id: string, text: string[] | Binding, opts: NodeOpts = {}): string {
    return this.add({ id, kind: 'text', tag: 'div', text: isBinding(text) ? text : toRichText(text), rich: true }, opts);
  }
  image(id: string, image: ImageValue | Binding, opts: NodeOpts & { fallbackAlt?: string | Binding } = {}): string {
    return this.add({ id, kind: 'image', image, ...(opts.fallbackAlt !== undefined ? { fallbackAlt: opts.fallbackAlt } : {}) }, opts);
  }
  /** A button or link, optionally with an icon beside its label (`iconPosition` start, the default, or end). */
  link(
    id: string,
    link: LinkValue | Binding,
    label: string | Binding,
    appearance: ButtonAppearance | Binding,
    opts: NamedOpts & { icon?: Bindable<string>; iconPosition?: Bindable<IconPosition> } = {}
  ): string {
    return this.add(
      {
        id,
        kind: 'link',
        link,
        label,
        appearance,
        ...(opts.icon !== undefined ? { icon: opts.icon } : {}),
        ...(opts.iconPosition !== undefined ? { iconPosition: opts.iconPosition } : {}),
        ...(opts.ariaLabel !== undefined ? { ariaLabel: opts.ariaLabel } : {})
      },
      opts
    );
  }
  /** An icon; decorative unless it has an accessible name. */
  icon(id: string, icon: string | Binding, opts: NamedOpts = {}): string {
    return this.add({ id, kind: 'icon', icon, ...(opts.ariaLabel !== undefined ? { ariaLabel: opts.ariaLabel } : {}) }, opts);
  }
  divider(id: string, opts: NodeOpts = {}): string {
    return this.add({ id, kind: 'divider' }, opts);
  }
  repeat(id: string, list: string, children: string[], opts: NodeOpts = {}): string {
    return this.add({ id, kind: 'repeat', list: { $prop: list }, children }, opts);
  }
  slot(id: string, slot: string, opts: NodeOpts = {}): string {
    return this.add({ id, kind: 'slot', slot }, opts);
  }
}

export interface ComponentSpec {
  componentId: string;
  name: string;
  description: string;
  category: ComponentCategory;
  tags: string[];
  icon: string;
  properties: Record<string, PropSchema>;
  parts: Record<string, PartDef>;
  variantAxes?: Record<string, VariantAxis>;
  slots?: Record<string, { label: string }>;
  build: (b: TreeBuilder) => string;
  examples?: ComponentDefinition['examples'];
}

export const PACK_ID = 'foundation';
export const PACK_VERSION = '0.1.0';

export function definitionIdFor(componentId: string): string {
  return `${PACK_ID}.${componentId}`;
}

export function managed(spec: ComponentSpec): ComponentDefinition {
  const b = new TreeBuilder();
  const rootId = spec.build(b);
  // Shared variant helpers may style nodes a particular component does not have; keep only real nodes.
  const variantAxes = spec.variantAxes && Object.fromEntries(
    Object.entries(spec.variantAxes).map(([axis, a]) => [
      axis,
      {
        ...a,
        options: Object.fromEntries(
          Object.entries(a.options).map(([id, v]) => [id, v.styles ? { ...v, styles: Object.fromEntries(Object.entries(v.styles).filter(([nid]) => nid in b.nodes)) } : v])
        )
      }
    ])
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    id: definitionIdFor(spec.componentId),
    componentId: spec.componentId,
    contractVersion: 1,
    kind: 'managed',
    owner: 'theme',
    name: spec.name,
    description: spec.description,
    category: spec.category,
    tags: spec.tags,
    icon: spec.icon,
    properties: spec.properties,
    parts: spec.parts,
    slots: spec.slots,
    variantAxes,
    tree: { rootIds: [rootId], nodes: b.nodes },
    provenance: { pack: PACK_ID, packVersion: PACK_VERSION, componentId: spec.componentId },
    license: 'GPL-3.0-or-later',
    examples: spec.examples
  };
}

// ---------------------------------------------------------------------------
// Property helpers
// ---------------------------------------------------------------------------

/** A value authored with plain strings, with its rich text in the stored form. */
export function canonicalRich(schema: PropSchema, value: unknown): unknown {
  if (schema.type === 'richtext') return isBinding(value) ? value : toRichText(value, schema.plainAs);
  if (schema.type !== 'list' || !Array.isArray(value)) return value;
  return value.map((it: Record<string, unknown>) => {
    const out = { ...it };
    for (const [k, f] of Object.entries(schema.fields)) if (k in out) out[k] = canonicalRich(f, out[k]);
    return out;
  });
}

export const P = {
  str: (label: string, def: string, extra: Partial<ScalarPropSchema> = {}): ScalarPropSchema =>
    ({ type: 'string', label, default: def, ...extra }) as ScalarPropSchema,
  text: (label: string, def: string): ScalarPropSchema => ({ type: 'string', label, default: def, multiline: true }),
  rich: (label: string, def: string[], extra: { plainAs?: RichListType } = {}): ScalarPropSchema => ({ type: 'richtext', label, default: toRichText(def, extra.plainAs), ...extra }),
  bool: (label: string, def: boolean): ScalarPropSchema => ({ type: 'boolean', label, default: def }),
  num: (label: string, def: number, min?: number, max?: number): ScalarPropSchema => ({ type: 'number', label, default: def, min, max }),
  choice: (label: string, def: string, options: Array<[string, string]>): ScalarPropSchema => ({
    type: 'enum',
    label,
    default: def,
    options: options.map(([value, l]) => ({ value, label: l }))
  }),
  link: (label: string, def: Partial<LinkValue> = {}): ScalarPropSchema => ({
    type: 'link',
    label,
    default: { type: 'none', target: '', ...def }
  }),
  image: (label: string, alt = ''): ScalarPropSchema => ({ type: 'image', label, default: { assetId: null, alt } }),
  icon: (label: string, def: string): ScalarPropSchema => ({ type: 'icon', label, default: def }),
  choices: (label: string, extra: Partial<ScalarPropSchema> = {}): ScalarPropSchema => ({ type: 'choices', label, default: [], ...extra }) as ScalarPropSchema,
  list: (
    label: string,
    itemLabel: string,
    fields: Record<string, ScalarPropSchema>,
    items: Array<Record<string, unknown>>,
    extra: Partial<ListProp> = {}
  ): ListProp => ({
    type: 'list',
    label,
    itemLabel,
    fields,
    default: items.map((it, i) => canonicalRich({ type: 'list', fields } as ListProp, [{ id: `item-${i + 1}`, ...it }]) as ListItem[]).flat(),
    max: 24,
    ...extra
  })
};

export const NO_LINK: LinkValue = { type: 'none', target: '' };
