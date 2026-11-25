import './SeoView.css';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FileText, House, Newspaper, Search } from 'lucide-react';
import { setState, useStore } from '../store';
import { seoDocument, seoDocuments, seoSubjectKey, type SeoDocument } from '../lib/seo-view';

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

/** What a document is, in words: the home page, a page, or an entry of its collection. */
function kindOf(d: SeoDocument, collectionName: string | undefined): string {
  if (d.subject.kind === 'page') return d.home ? 'Home page' : d.draft ? 'Draft page' : 'Page';
  const of = collectionName ? ` in ${collectionName}` : '';
  return `${d.draft ? 'Draft' : 'Published'}${of}`;
}

/**
 * The SEO view (#700), in the canvas's place while its panel shows: the document chosen in the list, by its title and
 * address, or a prompt to choose one. The canvas stays loaded underneath, as it was.
 */
export function SeoView() {
  const snap = useStore((s) => s.snapshot);
  const subject = useStore((s) => s.seoSubject);
  const state = snap?.state;
  const doc = seoDocument(state, subject);
  const collection = doc?.subject.kind === 'entry' && state ? state.collections[doc.subject.collectionId]?.settings.name : undefined;
  return (
    <section className="seo-view" aria-label="SEO view">
      <div className="seo-bar">
        {doc ? (
          <>
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
        {doc ? (
          <div className="seo-doc" key={doc.key} data-seo-doc={doc.key}>
            <p className="seo-doc-kind">{kindOf(doc, collection)}</p>
            <dl className="seo-doc-facts">
              <dt>Title</dt>
              <dd>{doc.title}</dd>
              <dt>Address</dt>
              <dd>{doc.address}</dd>
            </dl>
            {doc.draft && <p className="seo-note">A draft is left out of the website, so search engines and link previews don’t see it until it’s published.</p>}
          </div>
        ) : (
          <div className="seo-none">
            <Search aria-hidden="true" />
            <p>Choose a page or post in the list to see how it reads in search results and when it’s shared.</p>
          </div>
        )}
      </div>
    </section>
  );
}
