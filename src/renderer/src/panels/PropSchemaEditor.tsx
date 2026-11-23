import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PropSchema } from '@shared/types';
import { checkPropName } from '@engine/schema';
import { DraftInput, Field } from '../components/ui';

/**
 * The editable property schema (manifest) of a code component. Each row is one property: its name, type,
 * label, default and the settings that type takes. The engine validates the whole schema when it is saved.
 */
export interface SchemaRow {
  key: string;
  name: string;
  /** The name the property was stored under, to tell a rename from a new property. */
  orig?: string;
  schema: Record<string, unknown>;
}

const TYPES: Array<[PropSchema['type'], string]> = [
  ['string', 'Text'],
  ['richtext', 'Rich text'],
  ['number', 'Number'],
  ['boolean', 'On/off'],
  ['enum', 'Choice'],
  ['link', 'Link'],
  ['image', 'Image'],
  ['icon', 'Icon'],
  ['list', 'List']
];

let rowSeq = 0;
const rowKey = () => `r${++rowSeq}`;

export function rowsFromProperties(props: Record<string, PropSchema>): SchemaRow[] {
  return Object.entries(props).map(([name, schema]) => ({ key: rowKey(), name, orig: name, schema: structuredClone(schema) as unknown as Record<string, unknown> }));
}

export function propertiesFromRows(rows: SchemaRow[]): Record<string, unknown> {
  return Object.fromEntries(rows.map((r) => [r.name.trim(), r.schema]));
}

/** Problems the person can fix before saving; the engine checks everything else. */
export function schemaProblems(rows: SchemaRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const n = r.name.trim();
    try {
      checkPropName(n);
      if (seen.has(n)) out.push(`The property name "${n}" is used twice.`);
    } catch (e) {
      out.push((e as Error).message);
    }
    seen.add(n);
  }
  return out;
}

/** Defaults that make sense when a property changes type, so the engine never receives a mismatched default. */
function retype(schema: Record<string, unknown>, type: PropSchema['type']): Record<string, unknown> {
  const base: Record<string, unknown> = { type, label: schema.label };
  if (schema.description) base.description = schema.description;
  if (schema.group) base.group = schema.group;
  if (type === 'enum') base.options = [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }];
  if (type === 'list') Object.assign(base, { itemLabel: 'Item', fields: { title: { type: 'string', label: 'Title', default: '' } } });
  return base;
}

const optionsText = (o: unknown) => (Array.isArray(o) ? o.map((x: { value: string; label: string }) => (x.label && x.label !== x.value ? `${x.value} | ${x.label}` : x.value)).join('\n') : '');
const parseOptions = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [value, ...rest] = l.split('|');
      return { value: value.trim(), label: rest.join('|').trim() || value.trim() };
    });
const numOrUndef = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));

