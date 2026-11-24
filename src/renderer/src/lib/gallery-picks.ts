// Choosing several library images for a gallery in one pass (issue #60). Plain functions, so which rows count as
// samples, how much room the choice has and the order the edits are made in are tested without a renderer.
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, ComponentDefinition, ImageValue, ListItem, ListProp, OwnerRef, PropSchema } from '@shared/types';
import type { MoveDirection } from './list-editor';

/** The lists that take several library images at once, by component: the list and the item field the image goes in.
 *  Only a Gallery: a team member, testimonial or logo needs more than a picture to be worth a row. */
const PICK_MANY: Record<string, { prop: string; field: string }> = { 'media.gallery': { prop: 'images', field: 'image' } };

/** The item field chosen images go in, for a list that takes several at once; otherwise null. A component made
 *  unique from a Gallery keeps the action while its list still holds images. */
export function pickImagesField(def: Pick<ComponentDefinition, 'componentId' | 'provenance'> | undefined, prop: string, schema: PropSchema): string | null {
  const from = def ? [def.componentId, def.provenance?.componentId] : [];
  const at = from.map((id) => (id && Object.hasOwn(PICK_MANY, id) ? PICK_MANY[id] : undefined)).find(Boolean);
  if (!at || at.prop !== prop || schema.type !== 'list') return null;
  return schema.fields[at.field]?.type === 'image' ? at.field : null;
}

/**
 * The six invented rows a Gallery started with before it started empty. A project made then still has them, in its
 * galleries and in its own copy of the component, so they are still recognised as samples there.
 */
const EARLIER_SAMPLES: ListItem[] = ['Garden room, Ashford', 'Kitchen, Millbrook', 'Studio, Harbour Lane', 'Living room, Westfield', 'Library, Old Mill', 'Courtyard, Elm Street'].map((caption, i) => ({
  id: `item-${i + 1}`,
  image: { assetId: null, alt: '' },
  caption
}));

/** A value written the same way whatever order its keys were stored in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** An image as a sample compares it: which file, its description and whether it is decorative. */
const imageKey = (v: unknown) => {
  const x = (v ?? {}) as Partial<ImageValue>;
  return stable([x.assetId ?? null, x.alt ?? '', !!x.decorative]);
};

function sameRow(schema: Pick<ListProp, 'fields'>, a: ListItem, b: ListItem): boolean {
  return Object.entries(schema.fields).every(([k, f]) => {
    const x = Object.hasOwn(a, k) ? a[k] : f.default;
    const y = Object.hasOwn(b, k) ? b[k] : f.default;
    return f.type === 'image' ? imageKey(x) === imageKey(y) : stable(x) === stable(y);
  });
}

const noImage = (schema: Pick<ListProp, 'fields'>, it: ListItem) => Object.entries(schema.fields).every(([k, f]) => f.type !== 'image' || !(it[k] as Partial<ImageValue> | undefined)?.assetId);

/**
 * The rows of a list that are still untouched samples: no image chosen, and every field as one of the component's
 * own starting rows (or a Gallery's earlier ones) left it. Each sample row matches one row at most, so a sample the
 * author duplicated counts once. A row with a caption, description or image of the author's own is never a sample.
 */
export function sampleRows(schema: Pick<ListProp, 'fields' | 'default'>, items: ListItem[]): string[] {
  const pool: ListItem[] = [];
  for (const row of [...(schema.default ?? []), ...EARLIER_SAMPLES]) if (noImage(schema, row) && !pool.some((p) => sameRow(schema, p, row))) pool.push(row);
  const out: string[] = [];
  for (const it of items) {
    if (!noImage(schema, it)) continue;
    const at = pool.findIndex((p) => sameRow(schema, it, p));
    if (at < 0) continue;
    pool.splice(at, 1);
    out.push(it.id);
  }
  return out;
}

/**
 * Whether the list is still exactly the rows its component started with (its own starting rows, or a Gallery's six
 * earlier ones), all of them and in order. Only then are the samples replaced unless the author says otherwise: a
 * list the author has trimmed, reordered or added to may hold a caption they typed that happens to match a sample.
 */
export function startingSamples(schema: Pick<ListProp, 'fields' | 'default'>, items: ListItem[]): boolean {
  if (!items.length || !items.every((it) => noImage(schema, it))) return false;
  return [schema.default ?? [], EARLIER_SAMPLES].some((rows) => rows.length === items.length && rows.every((row, i) => sameRow(schema, items[i], row)));
}

/** How many images can be added: the list's room once the `replacing` rows are gone. */
export function pickRoom(schema: Pick<ListProp, 'max'>, count: number, replacing: number): number {
  return schema.max === undefined ? Number.POSITIVE_INFINITY : Math.max(0, schema.max - (count - replacing));
}

/** An image added from the library: its suggested description, which the author can check on the row. */
export function pickedImage(asset: Pick<AssetRecord, 'id' | 'altSuggestion'>): ImageValue {
  return { assetId: asset.id, alt: asset.altSuggestion ?? '' };
}

/** Choose an image, at the end of the order while there is room; choosing it again takes it out. */
export function togglePick(chosen: readonly string[], id: string, room: number): string[] {
  if (chosen.includes(id)) return chosen.filter((x) => x !== id);
  return chosen.length < room ? [...chosen, id] : [...chosen];
}

