/**
 * The editor's Copy and Paste of sections and elements, also between pages: the selected one, or the ones selected
 * together in Layers (lib/layer-set). The open project holds what was copied (ProjectSession.copy), so a paste never
 * depends on the original. A copy belongs to the opening of the project it was made in (#240): a duplicated project
 * shares its page and element IDs with the original, so nothing copied in one is ever looked up in another, and a
 * Paste there says why nothing was pasted.
 */
import { api, applyOps, getState, setState, toast } from '../store';
import { currentOwner, focusInLayers, focusSelectedRow, groupName, insertionPoint, planLayers, type InsertAt, type LayersPlan } from './actions';
import { layerRef } from './layer-set';
import { refLabel } from './model';

/** What Cmd+C last copied: a section or element on a page, or several side by side selected together in Layers.
 *  The open project holds the content itself, taken when it was copied, so editing or deleting the original
 *  afterwards does not change what is pasted. `opening` is the snapshot's workspaceKey of the project it was copied
 *  in, the only one it can be pasted in. `clipboardId` settles once the project has taken the copy, or to null when
 *  it could not; `previous` is the copy before it in the same opening, which a paste falls back to while this one is
 *  failing (dropped once it succeeds). `primary` and `anchor`: which of several was the selection, and where its
 *  Shift range started, for the paste to select the copies the same way. */
type Copied = { dir: string; opening: string; label: string; section: boolean; count: number; primary: number; anchor: number; clipboardId: Promise<string | null>; previous: Copied | null; refused?: boolean };
let copied: Copied | null = null;
/** The latest copy, once its project has closed or another has opened: kept only to say why a Paste there does
 *  nothing. Its project folder tells another project from the same one opened again. */
let left: { dir: string; label: string; count: number } | null = null;

/** The latest copy not refused: what a Paste would use (one still being taken counts). */
function latest(): Copied | null {
  let kept = copied;
  while (kept?.refused) kept = kept.previous;
  return kept;
}

/** Tell the menus that offer Paste (and say what it pastes) whether there is something to paste now. */
function publish() {
  const kept = latest();
  const next = kept ? { opening: kept.opening, label: kept.label, count: kept.count } : null;
  const now = getState().copyNote;
  if (now?.opening === next?.opening && now?.label === next?.label && now?.count === next?.count) return;
  setState({ copyNote: next });
}

/** What a Paste would paste here, for a menu: the latest copy made in the project open now. Null when there is none, or
 *  it was made before the project was closed and opened again. */
export function copiedHere(s = getState()): { label: string; count: number } | null {
  const note = s.copyNote;
  return note && note.opening === s.snapshot?.workspaceKey ? note : null;
}

/** Each project holds its own copies, so they are forgotten when the project closes; a Paste in the next one says why
 *  nothing was pasted, naming the latest copy not refused in front of the author (one still being taken counts). */
export function forgetCopy() {
  const kept = latest();
  if (kept) left = { dir: kept.dir, label: kept.label, count: kept.count };
  copied = null;
  publish();
}

/** The opening of the project shown now, or null while none is (or one is closing). */
const openingNow = () => getState().snapshot?.workspaceKey || null;

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
  // A menu's plan from a project that has since closed copies nothing, and leaves this project's copy as it was.
  if (!snap.workspaceKey || snap.workspaceKey !== openingNow()) return true;
  const label = plan.several ? groupName(snap.state, g) : refLabel(snap.state, layerRef(g.owner, g.ids[0]));
  const sameProject = () => openingNow() === snap.workspaceKey;
  // A failure the author was shown is not a copy; one that came after they left the project went unseen, and to them
  // it was copied there.
  const failed = (message?: string) => {
    if (sameProject()) {
      entry.refused = true;
      publish();
      toast(message ?? `${label} could not be copied.`, 'error');
    }
    return null;
  };
  const at = (id: string | undefined) => Math.max(0, g.ids.indexOf(id ?? ''));
  // A copy left in another opening is never a fallback here.
  if (copied && copied.opening !== snap.workspaceKey) forgetCopy();
  const entry: Copied = {
    dir: snap.dir,
    opening: snap.workspaceKey,
    label,
    section: g.parentId === null,
    count: g.ids.length,
    primary: at(plan.selection?.nodeId),
    anchor: at(plan.anchor),
    previous: copied,
    clipboardId: api.project.copy(g.owner.id, plan.several ? g.ids : g.ids[0], snap.revision, snap.workspaceKey).then(
      (r) => {
        if (!r.ok || !r.clipboardId) return failed(r.message);
        entry.previous = null;
        // Taken while it is still the copy: what was left in another project no longer explains anything. (One
        // already left behind is the explanation itself.)
        if (copied === entry) left = null;
        if (copied === entry && sameProject()) toast(`Copied ${label}. Paste ${entry.count > 1 ? 'them' : 'it'} on any page with ⌘V.`, 'info');
        return r.clipboardId;
      },
      () => failed()
    )
  };
  copied = entry;
  publish();
  return true;
}

