/**
 * Canonical project document types.
 *
 * These are the authoritative, versioned authoring documents stored under `siteorigin/`.
 * Svelte routes, components and stylesheets are derived from them by the generator.
 */
import { LATEST_SCHEMA_VERSION } from './migrations';
import type { RichListType, RichText } from './richtext';
import type { CrawlerPolicy } from './crawler-policy';

export type { RichBlock, RichImageBlock, RichListBlock, RichListType, RichSpan, RichText, RichTextBlock } from './richtext';

/** The current document format: one more than the number of migrations (see `./migrations`). */
export const SCHEMA_VERSION = LATEST_SCHEMA_VERSION;
export const GENERATOR_VERSION = '0.1.0';

export type ResponsiveScope = 'base' | 'phone' | 'tablet' | 'desktop';
export const RESPONSIVE_SCOPES: ResponsiveScope[] = ['base', 'phone', 'tablet', 'desktop'];

/**
 * Interactive states a style rule can be limited to: `hover` (pointer over it, on devices that hover), `focus`
 * (keyboard focus, as `:focus-visible` shows it) and `active` (while pressed). Listed in the order the stylesheet
 * writes them, so a later state wins while several hold at once.
 */
export type StyleState = 'hover' | 'focus' | 'active';
export const STYLE_STATES: StyleState[] = ['hover', 'focus', 'active'];
/** Where one bucket of styles applies: a size range, or a size range in one interactive state (`phone:hover`). */
export type StyleScopeKey = ResponsiveScope | `${ResponsiveScope}:${StyleState}`;

/** The key a size range's rules in one state (or, without one, its resting rules) are stored under. */
export const styleScopeKey = (scope: ResponsiveScope, state?: StyleState): StyleScopeKey => (state ? `${scope}:${state}` : scope);

/** The size range and state a stored key names, or null for a key that names none (a hand-edited document). */
export function parseStyleScopeKey(key: string): { scope: ResponsiveScope; state?: StyleState } | null {
  const [scope, state, ...rest] = key.split(':');
  if (rest.length || !(RESPONSIVE_SCOPES as string[]).includes(scope)) return null;
  if (state === undefined) return { scope: scope as ResponsiveScope };
  return (STYLE_STATES as string[]).includes(state) ? { scope: scope as ResponsiveScope, state: state as StyleState } : null;
}

/**
 * A style's link to a site token. A colour link can paint the token at part strength: `alpha` from 0 to 1 (0.7 is
 * 70%), mixed with transparent, for a see-through surface that still follows the token.
 */
export type StyleTokenRef = { token: string; alpha?: number };
/**
 * A library image painted behind an element's content (a hero's photograph): how it fills the box (`cover`, the
 * default, or `contain`), the point that stays in view when it is cropped ("X% Y%", centred by default) and an
 * optional scrim, a colour or one gradient painted over it so text on top stays readable. Only the `backgroundImage`
 * style property holds one (see shared/background-image.ts); it never names a token.
 */
export type BackgroundImageValue = { assetId: string; size?: 'cover' | 'contain'; position?: string; scrim?: string; token?: never };
/** A literal style value, a reference to a site token, or a background image (`backgroundImage` only). */
export type StyleValue = string | number | boolean | StyleTokenRef | BackgroundImageValue;
export type StyleProps = Record<string, StyleValue>;
/**
 * Style rules by where they apply: each size range's resting rules, and the rules for its interactive states, side by
 * side in one map (`{ base: {...}, "base:hover": {...}, "phone:focus": {...} }`). Every value is one set of style
 * properties, so whatever walks every rule (token use, copying) reads states without knowing of them.
 */
export type ResponsiveStyles = Partial<Record<StyleScopeKey, StyleProps>>;

export type LinkType = 'none' | 'page' | 'url' | 'email' | 'tel' | 'anchor' | 'document' | 'entry';
/** The relationships an author can declare on a link to another site, in the order they are stored and written. */
export const LINK_RELS = ['nofollow', 'sponsored', 'ugc'] as const;
export type LinkRel = (typeof LINK_RELS)[number];
export interface LinkValue {
  type: LinkType;
  /**
   * Page ID, URL, email address, telephone number, anchor ID, a document's asset ID or a collection entry's ID,
   * depending on `type`. Entry IDs are unique across the project, so an entry link names no collection.
   */
  target: string;
  /** Optional in-page anchor for page links. */
  anchor?: string;
  newTab?: boolean;
  /**
   * What a web address link says about where it goes (a paid placement, an untrusted citation): kept on `url` links
   * only, each token once, in LINK_RELS order, and left out when there are none. The site adds `noopener noreferrer`
   * itself when the link opens a new tab; those are never stored.
   */
  rel?: LinkRel[];
}

export interface ImageValue {
  assetId: string | null;
  alt: string;
  decorative?: boolean;
}

/**
 * Where a value is: in an element (`owner`, `nodeId`) or in a component property's starting value (`definitionId`);
 * `path` steps from there to it by key, and through list items by their ID (by position, for one without).
 */
export type ValuePlace = ({ owner: OwnerRef; nodeId: string } | { definitionId: string }) & { path: Array<string | number> };

/**
 * A use of a library image whose alternative text a replacement left for the author to check: one that keeps a
 * description of its own (`custom`), or one left with none (`missing`), such as an inherited description that went
 * because the new image suggests none. `alt` is the text it was left with.
 */
export type AltReview = ValuePlace & { reason: 'custom' | 'missing'; alt: string };

/**
 * One use of a library image, as a replacement in some places names it: an image value in an element (`node`) or in
 * a component property's starting value (`default`), reached by `path` as in ValuePlace but through list items only by
 * their ID; a page's sharing image; or the site's browser tab icon or sharing image.
 */
export type ImageUseTarget =
  | { kind: 'node'; owner: OwnerRef; nodeId: string; path: string[] }
  | { kind: 'default'; definitionId: string; path: string[] }
  | { kind: 'pageSharing'; pageId: string }
  | { kind: 'site'; field: 'favicon' | 'socialImage' | 'logo' };

/**
 * Binding to a property of the enclosing component, or a field of the current repeated item. `field` names one
 * field of an object property (`{ $prop: 'primary', field: 'label' }`); without it the whole value is bound.
 * Inside a collection's layout template (and only there), `{ $entry: field }` reads a field of the entry the template
 * is shown for (see shared/entry-fields.ts).
 */
