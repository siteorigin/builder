/**
 * Copy style and Paste style: the style changes a section, one of its parts or an element carries, taken as they
 * are when copied and pasted onto another selection as ordinary `node.setStyle` edits in one batch, so a single
 * Undo takes the whole paste back. Only style overrides move: content, links, images and design options stay.
 * One card of a repeated part goes where the inspector's Apply to says for that card: its own styles ("This card"),
 * or the style every card shares. Pure: it reads a project and says what a paste would change, for the editor to
 * show and send.
 */
import type { EditOperation } from "@shared/ops";
import type {
  ComponentDefinition,
  ElementRef,
  InstanceNode,
  ListItem,
  ListProp,
  OwnerRef,
  ProjectState,
  ResponsiveScope,
  ResponsiveStyles,
  StyleScope,
  StyleScopeKey,
  StyleState,
  StyleValue,
} from "@shared/types";
import {
  CONTAINER_SCOPES,
  STYLE_STATES,
  isContainerScope,
  parseStyleScopeKey,
  styleScopeKey,
} from "@shared/types";
import { GRID_CHILD_PROPS } from "./grid-child";
import {
  CONTAINER_SCOPE_LABEL,
  STYLE_PROP_MAP,
  containerStyleError,
  canonicalStyleValue,
  isStateStyleProp,
  offeredStyleProps,
  placementStyleControls,
  stateStyleError,
  styleSetFor,
  tokenVar,
  validateStyleValue,
} from "@shared/styles";
import { codeTakesOverrides, enclosingRepeatProp } from "@engine/tree";
import {
  itemStylesOf,
  liveItemStyles,
  placementItems,
  repeatedPartList,
} from "@shared/item-styles";
import {
  isBackgroundImageValue,
  isPictureAsset,
} from "@shared/background-image";
import { effectiveTokens } from "@generator/index";
import { resolveFontStack } from "@catalogue/fonts";
import {
  boundaryOf,
  ownerLabel,
  pagesUsingShell,
  refLabel,
  treeFor,
} from "./model";
import { itemReachKey } from "./item-reach";

export const STYLE_SCOPES: ResponsiveScope[] = [
  "base",
  "phone",
  "tablet",
  "desktop",
];
export const SCOPE_LABELS: Record<ResponsiveScope, string> = {
  base: "All sizes",
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Desktop",
};
export const STATE_LABELS: Record<StyleState, string> = {
  groupHover: "group hover",
  groupFocus: "group focus",
  hover: "hover",
  focus: "focus",
  active: "pressed",
};
/** A size's resting rule and then its state rules: every rule a paste for that size writes. */
const keysAt = (scope: StyleScope): StyleScopeKey[] => [
  scope,
  ...STYLE_STATES.map((st) => styleScopeKey(scope, st)),
];
/** Every rule a set of styles can hold, in the order a paste lists them: the screen sizes', then the container widths'. */
const ALL_KEYS: StyleScopeKey[] = [
  ...STYLE_SCOPES,
  ...CONTAINER_SCOPES,
].flatMap(keysAt);
const scopeLabel = (scope: StyleScope) =>
  isContainerScope(scope) ? CONTAINER_SCOPE_LABEL[scope] : SCOPE_LABELS[scope];
/** Where a change applies, in words: "Phone", or "All sizes, hover". */
/** A size range, and its state in brackets so a list of them never reads one as two: "All sizes (hover)". */
export const changeLabel = (c: { scope: StyleScope; state?: StyleState }) =>
  c.state
    ? `${scopeLabel(c.scope)} (${STATE_LABELS[c.state]})`
    : scopeLabel(c.scope);
/** The size range alone, for a row that shows the state beside it. */
export const changeSize = (c: { scope: StyleScope }) => scopeLabel(c.scope);
const andJoin = (items: string[]) =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** Which sizes a paste writes: every size the copy holds a change for, or only the changes made for one. */
export type PasteScope = "every" | ResponsiveScope;

/**
 * The Apply to chosen for one card of one placement (lib/item-reach's chosenReach): undefined while none has been
 * chosen, and then a card with styles of its own is styled on its own, as the inspector opens it.
 */
