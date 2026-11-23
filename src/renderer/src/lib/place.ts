import type { ProjectSnapshot } from '@shared/api';
import type { AssetRecord } from '@shared/types';
import { api, commitIfUnchanged, getState, setState, toast } from '../store';
import { trackApply, type ApplyOutcome } from './pending';

/** Asks the Assets panel to open on one image. `detail`: { opening, assetId }. */
export const SHOW_ASSET_EVENT = 'builder-show-asset';

/** Open the Assets panel on an image, if it is still in the opening of the project it was offered in. */
export function showAsset(opening: string, assetId: string): void {
  const snap = getState().snapshot;
  if (snap?.workspaceKey !== opening) return;
  if (snap.state.assets.assets[assetId]?.kind !== 'image') return toast('That image is no longer in Assets.', 'info');
  setState({ leftTab: 'assets' });
  window.dispatchEvent(new CustomEvent(SHOW_ASSET_EVENT, { detail: { opening, assetId } }));
}

/** none: no image arrived. placed: the image is in the field. kept: it is in Assets, and not in the field. */
export type PlaceResult = { kind: 'none' } | { kind: 'placed'; assetId: string } | { kind: 'kept'; assetId: string };

const sentenceEnd = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

/**
 * Import images for one image field (through the file picker when no `paths` are given) and place the first image
 * that arrives there. `place` writes it through the field's own change handler, kept from when the import began,
 * so the image goes to that field even when the author has moved to another section meanwhile, and never to the
 * one selected now. `base` is the project as the field's editor showed it then: the image is placed only while
 * the field still holds what it held, and is otherwise kept in Assets, with a note saying why and a way to find
 * it. `shown` says whether that editor is still on screen; a placement made out of sight is announced.
 *
 * The whole import counts as a save in flight until it settles, so the toolbar never says "Saved" while a
 * placement is still owed, and saving or leaving the project waits for it and hears if it was not made.
 */
export async function importAndPlace(opts: { paths?: string[]; base: ProjectSnapshot | null; place: (asset: AssetRecord) => unknown; shown: () => boolean }): Promise<PlaceResult> {
  let landed!: (o: ApplyOutcome) => void;
  trackApply(new Promise<ApplyOutcome>((r) => (landed = r)));
  setState({ pendingSave: getState().pendingSave + 1 });
  let outcome: ApplyOutcome = { ok: true };
  try {
    const r = await api.project.importAssets(opts.paths, 'image').catch((e: Error) => ({ ok: false, assetIds: [] as string[], message: `The image couldn’t be added: ${e.message}` }));
    if (r.message) toast(r.message, r.assetIds.length ? 'info' : 'error');
    const base = opts.base;
    const snap = getState().snapshot;
    // Only an image of the project the import began in can fill the field; fonts can arrive in the same drop.
    const assets = base && snap?.workspaceKey === base.workspaceKey ? snap.state.assets.assets : {};
    const asset = r.assetIds.map((id) => (Object.hasOwn(assets, id) ? assets[id] : undefined)).find((a) => a?.kind === 'image');
    if (!base || !asset) return { kind: 'none' };
    const done = await commitIfUnchanged(base, () => opts.place(asset));
    if (done.kind === 'applied' || done.kind === 'nothing') {
      if (done.kind === 'applied' && !opts.shown()) toast(`“${asset.name}” is now in the ${done.where}.`, 'info');
      return { kind: 'placed', assetId: asset.id };
    }
    // The project was closed or opened again meanwhile: nothing here is about the project now open.
    if (done.kind === 'closed') return { kind: 'kept', assetId: asset.id };
    // Undone (or removed) before it could be placed: it is not in Assets either.
    if (getState().snapshot?.state.assets.assets[asset.id]?.kind !== 'image') {
      outcome = { ok: false, message: `“${asset.name}” was not placed: it was removed from Assets while it was being added.` };
      toast(outcome.message!, 'error');
      return { kind: 'none' };
    }
    const why =
      done.kind === 'changed'
        ? `the ${done.where} was edited while it was being added.`
        : done.kind === 'gone'
          ? `the ${done.where} was removed while it was being added.`
          : done.kind === 'busy'
            ? 'the AI is making changes.'
            : sentenceEnd(done.message);
    outcome = { ok: false, message: `“${asset.name}” was added to Assets but not placed: ${why}` };
    toast(outcome.message!, 'error', { label: 'Show image', run: () => showAsset(base.workspaceKey, asset.id) });
    return { kind: 'kept', assetId: asset.id };
  } finally {
    setState({ pendingSave: Math.max(0, getState().pendingSave - 1) });
    landed(outcome);
  }
}