export type Binding = { $prop: string; field?: string } | { $item: string } | EntryBinding;
export type Bindable<T> = T | Binding;
/** A read of one field of the collection entry a layout template is shown for: `title`, `body`, `field.price`... */
export type EntryBinding = { $entry: string };

export function isBinding(v: unknown): v is Binding {
  return !!v && typeof v === 'object' && ('$prop' in (v as object) || '$item' in (v as object) || '$entry' in (v as object));
}

/** A read of an entry field, and nothing else: a value that also names a property or an item field is neither. */
export function isEntryBinding(v: unknown): v is EntryBinding {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { $entry?: unknown }).$entry === 'string' && !Object.hasOwn(v, '$prop') && !Object.hasOwn(v, '$item') && !Object.hasOwn(v, '$state');
}

/**
 * A read of one of the definition's own UI state variables (`ComponentDefinition.state`). Only conditions and the
 * variant axes of nested components read state: content (text, links, images) always comes from properties.
 */
export type StateRef = { $state: string };
/** What a condition or a nested component's variant axis can read: a property, a list item field or UI state. */
export type BindingRef = Binding | StateRef;

/** A read of UI state, and nothing else: a value that also names a property or an item field is neither. */
export function isStateRef(v: unknown): v is StateRef {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, '$state') && !isBinding(v);
}

export function isBindingRef(v: unknown): v is BindingRef {
  return isBinding(v) || isStateRef(v);
}

/** A value a condition can compare a bound value with. */
export type ConditionValue = string | number | boolean;
/** A bound value compared with a literal: equal (`eq`) or not equal (`ne`). */
export type Comparison = { ref: BindingRef; eq: ConditionValue } | { ref: BindingRef; ne: ConditionValue };
/** What `when` and `unless` test: a bound value being present, or a bound value compared with a literal. */
export type Condition = BindingRef | Comparison;

export function isComparison(v: unknown): v is Comparison {
  if (!v || typeof v !== 'object' || !isBindingRef((v as { ref?: unknown }).ref)) return false;
  return Object.hasOwn(v, 'eq') !== Object.hasOwn(v, 'ne');
}

/** The binding a condition reads, or undefined for a value that is not a condition. */
export function conditionRef(c: unknown): BindingRef | undefined {
  if (isComparison(c)) return c.ref;
  return isBindingRef(c) ? c : undefined;
}

/**
 * Whether a condition holds for the value its binding resolves to. `present` judges a plain binding (the
 * generated site's `has`); a comparison is strict equality, so `true` never equals `"true"`.
 */
export function conditionHolds(c: Condition, value: unknown, present: (v: unknown) => boolean): boolean {
  if (!isComparison(c)) return present(value);
  return 'eq' in c ? value === c.eq : value !== c.ne;
}

/** Where a link node shows its icon, relative to its label. */
export type IconPosition = 'start' | 'end';
export const ICON_POSITIONS: IconPosition[] = ['start', 'end'];

/** What clicking a container does (`ElementNode.action`): nothing, open its image full size, or follow its link. */
export type ElementAction = 'none' | 'image' | 'link';
export const ELEMENT_ACTIONS: ElementAction[] = ['none', 'image', 'link'];
/**
 * How a container a component's yes/no UI state opens shows over the page (`ElementNode.overlay`): a dialog in the
 * middle, or a drawer sliding in from the start or end side (left or right, following the text's direction) or the
 * bottom.
 */
export type OverlayMode = 'dialog' | 'drawer-start' | 'drawer-end' | 'drawer-bottom';
export const OVERLAY_MODES: readonly OverlayMode[] = ['dialog', 'drawer-start', 'drawer-end', 'drawer-bottom'];

/**
 * How a section or container enters the first time it scrolls into view (`appear`). Content is always visible until
 * the site's runtime arms it, so a page without JavaScript, a printout and a visitor who asks for reduced motion see
 * everything at once.
 */
export type AppearPreset = 'fade' | 'lift' | 'scale-subtle';
export const APPEAR_PRESETS: AppearPreset[] = ['fade', 'lift', 'scale-subtle'];
export const isAppearPreset = (v: unknown): v is AppearPreset => typeof v === 'string' && (APPEAR_PRESETS as string[]).includes(v);

// ---------------------------------------------------------------------------
// Property schema
// ---------------------------------------------------------------------------

interface PropBase {
  label: string;
  description?: string;
  group?: string;
}
export interface StringProp extends PropBase {
  type: 'string';
  default: string;
  multiline?: boolean;
  maxLength?: number;
}
export interface RichTextProp extends PropBase {
  type: 'richtext';
  /** Structured blocks of inline spans (see shared/richtext.ts). */
  default: RichText;
  /** Plain lines given to this property become items of this kind of list. */
  plainAs?: RichListType;
  /**
   * How a code component receives the value. `blocks`: the structured blocks, for its RichText.svelte to render
   * with links, lists and headings. Otherwise, as code components always have: one string per paragraph or list
   * item, with **bold** and *italic*. Managed components always take blocks.
   */
  codeForm?: RichCodeForm;
}
export type RichCodeForm = 'blocks' | 'paragraphs';
export const RICH_CODE_FORMS: readonly RichCodeForm[] = ['blocks', 'paragraphs'];
export interface NumberProp extends PropBase {
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  step?: number;
}
export interface BooleanProp extends PropBase {
  type: 'boolean';
  default: boolean;
}
export interface EnumProp extends PropBase {
  type: 'enum';
  default: string;
  options: Array<{ value: string; label: string }>;
}
export interface LinkProp extends PropBase {
  type: 'link';
  default: LinkValue;
}
export interface ImageProp extends PropBase {
  type: 'image';
  default: ImageValue;
}
export interface IconProp extends PropBase {
  type: 'icon';
  default: string;
}
/**
 * One answer a visitor can pick. `label` is what they read; `value` is what is sent, fixed when the choice is first
 * named so renaming or translating the label never moves earlier answers to another value.
 */
export interface ChoiceOption {
  id: string;
  label: string;
  value: string;
}
/** An ordered set of answers to pick from, such as the options of a single-choice form field. */
export interface ChoicesProp extends PropBase {
  type: 'choices';
  default: ChoiceOption[];
}
/**
 * One of the site's design tokens, chosen per placement (an accent color, a spacing step). The value is always a
 * reference to a token of `tokenGroup`, so it follows edits to that token and counts as one of its uses.
 */
