/**
 * Component Studio's sample content: the property values a component is previewed with, to see how its design holds
 * up. Never stored: they reach only the isolated preview (see @shared/component-preview), so a design is tried with
 * long copy or empty fields without touching its starting content or any placement.
 */
import type { ComponentDefinition, ListItem, ListProp, ObjectProp, PropSchema, ScalarPropSchema } from '@shared/types';
import { toRichText, type RichBlock, type RichSpan, type RichText } from '@shared/richtext';

/** What the studio fills the component with: its starting content, long copy, or nothing in the fields that can be empty. */
export type StudioSample = 'defaults' | 'long' | 'empty';
export const STUDIO_SAMPLES: ReadonlyArray<{ value: StudioSample; label: string; hint: string }> = [
  { value: 'defaults', label: 'Starting content', hint: 'The content a new placement starts with' },
  { value: 'long', label: 'Long copy', hint: 'Longer text and more list items, to see how the design copes' },
  { value: 'empty', label: 'Empty fields', hint: 'Text, images and lists left empty, to see what shows without them' }
];
export const isStudioSample = (v: unknown): v is StudioSample => STUDIO_SAMPLES.some((s) => s.value === v);

const FILLER =
  'This is a longer sample line, written to show how the design copes when an author writes more than the starting content does, across several lines on a narrow screen.';
/** At most this many items in a list made longer, so a stress test never becomes a wall of cards. */
const LONG_ITEMS = 8;

/** Text made longer, kept inside the property's own limit (and on one line when it takes one). */
function longer(text: string, max = 2000, multiline = false): string {
  const base = text.trim();
  const joined = base ? `${base} ${FILLER}` : FILLER;
  const out = multiline && base ? `${base}\n${FILLER}` : joined;
  return out.length > max ? out.slice(0, max).trimEnd() : out;
}

function longerSpans(spans: RichSpan[]): RichSpan[] {
  if (!spans.length) return [{ text: FILLER }];
  return [...spans.map((s) => ({ ...s })), { text: ` ${FILLER}` }];
}

function longerRich(value: unknown): RichText {
  // Stored as the canonical blocks, or as a hand-edited document may still hold it (plain strings).
  const blocks = toRichText(value);
  if (!blocks.length) return [{ type: 'p', spans: [{ text: FILLER }] }];
  const out = blocks.map((b): RichBlock => ('spans' in b ? { ...b, spans: longerSpans(b.spans) } : { ...b, items: b.items.map(longerSpans) }));
  // One more paragraph after the last text block, so a design sized for one paragraph shows how it grows.
  return [...out, { type: 'p', spans: [{ text: FILLER }] }];
}

/** A scalar's long sample, or undefined to keep its starting value (numbers, choices, links, images and icons). */
function longScalar(schema: ScalarPropSchema, value: unknown): unknown {
  if (schema.type === 'string') return longer(typeof value === 'string' ? value : typeof schema.default === 'string' ? schema.default : '', schema.maxLength, schema.multiline);
  if (schema.type === 'richtext') return longerRich(value);
  return undefined;
}

/** A scalar's empty sample, or undefined to keep its starting value (what has no empty form: numbers, choices, icons). */
function emptyScalar(schema: ScalarPropSchema): unknown {
  if (schema.type === 'string') return '';
  if (schema.type === 'richtext') return [];
  if (schema.type === 'image') return { assetId: null, alt: '' };
  // A link to nowhere, as clearing it in the Inspector leaves it: what shows only with a link (a button) goes.
  if (schema.type === 'link') return { type: 'none', target: '' };
  return undefined;
}

function fieldsOf(fields: Record<string, ScalarPropSchema>, values: Record<string, unknown>, make: (schema: ScalarPropSchema, value: unknown) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const [name, schema] of Object.entries(fields)) {
    const v = make(schema, Object.hasOwn(values, name) ? values[name] : schema.default);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

function longList(schema: ListProp): ListItem[] {
  const base = Array.isArray(schema.default) ? schema.default : [];
  const max = Math.min(schema.max ?? LONG_ITEMS, LONG_ITEMS);
  const count = Math.max(base.length, Math.min(max, Math.max(base.length * 2, 3)));
  const items: ListItem[] = [];
  for (let i = 0; i < count; i++) {
    const from = base.length ? base[i % base.length] : ({ id: '' } as ListItem);
    // Items repeated past the starting ones get IDs of their own, so each is its own item on the page.
    const id = i < base.length ? from.id : `${from.id || 'item'}-sample-${i}`;
    items.push({ ...fieldsOf(schema.fields, from, longScalar), id } as ListItem);
  }
  return items;
}

/**
 * The sample property values to preview `def` with (undefined for its starting content): long copy makes every text
 * longer and lists fuller, within each property's limits; empty clears every text, rich text, image and link and keeps
 * lists to their fewest items, cleared the same way. Lists that fill themselves from the site's pages are left as
 * they are.
 */
export function studioSampleProps(def: ComponentDefinition, sample: StudioSample): Record<string, unknown> | undefined {
  if (sample === 'defaults') return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(def.properties) as Array<[string, PropSchema]>) {
    let v: unknown;
    if (schema.type === 'list') {
      if (schema.feed) continue;
      // Empty keeps the fewest items the list allows, each with its fields cleared.
      v = sample === 'long' ? longList(schema) : (Array.isArray(schema.default) ? schema.default : []).slice(0, schema.min ?? 0).map((it) => ({ ...fieldsOf(schema.fields, it, (s) => emptyScalar(s)), id: it.id }));
    } else if (schema.type === 'object') {
      const values = (schema as ObjectProp).default ?? {};
      v = fieldsOf(schema.fields, values, sample === 'long' ? longScalar : (s) => emptyScalar(s));
    } else if (schema.type === 'table') continue;
    else v = sample === 'long' ? longScalar(schema, schema.default) : emptyScalar(schema);
    if (v !== undefined) out[name] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
