import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import type { ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import { createSeoResolver } from '@generator/seo-metadata';
import { useStore } from '../store';
import { AssetImage } from '../components/AssetImage';
import { Tabs } from '../components/ui';
import { lengthMeter, previewDocument, structuredPreview, withTypedSeo, type DocumentPreview, type LengthMeter as Meter, type StructuredPreview, type TypedSeo } from '../lib/seo-preview';
import { openSiteSharing, SharingPreview } from './SharingPreview';
import { previewHandoff } from '../lib/seoHandoff';
import { AiHandoffButton } from '../components/AiHandoff';

type PreviewTab = 'search' | 'link' | 'data';

/** One key per document, so what belongs to one (its typed text, its chosen tab) is never shown for another. */
export const subjectKey = (subject: SeoSubject) => (subject.kind === 'page' ? `page:${subject.pageId}` : `entry:${subject.collectionId}:${subject.entryId}`);

/** How long typing settles before the structured data, which reads the whole website, is worked out again. */
const SETTLE_MS = 150;

/**
 * Text typed into one document's Search & sharing fields and not saved yet, for its previews. Each field reports what
 * it shows through its `onDirty` (as typed, refused text shown again, or the saved value put back by Escape); the
 * handlers keep their identity for as long as the document stays, so a field's effect doesn't run on every render.
 */
export function useTypedSeo(key: string) {
  const [typed, setTyped] = useState<{ key: string; seo: TypedSeo }>({ key, seo: {} });
  const on = useMemo(() => {
    const set = (name: keyof TypedSeo, value: string | undefined) =>
      setTyped((prev) => {
        const seo = prev.key === key ? prev.seo : {};
        if (prev.key === key && seo[name] === value) return prev;
        const next = { ...seo };
        if (value === undefined) delete next[name];
        else next[name] = value;
        return { key, seo: next };
      });
    return {
      title: (dirty: boolean, draft: string) => set('title', dirty ? draft : undefined),
      description: (dirty: boolean, draft: string) => set('description', dirty ? draft : undefined),
      canonical: (url: string | undefined) => set('canonical', url)
    };
  }, [key]);
  return { typed: typed.key === key ? typed.seo : {}, on };
}

/**
 * One document's previews with typed text laid over it: the search result, the link card and the length meters,
 * worked out from that document alone, so they follow every keystroke.
 */
export function useDocumentPreview(state: ProjectState, subject: SeoSubject, typed: TypedSeo) {
  const key = subjectKey(subject);
  // Where the website publishes an entry is read from the whole website: once per saved change, not per keystroke.
  const route = useMemo(() => (subject.kind === 'entry' ? createSeoResolver(state).resolve(subject)?.route : undefined), [state, key]);
  const overlay = useMemo(() => withTypedSeo(state, subject, typed), [state, key, typed.title, typed.description, typed.canonical]);
  const doc = useMemo(() => previewDocument(overlay, subject, route), [overlay, route]);
  return { overlay, doc };
}

/** How a title or description measures up against a results page, under its field. Never blocks an edit. */
export function LengthMeter({ kind, doc }: { kind: 'title' | 'description'; doc: DocumentPreview | null }) {
  if (!doc) return null;
  const meter: Meter = lengthMeter(kind, doc);
  return (
    <span className={`seo-meter ${meter.tone}`} data-tone={meter.tone} data-meter={kind}>
      <span className="seo-meter-bar" aria-hidden="true">
        <span style={{ width: `${Math.round(meter.fill * 100)}%` }} />
      </span>
      <span className="seo-meter-text">{meter.label}</span>
    </span>
  );
}

/** The site's icon, as a result shows it beside the site's name. */
function SiteIcon({ state }: { state: ProjectState }) {
  const runtime = useStore((s) => s.runtime);
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const id = state.site.favicon;
  const icon = id && Object.hasOwn(state.assets.assets, id) && state.assets.assets[id].kind === 'image' ? state.assets.assets[id] : undefined;
  return <span className="serp-icon">{icon && devUrl ? <AssetImage asset={icon} devUrl={devUrl} cover alt="" /> : <Globe aria-hidden="true" />}</span>;
}

/** The document as a computer's and a phone's search results list it. */
function SearchResults({ state, doc }: { state: ProjectState; doc: DocumentPreview }) {
  const { address } = doc;
  return (
    <div className="serp-previews">
      {(['desktop', 'mobile'] as const).map((device) => {
        const r = doc.serp[device];
        return (
          // Each result is laid out at its screen's width, in proportion to the widths it is measured against, so a line
          // breaks where it would there; a computer's is wider than the Inspector, which scrolls it sideways.
          <div key={device} className={`serp-frame serp-frame-${device}`} tabIndex={device === 'desktop' ? 0 : undefined} role="group" aria-label={device === 'desktop' ? 'Search result on a computer' : 'Search result on a phone'}>
            <div className={`serp serp-${device}`} data-device={device}>
              <div className="serp-device">{device === 'desktop' ? 'Computer' : 'Phone'}</div>
              <div className="serp-site">
                <SiteIcon state={state} />
                <span className="serp-site-text">
                  <span className="serp-site-name">{doc.siteName || address.host || 'Your site'}</span>
                  <span className="serp-url">{[address.host ?? 'No public URL', ...address.trail].join(' › ')}</span>
                </span>
              </div>
              <div className={`serp-title${r.title.text ? '' : ' none'}`}>
                {r.title.lines.length
                  ? r.title.lines.map((line, i) => (
                      <span key={i} className="serp-title-line">
                        {line}
                      </span>
                    ))
                  : 'No title'}
              </div>
              <div className={`serp-desc${r.description.text ? '' : ' none'}`}>
                {doc.date && <span className="serp-date">{doc.date}</span>}
                {r.description.text || 'No description: search engines pick words from the page.'}
              </div>
            </div>
          </div>
        );
      })}
      <p className="field-hint serp-note">
        Where results likely cut the title and description short, from their width in the type search results use. Search engines may still choose other words.
        {!address.host && (
          <>
            {' '}
            The site has no public URL yet, so results show the page’s address within the site.{' '}
            <button type="button" className="link-btn" onClick={() => openSiteSharing('baseUrl')}>
              Open Site details
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** Where the document is published, and the structured data its exported page carries. */
function StructuredData({ structured }: { structured: StructuredPreview | null | undefined }) {
  if (structured === undefined) return <p className="field-hint">Working out the structured data…</p>;
  if (structured === null) return <p className="field-hint">This document is no longer in the project.</p>;
  const { status, graph } = structured;
  return (
    <div className="seo-data">
      <dl className="seo-status">
        {status.map((line) => (
          <div key={line.id} className={`seo-status-row${line.on ? ' on' : ''}`} data-status={line.id}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      {graph.kind === 'graph' ? (
        <>
          <p className="field-hint">The Schema.org graph search engines and AI answer engines read: who publishes the site, the site, this page and its place in it.</p>
          <pre className="code-view seo-graph" tabIndex={0} aria-label="Structured data as the exported page writes it" data-testid="seo-graph">
            {graph.json}
          </pre>
        </>
      ) : graph.kind === 'none' ? (
        <p className="field-hint seo-graph-none">{graph.reason}</p>
      ) : (
        <p className="field-error" role="alert">
          The structured data couldn’t be worked out: {graph.message}
        </p>
      )}
    </div>
  );
}

/**
 * A page's or a post's Search & sharing previews, in tabs: its search result on a computer and a phone, the card a
 * shared link makes, and its structured data with where it is published. `shown` says whether the previews are on
 * screen: the structured data, which reads the whole website, is worked out only while its tab shows. Optimize with AI
 * opens the AI panel about them (#599): an edit of a page's search title and description, or for a post, which the AI
 * can't change yet, a question that suggests them, from what is typed in its fields now.
 */
export function SeoPreview({ state, subject, overlay, doc, shown = true }: { state: ProjectState; subject: SeoSubject; overlay: ProjectState; doc: DocumentPreview | null; shown?: boolean }) {
  const key = subjectKey(subject);
  // Each document opens on its search result.
  const [chosen, setChosen] = useState<{ key: string; tab: PreviewTab }>({ key, tab: 'search' });
  const tab = chosen.key === key ? chosen.tab : 'search';
  const [structured, setStructured] = useState<{ key: string; value: StructuredPreview | null } | null>(null);
  const showing = shown && tab === 'data' && !!doc;
  const ready = structured?.key === key;
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  // Whether the tab has shown this document's structured data since it was last opened.
  const settled = useRef(false);
  useEffect(() => {
    if (!showing) {
      // Nothing worked out before stays to be shown again while the next look is worked out (a post's settings
      // reopened show what they held before React hears of it).
      settled.current = false;
      setStructured((prev) => (prev ? null : prev));
      return;
    }
    // A look on opening the tab is at once, never at a result left from before; while text is typed it waits for a pause.
    const wait = settled.current && ready ? SETTLE_MS : 0;
    const t = setTimeout(() => {
      settled.current = true;
      setStructured({ key, value: structuredPreview(overlay, subject) });
    }, wait);
    return () => clearTimeout(t);
  }, [showing, overlay, key]);
  if (!doc) return null;
  return (
    <div className="seo-preview">
      <Tabs<PreviewTab>
        value={tab}
        onChange={(v) => setChosen({ key, tab: v })}
        label="Preview"
        idBase={`seo-preview-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`}
        options={[
          { value: 'search', label: 'Search result', panel: () => <SearchResults state={state} doc={doc} /> },
          { value: 'link', label: 'Link preview', panel: () => <SharingPreview card={doc.card} /> },
          { value: 'data', label: 'Structured data', panel: () => <StructuredData structured={ready && settled.current ? structured!.value : undefined} /> }
        ]}
      />
      {!readOnly && (
        <div className="seo-preview-ai">
          <AiHandoffButton label="Optimize with AI" request={() => previewHandoff(overlay, subject)} />
          {subject.kind === 'entry' && <span className="field-hint">Suggests a title and description for you to paste in.</span>}
        </div>
      )}
    </div>
  );
}
