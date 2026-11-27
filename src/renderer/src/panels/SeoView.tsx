import './SeoView.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, Check, EyeOff, FileText, Info, LayoutList, Lock, X, House, Newspaper, SearchCheck, TriangleAlert } from 'lucide-react';
import type { ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import { leaveSeoView, setState, useStore } from '../store';
import { seoDocument, seoDocuments, seoSubjectKey, type SeoDocument } from '../lib/seo-view';
import { seoOverviewOnce, seoOverviewProblems, type SeoImageStatus, type SeoOverviewLevel, type SeoOverviewProblem, type SeoOverviewRow, type SeoOverviewText } from '../lib/seo-overview';
import { isDraftPage } from '@generator/index';
import { isReadOnlyCollection } from '../lib/content';
import { activeWorkspace } from '../lib/workspace';
import { leaveField } from '../lib/leave-field';
import { SeoPreview, useDocumentPreview, useTypedSeo, type TypedSeoOn } from './SeoPreview';
import type { DocumentPreview } from '../lib/seo-preview';
import { StructuredDataFields } from '../components/StructuredDataFields';
import { PageSearchFields } from './PageSearchFields';
import { pageUpdater } from '../lib/page-settings';
import { LockedFields, useLockedFields } from '../components/ui';
import { postAt } from '../lib/posts';
import { savePostSeo } from '../lib/post-seo';
import { PostSearchFields } from './PostSearchFields';
import { Hideable, useShownValue } from '../lib/hideable';

/**
 * The SEO view's list (#700), in the sidebar: every page of the site in its page order, then each collection's entries
 * in the collection's order, drafts included. Choosing one makes it the view's document; nothing on the canvas changes.
 * The list is one stop in the Tab order: the chosen row (else the first), and the arrow keys, Home and End move between
 * rows across the groups.
 */
export function SeoPanel() {
  const snap = useStore((s) => s.snapshot);
  const subject = useStore((s) => s.seoSubject);
  const state = snap?.state;
  const groups = useMemo(() => (state ? seoDocuments(state) : []), [state]);
  // Where each document stands, as the overview says it, so the list shows it beside each row.
  const rows = state ? seoOverviewOnce(state) : [];
  const levels = new Map(rows.map((r) => [r.key, r.level]));
  const toFix = rows.filter((r) => r.level === 'warning').length;
  const listRef = useRef<HTMLDivElement>(null);
  const chosen = subject ? seoSubjectKey(subject) : OVERVIEW_KEY;
  const keys = [OVERVIEW_KEY, ...groups.flatMap((g) => g.documents.map((d) => d.key))];
  // The row last focused while it is still listed, else the chosen one, else the first.
  const [focused, setFocused] = useState<string | null>(null);
  const stop = focused && keys.includes(focused) ? focused : chosen && keys.includes(chosen) ? chosen : (keys[0] ?? null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = keys.indexOf((e.target as HTMLElement).dataset.seo ?? '');
    if (i < 0) return;
    const n = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : null;
    if (n === null || n < 0 || n >= keys.length) return;
    e.preventDefault();
    listRef.current?.querySelector<HTMLElement>(`[data-seo="${CSS.escape(keys[n])}"]`)?.focus();
  };
  // The chosen document's row is brought into view when another panel opens the view on it, without taking focus.
  useEffect(() => {
    if (!listRef.current?.offsetParent) return;
    listRef.current.querySelector<HTMLElement>(`[data-seo="${CSS.escape(chosen)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [chosen]);
  if (!state) return null;
  return (
    <div className="seo-panel">
      <div className="panel-head">
        <h3>SEO</h3>
      </div>
      <div className="panel-body" ref={listRef} onKeyDown={onKey}>
        <div className={`seo-row seo-row-overview${chosen === OVERVIEW_KEY ? ' current' : ''}`}>
          <button
            className="seo-open"
            data-seo={OVERVIEW_KEY}
            tabIndex={stop === OVERVIEW_KEY ? 0 : -1}
            aria-current={chosen === OVERVIEW_KEY || undefined}
            onFocus={() => setFocused(OVERVIEW_KEY)}
            onClick={() => setState({ seoSubject: null })}
          >
            <span className="seo-row-title">
              <LayoutList aria-hidden="true" />
              <span className="ellipsis">Overview</span>
            </span>
            <span className="seo-row-meta">{toFix ? `${plural(toFix, 'page or post', 'pages and posts')} to fix` : 'Nothing to fix'}</span>
          </button>
        </div>
        {groups.map((g) => (
          <section key={g.id} className="seo-group" aria-labelledby={`seo-group-${g.id}`}>
            <h4 id={`seo-group-${g.id}`} className="seo-group-head">
              {g.label}
            </h4>
            {g.documents.length ? (
              <ul className="seo-list" aria-labelledby={`seo-group-${g.id}`}>
                {g.documents.map((d) => (
                  <li key={d.key} className={`seo-row${d.key === chosen ? ' current' : ''}`}>
                    <button
                      className="seo-open"
                      data-seo={d.key}
                      tabIndex={d.key === stop ? 0 : -1}
                      aria-current={d.key === chosen || undefined}
                      title={d.address}
                      onFocus={() => setFocused(d.key)}
                      onClick={() => setState({ seoSubject: d.subject })}
                    >
                      <span className="seo-row-title">
                        {d.home && <House role="img" aria-label="Home page" />}
                        <span className="ellipsis">{d.title}</span>
                        <LevelMark level={levels.get(d.key)} draft={d.draft} />
                      </span>
                      <span className="seo-row-meta">
                        <span className="seo-row-address ellipsis">{d.address}</span>
                        {d.draft && <span className="badge amber">Draft</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="seo-note">The site has no pages yet.</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/** The sidebar list's first row, the overview, as a key among the documents' keys. */
const OVERVIEW_KEY = 'overview';

/** A row's standing as a mark after its name in the sidebar: nothing when it is fine, or a draft (its badge says so). */
function LevelMark({ level, draft }: { level: SeoOverviewLevel | undefined; draft: boolean }) {
  if (level === 'warning') return <TriangleAlert className="seo-mark warn" role="img" aria-label="Something to fix" />;
  if (level === 'note') return <Info className="seo-mark note" role="img" aria-label="Worth a look" />;
  if (level === 'excluded' && !draft) return <EyeOff className="seo-mark quiet" role="img" aria-label="Kept out of search" />;
  return null;
}

/** What a document is, in words: the home page, a page, or an entry of its collection. */
function kindOf(d: SeoDocument, collectionName: string | undefined): string {
  if (d.subject.kind === 'page') return d.home ? 'Home page' : d.draft ? 'Draft page' : 'Page';
  const of = collectionName ? ` in ${collectionName}` : '';
  return `${d.draft ? 'Draft' : 'Published'}${of}`;
}

const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/** How a title or description measures up, in words, with the tone its status line shows in. */
function textNote(t: SeoOverviewText, field: 'title' | 'description', listed: boolean): { tone: 'warn' | 'note' | 'ok'; label: string; detail: string } {
  // A document search engines can't list has nothing wrong in search results yet: what it would need is a note.
  const warn = listed ? 'warn' : 'note';
  if (t.status === 'missing') return { tone: warn, label: field === 'title' ? 'No title' : 'No description', detail: '' };
  // The finding leads, in its tone; the count and where the words come from follow, quieter.
  const findings: string[] = [];
  let tone: 'warn' | 'note' | 'ok' = 'ok';
  if (t.duplicates > 0) {
    tone = warn;
    // A document search engines don't list repeats only the published ones they can: it would compete with them once listed.
    findings.push(`Same as ${plural(t.duplicates, listed ? 'other' : 'published one', listed ? 'others' : 'published ones')}`);
  }
  // A length is a note: beside a repeat (a warning) it is said in the quieter detail, so it never takes the amber.
  const length = t.status === 'short' ? 'Too short' : t.status === 'long' ? 'Too long' : '';
  if (length && !findings.length) findings.push(length);
  if (t.status !== 'good' && tone === 'ok') tone = 'note';
  const detail = [findings.length && length && findings[0] !== length ? length.toLowerCase() : '', plural(t.chars, 'character'), t.fallback ? (t.from === 'name' ? 'from its name' : t.from === 'excerpt' ? 'from the excerpt' : 'from the site’s description') : ''].filter(Boolean).join(' · ');
  return findings.length ? { tone, label: findings.join(' · '), detail } : { tone, label: detail, detail: '' };
}

const IMAGE_LABELS: Record<SeoImageStatus, string> = { own: 'Its own', featured: 'Featured image', site: 'Site image', none: 'None', gone: 'Missing from Assets' };

/** A problem in a few words, as the row's name and the document's findings lead with it. */
const PROBLEM_LABELS: Record<SeoOverviewProblem, string> = {
  'home-hidden': 'Home is hidden from search engines',
  'title-missing': 'No search title',
  'title-duplicate': 'Search title repeated',
  'description-missing': 'No description',
  'description-duplicate': 'Description repeated',
  'image-missing': 'No sharing image',
  'title-length': 'Search title length',
  'description-length': 'Description length'
};
const PROBLEM_ORDER = Object.keys(PROBLEM_LABELS) as SeoOverviewProblem[];
const WARNING_PROBLEMS: ReadonlySet<SeoOverviewProblem> = new Set(['home-hidden', 'title-missing', 'title-duplicate', 'description-missing', 'description-duplicate', 'image-missing']);

/** What a row leads with under its name: its first problem, how many more, or why search engines can't list it. */
function rowSummary(r: SeoOverviewRow): { tone: 'warn' | 'note' | 'quiet'; label: string } | null {
  if (r.level === 'excluded') return { tone: 'quiet', label: r.draft ? 'Kept out of search until published' : 'Kept out of search' };
  const problems = PROBLEM_ORDER.filter((p) => r.problems.includes(p));
  if (!problems.length) return null;
  // What follows the first: more to fix, or notes, said as such so a note never borrows a warning's weight.
  const rest = problems.slice(1);
  // As the document's findings rank them: for a document search engines can't list, only Home hidden is to fix.
  const notes = rest.filter((p) => !(p === 'home-hidden' || (r.listed && WARNING_PROBLEMS.has(p)))).length;
  const fixes = rest.length - notes;
  const more = [fixes ? `${fixes} more to fix` : '', notes ? plural(notes, 'note') : ''].filter(Boolean).join(' and ');
  return { tone: r.level === 'warning' ? 'warn' : 'note', label: `${PROBLEM_LABELS[problems[0]]}${more ? ` and ${more}` : ''}` };
}

/** A status line with its glyph: words always, a colour only where something is to fix. */
function Status({ tone, children, className = '' }: { tone: 'warn' | 'note' | 'ok' | 'quiet'; children: ReactNode; className?: string }) {
  const Icon = tone === 'warn' ? TriangleAlert : tone === 'note' ? Info : tone === 'ok' ? Check : EyeOff;
  return (
    <span className={`seo-ov-status ${tone} ${className}`}>
      <Icon aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/** Whether search engines may list a document, in words. */
function listing(r: SeoOverviewRow): { tone: 'warn' | 'ok' | 'quiet'; label: string } {
  // Short, under a column already named "Search engines"; the row's first cell says what it means for search results.
  if (r.noindex) return { tone: r.home ? 'warn' : 'quiet', label: 'Hidden' };
  if (r.draft) return { tone: 'quiet', label: 'Draft' };
  if (!r.listed) return { tone: 'quiet', label: 'Off the website' };
  // Allowed, not known to be: whether a search engine has listed it is beyond the editor.
  return { tone: 'ok', label: 'Can be listed' };
}

function TextCell({ t, field, listed }: { t: SeoOverviewText; field: 'title' | 'description'; listed: boolean }) {
  const note = textNote(t, field, listed);
  return (
    <td className="seo-ov-text">
      {/* Clamped to two lines: the whole of it is in the document's previews, a click away. */}
      {t.text ? <span className="seo-ov-words">{t.text}</span> : null}
      {/* A cell with nothing to say about its words says nothing, unless they are borrowed from elsewhere (the site's
          description, an excerpt): the count is in the document's meter. */}
      {note.tone === 'ok' ? (
        t.fallback && t.from !== 'name' ? <span className="seo-ov-status ok">{t.from === 'excerpt' ? 'From the excerpt' : 'From the site’s description'}</span> : null
      ) : (
        <Status tone={note.tone}>
          {note.label}
          {note.detail && <span className="seo-ov-detail"> · {note.detail}</span>}
        </Status>
      )}
    </td>
  );
}

/**
 * The SEO view's overview (#707), shown while no document is chosen: every page and post with its search title and
 * description and how each measures up, its sharing image and whether search engines may list it, the ones with
 * something to fix first. "Problems only" leaves out the rest; choosing a row opens that document in the view.
 */
function SeoOverview({ state, problemsOnly, onProblemsOnly, returnTo, onOpen }: { state: ProjectState; problemsOnly: boolean; onProblemsOnly: (on: boolean) => void; returnTo: { current: string | null }; onOpen: (row: SeoOverviewRow) => void }) {
  const all = seoOverviewOnce(state);
  const problems = useMemo(() => seoOverviewProblems(all), [all]);
  const rows = problemsOnly ? problems : all;
  const excluded = all.filter((r) => !r.listed).length;
  const fixes = all.filter((r) => r.level === 'warning').length;
  const notes = all.filter((r) => r.level === 'note').length;
  const ref = useRef<HTMLDivElement>(null);
  // Back from a document, focus goes to its row while it is still listed, else to the filter. Once only: the view
  // opened again later leaves focus where it was.
  useEffect(() => {
    const key = returnTo.current;
    returnTo.current = null;
    if (!key || !ref.current) return;
    const at = ref.current.querySelector<HTMLElement>(`[data-seo-row="${CSS.escape(key)}"] .seo-ov-open`) ?? ref.current.querySelector<HTMLElement>('.seo-ov-filter input');
    at?.focus();
    at?.scrollIntoView({ block: 'nearest' });
  }, [returnTo]);
  return (
    <div className="seo-ov" ref={ref}>
      <div className="seo-ov-head">
        <p className="seo-ov-summary">
          {plural(all.length, 'page or post', 'pages and posts')}
          {fixes ? ` · ${fixes} to fix` : ''}
          {notes ? ` · ${notes} worth a look` : ''}
          {!problems.length && all.length ? ' · nothing to fix' : ''}
          {excluded ? ` · ${excluded} kept out of search` : ''}
        </p>
        <label className="seo-ov-filter">
          <input type="checkbox" checked={problemsOnly} onChange={(e) => onProblemsOnly(e.target.checked)} /> Problems only
        </label>
      </div>
      {rows.length ? (
        <table className="seo-ov-table" aria-label="Search status of every page and post">
          <thead>
            <tr>
              <th scope="col">Page or post</th>
              <th scope="col">Search title</th>
              <th scope="col">Description</th>
              <th scope="col">Sharing image</th>
              <th scope="col">Search engines</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const listed = listing(r);
              const imageMissing = r.image === 'none' || r.image === 'gone';
              const summary = rowSummary(r);
              const where = r.collection ? `${r.collection} · ${r.address}` : r.address;
              return (
                <tr key={r.key} data-seo-row={r.key} data-level={r.level} className="seo-ov-row">
                  <th scope="row">
                    {/* The row's one action: its hit area covers the whole row (SeoView.css), so the row's highlight never promises more than it does. */}
                    <button className="seo-ov-open" title={`${r.name}\n${where}`} onClick={() => onOpen(r)}>
                      <span className="seo-ov-name">
                        {r.home && <House role="img" aria-label="Home page" />}
                        <span>{r.name}</span>
                        {r.draft && <span className="badge amber">Draft</span>}
                      </span>
                      <span className="seo-ov-where ellipsis">{where}</span>
                    </button>
                    {summary && (
                      <Status tone={summary.tone} className="seo-ov-lead">
                        {summary.label}
                      </Status>
                    )}
                  </th>
                  <TextCell t={r.title} field="title" listed={r.listed} />
                  <TextCell t={r.description} field="description" listed={r.listed} />
                  <td className="seo-ov-image">{imageMissing ? <Status tone={r.listed ? 'warn' : 'note'}>{IMAGE_LABELS[r.image]}</Status> : <span className="seo-ov-status ok">{IMAGE_LABELS[r.image]}</span>}</td>
                  <td>
                    <Status tone={listed.tone}>{listed.label}</Status>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="seo-ov-empty">{!all.length ? 'The site has no pages yet.' : problemsOnly && excluded ? 'No pages or posts need a fix. Those kept out of search are left out of this list.' : 'Nothing to fix: every page and post reads well in search results and when shared.'}</p>
      )}
    </div>
  );
}

/**
 * A post's Search & sharing settings in the view (#703), under its previews: the fields the post writer has, saved the
 * same way, whether or not the writer holds the post (savePostSeo). What they show as they are typed reaches the
 * previews and meters through `on`; `preview` is what the previews show now.
 */
function SeoViewPostSettings({ state, subject, preview, on }: { state: ProjectState; subject: Extract<SeoSubject, { kind: 'entry' }>; preview: DocumentPreview | null; on: TypedSeoOn }) {
  const headId = useId();
  const post = { collectionId: subject.collectionId, entryId: subject.entryId };
  const collection = Object.hasOwn(state.collections, post.collectionId) ? state.collections[post.collectionId] : undefined;
  const entry = postAt(state, post);
  if (!collection || !entry) return null;
  return (
    <div className="seo-settings">
      <section className="seo-settings-group" aria-labelledby={headId}>
        <h3 id={headId}>Search & sharing</h3>
        <PostSearchFields state={state} collection={collection} entry={entry} doc={preview} on={on} save={(edit) => savePostSeo(post, edit)} ids="seo-view" />
      </section>
    </div>
  );
}

/**
 * A page's Search & sharing and structured data settings in the view (#702): the Inspector's own fields, saving through
 * the same operations under the same labels, with what is typed in them reported through `on` for the previews beside
 * them. They are on screen only while the view is in front, and the Inspector shows the page's fields only while it is
 * not, so the page's text is never in two fields at once: text refused for being too long goes with the field, and
 * comes back wherever the field shows next. While they are away, nothing typed is laid over the previews.
 */
function SeoViewPageSettings({ state, pageId, on, preview }: { state: ProjectState; pageId: string; on: TypedSeoOn; preview: DocumentPreview | null }) {
  const locked = useLockedFields();
  useEffect(() => () => on.clear(), [on]);
  if (!Object.hasOwn(state.pages, pageId)) return null;
  const page = state.pages[pageId];
  const upd = pageUpdater(page);
  return (
    <div className="seo-settings">
      <section className="seo-settings-group" aria-labelledby="seo-view-search-head">
        <h3 id="seo-view-search-head">Search & sharing</h3>
        <PageSearchFields page={page} state={state} draft={isDraftPage(state, page)} upd={upd} on={on} doc={preview} ids="seo-view" />
      </section>
      <section className="seo-settings-group" aria-labelledby="seo-view-structured-head">
        <h3 id="seo-view-structured-head">Structured data</h3>
        <p className="field-hint">What the page is for search engines: a service, product, event or guide, with its facts.</p>
        <fieldset className="seo-field-group" disabled={locked}>
          <StructuredDataFields page={page} upd={upd} />
        </fieldset>
      </section>
    </div>
  );
}

/**
 * One document in the view, which holds what is typed for it and not saved yet: one per document and opening (see
 * SeoView's key), so nothing of one document (its surface, its typed text, its structured data) shows for another. Its
 * previews (#701) read the same answers as the previews beside its settings in the Inspector, with that typed text laid
 * over the saved settings; a page's settings sit beside them (#702), and a post's under them (#703).
 */
function SeoViewDocument({ state, doc, collection, shown, locked }: { state: ProjectState; doc: SeoDocument; collection: string | undefined; shown: boolean; locked: boolean }) {
  const { typed, on } = useTypedSeo(doc.key);
  // Put away, the view's findings and previews are held as they were (lib/hideable), worked out from the project as it
  // last showed: they are for reading alone, and each change would work them out over the whole site. Its settings stay
  // live, since the post writer reads what they could not save, and they follow what the project saves meanwhile.
  const seen = useShownValue(state, !shown);
  const { overlay, doc: preview } = useDocumentPreview(seen, doc.subject, typed);
  const page = doc.subject.kind === 'page' ? doc.subject.pageId : null;
  // A post synced from an external source is changed there, as the post writer says, whatever the project allows.
  const synced = doc.subject.kind === 'entry' && isReadOnlyCollection(Object.hasOwn(state.collections, doc.subject.collectionId) ? state.collections[doc.subject.collectionId] : undefined);
  const settingsLocked = locked || synced;
  // What the overview says of it, carried here so a finding is in sight, a click from the field that fixes it.
  const row = useMemo(() => seoOverviewOnce(seen).find((r) => r.key === doc.key), [seen, doc.key]);
  const findings = row ? docFindings(row) : [];
  const reason = row && !row.listed && !doc.draft ? (row.noindex ? 'It asks search engines to leave it out of their results, so the search result below is how it would show if they listed it. Shared links still show it: see Link preview.' : 'It is not on the website, so search engines and link previews don’t see it.') : null;
  const settingsRef = useRef<HTMLDivElement>(null);
  /** Bring a field into view and put the cursor in it, as a finding's link does. */
  const goTo = (field: FindingField) => {
    const box = settingsRef.current;
    let el = field === 'image' ? box?.querySelector<HTMLElement>('[data-seo-field="socialImage"]') : box?.querySelector<HTMLElement>(`#seo-view-${field}`);
    if (field === 'image') el = el?.querySelector<HTMLElement>('button:not(:disabled)') ?? el;
    // A locked control can't take focus: its row or group does, so the jump still lands on what it shows.
    if (el && (el as HTMLButtonElement).disabled) el = el.closest<HTMLElement>('.switch-row, [data-seo-field]') ?? el;
    if (el && el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.tabIndex = -1;
    (el ?? box?.querySelector<HTMLElement>('h3'))?.scrollIntoView({ block: 'center' });
    el?.focus({ preventScroll: true });
  };
  return (
    <div className="seo-doc" data-seo-doc={doc.key}>
      <Hideable hidden={!shown}>
      <div className="seo-doc-head">
        <p className="seo-doc-kind">{kindOf(doc, collection)}</p>
        {doc.draft && <p className="seo-note">A draft is left out of the website, so search engines and link previews don’t see it until it’s published. What follows is how it would show once it is.</p>}
        {reason && (
          <p className="seo-note seo-doc-lock">
            <EyeOff aria-hidden="true" />
            {reason}
          </p>
        )}
        {synced && (
          <p className="seo-note seo-doc-lock" role="note">
            <Lock aria-hidden="true" />
            Read-only: this post is synced from an external source. Change it there, or detach the collection to edit it here.
          </p>
        )}
        {findings.length > 0 && (
          <ul className="seo-findings" aria-label="What to fix">
            {findings.map((f) => (
              <li key={f.label}>
                <Status tone={f.tone}>
                  {f.label}
                  {f.field && (
                    <>
                      {' '}
                      <button type="button" className="link-btn seo-finding-go" onClick={() => goTo(f.field!)}>
                        {settingsLocked
                          ? f.field === 'image'
                            ? 'Show the sharing image'
                            : f.field === 'title'
                              ? 'Show the search title'
                              : f.field === 'noindex'
                                ? 'Show the setting'
                                : 'Show the description'
                          : f.field === 'image'
                            ? 'Choose an image'
                            : f.field === 'title'
                              ? 'Edit the search title'
                              : f.field === 'noindex'
                                ? 'Review search visibility'
                                : 'Edit the description'}
                      </button>
                    </>
                  )}
                </Status>
              </li>
            ))}
          </ul>
        )}
        {/* Under the previews while the view is narrow: a way straight down to the fields. */}
        <button type="button" className="link-btn seo-doc-jump" onClick={() => goTo('title')}>
          Go to Search & sharing settings
        </button>
      </div>
      <div className="seo-doc-previews">
        <SeoPreview state={seen} subject={doc.subject} overlay={overlay} typed={typed} doc={preview} shown={shown} />
      </div>
      </Hideable>
      {/* Locked (a project open read-only, a synced post), the settings stay in sight: their text read-only, still
          focusable, selectable and copyable, every other control disabled, and nothing dropped on them imported. */}
      <div
        ref={settingsRef}
        className="seo-doc-settings"
        data-locked={settingsLocked || undefined}
        onDropCapture={settingsLocked ? (e) => (e.preventDefault(), e.stopPropagation()) : undefined}
        onDragOverCapture={settingsLocked ? (e) => e.stopPropagation() : undefined}
      >
        <LockedFields value={settingsLocked}>
        {page && shown && <SeoViewPageSettings state={state} pageId={page} on={on} preview={preview} />}
        {doc.subject.kind === 'entry' && <SeoViewPostSettings state={state} subject={doc.subject} preview={preview} on={on} />}
        </LockedFields>
      </div>
    </div>
  );
}

type FindingField = 'title' | 'description' | 'image' | 'noindex';
const FINDING_FIELDS: Partial<Record<SeoOverviewProblem, FindingField>> = {
  'home-hidden': 'noindex',
  'title-missing': 'title',
  'title-duplicate': 'title',
  'title-length': 'title',
  'description-missing': 'description',
  'description-duplicate': 'description',
  'description-length': 'description',
  'image-missing': 'image'
};

/** A document's findings in full sentences, the ones that count in search results first, each with the field that fixes it. */
function docFindings(r: SeoOverviewRow): Array<{ tone: 'warn' | 'note'; label: string; field?: FindingField }> {
  // Amber only for what counts in search results now: anything a document search engines can't list would need is a
  // note, Home hidden aside, which is the problem itself.
  const tone = (p: SeoOverviewProblem) => (p === 'home-hidden' ? 'warn' : !r.listed || !['title-missing', 'title-duplicate', 'description-missing', 'description-duplicate', 'image-missing'].includes(p) ? 'note' : 'warn');
  // The documents it shares words with, by name while they are few.
  const others = (t: SeoOverviewText, verb: boolean) => {
    const names = t.peers.length && t.peers.length <= 3 ? t.peers.map((n) => `“${n}”`) : null;
    const who = names ? (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`) : plural(t.duplicates, `${r.listed ? 'other' : 'published'} page or post`, `${r.listed ? 'other' : 'published'} pages and posts`);
    return `${who}${verb ? (t.duplicates === 1 ? ' has' : ' have') : ''}`;
  };
  const said: Record<SeoOverviewProblem, string> = {
    'home-hidden': 'Home, the site’s main page, asks search engines to leave it out of their results.',
    'title-missing': 'It has no search title.',
    'title-duplicate': `${others(r.title, true)} the same search title, so results can’t tell them apart.`,
    'title-length': `Its search title is ${r.title.status === 'short' ? 'short' : 'long'} at ${plural(r.title.chars, 'character')}.`,
    'description-missing': 'It has no description.',
    'description-duplicate': `${others(r.description, true)} the same description${r.description.fallback ? `: this one uses ${r.description.from === 'excerpt' ? 'its excerpt' : 'the site’s description'}, so write one of its own` : ''}.`,
    'description-length': `Its description is ${r.description.status === 'short' ? 'short' : 'long'} at ${plural(r.description.chars, 'character')}.`,
    'image-missing': r.image === 'gone' ? 'Its sharing image is missing from Assets.' : 'It has no sharing image, so shared links show no picture.'
  };
  return PROBLEM_ORDER.filter((p) => r.problems.includes(p)).map((p) => ({ tone: tone(p) as 'warn' | 'note', label: said[p], field: FINDING_FIELDS[p] }));
}

/**
 * The SEO view (#700), in the canvas's place while its panel shows: the document chosen in the list, by its title and
 * address, with its previews (#701), or the overview of every document (#707) while none is chosen. The canvas stays
 * loaded underneath, as it was. `shown` says whether the view is in front: its structured data and its overview are
 * worked out only then.
 */
export function SeoView({ shown }: { shown: boolean }) {
  const hidden = !shown;
  const root = useRef<HTMLElement>(null);
  // A page's fields are in one place at a time: the view while it is in front, else the Inspector. A field with focus
  // in the place about to go (the sidebar's shortcut works from a field, another document chosen) is left first, as a
  // click away would leave it, so what it holds is saved, or kept as refused, by its own control before that goes.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const was = activeWorkspace(prev) === 'seo';
        const is = activeWorkspace(s) === 'seo';
        const subject = (x: SeoSubject | null) => (x ? seoSubjectKey(x) : null);
        if (was && (!is || subject(s.seoSubject) !== subject(prev.seoSubject))) leaveField(root.current);
        else if (!was && is) leaveField(document.getElementById('dock-panel-inspect'));
      }),
    []
  );
  const snap = useStore((s) => s.snapshot);
  const subject = useStore((s) => s.seoSubject);
  const state = snap?.state;
  const readOnly = snap?.readOnly ?? null;
  const doc = seoDocument(state, subject);
  const collection = doc?.subject.kind === 'entry' && state ? state.collections[doc.subject.collectionId]?.settings.name : undefined;
  // The overview's filter is kept while a document is open, so Back returns to the list as it was.
  const [problemsOnly, setProblemsOnly] = useState(false);
  const returnTo = useRef<string | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  const backFocused = useRef(false);
  const shownKey = useRef<string | null>(null);
  // A document gone while Back had focus (deleted, undone away) takes Back with it: focus goes to the overview, as Back
  // would have taken it. Before the overview's own effect, which reads where to put it.
  useLayoutEffect(() => {
    const was = shownKey.current;
    shownKey.current = doc?.key ?? null;
    if (!doc && was && backFocused.current && !hidden && !returnTo.current) returnTo.current = was;
    if (!doc) backFocused.current = false;
  }, [doc?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // A request the overview never took (the view closed first) is let go: opened again, the view leaves focus be.
  useEffect(() => {
    if (hidden) returnTo.current = null;
  }, [hidden]);
  useEffect(() => {
    if (doc && opened.current) backRef.current?.focus();
    opened.current = false;
  }, [doc?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Another document opens at its top, its previews in sight, wherever the last one was scrolled to.
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (doc && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [doc?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const back = () => {
    returnTo.current = doc?.key ?? null;
    setState({ seoSubject: null });
  };
  // Put away (the post writer, another panel): a field being typed in commits now, as leaving it does, before anything
  // that view shows can act on the document (the writer's Publish), rather than whenever the browser lets go of it.
  useLayoutEffect(() => {
    const at = document.activeElement;
    if (hidden && at instanceof HTMLElement && root.current?.contains(at)) at.blur();
  }, [hidden]);
  return (
    <section className="seo-view" aria-label="SEO view" ref={root}>
      <div className="seo-bar">
        {doc ? (
          <>
            <button ref={backRef} className="btn btn-sm btn-ghost seo-back" aria-label="Back to overview" title="Back to overview (Esc)" onClick={back} onFocus={() => (backFocused.current = true)} onBlur={() => (backFocused.current = false)}>
              <ArrowLeft aria-hidden="true" />
              Overview
            </button>
            <span className="seo-bar-sep" aria-hidden="true" />
            {doc.subject.kind === 'page' ? <FileText aria-hidden="true" /> : <Newspaper aria-hidden="true" />}
            <h2 className="seo-title ellipsis">{doc.title}</h2>
            <span className="seo-address ellipsis" title={doc.address}>
              {doc.address}
            </span>
          </>
        ) : (
          <>
            <SearchCheck aria-hidden="true" />
            <h2 className="seo-title">SEO</h2>
          </>
        )}
        {/* Escape steps back to the overview from a document first, so only the overview's Close says it. */}
        <button className="btn btn-sm seo-leave" title={doc ? 'Leave the SEO view and return to the page' : 'Leave the SEO view and return to the page (Esc)'} onClick={() => {
            leaveSeoView();
            // Focus lands on the rail's SEO button, where the view opens from, not on the page.
            requestAnimationFrame(() => document.querySelector<HTMLElement>('.rail [data-rail="seo"]')?.focus());
          }}
        >
          <X aria-hidden="true" />
          Close SEO view
        </button>
      </div>
      {readOnly && (
        <p className="seo-locked" role="note">
          <Lock aria-hidden="true" />
          <span>{readOnly.reason}</span>
        </p>
      )}
      <div className="seo-scroll" ref={scrollRef}>
        {doc && state && snap ? (
          <SeoViewDocument key={`${snap.workspaceKey}\n${doc.key}`} state={state} doc={doc} collection={collection} shown={shown} locked={!!readOnly} />
        ) : state && !hidden ? (
          <SeoOverview
            state={state}
            problemsOnly={problemsOnly}
            onProblemsOnly={setProblemsOnly}
            returnTo={returnTo}
            onOpen={(r) => {
              opened.current = true;
              setState({ seoSubject: r.subject });
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