export type ReachChoice = (key: string) => "all" | "item" | undefined;
const noChoice: ReachChoice = () => undefined;

/** A card with styles of its own, which beat the style every card shares. */
export interface OwnItem {
  id: string;
  /** As the inspector names it: its title in quotes, or "Card 2". */
  name: string;
  styles: ResponsiveStyles;
}

/** Which copies of a repeated part a paste onto one of them changes, in the words of the inspector's Apply to. */
export interface RepeatReach {
  /** item: one card's own styles ("This card"); every: the style every card shares. */
  kind: "item" | "every";
  /** The part, as Apply to counts it: "card", or "card title". */
  partName: string;
  itemLabel: string;
  /** The list, as "Cards". */
  listLabel: string;
  /** The section the part is in. */
  parent: string;
  /** How many cards the list shows; none for a list worked out from the site's pages or filled from a collection. */
  count?: number;
  /** The card a paste onto one card goes to, as the inspector names it. */
  itemName?: string;
  /** A card can be styled on its own here (Apply to is offered), and one was picked on the page (not in Layers). */
  oneByOne: boolean;
  picked: boolean;
  /** Onto the style every card shares: how many cards keep styles of their own. */
  keeping?: number;
}

/** One set of style rules a selection carries, and where `node.setStyle` writes it. */
export interface StyleTarget {
  /** The part of a section ("root" is the section itself); null for a selected part or element, which is one set. */
  part: string | null;
  label: string;
  /** The properties the inspector offers here, and so the ones a paste may write. */
  offered: string[];
  styles: ResponsiveStyles | undefined;
  owner: OwnerRef;
  nodeId: string;
  partId?: string;
  /** A part inside a repeat is styled once for all of them: "every card". */
  reach?: string;
  /** Set when one card is styled on its own ("This card"): `styles` are that card's own. */
  itemId?: string;
  /** For one card: the style every card shares, which shows wherever this one sets nothing. */
  shared?: ResponsiveStyles;
  /** For the style every card shares: the cards with styles of their own, in list order, which keep theirs. */
  ownItems?: OwnItem[];
}

export interface StyleSelection {
  kind: "section" | "single";
  label: string;
  /** Where it is: "on the Home page", or the shared header and the pages that show it. */
  where: string;
  targets: StyleTarget[];
  /** A part repeated once per card: whether this changes one card or all of them. */
  repeat?: RepeatReach;
}

/** What Copy style took: each set's rules, detached from the project, so later edits to the original don't change it. */
export interface StyleCopy {
  kind: "section" | "single";
  label: string;
  sets: Array<{ part: string | null; label: string; styles: ResponsiveStyles }>;
  /** The site styles there were when it was copied, as CSS text names them, to tell one removed since. */
  vars: string[];
}

/** One override a paste writes (`to`) over what the destination has now (`from`). No `to` removes the override. */
export interface PasteChange {
  scope: StyleScope;
  /** The interactive state the value is for; none for the resting style. */
  state?: StyleState;
  from?: StyleValue;
  to?: StyleValue;
  /**
   * Onto one card: the shared value it shows here while it has none of its own. Beside a new value, what it shows
   * now and stops using; beside a cleared one, what it shows once the paste is done.
   */
  shared?: StyleValue;
}

/** A card that keeps its own value for a style over a change to the style every card shares, and where. */
export interface KeptValue {
  id: string;
  name: string;
  scope: StyleScope;
  state?: StyleState;
  value: StyleValue;
}

export interface PasteRow {
  /** The part it lands on (or, with nowhere to go, the copied part it came from); null for a single part or element. */
  part: string | null;
  /** Where it lands: the destination part or element, or the copied part that has nowhere to go. */
  target: string;
  property: string;
  label: string;
  /** change: the paste writes it; same: the destination already matches; skip: it can't be pasted here (`reason`). */
  status: "change" | "same" | "skip";
  reason?: string;
  changes: PasteChange[];
  /** Onto the style every card shares: the cards with a value of their own for this style that beats the change. */
  kept?: KeptValue[];
  /** Left out of this paste by the caller: shown, but no edit is made for it. */
  left?: boolean;
}

