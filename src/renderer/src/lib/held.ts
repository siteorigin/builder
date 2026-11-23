import type { EditOperation } from '@shared/ops';
import type { GraphNode, NodeTree, OwnerRef, ProjectState, TableValue } from '@shared/types';
import { getTheme } from '@catalogue/index';
import { displayName } from '@engine/tree';
import { followsPage, inheritedValue } from '@shared/page-teasers';

/**
 * A typed edit made while the AI is working is held, not dropped. Each operation it is made of names one
 * field (a page's browser title, a property, a style) and is read here twice: when the edit is held, as
 * the value the author was editing, and again before it is applied, once the AI has stopped and its
 * changes are undone. The edit applies only when every field it writes still holds that value.
 *
 * Only edits whose fields can be read this way are held. Gestures (insert, delete, move, paste, theme
 * switches) are refused as before: they carry no typed text, and replaying them later is not safe.
 */

/** A field the edit writes: its value when found, or what it belonged to when that no longer exists. */
export type FieldRead = { found: true; value: unknown } | { found: false; what: string };

const has = <T,>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const found = (value: unknown): FieldRead => ({ found: true, value });
const gone = (what: string): FieldRead => ({ found: false, what });

/** Page fields `page.update` can set, and where each is stored. */
const PAGE_FIELDS: Record<string, string[]> = {
  title: ['title'],
  route: ['route'],
  navLabel: ['navLabel'],
  seoTitle: ['seo', 'title'],
  description: ['seo', 'description'],
  noindex: ['seo', 'noindex'],
  searchHidden: ['seo', 'searchHidden'],
  draft: ['draft'],
  showHeader: ['showHeader'],
  showFooter: ['showFooter'],
  socialImage: ['seo', 'socialImage']
};
const SITE_FIELDS = ['name', 'language', 'description', 'baseUrl', 'favicon', 'socialImage'];

function treeOf(state: ProjectState, owner: OwnerRef): NodeTree | undefined {
  if (owner.kind === 'page') return has(state.pages, owner.id);
  if (owner.kind === 'shell') return owner.id === 'header' || owner.id === 'footer' ? state.site.shell[owner.id] : undefined;
  return has(state.components, owner.id)?.tree;
}

function nodeOf(state: ProjectState, owner: OwnerRef, nodeId: string): GraphNode | string {
  const tree = treeOf(state, owner);
  if (!tree) return owner.kind === 'page' ? 'page' : owner.kind === 'shell' ? 'header or footer' : 'component';
  return has(tree.nodes, nodeId) ?? 'element';
}

const at = (v: unknown, path: string[]) => path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), v);

/** Text with a Markdown link to a site address is resolved against the page routes when it is applied, so
 *  the page each address names is part of what it writes: a route the AI changed and stopping restored can
 *  send the link somewhere else. Other routes, and links elsewhere, do not matter. */
