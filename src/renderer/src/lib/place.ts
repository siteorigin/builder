import type { ProjectSnapshot } from '@shared/api';
import type { AssetRecord } from '@shared/types';
import { api, commitIfUnchanged, errorText, getState, setState, toast } from '../store';
import { trackApply, type ApplyOutcome } from './pending';
import { reviewImport } from './import-review';

/** Asks the Assets panel to open on one image or document. `detail`: { opening, assetId }. */
export const SHOW_ASSET_EVENT = 'builder-show-asset';

/** Open the Assets panel on an image or document, if it is still in the opening of the project it was offered in. */
export function showAsset(opening: string, assetId: string): void {
  const snap = getState().snapshot;
  if (snap?.workspaceKey !== opening) return;
  const kind = Object.hasOwn(snap.state.assets.assets, assetId) ? snap.state.assets.assets[assetId]?.kind : undefined;
  if (kind !== 'image' && kind !== 'document') return toast('That file is no longer in Assets.', 'info');
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
 * one selected now; it can return a note to add when the placement is announced. `holds` says the field already
 * held that image when the import began (the same picture imported again): it is then only checked. `base` is the
 * project as the field's editor showed it then: the image is placed only while the field still holds what it
 * held, and is otherwise kept in Assets, with a note saying why and a way to find it. `shown` says whether that
 * editor is still on screen; a placement made out of sight is announced.
 *
 * The whole import counts as a save in flight until it settles, so the toolbar never says "Saved" while a
 * placement is still owed, and saving or leaving the project waits for it and hears if it was not made.
 */
export async function importAndPlace(opts: { paths?: string[]; base: ProjectSnapshot | null; place: (asset: AssetRecord) => string | void; holds?: (asset: AssetRecord) => boolean; shown: () => boolean }): Promise<PlaceResult> {
  // Choosing the files, and the review of HEIC or large photos, come first: nothing is owed until the author confirms,
  // so leaving the project never waits on a question. The field is still the one captured in `base` and `place`.
  const plan = await reviewImport(opts.paths, 'image').catch((e: Error) => (toast(`The image couldn’t be added: ${e.message}`, 'error'), null));
  if (!plan) return { kind: 'none' };
  let landed!: (o: ApplyOutcome) => void;
  trackApply(new Promise<ApplyOutcome>((r) => (landed = r)));
  setState({ pendingSave: getState().pendingSave + 1 });
  let outcome: ApplyOutcome = { ok: true };
  try {
    const r: { ok: boolean; assetIds: string[]; message?: string; note?: string } = await api.project.importAssets(plan.paths, 'image', plan.choices).catch((e: Error) => ({ ok: false, assetIds: [] as string[], message: `The image couldn’t be added: ${e.message}` }));
    if (r.note) toast(r.note, 'info');
    // A notice naming files that were not added stays until it is dismissed, whether or not others arrived.
    if (r.message) toast(r.message, 'error');
    // Nothing arrived and the import said why (closing the picker says nothing): the image the author asked for is not here.
    if (!r.assetIds.length && r.message) outcome = { ok: false, message: r.message };
    const base = opts.base;
    if (!base || !r.assetIds.length) return { kind: 'none' };
    // Only an image of the project the import began in can fill the field; fonts can arrive in the same drop.
    const imageIn = (snap: ProjectSnapshot | null) => {
      const assets = snap?.workspaceKey === base.workspaceKey ? snap.state.assets.assets : {};
      return r.assetIds.map((id) => (Object.hasOwn(assets, id) ? assets[id] : undefined)).find((a) => a?.kind === 'image');
    };
    // This window hears of the new records after the import answers, at the latest: ask the project when it has not yet.
    const project = () => api.project.snapshot().catch(() => null);
    let asset = imageIn(getState().snapshot);
    if (!asset) {
      const snap = await project();
      asset = imageIn(snap);
      if (!snap) outcome = { ok: false, message: 'The image was added, but it could not be placed. Choose it from Assets.' };
    }
    if (!asset) return { kind: 'none' };
    let note: string | void = undefined;
    const done = await commitIfUnchanged(base, () => (note = opts.place(asset)), { checkOnly: !!opts.holds?.(asset) });
    if (done.kind === 'applied' || done.kind === 'unchanged') {
      if (done.kind === 'applied' && !opts.shown()) toast([`“${asset.name}” is now in the ${done.where}.`, note].filter(Boolean).join(' '), 'info');
      return { kind: 'placed', assetId: asset.id };
    }
    // The project was closed or opened again meanwhile: nothing here is about the project open now.
    if (done.kind === 'closed' || getState().snapshot?.workspaceKey !== base.workspaceKey) return { kind: 'kept', assetId: asset.id };
    const lead = `“${asset.name}” was added to Assets but not placed`;
    // Undone (or removed) before it could be placed: it is not in Assets either.
    const inAssets = (snap: ProjectSnapshot | null | undefined) => snap?.workspaceKey === base.workspaceKey && snap.state.assets.assets[asset.id]?.kind === 'image';
    if (!inAssets(getState().snapshot) && !inAssets(await project())) {
      outcome = { ok: false, message: `“${asset.name}” was not placed: it was removed from Assets while it was being added.` };
      toast(outcome.message!, 'error');
      return { kind: 'none' };
    }
    const message =
      done.kind === 'changed'
        ? `${lead}: the ${done.where} was edited while it was being added.`
        : done.kind === 'gone'
          ? `${lead}: ${done.what === 'list item' ? `its item in the ${done.where}` : `the ${done.where}`} was removed while it was being added.`
          : done.kind === 'busy' && !done.message
            ? `${lead}: the AI is making changes.`
            : `${lead}. ${sentenceEnd(done.message ?? 'That change could not be applied')}`;
    outcome = { ok: false, message };
    toast(message, 'error', { label: 'Show image', opening: base.workspaceKey, run: () => showAsset(base.workspaceKey, asset.id) });
    return { kind: 'kept', assetId: asset.id };
  } catch (e) {
    outcome = { ok: false, message: errorText(e) };
    throw e;
  } finally {
    setState({ pendingSave: Math.max(0, getState().pendingSave - 1) });
    landed(outcome);
  }
}
