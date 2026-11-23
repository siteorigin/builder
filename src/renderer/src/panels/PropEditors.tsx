import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, ImageOff, ImagePlus, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { ImageValue, LinkValue, ListItem, ListProp, ProjectState, PropSchema, ScalarPropSchema } from '@shared/types';
import { ICONS } from '@catalogue/foundation/icons';
import { api, useStore } from '../store';
import { DraftInput, Field, Switch, useMenu, SwitchRow } from '../components/ui';
import { assetUrl } from '../lib/model';

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Link editor: what kind of destination, then the destination itself. `label` names the field it belongs to
 * ("Primary button"), so each control has a name that still makes sense out of context.
 */
export function LinkEditor({ value, onChange, state, label }: { value: LinkValue; onChange: (v: LinkValue) => void; state: ProjectState; label?: string }) {
  const v = value ?? { type: 'none', target: '' };
  const base = label?.replace(/ link$/i, '');
  const named = (what: string) => (base && base.toLowerCase() !== 'link' ? `${base} ${what.toLowerCase()}` : what);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="insp-link-row">
        <select className={`select sm${v.type === 'none' ? ' grow' : ' insp-link-type'}`} value={v.type} aria-label={named('Link type')} onChange={(e) => {
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
          <select className="select sm grow" value={v.target} aria-label={named('Page')} onChange={(e) => onChange({ ...v, target: e.target.value })}>
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
            ariaLabel={named(v.type === 'url' ? 'Web address' : v.type === 'email' ? 'Email address' : v.type === 'tel' ? 'Phone number' : 'Anchor')}
            placeholder={v.type === 'url' ? 'https://example.com' : v.type === 'email' ? 'hello@example.com' : v.type === 'tel' ? '+1 555 0100' : 'section-id'}
            onCommit={(t) => onChange({ ...v, target: t.trim() })}
          />
        ) : null}
      </div>
      {/* A new tab only means something for pages and web addresses; mail and phone links open their own apps. */}
      {(v.type === 'page' || v.type === 'url') && <SwitchRow checked={!!v.newTab} onChange={(n) => onChange({ ...v, newTab: n })} label="Open in a new tab" />}
    </div>
  );
}

/**
 * Image editor: one card holding the picture, its description and whether it is decorative. `title` puts the
 * field's name inside the card (like the other field groups); a standalone image passes none.
 */
export function ImageEditor({ value, onChange, state, title }: { value: ImageValue; onChange: (v: ImageValue) => void; state: ProjectState; title?: string }) {
  const runtime = useStore((s) => s.runtime);
  const menu = useMenu();
  const altId = useId();
  const titleId = useId();
  // A description carried over from the previous image may no longer be true; say so until it is edited.
  const [carried, setCarried] = useState(false);
  const v = value ?? { assetId: null, alt: '' };
  const asset = v.assetId ? state.assets.assets[v.assetId] : null;
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const pick = (id: string, suggestion?: string) => {
    if (id === v.assetId) return;
    const keep = !suggestion && !!v.alt && !!v.assetId;
    setCarried(keep);
    onChange({ assetId: id, alt: suggestion || v.alt || '', decorative: v.decorative });
  };
  const choose = (el: HTMLElement) =>
    menu.openAt(el, [
      { label: 'Import new image…', icon: <ImagePlus />, onSelect: async () => {
        const r = await api.project.importAssets();
        const id = r.assetIds[0];
        if (id) pick(id, useStore.getState().snapshot?.state.assets.assets[id]?.altSuggestion);
      } },
      ...(Object.values(state.assets.assets).length ? [{ separator: true }] : []),
      ...(Object.values(state.assets.assets).length ? [{ heading: 'Your images' }] : []),
      ...Object.values(state.assets.assets).map((a) => ({
        label: a.name,
        checked: a.id === v.assetId,
        icon: devUrl ? <img className="menu-thumb" src={assetUrl(devUrl, a.file)!} alt="" /> : undefined,
        onSelect: () => pick(a.id, a.altSuggestion)
      })),
      ...(v.assetId ? [{ separator: true }, { label: 'Remove image', icon: <ImageOff />, onSelect: () => onChange({ assetId: null, alt: v.alt, decorative: v.decorative }) }] : [])
    ], title ? `${title} options` : 'Image options');
  // Until there is an image (or something already set about it), the chooser is the only thing to do.
  const details = !!asset || !!v.alt || !!v.decorative;
  return (
    <div className="insp-image" role={title ? 'group' : undefined} aria-labelledby={title ? titleId : undefined}>
      {title && (
        <div className="insp-group-title" id={titleId}>
          {title}
        </div>
      )}
      <div className="insp-image-top">
        <div className={`insp-image-thumb${asset ? '' : ' empty'}`}>{asset && devUrl ? <img src={assetUrl(devUrl, asset.file)!} alt="" /> : <ImageOff aria-hidden="true" />}</div>
        <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
          <span className={`ellipsis insp-image-name${asset ? '' : ' none'}`} title={asset?.name}>{asset ? asset.name : 'No image chosen'}</span>
          <button className="btn btn-sm" aria-haspopup="menu" style={{ alignSelf: 'flex-start' }} onClick={(e) => choose(e.currentTarget)}>
            <ImagePlus />
            {asset ? 'Change…' : 'Choose image…'}
          </button>
        </div>
      </div>
      {details && !v.decorative && (
        <div className="field">
          <label htmlFor={altId}>Image description</label>
          <DraftInput
            id={altId}
            multiline
            rows={2}
            className="textarea insp-alt"
            value={v.alt}
            placeholder="What the image shows"
            aria-describedby={`${altId}-h`}
            onCommit={(alt) => (setCarried(false), onChange({ ...v, alt }))}
          />
          <span className={`field-hint${carried ? ' insp-check' : ''}`} id={`${altId}-h`}>
            {carried && <TriangleAlert aria-hidden="true" />}
            {carried ? 'Kept from the previous image. Check it still describes this one.' : 'For screen readers, and shown if the image can’t load.'}
          </span>
        </div>
      )}
      {details && <SwitchRow checked={!!v.decorative} onChange={(d) => onChange({ ...v, decorative: d })} label="Decorative image" hint={v.decorative ? 'Screen readers skip it, so it needs no description.' : undefined} />}
      {menu.node}
    </div>
  );
}