export interface TokenProp extends PropBase {
  type: 'token';
  tokenGroup: TokenGroup;
  default: { token: string };
}
export type ScalarPropSchema =
  | StringProp
  | RichTextProp
  | NumberProp
  | BooleanProp
  | EnumProp
  | LinkProp
  | ImageProp
  | IconProp
  | ChoicesProp
  | TokenProp;
export interface ListProp extends PropBase {
  type: 'list';
  itemLabel: string;
  /** Item field used as the readable title of an item. */
  titleField?: string;
  fields: Record<string, ScalarPropSchema>;
  default: ListItem[];
  min?: number;
  max?: number;
  /** Items are cards for pages of the site: fields left empty show the linked page's own values (see shared/page-teasers.ts). */
  pageTeaser?: PageTeaser;
  /**
   * Items are not stored: they are worked out from the site's pages (or a collection's entries) where the list is
   * placed, each time the site is generated (see shared/articles.ts and shared/entry-feed.ts). Fields named like a
   * row's (`pageLink`, `title`, `date`, `dateLabel`, `byline`, `excerpt`, and for entries `image` and `category`) are
   * filled from it; the stored value is ignored.
   */
  feed?: ListFeed;
}
/**
 * What a computed list holds: the site's dated articles, newest first; the page it is placed on; or the published
 * entries of a collection, newest first, chosen by the placement's own `collection`, `category`, `tag` and `count`
 * properties (see shared/entry-feed.ts).
 */
export type ListFeed = 'articles' | 'currentPage' | 'entries';
export const LIST_FEEDS: readonly ListFeed[] = ['articles', 'currentPage', 'entries'];
/**
 * Which item fields of a page list follow the linked page. `link` names the item's link field; `title` (a text
 * field) shows the page's title, `description` (a text field) its description and `image` (an image field) its
 * sharing image, each only while the item's own value is empty. Deleting a page removes the items that link to it.
 */
export interface PageTeaser {
  link: string;
  title: string;
  description?: string;
  image?: string;
}
/**
 * A table of plain text: named columns and rows whose cells are keyed by column ID, so moving or removing a
 * column keeps every other cell where it belongs. IDs are local to the table (`col_…`, `row_…`).
 */
export interface TableColumn {
  id: string;
  label: string;
}
export interface TableRow {
  id: string;
  /** One text per column, keyed by column ID. */
  cells: Record<string, string>;
}
export interface TableValue {
  columns: TableColumn[];
  rows: TableRow[];
}
export interface TableProp extends PropBase {
  type: 'table';
  default: TableValue;
}
/**
 * Related values kept together as one property (a button's label and link), each a named single value. A managed
 * definition binds one field with `{ $prop, field }`, or passes the whole object to a component that takes one.
 */
export interface ObjectProp extends PropBase {
  type: 'object';
  fields: Record<string, ScalarPropSchema>;
  /** Every field's value, by field name. */
  default: Record<string, unknown>;
}
export type PropSchema = ScalarPropSchema | ListProp | TableProp | ObjectProp;
export type ListItem = { id: string } & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Managed graph nodes
// ---------------------------------------------------------------------------

export const ELEMENT_TAGS = [
  'div', 'section', 'header', 'footer', 'nav', 'main', 'article', 'aside', 'figure', 'ul', 'ol', 'li',
  'span', 'blockquote', 'figcaption', 'address', 'dl', 'dt', 'dd', 'details', 'summary', 'p'
] as const;
export type ElementTag = (typeof ELEMENT_TAGS)[number];
export const TEXT_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'small', 'strong', 'blockquote', 'div', 'cite', 'dt', 'dd', 'figcaption'] as const;
export type TextTag = (typeof TEXT_TAGS)[number];

