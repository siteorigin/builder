import { Fragment, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, Cloud, Copy, FolderCode, Globe, Info, MapPin, MapPinOff, TriangleAlert, Upload } from 'lucide-react';
import { describeDraftLink, publicationIds, publicationPlan, type DraftLink } from '@generator/checks';
import type { PageDoc, ProjectState } from '@shared/types';
import type { SiteEntry } from '@shared/collections';
import { BUILD_FAILED_UNPLACED, type Diagnostic, type ExportFormat, type ExportNote, type ExportResult, type RecentExport } from '@shared/api';
import { api, editRunStatus, getState, keepSamples, setState, toast, useStore } from '../store';
import { Modal, Segmented, Spinner, openSection } from '../components/ui';
import { goToShellPart, openAsset, pageOutOfSight, selectPage, openLayout, showArchiveLayout } from '../lib/actions';
import { treeFor } from '../lib/model';
import { settleEdits } from '../lib/leave';
import { afterEditsSettle } from '../lib/pending';
import type { SampleContactGroup, SampleIdentityField } from '../lib/find-content';
import { sampleGroups, sampleWhere } from '../lib/sample-review';
import { openContentMatch } from './FindReplace';
import { websiteFormNotes, websiteFormProblems, websiteTrees } from '@engine/validate';
import { publishedState } from '@generator/index';
import { destinationLabel, noteState } from '../lib/destinations';
import { openEditorDestination } from '../lib/open-destination';
import { dialogFixes, healthNotes, healthNotesText, nothingToFix, pagesSummaryText, sampleContactsLine, type HealthNotes } from '../lib/export-summary';
import { auditForHealth } from '../lib/seo-health';
import { BlockedNote, aiAwaiting, aiChanging, readOnlyBlock } from '../components/BlockedNote';
import { ClientReview, type ReviewBusy } from './ClientReview';
import './ExportModal.css';

type ExportKind = 'static' | 'source';

const NO_EXPORTS: RecentExport[] = [];
/** More links to drafts than this are counted, with the list one click away. */
const LONG_LINK_LIST = 3;
/** More notes than this fold into the export's own row, so a success keeps its next step in view. */
const MANY_NOTES = 2;
const UNEXPECTED_FAILURE = 'The export could not be completed.';
/** Why the website card waits while the website tools are set up (#1395), said in the dialog and announced. */
const TOOLS_NOTE = 'SiteOrigin Builder is still setting up the website tools. The website can be exported once they are ready; the editable project can be exported now.';
const TOOLS_NOTE_SHORT = 'SiteOrigin Builder is still setting up the website tools. The website can be exported once they are ready.';
const NOT_STARTED = 'The export didn’t start, because a change isn’t saved yet. Save or discard it, then export again.';
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
  const owner = l.owner as { kind: 'page' | 'shell' | 'template' | 'archive'; id: string };
  const s = getState();
  const st = s.snapshot?.state;
  const tree = st && treeFor(st, owner);
  if (!tree?.nodes[l.nodeId]) return toast('That link is no longer on the site.', 'info');
  // A link in a collection's layout is shown on one of its entries; one in its archive layout, on its index.
  if (owner.kind === 'template' || owner.kind === 'archive') {
    if (owner.kind === 'template') openLayout(owner.id, l.shownOn);
    else if (!showArchiveLayout(owner.id)) return toast('That link is no longer on the site.', 'info');
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

/**
 * Every page the website publishes and leaves out, one click away, for a site whose pages the website card counts
 * rather than names: the lists can't go in the card, which is itself the button that starts the export.
 */
function PageLists({ published, drafts }: { published: PageDoc[]; drafts: PageDoc[] }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="export-pages" data-testid="export-page-lists">
      <button type="button" className="btn btn-sm btn-ghost export-pages-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} /> Review all pages
      </button>
      <div id={listId} className="export-pages-all" hidden={!open}>
        <PageList title="Published" pages={published} />
        {drafts.length > 0 && <PageList title="Left out as drafts" pages={drafts} />}
      </div>
    </div>
  );
}

/** Where the site's publisher's contact details are set: Site settings, under Published by. */
const IDENTITY = { kind: 'site', field: 'identity' } as const;
const IDENTITY_NAMES: Record<SampleIdentityField, string> = { email: 'Email', telephone: 'Telephone', address: 'Address' };

