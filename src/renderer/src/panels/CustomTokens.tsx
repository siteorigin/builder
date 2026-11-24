import { useId, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProjectState, TokenDef, TokenGroup } from '@shared/types';
import { effectiveTokens } from '@generator/index';
import { tokenUsageCounts } from '@engine/tokens';
import { followedText, linkOf, textMetrics } from '@shared/styles';
import { applyOps } from '../store';
import { ColorPick } from '../components/ColorPick';
import { DraftInput, Field } from '../components/ui';
import { FontSelect, familyName } from './FontSelect';

/**
 * The project's own site styles (spec §7.2): create, rename, change and remove them, with how many places use
 * each. Removing a used style asks for a replacement, or keeps its value where it is used.
 */
const GROUPS: Array<{ group: TokenGroup; label: string; placeholder: string }> = [
  { group: 'color', label: 'Color', placeholder: '#2e8b57' },
  { group: 'space', label: 'Spacing', placeholder: '24px' },
  { group: 'container', label: 'Page width', placeholder: '960px' },
  { group: 'radius', label: 'Corners', placeholder: '12px' },
  { group: 'shadow', label: 'Shadow', placeholder: '0 4px 12px rgb(0 0 0 / 0.12)' },
  { group: 'border', label: 'Border', placeholder: '1px solid var(--so-color-border)' },
  { group: 'font', label: 'Font', placeholder: "'Inter', system-ui, sans-serif" },
  { group: 'text', label: 'Text style', placeholder: '' }
];
const groupLabel = (g: TokenGroup) => GROUPS.find((x) => x.group === g)?.label ?? g;
const times = (n: number) => (n ? `Used ${n} time${n === 1 ? '' : 's'}` : 'Not used yet');
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

