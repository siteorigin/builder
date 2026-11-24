import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, CircleCheck, Cloud, Copy, FilePen, FolderCode, Globe, TriangleAlert, Upload } from 'lucide-react';
import { describeDraftLink, publicationPlan } from '@generator/checks';
import type { PageDoc } from '@shared/types';
import type { ExportFormat, ExportResult, RecentExport } from '@shared/api';
import { api, editRunStatus, getState, saveLocal, setState, useStore } from '../store';
import { Modal, Segmented, Spinner } from '../components/ui';
import { openAsset } from '../lib/actions';
import { sampleContactMatches, type ContentField, type SampleContactGroup } from '../lib/find-content';
import { openContentMatch } from './FindReplace';

type ExportKind = 'static' | 'source';

const NO_EXPORTS: RecentExport[] = [];
/** More pages than this are counted, with the full lists one click away, so they never push the export choices out of view. */
const LONG_PAGE_LIST = 6;
/** More links to drafts than this are counted, with the list one click away. */
const LONG_LINK_LIST = 3;
/** More notes than this fold into the export's own row, so a success keeps its next step in view. */
const MANY_NOTES = 2;
const UNEXPECTED_FAILURE = 'The export could not be completed.';

/** "Home", "Home and About", "Home, About and Contact". Pages that share a title are told apart by their address. */
function listTitles(pages: PageDoc[], all: PageDoc[]): string {
  const key = (p: PageDoc) => p.title.trim().toLowerCase();
  const titles = pages.map((p) => (all.some((o) => o.id !== p.id && key(o) === key(p)) ? `${p.title} (${p.route})` : p.title));
  return titles.length < 2 ? (titles[0] ?? '') : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

/** When an export finished: the time today, or the date and time on an earlier day. */
function finishedAt(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** A full path that wraps at its separators, with the file or folder it ends in standing out. */
function ExportPath({ path, id }: { path: string; id?: string }) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  return (
    <span className="export-path" id={id}>
      {path
        .slice(0, cut)
        .split(/(?<=[/\\])/)
        .map((part, i) => (
          <Fragment key={i}>
            {part}
            <wbr />
          </Fragment>
        ))}
      <strong>{path.slice(cut)}</strong>
    </span>
  );
}

function PageList({ title, pages }: { title: string; pages: PageDoc[] }) {
  return (
    <div>
      <h3>{title}</h3>
      <ul>
        {pages.map((p) => (
          <li key={p.id}>
            {p.title} <span>{p.route}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the website export publishes and leaves out: named when the list is short, counted when it is long. */
function PagesSummary({ published, drafts }: { published: PageDoc[]; drafts: PageDoc[] }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const all = [...published, ...drafts];
  const long = all.length > LONG_PAGE_LIST;
  return (
    <div className="export-pages" data-testid="export-pages">
      <p>
        <Globe size={14} aria-hidden /> <span>
          <strong>The website publishes {published.length === 1 ? '1 page' : `${published.length} pages`}{long ? '.' : ':'}</strong>{!long && ` ${listTitles(published, all)}.`}
        </span>
      </p>
      {drafts.length > 0 && (
        <p data-testid="export-drafts">
          <FilePen size={14} aria-hidden /> <span>
            <strong>{drafts.length === 1 ? '1 draft is' : `${drafts.length} drafts are`} left out{long ? '.' : ':'}</strong>{!long && ` ${listTitles(drafts, all)}.`} Drafts stay in the editable project. A page hidden from search engines is still published.
          </span>
        </p>
      )}
      {long && (
        <>
          <button type="button" className="btn btn-sm btn-ghost export-pages-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
            <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} /> Review all pages
          </button>
          <div id={listId} className="export-pages-all" hidden={!open}>
            <PageList title="Published" pages={published} />
            {drafts.length > 0 && <PageList title="Left out as drafts" pages={drafts} />}
          </div>
        </>
      )}
    </div>
  );
}

/** "Contact", "Contact and the shared footer": where a sample detail is, by page or shared part, in reading order. */
function placesOf(fields: ContentField[]): string {
  const names = [...new Set(fields.map((f) => (f.owner.kind === 'shell' ? `the shared ${f.owner.id}` : f.where)))];
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Remember the sample details the author keeps on purpose (or, with `keep` false, review again), for this project. */
function keepSamples(values: string[], keep: boolean) {
  const was = getState().keptSamples;
  const next = keep ? [...new Set([...was, ...values])] : was.filter((v) => !values.includes(v));
  setState({ keptSamples: next });
  saveLocal({ keptSamples: next });
}

/**
 * The starter's sample contact details the website would still publish. Visitors who use them reach no one, so they
 * are reviewed before the website goes out, but never stop it: an author may mean to publish one. Each detail can be
 * opened where it is, replaced everywhere at once, or kept, which this project remembers.
 */
function SampleContactReview({ groups, kept, disabled, readOnly, onSettle }: { groups: SampleContactGroup[]; kept: SampleContactGroup[]; disabled: boolean; readOnly: boolean; onSettle: () => void }) {
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!groups.length && !kept.length) return null;
  // The control pressed goes away with its group: focus moves to what took its place, here or in the dialog.
  const settle = (next: string) =>
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const el = rootRef.current?.querySelector<HTMLElement>(next);
      if (el) el.focus();
      else onSettle();
    });
  const keptLine = kept.length > 0 && (
    <p className="export-samples-kept faint" data-testid="export-samples-kept">
      {kept.length === 1 ? `${kept[0].value} is kept as you chose.` : `${kept.length} sample contact details are kept as you chose.`}{' '}
      <button className="link-btn" disabled={disabled} onClick={() => (keepSamples(kept.map((g) => g.value), false), settle('.export-samples-head .btn'))}>
        Review {kept.length === 1 ? 'it' : 'them'} again
      </button>
    </p>
  );
  return (
    <div ref={rootRef} className="export-samples-review">
      {groups.length > 0 && (
        <div className="scope-note site export-samples" data-testid="export-sample-contacts">
          <TriangleAlert />
          <div className="export-note-body">
            <strong>The website still shows sample contact details from the starter.</strong>
            <span>Visitors who use them won’t reach you. Replace them with your own, or keep any you mean to publish.</span>
            <ul className="export-samples-list">
              {groups.map((g) => {
                const listId = `${baseId}-${g.kind}`;
                const nameId = `${listId}-name`;
                const shown = open === g.kind;
                return (
                  <li key={g.kind} data-testid={`export-sample-${g.kind}`}>
                    <div className="export-samples-head">
                      <span className="grow" id={nameId}>
                        <strong>{g.value}</strong>{' '}
                        <span className="faint">
                          · {g.matches.length === 1 ? '1 place' : `${g.matches.length} places`} on {placesOf(g.matches.map((m) => m.field))}
                        </span>
                      </span>
                      <button className="btn btn-sm" disabled={disabled} aria-describedby={nameId} onClick={() => setState({ modal: { kind: 'find', query: g.value, sample: g.kind } })}>
                        Replace everywhere…
                      </button>
                      {/* A read-only project keeps nothing, and exports nothing either. */}
                      <button className="btn btn-sm btn-ghost" disabled={disabled || readOnly} aria-describedby={nameId} onClick={() => (keepSamples([g.value], true), settle('.export-samples-head .btn, .export-samples-kept button'))}>
                        Keep it
                      </button>
                    </div>
                    <button type="button" className="btn btn-sm btn-ghost export-note-toggle" aria-expanded={shown} aria-controls={listId} aria-describedby={nameId} onClick={() => setOpen(shown ? null : g.kind)}>
                      <ChevronRight size={14} style={{ transform: shown ? 'rotate(90deg)' : undefined }} /> Show where
                    </button>
                    <ul className="export-samples-places" id={listId} hidden={!shown}>
                      {g.matches.map((m) => {
                        const f = m.field;
                        const path = f.section === f.where || f.label === f.section || f.label.startsWith(`${f.section} › `) ? f.label : `${f.section} › ${f.label}`;
                        const name = `${f.owner.kind === 'shell' ? `Shared ${f.owner.id}` : f.where} › ${path}`;
                        return (
                          <li key={m.id}>
                            <span className="grow">{name}</span>
                            <button className="btn btn-sm btn-ghost" disabled={disabled} aria-label={`Open ${name} in the inspector`} onClick={() => openContentMatch(f)}>
                              Open
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
      {keptLine}
    </div>
  );
}

/**
 * What a failed build said, for the author to read and copy into a support request. Copying works with the details
 * closed; a clipboard that is unavailable or refuses says so, and the text can still be selected.
 */
function BuildDetails({ text }: { text: string }) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      setCopied('failed');
      setOpen(true);
    }
  };
  return (
    <div className="build-details" data-testid="export-build-details">
      <div className="row wrap" style={{ gap: 6 }}>
        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} /> Technical details
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void copy()}>
          <Copy size={13} /> Copy details
        </button>
        <span className="faint" role="status" style={{ fontSize: 12 }}>
          {copied === 'copied' ? 'Copied to the clipboard.' : copied === 'failed' ? 'Could not copy. Select the details and copy them.' : ''}
        </span>
      </div>
      <div id={bodyId} hidden={!open}>
        <pre tabIndex={0} aria-label="Technical details of the failed build" data-testid="export-build-details-text">
          {text}
        </pre>
      </div>
    </div>
  );
}

export function ExportModal() {
  // A read-only question changes nothing, so exporting goes on while it runs.
  const aiBusy = useStore((s) => !!editRunStatus(s));
  const conflicts = useStore((s) => s.snapshot?.conflicts.length ?? 0);
  // Kept by the project, not this dialog: closing and reopening it still shows what was handed off.
  const recent = useStore((s) => s.snapshot?.recentExports ?? NO_EXPORTS);
  const state = useStore((s) => s.snapshot?.state);
  // What the website export publishes, worked out the way the export itself does.
  const plan = useMemo(() => (state ? publicationPlan(state) : null), [state]);
  const draftLinks = plan?.draftLinks ?? [];
  const draftTargets = new Set(draftLinks.map((l) => l.pageId)).size;
  // The starter's sample contact details the website would publish: reviewed, apart from those kept on purpose.
  const keptValues = useStore((s) => s.keptSamples);
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  const samples = useMemo(() => (state ? sampleContactMatches(state) : []), [state]);
  const samplesToReview = samples.filter((g) => !keptValues.includes(g.value));
  const samplesKept = samples.filter((g) => keptValues.includes(g.value));
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [format, setFormat] = useState<ExportFormat>('folder');
  const linksId = useId();
  const [linksOpen, setLinksOpen] = useState(false);
  const longLinks = draftLinks.length > LONG_LINK_LIST;
  const close = () => !busy && setState({ modal: null });
  const blocked = aiBusy || conflicts > 0;
  // The last report stays until a new one replaces it, so cancelling the save picker on a retry keeps it to copy.
  const shown = !busy && result?.message ? result : null;
  const succeeded = !!shown?.ok;
  const foldNotes = succeeded && shown!.warnings.length > MANY_NOTES && recent[0]?.path === shown!.path;
  const notesId = useId();
  const [notesOpen, setNotesOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstControl = () => rootRef.current?.querySelector<HTMLElement>('button:not(:disabled):not([aria-disabled="true"])');
  // Said once when it changes: a note that simply appears or disappears is not reliably announced.
  const availability = aiBusy ? 'Wait for the AI to finish before exporting.' : conflicts > 0 ? 'A project file changed outside SiteOrigin Builder. Resolve it in Project health before exporting.' : draftLinks.length ? 'The website cannot be exported until its links to drafts are changed. The editable project can still be exported.' : 'Both exports are available.';
  const [announced, setAnnounced] = useState('');
  const lastAvailability = useRef(availability);
  useEffect(() => {
    if (lastAvailability.current !== availability) {
      lastAvailability.current = availability;
      setAnnounced(availability);
    }
    // A control that went away with its blocker leaves focus nowhere.
    if (document.activeElement === document.body) firstControl()?.focus();
  }, [availability, longLinks]);
  const resultRef = useRef<HTMLDivElement>(null);
  const buttons = useRef<Record<ExportKind, HTMLButtonElement | null>>({ static: null, source: null });
  // Where focus goes once the job ends: the result when there is one to read, else back on the button used.
  // Going back to the options lands on the first control, never on a card that would start an export.
  const settle = useRef<ExportKind | 'result' | 'setup' | null>(null);
  useEffect(() => {
    if (busy || !settle.current) return;
    const target = settle.current === 'result' ? resultRef.current : settle.current === 'setup' ? firstControl() : buttons.current[settle.current];
    settle.current = null;
    target?.focus();
  }, [busy, result]);
  const run = async (kind: ExportKind) => {
    if (busy || blocked || (kind === 'static' && draftLinks.length)) return;
    setBusy(kind);
    try {
      // The website is built only if it still publishes the pages listed here.
      const r = kind === 'static' ? await api.project.exportStatic(format, plan?.published.map((p) => p.id)) : await api.project.exportSource(format);
      if (r.message) setResult(r);
      settle.current = r.message ? 'result' : kind;
    } catch (e) {
      settle.current = 'result';
      setResult({ ok: false, message: UNEXPECTED_FAILURE, warnings: [], details: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const backToOptions = () => {
    settle.current = 'setup';
    setNotesOpen(false);
    setResult(null);
  };
  const blockedBy = [aiBusy && 'export-blocked-ai', conflicts > 0 && 'export-blocked-conflict'].filter(Boolean) as string[];
  const websiteBlockedBy = [...blockedBy, ...(draftLinks.length ? ['export-draft-links-summary'] : [])];
  const cardState = (kind: ExportKind) => (busy === kind ? ' is-running' : '');
  const formatWords = format === 'zip' ? 'in one ZIP file' : 'as a folder';

  const history = recent.length > 0 && (
    <section className="export-history" aria-labelledby="export-history-title">
      <h3 id="export-history-title">Recent exports</h3>
      {recent.some((e) => e.previewUrl) && <p className="faint">Website folder previews keep running until you close this project.</p>}
      <ul>
        {recent.map((e, i) => {
          const latest = succeeded && i === 0 && e.path === shown?.path;
          return (
          <li key={`${e.path}\n${e.exportedAt}`} className={latest ? 'is-latest' : undefined}>
            <div className="row export-history-head">
              <strong className="grow">
                {e.kind === 'site' ? 'Website' : 'Editable project'}
                {e.format === 'zip' ? ' (ZIP file)' : ''}
              </strong>
              <span className="faint">
                <time dateTime={e.exportedAt}>{finishedAt(e.exportedAt)}</time> · revision {e.revision}
              </span>
            </div>
            <ExportPath path={e.path} id={`export-history-path-${i}`} />
            <div className="row">
              <button className={`btn btn-sm${latest ? ' btn-primary' : ''}`} aria-describedby={`export-history-path-${i}`} onClick={() => void api.projects.reveal(e.path)}>
                Show in folder
              </button>
              {e.previewUrl && (
                <button className="btn btn-sm" aria-describedby={`export-history-path-${i}`} title={e.previewUrl} onClick={() => void api.app.openExternal(e.previewUrl!)}>
                  Preview in browser
                </button>
              )}
            </div>
            {latest && foldNotes && (
              <>
                <button type="button" className="btn btn-sm btn-ghost export-note-toggle" aria-expanded={notesOpen} aria-controls={notesId} onClick={() => setNotesOpen(!notesOpen)}>
                  <ChevronRight size={14} style={{ transform: notesOpen ? 'rotate(90deg)' : undefined }} /> Review {shown!.warnings.length} export notes
                </button>
                <div className="export-row-notes" id={notesId} hidden={!notesOpen}>
                  {shown!.warnings.map((w, n) => (
                    <span className="export-note-line" key={n}>
                      • {w}
                    </span>
                  ))}
                </div>
              </>
            )}
          </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <Modal
      title="Export your website"
      icon={<Upload />}
      onClose={close}
      busy={!!busy}
      footer={
        <>
          {!succeeded && (
            <span className="export-hosting">
              <Cloud size={14} aria-hidden /> One-click publishing with SiteOrigin Hosting is coming soon.
            </span>
          )}
          <span className="spacer" />
          {succeeded && (
            <button className="btn" onClick={backToOptions}>
              Back to export options
            </button>
          )}
          <button className="btn" onClick={close} disabled={!!busy}>
            Close
          </button>
        </>
      }
    >
      <div className="export-dialog" ref={rootRef}>
        {/* Always mounted, so the start of a job is announced. It stays in view while the body scrolls. */}
        <div className="sr-only" role="status">
          {announced}
        </div>
        <div className="export-progress" role="status">
          {busy && (
            <>
              <Spinner decorative />
              <span>
                <strong>{busy === 'static' ? 'Building your website and checking every page…' : 'Copying the editable project…'}</strong>
                {busy === 'static' && <span>This can take a few minutes.</span>}
              </span>
            </>
          )}
        </div>
        {shown && (
          <>
            <div ref={resultRef} tabIndex={-1} className={`scope-note export-result ${shown.ok ? 'shared' : 'danger'}`} role={shown.ok ? 'status' : 'alert'}>
              {shown.ok ? <CircleCheck /> : <TriangleAlert />}
              <div className="export-note-body">
                <strong>{shown.message}</strong>
                {/* On success the newest recent export, directly below, already shows this path. */}
                {shown.path && recent[0]?.path !== shown.path && <ExportPath path={shown.path} />}
                {foldNotes ? (
                  <span>This export has {shown.warnings.length} notes to review.</span>
                ) : (
                  shown.warnings.map((w, i) => (
                    <span className="export-note-line" key={i}>
                      • {w}
                    </span>
                  ))
                )}
                {!shown.ok && shown.assetId && (
                  <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => openAsset(shown.assetId!)}>
                    Open in Assets
                  </button>
                )}
                {!shown.ok && shown.details && <span className="export-note-next">{shown.message === UNEXPECTED_FAILURE ? 'Try exporting again. If it keeps failing, use Copy details and send the report to your developer or support.' : 'Check the page or component named above in the editor, then export again. If you can’t fix it, use Copy details and send the report to your developer or support.'}</span>}
              </div>
            </div>
            {/* Outside the alert: opening the report or copying it must not make the result announce itself again. */}
            {!shown.ok && shown.details && <BuildDetails text={shown.details} />}
          </>
        )}
        {succeeded ? (
          history
        ) : (
          <>
            {!shown && !busy && <p className="export-intro">Host it anywhere or hand it to a developer. It runs without SiteOrigin Builder.</p>}
            {aiBusy && (
              <div className="scope-note site">
                <TriangleAlert />
                <span className="grow" id="export-blocked-ai">
                  Wait for the AI to finish before exporting.
                </span>
              </div>
            )}
            {conflicts > 0 && (
              <div className="scope-note site">
                <TriangleAlert />
                <span className="grow" id="export-blocked-conflict">
                  A project file changed outside SiteOrigin Builder. Resolve it in Project health before exporting.{aiBusy && ' You can open Project health once the AI finishes.'}
                </span>
                {!aiBusy && !busy && (
                  <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'health' } })}>
                    Open project health
                  </button>
                )}
              </div>
            )}
            {state && draftLinks.length > 0 && (
              <div className="scope-note danger" data-testid="export-draft-links">
                <TriangleAlert />
                {/* A short list is shown outright unless the window is too short to spare the room (styles.css). */}
                <div className={`export-note-body${longLinks ? '' : ' export-links-short'}`}>
                  <strong id="export-draft-links-summary">
                    {draftLinks.length === 1 ? 'A published page links to a draft.' : `Published pages have ${draftLinks.length} links to ${draftTargets === 1 ? 'a draft' : 'drafts'}.`} Change {draftLinks.length === 1 ? 'it' : 'them'} or publish {draftTargets === 1 ? 'the draft' : 'those drafts'} before exporting the website.
                  </strong>
                  {!blocked && <span>The editable project can still be exported.</span>}
                  <button type="button" className="btn btn-sm btn-ghost export-note-toggle" aria-expanded={linksOpen} aria-controls={linksId} onClick={() => setLinksOpen(!linksOpen)}>
                    <ChevronRight size={14} style={{ transform: linksOpen ? 'rotate(90deg)' : undefined }} /> Review links to drafts
                  </button>
                  <ul className="export-draft-links" id={linksId} hidden={!linksOpen}>
                    {draftLinks.map((l, i) => (
                      <li key={i}>{describeDraftLink(state, l)}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {state && <SampleContactReview groups={samplesToReview} kept={samplesKept} disabled={!!busy} readOnly={readOnly} onSettle={() => firstControl()?.focus()} />}
            {plan && <PagesSummary published={plan.published} drafts={plan.drafts} />}
            <div className="export-format">
              <span className="muted">Save as</span>
              {/* A fieldset locks both format buttons during a build, and while a conflict stops both exports. */}
              <fieldset className="export-format-control" role="presentation" disabled={!!busy || conflicts > 0}>
                <Segmented
                  label="Save as"
                  value={format}
                  onChange={(v) => !busy && setFormat(v)}
                  options={[
                    { value: 'folder', label: 'Folder' },
                    { value: 'zip', label: 'ZIP file' }
                  ]}
                />
              </fieldset>
            </div>
            <button ref={(el) => void (buttons.current.static = el)} className={`welcome-action${cardState('static')}`} aria-disabled={!!busy || blocked || draftLinks.length > 0 || undefined} aria-describedby={websiteBlockedBy.join(' ') || undefined} onClick={() => void run('static')}>
              <span className="ico"><Globe size={18} /></span>
              <span className="grow">
                <strong>Website files, ready to upload</strong>
                <span className="export-card-line">{format === 'zip' ? 'Every published page as a finished website, in one ZIP file.' : 'Every published page as a finished website folder, for any web host.'}</span>
                <span className="export-card-line" data-testid="export-photo-privacy">Photos leave out where they were taken and the camera details. Credits, copyright, orientation and colour stay.</span>
              </span>
              <ChevronRight className="chev" />
            </button>
            <button ref={(el) => void (buttons.current.source = el)} className={`welcome-action secondary${cardState('source')}`} aria-disabled={!!busy || blocked || undefined} aria-describedby={blockedBy.join(' ') || undefined} onClick={() => void run('source')}>
              <span className="ico"><FolderCode size={18} /></span>
              <span className="grow">
                <strong>Editable project, for a developer</strong>
                <span className="export-card-line">The complete project {formatWords}, so a developer can keep building it with standard tools.</span>
                <span className="export-card-line">Photos stay exactly as imported, including any location they record.</span>
              </span>
              <ChevronRight className="chev" />
            </button>
            {history}
          </>
        )}
      </div>
    </Modal>
  );
}
