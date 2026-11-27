/**
 * What a live session's Copy Editor may change, checked against the project (#1148): the words of a page's own text
 * elements, and the copy and pictures a design marks `copyEditable` on the components placed on a page, with pictures
 * only from the asset library. Nothing structural (what is on a page and how it is arranged, styles, options, links),
 * nothing in the shared header and footer or in a design, and never where a contact form sends its messages.
 *
 * It is checked twice over, so neither half has to be right alone. Every operation is held to the project as it was
 * (copyEditorOperationProblem first, which reads the operation alone), naming the first refused, and then the project
 * as the batch would leave it is compared with the project as it was: it may differ only at the values those
 * operations were allowed to change, each still a value of the kind allowed. One refusal refuses the whole batch.
 */
import type { EditOperation } from '@shared/ops';
import type { GraphNode, NodeTree, ProjectState, PropSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import { isImageBlock, isRichBlock, spanRuns, type RichBlock, type RichSpan } from '@shared/richtext';
import { sameValue } from '@shared/same';
import { copyEditorOperationProblem } from '@shared/live/copy-editor';
import { formDestinationProps } from './form-destinations';
import { guestDestinationChange } from './guest-edits';
import { bindingSites, type BindingSite } from './schema';
import { findParent } from './tree';

/** Why a Copy Editor's batch is refused, and the operation that was, when it is one operation's fault. */
export interface CopyEditorRefusal {
  message: string;
  operationIndex?: number;
}

/** What a property holds for a Copy Editor: plain text, rich text, or a picture. */
type Kind = 'text' | 'rich' | 'image';
const kindOf = (schema: PropSchema | undefined): Kind | null => (schema?.type === 'string' ? 'text' : schema?.type === 'richtext' ? 'rich' : schema?.type === 'image' ? 'image' : null);

const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined => (record && Object.hasOwn(record, key) ? record[key] : undefined);

/** Whether a property of a design is one a Copy Editor may change, for one state of the project. */
export type CopyEditableLookup = (definitionId: string, prop: string) => boolean;

/**
 * Which properties a Copy Editor may change, worked out as they are asked about. A property qualifies when its design
 * marks it `copyEditable`, it is a top-level text, rich text or image property of a managed design, it has no part in
 * where a contact form sends (formDestinationProps), and every use of it in the design shows it as what it is: the
 * words of a text element of the same kind, an image element's picture, a test of whether it is set (which a Copy
 * Editor's edit never changes: see `present`), or a whole property passed on to a nested component that qualifies
 * in turn, for the same kind. A design that passes it on is followed at every hop; any other use (a tag, a link, a
 * comparison, a variant, a list, one field of it), a code component, which decides in its source what it does with
 * it, or a property the design never uses, does not qualify.
 */
export function copyEditableLookup(state: ProjectState): CopyEditableLookup {
  const known = new Map<string, boolean>();
  const visiting = new Set<string>();
  let destinations: Map<string, Set<string>> | undefined;
  const qualifies = (definitionId: string, prop: string): boolean => {
    const key = `${definitionId}\u0000${prop}`;
    const seen = known.get(key);
    if (seen !== undefined) return seen;
    // A design that reaches itself again never renders; nothing in such a loop qualifies.
    if (visiting.has(key)) return false;
    const def = own(state.components, definitionId);
    const schema = def ? own(def.properties, prop) : undefined;
    const kind = kindOf(schema);
    let ok = false;
    if (def?.kind === 'managed' && def.tree && kind && schema?.copyEditable === true && !(destinations ??= formDestinationProps(state)).get(definitionId)?.has(prop)) {
      visiting.add(key);
      const uses = bindingSites(def).filter((s) => isBinding(s.binding) && '$prop' in s.binding && s.binding.$prop === prop);
      ok = uses.length > 0 && uses.every((s) => shows(s, kind));
      visiting.delete(key);
    }
    known.set(key, ok);
    return ok;
  };
  const shows = (site: BindingSite, kind: Kind): boolean => {
    if ((site.binding as { field?: unknown }).field !== undefined) return false;
    const { node } = site;
    switch (site.field) {
      case 'when':
      case 'unless':
        return !site.comparison;
      case 'text':
        return node.kind === 'text' && (kind === 'rich' ? node.rich === true : kind === 'text' && !node.rich);
      case 'image':
        return node.kind === 'image' && kind === 'image';
      case 'prop': {
        if (node.kind !== 'instance' || site.prop === undefined) return false;
        const nested = own(state.components, node.definitionId);
        return kindOf(nested ? own(nested.properties, site.prop) : undefined) === kind && qualifies(node.definitionId, site.prop);
      }
      default:
        return false;
    }
  };
  return qualifies;
}

/** Whether a node of a tree is shown once for each item or entry of a repeat it is inside. */
function insideRepeat(tree: NodeTree, nodeId: string): boolean {
  let id = nodeId;
  // A tree cannot nest deeper than it has nodes; a longer walk is a loop, and counts as inside one.
  for (let steps = Object.keys(tree.nodes).length; steps > 0; steps--) {
    const parent = findParent(tree, id);
    if (!parent || parent.parentId === null) return false;
    id = parent.parentId;
    if (own(tree.nodes, id)?.kind === 'repeat') return true;
  }
  return true;
}

/**
 * Whether a value shows, as the generated site's `has()` judges it (generator/checks.ts `shown`): text of more than
 * spaces, a list or rich text with anything in it, a picture that is in the library. A Copy Editor's edit never
 * changes it, so an element shown only while its copy is set stays shown or hidden as it was, and no layout moves.
 */
function present(value: unknown, state: ProjectState): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object' && 'assetId' in value) {
    const id = (value as { assetId?: unknown }).assetId;
    return typeof id === 'string' && !!id && Object.hasOwn(state.assets.assets, id);
  }
  return !!value;
}

