import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Camera, ChevronRight, CircleAlert, CircleCheck } from 'lucide-react';
import type { ProjectState } from '@shared/types';
import { DEFAULT_REVIEW_WIDTHS, reviewPages, type ReviewEditionManifest } from '@shared/review-edition';
import { publishedState } from '@generator/index';
import { api, getState } from '../store';
import { Spinner } from '../components/ui';
import { settleEdits } from '../lib/leave';
import { afterEditsSettle } from '../lib/pending';

/** What the review section is doing: picturing pages, or saving an edition as one file. */
export type ReviewBusy = 'capture' | 'save';

type Outcome = { ok: boolean; message: string; path?: string; editionId?: string };

const WIDTHS_SAID = DEFAULT_REVIEW_WIDTHS.map((w) => `${w.label} · ${w.width} px`).join(' and ');

/** When an edition was made: the time today, or the date and time on an earlier day. */
function madeAt(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `Today, ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}, ${time}`;
}

function editionSummary(m: ReviewEditionManifest): string {
  const pages = `${m.routes.length} ${m.routes.length === 1 ? 'page' : 'pages'}`;
  const taken = m.captures.filter((c) => c.status === 'captured').length;
  const shots = m.captures.length === taken ? `${taken} ${taken === 1 ? 'picture' : 'pictures'}` : `${taken} of ${m.captures.length} pictures taken`;
  return `${pages} · ${shots}`;
}

/**
 * Client review pages in the Export dialog (#1133, #1134): pictures of chosen pages at a desktop and a phone width,
 * kept in the project as a dated edition, and any edition saved as one HTML file a client opens from Downloads with no
 * Builder, server or network. Folded until opened, so the dialog's exports stay first. Capturing builds the website, so
 * it waits on what stops an export (`blocked`); saving an edition only reads the project and is always offered.
 */
