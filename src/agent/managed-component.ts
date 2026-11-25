/**
 * upsert_managed_component: a whole managed component (its properties, design, parts, slots and variants) created or
 * rebuilt in one call, and placed on a page in the same undo step when asked. It compiles to the engine's
 * `component.upsert` operation (and a `node.insert` for the placement), so scope checks, validation and undo are the
 * same as for any edit.
 *
 * The arguments are a closed, finite JSON shape, so a grammar-constrained local model gets the same tool as a cloud
 * one with nothing carried as encoded JSON (#359): every map the operation takes is a list of named rows here, and the
 * design is a flat list of nodes that name their children, so a design of any depth has the same, fixed-depth schema.
 */
import { z } from 'zod';
import type { EditOperation, Op } from '@shared/ops';
import type { ComponentDefinition, LinkValue, PropSchema, ProjectState, TokenGroup, UiStateSchema } from '@shared/types';
import { linkRels, withRels } from '@shared/link-rel';
import { APPEAR_PRESETS, COMPONENT_CATEGORIES, DIVIDER_SHAPES, ELEMENT_ACTIONS, OVERLAY_MODES, SLOT_PRIMITIVES, STYLE_SCOPES, STYLE_STATES } from '@shared/types';
import { TABLE_LIMITS } from '@engine/table';
import { MAX_CHOICES } from '@engine/values';
import { CONTAINER_SCOPE_HELP, STYLE_PROP_MAP } from '@shared/styles';
import { newId } from '@shared/ids';
import { projectDefinitionId } from '@shared/component-ids';
import { normalizeRoute } from '@shared/routes';
import { BACKGROUND_IMAGE, DIVIDER_SHAPE_TEXT, STYLE_TOKEN_REF, validateOperation } from '@shared/ops';
import { sha256Hex } from '@shared/sha256';
import { applyOperations } from '@engine/apply';
import type { EngineError } from '@engine/tree';
import { MAX_UI_STATES, acceptedTypes, checkPropName, declaredState, isProtoKey, normalizePropSchema, normalizeUiState, stateActionProblem, stateUsers, type BindField } from '@engine/schema';
import { normalizeLink } from '@engine/values';
import { fieldError, type FieldIssue, type MacroMemory } from './macros';
import type { JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';

/** The design node IDs the engine keeps (see DESIGN_NODE_ID in shared/ops.ts). */
const NODE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_ISSUES = 12;
const SCOPES = STYLE_SCOPES;
const STATES = STYLE_STATES;
const APPEARANCES = ['primary', 'secondary', 'text', 'light', 'link', 'plain'] as const;
const TOKEN_GROUPS = ['color', 'font', 'space', 'container', 'radius', 'shadow', 'border'] as const satisfies readonly TokenGroup[];
const CATEGORIES = COMPONENT_CATEGORIES.filter((c) => c !== 'shell') as unknown as [string, ...string[]];

const NODE_ID = z.string().min(1).max(64);
const NAME = z.string().min(1).max(40);
const SCALAR = z.union([z.string(), z.number(), z.boolean()]);
const IMAGE = z.object({ assetId: z.string().nullable().describe('An ID from search_assets, or null.'), alt: z.string().max(300) }).strict();
const LINK = z.string().max(500).describe('A route such as /contact/, an https:// URL, mailto:, tel: or #anchor; "" for none.');
const BINDING = [
  z.object({ $prop: z.string(), field: z.string().optional() }).strict(),
  z.object({ $item: z.string() }).strict()
] as const;
/** A literal, or the property ({"$prop"}) or list item field ({"$item"}) it shows. */
const bindable = <T extends z.ZodType>(literal: T) => z.union([literal, ...BINDING]);
/** What a condition reads: a property, a list item field, or one of the component's own UI state variables. */
const CONDITION_REF = [...BINDING, z.object({ $state: z.string() }).strict()] as const;
const CONDITION = z.union([...CONDITION_REF, z.object({ ref: z.union(CONDITION_REF), eq: SCALAR }).strict(), z.object({ ref: z.union(CONDITION_REF), ne: SCALAR }).strict()]);
/** What clicking a button does to the component's UI state. */
const STATE_ACTION = z
  .discriminatedUnion('op', [
    z.object({ op: z.literal('set'), state: z.string(), value: z.union([z.string(), z.boolean()]).describe('true or false for a yes/no state; an option value of a choice.') }).strict(),
    z.object({ op: z.literal('toggle'), state: z.string() }).strict(),
    z.object({ op: z.literal('next'), state: z.string(), wrap: z.boolean().optional() }).strict(),
    z.object({ op: z.literal('prev'), state: z.string(), wrap: z.boolean().optional() }).strict(),
    z.object({ op: z.literal('select'), state: z.string() }).strict()
  ])
  .describe("Sets a state, toggles a yes/no one, steps a choice or a list's active item to its next or prev (wrap: round to the other end), or (select, a button in a repeat of an item state's list) makes the button's own item the active one.");
/** One UI state variable: yes/no, or a choice between options. */
const STATE = z.discriminatedUnion('type', [
  z.object({ type: z.literal('boolean'), name: NAME.describe('camelCase, such as "open"; not a property name.'), label: z.string().min(1).max(80), initial: z.boolean().optional().describe('Defaults to false.') }).strict(),
  z
    .object({
      type: z.literal('enum'),
      name: NAME.describe('camelCase, such as "tab" or "billing"; not a property name.'),
      label: z.string().min(1).max(80),
      options: z.array(z.object({ value: z.string().min(1).max(60), label: z.string().min(1).max(80) }).strict()).min(2).max(50),
      initial: z.string().optional().describe('An option value; defaults to the first.')
    })
    .strict(),
  z
    .object({
      type: z.literal('item'),
      name: NAME.describe('camelCase, such as "activeStep"; not a property name.'),
      label: z.string().min(1).max(80),
      list: NAME.describe('The list property whose active item it holds.'),
      initial: z.number().int().min(0).optional().describe('The position of the item each placement starts at, from 0; defaults to the first.')
    })
    .strict()
]);
const STYLE_FIELDS = {
  property: z.string().describe('A style property such as layout, gap, columns, paddingBlock, background, color, textStyle, radius.'),
  value: z.union([z.string(), z.number(), z.boolean(), STYLE_TOKEN_REF, BACKGROUND_IMAGE]),
  scope: z.enum(SCOPES).optional().describe(`Screen size; "base" (the default) is every size. ${CONTAINER_SCOPE_HELP}`),
  state: z.enum(STATES).optional()
};
const STYLES = z.array(z.object(STYLE_FIELDS).strict()).max(80).optional();
const CONDITIONS = {
  when: CONDITION.optional().describe('Shown only while the property, item field or UI state ({"$state": name}) is set (a yes/no state on), or compared with eq / ne.'),
  unless: CONDITION.optional().describe('Hidden while it is set, or while the comparison holds.')
};
const CHILDREN = z.array(NODE_ID).max(200).optional().describe('IDs of the nodes inside it, in order.');
const NODE_HEAD = { id: NODE_ID.describe('Its ID in the design, such as "title" or "card".'), name: z.string().max(60).optional(), anchor: z.string().max(62).optional() };
const APPEAR = z.enum(APPEAR_PRESETS as unknown as [string, ...string[]]).optional().describe('How it enters when first scrolled into view.');

const NODE = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('element'),
      ...NODE_HEAD,
      tag: bindable(z.string()).optional().describe('section, div, header, ul, li, article… Defaults to div.'),
      children: CHILDREN,
      link: bindable(LINK).optional().describe('Makes the whole container one link (a card): nothing inside may be a link.'),
      ariaLabel: bindable(z.string()).optional(),
      collapseEmpty: z.boolean().optional().describe('Hidden when everything inside it is hidden.'),
      action: bindable(z.enum(ELEMENT_ACTIONS as unknown as [string, ...string[]])).optional().describe('What clicking it does: none, image (open its image full size) or link.'),
      carousel: z.literal(true).optional().describe('A list whose items scroll sideways as a carousel.'),
      interactionGroup: z
        .literal(true)
        .optional()
        .describe('An interaction group (a card): hovering it, or focus inside it, shows the groupHover and groupFocus styles of the nodes inside it.'),
      appear: APPEAR,
      overlay: z
        .enum(OVERLAY_MODES as unknown as [string, ...string[]])
        .optional()
        .describe('A div below the root shown only while a yes/no state is on (its one condition): a dialog or drawer over the page, opened and closed by that state\'s buttons.'),
      styles: STYLES,
      ...CONDITIONS
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      ...NODE_HEAD,
      tag: bindable(z.string()).optional().describe('h2, h3, p, span… Defaults to p.'),
      text: bindable(z.union([z.string(), z.array(z.string())])),
      rich: z.boolean().optional().describe('Rich text (paragraphs, lists, links), bound to a richtext property.'),
      datetime: bindable(z.string()).optional().describe('A YYYY-MM-DD date the text states, rendered as a <time>.'),
      styles: STYLES,
      ...CONDITIONS
    })
    .strict(),
  z.object({ kind: z.literal('image'), ...NODE_HEAD, image: bindable(IMAGE), fallbackAlt: bindable(z.string()).optional(), styles: STYLES, ...CONDITIONS }).strict(),
  z
    .object({
      kind: z.literal('link'),
      ...NODE_HEAD,
      link: bindable(LINK),
      label: bindable(z.string()),
      appearance: bindable(z.enum(APPEARANCES)).optional().describe('Button style; defaults to primary.'),
      icon: bindable(z.string()).optional(),
      ariaLabel: bindable(z.string()).optional(),
      stateAction: STATE_ACTION.optional(),
      styles: STYLES,
      ...CONDITIONS
    })
    .strict(),
  z.object({ kind: z.literal('icon'), ...NODE_HEAD, icon: bindable(z.string()), ariaLabel: bindable(z.string()).optional(), styles: STYLES, ...CONDITIONS }).strict(),
  z
    .object({
      kind: z.literal('divider'),
      ...NODE_HEAD,
      shape: z.enum(DIVIDER_SHAPES).optional().describe(DIVIDER_SHAPE_TEXT),
      icon: z.string().optional().describe('Shape "icon" only: the icon between the hairlines.'),
      styles: STYLES,
      ...CONDITIONS
    })
    .strict(),
  z
    .object({
      kind: z.literal('repeat'),
      ...NODE_HEAD,
      list: z.string().describe('The list property shown once per item; nodes inside show item fields with {"$item": field}.'),
      children: CHILDREN,
      appearStagger: z.boolean().optional(),
      filter: z
        .object({ field: z.string(), when: z.string().optional() })
        .strict()
        .optional()
        .describe('Category pills above the items: field, a text or choice item field; when, the yes/no property turning them on.'),
      ...CONDITIONS
    })
    .strict(),
  z
    .object({
      kind: z.literal('slot'),
      ...NODE_HEAD,
      slot: z.string().describe('The declared slot whose content shows here.'),
      children: CHILDREN.describe('Fallback: nodes shown here instead while a placement leaves the slot empty, such as a default badge.'),
      ...CONDITIONS
    })
    .strict()
]);

