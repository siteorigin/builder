/**
 * The editor's Copy and Paste of sections and elements, also between pages: the selected one, or the ones selected
 * together in Layers (lib/layer-set). The open project holds what was copied (ProjectSession.copy), so a paste never
 * depends on the original.
 */
import { api, applyOps, getState, setState, toast } from '../store';
import { focusInLayers, focusSelectedRow, groupName, insertionPoint, planLayers, type InsertAt, type LayersPlan } from './actions';
import { layerRef } from './layer-set';
import { refLabel } from './model';

/** What Cmd+C last copied: a section or element on a page, or several side by side selected together in Layers.
 *  The open project holds the content itself, taken when it was copied, so editing or deleting the original
 *  afterwards does not change what is pasted. `clipboardId` settles once the project has taken the copy, or to null
 *  when it could not; `previous` is the copy before it, which a paste falls back to while this one is failing
 *  (dropped once it succeeds). `primary` and `anchor`: which of several was the selection, and where its Shift
 *  range started, for the paste to select the copies the same way. */
type Copied = { dir: string; label: string; section: boolean; count: number; primary: number; anchor: number; clipboardId: Promise<string | null>; previous: Copied | null };
let copied: Copied | null = null;

/** Each project holds its own copies, so they are forgotten when the project closes. */
export function forgetCopy() {
  copied = null;
}

/** Copy the selected section or element (the whole section when a part of one is selected), or the sections or
 *  elements selected together in Layers; or what `plan` names (a menu's, made as it opened). False when nothing is
 *  selected to copy. */
export function copySelection(plan: LayersPlan | null = planLayers()): boolean {
  if (!plan) return false;
  const g = plan.group;
  if (g.owner.kind !== 'page') {
    toast(g.owner.kind === 'shell' ? 'The shared header and footer are shared by the pages that show them, so they aren’t copied.' : 'Copy sections from a page. Inside a component, use Duplicate.', 'error');
    return true;
  }
  const snap = plan.snap;
  const label = plan.several ? groupName(snap.state, g) : refLabel(snap.state, layerRef(g.owner, g.ids[0]));
  const sameProject = () => getState().snapshot?.dir === snap.dir;
  const failed = (message?: string) => {
    if (sameProject()) toast(message ?? `${label} could not be copied.`, 'error');
    return null;
  };
  const at = (id: string | undefined) => Math.max(0, g.ids.indexOf(id ?? ''));
  const entry: Copied = {
    dir: snap.dir,
    label,
    section: g.parentId === null,
    count: g.ids.length,
    primary: at(plan.selection?.nodeId),
    anchor: at(plan.anchor),
    previous: copied,
    clipboardId: api.project.copy(g.owner.id, plan.several ? g.ids : g.ids[0], snap.revision).then(
      (r) => {
        if (!r.ok || !r.clipboardId) return failed(r.message);
        entry.previous = null;
        if (copied === entry && sameProject()) toast(`Copied ${label}. Paste ${entry.count > 1 ? 'them' : 'it'} on any page with ⌘V.`, 'info');
        return r.clipboardId;
      },
      () => failed()
    )
  };
  copied = entry;
  return true;
}

/** Paste the latest copy of this project's, if there is one (one of another project's is forgotten). */
export function pasteCopy(): boolean {
  if (copied && copied.dir !== getState().snapshot?.dir) copied = null;
  if (!copied) return false;
  void pasteCopied(copied);
  return true;
}

/**
 * Paste the latest copy that worked, as it was when copied, with new IDs, and select it: after the selection, or
 * after the last of the layers selected together (elements in their list, never into one of them), or at the end of
 * the page. The place is taken when ⌘V is pressed, even if the copy is still being taken; the copies are selected
 * only while the author is still where they pressed it.
 */
async function pasteCopied(latest: Copied) {
  const s = getState();
  const plan = planLayers(s);
  const group = plan?.several ? plan.group : null;
  const last = group ? layerRef(group.owner, group.ids[group.ids.length - 1]) : s.selection;
  const places: { section: InsertAt | null; element: InsertAt | null } = {
    section: insertionPoint('section', last),
    element: group && group.parentId !== null ? { owner: group.owner, parentId: group.parentId, slot: group.slot, index: group.indexes[group.indexes.length - 1] + 1 } : insertionPoint('element', last)
  };
  const follow = focusInLayers();
  let entry: Copied | null = latest;
  let clipboardId: string | null = null;
  while (entry && !(clipboardId = await entry.clipboardId)) entry = entry.previous;
  // A copy that failed has said so; a project closed in the meantime took its copies with it.
  if (!entry || !clipboardId || getState().snapshot?.dir !== entry.dir) return;
  const at = places[entry.section ? 'section' : 'element'];
  if (!at) return;
  // Beside layers selected together, the place is a position in their list as the project was at the keypress: a
  // change landing meanwhile makes it refuse rather than land somewhere else.
  const beside = at === places.element && !!group && group.parentId !== null && !entry.section;
  const r = await applyOps([{ type: 'node.paste', clipboardId, toOwner: at.owner, parentId: at.parentId, slot: at.slot, index: at.index }], `Paste ${entry.label}`, undefined, beside ? s.snapshot?.revision : undefined);
  const id = r?.[0]?.nodeId as string | undefined;
  const ids = Array.isArray(r?.[0]?.nodeIds) ? (r[0].nodeIds as string[]) : id ? [id] : [];
  const here = getState();
  if (!ids.length || here.snapshot?.dir !== entry.dir || here.pageId !== at.owner.id || here.definitionMode || here.selection !== s.selection || here.layerSet !== s.layerSet) return;
  const pick = (i: number) => ids[Math.min(i, ids.length - 1)];
  // Several pasted together stay selected together, as they were when copied.
  setState({ selection: layerRef(at.owner, pick(entry.primary)), layerSet: ids.length > 1 ? { owner: at.owner, ids, anchor: pick(entry.anchor) } : null, rightTab: 'inspect' });
  if (follow) focusSelectedRow();
}
