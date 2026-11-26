/**
 * In a collection's layout: what an element, or a section placed there, shows of each entry. Each place that can show
 * an entry's field (a text's words, an image, a button's link and label, a section's property) offers the fields that
 * fit it, or its own value, which is then the same on every entry's page; and the element can be shown only on the
 * entries that have a value for a field (a featured image, an author).
 */
import type { Collection, GraphNode, OwnerRef, ProjectState, PropSchema } from '@shared/types';
import { conditionRef, isBinding, isEntryBinding } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { entryChoiceProblem, entryFieldLabel, entryFieldSchemas, isEntryDateField } from '@shared/entry-fields';
import { rowFieldSchemas } from '@shared/collection-rows';
import { acceptedTypes, type BindField } from '@engine/schema';
import { loopCollection, loopMembers } from '@engine/collection-sources';
import { getTree } from '@engine/tree';
import { applyOps } from '../store';
import { Field, Section } from '../components/ui';

interface Place {
  /** A field node.setBinding sets: a filter's switch is set with the rest of its design. */
  field: Exclude<BindField, 'filter'>;
  prop?: string;
  label: string;
  nested?: PropSchema;
  value: unknown;
}

/** The places of a node that can show an entry's field. */
function placesOf(state: ProjectState, node: GraphNode): Place[] {
  const r = node as unknown as Record<string, unknown>;
  switch (node.kind) {
    case 'text':
      return [{ field: 'text', label: node.rich ? 'Rich text' : 'Text', value: r.text }];
    case 'image':
      return [{ field: 'image', label: 'Image', value: r.image }];
    case 'link':
      return [
        { field: 'label', label: 'Label', value: r.label },
        { field: 'link', label: 'Link', value: r.link }
      ];
    case 'instance': {
      const def = state.components[node.definitionId];
      if (!def) return [];
      const kinds = new Set(['string', 'richtext', 'number', 'boolean', 'enum', 'image', 'link']);
      return Object.entries(def.properties)
        .filter(([, s]) => kinds.has(s.type))
        .map(([prop, s]) => ({ field: 'prop' as const, prop, label: s.label, nested: s, value: Object.hasOwn(node.props, prop) ? node.props[prop] : undefined }));
    }
    default:
      return [];
  }
}

/** Which of a collection's fields a place can show: those of a type it takes. */
function fitting(fields: Record<string, PropSchema>, node: GraphNode, place: Place): string[] {
  const ok = acceptedTypes(node, place.field, place.nested);
  // A choice must offer only what the placed section's choice offers.
  return Object.keys(fields).filter((f) => (!ok || ok.includes(fields[f].type)) && !entryChoiceProblem(fields[f], place.nested));
}

/** What an element reads entries through: a collection's layout (`$entry`), or the collection loop it is in (`$item`). */
interface Reader {
  key: '$entry' | '$item';
  collection: Collection;
  fields: Record<string, PropSchema>;
}

/** How a node reads entries: inside a collection loop, each row's; in a collection's layout, the page's. */
function readerFor(state: ProjectState, owner: OwnerRef, node: GraphNode): Reader | null {
  let tree;
  try {
    tree = getTree(state, owner);
  } catch {
    return null;
  }
  const loop = loopMembers(tree).get(node.id);
  const looped = loop ? loopCollection(state, owner, loop) : undefined;
  if (looped) return { key: '$item', collection: looped, fields: rowFieldSchemas(looped) };
  if (owner.kind !== 'template' || !Object.hasOwn(state.collections, owner.id)) return null;
  const collection = state.collections[owner.id];
  return { key: '$entry', collection, fields: entryFieldSchemas(collection) };
}

/** The entry field a value reads through `key`, or '' for a value of its own. */
const readOf = (v: unknown, key: Reader['key']): string => (key === '$entry' ? (isEntryBinding(v) ? v.$entry : '') : isBinding(v) && '$item' in v && typeof v.$item === 'string' ? v.$item : '');