const PROP_HEAD = { name: NAME.describe('camelCase, such as "heading".'), label: z.string().min(1).max(80), description: z.string().max(300).optional() };
/** The single-value property types: a component property, or a field of a list item or of an object. */
const scalarProps = () =>
  [
    z.object({ type: z.literal('string'), ...PROP_HEAD, default: z.string().optional(), multiline: z.boolean().optional() }).strict(),
    z.object({ type: z.literal('richtext'), ...PROP_HEAD, default: z.union([z.string(), z.array(z.string())]).optional().describe('Paragraphs separated by a blank line; **bold**, *italic*, [label](/route/) and "- " list lines.') }).strict(),
    z.object({ type: z.literal('number'), ...PROP_HEAD, default: z.number().optional(), min: z.number().optional(), max: z.number().optional(), step: z.number().optional() }).strict(),
    z.object({ type: z.literal('boolean'), ...PROP_HEAD, default: z.boolean().optional() }).strict(),
    z.object({ type: z.literal('enum'), ...PROP_HEAD, options: z.array(z.object({ value: z.string().max(60), label: z.string().max(80) }).strict()).min(1).max(50), default: z.string().optional() }).strict(),
    z.object({ type: z.literal('link'), ...PROP_HEAD, default: LINK.optional() }).strict(),
    z.object({ type: z.literal('image'), ...PROP_HEAD, default: IMAGE.optional() }).strict(),
    z.object({ type: z.literal('icon'), ...PROP_HEAD, default: z.string().max(40).optional() }).strict(),
    z.object({ type: z.literal('token'), ...PROP_HEAD, tokenGroup: z.enum(TOKEN_GROUPS), default: z.string().optional().describe('A token ID of that group, such as color.brand.') }).strict(),
    z
      .object({ type: z.literal('choices'), ...PROP_HEAD, default: z.array(z.object({ label: z.string().max(200), value: z.string().max(200).optional() }).strict()).max(MAX_CHOICES).optional().describe('Answers a visitor picks from, in order.') })
      .strict()
  ] as const;
const FIELD = z.discriminatedUnion('type', [...scalarProps()]);
/** A list item's or an object's values, one row per field. */
const VALUES = z.array(z.object({ field: z.string(), value: z.union([z.string(), z.number(), z.boolean(), IMAGE]) }).strict()).max(20);
const PROPERTY = z.discriminatedUnion('type', [
  ...scalarProps(),
  z
    .object({
      type: z.literal('list'),
      ...PROP_HEAD,
      itemLabel: z.string().max(40).optional().describe('What one item is called, such as "Card".'),
      titleField: z.string().optional(),
      fields: z.array(FIELD).min(1).max(20),
      default: z.array(z.object({ id: z.string().optional(), values: VALUES }).strict()).max(50).optional().describe('The items a new placement starts with.'),
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(1).optional()
    })
    .strict(),
  z.object({ type: z.literal('object'), ...PROP_HEAD, fields: z.array(FIELD).min(1).max(20), default: VALUES.optional() }).strict(),
  z
    .object({
      type: z.literal('table'),
      ...PROP_HEAD,
      default: z
        .object({
          columns: z.array(z.string().max(TABLE_LIMITS.label)).min(1).max(TABLE_LIMITS.columns),
          rows: z.array(z.array(z.string().max(TABLE_LIMITS.cell)).max(TABLE_LIMITS.columns)).max(TABLE_LIMITS.rows)
        })
        .strict()
        .optional()
        .describe('Column names, then one row per entry with one text per column.')
    })
    .strict()
]);