interface NodeBase {
  id: string;
  /** Optional readable layer name. */
  name?: string;
  styles?: ResponsiveStyles;
  /**
   * Render only when the bound value is truthy (non-empty string, true, non-empty list, link with target), or,
   * for a comparison, when the bound value equals (`eq`) or differs from (`ne`) the given literal.
   */
  when?: Condition;
  /** Render only when the bound value is empty, or, for a comparison, when the comparison does not hold. */
  unless?: Condition;
  /** Optional anchor ID for in-page links. */
  anchor?: string;
  /**
   * Where the node came from when its component placement was detached: the design's key (as in its class names), the
   * node there, and the options that styled it. The node carries inert copies of those classes (`so--d-…`), which no
   * component's rules match but the theme's own hooks still read (a dark section's colours, print rules).
   */
  detachedFrom?: DetachedFrom;
}
export interface DetachedFrom {
  component: string;
  node: string;
  /** Variant options by axis, for the axes whose class the node carried. */
  options?: Record<string, string>;
  /** An image or link action repeated in a list: the images its viewer moved through together (one gallery). */
  group?: string;
}
export interface ElementNode extends NodeBase {
  kind: 'element';
  /** A literal tag, or an enum property whose options are all element tags. */
  tag: Bindable<ElementTag>;
  children: string[];
  /**
   * Makes the whole container one link (a card). It renders as an `<a>` while the destination resolves and as
   * its tag otherwise, so nothing inside it may be interactive (see `CARD_LINK_INTERACTIVE`).
   */
  link?: Bindable<LinkValue>;
  /**
   * What clicking the container does, chosen per placement or list item (a gallery photo): nothing, open its image
   * full size (`image`, the first image inside it that shows a picture) in a viewer, or follow `link`. With an action
   * set, `link` applies only while the action is `link`. The container keeps its tag either way: a working action
   * wraps it in one link, so nothing inside it may be interactive, as in a card. The tag must be fixed and one a link
   * may wrap (not a list item, term or disclosure); otherwise the action does nothing.
   */
  action?: Bindable<ElementAction>;
  /** Accessible name, for landmarks such as navigation regions. */
  ariaLabel?: Bindable<string>;
  /**
   * Render only when at least one child renders, judged from the children's own conditions (a nested
   * collapsing element by its children, a repeat by its list). A child that always renders keeps this one.
   */
  collapseEmpty?: boolean;
  /** How the container enters when it first scrolls into view. Absent: it is simply there. */
  appear?: AppearPreset;
  /**
   * Makes a list (a literal `ul` with no link or action of its own) a carousel track: it scrolls sideways and snaps
   * to each item, and the runtime helper adds Previous and Next buttons and a count of the slides showing once the
   * page's script runs. Without it the list still scrolls, and it prints as a plain stack.
   */
  carousel?: true;
  /**
   * Inside a component's design: shows the container over the page, as a modal dialog or a drawer (a native
   * `<dialog>`), while the yes/no UI state its one condition reads says so, instead of in its place. The design's
   * buttons that set or toggle that state open and close it; Escape and a click beside it close it, giving focus back
   * to the button that opened it. It stays in the page while closed, and never prints. Only a plain `div` rendered once
   * per placement can be one (see engine/schema `overlayProblem`); otherwise it is an ordinary container.
   */
  overlay?: OverlayMode;
}
export interface TextNode extends NodeBase {
  kind: 'text';
  /** A literal tag, or (plain text only) an enum property whose options are all text tags. */
  tag: Bindable<TextTag>;
  /** For rich text nodes the value is structured blocks. */
  text: Bindable<string | RichText>;
  rich?: boolean;
  /**
   * Plain text only: the date (YYYY-MM-DD) the text states. The text then renders inside a `<time>` element with
   * this as its machine-readable `datetime`, while it is set.
   */
  datetime?: Bindable<string>;
  /**
   * Rich text only: shows paragraphs, and the items of this kind of list, as one list of this kind, as rich text
   * marked as a list showed them before structured rich text. Text holding anything else shows as written. Set by
   * the migration where one property's value is shown both as a list and as paragraphs.
   */
  paragraphList?: Extract<RichListType, 'ul' | 'check'>;
}
export interface ImageNode extends NodeBase {
  kind: 'image';
  image: Bindable<ImageValue>;
  /** What the image stands for, used as its alternative text when it has none (shown as hidden text when decorative). */
  fallbackAlt?: Bindable<string>;
}
export type ButtonAppearance = 'primary' | 'secondary' | 'text' | 'light' | 'link' | 'plain';
export interface LinkNode extends NodeBase {
  kind: 'link';
  link: Bindable<LinkValue>;
  label: Bindable<string>;
  appearance: Bindable<ButtonAppearance | string>;
  /** An icon shown beside the label; none when empty. */
  icon?: Bindable<string>;
  /** Which side of the label the icon is on. Defaults to `start`. */
  iconPosition?: Bindable<IconPosition>;
  /** Accessible name, when the label alone does not say where the link goes. */
  ariaLabel?: Bindable<string>;
  /**
   * Inside a component's design: what clicking the button does to the component's UI state, instead of (a link of
   * type `none`) or alongside going somewhere.
   */
  stateAction?: StateAction;
}
export interface IconNode extends NodeBase {
  kind: 'icon';
  icon: Bindable<string>;
  /** Accessible name; an icon without one is decorative. */
  ariaLabel?: Bindable<string>;
}
/**
 * How a divider is drawn: `line` (the default, also when absent) is a plain rule, a real separator. The others are
 * decorative bands drawn as inline SVG in the divider's text color, hidden from assistive technology: `angle` and
 * `wave` are section transitions, `icon` is a hairline either side of an icon.
 */
export const DIVIDER_SHAPES = ['line', 'angle', 'wave', 'icon'] as const;
export type DividerShape = (typeof DIVIDER_SHAPES)[number];
/** The icon a divider of shape `icon` shows when it names none (or one that is not available). */
export const DIVIDER_ICON = 'sparkles';
export interface DividerNode extends NodeBase {
  kind: 'divider';
  /** Absent for a plain rule. A literal, never bound: the shape is part of the design. */
  shape?: Exclude<DividerShape, 'line'>;
  /** Shape `icon` only: the icon between the hairlines, by name. Absent: `DIVIDER_ICON`. */
  icon?: string;
}
export interface RepeatNode extends NodeBase {
  kind: 'repeat';
  list: { $prop: string };
  children: string[];
  /**
   * Items that enter together (a row of cards scrolling into view) start their entrances one after another. Only
   * the item's own entrance (`appear` on a direct child) is staggered; it does nothing without one.
   */
  appearStagger?: boolean;
  /**
   * Category filter pills for the items (a portfolio's Residential and Commercial): visitors pick a category, or All,
   * and only the items whose `field` (a text or choice field of the list's items) holds it show. Every item stays in
   * the page and in print. The pills show above the repeat's container, which holds the repeat alone, while `when` (a
   * yes/no property) is on, or always without it, and only when the items name two categories or more.
   */
  filter?: RepeatFilter;
}
export interface RepeatFilter {
  /** The item field holding each item's category: text (pills in the order items first use them) or a choice. */
  field: string;
  /** The yes/no property that turns the pills on; without it they always show. */
  when?: { $prop: string };
}
export interface SlotNode extends NodeBase {
  kind: 'slot';
  slot: string;
}
export interface InstanceNode extends NodeBase {
  kind: 'instance';
  definitionId: string;
  props: Record<string, unknown>;
  /**
   * The option chosen on each of the definition's variant axes. An axis left out uses its default. Inside a
   * definition an axis can be bound to an enum property, or to enum UI state, whose options are all options of that
   * axis.
   */
  variants?: Record<string, string | BindingRef>;
  /** Instance style overrides keyed by public part ID ("root" is the instance boundary). */
  overrides?: Record<string, ResponsiveStyles>;
  /**
   * Styles for one repeated item only (one card of a grid), keyed by public part ID. They apply over `overrides` for
   * that part, so an item keeps the shared style for everything it does not set, and follow the item, by its stable
   * ID, when the list is reordered. Only a part inside exactly one repeat of a managed definition takes them.
   */
  itemOverrides?: Record<string, ItemStyles>;
  /** Content placed into the definition's declared slots. */
  slots?: Record<string, string[]>;
  /**
   * For the shared header or footer: brand properties (its site name, its copyright line) that keep their text when
   * the site is renamed, although that text says the site's name. The author wrote it before the site took the same
   * name (see shared/site-name.ts). Editing the property gives it up. An editor that drops it only lets the text
   * follow the next rename, so it needs no new document version.
   */
  keepsText?: string[];
  /**
   * How the section enters when it first scrolls into view, on its component's root element. Absent: the design's own
   * choice for its root; `none`: no entrance here, whatever the design chooses. Managed components only.
   */
  appear?: AppearPreset | 'none';
  /**
   * For a contact form: the name and description it is declared to AI agents by while the site has WebMCP on
   * (src/shared/webmcp.ts), as the author typed them. Either left out takes the default.
   */
  webmcp?: { toolName?: string; toolDescription?: string };
}

