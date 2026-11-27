import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Component, FileDown, FilePlus, FileSearch, FileText, FileUp, Globe, Grid3x3, ImageDown, ImageIcon, ImageOff, ImagePlus, Info, MapPin, Newspaper, PanelTop, RefreshCw, Replace, Search, Sparkles, Trash2, TriangleAlert, Type, Upload } from 'lucide-react';
import { allTrees, displayName } from '@engine/tree';
import { isDocumentLink } from '@engine/apply';
import type { AltReview, AssetRecord, OwnerRef, ProjectState } from '@shared/types';
import { api, applyOps, attachToChat, commitOps, getState, inspectorFocusRequest, setState, toast, undoAction, undoAvailable, useStore, type UndoTarget } from '../store';
import { Disclosure, DisclosureMark, Field, DraftInput, Segmented, Spinner, Tabs, openSection } from '../components/ui';
import { TEXT_LIMITS } from '@shared/text-limits';
import { isValidFontAsset } from '@shared/fonts';
import { FontList } from './FontFiles';
import { inSeries, sortAssets } from '@shared/asset-order';
import { AssetOrderControls, shortName, useAssetSeries } from '../components/AssetOrder';
import { Picture, Thumb } from '../components/AssetPicture';
import { assetDropRefusal, goToShellPart, imagePlacement, openComponentStudio, openPost, openSiteStyles, placeAsset, selectPage, openLayout } from '../lib/actions';
import { beginAssetDrag } from '../lib/asset-drag';
import { SHOW_ASSET_EVENT } from '../lib/place';
import { formatBytes, plural } from '../lib/storage';
import { sameNameLabels } from '../lib/same-name';
import { FreeSpaceDialog, StorageSummary, useProjectStorage } from './AssetStorage';
import { assetArrived, reviewImport } from '../lib/import-review';
import { perfMark } from '../lib/perf';
import { documentDetails, documentLabels, documentName, libraryDocuments } from '../lib/documents';
import { altChecks } from '../lib/alt-review';
import { imageUseRows, type ImageUseRow, type PlaceLabel, type UseField } from '../lib/asset-uses';
import { defaultEditorNode } from '../lib/design-content';
import type { MissingAssetFiles, WebCopyPlan } from '@shared/api';
import './AssetsPanel.css';

/** Whether a library file is still in the project, for text kept for its fields (see DraftInput's keepWhile). */
const assetAlive = (id: string) => () => Object.hasOwn(getState().snapshot?.state.assets.assets ?? {}, id);

/** Above this an image is worth flagging: pages load smaller copies, but the original still ships with the site. */
const LARGE = 1_500_000;


function formatType(mime: string): string {
  if (mime === 'image/svg+xml') return 'SVG';
  return mime.replace(/^image\//, '').toUpperCase();
}

const nameOf = (a: AssetRecord) => a.name.trim() || 'Untitled image';
/** How far a pressed image tile moves before it is dragged onto the canvas rather than clicked (as Insert's tiles). */
const DRAG_START = 5;

/** The library's three kinds, each shown on its own: a long image grid never buries fonts or documents. */
type Section = 'images' | 'fonts' | 'documents';
/** Smaller thumbnails, for scanning a long library by eye. Kept while the app runs, whichever project is open. */
let compactPref = false;

/**
 * What is wrong with an image's files: every file gone (nothing can show it), only the original gone (its
 * smaller copies still show, but the site is built from the original), or some smaller copies gone.
 */
function damage(a: AssetRecord, gone: MissingAssetFiles | undefined): 'all' | 'original' | 'copies' | null {
  if (!gone) return null;
  if (!gone.original) return 'copies';
  return (a.variants?.length ?? 0) <= gone.variants.length ? 'all' : 'original';
}

/** What a tile shows of its image: every field of the record but those only search reads, by value. */
function sameTileRecord(a: AssetRecord, b: AssetRecord): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.name !== b.name || a.file !== b.file || a.mime !== b.mime || a.bytes !== b.bytes || a.width !== b.width || a.height !== b.height) return false;
  const x = a.variants ?? [];
  const y = b.variants ?? [];
  return x.length === y.length && x.every((v, i) => v.file === y[i].file && v.width === y[i].width);
}

interface TileProps {
  a: AssetRecord;
  /** Why it can't be picked here, or null. */
  reason: string | null;
  hurt: ReturnType<typeof damage>;
  /** Smaller copies missing, and the picture's key, which starts it again when its files come back or go. */
  copies: number;
  thumbKey: string;
  gone: boolean;
  /** What tells it apart from images of the same name. */
  apart: string | undefined;
  /** Chosen so far (true or false) where picking is not yet acting on it; undefined elsewhere. */
  picked: boolean | undefined;
  tabbable: boolean;
  compact: boolean;
  devUrl: string | null;
  /** In the library, where a damaged tile says where its repair is. */
  drag: boolean;
}

/**
 * One image of the grid. It draws only from its props: values, and a record the grid hands on as the same object while
 * what a tile shows of it is unchanged (every snapshot brings new objects), so a snapshot that leaves the image as it
 * was leaves its tile alone. Clicks, focus and drags are handled by the grid around it, from the render that is current.
 */
const AssetTile = memo(function AssetTile({ a, reason, hurt, copies, thumbKey, gone, apart, picked, tabbable, compact, devUrl, drag }: TileProps) {
  const big = a.bytes > LARGE && !gone;
  // Two imports can share a name ("hero"): their size, the day they were added or their uses tell them apart.
  const name = apart ? `${nameOf(a)} (${apart})` : nameOf(a);
  // The chip's words, and the shorter ones a narrow tile (compact, or the sidebar at its narrowest) shows instead: the
  // alert glyph already says something is wrong, so the short form only names what. Never cut to an ellipsis.
  const chip = hurt === 'all' ? 'Missing' : hurt === 'original' ? 'No original' : copies === 1 ? 'Copy missing' : 'Copies missing';
  const chipShort = hurt === 'all' ? 'Missing' : hurt === 'original' ? 'Original' : copies === 1 ? 'Copy' : 'Copies';
  const missingLabel = hurt === 'all' ? 'file missing' : hurt === 'original' ? 'original file missing, smaller copies still show' : copies === 1 ? 'a smaller copy missing' : 'smaller copies missing';
  // In the library, a damaged tile says where its repair is: opening it shows the details, which hold it.
  const repair = gone && !reason && drag ? (hurt === 'copies' ? 'Open it to make the copies again.' : 'Open it to locate the file.') : '';
  return (
    <button
      data-asset={a.id}
      className={`asset-tile${reason ? ' blocked' : ''}${picked ? ' picked' : ''}`}
      tabIndex={tabbable ? 0 : -1}
      aria-pressed={picked}
      aria-disabled={reason ? true : undefined}
      aria-label={`${gone ? `${name}, ${missingLabel}` : big ? `${name}, large file, ${formatBytes(a.bytes)}` : name}${reason ? `. ${reason}` : repair ? `. ${repair}` : ''}`}
      title={`${gone ? `${name}\n${missingLabel[0].toUpperCase()}${missingLabel.slice(1)}` : big ? `${name}\nLarge file: ${formatBytes(a.bytes)}` : name}${reason ? `\n${reason}` : repair ? `\n${repair}` : ''}`}
    >
      {hurt === 'all' ? (
        // Nothing is left to show: a picture still on screen would only be the browser's memory of it.
        <span className="asset-thumb asset-thumb-gone">
          <ImageOff aria-hidden="true" />
          {repair && !compact && (
            <span className="asset-thumb-repair" aria-hidden="true">
              Open to repair
            </span>
          )}
        </span>
      ) : (
        <Thumb key={thumbKey} a={a} devUrl={devUrl} />
      )}
      {picked && (
        <span className="asset-picked" aria-hidden="true">
          <Check />
        </span>
      )}
      {gone && (
        <span className={`asset-size asset-gone${hurt === 'copies' ? (copies === 1 ? ' copy' : ' copies') : ''}`} aria-hidden="true">
          <TriangleAlert />
          {chipShort === chip ? (
            <span>{chip}</span>
          ) : (
            <>
              <span className="asset-chip-long">{chip}</span>
              <span className="asset-chip-short">{chipShort}</span>
            </>
          )}
        </span>
      )}
      {big && (
        <span className="asset-size" aria-hidden="true">
          <Info />
          <span>{formatBytes(a.bytes)}</span>
        </span>
      )}
      {/* Smaller thumbnails are for scanning by eye: the name is in the tile's tooltip and its spoken name. */}
      {!compact && <span className="asset-name">{shortName(nameOf(a))}</span>}
      {apart && !compact && <span className="asset-tile-id">{apart}</span>}
    </button>
  );
});

/** Fonts sort by family, weight and style, and then file: two files of one face (say, two alphabets) sit together. */
const fontLabel = (a: AssetRecord) => `${a.font?.family ?? a.name} ${a.font?.weight ?? ''} ${a.font?.style ?? ''} ${a.file}`;

/**
 * Downloadable documents: each one's name, the file visitors download, where the site links to it, and what can be
 * done with it. A new version of the file goes in with Replace file, and every link follows; links can also move to
 * another document. A document stays while anything links to it, so no link is ever left going nowhere.
 */