export const MANAGED_COMPONENT_ARGS = z
  .object({
    definitionId: z.string().optional().describe('A project component to rebuild whole. Omit to create a new one.'),
    name: z.string().min(1).max(60),
    description: z.string().max(300).optional().describe('What it is for, as the Insert panel shows it.'),
    category: z.enum(CATEGORIES).optional(),
    tags: z.array(z.string().min(1).max(40)).max(12).optional(),
    insertAs: z.enum(['section', 'element']).optional().describe('"element" for a subcomponent that goes in slots and columns; "section" for a whole page section.'),
    properties: z.array(PROPERTY).max(60).optional().describe('What an author fills in on each placement, in order.'),
    nodes: z.array(NODE).min(1).max(300).optional().describe('Every node of the design. Exactly one is inside no other: the root element. Required unless repair.'),
    parts: z
      .array(z.object({ id: NAME, nodeId: NODE_ID, label: z.string().min(1).max(60), styleControls: z.array(z.string()).max(80).optional() }).strict())
      .max(30)
      .optional()
      .describe('Elements authors can style on each placement. "root" is always the root node.'),
    slots: z
      .array(
        z
          .object({
            name: NAME,
            label: z.string().min(1).max(60),
            description: z.string().max(300).optional(),
            categories: z.array(z.enum(COMPONENT_CATEGORIES as unknown as [string, ...string[]])).max(20).optional().describe('Component categories it takes.'),
            componentIds: z.array(z.string().min(1).max(120)).max(50).optional().describe('Components it takes by ID whatever their category: a contract ID such as "features.grid", or a project component\'s definition ID.'),
            primitives: z.array(z.enum(SLOT_PRIMITIVES as unknown as [string, ...string[]])).max(6).optional(),
            max: z.number().int().min(0).max(1000).optional()
          })
          .strict()
      )
      .max(10)
      .optional()
      .describe('Places each placement fills with content of its own; each is shown by one slot node.'),
    variantAxes: z
      .array(
        z
          .object({
            name: NAME.describe('camelCase, such as "tone" or "layout".'),
            label: z.string().min(1).max(40),
            default: z.string().optional().describe('The option placements show until they choose. Defaults to the first.'),
            options: z
              .array(
                z
                  .object({
                    id: z.string().min(1).max(40).describe('lowercase-with-hyphens, such as "dark".'),
                    label: z.string().min(1).max(60),
                    styles: z.array(z.object({ nodeId: NODE_ID, ...STYLE_FIELDS }).strict()).max(80).optional().describe('The rules this option adds, by node.')
                  })
                  .strict()
              )
              .min(1)
              .max(12)
          })
          .strict()
      )
      .max(4)
      .optional(),
    state: z
      .array(STATE)
      .max(MAX_UI_STATES)
      .optional()
      .describe('UI state each placement holds and its buttons change (stateAction), read by when/unless as {"$state": name}: tabs, a toggle, a dialog. Placements never set it.'),
    placeOnPage: z
      .object({ pageId: z.string().describe('A page ID or route.'), index: z.number().int().min(0).optional().describe('Among its sections; omit for the end.') })
      .strict()
      .optional()
      .describe('Also place it on this page, in the same step.'),
    repair: z
      .boolean()
      .optional()
      .describe('After an error: send name (and definitionId) with only the corrected nodes (by id) and properties (by name), and any other list to replace whole; the rest of the rejected call is kept.'),
    removeNodes: z.array(z.string()).max(100).optional().describe('With repair: node IDs to leave out of the rejected call.'),
    removeProperties: z.array(z.string()).max(60).optional().describe('With repair: property names to leave out of the rejected call.')
  })
  .strict();
export type ManagedComponentArgs = z.infer<typeof MANAGED_COMPONENT_ARGS>;
type NodeArgs = NonNullable<ManagedComponentArgs['nodes']>[number];
type PropertyArgs = NonNullable<ManagedComponentArgs['properties']>[number];
type FieldArgs = z.infer<typeof FIELD>;
type StyleRow = { property: string; value: unknown; scope?: (typeof SCOPES)[number]; state?: (typeof STATES)[number] };

/** The tool's parameter schema: closed and finite, with no map or open value anywhere. */
export function managedComponentSchema(): JsonSchema {
  // Repeated shapes (bindings, style rows, field types) are written once under $defs: there are no cycles, so the
  // strict form resolves every reference and a grammar sees one finite tree.
  const schema = z.toJSONSchema(MANAGED_COMPONENT_ARGS, { io: 'input', reused: 'ref' }) as JsonSchema;
  delete schema.$schema;
  return schema;
}

export const MANAGED_COMPONENT_DESCRIPTION =
  'Create a reusable managed component, or rebuild one (definitionId), in one call: its properties (what authors fill in on each placement), its design as a flat list of nodes that name their children by ID, the parts authors can style, slots, variant options and UI state. Bind a node to a property with {"$prop": name} ({"$prop": name, "field": f} for one field of an object property); inside a repeat of a list property, bind to each item\'s field with {"$item": field}. Style with site tokens such as {"token": "space.lg"} and add phone/tablet/desktop rules with scope. Interactive parts work in the published site with no code: declare UI state (a choice such as "plan" with options, or a yes/no "open"), give buttons a stateAction and link "", and show content only for one value with when. Tabs: a div holding nothing but one button per option (stateAction {"op": "set", "state": "plan", "value": option}), and one div panel per option with when {"ref": {"$state": "plan"}, "eq": option}. A toggle: a button with stateAction {"op": "toggle", "state": "open"} and content with when {"$state": "open"}; add overlay "dialog" or "drawer-end" to that div to show it over the page. Steps whose button shows their own text and picture from one list: an item state {"type": "item", "name": "active", "list": "steps"}; in a repeat of steps, a button with stateAction {"op": "select", "state": "active"} and a div with when {"$state": "active"}; a second repeat of steps (the picture side) whose div also has when {"$state": "active"}. A rebuild replaces the whole design and its UI state; placements keep the values the new properties still take. placeOnPage places it on a page in the same step. If anything is invalid nothing is applied and the error names each field by its path: call again with repair: true and only the corrected nodes (by id) and properties (by name).';

export const MANAGED_COMPONENT_BRIEF =
  'A whole reusable component in one call: properties authors fill in, nodes (a flat list; children name node IDs; one root element), parts, slots, variant options and UI state; definitionId rebuilds one whole. Bind with {"$prop": name}, or {"$item": field} inside a repeat of a list. Tabs: declare an enum state; a div holding only one button per option (stateAction set to the option, link ""); one div panel per option with when {"ref":{"$state":name},"eq":option}. A toggle: a toggle button and when {"$state":name}; overlay makes that div a dialog or drawer. Steps from one list: an item state (type "item", list); in each repeat of that list, a select button and divs with when {"$state":name}. Style with tokens such as {"token":"space.lg"}; scope adds phone/tablet/desktop rules. placeOnPage also places it. On an error nothing is applied: call again with repair: true and only the corrected nodes (by id) and properties (by name).';

// ---------------------------------------------------------------------------
// Running the tool
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A link a rebuild sends back in the string form read_component shows keeps what that form cannot say (a new tab, a
 * web address's relationships) while it still goes to the same place.
 */
function keptLinkOptions(link: LinkValue, was: unknown): LinkValue {
  if (!isRecord(was) || was.type !== link.type || was.target !== link.target || (was.anchor || undefined) !== link.anchor) return link;
  return withRels(was.newTab === true ? { ...link, newTab: true } : link, linkRels(was));
}

/** A zod issue path as the arguments are written: `nodes[3].text`. */
function pathOf(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, k) => (typeof k === 'number' ? `${out}[${k}]` : out ? `${out}.${String(k)}` : String(k)), '') || 'arguments';
}

/**
 * A zod issue as the problems a model can fix: a union the value matched none of is reported by the branch that got
 * furthest (an image whose alt is a number, not "matches no shape"), when one got past the value itself.
 */
function issueRows(issue: z.core.$ZodIssue, base: readonly PropertyKey[] = []): FieldIssue[] {
  const path = [...base, ...issue.path];
  const branches = issue.code === 'invalid_union' ? (issue as { errors?: z.core.$ZodIssue[][] }).errors : undefined;
  if (branches?.length) {
    const depth = (b: z.core.$ZodIssue[]) => Math.max(0, ...b.map((i) => i.path.length));
    const best = branches.filter((b) => b.length).sort((a, b) => depth(b) - depth(a) || a.length - b.length)[0];
    if (best && depth(best) > 0) return best.flatMap((i) => issueRows(i, path));
  }
  return [{ field: pathOf(path), message: issue.message }];
}

/** The key of a row a repair addresses: a node's id or a property's name. Rows without one cannot be addressed. */
const keyOf = (row: unknown, key: string): string | undefined => (isRecord(row) && typeof row[key] === 'string' ? (row[key] as string) : undefined);