/** A placement's content in one slot: the list it holds, or none when a hand edit left something else there. */
export function slotChildren(node: { slots?: Record<string, string[]> }, slot: string): string[] {
  const ids = node.slots && Object.hasOwn(node.slots, slot) ? node.slots[slot] : undefined;
  return Array.isArray(ids) ? ids : [];
}

/** One part's styles for single items of a list. */
export interface ItemStyles {
  /**
   * The list property the part repeated over when these were set. Item IDs are unique only within one list, so the
   * styles apply only while the part still repeats over this list.
   */
  list: string;
  /** Styles keyed by stable item ID. */
  items: Record<string, ResponsiveStyles>;
}

export type GraphNode =
  | ElementNode
  | TextNode
  | ImageNode
  | LinkNode
  | IconNode
  | DividerNode
  | RepeatNode
  | SlotNode
  | InstanceNode;
export type NodeKind = GraphNode['kind'];

/** A tree of nodes owned by a page, the shared shell or a component definition. */
export interface NodeTree {
  rootIds: string[];
  nodes: Record<string, GraphNode>;
}

// ---------------------------------------------------------------------------
// Component definitions
// ---------------------------------------------------------------------------

export interface PartDef {
  nodeId: string;
  label: string;
  /** Style properties offered for this part in the inspector. */
  styleControls?: string[];
}

export interface VariantDef {
  label: string;
  /** Style rules applied when this variant is selected, keyed by definition node ID. */
  styles?: Record<string, ResponsiveStyles>;
}

/** One independent design choice, such as tone or layout. A placement picks one option on every axis. */
export interface VariantAxis {
  label: string;
  /** Option ID used by placements that have not chosen one. */
  default: string;
  options: Record<string, VariantDef>;
}

/** Kinds of element a slot can take besides placed components, as stored: a heading and a paragraph are both text. */
export type SlotPrimitive = 'element' | 'text' | 'image' | 'link' | 'icon' | 'divider';
export const SLOT_PRIMITIVES: readonly SlotPrimitive[] = ['element', 'text', 'image', 'link', 'icon', 'divider'];
export const COMPONENT_CATEGORIES: readonly ComponentCategory[] = ['hero', 'content', 'social-proof', 'conversion', 'media', 'layout', 'shell', 'primitive', 'custom'];

/**
 * A place in a component where each placement puts content of its own. With neither `categories` nor `primitives`
 * it takes anything; with either, only components of those categories and elements of those kinds. `max` caps how
 * many children it holds (0 closes it).
 */
export interface SlotDef {
  label: string;
  /** What belongs there, for authors and the AI. */
  description?: string;
  categories?: ComponentCategory[];
  primitives?: SlotPrimitive[];
  max?: number;
}

/**
 * One of a managed component's own UI state variables: whether a panel is open, which tab or billing period shows.
 * Each placement starts at `initial`, and visitors change it with buttons (`LinkNode.stateAction`); it is never a
 * property placements set.
 */
export type UiStateSchema = BooleanUiState | EnumUiState | ItemUiState;
export interface BooleanUiState {
  type: 'boolean';
  label: string;
  initial: boolean;
}
export interface EnumUiState {
  type: 'enum';
  label: string;
  /** The values in order, which `next` and `prev` step through. */
  options: Array<{ value: string; label: string }>;
  initial: string;
}
/**
 * Which item of one of the component's own list properties is the active one (a step whose description is open and
 * whose picture shows). Buttons in a repeat of that list select their own item (`select`) or step through the items
 * (`next`, `prev`), and content in any repeat of the same list reads `{ $state: name }` as "this item is the active
 * one", so one list drives both the buttons and what they show. Each placement starts at the item in position
 * `initial` (counted from 0, the last when the list is shorter) and, once a visitor chooses, keeps that item while the
 * list changes around it.
 */
export interface ItemUiState {
  type: 'item';
  label: string;
  /** The list property whose items it chooses between. */
  list: string;
  initial: number;
}
export const UI_STATE_TYPES: ReadonlyArray<UiStateSchema['type']> = ['boolean', 'enum', 'item'];

/**
 * What a button does to UI state: `set` it to a value, `toggle` a yes/no state, or step a choice (or the active item)
 * to its `next` or `prev` option, staying at the last (or first) unless `wrap` goes round to the other end. `select`
 * makes the button's own list item the active one (a button in a repeat of the item state's list).
 */
export type StateAction =
  | { state: string; op: 'set'; value: boolean | string }
  | { state: string; op: 'toggle' }
  | { state: string; op: 'next' | 'prev'; wrap?: boolean }
  | { state: string; op: 'select' };
export type StateActionOp = StateAction['op'];
export const STATE_ACTION_OPS: readonly StateActionOp[] = ['set', 'toggle', 'next', 'prev', 'select'];

/** The value a definition's UI state starts at in every placement, or undefined when it declares no such state. */
export function stateInitial(def: Pick<ComponentDefinition, 'state'> | undefined, name: string): unknown {
  const s: unknown = def?.state && Object.hasOwn(def.state, name) ? def.state[name] : undefined;
  return s && typeof s === 'object' ? (s as { initial?: unknown }).initial : undefined;
}

export interface ComponentDefinition {
  schemaVersion: number;
  /** Unique installed definition identity. */
  id: string;
  /** Public catalogue contract ID, stable across compatible themes. */
  componentId: string;
  contractVersion: number;
  kind: 'managed' | 'code';
  owner: 'theme' | 'project';
  name: string;
  description: string;
  category: ComponentCategory;
  tags: string[];
  properties: Record<string, PropSchema>;
  parts: Record<string, PartDef>;
  slots?: Record<string, SlotDef>;
  variantAxes?: Record<string, VariantAxis>;
  /** UI state the design reads (`{ $state: name }`) and its buttons change (managed components only). */
  state?: Record<string, UiStateSchema>;
  /** Managed graph (managed components only). */
  tree?: NodeTree;
  /** Svelte source for code components bundled with a theme. */
  source?: string;
  /** Project-relative path of an authored project code component. */
  sourcePath?: string;
  dependencies?: string[];
  provenance?: { pack?: string; packVersion?: string; componentId?: string; forkedFrom?: string; createdBy?: 'user' | 'ai' };
  license?: string;
  examples?: Array<{ description: string; props: Record<string, unknown> }>;
  /** Icon name used in the insert panel. */
  icon?: string;
  /**
   * Where Insert puts a new placement (project components): beside the page's sections, or where an element goes,
   * inside the selected layout. Create component records where its source sat; copies carry it on. Without it the
   * editor reads it from the design (lib/insert-at).
   */
  insertAs?: 'section' | 'element';
}

