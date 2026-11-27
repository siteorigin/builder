import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProjectState, TokenDef, TokenGroup } from '@shared/types';
import { effectiveTokens } from '@generator/index';
import { tokenPropUsageCounts, tokenUsageCounts } from '@engine/tokens';
import { followedText, linkOf, textMetrics } from '@shared/styles';
import { applyOps, commitOps, toast, undoAction } from '../store';
import { ColorPick, opacityWords, type ColorPreset } from '../components/ColorPick';
import { ColorTextInput } from '../components/ColorTextInput';
import { colorFieldProblem } from '@shared/color';
import { normalizeColorText } from '@shared/color-names';
import { DisclosureMark, DraftInput, Field } from '../components/ui';
import { FontSelect, familyName } from './FontSelect';
import { usePreviewStack } from '../lib/editor-fonts';

/**
 * The project's own site styles (spec §7.2): create, rename, change and remove them, with how many places use
 * each. Each style is a summary row (its sample, name, kind, value and whether it is used) that opens to edit, as
 * the Text styles list above does. Removing a used style asks for a replacement, or keeps its value where it is
 * used; any removal is answered with a notice carrying Undo.
 */
const GROUPS: Array<{ group: TokenGroup; label: string; placeholder: string }> = [
  { group: 'color', label: 'Color', placeholder: '#2e8b57' },
  { group: 'space', label: 'Spacing', placeholder: '24px' },
  { group: 'container', label: 'Page width', placeholder: '960px' },
  { group: 'radius', label: 'Corners', placeholder: '12px' },
  { group: 'shadow', label: 'Shadow', placeholder: '0 4px 12px rgb(0 0 0 / 0.12)' },
  { group: 'border', label: 'Border', placeholder: '1px solid #d0d5dd' },
  { group: 'font', label: 'Font', placeholder: "'Inter', system-ui, sans-serif" },
  { group: 'text', label: 'Text style', placeholder: '' }
];
const groupLabel = (g: TokenGroup) => GROUPS.find((x) => x.group === g)?.label ?? g;
const groupOrder = (g: TokenGroup) => {
  const i = GROUPS.findIndex((x) => x.group === g);
  return i < 0 ? GROUPS.length : i;
};
const uses = (n: number) => (n === 1 ? '1 use' : `${n} uses`);
const isRef = (v: unknown): v is { token: string } => !!v && typeof v === 'object' && 'token' in (v as object);
const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };
const px = (v: string) => {
  const m = /^(-?\d*\.?\d+)(rem|em|px)$/.exec(v.trim());
  return m ? Math.round(parseFloat(m[1]) * (m[2] === 'px' ? 1 : 16) * 10) / 10 : null;
};
/** A size as an owner reads it: "20px", or "42–78px" for one that grows with the window; anything else as written. */
const sizeName = (v: string) => {
  const one = px(v);
  if (one !== null) return `${one}px`;
  const m = /^clamp\(\s*([^,]+),[^,]+,\s*([^)]+)\)$/.exec(v.trim());
  const [a, b] = m ? [px(m[1]), px(m[2])] : [null, null];
  return a !== null && b !== null ? `${Math.round(a)}–${Math.round(b)}px` : v;
};

/** What Add style still needs, said beside it while it can't add: a name first, then a value of the chosen kind. */
const needs = (group: TokenGroup, label: string, value: string, canStart: boolean): string | null => {
  if (!label.trim()) return 'Give it a name to add it';
  if (group === 'text') return canStart ? null : 'There is no text style to start from';
  if (value.trim()) return null;
  return group === 'color' ? 'Pick or type a color to add it' : group === 'font' ? 'Choose a font to add it' : 'Type a value to add it';
};