/**
 * A rejected call's rows with a repair's applied: each row sent replaces every held row with its key (so a key that
 * was given twice is left once), a new key is added at the end, and `removed` keys go. A held row with no key stays as
 * it was (a property dropped unseen would take its values from every placement): only a whole call replaces it.
 */
function mergeRows(held: unknown, sent: unknown, key: string, removed: ReadonlySet<string>): unknown {
  // Something that is not a list stays as it was sent, for the argument check to name: never read as an empty list.
  if (sent !== undefined && !Array.isArray(sent)) return sent;
  if (!Array.isArray(held)) return sent === undefined ? held : sent;
  const out = held.filter((r) => {
    const k = keyOf(r, key);
    return k === undefined || !removed.has(k);
  });
  for (const row of (sent as unknown[] | undefined) ?? []) {
    const k = keyOf(row, key);
    const first = k === undefined ? -1 : out.findIndex((h) => keyOf(h, key) === k);
    if (first < 0) {
      out.push(row);
      continue;
    }
    out[first] = row;
    for (let i = out.length - 1; i > first; i--) if (keyOf(out[i], key) === k) out.splice(i, 1);
  }
  return out;
}

const REPAIR_KEYS = new Set(['repair', 'removeNodes', 'removeProperties', 'nodes', 'properties']);
/** Checked before a repair uses them: a list of names, or nothing. */
const names = (v: unknown, max: number): v is string[] | undefined => v === undefined || (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string'));

function mergeRepair(held: Record<string, unknown>, sent: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...held };
  for (const [k, v] of Object.entries(sent)) if (!REPAIR_KEYS.has(k) && v !== undefined) out[k] = v;
  if (held.nodes !== undefined || sent.nodes !== undefined) out.nodes = mergeRows(held.nodes, sent.nodes, 'id', new Set((sent.removeNodes as string[] | undefined) ?? []));
  if (held.properties !== undefined || sent.properties !== undefined) out.properties = mergeRows(held.properties, sent.properties, 'name', new Set((sent.removeProperties as string[] | undefined) ?? []));
  return out;
}

/** Which component a call is about: the one it rebuilds, or a new one by its name. */
const draftKey = (a: Record<string, unknown>) => (typeof a.definitionId === 'string' ? `id:${a.definitionId}` : `new:${typeof a.name === 'string' ? a.name.trim().toLowerCase() : ''}`);
/** The component a rebuild was described against, so a repair never applies a description made before it changed. */
const targetOf = (state: ProjectState, a: Record<string, unknown>): string | null =>
  typeof a.definitionId === 'string' && Object.hasOwn(state.components, a.definitionId) ? sha256Hex(JSON.stringify(state.components[a.definitionId])) : null;

const NOTHING_APPLIED =
  'Nothing was applied. Call again with repair: true, the same name (and definitionId), and only what needs fixing: the corrected nodes (by id) and properties (by name), removeNodes or removeProperties for any to leave out, and any other list to replace whole.';
const SEND_WHOLE = 'Send the whole component, without repair.';

export async function runManagedComponent(raw: unknown, host: ToolHost, callId: string, memory: MacroMemory): Promise<ToolOutcome> {
  // Named with the tool, so another tool's call ID is never taken as this one's.
  const fingerprint = JSON.stringify(['upsert_managed_component', raw]);
  const prior = memory.replay.get(callId);
  if (prior) {
    if (prior.args === fingerprint) return { ok: prior.ok, content: prior.content };
    return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'That tool call ID was already used for a different request.' } };
  }
  const outcome = await compileAndApply(raw, host, callId, memory);
  memory.replay.set(callId, { args: fingerprint, ok: outcome.ok, content: outcome.content });
  return outcome;
}

async function compileAndApply(raw: unknown, host: ToolHost, callId: string, memory: MacroMemory): Promise<ToolOutcome> {
  if (!isRecord(raw)) return fieldError([{ field: 'arguments', message: 'expected an object' }], 'Nothing was applied.');
  // Anything but a plain true or false would be taken for a whole new description, losing what a repair keeps.
  if (raw.repair !== undefined && typeof raw.repair !== 'boolean') return fieldError([{ field: 'repair', message: 'expected true or false' }], 'Nothing was applied.');
  for (const [k, max] of [['removeNodes', 100], ['removeProperties', 60]] as const) {
    if (raw[k] === undefined) continue;
    if (raw.repair !== true) return fieldError([{ field: k, message: 'only with repair: true' }], 'Nothing was applied.');
    if (!names(raw[k], max)) return fieldError([{ field: k, message: `expected a list of up to ${max} names` }], 'Nothing was applied.');
  }
  // Read below before the arguments are checked: anything but text is the arguments' to name, never a crash here.
  for (const k of ['name', 'definitionId'] as const)
    if (raw[k] !== undefined && typeof raw[k] !== 'string') return fieldError([{ field: k, message: 'expected text' }], 'Nothing was applied.');
  const state = host.state();
  const drafts = (memory.componentDrafts ??= new Map());
  let given = raw;
  let target = targetOf(state, raw);
  let from: string | null = null;
  if (raw.repair === true) {
    // A rebuild is repaired by its definitionId, a new component by its name: never another component's call.
    from = draftKey(raw);
    const draft = drafts.get(from);
    if (!draft)
      return fieldError(
        [{ field: 'repair', message: `there is no rejected call ${raw.definitionId !== undefined ? `rebuilding "${raw.definitionId as string}"` : `creating "${(raw.name as string | undefined) ?? ''}"`} to repair. A rebuild's repair names its definitionId` }],
        SEND_WHOLE
      );
    if (draft.target !== targetOf(state, draft.args)) {
      drafts.delete(from);
      return fieldError([{ field: 'repair', message: `"${typeof draft.args.name === 'string' ? draft.args.name : ''}" changed since that call was rejected` }], `Read it again and ${SEND_WHOLE.charAt(0).toLowerCase()}${SEND_WHOLE.slice(1)}`);
    }
    given = mergeRepair(draft.args, raw);
    target = draft.target;
  }
  // Whatever is sent is held until it applies, so the next call can repair only what this one names.
  const { repair: _r, removeNodes: _n, removeProperties: _p, ...held } = given;
  if (from) drafts.delete(from);
  drafts.set(draftKey(held), { args: held, target });
  const parsed = MANAGED_COMPONENT_ARGS.safeParse(held);
  if (!parsed.success) {
    const rows = parsed.error.issues.flatMap((i) => issueRows(i)).slice(0, MAX_ISSUES);
    // A row missing the id or name a repair addresses it by can only be replaced by a whole call.
    for (const r of rows) {
      const m = /^(nodes|properties)\[(\d+)\]\.(id|name)$/.exec(r.field);
      const row = m && Array.isArray(held[m[1]]) ? (held[m[1]] as unknown[])[Number(m[2])] : undefined;
      if (m && keyOf(row, m[3]) === undefined) r.message += `. A row without its ${m[3]} cannot be repaired by it: send the whole component again, without repair`;
    }
    return fieldError(rows, NOTHING_APPLIED);
  }
  const compiled = compile(state, parsed.data);
  if ('issues' in compiled) return fieldError(compiled.issues.slice(0, MAX_ISSUES), NOTHING_APPLIED);
  const { op, place, index } = compiled;
  const ops: EditOperation[] = place ? [op, place] : [op];
  // What the session checks every operation for (reserved names, the operation's own schema), named where it can be.
  for (const o of ops) {
    const v = validateOperation(o);
    if (v.ok) continue;
    const node = /^nodes\.(\d+)/.exec(v.message)?.[1];
    return fieldError([{ field: o === place ? 'placeOnPage' : node !== undefined ? `nodes[${node}]` : 'arguments', message: v.message }], NOTHING_APPLIED);
  }

  // The engine checks the description as the finished component: run it on a copy first, alone so a problem it finds
  // is named by the field it came from, then with its placement, as the session will apply them, so what only the two
  // together break (a list item placed straight on a page) is named by placeOnPage.
  const failure = (e: unknown, placing: boolean) => {
    const details = (e as EngineError).details;
    const owner = isRecord(details) && isRecord(details.owner) ? details.owner.kind : undefined;
    // Alone, a page's problem is an existing placement the design no longer fits; only what the placement adds fails
    // with it, and is the placement's unless it names a node of the design.
    const field = owner === 'page' ? (placing ? 'placeOnPage' : 'nodes') : placing && owner !== 'component' ? 'placeOnPage' : index.locate((e as Error).message, details);
    return fieldError([{ field, message: (e as Error).message }], NOTHING_APPLIED);
  };
  try {
    applyOperations(state, [op]);
  } catch (e) {
    return failure(e, false);
  }
  if (place) {
    try {
      applyOperations(state, ops);
    } catch (e) {
      return failure(e, true);
    }
  }

  const label = `${op.definitionId ? 'Rebuild' : 'Build'} ${op.name}`;
  const res = await host.apply(ops, host.revision(), label, callId);
  if (!res.ok) return { ok: false, content: { ok: false, revision: res.revision, error: res.error, note: NOTHING_APPLIED } };
  drafts.delete(draftKey(held));
  const made = (res.results?.[0] ?? {}) as { definitionId?: string; rootNodeId?: string };
  const placed = place ? ((res.results?.[1] ?? {}) as { nodeId?: string }) : null;
  const definitionId = made.definitionId ?? op.definitionId ?? op.newDefinitionId;
  return {
    ok: true,
    mutated: true,
    ops,
    results: res.results,
    content: {
      ok: true,
      revision: res.revision,
      definitionId,
      rootNodeId: made.rootNodeId,
      ...(placed && place ? { placed: { pageId: place.owner.id, nodeId: placed.nodeId ?? place.newNodeId } } : {}),
      note: `Change it again with this tool and definitionId "${definitionId}", which replaces the whole design.`
    }
  };
}

