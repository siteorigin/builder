import type { ComponentDefinition, GraphNode, ResponsiveStyles, StyleScope, StyleValue, TokenDef, TokenGroup, TokenValue } from '@shared/types';
import { isBinding, parseStyleScopeKey } from '@shared/types';
import { STATE_WORDS, STYLE_PROP_MAP, followToken } from '@shared/styles';
import { parseColor } from '@shared/color';
import { isNamedColor } from '@shared/color-names';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { variantOptions } from '@shared/variants';
import { childLists } from './tree';
import { boundSchema, stateActionRuns } from './schema';
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
/** Site text styles that make whatever wears them a heading, whatever its tag (a card's title link, say). */
const HEADING_TEXT_STYLE = /^text\.(display|h[1-6])$/;
/** What a placement's content comes from; icons decorate it. */
const CONTENT_KINDS = new Set(['text', 'image', 'link', 'icon']);
const SUBSTANTIVE_KINDS = new Set(['text', 'image', 'link']);
/** Styles that draw a box of its own around an element: what makes a container a card, or a text a chip. */
const SURFACE_PROPS = ['background', 'border', 'borderBlockStart', 'borderBlockEnd', 'borderInlineStart', 'borderInlineEnd', 'shadow', 'radius'];
const PADDING_PROPS = new Set(['paddingBlock', 'paddingInline', 'paddingBlockStart', 'paddingBlockEnd', 'paddingInlineStart', 'paddingInlineEnd']);
const BOX_PROPS = [...SURFACE_PROPS, ...PADDING_PROPS];
/** Values that set a style back to nothing. */
const RESET_VALUES = new Set(['', '0', '0px', '0rem', 'none', 'transparent', 'inherit', 'initial', 'unset']);
/** Button looks that draw their own box, so their padding is the button's shape. */
const PLAIN_LINKS = new Set(['text', 'link', 'plain']);
/** An image capped at this or less across or down at every width is a detail (an avatar, a logo), not a card's picture. */
const ACCESSORY_IMAGE_PX = 64;
/** A frame's style controls that change how the picture inside it is cropped or cornered. */
const CROP_CONTROLS = ['aspectRatio', 'radius', 'width', 'height', 'maxWidth', 'maxHeight'];
/** A card named for what it is: "Card", "Service card", "Panel", "Tile" (but not "Card grid" or "Card item"). */
const CARD_NAME = /\b(card|panel|tile)s?\s*$/i;
/** Below this a spacing length is a hairline adjustment that no spacing style stands for, unless one matches it exactly. */
const MIN_SPACE_PX = 4;
/** A literal color: hex, rgb() or hsl(), or a color name (red). Keywords, variables, mixes and gradients are left alone. */
const LITERAL_COLOR_RE = /^(#[0-9a-f]{3,8}|(rgba?|hsla?)\(.*\))$/i;
const SCOPE_WORDS: Record<StyleScope, string> = { base: '', phone: ' on phones', tablet: ' on tablets', desktop: ' on desktops', 'cq-narrow': ' in a narrow container', 'cq-medium': ' in a medium container', 'cq-wide': ' in a wide container' };
const KIND_WORDS: Partial<Record<GraphNode['kind'], string>> = { element: 'a container', text: 'a text layer', link: 'a button', image: 'an image', icon: 'an icon', divider: 'a divider', repeat: 'a list', instance: 'a nested component' };

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
const sharedIntent = (n: GraphNode) => typeof n.name === 'string' && /^\s*shared\b/i.test(n.name);

/** A length in px, reading rem as 16px; null for anything else (a keyword, a percentage, a calculation). */
function lengthPx(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(-?\d*\.?\d+)(px|rem)$/.exec(v.trim());
  if (!m) return null;
  const px = Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  return Number.isFinite(px) ? px : null;
}

const sameLength = (a: string, b: unknown) => typeof b === 'string' && (a.trim().toLowerCase() === b.trim().toLowerCase() || (lengthPx(a) !== null && lengthPx(a) === lengthPx(b)));

/** Whether a style value draws something: a literal other than a reset, or a site style. A binding is not a style. */
const sets = (v: unknown) =>
  typeof v === 'string' ? !RESET_VALUES.has(v.trim().toLowerCase()) : typeof v === 'number' ? v !== 0 : !!v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string';

const quoted = (text: string) => `“${text.length > 50 ? `${text.slice(0, 47).trimEnd()}…` : text}”`;
const layer = (n: GraphNode, fallback: string) => (typeof n.name === 'string' && n.name ? `“${n.name}”` : fallback);
const scopesOf = (rs: unknown) => (rs && typeof rs === 'object' && !Array.isArray(rs) ? (Object.entries(rs) as Array<[string, unknown]>) : []).filter((e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === 'object' && !Array.isArray(e[1]));

/** Site styles as they resolve, worked out once for every definition one validation checks. */
const resolvedCache = new WeakMap<readonly TokenDef[], Array<{ t: TokenDef; value: TokenValue | undefined }>>();
function resolveTokens(tokens: readonly TokenDef[]) {
  let r = resolvedCache.get(tokens);
  if (!r) {
    r = tokens.map((t) => ({ t, value: followToken(tokens as TokenDef[], t.id) }));
    resolvedCache.set(tokens, r);
  }
  return r;
}

export function componentReusabilityDiagnostics(def: ComponentDefinition, tokens: readonly TokenDef[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tree = def.tree;
  if (def.kind !== 'managed' || !tree || !tree.nodes || typeof tree.nodes !== 'object') return out;
  const owner = { kind: 'component', id: def.id };
  const nodes = tree.nodes;
  const node = (id: unknown) => (typeof id === 'string' && Object.hasOwn(nodes, id) && nodes[id] && typeof nodes[id] === 'object' ? nodes[id] : undefined);
  const partList = Object.values(def.parts ?? {}).filter((p) => !!p && typeof p === 'object');
  const parts = new Set(partList.map((p) => p.nodeId));
  const push = (code: string, n: GraphNode, site: unknown[], message: string) => out.push({ severity: 'warning', code, message: `${def.name}: ${message}`, owner, nodeId: n.id, site: JSON.stringify([n.id, ...site]) });

  const resolved = resolveTokens(tokens);
  const ofGroups = (groups: readonly TokenGroup[]) => resolved.filter(({ t }) => groups.includes(t.group));
  /** A node's own styles and those its variants give it, scope by scope. */
  const variantStyles = new Map<string, ResponsiveStyles[]>();
  for (const { option } of variantOptions(def))
    for (const [nid, rs] of Object.entries(option?.styles ?? {})) variantStyles.set(nid, [...(variantStyles.get(nid) ?? []), rs]);
  const allScopes = (n: GraphNode) => [n.styles, ...(variantStyles.get(n.id) ?? [])].flatMap(scopesOf).map(([, props]) => props);
  const draws = (n: GraphNode, props: readonly string[]) => allScopes(n).some((scope) => props.some((p) => sets(scope[p])));

  /** What a subtree shows. */
  const counts = (kinds: Set<string>) => {
    const memo = new Map<string, number>();
    const count = (id: string, seen = new Set<string>()): number => {
      const n = node(id);
      if (!n || seen.has(id)) return 0;
      seen.add(id);
      if (memo.has(id)) return memo.get(id)!;
      const total = (kinds.has(n.kind) ? 1 : 0) + childLists(n).reduce((sum, cl) => sum + cl.ids.reduce((s, c) => s + count(c, seen), 0), 0);
      memo.set(id, total);
      return total;
    };
    return count;
  };
  const countContent = counts(CONTENT_KINDS);
  const countSubstance = counts(SUBSTANTIVE_KINDS);
  const exposedMemo = new Map<string, boolean>();
  const exposesPart = (id: string, seen = new Set<string>()): boolean => {
    const n = node(id);
    if (!n || seen.has(id)) return false;
    seen.add(id);
    if (exposedMemo.has(id)) return exposedMemo.get(id)!;
    const r = parts.has(id) || childLists(n).some((cl) => cl.ids.some((c) => exposesPart(c, seen)));
    exposedMemo.set(id, r);
    return r;
  };

  /** Whether a text or button is a heading: by its tag, the tags its bound tag can be, or a heading's text style. */
  const isHeading = (n: GraphNode) => {
    const styleId = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string' ? (v as { token: string }).token : '');
    if (allScopes(n).some((scope) => HEADING_TEXT_STYLE.test(styleId(scope.textStyle)))) return true;
    if (n.kind !== 'text') return false;
    if (!isBinding(n.tag)) return typeof n.tag === 'string' && HEADING_TAGS.has(n.tag);
    const schema = boundSchema(def, n.id, n.tag);
    const options = schema && 'options' in schema && Array.isArray(schema.options) ? schema.options : null;
    return !options || options.some((o) => typeof o?.value === 'string' && HEADING_TAGS.has(o.value));
  };

  // 1. Content a placement should choose, written into the design.
  const content = (n: GraphNode, inRepeat: boolean) => {
    if (sharedIntent(n)) return;
    const every = inRepeat ? 'every item of every placement' : 'every placement';
    const where = (kind: string) => (inRepeat ? `a ${kind} field of the list item` : `a ${kind} property`);
    const optOut = 'or name the layer “Shared …” if it is meant to be the same everywhere.';
    const goesNowhere = (l: unknown) => {
      const { type, target } = (l && typeof l === 'object' ? l : {}) as { type?: unknown; target?: unknown };
      return type === 'none' || typeof target !== 'string' || !target.trim();
    };
    if (n.kind === 'text' && !isBinding(n.text)) {
      const text = (typeof n.text === 'string' && !n.rich ? n.text : richTextToPlain(toRichText(n.text))).trim();
      const heading = isHeading(n);
      if (text && (n.rich || !isMicroLabel(text, heading)))
        push('COMPONENT_UNBOUND_CONTENT', n, ['content', 'text'], `the ${heading ? 'heading' : 'text'} ${quoted(text)} is written into the design, so ${every} shows the same words. Bind its text to ${where(n.rich ? 'rich text' : 'text')}, with these words as the default, ${optOut}`);
    }
    if (n.kind === 'image' && !isBinding(n.image))
      push('COMPONENT_UNBOUND_CONTENT', n, ['content', 'image'], `${`the image ${layer(n, '')}`.trimEnd()} is chosen in the design, so ${every} shows the same picture. Bind it to ${where('image')}, ${optOut}`);
    if (n.kind === 'link') {
      const label = typeof n.label === 'string' ? n.label.trim() : '';
      const heading = isHeading(n);
      const button = label ? `the ${quoted(label)} ${heading ? 'link' : 'button'}` : `${`the button ${layer(n, '')}`.trimEnd()}`;
      if (label && !isMicroLabel(label, heading))
        push('COMPONENT_UNBOUND_CONTENT', n, ['content', 'label'], `the ${heading ? 'link text' : 'button label'} ${quoted(label)} is written into the design, so ${every} shows it. Bind it to ${where('text')}, ${optOut}`);
      // A button that changes the component's UI state and goes nowhere (a tab, a toggle) is a control every placement
      // shares, not a destination a placement chooses.
      const control = goesNowhere(n.link) && stateActionRuns(def, n.stateAction, n.id);
      if (!isBinding(n.link) && !control)
        push(
          'COMPONENT_UNBOUND_CONTENT',
          n,
          ['content', 'link'],
          goesNowhere(n.link)
            ? `${button} has no destination in the design, and placements cannot give it one. Bind its link to ${where('link')}, ${optOut}`
            : `where ${button} goes is set in the design, so ${every} links to the same place. Bind its link to ${where('link')}, ${optOut}`
        );
    }
    // A container's link is used unless a fixed action other than following it says otherwise.
    if (n.kind === 'element' && !isBinding(n.link) && !goesNowhere(n.link) && (n.action === undefined || isBinding(n.action) || n.action === 'link'))
      push('COMPONENT_UNBOUND_CONTENT', n, ['content', 'link'], `where ${layer(n, 'a linked container')} goes is set in the design, so ${every} links to the same place. Bind its link to ${where('link')}, ${optOut}`);
  };

  // 2. Colors and spacing written as values where a site style of the right kind exists.
  /** A text or button that draws its own box (a badge, a pill, a button): its padding is its shape, not the layout's. */
  const isChip = (n: GraphNode) => (n.kind === 'text' || n.kind === 'link') && (draws(n, SURFACE_PROPS) || (n.kind === 'link' && (typeof n.appearance !== 'string' || !PLAIN_LINKS.has(n.appearance))));
  const styles = (n: GraphNode, rs: unknown, layerKey: string, variantWords: string) => {
    for (const [scope, props] of scopesOf(rs)) {
      for (const [prop, v] of Object.entries(props)) {
        const style = Object.hasOwn(STYLE_PROP_MAP, prop) ? STYLE_PROP_MAP[prop] : undefined;
        if (!style || typeof v !== 'string') continue;
        const groups: readonly TokenGroup[] = style.tokenGroup === undefined ? [] : Array.isArray(style.tokenGroup) ? style.tokenGroup : [style.tokenGroup];
        const value = v.trim();
        let kind: 'color' | 'spacing' | null = null;
        let matches: typeof resolved = [];
        if (style.kind === 'color' && groups.includes('color') && (LITERAL_COLOR_RE.test(value) || isNamedColor(value))) {
          const rgba = parseColor(value);
          if (!rgba || !ofGroups(['color']).length) continue;
          kind = 'color';
          matches = ofGroups(['color']).filter(({ value: tv }) => {
            const c = typeof tv === 'string' ? parseColor(tv) : null;
            return !!c && c.r === rgba.r && c.g === rgba.g && c.b === rgba.b && Math.abs(c.a - rgba.a) < 1 / 255;
          });
        } else if (style.kind === 'length' && (groups.includes('space') || groups.includes('container')) && !RESET_VALUES.has(value.toLowerCase())) {
          const px = lengthPx(value);
          // A hairline adjustment is meant as it is, whatever the spacing scale holds; so is a chip's own padding.
          if ((px !== null && Math.abs(px) < MIN_SPACE_PX) || (PADDING_PROPS.has(prop) && isChip(n))) continue;
          matches = ofGroups(groups).filter(({ t, value: tv }) => (t.group !== 'container' || !style.containerTokens || style.containerTokens.includes(t.id)) && sameLength(value, tv));
          // A length a site style has exactly is always worth linking. Any other is judged as spacing: a size such as a
          // maximum width, or a negative pull, is often meant as it is.
          if (!matches.length && (prop === 'maxWidth' || !groups.includes('space') || px === null || px < MIN_SPACE_PX || !ofGroups(['space']).length)) continue;
          kind = 'spacing';
        }
        if (!kind) continue;
        const at = parseStyleScopeKey(scope);
        const where = at ? `${SCOPE_WORDS[at.scope]}${at.state ? ` ${STATE_WORDS[at.state]}` : ''}` : ` at ${scope}`;
        const what = `${style.label.toLowerCase()}${where}${variantWords}`;
        const suggestion = matches.length === 1 ? `the site style “${matches[0].t.label}” (${matches[0].t.id})` : kind === 'color' ? 'one of the site colors' : 'one of the spacing styles';
        const follows = kind === 'color' ? 'so it follows Site styles' : 'so it follows the site’s spacing';
        push('COMPONENT_LITERAL_STYLE', n, ['style', layerKey, scope, prop], `${layer(n, KIND_WORDS[n.kind] ?? 'an element')} uses ${value} for its ${what}. Link it to ${suggestion}, ${follows}.`);
      }
    }
  };

  // 3. The cards and pictures a list repeats, which a placement can only restyle when they are parts.
  const isCard = (n: GraphNode) => draws(n, BOX_PROPS) || (n.kind === 'element' && n.tag === 'article') || (typeof n.name === 'string' && CARD_NAME.test(n.name));
  const repeatedCards = (repeat: GraphNode) => {
    for (const cl of childLists(repeat))
      for (const itemId of cl.ids) {
        let card = node(itemId);
        const seen = new Set<string>();
        // Wrappers that only hold the card (a list item around it) lead to it.
        while (card?.kind === 'element' && !seen.has(card.id) && !parts.has(card.id) && !isCard(card) && Array.isArray(card.children) && card.children.length === 1 && node(card.children[0])?.kind === 'element') {
          seen.add(card.id);
          card = node(card.children[0]);
        }
        if (!card || card.kind !== 'element' || parts.has(card.id)) continue;
        if (isCard(card) || (countSubstance(itemId) >= 2 && !exposesPart(itemId)))
          push('COMPONENT_PART_MISSING', card, ['part', 'card'], `${layer(card, 'the container')} is repeated for each list item, but it is not one of the component’s parts, so placements cannot restyle it. Add it to the parts.`);
      }
  };
  /**
   * Capped at or below the accessory size across or down at every width and in every variant: styles apply as the
   * generated rules cascade (the node's base and its rule for that width, then the variant's, which are more specific),
   * so a maximum still caps a larger width, and a variant's larger maximum lifts it.
   */
  const isAccessory = (n: GraphNode) => {
    const own = Object.fromEntries(scopesOf(n.styles));
    const variants = [{}, ...(variantStyles.get(n.id) ?? []).map((rs) => Object.fromEntries(scopesOf(rs)))];
    const widths = new Set(['base', ...Object.keys(own), ...variants.flatMap((v) => Object.keys(v))]);
    const applied = variants.flatMap((v) => [...widths].map((w) => ({ ...own.base, ...own[w], ...v.base, ...v[w] })));
    const capped = (props: Record<string, unknown>, axis: string[]) =>
      axis.some((p) => {
        const px = lengthPx(props[p]);
        return px !== null && px > 0 && px <= ACCESSORY_IMAGE_PX;
      });
    return [['width', 'maxWidth'], ['height', 'maxHeight']].some((axis) => applied.every((props) => capped(props, axis)));
  };
  /** A part whose controls (all of them, when it lists none) can change its picture's crop or corners. */
  const cropFrame = (id: string) => partList.some((p) => p.nodeId === id && (!Array.isArray(p.styleControls) || !p.styleControls.length || p.styleControls.some((c) => CROP_CONTROLS.includes(c))));
  const repeatedImage = (n: GraphNode, frames: string[]) => {
    if (parts.has(n.id) || isAccessory(n)) return;
    // A frame that holds only this picture can be the part instead, when it offers the controls that crop it.
    if (frames.some((f) => countContent(f) === 1 && cropFrame(f))) return;
    push('COMPONENT_PART_MISSING', n, ['part', 'media'], `${`the image ${layer(n, '')}`.trimEnd()} is repeated for each list item, but it is not one of the component’s parts, so placements cannot change its crop or corners. Add it to the parts.`);
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
    for (const cl of childLists(n)) if (Array.isArray(cl.ids)) cl.ids.forEach((c) => walk(c, inner));
  };
  (Array.isArray(tree.rootIds) ? tree.rootIds : []).forEach((r) => walk(r, null));
  for (const { axis, id, option } of variantOptions(def)) {
    const a = def.variantAxes?.[axis]?.label;
    const axisLabel = typeof a === 'string' && a ? a : axis;
    const optionLabel = typeof option?.label === 'string' && option.label ? option.label : id;
    for (const [nid, rs] of Object.entries(option?.styles ?? {})) {
      const n = node(nid);
      if (n && visited.has(nid)) styles(n, rs, `variant:${axis}:${id}`, ` in the “${optionLabel}” ${axisLabel.toLowerCase()} variant`);
    }
  }
  return out;
}
