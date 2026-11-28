import type { GraphNode, NodeTree, OwnerRef, ProjectState, StyleProps, StyleValue, TokenDef } from '@shared/types';
import { isBinding, parseStyleScopeKey } from '@shared/types';
import { cascadeStyles, followedText, isGradient, linkOf, parseCustomCss, textMetrics, tokenVar } from '@shared/styles';
import { parseColor, type Rgba } from '@shared/color';
import { compositeOver, contrastBetween, formatRatio, relativeLuminance, TEXT_CONTRAST } from '@shared/contrast';
import { hasDarkPalette, type PaletteScheme } from '@shared/color-scheme';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { getTheme } from '@catalogue/index';
import { showsPart } from '@shared/page-shell';
import { detachedClasses, effectiveTokens, pageNodeClass } from '@generator/index';
import { paintsPicture } from '@generator/background';
import { displayName } from './tree';
import { themePaintRules, type ThemeLayoutRules } from './theme-layout-rules';
import type { Diagnostic } from './validate';
import type { Keeper } from './validation-cache';

/*
 * Text an element's own colours make hard to read (#1489): a text colour picked in the Inspector that disappears into
 * the background behind it, or text over a background picture that nothing makes readable. The theme's own colour
 * pairs are checked in Site styles; this reads the colours a page's (or the header's and footer's) own elements end up
 * with, at each screen size, and in the dark palette too when visitors can see it.
 *
 * - The text colour is the text's own, or the nearest one around it; the background is what is painted behind it, the
 *   text's own and every element's around it, a see-through colour laid over what is beneath.
 * - Over a background picture, the overlay is what the text sits on: a solid one is checked as a colour; a see-through
 *   one could show any part of the picture, so the text is checked against every colour it can make of one, from it
 *   over black to it over white, and is said to need checking when any may be hard to read. A picture with no overlay, or a gradient one, can't be measured,
 *   so its text is said to need checking rather than passed.
 * - Only what is known for certain is measured, since a wrong warning is worse than a missed one. The page starts
 *   with the theme's text colour on its page background; inside a placed component, whose own markup and stylesheet
 *   may paint anything, nothing is known until an element of the page sets a colour or a background again. A theme
 *   rule that may paint an element, custom CSS that may, a width range of its container, a fade (opacity), an inset
 *   shadow or a colour this cannot read leaves its text unmeasured; an element positioned or moved away from where it
 *   sits leaves what is behind it unknown. Text that may not render (a condition, a collection's items, a bound text)
 *   is not read, nor are hover, focus and press states.
 * - Text is measured only where an element sets a text colour, a background or a picture on the way to it: the theme's
 *   own colours alone are its pairs' to check.
 * - Text this size needs 4.5:1; text that may be large (a heading, or a size that reaches 24px, or 18.66px bold) 3:1.
 */

type Size = 'phone' | 'tablet' | 'desktop';
const SIZES: readonly Size[] = ['phone', 'tablet', 'desktop'];
/** The minimum for large text (WCAG 2.2 AA, 1.4.3). */
const LARGE_TEXT_CONTRAST = 3;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/**
 * The opaque colours behind text: one colour (`lo` and `hi` the same), or, over a picture a see-through overlay covers,
 * the darkest and lightest the overlay can make of it (painted over black and over white).
 */
interface Ground {
  lo: Rgba;
  hi: Rgba;
  /** False over a picture: the colour behind the text is somewhere between `lo` and `hi`. */
  exact: boolean;
}

/** Why text over a picture can't be measured. */
type Picture = 'bare' | 'gradient';
/** A picture: any colour at all may be behind the text. */
const ANY: Ground = { lo: BLACK, hi: WHITE, exact: false };

