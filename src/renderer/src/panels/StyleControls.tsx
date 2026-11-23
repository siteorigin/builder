import { RotateCcw } from 'lucide-react';
import type { ResponsiveScope, ResponsiveStyles, StyleValue, TokenDef } from '@shared/types';
import { STYLE_GROUP_LABELS, STYLE_PROPS, STYLE_PROP_MAP, type StylePropDef } from '@shared/styles';
import { DraftInput, Segmented } from '../components/ui';
import { setState, useStore } from '../store';

const tokenLabel = (tokens: TokenDef[], id: string) => tokens.find((t) => t.id === id)?.label ?? id;

function fmt(v: StyleValue | undefined, tokens: TokenDef[]): string {
  if (v === undefined) return '';
  if (typeof v === 'object') return tokenLabel(tokens, v.token);
  return String(v);
}

export function ScopePicker() {
  const scope = useStore((s) => s.styleScope);
  const viewport = useStore((s) => s.viewport);
  const current = viewport < 768 ? 'phone' : viewport < 1024 ? 'tablet' : 'desktop';
  return (
    <div className="col" style={{ gap: 6 }}>
      <Segmented<ResponsiveScope>
        full
        label="Style scope"
        value={scope}
        onChange={(v) => setState({ styleScope: v })}
        options={[
          { value: 'base', label: 'All sizes' },
          { value: 'phone', label: 'Phone' },
          { value: 'tablet', label: 'Tablet' },
          { value: 'desktop', label: 'Desktop' }
        ]}
      />
      {scope === 'base' && current !== 'desktop' ? (
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setState({ styleScope: current })}>
          Override at this size ({current})
        </button>
      ) : scope !== 'base' ? (
        <span className="field-hint">
          Changes apply only to {scope} widths ({scope === 'phone' ? 'below 768px' : scope === 'tablet' ? '768–1023px' : '1024px and wider'}).
        </span>
      ) : null}
    </div>
  );
}

export function StyleControls({
  styles,
  inherited,
  allowed,
  tokens,
  onSet,
  onReset
}: {
  styles: ResponsiveStyles | undefined;
  inherited: ResponsiveStyles | undefined;
  allowed?: string[];
  tokens: TokenDef[];
  onSet: (prop: string, value: StyleValue | null) => void;
  onReset?: () => void;
}) {
  const scope = useStore((s) => s.styleScope);
  const props = allowed?.length ? allowed.map((id) => STYLE_PROP_MAP[id]).filter(Boolean) : STYLE_PROPS;
  const groups = new Map<StylePropDef['group'], StylePropDef[]>();
  for (const p of props) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const own = styles?.[scope] ?? {};
  const anyOverride = Object.values(styles ?? {}).some((s) => s && Object.keys(s).length);
  return (
    <div className="col" style={{ gap: 14 }}>
      {[...groups.entries()].map(([g, list]) => (
        <div key={g} className="col" style={{ gap: 6 }}>
          <div className="field-label">{STYLE_GROUP_LABELS[g]}</div>
          {list.map((p) => {
            const value = own[p.id];
            const inheritedValue = scope !== 'base' ? (styles?.base?.[p.id] ?? inherited?.[scope]?.[p.id] ?? inherited?.base?.[p.id]) : (inherited?.base?.[p.id]);
            return (
              <div className="style-row" key={p.id}>
                <label title={p.description ?? p.label}>
                  {value !== undefined && <span className="ovr-dot" title="Overridden here" />}
                  {p.label}
                </label>
                <div className="style-control">
                  <Control def={p} value={value} placeholder={fmt(inheritedValue, tokens)} tokens={tokens} onSet={(v) => onSet(p.id, v)} />
                </div>
                <button className="icon-btn sm reset" title="Reset to inherited value" aria-label={`Reset ${p.label}`} disabled={value === undefined} onClick={() => onSet(p.id, null)}>
                  <RotateCcw />
                </button>
              </div>
            );
          })}
        </div>
      ))}
      {onReset && anyOverride && (
        <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onReset}>
          <RotateCcw /> Reset all overrides
        </button>
      )}
    </div>
  );
}

function tokenOptions(tokens: TokenDef[], group: StylePropDef['tokenGroup']) {
  const groups = Array.isArray(group) ? group : group ? [group] : [];
  return tokens.filter((t) => groups.includes(t.group));
}