export type ComponentCategory = 'hero' | 'content' | 'social-proof' | 'conversion' | 'media' | 'layout' | 'shell' | 'primitive' | 'custom';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type TokenGroup = 'color' | 'font' | 'text' | 'space' | 'container' | 'radius' | 'shadow' | 'border';

export interface TextStyleValue {
  family: StyleValue;
  size: string;
  lineHeight: string;
  weight: number;
  tracking: string;
  transform?: string;
}
export type TokenValue = string | TextStyleValue | { token: string };

export interface TokenDef {
  id: string;
  label: string;
  group: TokenGroup;
  value: TokenValue;
  description?: string;
}

/**
 * Which colour palettes the website gives its visitors: the one palette (`single`, and when absent), a dark one
 * beside it that follows the visitor's device setting (`system`), or that and a Light/Dark switch in the shared
 * header whose choice the browser remembers (`toggle`).
 */
export type ColorSchemeMode = 'single' | 'system' | 'toggle';
export const COLOR_SCHEME_MODES: readonly ColorSchemeMode[] = ['single', 'system', 'toggle'];

/** A colour of the dark palette: a colour, or another colour token followed within the dark palette. */
export type DarkColorValue = string | { token: string };

export interface TokensDoc {
  schemaVersion: number;
  overrides: Record<string, TokenValue>;
  custom: TokenDef[];
  /** Absent: `single`. */
  colorSchemeMode?: ColorSchemeMode;
  /**
   * The dark palette's own colours, by colour token ID. A colour without one shows its value from the light palette
   * (`overrides`, else its definition), and a link there is followed within the dark palette. Made from the light
   * palette the first time a dark palette is turned on, and kept (unused) while the site is back to one palette.
   * Absent: never made.
   */
  darkOverrides?: Record<string, DarkColorValue>;
}

// ---------------------------------------------------------------------------
// Site, pages and assets
// ---------------------------------------------------------------------------

export interface PageSeo {
  title?: string;
  description?: string;
  socialImage?: string | null;
  noindex?: boolean;
  /** Left out of the site's own search (the Site search section), whatever search engines are told. */
  searchHidden?: boolean;
  /**
   * The address search engines are told is the page's own, when it is not where the site publishes it (a copy of an
   * article first published elsewhere): an absolute http(s) URL (see shared/seo `checkCanonicalUrl`). Absent: the
   * page's public URL.
   */
  canonical?: string;
  /**
   * What the page is, beyond a web page, for search engines and AI answer engines (shared/page-structured-data.ts): an
   * About or Contact page, or the page of one of the publisher's own services, products, events or guides, with the
   * facts that describe it. Absent: a web page.
   */
  structuredData?: PageStructuredData;
}

/** Whether a product can be had now, as Schema.org's ItemAvailability names it. */
export type ProductAvailability = 'InStock' | 'OutOfStock' | 'PreOrder' | 'BackOrder' | 'LimitedAvailability' | 'MadeToOrder' | 'SoldOut' | 'Discontinued';

/**
 * The kind of thing a page is and the facts it states, one kind at a time. A fact may be missing while the author
 * fills it in: the page's structured data names the entity only once the facts it needs are there.
 */
export type PageStructuredData =
  | { type: 'AboutPage' }
  | { type: 'ContactPage' }
  | { type: 'Service'; serviceType?: string; areaServed?: string }
  | { type: 'Product'; price?: string; currency?: string; availability?: ProductAvailability; offerUrl?: string }
  | { type: 'Event'; startDate?: string; endDate?: string; venue?: string; address?: string }
  | { type: 'HowTo'; steps?: string[] };

/** A page's structured type: a plain web page, or one a PageStructuredData record makes it. */
export type PageStructuredType = 'WebPage' | PageStructuredData['type'];

/**
 * A collection entry's search and sharing settings, read through generator/seo-metadata. Each one left out falls back
 * as the entry's page always has: its title, its excerpt, its featured image, its public URL.
 */
export interface EntrySeo {
  /** The browser title and the title of a link preview, used as it is written (no site name added). */
  title?: string;
  /** What search engines and link previews show of it. Absent: its excerpt, else the site's description. */
  description?: string;
  /** A library image's asset ID to share it with. Absent: its featured image, else the site's sharing image. */
  socialImage?: string;
  /** Search engines are asked not to list it, and it is left out of the sitemap, as a page's switch does. */
  noindex?: boolean;
  /** Left out of the site's own search, whatever search engines are told, as a page's switch does. */
  searchHidden?: boolean;
  /** The address search engines are told is its own, as a page's canonical override is. */
  canonical?: string;
}

export interface PageDoc extends NodeTree {
  schemaVersion: number;
  id: string;
  title: string;
  route: string;
  navLabel?: string;
  seo: PageSeo;
  /** Whether this page shows the site's shared header. Each page chooses on its own. */
  showHeader: boolean;
  /** Whether this page shows the site's shared footer, independently of the header. */
  showFooter: boolean;
  /**
   * A draft stays in the project (editable, previewed, in the editable project export) but is left out of the
   * website: no page file, no sitemap entry, no old address leading to it. Unlike seo.noindex, which publishes the
   * page and only asks search engines not to list it. The Home page is never a draft.
   */
  draft?: boolean;
  /** The language this page is written in, as a code such as "fr" or "en-AU". Absent: the site's language. */
  language?: string;
  /**
   * Pages sharing this key are the same page in different languages: each lists every other as an alternate
   * version. No two pages of one group are in the same language. The key means nothing beyond that.
   */
  translationGroup?: string;
  /** Makes the page a dated article, such as a news item or an announcement (see shared/articles.ts). */
  article?: PageArticle;
  /**
   * When the page's content was last revised, as the author states it (YYYY-MM-DD), as an entry's `updatedAt` is.
   * It is the sitemap's last-modified date for the page. Absent on pages stored before it existed: no date is made up.
   */
  updatedAt?: string;
}