/** Paste the latest copy of this project's, if there is one. One made in another project, or before this one was
 *  closed and opened again, is never pasted: the key is taken, nothing changes, and the author is told why.
 *  `follow`: keyboard focus goes on to the pasted layers (asked for from Layers; by default, when it is in Layers now). */
export function pasteCopy(follow = focusInLayers()): boolean {
  const opening = openingNow();
  if (!opening) return false;
  if (copied && copied.opening !== opening) forgetCopy();
  // A copy that was refused is not one to paste (it has said so); a refused latest one falls back to the copy before it.
  if (copied && latest()) {
    void pasteCopied(copied, opening, follow);
    return true;
  }
  if (!left) return false;
  const dir = getState().snapshot?.dir;
  toast(
    left.dir === dir
      ? `Nothing was pasted. Closing the project cleared the copy of ${left.label}. Copy it again to paste it.`
      : `Nothing was pasted. ${left.label} ${left.count > 1 ? 'were' : 'was'} copied in another project, and copies can only be pasted in the project they were copied in, while it stays open.`,
    'info'
  );
  return true;
}

/** Paste chosen from a menu: as ⌘V does, though the menu may have been open while the copy went away or the editor
 *  left Edit mode, and says so. `follow`: the menu belongs to Layers, so focus goes on to the pasted layers. */
export function pasteFromMenu(follow = false) {
  if (getState().mode !== 'edit') return void toast('Paste works while editing a page, not in Preview.', 'info');
  if (!pasteCopy(follow)) toast('Nothing is copied. Copy a section or element first.', 'info');
}

/**
 * Paste the latest copy that worked, as it was when copied, with new IDs, and select it: after the selection, or
 * after the last of the layers selected together (elements in their list, never into one of them), or at the end of
 * the page. The place is taken when ⌘V is pressed, even if the copy is still being taken; the copies are selected
 * only while the author is still where they pressed it.
 */
async function pasteCopied(latest: Copied, opening: string, follow: boolean) {
  const s = getState();
  const plan = planLayers(s);
  const group = plan?.several ? plan.group : null;
  const last = group ? layerRef(group.owner, group.ids[group.ids.length - 1]) : s.selection;
  const places: { section: InsertAt | null; element: InsertAt | null } = {
    // Into a slot picked for Insert, if one is (nothing is selected then), as a tile clicked there goes.
    section: insertionPoint('section', last, undefined, undefined, s.slotTarget),
    element: group && group.parentId !== null ? { owner: group.owner, parentId: group.parentId, slot: group.slot, index: group.indexes[group.indexes.length - 1] + 1 } : insertionPoint('element', last, undefined, undefined, s.slotTarget)
  };
  let entry: Copied | null = latest;
  let clipboardId: string | null = null;
  while (entry && !(clipboardId = await entry.clipboardId)) entry = entry.previous;
  // A copy that failed has said so; a project closed in the meantime (even if opened again) took its copies with it.
  if (!entry || !clipboardId || openingNow() !== opening || entry.opening !== opening) return;
  // A component edited everywhere has no sections: what was copied goes where an element does, into the selected
  // container, else into the component's own root.
  const at = places[entry.section && !s.definitionMode ? 'section' : 'element'];
  // A component edited everywhere whose root holds nothing to put content in (a paragraph) has nowhere to paste.
  if (!at) return void toast(`Nothing was pasted. This component’s design has no container to hold ${entry.label}.`, 'info');
  // Beside layers selected together, the place is a position in their list as the project was at the keypress: a
  // change landing meanwhile makes it refuse rather than land somewhere else.
  const beside = at === places.element && !!group && group.parentId !== null;
  const r = await applyOps([{ type: 'node.paste', clipboardId, toOwner: at.owner, parentId: at.parentId, slot: at.slot, index: at.index }], `Paste ${entry.label}`, undefined, beside ? s.snapshot?.revision : undefined);
  const id = r?.[0]?.nodeId as string | undefined;
  const ids = Array.isArray(r?.[0]?.nodeIds) ? (r[0].nodeIds as string[]) : id ? [id] : [];
  const here = getState();
  // Selected only while the author is still where they pressed it: the same page, or the same component edited everywhere,
  // with nothing else selected or picked (another slot for Insert, say) meanwhile.
  const now = currentOwner();
  if (!ids.length || here.snapshot?.workspaceKey !== opening || now?.kind !== at.owner.kind || now.id !== at.owner.id || here.mode !== 'edit' || here.selection !== s.selection || here.layerSet !== s.layerSet || here.slotTarget !== s.slotTarget) return;
  const pick = (i: number) => ids[Math.min(i, ids.length - 1)];
  // Several pasted together stay selected together, as they were when copied.
  setState({ selection: layerRef(at.owner, pick(entry.primary)), layerSet: ids.length > 1 ? { owner: at.owner, ids, anchor: pick(entry.anchor) } : null, rightTab: 'inspect' });
  if (follow) focusSelectedRow();
}
