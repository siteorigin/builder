import { Fragment, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, Cloud, Copy, FilePen, FolderCode, Globe, MapPin, MapPinOff, TriangleAlert, Upload } from 'lucide-react';
import { describeDraftLink, publicationIds, publicationPlan, type DraftLink } from '@generator/checks';
import type { PageDoc, ProjectState } from '@shared/types';
import type { SiteEntry } from '@shared/collections';
import type { ExportFormat, ExportNote, ExportResult, RecentExport } from '@shared/api';
import { api, editRunStatus, getState, saveLocal, setState, toast, useStore } from '../store';
import { Modal, Segmented, Spinner, openSection } from '../components/ui';
import { goToShellPart, openAsset, pageOutOfSight, selectPage, openLayout } from '../lib/actions';
import { treeFor } from '../lib/model';
import { sampleContactMatches, type ContentField, type SampleContactGroup } from '../lib/find-content';
import { openContentMatch } from './FindReplace';
import { diagnosticKey, websiteFormNotes, websiteTrees } from '@engine/validate';
import { publishedState } from '@generator/index';
import { destinationLabel, noteState } from '../lib/destinations';
import { openEditorDestination } from '../lib/open-destination';
import { pagesSummaryText } from '../lib/export-summary';
import { auditForHealth, seoCountsText, seoPreflight, type SeoAuditResult } from '../lib/seo-health';
import { findingHandoff } from '../lib/seoHandoff';
import { AiHandoffButton } from '../components/AiHandoff';
import './ExportModal.css';

type ExportKind = 'static' | 'source';

const NO_EXPORTS: RecentExport[] = [];
/** More links to drafts than this are counted, with the list one click away. */
const LONG_LINK_LIST = 3;
/** More notes than this fold into the export's own row, so a success keeps its next step in view. */
const MANY_NOTES = 2;
const UNEXPECTED_FAILURE = 'The export could not be completed.';
let reports = 0;
/** A new export report's id: unique for this editor's lifetime, across every opening of the dialog. */
const newReportId = () => `${Date.now().toString(36)}-${++reports}`;

/** A window too short to spare the room folds even a short list of links to drafts, so the choices stay in view. */
const SHORT_WINDOW = '(max-height: 720px)';
const watchShortWindow = (change: () => void) => {
  const query = window.matchMedia(SHORT_WINDOW);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
};
const useShortWindow = () => useSyncExternalStore(watchShortWindow, () => window.matchMedia(SHORT_WINDOW).matches);

/** Close the dialog on the page a failed build was working on, ready to edit. */
function openFailedPage(pageId: string) {
  const s = getState();
  if (pageOutOfSight(s, pageId)) selectPage(pageId);
  setState({ modal: null, mode: 'edit', rightTab: 'inspect', dockOpen: true });
}

/** Select the element that holds a link to a draft, on the page or shared part it is in, so the link can be changed. */
function openDraftLink(l: DraftLink) {
  // A collection entry's text has no place in the inspector yet (the dialog offers no button for one).
  if (l.owner.kind === 'entry') return;
  const owner = l.owner as { kind: 'page' | 'shell' | 'template'; id: string };
  const s = getState();
  const st = s.snapshot?.state;
  const tree = st && treeFor(st, owner);
  if (!tree?.nodes[l.nodeId]) return toast('That link is no longer on the site.', 'info');
  // A link in a collection's layout is shown on one of its entries.
  if (owner.kind === 'template') {
    openLayout(owner.id);
    setState({ modal: null, selection: { owner, instancePath: [], nodeId: l.nodeId }, rightTab: 'inspect', dockOpen: true });
    setTimeout(() => openSection('content'), 50);
    return;
  }
  if (l.owner.kind === 'shell') {
    if (!goToShellPart(l.owner.id)) return toast(`No page shows the shared ${l.owner.id}, so the link is not on any page.`, 'info');
  } else if (pageOutOfSight(s, l.owner.id)) selectPage(l.owner.id);
  setState({ modal: null, mode: 'edit', selection: { owner, instancePath: [], nodeId: l.nodeId }, rightTab: 'inspect', dockOpen: true, definitionMode: null });
  setTimeout(() => openSection('content'), 50);
}

