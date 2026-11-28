/**
 * Sample defaults (`sampleDefault`). A design's defaults are of two kinds: sample content, written so a newly placed
 * section and its Insert thumbnail look designed (a hero's headline, a pricing table's plans), which an author is
 * expected to replace or knowingly keep before publishing; and defaults ready to publish as they are, the labels of
 * ordinary controls ("Search", "Send message"). The mark says which a default is, so a check can tell copy nobody has
 * touched yet from a label nobody needs to.
 *
 * Where it may stand, and what it marks:
 * - a component's own text or rich text property: its default;
 * - a list: the items it starts with (a computed list stores none, so it cannot be marked);
 * - a table: the columns and rows it starts with;
 * - a text or rich text field of a list: what the field holds in a newly added item;
 * - a text or rich text field of an object: what the field holds in the object's default.
 * An object is marked field by field, since its fields are often a sample text beside a link that is not.
 */

/** Property types whose default can be sample content. */
export const SAMPLE_DEFAULT_TYPES: readonly string[] = ['string', 'richtext', 'list', 'table'];
/** Field types (of a list or an object) whose default can be sample content. */
export const SAMPLE_DEFAULT_FIELD_TYPES: readonly string[] = ['string', 'richtext'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Why a property's (or, with `field`, a list's or object's field's) `sampleDefault` cannot stand, or null when it can
 * or there is none. Only `true` is a mark: leaving it out is how a default says it is ready to publish. A computed
 * list's items and fields come from the site's pages, so neither it nor any of its fields can be marked.
 */
export function sampleDefaultProblem(schema: { type?: unknown; sampleDefault?: unknown; feed?: unknown; fields?: unknown }, field = false): string | null {
  const type = String(schema.type);
  const computed = !field && type === 'list' && schema.feed !== undefined;
  if (schema.sampleDefault !== undefined) {
    if (schema.sampleDefault !== true) return 'sampleDefault must be true, or left out';
    if (field && !SAMPLE_DEFAULT_FIELD_TYPES.includes(type)) return 'only a text or rich text field can have a sample default';
    if (!field && !SAMPLE_DEFAULT_TYPES.includes(type))
      return type === 'object' ? 'an object cannot have a sample default; mark its text fields instead' : 'only a text, rich text, list or table property can have a sample default';
    if (computed) return 'a computed list has no items of its own, so they cannot be sample content';
  }
  if (computed && isRecord(schema.fields)) {
    const marked = Object.entries(schema.fields).find(([, f]) => isRecord(f) && f.sampleDefault !== undefined)?.[0];
    if (marked) return `the field "${marked}" of a computed list is filled from the site's pages, so it cannot have a sample default`;
  }
  return null;
}