export function IconPicker({ value, onChange, label = 'Icon', id, describedBy }: { value: string; onChange: (v: string) => void; label?: string; id?: string; describedBy?: string }) {
  return (
    <select className="select" id={id} aria-describedby={describedBy} value={value} onChange={(e) => onChange(e.target.value)} aria-label={id ? undefined : label}>
      {Object.keys(ICONS).map((k) => (
        <option key={k} value={k}>
          {sentence(k.replace(/-/g, ' '))}
        </option>
      ))}
    </select>
  );
}

/**
 * The control for one scalar value. With `id`, a visible <label htmlFor> names it and `describedBy` points at
 * its hint; without, it names itself with aria-label.
 */
export function ScalarEditor({ schema, value, onChange, state, label, id, describedBy }: { schema: ScalarPropSchema; value: unknown; onChange: (v: unknown) => void; state: ProjectState; label?: string; id?: string; describedBy?: string }) {
  const name = id ? undefined : (label ?? schema.label);
  const wired = { id, 'aria-describedby': describedBy };
  switch (schema.type) {
    case 'string':
      return <DraftInput {...wired} multiline={schema.multiline} rows={2} value={String(value ?? '')} onCommit={onChange} ariaLabel={name} />;
    case 'richtext':
      return (
        <DraftInput
          {...wired}
          multiline
          rows={4}
          value={(Array.isArray(value) ? value : []).join('\n\n')}
          onCommit={(t) => onChange(t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean))}
          ariaLabel={name}
          placeholder="Separate paragraphs with a blank line. Use **bold** and *italic*."
        />
      );
    case 'number':
      return <DraftInput {...wired} value={String(value ?? schema.default)} onCommit={(t) => onChange(Number(t))} ariaLabel={name} />;
    case 'boolean':
      return <Switch id={id} describedBy={describedBy} checked={!!value} onChange={onChange} label={name ?? schema.label} />;
    case 'enum':
      return (
        <select className="select" {...wired} value={String(value ?? schema.default)} onChange={(e) => onChange(e.target.value)} aria-label={name}>
          {schema.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'link':
      return <LinkEditor value={value as LinkValue} onChange={onChange} state={state} label={label ?? schema.label} />;
    case 'image':
      return <ImageEditor value={value as ImageValue} onChange={onChange} state={state} title={label ?? schema.label} />;
    case 'icon':
      return <IconPicker id={id} describedBy={describedBy} value={String(value ?? schema.default)} onChange={onChange} label={label ?? schema.label} />;
  }
}

/** One scalar field with its visible label wired to its control. Booleans sit on one line; images are their own titled card. */
export function ScalarField({ schema, value, onChange, state, label }: { schema: ScalarPropSchema; value: unknown; onChange: (v: unknown) => void; state: ProjectState; label?: string }) {
  const id = useId();
  const shown = label ?? schema.label;
  if (schema.type === 'boolean') return <SwitchRow checked={!!value} onChange={onChange} label={shown} hint={schema.description} />;
  if (schema.type === 'image') return <ImageEditor value={value as ImageValue} onChange={onChange} state={state} title={shown} />;
  // A link is two controls (kind and destination) that name themselves; the label names the pair.
  if (schema.type === 'link')
    return (
      <div className="field" role="group" aria-labelledby={`${id}-l`}>
        <div className="field-label" id={`${id}-l`}>
          {shown}
        </div>
        <LinkEditor value={value as LinkValue} onChange={onChange} state={state} label={schema.label} />
        {schema.description && <div className="field-hint">{schema.description}</div>}
      </div>
    );
  return (
    <Field label={shown} hint={schema.description} controlId={id}>
      <ScalarEditor schema={schema} value={value} onChange={onChange} state={state} id={id} describedBy={schema.description ? `${id}-note` : undefined} />
    </Field>
  );
}

export function PropField({ name, schema, value, onChange, onList, state, focusItem, label }: {
  name: string;
  schema: PropSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  onList: (op: { kind: 'insert' } | { kind: 'remove'; itemId: string } | { kind: 'move'; itemId: string; index: number } | { kind: 'field'; itemId: string; field: string; value: unknown }) => void;
  state: ProjectState;
  focusItem?: string;
  /** A shorter visible label, when a group heading already says what the field belongs to. */
  label?: string;
}) {
  if (schema.type === 'list') return <ListEditor name={name} schema={schema} items={(value as ListItem[]) ?? []} onList={onList} state={state} focusItem={focusItem} />;
  return <ScalarField schema={schema} value={value} onChange={onChange} state={state} label={label} />;
  void name;
}

export interface PropGroup<T> {
  /** Heading for fields that belong together ("Primary button"), or none for a field that stands alone. */
  title?: string;
  items: Array<{ key: string; schema: PropSchema | ScalarPropSchema; label?: string; data: T }>;
}

/**
 * Group content fields the way they appear on the page. A schema's own `group` wins; otherwise a text field
 * named "X label" followed by a link named "X link" (or just "Link") is one thing on the page, a button or a
 * link, so it becomes a group "X" with fields "Label" and "Link". Everything else stays in schema order.
 */
export function groupFields<T>(entries: Array<{ key: string; schema: PropSchema | ScalarPropSchema; data: T }>): Array<PropGroup<T>> {
  const out: Array<PropGroup<T>> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const g = e.schema.group;
    if (g) {
      const last = out[out.length - 1];
      if (last?.title === g) last.items.push({ ...e, label: shorten(e.schema.label, g) });
      else out.push({ title: g, items: [{ ...e, label: shorten(e.schema.label, g) }] });
      continue;
    }
    const next = entries[i + 1];
    const m = /^(.*) label$/i.exec(e.schema.label);
    if (m && e.schema.type === 'string' && next && next.schema.type === 'link' && !next.schema.group) {
      const prefix = m[1];
      const nl = next.schema.label.toLowerCase();
      if (nl === `${prefix} link`.toLowerCase() || nl === 'link') {
        out.push({ title: prefix, items: [{ ...e, label: 'Label' }, { ...next, label: prefix.toLowerCase() === 'link' ? 'Destination' : 'Link' }] });
        i++;
        continue;
      }
    }
    out.push({ items: [e] });
  }
  return out;
}