/**
 * The whole choice after the author changed the part of it still in Assets (`live`, now `next`). An image that left
 * Assets stays right after the nearest image before it that is still chosen (or first, with none), so if it comes
 * back (an Undo in Assets) it is where the author put it, whatever else they left out or moved meanwhile.
 */
export function mergeChoice(raw: readonly string[], live: readonly string[], next: readonly string[]): string[] {
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of raw) {
    if (!live.includes(id)) after.set(anchor, [...(after.get(anchor) ?? []), id]);
    else if (next.includes(id)) anchor = id;
  }
  return [...(after.get(null) ?? []), ...next.flatMap((id) => [id, ...(after.get(id) ?? [])])];
}

/** Move a chosen image one place earlier or later in the order. */
export function movePick(chosen: readonly string[], id: string, direction: MoveDirection): string[] {
  const i = chosen.indexOf(id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= chosen.length) return [...chosen];
  const out = [...chosen];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

const images = (n: number) => `${n} ${n === 1 ? 'image' : 'images'}`;

/** What the choice says while it is too big for the list, or null while it fits. */
export function overNote(count: number, room: number): string | null {
  if (count <= room) return null;
  return room === 0 ? `This gallery is full. Leave out ${images(count)}, or remove rows from the gallery first.` : `This gallery has room for ${room} more ${room === 1 ? 'image' : 'images'}. Leave out ${images(count - room)}.`;
}

/** The change's name in the history: one undo step for the whole choice. */
export function pickLabel(count: number, replaced: number): string {
  return replaced ? `Replace ${replaced === 1 ? 'sample image' : 'sample images'} with ${images(count)}` : `Add ${images(count)}`;
}

/** What a screen reader hears once the images are in. */
export function pickAnnouncement(count: number, replaced: number): string {
  return replaced ? `Added ${images(count)} in place of the samples.` : `Added ${images(count)}.`;
}

export type PickStep = { kind: 'remove'; itemId: string } | { kind: 'insert'; item: Record<string, unknown> };

/**
 * The edits that add `chosen` to the end of the list in order, with `field` holding each image, and take away the
 * `replace` rows still in it, as one change. A row is taken away as soon as the list's minimum allows and before an
 * image is added, so a list full of samples can be swapped for a full list of images without passing its maximum.
 * Rows the choice doesn't replace keep their place and their IDs.
 */
export function planPicks(schema: Pick<ListProp, 'min' | 'max' | 'itemLabel'>, items: ListItem[], field: string, chosen: ImageValue[], replace: readonly string[]): { steps: PickStep[] } | { error: string } {
  if (!chosen.length) return { error: 'Choose at least one image to add.' };
  const removes = items.filter((it) => replace.includes(it.id)).map((it) => it.id);
  const room = pickRoom(schema, items.length, removes.length);
  const over = overNote(chosen.length, room);
  if (over) return { error: over };
  const min = schema.min ?? 0;
  const max = schema.max ?? Number.POSITIVE_INFINITY;
  const queue = [...chosen];
  const steps: PickStep[] = [];
  let count = items.length;
  while (removes.length || queue.length) {
    if (removes.length && count > min) {
      steps.push({ kind: 'remove', itemId: removes.shift()! });
      count--;
    } else if (queue.length && count < max) {
      steps.push({ kind: 'insert', item: { [field]: queue.shift()! } });
      count++;
    } else {
      return { error: `This list needs at least ${min} ${min === 1 ? schema.itemLabel.toLowerCase() : 'items'}, so those rows can’t all be replaced.` };
    }
  }
  return { steps };
}

/**
 * The change Add makes, planned against the project as it is when Add is pressed. Every chosen image must still be
 * in Assets: one that went since the author last looked stops it, so the picker stays open on what is left for the
 * author to confirm again. Only the `replace` rows the author was shown that are still samples go, so a sample
 * filled in meanwhile is kept and nothing beyond what was shown is taken away.
 */
export function planChoice(
  schema: Pick<ListProp, 'fields' | 'default' | 'min' | 'max' | 'itemLabel'>,
  items: ListItem[],
  field: string,
  assetIds: readonly string[],
  replace: readonly string[],
  assets: Record<string, Pick<AssetRecord, 'id' | 'kind' | 'altSuggestion'>>
): { steps: PickStep[]; label: string } | { error: string } {
  const gone = assetIds.filter((id) => !Object.hasOwn(assets, id) || assets[id].kind !== 'image');
  if (gone.length) return { error: `${gone.length === 1 ? 'An image you chose was' : `${gone.length} images you chose were`} removed from Assets. Check your choice, then add again.` };
  const still = new Set(sampleRows(schema, items));
  const plan = planPicks(schema, items, field, assetIds.map((id) => pickedImage(assets[id])), replace.filter((id) => still.has(id)));
  if ('error' in plan) return plan;
  return { steps: plan.steps, label: pickLabel(assetIds.length, plan.steps.filter((st) => st.kind === 'remove').length) };
}

/** The planned steps as list edits on one placement, to be applied as one batch. */
export function pickOperations(owner: OwnerRef, nodeId: string, prop: string, steps: readonly PickStep[]): EditOperation[] {
  return steps.map((st) => (st.kind === 'remove' ? { type: 'instance.listRemove', owner, nodeId, prop, itemId: st.itemId } : { type: 'instance.listInsert', owner, nodeId, prop, item: st.item }));
}
