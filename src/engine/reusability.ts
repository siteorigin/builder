import type { ComponentDefinition, GraphNode, ResponsiveScope, ResponsiveStyles, StyleValue, TokenDef, TokenGroup } from '@shared/types';
import { isBinding } from '@shared/types';
import { STYLE_PROP_MAP, followToken } from '@shared/styles';
import { parseColor } from '@shared/color';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { variantOptions } from '@shared/variants';
import { childLists } from './tree';
import type { Diagnostic } from './validate';

/**
 * Static checks that a project component is built to be reused: what a placement should choose (its words, pictures
 * and destinations) is bound to a property or list item field, its colors and spacing follow the site styles, and the
 * cards and pictures it repeats are parts a placement can restyle. Warnings only: a component that fails them still
 * works, it just shows the same sample in every placement, or ignores a change to Site styles.
 */
export const REUSABILITY_CODES = new Set(['COMPONENT_UNBOUND_CONTENT', 'COMPONENT_LITERAL_STYLE', 'COMPONENT_PART_MISSING']);

export const isReusabilityWarning = (d: Diagnostic) => REUSABILITY_CODES.has(d.code);

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** The fields a placement's content comes from. */
const CONTENT_KINDS = new Set(['text', 'image', 'link', 'icon']);
/** Styles that give a container a visible box of its own: what makes it a card rather than a layout wrapper. */
const BOX_PROPS = ['background', 'border', 'shadow', 'radius', 'paddingBlock', 'paddingInline', 'paddingBlockStart', 'paddingBlockEnd', 'paddingInlineStart', 'paddingInlineEnd'];
const PADDING_PROPS = new Set(BOX_PROPS.filter((p) => p.startsWith('padding')));
/** Values that set a style back to nothing. */
const RESET_VALUES = new Set(['', '0', '0px', '0rem', 'none', 'transparent', 'inherit', 'initial', 'unset']);
/** An image no bigger than this across or down is a detail (an avatar, a logo), not the picture a card is about. */
const ACCESSORY_IMAGE_PX = 64;
/** A literal color: hex, rgb() or hsl(). Keywords, variables, mixes and gradients are left alone. */
const LITERAL_COLOR_RE = /^(#[0-9a-f]{3,8}|(rgba?|hsla?)\(.*\))$/i;
const SCOPE_WORDS: Record<ResponsiveScope, string> = { base: '', phone: ' on phones', tablet: ' on tablets', desktop: ' on desktops' };

/**
 * A short fixed label is part of a design (an eyebrow, "Read more", "/ month"), not sample content: plain text of a
 * few words that is not a heading. Anything longer, or any heading, is what a placement is expected to choose.
 */
export function isMicroLabel(text: string, heading = false): boolean {
  const s = text.trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return true;
  return !heading && s.length <= 32 && s.split(/\s+/).length <= 4;
}

/** The author says the content is meant to be the same everywhere by naming its layer "Shared …". */
const sharedIntent = (n: GraphNode) => /\bshared\b/i.test(n.name ?? '');

/** A length in px, reading rem as 16px; null for anything else (a keyword, a percentage, a calculation). */
function lengthPx(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(-?\d*\.?\d+)(px|rem)$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
}

const isReset = (v: StyleValue | undefined) => v === undefined || v === false || v === 0 || (typeof v === 'string' && RESET_VALUES.has(v.trim().toLowerCase()));

const quoted = (text: string) => `“${text.length > 50 ? `${text.slice(0, 47).trimEnd()}…` : text}”`;

const layer = (n: GraphNode, fallback: string) => (n.name ? `“${n.name}”` : fallback);
const KIND_WORDS: Partial<Record<GraphNode['kind'], string>> = { element: 'a container', text: 'a text', link: 'a button', image: 'an image', icon: 'an icon', divider: 'a divider', repeat: 'a list', instance: 'a nested component' };

export function componentReusabilityDiagnostics(def: ComponentDefinition, tokens: readonly TokenDef[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tree = def.tree;
  if (def.kind !== 'managed' || !tree) return out;
  const owner = { kind: 'component', id: def.id };
  const nodes = tree.nodes;
  const node = (id: string) => (Object.hasOwn(nodes, id) ? nodes[id] : undefined);
  const parts = new Set(Object.values(def.parts ?? {}).map((p) => p?.nodeId));
  const push = (code: string, n: GraphNode, site: unknown[], message: string) => out.push({ severity: 'warning', code, message: `${def.name}: ${message}`, owner, nodeId: n.id, site: JSON.stringify([n.id, ...site]) });

  // Site styles as they resolve, so a literal can be matched to the one with the same value.
  const resolved = tokens.map((t) => ({ t, value: followToken(tokens as TokenDef[], t.id) }));
  const ofGroups = (groups: readonly TokenGroup[]) => resolved.filter(({ t }) => groups.includes(t.group));
  const minSpace = Math.min(...ofGroups(['space']).map(({ value }) => lengthPx(value)).filter((x): x is number => x !== null && x > 0));

  /** What content nodes a subtree shows, and whether any of it is a part. */
  const contentCount = new Map<string, number>();
  const countContent = (id: string, seen = new Set<string>()): number => {
    const n = node(id);
    if (!n || seen.has(id)) return 0;
    seen.add(id);
    if (contentCount.has(id)) return contentCount.get(id)!;
    const own = CONTENT_KINDS.has(n.kind) ? 1 : 0;
    const total = own + childLists(n).reduce((sum, cl) => sum + cl.ids.reduce((s, c) => s + countContent(c, seen), 0), 0);
    contentCount.set(id, total);
    return total;
  };
  const exposesPart = (id: string, seen = new Set<string>()): boolean => {
    const n = node(id);
    if (!n || seen.has(id)) return false;
    seen.add(id);
    return parts.has(id) || childLists(n).some((cl) => cl.ids.some((c) => exposesPart(c, seen)));
  };
  const hasBox = (n: GraphNode) => Object.values(n.styles ?? {}).some((scope) => BOX_PROPS.some((p) => !isReset(scope?.[p])));

  // 1. Content a placement should choose, written into the design.
  const content = (n: GraphNode, inRepeat: boolean) => {
    if (sharedIntent(n)) return;
    const every = inRepeat ? 'every item of every placement' : 'every placement';
    const where = (kind: string) => (inRepeat ? `a ${kind} field of the list item` : `a ${kind} property`);
    const optOut = 'or name the layer “Shared …” if it is meant to be the same everywhere.';
    if (n.kind === 'text' && !isBinding(n.text)) {
      const text = (typeof n.text === 'string' && !n.rich ? n.text : richTextToPlain(toRichText(n.text))).trim();
      const heading = isBinding(n.tag) || HEADING_TAGS.has(n.tag);
      if (text && (n.rich || !isMicroLabel(text, heading)))
        push('COMPONENT_UNBOUND_CONTENT', n, ['content', 'text'], `the ${heading ? 'heading' : 'text'} ${quoted(text)} is written into the design, so ${every} shows the same words. Bind its text to ${where('text')}, with these words as the default, ${optOut}`);
    }
    if (n.kind === 'image' && !isBinding(n.image))
      push('COMPONENT_UNBOUND_CONTENT', n, ['content', 'image'], `the image ${layer(n, '')}`.trimEnd() + ` is chosen in the design, so ${every} shows the same picture. Bind it to ${where('image')}, ${optOut}`);
    if (n.kind === 'link') {
      const label = isBinding(n.label) ? '' : String(n.label ?? '').trim();
      const button = label ? `the ${quoted(label)} button` : `the button ${layer(n, '')}`.trimEnd();
      if (label && !isMicroLabel(label))
        push('COMPONENT_UNBOUND_CONTENT', n, ['content', 'label'], `the button label ${quoted(label)} is written into the design, so ${every} shows it. Bind the label to ${where('text')}, ${optOut}`);
      if (!isBinding(n.link))
        push('COMPONENT_UNBOUND_CONTENT', n, ['content', 'link'], `where ${button} goes is set in the design, so ${every} links to the same place. Bind its link to ${where('link')}, ${optOut}`);
    }
    if (n.kind === 'element' && n.link !== undefined && !isBinding(n.link) && n.link?.type !== 'none' && !(n.action !== undefined && !isBinding(n.action) && n.action !== 'link'))
      push('COMPONENT_UNBOUND_CONTENT', n, ['content', 'link'], `where ${layer(n, 'a linked container')} goes is set in the design, so ${every} links to the same place. Bind its link to ${where('link')}, ${optOut}`);
  };

  // 2. Colors and spacing written as values where a site style of the right kind exists.
  const styles = (n: GraphNode, rs: ResponsiveStyles | undefined, layerKey: string, variantWords: string) => {
    for (const [scope, props] of Object.entries(rs ?? {}) as Array<[ResponsiveScope, Record<string, StyleValue> | undefined]>) {
      for (const [prop, v] of Object.entries(props ?? {})) {
        const style = Object.hasOwn(STYLE_PROP_MAP, prop) ? STYLE_PROP_MAP[prop] : undefined;
        if (!style || typeof v !== 'string') continue;
        const groups: readonly TokenGroup[] = style.tokenGroup === undefined ? [] : Array.isArray(style.tokenGroup) ? style.tokenGroup : [style.tokenGroup];
        const value = v.trim();
        let kind: 'color' | 'spacing' | null = null;
        let matches: typeof resolved = [];
        if (style.kind === 'color' && groups.includes('color') && LITERAL_COLOR_RE.test(value)) {
          const rgba = parseColor(value);
          if (!rgba || !ofGroups(['color']).length) continue;
          kind = 'color';
          matches = ofGroups(['color']).filter(({ value: tv }) => {
            const c = typeof tv === 'string' ? parseColor(tv) : null;
            return !!c && c.r === rgba.r && c.g === rgba.g && c.b === rgba.b && Math.abs(c.a - rgba.a) < 1 / 255;
          });
        } else if (style.kind === 'length' && groups.includes('space') && prop !== 'maxWidth') {
          // A text's or button's own padding is the shape of its chip (a badge, a pill), not the layout's rhythm.
          if (PADDING_PROPS.has(prop) && n.kind !== 'element') continue;
          const px = lengthPx(value);
          // Nothing smaller than the smallest spacing style has a site style to stand for it (a hairline offset).
          if (px === null || px <= 0 || !ofGroups(groups).length || (Number.isFinite(minSpace) && px < minSpace)) continue;
          kind = 'spacing';
          matches = ofGroups(groups).filter(({ value: tv }) => lengthPx(tv) === px);
        }
        if (!kind) continue;
        const what = `${style.label.toLowerCase()}${SCOPE_WORDS[scope] ?? ''}${variantWords}`;
        const suggestion = matches.length === 1 ? `the site style “${matches[0].t.label}” (${matches[0].t.id})` : kind === 'color' ? 'one of the site colors' : 'one of the spacing styles';
        const follows = kind === 'color' ? 'so it follows Site styles' : 'so it follows the site’s spacing';
        push('COMPONENT_LITERAL_STYLE', n, ['style', layerKey, scope, prop], `${layer(n, KIND_WORDS[n.kind] ?? 'an element')} uses ${value} for its ${what}. Link it to ${suggestion}, ${follows}.`);
      }
    }
  };

  // 3. The cards and pictures a list repeats, which a placement can only restyle when they are parts.
  const repeatedCards = (repeat: GraphNode) => {
    for (const cl of childLists(repeat))
      for (const itemId of cl.ids) {
        let card = node(itemId);
        // Wrappers that only hold the card (a list item around it) lead to it.
        while (card?.kind === 'element' && !parts.has(card.id) && !hasBox(card) && card.children.length === 1 && node(card.children[0])?.kind === 'element') card = node(card.children[0]);
        if (!card || card.kind !== 'element' || parts.has(card.id)) continue;
        if (hasBox(card) || (countContent(itemId) >= 2 && !exposesPart(itemId)))
          push('COMPONENT_PART_MISSING', card, ['part', 'card'], `${layer(card, 'the container')} is repeated for each list item, but it is not one of the component’s parts, so placements cannot restyle it. Add it to the parts.`);
      }
  };
  const isAccessory = (n: GraphNode) =>
    ['width', 'height', 'maxWidth', 'maxHeight'].some((p) => {
      const px = lengthPx(n.styles?.base?.[p]);
      return px !== null && px > 0 && px <= ACCESSORY_IMAGE_PX;
    });
  const repeatedImage = (n: GraphNode, frames: string[]) => {
    if (parts.has(n.id) || isAccessory(n)) return;
    // A frame that holds only this picture (and owns its crop) can be the part instead.
    if (frames.some((f) => parts.has(f) && countContent(f) === 1)) return;
    push('COMPONENT_PART_MISSING', n, ['part', 'media'], `the image ${layer(n, '')}`.trimEnd() + ` is repeated for each list item, but it is not one of the component’s parts, so placements cannot change its crop or corners. Add it to the parts.`);
  };

  const visited = new Set<string>();
  /** `frames`: the elements between the nearest repeat and this node, or null outside any repeat. */
  const walk = (id: string, frames: string[] | null) => {
    const n = node(id);
    if (!n || visited.has(id)) return;
    visited.add(id);
    content(n, frames !== null);
    styles(n, n.styles, 'own', '');
    if (n.kind === 'repeat') repeatedCards(n);
    if (n.kind === 'image' && frames) repeatedImage(n, frames);
    const inner = n.kind === 'repeat' ? [] : frames && n.kind === 'element' ? [...frames, n.id] : frames;
    for (const cl of childLists(n)) cl.ids.forEach((c) => walk(c, inner));
  };
  tree.rootIds.forEach((r) => walk(r, null));
  for (const { axis, id, option } of variantOptions(def)) {
    const axisLabel = def.variantAxes?.[axis]?.label ?? axis;
    for (const [nid, rs] of Object.entries(option.styles ?? {})) {
      const n = node(nid);
      if (n && visited.has(nid)) styles(n, rs, `variant:${axis}:${id}`, ` in the “${option.label || id}” ${axisLabel.toLowerCase()} variant`);
    }
  }
  return out;
}
