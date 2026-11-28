import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { ArrowDown, ArrowUp, ImageOff, TriangleAlert, X } from 'lucide-react';
import type { ListItem, ListProp, ProjectState } from '@shared/types';
import { copiesWrong } from '@shared/api';
import { setState, useStore } from '../store';
import { SwitchRow } from '../components/ui';
import { AssetImage } from '../components/AssetImage';
import { WindowedGrid, type WindowedGridApi } from '../components/WindowedGrid';
import { fitFor } from '../components/AssetPicture';
import { AssetOrderControls, shortName, useAssetSeries } from '../components/AssetOrder';
import { assetLabels, inSeries, sortAssets } from '@shared/asset-order';
import { isImeComposing } from '../lib/ime';
import { mergeChoice, movePick, overNote, pickRoom, sampleRows, startingSamples, togglePick } from '../lib/gallery-picks';

/**
 * Changes when a picture's files go missing, are damaged or come back, so a preview that gave up on a file tries it
 * again: by the files themselves, since one copy repaired as another is damaged leaves the count the same.
 */
export const missingKey = (snapshot: { missingAssets: Array<{ assetId: string; original: boolean; variants: string[] }> } | null | undefined, id: string) => {
  const gone = snapshot?.missingAssets.find((m) => m.assetId === id);
  return gone ? `missing-${gone.original}-${gone.variants.join('|')}` : 'present';
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
 * As pickGridKeys, for a picker grid that draws only the rows near its view (WindowedGrid, #973): the option focused is
 * found by its place in the list (its aria-posinset), and the one moved to is put in the page first when it is out of
 * view. Up and Down move `down` options (a row; 1 where the options are read one at a time). `modifiers`: a key held
 * with Alt, Command or Control is left alone.
 */
export function windowedPickKeys(e: ReactKeyboardEvent<HTMLDivElement>, count: number, down: number, api: RefObject<WindowedGridApi | null>, onMove?: (to: number) => void, modifiers = false) {
  const at = document.activeElement;
  const i = at instanceof HTMLElement && at.matches('[role="option"]') && e.currentTarget.contains(at) ? Number(at.getAttribute('aria-posinset')) - 1 : -1;
  if (!(i >= 0) || (modifiers && (e.altKey || e.metaKey || e.ctrlKey))) return;
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: down, ArrowUp: -down }[e.key];
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : step !== undefined ? Math.max(0, Math.min(count - 1, i + step)) : -1;
  if (to < 0) return;
  e.preventDefault();
  onMove?.(to);
  api.current?.reveal(to);
  e.currentTarget.querySelector<HTMLElement>(`[role="option"][aria-posinset="${to + 1}"]`)?.focus();
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
  // What the last change to the order did, said to screen readers.
  const [said, setSaid] = useState('');
  // Where focus goes once the order is drawn again: the same control on the row moved, or the next row's.
  const refocus = useRef<{ id: string; control: 'up' | 'down' | 'out' } | null>(null);
  const orderRef = useRef<HTMLOListElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const fixBtn = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const orderId = useId();
  const overId = useId();
  const brokenId = useId();
  const alive = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    // The picker comes into view from its heading, so the images show and not only the fields above it.
    root.current?.scrollIntoView({ block: 'start' });
    // Focus starts on the search, else the first image, else the way to Assets: once, when the picker opens, so a
    // grid drawn again later never takes focus from what the author is typing in.
    root.current?.querySelector<HTMLElement>('input[type="search"], .insp-pick-tile, .btn')?.focus({ preventScroll: true });
    return () => {
      alive.current = false;
    };
  }, []);
  const needle = q.trim().toLowerCase();
  // The ID a same-named image shows is searchable too.
  const shown = images.filter((a) => (!series.key || inSeries(a, series.key)) && (!needle || `${a.name} ${a.id} ${a.description ?? ''} ${a.altSuggestion ?? ''}`.toLowerCase().includes(needle)));
  const full = chosen.length >= room;
  // As Replace everywhere: a picture with any of its files gone can't go into a gallery until it is repaired in Assets.
  const damageOf = (id: string): 'original' | 'copies' | null => {
    const m = snapshot?.missingAssets.find((x) => x.assetId === id);
    return m ? (m.original ? 'original' : 'copies') : null;
  };
  // Whether the copies at fault are missing or there but damaged.
  const copiesOf = (id: string) => {
    const m = snapshot?.missingAssets.find((x) => x.assetId === id);
    return m ? copiesWrong(m) : 'missing';
  };
  const lost = (id: string) => !!damageOf(id);
  // A chosen image with missing files stops Add: said beside Add as soon as it is known, not only when Add is pressed.
  const broken = chosen.filter(lost);
  // The grid's one Tab stop: the tile used last, while it is still shown.
  const [activeTile, setActiveTile] = useState<string | null>(null);
  const roving = shown.some((a) => a.id === activeTile) ? activeTile : (shown[0]?.id ?? null);
  // The grid draws only the rows in and near its view (#973), and always the Tab stop's.
  const gridApi = useRef<WindowedGridApi | null>(null);
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
    if (busy || !chosen.length || over || broken.length) return;
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
  const move = (id: string, direction: 'up' | 'down') => {
    const i = chosen.indexOf(id);
    const to = direction === 'up' ? i - 1 : i + 1;
    if (busy || i < 0 || to < 0 || to >= chosen.length) return;
    refocus.current = { id, control: direction };
    choose(movePick(chosen, id, direction));
    setSaid(`${nameOf(id)} is now ${to + 1} of ${chosen.length}.`);
  };
  const leaveOut = (id: string) => {
    if (busy) return;
    const i = chosen.indexOf(id);
    refocus.current = { id: chosen[i + 1] ?? chosen[i - 1] ?? '', control: 'out' };
    choose(chosen.filter((x) => x !== id));
    setSaid(`${nameOf(id)} left out.`);
  };
  // Every chosen image with missing files left out at once, from the foot; focus goes to Add, which now works.
  const leaveBroken = () => {
    if (busy || !broken.length) return;
    const kept = chosen.filter((x) => !lost(x));
    choose(kept);
    setSaid(broken.length === 1 ? `${nameOf(broken[0])} left out.` : `${broken.length} images left out.`);
    // To Add when something is left to add; otherwise back to choosing.
    requestAnimationFrame(() => (kept.length ? addBtn.current : root.current?.querySelector<HTMLElement>('input[type="search"], .insp-pick-tile[tabindex="0"]'))?.focus());
  };
  useEffect(() => {
    const want = refocus.current;
    if (!want) return;
    refocus.current = null;
    const row = want.id ? orderRef.current?.querySelector<HTMLElement>(`li[data-pick="${CSS.escape(want.id)}"]`) : null;
    // A move button that can go no further hands focus to the other one, so it never drops to the page.
    const order = want.control === 'up' ? ['up', 'down', 'out'] : want.control === 'down' ? ['down', 'up', 'out'] : ['out'];
    for (const c of order) {
      const b = row?.querySelector<HTMLButtonElement>(`[data-control="${c}"]`);
      if (b && !b.disabled) return b.focus();
    }
    root.current?.querySelector<HTMLElement>('.insp-pick-tile[tabindex="0"], input[type="search"]')?.focus();
  }, [chosenRaw]);
  // The grid gives up some height once there is a choice, so the order shows: the tile in use stays in view.
  const hasChoice = chosen.length > 0;
  useEffect(() => {
    const at = document.activeElement;
    if (hasChoice && at instanceof HTMLElement && at.closest('.insp-pick-grid')) at.scrollIntoView({ block: 'nearest' });
  }, [hasChoice]);
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
  const alt = mac ? '⌥' : 'Alt+';
  const left = Number.isFinite(room) ? room - chosen.length : Infinity;
  return (
    <div
      ref={root}
      className={`insp-pick insp-pick-many${chosen.length ? ' has-choice' : ''}${broken.length ? ' has-broken' : ''}`}
      role="group"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || isImeComposing(e)) return;
        e.stopPropagation();
        // Escape while a search has words in it clears the search, wherever focus is in the picker, and keeps the
        // choice; the next Escape closes.
        if (q) {
          e.preventDefault();
          setQ('');
          root.current?.querySelector<HTMLElement>('input[type="search"]')?.focus();
          return;
        }
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
          <p className="faint insp-note">{Number.isFinite(room) && room > 0 ? `Choose up to ${room} ${room === 1 ? 'image' : 'images'} in the order you want them, then check the order below.` : 'Choose images in the order you want them, then check the order below.'}</p>
          {(images.length > 6 || q) && (
            <div className="insp-pick-tools">
              <input type="search" className="input sm grow" placeholder="Search images" aria-label="Search images" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          {/* Kept while a series is chosen, so it can always be cleared. */}
          {(images.length > 6 || !!series.key) && <AssetOrderControls series={series.list} value={series.key} onSeries={series.choose} />}
          {shown.length > 0 ? (
            // Drawn afresh for each search, series and order, so the first image shown is the grid's tab stop again.
            <WindowedGrid
              key={JSON.stringify([needle, series.key, assetSort])}
              api={gridApi}
              className="insp-pick-grid"
              role="listbox"
              aria-multiselectable="true"
              aria-label="Your images"
              aria-describedby={over ? overId : undefined}
              // A listbox moves one option at a time, Up and Left back, Down and Right on, in the order the names are read.
              onKeyDown={(e) => windowedPickKeys(e, shown.length, 1, gridApi, (to) => setActiveTile(shown[to]?.id ?? null), true)}
              count={shown.length}
              keep={[shown.findIndex((a) => a.id === roving)]}
              tile={(i) => {
                const a = shown[i];
                const at = chosen.indexOf(a.id);
                // A file can go missing after it was chosen: the tile keeps saying so, and Add stops for it.
                const missing = lost(a.id);
                const blocked = (at < 0 && full) || (at < 0 && missing);
                const label = labels.get(a.id)?.label ?? a.name;
                const hurt = damageOf(a.id);
                const what = hurt === 'copies' ? `some of its smaller copies are ${copiesOf(a.id)}` : 'its file is missing';
                const why = missing ? (at >= 0 ? `${what}, so leave it out or repair it in Assets` : `${what}, so repair it in Assets first`) : blocked ? 'the gallery has no room for more images' : '';
                // Logos and extreme shapes are shown whole, as Assets shows them.
                const whole = fitFor(a).contain;
                return (
                  <button
                    key={a.id}
                    role="option"
                    aria-selected={at >= 0}
                    aria-disabled={blocked || busy ? true : undefined}
                    aria-label={`${label}${at >= 0 ? `, number ${at + 1}` : ''}${why ? `: ${why}` : ''}`}
                    aria-posinset={i + 1}
                    aria-setsize={shown.length}
                    tabIndex={a.id === roving ? 0 : -1}
                    onFocus={() => setActiveTile(a.id)}
                    className={`insp-pick-tile${at >= 0 ? ' current' : ''}${missing ? ' missing' : ''}`}
                    title={why ? `${label}: ${why}` : label}
                    onClick={() => (at >= 0 || !missing) && choose(togglePick(chosen, a.id, room))}
                  >
                    {/* A picture whose file is gone is an empty frame, as in Assets and the order, never a faded memory of it. */}
                    {hurt === 'original' || !devUrl ? (
                      <span className="insp-pick-frame" aria-hidden="true">
                        <ImageOff />
                      </span>
                    ) : (
                      <AssetImage key={missingKey(snapshot, a.id)} asset={a} devUrl={devUrl} cover={!whole} className={whole ? 'contain' : undefined} alt="" loading="lazy" />
                    )}
                    {at >= 0 && (
                      <span className="insp-pick-num" aria-hidden="true">
                        {at + 1}
                      </span>
                    )}
                    <span className="insp-pick-name" aria-hidden="true">
                      {shortName(labels.get(a.id)?.name ?? '', 22)}
                    </span>
                    {/* Another image has this name: its ID, on a line of its own, tells them apart. */}
                    {labels.get(a.id)?.label !== labels.get(a.id)?.name && <span className="ellipsis insp-pick-id">{a.id}</span>}
                    {/* What is wrong, in words under the name, the same chip as in the order: never over the picture. */}
                    {missing && (
                      <span className="insp-pick-gone" aria-hidden="true">
                        {/* One word on a tile; the picture or the empty frame says which, and the order row says it in full. */}
                        <TriangleAlert /> Missing
                      </span>
                    )}
                  </button>
                );
              }}
            />
          ) : (
            <div className="insp-pick-nomatch">
              <p className="faint insp-note">{`No images ${series.key ? `in ${series.label} ` : ''}match “${q.trim()}”.`}</p>
              {needle && (
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setQ('');
                    root.current?.querySelector<HTMLElement>('input[type="search"]')?.focus();
                  }}
                >
                  Clear search
                </button>
              )}
            </div>
          )}
          <p className={(needle || series.key) && shown.length ? 'faint insp-note insp-pick-result' : 'sr-only'} role="status">
            {needle || series.key ? `${shown.length} of ${images.length} ${images.length === 1 ? 'image' : 'images'}${series.key ? ` · ${series.label}` : ''}` : ''}
          </p>
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
                <span className="insp-count">{chosen.length} chosen</span>
              </div>
              {/* Shown on keyboard focus only: a long order is three stops a row, and this goes straight past it to Add. */}
              <button type="button" className="btn btn-sm insp-pick-skip" onClick={() => (broken.length ? fixBtn.current : addBtn.current)?.focus()}>
                {broken.length ? 'Skip to missing files' : 'Skip to Add'}
              </button>
              <ol
                ref={orderRef}
                className="insp-pick-order"
                aria-labelledby={orderId}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                  const id = (e.target as HTMLElement).closest<HTMLElement>('li[data-pick]')?.dataset.pick;
                  if (!id) return;
                  e.preventDefault();
                  move(id, e.key === 'ArrowUp' ? 'up' : 'down');
                }}
              >
                {chosen.map((id, i) => (
                  <li key={id} data-pick={id} className={lost(id) ? 'missing' : undefined}>
                    <span className="insp-pick-order-num" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="insp-pick-order-thumb" aria-hidden="true">
                      {damageOf(id) === 'original' || !devUrl ? <ImageOff /> : <AssetImage key={missingKey(snapshot, id)} asset={assets[id]} devUrl={devUrl} cover={!fitFor(assets[id]).contain} className={fitFor(assets[id]).contain ? 'contain' : undefined} alt="" loading="lazy" />}
                    </span>
                    {/* The whole name, wrapped, since the author checks the order by it; what is wrong goes under it in words. */}
                    <span className="insp-pick-order-name grow">
                      <span>{nameOf(id)}</span>
                      {lost(id) && (
                        <span className="insp-pick-order-miss">
                          <TriangleAlert aria-hidden="true" /> {damageOf(id) === 'copies' ? `Copy ${copiesOf(id)}` : 'Missing'}
                        </span>
                      )}
                    </span>
                    <span className="insp-pick-order-acts">
                      <button className="icon-btn sm" data-control="up" aria-label={`Move ${nameOf(id)} up`} aria-keyshortcuts="Alt+ArrowUp" title={`Move up (${alt}↑)`} disabled={i === 0} aria-disabled={busy ? true : undefined} onClick={() => move(id, 'up')}>
                        <ArrowUp />
                      </button>
                      <button className="icon-btn sm" data-control="down" aria-label={`Move ${nameOf(id)} down`} aria-keyshortcuts="Alt+ArrowDown" title={`Move down (${alt}↓)`} disabled={i === chosen.length - 1} aria-disabled={busy ? true : undefined} onClick={() => move(id, 'down')}>
                        <ArrowDown />
                      </button>
                      <button className="icon-btn sm" data-control="out" aria-label={`Leave out ${nameOf(id)}`} title="Leave out" aria-disabled={busy ? true : undefined} onClick={() => leaveOut(id)}>
                        <X />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
              {!replacing && items.length > 0 && (
                <p className="faint insp-note">
                  {chosen.length === 1 ? 'It goes' : 'They go'} {items.length === 1 ? 'after the image already in this gallery.' : `after the ${items.length} images already in this gallery.`}
                </p>
              )}
            </div>
          )}
          <p className="sr-only" role="status">
            {said}
          </p>
          {/* The foot stays in view however long the choice gets: what stops Add, then Add, Cancel and the room left. */}
          <div className="insp-pick-foot">
            {over && (
              <p className="field-error" id={overId}>
                {over}
              </p>
            )}
            {/* What stops Add, with the way past it right there: the rows it names may be scrolled under this foot. */}
            {broken.length > 0 && (
              <div className="insp-pick-fix">
                <p className="field-error" id={brokenId}>
                  {broken.length === 1 ? `${nameOf(broken[0])} has missing files.` : `${broken.length} images you chose have missing files.`} Repair {broken.length === 1 ? 'it' : 'them'} in Assets, or leave {broken.length === 1 ? 'it' : 'them'} out.
                </p>
                <button ref={fixBtn} type="button" className="btn btn-sm" aria-disabled={busy ? true : undefined} onClick={leaveBroken}>
                  {broken.length === 1 ? 'Leave it out' : `Leave ${broken.length} out`}
                </button>
              </div>
            )}
            <p className={gone || notice ? 'field-error' : 'sr-only'} role="status">
              {gone ? `${gone === 1 ? 'An image you chose was' : `${gone} images you chose were`} removed from Assets.` : notice}
            </p>
            <div className="insp-pick-tools">
              <button ref={addBtn} className="btn btn-sm btn-primary" aria-disabled={!chosen.length || !!over || broken.length > 0 || busy ? true : undefined} aria-describedby={[over ? overId : '', broken.length ? brokenId : ''].filter(Boolean).join(' ') || undefined} onClick={() => void add()}>
                {busy ? 'Adding…' : chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? 'image' : 'images'}` : 'Add images'}
              </button>
              <button className="btn btn-sm" aria-disabled={busy ? true : undefined} onClick={close}>
                Cancel
              </button>
              {Number.isFinite(left) && <span className="insp-count insp-pick-room">{left > 0 ? `Room for ${left}` : 'Gallery full'}</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
