/**
 * Detaching a placement: one managed component instance on a page replaced by the ordinary page elements it renders,
 * as it renders them now. Properties become the values they show, each list item its own copy, conditions the
 * branches they pick, and the design's styles, the chosen variant options and the placement's own style changes one
 * set of styles per element that cascades the same. Slot content moves into place. Components placed inside the
 * design stay placements, given the values and styles they were shown with.
 */
import type { ComponentDefinition, DetachedFrom, GraphNode, InstanceNode, NodeTree, ProjectState, PropSchema, ResponsiveStyles } from '@shared/types';
import { ELEMENT_ACTIONS, ELEMENT_TAGS, ICON_POSITIONS, TEXT_TAGS, isAppearPreset, isBinding, isBindingRef, slotChildren, stateInitial } from '@shared/types';
import { propBindingSchema } from '@shared/bindings';
import type { Op } from '@shared/ops';
import { newId } from '@shared/ids';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { isArticleDate } from '@shared/articles';
import { flattenStates, flattenStyles, type StyleLayer } from '@shared/styles';
import { designLayers, selectedVariants } from '@shared/variants';
import { liveItemStyles } from '@shared/item-styles';
import { defKey, keepWeakerHides, naturalDisplay, nodeAxes } from '@generator/index';
import { effectiveProps, evaluate, rendersIn, type Scope } from '@generator/checks';
import { anchorCapable, anchorsInUse, fail, findParent, getNode, getTree, settledRoot } from './tree';
import { slotLandingProblem } from './slots';
import { clone } from './install';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);
const TEXT_TAG_SET = new Set<string>(TEXT_TAGS);
const ELEMENT_TAG_SET = new Set<string>(ELEMENT_TAGS);

/**
 * A design's property values with each object's fields filled as the generator fills them: the stored field, else
 * the object's default for it, else the field's own default.
 */
function withObjectFields(def: ComponentDefinition, props: Record<string, unknown>): Record<string, unknown> {
  const out = { ...props };
  for (const [name, schema] of Object.entries(def.properties)) {
    const v = out[name];
    if (schema.type !== 'object') continue;
    // A value that is not an object (none stored, or a hand edit) shows the object's defaults.
    const stored = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const fallback = schema.default && typeof schema.default === 'object' ? schema.default : {};
    out[name] = { ...stored, ...Object.fromEntries(Object.entries(schema.fields).map(([k, f]) => [k, Object.hasOwn(stored, k) ? stored[k] : Object.hasOwn(fallback, k) ? fallback[k] : f.default])) };
  }
  return out;
}

/** Where the walk is inside the design: the values in scope, the item of each list it is inside, and those lists. */
interface At {
  scope: Scope;
  items: Record<string, string>;
  repeats: Array<{ id: string; item: string }>;
}

/**
 * Replace a page's placement of a managed component with the elements it renders. `copy` copies a subtree of the page
 * under fresh IDs (for slot content the design shows more than once).
 */