/** The links rich text holds, in order, a link running over several spans counted once, and its pictures. */
function richFixtures(blocks: readonly RichBlock[]): unknown[] {
  const out: unknown[] = [];
  for (const b of blocks) {
    if (isImageBlock(b)) {
      out.push(b);
      continue;
    }
    for (const run of spanRuns(b)) {
      let last: RichSpan['link'];
      for (const span of run) {
        if (span.link && !(last && sameValue(last, span.link))) out.push(span.link);
        last = span.link;
      }
    }
  }
  return out;
}

const COPY_ONLY = 'A copy editor changes only text and pictures on the site’s pages.';

/**
 * Why `now` is not a value a Copy Editor may leave where `was` was, for a value of this kind, or null when it is.
 * Text stays text; rich text keeps its links (their words may change, not where they go) and its pictures; a picture
 * is one in the library, with its own description, as decorative as it was. Whether it shows never changes.
 */
function valueProblem(kind: Kind, was: unknown, now: unknown, before: ProjectState): string | null {
  if (present(was, before) !== present(now, before)) return 'A copy editor rewords text and replaces pictures; adding or clearing them changes the layout, which is the host’s.';
  if (kind === 'text') return typeof now === 'string' ? null : COPY_ONLY;
  if (kind === 'rich') {
    if (!Array.isArray(was) || !Array.isArray(now) || !now.every(isRichBlock)) return COPY_ONLY;
    return sameValue(richFixtures(was as RichBlock[]), richFixtures(now)) ? null : 'A copy editor rewords links but does not add, remove or retarget them, or change pictures in the text.';
  }
  if (!now || typeof now !== 'object' || Array.isArray(now) || !was || typeof was !== 'object') return COPY_ONLY;
  const image = now as Record<string, unknown>;
  if (Object.keys(image).some((k) => k !== 'assetId' && k !== 'alt' && k !== 'decorative')) return COPY_ONLY;
  const asset = typeof image.assetId === 'string' ? own(before.assets.assets, image.assetId) : undefined;
  if (asset?.kind !== 'image') return 'A copy editor replaces a picture only with one already in the library.';
  if (typeof image.alt !== 'string') return COPY_ONLY;
  if (!sameValue(image.decorative, (was as { decorative?: unknown }).decorative)) return 'Only the host can change whether a picture is decorative.';
  return null;
}

/** A value a Copy Editor may change: a text element's words, or a placed component's property. */
type Leaf = { kind: 'text'; rich: boolean } | { kind: 'prop'; prop: string; type: Kind; schema: PropSchema };

const sameExcept = (a: object, b: object, skip: string): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === skip) continue;
    if (Object.hasOwn(a, k) !== Object.hasOwn(b, k) || !sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
};

/** What a placement shows for a property: its own value, or its design's default. */
const effective = (node: Extract<GraphNode, { kind: 'instance' }>, prop: string, schema: PropSchema): unknown => (Object.hasOwn(node.props, prop) ? node.props[prop] : schema.default);

