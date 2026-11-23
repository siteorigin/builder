/**
 * Canonical project document types.
 *
 * These are the authoritative, versioned authoring documents stored under `siteorigin/`.
 * Svelte routes, components and stylesheets are derived from them by the generator.
 */
import { LATEST_SCHEMA_VERSION } from './migrations';
import type { RichListType, RichText } from './richtext';

export type { RichBlock, RichListBlock, RichListType, RichSpan, RichText, RichTextBlock } from './richtext';

/** The current document format: one more than the number of migrations (see `./migrations`). */
export const SCHEMA_VERSION = LATEST_SCHEMA_VERSION;
export const GENERATOR_VERSION = '0.1.0';

export type ResponsiveScope = 'base' | 'phone' | 'tablet' | 'desktop';
export const RESPONSIVE_SCOPES: ResponsiveScope[] = ['base', 'phone', 'tablet', 'desktop'];

/** A literal style value or a reference to a site token. */
export type StyleValue = string | number | boolean | { token: string };
export type StyleProps = Record<string, StyleValue>;
export type ResponsiveStyles = Partial<Record<ResponsiveScope, StyleProps>>;

export type LinkType = 'none' | 'page' | 'url' | 'email' | 'tel' | 'anchor';
export interface LinkValue {
  type: LinkType;
  /** Page ID, URL, email address, telephone number or anchor ID depending on `type`. */
  target: string;
  /** Optional in-page anchor for page links. */
  anchor?: string;
  newTab?: boolean;
}

export interface ImageValue {
  assetId: string | null;
  alt: string;
  decorative?: boolean;
}

/** Binding to a property of the enclosing component, or a field of the current repeated item. */
export type Binding = { $prop: string } | { $item: string };
export type Bindable<T> = T | Binding;

export function isBinding(v: unknown): v is Binding {
  return !!v && typeof v === 'object' && ('$prop' in (v as object) || '$item' in (v as object));
}

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
}
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
export type ScalarPropSchema =
  | StringProp
  | RichTextProp
  | NumberProp
  | BooleanProp
  | EnumProp
  | LinkProp
  | ImageProp
  | IconProp;
export interface ListProp extends PropBase {
  type: 'list';
  itemLabel: string;
  /** Item field used as the readable title of an item. */
  titleField?: string;
  fields: Record<string, ScalarPropSchema>;
  default: ListItem[];
  min?: number;
  max?: number;
}
export type PropSchema = ScalarPropSchema | ListProp;
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
  /** Render only when the bound value is truthy (non-empty string, true, non-empty list, link with target). */
  when?: Binding;
  /** Render only when the bound value is empty. */
  unless?: Binding;
  /** Optional anchor ID for in-page links. */
  anchor?: string;
}
export interface ElementNode extends NodeBase {
  kind: 'element';
  tag: ElementTag;
  children: string[];
  /**
   * Render only when at least one child renders, judged from the children's own conditions (a nested
   * collapsing element by its children, a repeat by its list). A child that always renders keeps this one.
   */
  collapseEmpty?: boolean;
}
export interface TextNode extends NodeBase {
  kind: 'text';
  tag: TextTag;
  /** For rich text nodes the value is structured blocks. */
  text: Bindable<string | RichText>;
  rich?: boolean;
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
}
export interface IconNode extends NodeBase {
  kind: 'icon';
  icon: Bindable<string>;
}
export interface DividerNode extends NodeBase {
  kind: 'divider';
}
export interface RepeatNode extends NodeBase {
  kind: 'repeat';
  list: { $prop: string };
  children: string[];
}
export interface SlotNode extends NodeBase {
  kind: 'slot';
  slot: string;
}
export interface InstanceNode extends NodeBase {
  kind: 'instance';
  definitionId: string;
  props: Record<string, unknown>;
  /** The option chosen on each of the definition's variant axes. An axis left out uses its default. */
  variants?: Record<string, string>;
  /** Instance style overrides keyed by public part ID ("root" is the instance boundary). */
  overrides?: Record<string, ResponsiveStyles>;
  /** Content placed into the definition's declared slots. */
  slots?: Record<string, string[]>;
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
  slots?: Record<string, { label: string }>;
  variantAxes?: Record<string, VariantAxis>;
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

export interface TokensDoc {
  schemaVersion: number;
  overrides: Record<string, TokenValue>;
  custom: TokenDef[];
}

// ---------------------------------------------------------------------------
// Site, pages and assets
// ---------------------------------------------------------------------------

export interface PageSeo {
  title?: string;
  description?: string;
  socialImage?: string | null;
  noindex?: boolean;
}

export interface PageDoc extends NodeTree {
  schemaVersion: number;
  id: string;
  title: string;
  route: string;
  navLabel?: string;
  seo: PageSeo;
  shell: 'default' | 'none';
}

export interface SiteDoc {
  schemaVersion: number;
  name: string;
  language: string;
  description: string;
  baseUrl?: string;
  favicon?: string | null;
  socialImage?: string | null;
  homePageId: string;
  pageOrder: string[];
  themeId: string;
  /** Shared header and footer instances. */
  shell: { header: NodeTree; footer: NodeTree };
}

export interface AssetRecord {
  id: string;
  name: string;
  file: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  hash: string;
  kind: 'image' | 'font';
  /** Smaller generated copies for responsive srcset, narrowest first. Originals are always kept. */
  variants?: Array<{ width: number; file: string }>;
  description?: string;
  altSuggestion?: string;
  /** For a font: the family it provides and the weight (or variable range, "100 900") and style of this file. */
  font?: FontFace;
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
  createdAt: string;
  template: { id: string; version: string };
  generator: string;
  app: string;
}

export interface ThemeLock {
  schemaVersion: number;
  theme: { id: string; version: string };
  components: Record<string, { componentId: string; version: string; hash: string }>;
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
}

// ---------------------------------------------------------------------------
// Selection identity
// ---------------------------------------------------------------------------

export type OwnerKind = 'page' | 'shell' | 'component';
export interface OwnerRef {
  kind: OwnerKind;
  /** Page ID, shell part ('header' | 'footer') or definition ID. */
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
