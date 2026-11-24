/**
 * Copy style and Paste style: the style changes a section, one of its parts or an element carries, taken as they
 * are when copied and pasted onto another selection as ordinary `node.setStyle` edits in one batch, so a single
 * Undo takes the whole paste back. Only style overrides move: content, links, images and design options stay.
 * Pure: it reads a project and says what a paste would change, for the editor to show and send.
 */
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, ElementRef, InstanceNode, OwnerRef, ProjectState, ResponsiveScope, ResponsiveStyles, StyleScopeKey, StyleState, StyleValue } from '@shared/types';
import { STYLE_STATES, parseStyleScopeKey, styleScopeKey } from '@shared/types';
import { STYLE_PROP_MAP, isStateStyleProp, offeredStyleProps, placementStyleControls, stateStyleError, styleSetFor, tokenVar, validateStyleValue } from '@shared/styles';
import { codeTakesOverrides, enclosingRepeatProp } from '@engine/tree';
import { effectiveTokens } from '@generator/index';
import { resolveFontStack } from '@catalogue/fonts';
import { boundaryOf, ownerLabel, pagesUsingShell, refLabel, treeFor } from './model';

export const STYLE_SCOPES: ResponsiveScope[] = ['base', 'phone', 'tablet', 'desktop'];
export const SCOPE_LABELS: Record<ResponsiveScope, string> = { base: 'All sizes', phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop' };
export const STATE_LABELS: Record<StyleState, string> = { hover: 'hover', focus: 'focus', active: 'pressed' };
/** A size's resting rule and then its state rules: every rule a paste for that size writes. */
const keysAt = (scope: ResponsiveScope): StyleScopeKey[] => [scope, ...STYLE_STATES.map((st) => styleScopeKey(scope, st))];
/** Every rule a set of styles can hold, in the order a paste lists them. */
const ALL_KEYS: StyleScopeKey[] = STYLE_SCOPES.flatMap(keysAt);
/** Where a change applies, in words: "Phone", or "All sizes, hover". */
export const changeLabel = (c: { scope: ResponsiveScope; state?: StyleState }) => (c.state ? `${SCOPE_LABELS[c.scope]}, ${STATE_LABELS[c.state]}` : SCOPE_LABELS[c.scope]);

/** Which sizes a paste writes: every size the copy holds a change for, or only the changes made for one. */
export type PasteScope = 'every' | ResponsiveScope;

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
}

export interface StyleSelection {
  kind: 'section' | 'single';
  label: string;
  /** Where it is: "on the Home page", or the shared header and the pages that show it. */
  where: string;
  targets: StyleTarget[];
}

/** What Copy style took: each set's rules, detached from the project, so later edits to the original don't change it. */
export interface StyleCopy {
  kind: 'section' | 'single';
  label: string;
  sets: Array<{ part: string | null; label: string; styles: ResponsiveStyles }>;
  /** The site styles there were when it was copied, as CSS text names them, to tell one removed since. */
  vars: string[];
}

/** One override a paste writes (`to`) over what the destination has now (`from`). No `to` removes the override. */
export interface PasteChange {
  scope: ResponsiveScope;
  /** The interactive state the value is for; none for the resting style. */
  state?: StyleState;
  from?: StyleValue;
  to?: StyleValue;
}

export interface PasteRow {
  /** The part it lands on (or, with nowhere to go, the copied part it came from); null for a single part or element. */
  part: string | null;
  /** Where it lands: the destination part or element, or the copied part that has nowhere to go. */
  target: string;
  property: string;
  label: string;
  /** change: the paste writes it; same: the destination already matches; skip: it can't be pasted here (`reason`). */
  status: 'change' | 'same' | 'skip';
  reason?: string;
  changes: PasteChange[];
}

