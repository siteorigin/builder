import { variantOptions } from '@shared/variants';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Globe, Link2, RotateCcw, TriangleAlert } from 'lucide-react';
import type { EntityKind, ProjectState, SiteIdentity, TextStyleValue, TokenDef } from '@shared/types';
import { followToken, followedText, textMetrics, tokenVar } from '@shared/styles';
import { buttonStyleIds, tokenFollowers } from '@shared/button-styles';
import { effectiveTokens } from '@generator/index';
import { hasDarkPalette, type PaletteScheme } from '@shared/color-scheme';
import { ColorSchemeControls } from './ColorSchemeControls';
import { PaletteHarmony } from './PaletteHarmony';
import { getTheme, listThemes, themePinProblem, type ThemePack } from '@catalogue/index';
import { comparePackVersions, PACK_VERSION_RE } from '@catalogue/pack';
import { usePackPreview } from '../components/PackPreview';
import { installedFonts } from '@catalogue/fonts';
import { activePairing, activeTypeScale, availablePairings, pairingOps, scaleRoles, sizeAtWidth, typeScale, typeScaleOps, TYPE_SCALE_CHOICES, type TypeScaleChoice } from '@shared/type-scale';
import { allTrees, instancesOf } from '@engine/tree';
import { forEachTokenPropRef, tokenResetOrder } from '@engine/tokens';
import { api, applyOps, claimRefusals, commitOps, dismissToast, getState, setState, shownAt, toast, undoAction, undoAvailable, useStore } from '../store';
import { openSiteStyles } from '../lib/actions';
import { afterEditsSettle } from '../lib/pending';
import { settleEdits } from '../lib/leave';
import { ColorPick, opacityWords } from '../components/ColorPick';
import { ColorTextInput } from '../components/ColorTextInput';
import { useJumpMark } from '../lib/use-jump-mark';
import { ChoiceField, Disclosure, DisclosureMark, DraftInput, Field, InfoTip, Section, Segmented, openSection, type DraftHandle, type DraftProblem } from '../components/ui';
import { TEXT_LIMITS } from '@shared/text-limits';
import { CustomTokens } from './CustomTokens';
import { SiteImageField } from './PropEditors';
import { FontSelect, familyName } from './FontSelect';
import { usePreviewStack } from '../lib/editor-fonts';
import { BrandContrast, ContrastDetail, ContrastFlags, buildContrastModel, useContrastStatus } from './ContrastNotes';
import type { ContrastPair, ForegroundSuggestion } from '@shared/contrast';
import { NOT_FOUND_ENGLISH, NOT_FOUND_LIMITS, clipText, notFoundCopy, notFoundDefaults, notFoundEnglish } from '@shared/not-found';
import { VisitorTextFields, WordingField, visitorTextScope, type Wording } from './VisitorText';
import { directionHint, languageCodeFor, namedLanguage, notFoundScope, ownWording, siteDetailsScope } from './site-details';
import { AgentDiscoveryFields, agentsScope } from './AgentDiscovery';
import { SiteSearchFields, siteSearchScope } from './SiteSearchFields';
import { CrawlerPolicyFields } from './CrawlerPolicy';
import { RedirectsFields } from './RedirectsManager';
import { IntegrationFields, SiteCodeFields, integrationsScope, siteCodeScope } from './SiteCode';
import { redirectRecords } from '@shared/redirects';
import { itemStyleRecords } from '@shared/item-styles';
import { checkPublicUrl, publicUrl } from '@shared/public-url';
import { isLanguageCode, siteDirection, siteLanguage, siteLanguageProblem } from '@shared/languages';
import { carrySiteName, siteNameNote, siteNameText } from '@shared/site-name';
import { ENTITY_KIND_LABELS, ENTITY_KINDS, IDENTITY_LIMITS, checkCoordinates, checkEmail, checkHoursList, checkProfileUrl, checkProfiles, checkTelephone, checkTwitterHandle, coordinatesText, isEntityKind, type Checked, type IdentityPatch } from '@shared/site-identity';
import './SiteStyles.css';

/**
 * What the Foundation theme uses each colour for, checked against its base CSS and component styles, so an
 * owner can predict what a change affects. Short enough to sit on one line under the colour's name.
 */
const FOUNDATION_USES: Record<string, string> = {
  'color.background': 'Page background',
  'color.surface': 'Plans and contact boxes',
  'color.surface-alt': 'Alternate sections',
  'color.text': 'Headings and body text',
  'color.muted': '',
  'color.brand': 'Buttons, links, highlights',
  'color.brand-strong': 'Buttons on hover',
  'color.on-brand': 'Text on buttons',
  'color.accent': 'Decorative highlights',
  'color.inverse': '',
  'color.on-inverse': '',
  'color.border': 'Dividers',
  // The label says it ("Keyboard focus outline", "Text on dark sections"): no second line.
  'color.focus': '',
  'color.error': 'Form errors',
  'color.error-on-inverse': 'Errors in dark sections'
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

const NO_PAIRS: readonly ContrastPair[] = [];

/** Colour roles grouped by purpose, brand first: it is the one most owners change. Unknown ids go last. */
const COLOR_GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: 'Brand and accent', ids: ['color.brand', 'color.brand-strong', 'color.on-brand', 'color.accent'] },
  { label: 'Backgrounds', ids: ['color.background', 'color.surface', 'color.surface-alt'] },
  { label: 'Text', ids: ['color.text', 'color.muted'] },
  { label: 'Dark areas', ids: ['color.inverse', 'color.on-inverse'] },
  { label: 'Lines and focus', ids: ['color.border', 'color.focus'] },
  { label: 'Form errors', ids: ['color.error', 'color.error-on-inverse'] }
];

/** The jump links under the panel's header, one for each section in order. */
const JUMPS = [
  { id: 'tok-basics', label: 'Basics' },
  { id: 'tok-color', label: 'Colors' },
  { id: 'tok-text', label: 'Text' },
  { id: 'tok-buttons', label: 'Buttons' },
  { id: 'tok-layout', label: 'Layout' },
  { id: 'tok-custom', label: 'Yours' },
  { id: 'site-settings', label: 'Site' }
];
/** The jump links for a theme: Buttons only when it declares a button style, as its section shows only then. */
const jumpsFor = (buttons: boolean) => (buttons ? JUMPS : JUMPS.filter((j) => j.id !== 'tok-buttons'));

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
        : t.owner.kind === 'shell' || t.owner.kind === 'template'
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
  // A placement's token property (an accent colour, a spacing step) uses the style it chooses.
  forEachTokenPropRef(state, (id, site) => {
    if (site.owner.kind === 'page') at(id).pages.set(site.owner.id, site.label);
    else if (site.owner.kind === 'shell' || site.owner.kind === 'template') at(id).shared.add(site.label);
    else if (instancesOf(state, site.owner.id).length) at(id).components.set(site.owner.id, site.label);
  });
  return uses;
}

/** The widths the type specimen shows each text style at: a phone, and a desktop window. */
const SPECIMEN_WIDTHS = [
  { label: 'Phone', width: 375 },
  { label: 'Desktop', width: 1280 }
] as const;
/** A size drawn small enough for the dock and in the same order as the real ones: body text reads at 13px, the biggest display near 36px. */
const specimenPx = (px: number) => Math.round(13 * Math.pow(Math.max(px, 1) / 16, 0.55) * 2) / 2;

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
/** A weight as said beside a size: a named one by its name, any other as "Weight 480", never a bare number. */
const weightWords = (w: number) => WEIGHTS.find(([n]) => n === w)?.[1] ?? `Weight ${w}`;
/** A size in pixels as the size fields show it: to one decimal, without a trailing zero. */
const pxText = (px: number) => `${Math.round(px * 10) / 10}px`;
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
      {/* A fold: the CSS opens below its trigger, so the next Tab goes into it. */}
      <button className="disclosure-trigger ss-shadow-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DisclosureMark />
        Edit as CSS
        <span className="sr-only"> for {name}</span>
      </button>
      {open && <DraftInput multiline rows={2} className="textarea mono ss-css-area" value={value} ariaLabel={`${name} as CSS`} onCommit={(v) => (v.trim() ? onCommit(v.replace(/\s+/g, ' ').trim()) : false)} />}
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
/** Where a changed value goes back to: the theme's default, or (in the dark palette) the colour of the light one. */
const RESET_FROM = { theme: ['the theme', "the theme's"], light: ['the light colors', "the light colors'"] } as const;

function ResetDot({ label, theme, onReset, from = 'theme' }: { label: string; theme: string; onReset: () => unknown; from?: keyof typeof RESET_FROM }) {
  const say = useContext(SayContext);
  const [origin, whose] = RESET_FROM[from];
  return (
    <button
      className="reset-dot"
      title={`Changed from ${origin}. Click to go back to ${whose} ${theme}.`}
      aria-label={`Set ${label} back to ${whose} ${theme}`}
      onClick={(e) => {
        const row = e.currentTarget.closest('[data-ss-row]');
        const item = e.currentTarget.closest('li');
        // The next change's reset, or the one before when this was the last: never the list's own footer.
        const next = item?.nextElementSibling?.querySelector<HTMLElement>('.reset-dot') ?? item?.previousElementSibling?.querySelector<HTMLElement>('.reset-dot') ?? null;
        const panel = e.currentTarget.closest('.ss');
        const trigger = e.currentTarget;
        // Said once the change has saved, never before: a refused reset says nothing.
        void Promise.resolve(onReset()).then((ok) => ok !== null && ok !== false && say(`${label} is back to ${whose} ${theme}.`));
        refocus(trigger, row, next, () => panel?.querySelector<HTMLElement>('.ss-changes button, .ss-theme-change, .ss-color.compact input.ss-hex') ?? panel?.querySelector<HTMLElement>('.insp-jump button') ?? null);
      }}
    >
      <RotateCcw />
    </button>
  );
}

/** Site details, wherever the author has gone since: Keep editing returns to a field in it. */
const revealSiteDetails = () => {
  openSiteStyles();
  openSection('site-settings', { scroll: false });
};

/** Why the Public URL field can't save this text, with the address most likely meant. */
function publicUrlProblem(text: string): DraftProblem | null {
  const c = checkPublicUrl(text);
  if (c.ok) return null;
  return c.suggestion ? { message: c.message, suggestion: c.suggestion, fix: /^http:/i.test(text.trim()) ? 'Use https://' : 'Add https://' } : { message: c.message };
}

/**
 * A site setting checked before it is saved. Text it can't take stays in the field as an unsaved draft, with the
 * reason, the value still saved, and a correction when there is one, until it is corrected or discarded (Escape).
 * A saved value that can't be used (saved by hand or by an earlier version) is pointed out the same way.
 */