/**
 * What makes a page a dated article. News lists show the site's articles newest first, by `date`, with the page's
 * title; the page's own Article header shows the same values.
 */
export interface PageArticle {
  /** Publication date, a calendar day written YYYY-MM-DD. It may be in the past (a backdated piece). */
  date: string;
  /** Who wrote it, shown as written ("By Ana Ruiz", "Market team"). */
  byline?: string;
  /** A short summary for news lists and the article's introduction. */
  excerpt?: string;
  /** Left out of news lists, while the page itself stays published. */
  hidden?: boolean;
}

export interface SiteDoc {
  schemaVersion: number;
  name: string;
  language: string;
  /** Which way the site's text runs. Absent: the way its language is written (right to left for Arabic or Hebrew). */
  direction?: 'ltr' | 'rtl';
  description: string;
  baseUrl?: string;
  favicon?: string | null;
  socialImage?: string | null;
  /** The site's X (Twitter) account, written "@handle", named by link previews as `twitter:site`. Absent: none. */
  twitterSite?: string;
  homePageId: string;
  pageOrder: string[];
  themeId: string;
  /** Shared header and footer instances. */
  shell: { header: NodeTree; footer: NodeTree };
  /**
   * Addresses a page or a published collection entry used to have, kept working for old links and bookmarks: each
   * sends visitors to that one's current address. Nothing else uses one of these routes; a page given one takes it
   * over, and an entry can take back its own.
   */
  redirects?: SiteRedirect[];
  /** The not-found page's heading, message and Home link label; the defaults are used while these are unset. */
  notFoundHeading?: string;
  notFoundMessage?: string;
  notFoundLinkLabel?: string;
  /**
   * The author's wording for what the site says on its own (the skip link, the menu button, a form's progress), by
   * lower-case language code and then by piece (src/shared/visitor-text.ts). Anything left out uses the built-in
   * wording for the language.
   */
  visitorText?: Record<string, Record<string, string>>;
  /**
   * What the website offers AI agents beside its pages (src/shared/llms.ts): the llms.txt index of its pages and entries,
   * on unless this is false; llms-full.txt, every one of them in one file, while true; a Markdown copy beside each one
   * (`/about/index.html.md`), while true; and the short summary the index opens with, else the site's description.
   */
  llmsTxt?: boolean;
  llmsFull?: boolean;
  markdownMirrors?: boolean;
  llmsSummary?: string;
  /**
   * Whether the website declares tools to AI agents in visitors' browsers through WebMCP (src/shared/webmcp.ts): its
   * contact forms, and its search while it has one. Off unless this is true.
   */
  webmcp?: boolean;
  /**
   * Which crawlers the website's robots.txt asks to stay away, and whether its pages ask AI services not to train on
   * them (src/shared/crawler-policy.ts). Absent: every crawler is let in, as the website always did.
   */
  crawlerPolicy?: CrawlerPolicy;
  /**
   * Who publishes the site, as search engines and AI answer engines are told it in the pages' structured data
   * (src/shared/site-identity.ts). Absent: the site's name, as an organization, with nothing else said of it.
   */
  identity?: SiteIdentity;
}

/** The kinds of entity a site can be published by. */
export type EntityKind = 'Organization' | 'LocalBusiness' | 'Person';

/**
 * The site's publisher. Every field is optional; one left out says nothing. Contact details are said of any kind;
 * opening hours, price range and map position only of a local business, and choosing another kind clears them.
 */
export interface SiteIdentity {
  /** Absent: not chosen yet, and the site is described as an organization. */
  kind?: EntityKind;
  /** The publisher's legal or brand name, when it is not the site's name. */
  name?: string;
  /** The publisher's own home page, when it is not this site (https://…). */
  url?: string;
  /** A library image's asset ID: the organization's logo, or the person's photo. */
  logo?: string;
  /** Addresses of the publisher's profiles elsewhere that say who it is (Wikidata, LinkedIn, GitHub…), in order. */
  sameAs?: string[];
  /** The publisher's X (Twitter) handle, with its @. */
  twitterSite?: string;
  /** A postal address, as one line. */
  address?: string;
  telephone?: string;
  email?: string;
  /** When a local business is open, one Schema.org period per line ("Mo-Fr 09:00-17:00"). */
  openingHours?: string[];
  /** A local business's price range ("$$", "R100–R400"). */
  priceRange?: string;
  /** Where a local business is on a map. */
  geo?: { latitude: number; longitude: number };
}

/**
 * An old address that sends visitors on to a page or a collection entry, by ID, so it follows that one's later moves.
 * It names exactly one of them.
 */
export type SiteRedirect = { from: string; pageId: string; entryId?: never } | { from: string; entryId: string; pageId?: never };

export interface AssetRecord {
  id: string;
  name: string;
  file: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  hash: string;
  /** A document is a file visitors download (a PDF, a spreadsheet), linked to rather than shown. */
  kind: 'image' | 'font' | 'document';
  /** Smaller generated copies for responsive srcset, narrowest first. Originals are always kept. */
  variants?: Array<{ width: number; file: string }>;
  description?: string;
  altSuggestion?: string;
  /** For a font: the family it provides and the weight (or variable range, "100 900") and style of this file. */
  font?: FontFace;
  /**
   * For a document: the name of the file it came from ("Exhibitor guide.pdf"), which visitors' downloads keep. For a
   * font: the name of the file it was imported from, shown to tell its files apart.
   */
  originalName?: string;
  createdAt: string;
}

export interface FontFace {
  family: string;
  weight: string;
  style: 'normal' | 'italic';
}

export interface AssetsDoc {
  schemaVersion: number;
  assets: Record<string, AssetRecord>;
}

export interface ProjectManifest {
  schemaVersion: number;
  projectId: string;
  name: string;
  /**
   * The author's own name for this working copy (#176), given when the project was duplicated: Recent projects and the
   * toolbar show it in place of the site's name, through every rename of the site. Visitors never see it.
   */
  workingCopyName?: string;
  createdAt: string;
  template: { id: string; version: string };
  generator: string;
  app: string;
}

