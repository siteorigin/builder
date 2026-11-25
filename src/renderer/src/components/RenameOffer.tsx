import { useEffect, useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { applyOps, getState, setState, useStore } from '../store';
import { renameLabels } from '../lib/page-navigation';
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
  if (!offer || !snap || !page || !found.length) return null;
  const ticked = (key: string, preselect: boolean) => ticks.get(key) ?? preselect;
  const picked = found.filter((l) => ticked(l.key, l.preselect));
  const update = async () => {
    setBusy(true);
    // Against the project these labels were read from: one that has changed since shows its labels again.
    const r = await applyOps(picked.map((l) => l.op), picked.length === 1 ? 'Update label to match page title' : 'Update labels to match page title', undefined, snap.revision);
    setBusy(false);
    if (r && getState().renameOffer === offer) setState({ renameOffer: null });
  };
  const id = `rename-offer-${offer.pageId}`;
  return (
    <div className="toast rename-offer" role="group" aria-labelledby={`${id}-title`}>
      <Pencil />
      <div className="grow rename-offer-body">
        <span className="rename-offer-title" id={`${id}-title`}>
          Renamed to “{offer.to}”
        </span>
        <span role="status">{`${found.length === 1 ? 'This still says' : 'These still say'} ${[...new Set(found.map((l) => `“${l.text}”`))].join(' or ')}:`}</span>
        <ul className="rename-offer-list">
          {found.map((l) => (
            <li key={l.key}>
              <label>
                <input type="checkbox" checked={ticked(l.key, l.preselect)} disabled={busy} onChange={(e) => setTicks(new Map(ticks).set(l.key, e.target.checked))} />
                {l.where}
              </label>
            </li>
          ))}
        </ul>
        <span className="rename-offer-note">The address stays {page.route}, so links already shared keep working.</span>
        <span className="rename-offer-actions">
          <button className="btn btn-sm btn-ghost" disabled={!picked.length || busy} onClick={() => void update()}>
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
