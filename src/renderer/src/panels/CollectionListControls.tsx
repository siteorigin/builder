/**
 * Showing a collection in a list (#677), in the inspector: a placed section's list property switches between its own
 * items and a collection's entries (which collection, which of its entries, in what order, how many, and which entry
 * field fills each item field), and a collection loop's query is chosen the same way. Every change is one edit.
 */
import { useId, type ReactNode } from 'react';
import type { InstanceNode, ListConnection, ListProp, OwnerRef, ProjectState, RepeatNode } from '@shared/types';
import { CURRENT_COLLECTION, ENTRY_ORDER_FIELD, QUERY_OPERATORS, normalizeCollectionQuery, queryEntries, type CollectionQuery, type QueryClause, type QueryOperator } from '@shared/collection-query';
import { fieldFitProblem, rowFieldSchemas } from '@shared/collection-rows';
import { connectionProblem, loopProblem } from '@engine/collection-sources';
import { getTree } from '@engine/tree';
import { applyOps, toast, useStore } from '../store';
import { DraftInput, Field, Segmented } from '../components/ui';

const OP_WORDS: Record<QueryOperator, string> = { eq: 'is', ne: 'is not', in: 'is one of', contains: 'contains', gt: 'is after / more than', gte: 'is at least', lt: 'is before / less than', lte: 'is at most', exists: 'is set' };