// ---------------------------------------------------------------------------
// Compiling the arguments to the operation
// ---------------------------------------------------------------------------

/** Where each name in the arguments was given, so an engine message that quotes one is named by its field. */
interface SourceIndex {
  /** `details`: what the engine names beside its message, such as the design node a tag check found out of place. */
  locate(message: string, details?: unknown): string;
}

type Compiled = { op: Op<'component.upsert'>; place: Op<'node.insert'> | null; index: SourceIndex } | { issues: FieldIssue[] };

const BINDABLE: Partial<Record<NodeArgs['kind'], BindField[]>> = {
  element: ['tag', 'link', 'ariaLabel', 'action'],
  text: ['tag', 'text', 'datetime'],
  image: ['image', 'fallbackAlt'],
  link: ['link', 'label', 'appearance', 'icon', 'ariaLabel'],
  icon: ['icon', 'ariaLabel']
};

/** Names the session refuses anywhere in an operation (see validateOperation), beside those every object has. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** A name used as a key that every object already has (constructor, __proto__), or `prototype`: refused, as the engine refuses it. */
function reservedKey(key: string, field: string, issues: FieldIssue[]): boolean {
  if (!isProtoKey(key) && !FORBIDDEN_KEYS.has(key)) return false;
  issues.push({ field, message: `"${key}" is a reserved name. Choose another` });
  return true;
}

const isBindingValue = (v: unknown): v is { $prop: string; field?: string } | { $item: string } => isRecord(v) && (typeof v.$prop === 'string' || typeof v.$item === 'string');

/** A page by its ID or its route. */
function pageFor(state: ProjectState, ref: string): string | null {
  if (Object.hasOwn(state.pages, ref)) return ref;
  if (!ref.trim()) return null;
  const route = normalizeRoute(ref.trim());
  return Object.values(state.pages).find((p) => p.route === route)?.id ?? null;
}