/**
 * The project brief (#518): `siteorigin/brief.json`, what the project is for, kept for its author alone. It travels
 * with the project folder and Duplicate project, and never reaches the website or an export. Absent while both fields
 * are empty.
 */
export interface ProjectBriefDoc {
  schemaVersion: number;
  /**
   * What the site is and who it is for, in a line or two. Recent projects shows it under the project's name. The app
   * always writes both fields; one left out of a file written by hand reads as empty (see `briefText`).
   */
  description?: string;
  /** Free-form working notes: the client, the audience, what the site should achieve. */
  notes?: string;
}

export interface ThemeLock {
  schemaVersion: number;
  /**
   * The theme pack in use. `digest` pins an installed (not bundled) pack's exact release, so a different copy
   * under the same version is noticed before it restyles the site.
   */
  theme: { id: string; version: string; digest?: string };
  components: Record<string, { componentId: string; version: string; hash: string }>;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** The kinds of custom field a collection's entries can fill in: one plain value, or a picture. */
export type CollectionFieldSchema = StringProp | NumberProp | BooleanProp | EnumProp | ImageProp;
export const COLLECTION_FIELD_TYPES = ['string', 'number', 'boolean', 'enum', 'image'] as const;
export type CollectionFieldValue = string | number | boolean | ImageValue;

/** One way of grouping a collection's entries, such as categories or tags. */
export interface CollectionTaxonomy {
  label: string;
  /** Terms by stable ID, in the order they are offered. Renaming a term keeps every entry's assignment. */
  terms: Record<string, { label: string }>;
}

/**
 * A collection's settings: `siteorigin/collections/<id>/collection.json`. Its entries are files of their own beside
 * it, under `entries/`, so editing one post rewrites one file.
 */
export interface CollectionDoc {
  schemaVersion: number;
  /** Stable lowercase slug such as "posts" or "case-studies"; also the collection's folder name. */
  id: string;
  name: string;
  /**
   * The address prefix every entry's address starts with, such as "/blog/". The collection owns this exact address
   * and each entry owns its prefix plus slug; no page or old page address may use either.
   */
  route: string;
  /** Groupings by stable ID ("categories", "tags"). */
  taxonomies: Record<string, CollectionTaxonomy>;
  /** Custom fields every entry can fill in, by stable name. An entry without a value of its own shows the default. */
  fields: Record<string, CollectionFieldSchema>;
  /**
   * An editorial order chosen for the entries, listing each exactly once. Absent, entries go newest first by
   * `publishedAt` (then by ID), as dated articles do.
   */
  entryOrder?: string[];
  /**
   * How many entries each page of the collection's index (its own address, then `page/2/`, `page/3/`...) and of each
   * category's archive lists, newest first. Absent: 10.
   */
  pageSize?: number;
  /** Whether each category with a published entry gets an archive at `category/<term ID>/`. Absent: it does. */
  categoryArchives?: boolean;
  /**
   * The layout every entry's page is shown with: a tree of sections and elements, edited like a page's, whose nodes
   * and placed sections read the entry they are shown for through `{ $entry: field }` bindings. Editing it changes
   * every entry's page; each entry keeps its own words and details.
   */
  template: NodeTree;
}

/** One entry of a collection: `siteorigin/collections/<collectionId>/entries/<id>.json`. */
export interface EntryDoc {
  schemaVersion: number;
  /** Stable `en_…` ID, unique across the whole project, so links to it name no collection. */
  id: string;
  /** The last segment of its address: one lowercase segment, unique among the site's addresses. */
  slug: string;
  title: string;
  /** Publication date, a calendar day written YYYY-MM-DD. It may be in the past (a backdated piece). */
  publishedAt: string;
  /** When it was last revised, as the author states it (YYYY-MM-DD). */
  updatedAt?: string;
  /** A draft stays in the project and keeps its address, but is left out of the website. */
  draft: boolean;
  /** Who wrote it, shown as written. */
  author?: string;
  excerpt?: string;
  /** A library image's asset ID. */
  featuredImage?: string;
  /** Search settings. Absent on every entry stored before they existed. */
  seo?: EntrySeo;
  /** Assigned term IDs, by taxonomy ID. */
  terms: Record<string, string[]>;
  /** Custom field values by field name. A field left out shows its default. */
  values: Record<string, CollectionFieldValue>;
  body: RichText;
}

/** A collection in memory: its settings and its entries, each stored in a file of its own. */
export interface Collection {
  settings: CollectionDoc;
  entries: Record<string, EntryDoc>;
}

/** The full in-memory project state. */
export interface ProjectState {
  manifest: ProjectManifest;
  site: SiteDoc;
  pages: Record<string, PageDoc>;
  components: Record<string, ComponentDefinition>;
  tokens: TokensDoc;
  assets: AssetsDoc;
  themeLock: ThemeLock;
  /** Collections by ID. Empty for a project without any (and for every project stored before collections). */
  collections: Record<string, Collection>;
  /** The private project brief. Absent while it is empty, as for every project stored before it existed. */
  brief?: ProjectBriefDoc;
}

// ---------------------------------------------------------------------------
// Selection identity
// ---------------------------------------------------------------------------

export type OwnerKind = 'page' | 'shell' | 'component' | 'template';
export interface OwnerRef {
  kind: OwnerKind;
  /** Page ID, shell part ('header' | 'footer'), definition ID, or (for a layout template) collection ID. */
  id: string;
}

export interface ElementRef {
  owner: OwnerRef;
  /** Instances entered from the owner tree down to the target's containing definition. */
  instancePath: string[];
  /** Target node within the innermost tree (owner tree when instancePath is empty). */
  nodeId: string;
  /** Public part ID when the target is a declared part of a definition. */
  partId?: string;
  /** Repeated item IDs from outermost to innermost. */
  itemPath?: string[];
}

export function refKey(ref: ElementRef): string {
  return [
    `${ref.owner.kind}:${ref.owner.id}`,
    ...ref.instancePath,
    ref.nodeId,
    ref.itemPath?.length ? `#${ref.itemPath.join(',')}` : ''
  ].join('|');
}

export function sameRef(a: ElementRef | null | undefined, b: ElementRef | null | undefined): boolean {
  if (!a || !b) return a === b;
  return refKey(a) === refKey(b);
}
