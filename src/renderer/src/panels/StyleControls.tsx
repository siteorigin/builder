import { useState } from 'react';
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
          Change for {current} only
        </button>
      ) : scope !== 'base' ? (
        <span className="field-hint">
          Changes here apply only on {scope} screens ({scope === 'phone' ? 'narrower than 768px' : scope === 'tablet' ? '768 to 1023px' : '1024px and wider'}).
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
  onReset,
  resetLabel = 'Reset all style changes'
}: {
  styles: ResponsiveStyles | undefined;
  inherited: ResponsiveStyles | undefined;
  allowed?: string[];
  tokens: TokenDef[];
  onSet: (prop: string, value: StyleValue | null) => void;
  onReset?: () => void;
  resetLabel?: string;
}) {
  const scope = useStore((s) => s.styleScope);
  const [showAll, setShowAll] = useState(false);
  const props = allowed?.length ? allowed.map((id) => STYLE_PROP_MAP[id]).filter(Boolean) : STYLE_PROPS;
  const groups = new Map<StylePropDef['group'], StylePropDef[]>();
  for (const p of props) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const own = styles?.[scope] ?? {};
  const anyOverride = Object.values(styles ?? {}).some((s) => s && Object.keys(s).length);
  // Layout controls that only mean something for a stack or grid are shown when the layout is one.
  const effective = (id: string) => own[id] ?? styles?.base?.[id] ?? inherited?.[scope]?.[id] ?? inherited?.base?.[id];
  const layout = effective('layout');
  const relevant = (id: string) => {
    if (own[id] !== undefined) return true;
    if (id === 'order') return false;
    if (id === 'columns') return layout === 'grid';
    if (id === 'align' || id === 'justify' || id === 'gap' || id === 'wrap') return layout === 'stack' || layout === 'row' || layout === 'grid';
    return true;
  };
  // Long lists show the first two groups plus anything already set; the rest sit behind one disclosure.
  const entries = [...groups.entries()];
  const long = entries.reduce((n, [, l]) => n + l.length, 0) > 10;
  const primary = new Set(entries.slice(0, 2).map(([g]) => g));
  const visible = (g: StylePropDef['group'], id: string) => showAll || !long || primary.has(g) || own[id] !== undefined;
  const hiddenCount = long && !showAll ? entries.reduce((n, [g, l]) => n + l.filter((p) => relevant(p.id) && !visible(g, p.id)).length, 0) : 0;
  return (
    <div className="col" style={{ gap: 14 }}>
      {entries.filter(([g, list]) => list.some((p) => relevant(p.id) && visible(g, p.id))).map(([g, list]) => (
        <div key={g} className="col" style={{ gap: 6 }}>
          <div className="field-label">{STYLE_GROUP_LABELS[g]}</div>
          {list.filter((p) => relevant(p.id) && visible(g, p.id)).map((p) => {
            const value = own[p.id];
            const inheritedValue = scope !== 'base' ? (styles?.base?.[p.id] ?? inherited?.[scope]?.[p.id] ?? inherited?.base?.[p.id]) : (inherited?.base?.[p.id]);
            return (
              <div className={`style-row${value !== undefined ? ' set' : ''}`} key={p.id}>
                {/* Not a <label>: the reset button beside the name must never be the target of a click on the name.
                    Each control carries its own accessible name. */}
                <div className="style-label" title={p.description ?? p.label}>
                  <span>{p.label}</span>
                  {value !== undefined && (
                    <button className="reset-dot" title="Changed here. Click to reset to the default." aria-label={`Reset ${p.label} to default`} onClick={() => onSet(p.id, null)}>
                      <RotateCcw />
                    </button>
                  )}
                </div>
                <div className="style-control">
                  <Control def={p} value={value} placeholder={fmt(inheritedValue, tokens)} tokens={tokens} onSet={(v) => onSet(p.id, v)} />
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {hiddenCount > 0 && (
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} aria-expanded={false} onClick={() => setShowAll(true)}>
          More style options ({hiddenCount})
        </button>
      )}
      {long && showAll && (
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} aria-expanded={true} onClick={() => setShowAll(false)}>
          Fewer style options
        </button>
      )}
      {/* The bulk reset clears every screen size, so it is offered only under All sizes, never while a
          single range (Phone, Tablet, Desktop) is showing. */}
      {onReset && anyOverride && scope === 'base' && (
        <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onReset}>
          <RotateCcw /> {resetLabel}
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
  const cls = `select sm grow${value !== undefined ? ' overridden' : ' inherit'}`;
  if (def.kind === 'boolean') {
    return (
      <select className={cls} value={value === undefined ? '' : String(value)} onChange={(e) => onSet(e.target.value === '' ? null : e.target.value === 'true')} aria-label={def.label}>
        <option value="">{placeholder ? `${placeholder === 'true' ? 'Yes' : 'No'} · default` : 'Default'}</option>
        <option value="true">{def.id === 'hidden' ? 'Hidden' : 'Yes'}</option>
        <option value="false">{def.id === 'hidden' ? 'Visible' : 'No'}</option>
      </select>
    );
  }
  if (def.kind === 'enum' || def.kind === 'ratio') {
    return (
      <select className={cls} value={value === undefined ? '' : String(value)} onChange={(e) => onSet(e.target.value === '' ? null : e.target.value)} aria-label={def.label}>
        <option value="">{placeholder ? `${def.options?.find((o) => o.value === placeholder)?.label ?? placeholder} · default` : 'Default'}</option>
        {value !== undefined && !def.options!.some((o) => o.value === String(value)) && <option value={String(value)}>{String(value)}</option>}
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
        className={`input sm grow${value !== undefined ? ' overridden' : ' inherit'}`}
        value={value === undefined ? '' : String(value)}
        placeholder={placeholder ? `${placeholder} · default` : 'Default'}
        ariaLabel={def.label}
        onCommit={(t) => onSet(t.trim() === '' ? null : Number(t))}
      />
    );
  }
  // Token-capable values: a token picker plus an optional custom value.
  const selectValue = value === undefined ? '' : isToken ? `token:${(value as { token: string }).token}` : def.options?.some((o) => o.value === String(value)) ? String(value) : 'custom';
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
        <option value="">{placeholder ? `${placeholder} · default` : 'Default'}</option>
        {def.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {tokOpts.length > 0 && (
          <optgroup label="Site styles">
            {tokOpts.map((t) => (
              <option key={t.id} value={`token:${t.id}`}>
                {t.label}
                {def.kind === 'length' && typeof t.value === 'string' && t.value.length < 14 ? ` · ${t.value}` : ''}
              </option>
            ))}
          </optgroup>
        )}
        {selectValue.startsWith('token:') && !tokOpts.some((t) => `token:${t.id}` === selectValue) && <option value={selectValue}>{tokenLabel(tokens, selectValue.slice(6))}</option>}
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