function withRoutes(state: ProjectState, value: unknown, read: Record<string, unknown>): FieldRead {
  if (typeof value !== 'string') return found(read);
  const paths = [...value.matchAll(/\]\((\/[^)\s#?]*)/g)].map((m) => m[1]);
  if (!paths.length) return found(read);
  const slash = (r: string) => (r.endsWith('/') ? r : `${r}/`);
  const pageAt = (path: string) => Object.values(state.pages).find((p) => slash(p.route) === slash(path))?.id ?? null;
  return found({ ...read, links: Object.fromEntries(paths.map((p) => [p, pageAt(p)])) });
}

/**
 * Read the field `op` writes, as it is in `state`. Returns null for an operation that is not a field
 * edit (it is never held).
 */
export function readField(state: ProjectState, op: EditOperation): FieldRead | null {
  switch (op.type) {
    case 'page.update': {
      const page = has(state.pages, op.pageId);
      if (!page) return gone('page');
      const keys = Object.keys(PAGE_FIELDS).filter((k) => (op as Record<string, unknown>)[k] !== undefined);
      return found(Object.fromEntries(keys.map((k) => [k, at(page, PAGE_FIELDS[k])])));
    }
    case 'site.update': {
      const keys = SITE_FIELDS.filter((k) => (op as Record<string, unknown>)[k] !== undefined);
      return found(Object.fromEntries(keys.map((k) => [k, (state.site as unknown as Record<string, unknown>)[k]])));
    }
    case 'node.rename': {
      const node = nodeOf(state, op.owner, op.nodeId);
      return typeof node === 'string' ? gone(node) : found(node.name);
    }
    case 'node.setContent': {
      const node = nodeOf(state, op.owner, op.nodeId);
      if (typeof node === 'string') return gone(node);
      const value = (node as unknown as Record<string, unknown>)[op.field];
      // In component editing, bound content writes the property's default, so that property is the field.
      const bound = value && typeof value === 'object' && '$prop' in value ? String((value as { $prop: unknown }).$prop) : null;
      const def = bound && op.owner.kind === 'component' ? has(state.components, op.owner.id) : undefined;
      return withRoutes(state, op.value, { kind: node.kind, value, schema: bound ? has(def?.properties, bound) : undefined });
    }
    case 'instance.setProp': {
      const node = nodeOf(state, op.owner, op.nodeId);
      if (typeof node === 'string') return gone(node);
      if (node.kind !== 'instance') return gone('element');
      // The property's schema is part of the field: an unset property shows its default, and the schema
      // decides how the value is read.
      const schema = has(has(state.components, node.definitionId)?.properties, op.prop);
      const value = has(node.props, op.prop);
      if (!op.itemId) return withRoutes(state, op.value, { definitionId: node.definitionId, schema, value });
      // A placement without its own list shows (and edits) the definition's items.
      const items = value === undefined && schema?.type === 'list' ? schema.default : value;
      const item = Array.isArray(items) ? items.find((i) => i && typeof i === 'object' && (i as { id?: unknown }).id === op.itemId) : undefined;
      if (!item) return gone('list item');
      const row = item as Record<string, unknown>;
      // A page list's card shows its page's values in the fields it leaves empty: the page it links to, and what
      // that page gives the field, are part of what the author saw there.
      const teaser = schema?.type === 'list' && schema.pageTeaser ? { page: row[schema.pageTeaser.link], shows: op.field ? inheritedValue(state, schema, row, op.field) : undefined } : {};
      return withRoutes(state, op.value, { definitionId: node.definitionId, schema, value: op.field ? row[op.field] : item, ...teaser });
    }
    case 'instance.editTable': {
      // A cell's text and a column's name are typed fields. Adding, removing and moving rows or columns are
      // gestures, and are refused while the AI works like any other.
      if (op.action !== 'setCell' && op.action !== 'renameColumn') return null;
      const node = nodeOf(state, op.owner, op.nodeId);
      if (typeof node === 'string') return gone(node);
      if (node.kind !== 'instance') return gone('element');
      const schema = has(has(state.components, node.definitionId)?.properties, op.prop);
      // A placement without its own table shows (and edits) the definition's.
      const own = has(node.props, op.prop);
      const table = (own === undefined && schema?.type === 'table' ? schema.default : own) as Partial<TableValue> | undefined;
      const column = (Array.isArray(table?.columns) ? table.columns : []).find((c) => c && c.id === op.columnId);
      if (!column) return gone('table column');
      if (op.action === 'renameColumn') return found({ definitionId: node.definitionId, value: column.label });
      const row = (Array.isArray(table?.rows) ? table.rows : []).find((r) => r && r.id === op.rowId);
      if (!row) return gone('table row');
      // A cell is its row and column by ID, and its row is also known by its name (its first cell), so a row given
      // other content under the same ID is not the one the author edited. Other cells may change (another held edit
      // to the same row) without making this a different field.
      const first = (Array.isArray(table?.columns) ? table.columns : []).find((c) => c && typeof c.id === 'string');
      const name = first && first.id !== column.id ? { name: row.cells?.[first.id] ?? '' } : {};
      return found({ definitionId: node.definitionId, value: row.cells?.[column.id] ?? '', ...name });
    }
    case 'node.setStyle': {
      // A variant rule lives on the component definition with every other rule of that option: not one field.
      if (op.variant !== undefined) return null;
      const node = nodeOf(state, op.owner, op.nodeId);
      if (typeof node === 'string') return gone(node);
      if (node.kind === 'instance') {
        // A part is a name for one element of the component: which element it names is part of the field.
        const partId = op.partId ?? 'root';
        const part = has(has(state.components, node.definitionId)?.parts, partId);
        return found({ definitionId: node.definitionId, part, value: at(node.overrides, [partId, op.scope, op.property]) });
      }
      return found({ kind: node.kind, value: at((node as { styles?: unknown }).styles, [op.scope, op.property]) });
    }
    case 'token.set': {
      // A theme style's value is its override over the theme's default, so the theme is part of the field.
      // A custom style is read whole: one deleted and created again under the same ID is not the same style.
      const custom = state.tokens.custom.find((t) => t.id === op.tokenId);
      if (!custom && !getTheme(state.site.themeId).tokens.some((t) => t.id === op.tokenId)) return gone('site style');
      return found({ themeId: state.site.themeId, override: has(state.tokens.overrides, op.tokenId), custom });
    }
    case 'token.rename': {
      const custom = state.tokens.custom.find((t) => t.id === op.tokenId);
      return custom ? found({ custom }) : gone('site style');
    }
    case 'asset.update': {
      const asset = has(state.assets.assets, op.assetId);
      if (!asset) return gone('file');
      // Renaming a font family rewrites every style that names it, anywhere in the project: the whole
      // project is what it writes. Other details are the file's own.
      return found(op.font ? { asset, project: state } : { asset });
    }
    case 'component.rename': {
      const def = has(state.components, op.definitionId);
      return def ? found({ name: def.name, description: def.description }) : gone('component');
    }
  }
  return null;
}

/** null and a missing value both mean "not set". (Empty text does not: an empty property hides its default.) */
const blank = (v: unknown) => v === undefined || v === null;

/** Compare two field values: object key order does not matter, and null equals a missing value. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (blank(a) && blank(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    return [...new Set([...Object.keys(ao), ...Object.keys(bo)])].every((k) => sameValue(ao[k], bo[k]));
  }
  return Object.is(a, b);
}

/** The fields a batch writes, as it is in `state`; null when any operation is not a field edit. */
export function readFields(state: ProjectState, operations: EditOperation[]): FieldRead[] | null {
  if (!operations.length) return null;
  const reads = operations.map((op) => readField(state, op));
  return reads.every((r): r is FieldRead => r !== null) ? reads : null;
}

export type HeldCheck =
  /** Every field still holds what the author edited: apply it. */
  | { kind: 'apply' }
  /** What the edit was for no longer exists (the AI created it, and stopping removed it). */
  | { kind: 'gone'; what: string }
  /** A field holds something else now (the AI had changed it, and stopping undid that). `current` is
   *  what the fields hold now: the author reviews it, and it is checked again before it is replaced. */
  | { kind: 'changed'; current: unknown[] };

/** Check a held batch against `state`, given what its fields held when it was made (`base`). */
export function checkHeld(state: ProjectState, operations: EditOperation[], base: unknown[]): HeldCheck {
  const now = readFields(state, operations);
  // Never null for a batch that was held: the operations are the same ones.
  if (!now) return { kind: 'gone', what: 'change' };
  const missing = now.find((r) => !r.found);
  if (missing && !missing.found) return { kind: 'gone', what: missing.what };
  const current = now.map((r) => (r.found ? r.value : undefined));
  return current.every((v, i) => sameValue(v, base[i])) ? { kind: 'apply' } : { kind: 'changed', current };
}

/** Keys that say which field an operation writes; every other key is the value written. */
const TARGET_KEYS = new Set(['owner', 'nodeId', 'pageId', 'prop', 'itemId', 'field', 'partId', 'variant', 'axis', 'scope', 'property', 'tokenId', 'assetId', 'definitionId', 'action', 'rowId', 'columnId']);

/** Identifies the fields a batch writes, so a newer edit of the same fields replaces an older held one. */
export function fieldKey(operations: EditOperation[]): string {
  return JSON.stringify(
    operations.map((op) => {
      const o: Record<string, unknown> = { ...op };
      // An instance's style with no part is its root's.
      if (op.type === 'node.setStyle' && o.partId === undefined) o.partId = 'root';
      return Object.entries(o)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => {
          if (TARGET_KEYS.has(k)) return [k, v];
          // A text style is set part by part (size, line height, tracking): each part is its own field.
          if (op.type === 'token.set' && k === 'value' && v && typeof v === 'object' && !Array.isArray(v) && !('token' in v)) return [k, Object.keys(v).sort()];
          return [k];
        })
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    })
  );
}

/** Text for a value a field holds or will hold, to show the author; null for structured values. */
export function shownValue(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** What the author typed into a batch: the value its first operation writes, when that is plain text. */
export function typedText(op: EditOperation): string | null {
  const o = op as Record<string, unknown>;
  if (op.type === 'page.update' || op.type === 'site.update' || op.type === 'asset.update') {
    const key = Object.keys(o).find((k) => k !== 'type' && !TARGET_KEYS.has(k) && o[k] !== undefined);
    if (key === 'font') return shownValue((o.font as { family?: unknown } | undefined)?.family);
    return key ? shownValue(o[key]) : null;
  }
  if (op.type === 'node.rename' || op.type === 'component.rename') return shownValue(op.name);
  if (op.type === 'token.rename') return shownValue(op.label);
  return shownValue(o.value);
}

/** What the field `op` writes holds, as read by `readField`, as text to show the author ("" when empty). */
export function shownField(op: EditOperation, read: unknown): string | null {
  const o = (read && typeof read === 'object' ? read : {}) as Record<string, unknown>;
  let v: unknown = read;
  if (op.type === 'page.update' || op.type === 'site.update' || op.type === 'component.rename') v = Object.values(o)[0];
  else if (op.type === 'asset.update') {
    const asset = (o.asset ?? {}) as Record<string, unknown>;
    const key = Object.keys(op).find((k) => k !== 'type' && k !== 'assetId');
    v = key === 'font' ? (asset.font as { family?: unknown } | undefined)?.family : key ? asset[key] : undefined;
  } else if (op.type === 'token.set') v = o.override ?? (o.custom as { value?: unknown } | undefined)?.value;
  else if (op.type === 'token.rename') v = (o.custom as { label?: unknown } | undefined)?.label;
  else if (op.type === 'instance.setProp' && !op.itemId) v = o.value ?? (o.schema as { default?: unknown } | undefined)?.default;
  // A page list's empty card field shows its page's value, which is what the author sees there.
  else if (op.type === 'instance.setProp' && followsPage(o.value) && typeof o.shows === 'string' && o.shows.trim()) v = o.shows;
  else if (op.type !== 'node.rename') v = o.value;
  return blank(v) ? '' : shownValue(v);
}

/** Where the field `op` writes is, in the author's words: a page title, "Header", a style or file name. */
export function placeOf(state: ProjectState, op: EditOperation): string {
  const o = op as Record<string, unknown>;
  if (typeof o.pageId === 'string') return has(state.pages, o.pageId)?.title ?? 'Page';
  if (o.owner && typeof o.owner === 'object') {
    const owner = o.owner as OwnerRef;
    if (owner.kind === 'page') return has(state.pages, owner.id)?.title ?? 'Page';
    if (owner.kind === 'shell') return owner.id === 'footer' ? 'Footer' : 'Header';
    return has(state.components, owner.id)?.name ?? 'Component';
  }
  if (typeof o.tokenId === 'string') return [...getTheme(state.site.themeId).tokens, ...state.tokens.custom].find((t) => t.id === o.tokenId)?.label ?? 'Site style';
  if (typeof o.assetId === 'string') return has(state.assets.assets, o.assetId)?.name ?? 'File';
  if (typeof o.definitionId === 'string') return has(state.components, o.definitionId)?.name ?? 'Component';
  return 'Site settings';
}

/** The element the field `op` writes belongs to, and where it is, in the author's words: "Split hero on Home",
 *  "Logo in Header". A field of no element (a page or site setting) is just where it is. */
export function whereOf(state: ProjectState, op: EditOperation): string {
  const o = op as Record<string, unknown>;
  const place = placeOf(state, op);
  if (!o.owner || typeof o.owner !== 'object' || typeof o.nodeId !== 'string') return place;
  const owner = o.owner as OwnerRef;
  const node = nodeOf(state, owner, o.nodeId);
  return typeof node === 'string' ? place : `${displayName(state, node)} ${owner.kind === 'page' ? 'on' : 'in'} ${place}`;
}

export type HeldAction = 'stop-apply' | 'apply' | 'replace' | 'copy' | 'retry' | 'discard';

/** What a held edit's row says, and the actions it offers, in each phase. */
export function heldPrompt(h: { phase: string; text: string | null; currentText?: string | null; note?: string; stopping?: boolean; writing?: boolean }, aiBusy: boolean, phase: 'working' | 'asking' | 'checking' | 'stopping' | null = null): { message: string; actions: HeldAction[] } {
  const quote = (t: string | null | undefined) => (t === '' ? 'nothing' : t ? `“${t}”` : null);
  switch (h.phase) {
    case 'applying':
      // Once the write is on its way it cannot be called back, so nothing is offered.
      if (h.writing) return { message: 'Saving your edit.', actions: [] };
      return { message: h.stopping ? 'Stopping the AI. Your edit is applied once its changes are undone.' : 'Checking your edit before it is applied.', actions: ['discard'] };
    case 'changed': {
      const now = quote(h.currentText);
      return {
        message: `Not applied: this changed while the AI was working${now ? ` and now holds ${now}` : ''}. Replace it with your edit?`,
        actions: ['replace', 'discard']
      };
    }
    case 'gone':
      return { message: `Not applied: the ${h.note ?? 'item'} this edit was for no longer exists, so there is nothing to apply it to.${h.text ? ' Copy your text to use it elsewhere.' : ''}`, actions: h.text ? ['copy', 'discard'] : ['discard'] };
    case 'failed':
      return { message: `Not applied: ${h.note ?? 'the change could not be made.'}`, actions: ['retry', 'discard'] };
  }
  if (aiBusy) return { message: `Not saved yet: the AI is ${phase === 'asking' ? 'waiting for your answer' : phase === 'stopping' ? 'stopping' : 'working'}.${h.note ? ` ${h.note}` : ''}`, actions: ['stop-apply', 'discard'] };
  return { message: 'Not saved yet: the AI has finished. Your edit is checked against its changes before it is applied.', actions: ['apply', 'discard'] };
}