/**
 * What keeps visitors from reaching the author, in one box: each form on the website that visitors cannot send (in
 * Project health's words, which name its page) with the way to its settings, and the starter's sample contact details
 * still on it, on one line. Neither stops the export: a work in progress can still go out on purpose. Review on the
 * sample details opens each one, to see where it is, replace it everywhere at once, or keep it, which this project
 * remembers.
 */
function VisitorReview({ forms, groups, kept, disabled, readOnly, onSettle }: { forms: ExportNote[]; groups: SampleContactGroup[]; kept: SampleContactGroup[]; disabled: boolean; readOnly: boolean; onSettle: () => void }) {
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The sample details' own choices are one click away, behind Review.
  const [samplesOpen, setSamplesOpen] = useState(false);
  // A job that starts folds them away again: their actions wait for it.
  useEffect(() => {
    if (disabled) setSamplesOpen(false);
  }, [disabled]);
  if (!forms.length && !groups.length && !kept.length) return null;
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
  // A kept detail goes away: focus moves to the same decision on the detail that took its place, else the one above it,
  // else the way to review the kept details again.
  const keepAt = (i: number) => {
    const keeps = usable('.export-samples-list > li .export-review-keep');
    return keeps[i] ?? keeps[i - 1] ?? usable('.export-samples-kept button')[0];
  };
  const keptLine = kept.length > 0 && (
    <p className="export-samples-kept" data-testid="export-samples-kept">
      <CircleCheck aria-hidden />
      <span>
        {kept.length === 1 ? `${kept[0].value} is kept as you chose.` : `${kept.length} sample contact details are kept as you chose.`}{' '}
        <button className="link-btn" disabled={disabled || readOnly} onClick={() => (keepSamples(kept.map((g) => g.value), false), setSamplesOpen(true), settle(() => usable(`.export-samples-list > [data-testid="export-sample-${kept[0].kind}"] .export-review-actions .btn`)[0] ?? usable('.export-samples-list .btn')[0]))}>
          Review {kept.length === 1 ? 'it' : 'them'} again
        </button>
      </span>
    </p>
  );
  const headId = `${baseId}-head`;
  const samplesId = `${baseId}-samples`;
  const samplesLineId = `${samplesId}-line`;
  return (
    <div ref={rootRef} className="export-visitors">
      {(forms.length > 0 || groups.length > 0) && (
        <section className="export-review" data-testid="export-visitor-review" aria-labelledby={headId}>
          <div className="export-review-head">
            <TriangleAlert aria-hidden />
            <strong className="grow" id={headId}>
              Visitors can’t reach you yet
            </strong>
          </div>
          <ul className="export-review-list">
            {forms.map((n, i) => (
              <li key={n.destination?.kind === 'form' ? `${n.destination.owner.kind}:${n.destination.owner.id}:${n.destination.nodeId}` : i} data-testid="export-form-note">
                <div className="export-review-row">
                  <span className="export-review-what" id={`${baseId}-form-${i}`}>
                    {n.message}
                  </span>
                  <div className="export-review-actions">
                    {n.destination && (
                      <button className="btn btn-sm" disabled={disabled} aria-describedby={`${baseId}-form-${i}`} onClick={() => openEditorDestination(n.destination!)}>
                        {destinationLabel(n.destination)}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
            {groups.length > 0 && (
              <li data-testid="export-sample-contacts">
                <div className="export-review-row">
                  <span className="export-review-what" id={samplesLineId}>
                    {sampleContactsLine(groups.map((g) => g.value))}
                  </span>
                  <div className="export-review-actions">
                    {/* While a job runs the details' actions wait, so there is nothing to open. */}
                    <button type="button" className="btn btn-sm export-review-toggle" disabled={disabled} aria-expanded={samplesOpen} aria-controls={samplesId} aria-describedby={samplesLineId} onClick={() => setSamplesOpen(!samplesOpen)}>
                      <ChevronRight size={14} aria-hidden />
                      {samplesOpen ? 'Hide' : 'Review'}
                    </button>
                  </div>
                </div>
                <ul className="export-samples-list" id={samplesId} hidden={!samplesOpen}>
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
                                · {sampleWhere(g)}.
                              </span>
                            </span>{' '}
                            {/* Beside the places it reveals, so the row stays one decision wide. */}
                            <button type="button" className="export-inline-toggle" aria-expanded={shown} aria-controls={listId} aria-describedby={nameId} onClick={() => setOpen(shown ? null : g.kind)}>
                              Show where
                              <ChevronRight size={13} aria-hidden />
                            </button>
                          </div>
                          <div className="export-review-actions">
                            {/* Site settings' Published by is changed there, not by Find and Replace. */}
                            {g.matches.length > 0 && (
                              <button className="btn btn-sm" disabled={disabled} aria-describedby={nameId} onClick={() => setState({ modal: { kind: 'find', query: g.value, sample: g.kind } })}>
                                {g.identity ? 'Replace on pages…' : 'Replace everywhere…'}
                              </button>
                            )}
                            {g.identity && (
                              <button className="btn btn-sm" disabled={disabled} aria-describedby={nameId} onClick={() => openEditorDestination(IDENTITY)}>
                                {destinationLabel(IDENTITY)}
                              </button>
                            )}
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
                          {g.identity && (
                            <li key="identity">
                              <span className="grow">Site settings › Published by › {IDENTITY_NAMES[g.identity]}</span>
                              <button className="btn btn-sm btn-ghost" disabled={disabled} aria-label={`Open Site settings › Published by › ${IDENTITY_NAMES[g.identity]}`} onClick={() => openEditorDestination(IDENTITY)}>
                                Open
                              </button>
                            </li>
                          )}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              </li>
            )}
          </ul>
        </section>
      )}
      {keptLine}
    </div>
  );
}

/**
 * Everything else Project health lists, as one counted line with the way there: the search and sharing findings, and
 * the project's other notes. Each is fixed in Project health, and none of them stops the export. With nothing to count,
 * there is no line.
 */
function HealthSummary({ notes, disabled }: { notes: HealthNotes; disabled: boolean }) {
  const lineId = useId();
  const text = healthNotesText(notes);
  if (!text) return null;
  return (
    <p className="export-health" data-testid="export-health-summary">
      <span id={lineId}>{text}</span>
      <button type="button" className="link-btn export-health-go" disabled={disabled} aria-describedby={lineId} onClick={() => setState({ modal: notes.atSeo ? { kind: 'health', section: 'seo' } : { kind: 'health' } })}>
        Review in Project health
        <ChevronRight size={13} aria-hidden />
      </button>
    </p>
  );
}

/** What an export note says once what it describes was put right after the export: the files need exporting again. */
function fixedSince(note: ExportNote, state: 'fixed' | 'gone'): string {
  if (note.destination?.kind === 'site') return 'Public URL set since this export. Export again to publish with the new address.';
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

/**
 * What the dialog lists to fix besides the export's own notes: the starter's sample contact details not kept on purpose,
 * and what keeps the website from being found or shared. A result never says "Nothing to fix." over them.
 */
function listedFixes(state: ProjectState, kept: readonly string[], diagnostics: readonly Diagnostic[]): string[] {
  const notes = healthNotesOf(state, diagnostics);
  return dialogFixes({ samples: sampleGroups(state).flatMap((g) => (kept.includes(g.value) ? [] : [g.value])), seo: notes.seo, other: notes.otherDue });
}

/** What Project health lists beside what the dialog shows itself, counted once each (healthNotes). */
function healthNotesOf(state: ProjectState, diagnostics: readonly Diagnostic[]): HealthNotes {
  const audit = auditForHealth(state);
  return healthNotes({ seo: audit.ok ? audit.findings : [], diagnostics, shown: websiteFormProblems(state) });
}

export function ExportModal() {
  // A read-only question changes nothing, so exporting goes on while it runs.
  // An edit request in the chat, or the project held for the AI: either way the export waits for it.
  const aiBusy = useStore((s) => !!editRunStatus(s) || !!s.snapshot?.aiBusy);
  const awaiting = useStore((s) => s.runStatus === 'awaiting-input');
  const conflicts = useStore((s) => s.snapshot?.conflicts.length ?? 0);
  // A code component whose file was deleted outside the app is named (#1540), not left as "a project file".
  const deletedCode = useStore((s) => {
    const components = s.snapshot?.state.components;
    if (!components) return null;
    const held = s.snapshot!.conflicts.find((c) => c.deletedCode && Object.hasOwn(components, c.deletedCode.definitionId) && components[c.deletedCode.definitionId].sourcePath === c.path);
    return held ? components[held.deletedCode!.definitionId].name : null;
  });
  // One opened without its file is named too, and holds both exports back as a conflict does.
  const missingCode = useStore((s) => s.snapshot?.diagnostics.find((d) => d.code === 'CODE_SOURCE_MISSING')?.message ?? null);
  const heldBack = conflicts > 0 || !!missingCode;
  const conflictText = missingCode && !deletedCode && !conflicts ? missingCode : deletedCode ? `The file of the code component “${deletedCode}” was deleted outside SiteOrigin Builder. Put it back or remove the component in Project health first.` : 'A project file changed outside SiteOrigin Builder. Resolve it in Project health first.';
  // Kept by the project, not this dialog: closing and reopening it still shows what was handed off.
  const recent = useStore((s) => s.snapshot?.recentExports ?? NO_EXPORTS);
  const state = useStore((s) => s.snapshot?.state);
  // What the website export publishes, worked out the way the export itself does.
  const plan = useMemo(() => (state ? publicationPlan(state) : null), [state]);
  const draftLinks = plan?.draftLinks ?? [];
  const draftTargets = new Set(draftLinks.map((l) => l.pageId ?? `entry:${l.entryId}`)).size;
  // The starter's sample contact details the website would publish: reviewed, apart from those kept on purpose.
  const keptValues = useStore((s) => s.keptSamples);
  // Export builds from the project folder and needs its lock, so a read-only project exports nothing (controller.ts).
  const readOnlyReason = useStore((s) => s.snapshot?.readOnly?.reason ?? null);
  const readOnly = readOnlyReason !== null;
  // The website is built with the project's website tools, so its export waits while they are set up or reinstalled
  // (#1395); the editable project needs none. Only that: a preview still starting has its tools ready. (A read-only
  // project is preparing a copy to preview, and exports nothing anyway.)
  const toolsSettingUp = useStore((s) => s.runtime.state === 'preparing') && !readOnly;
  const samples = useMemo(() => (state ? sampleGroups(state) : []), [state]);
  const samplesToReview = samples.filter((g) => !keptValues.includes(g.value));
  const samplesKept = samples.filter((g) => keptValues.includes(g.value));
  // The website's contact forms visitors cannot send, as the website export would name them, and where to fix each.
  const formNotes = useMemo(() => (state ? websiteFormNotes(state) : []), [state]);
  // What else Project health lists, counted once each beside the forms named here: what keeps the website from being
  // found or shared (as its Search & AI readiness says it), its suggestions, and the project's other notes.
  const diagnostics = useStore((s) => s.snapshot?.diagnostics);
  const health = useMemo(() => (state ? healthNotesOf(state, diagnostics ?? []) : null), [state, diagnostics]);
  // What the website card says it publishes: pages named when the list is short and counted when it is long.
  const pagesText = useMemo(() => (plan ? pagesSummaryText(plan) : null), [plan]);
  // What the website shows now, read once for every note about an earlier export.
  const liveTrees = useMemo(() => (state ? websiteTrees(publishedState(state)) : []), [state]);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  // Client review pages (#1134) work on their own, in their own section; nothing else starts while they do.
  const [reviewBusy, setReviewBusy] = useState<ReviewBusy | null>(null);
  const workspaceKey = useStore((s) => s.snapshot?.workspaceKey);
  // Each report carries its own id, shown on the result (data-report): the same report drawn again after a cancelled
  // retry keeps its id, a new one (even with the same words) gets another, so a test can tell them apart.
  const [result, setResult] = useState<(ExportResult & { report: string; fixesListed?: string[] }) | null>(null);
  const [format, setFormat] = useState<ExportFormat>('folder');
  const linksId = useId();
  const [linksOpen, setLinksOpen] = useState(false);
  // A long list, or a window too short to spare the room, folds behind a disclosure; otherwise there is none to focus.
  const shortWindow = useShortWindow();
  const longLinks = draftLinks.length > LONG_LINK_LIST || shortWindow;
  // Anything that would close or replace the dialog, or change what an export makes, waits for either kind of work.
  const locked = !!busy || !!reviewBusy;
  const close = () => !locked && setState({ modal: null });
  const blocked = readOnly || aiBusy || heldBack;
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
  const hostingId = useId();
  // The page a failed build names by its address, when exactly one page has it: the author's way back to fix it.
  const failedPage = useMemo(() => {
    if (!shown || shown.ok || !state) return null;
    const named = Object.values(state.pages).filter((p) => shown.message.includes(`(${p.route})`));
    return named.length === 1 ? named[0] : null;
  }, [shown, state]);
  const fix = failedPage ? (
    <button className="btn btn-sm btn-primary export-fix" disabled={!!reviewBusy} onClick={() => openFailedPage(failedPage.id)}>
      Open the {failedPage.title} page
    </button>
  ) : shown && !shown.ok && shown.assetId ? (
    <button className="btn btn-sm btn-primary export-fix" disabled={!!reviewBusy} onClick={() => openAsset(shown.assetId!)}>
      Open in Assets
    </button>
  ) : null;
  const [notesOpen, setNotesOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const choiceRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // The first control the author can see and use: never one folded away or unavailable. What the body lists to see to
  // comes first; with nothing there (the recent exports are further down, not a place to start), the format the
  // exports save as, then Close. Never a card, which would start an export.
  const firstControl = () =>
    [
      ...(rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([aria-disabled="true"])') ?? []),
      ...(choiceRef.current?.querySelectorAll<HTMLElement>('[role="radio"][aria-checked="true"]:not(:disabled)') ?? []),
      ...(closeButtonRef.current && !closeButtonRef.current.disabled ? [closeButtonRef.current] : [])
    ].find((b) => !b.closest('.export-history, .client-review') && b.offsetParent !== null);
  // The dialog opens on its first control in the body, which can be a recent export below everything the body says.
  useEffect(() => {
    if (!document.activeElement?.closest('.export-history, .client-review')) return;
    firstControl()?.focus();
    rootRef.current?.parentElement?.scrollTo({ top: 0 });
  }, []);
  // Said once when it changes: a note that simply appears or disappears is not reliably announced.
  // With something else also in the way, the AI's note can't promise an export once it finishes: it says the export
  // waits, and the other note says what else to do.
  const otherBlocker = heldBack || draftLinks.length > 0 || toolsSettingUp;
  const aiNote = otherBlocker
    ? awaiting
      ? 'The AI is waiting for your answer in the AI panel. Exporting waits until you answer and it finishes.'
      : 'The AI is making changes. Exporting waits until it finishes.'
    : awaiting
      ? aiAwaiting('export')
      : aiChanging('export');
  const availability = readOnlyReason ?? (aiBusy ? aiNote : heldBack ? (deletedCode || !conflicts ? conflictText : 'A project file changed outside SiteOrigin Builder. Resolve it in Project health before exporting.') : draftLinks.length ? 'The website cannot be exported until its links to drafts are changed. The editable project can still be exported.' : toolsSettingUp ? TOOLS_NOTE : 'Both exports are available.');
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
    // The count line goes too once Project health has nothing left, which can change without the project (a missing
    // file restored on disk).
  }, [availability, longLinks, state, health?.seo, health?.other]);
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
    if (busy || reviewBusy || blocked || (kind === 'static' && (draftLinks.length || toolsSettingUp))) return;
    setBusy(kind);
    const opening = getState().snapshot?.workspaceKey;
    try {
      // What is still being typed (an edit on the canvas, a field) is saved first, so the export holds what is on
      // screen. Something that can't be saved stops it before anything is asked or written, and is said here.
      const started = await afterEditsSettle(
        () => settleEdits(),
        // The website is built only if it still publishes the pages and entries counted here.
        async () => (getState().snapshot?.workspaceKey !== opening ? null : kind === 'static' ? await api.project.exportStatic(format, plan ? publicationIds(plan) : undefined) : await api.project.exportSource(format))
      );
      if (!started.ok) {
        settle.current = 'result';
        setResult({ ok: false, message: NOT_STARTED, warnings: started.problems, report: newReportId() });
        return;
      }
      const r = started.value;
      // The project closed while its edits were being saved: nothing was exported.
      if (!r) return;
      // What the dialog lists to fix beside the export's own notes, said with its result in the dialog's words. It is
      // read once the export returns, from the project as it is then, so an edit made while the folder was being chosen
      // or the edits were saving (which the export carries) is never contradicted.
      const now = getState();
      if (r.message) setResult({ ...r, report: newReportId(), fixesListed: r.ok && now.snapshot ? listedFixes(now.snapshot.state, now.keptSamples, now.snapshot.diagnostics) : undefined });
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
  const blockedBy = [readOnly && 'export-blocked-read-only', aiBusy && !readOnly && 'export-blocked-ai', heldBack && 'export-blocked-conflict'].filter(Boolean) as string[];
  const websiteBlockedBy = [...blockedBy, ...(draftLinks.length ? ['export-draft-links-summary'] : []), ...(toolsSettingUp ? ['export-blocked-tools'] : [])];
  const websiteUnavailable = blocked || draftLinks.length > 0 || toolsSettingUp;
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
                      <NoteLine key={n} note={note} project={state} forms={formNotes} trees={liveTrees} disabled={locked} />
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

  // The two exports and the format they save as. They sit in the dialog's footer, so they stay in view and in reach
  // however much the body lists above them. With a fix to make first, the website card's export is no longer the primary
  // action.
  const choice = (
    <div className={`export-choice${fix ? ' has-fix' : ''}`} role="group" aria-labelledby="export-choice-title" ref={choiceRef}>
      <div className="export-choice-head">
        <h3 id="export-choice-title">Choose an export</h3>
        <div className="export-format">
          <span>Save as</span>
          {/* A fieldset locks both format buttons during a build, and while a conflict stops both exports. */}
          <fieldset className="export-format-control" role="presentation" disabled={locked || heldBack}>
            <Segmented
              radio
              label="Save as"
              value={format}
              onChange={(v) => !locked && setFormat(v)}
              options={[
                { value: 'folder', label: 'Folder' },
                { value: 'zip', label: 'ZIP file' }
              ]}
            />
          </fieldset>
        </div>
      </div>
      <button ref={(el) => void (buttons.current.static = el)} className={`action-card export-card${cardState('static')}`} aria-disabled={!!busy || !!reviewBusy || websiteUnavailable || undefined} aria-describedby={websiteBlockedBy.join(' ') || undefined} onClick={() => void run('static')}>
        <span className="ico"><Globe size={18} /></span>
        <span className="grow">
          <span className="export-card-title">
            <strong>Website files, ready to upload</strong>
            {cardEnd('static', websiteUnavailable)}
          </span>
          {pagesText ? (
            <>
              <span className="export-card-line" data-testid="export-pages">
                {pagesText.published.lead}
                {pagesText.published.rest}
              </span>
              {pagesText.drafts && (
                <span className="export-card-line export-card-drafts" data-testid="export-drafts">
                  {pagesText.drafts.lead}
                  {pagesText.drafts.rest}
                </span>
              )}
            </>
          ) : (
            <span className="export-card-line">Every published page as a finished website, for any web host.</span>
          )}
          <span className="export-card-line export-card-photos" data-testid="export-photo-privacy">
            <MapPinOff aria-hidden /> <span>Removes where each photo was taken and the camera details. Credits, copyright, orientation and color stay.</span>
          </span>
        </span>
      </button>
      <button ref={(el) => void (buttons.current.source = el)} className={`action-card export-card secondary${cardState('source')}`} aria-disabled={!!busy || !!reviewBusy || blocked || undefined} aria-describedby={blockedBy.join(' ') || undefined} onClick={() => void run('source')}>
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
  );

  return (
    <Modal
      title="Export your website"
      icon={<Upload />}
      describedBy={succeeded ? undefined : readOnly ? 'export-blocked-read-only' : aiBusy ? 'export-blocked-ai' : heldBack ? 'export-blocked-conflict' : draftLinks.length ? 'export-draft-links-summary' : toolsSettingUp ? 'export-blocked-tools' : undefined}
      onClose={close}
      busy={!!busy || !!reviewBusy}
      footer={
        <>
          {!succeeded && choice}
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
          <button ref={closeButtonRef} className="btn" onClick={close} disabled={!!busy || !!reviewBusy}>
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
            <div ref={resultRef} tabIndex={-1} className={`scope-note export-result ${shown.ok ? 'shared' : 'danger'}`} role={shown.ok ? 'status' : 'alert'} data-report={shown.report} aria-describedby={shown.ok && shown.hosting ? hostingId : undefined}>
              {shown.ok ? <CircleCheck /> : <CircleAlert />}
              <div className="export-note-body">
                <strong>{shown.message}</strong>
                {/* On success the newest recent export, directly below, already shows this path. */}
                {shown.path && recent[0]?.path !== shown.path && <ExportPath path={shown.path} />}
                {shown.ok &&
                  shown.fixesListed?.map((line, i) => (
                    <span className="export-note-line" key={`listed-${i}`}>
                      • {line}
                    </span>
                  ))}
                {notesInRow ? (
                  <span>{shown.warnings.length === 1 ? '1 note to review below.' : `${shown.warnings.length} notes to review below.`}</span>
                ) : nothingToFix(shown) ? (
                  <span className="export-clean">Nothing to fix.</span>
                ) : (
                  shown.warnings.map((w, i) => (
                    <span className="export-note-line" key={i}>
                      • {w}
                    </span>
                  ))
                )}
                {!shown.ok && shown.details && <span className="export-note-next">{shown.message === UNEXPECTED_FAILURE || shown.message === BUILD_FAILED_UNPLACED ? 'Try exporting again. If it keeps failing, use Copy details and send the report to your developer or support.' : 'Check the page or component named above in the editor, then export again. If you can’t fix it, use Copy details and send the report to your developer or support.'}</span>}
              </div>
            </div>
            {/* Guidance for the host, not a note about the website: it is never counted among the notes to review. */}
            {shown.ok && shown.hosting && (
              <div className="scope-note info export-hosting-guide" id={hostingId} data-testid="export-hosting">
                <Info aria-hidden />
                <span className="export-note-body">
                  <strong>Publishing it</strong>
                  <span>{shown.hosting}</span>
                </span>
              </div>
            )}
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
            {/* A state, not a fault: read-only or the AI at work, said as every dialog says it; `availability` announces the change. */}
            {readOnly ? (
              <BlockedNote block={readOnlyBlock({ readOnly: { reason: readOnlyReason } })!} id="export-blocked-read-only" live={false} className="export-blocker" />
            ) : (
              aiBusy && <BlockedNote block={{ kind: 'ai', text: aiNote }} id="export-blocked-ai" live={false} className="export-blocker" />
            )}
            {heldBack && (
              <div className="scope-note danger export-blocker">
                <CircleAlert />
                <span className="export-note-body export-blocker-text" id="export-blocked-conflict">
                  <strong>Both exports are unavailable.</strong>
                  <span>
                    {conflictText}
                    {aiBusy && ' You can open Project health once the AI finishes.'}
                  </span>
                </span>
                {!aiBusy && !locked && (
                  <button className="btn btn-sm btn-primary" aria-describedby="export-blocked-conflict" onClick={() => setState({ modal: { kind: 'health' } })}>
                    Open project health
                  </button>
                )}
              </div>
            )}
            {toolsSettingUp && (
              <div className="scope-note info export-blocker" data-testid="export-blocked-tools">
                <Info aria-hidden />
                <span className="export-note-body export-blocker-text" id="export-blocked-tools">
                  {/* With something else in the way too, its own note says what else waits. */}
                  {blocked || draftLinks.length > 0 ? TOOLS_NOTE_SHORT : TOOLS_NOTE}
                </span>
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
                            <button className="btn btn-sm" disabled={locked} aria-label={`Open ${said} in the inspector`} aria-describedby="export-draft-links-summary" onClick={() => openDraftLink(l)}>
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
            {state && <VisitorReview forms={formNotes} groups={samplesToReview} kept={samplesKept} disabled={locked} readOnly={readOnly} onSettle={() => firstControl()?.focus()} />}
            {health && <HealthSummary notes={health} disabled={locked} />}
            {plan && pagesText?.long && <PageLists published={plan.published} drafts={plan.drafts} />}
            {history}
            {state && <ClientReview key={workspaceKey} state={state} workspaceKey={workspaceKey} blocked={websiteUnavailable} otherBusy={!!busy} busy={reviewBusy} onBusy={setReviewBusy} />}
          </>
        )}
      </div>
    </Modal>
  );
}
