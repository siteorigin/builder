import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ImageOff, X } from 'lucide-react';
import type { ListItem, ListProp, ProjectState } from '@shared/types';
import { setState, useStore } from '../store';
import { SwitchRow } from '../components/ui';
import { AssetImage } from '../components/AssetImage';
import { AssetOrderControls, useAssetSeries } from '../components/AssetOrder';
import { assetLabels, inSeries, sortAssets } from '@shared/asset-order';
import { isImeComposing } from '../lib/ime';
import { mergeChoice, movePick, overNote, pickRoom, sampleRows, startingSamples, togglePick } from '../lib/gallery-picks';

/** Changes when a picture's files go missing or come back, so a preview that gave up on a file tries it again. */
export const missingKey = (snapshot: { missingAssets: Array<{ assetId: string; original: boolean; variants: unknown[] }> } | null | undefined, id: string) => {
  const gone = snapshot?.missingAssets.find((m) => m.assetId === id);
  return gone ? `missing-${gone.original}-${gone.variants.length}` : 'present';
};

/**
 * Arrow keys move between the thumbnails of a picker grid (three to a row); the grid is one tab stop. A grid that
 * keeps its tab stop in state gets the index of the tile moved to (the tiles are the images shown, in order);
 * otherwise the tiles' tab stops are moved here.
 */
export function pickGridKeys(e: ReactKeyboardEvent<HTMLDivElement>, onMove?: (to: number) => void) {
  const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>('.insp-pick-tile')];
  const i = tiles.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[e.key];
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? tiles.length - 1 : step !== undefined ? Math.max(0, Math.min(tiles.length - 1, i + step)) : -1;
  if (to < 0) return;
  e.preventDefault();
  if (onMove) onMove(to);
  else tiles.forEach((t, k) => (t.tabIndex = k === to ? 0 : -1));
  tiles[to].focus();
}

/**
 * Choose several images from Assets for a gallery, put them in order, then add them all as one change. Nothing is
 * written until Add: closing the picker drops the choice. While the list is still exactly its component's sample rows,
 * the images replace them (the author can keep them instead); `onAdd` gets the sample rows shown as replaced. It
 * resolves to whether the change was made; the picker stays open with the choice when it was not. While it is being
 * made, the choice can't be changed or dismissed, so what lands is what the picker shows.
 */
