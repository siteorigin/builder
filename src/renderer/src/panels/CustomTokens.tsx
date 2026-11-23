import { useId, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProjectState, TokenDef, TokenGroup } from '@shared/types';
import { effectiveTokens } from '@generator/index';
import { tokenUsageCounts } from '@engine/tokens';
import { applyOps } from '../store';
import { DraftInput, Field } from '../components/ui';

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
            {group === 'color' && <input type="color" aria-label="Pick a colour" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => setValue(e.target.value)} />}
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

function StyleRow({ t, uses, tokens }: { t: TokenDef; uses: number; tokens: TokenDef[] }) {
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
  const shown = isRef(t.value) ? `Same as ${tokens.find((x) => x.id === (t.value as { token: string }).token)?.label ?? (t.value as { token: string }).token}` : typeof t.value === 'string' ? t.value : '';
  const remove = async () => {
    if (!uses) return void applyOps([{ type: 'token.remove', tokenId: t.id }], `Remove ${t.label}`);
    if (!replacement) return;
    await applyOps([{ type: 'token.remove', tokenId: t.id, ...(replacement === '__keep' ? { detach: true } : { replacementTokenId: replacement }) }], `Remove ${t.label}`);
  };
  return (
    <div className="ss-custom-row" data-ss-row style={{ display: 'grid', gap: 6, paddingBlock: 6, borderBottom: '1px solid var(--line, #e5e5e5)' }}>
      <div className="row" style={{ gap: 8 }}>
        {t.group === 'color' && typeof t.value === 'string' && <span className="ss-swatch" aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 4, background: t.value, flex: 'none' }} />}
        <DraftInput className="input sm grow" value={t.label} onCommit={(v) => (v.trim() ? void applyOps([{ type: 'token.rename', tokenId: t.id, label: v.trim() }], `Rename ${t.label}`) : false)} ariaLabel={`${t.label} name`} />
        <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${t.label}`} aria-expanded={removing} onClick={() => (uses ? setRemoving(!removing) : void remove())}>
          <Trash2 />
        </button>
      </div>
      <div className="row faint" style={{ gap: 8, fontSize: 12 }}>
        <span>{groupLabel(t.group)}</span>
        <span aria-hidden="true">·</span>
        <span className="ss-custom-uses">{times(uses)}</span>
        <span className="mono grow" style={{ textAlign: 'end', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={shown}>
          {t.group !== 'text' && !isRef(t.value) ? (
            <DraftInput className="input sm mono" value={shown} onCommit={(v) => (v.trim() ? void applyOps([{ type: 'token.set', tokenId: t.id, value: v.trim() }], `Change ${t.label}`, `token:${t.id}`) : false)} ariaLabel={`${t.label} value`} />
          ) : (
            shown
          )}
        </span>
      </div>
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

export function CustomTokens({ state }: { state: ProjectState }) {
  const tokens = useMemo(() => effectiveTokens(state), [state]);
  const uses = useMemo(() => tokenUsageCounts(state), [state]);
  const custom = tokens.filter((t) => state.tokens.custom.some((c) => c.id === t.id));
  return (
    <div className="col ss-custom" style={{ gap: 10 }}>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        Your own colours, sizes and text styles, alongside the theme's. Link elements to them like any site style.
      </p>
      {custom.length ? custom.map((t) => <StyleRow key={t.id} t={t} uses={uses[t.id] ?? 0} tokens={tokens} />) : <p className="ss-none">No styles of your own yet.</p>}
      <NewStyle tokens={tokens} />
    </div>
  );
}