function CheckedField({ label, hint, info, value: saved, check, onCommit, unusable, className, placeholder, id, multiline, rows }: { id?: string; label: string; hint?: ReactNode; info?: ReactNode; value: unknown; check: (v: string) => DraftProblem | null; onCommit: (v: string) => unknown; unusable: string; className?: string; placeholder?: string; multiline?: boolean; rows?: number }) {
  // A value of another kind (written by hand into the project's files) is shown as text, to be corrected.
  const value = typeof saved === 'string' ? saved : saved == null ? '' : JSON.stringify(saved);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [dirty, setDirty] = useState(false);
  const handle = useRef<DraftHandle | null>(null);
  // What is wrong with the saved value describes the field only while it shows that value.
  const shown = problem ?? (value && !dirty ? check(value) : null);
  const fix = shown?.suggestion;
  const error = shown && (
    <>
      <span role={problem ? 'alert' : undefined}>
        {shown.message}{' '}
        {problem ? (
          <span className="field-saved">
            Not saved. {value ? <>The saved value is still <bdi>{value}</bdi>.</> : 'Nothing is saved here yet.'}
          </span>
        ) : (
          unusable
        )}
      </span>
      {fix && (
        <button type="button" className="link-btn field-fix" onClick={() => handle.current?.commit(fix)}>
          {shown.fix ?? `Use ${fix}`}
        </button>
      )}
    </>
  );
  return (
    <Field label={label} hint={hint} info={info} error={error}>
      <DraftInput id={id} className={className} value={value} placeholder={placeholder} multiline={multiline} rows={rows} check={check} onProblem={setProblem} onDirty={setDirty} reveal={revealSiteDetails} handle={handle} onCommit={onCommit} />
    </Field>
  );
}

/**
 * A site picture with its guidance: the card names it (the title sits inside, as every image field has it) and the
 * guidance under it is read with that name.
 */
function SiteImage({ id, hint, ...field }: { id: string; hint: string } & Parameters<typeof SiteImageField>[0]) {
  const hintId = `${id}-hint`;
  return (
    <div className="field" id={id}>
      <SiteImageField {...field} describedBy={hintId} />
      <div className="field-hint" id={hintId}>
        {hint}
      </div>
    </div>
  );
}

/** What a type scale does, behind the info button beside Type scale. */
const SCALE_INFO = 'A scale sets the size, line height and letter spacing of every style in the table at once, keeping their fonts. The samples are drawn smaller; the numbers are the sizes on the site.';

/** The longest language code a site can save (the site.update operation's limit). */
const LANGUAGE_CODE_MAX = 20;
/** The code the Language field saves for what was typed: a language's name ("French") as its code ("fr"), else the text. */
const languageTyped = (v: string) => languageCodeFor(v) ?? v.trim();
/** What the Language field says about text that is neither a code nor a language it knows by name. */
const LANGUAGE_TYPED_ERROR = 'Type a language, such as Spanish, or a code, such as en-AU.';
/** The site's language, typed as a code or as a language's name; either is checked as the code it saves. */
function siteLanguageCheck(state: ProjectState) {
  return (v: string): DraftProblem | null => {
    const code = languageTyped(v);
    if (!isLanguageCode(code)) return { message: LANGUAGE_TYPED_ERROR };
    if (code.length > LANGUAGE_CODE_MAX) return { message: `A language code can be at most ${LANGUAGE_CODE_MAX} characters.` };
    const problem = siteLanguageProblem(state, code);
    return problem ? { message: problem } : null;
  };
}
/**
 * The site name can't be empty, nor longer than a header or footer text that follows it can hold: the rename is tried
 * on a copy of the shared header and footer, so checking it changes nothing.
 */
function siteNameCheck(state: ProjectState) {
  return (v: string): DraftProblem | null => {
    const name = siteNameText(v);
    if (!name) return { message: 'Enter a site name.' };
    if (name === state.site.name) return null;
    const problem = carrySiteName({ ...state, site: { ...state.site, shell: structuredClone(state.site.shell) } }, state.site.name, name);
    return problem ? { message: problem } : null;
  };
}

/** The not-found page's three wordings, in page order: each falls back to the built-in wording when left empty. */
const NOT_FOUND_FIELDS: Array<Wording & { key: 'notFoundHeading' | 'notFoundMessage' | 'notFoundLinkLabel'; limit: number; copy: 'heading' | 'message' | 'linkLabel' }> = [
  { key: 'notFoundHeading', copy: 'heading', label: 'Heading', hint: 'The page’s main heading.', limit: NOT_FOUND_LIMITS.heading },
  { key: 'notFoundMessage', copy: 'message', label: 'Message', hint: 'Under the heading: what happened, and where to go.', limit: NOT_FOUND_LIMITS.message },
  { key: 'notFoundLinkLabel', copy: 'linkLabel', label: 'Home link', hint: 'The link at the end of the page, to your home page.', limit: NOT_FOUND_LIMITS.linkLabel }
];

/**
 * The page visitors see at an address the site does not have: its wording, each the author's own or the built-in
 * wording (shown while the field is empty, and under it once it holds text), and the page as it reads with them.
 */
function NotFoundFields({ site, onCommit }: { site: ProjectState['site']; onCommit: (patch: Record<string, string>) => unknown }) {
  const say = useContext(SayContext);
  const defaults = notFoundDefaults(siteLanguage(site));
  const shown = notFoundCopy(site);
  const language = siteLanguage(site);
  // Marked as the website marks it: built-in English reads as English, left to right.
  const english = notFoundEnglish(site);
  const phrase = (key: keyof typeof shown) => (english[key] ? <span {...NOT_FOUND_ENGLISH}>{shown[key]}</span> : shown[key]);
  return (
    <>
      <p className="agents-intro">Visitors see this page, with your header and footer, at any address your site doesn’t have. Leave a field empty to use the wording shown.</p>
      {NOT_FOUND_FIELDS.map((f) => (
        <WordingField
          key={f.key}
          f={f}
          limit={f.limit}
          own={ownWording(site[f.key])}
          fallback={defaults[f.copy]}
          onCommit={(v) => {
            const text = clipText(v.trim(), f.limit);
            const saved = onCommit({ [f.key]: text });
            // Putting a wording back is said once it has saved: a refused save says nothing.
            if (!text && ownWording(site[f.key])) void Promise.resolve(saved).then((ok) => ok !== null && ok !== false && say(`${f.label} is back to “${defaults[f.copy]}”.`));
            return saved;
          }}
        />
      ))}
      <figure className="nf-preview" aria-label="How the page reads">
        <figcaption className="ss-group-label">How the page reads</figcaption>
        <div className="nf-page" lang={language} dir={siteDirection(site)}>
          <div className="nf-heading">{phrase('heading')}</div>
          <p className="nf-message">{phrase('message')}</p>
          <span className="nf-link">{phrase('linkLabel')}</span>
        </div>
      </figure>
    </>
  );
}

/** A check's refusal as a field shows it. */
const refusalOf = <T,>(c: Checked<T>): DraftProblem | null => (c.ok ? null : { message: c.message });
/**
 * Saves a field's checked value, or refuses the text (false) without saving anything: a field that leaves with text
 * its check refuses (one unmounted while focused) must never clear what was saved.
 */
const commitChecked = <T,>(c: Checked<T>, save: (value: T) => unknown): unknown => (c.ok ? save(c.value) : false);
const textOf = (v: unknown) => (typeof v === 'string' ? v : '');
const linesOf = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : textOf(v));

/**
 * Who publishes the site (shared/site-identity.ts), as its pages tell search engines and AI answer engines: its kind,
 * name, home page, logo, profiles elsewhere and contact details, and a local business's hours, prices and place on the
 * map. Each field saves on its own, and text it can't take stays in it with the reason, as the Public URL does.
 */