function shorten(label: string, group: string): string | undefined {
  if (!label.toLowerCase().startsWith(group.toLowerCase() + ' ')) return undefined;
  return sentence(label.slice(group.length + 1));
}

/** Renders grouped fields: a group gets a heading and a quiet frame, a lone field renders as itself. */
export function FieldGroups<T>({ groups, render }: { groups: Array<PropGroup<T>>; render: (item: PropGroup<T>['items'][number]) => ReactNode }) {
  return (
    <>
      {groups.map((g, gi) =>
        g.title ? (
          <fieldset key={gi} className="insp-group">
            <legend className="insp-group-title">{g.title}</legend>
            {g.items.map((it) => (
              <Fragment key={it.key}>{render(it)}</Fragment>
            ))}
          </fieldset>
        ) : (
          <Fragment key={g.items[0].key}>{render(g.items[0])}</Fragment>
        )
      )}
    </>
  );
}

/**
 * A repeatable list. Focus follows the edit: a new item opens with its row focused, and removing an item moves
 * focus to the row that takes its place (or to Add when the list is empty).
 */
function ListEditor({ name, schema, items, onList, state, focusItem }: { name: string; schema: ListProp; items: ListItem[]; onList: (op: never) => void; state: ProjectState; focusItem?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const labelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const after = useRef<{ kind: 'added'; before: string[] } | { kind: 'removed'; focus: string | null } | null>(null);
  const ids = items.map((i) => i.id).join(',');
  useEffect(() => {
    const a = after.current;
    if (!a) return;
    const root = rootRef.current;
    const focusRow = (id: string | null) => ((id && root?.querySelector<HTMLElement>(`#list-head-${CSS.escape(id)}`)) || root?.querySelector<HTMLElement>('.insp-add'))?.focus();
    if (a.kind === 'added') {
      const added = items.find((i) => !a.before.includes(i.id));
      if (!added) return;
      after.current = null;
      setOpen(added.id);
      requestAnimationFrame(() => focusRow(added.id));
    } else {
      after.current = null;
      requestAnimationFrame(() => focusRow(a.focus));
    }
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const openId = focusItem ?? open;
  const titleOf = (it: ListItem, i: number) => {
    const t = schema.titleField ? it[schema.titleField] : Object.values(it).find((v) => typeof v === 'string' && v && v !== it.id);
    return (typeof t === 'string' && t) || `${schema.itemLabel} ${i + 1}`;
  };
  const L = onList as (op: unknown) => void;
  const fields = groupFields(Object.entries(schema.fields).map(([key, s]) => ({ key, schema: s, data: null })));
  return (
    <div className="field" role="group" aria-labelledby={labelId} data-list={name} ref={rootRef}>
      <div className="field-label" id={labelId}>
        <span className="grow">{schema.label}</span>
        <span className="insp-count" aria-label={`${items.length} ${items.length === 1 ? schema.itemLabel.toLowerCase() : 'items'}`}>
          {items.length}
        </span>
      </div>
      <div className="list-editor">
        {items.map((it, i) => (
          <div key={it.id} className={`list-editor-item${focusItem === it.id ? ' focused' : ''}`}>
            <div className="list-editor-head">
              {/* The chevron and title are one disclosure button, so the whole leading area opens the item. */}
              <button className="title" id={`list-head-${it.id}`} aria-expanded={openId === it.id} aria-controls={`list-item-${it.id}`} onClick={() => setOpen(openId === it.id ? null : it.id)}>
                <ChevronRight size={12} className="faint" style={{ transform: openId === it.id ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
                <span className="ellipsis">{titleOf(it, i)}</span>
              </button>
              <button className="icon-btn sm" aria-label={`Move ${titleOf(it, i)} up`} disabled={i === 0} onClick={() => L({ kind: 'move', itemId: it.id, index: i - 1 })}>
                <ArrowUp />
              </button>
              <button className="icon-btn sm" aria-label={`Move ${titleOf(it, i)} down`} disabled={i === items.length - 1} onClick={() => L({ kind: 'move', itemId: it.id, index: i + 1 })}>
                <ArrowDown />
              </button>
              <button className="icon-btn sm" aria-label={`Remove ${titleOf(it, i)}`} disabled={schema.min !== undefined && items.length <= schema.min} onClick={() => {
                  after.current = { kind: 'removed', focus: (items[i + 1] ?? items[i - 1])?.id ?? null };
                  L({ kind: 'remove', itemId: it.id });
                }}>
                <Trash2 />
              </button>
            </div>
            {/* The controlled region always exists, so aria-controls resolves while the item is closed. */}
            <div className="list-editor-body" id={`list-item-${it.id}`} hidden={openId !== it.id}>
              {openId === it.id && (
                <FieldGroups
                  groups={fields}
                  render={({ key, schema: fs, label }) => <ScalarField key={key} schema={fs as ScalarPropSchema} label={label} value={it[key]} onChange={(v) => L({ kind: 'field', itemId: it.id, field: key, value: v })} state={state} />}
                />
              )}
            </div>
          </div>
        ))}
        <button className="btn btn-sm insp-add" disabled={schema.max !== undefined && items.length >= schema.max} onClick={() => {
            after.current = { kind: 'added', before: items.map((x) => x.id) };
            L({ kind: 'insert' });
          }}>
          <Plus /> Add {schema.itemLabel.toLowerCase()}
        </button>
      </div>
    </div>
  );
}