/** A row's identity in a review: the part it lands on and the property. */
export const pasteRowKey = (r: { part: string | null; property: string }) =>
  `${r.part ?? ""}:${r.property}`;

/** Where a style sits in its parent rather than how it looks: a paste starts with these left out. */
export const PLACEMENT_PROPS: readonly string[] = [
  "columnStart",
  "columnSpan",
  "rowSpan",
  "order",
];

export interface PastePlan {
  /** Null when the selection takes no style changes. */
  destination: StyleSelection | null;
  rows: PasteRow[];
  operations: EditOperation[];
}

const own = <T>(
  rec: Record<string, T> | undefined,
  key: string,
): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);
const TEXT_TOKEN_RE = /^text\.[a-z0-9-]+$/;
const FONT_KEYWORD_RE =
  /^(inherit|initial|unset|revert|revert-layer|var\(.*)$/i;

function whereOf(state: ProjectState, owner: OwnerRef): string {
  if (owner.kind === "shell") {
    const n = pagesUsingShell(state, owner.id);
    return `in the shared ${owner.id}, shown on ${n === 1 ? "1 page" : `${n} pages`}`;
  }
  return `on the ${ownerLabel(state, owner)} page`;
}

/** The list a part repeats over: the repeat around it in a design, or the list a code component says it repeats over. */
function repeatListOf(
  def: ComponentDefinition,
  partId: string,
): ListProp | undefined {
  const part = own(def.parts, partId);
  const prop =
    def.kind === "code"
      ? part?.list
      : part
        ? enclosingRepeatProp(def, part.nodeId)
        : undefined;
  const schema =
    typeof prop === "string" ? own(def.properties, prop) : undefined;
  return schema?.type === "list" ? schema : undefined;
}

/**
 * The cards a placement's part can be styled one at a time on, as the inspector offers it: a list that keeps its own
 * items (not one worked out from pages, nor a code placement's list filled from a collection). None otherwise.
 */
function cardsOf(
  def: ComponentDefinition,
  inst: InstanceNode,
  partId: string,
): { schema: ListProp; items: ListItem[] } | undefined {
  const list = repeatedPartList(def, partId);
  if (
    !list ||
    (def.kind === "code" && Object.hasOwn(inst.listSources ?? {}, list))
  )
    return undefined;
  const schema = own(def.properties, list);
  return schema?.type === "list"
    ? { schema, items: placementItems(def, inst, list) }
    : undefined;
}

/** A card as the inspector names it: its title in quotes, or "Card 2". */
function cardName(schema: ListProp, items: ListItem[], index: number): string {
  const t = schema.titleField ? items[index]?.[schema.titleField] : undefined;
  return typeof t === "string" && t.trim()
    ? `“${t.trim()}”`
    : `${schema.itemLabel} ${index + 1}`;
}

/** The cards that keep styles of their own for a part, in list order. */
function ownItemsOf(
  def: ComponentDefinition,
  inst: InstanceNode,
  partId: string,
  cards: { schema: ListProp; items: ListItem[] },
): OwnItem[] {
  const styled = liveItemStyles(def, inst, partId)?.items ?? {};
  return cards.items.flatMap((it, i) => {
    const styles = own(styled, it.id);
    return styles && typeof styles === "object" && hasRules(styles)
      ? [{ id: it.id, name: cardName(cards.schema, cards.items, i), styles }]
      : [];
  });
}

function partTarget(
  def: ComponentDefinition,
  inst: InstanceNode,
  owner: OwnerRef,
  partId: string,
  list: string[] | undefined,
): StyleTarget {
  const part = own(def.parts, partId);
  const repeat = repeatListOf(def, partId);
  const cards = repeat ? cardsOf(def, inst, partId) : undefined;
  return {
    part: partId,
    label: part?.label ?? "Section",
    offered: offeredStyleProps(list),
    styles: inst.overrides?.[partId],
    owner,
    nodeId: inst.id,
    partId,
    ...(repeat ? { reach: `every ${repeat.itemLabel.toLowerCase()}` } : {}),
    ...(cards ? { ownItems: ownItemsOf(def, inst, partId, cards) } : {}),
  };
}

/**
 * The style sets a selection carries, as the inspector edits them: a section's own and each of its parts', or the
 * one set of a selected part or element. A part picked in one card of a list is that card's own styles when Apply
 * to is "This card" for it (`reach`), else the style every card shares. Null for what takes no style changes of its
 * own here: a component's design (Edit everywhere styles every placement), a part of a component nested inside a
 * section, a repeat or slot.
 */
export function styleSelection(
  state: ProjectState,
  ref: ElementRef,
  reach: ReachChoice = noChoice,
): StyleSelection | null {
  // A slot of a placement, picked by its empty box, is a place for content: it has no styles of its own.
  if (ref.owner.kind === "component" || ref.slot !== undefined) return null;
  // A part picked by name stays that part, as in the inspector, even on its component's root element: a component
  // made from one heading names both.
  const named =
    ref.instancePath.length > 0 && !!ref.partId && ref.partId !== "root";
  const b = named ? ref : boundaryOf(state, ref);
  const tree = treeFor(state, b.owner);
  if (!tree) return null;
  const where = whereOf(state, b.owner);
  if (!b.instancePath.length) {
    const node = own(tree.nodes, b.nodeId);
    if (!node || node.kind === "repeat" || node.kind === "slot") return null;
    if (node.kind !== "instance") {
      const label = refLabel(state, b);
      return {
        kind: "single",
        label,
        where,
        targets: [
          {
            part: null,
            label,
            offered: offeredStyleProps(styleSetFor(node)),
            styles: node.styles,
            owner: b.owner,
            nodeId: node.id,
          },
        ],
      };
    }
    const def = own(state.components, node.definitionId);
    if (!def) return null;
    const codeStyled = def.kind === "code" && codeTakesOverrides(def);
    const targets = [
      "root",
      ...Object.keys(def.parts).filter((p) => p !== "root"),
    ].flatMap((p) => {
      const list = placementStyleControls(def, p, codeStyled);
      return list === null ? [] : [partTarget(def, node, b.owner, p, list)];
    });
    return targets.length
      ? { kind: "section", label: node.name ?? def.name, where, targets }
      : null;
  }
  if (b.instancePath.length !== 1 || !b.partId || b.partId === "root")
    return null;
  const inst = own(tree.nodes, b.instancePath[0]);
  const def =
    inst?.kind === "instance"
      ? own(state.components, inst.definitionId)
      : undefined;
  // The part must still be the element that was picked: a change to the design can give its name to another.
  if (
    inst?.kind !== "instance" ||
    !def ||
    own(def.parts, b.partId)?.nodeId !== b.nodeId
  )
    return null;
  const list = placementStyleControls(
    def,
    b.partId,
    def.kind === "code" && codeTakesOverrides(def),
  );
  if (list === null) return null;
  const t = partTarget(def, inst, b.owner, b.partId, list);
  const parent = inst.name ?? def.name;
  const repeated = repeatListOf(def, b.partId);
  if (!repeated)
    return {
      kind: "single",
      label: `${t.label} in ${parent}`,
      where,
      targets: [{ ...t, part: null }],
    };
  const cards = cardsOf(def, inst, b.partId);
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  const index =
    cards && itemId ? cards.items.findIndex((x) => x.id === itemId) : -1;
  // A card that has left its list (removed, or an undo took it back) is neither its own style nor the shared one
  // the author picked: nothing is offered until they pick again, as in the inspector.
  if (cards && itemId && index < 0) return null;
  const words = {
    partName: t.label.toLowerCase(),
    itemLabel: repeated.itemLabel.toLowerCase(),
    listLabel: repeated.label,
    parent,
    oneByOne: !!cards,
    picked: index >= 0,
    ...(cards ? { count: cards.items.length } : {}),
  };
  // The card it was picked in is styled on its own when Apply to says so for that card (or, with nothing chosen
  // yet, when the card has styles of its own), as the inspector and the canvas's spacing handles do.
  if (cards && itemId && index >= 0) {
    const mine = itemStylesOf(def, inst, b.partId, itemId);
    if (
      (reach(itemReachKey(b.owner, inst.id, itemId)) ??
        (mine ? "item" : "all")) === "item"
    ) {
      const name = cardName(cards.schema, cards.items, index);
      // "Card “Planning & layout”", or "Card title of “Planning & layout”" for another part of the card.
      const card =
        t.label.toLowerCase() === words.itemLabel
          ? name.startsWith("“")
            ? `${t.label} ${name}`
            : name
          : `${t.label} of ${name}`;
      const { ownItems: _others, ...rest } = t;
      return {
        kind: "single",
        label: `${card} in ${parent}`,
        where,
        targets: [
          { ...rest, part: null, itemId, styles: mine, shared: t.styles },
        ],
        repeat: { ...words, kind: "item", itemName: name },
      };
    }
  }
  return {
    kind: "single",
    label: `${t.label} in ${parent}`,
    where,
    targets: [{ ...t, part: null }],
    repeat: {
      ...words,
      kind: "every",
      ...(t.ownItems ? { keeping: t.ownItems.length } : {}),
    },
  };
}

const hasRules = (s: ResponsiveStyles | undefined) =>
  ALL_KEYS.some((sc) => Object.keys(s?.[sc] ?? {}).length > 0);

/**
 * Take the style a selection carries now: for one card styled on its own, that card's own styles. Null when it takes
 * none; a copy with no sets has nothing to paste.
 */
export function captureStyle(
  state: ProjectState,
  ref: ElementRef,
  reach: ReachChoice = noChoice,
): StyleCopy | null {
  const sel = styleSelection(state, ref, reach);
  if (!sel) return null;
  const sets = sel.targets
    .filter((t) => hasRules(t.styles))
    .map((t) => ({
      part: t.part,
      label: t.label,
      styles: JSON.parse(JSON.stringify(t.styles)) as ResponsiveStyles,
    }));
  return {
    kind: sel.kind,
    label: sel.label,
    sets,
    vars: effectiveTokens(state).map((t) => tokenVar(t.id)),
  };
}

/** Links compare as stored (token first, a strength only below full), so key order and a full strength of 1 are no change. */
const sameValue = (a: StyleValue | undefined, b: StyleValue | undefined) =>
  (a && typeof a === "object") || (b && typeof b === "object")
    ? JSON.stringify(a && canonicalStyleValue(a)) ===
      JSON.stringify(b && canonicalStyleValue(b))
    : a === b;

/** The site style a value links to, also in the older bare "text.h2" spelling of a text style. */
function tokenRef(property: string, v: StyleValue): string | null {
  if (v && typeof v === "object")
    return typeof v.token === "string" ? v.token : null;
  return property === "textStyle" &&
    typeof v === "string" &&
    TEXT_TOKEN_RE.test(v.trim())
    ? v.trim()
    : null;
}

/**
 * A value an edit can carry: a literal, a link, `{ token }` or a colour's `{ token, alpha }` (validateStyleValue
 * checks where a strength may go), or a background image naming a library image. Anything else came from a
 * hand-edited document.
 */
function isStyleValue(v: unknown): v is StyleValue {
  if (typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (isBackgroundImageValue(v)) return true;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    typeof (v as { token?: unknown }).token !== "string"
  )
    return false;
  const keys = Object.keys(v);
  return (
    keys.length === 1 ||
    (keys.length === 2 && typeof (v as { alpha?: unknown }).alpha === "number")
  );
}

/** CSS variables named in CSS text, such as a gradient's `var(--so-color-brand)` (`var` in any case, as CSS reads it). */
const CSS_VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)/gi;
/** The variables a text style is read through, one per metric, after its own name. */
const TEXT_METRICS = [
  "family",
  "size",
  "line-height",
  "weight",
  "tracking",
  "transform",
];
const removed = (token: string) =>
  `It uses the site style “${token}”, which has been removed since it was copied.`;