/** When an export finished: the time today, or the date and time on an earlier day. */
function finishedAt(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * A full path that wraps at its separators, with the file or folder it ends in standing out. `compact` keeps it to one
 * line for an earlier export: the folder gives way from its start, the name always shows whole, and the text (selected,
 * copied, or read aloud) is still the full path.
 */
function ExportPath({ path, id, compact }: { path: string; id?: string; compact?: boolean }) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  if (compact)
    return (
      <span className="export-path is-compact" id={id} title={path} style={{ '--name': `${path.length - cut + 0.5}ch` } as CSSProperties}>
        {cut > 0 && (
          <span className="export-path-dir">
            <bdi dir="ltr">{path.slice(0, cut)}</bdi>
          </span>
        )}
        <strong>{path.slice(cut)}</strong>
      </span>
    );
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

/** What the website export publishes and leaves out: pages named when the list is short, counted when it is long, and the collection entries counted. */
function PagesSummary({ published, drafts, publishedEntries, draftEntries }: { published: PageDoc[]; drafts: PageDoc[]; publishedEntries: SiteEntry[]; draftEntries: SiteEntry[] }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const text = pagesSummaryText({ published, drafts, publishedEntries, draftEntries });
  const { long } = text;
  return (
    <div className="export-pages" data-testid="export-pages">
      <p>
        <Globe size={14} aria-hidden /> <span>
          <strong>{text.published.lead}</strong>{text.published.rest}
        </span>
      </p>
      {text.drafts && (
        <p data-testid="export-drafts">
          <FilePen size={14} aria-hidden /> <span>
            <strong>{text.drafts.lead}</strong>{text.drafts.rest}
          </span>
        </p>
      )}
      {long && (
        <>
          <button type="button" className="btn btn-sm btn-ghost export-pages-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
            <ChevronRight size={14} /> Review all pages
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
function SampleContactReview({ groups, kept, disabled, readOnly, folded, onSettle }: { groups: SampleContactGroup[]; kept: SampleContactGroup[]; disabled: boolean; readOnly: boolean; folded: boolean; onSettle: () => void }) {
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Folded to its counted heading while something more urgent needs the room; the rows are one click away.
  const [listOpen, setListOpen] = useState(false);
  const listHidden = folded && !listOpen;
  // A job that starts folds the rows away again: their actions wait for it.
  useEffect(() => {
    if (disabled) setListOpen(false);
  }, [disabled]);
  if (!groups.length && !kept.length) return null;
  // The control pressed goes away with its group: focus moves to what took its place, here or in the dialog.
  // Only a control that is shown and usable can take focus.
  const usable = (selector: string) => [...(rootRef.current?.querySelectorAll<HTMLElement>(selector) ?? [])].filter((c) => c.offsetParent !== null && !(c as HTMLButtonElement).disabled);
  const settle = (pick: () => HTMLElement | undefined) =>
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const el = pick();
      if (el) el.focus();
      else onSettle();
    });
  // A kept row goes away: focus moves to the same decision on the row that took its place, else the one above it,
  // else the way to review the kept details again.
  const keepAt = (i: number) => {
    const keeps = usable('.export-review-list > li .export-review-keep');
    return keeps[i] ?? keeps[i - 1] ?? usable('.export-samples-kept button')[0];
  };
  const keptLine = kept.length > 0 && (
    <p className="export-samples-kept" data-testid="export-samples-kept">
      <CircleCheck aria-hidden />
      <span>
        {kept.length === 1 ? `${kept[0].value} is kept as you chose.` : `${kept.length} sample contact details are kept as you chose.`}{' '}
        <button className="link-btn" disabled={disabled || readOnly} onClick={() => (keepSamples(kept.map((g) => g.value), false), setListOpen(true), settle(() => usable('.export-review-actions .btn')[0]))}>
          Review {kept.length === 1 ? 'it' : 'them'} again
        </button>
      </span>
    </p>
  );
  const headId = `${baseId}-head`;
  const rowsId = `${baseId}-rows`;
  return (
    <div ref={rootRef} className="export-samples-review">
      {groups.length > 0 && (
        <section className="export-review" data-testid="export-sample-contacts" aria-labelledby={headId}>
          <div className="export-review-head">
            <TriangleAlert aria-hidden />
            <div className="grow">
              <strong id={headId}>{groups.length === 1 ? 'A sample contact detail from the starter is still on the website.' : `${groups.length} sample contact details from the starter are still on the website.`}</strong>
              <span>Visitors who use {groups.length === 1 ? 'it' : 'them'} won’t reach you. This won’t stop the export.</span>
            </div>
            {/* While a job runs the rows' actions wait, so there is nothing to open. */}
            {folded && !disabled && (
              <button type="button" className="btn btn-sm export-review-toggle" aria-expanded={listOpen} aria-controls={rowsId} aria-describedby={headId} onClick={() => setListOpen(!listOpen)}>
                <ChevronRight size={14} aria-hidden />
                {listOpen ? 'Hide' : 'Review'}
              </button>
            )}
          </div>
          <ul className="export-review-list" id={rowsId} hidden={listHidden}>
            {groups.map((g, row) => {
              const listId = `${baseId}-${g.kind}`;
              const nameId = `${listId}-name`;
              const shown = open === g.kind;
              return (
                <li key={g.kind} data-testid={`export-sample-${g.kind}`}>
                  <div className="export-review-row">
                    <div className="export-review-what">
                      <span id={nameId}>
                        <strong>{g.value}</strong>{' '}
                        <span className="export-review-where">
                          · {g.matches.length === 1 ? '1 place' : `${g.matches.length} places`} on {placesOf(g.matches.map((m) => m.field))}.
                        </span>
                      </span>{' '}
                      {/* Beside the places it reveals, so the row stays one decision wide. */}
                      <button type="button" className="export-inline-toggle" aria-expanded={shown} aria-controls={listId} aria-describedby={nameId} onClick={() => setOpen(shown ? null : g.kind)}>
                        Show where
                        <ChevronRight size={13} aria-hidden />
                      </button>
                    </div>
                    <div className="export-review-actions">
                      <button className="btn btn-sm" disabled={disabled} aria-describedby={nameId} onClick={() => setState({ modal: { kind: 'find', query: g.value, sample: g.kind } })}>
                        Replace everywhere…
                      </button>
                      {/* A read-only project keeps nothing, and exports nothing either. */}
                      <button className="btn btn-sm btn-ghost export-review-keep" disabled={disabled || readOnly} aria-describedby={nameId} onClick={() => (keepSamples([g.value], true), settle(() => keepAt(row)))}>
                        Keep it
                      </button>
                    </div>
                  </div>
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
        </section>
      )}
      {keptLine}
    </div>
  );
}

/**
 * The contact forms the website would publish that visitors cannot send, each in Project health's words (which name
 * its page) with the way to its settings. They are reviewed before the website goes out, but never stop it: a work in
 * progress can still be exported on purpose.
 */
function FormReview({ notes, disabled, folded }: { notes: ExportNote[]; disabled: boolean; folded: boolean }) {
  const baseId = useId();
  // Folded to its counted heading while something more urgent needs the room; the rows are one click away.
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    if (disabled) setListOpen(false);
  }, [disabled]);
  if (!notes.length) return null;
  const headId = `${baseId}-head`;
  const rowsId = `${baseId}-rows`;
  return (
    <section className="export-review" data-testid="export-form-review" aria-labelledby={headId}>
      <div className="export-review-head">
        <TriangleAlert aria-hidden />
        <div className="grow">
          <strong id={headId}>{notes.length === 1 ? 'A contact form on the website can’t send messages yet.' : `${notes.length} contact forms on the website can’t send messages yet.`}</strong>
          <span>Visitors who fill {notes.length === 1 ? 'it' : 'them'} in won’t reach you. You can still export the website.</span>
        </div>
        {folded && !disabled && (
          <button type="button" className="btn btn-sm export-review-toggle" aria-expanded={listOpen} aria-controls={rowsId} aria-describedby={headId} onClick={() => setListOpen(!listOpen)}>
            <ChevronRight size={14} aria-hidden />
            {listOpen ? 'Hide' : 'Review'}
          </button>
        )}
      </div>
      <ul className="export-review-list" id={rowsId} hidden={folded && !listOpen}>
        {notes.map((n, i) => (
          <li key={n.destination?.kind === 'form' ? `${n.destination.owner.kind}:${n.destination.owner.id}:${n.destination.nodeId}` : i}>
            <div className="export-review-row">
              <span className="export-review-what" id={`${baseId}-${i}`}>
                {n.message}
              </span>
              <div className="export-review-actions">
                {n.destination && (
                  <button className="btn btn-sm" disabled={disabled} aria-describedby={`${baseId}-${i}`} onClick={() => openEditorDestination(n.destination!)}>
                    {destinationLabel(n.destination)}
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The SEO and agentic preflight: what keeps the website from being found, shared or read by search engines, link
 * previews and AI agents (the SEO audit's problems and warnings), counted, with a few of them and the way to where each
 * is fixed (and Fix with AI, when the AI can fix it), and the way to all of them in Project health. It never stops the
 * export: an author may publish before the site has a public URL, say. With nothing to fix, it is one quiet line.
 */
function SeoPreflight({ audit, state, disabled, folded }: { audit: SeoAuditResult; state: ProjectState; disabled: boolean; folded: boolean }) {
  const baseId = useId();
  // Folded to its counted heading while something more urgent needs the room; the rows are one click away.
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    if (disabled) setListOpen(false);
  }, [disabled]);
  // Project health says why the audit could not read the project; the export itself is not held up by it.
  if (!audit.ok) return null;
  const pre = seoPreflight(audit.findings);
  const openHealth = () => setState({ modal: { kind: 'health', section: 'seo' } });
  if (!pre.total)
    return (
      <p className="export-seo-ready" data-testid="export-seo-preflight">
        <CircleCheck aria-hidden />
        <span>
          <strong>Ready for search and AI.</strong> {pre.notes ? `Nothing to fix; Project health has ${seoCountsText(audit.findings)} with suggestions.` : 'Nothing keeps search engines, link previews or AI agents from the website.'}{' '}
          {pre.notes > 0 && (
            <button type="button" className="link-btn" disabled={disabled} onClick={openHealth}>
              Review in Project health
            </button>
          )}
        </span>
      </p>
    );
  const headId = `${baseId}-head`;
  const rowsId = `${baseId}-rows`;
  return (
    <section className="export-review" data-testid="export-seo-preflight" aria-labelledby={headId}>
      <div className="export-review-head">
        <TriangleAlert aria-hidden />
        <div className="grow">
          <strong id={headId}>{pre.total === 1 ? 'One thing keeps the website from being found or shared well.' : `${pre.total} things keep the website from being found or shared well.`}</strong>
          <span>Search engines, link previews and AI agents read the website as it is exported. This won’t stop the export.</span>
        </div>
        {folded && !disabled && (
          <button type="button" className="btn btn-sm export-review-toggle" aria-expanded={listOpen} aria-controls={rowsId} aria-describedby={headId} onClick={() => setListOpen(!listOpen)}>
            <ChevronRight size={14} aria-hidden />
            {listOpen ? 'Hide' : 'Review'}
          </button>
        )}
      </div>
      <ul className="export-review-list" id={rowsId} hidden={folded && !listOpen}>
        {pre.examples.map((f, i) => (
          <li key={diagnosticKey(f)}>
            <div className="export-review-row">
              <span className="export-review-what" id={`${baseId}-${i}`}>
                {f.message}
              </span>
              <div className="export-review-actions">
                {f.destination && (
                  <button className="btn btn-sm" disabled={disabled} aria-describedby={`${baseId}-${i}`} onClick={() => openEditorDestination(f.destination!)}>
                    {destinationLabel(f.destination)}
                  </button>
                )}
                {findingHandoff(state, f) && <AiHandoffButton label="Fix with AI" disabled={disabled} describedBy={`${baseId}-${i}`} request={() => findingHandoff(getState().snapshot?.state ?? state, f)} />}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="export-seo-more">
        <span>{pre.more ? `${pre.more} more ${pre.more === 1 ? 'is' : 'are'} in Project health.` : pre.notes ? `Project health also has ${seoCountsText(audit.findings.filter((f) => f.severity === 'info'))} with suggestions.` : ''}</span>
        <button type="button" className="link-btn" disabled={disabled} aria-describedby={headId} onClick={openHealth}>
          View all in Project health
        </button>
      </p>
    </section>
  );
}

/** What an export note says once what it describes was put right after the export: the files need exporting again. */
function fixedSince(note: ExportNote, state: 'fixed' | 'gone'): string {
  if (note.destination?.kind === 'site') return 'Public URL set since this export. Export again to include canonical links and the sitemap.';
  return state === 'gone' ? 'This form is no longer on the website. Export again to update the files.' : 'Connected since this export. Export again so visitors can send it.';
}

/**
 * One note about an export. A note about something the author can fix leads to it while it still holds, and once it is
 * fixed says that the files need exporting again: the export itself never changes.
 */
function NoteLine({ note, project, forms, trees, disabled }: { note: ExportNote; project: ProjectState | undefined; forms: ExportNote[]; trees: ReturnType<typeof websiteTrees>; disabled: boolean }) {
  const lineId = useId();
  const now = project ? noteState(project, note, forms, trees) : null;
  return (
    <p className="export-note-line">
      <span id={lineId}>{note.message}</span>
      {now === 'open' && note.destination && (
        <>
          {' '}
          <button type="button" className="link-btn export-note-go" disabled={disabled} aria-describedby={lineId} onClick={() => openEditorDestination(note.destination!)}>
            {destinationLabel(note.destination)}
          </button>
        </>
      )}
      {(now === 'fixed' || now === 'gone') && (
        <span className="export-note-since">
          <CircleCheck aria-hidden /> {fixedSince(note, now)}
        </span>
      )}
    </p>
  );
}

/**
 * What a failed build said, for the author to read and copy into a support request. Copying works with the details
 * closed; a clipboard that is unavailable or refuses says so, and the text can still be selected.
 */
function BuildDetails({ text, fix }: { text: string; fix?: ReactNode }) {
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
        {fix}
        <button type="button" className="btn btn-sm btn-ghost export-details-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          <ChevronRight size={14} /> Technical details
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
  const draftTargets = new Set(draftLinks.map((l) => l.pageId ?? `entry:${l.entryId}`)).size;
  // The starter's sample contact details the website would publish: reviewed, apart from those kept on purpose.
  const keptValues = useStore((s) => s.keptSamples);
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  const samples = useMemo(() => (state ? sampleContactMatches(state) : []), [state]);
  const samplesToReview = samples.filter((g) => !keptValues.includes(g.value));
  const samplesKept = samples.filter((g) => keptValues.includes(g.value));
  // The website's contact forms visitors cannot send, as the website export would name them, and where to fix each.
  const formNotes = useMemo(() => (state ? websiteFormNotes(state) : []), [state]);
  // What keeps the website from being found or shared, as Project health's Search & AI readiness says it.
  const seoAudit = useMemo(() => (state ? auditForHealth(state) : null), [state]);
  // What the website shows now, read once for every note about an earlier export.
  const liveTrees = useMemo(() => (state ? websiteTrees(publishedState(state)) : []), [state]);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  // Each report carries its own id, shown on the result (data-report): the same report drawn again after a cancelled
  // retry keeps its id, a new one (even with the same words) gets another, so a test can tell them apart.
  const [result, setResult] = useState<(ExportResult & { report: string }) | null>(null);
  const [format, setFormat] = useState<ExportFormat>('folder');
  const linksId = useId();
  const [linksOpen, setLinksOpen] = useState(false);
  // A long list, or a window too short to spare the room, folds behind a disclosure; otherwise there is none to focus.
  const shortWindow = useShortWindow();
  const longLinks = draftLinks.length > LONG_LINK_LIST || shortWindow;
  const close = () => !busy && setState({ modal: null });
  const blocked = aiBusy || conflicts > 0;
  // The last report stays until a new one replaces it, so cancelling the save picker on a retry keeps it to copy.
  const shown = !busy && result?.message ? result : null;
  const succeeded = !!shown?.ok;
  // A success's notes go with the export they describe, under its actions, so the result stays a short verdict.
  const notesInRow = succeeded && shown!.warnings.length > 0 && recent[0]?.path === shown!.path;
  // The newest export's notes: all of them just after it finishes; once the dialog is opened again, those that lead to
  // something to fix, so a fix made since says the files need exporting again.
  const rowNotes: ExportNote[] = notesInRow ? (shown!.notes ?? shown!.warnings.map((message) => ({ message }))) : succeeded ? [] : (recent[0]?.notes ?? []).filter((n) => n.destination);
  const foldNotes = rowNotes.length > MANY_NOTES;
  const notesId = useId();
  // The page a failed build names by its address, when exactly one page has it: the author's way back to fix it.
  const failedPage = useMemo(() => {
    if (!shown || shown.ok || !state) return null;
    const named = Object.values(state.pages).filter((p) => shown.message.includes(`(${p.route})`));
    return named.length === 1 ? named[0] : null;
  }, [shown, state]);
  const fix = failedPage ? (
    <button className="btn btn-sm btn-primary export-fix" onClick={() => openFailedPage(failedPage.id)}>
      Open the {failedPage.title} page
    </button>
  ) : shown && !shown.ok && shown.assetId ? (
    <button className="btn btn-sm btn-primary export-fix" onClick={() => openAsset(shown.assetId!)}>
      Open in Assets
    </button>
  ) : null;
  const [notesOpen, setNotesOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // The first control the author can see and use: never one folded away or unavailable.
  const firstControl = () => [...(rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([aria-disabled="true"])') ?? [])].find((b) => b.offsetParent !== null);
  // Said once when it changes: a note that simply appears or disappears is not reliably announced.
  const availability = aiBusy ? 'Wait for the AI to finish before exporting.' : conflicts > 0 ? 'A project file changed outside SiteOrigin Builder. Resolve it in Project health before exporting.' : draftLinks.length ? 'The website cannot be exported until its links to drafts are changed. The editable project can still be exported.' : 'Both exports are available.';
  const [announced, setAnnounced] = useState('');
  const lastAvailability = useRef(availability);
  useEffect(() => {
    if (lastAvailability.current !== availability) {
      lastAvailability.current = availability;
      setAnnounced(availability);
    }
    // A control that went away with its blocker, or with what a note or the form review named (fixed meanwhile), leaves
    // focus nowhere.
    if (document.activeElement === document.body) firstControl()?.focus();
  }, [availability, longLinks, state]);
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
      // The website is built only if it still publishes the pages and entries counted here.
      const r = kind === 'static' ? await api.project.exportStatic(format, plan ? publicationIds(plan) : undefined) : await api.project.exportSource(format);
      if (r.message) setResult({ ...r, report: newReportId() });
      settle.current = r.message ? 'result' : kind;
    } catch (e) {
      settle.current = 'result';
      setResult({ ok: false, message: UNEXPECTED_FAILURE, warnings: [], details: (e as Error).message, report: newReportId() });
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
  /** What the end of a card says it will do: start, work, or nothing until its blocker is cleared. Its name says the rest. */
  const cardEnd = (kind: ExportKind, unavailable: boolean) => (
    <span className={`export-card-end${!busy && !unavailable ? ' is-ready' : ''}`} aria-hidden>
      {busy === kind ? (
        kind === 'static' ? 'Building…' : 'Copying…'
      ) : busy ? null : unavailable ? (
        'Unavailable'
      ) : (
        <>
          Export <ChevronRight size={14} />
        </>
      )}
    </span>
  );

  const history = recent.length > 0 && (
    <section className="export-history" aria-labelledby="export-history-title">
      <div className="export-history-title">
        <h3 id="export-history-title">Recent exports</h3>
      </div>
      <ul>
        {recent.map((e, i) => {
          const latest = succeeded && i === 0 && e.path === shown?.path;
          return (
            <li key={`${e.path}\n${e.exportedAt}`} className={latest ? 'is-latest' : undefined}>
              <div className="export-history-head">
                <strong>
                  {e.kind === 'site' ? 'Website' : 'Editable project'}
                  {e.format === 'zip' ? ' (ZIP file)' : ''}
                </strong>
                <span>
                  <time dateTime={e.exportedAt}>{finishedAt(e.exportedAt)}</time> · revision {e.revision}
                </span>
              </div>
              <ExportPath path={e.path} id={`export-history-path-${i}`} compact={!latest} />
              <div className="export-history-actions">
                <button className={`btn btn-sm${latest ? ' btn-primary' : ''}`} aria-describedby={`export-history-path-${i}`} onClick={() => void api.projects.reveal(e.path)}>
                  Show in folder
                </button>
                {e.previewUrl && (
                  <>
                    <button className="btn btn-sm" aria-describedby={`export-history-path-${i} export-history-preview-${i}`} title={e.previewUrl} onClick={() => void api.app.openExternal(e.previewUrl!)}>
                      Preview in browser
                    </button>
                    <span className="export-history-hint" id={`export-history-preview-${i}`}>
                      Runs until you close this project.
                    </span>
                  </>
                )}
              </div>
              {i === 0 && rowNotes.length > 0 && (
                <div className="export-row-notes-wrap">
                  {foldNotes ? (
                    <button type="button" className="btn btn-sm btn-ghost export-note-toggle" aria-expanded={notesOpen} aria-controls={notesId} onClick={() => setNotesOpen(!notesOpen)}>
                      <ChevronRight size={14} /> Review {rowNotes.length} export notes
                    </button>
                  ) : (
                    <h4 className="export-row-notes-title">{rowNotes.length === 1 ? 'A note about this export' : 'Notes about this export'}</h4>
                  )}
                  {/* Not a list: the history's list items are its exports, one each. */}
                  <div className="export-row-notes" id={notesId} hidden={foldNotes && !notesOpen}>
                    {rowNotes.map((note, n) => (
                      <NoteLine key={n} note={note} project={state} forms={formNotes} trees={liveTrees} disabled={!!busy} />
                    ))}
                  </div>
                </div>
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
      describedBy={succeeded ? undefined : aiBusy ? 'export-blocked-ai' : conflicts > 0 ? 'export-blocked-conflict' : draftLinks.length ? 'export-draft-links-summary' : undefined}
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
      {/* With a fix to make first, the website card's export is no longer the primary action. */}
      <div className={`export-dialog${fix ? ' has-fix' : ''}`} ref={rootRef}>
        {/* Always mounted, so the start of a job is announced. It stays in view while the body scrolls. */}
        <div className="sr-only" role="status">
          {announced}
        </div>
        {/* The report kept, by its id, while it is hidden by a running export: what a test compares a new report with. */}
        <div className="export-progress" role="status" data-kept-report={result?.report}>
          {busy && (
            <>
              <Spinner decorative />
              <span>
                <strong>{busy === 'static' ? 'Building your website and checking every page…' : 'Copying the editable project…'}</strong>
                <span>{busy === 'static' ? 'This can take a few minutes. The dialog stays open until it finishes.' : 'The dialog stays open until it finishes.'}</span>
              </span>
            </>
          )}
        </div>
        {shown && (
          // A failure and its report read as one card; the report stays outside the alert itself.
          <div className={shown.ok ? 'export-outcome' : 'export-outcome export-failure'}>
            <div ref={resultRef} tabIndex={-1} className={`scope-note export-result ${shown.ok ? 'shared' : 'danger'}`} role={shown.ok ? 'status' : 'alert'} data-report={shown.report}>
              {shown.ok ? <CircleCheck /> : <CircleAlert />}
              <div className="export-note-body">
                <strong>{shown.message}</strong>
                {/* On success the newest recent export, directly below, already shows this path. */}
                {shown.path && recent[0]?.path !== shown.path && <ExportPath path={shown.path} />}
                {notesInRow ? (
                  <span>{shown.warnings.length === 1 ? '1 note to review below.' : `${shown.warnings.length} notes to review below.`}</span>
                ) : (
                  shown.warnings.map((w, i) => (
                    <span className="export-note-line" key={i}>
                      • {w}
                    </span>
                  ))
                )}
                {!shown.ok && shown.details && <span className="export-note-next">{shown.message === UNEXPECTED_FAILURE ? 'Try exporting again. If it keeps failing, use Copy details and send the report to your developer or support.' : 'Check the page or component named above in the editor, then export again. If you can’t fix it, use Copy details and send the report to your developer or support.'}</span>}
              </div>
            </div>
            {/* Outside the alert: opening the report or copying it must not make the result announce itself again. The fix,
                when there is one, leads the row as the dialog's primary action, and is the next stop after the result. */}
            {!shown.ok && (shown.details ? <BuildDetails text={shown.details} fix={fix} /> : fix && (
                  <div className="build-details">
                    <div className="row wrap">{fix}</div>
                  </div>
                ))}
          </div>
        )}
        {succeeded ? (
          history
        ) : (
          <>
            {!shown && !busy && <p className="export-intro">Host it anywhere or hand it to a developer. It runs without SiteOrigin Builder.</p>}
            {aiBusy && (
              // A wait, not a fault: it clears itself, so it is drawn as work in progress rather than an error.
              <div className="scope-note info export-blocker">
                <Spinner decorative />
                <span className="export-note-body export-blocker-text" id="export-blocked-ai">
                  <strong>Both exports wait for the AI to finish.</strong>
                  <span>They become available as soon as it’s done.</span>
                </span>
              </div>
            )}
            {conflicts > 0 && (
              <div className="scope-note danger export-blocker">
                <CircleAlert />
                <span className="export-note-body export-blocker-text" id="export-blocked-conflict">
                  <strong>Both exports are unavailable.</strong>
                  <span>A project file changed outside SiteOrigin Builder. Resolve it in Project health first.{aiBusy && ' You can open Project health once the AI finishes.'}</span>
                </span>
                {!aiBusy && !busy && (
                  <button className="btn btn-sm btn-primary" aria-describedby="export-blocked-conflict" onClick={() => setState({ modal: { kind: 'health' } })}>
                    Open project health
                  </button>
                )}
              </div>
            )}
            {state && draftLinks.length > 0 && (
              <div className="scope-note danger export-blocker" data-testid="export-draft-links">
                <CircleAlert />
                <div className="export-note-body">
                  <div className="export-blocker-head">
                    <span className="export-blocker-text" id="export-draft-links-summary">
                      <strong>{draftLinks.length === 1 ? 'A link to a draft stops the website export.' : `${draftLinks.length} links to ${draftTargets === 1 ? 'a draft' : 'drafts'} stop the website export.`}</strong>{' '}
                      <span>
                        Change {draftLinks.length === 1 ? 'it' : 'them'}, or publish {draftTargets === 1 ? 'the draft' : 'those drafts'}.{!blocked && ' The editable project can still be exported.'}
                      </span>
                    </span>
                    {/* Only a folded list has a disclosure, so nothing hidden can take focus. It sits before the list it opens. */}
                    {longLinks && (
                      <button type="button" className="btn btn-sm export-blocker-toggle" aria-expanded={linksOpen} aria-controls={linksId} aria-describedby="export-draft-links-summary" onClick={() => setLinksOpen(!linksOpen)}>
                        <ChevronRight size={14} aria-hidden /> Review links to drafts
                      </button>
                    )}
                  </div>
                  <ul className="export-draft-links" id={linksId} hidden={longLinks && !linksOpen}>
                    {draftLinks.map((l, i) => {
                      const said = describeDraftLink(state, l);
                      return (
                        <li key={i}>
                          <span className="grow">{said}</span>
                          {/* A collection entry's text has no place in the inspector yet: the line names the entry. */}
                          {l.owner.kind !== 'entry' && (
                            <button className="btn btn-sm" disabled={!!busy} aria-label={`Open ${said} in the inspector`} aria-describedby="export-draft-links-summary" onClick={() => openDraftLink(l)}>
                              Open
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            )}
            {state && <FormReview notes={formNotes} disabled={!!busy} folded={shortWindow || !!busy || blocked || draftLinks.length > 0 || (!!shown && !shown.ok)} />}
            {state && <SampleContactReview groups={samplesToReview} kept={samplesKept} disabled={!!busy} readOnly={readOnly} folded={shortWindow || !!busy || blocked || draftLinks.length > 0 || (!!shown && !shown.ok)} onSettle={() => firstControl()?.focus()} />}
            {seoAudit && state && <SeoPreflight audit={seoAudit} state={state} disabled={!!busy} folded={shortWindow || !!busy || blocked || draftLinks.length > 0 || (!!shown && !shown.ok)} />}
            {plan && <PagesSummary published={plan.published} drafts={plan.drafts} publishedEntries={plan.publishedEntries} draftEntries={plan.draftEntries} />}
            <div className="export-choice" role="group" aria-labelledby="export-choice-title">
              <div className="export-choice-head">
                <h3 id="export-choice-title">Choose an export</h3>
                <div className="export-format">
                  <span>Save as</span>
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
              </div>
              <button ref={(el) => void (buttons.current.static = el)} className={`action-card export-card${cardState('static')}`} aria-disabled={!!busy || blocked || draftLinks.length > 0 || undefined} aria-describedby={websiteBlockedBy.join(' ') || undefined} onClick={() => void run('static')}>
                <span className="ico"><Globe size={18} /></span>
                <span className="grow">
                  <span className="export-card-title">
                    <strong>Website files, ready to upload</strong>
                    {cardEnd('static', blocked || draftLinks.length > 0)}
                  </span>
                  <span className="export-card-line">{format === 'zip' ? 'Every published page as a finished website, in one ZIP file.' : 'Every published page as a finished website folder, for any web host.'}</span>
                  <span className="export-card-line export-card-photos" data-testid="export-photo-privacy">
                    <MapPinOff aria-hidden /> <span>Removes where each photo was taken and the camera details. Credits, copyright, orientation and colour stay.</span>
                  </span>
                </span>
              </button>
              <button ref={(el) => void (buttons.current.source = el)} className={`action-card export-card secondary${cardState('source')}`} aria-disabled={!!busy || blocked || undefined} aria-describedby={blockedBy.join(' ') || undefined} onClick={() => void run('source')}>
                <span className="ico"><FolderCode size={18} /></span>
                <span className="grow">
                  <span className="export-card-title">
                    <strong>Editable project, for a developer</strong>
                    {cardEnd('source', blocked)}
                  </span>
                  <span className="export-card-line">The complete project {formatWords}, so a developer can keep building it with standard tools.</span>
                  <span className="export-card-line export-card-photos">
                    <MapPin aria-hidden /> <span>Photos stay exactly as imported, including any location they record.</span>
                  </span>
                </span>
              </button>
            </div>
            {history}
          </>
        )}
      </div>
    </Modal>
  );
}