export interface PastePlan {
  /** Null when the selection takes no style changes. */
  destination: StyleSelection | null;
  rows: PasteRow[];
  operations: EditOperation[];
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);
const TEXT_TOKEN_RE = /^text\.[a-z0-9-]+$/;
const FONT_KEYWORD_RE = /^(inherit|initial|unset|revert|revert-layer|var\(.*)$/i;

function whereOf(state: ProjectState, owner: OwnerRef): string {
  if (owner.kind === 'shell') {
    const n = pagesUsingShell(state, owner.id);
    return `in the shared ${owner.id}, shown on ${n === 1 ? '1 page' : `${n} pages`}`;
  }
  return `on the ${ownerLabel(state, owner)} page`;
}

/** The list a part repeats over, as "every card", when it sits inside a repeat. */
function reachOf(def: ComponentDefinition, nodeId: string | undefined): string | undefined {
  const prop = nodeId ? enclosingRepeatProp(def, nodeId) : undefined;
  const schema = prop ? own(def.properties, prop) : undefined;
  return schema?.type === 'list' ? `every ${schema.itemLabel.toLowerCase()}` : undefined;
}

function partTarget(def: ComponentDefinition, inst: InstanceNode, owner: OwnerRef, partId: string, list: string[] | undefined): StyleTarget {
  const part = own(def.parts, partId);
  return {
    part: partId,
    label: part?.label ?? 'Section',
    offered: offeredStyleProps(list),
    styles: inst.overrides?.[partId],
    owner,
    nodeId: inst.id,
    partId,
    reach: def.kind === 'managed' ? reachOf(def, part?.nodeId) : undefined
  };
}

/**
 * The style sets a selection carries, as the inspector edits them: a section's own and each of its parts', or the
 * one set of a selected part or element. Null for what takes no style changes of its own here: a component's
 * design (Edit everywhere styles every placement), a part of a component nested inside a section, a repeat or slot.
 */
export function styleSelection(state: ProjectState, ref: ElementRef): StyleSelection | null {
  if (ref.owner.kind === 'component') return null;
  // A part picked by name stays that part, as in the inspector, even on its component's root element: a component
  // made from one heading names both.
  const named = ref.instancePath.length > 0 && !!ref.partId && ref.partId !== 'root';
  const b = named ? ref : boundaryOf(state, ref);
  const tree = treeFor(state, b.owner);
  if (!tree) return null;
  const where = whereOf(state, b.owner);
  if (!b.instancePath.length) {
    const node = own(tree.nodes, b.nodeId);
    if (!node || node.kind === 'repeat' || node.kind === 'slot') return null;
    if (node.kind !== 'instance') {
      const label = refLabel(state, b);
      return { kind: 'single', label, where, targets: [{ part: null, label, offered: offeredStyleProps(styleSetFor(node)), styles: node.styles, owner: b.owner, nodeId: node.id }] };
    }
    const def = own(state.components, node.definitionId);
    if (!def) return null;
    const codeStyled = def.kind === 'code' && codeTakesOverrides(def);
    const targets = ['root', ...Object.keys(def.parts).filter((p) => p !== 'root')].flatMap((p) => {
      const list = placementStyleControls(def, p, codeStyled);
      return list === null ? [] : [partTarget(def, node, b.owner, p, list)];
    });
    return targets.length ? { kind: 'section', label: node.name ?? def.name, where, targets } : null;
  }
  if (b.instancePath.length !== 1 || !b.partId || b.partId === 'root') return null;
  const inst = own(tree.nodes, b.instancePath[0]);
  const def = inst?.kind === 'instance' ? own(state.components, inst.definitionId) : undefined;
  // The part must still be the element that was picked: a change to the design can give its name to another.
  if (inst?.kind !== 'instance' || !def || own(def.parts, b.partId)?.nodeId !== b.nodeId) return null;
  const list = placementStyleControls(def, b.partId, def.kind === 'code' && codeTakesOverrides(def));
  if (list === null) return null;
  const t = partTarget(def, inst, b.owner, b.partId, list);
  return { kind: 'single', label: `${t.label} in ${inst.name ?? def.name}`, where, targets: [{ ...t, part: null }] };
}

const hasRules = (s: ResponsiveStyles | undefined) => ALL_KEYS.some((sc) => Object.keys(s?.[sc] ?? {}).length > 0);

/** Take the style a selection carries now. Null when it takes none; a copy with no sets has nothing to paste. */
export function captureStyle(state: ProjectState, ref: ElementRef): StyleCopy | null {
  const sel = styleSelection(state, ref);
  if (!sel) return null;
  const sets = sel.targets.filter((t) => hasRules(t.styles)).map((t) => ({ part: t.part, label: t.label, styles: JSON.parse(JSON.stringify(t.styles)) as ResponsiveStyles }));
  return { kind: sel.kind, label: sel.label, sets, vars: effectiveTokens(state).map((t) => tokenVar(t.id)) };
}

const sameValue = (a: StyleValue | undefined, b: StyleValue | undefined) => (a && typeof a === 'object') || (b && typeof b === 'object') ? JSON.stringify(a) === JSON.stringify(b) : a === b;

/** The site style a value links to, also in the older bare "text.h2" spelling of a text style. */
function tokenRef(property: string, v: StyleValue): string | null {
  if (v && typeof v === 'object') return typeof v.token === 'string' ? v.token : null;
  return property === 'textStyle' && typeof v === 'string' && TEXT_TOKEN_RE.test(v.trim()) ? v.trim() : null;
}

/** A value an edit can carry: a literal, or exactly `{ token }`. Anything else came from a hand-edited document. */
function isStyleValue(v: unknown): v is StyleValue {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { token?: unknown }).token === 'string';
}

