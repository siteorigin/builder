import { variantOptions } from '@shared/variants';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Globe, Link2, RotateCcw } from 'lucide-react';
import type { ProjectState, TextStyleValue, TokenDef } from '@shared/types';
import { followToken, followedText, textMetrics, tokenVar } from '@shared/styles';
import { effectiveTokens } from '@generator/index';
import { getTheme, listThemes } from '@catalogue/index';
import { installedFonts } from '@catalogue/fonts';
import { activePairing, activeTypeScale, availablePairings, pairingOps, scaleRoles, sizeAtWidth, typeScale, typeScaleOps, TYPE_SCALE_CHOICES, type TypeScaleChoice } from '@shared/type-scale';
import { allTrees, instancesOf } from '@engine/tree';
import { api, applyOps, useStore } from '../store';
import { assetLabels, sortAssets } from '@shared/asset-order';
import { ColorPick } from '../components/ColorPick';
import { DraftInput, Field, Section, openSection } from '../components/ui';
import { CustomTokens } from './CustomTokens';
import { FontSelect, familyName } from './FontSelect';
import { BrandContrast, ContrastDetail, ContrastFlags, buildContrastModel, useContrastStatus } from './ContrastNotes';
import type { ForegroundSuggestion } from '@shared/contrast';
import { NOT_FOUND_DEFAULTS, NOT_FOUND_LIMITS, clipText } from '@shared/not-found';
import { itemStyleRecords } from '@shared/item-styles';

/**
 * What the Foundation theme uses each colour for, checked against its base CSS and component styles, so an
 * owner can predict what a change affects. Short enough to sit on one line under the colour's name.
 */
const FOUNDATION_USES: Record<string, string> = {
  'color.background': 'Page background',
  'color.surface': 'Cards, price plans, contact boxes',
  'color.surface-alt': 'Alternate sections, soft backdrops',
  'color.text': 'Headings and body text',
  'color.muted': 'Secondary text',
  'color.brand': 'Buttons, links, highlights',
  'color.brand-strong': 'Buttons on hover',
  'color.on-brand': 'Text on buttons',
  'color.accent': 'Decorative highlights',
  'color.inverse': 'Dark sections and panels',
  'color.on-inverse': 'Text in dark sections',
  'color.border': 'Dividers',
  'color.focus': 'Focus outline for keyboard users'
};

/** What Foundation's layout values that are not self-explanatory do, so an owner can predict the effect. */
const FOUNDATION_LAYOUT_USES: Record<string, string> = {
  'space.section': 'Space above and below each section',
  'container.reading': 'Longest line of text',
  'container.content': 'Widest the page content gets',
  'container.gutter': 'Space between the content and the window edge'
};

/** Where Foundation's components use each text style, checked against its component definitions. */
const FOUNDATION_TEXT_USES: Record<string, string> = {
  'text.display': 'The centered hero heading',
  'text.h1': 'Page headings in the split hero and page introduction',
  'text.h2': 'Section headings',
  'text.h3': 'Card titles, plan names, questions and team names',
  'text.lead': 'Supporting text under headings',
  'text.body': 'Page text and text blocks',
  'text.small': 'Captions, labels and plan details',
  'text.eyebrow': 'Small labels above headings, footer headings',
  'text.stat': 'Statistics and prices'
};

/** Colour roles grouped by purpose, brand first: it is the one most owners change. Unknown ids go last. */
const COLOR_GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: 'Brand and accent', ids: ['color.brand', 'color.brand-strong', 'color.on-brand', 'color.accent'] },
  { label: 'Backgrounds', ids: ['color.background', 'color.surface', 'color.surface-alt'] },
  { label: 'Text', ids: ['color.text', 'color.muted'] },
  { label: 'Dark areas', ids: ['color.inverse', 'color.on-inverse'] },
  { label: 'Lines and focus', ids: ['color.border', 'color.focus'] }
];

/**
 * Says a change out loud in the panel's status region (WCAG 2.2 SC 4.1.3): a reset happens away from where focus
 * lands afterwards, so without this a screen reader user hears nothing.
 */
const SayContext = createContext<(text: string) => void>(() => {});

const LAYOUT_GROUPS = [
  { group: 'space', label: 'Spacing' },
  { group: 'container', label: 'Page widths' },
  { group: 'radius', label: 'Corners' },
  { group: 'shadow', label: 'Shadows' },
  { group: 'border', label: 'Borders' }
] as const;

const WEIGHTS: Array<[number, string]> = [
  [100, 'Thin'],
  [200, 'Extra light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
  [900, 'Black']
];
/** Spacing and widths are drawn on a square-root scale within their group, so small steps stay apart. */
const barWidth = (size: number, max: number) => Math.max(3, Math.round(Math.sqrt(Math.max(0, size) / (max || 1)) * 40));

const TEXT_METRICS = ['family', 'size', 'weight', 'lineHeight', 'tracking', 'transform'] as const;
type TextMetric = (typeof TEXT_METRICS)[number];
const METRIC_NAMES: Record<TextMetric, string> = { family: 'font', size: 'size', weight: 'weight', lineHeight: 'line height', tracking: 'letter spacing', transform: 'case' };
const CASES: Array<[string, string]> = [
  ['none', 'As typed'],
  ['uppercase', 'UPPERCASE'],
  ['lowercase', 'lowercase'],
  ['capitalize', 'Capitalize Each Word']
];
/** A text style's metric with the engine's defaults filled in, so "no case" and "none" compare equal. */
const metricOf = (v: TextStyleValue | undefined, k: TextMetric) => (v?.[k] ?? (k === 'transform' ? 'none' : undefined));

interface TokenUse {
  pages: Map<string, string>;
  components: Map<string, string>;
  shared: Set<string>;
}

/**
 * Where this project uses each site style, keyed by stable ids: pages, components (only those placed
 * somewhere) and the shared header/footer that are set to it.
 */
function tokenUses(state: ProjectState): Map<string, TokenUse> {
  const uses = new Map<string, TokenUse>();
  const at = (id: string) => uses.get(id) ?? uses.set(id, { pages: new Map(), components: new Map(), shared: new Set() }).get(id)!;
  const scan = (styles: unknown, mark: (u: TokenUse) => void) => {
    for (const scope of Object.values((styles ?? {}) as Record<string, Record<string, unknown>>))
      for (const v of Object.values(scope ?? {})) if (v && typeof v === 'object' && 'token' in (v as object)) mark(at(String((v as { token: string }).token)));
  };
  for (const t of allTrees(state)) {
    const mark =
      t.owner.kind === 'page'
        ? (u: TokenUse) => u.pages.set(t.owner.id, t.label)
        : t.owner.kind === 'shell'
          ? (u: TokenUse) => u.shared.add(t.label)
          : (u: TokenUse) => u.components.set(t.owner.id, t.label);
    if (t.owner.kind === 'component') {
      const def = state.components[t.owner.id];
      if (!def || !instancesOf(state, def.id).length) continue;
      for (const { option: v } of variantOptions(def)) for (const st of Object.values(v.styles ?? {})) scan(st, mark);
    }
    for (const n of Object.values(t.tree.nodes)) {
      scan(n.styles, mark);
      if (n.kind === 'instance') for (const o of [...Object.values(n.overrides ?? {}), ...itemStyleRecords(n)]) scan(o, mark);
    }
  }
  return uses;
}

/** The widths the type specimen shows each text style at: a phone, and a desktop window. */
const SPECIMEN_WIDTHS = [
  { label: 'Phone', width: 375 },
  { label: 'Desktop', width: 1280 }
] as const;
/** A size drawn small enough for the dock and in the same order as the real ones: body text reads at 13px. */
const specimenPx = (px: number) => Math.round(13 * Math.pow(Math.max(px, 1) / 16, 0.45) * 2) / 2;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const refOf = (v: unknown) => (v && typeof v === 'object' && 'token' in (v as object) ? String((v as { token: string }).token) : null);

function resolveColor(tokens: TokenDef[], v: unknown): string {
  const ref = refOf(v);
  const end = ref ? followToken(tokens, ref) : v;
  return typeof end === 'string' ? end : '';
}

const resolvedText = followedText;

const toPx = (v: string): number | null => {
  const m = /^(-?\d*\.?\d+)(rem|em|px)$/.exec(v.trim());
  return m ? Math.round(parseFloat(m[1]) * (m[2] === 'px' ? 1 : 16) * 10) / 10 : null;
};
/** clamp(min, preferred, max) as its two ends in pixels; null for anything else. */
const clampRange = (v: string): [number, number] | null => {
  const m = /^clamp\(\s*([^,]+),[^,]+,\s*([^)]+)\)$/.exec(v.trim());
  if (!m) return null;
  const a = toPx(m[1]);
  const b = toPx(m[2]);
  return a !== null && b !== null ? [Math.round(a), Math.round(b)] : null;
};
/** A size as an owner reads it: "36–58px" for a size that scales with the window, "16px" for a fixed one. */
const friendlySize = (v: string) => {
  const r = clampRange(v);
  if (r) return `${r[0]}–${r[1]}px`;
  const p = toPx(v);
  return p !== null ? `${p}px` : v;
};
const weightName = (w: number) => WEIGHTS.find(([n]) => n === w)?.[1] ?? String(w);
/** Equal as data, whatever order the keys were written in. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return String(a ?? '') === String(b ?? '');
};

/** Pixels back in the unit the value was written in, so rem-based sizes stay rem-based. */
const unitOf = (v: string) => (/rem\s*$/.test(v.trim()) ? 'rem' : /em\s*$/.test(v.trim()) ? 'em' : 'px');
const fromPx = (n: number, unit: string) => (unit === 'px' ? `${n}px` : `${+(n / 16).toFixed(4)}${unit}`);
/** A typed number of pixels; negative only where the value can be (spacing). */
const parseNum = (s: string, negative = false) => {
  const n = Number(s.trim().replace(/px$/i, ''));
  return s.trim() !== '' && Number.isFinite(n) && (negative || n >= 0) ? n : null;
};
/** clamp(min, preferred, max) split into its three parts, or null. */
const clampParts = (v: string): [string, string, string] | null => {
  const m = /^clamp\(\s*([^,]+),\s*([^,]+),\s*([^)]+)\)$/.exec(v.trim());
  return m ? [m[1].trim(), m[2].trim(), m[3].trim()] : null;
};

