/**
 * An Assets image dragged onto the canvas (#505): the images on the page being edited that can take it, and the one
 * a drop at the pointer changes. The pointer's place is what the page says is under it (the element chain, innermost
 * first); the image there takes it, and off any image, the one empty image of the component (or list item) the pointer
 * is in.
 */
import type { EditOperation } from '@shared/ops';
import type { ElementRef, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { partsShown } from '@shared/page-shell';
import { findParent } from '@engine/tree';
import { renderedImages, repeatsAbove, type ImageField } from '@generator/checks';
import { descOf, encodeItemId, parseCtx, resolveRef, type BridgeDesc } from './model';
import { insertOps, type InsertAt } from './insert-at';
import type { InsertAim } from './insert-drop';
import type { Box } from './reorder';

/** One image on the page (or the header or footer it shows) a dragged image can be dropped on. */
export interface ImageTarget {
  owner: OwnerRef;
  /** The image as the page shows it, matched against what is under the pointer. */
  desc: BridgeDesc;
  /**
   * What is outlined for it when the pointer is elsewhere in its component: the image, or for one a design leaves out
   * until it has an image, the element that will show it (a team member's card); for a code placement, the placement.
   */
  box: BridgeDesc;
  /** The field a dropped image is written to, for this use only; null when the image can't take one. */
  field: ImageField | null;
  /** The field it shows, whether or not this use of it can take a drop. */
  reads: ImageField | null;
  unfilled: boolean;
  /** Shown by `box` until it has an image. */
  hidden: boolean;
  /** A code placement's one image, or one item's of the list it shows a picture per item of: whether its markup shows
   *  exactly it, and the files its picture can show now (see RenderedImage.code). */
  code: { drawn: boolean; files: string[]; item?: true } | null;
  /** Shown more than once on the page from the same field. */
  multiple: boolean;
  /**
   * The component it shows in (its context on the page) and the list items it is shown for, as `[repeat, item]`: for
   * content placed in a design's slot (an Image in a Section), that design.
   */
  scope: { ctx: string; rows: string[] };
  /** How the drag names it: "Portrait · Hannah Wells in Team". */
  label: string;
}

/** What resolveImageDrop finds: the image a drop changes, or a picture under the pointer that takes nothing. */
export type ImageHit = { target: ImageTarget; direct: boolean } | { blocked: true };

/** What the page says is at the pointer. */
export interface PointedAt {
  chain: BridgeDesc[];
  /**
   * The picture the pointer is on, if any: the file it shows, whether it is the only one the code placement around it
   * draws itself (`own`), and whether that placement draws it at all (`inside`; `own` says so too).
   */
  picture: { src: string; own: boolean; inside?: boolean } | null;
}

/** Whether a picture's address is the library file `file` (`images/x.jpg`), wherever the site is served from. */
export function showsFile(src: string, file: string): boolean {
  let path = src.split(/[?#]/)[0];
  try {
    path = decodeURI(path);
  } catch {
    // An address that does not decode is compared as it is.
  }
  return !!file && (path === `/${file}` || path.endsWith(`/${file}`));
}

export const descKey = (d: Pick<BridgeDesc, 'ctx' | 'node' | 'items'>) => JSON.stringify([d.ctx, d.node, d.items]);
const sameDesc = (a: BridgeDesc, b: BridgeDesc) => a.ctx === b.ctx && a.node === b.node && a.items === b.items;
const fieldKey = (owner: OwnerRef, f: ImageField) => JSON.stringify([owner.kind, owner.id, f.nodeId, f.prop ?? null, f.itemId ?? null, f.field ?? null]);
const row = (repeat: string, item: string) => JSON.stringify([repeat, item]);

/** The component a placement's design belongs to, named as Layers names it. */
function componentName(state: ProjectState, owner: OwnerRef, instancePath: string[]): string | undefined {
  if (!instancePath.length) return undefined;
  const r = resolveRef(state, { owner, instancePath: instancePath.slice(0, -1), nodeId: instancePath[instancePath.length - 1] });
  const n = r.node;
  if (n?.kind !== 'instance') return undefined;
  return n.name?.trim() || (Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId].name : undefined);
}

/**
 * The images a drop on page `pageId` can reach, in the header and footer it shows and in the page itself. An element
 * of the page that shows two different fields' images (a component placed in each item of a list, its images naming no
 * item of their own) can't tell them apart, so neither takes a drop; nor does a field shown in more than one item of a
 * list (every card's badge from one property, or content a design repeats in each item), since a drop on one item
 * would change them all.
 */
export function imageDropTargets(state: ProjectState, pageId: string): ImageTarget[] {
  const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  if (!page) return [];
  const trees: Array<{ owner: OwnerRef; tree: NodeTree | undefined }> = [
    ...partsShown(page).map((part) => ({ owner: { kind: 'shell', id: part } as OwnerRef, tree: state.site.shell?.[part] })),
    { owner: { kind: 'page', id: pageId }, tree: page }
  ];
  const out: ImageTarget[] = [];
  const byDesc = new Map<string, ImageTarget[]>();
  for (const { owner, tree } of trees) {
    if (!tree) continue;
    for (const r of renderedImages(state, tree)) {
      const ref: ElementRef = { owner, instancePath: r.instancePath, nodeId: r.nodeId, ...(r.itemPath.length ? { itemPath: r.itemPath } : {}) };
      const desc = descOf(state, ref);
      const box = r.box ? descOf(state, { ...ref, nodeId: r.box }) : desc;
      const where = r.code ? componentName(state, owner, [...r.instancePath, r.nodeId]) : componentName(state, owner, r.instancePath);
      const t: ImageTarget = {
        owner,
        desc,
        box,
        field: r.field,
        reads: r.reads,
        unfilled: r.unfilled,
        hidden: !!r.box,
        code: r.code ?? null,
        multiple: !!r.multiple,
        scope: r.code
          ? { ctx: `${desc.ctx}|${desc.node}`, rows: [] }
          : r.shownIn
            ? { ctx: [`${owner.kind}:${owner.id}`, ...r.shownIn.instancePath].join('|'), rows: r.shownIn.repeats.map((rep, i) => row(rep, encodeItemId(r.shownIn!.itemPath[i] ?? ''))) }
            : { ctx: desc.ctx, rows: r.repeats.map((rep, i) => row(rep, encodeItemId(r.itemPath[i] ?? ''))) },
        label: `${r.name}${r.item ? ` · ${r.item}` : ''}${where ? ` in ${where}` : owner.kind === 'shell' ? ` in the ${owner.id}` : ''}`
      };
      const k = descKey(desc);
      const same = byDesc.get(k);
      // The same field shown again from the same element (slot content a design repeats) is one image.
      if (same?.some((s) => s.field && t.field && fieldKey(s.owner, s.field) === fieldKey(t.owner, t.field))) continue;
      byDesc.set(k, [...(same ?? []), t]);
      out.push(t);
    }
  }
  // The items of a list a code placement shows a picture per item of are told apart by the file each shows.
  for (const group of byDesc.values()) if (group.length > 1 && !group.every((t) => t.code?.item)) for (const t of group) t.field = null;
  // Every use of a field, counted whether or not it can take a drop itself: a field one of whose uses can't be told
  // apart (a component placed in each item of a list) is shown there too, and would change there.
  const byField = new Map<string, ImageTarget[]>();
  for (const t of out) if (t.reads) byField.set(fieldKey(t.owner, t.reads), [...(byField.get(fieldKey(t.owner, t.reads)) ?? []), t]);
  for (const group of byField.values()) {
    const rows = new Set(group.map((t) => JSON.stringify(t.scope.rows)));
    if (rows.size > 1 || group.some((t) => t.multiple || !t.field)) for (const t of group) t.field = null;
  }
  return out;
}

/** The definition whose design an element of the page belongs to, from its context (`page:home|hero`). */
function designAt(state: ProjectState, ctx: string) {
  const at = parseCtx(ctx);
  if (!at?.path.length) return undefined;
  const r = resolveRef(state, { owner: at.owner, instancePath: at.path.slice(0, -1), nodeId: at.path[at.path.length - 1] });
  return r.node?.kind === 'instance' && Object.hasOwn(state.components, r.node.definitionId) ? state.components[r.node.definitionId] : undefined;
}

/**
 * The component, or list item of one, the pointer is in: the nearest element on the chain that is a list item's own
 * element (a team member's card) or the outer element of a placed component. Elements of the page itself (content
 * placed in a section's slot) belong to the component around them.
 */
export function scopeAt(state: ProjectState, chain: BridgeDesc[]): { ctx: string; rows: string[] } | null {
  for (const e of chain) {
    if (e.code) return { ctx: `${e.ctx}|${e.node}`, rows: [] };
    const tree = designAt(state, e.ctx)?.tree;
    if (!tree || !Object.hasOwn(tree.nodes, e.node)) continue;
    if (tree.rootIds[0] === e.node) return { ctx: e.ctx, rows: [] };
    const p = findParent(tree, e.node);
    if (!p?.parentId || tree.nodes[p.parentId]?.kind !== 'repeat') continue;
    const repeats = repeatsAbove(tree, e.node);
    const items = e.items ? e.items.split(',') : [];
    if (repeats.length !== items.length) return null;
    return { ctx: e.ctx, rows: repeats.map((rep, i) => row(rep, items[i])) };
  }
  return null;
}

/**
 * The image a drop where the page says the pointer is would change, and whether the pointer is on it. On an image, that
 * image (none when it can't take one). Off any image, the one empty image of the component or list item the pointer is
 * in, counted once however often it shows; none when it has none, or more than one. `shown` says whether the page
 * shows an image's box now (a tab not chosen does not): only those count. `blocked` for a picture a list item of a code
 * placement shows that can't take it (another item, or other content of the placement, shows the same file): the drop
 * is the picture's, and does nothing.
 */
export function resolveImageDrop(state: ProjectState, targets: readonly ImageTarget[], at: PointedAt, shown: (t: ImageTarget) => boolean = () => true): ImageHit | null {
  const first = at.chain[0];
  if (!first) return null;
  const on = targets.find((t) => !t.code && !t.hidden && sameDesc(t.desc, first));
  if (on) return on.field ? { target: on, direct: true } : null;
  if (at.picture) {
    // The one picture a code placement draws, showing its image property's file: that property.
    const shows = (t: ImageTarget) => !!t.code?.drawn && sameDesc(t.desc, first) && t.code.files.some((f) => showsFile(at.picture!.src, f));
    const drawn = first.code && at.picture.own ? targets.find((t) => !t.code?.item && shows(t)) : undefined;
    if (drawn) return drawn.field ? { target: drawn, direct: true } : null;
    // A picture the code draws of one item of its list (a Gallery's): the one item whose picture shows that file. Two
    // showing it can't be told apart.
    const items = first.code && (at.picture.own || at.picture.inside) ? targets.filter((t) => t.code?.item && shows(t)) : [];
    if (items.length) return items.length === 1 && items[0].field ? { target: items[0], direct: true } : { blocked: true };
    // Any other picture (one the code draws of its own, an entry's, one in rich text) takes nothing. An empty one the
    // code draws (its placeholder shows no file) is the placement's empty image, as anywhere else on it.
    if (!(first.code && at.picture.own && !at.picture.src)) return null;
  }
  if (first.tag === 'img' || first.tag === 'picture') return null;
  const scope = scopeAt(state, at.chain);
  if (!scope) return null;
  const within = (rows: string[]) => scope.rows.every((r, i) => rows[i] === r);
  const empty = new Map<string, ImageTarget>();
  for (const t of targets) {
    if (!t.unfilled || t.scope.ctx !== scope.ctx || !within(t.scope.rows) || !shown(t)) continue;
    empty.set(t.field ? fieldKey(t.owner, t.field) : `desc:${descKey(t.desc)}`, t);
  }
  if (empty.size !== 1) return null;
  const [t] = empty.values();
  return t.field && !t.multiple ? { target: t, direct: false } : null;
}

/** The change a drop makes: the asset ID in the field, which takes the image's suggested alt text with it. */
export function imageDropOps(owner: OwnerRef, field: ImageField, assetId: string): EditOperation[] {
  if (field.prop === undefined) return [{ type: 'node.setContent', owner, nodeId: field.nodeId, field: 'image', value: assetId }];
  return [
    {
      type: 'instance.setProp',
      owner,
      nodeId: field.nodeId,
      prop: field.prop,
      ...(field.itemId !== undefined ? { itemId: field.itemId } : {}),
      ...(field.field !== undefined ? { field: field.field } : {}),
      value: assetId
    }
  ];
}

/**
 * The change a drop between content makes (#506), the one Place on page makes: a new Image element at `at` (in a Section
 * of its own at a page's top level), named `nodeId`, showing the library image with its suggested alt text.
 */
export function imageInsertOps(at: InsertAt, assetId: string, nodeId: string): EditOperation[] {
  return [...insertOps(at, { primitive: 'image' }, 'element', nodeId), { type: 'node.setContent', owner: at.owner, nodeId, field: 'image', value: assetId }];
}

/**
 * What a release of an Assets image at the pointer does: fill or replace an image on the page (#505), go between
 * content as a new Image element, where an Insert tile would (#506; `aim.at` null where nothing can go), nothing, or
 * not known yet, which a release waits out.
 */
export type AssetAim = { kind: 'pending' } | { kind: 'none' } | { kind: 'image'; target: ImageTarget; outline: Box } | { kind: 'insert'; aim: InsertAim };

/**
 * The image the page says is at the pointer takes the drop first (#505); a new Image goes between content only where
 * no image is targeted (#506). `hit`: what resolveImageDrop found, `outline` the box it shows; `ready`: whether what
 * an empty image off the pointer and a place between content are found by is measured where the page now shows (an
 * empty image not yet measured is not yet counted, so a miss means nothing until then); `insert`: where it would go
 * between content. An image that takes it but can't be outlined (one shown more than once), or a picture that takes
 * nothing (`blocked`), takes it nowhere.
 */
export function assetAim(hit: ImageHit | null, outline: Box | null, ready: boolean, insert: () => InsertAim | null): AssetAim {
  if (hit && 'blocked' in hit) return { kind: 'none' };
  if (hit?.direct || (hit && ready)) return outline ? { kind: 'image', target: hit.target, outline } : { kind: 'none' };
  if (!ready) return { kind: 'pending' };
  const aim = insert();
  return aim ? { kind: 'insert', aim } : { kind: 'none' };
}

/** What an aim would do, to tell whether two aims at the same point agree: null while it is not known yet. */
export function aimKey(a: AssetAim): string | null {
  if (a.kind === 'pending') return null;
  if (a.kind === 'image') return JSON.stringify(['image', descKey(a.target.desc), a.target.field && fieldKey(a.target.owner, a.target.field)]);
  if (a.kind === 'insert') return JSON.stringify(['insert', a.aim.at && [a.aim.at.owner, a.aim.at.parentId, a.aim.at.slot ?? null, a.aim.at.index ?? null]]);
  return 'none';
}
