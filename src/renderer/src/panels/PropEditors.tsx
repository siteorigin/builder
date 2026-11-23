import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, ImageOff, ImagePlus, Plus, Trash2 } from 'lucide-react';
import type { ImageValue, LinkValue, ListItem, ListProp, ProjectState, PropSchema, ScalarPropSchema } from '@shared/types';
import { ICONS } from '@catalogue/foundation/icons';
import { api, useStore } from '../store';
import { DraftInput, Field, Switch, useMenu, SwitchRow } from '../components/ui';
import { assetUrl } from '../lib/model';

export function LinkEditor({ value, onChange, state }: { value: LinkValue; onChange: (v: LinkValue) => void; state: ProjectState }) {
  const v = value ?? { type: 'none', target: '' };
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <select className="select sm" style={{ width: 110 }} value={v.type} aria-label="Link type" onChange={(e) => {
          const type = e.target.value as LinkValue['type'];
          onChange({ type, target: type === 'page' ? state.site.homePageId : '', newTab: v.newTab });
        }}>
          <option value="none">No link</option>
          <option value="page">Page</option>
          <option value="url">Web address</option>
          <option value="email">Email</option>
          <option value="tel">Phone</option>
          <option value="anchor">Section anchor</option>
        </select>
        {v.type === 'page' ? (
          <select className="select sm grow" value={v.target} aria-label="Page" onChange={(e) => onChange({ ...v, target: e.target.value })}>
            {state.site.pageOrder.map((id) => (
              <option key={id} value={id}>
                {state.pages[id].title} ({state.pages[id].route})
              </option>
            ))}
          </select>
        ) : v.type !== 'none' ? (
          <DraftInput
            className="input sm grow"
            value={v.target}
            ariaLabel="Link destination"
            placeholder={v.type === 'url' ? 'https://example.com' : v.type === 'email' ? 'hello@example.com' : v.type === 'tel' ? '+1 555 0100' : 'section-id'}
            onCommit={(t) => onChange({ ...v, target: t.trim() })}
          />
        ) : null}
      </div>
      {v.type !== 'none' && (
        <SwitchRow checked={!!v.newTab} onChange={(n) => onChange({ ...v, newTab: n })} label="Open in a new tab" />
      )}
    </div>
  );
}

export function ImageEditor({ value, onChange, state }: { value: ImageValue; onChange: (v: ImageValue) => void; state: ProjectState }) {
  const runtime = useStore((s) => s.runtime);
  const menu = useMenu();
  const v = value ?? { assetId: null, alt: '' };
  const asset = v.assetId ? state.assets.assets[v.assetId] : null;
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const choose = (el: HTMLElement) =>
    menu.openAt(el, [
      { label: 'Import new image…', icon: <ImagePlus />, onSelect: async () => {
        const r = await api.project.importAssets();
        const id = r.assetIds[0];
        if (id) {
          const a = useStore.getState().snapshot?.state.assets.assets[id];
          onChange({ assetId: id, alt: v.alt || a?.altSuggestion || '' });
        }
      } },
      ...(Object.values(state.assets.assets).length ? [{ separator: true }] : []),
      ...Object.values(state.assets.assets).map((a) => ({ label: a.name, onSelect: () => onChange({ assetId: a.id, alt: v.alt || a.altSuggestion || '', decorative: v.decorative }) })),
      ...(v.assetId ? [{ separator: true }, { label: 'Remove image', icon: <ImageOff />, onSelect: () => onChange({ assetId: null, alt: v.alt }) }] : [])
    ]);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="image-picker">
        <div className="thumb">{asset && devUrl ? <img src={assetUrl(devUrl, asset.file)!} alt="" /> : <ImageOff />}</div>
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span className="ellipsis" style={{ fontSize: 12 }}>{asset ? asset.name : 'No image chosen'}</span>
          <button className="btn btn-sm" aria-haspopup="menu" style={{ alignSelf: 'flex-start' }} onClick={(e) => choose(e.currentTarget)}>
            {asset ? 'Change…' : 'Choose image…'}
          </button>
        </div>
      </div>
      {!v.decorative && <DraftInput className="input sm" value={v.alt} placeholder="Describe the image for screen readers" ariaLabel="Alt text" onCommit={(alt) => onChange({ ...v, alt })} />}
      <SwitchRow checked={!!v.decorative} onChange={(d) => onChange({ ...v, decorative: d })} label="Decorative" hint="No description needed; screen readers skip it." />
      {menu.node}
    </div>
  );
}

export function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="select sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Icon">
      {Object.keys(ICONS).map((k) => (
        <option key={k} value={k}>
          {k.replace(/-/g, ' ')}
        </option>
      ))}
    </select>
  );
}

