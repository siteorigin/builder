import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Monitor, Palette, RotateCcw, Smartphone, Tablet } from 'lucide-react';
import type { ResponsiveScope, ResponsiveStyles, StyleValue, TokenDef } from '@shared/types';
import { STYLE_GROUP_LABELS, STYLE_PROPS, STYLE_PROP_MAP, VIEWPORT_PRESETS, type StylePropDef } from '@shared/styles';
import { ColorPick } from '../components/ColorPick';
import { DraftInput } from '../components/ui';
import { setState, useStore } from '../store';

type Size = Exclude<ResponsiveScope, 'base'>;
const SIZES: Size[] = ['phone', 'tablet', 'desktop'];
const SCOPE_LABEL: Record<ResponsiveScope, string> = { base: 'All sizes', phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop' };
const SIZE_ICON: Record<Size, typeof Monitor> = { phone: Smartphone, tablet: Tablet, desktop: Monitor };
const SIZE_RANGE: Record<Size, string> = { phone: 'narrower than 768px', tablet: '768 to 1023px wide', desktop: '1024px and wider' };
/** Where a label in the shared list would repeat its own group heading. */
const LABELS: Record<string, string> = { layout: 'Arrange' };
const labelOf = (p: StylePropDef) => LABELS[p.id] ?? p.label;

const sizeForWidth = (w: number): Size => (w < 768 ? 'phone' : w < 1024 ? 'tablet' : 'desktop');
const has = (s: ResponsiveStyles | undefined, scope: ResponsiveScope) => !!s?.[scope] && Object.keys(s[scope]!).length > 0;
const listJoin = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

const tokenOf = (tokens: TokenDef[], id: string) => tokens.find((t) => t.id === id);
const isToken = (v: StyleValue | undefined): v is { token: string } => typeof v === 'object' && v !== null;

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

/** How a value reads in the panel: a site style by name (with its size when short), an option by its label. */
function describe(def: StylePropDef, v: StyleValue | undefined, tokens: TokenDef[]): string {
  if (v === undefined) return '';
  if (isToken(v)) return tokenText(def, tokens, v.token);
  if (def.kind === 'boolean') return def.id === 'hidden' ? (v ? 'Hidden' : 'Visible') : v ? 'Yes' : 'No';
  return def.options?.find((o) => o.value === String(v))?.label ?? String(v);
}

function colorOf(tokens: TokenDef[], id: string): string {
  const v = resolved(tokens, id);
  return typeof v === 'string' ? v : 'transparent';
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
  const PreviewIcon = SIZE_ICON[preview];
  return (
    <div className="style-scope" ref={ref}>
      <div className="style-scope-label" id={labelId}>
        Edit styles for
      </div>
      <div ref={group} className="style-scope-picker" role="radiogroup" aria-labelledby={labelId} aria-describedby={mismatch ? `${noteId} ${previewId}` : noteId} onKeyDown={onKeyDown}>
        {order.map((v) => {
          const marked = v === 'base' ? has(styles, 'base') : sized.includes(v as Size);
          return (
            <button key={v} type="button" role="radio" aria-checked={scope === v} tabIndex={scope === v ? 0 : -1} onClick={() => choose(v)} title={marked ? (v === 'base' ? 'Has changes for all sizes' : `${SCOPE_LABEL[v]} has its own changes`) : undefined}>
              {SCOPE_LABEL[v]}
              {marked && (
                <>
                  <span className="style-scope-dot" aria-hidden="true" />
                  <span className="sr-only">, has its own changes</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      <p className="style-scope-note" id={noteId}>
        {scope === 'base' ? (
          <>Changes apply at every size.{sized.length ? ` Where a row says ${sized.map((z) => `“${SCOPE_LABEL[z]} uses …”`).join(' or ')}, that size keeps its own value.` : ''}</>
        ) : (
          <>
            <strong>{SCOPE_LABEL[scope]} only</strong>, {SIZE_RANGE[scope]}. Other sizes keep their values.
          </>
        )}
      </p>
      {mismatch && (
        <p className="style-scope-preview" id={previewId}>
          <PreviewIcon aria-hidden="true" />
          <span>
            {scope === 'base' ? `Previewing ${preview}.` : `Previewing ${preview}, so these changes are not showing.`}{' '}
            {scope === 'base' ? (
              <button type="button" className="style-scope-link" onClick={() => choose(preview, true)}>
                Edit {preview} only
              </button>
            ) : (
              <button type="button" className="style-scope-link" onClick={() => {
                  setState({ viewport: VIEWPORT_PRESETS[scope] });
                  setFocusAfter(true);
                }}
              >
                Preview {scope}
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
  designSizesWin
}: {
  styles: ResponsiveStyles | undefined;
  inherited: ResponsiveStyles | undefined;
  allowed?: string[];
  tokens: TokenDef[];
  onSet: (prop: string, value: StyleValue | null) => void;
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
}) {
  const scope = useStore((s) => s.styleScope);
  const viewport = useStore((s) => s.viewport);
  const preview = sizeForWidth(viewport);
  const [showAll, setShowAll] = useState(false);
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
  const setOutside = allowed?.length ? [...new Set(Object.values(styles ?? {}).flatMap((sc) => Object.keys(sc ?? {})))].filter((id) => !allowed.includes(id)) : [];
  const props = allowed?.length ? [...allowed, ...setOutside].map((id) => STYLE_PROP_MAP[id]).filter(Boolean) : STYLE_PROPS;
  const groups = new Map<StylePropDef['group'], StylePropDef[]>();
  for (const p of props) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const own = styles?.[scope] ?? {};
  // Layout controls that only mean something for a stack or grid are shown when the layout is one.
  const effective = (id: string) => own[id] ?? styles?.base?.[id] ?? inherited?.[scope]?.[id] ?? inherited?.base?.[id];
  const layout = effective('layout');
  const position = effective('position');
  // Set at any size: such a row always shows, so "From All sizes" and "Phone uses …" are never hidden.
  const setAnywhere = (id: string) => own[id] !== undefined || Object.values(styles ?? {}).some((sc) => sc?.[id] !== undefined);
  const relevant = (id: string) => {
    if (setAnywhere(id)) return true;
    if (id === 'order') return false;
    if (id === 'columns' || id === 'gridTemplate') return layout === 'grid';
    if (id === 'align' || id === 'justify' || id === 'gap' || id === 'wrap' || id === 'rowGap' || id === 'columnGap') return layout === 'stack' || layout === 'row' || layout === 'grid';
    // Offsets do nothing until the element is positioned.
    if (id === 'inset') return position !== undefined && position !== 'static';
    return true;
  };
  // Long lists show the common controls of the first two groups plus anything already set; the rest sit behind
  // one disclosure.
  const entries = [...groups.entries()];
  const long = entries.reduce((n, [, l]) => n + l.filter((p) => relevant(p.id)).length, 0) > 10;
  const primary = new Set(entries.slice(0, 2).map(([g]) => g));
  const isPrimary = (g: StylePropDef['group'], p: StylePropDef) => !long || (primary.has(g) && !p.advanced);
  const tucked = (g: StylePropDef['group'], p: StylePropDef) => !isPrimary(g, p) && relevant(p.id) && !setAnywhere(p.id);
  const hiddenCount = entries.reduce((n, [g, l]) => n + l.filter((p) => tucked(g, p)).length, 0);
  const total = Object.values(styles ?? {}).reduce((n, s) => n + Object.keys(s ?? {}).length, 0);
  const here = Object.keys(own).length;
  const sizeName = (s: ResponsiveScope) => SCOPE_LABEL[s].toLowerCase();

  const row = (p: StylePropDef) => {
    const value = own[p.id];
    const label = labelOf(p);
    // What shows through when nothing is set here, and where it comes from.
    const designHere = scope !== 'base' ? inherited?.[scope]?.[p.id] : undefined;
    const allSizes = scope !== 'base' && !(designSizesWin && designHere !== undefined) ? styles?.base?.[p.id] : undefined;
    const fromDesign = designHere ?? inherited?.base?.[p.id];
    const under = allSizes ?? fromDesign;
    const underText = describe(p, under, tokens);
    const underFrom = allSizes !== undefined ? 'From All sizes' : under !== undefined ? 'From the design' : undefined;
    // Under All sizes, a size with its own value here wins over whatever is set for all sizes; so does the
    // design's own value for the previewed size when nothing here overrides it (or, for a component's own
    // design, whenever it has one).
    const exceptions = scope === 'base' ? SIZES.filter((s) => styles?.[s]?.[p.id] !== undefined) : [];
    const lines: Array<{ text: string; previewed?: boolean; quiet?: boolean }> = [];
    if (value === undefined && underFrom) lines.push({ text: underFrom, quiet: underFrom === 'From the design' });
    for (const s of exceptions) lines.push({ text: `${SCOPE_LABEL[s]} uses ${describe(p, styles![s]![p.id], tokens)}`, previewed: s === preview });
    const designAtPreview = inherited?.[preview]?.[p.id];
    if (scope === 'base' && (value === undefined || designSizesWin) && !exceptions.includes(preview) && designAtPreview !== undefined && JSON.stringify(designAtPreview) !== JSON.stringify(inherited?.base?.[p.id]))
      lines.push({ text: `${SCOPE_LABEL[preview]} uses ${describe(p, designAtPreview, tokens)} from the design`, previewed: true });
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
                focusNext(`[data-prop="${p.id}"] :is(select, input, textarea)`, '.style-more', '[role="radio"][aria-checked="true"]');
                onSet(p.id, null);
              }}
            >
              <RotateCcw />
            </button>
          )}
        </div>
        <div className="style-control">
          <Control def={p} label={label} value={value} under={under} underText={underText} underFrom={underFrom} tokens={tokens} describedBy={lines.length ? sourceId : undefined} onSet={(v) => onSet(p.id, v)} />
        </div>
        {lines.length > 0 && (
          <div className="style-source" id={sourceId}>
            {lines.map((l) => (
              // The design is the expected source of anything not changed here, so it is named for screen
              // readers only; everything else is shown.
              <span key={l.text} className={l.quiet ? 'sr-only' : l.previewed ? 'previewed' : undefined}>
                {l.text}
                {l.previewed && <span className="style-source-tag"> · in the preview</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  const group = (g: StylePropDef['group'], list: StylePropDef[]) => (
    <div key={g} className="style-group" role="group" aria-label={STYLE_GROUP_LABELS[g]}>
      <div className="style-group-title" aria-hidden="true">
        {STYLE_GROUP_LABELS[g]}
      </div>
      {list.map(row)}
    </div>
  );
  const shown = (pick: (g: StylePropDef['group'], p: StylePropDef) => boolean) =>
    entries.map(([g, list]) => [g, list.filter((p) => relevant(p.id) && pick(g, p))] as const).filter(([, list]) => list.length);

  const before = shown((g, p) => isPrimary(g, p) || (!showAll && setAnywhere(p.id)));
  const after = showAll ? shown((g, p) => !isPrimary(g, p)) : [];
  const moreGroups = entries.filter(([g, l]) => l.some((p) => tucked(g, p))).map(([g]) => STYLE_GROUP_LABELS[g]);
  const size = sizeName(scope);
  const subject = target ? ` to ${target}` : '';
  // The reset clears the size being edited and nothing else; clearing every size is a separate, named choice.
  const others = total - here;
  const resetText = scope === 'base' ? (resetLabel && !others ? resetLabel : `Reset ${here === 1 ? 'the' : here} all-sizes change${here === 1 ? '' : 's'}`) : `Reset ${here === 1 ? 'the' : here} ${size} change${here === 1 ? '' : 's'}`;
  const resetHint =
    scope === 'base'
      ? others
        ? `Clears ${here === 1 ? 'the change' : 'the changes'} made for all sizes${subject}. Changes made for one size stay.`
        : `Clears ${here === 1 ? 'the style change' : 'every style change'}${subject || ' made here'}.`
      : `Clears only ${here === 1 ? `this ${size} change` : `the ${size} changes`}${subject}. All sizes and the other sizes stay as they are.`;
  const everyText = resetLabel ?? `Reset all ${total} changes at every size`;
  return (
    <div className="style-controls" ref={root}>
      <ScopePicker styles={styles} />
      {before.map(([g, list]) => group(g, list))}
      {long && (showAll || hiddenCount > 0) && (
        <button type="button" className="style-more" aria-expanded={showAll} aria-controls={moreId} onClick={() => setShowAll(!showAll)}>
          {showAll ? <ChevronUp /> : <ChevronDown />}
          <span className="style-more-text">
            <span>{showAll ? 'Fewer style options' : `More style options (${hiddenCount})`}</span>
            {!showAll && moreGroups.length > 0 && <span className="style-more-groups">{moreGroups.join(', ')}</span>}
          </span>
        </button>
      )}
      <div id={moreId} className="style-more-body" hidden={!showAll}>
        {after.map(([g, list]) => group(g, list))}
      </div>
      {onReset && (here > 0 || (scope === 'base' && others > 0)) && (
        <div className="style-footer">
          {here > 0 && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                aria-describedby={resetHintId}
                onClick={() => {
                  focusNext('.style-footer .btn', '[role="radio"][aria-checked="true"]');
                  onReset(scope);
                }}
              >
                <RotateCcw /> {resetText}
              </button>
              <span className="style-footer-hint" id={resetHintId}>
                {resetHint}
              </span>
            </>
          )}
          {/* Under All sizes, the changes made for single sizes can go too, in one step. */}
          {scope === 'base' && others > 0 && (
            <button
              type="button"
              className={here > 0 ? 'link-btn style-footer-every' : 'btn btn-sm'}
              onClick={() => {
                focusNext('[role="radio"][aria-checked="true"]');
                onReset(undefined);
              }}
            >
              {here > 0 ? everyText : <><RotateCcw /> {everyText}</>}
            </button>
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
function Lead({ def, v, tokens }: { def: StylePropDef; v: { token: string }; tokens: TokenDef[] }) {
  if (def.kind === 'color') return <span className="style-lead swatch" style={{ background: colorOf(tokens, v.token) }} aria-hidden="true" />;
  return <Palette className="style-lead" aria-hidden="true" />;
}

function Control({
  def,
  label,
  value,
  under,
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
  if (def.kind === 'enum' || def.kind === 'ratio') {
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
    const range = def.min !== undefined && def.max !== undefined ? ` (${def.min} to ${def.max})` : '';
    return (
      <DraftInput
        className={`input sm grow style-input${state}`}
        value={set ? String(value) : ''}
        placeholder={underText || `Default${range}`}
        ariaLabel={`${label}${range}`}
        aria-describedby={describedBy}
        onCommit={(t) => {
          const n = Number(t.trim().replace(/%$/, ''));
          if (t.trim() === '') onSet(null);
          else if (Number.isFinite(n)) onSet(/%$/.test(t.trim()) && def.max === 1 ? n / 100 : n);
          else return false;
        }}
      />
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
  const linkedName = lead ? `${describe(def, lead, tokens)}, from Site styles` : undefined;
  // What a custom value starts from: the value in effect, written out.
  const currentText = isToken(current) ? (typeof tokenOf(tokens, current.token)?.value === 'string' ? String(tokenOf(tokens, current.token)!.value) : undefined) : current === undefined ? undefined : String(current);
  // What the colour picker starts from: the colour in effect, a linked style followed to its end.
  const colorText = isToken(current) ? colorOf(tokens, current.token) : current === undefined ? '' : String(current);
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
          className={`select sm grow style-select${state}`}
          value={selectValue}
          aria-label={label}
          aria-describedby={[describedBy, lead ? linkId : undefined].filter(Boolean).join(' ') || undefined}
          onChange={(e) => {
            const v = e.target.value;
            setDrafting(false);
            if (v === '') onSet(null);
            else if (v === 'custom') setDrafting(true);
            else if (v.startsWith('token:')) onSet({ token: v.slice(6) });
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
          {linked && !tokOpts.some((t) => t.id === value.token) && <option value={`token:${value.token}`}>{describe(def, value, tokens)}</option>}
          {def.kind !== 'textStyle' && <option value="custom">{custom ? 'Custom' : 'Custom value…'}</option>}
        </select>
      </span>
      {custom && (
        <div
          className="style-custom"
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || literal) return;
            setDrafting(false);
            requestAnimationFrame(() => picker.current?.focus());
          }}
        >
          {def.kind === 'color' && <ColorPick className="md" value={literal ? String(value) : colorText} onPick={onSet} label={`${label}: pick a color`} />}
          <DraftInput
            className={`input sm grow style-input${def.kind === 'color' ? ' mono' : ''}${literal ? ' is-set' : ''}`}
            value={literal ? String(value) : ''}
            placeholder={currentText ?? (def.kind === 'color' ? '#1c2742' : def.placeholder ? `For example ${def.placeholder}` : undefined)}
            autoFocus={!literal}
            onCommit={(t) => (t.trim() ? onSet(t.trim()) : false)}
            ariaLabel={`${label} value`}
          />
        </div>
      )}
    </>
  );
}