/** What a check of the copy needs: the site styles now (by ID and as CSS text names them), and when it was copied. */
interface Known {
  tokens: Set<string>;
  vars: Set<string>;
  copied: Set<string>;
}

/**
 * The value a paste writes for a copied one, and the value the edit stores for it (a font named on its own is stored
 * as its full stack), or why it can't be written into this project now: the checks the edit makes, so one value
 * never fails the whole paste.
 */
function prepare(
  state: ProjectState,
  known: Known,
  property: string,
  v: unknown,
  inState: StyleState | undefined,
  inContainer = false,
): { value: StyleValue; stored: StyleValue } | { error: string } {
  if (!isStyleValue(v))
    return { error: "The copied value isn’t one the builder can paste." };
  // A hand-edited document can hold a state value the builder never writes, or a container width's.
  if (inState && !isStateStyleProp(property, inState))
    return { error: stateStyleError(property, inState)! };
  const containerError = inContainer ? containerStyleError(property) : null;
  if (containerError) return { error: containerError };
  const err = validateStyleValue(property, v);
  if (err) return { error: err };
  // A picture from another project, or one removed since it was copied, is not here to show.
  if (isBackgroundImageValue(v)) {
    const asset = Object.hasOwn(state.assets.assets, v.assetId)
      ? state.assets.assets[v.assetId]
      : undefined;
    if (!isPictureAsset(asset))
      return {
        error: "The copied background image is not in this project’s library.",
      };
  }
  const token = tokenRef(property, v);
  if (token && !known.tokens.has(token)) return { error: removed(token) };
  // CSS text naming a site style's variable (or one of a text style's metrics): only a style there was when copied,
  // and is no longer, is missing.
  if (typeof v === "string")
    for (const [, name] of v.matchAll(CSS_VAR_RE)) {
      const metric =
        known.copied.has(name) || !name.startsWith("--so-text-")
          ? undefined
          : TEXT_METRICS.find(
              (m) =>
                name.endsWith(`-${m}`) &&
                known.copied.has(name.slice(0, -m.length - 1)),
            );
      const style = metric ? name.slice(0, -metric.length - 1) : name;
      if (known.copied.has(style) && !known.vars.has(style))
        return { error: removed(style.slice(5)) };
    }
  if (
    property === "fontFamily" &&
    typeof v === "string" &&
    !FONT_KEYWORD_RE.test(v.trim())
  ) {
    // The edit checks the value as written, then stores the stack, which may be longer than a value may be written.
    const font = resolveFontStack(state, v);
    return "error" in font
      ? { error: font.error }
      : { value: v, stored: font.stack };
  }
  // The edit stores a link token first, with its strength only below full.
  return { value: v, stored: canonicalStyleValue(v) };
}