function compile(state: ProjectState, args: ManagedComponentArgs): Compiled {
  const issues: FieldIssue[] = [];
  const nodes = args.nodes ?? [];
  if (!nodes.length) issues.push({ field: 'nodes', message: 'a component needs its design: at least one node, its root' });

  // A rebuild keeps what this tool cannot say about a property or slot it keeps (a list filled from the site's pages,
  // a page list's card fields, a rich text's list kind, an Inspector group, the categories a slot takes), rather than
  // dropping it unseen.
  const was = args.definitionId !== undefined && Object.hasOwn(state.components, args.definitionId) ? state.components[args.definitionId] : undefined;

  // Properties: each checked as the engine will store it, so a problem is named by its row and field.
  const props = new Map<string, { at: number; schema: PropSchema }>();
  const properties: Record<string, unknown> = {};
  (args.properties ?? []).forEach((p, i) => {
    const at = `properties[${i}]`;
    if (reservedKey(p.name, `${at}.name`, issues)) return;
    if (props.has(p.name) || Object.hasOwn(properties, p.name)) return issues.push({ field: `${at}.name`, message: `"${p.name}" is already the name of properties[${props.get(p.name)?.at ?? '?'}]` });
    try {
      checkPropName(p.name);
    } catch (e) {
      return issues.push({ field: `${at}.name`, message: (e as Error).message });
    }
    const sent = propertySchema(p, at, issues);
    if (!sent) return;
    const old = was && Object.hasOwn(was.properties, p.name) ? (was.properties[p.name] as unknown as Record<string, unknown>) : undefined;
    const kept = old?.type === p.type ? keptSettings(old, restoreClipped(sent, old)) : sent;
    const carried = KEPT_PROPERTY_KEYS.filter((k) => Object.hasOwn(kept, k) && !Object.hasOwn(sent, k));
    properties[p.name] = kept;
    try {
      props.set(p.name, { at: i, schema: normalizePropSchema(kept, state, p.name) });
    } catch (e) {
      // What it kept no longer fits the fields this call gives it: said, never dropped unseen (a list filled from the
      // site's pages would become an empty list on every placement).
      const why = carried.length ? ` It keeps ${carried.join(' and ')} from the component as it is, which this tool cannot change: keep the fields that needs, or give the property a new name.` : '';
      issues.push({ field: propertyField(p, at, (e as Error).message), message: `${(e as Error).message}${why}` });
    }
  });

  // UI state: each variable settled as the engine will store it, so a problem is named by its row.
  const uiState: Record<string, UiStateSchema> = {};
  // Rows refused here are reported once, on the row: not again by every node that uses them.
  const refusedStates = new Set<string>();
  (args.state ?? []).forEach((st, i) => {
    const at = `state[${i}]`;
    if (reservedKey(st.name, `${at}.name`, issues)) return refusedStates.add(st.name);
    if (Object.hasOwn(uiState, st.name)) return issues.push({ field: `${at}.name`, message: `"${st.name}" is listed twice` });
    if (Object.hasOwn(properties, st.name)) {
      refusedStates.add(st.name);
      return issues.push({ field: `${at}.name`, message: `"${st.name}" is already a property. UI state needs a name of its own` });
    }
    try {
      checkPropName(st.name, 'State');
    } catch (e) {
      refusedStates.add(st.name);
      return issues.push({ field: `${at}.name`, message: (e as Error).message });
    }
    try {
      uiState[st.name] = normalizeUiState(st, st.name);
    } catch (e) {
      refusedStates.add(st.name);
      const message = (e as Error).message;
      issues.push({ field: /starts (as|at)/.test(message) ? `${at}.initial` : /option/.test(message) ? `${at}.options` : /"list"/.test(message) ? `${at}.list` : at, message });
    }
  });
  // Left out of a rebuild, the component keeps the state its design does not use, which the new design may read; state
  // its design uses must be described again, so working tabs or toggles are never dropped unseen.
  const known: Record<string, UiStateSchema> = args.state !== undefined ? uiState : {};
  if (args.state === undefined && was?.state && typeof was.state === 'object' && !Array.isArray(was.state)) {
    const used = Object.keys(was.state).filter((name) => stateUsers(was, name).length);
    if (used.length) issues.push({ field: 'state', message: `"${was.name}" has UI state its design reads or its buttons change (${used.join(', ')}). Send state again with the rebuild; an empty list removes it` });
    for (const name of Object.keys(was.state)) {
      const kept = declaredState(was, name);
      if (kept && !Object.hasOwn(properties, name)) known[name] = kept;
    }
  }
  const stateNames = () => (Object.keys(known).length ? ` (${Object.keys(known).join(', ')})` : '. Declare it in state');
  /** A condition that reads UI state: state the call declares, compared (if at all) with a value it can hold. */
  const checkStateCondition = (v: unknown, name: string, at: string, id: string) => {
    const s = Object.hasOwn(known, name) ? known[name] : undefined;
    if (refusedStates.has(name)) return;
    if (!s) return issues.push({ field: at, message: `"${id}" reads the UI state "${name}", which is not one of the state${stateNames()}` });
    if (s.type === 'item' && isRecord(v) && 'ref' in v) return issues.push({ field: at, message: `"${name}" is the active item of a list: read it plainly, {"$state": "${name}"}, as whether this item is the active one` });
    if (!isRecord(v) || !('ref' in v)) return;
    const key = 'eq' in v ? 'eq' : 'ne';
    const value = v[key];
    if (s.type === 'boolean' && typeof value !== 'boolean') issues.push({ field: `${at}.${key}`, message: `"${name}" is yes/no: compare it with true or false` });
    if (s.type === 'enum' && !(typeof value === 'string' && s.options.some((o) => o.value === value)))
      issues.push({ field: `${at}.${key}`, message: `${JSON.stringify(value)} is not one of the options of "${name}" (${s.options.map((o) => o.value).join(', ')})` });
  };

  // The design: one tree under one root, every node in one place.
  const byId = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (!NODE_ID_RE.test(n.id)) issues.push({ field: `nodes[${i}].id`, message: 'use a letter, then letters, numbers, - or _ (up to 64)' });
    else if (reservedKey(n.id, `nodes[${i}].id`, issues)) return;
    else if (byId.has(n.id)) issues.push({ field: `nodes[${i}].id`, message: `"${n.id}" is already the ID of nodes[${byId.get(n.id)}]. Give each node an ID of its own` });
    else byId.set(n.id, i);
  });
  const parentOf = new Map<string, string>();
  nodes.forEach((n, i) => {
    if (n.kind !== 'element' && n.kind !== 'repeat' && n.kind !== 'slot') return;
    (n.children ?? []).forEach((c, j) => {
      const at = `nodes[${i}].children[${j}]`;
      if (!byId.has(c)) issues.push({ field: at, message: `"${c}" is not the id of any node` });
      else if (c === n.id) issues.push({ field: at, message: `"${n.id}" cannot be inside itself` });
      else if (parentOf.has(c)) issues.push({ field: at, message: `"${c}" is already inside "${parentOf.get(c)}". A node goes in one place` });
      else parentOf.set(c, n.id);
    });
  });
  const roots = nodes.filter((n) => byId.get(n.id) !== undefined && !parentOf.has(n.id));
  if (nodes.length && !roots.length) issues.push({ field: 'nodes', message: 'every node is inside another, so there is no root. Leave the root out of every children list' });
  for (const extra of roots.slice(1))
    issues.push({ field: `nodes[${byId.get(extra.id)}]`, message: `"${extra.id}" is inside no other node, but "${roots[0].id}" is already the root. Add it to the children of the node it belongs in` });

  // The list each node repeats over: the nearest repeat around it.
  const nodeAt = (id: string) => nodes[byId.get(id)!];
  const listAround = (id: string): string | null => {
    for (let p = parentOf.get(id), guard = 0; p !== undefined && guard <= nodes.length; p = parentOf.get(p), guard++) {
      const outer = nodeAt(p);
      if (outer?.kind === 'repeat') return outer.list;
    }
    return null;
  };
  const itemFields = (list: string | null) => {
    const s = list ? props.get(list)?.schema : undefined;
    return s?.type === 'list' ? s.fields : null;
  };
  /** The property or item field a binding shows, or null (with the problem noted) when there is none. */
  const checkBinding = (b: { $prop: string; field?: string } | { $item: string }, at: string, id: string): PropSchema | null => {
    if ('$prop' in b) {
      const p = props.get(b.$prop)?.schema;
      if (!p) {
        if (!Object.hasOwn(properties, b.$prop)) issues.push({ field: at, message: `"${id}" shows "${b.$prop}", which is not one of the properties${props.size ? ` (${[...props.keys()].join(', ')})` : ''}` });
        return null;
      }
      if (b.field === undefined) return p;
      if (p.type !== 'object') {
        issues.push({ field: at, message: `"${b.$prop}" is not an object property, so it has no field "${b.field}"` });
        return null;
      }
      const f = Object.hasOwn(p.fields, b.field) ? p.fields[b.field] : undefined;
      if (!f) issues.push({ field: at, message: `"${b.$prop}" has no field "${b.field}". Fields: ${Object.keys(p.fields).join(', ')}` });
      return f ?? null;
    }
    const list = listAround(id);
    const fields = itemFields(list);
    if (!list) {
      issues.push({ field: at, message: `"${id}" shows the item field "${b.$item}" outside any repeat` });
      return null;
    }
    if (!fields) return null;
    const f = Object.hasOwn(fields, b.$item) ? fields[b.$item] : undefined;
    if (!f) issues.push({ field: at, message: `"${list}" items have no field "${b.$item}". Fields: ${Object.keys(fields).join(', ')}` });
    return f ?? null;
  };

  const slotsShown = new Map<string, string>();
  const designNodes = nodes.map((n, i) => {
    const at = `nodes[${i}]`;
    const out: Record<string, unknown> = { ...n };
    // A text a rebuild sends back as read_component shortened it keeps its whole text.
    const prev = was?.tree && Object.hasOwn(was.tree.nodes, n.id) ? (was.tree.nodes[n.id] as unknown as Record<string, unknown>) : undefined;
    if (prev?.kind === 'text' && n.kind === 'text') out.text = unclip(n.text, prev.text);
    for (const field of BINDABLE[n.kind] ?? []) {
      const v = (n as Record<string, unknown>)[field];
      if (v === undefined) continue;
      if (isBindingValue(v)) {
        const schema = checkBinding(v, `${at}.${field}`, n.id);
        const ok = schema ? acceptedTypes({ kind: n.kind, rich: n.kind === 'text' ? n.rich : undefined } as never, field) : null;
        if (schema && ok && !ok.includes(schema.type)) issues.push({ field: `${at}.${field}`, message: `"${n.id}" cannot show a ${schema.type} property as its ${field}: it needs a ${ok.join(' or ')}` });
        continue;
      }
      // A link is written as a route, URL or address here, and stored as the link it names.
      if (field === 'link' && typeof v === 'string') {
        try {
          out.link = keptLinkOptions(normalizeLink(v, state, `${at}.link`), prev?.link);
        } catch (e) {
          issues.push({ field: `${at}.link`, message: (e as Error).message });
        }
      }
    }
    for (const c of ['when', 'unless'] as const) {
      const v = n[c];
      if (v === undefined) continue;
      const ref: unknown = isRecord(v) && 'ref' in v ? v.ref : v;
      if (isRecord(ref) && typeof ref.$state === 'string') checkStateCondition(v, ref.$state, `${at}.${c}`, n.id);
      else checkBinding(ref as Parameters<typeof checkBinding>[0], `${at}.${c}`, n.id);
    }
    // A button's state action changes state the call declares, in a way that state can change.
    if (n.kind === 'link' && n.stateAction && !refusedStates.has(n.stateAction.state)) {
      const problem = stateActionProblem({ state: known, properties } as unknown as ComponentDefinition, n.stateAction);
      if (problem) issues.push({ field: `${at}.stateAction`, message: `"${n.id}" ${problem}` });
    }
    if (n.kind === 'repeat') {
      const p = props.get(n.list)?.schema;
      if (!p && !Object.hasOwn(properties, n.list)) issues.push({ field: `${at}.list`, message: `"${n.list}" is not one of the properties. Add a list property for the items` });
      else if (p && p.type !== 'list') issues.push({ field: `${at}.list`, message: `"${n.list}" is a ${p.type} property, not a list` });
    }
    if (n.kind === 'slot') {
      if (!(args.slots ?? []).some((s) => s.name === n.slot)) issues.push({ field: `${at}.slot`, message: `"${n.slot}" is not one of the slots. Declare it in slots` });
      else if (slotsShown.has(n.slot)) issues.push({ field: `${at}.slot`, message: `the slot "${n.slot}" is already shown by "${slotsShown.get(n.slot)}". Each slot is shown once` });
      else slotsShown.set(n.slot, n.id);
    }
    if ('styles' in n && n.styles) {
      const styles = styleRules(n.styles, `${at}.styles`, issues);
      if (styles) out.styles = styles;
      else delete out.styles;
    }
    return out;
  });

  // Parts, slots and variant options: lists of named rows here, maps in the operation.
  const parts: Record<string, unknown> = {};
  (args.parts ?? []).forEach((p, i) => {
    const at = `parts[${i}]`;
    if (reservedKey(p.id, `${at}.id`, issues)) return;
    if (Object.hasOwn(parts, p.id)) return issues.push({ field: `${at}.id`, message: `"${p.id}" is listed twice` });
    if (!byId.has(p.nodeId)) issues.push({ field: `${at}.nodeId`, message: `"${p.nodeId}" is not the id of any node` });
    else if (p.id === 'root' && roots.length === 1 && p.nodeId !== roots[0].id) issues.push({ field: `${at}.nodeId`, message: `the root part is always the root node, "${roots[0].id}"` });
    const bad = (p.styleControls ?? []).filter((s) => !Object.hasOwn(STYLE_PROP_MAP, s));
    if (bad.length) issues.push({ field: `${at}.styleControls`, message: `unknown style properties: ${bad.join(', ')}` });
    parts[p.id] = { nodeId: p.nodeId, label: p.label, ...(p.styleControls ? { styleControls: p.styleControls } : {}) };
  });
  const slots: Record<string, unknown> = {};
  (args.slots ?? []).forEach((s, i) => {
    const at = `slots[${i}]`;
    if (reservedKey(s.name, `${at}.name`, issues)) return;
    if (Object.hasOwn(slots, s.name)) return issues.push({ field: `${at}.name`, message: `"${s.name}" is listed twice` });
    if (!slotsShown.has(s.name)) issues.push({ field: at, message: `no slot node shows "${s.name}", so content put there would never appear. Add a node { "kind": "slot", "slot": "${s.name}" }` });
    const { name: _n, ...rest } = s;
    const old = was?.slots && Object.hasOwn(was.slots, s.name) ? was.slots[s.name] : undefined;
    slots[s.name] = { ...rest, ...(old?.categories && rest.categories === undefined ? { categories: old.categories } : {}), ...(old?.componentIds && rest.componentIds === undefined ? { componentIds: old.componentIds } : {}) };
  });
  const variantAxes: Record<string, unknown> = {};
  (args.variantAxes ?? []).forEach((a, i) => {
    const at = `variantAxes[${i}]`;
    if (reservedKey(a.name, `${at}.name`, issues)) return;
    if (Object.hasOwn(variantAxes, a.name)) return issues.push({ field: `${at}.name`, message: `"${a.name}" is listed twice` });
    const options: Record<string, unknown> = {};
    a.options.forEach((o, j) => {
      const oat = `${at}.options[${j}]`;
      if (reservedKey(o.id, `${oat}.id`, issues)) return;
      if (Object.hasOwn(options, o.id)) return issues.push({ field: `${oat}.id`, message: `"${o.id}" is listed twice` });
      const byNode: Record<string, StyleRow[]> = {};
      (o.styles ?? []).forEach((r, k) => {
        if (!byId.has(r.nodeId)) issues.push({ field: `${oat}.styles[${k}].nodeId`, message: `"${r.nodeId}" is not the id of any node` });
        else (byNode[r.nodeId] ??= []).push(r);
      });
      const styles: Record<string, unknown> = {};
      for (const [nodeId, rows] of Object.entries(byNode)) {
        const rules = styleRules(rows, `${oat}.styles`, issues, (o.styles ?? []).map((r, k) => (r.nodeId === nodeId ? k : -1)).filter((k) => k >= 0));
        if (rules) styles[nodeId] = rules;
      }
      options[o.id] = { label: o.label, ...(Object.keys(styles).length ? { styles } : {}) };
    });
    if (a.default !== undefined && !a.options.some((o) => o.id === a.default)) issues.push({ field: `${at}.default`, message: `"${a.default}" is not one of its options (${a.options.map((o) => o.id).join(', ')})` });
    variantAxes[a.name] = { label: a.label, ...(a.default !== undefined ? { default: a.default } : {}), options };
  });

  // The placement: a page of the site, at a place among its sections.
  let place: Op<'node.insert'> | null = null;
  if (args.placeOnPage) {
    const pageId = pageFor(state, args.placeOnPage.pageId);
    if (!pageId) issues.push({ field: 'placeOnPage.pageId', message: `there is no page "${args.placeOnPage.pageId}". Use a page ID or route from read_project` });
    else {
      const count = state.pages[pageId].rootIds.length;
      const at = args.placeOnPage.index;
      if (at !== undefined && at > count) issues.push({ field: 'placeOnPage.index', message: `the page has ${count} sections: use 0 to ${count}, or leave it out for the end` });
      place = { type: 'node.insert', newNodeId: newId('n'), owner: { kind: 'page', id: pageId }, parentId: null, ...(at !== undefined ? { index: at } : {}), definitionId: '' };
    }
  }
  if (issues.length) return { issues };

  const definitionId = args.definitionId ?? projectDefinitionId(args.name);
  const op: Op<'component.upsert'> = {
    type: 'component.upsert',
    ...(args.definitionId !== undefined ? { definitionId: args.definitionId } : { newDefinitionId: definitionId }),
    name: args.name,
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.category !== undefined ? { category: args.category } : {}),
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    ...(args.insertAs !== undefined ? { insertAs: args.insertAs } : {}),
    properties,
    nodes: designNodes as Op<'component.upsert'>['nodes'],
    ...(args.parts !== undefined ? { parts: parts as Op<'component.upsert'>['parts'] } : {}),
    ...(args.slots !== undefined ? { slots: slots as Op<'component.upsert'>['slots'] } : {}),
    ...(args.variantAxes !== undefined ? { variantAxes: variantAxes as Op<'component.upsert'>['variantAxes'] } : {}),
    // Left out, a rebuild keeps state its design does not use; an empty list removes it.
    ...(args.state !== undefined ? { state: uiState } : {})
  };
  if (place) place.definitionId = definitionId;
  return { op, place, index: sourceIndex(args) };
}