export function ClientReview({ state, workspaceKey, blocked, otherBusy, busy, onBusy }: { state: ProjectState; workspaceKey: string | undefined; blocked: boolean; otherBusy: boolean; busy: ReviewBusy | null; onBusy: (b: ReviewBusy | null) => void }) {
  const bodyId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const pages = useMemo(() => reviewPages(publishedState(state)), [state]);
  const [chosen, setChosen] = useState<string[]>(() => [pages.find((p) => p.route === '/')?.route ?? pages[0]?.route].filter((r): r is string => !!r));
  const [editions, setEditions] = useState<ReviewEditionManifest[] | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  // An answer for a project no longer open is never shown.
  const key = useRef(workspaceKey);
  key.current = workspaceKey;
  // Only the latest listing asked for is shown: a slow first one never replaces the one after a capture.
  const asked = useRef(0);
  const load = async (opening = workspaceKey) => {
    const n = ++asked.current;
    const list = await api.project.reviewEditions().catch(() => [] as ReviewEditionManifest[]);
    if (key.current === opening && n === asked.current) setEditions(Array.isArray(list) ? list : []);
  };
  useEffect(() => {
    setEditions(null);
    setOutcome(null);
    if (open) void load();
  }, [open, workspaceKey]);
  // Pages that went away (unpublished, renamed) are no longer chosen, even if another page takes the address later.
  const picked = chosen.filter((r) => pages.some((p) => p.route === r));
  useEffect(() => {
    if (picked.length !== chosen.length) setChosen(picked);
  }, [pages]);
  const anyBusy = otherBusy || !!busy;
  // Where focus goes once the work ends (the dialog unlocks then): the outcome to read, or the button that was used.
  const settle = useRef<'outcome' | HTMLButtonElement | null>(null);
  useEffect(() => {
    if (busy || !settle.current) return;
    const target = settle.current === 'outcome' ? outcomeRef.current : settle.current;
    settle.current = null;
    target?.focus();
  }, [busy, outcome]);
  const say = (o: Outcome) => {
    settle.current = 'outcome';
    setOutcome(o);
  };

  const capture = async () => {
    if (anyBusy || blocked || !picked.length) return;
    const opening = workspaceKey;
    onBusy('capture');
    setOutcome(null);
    try {
      const started = await afterEditsSettle(
        () => settleEdits(),
        async () => {
          const now = getState().snapshot;
          if (!now || now.workspaceKey !== opening) return null;
          // The saved edits may have taken a chosen page away: nothing is captured that the list no longer shows.
          const live = reviewPages(publishedState(now.state));
          const lost = picked.find((r) => !live.some((p) => p.route === r));
          if (lost) return { ok: false as const, message: `The website no longer has a page at ${lost}. Check the pages to capture, then capture again.` };
          return await api.project.captureReviewEdition({ routes: picked });
        }
      );
      if (key.current !== opening) return;
      if (!started.ok) return say({ ok: false, message: `The pages were not captured, because a change isn’t saved yet. ${started.problems.join(' ')}` });
      const r = started.value;
      if (!r) return;
      if (!r.ok) return say({ ok: false, message: r.message });
      await load(opening);
      say({ ok: true, message: r.message, editionId: r.edition.editionId });
    } catch (e) {
      say({ ok: false, message: `The pages were not captured: ${(e as Error).message}` });
    } finally {
      onBusy(null);
    }
  };

  const save = async (id: string, button: HTMLButtonElement) => {
    if (anyBusy) return;
    const opening = workspaceKey;
    onBusy('save');
    try {
      const r = await api.project.exportReviewSheet(id);
      if (key.current !== opening) return;
      if (r.ok) say({ ok: true, message: r.message, path: r.path, editionId: id });
      else if (r.message) say({ ok: false, message: r.message, editionId: id });
      // The chooser was closed: back where the author was.
      else settle.current = button;
    } catch (e) {
      say({ ok: false, message: `The review pages were not saved: ${(e as Error).message}` });
    } finally {
      onBusy(null);
    }
  };

  return (
    <section className="client-review" aria-labelledby={`${bodyId}-title`}>
      <h3 className="client-review-title" id={`${bodyId}-title`}>
        {/* Kept open while it works, so its progress and outcome stay where the author is reading. */}
        <button type="button" className="btn btn-sm btn-ghost client-review-toggle" aria-expanded={open} aria-controls={bodyId} aria-disabled={(open && !!busy) || undefined} onClick={() => !(open && busy) && setOpen(!open)}>
          <ChevronRight size={14} aria-hidden /> Client review pages
        </button>
      </h3>
      <div className="client-review-body" id={bodyId} hidden={!open}>
        <p className="client-review-intro">Picture chosen pages at {WIDTHS_SAID}, then save them as one file a client can open without SiteOrigin Builder or the internet. Links, menus and forms need a live preview.</p>
        {open && (
          <>
            <fieldset className="client-review-pages" disabled={anyBusy}>
              <legend>Pages to capture</legend>
              {pages.length === 0 ? (
                <p className="client-review-empty">The website has no published pages to capture.</p>
              ) : (
                <ul id={listId}>
                  {pages.map((p) => (
                    <li key={p.route}>
                      <label>
                        <input type="checkbox" checked={picked.includes(p.route)} onChange={(e) => setChosen(e.target.checked ? [...picked, p.route] : picked.filter((r) => r !== p.route))} />
                        <span className="grow">{p.title || p.route}</span>
                        <span className="client-review-route">{p.route}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <div className="client-review-actions">
              <button type="button" className="btn btn-sm" aria-disabled={anyBusy || blocked || !picked.length || undefined} onClick={() => void capture()}>
                <Camera size={13} aria-hidden /> {picked.length > 1 ? `Capture ${picked.length} pages` : 'Capture page'}
              </button>
              <span className="client-review-hint" role="status">
                {busy === 'capture' ? (
                  <>
                    <Spinner decorative /> Building the website and picturing each page…
                  </>
                ) : busy === 'save' ? (
                  <>
                    <Spinner decorative /> Saving the review pages…
                  </>
                ) : blocked ? (
                  'Capturing waits until the website can be exported. Earlier editions can still be saved.'
                ) : !picked.length ? (
                  'Choose at least one page.'
                ) : (
                  ''
                )}
              </span>
            </div>
            {outcome && (
              <div ref={outcomeRef} tabIndex={-1} className={`scope-note ${outcome.ok ? 'shared' : 'danger'} client-review-outcome`} role={outcome.ok ? 'status' : 'alert'}>
                {outcome.ok ? <CircleCheck /> : <CircleAlert />}
                <span className="export-note-body">
                  <strong>{outcome.message}</strong>
                  {outcome.path && <span className="client-review-path">{outcome.path}</span>}
                  {outcome.path && (
                    <span>
                      <button type="button" className="btn btn-sm" onClick={() => void api.projects.reveal(outcome.path!)}>
                        Show in folder
                      </button>
                    </span>
                  )}
                </span>
              </div>
            )}
            <div className="client-review-editions">
              <h4>Captured editions</h4>
              {editions === null ? (
                <p className="client-review-empty">Loading…</p>
              ) : editions.length === 0 ? (
                <p className="client-review-empty">No pages captured yet.</p>
              ) : (
                <ul>
                  {editions.map((m) => (
                    <li key={m.editionId} className={outcome?.editionId === m.editionId ? 'is-latest' : undefined}>
                      <span className="grow">
                        <strong>
                          <time dateTime={m.createdAt}>{madeAt(m.createdAt)}</time>
                        </strong>
                        <span>{editionSummary(m)}</span>
                        <code>{m.editionId}</code>
                      </span>
                      <button type="button" className="btn btn-sm" aria-disabled={anyBusy || undefined} aria-label={`Save as one file: the edition of ${madeAt(m.createdAt)}, ${m.editionId}`} onClick={(e) => void save(m.editionId, e.currentTarget)}>
                        Save as one file
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