/** CSS variables named in CSS text, such as a gradient's `var(--so-color-brand)` (`var` in any case, as CSS reads it). */
const CSS_VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)/gi;
/** The variables a text style is read through, one per metric, after its own name. */
const TEXT_METRICS = ['family', 'size', 'line-height', 'weight', 'tracking', 'transform'];
const removed = (token: string) => `It uses the site style “${token}”, which has been removed since it was copied.`;

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
function prepare(state: ProjectState, known: Known, property: string, v: unknown, inState: boolean): { value: StyleValue; stored: StyleValue } | { error: string } {
  if (!isStyleValue(v)) return { error: 'The copied value isn’t one the builder can paste.' };
  // A hand-edited document can hold a state value the builder never writes.
  if (inState && !isStateStyleProp(property)) return { error: stateStyleError(property)! };
  const err = validateStyleValue(property, v);
  if (err) return { error: err };
  const token = tokenRef(property, v);
  if (token && !known.tokens.has(token)) return { error: removed(token) };
  // CSS text naming a site style's variable (or one of a text style's metrics): only a style there was when copied,
  // and is no longer, is missing.
  if (typeof v === 'string')
    for (const [, name] of v.matchAll(CSS_VAR_RE)) {
      const metric = known.copied.has(name) || !name.startsWith('--so-text-') ? undefined : TEXT_METRICS.find((m) => name.endsWith(`-${m}`) && known.copied.has(name.slice(0, -m.length - 1)));
      const style = metric ? name.slice(0, -metric.length - 1) : name;
      if (known.copied.has(style) && !known.vars.has(style)) return { error: removed(style.slice(5)) };
    }
  if (property === 'fontFamily' && typeof v === 'string' && !FONT_KEYWORD_RE.test(v.trim())) {
    // The edit checks the value as written, then stores the stack, which may be longer than a value may be written.
    const font = resolveFontStack(state, v);
    return 'error' in font ? { error: font.error } : { value: v, stored: font.stack };
  }
  return { value: v, stored: v };
}

const scopeList = (s: ResponsiveStyles, property: string) => ALL_KEYS.filter((k) => s[k]?.[property] !== undefined).map((k) => changeLabel(parseStyleScopeKey(k)!));

/**
 * What pasting `copy` onto the selection would do. A section pastes onto a section part by part (the same part IDs);
 * anything else pastes one set onto the selection's own (a section's own when the selection is a section).
 * With `every`, each copied property ends up exactly as the copy has it at every size: its values are written and
 * the destination's own values for that property at the other sizes are removed. With one size, only the values
 * the copy holds for that size are written. A property the copy doesn't set, and every one the destination doesn't
 * offer, is left as it is.
 */