/** What a property, or a field of a list or object, keeps through a rebuild that this tool has no field for. */
const KEPT_PROPERTY_KEYS = ['group', 'feed', 'pageTeaser', 'plainAs', 'codeForm'] as const;

/** `sent` with the settings `old` had that this tool cannot give, its fields' included, where `sent` names none. */
function keptSettings(old: Record<string, unknown>, sent: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...sent };
  for (const k of KEPT_PROPERTY_KEYS) if (Object.hasOwn(old, k) && !Object.hasOwn(out, k)) out[k] = old[k];
  const was = isRecord(old.fields) ? old.fields : undefined;
  if (was && isRecord(sent.fields))
    out.fields = Object.fromEntries(
      Object.entries(sent.fields).map(([k, f]) => {
        const prev = Object.hasOwn(was, k) ? was[k] : undefined;
        return [k, isRecord(prev) && isRecord(f) && prev.type === f.type ? keptSettings(prev, f) : f];
      })
    );
  return out;
}

/** How read_component shortens a long text it shows (see summarizeValue in context.ts): to this length, ending in …. */
const SHOWN_CHARS = 220;
/** A text sent back as a read shortened it: the stored whole text it stands for, else what was sent. */
function unclip(sent: unknown, stored: unknown): unknown {
  return typeof sent === 'string' && sent.length === SHOWN_CHARS && sent.endsWith('…') && typeof stored === 'string' && stored.length > SHOWN_CHARS && stored.startsWith(sent.slice(0, -1)) ? stored : sent;
}