function NewStyle({ tokens, say }: { tokens: TokenDef[]; say: (text: string) => void }) {
  const uid = useId();
  const [group, setGroup] = useState<TokenGroup>('color');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  // Only text styles whose metrics can be read can be started from; their metrics are what is copied.
  const textStyles = tokens.filter((t) => t.group === 'text' && textMetrics(tokens, t.id));
  const [basedOn, setBasedOn] = useState('');
  const spec = GROUPS.find((g) => g.group === group)!;
  const create = async () => {
    const base = textStyles.find((t) => t.id === (basedOn || textStyles[0]?.id));
    const v = group === 'text' ? (base ? textMetrics(tokens, base.id) : null) : value.trim();
    if (!label.trim() || !v) return;
    if (await applyOps([{ type: 'token.create', group, label: label.trim(), value: v }], `Add ${label.trim()}`)) {
      say(`${label.trim()} added to your styles.`);
      setLabel('');
      setValue('');
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
          <select id={`${uid}-group`} className="select sm" value={group} onChange={(e) => setGroup(e.target.value as TokenGroup)}>
            {GROUPS.map((g) => (
              <option key={g.group} value={g.group}>
                {g.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name" controlId={`${uid}-label`}>
          <input id={`${uid}-label`} className="input sm" value={label} placeholder="e.g. Highlight" maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </div>
      {group === 'text' ? (
        <Field label="Start from" controlId={`${uid}-based`}>
          <select id={`${uid}-based`} className="select sm" value={basedOn || textStyles[0]?.id} onChange={(e) => setBasedOn(e.target.value)}>
            {textStyles.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label="Value" controlId={`${uid}-value`}>
          <span className="ss-new-value">
            {group === 'color' && <ColorPick className="md" value={value} onPick={setValue} label="Pick a color" />}
            <input id={`${uid}-value`} className="input sm mono" value={value} placeholder={spec.placeholder} onChange={(e) => setValue(e.target.value)} />
          </span>
        </Field>
      )}
      <div>
        <button type="submit" className="btn btn-sm" disabled={!label.trim() || (group !== 'text' && !value.trim())}>
          <Plus /> Add style
        </button>
      </div>
    </form>
  );
}

/** What a style's own value is called in its "Same as" menu. */
const OWN: Partial<Record<TokenGroup, string>> = { color: 'Its own color', font: 'Its own font' };

/** A small sample of a non-colour style, the same size as a colour's swatch, so every row starts on one edge. */
function Mark({ t, value, tokens }: { t: TokenDef; value: string; tokens: TokenDef[] }) {
  if (t.group === 'text') {
    const v = textMetrics(tokens, t.id);
    const famRef = linkOf(v?.family);
    const stack = famRef ? followedText(tokens, famRef) : String(v?.family ?? '');
    return (
      <span className="ss-custom-mark" style={{ fontFamily: stack || undefined, fontWeight: v?.weight }} aria-hidden="true">
        Aa
      </span>
    );
  }
  if (t.group === 'font')
    return (
      <span className="ss-custom-mark" style={{ fontFamily: value || undefined }} aria-hidden="true">
        Aa
      </span>
    );
  const style: React.CSSProperties =
    t.group === 'radius' ? { borderTopLeftRadius: value } : t.group === 'shadow' ? { boxShadow: value } : t.group === 'border' ? { border: value.replace(/var\((--so-[a-z0-9-]+)\)/gi, 'currentColor') } : {};
  return (
    <span className={`ss-custom-mark ${t.group}`} aria-hidden="true">
      <i style={style} />
    </span>
  );
}

function StyleRow({ t, uses, where, tokens, state, say, onEditText }: { t: TokenDef; uses: number; where: string[]; tokens: TokenDef[]; state: ProjectState; say: (text: string) => void; onEditText: (id: string) => void }) {
  const uid = useId();
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
  const options = [...(t.group !== 'text' ? ['__keep'] : []), ...others.map((o) => o.id)];
  const replacement = options.includes(choice) ? choice : (options[0] ?? '');
  const ref = linkOf(t.value, t.group);
  const follows = ref ? (tokens.find((x) => x.id === ref)?.label ?? 'a style that is no longer available') : null;
  // The value in effect, a style it follows already followed: what a link shows, and what unlinking keeps.
  const literal = followedText(tokens, t.id);
  /** A picker's changes merge with each other, never with a typed value: undo returns to what was typed. */
  const set = (value: unknown, by?: 'picker') => applyOps([{ type: 'token.set', tokenId: t.id, value }], `Change ${t.label}`, by ? `token:${t.id}:${by}` : `token:${t.id}`);
  /** Linking and unlinking are steps of their own, so undo always returns to the link before. */
  const relink = (value: unknown) => applyOps([{ type: 'token.set', tokenId: t.id, value }], `Change ${t.label}`);
  const remove = async () => {
    if (uses && !replacement) return;
    // Where focus goes once this row is gone: the next style's name, the one before, or the Add a style form.
    const row = toggle.current?.closest('.ss-custom-row');
    const list = row?.closest('.ss-custom');
    // Found before the change: once it lands this row is detached and has no neighbours left to ask.
    const neighbour = (row?.nextElementSibling ?? row?.previousElementSibling)?.getAttribute('data-token-id') ?? null;
    const after = () => (neighbour ? list?.querySelector<HTMLElement>(`[data-token-id="${CSS.escape(neighbour)}"] .ss-custom-name`) : null) ?? list?.querySelector<HTMLElement>('.ss-new-style select') ?? null;
    const ok = await applyOps([{ type: 'token.remove', tokenId: t.id, ...(!uses ? {} : replacement === '__keep' ? { detach: true } : { replacementTokenId: replacement }) }], `Remove ${t.label}`);
    if (!ok) return;
    say(`${t.label} removed. You can undo this.`);
    requestAnimationFrame(() => after()?.focus());
  };
  const spec = GROUPS.find((g) => g.group === t.group);
  let value: React.ReactNode;
  if (t.group === 'text') {
    const v = textMetrics(tokens, t.id);
    const famRef = linkOf(v?.family);
    const stack = famRef ? followedText(tokens, famRef) : String(v?.family ?? '');
    // A text style whose metrics cannot be read (hand-edited, or linked to a style that is gone) starts again from one that can.
    const restart = v ? null : tokens.find((x) => x.group === 'text' && x.id !== t.id && textMetrics(tokens, x.id));
    value = v ? (
      <div className="ss-custom-text">
        <span className="ss-custom-summary">
          {sizeName(v.size)} · {WEIGHT_NAMES[v.weight] ?? v.weight} · {famRef ? (tokens.find((x) => x.id === famRef)?.label ?? 'a font that is no longer available') : familyName(stack)}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => onEditText(t.id)}>
          Edit text style<span className="sr-only"> {t.label}</span>
        </button>
      </div>
    ) : (
      <div className="ss-custom-text">
        <span className="ss-custom-summary">Its settings are missing.</span>
        {restart && (
          <button type="button" className="btn btn-sm" onClick={() => void relink(textMetrics(tokens, restart.id))}>
            Start from {restart.label}
          </button>
        )}
      </div>
    );
  } else {
    const own =
      t.group === 'font' ? (
        <FontSelect id={`${uid}-value`} state={state} stack={literal} onChoose={(next) => set(next)} />
      ) : (
        <DraftInput id={`${uid}-value`} className="input sm mono" value={literal} placeholder={spec?.placeholder} onCommit={(v) => (v.trim() ? set(v.trim()) : false)} />
      );
    // A link to a style that is gone shows nothing to keep, so a value can be typed over it instead.
    const broken = !!ref && !literal;
    value = (
      <>
        <div className="grid-2">
          <Field label="Value" controlId={ref && !broken ? undefined : `${uid}-value`}>
            {ref && !broken ? (
              <span className="ss-custom-linked mono" title={literal}>
                {t.group === 'font' ? familyName(literal) : literal}
              </span>
            ) : (
              own
            )}
          </Field>
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
        </div>
        {t.group === 'font' && !ref && (
          <div className="ss-custom-stack">
            {editingStack && <DraftInput className="input sm mono" value={literal} ariaLabel={`${t.label} font stack`} onCommit={(v) => (v.trim() ? set(v.trim()) : false)} />}
            <button type="button" className="link-btn" aria-expanded={editingStack} onClick={() => setEditingStack(!editingStack)}>
              {editingStack ? 'Hide font stack' : 'Edit font stack'}
              <span className="sr-only"> for {t.label}</span>
            </button>
          </div>
        )}
      </>
    );
  }
  return (
    <div className={`ss-custom-row${removing ? ' removing' : ''}`} data-ss-row data-token-id={t.id}>
      <div className="ss-custom-head">
        {t.group === 'color' ? <ColorPick className="md" value={literal} disabled={!!ref} onPick={(next) => set(next, 'picker')} label={`${t.label} color`} /> : <Mark t={t} value={literal} tokens={tokens} />}
        <DraftInput className="input sm ss-custom-name" value={t.label} onCommit={(v) => (v.trim() ? void applyOps([{ type: 'token.rename', tokenId: t.id, label: v.trim() }], `Rename ${t.label}`) : false)} ariaLabel={`${t.label} name`} />
        <button
          ref={toggle}
          type="button"
          className="btn btn-sm btn-ghost ss-custom-remove-toggle"
          title={uses ? `Remove ${t.label}…` : `Remove ${t.label}`}
          aria-label={`Remove ${t.label}`}
          // Only a style in use asks first; one that is not used is removed at once, and undo brings it back.
          aria-expanded={uses ? removing : undefined}
          onClick={() => (uses ? setRemoving(!removing) : void remove())}
        >
          <Trash2 />
        </button>
      </div>
      <div className="ss-custom-meta">
        <span>{groupLabel(t.group)}</span>
        <span aria-hidden="true">·</span>
        <span className="ss-custom-uses">{times(uses)}</span>
        {follows && (
          <>
            <span aria-hidden="true">·</span>
            <span className="ss-custom-follows">Same as {follows}</span>
          </>
        )}
      </div>
      {value}
      {removing && uses > 0 && (
        <div className="ss-custom-remove" role="group" aria-label={`Remove ${t.label}`}>
          <p className="ss-custom-where">
            {where.length ? (
              <>
                Used in <strong>{where.join(', ')}</strong>.
              </>
            ) : (
              `Used in ${uses === 1 ? 'one place' : `${uses} places`}.`
            )}{' '}
            {uses === 1
              ? t.group !== 'text'
                ? 'That place can keep the value it shows now, or follow another style.'
                : 'That place follows another text style instead.'
              : t.group !== 'text'
                ? 'Those places can keep the value they show now, or follow another style.'
                : 'Those places follow another text style instead.'}
          </p>
          <Field label="In its place" controlId={`${uid}-repl`}>
            {/* Opening the step puts focus on its one decision. */}
            <select id={`${uid}-repl`} className="select sm" value={replacement} autoFocus onChange={(e) => setChoice(e.target.value)}>
              {t.group !== 'text' && <option value="__keep">{uses === 1 ? 'Keep the value it shows now' : 'Keep the value they show now'}</option>}
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  Use {o.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="ss-custom-remove-actions">
            <button type="button" className="btn btn-sm btn-danger" disabled={!replacement} onClick={() => void remove()}>
              <Trash2 />
              Remove<span className="sr-only"> {t.label}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setRemoving(false);
                toggle.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** `onEditText` opens a text style in the Text styles list, where all of its metrics are edited. */
/** `whereUsed` names the pages, shared parts, components and styles that use a style, for the remove step. */
export function CustomTokens({ state, whereUsed, say = () => {}, onEditText }: { state: ProjectState; whereUsed?: (id: string) => string[]; say?: (text: string) => void; onEditText: (id: string) => void }) {
  const tokens = useMemo(() => effectiveTokens(state), [state]);
  const uses = useMemo(() => tokenUsageCounts(state), [state]);
  const custom = tokens.filter((t) => state.tokens.custom.some((c) => c.id === t.id));
  return (
    <div className="ss-custom">
      <p className="ss-custom-intro">
        Your own colors, sizes, fonts and text styles, beside the theme's. Pick them in the Inspector like any site style.
        {custom.length > 2 && (
          <>
            {' '}
            <button type="button" className="link-btn ss-jump" onClick={(e) => e.currentTarget.closest('.ss-custom')?.querySelector<HTMLElement>('.ss-new-style select')?.focus()}>
              Add a style
            </button>
          </>
        )}
      </p>
      {custom.length ? <div className="ss-custom-list">{custom.map((t) => <StyleRow key={t.id} t={t} uses={uses[t.id] ?? 0} where={whereUsed?.(t.id) ?? []} tokens={tokens} say={say} state={state} onEditText={onEditText} />)}</div> : <p className="ss-none">No styles of your own yet.</p>}
      <NewStyle tokens={tokens} say={say} />
    </div>
  );
}