export function ScalarEditor({ schema, value, onChange, state }: { schema: ScalarPropSchema; value: unknown; onChange: (v: unknown) => void; state: ProjectState }) {
  switch (schema.type) {
    case 'string':
      return <DraftInput multiline={schema.multiline} rows={2} value={String(value ?? '')} onCommit={onChange} ariaLabel={schema.label} />;
    case 'richtext':
      return (
        <DraftInput
          multiline
          rows={4}
          value={(Array.isArray(value) ? value : []).join('\n\n')}
          onCommit={(t) => onChange(t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean))}
          ariaLabel={schema.label}
          placeholder="Separate paragraphs with a blank line. Use **bold** and *italic*."
        />
      );
    case 'number':
      return <DraftInput value={String(value ?? schema.default)} onCommit={(t) => onChange(Number(t))} ariaLabel={schema.label} />;
    case 'boolean':
      return <Switch checked={!!value} onChange={onChange} label={schema.label} />;
    case 'enum':
      return (
        <select className="select" value={String(value ?? schema.default)} onChange={(e) => onChange(e.target.value)} aria-label={schema.label}>
          {schema.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'link':
      return <LinkEditor value={value as LinkValue} onChange={onChange} state={state} />;
    case 'image':
      return <ImageEditor value={value as ImageValue} onChange={onChange} state={state} />;
    case 'icon':
      return <IconPicker value={String(value ?? schema.default)} onChange={onChange} />;
  }
}

export function PropField({ name, schema, value, onChange, onList, state, focusItem }: {
  name: string;
  schema: PropSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  onList: (op: { kind: 'insert' } | { kind: 'remove'; itemId: string } | { kind: 'move'; itemId: string; index: number } | { kind: 'field'; itemId: string; field: string; value: unknown }) => void;
  state: ProjectState;
  focusItem?: string;
}) {
  if (schema.type === 'list') return <ListEditor schema={schema} items={(value as ListItem[]) ?? []} onList={onList} state={state} focusItem={focusItem} />;
  if (schema.type === 'boolean')
    return (
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="field-label">{schema.label}</span>
        <ScalarEditor schema={schema} value={value} onChange={onChange} state={state} />
      </div>
    );
  return (
    <Field label={schema.label} hint={schema.description}>
      <ScalarEditor schema={schema} value={value} onChange={onChange} state={state} />
    </Field>
  );
  void name;
}

function ListEditor({ schema, items, onList, state, focusItem }: { schema: ListProp; items: ListItem[]; onList: (op: never) => void; state: ProjectState; focusItem?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const openId = focusItem ?? open;
  const titleOf = (it: ListItem, i: number) => {
    const t = schema.titleField ? it[schema.titleField] : Object.values(it).find((v) => typeof v === 'string' && v && v !== it.id);
    return (typeof t === 'string' && t) || `${schema.itemLabel} ${i + 1}`;
  };
  const L = onList as (op: unknown) => void;
  return (
    <div className="field">
      <label>
        <span className="grow">{schema.label}</span>
        <span className="faint">{items.length}</span>
      </label>
      <div className="list-editor">
        {items.map((it, i) => (
          <div key={it.id} className={`list-editor-item${focusItem === it.id ? ' focused' : ''}`}>
            <div className="list-editor-head">
              <ChevronRight size={12} className="faint" style={{ transform: openId === it.id ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
              <button className="title" onClick={() => setOpen(open === it.id ? null : it.id)}>
                {titleOf(it, i)}
              </button>
              <button className="icon-btn sm" aria-label="Move up" disabled={i === 0} onClick={() => L({ kind: 'move', itemId: it.id, index: i - 1 })}>
                <ArrowUp />
              </button>
              <button className="icon-btn sm" aria-label="Move down" disabled={i === items.length - 1} onClick={() => L({ kind: 'move', itemId: it.id, index: i + 1 })}>
                <ArrowDown />
              </button>
              <button className="icon-btn sm" aria-label={`Remove ${schema.itemLabel}`} disabled={schema.min !== undefined && items.length <= schema.min} onClick={() => L({ kind: 'remove', itemId: it.id })}>
                <Trash2 />
              </button>
            </div>
            {openId === it.id && (
              <div className="list-editor-body">
                {Object.entries(schema.fields).map(([f, fs]) => (
                  <Field key={f} label={fs.type === 'boolean' ? undefined : fs.label}>
                    <ScalarEditor schema={fs} value={it[f]} onChange={(v) => L({ kind: 'field', itemId: it.id, field: f, value: v })} state={state} />
                  </Field>
                ))}
              </div>
            )}
          </div>
        ))}
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} disabled={schema.max !== undefined && items.length >= schema.max} onClick={() => L({ kind: 'insert' })}>
          <Plus /> Add {schema.itemLabel.toLowerCase()}
        </button>
      </div>
    </div>
  );
}