/** A property's default, its list items' (by ID) and its object's values, with texts sent back shortened made whole. */
function restoreClipped(sent: Record<string, unknown>, old: Record<string, unknown>): Record<string, unknown> {
  const given = sent.default;
  if (given === undefined) return sent;
  if (typeof given === 'string') return { ...sent, default: unclip(given, old.default) };
  const values = (v: Record<string, unknown>, was: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unclip(x, was[k])]));
  if (Array.isArray(given) && Array.isArray(old.default)) {
    const byId = new Map(old.default.filter(isRecord).map((item) => [item.id, item]));
    return { ...sent, default: given.map((item) => (isRecord(item) && typeof item.id === 'string' && byId.has(item.id) ? values(item, byId.get(item.id)!) : item)) };
  }
  if (isRecord(given) && isRecord(old.default)) return { ...sent, default: values(given, old.default) };
  return sent;
}

/** The property's schema as the operation takes it, its rows turned back into maps. */
function propertySchema(p: PropertyArgs, at: string, issues: FieldIssue[]): Record<string, unknown> | null {
  const { name: _n, default: given, ...rest } = p as PropertyArgs & { default?: unknown };
  const out: Record<string, unknown> = { ...rest };
  if (p.type === 'list' || p.type === 'object') {
    const fields: Record<string, unknown> = {};
    let ok = true;
    p.fields.forEach((f: FieldArgs, j: number) => {
      if (reservedKey(f.name, `${at}.fields[${j}].name`, issues)) return (ok = false);
      if (Object.hasOwn(fields, f.name)) {
        ok = false;
        return issues.push({ field: `${at}.fields[${j}].name`, message: `"${f.name}" is listed twice` });
      }
      const { name: _f, ...schema } = f;
      fields[f.name] = withScalarDefault(schema);
    });
    out.fields = fields;
    if (given !== undefined) {
      if (p.type === 'list') {
        out.default = p.default!.map((item, k) => {
          const values = rowValues(item.values, fields, `${at}.default[${k}].values`, issues);
          if (!values) ok = false;
          return { ...(item.id !== undefined ? { id: item.id } : {}), ...values };
        });
      } else {
        const values = rowValues(p.default!, fields, `${at}.default`, issues);
        if (!values) ok = false;
        out.default = values;
      }
    }
    return ok ? out : null;
  }
  if (given !== undefined) out.default = p.type === 'token' ? { token: given } : given;
  return out;
}

/** A field's own default, as the engine takes it: a token field names its token as `{ token }`. */
function withScalarDefault(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.type === 'token' && typeof schema.default === 'string' ? { ...schema, default: { token: schema.default } } : schema;
}

/** One item's or one object's values, from its rows. */
function rowValues(rows: Array<{ field: string; value: unknown }>, fields: Record<string, unknown>, at: string, issues: FieldIssue[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let ok = true;
  rows.forEach((r, m) => {
    if (!Object.hasOwn(fields, r.field)) {
      ok = false;
      issues.push({ field: `${at}[${m}].field`, message: `"${r.field}" is not one of its fields (${Object.keys(fields).join(', ')})` });
    } else if (Object.hasOwn(out, r.field)) {
      ok = false;
      issues.push({ field: `${at}[${m}].field`, message: `"${r.field}" is given twice` });
    } else out[r.field] = (fields[r.field] as { type?: string }).type === 'token' && typeof r.value === 'string' ? { token: r.value } : r.value;
  });
  return ok ? out : null;
}

/** Which part of a property row an engine message is about: a field of a list or object, its default, or the row. */
function propertyField(p: PropertyArgs, at: string, message: string): string {
  const nested = /Property "[^".]+\.([^"]+)"/.exec(message)?.[1];
  if (nested && (p.type === 'list' || p.type === 'object')) {
    const j = p.fields.findIndex((f) => f.name === nested);
    if (j >= 0) return `${at}.fields[${j}]`;
  }
  if (/\bdefault\b/.test(message) && 'default' in p && p.default !== undefined) return `${at}.default`;
  if (/\boptions?\b/.test(message) && p.type === 'enum') return `${at}.options`;
  return at;
}

/** Style rows as the operation keeps them, by size and state: `{ base: {...}, "desktop": {...}, "base:hover": {...} }`. */
function styleRules(rows: StyleRow[], at: string, issues: FieldIssue[], positions?: number[]): Record<string, Record<string, unknown>> | null {
  const out: Record<string, Record<string, unknown>> = {};
  rows.forEach((r, k) => {
    const row = `${at}[${positions?.[k] ?? k}]`;
    if (!Object.hasOwn(STYLE_PROP_MAP, r.property)) return issues.push({ field: `${row}.property`, message: `"${r.property}" is not a style property` });
    const key = `${r.scope ?? 'base'}${r.state ? `:${r.state}` : ''}`;
    const rules = (out[key] ??= {});
    if (Object.hasOwn(rules, r.property)) return issues.push({ field: row, message: `${r.property} is already set for ${key}` });
    rules[r.property] = r.value;
  });
  return Object.keys(out).length ? out : null;
}

/** Each node, property, part, slot and axis by the name an engine message would quote. */
function sourceIndex(args: ManagedComponentArgs): SourceIndex {
  const names: Array<[string, string]> = [];
  (args.nodes ?? []).forEach((n, i) => names.push([n.id, `nodes[${i}]`]));
  // A node's layer name, where it names that node alone.
  const layers = new Map<string, number[]>();
  (args.nodes ?? []).forEach((n, i) => n.name && layers.set(n.name, [...(layers.get(n.name) ?? []), i]));
  for (const [name, at] of layers) if (at.length === 1) names.push([name, `nodes[${at[0]}]`]);
  (args.properties ?? []).forEach((p, i) => names.push([p.name, `properties[${i}]`]));
  (args.parts ?? []).forEach((p, i) => names.push([p.id, `parts[${i}]`]));
  (args.slots ?? []).forEach((s, i) => names.push([s.name, `slots[${i}]`]));
  (args.variantAxes ?? []).forEach((a, i) => {
    names.push([a.name, `variantAxes[${i}]`]);
    a.options.forEach((o, j) => names.push([o.id, `variantAxes[${i}].options[${j}]`]));
  });
  (args.state ?? []).forEach((st, i) => names.push([st.name, `state[${i}]`]));
  return {
    locate(message: string, details?: unknown) {
      const node = isRecord(details) && isRecord(details.owner) && details.owner.kind === 'component' && typeof details.nodeId === 'string' ? details.nodeId : undefined;
      const at = node === undefined ? -1 : (args.nodes ?? []).findIndex((n) => n.id === node);
      if (at >= 0) return `nodes[${at}]`;
      const quoted = [...message.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      for (const q of quoted) {
        const hits = names.filter(([n]) => n === q);
        // A name used by two kinds of thing (a node and a part both called "card") is the node: its message leads.
        if (hits.length) return hits[0][1];
      }
      return 'nodes';
    }
  };
}