/** What paints the text at one screen size in one palette. */
interface Paint {
  /** Nothing shows here: hidden, or inside something that is. Also set where nothing inside can be read (a fade). */
  off: boolean;
  /** The text colour, possibly see-through; null when not known. */
  fg: Rgba | null;
  /** What is behind; null when not known. */
  ground: Ground | null;
  /** A background picture behind with no overlay, or a gradient one: what this can't measure. */
  picture: Picture | null;
  /** An element on the way set a text colour, a background or a picture. */
  chosen: boolean;
  /** The text size set on the way, in CSS pixels at most; undefined for the theme's own, null for one this can't read. */
  px: number | null | undefined;
  /** The weight set on the way; undefined for the theme's own, null for one this can't read. */
  weight: number | null | undefined;
}

type Key = `${Size}|${PaletteScheme}`;
type Paints = Map<Key, Paint>;

/** Style properties that decide what this reads: set in a container width range, they leave it unknown. */
const READ_PROPS = new Set(['color', 'background', 'backgroundImage', 'opacity', 'hidden', 'customCss', 'textStyle', 'fontSize', 'fontWeight', 'backdropBlur', 'shadow', 'position', 'translateX', 'translateY', 'rotate', 'scale']);
/** Custom CSS that may paint text, or what is behind it, or change its size. */
const PAINT_CSS =
  /^(color|-webkit-text-fill-color|background(-[a-z-]+)?|opacity|filter|backdrop-filter|-webkit-backdrop-filter|mix-blend-mode|box-shadow|font(-size|-weight)?|display|visibility|content-visibility|position|inset|top|bottom|left|right|transform|translate|rotate|scale|margin(-[a-z-]+)?)$/;
/** The resting rules: what shows before any hover, focus or press. */
const RESTING = ['base', 'phone', 'tablet', 'desktop'] as const;

/** The most CSS pixels a size can be: a length, or the upper end of a clamp(); null for one this can't read. */
function maxPx(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  const clamp = /^clamp\((.*)\)$/s.exec(s);
  if (clamp) {
    const parts = clamp[1].split(',');
    return parts.length === 3 ? maxPx(parts[2]) : null;
  }
  const m = /^(\d+(?:\.\d+)?|\.\d+)(px|rem)$/.exec(s);
  return m ? Number(m[1]) * (m[2] === 'rem' ? 16 : 1) : null;
}

/** A colour style's value as one colour (a token followed, at its strength), or null when it can't be known. */
function colorReader(tokens: TokenDef[]) {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const memo = new Map<string, Rgba | null>();
  const token = (id: string): Rgba | null => {
    if (memo.has(id)) return memo.get(id)!;
    let out: Rgba | null = null;
    const seen = new Set<string>();
    for (let cur: string | null = id; cur && !seen.has(cur); ) {
      seen.add(cur);
      const t = byId.get(cur);
      if (!t || t.group !== 'color') break;
      const next = linkOf(t.value, 'color');
      if (next) cur = next;
      else {
        out = typeof t.value === 'string' ? parseColor(t.value) : null;
        break;
      }
    }
    memo.set(id, out);
    return out;
  };
  return (v: StyleValue | undefined): Rgba | null => {
    if (typeof v === 'string') return parseColor(v);
    if (!v || typeof v !== 'object' || typeof (v as { token?: unknown }).token !== 'string') return null;
    const ref = v as { token: string; alpha?: number };
    const c = token(ref.token);
    if (!c) return null;
    // As generated CSS mixes it with transparent: the channels stay, the alpha scales (see colorAtStrength).
    return typeof ref.alpha === 'number' && ref.alpha < 1 ? { ...c, a: c.a * (Math.round(Math.min(1, Math.max(0, ref.alpha)) * 10000) / 10000) } : c;
  };
}

/** `top` over a ground, as a ground: an opaque colour covers it; a see-through one is laid over both its ends. */
function over(top: Rgba, ground: Ground | null): Ground | null {
  if (top.a >= 1) return { lo: top, hi: top, exact: true };
  if (top.a <= 0) return ground;
  return ground ? { lo: compositeOver(top, ground.lo), hi: compositeOver(top, ground.hi), exact: ground.exact } : null;
}

