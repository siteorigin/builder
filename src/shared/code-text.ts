/**
 * Text a code component shows that the canvas lets the author type over (#1074). The code marks the element that
 * shows a text property, or one field of the list item it is showing, through a hook its placement is given only in
 * the editor's preview:
 *
 *   <h2 data-so-text={so_text?.('heading')}>{heading}</h2>
 *   {#each features as feature (feature.id)}<h3 data-so-text={so_text?.('features.title', feature.id)}>…{/each}
 *   <RichText value={body} data-so-text={so_text?.('body')} />
 *
 * The website is given no hook, so the call gives nothing and no marker is written there: the published site carries
 * none, whoever owns the code. A component placed by the code (not by the editor) is given no hook either, so text it
 * marks never names its parent's properties.
 */
import type { ComponentDefinition, ListProp, PropSchema } from './types';

/** The prop a code placement takes its text hook through. */
export const CODE_TEXT_HOOK = 'so_text';
/** The attribute the hook's answer is written in. */
export const CODE_TEXT_ATTR = 'data-so-text';
/**
 * The hook a code placement is given in the editor's preview, as written into the page: the path it is called with,
 * and after a `#` the ID of the item when it names a list item's field. Paths are property IDs, which hold no `#`.
 */
export const CODE_TEXT_HOOK_JS = "(path, item) => (item == null ? path : path + '#' + item)";

/** A property or field ID as a component may declare one (a theme's may hold underscores). */
const ID = /^[A-Za-z][A-Za-z0-9_]*$/;

/** What a marker's path names: a property, or one field of a list property's items. Null when it is not one. */
export function parseCodeTextPath(path: string): { prop: string; field?: string } | null {
  const [prop, field, ...rest] = path.split('.');
  if (rest.length || !ID.test(prop) || (field !== undefined && !ID.test(field))) return null;
  return field === undefined ? { prop } : { prop, field };
}

/** A marker's value as the preview writes it: its path, and the item it names, if any. Null when it names nothing. */
export function parseCodeText(value: string): { prop: string; field?: string; itemId?: string } | null {
  const at = value.indexOf('#');
  const path = parseCodeTextPath(at < 0 ? value : value.slice(0, at));
  if (!path) return null;
  if (at < 0) return path.field === undefined ? path : null;
  const itemId = value.slice(at + 1);
  return path.field !== undefined && itemId ? { ...path, itemId } : null;
}

/** The value a marker's path and item make, as the hook writes it. */
export function codeTextValue(path: string, itemId?: string): string {
  return itemId === undefined ? path : `${path}#${itemId}`;
}

export type CodeTextField = { rich: boolean; label: string; list?: ListProp & { id: string } };

/**
 * What a marker's path names in a code component's properties, when that is text the canvas can be typed into: a
 * string, or rich text the code receives as blocks (which RichText.svelte shows as it is edited); for a list item's
 * field, a list that stores its items (not one worked out from the site's pages). Otherwise why it is not.
 */
export function codeTextField(properties: ComponentDefinition['properties'], path: { prop: string; field?: string }): CodeTextField | { problem: string } {
  const own = <T>(map: Record<string, T> | undefined, k: string): T | undefined => (map && Object.hasOwn(map, k) ? map[k] : undefined);
  const schema = own<PropSchema>(properties, path.prop);
  if (!schema) return { problem: `“${path.prop}” is not one of the component’s properties.` };
  if (path.field === undefined) {
    if (schema.type === 'list') return { problem: `“${path.prop}” is a list: mark the text of each item’s field (so_text?.('${path.prop}.title', item.id)).` };
    return textOf(schema, `“${path.prop}”`);
  }
  if (schema.type !== 'list') return { problem: `“${path.prop}” is not a list, so it has no “${path.field}” field to show.` };
  if (schema.feed) return { problem: `“${path.prop}” is worked out from the site’s pages, so its words are changed there, not typed on the page.` };
  const field = own(schema.fields, path.field);
  if (!field) return { problem: `“${path.prop}” items have no “${path.field}” field.` };
  const text = textOf(field, `The “${path.field}” field of “${path.prop}”`);
  return 'problem' in text ? text : { ...text, list: { ...schema, id: path.prop } };
}

function textOf(schema: PropSchema, what: string): CodeTextField | { problem: string } {
  if (schema.type === 'string') return { rich: false, label: schema.label };
  if (schema.type === 'richtext' && schema.codeForm === 'blocks') return { rich: true, label: schema.label };
  if (schema.type === 'richtext') return { problem: `${what} is rich text given as paragraphs, which can’t be edited on the page as it shows. Give it to the code as blocks (codeForm “blocks”) and show it with RichText.` };
  return { problem: `${what} is not text (it is ${schema.type === 'enum' ? 'a choice' : `a${/^[aeiou]/.test(schema.type) ? 'n' : ''} ${schema.type}`}).` };
}
