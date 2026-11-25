import './SeoView.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, FileText, House, Newspaper, Search } from 'lucide-react';
import type { ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import { setState, useStore } from '../store';
import { seoDocument, seoDocuments, seoSubjectKey, type SeoDocument } from '../lib/seo-view';
import { seoOverviewOnce, seoOverviewProblems, type SeoImageStatus, type SeoOverviewRow, type SeoOverviewText } from '../lib/seo-overview';
import { isDraftPage } from '@generator/index';
import { activeWorkspace } from '../lib/workspace';
import { SeoPreview, useDocumentPreview, useTypedSeo, type TypedSeoOn } from './SeoPreview';
import type { DocumentPreview } from '../lib/seo-preview';
import { StructuredDataFields } from '../components/StructuredDataFields';
import { PageSearchFields } from './PageSearchFields';
import { pageUpdater } from '../lib/page-settings';
import { postAt } from '../lib/posts';
import { savePostSeo } from '../lib/post-seo';
import { PostSearchFields } from './PostSearchFields';

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
  const listRef = useRef<HTMLDivElement>(null);
  const chosen = subject ? seoSubjectKey(subject) : null;
  const keys = groups.flatMap((g) => g.documents.map((d) => d.key));
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
    if (!chosen || !listRef.current?.offsetParent) return;
    listRef.current.querySelector<HTMLElement>(`[data-seo="${CSS.escape(chosen)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [chosen]);
  if (!state) return null;
  return (
    <div className="seo-panel">
      <div className="panel-head">
        <h3>SEO</h3>
      </div>
      <div className="panel-body" ref={listRef} onKeyDown={onKey}>
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

/** Leaves the text field with focus inside `root`, if there is one: its control saves or keeps what it holds. */
function leaveField(root: HTMLElement | null) {
  const el = document.activeElement;
  if (root && el instanceof HTMLElement && root.contains(el) && el.matches('input, textarea')) el.blur();
}

/** What a document is, in words: the home page, a page, or an entry of its collection. */
function kindOf(d: SeoDocument, collectionName: string | undefined): string {
  if (d.subject.kind === 'page') return d.home ? 'Home page' : d.draft ? 'Draft page' : 'Page';
  const of = collectionName ? ` in ${collectionName}` : '';
  return `${d.draft ? 'Draft' : 'Published'}${of}`;
}

const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/** How a title or description measures up, in words, with the tone its status line shows in. */
function textNote(t: SeoOverviewText, field: 'title' | 'description', listed: boolean): { tone: 'warn' | 'note' | 'ok'; label: string } {
  if (t.status === 'missing') return { tone: 'warn', label: field === 'title' ? 'No title' : 'No description' };
  const parts: string[] = [];
  let tone: 'warn' | 'note' | 'ok' = 'ok';
  if (t.duplicates > 0) {
    tone = 'warn';
    // A document search engines don't list repeats only the published ones they can: it would compete with them once listed.
    parts.push(`Same as ${plural(t.duplicates, `${listed ? 'other' : 'published'} page or post`, `${listed ? 'other' : 'published'} pages and posts`)}`);
  }
  const count = plural(t.chars, 'character');
  if (t.status === 'short') parts.push(`Too short · ${count}`);
  else if (t.status === 'long') parts.push(`Too long · ${count}`);
  else parts.push(count);
  if (t.status !== 'good' && tone === 'ok') tone = 'note';
  if (t.fallback) parts.push(field === 'title' ? 'default' : 'fallback');
  return { tone, label: parts.join(' · ') };
}

const IMAGE_LABELS: Record<SeoImageStatus, string> = { own: 'Its own', featured: 'Featured image', site: 'The site’s', none: 'None', gone: 'Missing from the library' };

/** Whether search engines may list a document, in words. */
function listing(r: SeoOverviewRow): { tone: 'warn' | 'ok' | 'quiet'; label: string } {
  if (r.noindex) return { tone: r.home ? 'warn' : 'quiet', label: 'Hidden from search engines' };
  if (r.draft) return { tone: 'quiet', label: 'Draft: not on the website' };
  if (!r.listed) return { tone: 'quiet', label: 'Not on the website' };
  // Allowed, not known to be: whether a search engine has listed it is beyond the editor.
  return { tone: 'ok', label: 'Can be listed' };
}

function TextCell({ t, field, listed }: { t: SeoOverviewText; field: 'title' | 'description'; listed: boolean }) {
  const note = textNote(t, field, listed);
  return (
    <td className="seo-ov-text">
      {t.text ? (
        <span className="seo-ov-words" title={t.text}>
          {t.text}
        </span>
      ) : null}
      <span className={`seo-ov-status ${note.tone}`}>{note.label}</span>
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
          {problems.length ? ` · ${problems.length} with something to fix` : all.length ? ' · nothing to fix' : ''}
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
              return (
                <tr key={r.key} data-seo-row={r.key} data-level={r.level} className="seo-ov-row">
                  <th scope="row">
                    <button className="seo-ov-open" onClick={() => onOpen(r)}>
                      <span className="seo-ov-name">
                        {r.home && <House role="img" aria-label="Home page" />}
                        <span className="ellipsis">{r.name}</span>
                      </span>
                      <span className="seo-ov-where ellipsis">{r.collection ? `${r.collection} · ${r.address}` : r.address}</span>
                      {r.draft && <span className="badge amber">Draft</span>}
                    </button>
                  </th>
                  <TextCell t={r.title} field="title" listed={r.listed} />
                  <TextCell t={r.description} field="description" listed={r.listed} />
                  <td>
                    <span className={`seo-ov-status ${imageMissing ? 'warn' : 'ok'}`}>{IMAGE_LABELS[r.image]}</span>
                  </td>
                  <td>
                    <span className={`seo-ov-status ${listed.tone}`}>{listed.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="seo-ov-empty">{all.length ? 'Nothing to fix: every page and post reads well in search results and when shared.' : 'The site has no pages yet.'}</p>
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
    <section className="seo-settings" aria-labelledby={headId}>
      <h3 id={headId} className="seo-settings-head">
        Search & sharing
      </h3>
      <div className="seo-fields">
        <PostSearchFields state={state} collection={collection} entry={entry} doc={preview} on={on} save={(edit) => savePostSeo(post, edit)} />
      </div>
    </section>
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
        <StructuredDataFields page={page} upd={upd} />
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
function SeoViewDocument({ state, doc, collection, shown }: { state: ProjectState; doc: SeoDocument; collection: string | undefined; shown: boolean }) {
  const { typed, on } = useTypedSeo(doc.key);
  const { overlay, doc: preview } = useDocumentPreview(state, doc.subject, typed);
  const page = doc.subject.kind === 'page' ? doc.subject.pageId : null;
  return (
    <div className={`seo-doc${page ? ' seo-doc-page' : ''}`} data-seo-doc={doc.key}>
      <div className="seo-doc-head">
        <p className="seo-doc-kind">{kindOf(doc, collection)}</p>
        {doc.draft && <p className="seo-note">A draft is left out of the website, so search engines and link previews don’t see it until it’s published.</p>}
      </div>
      <div className="seo-doc-previews">
        <SeoPreview state={state} subject={doc.subject} overlay={overlay} typed={typed} doc={preview} shown={shown} place="view" />
      </div>
      {page && shown && <SeoViewPageSettings state={state} pageId={page} on={on} preview={preview} />}
      {doc.subject.kind === 'entry' && <SeoViewPostSettings state={state} subject={doc.subject} preview={preview} on={on} />}
    </div>
  );
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
            <button ref={backRef} className="btn btn-ghost seo-back" aria-label="Back to overview" title="Back to overview" onClick={back} onFocus={() => (backFocused.current = true)} onBlur={() => (backFocused.current = false)}>
              <ArrowLeft />
            </button>
            {doc.subject.kind === 'page' ? <FileText aria-hidden="true" /> : <Newspaper aria-hidden="true" />}
            <h2 className="seo-title ellipsis">{doc.title}</h2>
            <span className="seo-address ellipsis" title={doc.address}>
              {doc.address}
            </span>
          </>
        ) : (
          <>
            <Search aria-hidden="true" />
            <h2 className="seo-title">SEO</h2>
          </>
        )}
      </div>
      <div className="seo-scroll">
        {doc && state && snap ? (
          <SeoViewDocument key={`${snap.workspaceKey}\n${doc.key}`} state={state} doc={doc} collection={collection} shown={shown} />
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
