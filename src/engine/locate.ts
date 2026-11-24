import type { FieldLocation } from '@shared/api';
import type { ListItem, NodeTree, OwnerRef, ProjectState, PropSchema } from '@shared/types';
import { groupFields, listItemImage, listRowTitle } from '@shared/fields';
import { effectiveItem } from '@shared/page-teasers';
import { formServiceSetup } from '@catalogue/foundation/form';
import { displayName } from './tree';
import { pageShowing, partName } from '@shared/page-shell';

/** A content field of a placed component, named by IDs. */
export type FieldTarget = Omit<FieldLocation, 'path'>;

/**
 * Where a field is now. `path` is what the Inspector shows on the way to it; `pageId` is the page to open it on.
 * A failure has a `message` for the author and a `hint` that lists what the AI could have named instead.
 */
export type Located = { ok: true; pageId: string; owner: OwnerRef; path: string[]; value: unknown; shown?: string } | { ok: false; message: string; hint?: string };

const has = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);
/** For a choice, the option label the Inspector shows for a stored value. */
const shownAs = (schema: PropSchema, value: unknown): { shown?: string } => {
  const option = schema.type === 'enum' ? schema.options.find((o) => o.value === value) : undefined;
  return option && option.label !== value ? { shown: option.label } : {};
};
const fieldsOf = <T extends PropSchema>(schemas: Record<string, T>, hidden: string[] = []) =>
  groupFields(Object.entries(schemas).filter(([key]) => !hidden.includes(key)).map(([key, schema]) => ({ key, schema, data: null })));

/**
 * Find a content field the way the Inspector shows it: the placed component, its Content section, the field's
 * group or list, the list item by its title, then the field by its visible label. The labels come from the same
 * grouping the Inspector renders with, so an answer that quotes them matches what the author sees. The field is
 * found by IDs, so it is still found after its component or item moves on its page, and is reported gone once it is.
 */