function DocumentList({ state, docs, usage, missingOf, reveal, onRevealed }: { state: ProjectState; docs: AssetRecord[]; usage: Record<string, number>; missingOf: Map<string, MissingAssetFiles>; reveal: string | null; onRevealed: () => void }) {
  const labels = documentLabels(docs);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Where each document's links would move to, chosen before Move links.
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  // "Open in Assets" for a document opens its row once: the request is used up here. Focus follows on the next
  // frame, which only leaving the list cancels (using up the request re-renders before then).
  const focusFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
  useEffect(() => {
    if (!reveal) return;
    setOpen(reveal);
    onRevealed();
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => toggles.current.get(reveal)?.focus());
  }, [reveal, onRevealed]);
  const replaceFile = async (a: AssetRecord) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.project.locateAsset(a.id).catch((e: Error) => ({ ok: false, message: e.message }));
      if (r.message) toast(r.message, r.ok ? 'info' : 'error');
    } finally {
      setBusy(false);
    }
  };
  const moveLinks = async (a: AssetRecord, to: string) => {
    const target = state.assets.assets[to];
    if (missingOf.get(to)?.original) return toast(`${target ? documentName(target) : 'That document'} has a missing file, so links can’t move to it.`, 'error');
    const n = usage[a.id] ?? 0;
    const r = await commitOps([{ type: 'asset.replace', assetId: a.id, withAssetId: to }], `Move links from ${documentName(a)}`);
    if (r) {
      setMoveTo(({ [a.id]: _, ...rest }) => rest);
      toast(`${n === 1 ? 'The link' : `All ${n} links`} to ${documentName(a)} now go${n === 1 ? 'es' : ''} to ${target ? documentName(target) : 'the other document'}.`, 'info', undoAction(r));
    }
  };
  const remove = async (a: AssetRecord) => {
    const next = docs[docs.indexOf(a) + 1] ?? docs[docs.indexOf(a) - 1];
    const r = await commitOps([{ type: 'asset.remove', assetId: a.id }], `Remove ${documentName(a)}`);
    if (r) {
      toast(`Removed ${documentName(a)}.`, 'info', undoAction(r));
      // Focus moves to the next document, else to Add documents, never to the page.
      requestAnimationFrame(() => ((next && toggles.current.get(next.id)) || document.querySelector<HTMLElement>('.asset-add'))?.focus());
    }
  };
  return (
    <section className="doc-list" aria-label="Documents">
      {docs.length === 0 ? (
        <p className="doc-list-note">Files visitors download from your site: a PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV or ZIP file. Add one, then link a button to it by choosing Document as the link’s destination. It needs no other hosting.</p>
      ) : (
        <ul>
          {docs.map((a) => {
            const used = usage[a.id] ?? 0;
            const gone = missingOf.get(a.id)?.original;
            const expanded = open === a.id;
            // Links never move to a document whose own file is missing: they would go nowhere too.
            const others = docs.filter((d) => d.id !== a.id && !missingOf.get(d.id)?.original);
            return (
              <li key={a.id} className={`doc-item${expanded ? ' open' : ''}`} data-document={a.id}>
                <button
                  className="doc-toggle"
                  ref={(el) => {
                    if (el) toggles.current.set(a.id, el);
                    else toggles.current.delete(a.id);
                  }}
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : a.id)}
                >
                  <DisclosureMark />
                  <FileDown aria-hidden="true" />
                  <span className="doc-title">
                    <b>{labels.get(a.id)}</b>
                    <span className="doc-meta">
                      {documentDetails(a).split(' · ').map((part, i) => <span key={i}>{part}</span>)}
                    </span>
                    <span className={`doc-state${gone ? ' gone' : ''}`}>{gone ? 'File missing' : used ? `Linked ${plural(used, 'time', 'times')}` : 'Not linked'}</span>
                  </span>
                  {gone && <TriangleAlert className="doc-warn" aria-label="File missing" />}
                </button>
                {expanded && (
                  <div className="doc-body">
                    {gone && <p className="doc-missing">Its file is not in the project folder, so visitors can’t download it. Locate the file, or choose a new one.</p>}
                    <Field label="Name">
                      <DraftInput
                        className="input sm"
                        value={typeof a.name === 'string' ? a.name : ''}
                        ariaLabel={`Name of ${documentName(a)}`}
                        onCommit={(v) => {
                          const name = v.trim().slice(0, 120);
                          if (!name) return false;
                          if (name !== a.name) void applyOps([{ type: 'asset.update', assetId: a.id, name }], 'Rename document');
                        }}
                      />
                    </Field>
                    <DocumentPlaces state={state} assetId={a.id} />
                    <div className="doc-actions">
                      <button className="btn btn-sm" disabled={busy} onClick={() => void replaceFile(a)} title={used ? 'Choose a new version: every link to this document downloads it instead' : 'Choose another file for this document'}>
                        <FileUp /> {gone ? 'Locate file…' : 'Replace file…'}
                      </button>
                      {used > 0 && others.length > 0 && (
                        <span className="doc-move">
                          <select className="select sm" value={others.some((d) => d.id === moveTo[a.id]) ? moveTo[a.id] : ''} aria-label={`Document to move the links to ${documentName(a)} to`} onChange={(e) => setMoveTo((m) => ({ ...m, [a.id]: e.target.value }))}>
                            <option value="" disabled>
                              Move its links to…
                            </option>
                            {others.map((d) => (
                              <option key={d.id} value={d.id}>
                                {labels.get(d.id)}
                              </option>
                            ))}
                          </select>
                          <button className="btn btn-sm" disabled={!others.some((d) => d.id === moveTo[a.id])} onClick={() => void moveLinks(a, moveTo[a.id])}>
                            Move links
                          </button>
                        </span>
                      )}
                      <button className="btn btn-sm btn-danger" disabled={used > 0} onClick={() => void remove(a)} title={used ? `Linked ${plural(used, 'time', 'times')}. Replace its file, move its links to another document, or change those links first.` : `Remove ${documentName(a)}`}>
                        <Trash2 /> Remove
                      </button>
                    </div>
                    {used > 0 && <p className="doc-list-note">It can’t be removed while the site links to it: visitors would find those links going nowhere.</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Where the site links to a document, each place a button that goes there. */
function DocumentPlaces({ state, assetId }: { state: ProjectState; assetId: string }) {
  const places = placesOf(state, assetId);
  if (!places.length) return <p className="doc-list-note">No page links to it yet.</p>;
  return (
    <ul className="doc-places" aria-label="Linked from">
      {places.map((p) => {
        const Icon = PLACE_ICON[p.icon];
        const text = `${p.where}${p.what ? ` · ${p.what}` : ''}${p.count > 1 ? ` (${p.count})` : ''}`;
        return (
          <li key={p.key}>
            {p.go ? (
              <button className="link-btn" onClick={p.go}>
                <Icon aria-hidden="true" /> {text}
              </button>
            ) : (
              <span>
                <Icon aria-hidden="true" /> {text}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface Place {
  key: string;
  icon: 'page' | 'shell' | 'component' | 'site';
  where: string;
  what?: string;
  count: number;
  go?: () => void;
}

/** Said when a component's design was to be shown and it can no longer be changed here (removed meanwhile). */
const GONE = 'That component can no longer be changed here.';

/**
 * Selects an element where an image is used: on its page, in the shared part that shows it, or in a component's
 * design, opened in Component Studio. For a placed component's image, the inspector opens the field it is in: in a
 * gallery or team, that row, opened.
 */
const revealUse = (owner: OwnerRef, nodeId: string, field?: UseField, label = 'That image') => () => {
  if (owner.kind === 'page') selectPage(owner.id);
  else if (owner.kind === 'template') openLayout(owner.id);
  else if (owner.kind === 'component' && !openComponentStudio(owner.id)) return toast(GONE, 'info');
  else if (owner.kind === 'shell' && !goToShellPart(owner.id)) return toast(`No page shows the shared ${owner.id}, so this image is not on any page.`, 'info');
  const opening = getState().snapshot?.workspaceKey;
  setState({ selection: { owner, instancePath: [], nodeId }, rightTab: 'inspect', dockOpen: true, ...(field && opening ? { inspectorFocus: inspectorFocusRequest({ opening, owner, nodeId, ...field, label }) } : {}) });
};

/** Frames to wait for the Inspector to show what a component's starting value opened, before giving up quietly. */
const OVERVIEW_FRAMES = 60;

/**
 * Where a component's starting image or link is changed, in Component Studio: the element of its design whose image
 * (or link, for a document) shows the property, with that field in its Content focused. When no one element shows it
 * that way (a list's starting rows, a property nothing shows, several properties at once), the component with nothing
 * selected and, for a managed one, its Properties opened.
 */
const openComponentDefaults = (definitionId: string, prop?: string, content: 'image' | 'link' = 'image', part?: string) => () => {
  if (!openComponentStudio(definitionId)) return toast(GONE, 'info');
  const s = getState();
  const def = s.snapshot?.state.components[definitionId];
  const nodeId = def && prop ? defaultEditorNode(def, prop, content, part) : null;
  setState({ selection: nodeId ? { owner: { kind: 'component', id: definitionId }, instancePath: [], nodeId } : null });
  if (def?.kind !== 'managed') return;
  const opening = s.snapshot!.workspaceKey;
  const field = prop ? `[data-field="${CSS.escape(prop)}"][data-content="${content}"]` : '';
  let frames = 0;
  const step = () => {
    const now = getState();
    // Gone elsewhere meanwhile (another component, another part selected, another project): nothing more opens.
    if (now.snapshot?.workspaceKey !== opening || now.definitionMode?.definitionId !== definitionId || (now.selection?.nodeId ?? null) !== nodeId) return;
    if (nodeId) {
      if (document.querySelector(`#dock-panel-inspect ${field}`)) return openSection('def-content', { focus: `${field} :is(input, select, textarea, button)` });
      // Content shows its fields only while open: opened on the way.
      openSection('def-content', { scroll: false });
    } else if (document.querySelector('#dock-panel-inspect .insp-part-list')) return openSection('def-properties');
    if (++frames < OVERVIEW_FRAMES) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/** Whether a component's design and starting values can be changed in Component Studio: the project's own. */
const editable = (state: ProjectState, definitionId: string) => state.components[definitionId]?.owner === 'project';

/** Where a use in an element or a component goes: that element (in Component Studio for a design), or where the
 *  component's starting value is changed. None for a theme component's, which can't be changed. */
function goToPlace(state: ProjectState, p: Pick<PlaceLabel, 'at' | 'field' | 'what' | 'definitionId' | 'prop' | 'part'>): (() => void) | undefined {
  if (p.at) return revealUse(p.at.owner, p.at.nodeId, p.field, p.what);
  return p.definitionId && editable(state, p.definitionId) ? openComponentDefaults(p.definitionId, p.prop, 'image', p.part) : undefined;
}

/**
 * Where Show goes for one use of an image: its element and field (in Component Studio for a component's design), where
 * a component's starting image is changed, its page's settings, or Site styles.
 */
export function showUse(state: ProjectState, u: ImageUseRow): (() => void) | undefined {
  if (u.at || u.definitionId) return goToPlace(state, u);
  const post = u.post;
  if (post) return () => void openPost(post.collectionId, post.entryId, post.n);
  if (u.setting === 'site') return openSiteStyles;
  const pageId = u.setting?.pageId;
  return pageId ? () => showPageSettings(pageId) : undefined;
}

/** A page's sharing image is changed in its settings: the page is selected with the Inspector open, whichever view
 *  was showing (the AI is the right panel's default, #696), in Preview as in Edit. */
function showPageSettings(pageId: string) {
  selectPage(pageId, null);
  setState({ rightTab: 'inspect', dockOpen: true });
}

/** For a use in a theme component, whose design and starting values can't be changed: how it is changed instead. */
function changeHint(state: ProjectState, u: ImageUseRow): string | undefined {
  return u.definitionId && !editable(state, u.definitionId) ? 'Part of the theme: change it with Replace everywhere' : undefined;
}

/** What a use's button says it does: shows the element, or opens the component its starting image belongs to. */
const showLabel = (state: ProjectState, u: Pick<PlaceLabel, 'at' | 'definitionId' | 'what' | 'where'>) => (!u.at && u.definitionId ? `Open ${state.components[u.definitionId]?.name ?? u.where} in Component Studio` : `Show ${u.what} on ${u.where}`);

/** Every place a document is linked from, by the same rules as the engine's usage count. */
function placesOf(state: ProjectState, assetId: string): Place[] {
  const document = state.assets.assets[assetId]?.kind === 'document';
  const count = (v: unknown): number => {
    if (Array.isArray(v)) return v.reduce<number>((n, x) => n + count(x), 0);
    if (!v || typeof v !== 'object') return 0;
    let n = (v as { assetId?: unknown }).assetId === assetId || (isDocumentLink(v) && v.target === assetId) ? 1 : 0;
    for (const x of Object.values(v)) n += count(x);
    return n;
  };
  const out: Place[] = [];
  for (const t of allTrees(state)) {
    for (const n of Object.values(t.tree.nodes)) {
      const c = count(n);
      if (!c) continue;
      const what = displayName(state, n);
      const key = `${t.owner.kind}/${t.owner.id}/${n.id}`;
      if (t.owner.kind === 'page') out.push({ key, icon: 'page', where: t.label, what, count: c, go: revealUse(t.owner, n.id) });
      else if (t.owner.kind === 'shell') out.push({ key, icon: 'shell', where: `Shared ${t.label.toLowerCase()}`, what, count: c, go: revealUse(t.owner, n.id) });
      else if (t.owner.kind === 'template') out.push({ key, icon: 'page', where: t.label, what, count: c, go: revealUse(t.owner, n.id) });
      else out.push({ key, icon: 'component', where: `${t.label} design`, what, count: c, ...(editable(state, t.owner.id) ? { go: revealUse(t.owner, n.id) } : {}) });
    }
  }
  for (const d of Object.values(state.components)) {
    const c = count(d.properties);
    // One property's starting value opens where that is changed (for an object property, the one field holding it);
    // several, the component's Properties.
    const props = Object.keys(d.properties).filter((k) => count(d.properties[k]));
    const one = props.length === 1 ? d.properties[props[0]] : undefined;
    const parts = one?.type === 'object' ? Object.keys(one.fields).filter((f) => count(one.default?.[f]) + count(one.fields[f])) : [];
    const go = openComponentDefaults(d.id, one ? props[0] : undefined, 'link', parts.length === 1 ? parts[0] : undefined);
    if (c) out.push({ key: `default/${d.id}`, icon: 'component', where: `${d.name} default`, what: document ? 'Starting link for new copies' : 'Starting image for new copies', count: c, ...(editable(state, d.id) ? { go } : {}) });
  }
  for (const p of Object.values(state.pages)) {
    const c = count(p.seo) + (p.seo.socialImage === assetId ? 1 : 0);
    if (c) out.push({ key: `seo/${p.id}`, icon: 'page', where: p.title, what: 'Sharing image', count: c, go: () => showPageSettings(p.id) });
  }
  if (state.site.favicon === assetId) out.push({ key: 'favicon', icon: 'site', where: 'Site', what: 'Browser tab icon', count: 1, go: openSiteStyles });
  if (state.site.socialImage === assetId) out.push({ key: 'social', icon: 'site', where: 'Site', what: 'Sharing image', count: 1, go: openSiteStyles });
  if (state.site.identity?.logo === assetId) out.push({ key: 'logo', icon: 'site', where: 'Site', what: 'Publisher logo', count: 1, go: openSiteStyles });
  return out;
}

const PLACE_ICON = { page: FileText, shell: PanelTop, component: Component, site: Globe, post: Newspaper };

/** Arrow keys, Home and End move between tiles by row and column. The grid is one Tab stop: the tile last focused. */
function gridKeys(e: React.KeyboardEvent<HTMLElement>) {
  const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-asset]')];
  const i = tiles.indexOf(document.activeElement as HTMLElement);
  if (i < 0 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const cols = tiles.filter((t) => t.offsetTop === tiles[0].offsetTop).length || 1;
  const to = ({ ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - cols, ArrowDown: i + cols, Home: 0, End: tiles.length - 1 } as Record<string, number>)[e.key];
  if (to === undefined) return;
  e.preventDefault();
  tiles[Math.max(0, Math.min(tiles.length - 1, to))].focus();
}

/**
 * Whether the photo shown records where it was taken, asked for each time a photo is shown or its file changes.
 * An answer that arrives after another photo is shown is dropped.
 */
function useRecordsLocation(a: AssetRecord | null): boolean {
  const [answer, setAnswer] = useState<{ key: string; location: boolean } | null>(null);
  const id = a?.kind === 'image' ? a.id : null;
  const key = id && `${id}:${a!.file}`;
  useEffect(() => {
    if (!id || !key) return;
    let live = true;
    api.project
      .photoMetadata(id)
      .then((r) => live && setAnswer({ key, location: !!r?.location }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, key]);
  return !!key && answer?.key === key && answer.location;
}

/**
 * What a web-sized copy of a large JPEG or PNG would be (see WebCopyPlan), asked for each time such a picture is
 * shown or its file changes. Undefined while unknown.
 */
function useWebCopyPlan(a: AssetRecord | null, opening: string, originalMissing: boolean): WebCopyPlan | undefined {
  const [answer, setAnswer] = useState<{ key: string; plan: WebCopyPlan } | null>(null);
  const eligible = a?.kind === 'image' && a.bytes > LARGE && (a.mime === 'image/jpeg' || a.mime === 'image/png');
  const id = eligible ? a.id : null;
  // Asked again when the original comes back (Locate file) or the project is opened again.
  const key = id && `${opening}:${id}:${a!.file}:${a!.hash}:${originalMissing ? 'missing' : 'here'}`;
  useEffect(() => {
    if (!id || !key) return;
    let live = true;
    api.project
      .webCopyPlan(id)
      .then((plan) => live && setAnswer({ key, plan }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, key]);
  // Undefined while the answer is on its way, so the details never flash the advice for when no copy can be made.
  if (!key) return null;
  return answer?.key === key ? answer.plan : undefined;
}

/** `narrow`: the sidebar is drawn under 240px wide, so the header drops the image count. */
export function AssetsPanel({ narrow }: { narrow: boolean }) {
  const snap = useStore((s) => s.snapshot);
  const runtime = useStore((s) => s.runtime);
  // Where Place on page puts the image follows the page, its selection and the editing mode.
  useStore((s) => s.selection);
  useStore((s) => s.pageId);
  useStore((s) => s.mode);
  useStore((s) => s.definitionMode);
  const assetSort = useStore((s) => s.assetSort);
  const [placing, setPlacing] = useState(false);
  // A second click while the first placement is on its way places nothing more.
  const placingNow = useRef(false);
  const [over, setOver] = useState(false);
  const dragDepth = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const replaceSession = useRef(0);
  const replacingNow = useRef(false);
  const [q, setQ] = useState('');
  const [pickQ, setPickQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'unused' | 'missing'>('all');
  const [importing, setImporting] = useState(false);
  // Files are being written: only once the author has confirmed what comes in, never while they review it.
  const [adding, setAdding] = useState(false);
  const [section, setSection] = useState<Section>('images');
  const [compact, setCompactState] = useState(compactPref);
  const setCompact = (v: boolean) => {
    compactPref = v;
    setCompactState(v);
  };
  // The grid's one Tab stop: the tile focused last, while it is still shown.
  const [activeTile, setActiveTile] = useState<string | null>(null);
  // Each image's record as its tile last drew it, handed on again while what the tile shows of it is unchanged.
  const tileRecords = useRef(new Map<string, AssetRecord>());
  // Where the grid was scrolled when an image's details opened, so Back returns to the same view.
  const browseScroll = useRef(0);
  // The images view's scroll container, in browsing and in Replace everywhere alike.
  const bodyRef = useRef<HTMLDivElement>(null);
  // The tile to keep in view when the thumbnails change size.
  const densityAnchor = useRef<string | null>(null);
  useEffect(() => {
    const id = densityAnchor.current;
    densityAnchor.current = null;
    if (id) bodyRef.current?.querySelector<HTMLElement>(`[data-asset="${id}"]`)?.scrollIntoView({ block: 'start' });
  }, [compact]);
  const [nameError, setNameError] = useState<string | null>(null);
  const [allPlaces, setAllPlaces] = useState(false);
  // Replacing in some places: the uses ticked (by key) and the image picked for them. Null: every place, as picked.
  const [choosing, setChoosing] = useState<{ chosen: string[]; pick: string | null } | null>(null);
  // The uses whose alt text the last Replace everywhere left to check, shown with the replaced image while that change stands.
  const [altReview, setAltReview] = useState<{ assetId: string; withId: string; undo: UndoTarget; review: AltReview[] } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [fixing, setFixing] = useState(false);
  const storage = useProjectStorage();
  const [freeing, setFreeing] = useState(false);
  // Free up space belongs to the project it was opened for.
  const opening = snap?.workspaceKey;
  useEffect(() => setFreeing(false), [opening]);
  useEffect(() => setAltReview(null), [opening]);
  const assetsDoc = snap?.state.assets.assets;
  // Images whose files are not in the project folder: their uses stay, and the details offer to bring the files back.
  const missingAssets = snap?.missingAssets;
  const missingOf = useMemo(() => new Map((missingAssets ?? []).map((m) => [m.assetId, m])), [missingAssets]);
  // Images and fonts are listed apart: a font is never shown, picked or replaced as a picture.
  const assets = useMemo(() => sortAssets(Object.values(assetsDoc ?? {}).filter((a) => a?.kind === 'image'), assetSort), [assetsDoc, assetSort]);
  // The series shown while browsing, and while picking a replacement: the picker opens on every series, so a
  // series chosen to browse never hides the image wanted in its place.
  const browseSeries = useAssetSeries(assets, opening);
  const pickSeries = useAssetSeries(assets, opening);
  // A new search, sort, series or filter shows its results from the first one, never from partway down, and Tab
  // enters them at the first result too.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    setActiveTile(null);
  }, [q, pickQ, filter, browseSeries.key, pickSeries.key, assetSort]);
  const assetUsage = snap?.assetUsage;
  /** What tells apart each image whose name another image has, compared as the AI chat compares names. */
  const sameNames = useMemo(() => sameNameLabels(assets, assetUsage ?? {}, (a) => nameOf(a).toLowerCase()), [assets, assetUsage]);
  const fonts = useMemo(() => Object.values(assetsDoc ?? {}).filter(isValidFontAsset).sort((a, b) => fontLabel(a).localeCompare(fontLabel(b))), [assetsDoc]);
  const documents = useMemo(() => (snap ? libraryDocuments(snap.state) : []), [snap]);
  // The document "Open in Assets" asked for, until the list has opened it.
  const [shownDocument, setShownDocument] = useState<string | null>(null);
  const revealed = useCallback(() => setShownDocument(null), []);
  const sel = selected && assetsDoc ? (assetsDoc[selected] ?? null) : null;
  const recordsLocation = useRecordsLocation(sel);
  const webPlan = useWebCopyPlan(sel, snap?.workspaceKey ?? '', !!(sel && missingOf.get(sel.id)?.original));
  const [copying, setCopying] = useState(false);
  // The image shown now, and the latest Add images: an answer that arrives later only changes the view still showing.
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const importRun = useRef(0);
  const places = useMemo(() => (snap && sel?.kind === 'image' ? imageUseRows(snap.state, sel.id) : []), [snap, sel]);
  useEffect(() => {
    setNameError(null);
    setAllPlaces(false);
    setChoosing(null);
    setAltReview((r) => (r?.assetId === selected ? r : null));
  }, [selected]);
  // A pending "Import a replacement" never applies after the panel has gone.
  useEffect(() => () => void replaceSession.current++, []);
  // An image removed elsewhere (undo, the AI) closes its details rather than leaving them blank.
  useEffect(() => {
    if (selected && assetsDoc && !assetsDoc[selected]) {
      replaceSession.current++;
      const hadFocus = document.activeElement === document.body || !!document.activeElement?.closest('.asset-host');
      setSelected(null);
      setReplacing(false);
      if (hadFocus) requestAnimationFrame(() => (document.querySelector<HTMLElement>('.asset-tools input') ?? document.querySelector<HTMLElement>('.asset-drop'))?.focus());
    }
  }, [selected, assetsDoc]);
  // "Show image" (an import kept here rather than placed) opens that image's details.
  useEffect(() => {
    let frame = 0;
    const onShow = (e: Event) => {
      const { opening, assetId } = ((e as CustomEvent).detail ?? {}) as { opening?: string; assetId?: string };
      const s = getState().snapshot;
      const kind = assetId && s ? s.state.assets.assets[assetId]?.kind : undefined;
      if (!assetId || !s || s.workspaceKey !== opening || (kind !== 'image' && kind !== 'document')) return;
      replaceSession.current++;
      setReplacing(false);
      if (kind === 'document') {
        setSelected(null);
        setSection('documents');
        setShownDocument(assetId);
        return;
      }
      setSection('images');
      setSelected(assetId);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-detail .asset-back')?.focus());
    };
    window.addEventListener(SHOW_ASSET_EVENT, onShow);
    return () => {
      window.removeEventListener(SHOW_ASSET_EVENT, onShow);
      cancelAnimationFrame(frame);
    };
  }, []);
  // Undone, the replacement has nothing to check; redone, the same uses are listed again.
  const altToCheck = useMemo(() => (snap && sel && altReview?.assetId === sel.id && undoAvailable(altReview.undo, snap) ? altChecks(snap.state, altReview.withId, altReview.review) : []), [snap, sel, altReview]);
  if (!snap) return null;
  const usage = snap.assetUsage;
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const unused = assets.filter((a) => !usage[a.id]);
  const query = replacing ? pickQ : q;
  const needle = query.trim().toLowerCase();
  const series = replacing ? pickSeries : browseSeries;
  const matches = (a: AssetRecord) => (!series.key || inSeries(a, series.key)) && (!needle || `${a.name} ${a.description ?? ''} ${a.altSuggestion ?? ''}`.toLowerCase().includes(needle));
  const found = assets.filter((a) => matches(a) && !(replacing && a.id === sel?.id));
  const foundUnused = found.filter((a) => !usage[a.id]);
  // Images with files missing from the project folder, so they can be found without scrolling the whole library.
  const damaged = assets.filter((a) => missingOf.has(a.id));
  const foundDamaged = found.filter((a) => missingOf.has(a.id));
  const mode = replacing ? 'all' : filter === 'unused' && unused.length ? 'unused' : filter === 'missing' && damaged.length ? 'missing' : 'all';
  const shown = mode === 'unused' ? foundUnused : mode === 'missing' ? foundDamaged : found;
  const missingDocs = documents.filter((d) => missingOf.get(d.id)?.original).length;
  const removable = shown.filter((a) => !usage[a.id]);

  /** Focus moves to the tile (when it is still shown), else search, else the empty state's Add images. */
  const focusTile = (id?: string | null) =>
    requestAnimationFrame(() => {
      const el = (id && document.querySelector<HTMLElement>(`[data-asset="${id}"]`)) || searchRef.current || document.querySelector<HTMLElement>('.asset-drop');
      el?.focus();
    });
  const gridBody = () => bodyRef.current;
  /** Open an image's details, remembering where the grid was. */
  const openDetails = (id: string) => {
    browseScroll.current = gridBody()?.scrollTop ?? 0;
    setSelected(id);
    // The details start at the picture, whatever depth of the grid they were opened from.
    requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
    });
  };
  /** Back to the grid as it was left: the same scroll position, focus on the same tile. */
  const back = () => {
    const id = selected;
    setSelected(null);
    setReplacing(false);
    requestAnimationFrame(() => {
      const body = gridBody();
      if (body) body.scrollTop = browseScroll.current;
      const el = (id && document.querySelector<HTMLElement>(`[data-asset="${id}"]`)) || searchRef.current || document.querySelector<HTMLElement>('.asset-drop');
      el?.focus({ preventScroll: !!body });
      if (body && el?.matches('[data-asset]')) el.scrollIntoView({ block: 'nearest' });
    });
  };
  /** Change the thumbnail size and keep the picture in view: the focused tile, else the first one showing. */
  const toggleCompact = () => {
    const body = gridBody();
    const focused = document.activeElement?.closest<HTMLElement>('[data-asset]');
    const top = body?.getBoundingClientRect().top ?? 0;
    const first = focused ?? [...(body?.querySelectorAll<HTMLElement>('[data-asset]') ?? [])].find((t) => t.getBoundingClientRect().bottom > top + 8);
    densityAnchor.current = body && body.scrollTop > 0 ? (first?.dataset.asset ?? null) : null;
    setCompact(!compact);
  };
  const openReplace = () => {
    replaceSession.current++;
    setPickQ('');
    pickSeries.choose('');
    setChoosing(null);
    setReplacing(true);
    // The picker starts at what is being replaced, however far down the details were scrolled.
    requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
    });
  };
  const closeReplace = () => {
    replaceSession.current++;
    setReplacing(false);
    setChoosing(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-replace-open')?.focus());
  };

  /**
   * Import through the app's picker (no paths) or dropped files, and say exactly what arrived. HEIC photos, large
   * photos and files that can't be added are shown in the import review first (see reviewImport).
   */
  const importFiles = async (paths?: string[], only?: 'image' | 'font' | 'document') => {
    const before = new Set(Object.keys(getState().snapshot?.state.assets.assets ?? {}));
    setImporting(true);
    try {
      const plan = await reviewImport(paths, only).catch((e: Error) => (toast(`The files couldn’t be added: ${e.message}`, 'error'), null));
      if (!plan) return { ids: [], added: [], failed: false, reviewed: false, chosen: 0 };
      setAdding(true);
      perfMark('import.requested', { files: plan.paths.length, revision: getState().snapshot?.revision ?? null });
      const r: { ok: boolean; assetIds: string[]; message?: string; note?: string } = await api.project.importAssets(plan.paths, only, plan.choices).catch((e: Error) => ({ ok: false, assetIds: [] as string[], message: `The files couldn’t be added: ${e.message}` }));
      // What arrived is told by kind once the new records reach this window (they come in one snapshot).
      if (r.assetIds.length) await assetArrived(r.assetIds[r.assetIds.length - 1], plan.choices.opening);
      const added = r.assetIds.filter((id) => !before.has(id));
      const already = r.assetIds.length - added.length;
      const doc = getState().snapshot?.state.assets.assets ?? {};
      const addedFonts = added.filter((id) => doc[id]?.kind === 'font').length;
      const addedDocuments = added.filter((id) => doc[id]?.kind === 'document').length;
      const addedImages = added.length - addedFonts - addedDocuments;
      const parts = [
        addedImages ? `Added ${plural(addedImages, 'image', 'images')}.` : '',
        addedFonts ? `Added ${plural(addedFonts, 'font', 'fonts')}. Use ${addedFonts === 1 ? 'it' : 'them'} in Site styles.` : '',
        addedDocuments ? `Added ${plural(addedDocuments, 'document', 'documents')}. Link a button to ${addedDocuments === 1 ? 'it' : 'them'}: choose Document as the link’s destination.` : '',
        already ? `${plural(already, 'file was', 'files were')} already here.` : '',
        r.note ?? '',
        r.message ?? ''
      ].filter(Boolean);
      // Nothing is said about a project that has been closed or opened again since.
      if (parts.length && getState().snapshot?.workspaceKey === plan.choices.opening) toast(parts.join(' '), r.message ? 'error' : 'info');
      return { ids: r.assetIds, added, failed: !!r.message, reviewed: plan.reviewed, chosen: plan.chosen };
    } finally {
      setImporting(false);
      setAdding(false);
    }
  };
  /**
   * Adding keeps the view (details, search, filter) as it is; the toast says what arrived. After a review (a photo
   * converted or made web-sized), the first image that arrived opens, so the author sees what was made.
   */
  const addImages = async (paths?: string[]) => {
    if (importing) return;
    const wasEmpty = assets.length === 0;
    const session = replaceSession.current;
    const run = ++importRun.current;
    const shownBefore = selectedNow.current;
    const opening = getState().snapshot?.workspaceKey;
    // While choosing a replacement picture, only pictures come in.
    const { ids, added, reviewed } = await importFiles(paths, replacing ? 'image' : undefined);
    if (replacing && replaceSession.current === session) {
      // A file that was already here is a candidate too: the search and series make way for the first file given.
      const next = ids.find((id) => id !== sel?.id);
      if (!next) return;
      setPickQ('');
      pickSeries.choose('');
      focusTile(next);
      return;
    }
    if (reviewed && ids.length && opening && !(await assetArrived(ids[ids.length - 1], opening))) return;
    // Only while the panel shows what it did when the import began: another import, a replacement, or the panel gone.
    const still = run === importRun.current && replaceSession.current === session && selectedNow.current === shownBefore && getState().snapshot?.workspaceKey === opening;
    const image = reviewed && still ? ids.find((id) => getState().snapshot?.state.assets.assets[id]?.kind === 'image') : undefined;
    if (image) {
      // A photo dropped on the Fonts or Documents tab still opens among the images, so Back goes there.
      setSection('images');
      setSelected(image);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-detail .asset-back')?.focus());
    } else if (added.length && wasEmpty && still) requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-add')?.focus());
  };

  /**
   * Add a web-sized copy of the large image shown, and when it is used, show the copy in all its places (one step
   * that can be undone). The original stays in Assets; the copy's details open.
   */
  const makeWebCopy = async () => {
    const opening = getState().snapshot?.workspaceKey;
    if (!sel || copying || !opening) return;
    const replace = (usage[sel.id] ?? 0) > 0;
    const n = places.length || usage[sel.id] || 0;
    const name = nameOf(sel);
    const from = sel.id;
    const session = replaceSession.current;
    setCopying(true);
    try {
      const r = await api.project.makeWebCopy(from, { replace, opening }).catch((e: Error) => ({ ok: false, message: e.message }) as Awaited<ReturnType<typeof api.project.makeWebCopy>>);
      // Nothing is said about a project that has been closed or opened again since.
      if (getState().snapshot?.workspaceKey !== opening) return;
      if (!r.ok || !r.assetId) {
        if (r.message) toast(r.message, r.ok ? 'info' : 'error');
        return;
      }
      const undo = r.entryId && r.revision !== undefined ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: opening }) : undefined;
      toast(replace ? `A web-sized copy now shows in ${n === 1 ? 'its place' : `all ${n} places`} instead of ${name}. The original is still in Assets.` : r.message ?? `Added a web-sized copy of ${name}.`, 'info', undo);
      // The copy opens only while the author is still looking at the image it was made from.
      if ((await assetArrived(r.assetId, opening)) && selectedNow.current === from && replaceSession.current === session) {
        replaceSession.current++;
        setReplacing(false);
        setSelected(r.assetId);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-detail .asset-back')?.focus());
      }
    } finally {
      setCopying(false);
    }
  };

  const addDocuments = async () => {
    if (importing) return;
    await importFiles(undefined, 'document');
  };
  const addFonts = async () => {
    if (importing) return;
    await importFiles(undefined, 'font');
  };

  /**
   * Show another image in every place this one is used, or only in the places chosen (`only`) as the project was at
   * `revision`, the one their preview showed: a project changed since is refused, to choose again. One step either way.
   */
  const replaceWith = async (withId: string, only?: { uses: ImageUseRow[]; revision: number }) => {
    // A second choice while the first is on its way replaces nothing more.
    if (!sel || withId === sel.id || replacingNow.current || only?.uses.length === 0) return;
    // Checked again on the way in: a picture whose file has gone would carry the problem into every place.
    if (getState().snapshot?.missingAssets.some((m) => m.assetId === withId)) return toast('That image has missing files, so it can’t replace another image. Repair it in its details first.', 'error');
    const n = only?.uses.length ?? (places.length || usage[sel.id] || 0);
    const target = getState().snapshot?.state.assets.assets[withId];
    const uses = only?.uses.flatMap((u) => (u.target ? [u.target] : []));
    const session = replaceSession.current;
    replacingNow.current = true;
    const r = await commitOps(
      [{ type: 'asset.replace', assetId: sel.id, withAssetId: withId, ...(uses ? { uses } : {}) }],
      only ? `Replace ${nameOf(sel)} in ${plural(n, 'place', 'places')}` : `Replace ${nameOf(sel)}`,
      undefined,
      only?.revision
    ).finally(() => (replacingNow.current = false));
    if (r) {
      // The picker it was chosen in closes; one opened again since stays as it is.
      if (replaceSession.current === session) {
        replaceSession.current++;
        setReplacing(false);
        setChoosing(null);
      }
      // Uses with a description of their own, or none now, are listed with this image for the author to check.
      const review = (r.results?.[0]?.altReview ?? []) as AltReview[];
      const check = review.length > 0 && !!r.entryId && selectedNow.current === sel.id;
      setAltReview(check ? { assetId: sel.id, withId, undo: { entryId: r.entryId!, workspaceKey: r.workspaceKey, revision: r.revision }, review } : null);
      const more = check ? ` Check the alt text in ${review.length === 1 ? 'one place' : `${review.length} places`} below.` : '';
      const where = only ? (n === 1 ? 'the place you chose' : `the ${n} places you chose`) : n === 1 ? 'its place' : `all ${n} places`;
      toast(`${target ? nameOf(target) : 'The new image'} now shows in ${where} instead of ${nameOf(sel)}.${more}`, 'info', undoAction(r));
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-detail .asset-back')?.focus());
    }
  };
  /** Locate a missing file, or make missing copies again, and say how it went. */
  const fixFiles = async (run: () => Promise<{ ok: boolean; message?: string }>) => {
    if (fixing) return;
    setFixing(true);
    try {
      const r = await run().catch((e: Error) => ({ ok: false, message: e.message }));
      if (r.message) toast(r.message, r.ok ? 'info' : 'error');
      // The repair buttons go once the files are back: focus stays in the image's details.
      if (r.ok) requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-detail .asset-back')?.focus());
    } finally {
      setFixing(false);
    }
  };
  const removeOne = async (a: AssetRecord) => {
    const i = shown.findIndex((x) => x.id === a.id);
    const next = shown[i + 1] ?? shown[i - 1];
    const r = await commitOps([{ type: 'asset.remove', assetId: a.id }], `Remove ${nameOf(a)}`);
    if (r) {
      setSelected(null);
      toast(`Removed ${nameOf(a)}.`, 'info', undoAction(r));
      focusTile(next?.id);
    }
  };
  const removeMany = async (list: AssetRecord[]) => {
    const label = list.length === 1 ? `Remove ${nameOf(list[0])}` : `Remove ${list.length} unused images`;
    const r = await commitOps(list.map((a) => ({ type: 'asset.remove' as const, assetId: a.id })), label);
    if (r) {
      toast(`Removed ${plural(list.length, 'unused image', 'unused images')}.`, 'info', undoAction(r));
      if (list.length === unused.length) setFilter('all');
      focusTile(null);
    }
  };

  /** Escape leaves the details (or the replace picker), unless it is reverting a field or clearing a search. */
  const onEscape = (fn: () => void) => (e: React.KeyboardEvent) => {
    const t = e.target as HTMLInputElement;
    if (e.key !== 'Escape' || t.matches('textarea, input:not([type="search"]):not([type="checkbox"])') || (t.matches('input:not([type="checkbox"])') && t.value)) return;
    e.stopPropagation();
    fn();
  };

  const isFileDrag = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!over) setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setOver(false);
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
      if (paths.length) void addImages(paths);
    }
  };

  const roving = shown.some((a) => a.id === activeTile) ? activeTile : (shown[0]?.id ?? null);
  // An image tile pressed and moved a few pixels is dragged onto the canvas, which outlines the image on the page it
  // would fill or replace (#505); the click that ends a drag opens nothing. A click, Enter or Space still opens it.
  const dragged = useRef(false);
  const dragFrom = (a: AssetRecord) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      dragged.current = false;
      if (e.button !== 0 || !e.isPrimary || e.pointerType === 'touch') return;
      const from = { x: e.clientX, y: e.clientY, pointer: e.pointerId };
      const stop = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', stop, true);
        window.removeEventListener('pointercancel', stop, true);
        window.removeEventListener('blur', stop);
      };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== from.pointer || Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_START) return;
        stop();
        // Refused for the reason Place on page gives (Preview, the AI working, the file missing...): said once, as the
        // drag would have started.
        const why = assetDropRefusal(a.id);
        if (why) {
          dragged.current = true;
          return toast(why, 'error');
        }
        if (!beginAssetDrag({ assetId: a.id, name: nameOf(a) }, { x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId })) return;
        dragged.current = true;
        window.getSelection()?.removeAllRanges();
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', stop, true);
      window.addEventListener('pointercancel', stop, true);
      window.addEventListener('blur', stop);
    },
    onDragStart: (e: React.DragEvent<HTMLElement>) => e.preventDefault()
  });
  /** Whether a click ends a drag. A keyboard's click never does. */
  const endsDrag = (e: React.MouseEvent<HTMLElement>) => {
    if (e.detail === 0) return false;
    const was = dragged.current;
    dragged.current = false;
    return was;
  };
  /**
   * `blocked` gives the reason a tile can't be picked here, or null. `picked`: the tile chosen so far, when picking
   * one is not yet acting on it (replacing in some places). `drag`: a tile can be dragged onto the canvas.
   */
  const grid = (onPick: (a: AssetRecord) => void, label: string, { blocked, picked, drag }: { blocked?: (a: AssetRecord) => string | null; picked?: string | null; drag?: boolean } = {}) => {
    // The records the tiles drew last, kept for the images shown now only, so a removed image's goes with it.
    const drawn = tileRecords.current;
    const kept = new Map<string, AssetRecord>();
    tileRecords.current = kept;
    // The tile an event happened in, from the images this render shows: the tiles themselves hold no handlers.
    const tileOf = (e: React.SyntheticEvent) => {
      const id = (e.target as Element).closest?.('[data-asset]')?.getAttribute('data-asset');
      return id ? shown.find((x) => x.id === id) : undefined;
    };
    return (
      <div
        className={`asset-grid${compact ? ' compact' : ''}`}
        role="group"
        aria-label={label}
        aria-describedby="asset-grid-keys"
        onKeyDown={gridKeys}
        onFocus={(e) => {
          const a = tileOf(e);
          if (a) setActiveTile(a.id);
        }}
        onClick={(e) => {
          const a = tileOf(e);
          if (a && !(drag && endsDrag(e)) && !(blocked?.(a) ?? null)) onPick(a);
        }}
        {...(drag
          ? {
              onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
                const a = tileOf(e);
                if (a) dragFrom(a).onPointerDown(e);
              },
              onDragStart: (e: React.DragEvent<HTMLElement>) => {
                if (tileOf(e)) e.preventDefault();
              }
            }
          : {})}
      >
        <span className="sr-only" id="asset-grid-keys">
          Arrow keys move between images.
        </span>
        {shown.map((fresh) => {
          const was = drawn.get(fresh.id);
          const a = was && sameTileRecord(was, fresh) ? was : fresh;
          kept.set(a.id, a);
          const gone = missingOf.get(a.id);
          return (
            <AssetTile
              key={a.id}
              a={a}
              reason={blocked?.(a) ?? null}
              hurt={damage(a, gone)}
              copies={gone?.variants.length ?? 0}
              thumbKey={gone ? `missing-${gone.original}-${gone.variants.length}` : 'present'}
              gone={!!gone}
              apart={sameNames.get(a.id)}
              picked={picked === undefined ? undefined : picked === a.id}
              tabbable={a.id === roving}
              compact={compact}
              devUrl={devUrl}
              drag={!!drag}
            />
          );
        })}
      </div>
    );
  };
  const noMatches = (
    <div className="asset-nomatch">
      <p>
        {needle && mode === 'missing' && found.length ? (
          <>No images with missing files match “{query.trim()}”.</>
        ) : series.key && mode === 'missing' ? (
          <>No images in {series.label} have missing files.</>
        ) : needle && mode === 'unused' && found.length ? (
          <>No unused images match “{query.trim()}”.</>
        ) : needle ? (
          <>No images {series.key ? `in ${series.label} ` : ''}match “{query.trim()}”.</>
        ) : series.key && mode === 'unused' ? (
          <>Every image in {series.label} is in use.</>
        ) : series.key ? (
          <>There are no other images in {series.label}.</>
        ) : replacing ? (
          'There are no other images in this project yet. Import a replacement to use here.'
        ) : (
          'Every image is in use.'
        )}
      </p>
      {mode !== 'all' && found.length > 0 && (needle || series.key) && (
        <button
          className="btn btn-sm"
          onClick={() => {
            setFilter('all');
            searchRef.current?.focus();
          }}
        >
          Show all {found.length}
        </button>
      )}
      {series.key && (
        <button
          className="btn btn-sm"
          onClick={() => {
            series.choose('');
            searchRef.current?.focus();
          }}
        >
          Clear series
        </button>
      )}
      {needle && (
        <button
          className="btn btn-sm"
          onClick={() => {
            (replacing ? setPickQ : setQ)('');
            searchRef.current?.focus();
          }}
        >
          Clear search
        </button>
      )}
    </div>
  );
  const filtering = !!(needle || series.key);
  const browseTools = (
    <div className="asset-tools">
      <div className="asset-search-row">
        <div className="search">
          <Search />
          <input ref={searchRef} className="input" type="search" placeholder="Search images" value={query} onChange={(e) => (replacing ? setPickQ : setQ)(e.target.value)} aria-label="Search images by name or description" />
        </div>
        <button className="icon-btn asset-density" aria-pressed={compact} aria-label="Smaller thumbnails" title={compact ? 'Show larger thumbnails' : 'Show smaller thumbnails, more to a row'} onClick={toggleCompact}>
          <Grid3x3 />
        </button>
      </div>
      <AssetOrderControls series={series.list} value={series.key} onSeries={series.choose} />
      {!replacing && (unused.length > 0 || damaged.length > 0) && (
        <Segmented
          radio
          full
          label="Filter images"
          value={mode}
          onChange={setFilter}
          // Under 240px three labels and their counts no longer fit the row: the counts go, as the tabs' do.
          options={[
            { value: 'all' as const, label: <>All {!narrow && <span className="asset-count">{found.length}</span>}</> },
            ...(unused.length ? [{ value: 'unused' as const, label: <>Unused {!narrow && <span className="asset-count">{foundUnused.length}</span>}</> }] : []),
            ...(damaged.length ? [{ value: 'missing' as const, label: <>Missing {!narrow && <span className="asset-count">{foundDamaged.length}</span>}</> }] : [])
          ]}
        />
      )}
      {!replacing && mode === 'unused' && removable.length > 0 && (
        <div className="asset-cleanup">
          <p>
            {needle
              ? `${plural(removable.length, 'unused image matches', 'unused images match')} your search${series.key ? ` in ${series.label}` : ''}.`
              : series.key
                ? `${plural(removable.length, 'image', 'images')} in ${series.label} ${removable.length === 1 ? 'isn’t' : 'aren’t'} used anywhere.`
                : `${plural(removable.length, 'image isn’t', 'images aren’t')} used anywhere.`}{' '}
            You can undo this.
          </p>
          <button className="btn btn-sm btn-danger" onClick={() => void removeMany(removable)}>
            <Trash2 /> {removable.length === 1 ? 'Remove it' : needle || series.key ? `Remove these ${removable.length}` : `Remove all ${removable.length}`}
          </button>
        </div>
      )}
      <p className={filtering && shown.length ? 'asset-result' : 'sr-only'} role="status">
        {filtering
          ? `${shown.length} of ${mode === 'unused' ? plural(unused.length, 'unused image', 'unused images') : mode === 'missing' ? plural(damaged.length, 'image with missing files', 'images with missing files') : plural(assets.length - (replacing ? 1 : 0), 'image', 'images')}${series.key ? ` · ${series.label}` : ''}`
          : mode === 'missing'
            ? `${plural(shown.length, 'image has', 'images have')} missing files`
            : ''}
      </p>
    </div>
  );

  let tools: React.ReactNode = null;
  let body: React.ReactNode;
  // Pinned under the scrolling images, outside them, so nothing the keyboard reaches is ever hidden behind it.
  let foot: React.ReactNode = null;
  if (sel && replacing) {
    const n = places.length || usage[sel.id] || 0;
    // Some places, chosen from the uses still there: one removed meanwhile drops out of the count and the change.
    const chosen = choosing ? places.filter((u) => u.target && choosing.chosen.includes(u.key)) : [];
    const picked = choosing?.pick ? (snap.state.assets.assets[choosing.pick] ?? null) : null;
    const choosable = places.filter((u) => u.target).length;
    const onPick = (a: AssetRecord) => {
      if (!choosing) return void replaceWith(a.id);
      // Nothing changes while a replacement is on its way. Picked here, it wins over one still being imported.
      if (replacingNow.current) return;
      replaceSession.current++;
      setChoosing((c) => c && { ...c, pick: a.id });
    };
    // Ticked places that no longer show this image (removed, or given another since): said, and left out.
    const lost = choosing ? choosing.chosen.filter((k) => !places.some((u) => u.key === k && u.target)).length : 0;
    const startChoosing = () => {
      replaceSession.current++;
      setChoosing({ chosen: places.flatMap((u) => (u.target ? [u.key] : [])), pick: null });
      // The button that opened the list goes with it: focus lands on the first place, inside the labelled group.
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-choose input:not(:disabled)')?.focus());
    };
    const stopChoosing = () => {
      replaceSession.current++;
      setChoosing(null);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-choose-open')?.focus());
    };
    const tick = (key: string, on: boolean) => setChoosing((c) => c && { ...c, chosen: on ? [...c.chosen.filter((k) => k !== key), key] : c.chosen.filter((k) => k !== key) });
    const only = places.length === 1 ? places[0] : null;
    // A swap applies at once, and a place chosen gets the picture as it is, so a damaged one can't be picked: its files
    // are repaired first, in its details.
    const unusable = (a: AssetRecord) => {
      const hurt = damage(a, missingOf.get(a.id));
      return hurt === 'copies' ? 'Some of its smaller copies are missing. Make them again in its details first.' : hurt ? 'Its file is missing, so it can’t be used here. Locate it first.' : null;
    };
    // A picked image whose files went missing since is no longer the pick: the places stay ticked, and the foot asks for another.
    const pick = picked && !unusable(picked) ? picked : null;
    const pickLost = !!picked && !pick;
    // Two pictures can share a name: the foot names the pick the way its tile does.
    const pickName = pick ? (sameNames.get(pick.id) ? `${nameOf(pick)} (${sameNames.get(pick.id)})` : nameOf(pick)) : '';
    const blockedCount = shown.filter((a) => unusable(a)).length;
    // Only Cancel and the search stay put; what is being replaced scrolls away with the images.
    tools = (
      <div className="asset-replace-top">
        <div className="asset-detail-top">
          <button className="btn btn-sm btn-ghost asset-back" autoFocus onClick={closeReplace}>
            <ArrowLeft /> Cancel
          </button>
        </div>
        {browseTools}
      </div>
    );
    const importOffer = (
      <div className="asset-replace-add">
        <button
          className="btn btn-sm"
          disabled={importing}
          onClick={async () => {
            const session = replaceSession.current;
            const r = await importFiles(undefined, 'image');
            if (replaceSession.current !== session) return;
            // Applied only while the picker is still open for this image, and only for the one file chosen, come in
            // cleanly. Choosing places, it is picked for them, to replace there once the author says so. Otherwise a
            // photo the import review showed (converted or made web-sized) waits here to be picked: that review's button
            // said Add, not Replace.
            if (r.chosen === 1 && r.ids.length === 1 && !r.failed && (choosing || !r.reviewed)) {
              if (choosing) {
                // A file the library already had as this very image is no replacement for it.
                if (r.ids[0] !== sel.id) setChoosing((c) => c && { ...c, pick: r.ids[0] });
              } else void replaceWith(r.ids[0]);
            } else {
              const next = r.ids.find((id) => id !== sel.id);
              if (!next) return;
              setPickQ('');
              pickSeries.choose('');
              focusTile(next);
            }
          }}
        >
          <ImagePlus /> Import a replacement…
        </button>
        <p>{choosing ? 'One file is picked as soon as it’s added. Several wait here for you to pick.' : 'One file is used straight away. Several, or a photo that needs a check first, wait here for you to pick.'}</p>
      </div>
    );
    if (choosing)
      foot = (
        // What the change will do, and the button that makes it, stay in view below the images being picked from.
        <div className="asset-choose-foot">
          <p className="asset-choose-sum" role="status">
            {lost > 0 && `${lost === 1 ? 'A place you ticked no longer shows' : `${lost} places you ticked no longer show`} ${nameOf(sel)}. `}
            {!chosen.length
              ? 'Tick at least one place.'
              : pick
                ? // In a narrow sidebar the first sentence is enough: the unticked rows above say which places keep it.
                  `${pickName} will show in ${chosen.length === n ? `all ${n} places` : `${chosen.length} of ${n} places`}.${chosen.length < n && !narrow ? ` ${n - chosen.length === 1 ? 'The other place keeps' : `The other ${n - chosen.length} places keep`} ${nameOf(sel)}.` : ''}`
                : pickLost && picked
                  ? `${nameOf(picked)} can’t be used now: its files are missing. Pick another image to show in ${plural(chosen.length, 'place', 'places')}.`
                  : `Pick the image to show in ${plural(chosen.length, 'place', 'places')}.`}
          </p>
          <div className="asset-choose-actions">
            <button className="btn btn-sm btn-primary" disabled={!pick || !chosen.length} onClick={() => pick && void replaceWith(pick.id, { uses: chosen, revision: snap.revision })}>
              <Replace /> {chosen.length ? `Replace in ${plural(chosen.length, 'place', 'places')}` : 'Replace'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={stopChoosing}>
              Every place instead
            </button>
          </div>
        </div>
      );
    body = (
      <div className={`asset-replace${narrow ? ' narrow' : ''}`}>
        <div className="asset-replace-head">
          {damage(sel, missingOf.get(sel.id)) === 'all' ? (
            <span className="asset-thumb asset-thumb-gone">
              <ImageOff aria-hidden="true" />
            </span>
          ) : (
            <Thumb a={sel} devUrl={devUrl} />
          )}
          <div>
            <h4 title={nameOf(sel)}>Replace {nameOf(sel)}</h4>
            <p>
              {choosing ? (
                'Tick the places to change, then pick the image to show there.'
              ) : only ? (
                <>
                  Pick the image to show in <b>{only.where}{only.what ? ` · ${only.what}` : ''}</b> instead.
                </>
              ) : n === 1 ? (
                'Pick the image to show in its place instead.'
              ) : (
                `Pick the image to show in all ${n} places instead.`
              )}
              {choosing ? (narrow ? '' : ' You can undo it.') : ' It changes as soon as you pick, and you can undo it.'}
            </p>
            {!choosing && n > 1 && choosable > 0 && (
              <button className="link-btn asset-choose-open" onClick={startChoosing}>
                Choose places…
              </button>
            )}
          </div>
        </div>
        {choosing && (
          <fieldset className="asset-choose">
            <legend>
              Places to change <span className="asset-count">{chosen.length} of {n}</span>
            </legend>
            <ul>
              {places.map((u) => {
                const Icon = PLACE_ICON[u.icon];
                const go = showUse(snap.state, u);
                const label = `${u.where} · ${u.what}`;
                return (
                  <li key={u.key}>
                    <label className="asset-use" title={u.target ? label : `${label}\nOnly Replace everywhere can change this one.`}>
                      <input type="checkbox" checked={!!u.target && choosing.chosen.includes(u.key)} disabled={!u.target} onChange={(e) => tick(u.key, e.target.checked)} />
                      <Icon aria-hidden="true" />
                      <span className="asset-choose-place">
                        <span className="where">{u.where}</span>
                        <span className="what">{u.what}</span>
                      </span>
                    </label>
                    {go && (
                      <button className="btn btn-sm btn-ghost asset-choose-show" onClick={go} aria-label={showLabel(snap.state, u)} title={showLabel(snap.state, u)}>
                        <ChevronRight />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        {!narrow && importOffer}
        {blockedCount > 0 && (
          <p className="asset-blocked-note">
            <TriangleAlert aria-hidden="true" />
            <span>
              {blockedCount === 1 ? 'One image has' : `${blockedCount} images have`} missing files, so {blockedCount === 1 ? 'it can’t' : 'they can’t'} be used here. Repair {blockedCount === 1 ? 'it' : 'them'} in {blockedCount === 1 ? 'its' : 'their'} details first.
            </span>
          </p>
        )}
        {shown.length ? grid(onPick, choosing ? 'Image to show in the places ticked' : `Images to use instead of ${nameOf(sel)}`, { blocked: unusable, picked: choosing ? (pick?.id ?? null) : undefined }) : noMatches}
        {/* In a narrow sidebar the candidates come first, so one shows above the pinned foot; the offer follows them, in
            reading and tab order alike. */}
        {narrow && importOffer}
      </div>
    );
  } else if (sel) {
    const used = usage[sel.id] ?? 0;
    // Two imports can share a name ("hero"): what an author can see of them tells them apart.
    const apart = sameNames.get(sel.id);
    // One place the image is used: a way to it, or how it is changed where it can't be opened.
    const placeRow = (p: (typeof places)[number]) => {
      const Icon = PLACE_ICON[p.icon];
      const go = showUse(snap.state, p);
      const hint = go ? undefined : changeHint(snap.state, p);
      const inner = (
        <>
          <Icon aria-hidden="true" />
          <span className="where">{p.where}</span>
          <span className="what">{p.what}</span>
          {go && <ChevronRight className="go" aria-hidden="true" />}
        </>
      );
      return (
        <li key={p.key}>
          {go ? (
            <button className="asset-use" onClick={go} title={showLabel(snap.state, p)}>
              {inner}
            </button>
          ) : (
            // A theme component's design or starting image can't be opened: say how it is changed.
            <span className="asset-use static" title={`${p.what} · ${p.where}`}>
              {inner}
              {hint && <span className="asset-use-hint">{hint}</span>}
            </span>
          )}
        </li>
      );
    };
    const gone = missingOf.get(sel.id);
    const hurt = damage(sel, gone);
    const copies = gone?.variants.length ?? 0;
    const placement = imagePlacement();
    const offer = webPlan && 'format' in webPlan ? webPlan : null;
    const sameSize = !!offer && offer.width === sel.width && offer.height === sel.height;
    const onePlace = (places.length || used) === 1;
    const place = async () => {
      if (placingNow.current || !placement.at) return;
      placingNow.current = true;
      setPlacing(true);
      try {
        await placeAsset(sel.id, placement.key);
      } finally {
        placingNow.current = false;
        setPlacing(false);
      }
    };
    body = (
      <div className="asset-detail" id="asset-detail">
        <div className="asset-detail-top">
          {/* Back goes to the grid as it was left, so it names what that grid shows. */}
          <button className="btn btn-sm btn-ghost asset-back" autoFocus onClick={back}>
            <ArrowLeft /> {mode === 'missing' ? 'Missing images' : mode === 'unused' ? 'Unused images' : filtering ? 'Back to results' : 'All images'}
          </button>
        </div>
        <div className="asset-preview">
          {hurt === 'all' ? (
            <span className="asset-preview-off">
              <ImageOff aria-hidden="true" />
              No file left to show.
            </span>
          ) : devUrl ? (
            <Picture key={gone ? `missing-${gone.original}-${gone.variants.length}` : 'present'} a={sel} devUrl={devUrl} maxHeight={176} />
          ) : (
            <span className="asset-preview-off">
              <ImageIcon aria-hidden="true" />
              The picture appears once the site preview is running.
            </span>
          )}
        </div>
        <div className="asset-ident">
          <h4>{nameOf(sel)}</h4>
          <p className="asset-meta">{[sel.width && sel.height ? `${sel.width} × ${sel.height}` : '', formatBytes(sel.bytes), formatType(sel.mime)].filter(Boolean).join(' · ')}</p>
          {typeof sel.originalName === 'string' && sel.originalName.trim() && sel.originalName !== nameOf(sel) && (
            <p className="asset-meta asset-original" data-testid="asset-original-name">
              Original file: <span>{sel.originalName}</span>
            </p>
          )}
          {apart && (
            <p className="asset-meta" data-testid="asset-same-name">
              Another image has this name. This one: {apart}.
            </p>
          )}
        </div>
        {altToCheck.length > 0 && (
          <div className="asset-note asset-alt-review" role="note" aria-labelledby="asset-alt-review-title" data-testid="asset-alt-review">
            <TriangleAlert aria-hidden="true" />
            <div>
              <span>
                <b id="asset-alt-review-title">Check the alt text in {altToCheck.length === 1 ? 'one place' : `${altToCheck.length} places`}.</b> {nameOf(snap.state.assets.assets[altReview!.withId] ?? sel)} shows there now, but the alt text there was written for this image, or is empty.
              </span>
              <ul>
                {altToCheck.map((c) => {
                  const Icon = PLACE_ICON[c.icon];
                  const go = goToPlace(snap.state, c);
                  const inner = (
                    <>
                      <Icon aria-hidden="true" />
                      <span className="where">{c.where}</span>
                      <span className="what">{c.what}</span>
                      {go && <ChevronRight className="go" aria-hidden="true" />}
                    </>
                  );
                  return (
                    <li key={c.key}>
                      {go ? (
                        <button className="asset-use" onClick={go} title={showLabel(snap.state, c)}>
                          {inner}
                        </button>
                      ) : (
                        <span className="asset-use static">{inner}</span>
                      )}
                      <span className="asset-alt-text">{c.reason === 'custom' ? `Kept its own: “${c.alt}”` : 'No alt text'}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="asset-note-actions">
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setAltReview(null);
                    requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-detail .asset-back')?.focus());
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
        {gone && (
          <div className="asset-note asset-missing" role="note">
            <TriangleAlert aria-hidden="true" />
            <div>
              {hurt === 'all' ? (
                <span>
                  <b>File missing.</b> This picture{sel.variants?.length ? ' and its smaller copies are' : ' is'} no longer in the project folder, so {!used ? 'it can’t be shown' : onePlace ? 'the place below shows nothing' : 'the places below show nothing'}. {!used ? '' : onePlace ? 'Its use and alt text are kept. ' : 'Every use and its alt text are kept. '}Locate the file to bring it back{used ? ', or replace it everywhere' : ''}.
                </span>
              ) : hurt === 'original' ? (
                <span>
                  <b>Original missing.</b> {used ? `${onePlace ? 'The place below still shows' : 'The places below still show'} its smaller copies, but you can’t export the site while it uses this image.` : 'Its smaller copies are still here, but the original is the file the website is built from.'} Locate the file to bring it back{used ? ', or replace it everywhere' : ''}.
                </span>
              ) : (
                <span>
                  <b>{copies === 1 ? 'A smaller copy is missing.' : `${copies} smaller copies are missing.`}</b> Some screen sizes may show nothing until {copies === 1 ? 'it is' : 'they are'} made again from the original.
                </span>
              )}
              <div className="asset-missing-actions">
                {gone.original ? (
                  <>
                    <button className="btn btn-sm btn-primary" disabled={fixing} onClick={() => void fixFiles(() => api.project.locateAsset(sel.id))}>
                      <FileSearch /> Locate file…
                    </button>
                    {used > 0 && (
                      <button className="btn btn-sm asset-replace-open" onClick={openReplace}>
                        <Replace /> Replace everywhere…
                      </button>
                    )}
                  </>
                ) : (
                  <button className="btn btn-sm btn-primary" disabled={fixing} onClick={() => void fixFiles(() => api.project.regenerateAssetCopies(sel.id))}>
                    <RefreshCw /> {copies === 1 ? 'Make the copy again' : 'Make copies again'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {/* Advice about the original's size means nothing while the original is gone. */}
        {sel.bytes > LARGE && !gone?.original && (
          <div className="asset-note" role="note" data-testid="asset-large-note">
            <Info aria-hidden="true" />
            <div>
              <span>
                <b>Large file.</b>{' '}
                {sel.variants?.length ? `Pages load smaller copies, but the ${formatBytes(sel.bytes)} original is still part of the site.` : `At ${formatBytes(sel.bytes)} it will slow pages down.`}{' '}
                {webPlan === undefined
                  ? ''
                  : offer
                    ? `${sameSize ? `A ${offer.format} copy at the same ${offer.width} × ${offer.height} is far lighter.` : `A web-sized copy (${offer.format} · ${offer.width} × ${offer.height}) keeps it light.`} ${used ? `It shows in ${onePlace ? 'its place' : 'its places'} instead, and the original stays in Assets.` : 'It’s added to Assets beside the original, which you can then remove.'}`
                    : webPlan
                      ? 'A web-sized copy would be less than a third lighter, so none is offered.'
                      : used
                      ? 'A copy under 1.5 MB keeps it light: save one, add it, and use it with Replace everywhere.'
                      : 'A copy under 1.5 MB keeps it light: save one, add it, then remove this one.'}
              </span>
              {offer && (
                <div className="asset-note-actions">
                  <button className="btn btn-sm" data-testid="asset-web-copy" disabled={copying} onClick={() => void makeWebCopy()}>
                    {copying ? <Spinner /> : <ImagePlus />} {used ? `Use a ${sameSize ? `lighter ${offer.format}` : 'web-sized'} copy in ${plural(places.length || used, 'place', 'places')}` : sameSize ? `Make a lighter ${offer.format} copy` : 'Make a web-sized copy'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {recordsLocation && (
          <p className="asset-note" data-testid="asset-location-note">
            <MapPin aria-hidden="true" />
            <span>
              <b>Records where it was taken.</b> Exported website files leave the location out, along with any camera details. This original keeps them, and so does an editable project export.
            </span>
          </p>
        )}
        <div className="asset-place">
          {/* Placed only once its files are whole, as Replace everywhere and the gallery picker require. */}
          <button className={`btn btn-sm${gone ? '' : ' btn-primary'}`} disabled={!placement.at || !!gone} aria-describedby="asset-place-where" onClick={() => void place()}>
            <ImageDown /> {placing ? 'Placing…' : 'Place on page'}
          </button>
          <p className="asset-why" id="asset-place-where" data-testid="asset-place-where">
            {gone?.original ? (
              'Locate the file to place this image or use it in AI chat.'
            ) : gone ? (
              `Make the missing ${copies === 1 ? 'copy' : 'copies'} again to place this image.`
            ) : placement.at ? (
              <>
                Goes {placement.where.lead} <b>{placement.where.target}</b>
                {placement.where.within ? (
                  <>
                    {' in '}
                    <b>{placement.where.within}</b>
                  </>
                ) : null}
                {placement.where.node ? ` on ${placement.page}` : ''}. Select something on the page to put it elsewhere.
              </>
            ) : (
              placement.reason
            )}
          </p>
        </div>
        <section className="asset-uses" aria-labelledby="asset-uses-title">
          <h5 id="asset-uses-title">{used ? `Used in ${plural(places.length || used, 'place', 'places')}` : 'Not used anywhere yet'}</h5>
          {places.length > 0 && <ul>{places.slice(0, 4).map(placeRow)}</ul>}
          {/* The rest under a fold that stays put: it opens below itself, so the pointer and the next Tab land on them. */}
          {places.length > 4 && (
            <Disclosure className="asset-more" open={allPlaces} onToggle={(e) => setAllPlaces(e.currentTarget.open)} summary={`${places.length - 4} more ${places.length - 4 === 1 ? 'place' : 'places'}`}>
              <ul>{places.slice(4).map(placeRow)}</ul>
            </Disclosure>
          )}
          <div className="asset-actions">
            {used ? (
              <>
                {/* A missing original offers Replace everywhere in its note, beside Locate file. */}
                {!gone?.original && (
                  <button className="btn btn-sm asset-replace-open" onClick={openReplace}>
                    <Replace /> Replace everywhere…
                  </button>
                )}
                <p className="asset-why">To remove this image, replace it or take it out of {places.length === 1 ? 'the place' : 'the places'} above first.</p>
              </>
            ) : (
              <button className="btn btn-sm btn-danger" onClick={() => void removeOne(sel)}>
                <Trash2 /> Remove image
              </button>
            )}
            {/* Only the image's ID and name go to the AI; the picture stays on this computer. */}
            <button className="btn btn-sm btn-ghost asset-to-chat" disabled={!!gone?.original} aria-describedby={gone?.original ? 'asset-place-where' : undefined} title={gone?.original ? 'Locate the file to use this image in AI chat' : 'Attach this image to your next AI message'} onClick={() => attachToChat(snap.workspaceKey, sel.id)}>
              <Sparkles /> Use in AI chat
            </button>
          </div>
        </section>
        <div className="asset-fields">
          <Field label="Name" error={nameError}>
            <DraftInput
              value={sel.name}
              onLive={() => nameError && setNameError(null)}
              onCommit={(v) => {
                if (!v.trim()) {
                  setNameError('An image needs a name, so the old one was kept.');
                  return false;
                }
                setNameError(null);
                if (v.trim() === sel.name) return;
                void applyOps([{ type: 'asset.update', assetId: sel.id, name: v.trim() }], 'Rename image');
              }}
            />
          </Field>
          <Field label="Description" hint="Note what’s in it and where it fits. It helps you and the AI pick images; the AI never sees the picture.">
            <DraftInput multiline rows={2} limit={TEXT_LIMITS.assetDescription} keep={`asset:${sel.id}:description`} keepWhile={assetAlive(sel.id)} placeholder="For example: team photo outside the studio, summer" value={sel.description ?? ''} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, description: v }], 'Describe image')} />
          </Field>
          <Field label="Suggested alt text" hint="Filled in when you place the image, for people who can’t see it. Describe what matters, without “image of”. If it’s only decoration, mark it decorative where you place it.">
            <DraftInput multiline rows={2} limit={TEXT_LIMITS.altSuggestion} keep={`asset:${sel.id}:altSuggestion`} keepWhile={assetAlive(sel.id)} value={sel.altSuggestion ?? ''} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, altSuggestion: v }], 'Edit alt suggestion')} />
          </Field>
        </div>
      </div>
    );
  } else if (assets.length === 0) {
    body = (
      <div className="asset-empty">
        <button className={`asset-drop${over ? ' over' : ''}`} onClick={() => void addImages()} disabled={importing}>
          <span className="asset-drop-icon">
            <ImagePlus aria-hidden="true" />
          </span>
          <b>Add images</b>
          <span>Drop files here, or click to choose</span>
          <small>JPEG, PNG, WebP, GIF, AVIF, SVG or HEIC</small>
        </button>
        <p>Images you add are copied into this project, so the site keeps working wherever it goes. Fonts and documents have their own tabs above.</p>
      </div>
    );
  } else {
    tools = browseTools;
    body = (
      <>
        {shown.length ? grid((a) => openDetails(a.id), 'Images', { drag: true }) : noMatches}
        {!filtering && mode === 'all' && <p className="asset-drop-hint">You can also drop files anywhere on this panel.</p>}
      </>
    );
  }

  const browsing = !sel && !replacing;
  const imagesView = (
    <>
      {tools}
      <div ref={bodyRef} className={`panel-body${assets.length ? '' : ' asset-body-empty'}`}>
        {body}
      </div>
      {foot}
    </>
  );
  const add = section === 'fonts' ? { label: 'Add fonts', icon: <Type />, run: () => void addFonts(), title: 'Choose WOFF2 or WOFF font files' } : section === 'documents' ? { label: 'Add documents', icon: <FilePlus />, run: () => void addDocuments(), title: 'Choose PDFs or other files for visitors to download' } : { label: 'Add images', icon: <ImagePlus />, run: () => void addImages(), title: 'Choose images to add, or drop files anywhere on this panel' };
  // An empty kind needs no count: its tab says so when opened, and the row stays inside a narrow sidebar.
  const tabCount = (n: number) => !narrow && n > 0 && <span className="asset-count">{n}</span>;

  return (
    <>
      <div className="panel-head">
        <h3>Assets</h3>
        {browsing && (section !== 'images' || assets.length > 0) && (
          <button className="btn btn-sm asset-add" onClick={add.run} disabled={importing} title={add.title}>
            {add.icon} {add.label}
          </button>
        )}
      </div>
      <div className="asset-host" {...dropProps} onKeyDown={sel ? onEscape(replacing ? closeReplace : back) : undefined}>
        {adding && (
          <p className="asset-importing" role="status">
            <Spinner decorative /> Adding files…
          </p>
        )}
        {browsing ? (
          <Tabs<Section>
            value={section}
            onChange={setSection}
            label="Kinds of asset"
            idBase="asset-section"
            className="dock-tabs asset-sections"
            panelClassName="asset-section"
            options={[
              {
                value: 'images',
                label: <>Images {tabCount(assets.length)}</>,
                // Images with missing files are flagged on their tab too, seen from Fonts or Documents.
                icon: damaged.length ? <TriangleAlert className="asset-tab-warn" role="img" aria-label={`${plural(damaged.length, 'image has', 'images have')} missing files:`} /> : undefined,
                panel: () => imagesView
              },
              {
                value: 'fonts',
                label: <>Fonts {tabCount(fonts.length)}</>,
                panel: () => (
                  <div className="panel-body">
                    {fonts.length > 0 ? (
                      <FontList fonts={fonts} usage={usage} />
                    ) : (
                      <p className="asset-section-note">
                        No fonts yet. Add WOFF2 or WOFF files, then choose them for headings or body text in{' '}
                        <button className="link-btn" onClick={() => openSiteStyles()}>
                          Site styles
                        </button>
                        .
                      </p>
                    )}
                  </div>
                )
              },
              {
                value: 'documents',
                label: <>Documents {tabCount(documents.length)}</>,
                // A document whose file has gone is flagged on its tab, so it is found without opening the tab.
                icon: missingDocs ? <TriangleAlert className="asset-tab-warn" role="img" aria-label={`${plural(missingDocs, 'document has', 'documents have')} a missing file:`} /> : undefined,
                panel: () => (
                  <div className="panel-body">
                    <DocumentList state={snap.state} docs={documents} usage={usage} missingOf={missingOf} reveal={shownDocument} onRevealed={revealed} />
                  </div>
                )
              }
            ]}
          />
        ) : (
          imagesView
        )}
        {browsing && storage.info && (
          <StorageSummary
            info={storage.info}
            onFree={() => {
              // The dialog shows the figures as they are when it opens.
              storage.refresh();
              setFreeing(true);
            }}
          />
        )}
        {freeing && storage.info && <FreeSpaceDialog info={storage.info} onClose={() => setFreeing(false)} refresh={storage.refresh} />}
        {over && (assets.length > 0 || section !== 'images' || !!sel) && (
          <div className="asset-drop-overlay" aria-hidden="true">
            <div>
              <Upload />
              <b>Drop to add files</b>
              <span>They’re copied into this project</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
