import { useId, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProjectState, TextStyleValue, TokenDef, TokenGroup } from '@shared/types';
import { effectiveTokens } from '@generator/index';
import { followToken, tokenUsageCounts } from '@engine/tokens';
import { linkOf } from '@shared/styles';
import { applyOps } from '../store';
import { ColorPick } from '../components/ColorPick';
import { DraftInput, Field } from '../components/ui';
import { FontSelect, familyName } from './FontSelect';

/**
 * The project's own site styles (spec §7.2): create, rename, change and remove them, with how many places use
 * each. Removing a used style asks for a replacement, or keeps its value where it is used.
 */
const GROUPS: Array<{ group: TokenGroup; label: string; placeholder: string }> = [
  { group: 'color', label: 'Colour', placeholder: '#2e8b57' },
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

function NewStyle({ tokens }: { tokens: TokenDef[] }) {
  const uid = useId();
  const [group, setGroup] = useState<TokenGroup>('color');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const textStyles = tokens.filter((t) => t.group === 'text');
  const [basedOn, setBasedOn] = useState('');
  const spec = GROUPS.find((g) => g.group === group)!;
  const create = async () => {
    const base = textStyles.find((t) => t.id === (basedOn || textStyles[0]?.id));
    const v = group === 'text' ? structuredClone(base?.value) : value.trim();
    if (!label.trim() || !v) return;
    if (await applyOps([{ type: 'token.create', group, label: label.trim(), value: v }], `Add ${label.trim()}`)) {
      setLabel('');
      setValue('');
    }
  };
  return (
    <form
      className="ss-new-style col"
      style={{ gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
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
          <span className="row" style={{ gap: 6 }}>
            {group === 'color' && <ColorPick className="md" value={value} onPick={setValue} label="Pick a colour" />}
            <input id={`${uid}-value`} className="input sm mono grow" value={value} placeholder={spec.placeholder} onChange={(e) => setValue(e.target.value)} />
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

function StyleRow({ t, uses, tokens, state, onEditText }: { t: TokenDef; uses: number; tokens: TokenDef[]; state: ProjectState; onEditText: (id: string) => void }) {
  const uid = useId();
  const [removing, setRemoving] = useState(false);
  const [choice, setChoice] = useState('');
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
  const ref = linkOf(t.value);
  const follows = ref ? (tokens.find((x) => x.id === ref)?.label ?? ref) : null;
  // The value in effect, a style it follows already followed: what a link shows, and what unlinking keeps.
  const resolved = followToken(tokens, t.id);
  const literal = typeof resolved === 'string' ? resolved : '';
  /** A picker's changes merge with each other, never with a typed value: undo returns to what was typed. */
  const set = (value: unknown, by?: 'picker') => applyOps([{ type: 'token.set', tokenId: t.id, value }], `Change ${t.label}`, by ? `token:${t.id}:${by}` : `token:${t.id}`);
  const remove = async () => {
    if (!uses) return void applyOps([{ type: 'token.remove', tokenId: t.id }], `Remove ${t.label}`);
    if (!replacement) return;
    await applyOps([{ type: 'token.remove', tokenId: t.id, ...(replacement === '__keep' ? { detach: true } : { replacementTokenId: replacement }) }], `Remove ${t.label}`);
  };
  const spec = GROUPS.find((g) => g.group === t.group);
  let value: React.ReactNode;
  if (t.group === 'text') {
    const v = resolved && typeof resolved === 'object' && 'size' in resolved ? (resolved as TextStyleValue) : null;
    const famRef = linkOf(v?.family);
    const stack = famRef ? String(followToken(tokens, famRef) ?? '') : String(v?.family ?? '');
    value = (
      <div className="row" style={{ gap: 8 }}>
        <span className="grow" style={{ fontFamily: stack || undefined, fontWeight: v?.weight, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {famRef ? (tokens.find((x) => x.id === famRef)?.label ?? famRef) : familyName(stack)}
          {v && <span className="faint"> · {v.weight}</span>}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => onEditText(t.id)}>
          Edit text style<span className="sr-only"> {t.label}</span>
        </button>
      </div>
    );
  } else {
    const own =
      t.group === 'font' ? (
        <FontSelect id={`${uid}-value`} state={state} stack={literal} onChoose={(next) => set(next)} />
      ) : (
        <DraftInput id={`${uid}-value`} className="input sm mono" value={literal} placeholder={spec?.placeholder} onCommit={(v) => (v.trim() ? set(v.trim()) : false)} />
      );
    value = (
      <div className="grid-2">
        <Field label="Value" controlId={ref ? undefined : `${uid}-value`}>
          {ref ? (
            <span className="mono faint" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }} title={literal}>
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
              if (e.target.value) void set({ token: e.target.value });
              else if (literal) void set(literal);
            }}
          >
            <option value="">{OWN[t.group] ?? 'Its own value'}</option>
            {ref && !others.some((o) => o.id === ref) && <option value={ref}>{follows}</option>}
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    );
  }
  return (
    <div className="ss-custom-row" data-ss-row data-token-id={t.id} style={{ display: 'grid', gap: 6, paddingBlock: 6, borderBottom: '1px solid var(--line, #e5e5e5)' }}>
      <div className="row" style={{ gap: 8 }}>
        {t.group === 'color' && <ColorPick className="sm" value={literal} disabled={!!ref} onPick={(next) => set(next, 'picker')} label={`${t.label} color`} />}
        <DraftInput className="input sm grow" value={t.label} onCommit={(v) => (v.trim() ? void applyOps([{ type: 'token.rename', tokenId: t.id, label: v.trim() }], `Rename ${t.label}`) : false)} ariaLabel={`${t.label} name`} />
        <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${t.label}`} aria-expanded={removing} onClick={() => (uses ? setRemoving(!removing) : void remove())}>
          <Trash2 />
        </button>
      </div>
      <div className="row faint" style={{ gap: 8, fontSize: 12 }}>
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
        <div className="col" style={{ gap: 6 }} role="group" aria-label={`Remove ${t.label}`}>
          <Field label={`${times(uses)}. Where it is used:`} controlId={`${uid}-repl`}>
            <select id={`${uid}-repl`} className="select sm" value={replacement} onChange={(e) => setChoice(e.target.value)}>
              {t.group !== 'text' && <option value="__keep">Keep its current value there</option>}
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  Use {o.label} instead
                </option>
              ))}
            </select>
          </Field>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm btn-danger" disabled={!replacement} onClick={() => void remove()}>
              Remove {t.label}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** `onEditText` opens a text style in the Text styles list, where all of its metrics are edited. */
export function CustomTokens({ state, onEditText }: { state: ProjectState; onEditText: (id: string) => void }) {
  const tokens = useMemo(() => effectiveTokens(state), [state]);
  const uses = useMemo(() => tokenUsageCounts(state), [state]);
  const custom = tokens.filter((t) => state.tokens.custom.some((c) => c.id === t.id));
  return (
    <div className="col ss-custom" style={{ gap: 10 }}>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        Your own colours, sizes and text styles, alongside the theme's. Link elements to them like any site style.
      </p>
      {custom.length ? custom.map((t) => <StyleRow key={t.id} t={t} uses={uses[t.id] ?? 0} tokens={tokens} state={state} onEditText={onEditText} />) : <p className="ss-none">No styles of your own yet.</p>}
      <NewStyle tokens={tokens} />
    </div>
  );
}