export function planStylePaste(state: ProjectState, copy: StyleCopy, ref: ElementRef, scope: PasteScope): PastePlan {
  const destination = styleSelection(state, ref);
  if (!destination) return { destination, rows: [], operations: [] };
  const now = effectiveTokens(state);
  const known: Known = { tokens: new Set(now.map((t) => t.id)), vars: new Set(now.map((t) => tokenVar(t.id))), copied: new Set(copy.vars) };
  // A size's paste takes its state rules too: they change how it looks there.
  const scopes = scope === 'every' ? ALL_KEYS : keysAt(scope);
  const rows: PasteRow[] = [];
  const operations: EditOperation[] = [];
  for (const set of copy.sets) {
    let target: StyleTarget | undefined;
    let missing = '';
    if (destination.kind === 'single') {
      target = copy.kind === 'single' || set.part === 'root' ? destination.targets[0] : undefined;
      missing = `Only the section’s own style can go onto ${destination.label}.`;
    } else {
      const part = copy.kind === 'single' ? 'root' : set.part;
      target = destination.targets.find((t) => t.part === part);
      missing = `${destination.label} has no ${set.label.toLowerCase()} part to take it.`;
    }
    const properties = [...new Set(ALL_KEYS.flatMap((sc) => Object.keys(set.styles[sc] ?? {})))];
    for (const property of properties) {
      const def = own(STYLE_PROP_MAP, property);
      const label = def?.label ?? property;
      const at = target?.label ?? set.label;
      const part = target ? target.part : set.part;
      const skip = (reason: string) => rows.push({ part, target: at, property, label, status: 'skip', reason, changes: [] });
      if (!target) skip(missing);
      else if (!def) skip('This version of the builder doesn’t know this style.');
      else if (property === 'customCss') skip('Custom CSS can set several properties at once, so it isn’t pasted. Copy it by hand.');
      else if (!target.offered.includes(property)) skip(`${destination.kind === 'section' ? `${destination.label}’s ${target.label.toLowerCase()}` : destination.label} doesn’t offer ${label.toLowerCase()}.`);
      else if (!scopes.some((sc) => set.styles[sc]?.[property] !== undefined)) skip(`The copy sets it for ${scopeList(set.styles, property).join(', ')}, not ${SCOPE_LABELS[scope as ResponsiveScope]}.`);
      else {
        // Every size the paste writes is checked first: a property with one value that can't be written changes nowhere.
        const wants = new Map<StyleScopeKey, { value: StyleValue; stored: StyleValue }>();
        let why = '';
        for (const sc of scopes) {
          const raw: unknown = set.styles[sc]?.[property];
          if (raw === undefined) continue;
          const ready = prepare(state, known, property, raw, sc.includes(':'));
          if ('error' in ready) {
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
        for (const sc of scopes) {
          const want = wants.get(sc);
          // One size writes only what the copy holds there; every size also clears what it doesn't.
          if (want === undefined && scope !== 'every') continue;
          const have = target.styles?.[sc]?.[property];
          const at = parseStyleScopeKey(sc)!;
          const where = { scope: at.scope, ...(at.state ? { state: at.state } : {}) };
          if (want === undefined ? have !== undefined : !sameValue(want.stored, have)) changes.push(want === undefined ? { ...where, from: have } : { ...where, from: have, to: want.value });
        }
        rows.push({ part, target: at, property, label, status: changes.length ? 'change' : 'same', changes });
        for (const c of changes)
          operations.push({ type: 'node.setStyle', owner: target.owner, nodeId: target.nodeId, ...(target.partId ? { partId: target.partId } : {}), scope: c.scope, ...(c.state ? { state: c.state } : {}), property, value: c.to ?? null });
      }
    }
  }
  return { destination, rows, operations };
}
