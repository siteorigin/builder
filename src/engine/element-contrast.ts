import type { GraphNode, NodeTree, OwnerRef, ProjectState, StyleProps, StyleValue, TokenDef } from '@shared/types';
import { isBinding, parseStyleScopeKey } from '@shared/types';
import { cascadeStyles, isGradient, linkOf, parseCustomCss, textMetrics } from '@shared/styles';
import { parseColor, type Rgba } from '@shared/color';
import { compositeOver, contrastBetween, formatRatio, relativeLuminance, TEXT_CONTRAST } from '@shared/contrast';
import { hasDarkPalette, type PaletteScheme } from '@shared/color-scheme';
import { isBackgroundImageValue, isPictureAsset } from '@shared/background-image';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { getTheme } from '@catalogue/index';
import { detachedClasses, effectiveTokens, pageNodeClass } from '@generator/index';
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
 *   one could show any part of the picture, so the text is checked against it over both black and white, and is said
 *   to need checking when either may be hard to read. A picture with no overlay, or a gradient one, can't be measured,
 *   so its text is said to need checking rather than passed.
 * - Only what is known for certain is measured, since a wrong warning is worse than a missed one. The page starts
 *   with the theme's text colour on its page background; inside a placed component, whose own markup and stylesheet
 *   may paint anything, nothing is known until an element of the page sets a colour or a background again. A theme
 *   rule that may paint an element, custom CSS that may, a width range of its container, a fade (opacity) or a colour
 *   this cannot read leaves its text unmeasured. Hover, focus and press states are not read.
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

/** What paints the text at one screen size in one palette. */
interface Paint {
  /** Nothing shows here: hidden, or inside something that is. Also set where nothing inside can be read (a fade). */
  off: boolean;
  /** The text colour, possibly see-through; null when not known. */
  fg: Rgba | null;
  /** What is behind; null when not known. */
  ground: Ground | null;
  /** A background picture behind with no solid overlay: what this can't measure. */
  picture: Picture | null;
  /** An element on the way set a text colour, a background or a picture. */
  chosen: boolean;
  /** The text size set on the way, in CSS pixels at most; undefined for the theme's own, null for one this can't read. */
  px: number | null | undefined;
  /** The weight set on the way; undefined for the theme's own. */
  weight: number | undefined;
}

type Key = `${Size}|${PaletteScheme}`;
type Paints = Map<Key, Paint>;

/** Style properties that decide what this reads: set in a container width range, they leave it unknown. */
const READ_PROPS = new Set(['color', 'background', 'backgroundImage', 'opacity', 'hidden', 'customCss', 'textStyle', 'fontSize', 'fontWeight', 'backdropBlur']);
/** Custom CSS that may paint text, or what is behind it, or change its size. */
const PAINT_CSS = /^(color|-webkit-text-fill-color|background(-[a-z-]+)?|opacity|filter|backdrop-filter|-webkit-backdrop-filter|mix-blend-mode|font(-size|-weight)?|display|visibility|content-visibility)$/;
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

/** The lowest contrast `fg` can have over a ground, and whether that is at its lighter end. */
function lowest(fg: Rgba, ground: Ground): { ratio: number; light: boolean } {
  const lo = contrastBetween(compositeOver(fg, ground.lo), ground.lo);
  if (ground.exact) return { ratio: lo, light: false };
  const hi = contrastBetween(compositeOver(fg, ground.hi), ground.hi);
  // An opaque colour as light as some colour between the ends can't be told from it there.
  const l = relativeLuminance(fg);
  if (fg.a >= 1 && l >= relativeLuminance(ground.lo) && l <= relativeLuminance(ground.hi)) return { ratio: 1, light: hi <= lo };
  return hi < lo ? { ratio: hi, light: true } : { ratio: lo, light: false };
}

const HEADING = /^h[1-6]$/;

/** Whether text may be large enough to need only 3:1. */
function mayBeLarge(n: GraphNode & { kind: 'text' }, p: Paint): boolean {
  const heading = typeof n.tag !== 'string' || HEADING.test(n.tag);
  if (p.px === undefined) return heading;
  if (p.px === null) return true;
  return p.px >= 24 || (p.px >= 18.66 && (p.weight === undefined ? heading : p.weight >= 700));
}