function colorOf(tokens: TokenDef[], id: string, depth = 0): string {
  const t = tokens.find((x) => x.id === id);
  if (!t) return 'transparent';
  if (typeof t.value === 'object' && 'token' in t.value && depth < 5) return colorOf(tokens, (t.value as { token: string }).token, depth + 1);
  return String(t.value);
}

function Control({ def, value, placeholder, tokens, onSet }: { def: StylePropDef; value: StyleValue | undefined; placeholder: string; tokens: TokenDef[]; onSet: (v: StyleValue | null) => void }) {
  const tokOpts = tokenOptions(tokens, def.tokenGroup);
  const isToken = typeof value === 'object' && value !== null;
  const cls = `select sm grow${value !== undefined ? ' overridden' : ''}`;
  if (def.kind === 'boolean') {
    return (
      <select className={cls} value={value === undefined ? '' : String(value)} onChange={(e) => onSet(e.target.value === '' ? null : e.target.value === 'true')} aria-label={def.label}>
        <option value="">{placeholder ? `Inherit (${placeholder === 'true' ? 'yes' : 'no'})` : 'Inherit'}</option>
        <option value="true">{def.id === 'hidden' ? 'Hidden' : 'Yes'}</option>
        <option value="false">{def.id === 'hidden' ? 'Visible' : 'No'}</option>
      </select>
    );
  }
  if (def.kind === 'enum' || def.kind === 'ratio') {
    return (
      <select className={cls} value={value === undefined ? '' : String(value)} onChange={(e) => onSet(e.target.value === '' ? null : e.target.value)} aria-label={def.label}>
        <option value="">{placeholder ? `Inherit (${def.options?.find((o) => o.value === placeholder)?.label ?? placeholder})` : 'Inherit'}</option>
        {def.options!.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (def.kind === 'number') {
    return (
      <DraftInput
        className={`input sm grow${value !== undefined ? ' overridden' : ''}`}
        value={value === undefined ? '' : String(value)}
        placeholder={placeholder || 'Inherit'}
        ariaLabel={def.label}
        onCommit={(t) => onSet(t.trim() === '' ? null : Number(t))}
      />
    );
  }
  // Token-capable values: a token picker plus an optional custom value.
  const selectValue = value === undefined ? '' : isToken ? `token:${(value as { token: string }).token}` : 'custom';
  return (
    <>
      <select
        className={cls}
        value={selectValue}
        aria-label={def.label}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') onSet(null);
          else if (v === 'custom') onSet(def.kind === 'color' ? '#000000' : def.options?.[0]?.value ?? (def.placeholder || '0'));
          else if (v.startsWith('token:')) onSet({ token: v.slice(6) });
          else onSet(v);
        }}
        style={{ flex: selectValue === 'custom' ? '0 0 48%' : 1 }}
      >
        <option value="">{placeholder ? `Inherit (${placeholder})` : 'Inherit'}</option>
        {def.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {tokOpts.length > 0 && (
          <optgroup label="Site tokens">
            {tokOpts.map((t) => (
              <option key={t.id} value={`token:${t.id}`}>
                {t.label}
                {def.kind === 'length' && typeof t.value === 'string' && t.value.length < 14 ? ` · ${t.value}` : ''}
              </option>
            ))}
          </optgroup>
        )}
        {def.kind !== 'textStyle' && <option value="custom">Custom value…</option>}
      </select>
      {selectValue === 'custom' &&
        (def.kind === 'color' ? (
          <span className="color-input">
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#000000'} onChange={(e) => onSet(e.target.value)} aria-label={`${def.label} color`} />
            <DraftInput className="input sm grow" value={String(value)} onCommit={(t) => onSet(t.trim() || null)} ariaLabel={`${def.label} value`} />
          </span>
        ) : (
          <DraftInput className="input sm grow overridden" value={String(value)} placeholder={def.placeholder} onCommit={(t) => onSet(t.trim() || null)} ariaLabel={`${def.label} value`} />
        ))}
      {isToken && def.kind === 'color' && <span className="swatch-lg" style={{ width: 18, height: 18, alignSelf: 'center', background: colorOf(tokens, (value as { token: string }).token) }} />}
    </>
  );
}