/**
 * What one card with nothing of its own at a size shows there from the style every card shares: nothing while its
 * own All sizes value holds (a card's own rule beats the shared one at every size), else the shared value for that
 * size, or for all sizes. `own` reads the card's own values as they stand then: now, or once the paste is done.
 * Nothing is promised where a container width's value (the card's own, or the shared style's) can win instead: which
 * one shows depends on the width of the box around the card.
 */
function sharedShown(
  t: StyleTarget,
  sc: StyleScopeKey,
  property: string,
  own: (k: StyleScopeKey) => StyleValue | undefined,
): StyleValue | undefined {
  const at = parseStyleScopeKey(sc)!;
  const base = styleScopeKey("base", at.state);
  if (
    !t.itemId ||
    isContainerScope(at.scope) ||
    (at.scope !== "base" && own(base) !== undefined)
  )
    return undefined;
  if (
    CONTAINER_SCOPES.some(
      (c) =>
        own(styleScopeKey(c, at.state)) !== undefined ||
        t.shared?.[styleScopeKey(c, at.state)]?.[property] !== undefined,
    )
  )
    return undefined;
  return (
    t.shared?.[sc]?.[property] ??
    (at.scope === "base" ? undefined : t.shared?.[base]?.[property])
  );
}

/**
 * The cards that keep a value of their own over a change to the style every card shares: at each size and state where
 * the shared value in use changes (a size with nothing of its own uses All sizes), a card showing its own value there
 * keeps it. A card's own rule beats the shared one at every size, so at a size it shows its value for that size, else
 * its All sizes value. Container widths count as sizes: those the paste writes, and those a card has values for,
 * which hold wherever that width does. `before` and `after` read the shared style now and once the paste is done.
 */
