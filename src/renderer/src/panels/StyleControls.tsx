import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, EyeOff, Monitor, Palette, RotateCcw, Smartphone, Tablet } from 'lucide-react';
import type { ResponsiveScope, ResponsiveStyles, StyleTokenRef, StyleValue, TokenDef } from '@shared/types';
import { parseStyleScopeKey } from '@shared/types';
import { STYLE_GROUP_LABELS, STYLE_PROPS, STYLE_PROP_MAP, VIEWPORT_PRESETS, colorAtStrength, cssRivals, partStrength, styleDeclOrder, withColumnSizes, type StylePropDef } from '@shared/styles';
import { parseColor } from '@shared/color';
import { cascadedStyle, cropAxis, parseFocus, parseRatio } from '@shared/focus';
import { ColorPick } from '../components/ColorPick';
import { FocusEditor, type FocusImage } from './FocusEditor';
import { DraftInput } from '../components/ui';
import { setState, setViewport, useStore } from '../store';
import { allSizesReach, readStyleNumber, refinementShown, styleReached, styleUnder } from '../lib/style-source';

type Size = Exclude<ResponsiveScope, 'base'>;
const SIZES: Size[] = ['phone', 'tablet', 'desktop'];
const SCOPE_LABEL: Record<ResponsiveScope, string> = { base: 'All sizes', phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop' };
const SIZE_ICON: Record<Size, typeof Monitor> = { phone: Smartphone, tablet: Tablet, desktop: Monitor };
const SIZE_RANGE: Record<Size, string> = { phone: 'narrower than 768px', tablet: '768 to 1023px wide', desktop: '1024px and wider' };
/** Where a label in the shared list would repeat its own group heading. */
const LABELS: Record<string, string> = { layout: 'Arrange', fontSize: 'Text size' };
const labelOf = (p: StylePropDef) => LABELS[p.id] ?? p.label;
/** A property's name as the inspector shows it, for other views of the same styles (Paste style). */
export const styleLabel = (id: string, fallback: string) => (Object.hasOwn(STYLE_PROP_MAP, id) ? labelOf(STYLE_PROP_MAP[id]) : fallback);

const sizeForWidth = (w: number): Size => (w < 768 ? 'phone' : w < 1024 ? 'tablet' : 'desktop');
/** Whether a size has changes of its own: resting, or in a hover, focus or pressed state there (which its reset clears). */
const has = (s: ResponsiveStyles | undefined, scope: ResponsiveScope) => Object.entries(s ?? {}).some(([k, v]) => parseStyleScopeKey(k)?.scope === scope && !!v && Object.keys(v).length > 0);
/** The resting rules of a set of styles: what the controls show. */
const restingRules = (s: ResponsiveStyles | undefined) => Object.entries(s ?? {}).flatMap(([k, v]) => (parseStyleScopeKey(k)?.state === undefined ? [v] : []));
const listJoin = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

const tokenOf = (tokens: TokenDef[], id: string) => tokens.find((t) => t.id === id);
const isToken = (v: StyleValue | undefined): v is StyleTokenRef => typeof v === 'object' && v !== null;
/** A link's strength as a whole percentage, for a colour painted see-through. */
const strengthText = (ref: StyleTokenRef) => `${Math.round((ref.alpha ?? 1) * 1000) / 10}%`;

/** A site style's final value, following aliases (one style pointing at another). */
function resolved(tokens: TokenDef[], id: string, depth = 0): TokenDef['value'] | undefined {
  const t = tokenOf(tokens, id);
  if (!t) return undefined;
  if (typeof t.value === 'object' && 'token' in t.value && depth < 5) return resolved(tokens, (t.value as { token: string }).token, depth + 1);
  return t.value;
}

/** A site style as the panel names it everywhere: its label, plus its size when that is short enough to help. */
function tokenText(def: StylePropDef, tokens: TokenDef[], id: string): string {
  const t = tokenOf(tokens, id);
  if (!t) return id;
  const v = resolved(tokens, id);
  if (def.kind === 'length' && typeof v === 'string' && v.length < 14) return `${t.label} · ${v}`;
  if (def.kind === 'textStyle' && v && typeof v === 'object' && 'size' in v && v.size.length < 14) return `${t.label} · ${v.size}`;
  return t.label;
}

/** A text style saved the older way, as its bare ID ("text.h2"), read as the Site styles link it is. */
const linkOf = (def: StylePropDef, v: StyleValue | undefined): StyleValue | undefined =>
  def.kind === 'textStyle' && typeof v === 'string' && /^text\.[a-z0-9-]+$/.test(v.trim()) ? { token: v.trim() } : v;
/** Whether a value is a Site styles link, however it was saved. */
export const isStyleLink = (def: StylePropDef, v: StyleValue | undefined) => isToken(linkOf(def, v));
/** A unit as the panel writes it after a number: degrees as °, scale as ×. */
const unitText = (def: StylePropDef) => (def.unit === 'deg' ? '°' : def.id === 'scale' ? '×' : def.unit ? ` ${def.unit}` : '');

/** How a value reads in the panel: a site style by name (with its size when short), an option by its label. */
export function describeStyleValue(def: StylePropDef, raw: StyleValue | undefined, tokens: TokenDef[]): string {
  const v = linkOf(def, raw);
  if (v === undefined) return '';
  if (isToken(v)) return partStrength(v) ? `${tokenText(def, tokens, v.token)} at ${strengthText(v)}` : tokenText(def, tokens, v.token);
  if (def.kind === 'boolean') return def.id === 'hidden' ? (v ? 'Hidden' : 'Visible') : v ? 'Yes' : 'No';
  return def.options?.find((o) => o.value === String(v))?.label ?? (typeof v === 'number' ? `${v}${unitText(def)}` : def.unit ? `${v} ${def.unit}` : String(v));
}

function colorOf(tokens: TokenDef[], id: string): string {
  const v = resolved(tokens, id);
  return typeof v === 'string' ? v : 'transparent';
}

/**
 * The colour a link paints, written out: the site style's colour, at the link's strength when below full, as
 * rgb() with that opacity where the colour can be read (so the colour picker starts from it).
 */
function linkedColor(tokens: TokenDef[], ref: StyleTokenRef): string {
  const color = colorOf(tokens, ref.token);
  if (!partStrength(ref)) return color;
  const c = parseColor(color);
  const a = Number(((c?.a ?? 1) * ref.alpha!).toPrecision(4));
  return c ? `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)} / ${a})` : colorAtStrength(color, ref.alpha!);
}

/** The colour a colour value paints, for a swatch beside its name; undefined for anything that isn't a colour. */
export function styleSwatch(def: StylePropDef, v: StyleValue | undefined, tokens: TokenDef[]): string | undefined {
  if (def.kind !== 'color' || v === undefined) return undefined;
  return isToken(v) ? linkedColor(tokens, v) : String(v);
}

/** The scope control: which screen sizes the next change applies to, and which sizes already hold changes. */
export function ScopePicker({ styles }: { styles?: ResponsiveStyles }) {
  const scope = useStore((s) => s.styleScope);
  const viewport = useStore((s) => s.viewport);
  const preview = sizeForWidth(viewport);
  const ref = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const noteId = useId();
  const previewId = useId();
  const nowId = useId();
  const [focusAfter, setFocusAfter] = useState(false);

  // Stay in view under the inspector's own sticky header while the Style section scrolls, and keep focused
  // controls from scrolling in underneath the two of them.
  useEffect(() => {
    const el = ref.current;
    const head = el?.closest('.panel-body')?.querySelector<HTMLElement>('.insp-head');
    if (!el || !head) return;
    const place = () => {
      el.style.setProperty('--style-scope-top', `${head.offsetHeight}px`);
      el.parentElement?.style.setProperty('--style-scroll-top', `${head.offsetHeight + el.offsetHeight + 12}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(head);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // After a shortcut changes the scope, keyboard focus lands on the newly selected size.
  useEffect(() => {
    if (!focusAfter) return;
    group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    setFocusAfter(false);
  }, [focusAfter, scope]);

  const choose = (v: ResponsiveScope, focus = false) => {
    setState({ styleScope: v });
    if (focus) setFocusAfter(true);
  };
  const order: ResponsiveScope[] = ['base', ...SIZES];
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    const jump = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : -1;
    if (!step && jump < 0) return;
    e.preventDefault();
    const next = jump >= 0 ? order[jump] : order[(order.indexOf(scope) + step + order.length) % order.length];
    choose(next, true);
  };

  const sized = SIZES.filter((s) => has(styles, s));
  // What the canvas is showing, when that is not what is being edited.
  const mismatch = scope === 'base' ? preview !== 'desktop' : scope !== preview;
  // Editing changes the canvas only at the previewed size: one size being edited away from it hides them.
  const hidden = scope !== 'base' && scope !== preview;
  const PreviewIcon = SIZE_ICON[preview];
  const ScopeIcon = SIZE_ICON[scope === 'base' ? preview : scope];
  return (
    <div className="style-scope" ref={ref}>
      <div className="style-scope-head">
        <div className="style-scope-label" id={labelId}>
          Edit styles for
        </div>
        <span className="style-scope-now" id={nowId} title={`The canvas is showing the ${preview} size`}>
          <PreviewIcon aria-hidden="true" />
          {SCOPE_LABEL[preview]} preview
        </span>
      </div>
      <div
        ref={group}
        className={`style-scope-picker${scope !== 'base' ? ' one-size' : ''}`}
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={[noteId, nowId, mismatch ? previewId : ''].join(' ').trim()}
        onKeyDown={onKeyDown}
      >
        {order.map((v) => {
          const marked = v === 'base' ? has(styles, 'base') : sized.includes(v as Size);
          return (
            <button key={v} type="button" role="radio" aria-checked={scope === v} tabIndex={scope === v ? 0 : -1} onClick={() => choose(v)} title={marked ? (v === 'base' ? 'Has changes for all sizes' : `${SCOPE_LABEL[v]} has its own changes`) : undefined}>
              {SCOPE_LABEL[v]}
              {marked && (
                <>
                  <span className="style-scope-dot" aria-hidden="true" />
                  <span className="sr-only">{v === 'base' ? ', has changes for all sizes' : ', has its own changes'}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      <p className="style-scope-note" id={noteId}>
        {scope === 'base' ? (
          'Changes apply at every size, except where a size has its own value.'
        ) : (
          <>
            <strong>{SCOPE_LABEL[scope]} only</strong>, {SIZE_RANGE[scope]}. Other sizes keep their values.
          </>
        )}
      </p>
      {mismatch && (
        <p className={`style-scope-preview${hidden ? ' hides' : ''}`} id={previewId}>
          {hidden ? <EyeOff aria-hidden="true" /> : <ScopeIcon aria-hidden="true" />}
          <span>
            {hidden ? `Changes for ${scope} don’t show in the ${preview} preview.` : `To change ${preview} alone,`}{' '}
            {hidden ? (
              <button type="button" className="style-scope-link" onClick={() => {
                  setViewport(VIEWPORT_PRESETS[scope as Size]);
                  setFocusAfter(true);
                }}
              >
                Preview {scope}
              </button>
            ) : (
              <button type="button" className="style-scope-link" onClick={() => choose(preview, true)}>
                Edit {preview} only
              </button>
            )}
          </span>
        </p>
      )}
    </div>
  );
}

export function StyleControls({
  styles,
  inherited,
  allowed,
  tokens,
  onSet,
  onReset,
  resetLabel,
  target,
  designSizesWin,
  image,
  wideColumns
}: {
  styles: ResponsiveStyles | undefined;
  inherited: ResponsiveStyles | undefined;
  allowed?: string[];
  tokens: TokenDef[];
  /**
   * `expectedRevision`: the change applies only to the project as it was then (a drag started there). What it
   * returns may be the change's promise, settling to null when the project refused it.
   */
  onSet: (prop: string, value: StyleValue | null, expectedRevision?: number) => unknown;
  /** Clears this element's changes: at one size when a size is given, otherwise at every size. */
  onReset?: (scope?: ResponsiveScope) => void;
  /** Replaces the every-size reset's wording (for example, "Restore original design"). */
  resetLabel?: string;
  /** What the reset covers, when it is narrower than everything on screen (for example, "the split hero itself"). */
  target?: string;
  /**
   * True when `inherited` is this same element's own design (editing a component everywhere): its values for
   * one size then win over a change made for All sizes, as they do on the page.
   */
  designSizesWin?: boolean;
  /** For an image: the picture Image focus is chosen on, and the rules under these styles. */
  image?: FocusImage;
  /**
   * `styles` are a placement's overrides (or a variant's): the stylesheet keeps a multi-column value set for All
   * sizes off phones, where the design's own layout still applies.
   */
  wideColumns?: boolean;
}) {
  const scope = useStore((s) => s.styleScope);
  const viewport = useStore((s) => s.viewport);
  const preview = sizeForWidth(viewport);
  // The selected element's box on the canvas, for a crop no aspect ratio declares (a fixed height, say).
  const selectedBox = useStore((s) => (image ? s.rects.selected[0] : undefined));
  // The groups opened to show every option they hold.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const moreId = useId();
  const resetHintId = useId();
  const root = useRef<HTMLDivElement>(null);
  // Where keyboard focus goes once an action has removed the control that had it: the first of these
  // selectors that exists after the next update.
  const pendingFocus = useRef<string[] | null>(null);
  useEffect(() => {
    const want = pendingFocus.current;
    if (!want || !root.current) return;
    for (const sel of want) {
      const el = root.current.querySelector<HTMLElement>(sel);
      if (el) {
        el.focus();
        break;
      }
    }
    pendingFocus.current = null;
  });
  const focusNext = (...selectors: string[]) => {
    if (root.current?.contains(document.activeElement)) pendingFocus.current = selectors;
  };
  // A value set outside the offered controls (by the AI, say) still gets a row, so it can be seen and reset.
  const setOutside = allowed?.length ? [...new Set(restingRules(styles).flatMap((sc) => Object.keys(sc ?? {})))].filter((id) => !allowed.includes(id)) : [];
  const props = allowed?.length ? [...allowed, ...setOutside].map((id) => STYLE_PROP_MAP[id]).filter(Boolean) : STYLE_PROPS;
  const groups = new Map<StylePropDef['group'], StylePropDef[]>();
  for (const p of props) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const own = styles?.[scope] ?? {};
  const offered = (id: string) => !allowed?.length || allowed.includes(id);
  // Under All sizes every size counts, so a phone-only preset still offers the duration that would apply to it.
  const reached = (id: string) => styleReached({ prop: id, scope, styles, inherited, designSizesWin, wideColumns });
  // Layout controls that only mean something for a stack or grid show when the layout is one at a size the edit
  // reaches, and offsets when the element is positioned there: a stack on phones offers Gap under All sizes.
  const layouts = reached('layout');
  const flexLike = layouts.some((l) => l === 'stack' || l === 'row' || l === 'grid');
  const grid = layouts.includes('grid');
  const positioned = reached('position').some((v) => v !== 'static');
  // Set at any size: such a row always shows, so "From All sizes" and "Phone uses …" are never hidden.
  const setAnywhere = (id: string) => own[id] !== undefined || restingRules(styles).some((sc) => sc?.[id] !== undefined);
  const relevant = (id: string) => {
    if (setAnywhere(id)) return true;
    if (id === 'order') return false;
    if (id === 'columns' || id === 'gridTemplate') return grid;
    if (id === 'align' || id === 'justify' || id === 'gap' || id === 'wrap' || id === 'rowGap' || id === 'columnGap') return flexLike;
    // Offsets do nothing until the element is positioned.
    if (id === 'inset') return positioned;
    // An origin, duration or easing shows once what it refines is in effect.
    return refinementShown(id, reached, offered) ?? true;
  };
  // Long lists show the common controls of the first two groups plus anything already set; each group's other
  // controls open from its heading.
  const entries = [...groups.entries()];
  const long = entries.reduce((n, [, l]) => n + l.filter((p) => relevant(p.id)).length, 0) > 10;
  const primary = new Set(entries.slice(0, 2).map(([g]) => g));
  const isPrimary = (g: StylePropDef['group'], p: StylePropDef) => !long || (primary.has(g) && !p.advanced);
  const tucked = (g: StylePropDef['group'], p: StylePropDef) => !isPrimary(g, p) && relevant(p.id) && !setAnywhere(p.id);
  const total = Object.values(styles ?? {}).reduce((n, s) => n + Object.keys(s ?? {}).length, 0);
  // A size's reset clears its hover, focus and pressed changes with it, so they count as its changes.
  const here = Object.entries(styles ?? {}).reduce((n, [k, s]) => n + (parseStyleScopeKey(k)?.scope === scope ? Object.keys(s ?? {}).length : 0), 0);
  const sizeName = (s: ResponsiveScope) => SCOPE_LABEL[s].toLowerCase();

  const row = (p: StylePropDef) => {
    const value = own[p.id];
    const label = labelOf(p);
    // What shows through when nothing is set here, and where it comes from.
    const shows = styleUnder({ prop: p.id, scope, styles, inherited, designSizesWin, wideColumns });
    const under = shows.value;
    const underText = describeStyleValue(p, under, tokens);
    const underFrom = shows.from === 'all-sizes' ? 'From All sizes' : shows.from === 'design' ? 'From the design' : undefined;
    // Under All sizes, a size with its own value here wins over whatever is set for all sizes; so does the
    // design's own value for the previewed size when nothing here overrides it (or, for a component's own
    // design, whenever it has one).
    // A column count that the same styles' column sizes override is never written, so it is no exception.
    const written = styles ? withColumnSizes(styles) : styles;
    const exceptions = scope === 'base' ? SIZES.filter((s) => written?.[s]?.[p.id] !== undefined) : [];
    const lines: Array<{ text: string; previewed?: boolean; quiet?: boolean }> = [];
    // A size's own value, led by what it means for the canvas when that size is the one previewed.
    // A value never breaks across its own separator ("2XS · 4px").
    const whole = (v: StyleValue) => describeStyleValue(p, v, tokens).replace(/ · /g, '\u00a0·\u00a0');
    const uses = (s: Size, v: StyleValue, from = '') => ({ text: `${SCOPE_LABEL[s]}${s === preview ? ' preview' : ''} uses ${whole(v)}${from}`, previewed: s === preview });
    // Another control writing the same CSS, set at a size: a size's own rule beats All sizes, and within one rule the
    // later declaration wins (Column sizes over Columns). The winner at a size is named on this row.
    // Column sizes set for All sizes also override a column count saved for tablet or desktop: that count is never written.
    const rivalAt = (s: ResponsiveScope) =>
      cssRivals(p.id).find((r) => styles?.[s]?.[r] !== undefined && (styles?.[s]?.[p.id] === undefined || styleDeclOrder(r) > styleDeclOrder(p.id))) ??
      (styles?.[s]?.[p.id] !== undefined && written?.[s]?.[p.id] === undefined ? cssRivals(p.id)[0] : undefined);
    const rivalName = (r: string) => (STYLE_PROP_MAP[r] ? labelOf(STYLE_PROP_MAP[r]) : r);
    const insteadAt = (s: Size) => {
      const r = rivalAt(s);
      return r ? { text: `${SCOPE_LABEL[s]}${s === preview ? ' preview' : ''} uses ${rivalName(r)} instead`, previewed: s === preview } : undefined;
    };
    if (value === undefined && underFrom) lines.push({ text: underFrom, quiet: underFrom === 'From the design' });
    for (const s of exceptions) lines.push(insteadAt(s) ?? uses(s, styles![s]![p.id]!));
    // At one size, a value set here that a rival set here outranks.
    const outranked = scope !== 'base' && value !== undefined ? rivalAt(scope) : undefined;
    if (outranked) lines.push({ text: `${rivalName(outranked)} wins here`, previewed: scope === preview });
    const designAtPreview = inherited?.[preview]?.[p.id];
    // A value for All sizes that the stylesheet keeps off phones (a grid of several columns): phones show the design.
    const ownReachesPreview = allSizesReach(p.id, value, preview, wideColumns);
    const designOnPhone = inherited?.phone?.[p.id];
    const skipsPhone = scope === 'base' && value !== undefined && !exceptions.includes('phone') && !rivalAt('phone') && !allSizesReach(p.id, value, 'phone', wideColumns);
    if (skipsPhone) lines.push(designOnPhone !== undefined ? uses('phone', designOnPhone, ' from the design') : { text: 'Tablet and desktop only', previewed: preview === 'phone' });
    if (scope === 'base' && designSizesWin) {
      // Editing a design: each size it gives its own value keeps that value over any change for All sizes, even one
      // that happens to match it now, so it is always named, size by size.
      for (const s of SIZES) {
        const own = inherited?.[s]?.[p.id];
        if (!exceptions.includes(s) && !(s === 'phone' && skipsPhone) && own !== undefined) lines.push({ text: `${SCOPE_LABEL[s]}${s === preview ? ' preview' : ''} keeps ${whole(own)} from the design`, previewed: s === preview });
      }
    } else if (!skipsPhone && scope === 'base' && !ownReachesPreview && !exceptions.includes(preview) && designAtPreview !== undefined && JSON.stringify(designAtPreview) !== JSON.stringify(inherited?.base?.[p.id]))
      lines.push(uses(preview, designAtPreview, ' from the design'));
    // A size where only a rival is set (nothing of this property's own there) is named too.
    if (scope === 'base')
      for (const s of SIZES) {
        const line = exceptions.includes(s) ? undefined : insteadAt(s);
        if (line) lines.push(line);
      }
    // A change for one size: what its reset brings back, when that is known and different.
    if (scope !== 'base' && value !== undefined && under !== undefined && JSON.stringify(under) !== JSON.stringify(value))
      lines.push({ text: `${underFrom === 'From All sizes' ? 'All sizes has' : 'The design has'} ${whole(under)}` });
    // The previewed size leads: it is why the canvas may not match the value above.
    lines.sort((a, b) => Number(!!b.previewed) - Number(!!a.previewed));
    const sourceId = `${moreId}-${p.id}-src`;
    const resetTo = underText ? ` to ${underText} ${underFrom === 'From All sizes' ? 'from All sizes' : 'from the design'}` : '';
    const resetName = `Reset ${label}${scope === 'base' ? '' : ` on ${sizeName(scope)}`}${resetTo}`;
    return (
      <div className={`style-row${value !== undefined ? ' set' : ''}`} key={p.id} data-prop={p.id}>
        {/* Not a <label>: the reset button beside the name must never be the target of a click on the name.
            Each control carries its own accessible name. */}
        <div className="style-label" title={p.description}>
          <span>{label}</span>
          {value !== undefined && (
            <button
              type="button"
              className="reset-dot"
              title={resetName}
              aria-label={resetName}
              onClick={() => {
                focusNext(`[data-prop="${p.id}"] :is(select, input, textarea)`, `[data-group="${p.group}"] .style-group-toggle`, '[role="radio"][aria-checked="true"]');
                onSet(p.id, null);
              }}
            >
              <RotateCcw aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="style-control">
          <Control def={p} label={label} value={value} under={under} underText={underText} underFrom={underFrom} tokens={tokens} describedBy={lines.length ? sourceId : undefined} onSet={(v) => onSet(p.id, v)} />
        </div>
        {lines.length > 0 && (
          <div className={lines.every((l) => l.quiet) ? 'sr-only' : 'style-source'} id={sourceId}>
            {lines.map((l) => (
              // The design is the expected source of anything not changed here, so it is named for screen
              // readers only; everything else is shown.
              <span key={l.text} className={l.quiet ? 'sr-only' : l.previewed ? 'previewed' : undefined}>
                {/* The same mark as the scope's warning: a change here does not show at the previewed size. */}
                {l.previewed && <EyeOff aria-hidden="true" />}
                {l.text}
              </span>
            ))}
          </div>
        )}
        {p.kind === 'focus' && focusEditor(p, label, value)}
      </div>
    );
  };

  // The crop a focal point is chosen in: the size being edited, or the previewed one under All sizes, worked
  // out the way the exported site applies the rules.
  const focusEditor = (p: StylePropDef, label: string, value: StyleValue | undefined) => {
    const own = image?.own ?? styles;
    const below = image?.below ?? (inherited ? [[inherited]] : []);
    const tiers = [[own], ...below];
    const validFocus = (v: StyleValue) => parseFocus(v) !== null;
    // Under All sizes the crop shown is the previewed size's, unless that size keeps its own focus: then the
    // first size the all-sizes value does reach. When every size keeps its own, it reaches none.
    const keepsOwn = (z: Size) => own?.[z]?.[p.id] !== undefined && validFocus(own[z]![p.id]!);
    const fitAt = (z: Size) => {
      const v = cascadedStyle(tiers, z, 'objectFit');
      return typeof v === 'string' ? v.trim() : v;
    };
    // The ratio the browser applies: a declaration it can't read is skipped, as it skips it; "auto" or a ratio
    // with a zero in it keeps the picture's own shape.
    const readable = (v: StyleValue) => /^(auto|\d+(\.\d+)?(\s*\/\s*\d+(\.\d+)?)?)$/.test(String(v).trim());
    const declaredAt = (z: Size) => parseRatio(cascadedStyle(tiers, z, 'aspectRatio', readable));
    const has = (z: Size, keys: string[]) => tiers.some((t) => t.some((l) => [z, 'base' as const].some((sc) => keys.some((k) => l?.[sc]?.[k] !== undefined))));
    // Among the sizes it reaches, one its ratio crops, so the pad has a crop to show.
    const sourceRatio = image?.width && image.height ? image.width / image.height : null;
    const crops = (z: Size) => {
      const r = declaredAt(z);
      return r !== null && fitAt(z) !== 'contain' && (sourceRatio === null || cropAxis(sourceRatio, r) !== null);
    };
    const reachable = (['desktop', 'tablet', 'phone'] as const).filter((z) => !keepsOwn(z));
    const reached = scope !== 'base' ? scope : !keepsOwn(preview) ? preview : (reachable.find(crops) ?? reachable[0]);
    const size = reached ?? preview;
    // The box's shape: a declared ratio; else, when a height can crop the picture, the box the canvas shows for
    // this size, which is the picture's own box only without borders or custom CSS. Otherwise it is unknown.
    const heightSet = has(size, ['height', 'maxHeight', 'minHeight', 'customCss']);
    const plainBox = !has(size, ['border', 'borderBlockStart', 'borderBlockEnd', 'borderInlineStart', 'borderInlineEnd', 'customCss']);
    const measured = heightSet && plainBox && size === preview && selectedBox && selectedBox.width > 0 && selectedBox.height > 0 ? selectedBox.width / selectedBox.height : null;
    const ratio = declaredAt(size) ?? measured;
    const fit = fitAt(size);
    // Custom CSS is written after these properties, so it can set the crop itself.
    const custom = tiers.some((t) => t.some((l) => [size, 'base' as const].some((sc) => /\b(object-position|object-fit|aspect-ratio)\s*:/i.test(String(l?.[sc]?.customCss ?? '')))));
    // What shows when nothing is set here: this element's value at this size when only its changes are listed
    // (Edit everywhere), its all-sizes value when a size is being edited, then whatever lies under it.
    const current = value === undefined ? own?.[scope]?.[p.id] : undefined;
    const under = (current !== undefined && validFocus(current) ? current : undefined) ?? cascadedStyle([[scope === 'base' ? undefined : { base: own?.base }], ...below], size, p.id, validFocus);
    return (
      <FocusEditor
        label={label}
        value={value}
        under={under}
        scope={scope}
        size={size}
        previewed={size === preview}
        unreached={scope === 'base' && !reached}
        uncertain={ratio === null && heightSet}
        custom={custom}
        ratio={ratio}
        fit={fit}
        image={image}
        onSet={(v, rev) => onSet(p.id, v, rev)}
      />
    );
  };

  // Each group once, in registry order. A group in a long list shows its common rows and anything set at any size;
  // the rest open from its own heading, so every group is a direct way in.
  const groupList = entries
    .map(([g, list]) => {
      const rel = list.filter((p) => relevant(p.id));
      const visible = rel.filter((p) => !tucked(g, p));
      return { g, rel, visible, hidden: rel.length - visible.length };
    })
    .filter((x) => x.rel.length);
  const toggle = (g: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(g)) next.add(g);
      return next;
    });
  const group = ({ g, rel, visible, hidden }: (typeof groupList)[number]) => {
    const expanded = hidden > 0 && open.has(g);
    const title = STYLE_GROUP_LABELS[g];
    const bodyId = `${moreId}-${g}`;
    const more = visible.length ? `${hidden} more` : `${hidden} option${hidden === 1 ? '' : 's'}`;
    return (
      <div key={g} className="style-group" role="group" aria-label={title} data-group={g}>
        {hidden > 0 ? (
          <button type="button" className="style-group-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => toggle(g)}>
            <span className="style-group-name">{title}</span>
            <span className="style-group-count">
              {expanded ? (visible.length ? 'Fewer' : 'Hide') : more}
              <ChevronRight aria-hidden="true" />
            </span>
          </button>
        ) : (
          <div className="style-group-title" aria-hidden="true">
            {title}
          </div>
        )}
        <div id={bodyId} className="style-group-body">
          {(expanded ? rel : visible).map(row)}
        </div>
      </div>
    );
  };

  const size = SCOPE_LABEL[scope];
  const subject = target ? ` to ${target}` : '';
  // The reset clears the size being edited and nothing else; clearing every size is a separate, named choice.
  const others = total - here;
  const resetText = scope === 'base' && resetLabel && !others ? resetLabel : `Reset ${here === 1 ? 'the change' : `${here} changes`} for ${size}`;
  const resetHint =
    scope === 'base'
      ? others
        ? `Clears ${here === 1 ? 'the change' : 'the changes'} made for all sizes${subject}. Changes made for one size stay.`
        : `Clears ${here === 1 ? 'the style change' : 'every style change'}${subject || ' made here'}.`
      : `Clears only ${here === 1 ? `this ${sizeName(scope)} change` : `the ${sizeName(scope)} changes`}${subject}. All sizes and the other sizes stay as they are.`;
  const everyText = resetLabel ?? `Reset ${total === 1 ? '1 change' : `all ${total} changes`} at every size`;
  const everyHint = `Clears ${others === 1 ? 'the change' : 'the changes'} made for single sizes${subject}.`;
  return (
    <div className="style-controls" ref={root}>
      <ScopePicker styles={styles} />
      {groupList.map(group)}
      {onReset && (here > 0 || (scope === 'base' && others > 0)) && (
        <div className="style-footer">
          {here > 0 && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                aria-describedby={resetHintId}
                onClick={() => {
                  // The button goes with its changes. Focus lands on the size, never on the wider reset below.
                  focusNext('[role="radio"][aria-checked="true"]');
                  onReset(scope);
                }}
              >
                <RotateCcw aria-hidden="true" /> {resetText}
              </button>
              <span className="style-footer-hint" id={resetHintId}>
                {resetHint}
              </span>
            </>
          )}
          {/* Under All sizes, the changes made for single sizes can go too, in one step. */}
          {scope === 'base' && others > 0 && (
            <>
              <button
                type="button"
                className={here > 0 ? 'link-btn style-footer-every' : 'btn btn-sm'}
                aria-describedby={here > 0 ? undefined : resetHintId}
                onClick={() => {
                  focusNext('[role="radio"][aria-checked="true"]');
                  onReset(undefined);
                }}
              >
                {here > 0 ? everyText : <><RotateCcw aria-hidden="true" /> {everyText}</>}
              </button>
              {here === 0 && (
                <span className="style-footer-hint" id={resetHintId}>
                  {everyHint}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function tokenOptions(tokens: TokenDef[], group: StylePropDef['tokenGroup']) {
  const groups = Array.isArray(group) ? group : group ? [group] : [];
  return tokens.filter((t) => groups.includes(t.group));
}

/** The mark for a value linked to Site styles: the colour itself for a colour, the Site styles glyph otherwise. */
function Lead({ def, v, tokens }: { def: StylePropDef; v: StyleTokenRef; tokens: TokenDef[] }) {
  if (def.kind === 'color') return <span className="style-lead swatch" style={{ background: linkedColor(tokens, v) }} aria-hidden="true" />;
  return <Palette className="style-lead" aria-hidden="true" />;
}

function Control({
  def,
  label,
  value: saved,
  under: below,
  underText,
  underFrom,
  tokens,
  describedBy,
  onSet
}: {
  def: StylePropDef;
  label: string;
  value: StyleValue | undefined;
  under: StyleValue | undefined;
  underText: string;
  /** Where the value showing through comes from, named in the open menu. */
  underFrom?: string;
  tokens: TokenDef[];
  describedBy?: string;
  onSet: (v: StyleValue | null) => void;
}) {
  // Choosing "Custom value…" opens an editor first; nothing is written until a value is entered, and the
  // stored value (a site style, a preset) stays in place until then.
  const scope = useStore((s) => s.styleScope);
  const [drafting, setDrafting] = useState(false);
  const picker = useRef<HTMLSelectElement>(null);
  const linkId = useId();
  const draftId = useId();
  const value = linkOf(def, saved);
  const under = linkOf(def, below);
  // A commit, a reset, an undo or another size all end the draft.
  const valueKey = JSON.stringify(value ?? null);
  useEffect(() => setDrafting(false), [scope, valueKey]);
  const tokOpts = tokenOptions(tokens, def.tokenGroup);
  const set = value !== undefined;
  const state = set ? ' is-set' : ' is-inherited';
  const ghostText = underText || 'Default';
  // The "not changed here" choice, grouped under its source so it never reads as picking that value.
  const ghost = underFrom ? (
    <optgroup label={underFrom}>
      <option value="">{ghostText}</option>
    </optgroup>
  ) : (
    <option value="">{ghostText}</option>
  );
  if (def.kind === 'boolean') {
    const yes = def.id === 'hidden' ? 'Hidden' : 'Yes';
    const no = def.id === 'hidden' ? 'Visible' : 'No';
    return (
      <select className={`select sm grow style-select${state}`} value={set ? String(value) : ''} onChange={(e) => onSet(e.target.value === '' ? null : e.target.value === 'true')} aria-label={label} aria-describedby={describedBy}>
        {ghost}
        <option value="true">{yes}</option>
        <option value="false">{no}</option>
      </select>
    );
  }
  if (def.kind === 'enum' || def.kind === 'ratio' || def.kind === 'focus') {
    return (
      <select className={`select sm grow style-select${state}`} value={set ? String(value) : ''} onChange={(e) => onSet(e.target.value === '' ? null : e.target.value)} aria-label={label} aria-describedby={describedBy}>
        {ghost}
        {set && !def.options!.some((o) => o.value === String(value)) && <option value={String(value)}>{String(value)}</option>}
        {def.options!.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (def.kind === 'number') {
    const range = def.min !== undefined && def.max !== undefined ? ` (${def.min} to ${def.max}${unitText(def)})` : '';
    // A set value keeps its unit beside it, so -2 reads as -2°. The unit is drawn after an invisible copy of the
    // number in the field's own type, so it sits right after the digits; it steps aside while typing.
    const unit = set ? unitText(def) : '';
    return (
      <span className={`style-field${unit ? ' has-unit' : ''}`}>
        <DraftInput
          className={`input sm grow style-input${state}`}
          value={set ? String(value) : ''}
          placeholder={underText || `Default${range}`}
          ariaLabel={`${label}${range}`}
          aria-describedby={describedBy}
          onCommit={(t) => {
            // What the field shows ("-2°", "1.05×") reads back as the number it is.
            const n = readStyleNumber(def, t.trim().replace(/\s*[°×]$/, ''));
            if (t.trim() === '') onSet(null);
            else if (n !== null) onSet(n);
            else return false;
          }}
        />
        {unit && (
          <span className={`style-unit${state}`} aria-hidden="true">
            <span className="style-unit-digits">{String(value)}</span>
            {unit}
          </span>
        )}
      </span>
    );
  }
  if (def.kind === 'css') {
    return (
      <DraftInput
        className={`textarea style-input mono${state}`}
        multiline
        rows={3}
        value={set ? String(value) : ''}
        placeholder={def.placeholder}
        ariaLabel={label}
        aria-describedby={describedBy}
        onCommit={(t) => onSet(t.trim() ? t.trim() : null)}
      />
    );
  }
  // Token-capable values: a Site styles picker, plus a custom value on its own line when chosen.
  const linked = isToken(value);
  const literal = set && !linked && !def.options?.some((o) => o.value === String(value));
  const selectValue = drafting || literal ? 'custom' : !set ? '' : linked ? `token:${value.token}` : String(value);
  const custom = selectValue === 'custom';
  const current = set ? value : under;
  const leadValue = custom ? undefined : current;
  const lead = isToken(leadValue) ? leadValue : undefined;
  const linkedName = lead ? `${describeStyleValue(def, lead, tokens)}, from Site styles` : undefined;
  // What a custom value starts from: the value in effect, written out, a linked style followed to its end (a colour
  // at the strength the link paints it).
  const currentEnd = isToken(current) ? (def.kind === 'color' ? linkedColor(tokens, current) : resolved(tokens, current.token)) : current;
  const currentText = currentEnd === undefined || typeof currentEnd === 'object' ? undefined : String(currentEnd);
  // While a custom value is drafted over a stored or inherited one, that one still applies until the draft commits.
  const keeps = set ? describeStyleValue(def, value, tokens) : underText;
  const cancelDraft = () => {
    setDrafting(false);
    requestAnimationFrame(() => picker.current?.focus());
  };
  // What the colour picker starts from: the colour in effect, a linked style followed to its end.
  const colorText = isToken(current) ? linkedColor(tokens, current) : current === undefined ? '' : String(current);
  // A linked colour can be painted see-through: its strength, set here or showing through, and a field to change it.
  const strength = def.kind === 'color' && lead ? lead : undefined;
  const setStrength = (t: string) => {
    const text = t.trim().replace(/\s*%$/, '');
    if (text && !/^(\d+(\.\d+)?|\.\d+)$/.test(text)) return false;
    // In tenths of a percent, as the field shows it.
    const n = text ? Math.round(Number(text) * 10) / 10 : 100;
    if (n > 100) return false;
    // Empty or 100 is full strength: the plain link, kept here only if a strength was set here.
    if (n === 100) {
      if (linked && partStrength(value)) onSet({ token: value.token });
      return;
    }
    onSet({ token: strength!.token, alpha: Math.round(n * 10) / 1000 });
  };
  return (
    <>
      <span className={`style-field${lead ? ' has-lead' : ''}`} title={linkedName}>
        {lead && <Lead def={def} v={lead} tokens={tokens} />}
        {lead && (
          <span id={linkId} className="sr-only">
            {linkedName}
          </span>
        )}
        <select
          ref={picker}
          className={`select sm grow style-select${drafting && !literal ? ' is-drafting' : state}`}
          value={selectValue}
          aria-label={label}
          aria-describedby={[describedBy, lead ? linkId : undefined].filter(Boolean).join(' ') || undefined}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && drafting && !literal) {
              e.preventDefault();
              setDrafting(false);
            }
          }}
          onChange={(e) => {
            const v = e.target.value;
            setDrafting(false);
            if (v === '') onSet(null);
            else if (v === 'custom') setDrafting(true);
            // Another site color keeps the strength the link in effect paints at.
            else if (v.startsWith('token:')) onSet(isToken(current) && partStrength(current) && def.kind === 'color' ? { token: v.slice(6), alpha: current.alpha } : { token: v.slice(6) });
            else onSet(v);
          }}
        >
          {ghost}
          {def.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {tokOpts.length > 0 && (
            <optgroup label="Site styles">
              {tokOpts.map((t) => (
                <option key={t.id} value={`token:${t.id}`}>
                  {tokenText(def, tokens, t.id)}
                </option>
              ))}
            </optgroup>
          )}
          {linked && !tokOpts.some((t) => t.id === value.token) && <option value={`token:${value.token}`}>{describeStyleValue(def, value, tokens)}</option>}
          {def.kind !== 'textStyle' && <option value="custom">{literal ? 'Custom' : 'Custom value…'}</option>}
        </select>
      </span>
      {strength && (
        <span className="style-strength">
          <span className="style-strength-label" aria-hidden="true">
            Strength
          </span>
          <span className="style-field">
            <DraftInput
              className={`input sm grow style-input${linked && partStrength(value) ? ' is-set' : ' is-inherited'}`}
              value={linked && partStrength(value) ? strengthText(value).slice(0, -1) : ''}
              placeholder={strengthText(strength).slice(0, -1)}
              ariaLabel={`${label} strength, 0 to 100%`}
              aria-describedby={describedBy}
              onCommit={setStrength}
            />
          </span>
          <span className="style-strength-unit" aria-hidden="true">
            %
          </span>
        </span>
      )}
      {custom && (
        <div
          className="style-custom"
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || literal) return;
            cancelDraft();
          }}
        >
          {def.kind === 'color' && <ColorPick key={scope} className="md" value={literal ? String(value) : colorText} onPick={onSet} label={`${label}: pick a color`} />}
          <DraftInput
            className={`input sm grow style-input${def.kind === 'color' ? ' mono' : ''}${literal ? ' is-set' : ''}`}
            value={literal ? String(value) : ''}
            placeholder={currentText ?? (def.kind === 'color' ? '#1c2742' : def.placeholder ? `For example ${def.placeholder}` : undefined)}
            autoFocus={!literal}
            onCommit={(t) => (t.trim() ? onSet(t.trim()) : false)}
            ariaLabel={`${label} value`}
            aria-describedby={[describedBy, literal ? undefined : draftId].filter(Boolean).join(' ') || undefined}
          />
          {!literal && (
            <p className="style-custom-hint">
              <span id={draftId}>
                {keeps && (
                  <span className="style-custom-keeps">
                    Using {keeps} until a custom {def.kind === 'color' ? 'color' : 'value'} replaces it{scope === 'base' ? '' : ` for ${SCOPE_LABEL[scope]}`}.
                  </span>
                )}{' '}
                {def.kind === 'color' ? 'Pick or type a color' : 'Type a value'}, then press Enter or leave the field. Esc discards it.
              </span>{' '}
              {/* For the pointer, pressed without taking focus from the field, so it never commits what was typed. The
                  keyboard has Esc, and Tab leaves the field, which applies it, as every field here does. */}
              <button type="button" className="style-scope-link" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={cancelDraft}>
                Cancel
              </button>
            </p>
          )}
        </div>
      )}
    </>
  );
}