/** Whether a text node shows any text. */
function showsText(n: GraphNode & { kind: 'text' }): boolean {
  if (isBinding(n.text)) return true;
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

interface Finding {
  code: 'TEXT_CONTRAST_LOW' | 'TEXT_CONTRAST_UNVERIFIED';
  nodeId: string;
  /** What kind of finding it is, for telling them apart. */
  kind: string;
  keys: Key[];
  /** The lowest contrast found, the minimum it needed, and whether it was at the picture's lighter parts. */
  worst?: { ratio: number; min: number; light: boolean };
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
    return { theme, schemes, palettes };
  };
  const context = keep ? keep.shared('elementContrast', shared) : shared();
  const trees: Array<{ owner: OwnerRef; tree: NodeTree; label: string }> = [
    { owner: { kind: 'shell', id: 'header' }, tree: state.site.shell.header, label: 'Header' },
    { owner: { kind: 'shell', id: 'footer' }, tree: state.site.shell.footer, label: 'Footer' }
  ];
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
  { theme, schemes, palettes }: { theme: ThemeLayoutRules; schemes: PaletteScheme[]; palettes: Array<{ scheme: PaletteScheme; tokens: TokenDef[]; read: ReturnType<typeof colorReader> }> }
): Diagnostic[] {
  if (!tree || typeof tree !== 'object' || !tree.nodes || !Array.isArray(tree.rootIds)) return [];
  const found = new Map<string, Finding>();
  const record = (f: Omit<Finding, 'keys' | 'worst' | 'best'>, key: Key, worst?: Finding['worst']) => {
    const id = `${f.code}|${f.nodeId}|${f.kind}`;
    const kept = found.get(id) ?? found.set(id, { ...f, keys: [] }).get(id)!;
    kept.keys.push(key);
    if (worst && (!kept.worst || worst.ratio < kept.worst.ratio)) kept.worst = worst;
    if (worst && (kept.best === undefined || worst.ratio > kept.best)) kept.best = worst.ratio;
  };

  /** The page as it starts: the theme's text colour on its page background (painted over white). */
  const start: Paints = new Map();
  for (const { scheme, read } of palettes) {
    const fg = read({ token: 'color.text' });
    const page = read({ token: 'color.background' });
    for (const size of SIZES)
      start.set(`${size}|${scheme}`, { off: false, fg, ground: page ? over(page, { lo: WHITE, hi: WHITE, exact: true }) : null, picture: null, chosen: false, px: undefined, weight: undefined });
  }
  /**
   * Inside a placed component: nothing is known of what paints it but where it is hidden. Text placed in it keeps the
   * size it would have, since a component's stylesheet sizes its own text, not what is placed in its slots.
   */
  const unknown = (p: Paint): Paint => ({ ...p, fg: null, ground: null, picture: null, chosen: false });

  /** The paints inside an element, from the ones around it; null when nothing inside can be read. */
  const inside = (n: GraphNode & { kind: 'element' | 'text' }, around: Paints): Paints | null => {
    const tag = n.tag;
    const renders = typeof tag === 'string' ? [tag, ...(n.kind === 'element' && n.link !== undefined ? ['a'] : [])] : undefined;
    if (theme.reaches([pageNodeClass(n.id), ...detachedClasses(n)], renders)) return null;
    const styles = n.styles && typeof n.styles === 'object' ? n.styles : {};
    for (const [scope, props] of Object.entries(styles)) {
      const parsed = parseStyleScopeKey(scope);
      if (!parsed || parsed.state || !props || typeof props !== 'object') continue;
      // A container's width this can't know decides it.
      if (!(RESTING as readonly string[]).includes(parsed.scope) && Object.keys(props).some((p) => READ_PROPS.has(p))) return null;
      const css = (props as StyleProps).customCss;
      if (typeof css === 'string' && parseCustomCss(css).decls.some((d) => PAINT_CSS.test(d.slice(0, d.indexOf(':')).trim().toLowerCase()))) return null;
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
        if (opacity !== undefined && !(Number(opacity) >= 1)) next.off = true;
        if (at.backdropBlur !== undefined) next.off = true;
        if (at.background !== undefined) {
          next.chosen = true;
          const bg = typeof at.background === 'string' && isGradient(at.background) ? null : read(at.background);
          next.ground = bg ? over(bg, next.ground) : null;
          if (!bg || bg.a >= 1) next.picture = null;
        }
        const image = at.backgroundImage;
        const asset = isBackgroundImageValue(image) && Object.hasOwn(state.assets.assets, image.assetId) ? state.assets.assets[image.assetId] : undefined;
        if (isBackgroundImageValue(image) && isPictureAsset(asset)) {
          next.chosen = true;
          const scrim = typeof image.scrim === 'string' && image.scrim.trim() ? image.scrim.trim() : null;
          const solid = scrim && !isGradient(scrim) ? parseColor(scrim) : null;
          if (!scrim) [next.ground, next.picture] = [null, 'bare'];
          else if (!solid) [next.ground, next.picture] = [null, 'gradient'];
          else {
            // The picture may be any colour where the text sits: an overlay over it lies between its own colour over
            // black and over white.
            next.ground = over(solid, solid.a >= 1 ? null : { lo: BLACK, hi: WHITE, exact: false });
            next.picture = null;
          }
        }
        if (at.color !== undefined) {
          next.chosen = true;
          next.fg = read(at.color);
        }
        if (at.textStyle !== undefined) {
          const id = linkOf(at.textStyle, 'text');
          const m = id ? textMetrics(tokens, id) : null;
          next.px = m ? maxPx(m.size) : null;
          next.weight = m ? m.weight : undefined;
        }
        if (at.fontSize !== undefined) next.px = maxPx(at.fontSize);
        if (at.fontWeight !== undefined) {
          const w = Number(at.fontWeight);
          next.weight = Number.isFinite(w) ? w : 700;
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
      const { ratio, light } = lowest(p.fg, p.ground);
      if (ratio >= min) continue;
      if (p.ground.exact) record({ code: 'TEXT_CONTRAST_LOW', nodeId: n.id, kind: 'low' }, key, { ratio, min, light });
      else record({ code: 'TEXT_CONTRAST_UNVERIFIED', nodeId: n.id, kind: 'overlay' }, key, { ratio, min, light });
    }
  };

  const seen = new Set<string>();
  const visit = (id: string, around: Paints) => {
    const n = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'repeat') return n.children.forEach((c) => visit(c, around));
    if (n.kind === 'element' || n.kind === 'text') {
      const paints = inside(n, around);
      if (!paints) return;
      if (n.kind === 'text') return check(n, paints);
      return n.children.forEach((c) => visit(c, paints));
    }
    if (n.kind !== 'instance') return;
    // A placed component's markup and stylesheet are its own: what is placed in its slots starts from nothing known,
    // though it stays hidden wherever the placement is.
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
      message = `${label}: ${where}${subject} sits on a background picture its overlay lets show through, so where the picture is ${w!.light ? 'light' : 'dark'} it has as little as ${keyRatios}:1 contrast, and text ${w!.min === TEXT_CONTRAST ? 'this size' : 'even this large'} needs at least ${w!.min}:1. Make the overlay stronger, or check that the text reads well across the picture.`;
    else if (f.kind === 'gradient')
      message = `${label}: ${where}${subject} sits on a background picture with a gradient overlay, so its contrast can’t be measured. Check that the text reads well across the picture, or choose a solid overlay.`;
    else message = `${label}: ${where}${subject} sits on a background picture with no overlay, so its contrast can’t be measured, and text is hard to read wherever the picture is close to its color. Add an overlay to the picture (Darken, say), or check that the text reads well across it.`;
    out.push({ severity: 'warning', code: f.code, message, owner, nodeId: f.nodeId, site: JSON.stringify([f.nodeId, f.kind]) });
  }
  return out;
}