/** `away` is a style just added that landed out of view; `onShow` brings it into view. */
function NewStyle({ tokens, state, say, onAdded, away, onShow }: { tokens: TokenDef[]; state: ProjectState; say: (text: string) => void; onAdded: (id: string) => void; away: TokenDef | null; onShow: () => void }) {
  const uid = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const [group, setGroup] = useState<TokenGroup>('color');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  // Why the colour typed can't be added: said beside the field, which keeps it, and checked again as it is corrected.
  const [refused, setRefused] = useState<string | null>(null);
  // Only text styles whose metrics can be read can be started from; their metrics are what is copied.
  const textStyles = tokens.filter((t) => t.group === 'text' && textMetrics(tokens, t.id));
  const [chosenBase, setBasedOn] = useState('');
  // The one chosen, while it is still there to start from; otherwise the first that is.
  const basedOn = textStyles.some((t) => t.id === chosenBase) ? chosenBase : (textStyles[0]?.id ?? '');
  const spec = GROUPS.find((g) => g.group === group)!;
  const missing = needs(group, label, value, textStyles.length > 0);
  // Unavailable while something is missing or a refused colour is still in the field: its reason is said beside it.
  const blocked = !!missing || !!refused;
  const focusValue = () => (valueRef.current ?? document.getElementById(`${uid}-value`))?.focus();
  // One add at a time: a second press or Enter while the first is being saved would add the style twice.
  const pending = useRef(false);
  const create = async () => {
    if (pending.current) return;
    // Unavailable but still focusable, so its reason can be read: a press goes to what needs fixing instead.
    if (blocked) {
      if (!label.trim()) nameRef.current?.focus();
      else focusValue();
      return;
    }
    const base = textStyles.find((t) => t.id === basedOn);
    if (group === 'color') {
      const problem = colorFieldProblem(value);
      setRefused(problem?.message ?? null);
      if (problem) {
        // Said once, as it is refused; while it is corrected the field's own description keeps up quietly.
        say(problem.message);
        focusValue();
        return;
      }
    }
    const v = group === 'text' ? (base ? textMetrics(tokens, base.id) : null) : group === 'color' ? normalizeColorText(value) : value.trim();
    if (!v) return;
    pending.current = true;
    const added = await applyOps([{ type: 'token.create', group, label: label.trim(), value: v }], `Add ${label.trim()}`).finally(() => (pending.current = false));
    if (added) {
      say(`${label.trim()} added to your styles.`);
      const id = added[0]?.tokenId;
      if (typeof id === 'string') onAdded(id);
      setLabel('');
      setValue('');
      setRefused(null);
      // Ready for the next one.
      nameRef.current?.focus();
    }
  };
  return (
    <form
      className="ss-new-style"
      aria-labelledby={`${uid}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="ss-new-title" id={`${uid}-title`}>
        Add a style
      </div>
      <div className="grid-2">
        <Field label="Kind" controlId={`${uid}-group`}>
          <select
            id={`${uid}-group`}
            className="select sm"
            value={group}
            onChange={(e) => {
              // A value of one kind is rarely a value of another: the name stays, the value starts again.
              setGroup(e.target.value as TokenGroup);
              setValue('');
              setRefused(null);
            }}
          >
            {GROUPS.map((g) => (
              <option key={g.group} value={g.group}>
                {g.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name" controlId={`${uid}-label`}>
          <input ref={nameRef} id={`${uid}-label`} className="input sm" value={label} placeholder="e.g. Highlight" maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </div>
      {group === 'text' ? (
        <Field label="Start from" controlId={`${uid}-based`}>
          <select id={`${uid}-based`} className="select sm" value={basedOn} onChange={(e) => setBasedOn(e.target.value)}>
            {textStyles.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      ) : group === 'font' ? (
        <Field label="Font" controlId={`${uid}-value`}>
          <FontSelect id={`${uid}-value`} state={state} stack={value} onChoose={(next) => setValue(next)} />
        </Field>
      ) : (
        <Field label="Value" controlId={`${uid}-value`} error={refused}>
          <span className="ss-custom-value">
            {group === 'color' && (
              <ColorPick
                className="md"
                value={value}
                onPick={(next) => {
                  setValue(next);
                  setRefused(null);
                }}
                presets={sitePresets(tokens)}
                label="New color"
              />
            )}
            <input
              ref={valueRef}
              id={`${uid}-value`}
              className="input sm mono"
              value={value}
              placeholder={`e.g. ${spec.placeholder}`}
              aria-invalid={refused ? true : undefined}
              aria-describedby={refused ? `${uid}-value-note` : undefined}
              onChange={(e) => {
                setValue(e.target.value);
                if (refused) setRefused(e.target.value.trim() ? (colorFieldProblem(e.target.value)?.message ?? null) : null);
              }}
            />
          </span>
        </Field>
      )}
      <div className="ss-new-actions">
        <button type="submit" className="btn btn-sm" aria-disabled={blocked ? true : undefined} aria-describedby={missing ? `${uid}-needs` : refused ? `${uid}-value-note` : undefined}>
          <Plus /> Add style
        </button>
        {missing && (
          <span className="ss-new-needs" id={`${uid}-needs`}>
            {missing}
          </span>
        )}
        {away && !label && (
          <span className="ss-new-added">
            Added “{away.label}”.{' '}
            <button type="button" className="link-btn" onClick={onShow}>
              Show it
            </button>
          </span>
        )}
      </div>
    </form>
  );
}

/** What a style's own value is called in its "Same as" menu. */
const OWN: Partial<Record<TokenGroup, string>> = { color: 'Its own color', font: 'Its own font' };

/** The site's colours, as a picker offers them to copy: their value now, leaving out `except`. */
const sitePresets = (tokens: TokenDef[], except?: string): ColorPreset[] =>
  tokens.filter((x) => x.group === 'color' && x.id !== except && followedText(tokens, x.id)).map((x) => ({ id: x.id, label: x.label, value: followedText(tokens, x.id) }));

/** A small sample of the style, the same size for every kind, so every row starts on one edge. */
function Mark({ t, value, tokens }: { t: TokenDef; value: string; tokens: TokenDef[] }) {
  const shownStack = usePreviewStack();
  if (t.group === 'text') {
    const v = textMetrics(tokens, t.id);
    const famRef = linkOf(v?.family);
    const stack = famRef ? followedText(tokens, famRef) : String(v?.family ?? '');
    return (
      <span className="ss-custom-mark" style={{ fontFamily: stack ? shownStack(stack) : undefined, fontWeight: v?.weight }} aria-hidden="true">
        Aa
      </span>
    );
  }
  if (t.group === 'font')
    return (
      <span className="ss-custom-mark" style={{ fontFamily: value ? shownStack(value) : undefined }} aria-hidden="true">
        Aa
      </span>
    );
  const style: React.CSSProperties =
    t.group === 'color'
      ? { background: value }
      : t.group === 'radius'
        ? { borderTopLeftRadius: value }
        : t.group === 'shadow'
          ? { boxShadow: value }
          : t.group === 'border'
            ? { border: value.replace(/var\((--so-[a-z0-9-]+)\)/gi, 'currentColor') }
            : {};
  return (
    <span className={`ss-custom-mark ${t.group}`} aria-hidden="true">
      <i style={style} />
    </span>
  );
}

interface RowProps {
  t: TokenDef;
  fresh: boolean;
  uses: number;
  propUses: number;
  where: string[];
  tokens: TokenDef[];
  state: ProjectState;
  open: boolean;
  onOpen: (open: boolean) => void;
  onEditText: (id: string) => void;
}

function StyleRow({ t, fresh, uses: used, propUses, where, tokens, state, open, onOpen, onEditText }: RowProps) {
  const uid = useId();
  const bodyId = `${uid}-body`;
  const [removing, setRemoving] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState('');
  const [editingStack, setEditingStack] = useState(false);
  // Styles that follow this one (directly or through others) would end up following themselves.
  const followers = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of tokens) {
      const ref = isRef(x.value) ? x.value.token : null;
      if (ref && (ref === t.id || followers.has(ref)) && !followers.has(x.id)) (followers.add(x.id), (grew = true));
    }
  }
  const others = tokens.filter((x) => x.group === t.group && x.id !== t.id && !followers.has(x.id));
  // What the menu shows is what Remove sends: text styles cannot keep a plain value.
  // A text style, or one a component property chooses, can only move to another style: neither keeps a plain value.
  const keepable = t.group !== 'text' && !propUses;
  const options = [...(keepable ? ['__keep'] : []), ...others.map((o) => o.id)];
  const replacement = options.includes(choice) ? choice : (options[0] ?? '');
  const ref = linkOf(t.value, t.group);
  const follows = ref ? (tokens.find((x) => x.id === ref)?.label ?? 'a style that is no longer available') : null;
  // The value in effect, a style it follows already followed: what a link shows, and what unlinking keeps.
  const literal = followedText(tokens, t.id);
  // A link to a style that is gone shows nothing to keep, so a value can be typed over it instead.
  const broken = !!ref && !literal;
  /** A picker's changes merge with each other, never with a typed value: undo returns to what was typed. */
  const set = (value: unknown, by?: 'picker') => applyOps([{ type: 'token.set', tokenId: t.id, value }], `Change ${t.label}`, by ? `token:${t.id}:${by}` : `token:${t.id}`);
  /** Linking and unlinking are steps of their own, so undo always returns to the link before. */
  const relink = (value: unknown) => applyOps([{ type: 'token.set', tokenId: t.id, value }], `Change ${t.label}`);
  const remove = async () => {
    if (used && !replacement) return;
    // Where focus goes once this row is gone: the next style, the one before, or the Add a style form.
    const row = toggle.current?.closest('.ss-custom-row');
    const list = row?.closest('.ss-custom');
    // Found before the change: once it lands this row is detached and has no neighbours left to ask.
    const neighbour = (row?.nextElementSibling ?? row?.previousElementSibling)?.getAttribute('data-token-id') ?? null;
    const after = () => (neighbour ? list?.querySelector<HTMLElement>(`[data-token-id="${CSS.escape(neighbour)}"] .ss-custom-toggle`) : null) ?? list?.querySelector<HTMLElement>('.ss-new-style select') ?? null;
    const r = await commitOps([{ type: 'token.remove', tokenId: t.id, ...(!used ? {} : replacement === '__keep' ? { detach: true } : { replacementTokenId: replacement }) }], `Remove ${t.label}`);
    if (!r?.ok) return;
    // Seen and heard (the notices are a live region), with the way back beside it.
    toast(`Removed “${t.label}”`, 'info', undoAction(r));
    requestAnimationFrame(() => after()?.focus());
  };
  const closeRemove = () => {
    setRemoving(false);
    toggle.current?.focus();
  };

  // The closed row's one line: kind, then what it is now (and what it follows, when it follows another style).
  let shown: React.ReactNode[];
  if (t.group === 'text') {
    const v = textMetrics(tokens, t.id);
    const famRef = linkOf(v?.family);
    const stack = famRef ? followedText(tokens, famRef) : String(v?.family ?? '');
    shown = v ? [sizeName(v.size), WEIGHT_NAMES[v.weight] ?? String(v.weight), famRef ? (tokens.find((x) => x.id === famRef)?.label ?? 'a font that is no longer available') : familyName(stack)] : ['Its settings are missing'];
  } else shown = [broken ? 'No value' : t.group === 'font' ? familyName(literal) : <span className="mono">{literal}</span>];

  let fields: React.ReactNode;
  if (t.group === 'text') {
    const v = textMetrics(tokens, t.id);
    // A text style whose metrics cannot be read (hand-edited, or linked to a style that is gone) starts again from one that can.
    const restart = v ? null : tokens.find((x) => x.group === 'text' && x.id !== t.id && textMetrics(tokens, x.id));
    fields = v ? (
      <div className="ss-custom-text">
        <button type="button" className="btn btn-sm" onClick={() => onEditText(t.id)}>
          Edit text style<span className="sr-only"> {t.label}</span>
        </button>
        <span className="field-hint">Its size, weight and font are set in Text styles.</span>
      </div>
    ) : (
      <div className="ss-custom-text">
        <span className="field-hint">Its settings are missing.</span>
        {restart && (
          <button type="button" className="btn btn-sm" onClick={() => void relink(textMetrics(tokens, restart.id))}>
            Start from {restart.label}
          </button>
        )}
      </div>
    );
  } else {
    const spec = GROUPS.find((g) => g.group === t.group);
    const own =
      t.group === 'font' ? (
        <FontSelect id={`${uid}-value`} state={state} stack={literal} importable={t.label} onChoose={(next) => set(next)} />
      ) : t.group === 'color' ? (
        <span className="ss-custom-value">
          <ColorPick className="md" value={literal} onPick={(next) => set(next, 'picker')} presets={sitePresets(tokens, t.id)} label={`Pick a color for ${t.label}`} />
          <ColorTextInput id={`${uid}-value`} className="input sm mono" value={literal} placeholder={spec?.placeholder} onSave={(v) => set(v)} />
        </span>
      ) : (
        <DraftInput id={`${uid}-value`} className="input sm mono" value={literal} placeholder={spec?.placeholder} onCommit={(v) => (v.trim() ? set(v.trim()) : false)} />
      );
    fields = (
      <>
        <Field label="Same as" controlId={`${uid}-link`}>
          <select
            id={`${uid}-link`}
            className="select sm"
            value={ref ?? ''}
            onChange={(e) => {
              // Linking stores the style followed; unlinking keeps the value it showed as this style's own.
              if (e.target.value) void relink({ token: e.target.value });
              else if (literal) void relink(literal);
            }}
          >
            <option value="" disabled={broken}>
              {OWN[t.group] ?? 'Its own value'}
            </option>
            {ref && !others.some((o) => o.id === ref) && <option value={ref}>{follows}</option>}
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Value" controlId={ref && !broken ? undefined : `${uid}-value`} hint={ref && !broken ? `Follows ${follows}. Choose “${OWN[t.group] ?? 'Its own value'}” above to give it a value of its own.` : t.group === 'color' ? (opacityWords(literal) ?? undefined) : undefined}>
          {ref && !broken ? (
            <span className="ss-custom-linked mono" id={`${uid}-value`}>
              {t.group === 'font' ? familyName(literal) : literal}
            </span>
          ) : (
            own
          )}
        </Field>
        {t.group === 'font' && !ref && (
          <div className="ss-custom-stack">
            <button type="button" className="link-btn" aria-expanded={editingStack} onClick={() => setEditingStack(!editingStack)}>
              {editingStack ? 'Hide font stack' : 'Edit font stack'}
              <span className="sr-only"> for {t.label}</span>
            </button>
            {editingStack && <DraftInput className="input sm mono" value={literal} ariaLabel={`${t.label} font stack`} onCommit={(v) => (v.trim() ? set(v.trim()) : false)} />}
          </div>
        )}
      </>
    );
  }

  return (
    <li className={`ss-custom-row${open ? ' open' : ''}${fresh ? ' fresh' : ''}`} data-ss-row data-token-id={t.id}>
      <div className="ss-custom-head">
        <button
          ref={toggle}
          type="button"
          className="ss-custom-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            onOpen(!open);
            setRemoving(false);
          }}
        >
          <DisclosureMark />
          <Mark t={t} value={literal} tokens={tokens} />
          <span className="ss-custom-spec">
            <span className="ss-custom-top">
              <span className="ss-custom-name" title={t.label}>
                {t.label}
              </span>
              <span className={`badge${used ? ' accent' : ''} ss-custom-uses`}>{used ? uses(used) : 'Not used'}</span>
            </span>
            {/* Each part breaks whole, so a followed style's name and a size never split across lines. */}
            <span className="ss-custom-meta">
              {[groupLabel(t.group), ...(follows ? [`Same as ${follows}`] : []), ...shown].map((part, i) => (
                <span key={i}>{part}</span>
              ))}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="icon-btn sm ss-custom-remove-toggle"
          title={used ? `Remove ${t.label}…` : `Remove ${t.label}`}
          aria-label={`Remove ${t.label}`}
          // Only a style in use asks first; one that is not used is removed at once, and the notice's Undo brings it back.
          aria-expanded={used ? removing && open : undefined}
          aria-controls={used ? bodyId : undefined}
          onClick={() => {
            if (!used) return void remove();
            if (removing && open) return closeRemove();
            // A fresh decision each time: a replacement picked and then cancelled is not kept.
            setChoice('');
            onOpen(true);
            setRemoving(true);
          }}
        >
          <Trash2 />
        </button>
      </div>
      <div className="ss-custom-body" id={bodyId} hidden={!open}>
        {open &&
          (removing && used > 0 ? (
            <div className="ss-custom-remove" role="group" aria-label={`Remove ${t.label}`}>
              <p className="ss-custom-where" id={`${uid}-where`}>
                {where.length ? (
                  <>
                    Used in <strong>{where.join(', ')}</strong>.
                  </>
                ) : (
                  `Used in ${used === 1 ? 'one place' : `${used} places`}.`
                )}{' '}
                {used === 1
                  ? keepable
                    ? 'That place can keep the value it shows now, or follow another style.'
                    : `That place follows another ${t.group === 'text' ? 'text ' : ''}style instead.`
                  : keepable
                    ? 'Those places can keep the value they show now, or follow another style.'
                    : `Those places follow another ${t.group === 'text' ? 'text ' : ''}style instead.`}
              </p>
              {replacement ? (
                <Field label="In its place" controlId={`${uid}-repl`}>
                  {/* Opening the step puts focus on its one decision. */}
                  <select id={`${uid}-repl`} className="select sm" value={replacement} aria-describedby={`${uid}-where`} autoFocus onChange={(e) => setChoice(e.target.value)}>
                    {keepable && <option value="__keep">{used === 1 ? 'Keep the value it shows now' : 'Keep the value they show now'}</option>}
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        Use {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                // Nothing can take its place yet: say what would let it go, instead of an empty menu.
                <p className="ss-custom-where" id={`${uid}-blocked`}>
                  There is no other {groupLabel(t.group).toLowerCase()} style to use instead. Add one first, then remove this.
                </p>
              )}
              <div className="ss-custom-remove-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  aria-disabled={replacement ? undefined : true}
                  aria-describedby={replacement ? undefined : `${uid}-blocked`}
                  autoFocus={!replacement}
                  onClick={() => replacement && void remove()}
                >
                  <Trash2 />
                  Remove<span className="sr-only"> {t.label}</span>
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={closeRemove}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {used > 0 && (
                <p className="field-hint ss-custom-used-in">
                  {/* Context while editing, so a long list is cut short; the remove step names every place. */}
                  {where.length ? (
                    <>
                      Used in <strong>{where.slice(0, 3).join(', ')}</strong>
                      {where.length > 3 ? ` and ${where.length - 3} more` : ''}.
                    </>
                  ) : (
                    `Used in ${used === 1 ? 'one place' : `${used} places`}.`
                  )}
                </p>
              )}
              <Field label="Name" controlId={`${uid}-name`}>
                <DraftInput id={`${uid}-name`} className="input sm" value={t.label} onCommit={(v) => (v.trim() ? void applyOps([{ type: 'token.rename', tokenId: t.id, label: v.trim() }], `Rename ${t.label}`) : false)} />
              </Field>
              {fields}
            </>
          ))}
      </div>
    </li>
  );
}

/** `onEditText` opens a text style in the Text styles list, where all of its metrics are edited. */
/** `whereUsed` names the pages, shared parts, components and styles that use a style, for the remove step. */
export function CustomTokens({ state, whereUsed, say = () => {}, onEditText }: { state: ProjectState; whereUsed?: (id: string) => string[]; say?: (text: string) => void; onEditText: (id: string) => void }) {
  const tokens = useMemo(() => effectiveTokens(state), [state]);
  const counts = useMemo(() => tokenUsageCounts(state), [state]);
  const propUses = useMemo(() => tokenPropUsageCounts(state), [state]);
  // One style open at a time, as in Text styles.
  const [open, setOpen] = useState<string | null>(null);
  // A style just added is brought into view and marked for a moment, since it lands among its kind, not at the end.
  const [fresh, setFresh] = useState<string | null>(null);
  // One that would take Name (and its focus) out of view to show is named beside the form instead, with a way to it.
  const [awayId, setAway] = useState<string | null>(null);
  // Showing the one just added (Show it) is a request to go there, not another add to fit around the form.
  const going = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const behavior = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  useEffect(() => {
    if (!fresh) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-token-id="${CSS.escape(fresh)}"]`);
    const name = root.current?.querySelector<HTMLElement>('.ss-new-style input');
    const scroller = row?.closest<HTMLElement>('.panel-body');
    if (row && name && scroller && !going.current) {
      const view = scroller.getBoundingClientRect();
      // The panel's sticky header covers the top of the scroller.
      const top = (scroller.querySelector('.insp-head')?.getBoundingClientRect().bottom ?? view.top) + 8;
      const r = row.getBoundingClientRect();
      const n = name.getBoundingClientRect();
      if (r.top < top || r.bottom > view.bottom) {
        if (Math.max(r.bottom, n.bottom) - Math.min(r.top, n.top) <= view.bottom - top) scroller.scrollBy({ top: r.top < top ? r.top - top : r.bottom - view.bottom + 8, behavior: behavior() });
        else setAway(fresh);
      }
    }
    going.current = false;
    const timer = setTimeout(() => setFresh(null), 1800);
    return () => clearTimeout(timer);
  }, [fresh]);
  // The note lasts until the next style is begun.
  const added = (id: string) => (setAway(null), setFresh(id));
  const showAway = () => {
    if (!away) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-token-id="${CSS.escape(away.id)}"]`);
    row?.scrollIntoView({ block: 'center', behavior: behavior() });
    row?.querySelector<HTMLElement>('.ss-custom-toggle')?.focus({ preventScroll: true });
    going.current = true;
    setAway(null);
    // Marked afresh, even when it is still marked from being added a moment ago.
    setFresh(null);
    const id = away.id;
    requestAnimationFrame(() => setFresh(id));
  };
  // Kept together by kind, in the order the Kind menu lists them, and in the order they were added within a kind.
  const custom = tokens
    .filter((t) => state.tokens.custom.some((c) => c.id === t.id))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => groupOrder(a.t.group) - groupOrder(b.t.group) || a.i - b.i)
    .map(({ t }) => t);
  // Named from the style as it is now, and only while it is still there (an undo can take it away again).
  const away = custom.find((t) => t.id === awayId) ?? null;
  return (
    <div className="ss-custom" ref={root}>
      <p className="ss-custom-intro">
        {custom.length ? 'Your own colors, sizes, fonts and text styles, beside the theme’s. Pick them in the Inspector like any site style.' : 'None yet. Add the colors, sizes, fonts and text styles the theme doesn’t have, then pick them in the Inspector like any site style.'}
        {custom.length > 2 && (
          <>
            {' '}
            <button type="button" className="link-btn ss-jump" onClick={(e) => e.currentTarget.closest('.ss-custom')?.querySelector<HTMLElement>('.ss-new-style select')?.focus()}>
              Add a style
            </button>
          </>
        )}
      </p>
      {custom.length > 0 && (
        <ul className="ss-custom-list" aria-label="Your styles">
          {custom.map((t) => (
            <StyleRow key={t.id} t={t} fresh={fresh === t.id} uses={counts[t.id] ?? 0} propUses={propUses[t.id] ?? 0} where={whereUsed?.(t.id) ?? []} tokens={tokens} state={state} open={open === t.id} onOpen={(o) => setOpen(o ? t.id : null)} onEditText={onEditText} />
          ))}
        </ul>
      )}
      <NewStyle tokens={tokens} state={state} say={say} onAdded={added} away={away} onShow={showAway} />
    </div>
  );
}