/** Where over a picture the text reads worst: its light parts, its dark parts, or those close to the text's colour. */
type Worst = 'light' | 'dark' | 'close';

/** The lowest contrast `fg` can have over a ground, and where over a picture that is. */
function lowest(fg: Rgba, ground: Ground): { ratio: number; at: Worst } {
  const lo = contrastBetween(compositeOver(fg, ground.lo), ground.lo);
  if (ground.exact) return { ratio: lo, at: 'dark' };
  const hi = contrastBetween(compositeOver(fg, ground.hi), ground.hi);
  // Every colour between the ends is as light as some ground between them: text of that lightness (see-through or not,
  // since it then shows as nearly that ground) can't be told from it there.
  const l = relativeLuminance(fg);
  if (l >= relativeLuminance(ground.lo) && l <= relativeLuminance(ground.hi)) return { ratio: 1, at: 'close' };
  return hi < lo ? { ratio: hi, at: 'light' } : { ratio: lo, at: 'dark' };
}

const HEADING = /^h[1-6]$/;

/** Whether text may be large enough to need only 3:1. */
function mayBeLarge(n: GraphNode & { kind: 'text' }, p: Paint): boolean {
  const heading = typeof n.tag !== 'string' || HEADING.test(n.tag);
  if (p.px === undefined) return heading;
  if (p.px === null) return true;
  return p.px >= 24 || (p.px >= 18.66 && (p.weight === undefined ? heading : p.weight === null || p.weight >= 700));
}

/** Whether a text node shows any text. */
function showsText(n: GraphNode & { kind: 'text' }): boolean {
  // Bound text may be empty.
  if (isBinding(n.text)) return false;
  if (n.rich) {
    try {
      return richTextToPlain(toRichText(n.text)).trim() !== '';
    } catch {
      return false;
    }
  }
  return typeof n.text === 'string' && n.text.trim() !== '';
}

/** A few words of what a text says, to name it by. */
function quote(state: ProjectState, n: GraphNode & { kind: 'text' }): string {
  if (n.name) return `“${n.name}”`;
  let text = '';
  try {
    text = isBinding(n.text) ? '' : n.rich ? richTextToPlain(toRichText(n.text)) : typeof n.text === 'string' ? n.text : '';
  } catch {
    /* named by its kind */
  }
  const words = text.replace(/\s+/g, ' ').trim();
  if (!words) return `the ${displayName(state, n).toLowerCase()}`;
  return `the text “${words.length > 40 ? `${words.slice(0, 40).trimEnd()}…` : words}”`;
}

const SIZE_WORDS: Record<Size, string> = { phone: 'phones', tablet: 'tablets', desktop: 'desktops' };
const sizesText = (sizes: Size[]) => (sizes.length === SIZES.length ? '' : `on ${sizes.map((s) => SIZE_WORDS[s]).join(' and ')}`);

/**
 * Where a finding holds, as a lead for its message ("On phones in the dark palette, "), or nothing where it holds at
 * every size in every palette read.
 */