function keptOver(
  items: OwnItem[],
  property: string,
  changes: PasteChange[],
  before: (k: StyleScopeKey) => StyleValue | undefined,
  after: (k: StyleScopeKey) => StyleValue | undefined,
): KeptValue[] {
  const out: KeptValue[] = [];
  for (const it of items) {
    const seen = new Set<StyleScopeKey>();
    for (const st of new Set(changes.map((c) => c.state))) {
      const base = styleScopeKey("base", st);
      const widths = CONTAINER_SCOPES.filter(
        (c) =>
          changes.some((x) => x.state === st && x.scope === c) ||
          it.styles[styleScopeKey(c, st)]?.[property] !== undefined,
      );
      for (const size of [...STYLE_SCOPES, ...widths]) {
        const k = styleScopeKey(size, st);
        const used = (read: (k: StyleScopeKey) => StyleValue | undefined) =>
          size === "base" ? read(k) : (read(k) ?? read(base));
        if (sameValue(used(before), used(after))) continue;
        const mine =
          it.styles[k]?.[property] !== undefined
            ? k
            : it.styles[base]?.[property] !== undefined
              ? base
              : undefined;
        if (!mine || seen.has(mine)) continue;
        seen.add(mine);
        const at = parseStyleScopeKey(mine)!;
        out.push({
          id: it.id,
          name: it.name,
          scope: at.scope,
          ...(at.state ? { state: at.state } : {}),
          value: it.styles[mine]![property],
        });
      }
    }
  }
  return out;
}

