/**
 * Image files dropped on the AI Chat composer (#679): imported into Assets by the verified importer (with the import
 * review first, for a HEIC or large photo), then attached to the unsent message of the conversation they were dropped
 * on, as the chips an image chosen from Assets gets. The AI is told only each image's name and asset ID, as for any
 * attached image, never the picture.
 */
import { api, getState, setState, toast } from '../store';
import { assetArrived, reviewImport } from './import-review';
import { attachImages, droppedImagesNote } from './chatDrafts';
import { plural } from './storage';

export { isFileDrag } from './chatDrafts';

/**
 * Each drop still being imported, and the conversation whose unsent message it is for: that message's, wherever it
 * moves, and none once the message is discarded.
 */
const pending = new Set<{ to: string | null }>();

/**
 * A conversation's unsent message moved to another conversation (`to`), or was discarded (null: the conversation
 * deleted, history cleared, or the draft replaced by a request put back): the images still being added for it follow
 * it, or go to no message. `from` null means every conversation's.
 */
export function retargetDrops(from: string | null, to: string | null): void {
  for (const d of pending) if (from === null || d.to === from) d.to = to;
}

/**
 * Import the dropped files as images and attach what arrives to the unsent message of `conversationId`, or of the
 * conversation it has moved to since (see retargetDrops). Nothing is attached when the project was closed or opened
 * again meanwhile, or the message was discarded. Returns the asset IDs attached, and where.
 */
export async function importIntoChat(paths: string[], conversationId: string): Promise<{ ids: string[]; to: string | null }> {
  const drop = { to: conversationId as string | null };
  pending.add(drop);
  try {
    const ids = await attachDropped(paths, () => drop.to);
    return { ids, to: drop.to };
  } finally {
    pending.delete(drop);
  }
}

async function attachDropped(paths: string[], target: () => string | null): Promise<string[]> {
  if (!paths.length) return [];
  const plan = await reviewImport(paths, 'image').catch((e: Error) => (toast(`The images couldn’t be added: ${e.message}`, 'error'), null));
  if (!plan) return [];
  const { opening } = plan.choices;
  const r: { ok: boolean; assetIds: string[]; message?: string; note?: string } = await api.project.importAssets(plan.paths, 'image', plan.choices).catch((e: Error) => ({ ok: false, assetIds: [] as string[], message: `The images couldn’t be added: ${e.message}` }));
  const here = () => getState().snapshot?.workspaceKey === opening;
  if (!here()) return [];
  if (!r.assetIds.length) {
    if (r.message || r.note) toast([r.note, r.message].filter(Boolean).join(' '), r.message ? 'error' : 'info');
    return [];
  }
  // Only images were imported, so every ID returned is one. The new records reach this window with the next snapshot,
  // which the chips wait for to name them; one that has not arrived by then is looked for in the project itself, and
  // one it does not have either is never attached (the message would be refused for it).
  const arrived = await Promise.all(r.assetIds.map((id) => assetArrived(id, opening)));
  let ids = r.assetIds;
  if (arrived.includes(false)) {
    const snap = await api.project.snapshot().catch(() => null);
    const listed = snap?.workspaceKey === opening ? snap.state.assets.assets : {};
    ids = r.assetIds.filter((id, i) => arrived[i] || Object.hasOwn(listed, id));
  }
  if (!here()) return [];
  const lost = r.assetIds.length - ids.length;
  const conversationId = target();
  if (!conversationId) {
    toast(`${plural(ids.length, 'image is', 'images are')} in Assets, but the message ${ids.length === 1 ? 'it was' : 'they were'} for has gone.`, 'info');
    return [];
  }
  const done = attachImages(getState().chatImages, conversationId, ids);
  if (done.images !== getState().chatImages) setState({ chatImages: done.images });
  const said = [droppedImagesNote({ added: done.added.length, already: done.already, full: done.full }), lost ? `${plural(lost, 'image', 'images')} could not be attached: add ${lost === 1 ? 'it' : 'them'} from Assets.` : '', r.note ?? '', r.message ?? ''].filter(Boolean).join(' ');
  if (said) toast(said, r.message && !done.added.length ? 'error' : 'info');
  return done.added;
}
