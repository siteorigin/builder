import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Globe, Link2, Palette, RotateCcw } from 'lucide-react';
import type { ProjectState, TextStyleValue, TokenDef } from '@shared/types';
import { tokenVar } from '@shared/styles';
import { effectiveTokens } from '@generator/index';
import { getTheme, listThemes } from '@catalogue/index';
import { allTrees, instancesOf } from '@engine/tree';
import { importedFontStack, projectFontFamilies } from '@shared/fonts';
import { api, applyOps, getState, toast, useStore } from '../store';
import { DraftInput, Field, Section, openSection } from '../components/ui';
import { CustomTokens } from './CustomTokens';

/** The font menu's "Import a font…" entry; never saved as a value. */
const IMPORT_FONT = '__import-font';
const FONT_CHOICES = [
  { label: 'Inter (sans-serif)', value: "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { label: 'Fraunces (serif)', value: "'Fraunces Variable', 'Fraunces', Georgia, 'Times New Roman', serif" },
  { label: 'System sans-serif', value: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { label: 'Georgia (serif)', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Helvetica / Arial', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Monospace', value: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" }
];

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
  { label: 'Brand', ids: ['color.brand', 'color.brand-strong', 'color.on-brand', 'color.accent'] },
  { label: 'Backgrounds', ids: ['color.background', 'color.surface', 'color.surface-alt'] },
  { label: 'Text', ids: ['color.text', 'color.muted'] },
  { label: 'Dark sections', ids: ['color.inverse', 'color.on-inverse'] },
  { label: 'Lines and focus', ids: ['color.border', 'color.focus'] }
];

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

const TEXT_METRICS = ['family', 'size', 'weight', 'lineHeight', 'tracking', 'transform'] as const;
type TextMetric = (typeof TEXT_METRICS)[number];
const METRIC_NAMES: Record<TextMetric, string> = { family: 'font', size: 'size', weight: 'weight', lineHeight: 'line height', tracking: 'letter spacing', transform: 'case' };
const CASES: Array<[string, string]> = [
  ['none', 'As typed'],
  ['uppercase', 'UPPERCASE'],
  ['lowercase', 'lowercase'],
  ['capitalize', 'Capitalise Each Word']
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
      for (const v of Object.values(def.variants ?? {})) for (const st of Object.values(v.styles ?? {})) scan(st, mark);
    }
    for (const n of Object.values(t.tree.nodes)) {
      scan(n.styles, mark);
      if (n.kind === 'instance') for (const o of Object.values(n.overrides ?? {})) scan(o, mark);
    }
  }
  return uses;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const refOf = (v: unknown) => (v && typeof v === 'object' && 'token' in (v as object) ? String((v as { token: string }).token) : null);

function resolveColor(tokens: TokenDef[], v: unknown, depth = 0): string {
  const ref = refOf(v);
  if (ref && depth < 6) return resolveColor(tokens, tokens.find((t) => t.id === ref)?.value, depth + 1);
  return String(v ?? '');
}

/** The first family in a font stack, as a person would name it ("Fraunces", not "'Fraunces Variable'"). */
const familyName = (stack: string) => (stack.split(',')[0] ?? '').replace(/['"]/g, '').replace(/\s+Variable$/i, '').trim() || stack;

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
const parseNum = (s: string) => {
  const n = Number(s.trim().replace(/px$/i, ''));
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
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
function SizeControl({ value, name, id, onCommit, cssToggle = true }: { value: string; name: string; id?: string; onCommit: (v: string) => void; cssToggle?: boolean }) {
  const [asCss, setAsCss] = useState(false);
  const parts = clampParts(value);
  const range = clampRange(value);
  const px = toPx(value);
  const simple = !asCss && (range || px !== null);
  const bound = (i: 0 | 2, label: string, first: boolean) =>
    parts && range ? (
      <span className="ss-num">
        <span className="ss-num-label" aria-hidden="true">
          {label}
        </span>
        <DraftInput
          id={first ? id : undefined}
          className="input sm"
          value={String(range[i === 0 ? 0 : 1])}
          ariaLabel={`${name}, ${label.toLowerCase()}, in pixels`}
          onCommit={(s) => {
            const n = parseNum(s);
            if (n === null) return;
            const next = [...parts];
            next[i] = fromPx(n, unitOf(parts[i]));
            onCommit(`clamp(${next.join(', ')})`);
          }}
        />
        <span className="ss-unit">px</span>
      </span>
    ) : null;
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
          <DraftInput id={id} className="input sm" value={String(px)} ariaLabel={`${name}, in pixels`} onCommit={(s) => { const n = parseNum(s); if (n !== null) onCommit(fromPx(n, unitOf(value))); }} />
          <span className="ss-unit">px</span>
        </span>
      ) : (
        <DraftInput id={id} className="input sm mono" value={value} ariaLabel={`${name} as CSS`} onCommit={(v) => v.trim() && onCommit(v.trim())} />
      )}
      {(range || px !== null) && (cssToggle || range || asCss) && (
        <div className="ss-size-note">
          {range && !asCss && <span>Grows with the window between these sizes.</span>}
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
      {open && <DraftInput multiline rows={2} className="textarea mono ss-css-area" value={value} ariaLabel={`${name} as CSS`} onCommit={(v) => v.trim() && onCommit(v.replace(/\s+/g, ' ').trim())} />}
      <button className="link-btn ss-css-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide CSS' : 'Edit as CSS'}
        <span className="sr-only"> for {name}</span>
      </button>
    </div>
  );
}

/** A border as width, line style and one of the site's colours; anything else stays editable as CSS. */
function BorderControl({ value, name, colors, onCommit }: { value: string; name: string; colors: TokenDef[]; onCommit: (v: string) => void }) {
  const m = /^(\d*\.?\d+)px\s+(solid|dashed|dotted|double)\s+var\((--so-[a-z0-9-]+)\)$/i.exec(value.trim());
  const color = m ? colors.find((c) => tokenVar(c.id) === m[3]) : undefined;
  if (!m || !color) return <DraftInput className="input sm mono" value={value} ariaLabel={`${name} as CSS`} onCommit={(v) => v.trim() && onCommit(v.trim())} />;
  const build = (w: string, s: string, c: string) => `${w}px ${s} var(${tokenVar(c)})`;
  return (
    <div className="ss-border">
      <label className="ss-num">
        <DraftInput className="input sm" value={m[1]} ariaLabel={`${name} width, in pixels`} onCommit={(s) => { const n = parseNum(s); if (n !== null) onCommit(build(String(n), m[2], color.id)); }} />
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
function ResetDot({ label, theme, onReset }: { label: string; theme: string; onReset: () => void }) {
  return (
    <button
      className="reset-dot"
      title={`Changed from the theme. Click to go back to the theme's ${theme}.`}
      aria-label={`Set ${label} back to the theme's ${theme}`}
      onClick={(e) => {
        const row = e.currentTarget.closest('[data-ss-row]');
        const item = e.currentTarget.closest('li');
        const next = (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector<HTMLElement>('.reset-dot') ?? null;
        const panel = e.currentTarget.closest('.ss');
        const trigger = e.currentTarget;
        onReset();
        refocus(trigger, row, next, () => panel?.querySelector<HTMLElement>('.ss-changes button') ?? panel?.querySelector<HTMLElement>('.insp-jump button') ?? null);
      }}
    >
      <RotateCcw />
    </button>
  );
}

export function SiteStyles() {
  const snap = useStore((s) => s.snapshot);
  const [dev, setDev] = useState(false);
  useEffect(() => void api.app.info().then((i) => setDev(i.dev)), []);
  const tokens = useMemo(() => (snap ? effectiveTokens(snap.state) : []), [snap?.state.tokens, snap?.state.site.themeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const uses = useMemo(() => (snap ? tokenUses(snap.state) : new Map<string, TokenUse>()), [snap?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [openText, setOpenText] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const uid = useId();
  if (!snap) return null;
  const st = snap.state;
  const theme = getTheme(st.site.themeId);
  const overrides = st.tokens.overrides;
  const byId = (id: string) => tokens.find((t) => t.id === id);
  const themeValue = (id: string) => (theme.tokens.find((t) => t.id === id) ?? st.tokens.custom.find((t) => t.id === id))?.value;
  // A saved override that happens to equal the theme's value is not a change the owner can see.
  const changed = (id: string) => {
    if (!(id in overrides)) return false;
    const v = overrides[id];
    const b = themeValue(id);
    if (byId(id)?.group === 'text') return TEXT_METRICS.some((k) => !sameValue(metricOf(v as TextStyleValue, k), metricOf(b as TextStyleValue, k)));
    return !sameValue(v, b);
  };
  const set = (id: string, value: unknown) => void applyOps([{ type: 'token.set', tokenId: id, value }], `Change ${byId(id)?.label ?? id}`, `token:${id}`);
  const group = (g: TokenDef['group']) => tokens.filter((t) => t.group === g);
  const changedNote = (ids: string[]) => {
    const n = ids.filter(changed).length;
    return n ? `${n} changed` : undefined;
  };
  const site = st.site;
  const updSite = (patch: Record<string, unknown>) => void applyOps([{ type: 'site.update', ...patch }], 'Update site settings');
  const changedIds = tokens.map((t) => t.id).filter(changed);
  const savedIds = Object.keys(overrides).filter((id) => byId(id));
  const resetAll = (e: React.MouseEvent<HTMLButtonElement>) => {
    const panel = e.currentTarget.closest('.ss');
    const trigger = e.currentTarget;
    void applyOps(savedIds.map((id) => ({ type: 'token.set' as const, tokenId: id, value: null })), 'Use theme defaults');
    refocus(trigger, null, null, () => panel?.querySelector<HTMLElement>('.insp-jump button') ?? null);
  };
  const themes = listThemes().filter((t) => !t.devOnly || dev || t.id === theme.id);
  const hex = (id: string) => resolveColor(tokens, byId(id)?.value);
  const themeHex = (id: string) => resolveColor(theme.tokens, themeValue(id));
  const fontStack = (id: string) => String(byId(id)?.value ?? '');
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
        <div className="ss-detail-label">Also set directly in this project{count ? ` (${count})` : ''}</div>
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
          <p className="ss-none">Nothing else. The theme applies it wherever its description says.</p>
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
    if (ref) return k === 'family' || group === 'font' ? (byId(ref)?.label ?? ref) : `same as ${byId(ref)?.label ?? ref}`;
    if (k === 'family' || group === 'font') return familyName(String(v));
    if (k === 'size' || ((group === 'space' || group === 'container' || group === 'radius') && k === null)) return friendlySize(String(v));
    if (k === 'weight') return weightName(Number(v));
    if (k === 'transform') return (CASES.find(([c]) => c === (v ?? 'none'))?.[1] ?? String(v)).toLowerCase();
    return String(v ?? '');
  };
  /** What changed in a style, metric by metric for text styles: "size 48px (theme 36–58px)". */
  const differences = (id: string): Array<{ what: string; now: string; was: string }> => {
    const t = byId(id);
    if (!t) return [];
    if (t.group === 'text') {
      const v = t.value as TextStyleValue;
      const b = themeValue(id) as TextStyleValue;
      return TEXT_METRICS.filter((k) => !sameValue(metricOf(v, k), metricOf(b, k))).map((k) => ({ what: METRIC_NAMES[k], now: show('text', k, metricOf(v, k)), was: show('text', k, metricOf(b, k)) }));
    }
    return [{ what: '', now: show(t.group, null, t.value), was: show(t.group, null, themeValue(id)) }];
  };

  const colorRow = (t: TokenDef, compact = false) => {
    const value = hex(t.id);
    const ref = refOf(t.value);
    const follows = ref ? (byId(ref)?.label ?? ref) : null;
    const desc = (st.site.themeId === 'foundation' ? FOUNDATION_USES[t.id] : undefined) ?? t.description;
    const open = !compact && openDetail === t.id;
    const detailId = `${uid}-detail-${t.id}`;
    const loops = followers(t.id);
    return (
      <div className={`ss-color${changed(t.id) ? ' set' : ''}${open ? ' open' : ''}${compact ? ' compact' : ''}`} key={t.id} data-ss-row>
        {!compact && (
          <button className="ss-disclose" aria-expanded={open} aria-controls={detailId} aria-label={`${t.label}: where it is used, and linking`} onClick={() => setOpenDetail(open ? null : t.id)}>
            <ChevronRight />
          </button>
        )}
        <span className="ss-swatch">
          <input type="color" disabled={!!follows} value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => set(t.id, e.target.value)} aria-label={`${t.label} color`} />
        </span>
        <div className="ss-color-text">
          <div className="ss-name">
            <NameWithReset label={compact ? `${t.label} color` : t.label} reset={changed(t.id) && <ResetDot label={t.label} theme={`color, ${themeHex(t.id)}`} onReset={() => set(t.id, null)} />} />
          </div>
          <div className="ss-desc">{desc}</div>
          {follows && (
            <div className="ss-follows">
              <Link2 aria-hidden="true" />
              <span>Same as {follows}</span>
              <button
                className="link-btn"
                onClick={(e) => {
                  const row = e.currentTarget.closest('[data-ss-row]');
                  const trigger = e.currentTarget;
                  set(t.id, value);
                  refocus(trigger, row, null, () => null);
                }}
              >
                Use its own color
              </button>
            </div>
          )}
        </div>
        {follows ? (
          <span className="ss-hex ss-hex-linked mono" title={`Follows ${follows}. Choose "Use its own color" to set it separately.`}>
            {value}
          </span>
        ) : (
          <DraftInput className="input sm mono ss-hex" value={value} onCommit={(v) => v.trim() && set(t.id, v.trim())} ariaLabel={`${t.label} color value`} />
        )}
        {!compact && (
          <div className="ss-detail" id={detailId} hidden={!open}>
            {open && (
              <>
                <Field label="Same as" hint="Follows another color, and changes when it does.">
                  <select className="select sm" value={ref ?? ''} onChange={(e) => set(t.id, e.target.value ? { token: e.target.value } : value)}>
                    <option value="">Its own color</option>
                    {colorIds
                      .filter((id) => id !== t.id && !loops.has(id))
                      .map((id) => (
                        <option key={id} value={id}>
                          {byId(id)?.label}
                        </option>
                      ))}
                  </select>
                </Field>
                {usesBlock(t.id)}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const importedFonts = projectFontFamilies(st).map((f) => ({ label: f.family, value: importedFontStack(f.family) }));
  /** Bring in a web font and use it for this style straight away. */
  const importFontFor = async (t: TokenDef) => {
    const r = await api.project.importAssets(undefined, 'font').catch((e: Error) => ({ ok: false, assetIds: [] as string[], message: `The font couldn’t be added: ${e.message}` }));
    if (r.message) toast(r.message, r.assetIds.length ? 'info' : 'error');
    const doc = getState().snapshot?.state.assets.assets ?? {};
    const font = r.assetIds.map((id) => doc[id]).find((a) => a?.kind === 'font' && a.font);
    if (font?.font) set(t.id, importedFontStack(font.font.family));
    else if (r.assetIds.length) toast('That file is not a font. Choose a WOFF2 or WOFF file.', 'error');
  };
  const fontRow = (t: TokenDef) => {
    const stack = String(t.value);
    const known = FONT_CHOICES.some((f) => f.value === stack) || importedFonts.some((f) => f.value === stack);
    const selectId = `${uid}-font-${t.id}`;
    return (
      <div className={`ss-font${changed(t.id) ? ' set' : ''}`} key={t.id} data-ss-row>
        <span className="ss-font-sample" style={{ fontFamily: stack }} aria-hidden="true">
          Aa
        </span>
        <div className="ss-font-body">
          <div className="ss-name">
            <label htmlFor={selectId}>{t.label}</label>
            {changed(t.id) && (
              <>
                {' '}
                <ResetDot label={t.label} theme={`font, ${familyName(String(themeValue(t.id) ?? ''))}`} onReset={() => set(t.id, null)} />
              </>
            )}
          </div>
          <select
            id={selectId}
            className="select sm"
            value={known ? stack : ''}
            onChange={(e) => {
              if (e.target.value === IMPORT_FONT) void importFontFor(t);
              else set(t.id, e.target.value);
            }}
          >
            {!known && <option value="">Custom: {familyName(stack)}</option>}
            {importedFonts.length > 0 && (
              <optgroup label="Imported fonts">
                {importedFonts.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Built-in fonts">
              {FONT_CHOICES.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
            </optgroup>
            <option value={IMPORT_FONT}>Import a font…</option>
          </select>
        </div>
      </div>
    );
  };

  const textRow = (t: TokenDef) => {
    const v = t.value as TextStyleValue;
    const base = (themeValue(t.id) ?? v) as TextStyleValue;
    const famRef = refOf(v.family);
    const stack = famRef ? fontStack(famRef) : String(v.family);
    const famLabel = famRef ? (byId(famRef)?.label ?? famRef) : familyName(stack);
    const max = clampRange(v.size)?.[1] ?? toPx(v.size) ?? 16;
    const open = openText === t.id;
    const bodyId = `${uid}-text-${t.id}`;
    const nameId = `${bodyId}-name`;
    const textUse = st.site.themeId === 'foundation' ? FOUNDATION_TEXT_USES[t.id] : t.description;
    const weights = WEIGHTS.some(([n]) => n === v.weight) ? WEIGHTS : [...WEIGHTS, [v.weight, String(v.weight)] as [number, string]].sort((a, b) => a[0] - b[0]);
    const metricChanged = (k: TextMetric) => changed(t.id) && !sameValue(metricOf(v, k), metricOf(base, k));
    // Put back one metric; when that leaves the whole style matching the theme, drop the change entirely.
    const resetMetric = (k: TextMetric) => (TEXT_METRICS.every((m) => m === k || sameValue(metricOf(v, m), metricOf(base, m))) ? set(t.id, null) : set(t.id, { [k]: metricOf(base, k) }));
    /** One metric: its label (with the reset beside it, outside the label) over its control. */
    const metric = (k: TextMetric, control: (id: string) => ReactNode, hint?: string) => {
      const id = `${bodyId}-${k}`;
      return (
        <div className="field ss-field" data-ss-row>
          <div className="ss-name ss-field-name">
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
      <div className={`ss-text${open ? ' open' : ''}${changed(t.id) ? ' set' : ''}`} key={t.id} data-ss-row>
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
                  {group('font').map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label} ({familyName(String(f.value))})
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
                {metric('lineHeight', (id) => <DraftInput id={id} className="input sm" value={v.lineHeight} onCommit={(lineHeight) => lineHeight.trim() && set(t.id, { lineHeight: lineHeight.trim() })} />)}
                {metric('tracking', (id) => <DraftInput id={id} className="input sm" value={v.tracking} onCommit={(tracking) => tracking.trim() && set(t.id, { tracking: tracking.trim() })} />)}
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
    const value = String(t.value);
    const px = toPx(value);
    const size = px ?? clampRange(value)?.[1] ?? 0;
    const bg = hex('color.background') || undefined;
    const card = hex('color.surface') || '#fff';
    const noun = { space: 'spacing', radius: 'corner', shadow: 'shadow' }[g as string];
    const name = noun ? `${t.label} ${noun}` : t.label;
    let preview: ReactNode = null;
    // Spacing and widths are drawn to scale within their group, so the steps read as a progression.
    if (g === 'space' || g === 'container') preview = <span className="ss-bar" style={{ width: Math.max(2, Math.round((size / (groupMax || 1)) * 40)) }} />;
    else if (g === 'radius')
      preview = (
        <span className="ss-corner">
          <i style={{ borderTopLeftRadius: px !== null ? Math.min(px, 30) : value }} />
        </span>
      );
    // Shadows and borders are drawn on a card three times larger, then scaled down, so their real offsets
    // and spreads survive; both sit on the site's own background and card colours.
    else if (g === 'shadow')
      preview = (
        <span className="ss-well" style={{ background: bg }}>
          <i style={{ boxShadow: value, background: card }} />
        </span>
      );
    else if (g === 'border')
      preview = (
        <span className="ss-well" style={{ background: bg }}>
          <i style={{ border: value.replace(/var\((--so-[a-z0-9-]+)\)/gi, (m, n: string) => resolveColor(tokens, tokens.find((x) => tokenVar(x.id) === n)?.value) || m), background: card }} />
        </span>
      );
    const wide = g === 'border' || !!clampRange(value) || (g !== 'shadow' && px === null && value.length > 12);
    const commit = (v: string) => set(t.id, v);
    return (
      <div className={`ss-token${wide ? ' wide' : ''}${changed(t.id) ? ' set' : ''}`} key={t.id} data-ss-row>
        <div className="ss-token-label">
          <span className="ss-preview" aria-hidden="true">
            {preview}
          </span>
          <span className="ss-name">
            <NameWithReset label={t.label} reset={changed(t.id) && <ResetDot label={name} theme={`value, ${show(g, null, themeValue(t.id))}`} onReset={() => set(t.id, null)} />} />
          </span>
        </div>
        {g === 'border' ? (
          <BorderControl value={value} name={name} colors={colors} onCommit={commit} />
        ) : g === 'shadow' ? (
          <ShadowControl value={value} name={name} onCommit={commit} />
        ) : (
          <SizeControl value={value} name={name} onCommit={commit} cssToggle={wide} />
        )}
      </div>
    );
  };

  const look = ['color.brand', 'color.accent', 'color.inverse', 'color.surface-alt'].map(hex).filter(Boolean);
  const displayStack = fontStack('font.display') || fontStack(fontIds[0] ?? '');
  // Headings first: the display font is the one that sets a site's character.
  const fontsOrdered = [...group('font')].sort((a, b) => Number(b.id === 'font.display') - Number(a.id === 'font.display'));
  const brand = byId('color.brand') ?? colors[0];
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
    <div className="panel-body ss">
      <div className="insp-head ss-head">
        <div className="insp-title">
          <span className="layer-kind" aria-hidden="true">
            <Palette />
          </span>
          <h3>Site styles</h3>
        </div>
        <nav className="insp-jump" aria-label="Jump to section">
          {jumps.map((j) => (
            <button key={j.id} onClick={() => openSection(j.id)}>
              {j.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="ss-intro">
        <div className="scope-note site">
          <Globe />
          <span>
            <strong>Your whole site.</strong> Anything given its own value on the page keeps it.
          </span>
        </div>
        <div className="ss-theme">
          <div className="ss-look" style={{ background: hex('color.background') || undefined, color: hex('color.text') || undefined }} aria-hidden="true">
            <span style={{ fontFamily: displayStack }}>Aa</span>
            <span className="ss-look-dots">
              {look.map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
            </span>
          </div>
          <div className="ss-theme-meta">
            <div className="ss-eyebrow">Theme</div>
            <div className="ss-theme-name">
              <strong>{theme.name}</strong>
              <span className="faint">{theme.version}</span>
            </div>
            <div className="ss-theme-desc">{theme.description}</div>
            {themes.length > 1 && (
              <select className="select sm ss-theme-switch" value={theme.id} aria-label="Theme" aria-describedby={`${uid}-theme-hint`} onChange={(e) => void applyOps([{ type: 'theme.apply', themeId: e.target.value }], 'Switch theme')}>
                {themes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} {t.version}
                  </option>
                ))}
              </select>
            )}
            {themes.length > 1 && (
              <div className="ss-theme-hint" id={`${uid}-theme-hint`}>
                Switching keeps your content and changes. You can undo it.
              </div>
            )}
          </div>
        </div>
        {changedIds.length > 0 && (
          <div className="ss-changes">
            <div className="ss-changes-row">
              <span className="ss-changes-count">
                <strong>{changedIds.length} changed</strong>
              </span>
              <span className="ss-changes-actions">
                <button className="btn btn-sm btn-ghost" aria-expanded={reviewing} aria-controls={reviewId} onClick={() => setReviewing(!reviewing)}>
                  Review
                  <ChevronDown className={reviewing ? 'ss-flip' : undefined} />
                </button>
                <button className="btn btn-sm" onClick={resetAll} title="Put every site style back to the theme's value. You can undo this.">
                  <RotateCcw />
                  Reset all
                </button>
              </span>
            </div>
            <ul className="ss-review" id={reviewId} hidden={!reviewing}>
              {reviewing &&
                changedIds.map((id) => {
                  const diffs = differences(id);
                  return (
                    <li key={id}>
                      <span className="ss-review-name">{reviewName(id)}</span>
                      {diffs.map((d, i) => (
                        <span className="ss-review-vals" key={i}>
                          {d.what && <span className="ss-review-what">{d.what} </span>}
                          {d.now}
                          <span className="faint"> · theme {d.was}</span>
                        </span>
                      ))}
                      <ResetDot label={reviewName(id)} theme={diffs.length === 1 ? `${diffs[0].what ? diffs[0].what + ', ' : ''}${diffs[0].was}` : 'values'} onReset={() => set(id, null)} />
                    </li>
                  );
                })}
            </ul>
          </div>
        )}
      </div>

      <Section title="Basics" id="tok-basics" scope="Shortcuts">
        <div className="ss-group">
          {brand && colorRow(brand, true)}
          {fontsOrdered.map(fontRow)}
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
        <div className="ss-text-list">{group('text').map(textRow)}</div>
      </Section>

      <Section title="Layout" id="tok-layout" defaultOpen={false} scope={changedNote(layoutIds)}>
        {LAYOUT_GROUPS.filter(({ group: g }) => group(g).length).map(({ group: g, label }) => {
          const max = Math.max(...group(g).map((t) => toPx(String(t.value)) ?? clampRange(String(t.value))?.[1] ?? 0));
          return (
            <div className="ss-group" key={g} role="group" aria-label={label}>
              <div className="ss-group-label">{label}</div>
              {group(g).map((t) => layoutRow(g, t, max))}
            </div>
          );
        })}
      </Section>

      <Section title="Your styles" id="tok-custom" defaultOpen={st.tokens.custom.length > 0} scope={st.tokens.custom.length ? String(st.tokens.custom.length) : undefined}>
        <CustomTokens state={st} />
      </Section>

      <Section title="Site details" id="site-settings" defaultOpen={false}>
        <Field label="Site name">
          <DraftInput value={site.name} onCommit={(v) => v.trim() && updSite({ name: v.trim() })} />
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
            {Object.values(st.assets.assets).filter((a) => a.kind === 'image').map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Social sharing image">
          <select className="select" value={site.socialImage ?? ''} onChange={(e) => updSite({ socialImage: e.target.value || null })}>
            <option value="">None</option>
            {Object.values(st.assets.assets).filter((a) => a.kind === 'image').map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      </Section>
    </div>
  );
}