const scopeList = (s: ResponsiveStyles, property: string) =>
  ALL_KEYS.filter((k) => s[k]?.[property] !== undefined).map((k) =>
    changeLabel(parseStyleScopeKey(k)!),
  );

/**
 * What pasting `copy` onto the selection would do. A section pastes onto a section part by part (the same part IDs);
 * anything else pastes one set onto the selection's own (a section's own when the selection is a section).
 * With `every`, each copied property ends up exactly as the copy has it at every size: its values are written and
 * the destination's own values for that property at the other sizes are removed. With one size, only the values
 * the copy holds for that size are written. A property the copy doesn't set, and every one the destination doesn't
 * offer, is left as it is.
 */
export function planStylePaste(
  state: ProjectState,
  copy: StyleCopy,
  ref: ElementRef,
  scope: PasteScope,
  reach: ReachChoice = noChoice,
  leftOut?: ReadonlySet<string>,
): PastePlan {
  const destination = styleSelection(state, ref, reach);
  if (!destination) return { destination, rows: [], operations: [] };
  const now = effectiveTokens(state);
  const known: Known = {
    tokens: new Set(now.map((t) => t.id)),
    vars: new Set(now.map((t) => tokenVar(t.id))),
    copied: new Set(copy.vars),
  };
  // A size's paste takes its state rules too: they change how it looks there.
  const scopes = scope === "every" ? ALL_KEYS : keysAt(scope);
  const rows: PasteRow[] = [];
  const operations: EditOperation[] = [];
  for (const set of copy.sets) {
    let target: StyleTarget | undefined;
    let missing = "";
    if (destination.kind === "single") {
      target =
        copy.kind === "single" || set.part === "root"
          ? destination.targets[0]
          : undefined;
      missing = `Only the section’s own style can go onto ${destination.label}.`;
    } else {
      const part = copy.kind === "single" ? "root" : set.part;
      target = destination.targets.find((t) => t.part === part);
      missing = `${destination.label} has no ${set.label.toLowerCase()} part.`;
    }
    const properties = [
      ...new Set(ALL_KEYS.flatMap((sc) => Object.keys(set.styles[sc] ?? {}))),
    ];
    for (const property of properties) {
      const def = own(STYLE_PROP_MAP, property);
      const label = def?.label ?? property;
      const at = target?.label ?? set.label;
      const part = target ? target.part : set.part;
      const skip = (reason: string) =>
        rows.push({
          part,
          target: at,
          property,
          label,
          status: "skip",
          reason,
          changes: [],
        });
      if (!target) skip(missing);
      else if (!def)
        skip("This version of the builder doesn’t know this style.");
      else if (property === "customCss")
        skip(
          "Custom CSS can set several properties at once, so it isn’t pasted. Copy it by hand.",
        );
      // A placement takes spans whatever its design lists: they place it in the box around it. Whether that box is a
      // grid can change with this same paste, and outside one they do nothing. (An element's own set offers them.)
      else if (
        !target.offered.includes(property) &&
        !(target.partId && GRID_CHILD_PROPS.includes(property))
      )
        skip(
          `${destination.kind === "section" ? `${destination.label}’s ${target.label.toLowerCase()}` : destination.label} doesn’t offer ${label.toLowerCase()}.`,
        );
      else if (!scopes.some((sc) => set.styles[sc]?.[property] !== undefined))
        skip(
          `The copy sets it for ${andJoin(scopeList(set.styles, property))}, not ${SCOPE_LABELS[scope as ResponsiveScope]}.`,
        );
      else {
        // Every size the paste writes is checked first: a property with one value that can't be written changes nowhere.
        const wants = new Map<
          StyleScopeKey,
          { value: StyleValue; stored: StyleValue }
        >();
        let why = "";
        for (const sc of scopes) {
          const raw: unknown = set.styles[sc]?.[property];
          if (raw === undefined) continue;
          const ready = prepare(
            state,
            known,
            property,
            raw,
            parseStyleScopeKey(sc)?.state,
            isContainerScope(parseStyleScopeKey(sc)?.scope),
          );
          if ("error" in ready) {
            why = ready.error;
            break;
          }
          wants.set(sc, ready);
        }
        if (why) {
          skip(why);
          continue;
        }
        const changes: PasteChange[] = [];
        // The destination's values for this style now, and once the paste is done (every size the copy doesn't have
        // is cleared when the paste matches it at every size).
        const now = (k: StyleScopeKey) => target.styles?.[k]?.[property];
        const done = (k: StyleScopeKey) =>
          wants.has(k)
            ? wants.get(k)!.stored
            : scope === "every"
              ? undefined
              : now(k);
        for (const sc of scopes) {
          const want = wants.get(sc);
          // One size writes only what the copy holds there; every size also clears what it doesn't.
          if (want === undefined && scope !== "every") continue;
          const have = target.styles?.[sc]?.[property];
          const at = parseStyleScopeKey(sc)!;
          const where = {
            scope: at.scope,
            ...(at.state ? { state: at.state } : {}),
          };
          // One card: the shared value it shows now where it has none of its own, or once its own is cleared.
          const shown =
            want === undefined
              ? have !== undefined
                ? sharedShown(target, sc, property, done)
                : undefined
              : have === undefined
                ? sharedShown(target, sc, property, now)
                : undefined;
          if (
            want === undefined
              ? have !== undefined
              : !sameValue(want.stored, have)
          )
            changes.push({
              ...where,
              from: have,
              ...(want !== undefined ? { to: want.value } : {}),
              ...(shown !== undefined ? { shared: shown } : {}),
            });
        }
        // Onto the style every card shares: the cards whose own values for it beat the change.
        const kept = changes.length
          ? keptOver(target.ownItems ?? [], property, changes, now, done)
          : [];
        const left =
          !!changes.length && !!leftOut?.has(pasteRowKey({ part, property }));
        rows.push({
          part,
          target: at,
          property,
          label,
          status: changes.length ? "change" : "same",
          changes,
          ...(kept.length && !left ? { kept } : {}),
          ...(left ? { left } : {}),
        });
        if (!left)
          for (const c of changes)
            operations.push({
              type: "node.setStyle",
              owner: target.owner,
              nodeId: target.nodeId,
              ...(target.partId ? { partId: target.partId } : {}),
              ...(target.itemId ? { itemId: target.itemId } : {}),
              scope: c.scope,
              ...(c.state ? { state: c.state } : {}),
              property,
              value: c.to ?? null,
            });
      }
    }
  }
  return { destination, rows, operations };
}