/** Why one element of a page, changed at the leaves it was allowed, changed anywhere else or to a value it may not hold. */
function nodeProblem(was: GraphNode, now: GraphNode, leaves: readonly Leaf[], before: ProjectState): string | null {
  if (was.kind !== now.kind) return COPY_ONLY;
  if (was.kind === 'text' && now.kind === 'text') {
    if (!leaves.some((l) => l.kind === 'text') || !sameExcept(was, now, 'text')) return COPY_ONLY;
    return valueProblem(was.rich ? 'rich' : 'text', was.text, now.text, before);
  }
  if (was.kind !== 'instance' || now.kind !== 'instance' || !sameExcept(was, now, 'props')) return COPY_ONLY;
  const props = new Set([...Object.keys(was.props), ...Object.keys(now.props)]);
  for (const prop of props) {
    const leaf = leaves.find((l): l is Extract<Leaf, { kind: 'prop' }> => l.kind === 'prop' && l.prop === prop);
    if (!leaf) {
      if (Object.hasOwn(was.props, prop) !== Object.hasOwn(now.props, prop) || !sameValue(was.props[prop], now.props[prop])) return COPY_ONLY;
      continue;
    }
    const problem = valueProblem(leaf.type, effective(was, prop, leaf.schema), effective(now, prop, leaf.schema), before);
    if (problem) return problem;
  }
  return null;
}

/**
 * Why a Copy Editor's batch of `operations`, which leaves the project `before` as `after`, is refused, or null when
 * it may be saved. Pure: the host runs it on the project the engine is about to commit (main/controller.ts applyGuest's
 * guard), so what is saved is exactly what was checked.
 */
export function copyEditorBatchProblem(before: ProjectState, after: ProjectState, operations: readonly EditOperation[]): CopyEditorRefusal | null {
  const editable = copyEditableLookup(before);
  // The values the operations may change, by page and element.
  const allowed = new Map<string, Map<string, Leaf[]>>();
  for (const [operationIndex, op] of operations.entries()) {
    const refuse = (message: string): CopyEditorRefusal => ({ message, operationIndex });
    const shape = copyEditorOperationProblem(op);
    if (shape) return refuse(shape);
    if (op.type !== 'node.setContent' && op.type !== 'instance.setProp') return refuse(COPY_ONLY);
    const page = own(before.pages, op.owner.id);
    const node = page ? own(page.nodes, op.nodeId) : undefined;
    if (!page || !node) return refuse('A copy editor changes only what is already on the site’s pages.');
    // A repeat shows its contents once for every entry: changing them changes the design of every row.
    if (insideRepeat(page, node.id)) return refuse('A copy editor cannot change what a list of entries shows for each of them.');
    let leaf: Leaf;
    if (op.type === 'node.setContent') {
      if (node.kind !== 'text' || isBinding(node.text)) return refuse('A copy editor changes only the written words of a text element.');
      leaf = { kind: 'text', rich: !!node.rich };
    } else {
      const def = node.kind === 'instance' ? own(before.components, node.definitionId) : undefined;
      const schema = def ? own(def.properties, op.prop) : undefined;
      const type = kindOf(schema);
      if (node.kind !== 'instance' || !schema || !type || !editable(node.definitionId, op.prop)) return refuse(`Only the host can change “${(schema?.label ?? op.prop).slice(0, 60)}”.`);
      if (isBinding(own(node.props, op.prop))) return refuse('A copy editor cannot change content that comes from elsewhere.');
      leaf = { kind: 'prop', prop: op.prop, type, schema };
    }
    const nodes = allowed.get(page.id) ?? new Map<string, Leaf[]>();
    allowed.set(page.id, nodes.set(node.id, [...(nodes.get(node.id) ?? []), leaf]));
  }
  const refused = (message = COPY_ONLY): CopyEditorRefusal => ({ message });
  // Everything but the pages stays exactly as it was: the site and its header and footer, designs, styles, collections,
  // the library, the brief.
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'pages') continue;
    if (!sameValue((before as unknown as Record<string, unknown>)[key], (after as unknown as Record<string, unknown>)[key])) return refused();
  }
  const pageIds = new Set([...Object.keys(before.pages), ...Object.keys(after.pages)]);
  for (const id of pageIds) {
    const was = own(before.pages, id);
    const now = own(after.pages, id);
    if (!was || !now) return refused();
    if (was === now) continue;
    if (!sameExcept(was, now, 'nodes')) return refused();
    const nodeIds = new Set([...Object.keys(was.nodes), ...Object.keys(now.nodes)]);
    for (const nodeId of nodeIds) {
      const a = own(was.nodes, nodeId);
      const b = own(now.nodes, nodeId);
      if (!a || !b) return refused();
      if (a === b || sameValue(a, b)) continue;
      const leaves = allowed.get(id)?.get(nodeId);
      const problem = leaves ? nodeProblem(a, b, leaves, before) : COPY_ONLY;
      if (problem) return refused(problem);
    }
  }
  const destination = guestDestinationChange(before, after);
  return destination ? refused(destination) : null;
}