export function EntryFieldsSection({ state, owner, node }: { state: ProjectState; owner: OwnerRef; node: GraphNode }) {
  const reader = readerFor(state, owner, node);
  if (!reader) return null;
  const { collection, fields, key } = reader;
  const shown = (v: unknown) => readOf(v, key);
  const ref = (field: string) => (key === '$entry' ? { $entry: field } : { $item: field });
  const places = placesOf(state, node);
  // What decides whether it shows: one entry field being there (`with:`) or not (`without:`). A condition read from
  // anything else (a hand edit) shows as it is, and choosing On every entry clears both.
  const when = conditionRef(node.when);
  const unless = conditionRef(node.unless);
  const condition = shown(when) ? `with:${shown(when)}` : shown(unless) ? `without:${shown(unless)}` : node.when !== undefined || node.unless !== undefined ? 'other' : '';
  const bind = (place: Place, field: string) => {
    const ops: EditOperation[] = [{ type: 'node.setBinding', owner, nodeId: node.id, field: place.field, ...(place.prop ? { prop: place.prop } : {}), binding: field ? ref(field) : null }];
    // A text showing a date states it for machines too (a <time>); showing anything else, it states none.
    if (node.kind === 'text' && !node.rich && place.field === 'text') {
      if (isEntryDateField(collection, field)) ops.push({ type: 'node.setBinding', owner, nodeId: node.id, field: 'datetime', binding: ref(field) });
      else if (shown(node.datetime)) ops.push({ type: 'node.setBinding', owner, nodeId: node.id, field: 'datetime', binding: null });
    }
    void applyOps(ops, field ? `Show ${entryFieldLabel(collection, field)}` : `Unbind ${place.label}`);
  };
  const showWhen = (choice: string) => {
    const [how, field] = choice.split(/:(.*)/s);
    const ops: EditOperation[] = [];
    if (node.when !== undefined || how === 'with') ops.push({ type: 'node.setBinding', owner, nodeId: node.id, field: 'when', binding: how === 'with' ? ref(field) : null });
    if (node.unless !== undefined || how === 'without') ops.push({ type: 'node.setBinding', owner, nodeId: node.id, field: 'unless', binding: how === 'without' ? ref(field) : null });
    if (ops.length) void applyOps(ops, how === 'with' ? `Show only with ${entryFieldLabel(collection, field)}` : how === 'without' ? `Show only without ${entryFieldLabel(collection, field)}` : 'Show on every entry');
  };
  return (
    <Section title="Entry content" id="entry-fields" level={4}>
      <p className="faint insp-note">{key === '$item' ? `This repeats once for each entry of ${collection.settings.name} its list shows. Choose what it shows of each entry.` : `Every entry of ${collection.settings.name} is shown with this layout. Choose what this shows of each entry.`}</p>
      {places.map((place) => {
        const options = fitting(fields, node, place);
        const current = shown(place.value);
        const id = `entry-field-${node.id}-${place.prop ?? place.field}`;
        return (
          <Field key={place.prop ?? place.field} label={place.label} controlId={id}>
            <select id={id} className="select" value={current} data-testid={`entry-field-${place.prop ?? place.field}`} onChange={(e) => bind(place, e.target.value)}>
              <option value="">Its own {place.field === 'image' ? 'image' : place.field === 'link' ? 'link' : 'value'}, the same on every entry</option>
              {current && !options.includes(current) && <option value={current}>{entryFieldLabel(collection, current)} (does not fit)</option>}
              {options.map((f) => (
                <option key={f} value={f}>
                  Each entry’s {fields[f].label.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
        );
      })}
      <Field label="Show" controlId={`entry-when-${node.id}`}>
        <select id={`entry-when-${node.id}`} className="select" value={condition} data-testid="entry-field-when" onChange={(e) => showWhen(e.target.value)}>
          <option value="">On every entry</option>
          {condition === 'other' && (
            <option value="other" disabled>
              Under a condition set elsewhere
            </option>
          )}
          {condition.includes(':') && !Object.hasOwn(fields, condition.split(/:(.*)/s)[1]) && <option value={condition}>{condition.split(/:(.*)/s)[1]} (gone)</option>}
          {Object.keys(fields).map((f) => (
            <option key={`with:${f}`} value={`with:${f}`}>
              Only on entries with {fields[f].label.toLowerCase()}
            </option>
          ))}
          {Object.keys(fields).map((f) => (
            <option key={`without:${f}`} value={`without:${f}`}>
              Only on entries without {fields[f].label.toLowerCase()}
            </option>
          ))}
        </select>
      </Field>
    </Section>
  );
}

/** A note in place of a field that shows each entry's own value: it is changed in the entry, not here. */
export function EntryBoundNote({ state, owner, value, label, node }: { state: ProjectState; owner: OwnerRef; value: unknown; label: string; node?: GraphNode }) {
  const reader = node ? readerFor(state, owner, node) : owner.kind === 'template' && Object.hasOwn(state.collections, owner.id) ? { key: '$entry' as const, collection: state.collections[owner.id], fields: {} } : null;
  const field = reader ? readOf(value, reader.key) : '';
  if (!reader || !field) return null;
  return (
    <p className="faint insp-note" data-testid="entry-bound-note">
      {label}: each entry’s {(reader.fields[field]?.label ?? entryFieldLabel(reader.collection, field)).toLowerCase()}.
    </p>
  );
}