function IdentityFields({ state, workspaceKey, onPatch }: { state: ProjectState; workspaceKey?: string; onPatch: (patch: IdentityPatch) => unknown }) {
  const uid = useId();
  const raw: unknown = state.site.identity;
  const identity = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<Record<keyof SiteIdentity, unknown>>;
  const kind: EntityKind | '' = isEntityKind(identity.kind) ? identity.kind : '';
  const unusable = 'The website leaves it out until it is corrected.';
  // Keyed by the project's opening: text one project refused never shows in the next.
  const key = (field: string) => `identity-${field}-${workspaceKey}`;
  return (
    <div className="ss-group sd-group" role="group" aria-labelledby={`${uid}-identity`}>
      <div className="ss-group-label" id={`${uid}-identity`}>
        Publisher
      </div>
      <Field
        label="Published by"
        hint={kind === 'LocalBusiness' && (identity.openingHours || identity.priceRange || identity.geo) ? 'Another kind clears hours, prices and map position' : undefined}
        info="Who search engines and AI answer engines are told the site belongs to."
      >
        <select id="site-identity-kind" className="select" value={kind} onChange={(e) => onPatch({ kind: isEntityKind(e.target.value) ? e.target.value : null })}>
          <option value="">Organization (default)</option>
          {ENTITY_KINDS.map((k) => (
            <option key={k} value={k}>
              {ENTITY_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name">
        <DraftInput id="site-identity-name" value={textOf(identity.name)} placeholder={state.site.name} limit={IDENTITY_LIMITS.name} quietCount onCommit={(v) => onPatch({ name: v.trim() || null })} />
      </Field>
      <CheckedField
        key={key('url')}
        id="site-identity-url"
        label="Home page"
        info="The publisher’s own website, when it is not this one."
        value={identity.url}
        placeholder="https://"
        check={(v) => refusalOf(checkProfileUrl(v, 'The home page address'))}
        unusable={unusable}
        onCommit={(v) => commitChecked(checkProfileUrl(v), (url) => onPatch({ url: url || null }))}
      />
      <SiteImage id="site-identity-logo" title={kind === 'Person' ? 'Photo' : 'Logo'} plain="logo" state={state} value={textOf(identity.logo) || null} onChange={(id) => onPatch({ logo: id })} hint={kind === 'Person' ? 'A photo shown beside your name' : 'Square, shown beside the name in results'} />
      <CheckedField
        key={key('profiles')}
        id="site-identity-profiles"
        label="Profiles"
        hint="One address per line"
        info="Pages elsewhere that say who it is, such as Wikidata, LinkedIn, GitHub, X or YouTube."
        value={linesOf(identity.sameAs)}
        placeholder="https://www.wikidata.org/wiki/…"
        multiline
        rows={3}
        check={(v) => refusalOf(checkProfiles(v))}
        unusable={unusable}
        onCommit={(v) => commitChecked(checkProfiles(v), (sameAs) => onPatch({ sameAs }))}
      />
      <CheckedField key={key('x')} id="site-identity-x" label="X handle" value={identity.twitterSite} placeholder="@" check={(v) => refusalOf(checkTwitterHandle(v))} unusable={unusable} onCommit={(v) => commitChecked(checkTwitterHandle(v), (handle) => onPatch({ twitterSite: handle || null }))} />
      <Field label="Address">
        <DraftInput id="site-identity-address" value={textOf(identity.address)} limit={IDENTITY_LIMITS.address} quietCount onCommit={(v) => onPatch({ address: v.trim() || null })} />
      </Field>
      <CheckedField key={key('telephone')} id="site-identity-telephone" label="Telephone" hint="With the country code" placeholder="+27 21 555 0134" value={identity.telephone} check={(v) => refusalOf(checkTelephone(v))} unusable={unusable} onCommit={(v) => commitChecked(checkTelephone(v), (telephone) => onPatch({ telephone: telephone || null }))} />
      <CheckedField key={key('email')} id="site-identity-email" label="Email" value={identity.email} check={(v) => refusalOf(checkEmail(v))} unusable={unusable} onCommit={(v) => commitChecked(checkEmail(v), (email) => onPatch({ email: email || null }))} />
      {kind === 'LocalBusiness' && (
        <>
          <CheckedField
            key={key('hours')}
            id="site-identity-hours"
            label="Opening hours"
            hint="One period per line, 24-hour clock"
            info="Days then hours, such as Mo-Fr 09:00-17:00 or Sa 10:00-14:00."
            placeholder="Mo-Fr 09:00-17:00"
            value={linesOf(identity.openingHours)}
            multiline
            rows={3}
            check={(v) => refusalOf(checkHoursList(v))}
            unusable={unusable}
            onCommit={(v) => commitChecked(checkHoursList(v), (openingHours) => onPatch({ openingHours }))}
          />
          <Field label="Price range">
            <DraftInput id="site-identity-price" placeholder="$$ or R100–R400" value={textOf(identity.priceRange)} limit={IDENTITY_LIMITS.priceRange} quietCount onCommit={(v) => onPatch({ priceRange: v.trim() || null })} />
          </Field>
          <CheckedField
            key={key('geo')}
            id="site-identity-geo"
            label="Map position"
            hint="Latitude, longitude"
            placeholder="-33.92, 18.42"
            value={coordinatesText(identity.geo as SiteIdentity['geo'])}
            check={(v) => refusalOf(checkCoordinates(v))}
            unusable={unusable}
            onCommit={(v) => commitChecked(checkCoordinates(v), (geo) => onPatch({ geo }))}
          />
        </>
      )}
    </div>
  );
}

/** The preview a theme is pictured by: its split hero, or else its first section with a thumbnail. */
function themeShotFile(theme: Pick<ThemePack, 'previews'>): string | undefined {
  return theme.previews?.['hero.split']?.default ?? Object.values(theme.previews ?? {})[0]?.default;
}

/**
 * The theme as it was drawn when its pack was built, in its own colours and fonts. Decorative: the swatch beside its
 * name shows the site's own colours, and stays the only picture for a pack built without thumbnails.
 */
function ThemeShot({ theme }: { theme: ThemePack }) {
  const url = usePackPreview(theme.id, themeShotFile(theme));
  // A pack built without thumbnails is pictured by its own colours and display font instead of an empty frame.
  if (!url) return <ThemeSketch theme={theme} />;
  return <img className="ss-theme-shot" src={url} alt="" draggable={false} data-theme={theme.id} />;
}

/** A theme's own colour, as its pack sets it: a literal or one reference deep. */
function packHex(theme: ThemePack, id: string): string | undefined {
  const v = theme.tokens.find((t) => t.id === id)?.value;
  const ref = refOf(v);
  const value = ref ? theme.tokens.find((t) => t.id === ref)?.value : v;
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;
}

/** The stand-in for a theme with no thumbnail: a heading and a button on its background, in its own colours. */
function ThemeSketch({ theme }: { theme: ThemePack }) {
  const font = theme.tokens.find((t) => t.id === 'font.display')?.value;
  return (
    <span className="ss-theme-shot ss-theme-sketch" style={{ background: packHex(theme, 'color.background'), color: packHex(theme, 'color.text') }} aria-hidden="true">
      <span style={{ fontFamily: typeof font === 'string' ? font : undefined }}>Aa</span>
      <i style={{ background: packHex(theme, 'color.brand') }} />
    </span>
  );
}

/** A folder's path, breaking only after its separators so no folder name is split across lines. */
function FolderPath({ path }: { path: string }) {
  const parts = path.split(/(?<=[\\/])/);
  return (
    <code>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          <wbr />
        </span>
      ))}
    </code>
  );
}

/** What the theme card draws of the site's own look: its colours and display font. */
interface SiteLook {
  background?: string;
  text?: string;
  brand?: string;
  dots: string[];
  font?: string;
  /** For the larger sample of a theme before it is used: its text on the brand colour, and the font's name. */
  onBrand?: string;
  fontName?: string;
}

/** The site's name set in a theme's colours and display font, on a button and its palette: the site as it would be. */
function LookSample({ look, name }: { look: SiteLook; name: string }) {
  return (
    <div className="ss-theme-sample" style={{ background: look.background, color: look.text }} aria-hidden="true">
      <span className="ss-theme-sample-name" style={{ fontFamily: look.font }}>
        {name}
      </span>
      <span className="ss-theme-sample-row">
        <span className="ss-theme-sample-button" style={{ background: look.brand, color: look.onBrand }}>
          Button
        </span>
        <span className="ss-look-dots">
          {look.dots.map((c, i) => (
            <i key={i} style={{ background: c }} />
          ))}
        </span>
      </span>
    </div>
  );
}

/** A tiny page in a site's colours and display font: a heading, a button and the palette. */
function LookSwatch({ look }: { look: SiteLook }) {
  return (
    <div className="ss-look" style={{ background: look.background, color: look.text }} aria-hidden="true">
      <span className="ss-look-type" style={{ fontFamily: look.font }}>
        Aa
      </span>
      <span className="ss-look-button" style={{ background: look.brand }} />
      <span className="ss-look-dots">
        {look.dots.map((c, i) => (
          <i key={i} style={{ background: c }} />
        ))}
      </span>
    </div>
  );
}

/**
 * The theme card: what the site is built on, a deliberate way to move it to another installed theme, and how far it
 * has moved from its theme (`changes`). Picking a theme in the chooser only picks it, and shows it as designed and
 * with the site's own changes on it (`lookOf`); the button under the list makes the switch and says what it keeps,
 * and the card then says it happened, with an Undo for that switch while it can still be undone. A project open
 * read-only gets the reason in the card instead, and nothing the project would refuse.
 */
function ThemeCard({ st, theme, themes, look, lookOf, changedCount, changes, say }: { st: ProjectState; theme: ThemePack; themes: ThemePack[]; look: SiteLook; lookOf: (themeId: string) => SiteLook; changedCount: number; changes: ReactNode; say: (text: string) => void }) {
  const uid = useId();
  const snap = useStore((s) => s.snapshot);
  const refusedPacks = useStore((s) => s.packs.refused);
  const packsDir = useStore((s) => s.packs.userDir);
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState(theme.id);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The switch this card just made, for its receipt and Undo, shown while that history entry can still be undone.
  const [done, setDone] = useState<{ from: ThemePack; to: string; kept: number; undo: ReturnType<typeof undoAction> } | null>(null);
  const missing = theme.id !== st.site.themeId;
  // Why the project is open read-only because of its theme: not installed, or not the copy it was made with.
  const pin = themePinProblem(st);
  const readOnly = snap?.readOnly;
  const live = !!done && done.to === st.site.themeId && !!done.undo?.undoes && undoAvailable(done.undo.undoes, snap);
  // Undone, by any route: said once. The switch is kept, so a redo brings its receipt and Undo back.
  const wasLive = useRef(false);
  // Set when this card makes the switch, which it says itself; a later return of the same entry is a redo.
  const fresh = useRef(false);
  useEffect(() => {
    if (wasLive.current && !live && done && st.site.themeId === done.from.id) say(`Back on ${done.from.name}.`);
    if (!wasLive.current && live && done) {
      if (fresh.current) fresh.current = false;
      else say(`Switched to ${getTheme(done.to).name} again.`);
    }
    wasLive.current = live;
  }, [live, done, st.site.themeId, say]);
  // A project held read-only by its theme: the card shows what the project records, never the copy it refused.
  const blocked = missing || !!pin;
  const canSwitch = themes.length > 1 && !readOnly && !pin;
  const next = themes.find((t) => t.id === picked) ?? theme;
  const chooserId = `${uid}-chooser`;
  const changeId = `${uid}-change`;
  const focusChange = () => requestAnimationFrame(() => document.getElementById(changeId)?.focus());
  const close = (focus = true) => {
    if (busy) return;
    setChoosing(false);
    setRefusal(null);
    if (focus) focusChange();
  };
  const open = () => {
    setPicked(theme.id);
    setRefusal(null);
    setChoosing(true);
    // Into the list at the theme in use, as a radio group is entered.
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`#${CSS.escape(chooserId)} input:checked`)?.focus());
  };
  // A click brings the picked theme's preview and the switch into view, as a long list can push them below the panel.
  // Arrowing through the list leaves the scroll to the focused row, so browsing never loses its place.
  const pointer = useRef(false);
  const pick = (id: string) => {
    setPicked(id);
    setRefusal(null);
    if (pointer.current) requestAnimationFrame(() => document.querySelector(`#${CSS.escape(chooserId)} .ss-theme-confirm`)?.scrollIntoView({ block: 'nearest' }));
    pointer.current = false;
  };
  const use = async () => {
    if (next.id === theme.id || busy) return;
    setBusy(true);
    setRefusal(null);
    const from = theme;
    const opening = getState().snapshot?.workspaceKey;
    let started: { ok: true; value: Awaited<ReturnType<typeof commitOps>> } | { ok: false; problems: string[] };
    try {
      // What is still being typed lands first: the site is saved to Saved versions as it is before the switch (#1156).
      started = await afterEditsSettle(
        () => settleEdits(),
        // The refusal is said where it is shown (role=alert), once.
        async () =>
          getState().snapshot?.workspaceKey !== opening
            ? null
            : claimRefusals(
                (e) => {
                  setRefusal(e.message);
                  return true;
                },
                () => commitOps([{ type: 'theme.apply', themeId: next.id }], `Switch theme to ${next.name}`)
              )
      );
    } catch (e) {
      started = { ok: false, problems: [`The theme was not changed: ${(e as Error).message}`] };
    } finally {
      setBusy(false);
    }
    if (!started.ok) return setRefusal(started.problems[0]);
    const r = started.value;
    if (!r?.ok) return;
    fresh.current = true;
    setDone({ from, to: next.id, kept: changedCount, undo: undoAction(r) });
    say(`Switched to ${next.name}. Your content${changedCount ? ` and ${plural(changedCount, 'changed style', 'changed styles')} were` : ' was'} kept. You can undo this.`);
    setChoosing(false);
    focusChange();
  };
  const lock = st.themeLock?.theme?.id === st.site.themeId ? st.themeLock.theme : undefined;
  // The first thing to do for each way the installed copy can be the wrong one (themePinProblem's cases).
  const pinFix =
    theme.source === 'user' && !lock?.digest
      ? 'The site doesn’t record which copy of the theme it was made with. Open it in the copy of SiteOrigin Builder it was made with and switch its theme there.'
      : lock?.digest && theme.source !== 'user'
        ? 'A theme that comes with SiteOrigin Builder now has the same name as the theme this site was made with. Open the site in the version of SiteOrigin Builder it was made with and switch it to another theme there.'
        : lock && (typeof lock.version !== 'string' || !PACK_VERSION_RE.test(lock.version))
          ? 'The site’s record of its theme version is damaged: restore siteorigin/theme-lock.json from the copy the site was made with.'
          : lock && comparePackVersions(theme.version, lock.version) < 0
            ? `The site was made with version ${lock.version} of this theme, and the installed copy is the older ${theme.version}. Install ${lock.version} or a newer version, then restart SiteOrigin Builder.`
            : 'The installed copy isn’t the one the site was made with: reinstall that copy, then restart SiteOrigin Builder.';
  const kept = changedCount ? `Your content and the ${plural(changedCount, 'style', 'styles')} you changed are kept.` : 'Your content and any style changes are kept.';
  const nextLook = next.id !== theme.id ? lookOf(next.id) : null;
  // The picked theme's own picture, once it has loaded: without one, the sample takes the room.
  const nextShot = usePackPreview(nextLook ? next.id : undefined, themeShotFile(next));
  // An installed copy of the site's own theme that could not be loaded is the same problem as the missing theme.
  const ownRefusal = missing ? refusedPacks.find((r) => r.packId === st.site.themeId) : undefined;
  const otherRefused = refusedPacks.filter((r) => r !== ownRefusal);

  return (
    <div className="ss-theme" data-missing={missing ? '' : undefined}>
      {blocked ? (
        <>
          <div className="ss-theme-text">
            <div className="ss-eyebrow">Theme</div>
            <div className="ss-theme-name">
              <strong>{missing ? st.site.themeId : theme.name}</strong>
              {lock && <span className="ss-theme-version">{lock.version}</span>}
              <span className="ss-theme-chip">{!missing ? 'Can’t be used' : ownRefusal ? 'Couldn’t load' : 'Not installed'}</span>
            </div>
          </div>
          {/* What it means and what to do, in the owner's words; the exact reason stays one click away, for support. */}
          <div className="scope-note danger" role="note">
            <TriangleAlert />
            <div className="ss-theme-blocked">
              <span>
                {missing ? (
                  <>
                    <strong>This site’s theme {ownRefusal ? 'couldn’t be loaded' : 'isn’t installed'}</strong>, so the site is open read-only and can’t be previewed. {ownRefusal ? 'Reinstall a fresh copy of it' : 'Install it'}, then restart SiteOrigin Builder. A theme that came with the app comes back when you reinstall the app.
                  </>
                ) : (
                  <>
                    <strong>This site’s theme can’t be used here</strong>, so the site is open read-only. {pinFix}
                  </>
                )}
              </span>
              {packsDir && (
                <span className="ss-theme-folder">
                  Installed themes go in <FolderPath path={packsDir} />
                </span>
              )}
              {(ownRefusal || !missing) && (
                <Disclosure className="ss-packs-fold" summary={ownRefusal ? 'Why it couldn’t be loaded' : 'Why it can’t be used'}>
                  <span className="ss-theme-reason ss-packs-detail">{ownRefusal ? ownRefusal.reason : pin}</span>
                </Disclosure>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="ss-theme-id">
          <LookSwatch look={look} />
          <div className="ss-theme-text">
            <div className="ss-eyebrow">Theme</div>
            <div className="ss-theme-name">
              <strong>{theme.name}</strong>
              <span className="ss-theme-version">{theme.version}</span>
            </div>
          </div>
        </div>
      )}
      {!pin && readOnly && themes.length > 1 && (
        <p className="ss-theme-what">This site is open read-only, so its theme can’t be changed.</p>
      )}
      {live && !choosing && done && (
        <div className="ss-theme-receipt">
          <Check />
          <span>
            Switched from {done.from.name}. Your content{done.kept ? ` and ${plural(done.kept, 'changed style', 'changed styles')}` : ''} came with it.{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                done.undo?.run();
                focusChange();
              }}
            >
              Undo
            </button>
          </span>
        </div>
      )}
      {canSwitch && (
        <div className="ss-theme-actions">
          <button type="button" id={changeId} className="btn btn-sm ss-theme-change" data-theme-chooser="" aria-expanded={choosing} aria-controls={chooserId} disabled={busy} onClick={() => (choosing ? close() : open())}>
            <DisclosureMark />
            Change theme
          </button>
          <span className="ss-theme-count">{themes.length - 1 === 1 ? '1 other installed' : `${themes.length - 1} others installed`}</span>
        </div>
      )}
      {canSwitch && (
        <div
          className="ss-theme-chooser"
          id={chooserId}
          hidden={!choosing}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          {choosing && (
            <>
              <fieldset className="ss-theme-options" disabled={busy} onKeyDown={() => (pointer.current = false)}>
                <legend className="ss-theme-legend">Choose a theme</legend>
                {themes.map((t) => (
                  <label key={t.id} className="ss-theme-option" data-theme-option={t.id} onPointerDown={() => (pointer.current = true)}>
                    <input type="radio" name={`${uid}-theme`} value={t.id} checked={picked === t.id} onChange={() => pick(t.id)} />
                    <ThemeShot theme={t} />
                    <span className="ss-theme-option-text">
                      <span className="ss-theme-option-name">
                        <strong>{t.name}</strong>
                        {t.id === theme.id && <span className="ss-theme-chip">Current</span>}
                      </span>
                      <span className="ss-theme-option-desc">{t.description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {nextLook && (
                <div className="ss-theme-preview" role="group" aria-label={`${next.name}, before you switch`} data-single={nextShot ? undefined : ''}>
                  {/* Your site first: it is what the switch gives you. The pack's picture shows its layouts. */}
                  <figure>
                    <LookSample look={nextLook} name={st.site.name || next.name} />
                    <figcaption>
                      {changedCount ? 'With your changes' : 'Its colors and font'}
                      <span className="sr-only">
                        : headings in {nextLook.fontName}, brand color {nextLook.brand}
                      </span>
                    </figcaption>
                  </figure>
                  {/* A pack built without thumbnails has no layout to show: the sample takes the room. */}
                  {nextShot && (
                    <figure>
                      <img className="ss-theme-shot" src={nextShot} alt="" draggable={false} data-theme={next.id} />
                      <figcaption>Example layout</figcaption>
                    </figure>
                  )}
                </div>
              )}
              <p className="ss-theme-what" id={`${uid}-what`}>
                {next.id === theme.id
                  ? 'Pick a theme to see it here before you switch.'
                  : `${next.name} restyles every page: its layouts, colors and fonts. ${kept} You can undo the switch.`}
              </p>
              {refusal && (
                <p className="field-error" role="alert">
                  {refusal} {theme.name} is still this site’s theme.
                </p>
              )}
              <div className="ss-theme-confirm">
                {/* Kept focusable while the switch is on its way, so a refusal leaves focus where it was. */}
                <button type="button" className="btn btn-sm btn-primary" data-theme-switch-to={next.id} disabled={next.id === theme.id} aria-disabled={busy || undefined} aria-describedby={`${uid}-what`} onClick={() => void use()}>
                  {busy ? 'Switching…' : next.id === theme.id ? 'Use this theme' : `Use ${next.name}`}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => close()}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {otherRefused.length > 0 && (
        <div className="scope-note info ss-packs-refused">
          <CircleAlert />
          <div>
            <span>
              {otherRefused.length === 1 ? '1 installed theme' : `${otherRefused.length} installed themes`} couldn’t be loaded{missing ? '' : otherRefused.length === 1 ? ', so it isn’t offered here' : ', so they aren’t offered here'}.
            </span>
            <Disclosure className="ss-packs-fold" summary={otherRefused.length === 1 ? 'Why it couldn’t be loaded' : 'Why they couldn’t be loaded'}>
              <div className="ss-packs-why">
                <p className="ss-packs-fix">Reinstall a fresh copy of {otherRefused.length === 1 ? 'the theme' : 'each theme'} from wherever it came from, then restart SiteOrigin Builder.</p>
                <ul>
                  {otherRefused.map((r) => (
                    <li key={r.dir}>
                      <strong>{r.packId ?? r.dir.split(/[\\/]/).pop()}</strong>
                      <span className="ss-packs-detail">{r.reason}</span>
                    </li>
                  ))}
                </ul>
                {packsDir && !missing && (
                  <p className="ss-theme-folder">
                    Installed themes go in <FolderPath path={packsDir} />
                  </p>
                )}
              </div>
            </Disclosure>
          </div>
        </div>
      )}
      {!blocked && !readOnly && changes}
    </div>
  );
}

export function SiteStyles() {
  const snap = useStore((s) => s.snapshot);
  // The site's own head code and CSS change in Developer mode alone (Custom code).
  const developer = useStore((s) => !!s.settings?.developerMode);
  const [dev, setDev] = useState(false);
  useEffect(() => void api.app.info().then((i) => setDev(i.dev)), []);
  const tokens = useMemo(() => (snap ? effectiveTokens(snap.state) : []), [snap?.state.tokens, snap?.state.site.themeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const uses = useMemo(() => (snap ? tokenUses(snap.state) : new Map<string, TokenUse>()), [snap?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [openText, setOpenText] = useState<string | null>(null);
  // Type scale choices, one at a time: the arrow keys choose as they move, faster than a choice saves. Each is planned
  // against the project as the one before it left it; a choice overtaken while it waits is skipped for the newest.
  // The toast the last choice raised gives way to the next one's rather than stacking under it.
  const scaleRun = useRef<{ busy: Promise<void>; seq: number; toast: number | null; after: { opening: string; revision: number } | null }>({ busy: Promise.resolve(), seq: 0, toast: null, after: null });
  // The choice being saved: the radios follow it at once, so focus and the checked option never part while it saves. Once
  // saved it carries its revision, and counts only until the panel shows that revision.
  const [pendingScale, setPendingScale] = useState<{ choice: string; opening: string; revision?: number } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const uid = useId();
  // On a site with a dark palette, Colors shows and edits one palette at a time; the canvas previews the same one.
  const [paletteChoice, setPaletteChoice] = useState<PaletteScheme>('light');
  const dual = hasDarkPalette(snap?.state.tokens);
  const palette: PaletteScheme = dual ? paletteChoice : 'light';
  const darkTokens = useMemo(() => (snap ? effectiveTokens(snap.state, 'dark') : []), [snap?.state.tokens, snap?.state.site.themeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownTokens = palette === 'dark' ? darkTokens : tokens;
  // Which paired colours the theme sets against each other, and whether they are readable as they stand, in the
  // palette shown; and in the other one, so a pair spoiled there is never out of sight.
  const pairs = snap ? getTheme(snap.state.site.themeId).contrastPairs : undefined;
  const contrast = useMemo(() => buildContrastModel(shownTokens, pairs), [shownTokens, pairs]);
  const otherContrast = useMemo(() => (dual ? buildContrastModel(palette === 'dark' ? tokens : darkTokens, pairs) : null), [dual, palette, tokens, darkTokens, pairs]);
  const contrastStatus = useContrastStatus(contrast);
  // What a reset just did, for the status region; a repeat of the same words still changes the text, so it is read again.
  const [said, setSaid] = useState('');
  // The section under the sticky header, marked in the jump links so a long scroll keeps its bearings; a jump link's
  // own section stays marked through the scroll it starts (lib/use-jump-mark).
  const themeButtons = useMemo(() => (snap ? buttonStyleIds(getTheme(snap.state.site.themeId).tokens) : { radius: null, text: null }), [snap?.state.site.themeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasButtons = !!(themeButtons.radius || themeButtons.text);
  const jumps = useMemo(() => jumpsFor(hasButtons), [hasButtons]);
  const jumpIds = useMemo(() => jumps.map((j) => j.id), [jumps]);
  const { here, jump, panel } = useJumpMark(jumpIds, '.ss-head');
  // Layout groups whose sizes are shown as CSS, switched from the group's heading.
  const [cssGroups, setCssGroups] = useState<Set<string>>(() => new Set());
  const say = useCallback((text: string) => setSaid((prev) => (prev === text ? `${text} ` : text)), []);
  // Samples are drawn in the project's imported files themselves, which the editor loads under names of its own.
  const shownStack = usePreviewStack();
  // The page in the canvas: Text direction says so when it is in another language than the site's.
  const shownPageId = useStore((s) => s.pageId);
  if (!snap) return null;
  const st = snap.state;
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
  // The button styles have one place in the panel, Buttons: Text and Layout > Corners leave them out.
  const buttonIds = [themeButtons.radius, themeButtons.text].filter((id): id is string => !!id);
  const listed = (g: TokenDef['group']) => group(g).filter((t) => !buttonIds.includes(t.id));
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
    void applyOps([{ type: 'token.set', tokenId: s.token, value: s.value, ...(palette === 'dark' ? { scheme: 'dark' as const } : {}) }], `Use a readable ${label}${palette === 'dark' ? ' (dark colors)' : ''}`, undefined, snap.revision);
    // Brand's value is plain text while it follows another colour: then its "Use its own color" button is what can take focus.
    refocus(trigger, row, null, () => panel?.querySelector<HTMLElement>('.ss-color.compact input.ss-hex, .ss-color.compact .ss-follows .link-btn') ?? null);
  };
  /** Open a colour's row in Colors and put focus on its value, or on its details when it follows another colour. */
  const jumpTo = (id: string) => {
    const linked = !!refOf(shownById(id)?.value);
    openSection('tok-color', { focus: `[data-token-id="${CSS.escape(id)}"] ${linked ? '.ss-disclose' : 'input.ss-hex'}` });
  };
  /** Open where a changed style is edited, from its line in the review: its row, its text style, or its font in Basics. */
  const jumpToToken = (id: string) => {
    const t = byId(id);
    if (!t) return;
    const at = `[data-token-id="${CSS.escape(id)}"]`;
    if (buttonIds.includes(id)) return void openSection('tok-buttons', { focus: `${at} :is(select, input)` });
    if (t.group === 'color') return jumpTo(id);
    if (t.group === 'text') return void (setOpenText(id), openSection('tok-text', { focus: `${at} .ss-text-toggle` }));
    if (t.group === 'font') return void openSection('tok-basics', { focus: `${at} select` });
    openSection('tok-layout', { focus: `${at} :is(input, select, button:not(.reset-dot))` });
  };
  const site = st.site;
  // The newest website export said it had no public URL to build from, and one is saved now: it needs exporting again.
  const lastSite = snap.recentExports?.find((e) => e.kind === 'site');
  const urlSinceExport = !!publicUrl(site) && !!lastSite?.notes?.some((n) => n.destination?.kind === 'site' && n.destination.field === 'baseUrl');
  const updSite = (patch: Record<string, unknown>) => void applyOps([{ type: 'site.update', ...patch }], 'Update site settings');
  const changedIds = tokens.map((t) => t.id).filter(changed);
  // Theme styles only: an override on one of your own styles is its value in use, with no theme value under it.
  const savedIds = Object.keys(overrides).filter((id) => theme.tokens.some((t) => t.id === id));
  const resetAll = (e: React.MouseEvent<HTMLButtonElement>) => {
    const panel = e.currentTarget.closest('.ss');
    const trigger = e.currentTarget;
    const n = changedIds.length;
    // In an order that never passes through a loop: each reset is checked as it is made.
    void applyOps(tokenResetOrder(st, savedIds).map((id) => ({ type: 'token.set' as const, tokenId: id, value: null })), 'Use theme defaults').then((ok) => ok && say(`${plural(n, 'change', 'changes')} put back to ${theme.name}. You can undo this.`));
    // The changes bar goes with the reset: focus moves to the theme, the next thing down, not back to the top.
    refocus(trigger, null, null, () => panel?.querySelector<HTMLElement>('.ss-theme-change, .ss-color.compact input.ss-hex') ?? panel?.querySelector<HTMLElement>('.insp-jump button') ?? null);
  };
  const themes = listThemes().filter((t) => !t.devOnly || dev || t.id === theme.id);
  const hex = (id: string) => resolveColor(tokens, byId(id)?.value);
  const themeHex = (id: string) => resolveColor(theme.tokens, themeValue(id));
  // Colours as the palette shown has them. In the dark palette a colour is changed when it has a dark value of its
  // own, and going back shows its light colour again.
  const darkOwn = st.tokens.darkOverrides ?? {};
  const shownById = (id: string) => shownTokens.find((t) => t.id === id);
  const shownHex = (id: string) => resolveColor(shownTokens, shownById(id)?.value);
  const shownChanged = (id: string) => (palette === 'dark' ? Object.hasOwn(darkOwn, id) : changed(id));
  const setShown = (id: string, value: unknown, by?: 'picker') =>
    palette === 'dark'
      ? applyOps([{ type: 'token.set', tokenId: id, value, scheme: 'dark' }], `Change ${byId(id)?.label ?? id} (dark colors)`, by ? `token:dark:${id}:${by}` : `token:dark:${id}`)
      : set(id, value, by);
  const relinkShown = (id: string, value: unknown) => (palette === 'dark' ? applyOps([{ type: 'token.set', tokenId: id, value, scheme: 'dark' }], `Change ${byId(id)?.label ?? id} (dark colors)`) : relink(id, value));
  /** Show and edit one palette, and preview it on the canvas. */
  const choosePalette = (p: PaletteScheme) => {
    setPaletteChoice(p);
    setState({ previewScheme: p });
  };
  const fontStack = (id: string) => resolvedText(tokens, id);
  const colors = group('color');
  const colorIds = colors.map((t) => t.id);
  const fontIds = group('font').map((t) => t.id);
  const textIds = listed('text').map((t) => t.id);
  const layoutIds = LAYOUT_GROUPS.flatMap(({ group: g }) => listed(g).map((t) => t.id));
  /** Colours that already follow `id`, directly or through another colour: linking to them would loop. */
  const followers = (id: string): Set<string> => tokenFollowers(shownTokens, id, 'color');

  /** The palette's other colours, as its picker offers them to copy. */
  const colorPresets = (id: string) => colorIds.filter((c) => c !== id && !!shownHex(c)).map((c) => ({ id: c, label: byId(c)?.label ?? c, value: shownHex(c)! }));

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
    if (buttonIds.includes(id)) return `Buttons: ${id === themeButtons.radius ? 'Corners' : 'Label'}`;
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

  const colorRow = (light: TokenDef, compact = false) => {
    // The colour as the palette shown has it: its own dark value, or its light one shown again.
    const t = shownById(light.id) ?? light;
    const value = shownHex(t.id);
    const ref = refOf(t.value);
    // A link to a colour that is gone (renamed, removed with its pack) says so, rather than naming an ID.
    const follows = ref ? (byId(ref) && value ? byId(ref)!.label : 'a color that is no longer available') : null;
    // Gone, or followed through a chain that ends nowhere: either way there is no colour to show.
    const lost = !!ref && (!byId(ref) || !value);
    const darkShown = palette === 'dark';
    const desc = (theme.id.startsWith('foundation') ? FOUNDATION_USES[t.id] : undefined) ?? t.description;
    const open = !compact && openDetail === t.id;
    const detailId = `${uid}-detail-${t.id}`;
    const loops = followers(t.id);
    // How see-through it is, in words beside what it colours: the swatch shows it, this says how much.
    const opacity = opacityWords(value);
    return (
      <div className={`ss-color${shownChanged(t.id) ? ' set' : ''}${open ? ' open' : ''}${compact ? ' compact' : ''}${follows ? ' linked' : ''}`} key={t.id} data-ss-row data-token-id={compact ? undefined : t.id}>
        {!compact && (
          <button className="ss-disclose" title="Linking, contrast and where it is used" aria-expanded={open} aria-controls={detailId} aria-label={`${t.label}: linking, contrast and where it is used`} onClick={() => setOpenDetail(open ? null : t.id)}>
            <DisclosureMark />
          </button>
        )}
        {/* Each palette has its own picker and field: a pick or a draft under way never carries over to the other. */}
        <ColorPick
          key={`picker-${palette}`}
          value={value}
          follows={follows}
          onFollowed={lost ? undefined : () => jumpTo(ref!)}
          onOwn={value ? () => relinkShown(t.id, value) : undefined}
          onPick={(next) => setShown(t.id, next, 'picker')}
          presets={colorPresets(t.id)}
          label={`${t.label}${darkShown ? ' dark' : ''} color`}
        />
        {/* The name opens the row's details too, as its fold's chevron does; the chevron stays the one Tab stop. */}
        <div className="ss-color-text" onClick={compact ? undefined : (e) => !(e.target as HTMLElement).closest('button, a, input') && setOpenDetail(open ? null : t.id)}>
          <div className="ss-name">
            <NameWithReset
              label={compact ? `${t.label}${darkShown ? ' (dark colors)' : ''} color` : t.label}
              reset={
                shownChanged(t.id) &&
                (darkShown ? <ResetDot label={`${t.label} (dark colors)`} from="light" theme={refOf(byId(t.id)?.value) ? `color, ${show('color', null, byId(t.id)?.value)} in the dark colors` : `color, ${hex(t.id)}`} onReset={() => setShown(t.id, null)} /> : <ResetDot label={t.label} theme={`color, ${themeHex(t.id)}`} onReset={() => set(t.id, null)} />)
              }
            />
          </div>
          {(desc || opacity) && (
            <div className="ss-desc">
              {desc}
              {desc && opacity && ' · '}
              {opacity}
            </div>
          )}
        </div>
        {follows ? (
          <span className="ss-hex ss-hex-linked mono" title={lost ? 'The color it followed is no longer available. Open its details to choose another.' : `${value}. Follows ${follows}. Choose "Use its own color" to set it separately.`}>
            {value || '—'}
          </span>
        ) : (
          <ColorTextInput key={`field-${palette}`} className="input sm mono ss-hex" errorClassName="ss-color-extra" value={value} onSave={(v) => setShown(t.id, v)} ariaLabel={`${t.label}${darkShown ? ' dark' : ''} color value`} />
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
                    relinkShown(t.id, value);
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
            <ContrastFlags model={contrast} tokenId={t.id} onUse={chooseReadable} onJump={jumpTo} onShowAll={() => (setOpenDetail(t.id), requestAnimationFrame(() => document.getElementById(detailId)?.querySelector<HTMLElement>('.ss-contrast-block')?.focus()))} expanded={open} controls={detailId} />
          </div>
        )}
        {!compact && (
          <div className="ss-detail" id={detailId} hidden={!open}>
            {open && (
              <>
                <Field label="Link to another color" hint={lost ? 'The color it followed is no longer available. Choose another, or give it its own color.' : 'Follows another color, and changes when it does.'}>
                  <select className="select sm" value={ref ?? ''} onChange={(e) => relinkShown(t.id, e.target.value ? { token: e.target.value } : value || themeHex(t.id) || '#000000')}>
                    {lost && (
                      <option value={ref!} disabled>
                        No longer available
                      </option>
                    )}
                    <option value="">Its own color</option>
                    {colorIds
                      .filter((id) => id !== t.id && !loops.has(id) && !!shownHex(id))
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
        <span className="ss-font-sample" style={{ fontFamily: shownStack(stack) }} aria-hidden="true">
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
          <FontSelect id={selectId} state={st} stack={stack} follows={ref ? (byId(ref)?.label ?? 'a style that is no longer available') : null} importable={t.label} onChoose={(next) => set(t.id, next)} />
        </div>
      </div>
    );
  };

  /** A text style's fields (font, size, weight and case, line height and letter spacing), each with its own reset. */
  const textFields = (t: TokenDef, bodyId: string, hints: Partial<Record<TextMetric, string>> = {}) => {
    const v = textMetrics(tokens, t.id, themeValue(t.id));
    if (!v) return null;
    // The theme's own metrics, worked out through its links, so a field is marked changed only when it differs from them.
    const base = (textMetrics(theme.tokens, t.id) ?? themeValue(t.id) ?? v) as TextStyleValue;
    const famRef = refOf(v.family);
    const stack = famRef ? fontStack(famRef) : String(v.family);
    // The named weights, with the style's own and the theme's among them when they fall between (Foundation's buttons are 550).
    const between = [...new Set([v.weight, base.weight])].filter((n) => typeof n === 'number' && Number.isFinite(n) && !WEIGHTS.some(([w]) => w === n));
    const weights = [...WEIGHTS, ...between.map((n) => [n, String(n)] as [number, string])].sort((a, b) => a[0] - b[0]);
    const metricChanged = (k: TextMetric) => changed(t.id) && !sameValue(metricOf(v, k), metricOf(base, k));
    // Put back one metric; when that leaves the whole style matching the theme, drop the change entirely.
    const resetMetric = (k: TextMetric) => (TEXT_METRICS.every((m) => m === k || sameValue(metricOf(v, m), metricOf(base, m))) ? set(t.id, null) : set(t.id, { [k]: metricOf(base, k) }));
    /** One metric: its label (with the reset beside it, outside the label) over its control. */
    const metric = (k: TextMetric, control: (id: string) => ReactNode) => {
      const id = `${bodyId}-${k}`;
      const hint = hints[k];
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
        <div className="grid-2">
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
        </div>
        <div className="grid-2">
          {metric('lineHeight', (id) => <DraftInput id={id} className="input sm" value={v.lineHeight} onCommit={(lineHeight) => (lineHeight.trim() ? set(t.id, { lineHeight: lineHeight.trim() }) : false)} />)}
          {metric('tracking', (id) => <DraftInput id={id} className="input sm" value={v.tracking} onCommit={(tracking) => (tracking.trim() ? set(t.id, { tracking: tracking.trim() }) : false)} />)}
        </div>
      </>
    );
  };

  const textRow = (t: TokenDef) => {
    const v = textMetrics(tokens, t.id, themeValue(t.id));
    if (!v) return null;
    const famRef = refOf(v.family);
    const stack = famRef ? fontStack(famRef) : String(v.family);
    const famLabel = famRef ? (byId(famRef)?.label ?? 'a font that is no longer available') : familyName(stack);
    const max = clampRange(v.size)?.[1] ?? toPx(v.size) ?? 16;
    const open = openText === t.id;
    const bodyId = `${uid}-text-${t.id}`;
    const nameId = `${bodyId}-name`;
    const textUse = theme.id.startsWith('foundation') ? FOUNDATION_TEXT_USES[t.id] : t.description;
    return (
      <div className={`ss-text${open ? ' open' : ''}${changed(t.id) ? ' set' : ''}`} key={t.id} data-ss-row data-token-id={t.id}>
        {/* The whole head opens the row (the toggle's hit area covers it); the reset sits beside the name, as on every Site styles row. */}
        <div className="ss-text-head">
          <button className="ss-text-toggle" aria-expanded={open} aria-controls={bodyId} aria-describedby={`${bodyId}-meta`} onClick={() => setOpenText(open ? null : t.id)}>
            <DisclosureMark />
            <span
              id={nameId}
              className="ss-specimen"
              style={{
                fontFamily: shownStack(stack),
                fontWeight: v.weight,
                // A compressed scale: big styles stay bigger than small ones without filling the dock.
                fontSize: Math.round(Math.min(30, 12 + (max - 12) * 0.28)),
                letterSpacing: v.tracking,
                textTransform: (v.transform as React.CSSProperties['textTransform']) ?? 'none'
              }}
            >
              {t.label}
            </span>
          </button>
          {changed(t.id) && <ResetDot label={t.label} theme="text style" onReset={() => set(t.id, null)} />}
          <span className="ss-text-meta" id={`${bodyId}-meta`}>
            {friendlySize(v.size)} · {weightWords(v.weight)} · {famLabel}
          </span>
        </div>
        <div className="ss-text-body" id={bodyId} role="group" aria-labelledby={nameId} hidden={!open}>
          {open && (
            <>
              {textFields(t, bodyId)}
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
            {g === 'shadow' && value.trim().toLowerCase() === 'none' ? <span className="ss-desc">No shadow</span> : desc && <span className="ss-desc">{desc}</span>}
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

  /** Button corners: a step of Layout > Corners it follows, or a value of its own, started from what it shows now. */
  const cornerField = (t: TokenDef) => {
    const ref = refOf(t.value);
    const value = resolvedText(tokens, t.id);
    const loops = tokenFollowers(tokens, t.id, 'radius');
    // Only steps with a value to follow: one whose own link leads nowhere would be refused.
    const steps = group('radius').filter((x) => x.id !== t.id && !loops.has(x.id) && !!resolvedText(tokens, x.id));
    const id = `${uid}-button-corners`;
    const stepName = (x: TokenDef) => {
      const v = resolvedText(tokens, x.id);
      const px = toPx(v);
      return `${x.label} (${px !== null && px >= 100 ? 'fully rounded' : friendlySize(v)})`;
    };
    return (
      <div className="field ss-field" data-ss-row data-token-id={t.id}>
        <div className="ss-name ss-field-name ss-nowrap">
          <label htmlFor={id}>
            Corners<span className="sr-only"> of buttons</span>
          </label>
          {changed(t.id) && (
            <>
              {' '}
              <ResetDot label="Button corners" theme={`corners, ${show('radius', null, themeValue(t.id))}`} onReset={() => set(t.id, null)} />
            </>
          )}
        </div>
        {/* Linking and unlinking are steps of their own; "Its own value" keeps the corners as they are drawn now. */}
        <select id={id} className="select sm" value={ref ?? ''} onChange={(e) => relink(t.id, e.target.value ? { token: e.target.value } : value || '0px')}>
          {ref && !steps.some((x) => x.id === ref) && (
            <option value={ref} disabled>
              No longer available
            </option>
          )}
          {steps.map((x) => (
            <option key={x.id} value={x.id}>
              Same as {stepName(x)}
            </option>
          ))}
          <option value="">Its own value</option>
        </select>
        {!ref && <SizeControl value={value} name="Button corners" onCommit={(v) => set(t.id, v)} />}
        <div className="field-hint">{ref ? (value && byId(ref) ? `Changes with ${byId(ref)!.label} in Layout > Corners.` : 'The corner it followed is no longer available. Choose another, or give it its own value.') : 'Buttons only. 0px makes them square.'}</div>
      </div>
    );
  };

  /** Site styles > Buttons: a sample drawn as the theme draws its buttons, then their corners and their label. */
  const buttonsBody = () => {
    const r = themeButtons.radius ? byId(themeButtons.radius) : undefined;
    const label = themeButtons.text ? byId(themeButtons.text) : undefined;
    const v = label ? textMetrics(tokens, label.id, themeValue(label.id)) : null;
    const famRef = v ? refOf(v.family) : null;
    const stack = v ? (famRef ? fontStack(famRef) : String(v.family)) : fontStack('font.body');
    const famLabel = famRef ? (byId(famRef)?.label ?? 'a font that is no longer available') : familyName(stack);
    // At its real size, as far as the dock has room for (a size that grows with the window, at its largest); the padding
    // is in em, as the theme's is, so it scales with it. A size written some other way is drawn as written.
    const px = v ? (toPx(v.size) ?? clampRange(v.size)?.[1] ?? (Number(v.size.trim()) === 0 ? 0 : null)) : 16;
    const look: React.CSSProperties = {
      borderRadius: r ? resolvedText(tokens, r.id) || undefined : undefined,
      fontFamily: shownStack(stack),
      // A keyword (x-large) can't go inside clamp(); one is never bigger than the dock can show.
      fontSize: px !== null ? Math.max(11, Math.min(24, px)) : v && /\d/.test(v.size) ? `clamp(11px, ${v.size}, 24px)` : v?.size,
      ...(v ? { fontWeight: v.weight, lineHeight: v.lineHeight, letterSpacing: v.tracking, textTransform: (v.transform as React.CSSProperties['textTransform']) ?? 'none' } : {})
    };
    const ink = shownHex('color.text') || undefined;
    // Named as Colors names them, so the owner can find them there.
    const colorNames = ['color.brand', 'color.brand-strong', 'color.on-brand'].flatMap((id) => byId(id)?.label ?? []).join(', ');
    return (
      <>
        <div className="ss-btn-sample" style={{ background: shownHex('color.background') || undefined, color: ink }} aria-hidden="true">
          <span className="ss-btn-sample-btn" style={{ ...look, background: shownHex('color.brand') || undefined, color: shownHex('color.on-brand') || undefined }}>
            Get in touch
          </span>
          <span className="ss-btn-sample-btn secondary" style={look}>
            Learn more
          </span>
        </div>
        <p className="ss-btn-note">
          {v ? `${friendlySize(v.size)} · ${weightWords(v.weight)} · ${famLabel}. ` : ''}Every button the theme draws.{colorNames ? ` Their colors are ${colorNames}, in Colors.` : ''}
        </p>
        <div className="ss-btn-fields">
          {r && cornerField(r)}
          {label && (
            <div className="ss-btn-fields" data-token-id={label.id} role="group" aria-label="Button label">
              {textFields(label, `${uid}-button-label`, { size: 'The padding grows and shrinks with it.' })}
            </div>
          )}
        </div>
      </>
    );
  };

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
  const roles = scaleRoles(theme.tokens, tokens);
  const scale = activeTypeScale(tokens, theme.tokens);
  const pendingChoice = pendingScale && pendingScale.opening === snap.workspaceKey && (pendingScale.revision === undefined || snap.revision < pendingScale.revision) ? pendingScale.choice : null;
  const scaleName = (c: TypeScaleChoice) => (c === 'theme' ? 'Theme' : typeScale(c).label);
  const scaleDescription = (c: TypeScaleChoice) => (c === 'theme' ? `${theme.name}'s own sizes and spacing` : typeScale(c).description);
  // Said in a toast with its Undo, as the palette's choices are: one step puts back every size it replaced, own sizes included.
  const chooseScale = (c: TypeScaleChoice) => {
    const run = scaleRun.current;
    // Made in this opening of this project, and applied and answered only there.
    const opening = snap.workspaceKey;
    const seq = ++run.seq;
    const newest = () => run.seq === seq;
    const here = () => getState().snapshot?.workspaceKey === opening;
    setPendingScale({ choice: c, opening });
    let saved = false;
    const say = (text: string, kind: 'info' | 'error' = 'info', undo?: Parameters<typeof toast>[2]) => {
      if (!here()) return;
      if (run.toast !== null) dismissToast(run.toast);
      toast(text, kind, undo);
      run.toast = getState().toasts.at(-1)?.id ?? null;
    };
    run.busy = run.busy
      .then(async () => {
        if (!newest()) return;
        // Planned against the project as the last choice made in this opening left it, never an older copy.
        if (run.after?.opening === opening && !(await shownAt(run.after.revision, opening))) {
          say('The type scale could not be changed just now. Choose it again.', 'error');
          return;
        }
        const now = getState().snapshot;
        if (!now || now.workspaceKey !== opening || !newest()) return;
        const themeNow = getTheme(now.state.site.themeId);
        const tokensNow = effectiveTokens(now.state);
        const { ops, unscalable } = typeScaleOps(tokensNow, themeNow.tokens, now.state.tokens.overrides, c);
        const kept = unscalable.map((id) => tokensNow.find((t) => t.id === id)?.label ?? id);
        const keptText = kept.length ? `${kept.join(', ')} kept ${kept.length === 1 ? 'its' : 'their'} own size.` : '';
        if (!ops.length) {
          if (keptText) say(keptText);
          return;
        }
        const r = await commitOps(ops, c === 'theme' ? "Use the theme's type scale" : `Use the ${typeScale(c).label} type scale`, undefined, now.revision);
        if (!r?.ok || r.workspaceKey !== opening) return;
        run.after = { opening, revision: r.revision };
        saved = true;
        if (newest()) setPendingScale({ choice: c, opening, revision: r.revision });
        say(`${c === 'theme' ? `Headings and text are back to ${themeNow.name}'s sizes.` : `Headings and text now use the ${typeScale(c).label} scale.`}${keptText ? ` ${keptText}` : ''}`, 'info', undoAction(r));
        // The next choice waits until the panel shows this one.
        await shownAt(r.revision, opening);
      })
      // One choice that fails never stops the next.
      .catch(() => say('The type scale could not be changed. Choose it again.', 'error'))
      .finally(() => {
        // A saved choice stays pending until the panel shows its revision; anything else lets go at once.
        if (newest() && !saved) setPendingScale(null);
      });
  };
  // How big the largest style a scale sets runs, phone to desktop: said on each choice, so its words are never the only clue.
  const lead = roles[0];
  const scaleRange = (c: TypeScaleChoice) => {
    if (!lead) return '';
    if (c !== 'theme') {
      const [lo, hi] = typeScale(c).roles[lead];
      return `${byId(lead)?.label ?? ''} ${lo === hi ? `${lo}px` : `${lo}–${hi}px`}`;
    }
    const v = textMetrics(theme.tokens, lead);
    return v ? `${byId(lead)?.label ?? ''} ${friendlySize(v.size)}` : '';
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
        // Worked out where the size allows; a size written some other way is shown as written, never guessed. A size that
        // grows with the window is said in whole pixels, as its row's range is; a fixed one as its size field shows it.
        sizes: SPECIMEN_WIDTHS.map((w, i) => {
          const px = sizeAtWidth(v.size, w.width);
          return { px, drawn: specimenPx(px ?? ends?.[i] ?? toPx(v.size) ?? 16), text: px === null ? 'Custom CSS' : ends ? `${Math.round(px)}px` : pxText(px) };
        })
      }
    ];
  });

  // Every style drawn bigger than the one above it, among the headings or among the text styles, at either width: said in
  // words. The two runs are judged apart: Lead may outsize Heading 3, which themes keep for card titles and questions.
  const inverted = SPECIMEN_WIDTHS.flatMap((w, i) =>
    [['text.display', 'text.h1', 'text.h2', 'text.h3'], ['text.lead', 'text.body', 'text.small']].flatMap((chain) => {
      const rows = chain.map((id) => specimen.find((r) => r.id === id)).filter((r): r is (typeof specimen)[number] => !!r && r.sizes[i].px !== null);
      return rows.flatMap((r, k) => (k > 0 && r.sizes[i].px! > rows[k - 1].sizes[i].px! + 0.5 ? [`On a ${w.label.toLowerCase()}, ${r.label} is bigger than ${rows[k - 1].label}.`] : []));
    })
  );

  const redirectCount = redirectRecords(st).length;
  const reviewId = `${uid}-review`;

  return (
    <SayContext.Provider value={say}>
    <div
      className="panel-body ss"
      {...panel}
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
          {jumps.map((j, i) => (
            <button key={j.id} aria-current={here === i ? 'location' : undefined} onClick={() => jump(i)}>
              {j.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="ss-intro">
        <ThemeCard
          st={st}
          theme={theme}
          themes={themes}
          look={{ background: shownHex('color.background') || undefined, text: shownHex('color.text') || undefined, brand: shownHex('color.brand') || undefined, dots: ['color.brand', 'color.accent', 'color.inverse', 'color.surface-alt'].map(shownHex).filter(Boolean), font: shownStack(displayStack) }}
          lookOf={(themeId) => {
            // The site as it would be under that theme: its styles, with the owner's changes kept on top.
            // In the palette being edited, as the canvas shows it.
            const t = effectiveTokens({ ...st, site: { ...st.site, themeId } }, palette);
            const c = (id: string) => resolveColor(t, t.find((x) => x.id === id)?.value) || undefined;
            const display = resolvedText(t, 'font.display');
            return { background: c('color.background'), text: c('color.text'), brand: c('color.brand'), onBrand: c('color.on-brand'), dots: ['color.brand', 'color.accent', 'color.inverse', 'color.surface-alt'].flatMap((id) => c(id) ?? []), font: shownStack(display), fontName: familyName(display) };
          }}
          changedCount={changedIds.length}
          say={say}
          changes={
        changedIds.length > 0 && (
          <div className="ss-changes">
            <div className="ss-changes-row">
              <span>
                <strong>{changedIds.length} changed</strong>
                <span className="sr-only"> from {theme.name}</span>
              </span>
              <button className="btn btn-sm" aria-expanded={reviewing} aria-controls={reviewId} onClick={() => setReviewing(!reviewing)}>
                <DisclosureMark />
                Review
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
        )
          }
        />
        <div className="scope-note site">
          <Globe />
          <span>
            <strong>Every page</strong> · unless it sets its own
          </span>
        </div>
      </div>

      <Section title="Basics" id="tok-basics" scope={changedNote([...(brand ? [brand.id] : []), ...fontIds])}>
        <div className="ss-group">
          {brand && colorRow(brand, true)}
          {brand?.id === 'color.brand' && <BrandContrast model={contrast} onUse={chooseReadable} onJump={jumpTo} />}
          {/* A new brand colour with the theme's hover colour left as it was: buttons would hover to a colour from another palette. */}
          {palette === 'light' && brand?.id === 'color.brand' && changed('color.brand') && byId('color.brand-strong') && !changed('color.brand-strong') && !refOf(byId('color.brand-strong')?.value) && (
            <p className="ss-hover-note">
              <span className="ss-chip" style={{ background: hex('color.brand-strong') }} aria-hidden="true" />
              <span>
                Buttons still hover to the theme’s{' '}
                <button type="button" className="link-btn ss-jump" onClick={() => jumpTo('color.brand-strong')}>
                  Brand (strong)
                </button>
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

      {/* The count follows the palette shown, as the rows' own reset marks do. */}
      <Section title="Colors" id="tok-color" scope={palette === 'dark' ? (colorIds.some(shownChanged) ? `${colorIds.filter(shownChanged).length} changed` : undefined) : changedNote(colorIds)}>
        <ColorSchemeControls state={st} palette={palette} onPalette={choosePalette} contrast={contrast} otherContrast={otherContrast} onJump={(id) => (setOpenDetail(id), openSection('tok-color', { focus: `[data-token-id="${CSS.escape(id)}"] .ss-contrast-block` }))} />
        {/* A palette is made for the light colors; under Dark it says so, and the dark ones have their own remake. */}
        <PaletteHarmony tokens={tokens} pairs={pairs ?? NO_PAIRS} dark={dual ? (st.tokens.darkOverrides ?? {}) : null} revision={snap.revision} shown={palette} onShowLight={() => choosePalette('light')} />
        {[...COLOR_GROUPS, { label: 'Other colors', ids: colorIds.filter((id) => !COLOR_GROUPS.some((g) => g.ids.includes(id))) }]
          .map((g) => ({ ...g, list: g.ids.map(byId).filter((t): t is TokenDef => !!t && t.group === 'color') }))
          .filter((g) => g.list.length)
          .map((g) => (
            <div className="ss-group" key={g.label} role="group" aria-label={dual ? `${g.label}, ${palette} colors` : g.label}>
              <div className="ss-group-label">
                {g.label}
                {/* Which palette these rows edit, on every group, so it stays in view once the switch scrolls away. */}
                {dual && (
                  <span className="ss-group-scheme" aria-hidden="true">
                    {palette === 'dark' ? 'Dark colors' : 'Light colors'}
                  </span>
                )}
              </div>
              {g.list.map((t) => colorRow(t))}
            </div>
          ))}
      </Section>

      <Section title="Text styles" id="tok-text" scope={changedNote(textIds)}>
        {roles.length > 0 && (
          <div className="ss-scale">
            {/* What the sizes are now: the scale they match, or sizes of the owner's own (a state of its own, never an empty choice). */}
            <div className="ss-group-label ss-scale-head">
              <span className="ss-scale-title">
                <span id={`${uid}-scale`}>Type scale</span>
                <InfoTip label="Type scale">{SCALE_INFO}</InfoTip>
              </span>
              <span className="ss-scale-now" id={`${uid}-scale-now`}>
                {scale === 'theme' ? `${theme.name}'s sizes` : scale ? scaleName(scale) : 'Your own sizes'}
              </span>
            </div>
            {/* Each scaled style at a phone's and a desktop's width, row by row, so one style compares across. */}
            <table className="ss-type-specimen">
              <caption className="sr-only">Text sizes on a phone and on a desktop</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Style</span>
                  </th>
                  {SPECIMEN_WIDTHS.map((w) => (
                    <th scope="col" key={w.label}>
                      {w.label} <span className="ss-type-width">{w.width}px</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {specimen.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.label}</th>
                    {SPECIMEN_WIDTHS.map((w, i) => (
                      <td key={w.label}>
                        <span className="ss-type-cell">
                          {/* Drawn smaller than life, in order; a size only CSS can work out has no sample to draw. */}
                          {r.sizes[i].px !== null ? (
                            <span
                              className="ss-type-sample"
                              aria-hidden="true"
                              style={{ fontFamily: shownStack(r.stack), fontWeight: r.v.weight, fontSize: r.sizes[i].drawn, letterSpacing: r.v.tracking, textTransform: (r.v.transform as React.CSSProperties['textTransform']) ?? 'none' }}
                            >
                              Aa
                            </span>
                          ) : (
                            <span />
                          )}
                          <span className="ss-type-px">{r.sizes[i].text}</span>
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {inverted.length > 0 && (
              <ul className="ss-scale-warn">
                {inverted.map((line) => (
                  <li key={line}>
                    <TriangleAlert aria-hidden="true" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            )}
            <span id={`${uid}-scale-hint`} hidden>
              {SCALE_INFO}
            </span>
            {/* A radio group (one tab stop, the arrows choose), each scale saying what it does before it is chosen. */}
            <div className="ss-scale-choices">
              <Segmented
                radio
                full
                labelledBy={`${uid}-scale`}
                describedBy={`${uid}-scale-now ${uid}-scale-hint`}
                value={(pendingChoice ?? scale ?? '') as TypeScaleChoice}
                options={TYPE_SCALE_CHOICES.map((c) => ({
                  value: c,
                  label: (
                    <>
                      <span className="ss-scale-name">
                        {scaleName(c)}
                        {scaleRange(c) && (
                          <span className="ss-scale-range">
                            <span className="sr-only">, </span>
                            {scaleRange(c)}
                          </span>
                        )}
                      </span>
                      <span className="sr-only">, </span>
                      <span className="ss-scale-desc">{scaleDescription(c)}</span>
                      <Check className="ss-scale-check" aria-hidden="true" />
                    </>
                  )
                }))}
                onChange={chooseScale}
              />
            </div>
          </div>
        )}
        <div className="ss-text-list">{listed('text').map(textRow)}</div>
      </Section>

      {hasButtons && (
        <Section title="Buttons" id="tok-buttons" scope={changedNote(buttonIds)}>
          {buttonsBody()}
        </Section>
      )}

      <Section title="Layout" id="tok-layout" defaultOpen={false} scope={changedNote(layoutIds)}>
        {LAYOUT_GROUPS.filter(({ group: g }) => listed(g).length).map(({ group: g, label }) => {
          const max = Math.max(...listed(g).map((t) => toPx(resolvedText(tokens, t.id)) ?? clampRange(resolvedText(tokens, t.id))?.[1] ?? 0));
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
              {listed(g).map((t) => layoutRow(g, t, max))}
            </div>
          );
        })}
      </Section>

      <Section title="Your styles" id="tok-custom" defaultOpen={st.tokens.custom.length > 0} scope={st.tokens.custom.length ? plural(st.tokens.custom.length, 'style', 'styles') : undefined}>
        <CustomTokens state={st} say={say} whereUsed={(id) => usesOf(id).lines.flatMap(([, names]) => names)} onEditText={(id) => (setOpenText(id), openSection('tok-text', { focus: `[data-token-id="${CSS.escape(id)}"] .ss-text-toggle` }))} />
      </Section>

      <Section title="Site details" id="site-settings" defaultOpen={false} keepMounted scope={siteDetailsScope(site)}>
        <div className="ss-group sd-group" role="group" aria-labelledby="site-details-website">
          <div className="ss-group-label" id="site-details-website">
            Website
          </div>
          <CheckedField key={`name-${snap?.workspaceKey}`} id="site-name" label="Site name" info={siteNameNote(st)} value={site.name} check={siteNameCheck(st)} unusable="" onCommit={(v) => (v.trim() ? updSite({ name: v.trim() }) : false)} />
          <Field label="Default description">
            <DraftInput id="site-description" multiline limit={TEXT_LIMITS.siteDescription} keep="site:description" value={site.description} onCommit={(v) => updSite({ description: v })} />
          </Field>
          {/* Keyed by the project's opening: text one project refused never shows in the next. */}
          <CheckedField
            key={`url-${snap?.workspaceKey}`}
            id="site-public-url"
            label="Public URL"
            hint={urlSinceExport ? 'Export again to include it' : undefined}
            info={urlSinceExport ? 'Where the site is published, for links search engines follow and the sitemap. The website you last exported was built without it.' : 'Where the site is published, for links search engines follow and the sitemap.'}
            value={site.baseUrl}
            placeholder="https://example.com"
            check={publicUrlProblem}
            unusable="The website is built without it until it is corrected."
            onCommit={(v) => updSite({ baseUrl: v.trim() })}
          />
        </div>
        <div className="ss-group sd-group" role="group" aria-labelledby="site-details-language">
          <div className="ss-group-label" id="site-details-language">
            Language and direction
          </div>
          <CheckedField
            key={`lang-${snap?.workspaceKey}`}
            label="Language"
            hint={namedLanguage(siteLanguage(site)) ? <strong className="sd-lang-name">{namedLanguage(siteLanguage(site))}</strong> : undefined}
            info="Type a language or a code, such as Spanish or en-AU."
            className="input ss-lang"
            value={site.language}
            check={siteLanguageCheck(st)}
            unusable="The website is built in English (en) until it is corrected."
            onCommit={(v) => updSite({ language: languageTyped(v) })}
          />
          <ChoiceField
            label="Text direction"
            full
            value={site.direction === 'ltr' || site.direction === 'rtl' ? site.direction : 'auto'}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'ltr', label: 'Left to right' },
              { value: 'rtl', label: 'Right to left' }
            ]}
            hint={directionHint(site, shownPageId && Object.hasOwn(st.pages, shownPageId) ? st.pages[shownPageId] : null)}
            onChange={(direction) => updSite({ direction })}
          />
        </div>
        <div className="ss-group sd-group" role="group" aria-labelledby="site-details-images">
          <div className="ss-group-label" id="site-details-images">
            Images
          </div>
          <SiteImage id="site-favicon" title="Favicon" plain="favicon" state={st} value={site.favicon} onChange={(id) => updSite({ favicon: id })} hint="Square, larger than 48 × 48 pixels" />
          <SiteImage id="site-social-image" title="Social sharing image" plain="social" state={st} value={site.socialImage} onChange={(id) => updSite({ socialImage: id })} hint="Wide, about 1200 × 630 pixels" />
        </div>
        <IdentityFields state={st} workspaceKey={snap?.workspaceKey} onPatch={(identity) => updSite({ identity })} />
      </Section>

      <Section title="Site search" id="site-search" defaultOpen={false} keepMounted scope={siteSearchScope(site)}>
        {/* Keyed by the project's opening: an address typed in one project is never offered in the next. */}
        <SiteSearchFields key={`search-${snap?.workspaceKey}`} state={st} onChange={updSite} />
      </Section>

      <Section title="AI agents" id="site-agents" defaultOpen={false} scope={agentsScope(site)}>
        {/* Keyed by the project's opening: a summary typed in one project is never previewed in the next. */}
        <AgentDiscoveryFields key={`agents-${snap?.workspaceKey}`} state={st} onChange={updSite} />
      </Section>

      <Section title="Crawlers" id="site-crawlers" defaultOpen={false} keepMounted>
        {/* Keyed by the project's opening: lines typed in one project are never previewed in the next. */}
        <CrawlerPolicyFields key={`crawlers-${snap?.workspaceKey}`} state={st} onChange={updSite} />
      </Section>

      <Section title="Integrations" id="site-integrations" defaultOpen={false} keepMounted scope={integrationsScope(site)}>
        {/* Keyed by the project's opening: a site ID typed in one project is never offered in the next. */}
        {/* Its saves report back, so an ID refused while the AI changes the site stays in its form. */}
        <IntegrationFields key={`integrations-${snap?.workspaceKey}`} site={site} onChange={(patch) => applyOps([{ type: 'site.update', ...patch }], 'Update site settings')} />
      </Section>

      <Section title="Custom code" id="site-code" defaultOpen={false} keepMounted scope={siteCodeScope(site)}>
        <SiteCodeFields key={`code-${snap?.workspaceKey}`} site={site} developer={developer} onChange={updSite} />
      </Section>

      <Section title="Redirects" id="site-redirects" defaultOpen={false} keepMounted scope={redirectCount ? plural(redirectCount, 'redirect', 'redirects') : undefined}>
        {/* Keyed by the project's opening: a redirect half typed in one project is never offered in the next. */}
        <RedirectsFields key={`redirects-${snap?.workspaceKey}`} state={st} problems={snap?.diagnostics ?? []} revision={snap?.revision} />
      </Section>

      <Section title="Visitor text" id="site-visitor-text" defaultOpen={false} scope={visitorTextScope(site)}>
        {/* Its saves report back, so a wording put back is said only once it has saved. */}
        <VisitorTextFields state={st} onCommit={(language, key, value) => applyOps([{ type: 'site.update', visitorText: { language, text: { [key]: value } } }], 'Update site settings')} />
      </Section>

      <Section title="Not-found page" id="site-not-found" defaultOpen={false} keepMounted scope={notFoundScope(site)}>
        <NotFoundFields site={site} onCommit={(patch) => applyOps([{ type: 'site.update', ...patch }], 'Update site settings')} />
      </Section>
    </div>
    </SayContext.Provider>
  );
}
