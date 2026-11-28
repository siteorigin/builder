import './SeoPreview.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Check, EyeOff, Globe, Minus, Search, SearchCheck, TriangleAlert } from 'lucide-react';
import type { ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import { createSeoResolver } from '@generator/seo-metadata';
import { SERP_LAYOUT, type SerpDevice } from '@shared/serp';
import { setSerpView, useStore } from '../store';
import { FILLER_RESULTS, PHONE_BEZEL, SAMPLE_QUERY, SERP_MARGIN, serpPageWidth, serpScale, type FillerResult } from '../lib/serp-page';
import { openSeoViewFrom, postPreviewHandoff } from '../lib/actions';
import { AssetImage } from '../components/AssetImage';
import { Disclosure, Segmented, Switch, Tabs } from '../components/ui';
import { lengthMeter, previewDocument, structuredPreview, withTypedSeo, type DocumentPreview, type LengthMeter as Meter, type StructuredPreview, type TypedSeo } from '../lib/seo-preview';
import { openSiteSharing, SharingPreview } from './SharingPreview';
import { previewHandoff } from '../lib/seoHandoff';
import { destinationLabel } from '../lib/destinations';
import { openEditorDestination } from '../lib/open-destination';
import type { GraphSection } from '../lib/structured-summary';
import { AiHandoffButton } from '../components/AiHandoff';
import { CopyText } from '../components/CopyText';
import { perfCount } from '../lib/perf';

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
      canonical: (url: string | undefined) => set('canonical', url),
      /** Forget everything typed: the fields have gone. */
      clear: () => setTyped((prev) => (prev.key === key && !Object.keys(prev.seo).length ? prev : { key, seo: {} }))
    };
  }, [key]);
  return { typed: typed.key === key ? typed.seo : {}, on };
}

/** How a document's Search & sharing fields report what they show (useTypedSeo). */
export type TypedSeoOn = ReturnType<typeof useTypedSeo>['on'];

/**
 * One document's previews with typed text laid over it: the search result, the link card and the length meters,
 * worked out from that document alone, so they follow every keystroke.
 */
export function useDocumentPreview(state: ProjectState, subject: SeoSubject, typed: TypedSeo) {
  const key = subjectKey(subject);
  // Where the website publishes an entry is read from the whole website: once per saved change, not per keystroke.
  const route = useMemo(() => {
    if (subject.kind !== 'entry') return undefined;
    perfCount('seo.routes');
    return createSeoResolver(state).resolve(subject)?.route;
  }, [state, key]);
  const overlay = useMemo(() => withTypedSeo(state, subject, typed), [state, key, typed.title, typed.description, typed.canonical]);
  const doc = useMemo(() => previewDocument(overlay, subject, route), [overlay, route]);
  return { overlay, doc };
}

