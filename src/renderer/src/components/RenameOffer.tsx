import { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { applyOps, getState, setState, useStore } from '../store';
import { renameLabels } from '../lib/page-navigation';
import { handOffNoticeFocus } from './ui';
import './RenameOffer.css';

/**
 * After the author renames a page: the labels visitors read that still say its old name (its heading, its menu
 * links), each with a checkbox, to update together or keep. It stays until the author answers, and goes by itself once
 * nothing is left to offer (the labels were changed another way, the rename was undone, the page is gone). It shows
 * with the notifications, so it is there whichever panel the rename came from, and it never takes focus.
 */
export function RenameOffer() {
  const offer = useStore((s) => s.renameOffer);
  const snap = useStore((s) => s.snapshot);
  // The author's ticks, by label: a label not in here keeps its preselection.
  const [ticks, setTicks] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [busy, setBusy] = useState(false);
  // The card while focus is in it: answered (or gone by itself) then, focus goes on to the next notice, or back where
  // it came from, never dropping onto the page.
  const focusedCard = useRef<HTMLElement | null>(null);
  useEffect(() => setTicks(new Map()), [offer]);
  // The project as the rename left it, or later: an older snapshot has not caught up with it yet.
  const arrived = !!offer && snap?.workspaceKey === offer.opening && snap.revision >= offer.revision;
  const page = arrived && Object.hasOwn(snap!.state.pages, offer!.pageId) ? snap!.state.pages[offer!.pageId] : undefined;
  const live = !!page && page.title === offer?.to;
  const found = useMemo(() => (offer && snap && live ? renameLabels(snap.state, offer.pageId, offer.also ? [offer.from, offer.also] : offer.from) : []), [offer, snap, live]);
  // Once the project shows the rename, the offer lasts while it has something to offer and the page keeps that name: a
  // label written later with the old name is the author's own, and a page renamed again (or the rename undone) has
  // moved on, so neither brings this card back.
  useEffect(() => {
    if (offer && arrived && !(live && found.length) && getState().renameOffer === offer) setState({ renameOffer: null });
  }, [offer, arrived, live, found.length]);
  const visible = !!(offer && snap && page && found.length);
  useEffect(() => {
    const el = focusedCard.current;
    if (visible || !el) return;
    focusedCard.current = null;
    if (!document.activeElement || document.activeElement === document.body) handOffNoticeFocus(el);
  }, [visible]);
  if (!offer || !snap || !page || !found.length) return null;
  const ticked = (key: string, preselect: boolean) => ticks.get(key) ?? preselect;
  const picked = found.filter((l) => ticked(l.key, l.preselect));
  // Labels in the same place (a page linked again and again from the footer) cannot be told apart, so they are one
  // choice: "Footer links (6)", ticked when all of them are.
  const byPlace = new Map<string, typeof found>();
  for (const l of found) byPlace.set(l.where, [...(byPlace.get(l.where) ?? []), l]);
  const places = [...byPlace].map(([where, labels]) => ({ where, labels }));
  const update = async () => {
    setBusy(true);
    // Against the project these labels were read from: one that has changed since shows its labels again.
    const r = await applyOps(picked.map((l) => l.op), picked.length === 1 ? 'Update label to match page title' : 'Update labels to match page title', undefined, snap.revision);
    setBusy(false);
    if (r && getState().renameOffer === offer) setState({ renameOffer: null });
  };
  const id = `rename-offer-${offer.pageId}`;
  const one = found.length === 1;
  return (
    <div
      className="toast rename-offer"
      role="group"
      aria-labelledby={`${id}-title`}
      onFocus={(e) => (focusedCard.current = e.currentTarget)}
      onBlur={(e) => {
        // Moving out of the card on purpose; a button removed under focus moves nowhere.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) focusedCard.current = null;
      }}
      // An answer that arrived from another notice by Enter never takes that key's repeats.
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.repeat) e.preventDefault();
      }}
    >
      <Pencil />
      <div className="grow rename-offer-body">
        <span className="rename-offer-title" id={`${id}-title`}>
          {one ? 'Update the label' : 'Update labels'} to “{offer.to}”?
        </span>
        <span className="rename-offer-why" role="status">{`The page was renamed, but ${one ? 'this still says' : 'these still say'} ${[...new Set(found.map((l) => `“${l.text}”`))].join(' or ')}:`}</span>
        <ul className="rename-offer-list">
          {places.map(({ where, labels }) => {
            const count = labels.filter((l) => ticked(l.key, l.preselect)).length;
            return (
              <li key={where}>
                <label>
                  <input
                    type="checkbox"
                    checked={count === labels.length}
                    // Some of the place's labels, not all: shown as mixed, and a click ticks them all.
                    ref={(box) => void (box && (box.indeterminate = count > 0 && count < labels.length))}
                    disabled={busy}
                    onChange={(e) => {
                      const next = new Map(ticks);
                      for (const l of labels) next.set(l.key, e.target.checked);
                      setTicks(next);
                    }}
                  />
                  {labels.length > 1 ? `${where}s (${labels.length})` : where}
                </label>
              </li>
            );
          })}
        </ul>
        <span className="rename-offer-note">The address stays {page.route}, so links already shared keep working.</span>
        <span className="notice-later">Answer once this dialog is closed.</span>
        <span className="rename-offer-actions">
          <button className="btn btn-sm btn-primary" disabled={!picked.length || busy} onClick={() => void update()}>
            {picked.length > 1 ? `Update ${picked.length} labels` : 'Update label'}
          </button>
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setState({ renameOffer: null })}>
            Keep as they are
          </button>
        </span>
      </div>
    </div>
  );
}