export function ImagesPicker({ schema, items, state, onAdd, onClose }: { schema: ListProp; items: ListItem[]; state: ProjectState; onAdd: (assetIds: string[], replace: string[]) => Promise<boolean>; onClose: (refocus: boolean) => void }) {
  const runtime = useStore((s) => s.runtime);
  const snapshot = useStore((s) => s.snapshot);
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const assets = state.assets.assets;
  // In the order Assets lists them, and changing the order here changes it there.
  const assetSort = useStore((s) => s.assetSort);
  const images = useMemo(() => sortAssets(Object.values(assets).filter((a) => a.kind === 'image'), assetSort), [assets, assetSort]);
  const labels = useMemo(() => assetLabels(images), [images]);
  const series = useAssetSeries(images, snapshot?.workspaceKey);
  const samples = sampleRows(schema, items);
  const [chosenRaw, setChosen] = useState<string[]>([]);
  // An image removed from Assets meanwhile drops out of the choice, and Add asks for the smaller choice to be confirmed.
  const chosen = chosenRaw.filter((id) => Object.hasOwn(assets, id) && assets[id].kind === 'image');
  const [notice, setNotice] = useState('');
  const gone = chosenRaw.length - chosen.length;
  // Samples are replaced by default only while the list is exactly the rows its component started with.
  const [replace, setReplace] = useState(() => startingSamples(schema, items));
  const replacing = replace ? samples.length : 0;
  const room = pickRoom(schema, items.length, replacing);
  const over = overNote(chosen.length, room);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const orderId = useId();
  const overId = useId();
  const alive = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    // Focus starts on the search, else the first image, else the way to Assets: once, when the picker opens, so a
    // grid drawn again later never takes focus from what the author is typing in.
    root.current?.querySelector<HTMLElement>('input[type="search"], .insp-pick-tile, .btn')?.focus();
    return () => {
      alive.current = false;
    };
  }, []);
  const needle = q.trim().toLowerCase();
  const shown = images.filter((a) => (!series.key || inSeries(a, series.key)) && (!needle || `${a.name} ${a.description ?? ''} ${a.altSuggestion ?? ''}`.toLowerCase().includes(needle)));
  const full = chosen.length >= room;
  // Images that left Assets stay in the raw choice, in their places, until Add has said so.
  const choose = (next: string[]) => {
    if (busy) return;
    setNotice('');
    setChosen(mergeChoice(chosenRaw, chosen, next));
  };
  const close = () => {
    if (!busy) onClose(true);
  };
  const add = async () => {
    if (busy || !chosen.length || over) return;
    if (gone) {
      setChosen(chosen);
      setNotice(`${gone === 1 ? 'An image you chose was' : `${gone} images you chose were`} removed from Assets. Check your choice, then add again.`);
      return;
    }
    setBusy(true);
    try {
      const ok = await onAdd(chosen, replacing ? samples : []);
      if (ok && alive.current) onClose(false);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  // Another image with the same name is told apart by its ID.
  const nameOf = (id: string) => labels.get(id)?.label ?? assets[id]?.name ?? 'Image';
  return (
    <div
      ref={root}
      className="insp-pick insp-pick-many"
      role="group"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || isImeComposing(e)) return;
        e.stopPropagation();
        close();
      }}
    >
      <div className="insp-group-title" id={titleId}>
        Choose images
      </div>
      {images.length === 0 ? (
        <>
          <p className="faint insp-note">No images in Assets yet. Import them there, then choose them here.</p>
          <div className="insp-pick-tools">
            <button className="btn btn-sm" onClick={() => setState({ leftTab: 'assets' })}>
              Open Assets
            </button>
            <button className="btn btn-sm" onClick={close}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="faint insp-note">Select images in the order you want them, then check the order below.</p>
          {(images.length > 6 || q) && (
            <div className="insp-pick-tools">
              <input type="search" className="input sm grow" placeholder="Search images" aria-label="Search images" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          {/* Kept while a series is chosen, so it can always be cleared. */}
          {(images.length > 6 || !!series.key) && <AssetOrderControls series={series.list} value={series.key} onSeries={series.choose} />}
          {shown.length > 0 ? (
            // Drawn afresh for each search, series and order, so the first image shown is the grid's tab stop again.
            <div key={JSON.stringify([needle, series.key, assetSort])} className="insp-pick-grid" role="listbox" aria-multiselectable="true" aria-label="Your images" aria-describedby={over ? overId : undefined} onKeyDown={pickGridKeys}>
              {shown.map((a, i) => {
                const at = chosen.indexOf(a.id);
                const blocked = at < 0 && full;
                return (
                  <button
                    key={a.id}
                    role="option"
                    aria-selected={at >= 0}
                    aria-disabled={blocked || busy ? true : undefined}
                    tabIndex={i === 0 ? 0 : -1}
                    className={`insp-pick-tile${at >= 0 ? ' current' : ''}`}
                    title={blocked ? `${labels.get(a.id)?.label}: the gallery has no room for more images` : labels.get(a.id)?.label}
                    onClick={() => choose(togglePick(chosen, a.id, room))}
                  >
                    {devUrl ? <AssetImage key={missingKey(snapshot, a.id)} asset={a} devUrl={devUrl} cover alt="" loading="lazy" /> : <ImageOff aria-hidden="true" />}
                    {at >= 0 && (
                      <span className="insp-pick-num" aria-hidden="true">
                        {at + 1}
                      </span>
                    )}
                    <span className="ellipsis">{labels.get(a.id)?.name}</span>
                    {/* Another image has this name: its ID, on a line of its own, tells them apart. */}
                    {labels.get(a.id)?.label !== labels.get(a.id)?.name && <span className="ellipsis insp-pick-id">{a.id}</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="faint insp-note">{`No images ${series.key ? `in ${series.label} ` : ''}match “${q.trim()}”.`}</p>
          )}
          {samples.length > 0 && (
            <SwitchRow
              checked={replace}
              onChange={(v) => !busy && setReplace(v)}
              label={samples.length === 1 ? 'Replace the sample image' : `Replace the ${samples.length} sample images`}
              hint={replace ? 'Rows you have changed are kept.' : 'The samples stay, and your images go after them.'}
            />
          )}
          {chosen.length > 0 && (
            <div className="field">
              <div className="field-label" id={orderId}>
                <span className="grow">Order</span>
                <span className="insp-count">{Number.isFinite(room) ? `${chosen.length} / ${room}` : chosen.length}</span>
              </div>
              <ol className="insp-pick-order" aria-labelledby={orderId}>
                {chosen.map((id, i) => (
                  <li key={id}>
                    <span className="insp-pick-order-thumb" aria-hidden="true">
                      {devUrl ? <AssetImage key={missingKey(snapshot, id)} asset={assets[id]} devUrl={devUrl} cover alt="" loading="lazy" /> : <ImageOff />}
                    </span>
                    <span className="ellipsis grow" title={nameOf(id)}>
                      {nameOf(id)}
                    </span>
                    <button className="icon-btn sm" aria-label={`Move ${nameOf(id)} up`} disabled={i === 0} aria-disabled={busy ? true : undefined} onClick={() => choose(movePick(chosen, id, 'up'))}>
                      <ArrowUp />
                    </button>
                    <button className="icon-btn sm" aria-label={`Move ${nameOf(id)} down`} disabled={i === chosen.length - 1} aria-disabled={busy ? true : undefined} onClick={() => choose(movePick(chosen, id, 'down'))}>
                      <ArrowDown />
                    </button>
                    <button className="icon-btn sm" aria-label={`Leave out ${nameOf(id)}`} aria-disabled={busy ? true : undefined} onClick={() => choose(chosen.filter((x) => x !== id))}>
                      <X />
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {over && (
            <p className="field-warning insp-note" id={overId}>
              {over}
            </p>
          )}
          <p className={gone || notice ? 'field-warning insp-note' : 'sr-only'} role="status">
            {gone ? `${gone === 1 ? 'An image you chose was' : `${gone} images you chose were`} removed from Assets.` : notice}
          </p>
          <div className="insp-pick-tools">
            <button className="btn btn-sm btn-primary" aria-disabled={!chosen.length || !!over || busy ? true : undefined} aria-describedby={over ? overId : undefined} onClick={() => void add()}>
              {busy ? 'Adding…' : chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? 'image' : 'images'}` : 'Add images'}
            </button>
            <button className="btn btn-sm" aria-disabled={busy ? true : undefined} onClick={close}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