/** The collections a query in `owner`'s tree can name: the project's, and in a layout its own as "this collection". */
function collectionChoices(state: ProjectState, owner: OwnerRef): Array<{ value: string; label: string }> {
  const out = Object.values(state.collections ?? {})
    .map((c) => ({ value: c.settings.id, label: c.settings.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (owner.kind === 'template' || owner.kind === 'archive') out.unshift({ value: CURRENT_COLLECTION, label: `This collection (${state.collections[owner.id]?.settings.name ?? owner.id})` });
  return out;
}

/** A clause's value as typed: a number when it reads as one and the field holds numbers, a yes/no for one, else text. */
function typedValue(raw: string, type: string | undefined, op: QueryOperator): QueryClause['value'] {
  if (op === 'exists') return undefined;
  const one = (v: string): string | number | boolean => (type === 'number' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : type === 'boolean' ? v.trim() === 'true' : v);
  if (op === 'in') return raw.split(',').map((v) => v.trim()).filter(Boolean).map(one);
  return one(raw);
}

/** Which entries, in what order and how many: the controls of one collection query. */
export function QueryControls({ state, owner, query, onChange, note }: { state: ProjectState; owner: OwnerRef; query: CollectionQuery; onChange: (q: CollectionQuery) => void; note?: ReactNode }) {
  const id = useId();
  const collectionId = query.collectionId === CURRENT_COLLECTION && (owner.kind === 'template' || owner.kind === 'archive') ? owner.id : query.collectionId;
  const collection = Object.hasOwn(state.collections ?? {}, collectionId) ? state.collections[collectionId] : undefined;
  const fields = collection ? rowFieldSchemas(collection) : {};
  const readable = Object.entries(fields).filter(([f]) => f !== 'entryLink');
  const set = (patch: Partial<CollectionQuery>) => onChange(normalizeCollectionQuery({ ...query, ...patch }) ?? query);
  const where = query.where ?? [];
  const sort = query.sort?.[0];
  return (
    <div className="collection-query" data-query={query.collectionId}>
      <Field label="Collection" controlId={`${id}-c`}>
        <select id={`${id}-c`} value={query.collectionId} onChange={(e) => onChange({ collectionId: e.target.value })}>
          {!collectionChoices(state, owner).some((c) => c.value === query.collectionId) && <option value={query.collectionId}>{query.collectionId} (missing)</option>}
          {collectionChoices(state, owner).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      {where.map((c, i) => {
        const type = fields[c.field]?.type;
        const replace = (next: QueryClause) => set({ where: where.map((w, j) => (j === i ? next : w)) });
        return (
          <div className="query-clause" key={i} role="group" aria-label={`Filter ${i + 1}`}>
            <select aria-label="Field" value={c.field} onChange={(e) => replace({ ...c, field: e.target.value })}>
              {readable.map(([f, s]) => (
                <option key={f} value={f}>
                  {s.label}
                </option>
              ))}
            </select>
            <select aria-label="Test" value={c.op} onChange={(e) => {
              const op = e.target.value as QueryOperator;
              replace({ field: c.field, op, ...(op === 'exists' ? {} : { value: typedValue(Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? ''), type, op) }) });
            }}>
              {QUERY_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {OP_WORDS[op]}
                </option>
              ))}
            </select>
            {/* Kept as typed until it is committed: a list's trailing comma, or a number half typed, is never read back over it. */}
            {c.op !== 'exists' && (
              <Field label="Value">
                <DraftInput value={Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')} onCommit={(v) => replace({ field: c.field, op: c.op, value: typedValue(v, type, c.op) })} />
              </Field>
            )}
            <button className="btn btn-sm" aria-label={`Remove filter ${i + 1}`} onClick={() => set({ where: where.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        );
      })}
      {collection && (
        <button className="btn btn-sm insp-inline-btn" onClick={() => set({ where: [...where, { field: readable[0]?.[0] ?? 'title', op: 'exists' }] })}>
          Add a filter
        </button>
      )}
      <Field label="Order" controlId={`${id}-s`}>
        <select id={`${id}-s`} value={sort?.field ?? ''} onChange={(e) => set({ sort: e.target.value ? [{ field: e.target.value, ...(sort?.direction === 'desc' ? { direction: 'desc' as const } : {}) }] : undefined })}>
          <option value="">The collection’s own order</option>
          <option value={ENTRY_ORDER_FIELD}>Editorial order</option>
          {readable.map(([f, s]) => (
            <option key={f} value={f}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      {sort && <Segmented label="Direction" value={sort.direction ?? 'asc'} options={[{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]} onChange={(d) => set({ sort: [{ field: sort.field, ...(d === 'desc' ? { direction: 'desc' as const } : {}) }] })} />}
      <Field label="At most" controlId={`${id}-l`} hint="Leave empty to show every entry it finds.">
        <input id={`${id}-l`} type="number" min={0} value={query.limit ?? ''} onChange={(e) => set({ limit: e.target.value === '' ? undefined : Math.max(0, Math.floor(Number(e.target.value))) })} />
      </Field>
      {owner.kind === 'template' && (
        <label className="switch-row">
          <input type="checkbox" checked={!!query.excludeCurrent} onChange={(e) => set({ excludeCurrent: e.target.checked || undefined })} /> Leave out the entry whose page it is on
        </label>
      )}
      {note}
    </div>
  );
}

/** A preview of what a query finds here, at most `max`: the titles of its first few entries. */
function FoundEntries({ state, owner, query, max }: { state: ProjectState; owner: OwnerRef; query: CollectionQuery; max?: number }) {
  // In a collection's layout, the entry the canvas shows it on is the current one.
  const sample = useStore((s) => (s.templateMode && !s.templateMode.archive && owner.kind === 'template' && s.templateMode.collectionId === owner.id ? s.templateMode.entryId : null));
  const place = owner.kind === 'template' || owner.kind === 'archive' ? { entry: { collectionId: owner.id, entryId: sample ?? '' } } : {};
  const all = queryEntries(state, query, place);
  const found = max === undefined ? all : all.slice(0, max);
  if (!found.length) return <p className="insp-note muted">No published entries match yet. Drafts are left out.</p>;
  return (
    <p className="insp-note field-hint">
      Shows {found.length === 1 ? 'one entry' : `${found.length} entries`}: {found.slice(0, 4).map((e) => e.title).join(', ')}
      {found.length > 4 ? '…' : ''}. Drafts are left out.
    </p>
  );
}

/**
 * A first connection for a list: the first collection (by name) whose entry fields can fill every field an item needs,
 * each item field filled by the entry field of the same kind it best fits. Null when no collection can.
 */
function startConnection(state: ProjectState, owner: OwnerRef, node: InstanceNode, prop: string, schema: ListProp): ListConnection | null {
  for (const c of Object.values(state.collections ?? {}).sort((a, b) => a.settings.name.localeCompare(b.settings.name))) {
    const start = connectionFor(c, schema);
    if (start && !connectionProblem(state, owner, node, prop, start)) return start;
  }
  return null;
}

function connectionFor(first: ProjectState['collections'][string], schema: ListProp): ListConnection | null {
  const fields = rowFieldSchemas(first);
  const pick = (target: ListProp['fields'][string], name: string): string | undefined => {
    const fits = Object.entries(fields).filter(([, s]) => !fieldFitProblem(s, target));
    // A field named like the item field first ("role" from field.role), then a title or picture for a name or a portrait.
    return (
      fits.find(([f]) => f === `field.${name}` || f === name)?.[0] ??
      (target.type === 'image' ? fits.find(([f]) => f === 'featuredImage')?.[0] : target.type === 'link' ? fits.find(([f]) => f === 'entryLink')?.[0] : target.required || name === schema.titleField ? fits.find(([f]) => f === 'title')?.[0] : undefined)
    );
  };
  const map: Record<string, string> = {};
  for (const [name, target] of Object.entries(schema.fields)) {
    const source = pick(target, name);
    if (source) map[name] = source;
  }
  return { query: { collectionId: first.settings.id }, fields: map };
}

/**
 * A placed section's list: its own items or a collection's entries. Connected, it says which entries show and which
 * entry field fills each item field, in place of the list's item editor (`manual`), which shows while it is not.
 */
export function ListSourceSwitch({ state, owner, node, prop, schema, manual }: { state: ProjectState; owner: OwnerRef; node: InstanceNode; prop: string; schema: ListProp; manual: ReactNode }) {
  const id = useId();
  const connection = node.listSources && Object.hasOwn(node.listSources, prop) ? node.listSources[prop] : undefined;
  const hasCollections = Object.keys(state.collections ?? {}).length > 0;
  if (!hasCollections && !connection) return <>{manual}</>;
  const label = schema.label.toLowerCase();
  const send = (source: ListConnection | null, words: string) => void applyOps([{ type: 'instance.setListSource', owner, nodeId: node.id, prop, source: source as { query: Record<string, unknown>; fields: Record<string, string> } | null }], words);
  const mode = connection ? 'collection' : 'own';
  const toggle = (
    <Segmented
      label={`Where the ${label} come from`}
      value={mode}
      options={[
        { value: 'own', label: 'Its own items' },
        { value: 'collection', label: 'A collection' }
      ]}
      onChange={(v) => {
        if (v === mode) return;
        if (v === 'own') return send(null, `Show the ${label} from its own items`);
        const start = startConnection(state, owner, node, prop, schema);
        if (start) send(start, `Show a collection in the ${label}`);
        else toast(`No collection has fields that can fill every ${schema.itemLabel.toLowerCase()}'s ${Object.values(schema.fields).filter((f) => f.required).map((f) => f.label.toLowerCase()).join(' and ') || 'fields'}. Give one a field of that kind first.`, 'info');
      }}
    />
  );
  if (!connection) return (
    <div className="list-source" data-list-source={prop}>
      {toggle}
      {manual}
    </div>
  );
  const query = normalizeCollectionQuery(connection.query) ?? { collectionId: String((connection.query as { collectionId?: unknown })?.collectionId ?? '') };
  const collectionId = query.collectionId === CURRENT_COLLECTION && (owner.kind === 'template' || owner.kind === 'archive') ? owner.id : query.collectionId;
  const collection = Object.hasOwn(state.collections ?? {}, collectionId) ? state.collections[collectionId] : undefined;
  const sources = collection ? Object.entries(rowFieldSchemas(collection)) : [];
  const problem = connectionProblem(state, owner, node, prop, connection);
  return (
    <div className="list-source field" data-list-source={prop}>
      <div className="field-label">{schema.label}</div>
      {toggle}
      <QueryControls state={state} owner={owner} query={query} onChange={(q) => send({ ...connection, query: q }, `Choose which entries the ${label} show`)} note={<FoundEntries state={state} owner={owner} query={query} max={typeof schema.max === 'number' ? schema.max : undefined} />} />
      <div className="field-label" id={`${id}-map`}>
        Each {schema.itemLabel.toLowerCase()} shows
      </div>
      {Object.entries(schema.fields).map(([name, target]) => (
        <Field key={name} label={target.label} controlId={`${id}-${name}`}>
          <select
            id={`${id}-${name}`}
            value={connection.fields[name] ?? ''}
            onChange={(e) => {
              const fields = { ...connection.fields };
              if (e.target.value) fields[name] = e.target.value;
              else delete fields[name];
              send({ ...connection, fields }, `Choose what the ${label} show as ${target.label.toLowerCase()}`);
            }}
          >
            <option value="">{target.required ? 'Choose a field' : 'Nothing (its default)'}</option>
            {sources
              .filter(([, s]) => !fieldFitProblem(s, target))
              .map(([f, s]) => (
                <option key={f} value={f}>
                  {s.label}
                </option>
              ))}
          </select>
        </Field>
      ))}
      {problem && <p className="insp-note error">{problem}</p>}
      <p className="insp-note faint">Its own {label} are kept: they show again when it shows its own items.</p>
    </div>
  );
}

/** A collection loop's entries: what it repeats, for a loop selected on the canvas. */
export function LoopSourceControls({ state, owner, node }: { state: ProjectState; owner: OwnerRef; node: RepeatNode }) {
  const list = node.list as { $query?: unknown; $archive?: unknown };
  if (list.$archive === true)
    return (
      <p className="insp-note field-hint">
        Repeats once for each entry the archive page shown lists: its share of the collection’s entries, page by page. Bind the elements inside to the entry’s fields.
      </p>
    );
  const query = normalizeCollectionQuery(list.$query) ?? { collectionId: '' };
  const tree = getTree(state, owner);
  const problem = loopProblem(state, owner, tree, node);
  return (
    <>
      <QueryControls state={state} owner={owner} query={query} onChange={(q) => void applyOps([{ type: 'node.setRepeatSource', owner, nodeId: node.id, source: { $query: q as unknown as Record<string, unknown> } }], 'Choose which entries the list shows')} note={<FoundEntries state={state} owner={owner} query={query} />} />
      {problem && <p className="insp-note error">{problem}</p>}
      <p className="insp-note faint">Each element inside shows a field of each entry: bind it in its Entry content.</p>
    </>
  );
}