function whereText(keys: Key[], schemes: PaletteScheme[]): string {
  const sizesIn = (scheme: PaletteScheme) => SIZES.filter((s) => keys.includes(`${s}|${scheme}`));
  const per = schemes.map((scheme) => ({ scheme, sizes: sizesIn(scheme) })).filter((x) => x.sizes.length);
  const same = per.length === schemes.length && per.every((x) => x.sizes.join() === per[0].sizes.join());
  const parts = same ? [sizesText(per[0].sizes)] : per.map((x) => [sizesText(x.sizes), `in the ${x.scheme} palette`].filter(Boolean).join(' '));
  const text = parts.filter(Boolean).join(', and ');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}, ` : '';
}

/**
 * Whether a theme's stylesheet paints the page as contrast.ts assumes: its `body` rule sets the page background and the
 * text colour from the site's Background and Primary text styles.
 */
export function bodyPaints(css: string): boolean {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter((m) => /\bbody\b/i.test(m[1]));
  // One rule, for the body alone: another (in a media query, say) may paint it otherwise.
  if (rules.length !== 1 || rules[0][1].trim().toLowerCase() !== 'body') return false;
  let background: string | undefined;
  let color: string | undefined;
  for (const d of rules[0][2].split(';')) {
    const colon = d.indexOf(':');
    const prop = d.slice(0, colon).trim().toLowerCase();
    const value = d.slice(colon + 1).replace(/\s+/g, '');
    if (prop === 'background' || prop === 'background-color') background = value;
    else if (prop === 'color') color = value;
  }
  return background === `var(${tokenVar('color.background')})` && color === `var(${tokenVar('color.text')})`;
}

interface Finding {
  code: 'TEXT_CONTRAST_LOW' | 'TEXT_CONTRAST_UNVERIFIED';
  nodeId: string;
  /** What kind of finding it is, for telling them apart. */
  kind: string;
  keys: Key[];
  /** The lowest contrast found, where over a picture it was, and the highest minimum any of its places needs. */
  worst?: { ratio: number; min: number; at: Worst };
  /** The highest contrast found where it holds, to say when the lowest is only one of several. */
  best?: number;
}

/** Text an element's colours make hard to read, in every page and the shared header and footer. */
export function elementContrastDiagnostics(state: ProjectState, keep?: Keeper): Diagnostic[] {
  const out: Diagnostic[] = [];
  const shared = () => {
    let theme: ThemeLayoutRules;
    try {
      theme = themePaintRules(getTheme(state.site.themeId).baseCss ?? '');
    } catch {
      theme = { page: true, reaches: () => true };
    }
    const schemes: PaletteScheme[] = hasDarkPalette(state.tokens) ? ['light', 'dark'] : ['light'];
    const palettes = schemes.map((scheme) => {
      const tokens = effectiveTokens(state, scheme);
      return { scheme, tokens, read: colorReader(tokens) };
    });
    return { theme, schemes, palettes, body: bodyPaints(getTheme(state.site.themeId).baseCss ?? '') };
  };
  const context = keep ? keep.shared('elementContrast', shared) : shared();
  // The shared header and footer, while a page or a collection's pages show them.
  const pages = state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id)).map((id) => state.pages[id]);
  const shown = (part: 'header' | 'footer') => Object.keys(state.collections ?? {}).length > 0 || pages.some((p) => showsPart(p, part));
  const trees: Array<{ owner: OwnerRef; tree: NodeTree; label: string }> = [];
  if (shown('header')) trees.push({ owner: { kind: 'shell', id: 'header' }, tree: state.site.shell.header, label: 'Header' });
  if (shown('footer')) trees.push({ owner: { kind: 'shell', id: 'footer' }, tree: state.site.shell.footer, label: 'Footer' });
  for (const id of state.site.pageOrder) if (Object.hasOwn(state.pages, id)) trees.push({ owner: { kind: 'page', id }, tree: state.pages[id], label: state.pages[id].title });
  for (const t of trees) {
    const run = () => {
      try {
        return treeContrast(state, t.owner, t.tree, t.label, context);
      } catch {
        /* a document damaged by hand: the structural checks say what is wrong with it */
        return [];
      }
    };
    for (const d of keep ? keep.tree(t, 'elementContrast', run) : run()) out.push(d);
  }
  return out;
}

function treeContrast(
  state: ProjectState,
  owner: OwnerRef,
  tree: NodeTree,
  label: string,
  { theme, schemes, palettes, body }: { theme: ThemeLayoutRules; schemes: PaletteScheme[]; palettes: Array<{ scheme: PaletteScheme; tokens: TokenDef[]; read: ReturnType<typeof colorReader> }>; body: boolean }
): Diagnostic[] {
  if (!tree || typeof tree !== 'object' || !tree.nodes || !Array.isArray(tree.rootIds)) return [];
  const found = new Map<string, Finding>();
  const record = (f: Omit<Finding, 'keys' | 'worst' | 'best'>, key: Key, worst?: Finding['worst']) => {
    const id = `${f.code}|${f.nodeId}|${f.kind}`;
    const kept = found.get(id) ?? found.set(id, { ...f, keys: [] }).get(id)!;
    kept.keys.push(key);
    if (worst && (!kept.worst || worst.ratio < kept.worst.ratio)) kept.worst = { ...worst, min: Math.max(worst.min, kept.worst?.min ?? 0) };
    else if (worst && kept.worst) kept.worst.min = Math.max(kept.worst.min, worst.min);
    if (worst && (kept.best === undefined || worst.ratio > kept.best)) kept.best = worst.ratio;
  };

  /**
   * The page as it starts: the theme's text colour on its page background, when its stylesheet paints the page with
   * them (as contrast.ts reads its pairs on that background); otherwise nothing is known.
   */
  const start: Paints = new Map();
  for (const { scheme, read } of palettes) {
    const fg = body ? read({ token: 'color.text' }) : null;
    const page = body ? read({ token: 'color.background' }) : null;
    for (const size of SIZES) start.set(`${size}|${scheme}`, { off: false, fg, ground: page && page.a >= 1 ? over(page, null) : null, picture: null, chosen: false, px: undefined, weight: undefined });
  }
  /**
   * Inside a placed component: nothing is known of what paints it but where it is hidden. Text placed in it keeps the
   * size it would have, since a component's stylesheet sizes its own text, not what is placed in its slots.
   */
  const unknown = (p: Paint): Paint => ({ ...p, fg: null, ground: null, picture: null, chosen: false });

  /** The paints inside an element, from the ones around it; null when nothing inside can be read. */
  const inside = (n: GraphNode & { kind: 'element' | 'text' }, around: Paints): Paints | null => {
    const tag = n.tag;
    // A card renders as the runtime's link while its destination resolves; one with an action, inside one.
    const acts = n.kind === 'element' && n.action !== undefined && n.action !== null;
    const linked = acts || (n.kind === 'element' && n.link !== undefined && n.link !== null);
    const renders = typeof tag === 'string' ? [tag, ...(linked ? ['a'] : [])] : undefined;
    const runtime = acts ? ['so-card-link', 'so-action', 'so-action--image'] : linked ? ['so-card-link'] : [];
    if (theme.reaches([pageNodeClass(n.id), ...detachedClasses(n), ...runtime], renders)) return null;
    const styles = n.styles && typeof n.styles === 'object' ? n.styles : {};
    /** The sizes custom CSS may paint at: nothing inside can be read there. */
    const custom = new Set<Size>();
    for (const [scope, props] of Object.entries(styles)) {
      const parsed = parseStyleScopeKey(scope);
      if (!parsed || parsed.state || !props || typeof props !== 'object') continue;
      const resting = (RESTING as readonly string[]).includes(parsed.scope);
      // A container's width this can't know decides it.
      if (!resting && Object.keys(props).some((p) => READ_PROPS.has(p))) return null;
      const css = (props as StyleProps).customCss;
      if (typeof css === 'string' && parseCustomCss(css).decls.some((d) => PAINT_CSS.test(d.slice(0, d.indexOf(':')).trim().toLowerCase())))
        for (const size of parsed.scope === 'base' || !resting ? SIZES : [parsed.scope as Size]) custom.add(size);
    }
    const won = cascadeStyles([{ styles: n.styles, strength: 1 }]);
    const out: Paints = new Map();
    for (const { scheme, tokens, read } of palettes)
      for (const size of SIZES) {
        const key: Key = `${size}|${scheme}`;
        const p = around.get(key)!;
        const at = won[size] ?? {};
        if (p.off || at.hidden === true) {
          out.set(key, { ...p, off: true });
          continue;
        }
        const next: Paint = { ...p };
        const opacity = at.opacity;
        // Faded, the text and what is behind it blend with whatever is beneath: nothing inside can be read.
        if (custom.has(size) || (opacity !== undefined && !(Number(opacity) >= 1))) next.off = true;
        const blur = at.backdropBlur;
        if (blur !== undefined && blur !== 'none' && Number.parseFloat(String(blur)) !== 0) next.off = true;
        // Placed or moved away from where it sits, it may be over anything.
        const position = at.position;
        const offset = at.inset !== undefined && position !== undefined && position !== 'static';
        if (position === 'absolute' || position === 'fixed' || offset || ['translateX', 'translateY', 'rotate', 'scale'].some((t) => at[t] !== undefined)) [next.ground, next.picture] = [null, null];
        if (at.background !== undefined) {
          next.chosen = true;
          const bg = typeof at.background === 'string' && isGradient(at.background) ? null : read(at.background);
          next.ground = bg ? over(bg, next.picture ? ANY : next.ground) : null;
          // A colour over a picture covers it, or lets it show through: either way it is measured as it is.
          if (!bg || bg.a > 0) next.picture = null;
        }
        const image = at.backgroundImage;
        // One the site can't paint writes nothing, so a picture set elsewhere for this size may still show.
        if (image !== undefined && !paintsPicture(image, state.assets.assets)) [next.ground, next.picture] = [null, null];
        else if (image !== undefined) {
          next.chosen = true;
          const scrim = typeof image === 'object' && typeof (image as { scrim?: unknown }).scrim === 'string' ? (image as { scrim: string }).scrim.trim() : '';
          const solid = scrim && !isGradient(scrim) ? parseColor(scrim) : null;
          if (!scrim) [next.ground, next.picture] = [null, 'bare'];
          else if (!solid) [next.ground, next.picture] = [null, 'gradient'];
          else {
            // The picture may be any colour where the text sits: an overlay over it is between its own colour over
            // black and over white.
            next.ground = over(solid, ANY);
            next.picture = null;
          }
        }
        // An inset shadow paints over the background, beneath the text.
        const shadow = at.shadow;
        const shadowCss = typeof shadow === 'string' ? shadow : linkOf(shadow, 'shadow') ? followedText(tokens, linkOf(shadow, 'shadow')!) : '';
        if (/\binset\b/i.test(shadowCss) || (shadow !== undefined && typeof shadow !== 'string' && !shadowCss)) [next.ground, next.picture] = [null, null];
        if (at.color !== undefined) {
          next.chosen = true;
          next.fg = read(at.color);
        }
        if (at.textStyle !== undefined && (at.fontSize !== undefined || at.fontWeight !== undefined)) {
          // Which of them wins depends on where each is set: the size and weight are not known.
          next.px = null;
          next.weight = null;
        } else if (at.textStyle !== undefined) {
          const raw = at.textStyle;
          const id = linkOf(raw, 'text') ?? (typeof raw === 'string' && tokens.some((t) => t.id === raw && t.group === 'text') ? raw : null);
          const m = id ? textMetrics(tokens, id) : null;
          next.px = m ? maxPx(m.size) : null;
          next.weight = m ? m.weight : undefined;
        } else {
          if (at.fontSize !== undefined) next.px = maxPx(at.fontSize);
          if (at.fontWeight !== undefined) {
            const w = Number(at.fontWeight);
            next.weight = Number.isFinite(w) ? w : 700;
          }
        }
        out.set(key, next);
      }
    return out;
  };

  const check = (n: GraphNode & { kind: 'text' }, paints: Paints) => {
    if (!showsText(n)) return;
    for (const [key, p] of paints) {
      if (p.off || !p.chosen) continue;
      if (p.picture) {
        record({ code: 'TEXT_CONTRAST_UNVERIFIED', nodeId: n.id, kind: p.picture }, key);
        continue;
      }
      if (!p.fg || !p.ground) continue;
      const min = mayBeLarge(n, p) ? LARGE_TEXT_CONTRAST : TEXT_CONTRAST;
      const { ratio, at } = lowest(p.fg, p.ground);
      if (ratio >= min) continue;
      if (p.ground.exact) record({ code: 'TEXT_CONTRAST_LOW', nodeId: n.id, kind: 'low' }, key, { ratio, min, at });
      else record({ code: 'TEXT_CONTRAST_UNVERIFIED', nodeId: n.id, kind: 'overlay' }, key, { ratio, min, at });
    }
  };

  const seen = new Set<string>();
  const visit = (id: string, around: Paints) => {
    const n = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
    if (!n || seen.has(id)) return;
    seen.add(id);
    // What renders only under a condition, or once per item of a list that may be empty, may never show.
    if (n.kind === 'repeat' || (n as { when?: unknown }).when !== undefined || (n as { unless?: unknown }).unless !== undefined) return;
    if (n.kind === 'element' || n.kind === 'text') {
      const paints = inside(n, around);
      if (!paints) return;
      if (n.kind === 'text') return check(n, paints);
      return n.children.forEach((c) => visit(c, paints));
    }
    if (n.kind !== 'instance') return;
    // A placed component's markup and stylesheet are its own: what is placed in its slots starts from nothing known,
    // though it stays hidden wherever the placement is. A part of it hidden at some size may hold the slot: nothing
    // placed in it is read then.
    const hides = (rs: unknown) => !!rs && typeof rs === 'object' && Object.values(rs).some((props) => !!props && typeof props === 'object' && 'hidden' in props);
    if (Object.entries(n.overrides ?? {}).some(([part, rs]) => part !== 'root' && hides(rs))) return;
    if (Object.values(n.itemOverrides ?? {}).some((io) => Object.values(io?.items ?? {}).some(hides))) return;
    const root = cascadeStyles([{ styles: n.overrides?.root, strength: 1 }]);
    const fresh: Paints = new Map([...around].map(([key, p]) => [key, unknown({ ...p, off: p.off || root[key.split('|')[0] as Size]?.hidden === true })]));
    for (const ids of Object.values(n.slots ?? {})) if (Array.isArray(ids)) ids.forEach((c) => visit(c, fresh));
  };
  tree.rootIds.forEach((id) => visit(id, start));

  const out: Diagnostic[] = [];
  for (const f of found.values()) {
    const n = tree.nodes[f.nodeId] as GraphNode & { kind: 'text' };
    const name = quote(state, n);
    const where = whereText(f.keys, schemes);
    const subject = where ? name : `${name[0].toUpperCase()}${name.slice(1)}`;
    const w = f.worst;
    const keyRatios = w ? formatRatio(w.ratio) : '';
    // One measure everywhere it holds, or the lowest of several.
    const asLittle = w && f.best !== undefined && formatRatio(f.best) !== keyRatios ? 'as little as ' : '';
    let message: string;
    if (f.kind === 'low')
      message = `${label}: ${where}${subject} is hard to read: its color has ${asLittle}${keyRatios}:1 contrast with the background behind it, and text ${w!.min === TEXT_CONTRAST ? 'this size' : 'even this large'} needs at least ${w!.min}:1. Choose a text color or a background that stands further apart.`;
    else if (f.kind === 'overlay')
      message = `${label}: ${where}${subject} sits on a background picture that shows through the color over it, so where the picture is ${w!.at === 'close' ? 'close to the text’s color' : w!.at} it has as little as ${keyRatios}:1 contrast, and text ${w!.min === TEXT_CONTRAST ? 'this size' : 'even this large'} needs at least ${w!.min}:1. Make the overlay stronger, or check that the text reads well across the picture.`;
    else if (f.kind === 'gradient')
      message = `${label}: ${where}${subject} sits on a background picture with a gradient overlay, so its contrast can’t be measured. Check that the text reads well across the picture, or choose a solid overlay.`;
    else message = `${label}: ${where}${subject} sits on a background picture with no overlay, so its contrast can’t be measured, and text is hard to read wherever the picture is close to its color. Add an overlay to the picture (Darken, say), or check that the text reads well across it.`;
    out.push({ severity: 'warning', code: f.code, message, owner, nodeId: f.nodeId, site: JSON.stringify([f.nodeId, f.kind]) });
  }
  return out;
}