export function detachInstance(state: ProjectState, op: Op<'component.detachInstance'>, copy: (tree: NodeTree, nodeId: string) => string): { nodeId: string; label: string } {
  if (op.owner.kind === 'shell') fail('The header and footer are shared by every page, so their components cannot be detached. Use Make unique to change one on its own.');
  if (op.owner.kind !== 'page') fail('A component inside another component’s design cannot be detached. Detach the component that contains it where it is placed on a page.');
  const tree = getTree(state, op.owner);
  const inst = getNode(tree, op.nodeId);
  if (inst.kind !== 'instance') fail(`Node "${op.nodeId}" is not a component placement.`);
  const def = own(state.components, inst.definitionId) ?? fail(`Missing definition "${inst.definitionId}".`);
  const label = inst.name ?? def.name;
  if (def.kind !== 'managed' || !def.tree) fail(`“${label}” is a code component: its markup is in its source, so it cannot be detached into elements.`);
  // Elements on a page have no UI state: they would only ever show where it starts, and its buttons would change nothing.
  if (Object.keys(def.state ?? {}).length) fail(`“${label}” has UI state its buttons change, which elements on a page would not keep. Remove its UI state first.`);
  const design = def.tree;
  if (!settledRoot(design)) fail(`“${label}” has no single element at the top of its design, so it cannot be detached. Fix its design first.`);
  const parent = findParent(tree, op.nodeId) ?? fail('This placement is not on the page.');
  const rootId = design.rootIds[0];
  const key = defKey(def.id);
  const chosen = selectedVariants(def, inst.variants);
  const option = (axis: string) => {
    const v = chosen[axis];
    return typeof v === 'string' ? v : def.variantAxes![axis].default;
  };
  const partNode = (pid: string) => own(def.parts, pid)?.nodeId ?? (pid === 'root' ? rootId : undefined);
  const overrideParts = Object.keys(inst.overrides ?? {}).sort();
  const itemParts = Object.keys(inst.itemOverrides ?? {}).sort();
  const anchors = anchorsInUse(state, op.owner, op.nodeId);
  // The placement's anchor goes to what replaces it, as the design's root anchor did where it had none.
  const designAnchor = design.nodes[rootId].anchor;
  const rootAnchor = inst.anchor ?? (designAnchor && !anchors.has(designAnchor) ? designAnchor : undefined);
  if (rootAnchor) anchors.add(rootAnchor);
  const slotUses = new Map<string, number>();
  const tooMuch = (): never => fail(`“${label}” has more custom CSS on one element, across its design, options and placement, than one element can hold. Shorten some of it first.`);
  // State rules one element's own cannot reproduce: refused rather than detached into something that looks different.
  const states = (layers: StyleLayer[], link: boolean, beneath = 0): ResponsiveStyles =>
    flattenStates(layers, { beneath, link }) ??
    fail(`“${label}” has hover, focus or pressed styles that its design, options and placement combine in a way one element’s styles cannot show exactly. Set each in one place (its design or this placement), as a whole property, first.`);
  const added: GraphNode[] = [];
  // Names the galleries this detach makes, so each stays its own viewer group, apart from any other on the page.
  const groups = newId('g');
  // Rules of one class count from different components' designs: the one whose block comes later in the stylesheet
  // wins at every size (the generator writes each design's rules, media blocks included, in turn, in ID order).
  const defOrder = new Map(Object.values(state.components).sort((a, b) => a.id.localeCompare(b.id)).map((d, i) => [d.id, i]));
  const tie = (defId: string) => (defOrder.get(defId) ?? 0) / (defOrder.size + 1) / 10;

  /** The layers of rules on one of the design's nodes for this placement, weakest first, as the stylesheets cascade them. */
  const layersFor = (nodeId: string, at: At, boost: number): StyleLayer[] => {
    const design = designLayers(def, nodeId, inst.variants);
    const designed = design.map((l) => l.styles);
    const layers: StyleLayer[] = design.map((l) => ({ ...l, strength: l.strength + (boost ? tie(def.id) : 0) }));
    // Each shared change is two override classes, in the site stylesheet after every component's: it beats any
    // option's rule at every size. One item's own styles carry one class more. A part that is a placed component
    // takes two classes more than either.
    for (const pid of overrideParts) if (partNode(pid) === nodeId) layers.push({ styles: inst.overrides![pid], strength: 3 + boost, wideColumns: true, unhides: designed });
    for (const pid of itemParts) {
      if (partNode(pid) !== nodeId) continue;
      const entry = liveItemStyles(def, inst, pid);
      const item = entry ? at.items[entry.list] : undefined;
      const mine = entry && item !== undefined ? own(entry.items, item) : undefined;
      if (!mine || typeof mine !== 'object') continue;
      layers.push({ styles: keepWeakerHides(def, inst, pid, mine), strength: 4 + boost, wideColumns: true, unhides: [...designed, own(inst.overrides, pid)] });
    }
    return layers;
  };

  /**
   * A bound value as it renders here; literals stay as they are. A field of an object property the placement stores
   * without that field shows the object's default for it.
   */
  const value = (v: unknown, at: At) => {
    const got = evaluate(v, at.scope);
    if (got === undefined && isBinding(v) && '$prop' in v && v.field !== undefined) return clone(propBindingSchema(def.properties, v)?.default);
    return clone(got);
  };

  /** The tags a node can render (as the generator's `tagChoices`), and the one it renders here. */
  const tagsOf = (n: GraphNode & { kind: 'text' | 'element' }, at: At): { tags: string[]; tag: string } => {
    const allowed = n.kind === 'text' ? TEXT_TAG_SET : ELEMENT_TAG_SET;
    const plain = n.kind === 'text' ? 'p' : 'div';
    if (!isBinding(n.tag)) {
      const tag = allowed.has(n.tag) ? n.tag : plain;
      return { tags: [tag], tag };
    }
    const schema: PropSchema | undefined = '$prop' in n.tag ? propBindingSchema(def.properties, n.tag) : (own(at.scope.fields, n.tag.$item) as PropSchema | undefined);
    const options = schema?.type === 'enum' ? schema.options.map((o) => o.value).filter((o) => allowed.has(o)) : [];
    const fallback = schema?.type === 'enum' && options.includes(schema.default) ? schema.default : (options[0] ?? plain);
    const v = value(n.tag, at);
    return { tags: [...options.filter((o) => o !== fallback), fallback], tag: typeof v === 'string' && options.includes(v) ? v : fallback };
  };
  const tagOf = (n: GraphNode & { kind: 'text' | 'element' }, at: At): string => tagsOf(n, at).tag;

  /** Words as a plain text node shows them: stored blocks as their plain text. */
  const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? richTextToPlain(toRichText(v)) : '');

  /**
   * The name a design's navigation landmark takes from its first child, a heading (the generator's
   * `labellingHeading`): the heading's words, or while a heading shown only with its own text is hidden, that
   * property's default. A page element has no such link, so it keeps the name as its own.
   */
  const landmarkName = (src: GraphNode & { kind: 'element' }, at: At): string => {
    const first = own(design.nodes, src.children[0]);
    if (at.repeats.length || first?.kind !== 'text' || first.rich || first.unless) return '';
    if (!tagsOf(first, at).tags.every((t) => /^h[2-6]$/.test(t))) return '';
    const guarded = !!first.when && isBinding(first.text) && JSON.stringify(first.when) === JSON.stringify(first.text);
    if (first.when && !guarded) return '';
    if (rendersIn(state, design, at.scope, first)) return text(value(first.text, at)).trim();
    const fallback = isBinding(first.text) && '$prop' in first.text ? propBindingSchema(def.properties, first.text)?.default : undefined;
    return typeof fallback === 'string' ? fallback.trim() : '';
  };
  const setOptional = (n: Record<string, unknown>, k: string, v: string) => {
    if (v) n[k] = v;
    else delete n[k];
  };

  /** One of the design's elements as a page element for this rendering, with its descendants. */
  const element = (src: Exclude<GraphNode, { kind: 'repeat' | 'slot' | 'instance' }>, at: At): string => {
    const n = clone(src) as GraphNode & Record<string, unknown>;
    n.id = newId('n');
    delete n.when;
    delete n.unless;
    delete n.styles;
    delete n.anchor;
    switch (n.kind) {
      case 'element': {
        const tagBound = isBinding(n.tag);
        n.tag = tagOf(n, at) as typeof n.tag;
        delete n.collapseEmpty;
        // An action on a bound tag never made the element a link: it stays a plain container.
        if (tagBound && n.action !== undefined) {
          delete n.action;
          delete n.link;
        } else {
          if (n.link !== undefined) {
            const link = value(n.link, at);
            if (link && typeof link === 'object') n.link = link as typeof n.link;
            else delete n.link;
          }
          if (n.action !== undefined) {
            const action = value(n.action, at);
            if (ELEMENT_ACTIONS.includes(action as never)) n.action = action as typeof n.action;
            else delete n.action;
          }
        }
        if (n.ariaLabel !== undefined) setOptional(n, 'ariaLabel', text(value(n.ariaLabel, at)).trim());
        if (n.tag === 'nav' && !n.ariaLabel && src.kind === 'element') setOptional(n, 'ariaLabel', landmarkName(src, at));
        n.children = [];
        break;
      }
      case 'text': {
        n.tag = tagOf(n, at) as typeof n.tag;
        const v = value(n.text, at);
        n.text = n.rich ? toRichText(v) : text(v);
        if (n.datetime !== undefined) {
          const date = text(value(n.datetime, at)).trim();
          // A value that is not a date renders as ordinary text.
          if (date && isArticleDate(date)) n.datetime = date;
          else delete n.datetime;
        }
        break;
      }
      case 'image': {
        const img = value(n.image, at);
        n.image = img && typeof img === 'object' ? (img as typeof n.image) : { assetId: null, alt: '' };
        if (n.fallbackAlt !== undefined) setOptional(n, 'fallbackAlt', text(value(n.fallbackAlt, at)));
        break;
      }
      case 'link': {
        const link = value(n.link, at);
        n.link = link && typeof link === 'object' ? (link as typeof n.link) : { type: 'none', target: '' };
        n.label = text(value(n.label, at));
        // An empty look shows the label as plain words, as it did.
        n.appearance = text(value(n.appearance, at));
        if (n.icon !== undefined) setOptional(n, 'icon', text(value(n.icon, at)));
        if (n.iconPosition !== undefined) {
          const pos = value(n.iconPosition, at);
          if (ICON_POSITIONS.includes(pos as never)) n.iconPosition = pos as typeof n.iconPosition;
          else delete n.iconPosition;
        }
        if (n.ariaLabel !== undefined) setOptional(n, 'ariaLabel', text(value(n.ariaLabel, at)));
        // Only a design's buttons change UI state; on a page there is none to change.
        delete n.stateAction;
        break;
      }
      case 'icon':
        n.icon = text(value(n.icon, at));
        if (n.ariaLabel !== undefined) setOptional(n, 'ariaLabel', text(value(n.ariaLabel, at)));
        break;
    }
    const layers = layersFor(src.id, at, 0);
    const styles = { ...flattenStyles(layers, { link: src.kind === 'link', shownDisplay: () => naturalDisplay(src), tooMuch }), ...states(layers, src.kind === 'link') };
    if (Object.keys(styles).length) n.styles = styles;
    const from = provenance(src);
    // An action repeated in a list moved through the viewer with the list's other items (in each outer item apart).
    const list = at.repeats.at(-1);
    if (n.kind === 'element' && n.action !== undefined && list) from.group = [groups, list.id, ...at.repeats.slice(0, -1).map((r) => r.item)].join('|');
    else delete from.group;
    n.detachedFrom = from;
    keepAnchor(n, src);
    added.push(n);
    if (n.kind === 'element' && src.kind === 'element') n.children = src.children.flatMap((c) => emit(c, at));
    return n.id;
  };

  /**
   * The classes a node had in the design, inert, for the theme's hooks: its node and each axis whose option class it
   * carried. A node detached before (and made into this component since) keeps the hooks it already had.
   */
  const provenance = (src: GraphNode): DetachedFrom => {
    if (src.detachedFrom && typeof src.detachedFrom === 'object') return clone(src.detachedFrom);
    const axes = src.id === rootId ? Object.keys(def.variantAxes ?? {}) : nodeAxes(def, src.id);
    const from: DetachedFrom = { component: key, node: src.id };
    if (axes.length) from.options = Object.fromEntries(axes.map((a) => [a, option(a)]));
    return from;
  };

  /**
   * What styles the element a component placed in the design renders as its root, beneath what this design gives it:
   * that component's own design, and through a root that is itself a placed component, the next design down, with
   * the change each design makes to the component at its root (three classes). Ties between designs go by their order
   * in the stylesheet. Undefined when a code component renders it: its own styles are not known here.
   */
  const rootChain = (first: InstanceNode): { layers: StyleLayer[]; code: boolean } => {
    const levels: StyleLayer[][] = [];
    let node: GraphNode | undefined = first;
    // The values in scope where each component is placed: options bound to them are chosen by them.
    let scope: Scope = { props: {} };
    let code = false;
    const seen = new Set<string>();
    while (node?.kind === 'instance') {
      const placed: InstanceNode = node;
      const d: ComponentDefinition | undefined = own(state.components, placed.definitionId);
      if (!d || seen.has(d.id)) break;
      seen.add(d.id);
      if (d.kind !== 'managed' || !d.tree) {
        code = true;
        break;
      }
      const chosen = Object.fromEntries(Object.entries(placed.variants ?? {}).map(([axis, v]) => [axis, isBindingRef(v) ? String(evaluate(v, scope) ?? '') : v]));
      const r: string = d.tree.rootIds[0];
      const next: GraphNode | undefined = own(d.tree.nodes, r);
      const level: StyleLayer[] = designLayers(d, r, chosen).map((l) => ({ ...l, strength: l.strength + tie(d.id) }));
      levels.push(level);
      if (next?.kind === 'instance' && next.overrides?.root) level.push({ styles: next.overrides.root, strength: 3 + tie(d.id), wideColumns: true, unhides: [] });
      // An option bound to the design's UI state shows the one it starts at, as the generated site does.
      scope = { props: withObjectFields(d, effectiveProps(state, d, placed, scope, op.owner.id)), ...(d.state ? { ui: Object.fromEntries(Object.keys(d.state).map((k) => [k, stateInitial(d, k)])) } : {}) };
      node = next;
    }
    // The deepest design first: its layers are what each design above it shows again.
    const layers = levels.reverse().flat();
    for (const l of layers) if (l.strength >= 3) l.unhides = layers.filter((x) => x.strength < 3).map((x) => x.styles);
    return { layers, code };
  };

  /** A component placed in the design: still a placement, given the values, options and styles it renders with. */
  const placement = (src: InstanceNode, at: At): string => {
    const n = clone(src) as InstanceNode;
    n.id = newId('n');
    delete n.when;
    delete n.unless;
    delete n.styles;
    delete n.anchor;
    const inner = own(state.components, src.definitionId);
    n.props = {};
    for (const [k, v] of Object.entries(src.props)) {
      const resolved = isBinding(v) ? value(v, at) : clone(v);
      if (resolved !== undefined) n.props[k] = resolved;
    }
    if (src.variants) {
      const variants: Record<string, string> = {};
      for (const [axis, v] of Object.entries(src.variants)) {
        const picked = isBinding(v) ? evaluate(v, at.scope) : v;
        if (typeof picked === 'string' && inner?.variantAxes?.[axis] && Object.hasOwn(inner.variantAxes[axis].options, picked)) variants[axis] = picked;
      }
      if (Object.keys(variants).length) n.variants = variants;
      else delete n.variants;
    }
    if (src.slots) n.slots = Object.fromEntries(Object.keys(src.slots).map((slot) => [slot, slotChildren(src, slot).flatMap((c) => emit(c, at))]));
    // What the design and the placement give its root lands on its own placement now, where it beats its design: only
    // what beat that design before goes there, so an option of its own that won still wins.
    const chain = rootChain(n);
    const beneath = chain.layers;
    // The design's own change to it is three classes: it beats every option, loses to the placement's four, and shows
    // again what the placed component's design hides.
    const nested: StyleLayer[] = src.overrides?.root ? [{ styles: src.overrides.root, strength: 3 + tie(def.id), wideColumns: true, unhides: beneath.map((l) => l.styles), marks: chain.code }] : [];
    const layers = [...beneath, ...layersFor(src.id, at, 1), ...nested];
    const innerRoot = inner?.kind === 'managed' ? inner.tree?.rootIds[0] : undefined;
    const root = flattenStyles(layers, {
      beneath: beneath.length,
      wideColumns: true,
      link: !!innerRoot && inner?.tree?.nodes[innerRoot]?.kind === 'link',
      tooMuch,
      // What the stylesheet shows a placed component's root with: its own kind in this design (an instance: the browser's).
      shownDisplay: () => naturalDisplay(src)
    });
    Object.assign(root, states(layers, !!innerRoot && inner?.tree?.nodes[innerRoot]?.kind === 'link', beneath.length));
    const overrides = { ...(src.overrides ?? {}) };
    delete overrides.root;
    if (Object.keys(root).length) overrides.root = root;
    if (Object.keys(overrides).length) n.overrides = clone(overrides);
    else delete n.overrides;
    // The design's classes it carried (forwarded to its root), for the theme's hooks there.
    n.detachedFrom = provenance(src);
    delete n.detachedFrom.group;
    keepAnchor(n, src);
    added.push(n);
    return n.id;
  };

  /** A design node's anchor, while the page has no other element with it. */
  const keepAnchor = (n: GraphNode, src: GraphNode) => {
    if (src.id === rootId || !src.anchor || anchors.has(src.anchor)) return;
    n.anchor = src.anchor;
    anchors.add(src.anchor);
  };

  /** The page nodes one of the design's nodes renders as here: none, one, or one per list item. */
  const emit = (id: string, at: At): string[] => {
    const src = own(design.nodes, id);
    if (!src || !rendersIn(state, design, at.scope, src)) return [];
    switch (src.kind) {
      case 'repeat': {
        const list = src.list.$prop;
        const schema = own(def.properties, list);
        const rows = evaluate(src.list, at.scope);
        const fields = schema?.type === 'list' ? schema.fields : undefined;
        return (Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []).flatMap((item) => {
          const id = String(item?.id ?? '');
          const inner: At = { scope: { ...at.scope, item, fields }, items: { ...at.items, [list]: id }, repeats: [...at.repeats, { id: src.id, item: id }] };
          return src.children.flatMap((c) => emit(c, inner));
        });
      }
      case 'slot': {
        const content = slotChildren(inst, src.slot);
        const uses = slotUses.get(src.slot) ?? 0;
        slotUses.set(src.slot, uses + 1);
        // The content moves here; a slot the design shows again (once per list item) gets its own copies.
        return uses === 0 ? [...content] : content.map((c) => copy(tree, c));
      }
      case 'instance':
        return [placement(src, at)];
      default:
        return [element(src, at)];
    }
  };

  // An object shows its defaults for fields the placement stores none for, in what it renders and what it decides.
  const props = withObjectFields(def, effectiveProps(state, def, inst, { props: {} }, op.owner.id));
  const roots = emit(rootId, { scope: { props }, items: {}, repeats: [] });
  if (!roots.length) fail(`“${label}” shows nothing with its current settings, so there is nothing to detach. Delete it instead, or change its settings first.`);
  for (const slot of Object.keys(inst.slots ?? {})) {
    if (slotChildren(inst, slot).length && !slotUses.has(slot))
      fail(`“${label}” has content in its ${def.slots?.[slot]?.label ?? slot} that its current settings do not show. Move or remove that content first, so detaching keeps everything on the page.`);
  }
  const top = added.find((n) => n.id === roots[0])!;
  if (rootAnchor) top.anchor = rootAnchor;
  // The placement's entrance lands on what replaces it, as it did on the design's root: `none` turned the root's own off.
  const appear = inst.appear === 'none' || isAppearPreset(inst.appear) ? inst.appear : undefined;
  if (appear && top.kind === 'element') {
    if (appear === 'none') delete top.appear;
    else top.appear = appear;
  } else if (appear && top.kind === 'instance' && anchorCapable(state, own(state.components, top.definitionId))) top.appear = appear;
  // Named as the placement was in Layers: its own name, or the component's.
  top.name = inst.name ?? def.name;
  for (const n of added) tree.nodes[n.id] = n;
  delete tree.nodes[op.nodeId];
  parent.list.splice(parent.index, 1, ...roots);
  // In another placement's slot, the elements must be what that slot takes.
  const holder = parent.slot !== undefined && parent.parentId ? tree.nodes[parent.parentId] : undefined;
  if (holder?.kind === 'instance') {
    const problem = slotLandingProblem(state, tree, holder, parent.slot!, roots, slotChildren(holder, parent.slot!).length - roots.length + 1);
    if (problem) fail(`${problem} Detaching “${label}” there would leave elements of its own. Move it out of that slot first.`);
  }
  return { nodeId: top.id, label };
}