/**
 * A length as an owner edits it: one pixel field for a fixed size; for a size that scales with the window,
 * its smallest and largest sizes, each edited on its own so the scaling in between is kept; and the CSS
 * itself one step away for anything else.
 */
function SizeControl({ value, name, id, onCommit, cssToggle = true, negative = false, css = false }: { value: string; name: string; id?: string; onCommit: (v: string) => void; cssToggle?: boolean; negative?: boolean; css?: boolean }) {
  const [ownCss, setAsCss] = useState(false);
  const [order, setOrder] = useState(false);
  // A whole group can be switched to CSS from its heading; a row can also be switched on its own.
  const asCss = ownCss || css;
  const uid = useId();
  const parts = clampParts(value);
  const range = clampRange(value);
  const px = toPx(value);
  const simple = !asCss && (range || px !== null);
  const bound = (i: 0 | 2, label: string, first: boolean) => {
    const fieldId = first ? (id ?? `${uid}-min`) : `${uid}-max`;
    return parts && range ? (
      <span className="ss-num">
        <label className="ss-num-label" htmlFor={fieldId}>
          {label}
        </label>
        <DraftInput
          id={fieldId}
          className="input sm"
          value={String(range[i === 0 ? 0 : 1])}
          ariaLabel={`${name}, ${label.toLowerCase()}, in pixels`}
          onCommit={(s) => {
            const n = parseNum(s, negative);
            if (n === null) return false;
            // The smallest size above the largest would stop the size growing at all; say so and keep the value.
            if ((i === 0 && n > range[1]) || (i === 2 && n < range[0])) {
              setOrder(true);
              return false;
            }
            setOrder(false);
            const next = [...parts];
            next[i] = fromPx(n, unitOf(parts[i]));
            onCommit(`clamp(${next.join(', ')})`);
          }}
        />
        <span className="ss-unit">px</span>
      </span>
    ) : null;
  };
  return (
    <div className="ss-size">
      {simple && range ? (
        <div className="ss-size-pair">
          {bound(0, 'Smallest', true)}
          <span className="ss-size-to" aria-hidden="true">
            to
          </span>
          {bound(2, 'Largest', false)}
        </div>
      ) : simple ? (
        <span className="ss-num">
          <DraftInput id={id} className="input sm" value={String(px)} ariaLabel={`${name}, in pixels or any CSS length`} onCommit={(s) => { const n = parseNum(s, negative); if (n !== null) return void onCommit(fromPx(n, unitOf(value))); /* A CSS length typed into the field (1.5rem, clamp(…)) is taken as written; the project refuses one it cannot use. */ if (!s.trim() || /^-?\d/.test(s.trim()) && !/[a-z(%]/i.test(s)) return false; onCommit(s.trim()); }} />
          <span className="ss-unit">px</span>
        </span>
      ) : (
        <DraftInput id={id} className="input sm mono" value={value} ariaLabel={`${name} as CSS`} onCommit={(v) => (v.trim() ? onCommit(v.trim()) : false)} />
      )}
      {(range || px !== null) && !css && (cssToggle || range || asCss) && (
        <div className="ss-size-note">
          {range && !asCss && (order ? <span className="ss-size-error" role="alert">Smallest has to be no larger than Largest.</span> : <span>Grows with the window between these sizes.</span>)}
          <button className="link-btn ss-css-toggle" onClick={() => setAsCss(!asCss)}>
            {asCss ? 'Use simple fields' : 'Edit as CSS'}
            <span className="sr-only"> for {name}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** A shadow: its live sample does the explaining; the CSS opens on request, with room to read all of it. */
function ShadowControl({ value, name, onCommit }: { value: string; name: string; onCommit: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ss-size">
      {open && <DraftInput multiline rows={2} className="textarea mono ss-css-area" value={value} ariaLabel={`${name} as CSS`} onCommit={(v) => (v.trim() ? onCommit(v.replace(/\s+/g, ' ').trim()) : false)} />}
      <button className="link-btn ss-css-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide CSS' : 'Edit as CSS'}
        <span className="sr-only"> for {name}</span>
      </button>
    </div>
  );
}

/** A border as width, line style and one of the site's colours; anything else stays editable as CSS. */
function BorderControl({ value, name, colors, onCommit }: { value: string; name: string; colors: TokenDef[]; onCommit: (v: string) => void }) {
  const [asCss, setAsCss] = useState(false);
  const m = /^(\d*\.?\d+)px\s+(solid|dashed|dotted|double)\s+var\((--so-[a-z0-9-]+)\)$/i.exec(value.trim());
  const color = m ? colors.find((c) => tokenVar(c.id) === m[3]) : undefined;
  const css = <DraftInput className="input sm mono" value={value} ariaLabel={`${name} as CSS`} onCommit={(v) => (v.trim() ? onCommit(v.trim()) : false)} />;
  if (!m || !color) return css;
  const build = (w: string, s: string, c: string) => `${w}px ${s} var(${tokenVar(c)})`;
  const toggle = (
    <button className="link-btn ss-css-toggle" onClick={() => setAsCss(!asCss)}>
      {asCss ? 'Use simple fields' : 'Edit as CSS'}
      <span className="sr-only"> for {name}</span>
    </button>
  );
  if (asCss)
    return (
      <div className="ss-size">
        {css}
        {toggle}
      </div>
    );
  return (
    <div className="ss-size">
      <div className="ss-border">
        <label className="ss-num">
          <DraftInput className="input sm" value={m[1]} ariaLabel={`${name} width, in pixels`} onCommit={(s) => { const n = parseNum(s); if (n === null) return false; onCommit(build(String(n), m[2], color.id)); }} />
          <span className="ss-unit">px</span>
        </label>
        <select className="select sm" value={m[2].toLowerCase()} aria-label={`${name} line`} onChange={(e) => onCommit(build(m[1], e.target.value, color.id))}>
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
          <option value="dotted">Dotted</option>
          <option value="double">Double</option>
        </select>
        <select className="select sm" value={color.id} aria-label={`${name} color`} onChange={(e) => onCommit(build(m[1], m[2], e.target.value))}>
          {colors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {toggle}
    </div>
  );
}

/**
 * After a reset button disappears, put focus somewhere useful: the same row's value control while the row
 * remains, else the next reset in the same list, else the given fallback.
 */
function refocus(trigger: HTMLElement, row: Element | null, next: HTMLElement | null, fallback: () => HTMLElement | null) {
  // The change round-trips through the project before the panel re-renders: wait for the trigger to go.
  let tries = 0;
  const tick = () => {
    if (document.contains(trigger) && tries++ < 160) return void setTimeout(tick, 25);
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== trigger) return;
    const stillThere = row && document.contains(row);
    const inRow = stillThere ? ['input.ss-hex', 'select', 'input:not([type="color"])', 'textarea', '.link-btn', 'button:not(.reset-dot)'].map((s) => row!.querySelector<HTMLElement>(s)).find(Boolean) : null;
    const target = inRow ?? (next && document.contains(next) ? next : null) ?? fallback();
    target?.focus();
  };
  setTimeout(tick, 25);
}

/** A name with its reset kept on the same line as the name's last word, however the name wraps. */
function NameWithReset({ label, reset }: { label: string; reset: ReactNode }) {
  if (!reset) return <span>{label}</span>;
  const i = label.lastIndexOf(' ');
  return (
    <span>
      {i > 0 && label.slice(0, i + 1)}
      <span className="ss-nowrap">
        {i > 0 ? label.slice(i + 1) : label} {reset}
      </span>
    </span>
  );
}

/** The reset control on a changed value: the mark is the action, and it names what it puts back. */
function ResetDot({ label, theme, onReset }: { label: string; theme: string; onReset: () => unknown }) {
  const say = useContext(SayContext);
  return (
    <button
      className="reset-dot"
      title={`Changed from the theme. Click to go back to the theme's ${theme}.`}
      aria-label={`Set ${label} back to the theme's ${theme}`}
      onClick={(e) => {
        const row = e.currentTarget.closest('[data-ss-row]');
        const item = e.currentTarget.closest('li');
        // The next change's reset, or the one before when this was the last: never the list's own footer.
        const next = item?.nextElementSibling?.querySelector<HTMLElement>('.reset-dot') ?? item?.previousElementSibling?.querySelector<HTMLElement>('.reset-dot') ?? null;
        const panel = e.currentTarget.closest('.ss');
        const trigger = e.currentTarget;
        // Said once the change has saved, never before: a refused reset says nothing.
        void Promise.resolve(onReset()).then((ok) => ok !== null && ok !== false && say(`${label} is back to the theme's ${theme}.`));
        refocus(trigger, row, next, () => panel?.querySelector<HTMLElement>('.ss-changes button, .ss-theme-switch, .ss-color.compact input.ss-hex') ?? panel?.querySelector<HTMLElement>('.insp-jump button') ?? null);
      }}
    >
      <RotateCcw />
    </button>
  );
}

export function SiteStyles() {
  const snap = useStore((s) => s.snapshot);
  const assetSort = useStore((s) => s.assetSort);
  const [dev, setDev] = useState(false);
  useEffect(() => void api.app.info().then((i) => setDev(i.dev)), []);
  const tokens = useMemo(() => (snap ? effectiveTokens(snap.state) : []), [snap?.state.tokens, snap?.state.site.themeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const uses = useMemo(() => (snap ? tokenUses(snap.state) : new Map<string, TokenUse>()), [snap?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [openText, setOpenText] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const uid = useId();
  // Which paired colours the theme sets against each other, and whether they are readable as they stand.
  const contrast = useMemo(() => buildContrastModel(tokens, snap ? getTheme(snap.state.site.themeId).contrastPairs : []), [tokens, snap?.state.site.themeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const contrastStatus = useContrastStatus(contrast);
  const refusedPacks = useStore((s) => s.packs.refused);
  const packsDir = useStore((s) => s.packs.userDir);
  // What a reset just did, for the status region; a repeat of the same words still changes the text, so it is read again.
  const [said, setSaid] = useState('');
  // The section under the sticky header, marked in the jump links so a long scroll keeps its bearings.
  const [here, setHere] = useState(0);
  // Layout groups whose sizes are shown as CSS, switched from the group's heading.
  const [cssGroups, setCssGroups] = useState<Set<string>>(() => new Set());
  const say = useCallback((text: string) => setSaid((prev) => (prev === text ? `${text} ` : text)), []);
  if (!snap) return null;
  const st = snap.state;
  // The image menus list images in the order Assets does.
  const images = sortAssets(Object.values(st.assets.assets).filter((a) => a.kind === 'image'), assetSort);
  const imageLabels = assetLabels(images);
  const theme = getTheme(st.site.themeId);
  const overrides = st.tokens.overrides;
  const byId = (id: string) => tokens.find((t) => t.id === id);
  const themeValue = (id: string) => (theme.tokens.find((t) => t.id === id) ?? st.tokens.custom.find((t) => t.id === id))?.value;
  // A saved override that happens to equal the theme's value is not a change the owner can see.
  const changed = (id: string) => {
    // Your own styles have no theme value to differ from, or to go back to.
    if (!(id in overrides) || !theme.tokens.some((t) => t.id === id)) return false;
    const v = overrides[id];
    const b = themeValue(id);
    if (byId(id)?.group === 'text') return TEXT_METRICS.some((k) => !sameValue(metricOf(v as TextStyleValue, k), metricOf(b as TextStyleValue, k)));
    return !sameValue(v, b);
  };
  /** A picker's changes merge with each other, never with a typed value: undo returns to what was typed. */
  const set = (id: string, value: unknown, by?: 'picker') => applyOps([{ type: 'token.set', tokenId: id, value }], `Change ${byId(id)?.label ?? id}`, by ? `token:${id}:${by}` : `token:${id}`);
  /** Linking and unlinking are steps of their own, so undo always returns to the link before. */
  const relink = (id: string, value: unknown) => applyOps([{ type: 'token.set', tokenId: id, value }], `Change ${byId(id)?.label ?? id}`);
  const group = (g: TokenDef['group']) => tokens.filter((t) => t.group === g);
  const changedNote = (ids: string[]) => {
    const n = ids.filter(changed).length;
    return n ? `${n} changed` : undefined;
  };
  /** Take a suggested text color: one change of its own, refused if the project moved on while the author chose. */
  const chooseReadable = (s: ForegroundSuggestion, trigger: HTMLElement) => {
    const label = byId(s.token)?.label ?? s.token;
    // The offer goes once it is taken, so focus moves to the colour's own row, or to Brand in Basics.
    const row = trigger.closest('[data-ss-row]');
    const panel = trigger.closest('.ss');
    void applyOps([{ type: 'token.set', tokenId: s.token, value: s.value }], `Use a readable ${label}`, undefined, snap.revision);
    // Brand's value is plain text while it follows another colour: then its "Use its own color" button is what can take focus.
    refocus(trigger, row, null, () => panel?.querySelector<HTMLElement>('.ss-color.compact input.ss-hex, .ss-color.compact .ss-follows .link-btn') ?? null);
  };
  /** Open a colour's row in Colors and put focus on its value, or on its details when it follows another colour. */
  const jumpTo = (id: string) => {
    const linked = !!refOf(byId(id)?.value);
    openSection('tok-color', { focus: `[data-token-id="${CSS.escape(id)}"] ${linked ? '.ss-disclose' : 'input.ss-hex'}` });
  };
  /** Open where a changed style is edited, from its line in the review: its row, its text style, or its font in Basics. */
  const jumpToToken = (id: string) => {
    const t = byId(id);
    if (!t) return;
    const at = `[data-token-id="${CSS.escape(id)}"]`;
    if (t.group === 'color') return jumpTo(id);
    if (t.group === 'text') return void (setOpenText(id), openSection('tok-text', { focus: `${at} .ss-text-toggle` }));
    if (t.group === 'font') return void openSection('tok-basics', { focus: `${at} select` });
    openSection('tok-layout', { focus: `${at} :is(input, select, button:not(.reset-dot))` });
  };
  const site = st.site;
  const updSite = (patch: Record<string, unknown>) => void applyOps([{ type: 'site.update', ...patch }], 'Update site settings');
  const changedIds = tokens.map((t) => t.id).filter(changed);
  // Theme styles only: an override on one of your own styles is its value in use, with no theme value under it.
  const savedIds = Object.keys(overrides).filter((id) => theme.tokens.some((t) => t.id === id));
  const resetAll = (e: React.MouseEvent<HTMLButtonElement>) => {
    const panel = e.currentTarget.closest('.ss');
    const trigger = e.currentTarget;
    const n = changedIds.length;
    void applyOps(savedIds.map((id) => ({ type: 'token.set' as const, tokenId: id, value: null })), 'Use theme defaults').then((ok) => ok && say(`${plural(n, 'change', 'changes')} put back to ${theme.name}. You can undo this.`));
    // The changes bar goes with the reset: focus moves to the theme, the next thing down, not back to the top.
    refocus(trigger, null, null, () => panel?.querySelector<HTMLElement>('.ss-theme-switch, .ss-color.compact input.ss-hex') ?? panel?.querySelector<HTMLElement>('.insp-jump button') ?? null);
  };
  const themes = listThemes().filter((t) => !t.devOnly || dev || t.id === theme.id);
  const hex = (id: string) => resolveColor(tokens, byId(id)?.value);
  const themeHex = (id: string) => resolveColor(theme.tokens, themeValue(id));
  const fontStack = (id: string) => resolvedText(tokens, id);
  const colors = group('color');
  const colorIds = colors.map((t) => t.id);
  const fontIds = group('font').map((t) => t.id);
  const textIds = group('text').map((t) => t.id);
  const layoutIds = LAYOUT_GROUPS.flatMap(({ group: g }) => group(g).map((t) => t.id));
  /** Colours that already follow `id`, directly or through another colour: linking to them would loop. */
  const followers = (id: string): Set<string> => {
    const out = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of colors) {
        const r = refOf(c.value);
        if (r && (r === id || out.has(r)) && !out.has(c.id)) (out.add(c.id), (grew = true));
      }
    }
    return out;
  };

  /** What this project sets directly to a style, grouped by where it is. */
  const usesOf = (id: string) => {
    const u = uses.get(id);
    const linked = tokens.filter((x) => refOf(x.value) === id || refOf((x.value as TextStyleValue | undefined)?.family) === id).map((x) => x.label);
    const lines: Array<[string, string[]]> = [
      ['Pages', [...(u?.pages.values() ?? [])]],
      ['Shared', [...(u?.shared ?? [])]],
      ['Components', [...(u?.components.values() ?? [])]],
      ['Styles', linked]
    ];
    const filled = lines.filter(([, names]) => names.length);
    return { count: filled.reduce((n, [, names]) => n + names.length, 0), lines: filled };
  };
  const usesBlock = (id: string) => {
    const { lines, count } = usesOf(id);
    return (
      <div className="ss-uses-block">
        <div className="ss-detail-label">Set directly in this project{count ? ` (${count})` : ''}</div>
        {lines.length ? (
          <dl className="ss-uses">
            {lines.map(([k, names]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{names.join(', ')}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="ss-none">{theme.tokens.some((x) => x.id === id) ? 'Nowhere directly. The theme applies it wherever its description says.' : 'Not used anywhere yet.'}</p>
        )}
      </div>
    );
  };

  /** A changed style's name in the review list; layout steps share names ("Medium"), so they carry their group. */
  const reviewName = (id: string) => {
    const t = byId(id);
    const g = LAYOUT_GROUPS.find((x) => x.group === t?.group);
    return g ? `${g.label}: ${t?.label}` : (t?.label ?? id);
  };
  /** One readable value: a font by name, a size in px, a link by the colour it follows. */
  const show = (group: TokenDef['group'], k: TextMetric | null, v: unknown): string => {
    const ref = refOf(v);
    if (ref) return k === 'family' || group === 'font' ? (byId(ref)?.label ?? 'a style that is no longer available') : `same as ${byId(ref)?.label ?? 'a style that is no longer available'}`;
    if (k === 'family' || group === 'font') return familyName(String(v));
    if (k === 'size' || ((group === 'space' || group === 'container' || group === 'radius') && k === null)) return friendlySize(String(v));
    if (k === 'weight') return weightName(Number(v));
    if (k === 'transform') return (CASES.find(([c]) => c === (v ?? 'none'))?.[1] ?? String(v)).toLowerCase();
    return String(v ?? '');
  };
  /** What changed in a style, metric by metric for text styles: "size 48px (theme 36–58px)". */
  const differences = (id: string): Array<{ what: string; now: string; was: string; nowColor?: string; wasColor?: string }> => {
    const t = byId(id);
    if (!t) return [];
    if (t.group === 'text') {
      const v = textMetrics(tokens, id, themeValue(id)) ?? undefined;
      const b = themeValue(id) as TextStyleValue;
      return TEXT_METRICS.filter((k) => !sameValue(metricOf(v, k), metricOf(b, k))).map((k) => ({ what: METRIC_NAMES[k], now: show('text', k, metricOf(v, k)), was: show('text', k, metricOf(b, k)) }));
    }
    // A colour is shown as itself beside its value, so a change can be judged without reading hex.
    const colorsOf = t.group === 'color' ? { nowColor: hex(id), wasColor: themeHex(id) } : {};
    return [{ what: '', now: show(t.group, null, t.value), was: show(t.group, null, themeValue(id)), ...colorsOf }];
  };

  const colorRow = (t: TokenDef, compact = false) => {
    const value = hex(t.id);
    const ref = refOf(t.value);
    // A link to a colour that is gone (renamed, removed with its pack) says so, rather than naming an ID.
    const follows = ref ? (byId(ref) && value ? byId(ref)!.label : 'a color that is no longer available') : null;
    // Gone, or followed through a chain that ends nowhere: either way there is no colour to show.
    const lost = !!ref && (!byId(ref) || !value);
    const desc = (theme.id.startsWith('foundation') ? FOUNDATION_USES[t.id] : undefined) ?? t.description;
    const open = !compact && openDetail === t.id;
    const detailId = `${uid}-detail-${t.id}`;
    const loops = followers(t.id);
    return (
      <div className={`ss-color${changed(t.id) ? ' set' : ''}${open ? ' open' : ''}${compact ? ' compact' : ''}${follows ? ' linked' : ''}`} key={t.id} data-ss-row data-token-id={compact ? undefined : t.id}>
        {!compact && (
          <button className="ss-disclose" title="Linking, contrast and where it is used" aria-expanded={open} aria-controls={detailId} aria-label={`${t.label}: linking, contrast and where it is used`} onClick={() => setOpenDetail(open ? null : t.id)}>
            <ChevronRight />
          </button>
        )}
        <ColorPick value={value} disabled={!!follows} onPick={(next) => set(t.id, next, 'picker')} label={`${t.label} color`} />
        <div className="ss-color-text">
          <div className="ss-name">
            <NameWithReset label={compact ? `${t.label} color` : t.label} reset={changed(t.id) && <ResetDot label={t.label} theme={`color, ${themeHex(t.id)}`} onReset={() => set(t.id, null)} />} />
          </div>
          {desc && <div className="ss-desc">{desc}</div>}
        </div>
        {follows ? (
          <span className="ss-hex ss-hex-linked mono" title={lost ? 'The color it followed is no longer available. Open its details to choose another.' : `${value}. Follows ${follows}. Choose "Use its own color" to set it separately.`}>
            {value || '—'}
          </span>
        ) : (
          <DraftInput className="input sm mono ss-hex" value={value} onCommit={(v) => (v.trim() ? set(t.id, v.trim()) : false)} ariaLabel={`${t.label} color value`} />
        )}
        {/* Below the row, under the name: what it follows, and what is unreadable. Never squeezed beside the value. */}
        {follows && (
          <div className="ss-follows ss-color-extra">
            <Link2 aria-hidden="true" />
            <span>
              Same as{' '}
              {lost ? (
                follows
              ) : (
                <button type="button" className="link-btn ss-jump" onClick={() => jumpTo(ref!)}>
                  {follows}
                  <span className="sr-only">, go to its color</span>
                </button>
              )}
            </span>
            {/* With nothing to keep (the colour it followed is gone), the way out is to choose another colour in its details. */}
            {lost && !open && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  className="link-btn"
                  aria-controls={compact ? undefined : detailId}
                  aria-expanded={compact ? undefined : false}
                  onClick={() => {
                    // Opens the colour's details (in Colors, from Basics) and puts focus on the choice itself.
                    setOpenDetail(t.id);
                    if (compact) openSection('tok-color', { focus: `[data-token-id="${CSS.escape(t.id)}"] .ss-detail select` });
                    else requestAnimationFrame(() => document.getElementById(detailId)?.querySelector<HTMLElement>('select')?.focus());
                  }}
                >
                  Choose another<span className="sr-only"> color for {t.label}</span>
                </button>
              </>
            )}
            {value && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  className="link-btn"
                  onClick={(e) => {
                    const row = e.currentTarget.closest('[data-ss-row]');
                    const trigger = e.currentTarget;
                    relink(t.id, value);
                    refocus(trigger, row, null, () => null);
                  }}
                >
                  Use its own color
                </button>
              </>
            )}
          </div>
        )}
        {!compact && (
          <div className="ss-color-extra ss-flags-slot">
            <ContrastFlags model={contrast} tokenId={t.id} onUse={chooseReadable} onJump={jumpTo} onShowAll={open ? undefined : () => (setOpenDetail(t.id), requestAnimationFrame(() => document.getElementById(detailId)?.querySelector<HTMLElement>('.ss-contrast-block')?.focus()))} showAllControls={detailId} />
          </div>
        )}
        {!compact && (
          <div className="ss-detail" id={detailId} hidden={!open}>
            {open && (
              <>
                <Field label="Link to another color" hint={lost ? 'The color it followed is no longer available. Choose another, or give it its own color.' : 'Follows another color, and changes when it does.'}>
                  <select className="select sm" value={ref ?? ''} onChange={(e) => relink(t.id, e.target.value ? { token: e.target.value } : value || themeHex(t.id) || '#000000')}>
                    {lost && (
                      <option value={ref!} disabled>
                        No longer available
                      </option>
                    )}
                    <option value="">Its own color</option>
                    {colorIds
                      .filter((id) => id !== t.id && !loops.has(id) && !!hex(id))
                      .map((id) => (
                        <option key={id} value={id}>
                          {byId(id)?.label}
                        </option>
                      ))}
                  </select>
                </Field>
                <ContrastDetail model={contrast} tokenId={t.id} />
                {usesBlock(t.id)}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const fontRow = (t: TokenDef) => {
    const stack = fontStack(t.id);
    const ref = refOf(t.value);
    const selectId = `${uid}-font-${t.id}`;
    return (
      <div className={`ss-font${changed(t.id) ? ' set' : ''}`} key={t.id} data-ss-row data-token-id={t.id}>
        <span className="ss-font-sample" style={{ fontFamily: stack }} aria-hidden="true">
          Aa
        </span>
        <div className="ss-font-body">
          <div className="ss-name">
            <label htmlFor={selectId}>{t.label}</label>
            {changed(t.id) && (
              <>
                {' '}
                <ResetDot label={t.label} theme={`font, ${familyName(resolvedText(theme.tokens, t.id))}`} onReset={() => set(t.id, null)} />
              </>
            )}
          </div>
          <FontSelect id={selectId} state={st} stack={stack} follows={ref ? (byId(ref)?.label ?? 'a style that is no longer available') : null} onChoose={(next) => set(t.id, next)} />
        </div>
      </div>
    );
  };

  const textRow = (t: TokenDef) => {
    const v = textMetrics(tokens, t.id, themeValue(t.id));
    if (!v) return null;
    const base = (themeValue(t.id) ?? v) as TextStyleValue;
    const famRef = refOf(v.family);
    const stack = famRef ? fontStack(famRef) : String(v.family);
    const famLabel = famRef ? (byId(famRef)?.label ?? 'a font that is no longer available') : familyName(stack);
    const max = clampRange(v.size)?.[1] ?? toPx(v.size) ?? 16;
    const open = openText === t.id;
    const bodyId = `${uid}-text-${t.id}`;
    const nameId = `${bodyId}-name`;
    const textUse = theme.id.startsWith('foundation') ? FOUNDATION_TEXT_USES[t.id] : t.description;
    const weights = WEIGHTS.some(([n]) => n === v.weight) ? WEIGHTS : [...WEIGHTS, [v.weight, String(v.weight)] as [number, string]].sort((a, b) => a[0] - b[0]);
    const metricChanged = (k: TextMetric) => changed(t.id) && !sameValue(metricOf(v, k), metricOf(base, k));
    // Put back one metric; when that leaves the whole style matching the theme, drop the change entirely.
    const resetMetric = (k: TextMetric) => (TEXT_METRICS.every((m) => m === k || sameValue(metricOf(v, m), metricOf(base, m))) ? set(t.id, null) : set(t.id, { [k]: metricOf(base, k) }));
    /** One metric: its label (with the reset beside it, outside the label) over its control. */
    const metric = (k: TextMetric, control: (id: string) => ReactNode, hint?: string) => {
      const id = `${bodyId}-${k}`;
      return (
        <div className="field ss-field" data-ss-row>
          <div className="ss-name ss-field-name ss-nowrap">
            <label htmlFor={id}>
              {METRIC_NAMES[k][0].toUpperCase() + METRIC_NAMES[k].slice(1)}
              <span className="sr-only"> of {t.label}</span>
            </label>
            {metricChanged(k) && (
              <>
                {' '}
                <ResetDot label={`${t.label} ${METRIC_NAMES[k]}`} theme={`${METRIC_NAMES[k]}, ${show('text', k, metricOf(base, k))}`} onReset={() => resetMetric(k)} />
              </>
            )}
          </div>
          {control(id)}
          {hint && <div className="field-hint">{hint}</div>}
        </div>
      );
    };
    return (
      <div className={`ss-text${open ? ' open' : ''}${changed(t.id) ? ' set' : ''}`} key={t.id} data-ss-row data-token-id={t.id}>
        <div className="ss-text-head">
          <button className="ss-text-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpenText(open ? null : t.id)}>
            <ChevronRight className="chev" aria-hidden="true" />
            <span className="ss-text-spec">
              <span
                id={nameId}
                className="ss-specimen"
                style={{
                  fontFamily: stack,
                  fontWeight: v.weight,
                  // A compressed scale: big styles stay bigger than small ones without filling the dock.
                  fontSize: Math.round(Math.min(30, 12 + (max - 12) * 0.28)),
                  letterSpacing: v.tracking,
                  textTransform: (v.transform as React.CSSProperties['textTransform']) ?? 'none'
                }}
              >
                {t.label}
              </span>
              <span className="ss-text-meta">
                {friendlySize(v.size)} · {weightName(v.weight)} · {famLabel}
              </span>
            </span>
          </button>
          {changed(t.id) && <ResetDot label={t.label} theme="text style" onReset={() => set(t.id, null)} />}
        </div>
        <div className="ss-text-body" id={bodyId} role="group" aria-labelledby={nameId} hidden={!open}>
          {open && (
            <>
              {metric('family', (id) => (
                <select id={id} className="select sm" value={famRef ?? ''} onChange={(e) => set(t.id, { family: { token: e.target.value } })}>
                  {!famRef && <option value="">{familyName(stack)}</option>}
                  {famRef && !byId(famRef) && (
                    <option value={famRef} disabled>
                      No longer available
                    </option>
                  )}
                  {group('font').map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label} ({familyName(fontStack(f.id))})
                    </option>
                  ))}
                </select>
              ))}
              {metric('size', (id) => <SizeControl id={id} value={v.size} name={`${t.label} size`} onCommit={(size) => set(t.id, { size })} />)}
              {metric('weight', (id) => (
                <select id={id} className="select sm" value={v.weight} onChange={(e) => set(t.id, { weight: Number(e.target.value) })}>
                  {weights.map(([n, name]) => (
                    <option key={n} value={n}>
                      {name === String(n) ? n : `${n} · ${name}`}
                    </option>
                  ))}
                </select>
              ))}
              {metric('transform', (id) => (
                <select id={id} className="select sm" value={String(metricOf(v, 'transform'))} onChange={(e) => set(t.id, { transform: e.target.value })}>
                  {CASES.map(([c, label]) => (
                    <option key={c} value={c}>
                      {label}
                    </option>
                  ))}
                </select>
              ))}
              <div className="grid-2">
                {metric('lineHeight', (id) => <DraftInput id={id} className="input sm" value={v.lineHeight} onCommit={(lineHeight) => (lineHeight.trim() ? set(t.id, { lineHeight: lineHeight.trim() }) : false)} />)}
                {metric('tracking', (id) => <DraftInput id={id} className="input sm" value={v.tracking} onCommit={(tracking) => (tracking.trim() ? set(t.id, { tracking: tracking.trim() }) : false)} />)}
              </div>
              {textUse && (
                <div className="ss-uses-block">
                  <div className="ss-detail-label">In the theme</div>
                  <p className="ss-theme-use">{textUse}</p>
                </div>
              )}
              {usesBlock(t.id)}
            </>
          )}
        </div>
      </div>
    );
  };

  const layoutRow = (g: TokenDef['group'], t: TokenDef, groupMax: number) => {
    // A style that follows another is drawn and described with the value it follows.
    const value = resolvedText(tokens, t.id);
    const ref = refOf(t.value);
    const follows = ref ? (byId(ref)?.label ?? 'a style that is no longer available') : null;
    const px = toPx(value);
    const size = px ?? clampRange(value)?.[1] ?? 0;
    const bg = hex('color.background') || undefined;
    const card = hex('color.surface') || '#fff';
    const noun = { space: 'spacing', radius: 'corner', shadow: 'shadow' }[g as string];
    const desc = theme.id.startsWith('foundation') ? FOUNDATION_LAYOUT_USES[t.id] : undefined;
    const name = noun ? `${t.label} ${noun}` : t.label;
    let preview: ReactNode = null;
    // Spacing and widths are drawn to scale within their group, so the steps read as a progression.
    if (g === 'space' || g === 'container') preview = <span className="ss-bar" style={{ width: barWidth(size, groupMax) }} />;
    // A corner drawn at its real radius up to what the sample can show; a fully rounded one is drawn as the capsule it makes.
    else if (g === 'radius')
      preview =
        px !== null && px >= 100 ? (
          <span className="ss-corner pill">
            <i />
          </span>
        ) : (
          <span className="ss-corner">
            <i style={{ borderTopLeftRadius: px !== null ? Math.min(px, 26) : value }} />
          </span>
        );
    // Shadows and borders are drawn on a card three times larger, then scaled down, so their real offsets
    // and spreads survive; both sit on the site's own background and card colours.
    else if (g === 'shadow')
      preview = (
        <span className="ss-well" style={{ background: bg }}>
          {/* The card keeps a hairline under the shadow, so a soft shadow on a pale page still has an edge to read. */}
          <i style={{ boxShadow: value && value !== 'none' ? `inset 0 0 0 2px rgb(0 0 0 / 0.1), ${value}` : 'inset 0 0 0 2px rgb(0 0 0 / 0.1)', background: card }} />
        </span>
      );
    else if (g === 'border')
      preview = (
        <span className="ss-well" style={{ background: bg }}>
          <i style={{ border: value.replace(/var\((--so-[a-z0-9-]+)\)/gi, (m, n: string) => resolveColor(tokens, tokens.find((x) => tokenVar(x.id) === n)?.value) || m), background: card }} />
        </span>
      );
    const wide = !!follows || g === 'border' || !!clampRange(value) || (g !== 'shadow' && px === null && value.length > 12);
    const commit = (v: string) => set(t.id, v);
    return (
      <div className={`ss-token${wide ? ' wide' : ''}${changed(t.id) ? ' set' : ''}`} key={t.id} data-ss-row data-token-id={t.id}>
        <div className="ss-token-label">
          <span className="ss-preview" aria-hidden="true">
            {preview}
          </span>
          <span className="ss-token-text">
            <span className="ss-name">
              <NameWithReset label={t.label} reset={changed(t.id) && <ResetDot label={name} theme={`value, ${show(g, null, themeValue(t.id))}`} onReset={() => set(t.id, null)} />} />
            </span>
            {desc && <span className="ss-desc">{desc}</span>}
          </span>
        </div>
        {follows ? (
          <div className="ss-follows">
            <Link2 aria-hidden="true" />
            <span>
              Same as {follows}
              {value && g !== 'shadow' && g !== 'border' && <span className="faint"> · {show(g, null, value)}</span>}
            </span>
            {(value || typeof themeValue(t.id) === 'string') && (
              <button
                className="link-btn"
                onClick={(e) => {
                  const row = e.currentTarget.closest('[data-ss-row]');
                  const trigger = e.currentTarget;
                  // What it shows now, or the theme's own value when what it followed is gone.
                  relink(t.id, value || themeValue(t.id));
                  refocus(trigger, row, null, () => null);
                }}
              >
                Use its own value<span className="sr-only"> for {name}</span>
              </button>
            )}
          </div>
        ) : g === 'border' ? (
          <BorderControl value={value} name={name} colors={colors} onCommit={commit} />
        ) : g === 'shadow' ? (
          <ShadowControl value={value} name={name} onCommit={commit} />
        ) : (
          <SizeControl value={value} name={name} onCommit={commit} cssToggle={wide} negative={g === 'space'} css={cssGroups.has(g)} />
        )}
      </div>
    );
  };

  const look = ['color.brand', 'color.accent', 'color.inverse', 'color.surface-alt'].map(hex).filter(Boolean);
  const displayStack = fontStack('font.display') || fontStack(fontIds[0] ?? '');
  // Headings first: the display font is the one that sets a site's character.
  const fontsOrdered = [...group('font')].sort((a, b) => Number(b.id === 'font.display') - Number(a.id === 'font.display'));
  const brand = byId('color.brand') ?? colors[0];

  // Font pairings: both fonts the theme ships, set together in one step.
  const pairings = byId('font.display')?.group === 'font' && byId('font.body')?.group === 'font' ? availablePairings(installedFonts(st)) : [];
  const pairing = activePairing(pairings, fontStack('font.display'), fontStack('font.body'));
  const choosePairing = (p: (typeof pairings)[number]) => {
    const ops = pairingOps(p, tokens);
    if (ops.length) void applyOps(ops, `Use ${p.display} and ${p.body}`, undefined, snap.revision);
  };

  // Type scale: every heading and text size at once, keeping each style's font; one step to undo.
  const roles = scaleRoles(theme.tokens);
  const scale = activeTypeScale(tokens, theme.tokens);
  const scaleName = (c: TypeScaleChoice) => (c === 'theme' ? 'Theme' : typeScale(c).label);
  const scaleDescription = (c: TypeScaleChoice) => (c === 'theme' ? `${theme.name}'s own sizes, line heights and letter spacing.` : typeScale(c).description);
  const chooseScale = (c: TypeScaleChoice) => {
    const { ops } = typeScaleOps(tokens, theme.tokens, overrides, c);
    if (ops.length) void applyOps(ops, c === 'theme' ? "Use the theme's type scale" : `Use the ${typeScale(c).label} type scale`, undefined, snap.revision);
  };
  const specimen = roles.flatMap((id) => {
    const t = byId(id);
    const v = textMetrics(tokens, id, themeValue(id));
    if (!t || !v) return [];
    const famRef = refOf(v.family);
    const ends = clampRange(v.size);
    return [
      {
        id,
        label: t.label,
        v,
        stack: famRef ? fontStack(famRef) : String(v.family),
        // Worked out where the size allows; a size written some other way is shown as written, never guessed.
        sizes: SPECIMEN_WIDTHS.map((w, i) => {
          const px = sizeAtWidth(v.size, w.width);
          return { px, drawn: specimenPx(px ?? ends?.[i] ?? toPx(v.size) ?? 16), text: px === null ? friendlySize(v.size) : `${Math.round(px)}px` };
        })
      }
    ];
  });

  const jumps = [
    { id: 'tok-basics', label: 'Basics' },
    { id: 'tok-color', label: 'Colors' },
    { id: 'tok-text', label: 'Text' },
    { id: 'tok-layout', label: 'Layout' },
    { id: 'tok-custom', label: 'Yours' },
    { id: 'site-settings', label: 'Site' }
  ];
  const reviewId = `${uid}-review`;

  return (
    <SayContext.Provider value={say}>
    <div
      className="panel-body ss"
      onScroll={(e) => {
        const box = e.currentTarget;
        // The section that owns the upper third of what is in view below the header is the one being read.
        const head = box.querySelector<HTMLElement>('.ss-head')?.offsetHeight ?? 0;
        const line = box.getBoundingClientRect().top + head + (box.clientHeight - head) / 3;
        const sections = [...box.querySelectorAll<HTMLElement>(':scope > .section')];
        let i = 0;
        sections.forEach((sec, n) => sec.getBoundingClientRect().top <= line && (i = n));
        const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
        const next = atEnd ? jumps.length - 1 : Math.min(i, jumps.length - 1);
        if (next !== here) setHere(next);
      }}
    >
      <div className="sr-only" role="status" aria-live="polite">
        {contrastStatus}
      </div>
      {/* Resets and removals are said here; the status region above stays the one place contrast is reported. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {said}
      </div>
      <div className="insp-head ss-head">
        {/* The dock tab already names the panel; the heading stays for screen readers and gives the jump links the room. */}
        <div className="insp-title sr-only">
          <h3>Site styles</h3>
        </div>
        <nav className="insp-jump" aria-label="Jump to section">
          {jumps.map((j) => (
            <button key={j.id} aria-current={jumps[here]?.id === j.id ? 'location' : undefined} onClick={() => openSection(j.id)}>
              {j.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="ss-intro">
        <div className="ss-theme ss-theme-meta">
          <div className="ss-theme-id">
            <div className="ss-look" style={{ background: hex('color.background') || undefined, color: hex('color.text') || undefined }} aria-hidden="true">
              <span className="ss-look-type" style={{ fontFamily: displayStack }}>
                Aa
              </span>
              <span className="ss-look-button" style={{ background: hex('color.brand') || undefined }} />
              <span className="ss-look-dots">
                {look.map((c, i) => (
                  <i key={i} style={{ background: c }} />
                ))}
              </span>
            </div>
            <div className="ss-theme-text">
              <div className="ss-eyebrow">
                Theme <span className="ss-theme-version">{theme.version}</span>
              </div>
              {/* With themes to choose from, the selector is the theme's name; with one, the name stands alone. */}
              {themes.length > 1 ? (
                <select className="select ss-theme-switch" title={theme.name} value={theme.id} aria-label="Theme" aria-describedby={`${uid}-theme-hint`} onChange={(e) => void applyOps([{ type: 'theme.apply', themeId: e.target.value }], 'Switch theme')}>
                  {themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="ss-theme-name">
                  <strong>{theme.name}</strong>
                </div>
              )}
              <div className="ss-theme-desc">{theme.description}</div>
            </div>
          </div>
          {themes.length > 1 && (
            <div className="ss-theme-hint" id={`${uid}-theme-hint`}>
              Switching keeps your content and changes.
            </div>
          )}
          {theme.id !== st.site.themeId && (
            <div className="ss-theme-hint" role="note">
              This site's theme, “{st.site.themeId}”, is not installed, so {theme.name}'s styles are shown.{' '}
              <button className="link-btn" onClick={() => void applyOps([{ type: 'theme.apply', themeId: theme.id }], 'Switch theme')}>
                Use {theme.name}
              </button>
            </div>
          )}
          {refusedPacks.length > 0 && (
            <details className="ss-packs-refused">
              <summary>
                {refusedPacks.length === 1 ? '1 theme pack' : `${refusedPacks.length} theme packs`} could not be loaded
              </summary>
              <ul>
                {refusedPacks.map((r) => (
                  <li key={r.dir}>
                    <strong>{r.packId ?? r.dir.split(/[\\/]/).pop()}</strong>: {r.reason}
                  </li>
                ))}
              </ul>
              {packsDir && <p className="faint">Installed packs are read from {packsDir} when SiteOrigin Builder starts.</p>}
            </details>
          )}
        {changedIds.length > 0 && (
          <div className="ss-changes">
            <div className="ss-changes-row">
              <span className="ss-changes-count">
                <strong>{changedIds.length} changed</strong>
                <span className="sr-only"> from {theme.name}</span>
              </span>
              <button className="btn btn-sm" aria-expanded={reviewing} aria-controls={reviewId} onClick={() => setReviewing(!reviewing)}>
                Review
                <ChevronDown className={reviewing ? 'ss-flip' : undefined} />
              </button>
            </div>
            <ul className="ss-review" id={reviewId} hidden={!reviewing}>
              {reviewing &&
                changedIds.map((id) => {
                  const diffs = differences(id);
                  return (
                    <li key={id}>
                      <button type="button" className="link-btn ss-review-name" onClick={() => jumpToToken(id)}>
                        {reviewName(id)}
                        <span className="sr-only">, go to it</span>
                      </button>
                      {diffs.map((d, i) => (
                        <span className="ss-review-vals" key={i}>
                          {d.what && <span className="ss-review-what">{d.what} </span>}
                          {d.nowColor && <span className="ss-chip" style={{ background: d.nowColor }} aria-hidden="true" />}
                          {d.now}
                          <span className="ss-review-was">
                            {' · theme '}
                            {d.wasColor && <span className="ss-chip" style={{ background: d.wasColor }} aria-hidden="true" />}
                            {d.was}
                          </span>
                        </span>
                      ))}
                      <ResetDot label={reviewName(id)} theme={diffs.length === 1 ? `${diffs[0].what ? diffs[0].what + ', ' : ''}${diffs[0].was}` : 'values'} onReset={() => set(id, null)} />
                    </li>
                  );
                })}
              {reviewing && (
                <li className="ss-review-all">
                  {/* The bulk reset lives with the list it acts on, and names the values it goes back to. */}
                  <button className="btn btn-sm btn-ghost" onClick={resetAll}>
                    <RotateCcw />
                    Reset all to {theme.name}
                  </button>
                  <span className="ss-review-undo">You can undo this.</span>
                </li>
              )}
            </ul>
          </div>
        )}
        </div>
        <div className="scope-note site">
          <Globe />
          <span>
            <strong>Your whole site.</strong> Anything given its own value on the page keeps it.
          </span>
        </div>
      </div>

      <Section title="Basics" id="tok-basics" scope={changedNote([...(brand ? [brand.id] : []), ...fontIds])}>
        <div className="ss-group">
          {brand && colorRow(brand, true)}
          {brand?.id === 'color.brand' && <BrandContrast model={contrast} onUse={chooseReadable} onJump={jumpTo} />}
          {/* A new brand colour with the theme's hover colour left as it was: buttons would hover to a colour from another palette. */}
          {brand?.id === 'color.brand' && changed('color.brand') && byId('color.brand-strong') && !changed('color.brand-strong') && !refOf(byId('color.brand-strong')?.value) && (
            <p className="ss-hover-note">
              <span className="ss-chip" style={{ background: hex('color.brand-strong') }} aria-hidden="true" />
              <span>
                Buttons still hover to the theme's{' '}
                <span className="ss-nowrap">
                  <button type="button" className="link-btn ss-jump" onClick={() => jumpTo('color.brand-strong')}>
                    Brand (strong)
                  </button>
                  .
                </span>{' '}
                Change it to match your brand.
              </span>
            </p>
          )}
          {fontsOrdered.map(fontRow)}
          {pairings.length > 0 && (
            <div className="ss-pairings" role="group" aria-labelledby={`${uid}-pairings`}>
              <div className="ss-group-label" id={`${uid}-pairings`}>
                Font pairings
              </div>
              <div className="ss-pairing-list">
                {pairings.map((p) => (
                  <button key={p.id} className="ss-pairing" aria-pressed={pairing?.id === p.id} onClick={() => choosePairing(p)}>
                    <span className="ss-pairing-fonts">
                      <span style={{ fontFamily: p.displayStack }}>{p.display}</span>
                      <span className="faint"> + </span>
                      <span style={{ fontFamily: p.bodyStack }}>{p.body}</span>
                    </span>
                    <span className="ss-pairing-note">{p.note}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section title="Colors" id="tok-color" scope={changedNote(colorIds)}>
        {[...COLOR_GROUPS, { label: 'Other colors', ids: colorIds.filter((id) => !COLOR_GROUPS.some((g) => g.ids.includes(id))) }]
          .map((g) => ({ ...g, list: g.ids.map(byId).filter((t): t is TokenDef => !!t && t.group === 'color') }))
          .filter((g) => g.list.length)
          .map((g) => (
            <div className="ss-group" key={g.label} role="group" aria-label={g.label}>
              <div className="ss-group-label">{g.label}</div>
              {g.list.map((t) => colorRow(t))}
            </div>
          ))}
      </Section>

      <Section title="Text styles" id="tok-text" scope={changedNote(textIds)}>
        {roles.length > 0 && (
          <div className="ss-scale" role="group" aria-labelledby={`${uid}-scale`}>
            <div className="ss-group-label" id={`${uid}-scale`}>
              Type scale
            </div>
            <div className="segmented full ss-scale-choices">
              {TYPE_SCALE_CHOICES.map((c) => (
                <button key={c} aria-pressed={scale === c} title={scaleDescription(c)} onClick={() => chooseScale(c)}>
                  {scaleName(c)}
                </button>
              ))}
            </div>
            <p className="ss-scale-note">
              {scale ? scaleDescription(scale) : 'Sizes of your own. A scale sets every heading and text size at once, keeping your fonts.'} Each style below stays editable.
            </p>
            <div
              className="ss-type-specimen"
              role="img"
              aria-label={SPECIMEN_WIDTHS.map((w, i) => `${w.label}, ${w.width} pixels wide: ${specimen.map((r) => `${r.label} ${r.sizes[i].text}`).join(', ')}`).join('. ')}
            >
              {SPECIMEN_WIDTHS.map((w, i) => (
                <div className="ss-type-col" key={w.label} aria-hidden="true">
                  <div className="ss-type-head">
                    {w.label} <span className="faint">{w.width}px</span>
                  </div>
                  {specimen.map((r) => (
                    <div className="ss-type-row" key={r.id}>
                      <span
                        className="ss-type-sample"
                        style={{ fontFamily: r.stack, fontWeight: r.v.weight, fontSize: r.sizes[i].drawn, letterSpacing: r.v.tracking, textTransform: (r.v.transform as React.CSSProperties['textTransform']) ?? 'none' }}
                      >
                        {r.label}
                      </span>
                      <span className="ss-type-px">{r.sizes[i].text}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="ss-text-list">{group('text').map(textRow)}</div>
      </Section>

      <Section title="Layout" id="tok-layout" defaultOpen={false} scope={changedNote(layoutIds)}>
        {LAYOUT_GROUPS.filter(({ group: g }) => group(g).length).map(({ group: g, label }) => {
          const max = Math.max(...group(g).map((t) => toPx(resolvedText(tokens, t.id)) ?? clampRange(resolvedText(tokens, t.id))?.[1] ?? 0));
          return (
            <div className="ss-group" key={g} role="group" aria-label={label}>
              <div className="ss-group-label ss-group-head">
                <span>{label}</span>
                {(g === 'space' || g === 'container' || g === 'radius') && (
                  <button
                    className="link-btn ss-css-toggle"
                    onClick={() => setCssGroups((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(g)) next.add(g);
                      return next;
                    })}
                  >
                    {cssGroups.has(g) ? 'Use simple fields' : 'Edit as CSS'}
                    <span className="sr-only"> for {label.toLowerCase()}</span>
                  </button>
                )}
              </div>
              {group(g).map((t) => layoutRow(g, t, max))}
            </div>
          );
        })}
      </Section>

      <Section title="Your styles" id="tok-custom" defaultOpen={st.tokens.custom.length > 0} scope={st.tokens.custom.length ? plural(st.tokens.custom.length, 'style', 'styles') : undefined}>
        <CustomTokens state={st} say={say} whereUsed={(id) => usesOf(id).lines.flatMap(([, names]) => names)} onEditText={(id) => (setOpenText(id), openSection('tok-text', { focus: `[data-token-id="${CSS.escape(id)}"] .ss-text-toggle` }))} />
      </Section>

      <Section title="Site details" id="site-settings" defaultOpen={false}>
        <Field label="Site name">
          <DraftInput value={site.name} onCommit={(v) => (v.trim() ? updSite({ name: v.trim() }) : false)} />
        </Field>
        <Field label="Default description" hint="Used by pages without their own description.">
          <DraftInput multiline value={site.description} onCommit={(v) => updSite({ description: v })} />
        </Field>
        <Field label="Public URL" hint="For canonical links and the sitemap.">
          <DraftInput value={site.baseUrl ?? ''} placeholder="https://example.com" onCommit={(v) => updSite({ baseUrl: v.trim() })} />
        </Field>
        <Field label="Language" hint="A language code, such as en or en-GB.">
          <DraftInput className="input ss-lang" value={site.language} onCommit={(v) => updSite({ language: v.trim() })} />
        </Field>
        <Field label="Favicon">
          <select className="select" value={site.favicon ?? ''} onChange={(e) => updSite({ favicon: e.target.value || null })}>
            <option value="">None</option>
            {images.map((a) => (
              <option key={a.id} value={a.id}>
                {imageLabels.get(a.id)?.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Social sharing image">
          <select className="select" value={site.socialImage ?? ''} onChange={(e) => updSite({ socialImage: e.target.value || null })}>
            <option value="">None</option>
            {images.map((a) => (
              <option key={a.id} value={a.id}>
                {imageLabels.get(a.id)?.label}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Not-found page" id="site-not-found" defaultOpen={false}>
        <Field label="Heading" hint="Visitors see this page, with your header and footer, at any address your site does not have. Leave a field empty to use the wording shown.">
          <DraftInput value={site.notFoundHeading ?? ''} placeholder={NOT_FOUND_DEFAULTS.heading} onCommit={(v) => updSite({ notFoundHeading: clipText(v.trim(), NOT_FOUND_LIMITS.heading) })} />
        </Field>
        <Field label="Message">
          <DraftInput multiline value={site.notFoundMessage ?? ''} placeholder={NOT_FOUND_DEFAULTS.message} onCommit={(v) => updSite({ notFoundMessage: clipText(v.trim(), NOT_FOUND_LIMITS.message) })} />
        </Field>
        <Field label="Home link" hint="The page always ends with this link to your Home page.">
          <DraftInput value={site.notFoundLinkLabel ?? ''} placeholder={NOT_FOUND_DEFAULTS.linkLabel} onCommit={(v) => updSite({ notFoundLinkLabel: clipText(v.trim(), NOT_FOUND_LIMITS.linkLabel) })} />
        </Field>
      </Section>
    </div>
    </SayContext.Provider>
  );
}