function RowEditor({ row, onChange, onRemove, readOnly }: { row: SchemaRow; onChange: (r: SchemaRow) => void; onRemove: () => void; readOnly?: boolean }) {
  const s = row.schema;
  const type = String(s.type) as PropSchema['type'];
  const uid = useId();
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const options = Array.isArray(s.options) ? (s.options as Array<{ value: string; label: string }>) : [];
  const set = (patch: Record<string, unknown>) => {
    const next = { ...s, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
    onChange({ ...row, schema: next });
  };
  const named = (what: string) => `${row.name || 'New property'} ${what}`;
  return (
    <fieldset className="schema-row" disabled={readOnly} style={{ border: '1px solid var(--line, #ddd)', borderRadius: 8, padding: 10, display: 'grid', gap: 8, margin: 0 }}>
      <legend className="sr-only">{row.name || 'New property'}</legend>
      <div className="grid-2">
        <Field label="Name">
          <DraftInput className="input sm mono" value={row.name} onCommit={(name) => onChange({ ...row, name: name.trim() })} ariaLabel={named('name')} />
        </Field>
        <Field label="Label">
          <DraftInput className="input sm" value={String(s.label ?? '')} onCommit={(label) => set({ label })} ariaLabel={named('label')} />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Type" controlId={`${uid}-type`}>
          <select id={`${uid}-type`} className="select sm" value={type} onChange={(e) => onChange({ ...row, schema: retype(s, e.target.value as PropSchema['type']) })}>
            {TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {type === 'string' && (
          <Field label="Default">
            <DraftInput className={s.multiline ? 'textarea' : 'input sm'} multiline={!!s.multiline} rows={2} value={String(s.default ?? '')} onCommit={(v) => set({ default: v })} ariaLabel={named('default')} />
          </Field>
        )}
        {type === 'richtext' && (
          <Field label="Default" hint="One paragraph per line.">
            <DraftInput multiline rows={2} value={Array.isArray(s.default) ? (s.default as string[]).join('\n') : ''} onCommit={(v) => set({ default: v.split('\n').map((p) => p.trim()).filter(Boolean) })} ariaLabel={named('default')} />
          </Field>
        )}
        {type === 'number' && (
          <Field label="Default">
            <DraftInput className="input sm" value={s.default === undefined ? '' : String(s.default)} onCommit={(v) => set({ default: numOrUndef(v) })} ariaLabel={named('default')} />
          </Field>
        )}
        {type === 'boolean' && (
          <label className="row" style={{ gap: 6, alignSelf: 'end' }}>
            <input type="checkbox" checked={!!s.default} onChange={(e) => set({ default: e.target.checked })} /> On by default
          </label>
        )}
        {type === 'icon' && (
          <Field label="Default icon">
            <DraftInput className="input sm mono" value={String(s.default ?? '')} onCommit={(v) => set({ default: v.trim() || undefined })} ariaLabel={named('default icon')} />
          </Field>
        )}
        {type === 'enum' && (
          <Field label="Default">
            <select className="select sm" value={String(s.default ?? '')} onChange={(e) => set({ default: e.target.value })} aria-label={named('default')}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {type === 'string' && (
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={!!s.multiline} onChange={(e) => set({ multiline: e.target.checked || undefined })} /> Allow several lines
        </label>
      )}
      {type === 'number' && (
        <div className="grid-2">
          <Field label="Minimum">
            <DraftInput className="input sm" value={s.min === undefined ? '' : String(s.min)} onCommit={(v) => set({ min: numOrUndef(v) })} ariaLabel={named('minimum')} />
          </Field>
          <Field label="Maximum">
            <DraftInput className="input sm" value={s.max === undefined ? '' : String(s.max)} onCommit={(v) => set({ max: numOrUndef(v) })} ariaLabel={named('maximum')} />
          </Field>
        </div>
      )}
      {type === 'enum' && (
        <Field label="Options" hint={'One per line, as value or value | Label.'}>
          <DraftInput
            multiline
            rows={3}
            className="textarea mono"
            value={optionsText(s.options)}
            onCommit={(v) => {
              const options = parseOptions(v);
              set({ options, default: options.some((o) => o.value === s.default) ? s.default : options[0]?.value });
            }}
            ariaLabel={named('options')}
          />
        </Field>
      )}
      {type === 'list' && (
        <>
          <div className="grid-2">
            <Field label="Item name">
              <DraftInput className="input sm" value={String(s.itemLabel ?? '')} onCommit={(v) => set({ itemLabel: v })} ariaLabel={named('item name')} />
            </Field>
            <Field label="Most items">
              <DraftInput className="input sm" value={s.max === undefined ? '' : String(s.max)} onCommit={(v) => set({ max: numOrUndef(v) })} ariaLabel={named('most items')} />
            </Field>
          </div>
          <Field label="Item fields" hint={'JSON: { "title": { "type": "string", "label": "Title" } }'} error={fieldsError}>
            <DraftInput
              multiline
              rows={4}
              className="textarea mono"
              value={JSON.stringify(s.fields ?? {}, null, 2)}
              onCommit={(v) => {
                let fields: Record<string, unknown>;
                try {
                  fields = JSON.parse(v);
                } catch (e) {
                  return setFieldsError(`Not valid JSON: ${(e as Error).message}`);
                }
                setFieldsError(null);
                if (JSON.stringify(fields) === JSON.stringify(s.fields ?? {})) return;
                // New fields mean new default items; a title field that is gone is dropped.
                const titleField = typeof s.titleField === 'string' && fields && Object.hasOwn(fields, s.titleField) ? s.titleField : undefined;
                set({ fields, default: undefined, titleField });
              }}
              ariaLabel={named('item fields')}
            />
          </Field>
        </>
      )}
      {!readOnly && (
        <div className="row">
          <span className="grow" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRemove} aria-label={`Remove ${row.name || 'property'}`}>
            <Trash2 /> Remove
          </button>
        </div>
      )}
    </fieldset>
  );
}

export function PropSchemaEditor({ rows, onChange, readOnly }: { rows: SchemaRow[]; onChange: (rows: SchemaRow[]) => void; readOnly?: boolean }) {
  const add = () => {
    const used = new Set(rows.map((r) => r.name));
    let n = 1;
    while (used.has(`prop${n}`)) n++;
    onChange([...rows, { key: rowKey(), name: `prop${n}`, schema: { type: 'string', label: `Property ${n}`, default: '' } }]);
  };
  return (
    <div className="col schema-editor" style={{ gap: 10 }}>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        Properties become controls in the inspector and props in the source: <span className="mono">{'let { name } = $props()'}</span>.
      </p>
      {rows.map((r, i) => (
        <RowEditor key={r.key} row={r} readOnly={readOnly} onChange={(next) => onChange(rows.map((x, j) => (j === i ? next : x)))} onRemove={() => onChange(rows.filter((_, j) => j !== i))} />
      ))}
      {!rows.length && <p className="faint">No properties yet.</p>}
      {!readOnly && (
        <div>
          <button type="button" className="btn btn-sm" onClick={add}>
            <Plus /> Add property
          </button>
        </div>
      )}
    </div>
  );
}