/** How a title or description measures up against a results page, under its field. Never blocks an edit. */
export function LengthMeter({ kind, doc }: { kind: 'title' | 'description'; doc: DocumentPreview | null }) {
  if (!doc) return null;
  const meter: Meter = lengthMeter(kind, doc);
  return (
    <span className={`seo-meter ${meter.tone}`} data-tone={meter.tone} data-meter={kind} data-cut={meter.cutOn.join(' ') || undefined}>
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

/**
 * A results page laid out at its real size, so text wraps where it would there, then scaled down as a whole when the
 * place it shows in is narrower: never scrolled sideways, and never re-wrapped. A transform takes no room of its own,
 * so the slot around the page is given the size the page shows at.
 */
/** The width of the margin left of the results page, where the marker for the site's own result sits. */
const SERP_GUTTER = 76;

/**
 * `mark` names the site's own result in the margin ("Your page"): a label level with its first line and a rule the
 * height of the result, so it reads as a note on that result rather than as a control.
 */
function ScaledPage({ device, mark: markLabel, children }: { device: SerpDevice; mark: string; children: ReactNode }) {
  const fit = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ room: 0, height: 0, mark: null as { top: number; height: number } | null });
  const measure = useRef(() => {
    // To the fraction of a pixel (a rounded room or height would clip the page's edge), and the height as laid out,
    // before any scaling.
    // The margin to the left of the page holds the marker, so it is not room the page can use.
    const room = Math.max(0, (fit.current?.getBoundingClientRect().width ?? 0) - SERP_GUTTER);
    const height = (page.current && parseFloat(getComputedStyle(page.current).height)) || 0;
    // Hidden, there is nothing to measure: what was measured last stands until it shows again.
    if (!room || !height) return;
    // A title line the browser sets wider than it was measured (a script the width table only estimates) is narrowed
    // to its column, so it keeps the line break and the "…" it was measured with.
    for (const line of page.current!.querySelectorAll<HTMLElement>('.serp-title-text')) {
      const column = line.parentElement!.clientWidth;
      line.style.transform = line.offsetWidth > column ? `scaleX(${column / line.offsetWidth})` : '';
    }
    // The site's own result, as drawn (scaled) from the top of the page: the marker sits level with it.
    const own = page.current!.querySelector('[data-serp-own]')?.getBoundingClientRect();
    const box = page.current!.getBoundingClientRect();
    const mark = own ? { top: Math.round((own.top - box.top) * 100) / 100, height: Math.round(own.height * 100) / 100 } : null;
    setSize((s) => (s.room === room && s.height === height && s.mark?.top === mark?.top && s.mark?.height === mark?.height ? s : { room, height, mark }));
  }).current;
  // After every change to what shows, before it is painted.
  useLayoutEffect(measure);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(fit.current!);
    ro.observe(page.current!);
    return () => ro.disconnect();
  }, [measure]);
  const width = serpPageWidth(device);
  const scale = serpScale(size.room, device);
  return (
    <div className="serp-fit" ref={fit}>
      <div className="serp-row">
        <span className="serp-mark" aria-hidden="true">
          {size.mark && (
            <span className="serp-mark-tag" style={{ top: size.mark.top, height: size.mark.height }}>
              <span className="serp-mark-label">{markLabel}</span>
              <span className="serp-mark-rule" />
            </span>
          )}
        </span>
        <div className="serp-slot" style={{ width: width * scale, height: size.height ? size.height * scale : undefined }}>
          <div className="serp-scaled" ref={page} style={{ width, transform: scale < 1 ? `scale(${scale})` : undefined }} data-scale={scale}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The site's name and address trail over a result, beside its icon. */
function ResultSite({ icon, name, url }: { icon: ReactNode; name: string; url: string }) {
  return (
    <div className="serp-site">
      {icon}
      <span className="serp-site-text">
        <span className="serp-site-name">{name}</span>
        <span className="serp-url">{url}</span>
      </span>
    </div>
  );
}

/** The address line over a result: a phone's results show the site's host alone, a computer's its path after it. */
const resultUrl = (parts: readonly string[], device: SerpDevice) => (device === 'mobile' ? parts[0] : parts.join(' › '));

/** Another site's result, made up: there to be read against, and not read out. */
function Filler({ result, device }: { result: FillerResult; device: SerpDevice }) {
  return (
    <div className="serp-result serp-filler" aria-hidden="true">
      <ResultSite
        icon={
          <span className="serp-icon">
            <Globe />
          </span>
        }
        name={result.site}
        url={resultUrl(result.url.split(' › '), device)}
      />
      <div className="serp-title">{result.title}</div>
      <div className="serp-desc">{result.description}</div>
    </div>
  );
}

/**
 * The document on a sample results page, a computer's or a phone's, among placeholder results. The page has its own
 * light and dark colours, whatever the editor looks like.
 */
function SearchResults({ state, doc, kind }: { state: ProjectState; doc: DocumentPreview; kind: 'page' | 'post' }) {
  const { address } = doc;
  // Said over the results page itself, which stays in sight while the settings scroll: a hidden page or a draft only
  // shows how it would look.
  const unlisted = doc.meta.draft ? `A draft isn’t in search results. This is how it would show once it’s published.` : doc.meta.noindex ? `Hidden from search engines. This is how it would show if they listed it.` : null;
  const { device, dark } = useStore((s) => s.serpView);
  const darkId = useId();
  const r = doc.serp[device];
  const own = { dir: 'auto', lang: doc.meta.language || undefined };
  const [first, ...rest] = FILLER_RESULTS;
  return (
    <div className="serp-previews">
      <div className="serp-controls">
        <Segmented<SerpDevice>
          radio
          label="Results screen"
          value={device}
          onChange={(v) => setSerpView({ device: v })}
          options={[
            { value: 'desktop', label: 'Computer' },
            { value: 'mobile', label: 'Phone' }
          ]}
        />
        <span className="serp-theme">
          <label id={`${darkId}-l`} htmlFor={darkId}>
            Dark results
          </label>
          <Switch id={darkId} checked={dark} onChange={(v) => setSerpView({ dark: v })} labelledBy={`${darkId}-l`} />
        </span>
      </div>
      <p className="field-hint serp-note">Your {kind} among sample results. Search engines may shorten your title and description, or choose other words.</p>
      {unlisted && (
        <p className="seo-note seo-preview-state">
          <EyeOff aria-hidden="true" />
          {unlisted}
        </p>
      )}
      <div role="group" aria-label={device === 'desktop' ? 'Search result on a computer' : 'Search result on a phone'}>
        <ScaledPage device={device} mark={`Your ${kind}`}>
          <div
            className={`serp-page serp-page-${device}`}
            data-serp-theme={dark ? 'dark' : 'light'}
            style={
              {
                '--serp-margin': `${SERP_MARGIN}px`,
                '--serp-bezel': `${PHONE_BEZEL}px`,
                '--serp-title-size': `${SERP_LAYOUT.titleFont}px`,
                '--serp-desc-size': `${SERP_LAYOUT.descriptionFont}px`
              } as CSSProperties
            }
          >
            <div className="serp-search" aria-hidden="true">
              <Search />
              <span>{SAMPLE_QUERY}</span>
            </div>
            <Filler result={first} device={device} />
            <div className={`serp-result serp serp-${device}`} data-device={device} data-serp-own="">
              <span className="sr-only">Your {kind}’s result</span>
              <ResultSite icon={<SiteIcon state={state} />} name={doc.siteName || address.host || 'Your site'} url={resultUrl([address.host ?? 'No public URL', ...address.trail], device)} />
              {/* The document's own words read in its language and direction, so a right-to-left "…" falls at their end. */}
              <div className={`serp-title${r.title.text ? '' : ' none'}`} {...(r.title.text ? own : {})}>
                {r.title.lines.length
                  ? r.title.lines.map((line, i) => (
                      <span key={i} className="serp-title-line">
                        <span className="serp-title-text">{line}</span>
                      </span>
                    ))
                  : 'No title: results show the address instead.'}
              </div>
              <div className={`serp-desc${r.description.text ? '' : ' none'}`} {...(r.description.text ? own : {})}>
                {doc.date && <span className="serp-date">{doc.date}</span>}
                {r.description.text || 'No description: search engines pick words from the page.'}
              </div>
            </div>
            {rest.map((f) => (
              <Filler key={f.url} result={f} device={device} />
            ))}
          </div>
        </ScaledPage>
      </div>
    </div>
  );
}

/** The structured data in words: each entity's statement, what it is good for, and its values. */
function GraphSummary({ sections }: { sections: GraphSection[] }) {
  return (
    <div className="seo-summary">
      {sections.map((s) => (
        <section key={s.id} className="seo-entity" data-entity={s.id} aria-label={s.heading}>
          <h5>{s.heading}</h5>
          <p className="seo-entity-statement">{s.statement}</p>
          {s.rows.length > 0 && (
            <dl>
              {s.rows.map((r, i) => (
                <div key={i} className="seo-entity-row">
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {s.lists.map((list) => {
            const List = list.ordered ? 'ol' : 'ul';
            return (
              <div key={list.label} className="seo-entity-list">
                <span className="seo-entity-list-label">{list.label}</span>
                <List aria-label={list.label}>
                  {list.items.map((item, i) => (
                    <li key={i}>
                      {item.text}
                      {item.detail && <span className="seo-entity-detail">{item.detail}</span>}
                    </li>
                  ))}
                </List>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** The JSON-LD laid out a value to a line, as the page writes it but readable: only the spaces between tokens differ. */
function readableJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/**
 * Where the document is published, what its typed structured data still needs, and the structured data its exported
 * page carries: in words, with the exact JSON-LD a click away.
 */
function StructuredData({ structured, noAddress, onEditType }: { structured: StructuredPreview | null | undefined; noAddress: boolean; onEditType?: () => void }) {
  const uid = useId();
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  if (structured === undefined) return <p className="field-hint">Working out the structured data…</p>;
  if (structured === null) return <p className="field-hint">This document is no longer in the project.</p>;
  const { status, problem, graph } = structured;
  return (
    <div className="seo-data">
      <section className="seo-data-part" aria-labelledby={`${uid}-where`}>
        <h4 id={`${uid}-where`} className="seo-data-head">
          Where it appears
        </h4>
        <dl className="seo-status">
          {status.map((line) => (
            <div key={line.id} className={`seo-status-row${line.on ? ' on' : ''}`} data-status={line.id}>
              {/* The mark leads the row, so the values start on the same line as the facts below. */}
              <dt>
                {line.on ? <Check aria-hidden="true" /> : <Minus aria-hidden="true" />}
                <span>{line.label}</span>
              </dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      {problem && (
        <div className="seo-data-problem" data-code={problem.code}>
          <p>
            <TriangleAlert aria-hidden="true" />
            <span>{problem.message}</span>
          </p>
          <p className="field-hint">{problem.explanation}</p>
          {problem.destination && (
            <button type="button" className="link-btn" onClick={() => openEditorDestination(problem.destination!)}>
              {destinationLabel(problem.destination)}
            </button>
          )}
        </div>
      )}
      {graph.kind === 'graph' ? (
        <section className="seo-data-part" aria-labelledby={`${uid}-what`}>
          <div className="seo-data-headrow">
            <h4 id={`${uid}-what`} className="seo-data-head">
              What it tells search engines
            </h4>
            {/* From what it says to where it is set: the page type and its facts, beside the previews. */}
            {onEditType && (
              <button type="button" className="link-btn" onClick={onEditType}>
                {readOnly ? 'Show the page type' : 'Edit the page type'}
              </button>
            )}
          </div>
          <p className="field-hint">What the exported page says about itself to search engines and AI answer engines, as Schema.org structured data.</p>
          <GraphSummary sections={graph.sections} />
          <Disclosure className="seo-json" summary="Exact JSON-LD">
            <div className="seo-json-tools">
              <span className="field-hint">Paste it into a structured data checker, such as the Schema Markup Validator.</span>
              <CopyText text={graph.json} what="JSON-LD" />
            </div>
            <pre className="code-view seo-graph" tabIndex={0} aria-label="Structured data as the exported page writes it" data-testid="seo-graph">
              {readableJson(graph.json)}
            </pre>
          </Disclosure>
        </section>
      ) : graph.kind === 'none' ? (
        <section className="seo-data-part" aria-labelledby={`${uid}-what`}>
          <h4 id={`${uid}-what`} className="seo-data-head">
            What it tells search engines
          </h4>
          <p className="field-hint seo-graph-none">
            {graph.reason}
            {/* The remedy where the reason is. */}
            {noAddress && (
              <>
                {' '}
                <button type="button" className="link-btn" onClick={() => openSiteSharing('baseUrl')}>
                  {readOnly ? 'Show Site details' : 'Set the public URL'}
                </button>
              </>
            )}
          </p>
        </section>
      ) : (
        <p className="field-error" role="alert">
          The structured data couldn’t be worked out: {graph.message}
        </p>
      )}
    </div>
  );
}

/**
 * Optimize with AI for one document (#599): it opens the AI panel with an edit of a page's search title and
 * description, or for a post, which the AI can't change yet, a question that suggests them, from what is typed in its
 * fields now (`typed`, laid over the project as `overlay`). `from` says where it is pressed: beside the document's own
 * settings (the Inspector, the post writer), or in the SEO view on the document chosen there.
 */
export function SeoAiAction({ subject, overlay, typed, from, hint = true }: { subject: SeoSubject; overlay: ProjectState; typed: TypedSeo; from: 'inline' | 'view'; hint?: boolean }) {
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  if (readOnly) return null;
  return (
    <div className="seo-preview-ai">
      <AiHandoffButton
        label="Optimize with AI"
        request={() =>
          // A page's request names the page alone. A post's other fields (its excerpt, its text) are saved first when
          // the writer holds it, so the question quotes them as typed; its search title and description are what its
          // fields show, typed or saved.
          subject.kind === 'page' ? previewHandoff(overlay, subject) : postPreviewHandoff(subject, typed, from === 'view' ? 'view' : 'writer')
        }
      />
      {hint && subject.kind === 'entry' && <span className="field-hint">Suggests a title and description for you to paste in.</span>}
    </div>
  );
}

/**
 * At the top of a page's or a post's Search & sharing settings beside the document itself (the Inspector, the post
 * writer), where its previews used to be (#708): Open in SEO view, which shows its search result, link preview and
 * structured data with the same fields beside them, and Optimize with AI. A field being typed in is left first, as a
 * click away leaves it, so what it holds is saved, or kept as refused, by its own control before the view opens on it.
 */
export function SeoInlineActions({ subject, overlay, typed }: { subject: SeoSubject; overlay: ProjectState; typed: TypedSeo }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = () => {
    const settings = ref.current?.parentElement ?? null;
    const opened = openSeoViewFrom(subject, {
      leave: () => {
        const at = document.activeElement;
        // At once, with what the field shows after: whether it refused the text is read straight after.
        if (settings && at instanceof HTMLElement && settings.contains(at) && at.matches('input, textarea')) flushSync(() => at.blur());
      },
      refused: () => {
        const el = settings?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input[aria-invalid="true"], textarea[aria-invalid="true"]');
        if (!el) return null;
        const label = el.labels?.[0];
        const name = (label?.querySelector('.grow')?.textContent ?? label?.textContent ?? '').trim();
        return { name: name || 'Search & sharing', focus: () => el.focus() };
      }
    });
    // The button goes with the settings it was in: focus moves to the view's way back to the overview.
    if (opened) requestAnimationFrame(() => document.querySelector<HTMLElement>('.seo-view .seo-back')?.focus());
  };
  return (
    <div className="seo-inline-actions" ref={ref}>
      <button type="button" className="btn btn-sm" onClick={open}>
        <SearchCheck aria-hidden /> Open in SEO view
      </button>
      <SeoAiAction subject={subject} overlay={overlay} typed={typed} from="inline" />
    </div>
  );
}

/**
 * A page's or a post's Search & sharing previews in the SEO view, in tabs: its search result on a computer or a phone,
 * the card a shared link makes, and its structured data with where it is published. `shown` says whether the previews
 * are on screen: the structured data, which reads the whole website, is worked out only while its tab shows. `overlay`
 * lays the text typed into the document's fields and not saved yet over the project. Optimize with AI sits with the
 * settings it changes (SeoView), not under the previews.
 */
export function SeoPreview({
  state,
  subject,
  overlay,
  doc,
  shown = true,
  onEditType
}: {
  state: ProjectState;
  subject: SeoSubject;
  overlay: ProjectState;
  doc: DocumentPreview | null;
  shown?: boolean;
  /** A page's way from its structured data to the Page type field that sets it. */
  onEditType?: () => void;
}) {
  const key = subjectKey(subject);
  // Ids of their own, so the tabs never share one with another mount's.
  const uid = useId();
  // Each document opens on its search result.
  const [chosen, setChosen] = useState<{ key: string; tab: PreviewTab }>({ key, tab: 'search' });
  const tab = chosen.key === key ? chosen.tab : 'search';
  const [structured, setStructured] = useState<{ key: string; value: StructuredPreview | null } | null>(null);
  const showing = shown && tab === 'data' && !!doc;
  const ready = structured?.key === key;
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
    <div className="seo-preview seo-preview-wide" data-seo-preview={key}>
      <Tabs<PreviewTab>
        value={tab}
        onChange={(v) => setChosen({ key, tab: v })}
        label="Preview surface"
        idBase={`seo-preview-${uid.replace(/[^A-Za-z0-9_-]/g, '')}-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`}
        options={[
          { value: 'search', label: 'Search result', panel: () => <SearchResults state={state} doc={doc} kind={subject.kind === 'page' ? 'page' : 'post'} /> },
          { value: 'link', label: 'Link preview', panel: () => <SharingPreview card={doc.card} /> },
          { value: 'data', label: 'Structured data', panel: () => <StructuredData key={key} structured={ready && settled.current ? structured!.value : undefined} noAddress={!!doc.card.addressNote} onEditType={onEditType} /> }
        ]}
      />
    </div>
  );
}