export function locateField(state: ProjectState, target: FieldTarget, currentPageId?: string | null): Located {
  const { owner, nodeId, prop } = target;
  let tree: NodeTree | undefined;
  let pageId: string | undefined;
  let where: string;
  if (owner?.kind === 'page') {
    // Only on its own page: a component moves within its page, and one on another page with the same ID (copied
    // documents can share IDs) is not the one that was found.
    const page = has(state.pages, owner.id);
    if (!page) return { ok: false, message: 'That page is no longer in the site.' };
    if (!has(page.nodes, nodeId)) return { ok: false, message: `That component is no longer on ${page.title}.` };
    tree = page;
    pageId = page.id;
    where = page.title;
  } else if (owner?.kind === 'shell' && (owner.id === 'header' || owner.id === 'footer')) {
    tree = state.site.shell[owner.id];
    // The page being viewed when it shows this part, else the first page that does: pages choose each on its own.
    pageId = pageShowing(state, owner.id, currentPageId);
    if (!pageId) return { ok: false, message: `No page shows ${partName(owner.id)}.` };
    where = owner.id === 'header' ? 'Header' : 'Footer';
  } else return { ok: false, message: 'Only fields of a component placed on a page, or in the shared header or footer, can be opened in the Inspector.' };
  const node = has(tree?.nodes, nodeId);
  if (!node) return { ok: false, message: `That component is no longer in the shared ${owner.id}.` };
  if (node.kind !== 'instance') return { ok: false, message: 'Only the Content fields of a placed component can be opened in the Inspector.', hint: `"${nodeId}" is a ${node.kind} element. Name the component it belongs to and the property bound to it.` };
  const def = has(state.components, node.definitionId);
  if (!def) return { ok: false, message: 'That component is missing from the project.' };
  const name = displayName(state, node);
  // A contact form's Content leaves out the settings of the services it is not using.
  const groups = fieldsOf(def.properties, formServiceSetup(def, node.props)?.hidden);
  const group = groups.find((g) => g.items.some((i) => i.key === prop));
  const entry = group?.items.find((i) => i.key === prop);
  const keys = (gs: typeof groups) => gs.flatMap((g) => g.items.map((i) => i.key)).join(', ');
  if (!group || !entry) return { ok: false, message: `${name} has no such field in its Content.`, hint: `Its fields: ${keys(groups)}.` };
  // A button inside a declared group ("Actions") is a group of its own within it.
  const inner = group.groups?.find((g) => g.items.some((i) => i.key === prop));
  const head = [where, name, 'Content', ...(group.title ? [group.title] : []), ...(inner?.title ? [inner.title] : [])];
  const schema = entry.schema as PropSchema;
  if (schema.type === 'object') {
    // An object shows its fields under its own name; one field is opened by `field`.
    if (target.itemId !== undefined) return { ok: false, message: `${schema.label} is an object, not a list.`, hint: `Leave out itemId; give field, one of ${Object.keys(schema.fields).join(', ')}.` };
    const objectValue = has(node.props, prop) ?? schema.default;
    if (target.field === undefined) return { ok: true, pageId, owner, path: [...head, entry.label ?? schema.label], value: objectValue };
    const f = has(schema.fields, target.field);
    if (!f) return { ok: false, message: `${schema.label} has no field "${target.field}".`, hint: `Its fields: ${Object.keys(schema.fields).join(', ')}.` };
    const fieldValue = objectValue && typeof objectValue === 'object' && Object.hasOwn(objectValue, target.field) ? (objectValue as Record<string, unknown>)[target.field] : f.default;
    return { ok: true, pageId, owner, path: [...head, entry.label ?? schema.label, f.label], value: fieldValue, ...shownAs(f, fieldValue) };
  }
  if (schema.type !== 'list') {
    if (target.itemId !== undefined || target.field !== undefined) return { ok: false, message: `${schema.label} is a single field, not a list.`, hint: 'Leave out itemId and field.' };
    const value = has(node.props, prop) ?? schema.default;
    return { ok: true, pageId, owner, path: [...head, entry.label ?? schema.label], value, ...shownAs(schema, value) };
  }
  const value = has(node.props, prop) ?? schema.default;
  const items = (Array.isArray(value) ? value : []).filter((it): it is ListItem => !!it && typeof it === 'object');
  const itemFields = fieldsOf(schema.fields);
  // A row is named as the Inspector shows it: a page list's card by its page's title while it has none of its own.
  const rowTitle = (it: ListItem, i: number) => {
    const shown = effectiveItem(state, schema, it);
    return listRowTitle(schema, shown, i, listItemImage(schema, shown, state.assets.assets)?.name);
  };
  const listed = `Items: ${items.map((it, i) => `${it.id} (${rowTitle(it, i)})`).join(', ') || 'none'}. Item fields: ${keys(itemFields)}.`;
  if (target.itemId === undefined || target.field === undefined) return { ok: false, message: `${schema.label} is a list: open one field of one ${schema.itemLabel.toLowerCase()}.`, hint: `Give itemId and field. ${listed}` };
  const index = items.findIndex((it) => it.id === target.itemId);
  if (index < 0) return { ok: false, message: `${schema.label} in ${name} no longer has that ${schema.itemLabel.toLowerCase()}.`, hint: listed };
  const itemGroup = itemFields.find((g) => g.items.some((i) => i.key === target.field));
  const itemInner = itemGroup?.groups?.find((g) => g.items.some((i) => i.key === target.field));
  const field = itemGroup?.items.find((i) => i.key === target.field);
  if (!itemGroup || !field) return { ok: false, message: `A ${schema.itemLabel.toLowerCase()} has no such field.`, hint: listed };
  // A page list's card field that follows its page reads as the page's value, as the card shows it.
  const item = items[index];
  const itemValue = has(effectiveItem(state, schema, item), target.field);
  return { ok: true, pageId, owner, path: [...head, schema.label, rowTitle(item, index), ...(itemGroup.title ? [itemGroup.title] : []), ...(itemInner?.title ? [itemInner.title] : []), field.label ?? field.schema.label], value: itemValue, ...shownAs(field.schema as PropSchema, itemValue) };
}
