import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Component, FileDown, FilePlus, FileSearch, FileText, FileUp, Globe, ImageDown, ImageIcon, ImagePlus, Info, MapPin, PanelTop, RefreshCw, Replace, Search, Sparkles, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { allTrees, displayName } from '@engine/tree';
import { isDocumentLink } from '@engine/apply';
import type { AssetRecord, OwnerRef, ProjectState } from '@shared/types';
import { api, applyOps, attachToChat, commitOps, getState, setState, toast, undoAction, useStore } from '../store';
import { Field, DraftInput, Segmented, Spinner } from '../components/ui';
import { isValidFontAsset, sameFontFamily } from '@shared/fonts';
import { Picture, Thumb } from '../components/AssetPicture';
import { goToShellPart, imagePlacement, openSiteStyles, placeAsset, selectPage } from '../lib/actions';
import { SHOW_ASSET_EVENT } from '../lib/place';
import { formatBytes, plural } from '../lib/storage';
import { FreeSpaceDialog, StorageSummary, useProjectStorage } from './AssetStorage';
import { assetArrived, reviewImport } from '../lib/import-review';
import { documentDetails, documentLabels, documentName, libraryDocuments } from '../lib/documents';
import type { MissingAssetFiles } from '@shared/api';

/** Above this an image is worth flagging: pages load smaller copies, but the original still ships with the site. */
const LARGE = 1_500_000;


function formatType(mime: string): string {
  if (mime === 'image/svg+xml') return 'SVG';
  return mime.replace(/^image\//, '').toUpperCase();
}

const nameOf = (a: AssetRecord) => a.name.trim() || 'Untitled image';
/** Two lines of a tile hold about 30 characters. A longer name keeps its first and last words, since versions
 *  and sizes live at the end, cut at word boundaries where there are any. */
function shortName(name: string): string {
  if (name.length <= 30) return name;
  let head = name.slice(0, 14);
  if (head.lastIndexOf(' ') > 6) head = head.slice(0, head.lastIndexOf(' '));
  const space = name.lastIndexOf(' ', name.length - 6);
  const tail = space > head.length && name.length - space - 1 <= 13 ? name.slice(space + 1) : name.slice(-11);
  return `${head.trimEnd()} … ${tail.trimStart()}`;
}

const WEIGHTS: Array<[string, string]> = [
  ['100', 'Thin'], ['200', 'Extra light'], ['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold'], ['900', 'Black']
];
/** "Bold italic", "Variable (100–900)". */
function faceLabel(a: AssetRecord): string {
  const w = a.font?.weight ?? '400';
  const weight = w.includes(' ') ? `Variable (${w.replace(' ', '–')})` : (WEIGHTS.find(([v]) => v === w)?.[1] ?? w);
  return a.font?.style === 'italic' ? `${weight} italic` : weight;
}
const fontLabel = (a: AssetRecord) => `${a.font?.family ?? a.name} ${a.font?.weight ?? ''} ${a.font?.style ?? ''}`;

/** Imported web fonts: each file is one face (weight and style) of a family that Site styles can use. */
function FontList({ fonts, usage }: { fonts: AssetRecord[]; usage: Record<string, number> }) {
  const faceOf = (a: AssetRecord) => ({ family: a.font?.family ?? a.name, weight: a.font?.weight ?? '400', style: a.font?.style ?? ('normal' as const) });
  const update = (a: AssetRecord, patch: Partial<NonNullable<AssetRecord['font']>>, label: string) => void applyOps([{ type: 'asset.update', assetId: a.id, font: { ...faceOf(a), ...patch } }], label);
  /** A family is renamed as a whole, so its files stay together and the styles using it follow. */
  const renameFamily = (a: AssetRecord, family: string) =>
    void applyOps(
      fonts.filter((x) => sameFontFamily(x, a)).map((x) => ({ type: 'asset.update' as const, assetId: x.id, font: { ...faceOf(x), family } })),
      `Rename font family to ${family}`
    );
  const remove = async (a: AssetRecord) => {
    const r = await commitOps([{ type: 'asset.remove', assetId: a.id }], `Remove ${a.name}`);
    if (r) toast(`Removed ${a.name}.`, 'info', undoAction(r));
  };
  return (
    <section className="font-list" aria-labelledby="font-list-title">
      <h4 id="font-list-title">Fonts</h4>
      <p className="font-list-note">
        Imported fonts are part of your site. Choose one for headings or body text in{' '}
        <button className="link-btn" onClick={() => openSiteStyles()}>
          Site styles
        </button>
        .
      </p>
      <ul>
        {fonts.map((a) => {
          const used = usage[a.id] ?? 0;
          const variable = !!a.font?.weight.includes(' ');
          // Another file of the same family keeps the styles using it working, so this one can go.
          const locked = !!used && fonts.filter((x) => sameFontFamily(x, a)).length === 1;
          return (
            <li key={a.id} className="font-face">
              <div className="font-face-head">
                <b title={a.name}>{a.font?.family ?? a.name}</b>
                <span className="font-face-meta">
                  {faceLabel(a)} · {formatBytes(a.bytes)} · {used ? 'In use' : 'Not used'}
                </span>
              </div>
              <div className="font-face-edit">
                <DraftInput
                  className="input sm"
                  value={a.font?.family ?? ''}
                  ariaLabel={`Font family name for ${a.name}`}
                  onCommit={(v) => {
                    const family = v.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60);
                    if (!family) return false;
                    if (family !== a.font?.family) renameFamily(a, family);
                  }}
                />
                <select className="select sm" value={variable ? a.font!.weight : a.font?.weight ?? '400'} disabled={variable} aria-label={`Weight of ${a.name}`} title={variable ? 'A variable font covers a range of weights.' : undefined} onChange={(e) => update(a, { weight: e.target.value }, `Set ${a.name} weight`)}>
                  {variable && <option value={a.font!.weight}>Variable</option>}
                  {WEIGHTS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {v} {l}
                    </option>
                  ))}
                </select>
                <select className="select sm" value={a.font?.style ?? 'normal'} aria-label={`Style of ${a.name}`} onChange={(e) => update(a, { style: e.target.value as 'normal' | 'italic' }, `Set ${a.name} style`)}>
                  <option value="normal">Upright</option>
                  <option value="italic">Italic</option>
                </select>
                <button className="btn btn-sm btn-ghost" disabled={locked} title={locked ? 'In use by your site styles. Choose another font there first.' : `Remove ${a.name}`} aria-label={`Remove ${a.name}`} onClick={() => void remove(a)}>
                  <Trash2 />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Downloadable documents: each one's name, the file visitors download, where the site links to it, and what can be
 * done with it. A new version of the file goes in with Replace file, and every link follows; links can also move to
 * another document. A document stays while anything links to it, so no link is ever left going nowhere.
 */
function DocumentList({ state, docs, usage, missingOf, reveal, onRevealed, onAdd, adding }: { state: ProjectState; docs: AssetRecord[]; usage: Record<string, number>; missingOf: Map<string, MissingAssetFiles>; reveal: string | null; onRevealed: () => void; onAdd: () => void; adding: boolean }) {
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
    const n = usage[a.id] ?? 0;
    const r = await commitOps([{ type: 'asset.replace', assetId: a.id, withAssetId: to }], `Move links from ${documentName(a)}`);
    if (r) {
      setMoveTo(({ [a.id]: _, ...rest }) => rest);
      toast(`${n === 1 ? 'The link' : `All ${n} links`} to ${documentName(a)} now go${n === 1 ? 'es' : ''} to ${target ? documentName(target) : 'the other document'}.`, 'info', undoAction(r));
    }
  };
  const remove = async (a: AssetRecord) => {
    const r = await commitOps([{ type: 'asset.remove', assetId: a.id }], `Remove ${documentName(a)}`);
    if (r) toast(`Removed ${documentName(a)}.`, 'info', undoAction(r));
  };
  return (
    <section className="doc-list" aria-labelledby="doc-list-title">
      <div className="doc-list-head">
        <h4 id="doc-list-title">Documents</h4>
        <button className="btn btn-sm" onClick={onAdd} disabled={adding} title="Choose PDFs or other files for visitors to download">
          <FilePlus /> Add documents
        </button>
      </div>
      {docs.length === 0 ? (
        <p className="doc-list-note">Add a PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV or ZIP file, then link a button to it: choose Document as the link’s destination. Visitors download it from your site, so it needs no other hosting.</p>
      ) : (
        <ul>
          {docs.map((a) => {
            const used = usage[a.id] ?? 0;
            const gone = missingOf.get(a.id)?.original;
            const expanded = open === a.id;
            const others = docs.filter((d) => d.id !== a.id);
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
                  {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                  <FileDown aria-hidden="true" />
                  <span className="doc-title">
                    <b>{labels.get(a.id)}</b>
                    <span className="doc-meta">
                      {documentDetails(a)} · {gone ? 'File missing' : used ? `Linked ${plural(used, 'time', 'times')}` : 'Not linked'}
                    </span>
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
                      <button className="btn btn-sm btn-ghost" disabled={used > 0} onClick={() => void remove(a)} title={used ? `Linked ${plural(used, 'time', 'times')}. Replace its file, move its links to another document, or change those links first.` : `Remove ${documentName(a)}`}>
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

/** Every place an image is used, or a document linked to, by the same rules as the engine's usage count. */
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
  const reveal = (owner: OwnerRef, nodeId: string) => () => {
    if (owner.kind === 'page') selectPage(owner.id);
    else if (owner.kind === 'shell' && !goToShellPart(owner.id)) return toast(`No page shows the shared ${owner.id}, so this image is not on any page.`, 'info');
    setState({ selection: { owner, instancePath: [], nodeId }, rightTab: 'inspect', dockOpen: true });
  };
  for (const t of allTrees(state)) {
    for (const n of Object.values(t.tree.nodes)) {
      const c = count(n);
      if (!c) continue;
      const what = displayName(state, n);
      const key = `${t.owner.kind}/${t.owner.id}/${n.id}`;
      if (t.owner.kind === 'page') out.push({ key, icon: 'page', where: t.label, what, count: c, go: reveal(t.owner, n.id) });
      else if (t.owner.kind === 'shell') out.push({ key, icon: 'shell', where: `Shared ${t.label.toLowerCase()}`, what, count: c, go: reveal(t.owner, n.id) });
      else out.push({ key, icon: 'component', where: `${t.label} design`, what, count: c });
    }
  }
  for (const d of Object.values(state.components)) {
    const c = count(d.properties);
    if (c) out.push({ key: `default/${d.id}`, icon: 'component', where: `${d.name} default`, what: document ? 'Starting link for new copies' : 'Starting image for new copies', count: c });
  }
  for (const p of Object.values(state.pages)) {
    const c = count(p.seo) + (p.seo.socialImage === assetId ? 1 : 0);
    if (c) out.push({ key: `seo/${p.id}`, icon: 'page', where: p.title, what: 'Sharing image', count: c, go: () => selectPage(p.id) });
  }
  if (state.site.favicon === assetId) out.push({ key: 'favicon', icon: 'site', where: 'Site', what: 'Browser tab icon', count: 1, go: openSiteStyles });
  if (state.site.socialImage === assetId) out.push({ key: 'social', icon: 'site', where: 'Site', what: 'Sharing image', count: 1, go: openSiteStyles });
  return out;
}

const PLACE_ICON = { page: FileText, shell: PanelTop, component: Component, site: Globe };

/** Arrow keys, Home and End move between tiles by row and column; Tab still walks them in order. */
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
 * What a web-sized copy of a large JPEG or PNG would be (format and size), asked for each time such a picture is
 * shown or its file changes. Null while unknown, or when no copy can be made from it.
 */
type WebPlan = { format: 'JPEG' | 'PNG' | 'JPEG or PNG'; width: number; height: number };
function useWebCopyPlan(a: AssetRecord | null, opening: string, originalMissing: boolean): WebPlan | null {
  const [answer, setAnswer] = useState<{ key: string; plan: WebPlan | null } | null>(null);
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
  return key && answer?.key === key ? answer.plan : null;
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
  const [placing, setPlacing] = useState(false);
  // A second click while the first placement is on its way places nothing more.
  const placingNow = useRef(false);
  const [over, setOver] = useState(false);
  const dragDepth = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const replaceSession = useRef(0);
  const [q, setQ] = useState('');
  const [pickQ, setPickQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'unused'>('all');
  const [importing, setImporting] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [allPlaces, setAllPlaces] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [fixing, setFixing] = useState(false);
  const storage = useProjectStorage();
  const [freeing, setFreeing] = useState(false);
  // Free up space belongs to the project it was opened for.
  const opening = snap?.workspaceKey;
  useEffect(() => setFreeing(false), [opening]);
  const assetsDoc = snap?.state.assets.assets;
  // Images whose files are not in the project folder: their uses stay, and the details offer to bring the files back.
  const missingAssets = snap?.missingAssets;
  const missingOf = useMemo(() => new Map((missingAssets ?? []).map((m) => [m.assetId, m])), [missingAssets]);
  // Images and fonts are listed apart: a font is never shown, picked or replaced as a picture.
  const assets = useMemo(() => Object.values(assetsDoc ?? {}).filter((a) => a?.kind === 'image').sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [assetsDoc]);
  /** Names more than one image has, compared as the AI chat compares them. */
  const sharedNames = useMemo(() => {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const a of assets) {
      if (typeof a.name !== 'string') continue;
      const n = nameOf(a).toLowerCase();
      if (seen.has(n)) shared.add(n);
      seen.add(n);
    }
    return shared;
  }, [assets]);
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
  const places = useMemo(() => (snap && sel ? placesOf(snap.state, sel.id) : []), [snap, sel]);
  useEffect(() => {
    setNameError(null);
    setAllPlaces(false);
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
        setShownDocument(assetId);
        return;
      }
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
  if (!snap) return null;
  const usage = snap.assetUsage;
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const unused = assets.filter((a) => !usage[a.id]);
  const query = replacing ? pickQ : q;
  const needle = query.trim().toLowerCase();
  const matches = (a: AssetRecord) => !needle || `${a.name} ${a.description ?? ''} ${a.altSuggestion ?? ''}`.toLowerCase().includes(needle);
  const found = assets.filter((a) => matches(a) && !(replacing && a.id === sel?.id));
  const foundUnused = found.filter((a) => !usage[a.id]);
  const mode = unused.length && !replacing ? filter : 'all';
  const shown = mode === 'unused' ? foundUnused : found;

  /** Focus moves to the tile (when it is still shown), else search, else the empty state's Add images. */
  const focusTile = (id?: string | null) =>
    requestAnimationFrame(() => {
      const el = (id && document.querySelector<HTMLElement>(`[data-asset="${id}"]`)) || searchRef.current || document.querySelector<HTMLElement>('.asset-drop');
      el?.focus();
    });
  const back = () => {
    const id = selected;
    setSelected(null);
    setReplacing(false);
    focusTile(id);
  };
  const openReplace = () => {
    replaceSession.current++;
    setPickQ('');
    setReplacing(true);
  };
  const closeReplace = () => {
    replaceSession.current++;
    setReplacing(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.asset-replace-open')?.focus());
  };

  /**
   * Import through the app's picker (no paths) or dropped files, and say exactly what arrived. HEIC photos, large
   * photos and files that can't be added are shown in the import review first (see reviewImport).
   */
  const importFiles = async (paths?: string[], only?: 'image' | 'document') => {
    const before = new Set(Object.keys(getState().snapshot?.state.assets.assets ?? {}));
    setImporting(true);
    try {
      const plan = await reviewImport(paths, only).catch((e: Error) => (toast(`The files couldn’t be added: ${e.message}`, 'error'), null));
      if (!plan) return { ids: [], added: [], failed: false, reviewed: false, chosen: 0 };
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
      if (parts.length && getState().snapshot?.workspaceKey === plan.choices.opening) toast(parts.join(' '), r.message && !added.length ? 'error' : 'info');
      return { ids: r.assetIds, added, failed: !!r.message, reviewed: plan.reviewed, chosen: plan.chosen };
    } finally {
      setImporting(false);
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
      if (!added.length) return;
      setPickQ('');
      focusTile(added[0]);
      return;
    }
    if (reviewed && ids.length && opening && !(await assetArrived(ids[ids.length - 1], opening))) return;
    // Only while the panel shows what it did when the import began: another import, a replacement, or the panel gone.
    const still = run === importRun.current && replaceSession.current === session && selectedNow.current === shownBefore && getState().snapshot?.workspaceKey === opening;
    const image = reviewed && still ? ids.find((id) => getState().snapshot?.state.assets.assets[id]?.kind === 'image') : undefined;
    if (image) {
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

  const replaceWith = async (withId: string) => {
    if (!sel || withId === sel.id) return;
    const n = places.length || usage[sel.id] || 0;
    const target = getState().snapshot?.state.assets.assets[withId];
    const r = await commitOps([{ type: 'asset.replace', assetId: sel.id, withAssetId: withId }], `Replace ${nameOf(sel)}`);
    if (r) {
      replaceSession.current++;
      setReplacing(false);
      toast(`${target ? nameOf(target) : 'The new image'} now shows in ${n === 1 ? 'its place' : `all ${n} places`} instead of ${nameOf(sel)}.`, 'info', undoAction(r));
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
    if (e.key !== 'Escape' || t.matches('textarea, input:not([type="search"])') || (t.matches('input') && t.value)) return;
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

  const grid = (onPick: (a: AssetRecord) => void, label: string) => (
    <div className="asset-grid" role="group" aria-label={label} onKeyDown={gridKeys}>
      {shown.map((a) => {
        // Two imports can share a name ("hero"): the asset ID tells them apart, as the AI chat names them.
        const gone = missingOf.get(a.id);
        const big = a.bytes > LARGE && !gone;
        const shared = typeof a.name === 'string' && sharedNames.has(nameOf(a).toLowerCase());
        const name = shared ? `${nameOf(a)} (${a.id})` : nameOf(a);
        const missingLabel = gone ? (gone.original ? 'file missing' : 'smaller copies missing') : '';
        return (
          <button
            key={a.id}
            data-asset={a.id}
            className="asset-tile"
            onClick={() => onPick(a)}
            aria-label={gone ? `${name}, ${missingLabel}` : big ? `${name}, large file, ${formatBytes(a.bytes)}` : name}
            title={gone ? `${name}\n${missingLabel[0].toUpperCase()}${missingLabel.slice(1)}` : big ? `${name}\nLarge file: ${formatBytes(a.bytes)}` : name}
          >
            <Thumb key={gone ? `missing-${gone.original}-${gone.variants.length}` : 'present'} a={a} devUrl={devUrl} />
            {gone && (
              <span className="asset-size asset-gone" aria-hidden="true">
                <TriangleAlert />
                {gone.original ? 'Missing' : 'Copies missing'}
              </span>
            )}
            {big && (
              <span className="asset-size" aria-hidden="true">
                <Info />
                {formatBytes(a.bytes)}
              </span>
            )}
            <span className="asset-name">{shortName(nameOf(a))}</span>
            {shared && <span className="asset-tile-id">{a.id}</span>}
          </button>
        );
      })}
    </div>
  );
  const noMatches = (
    <div className="asset-nomatch">
      <p>
        {needle && mode === 'unused' && found.length ? (
          <>No unused images match “{query.trim()}”.</>
        ) : needle ? (
          <>No images match “{query.trim()}”.</>
        ) : replacing ? (
          'There are no other images in this project yet. Import one above.'
        ) : (
          'Every image is in use.'
        )}
      </p>
      {needle && mode === 'unused' && found.length > 0 && (
        <button className="btn btn-sm" onClick={() => setFilter('all')}>
          Show all {found.length}
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
  const browseTools = (
    <div className="asset-tools">
      <div className="search">
        <Search />
        <input ref={searchRef} className="input" type="search" placeholder="Search images" value={query} onChange={(e) => (replacing ? setPickQ : setQ)(e.target.value)} aria-label="Search images by name or description" />
      </div>
      {!replacing && unused.length > 0 && (
        <Segmented
          full
          label="Show"
          value={mode}
          onChange={setFilter}
          options={[
            { value: 'all', label: <>All <span className="asset-count">{found.length}</span></> },
            { value: 'unused', label: <>Unused <span className="asset-count">{foundUnused.length}</span></> }
          ]}
        />
      )}
      <span className="sr-only" role="status">
        {needle ? `${plural(shown.length, 'image matches', 'images match')}` : ''}
      </span>
    </div>
  );

  let tools: React.ReactNode = null;
  let body: React.ReactNode;
  if (sel && replacing) {
    const n = places.length || usage[sel.id] || 0;
    body = <div className="asset-replace">{shown.length ? grid((a) => void replaceWith(a.id), `Images to use instead of ${nameOf(sel)}`) : noMatches}</div>;
    tools = (
      <div className="asset-replace-top">
        <div className="asset-detail-top">
          <button className="btn btn-sm btn-ghost asset-back" autoFocus onClick={closeReplace}>
            <ArrowLeft /> Cancel
          </button>
        </div>
        <div className="asset-replace-head">
          <Thumb a={sel} devUrl={devUrl} />
          <div>
            <h4 title={nameOf(sel)}>Replace {nameOf(sel)}</h4>
            <p>{n === 1 ? 'Pick the image to show in its place.' : `Pick the image to show in all ${n} places.`} You can undo this.</p>
          </div>
        </div>
        <div className="asset-replace-add">
          <button
            className="btn btn-sm"
            disabled={importing}
            title="Choose one file to use straight away, or several to pick from here"
            onClick={async () => {
              const session = replaceSession.current;
              const r = await importFiles(undefined, 'image');
              if (replaceSession.current !== session) return;
              // Applied only while the picker is still open for this image, and only for the one file chosen, come in cleanly.
              if (r.chosen === 1 && r.ids.length === 1 && !r.failed) void replaceWith(r.ids[0]);
              else if (r.added.length) {
                setPickQ('');
                focusTile(r.added[0]);
              }
            }}
          >
            <ImagePlus /> Import a replacement…
          </button>
          <p>Choose one file to use it straight away, or several to pick from here.</p>
        </div>
        {browseTools}
      </div>
    );
  } else if (sel) {
    const used = usage[sel.id] ?? 0;
    // Two imports can share a name ("hero"): the asset ID is what tells them apart, here and in the AI chat.
    const sameName = typeof sel.name === 'string' && sharedNames.has(nameOf(sel).toLowerCase());
    const shownPlaces = allPlaces ? places : places.slice(0, 4);
    const gone = missingOf.get(sel.id);
    const copies = gone?.variants.length ?? 0;
    const placement = imagePlacement();
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
          <button className="btn btn-sm btn-ghost asset-back" autoFocus onClick={back}>
            <ArrowLeft /> All images
          </button>
        </div>
        <div className="asset-preview">
          {devUrl ? (
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
          {sameName && (
            <p className="asset-meta" data-testid="asset-id">
              Another image has this name. This one is <code>{sel.id}</code>.
            </p>
          )}
        </div>
        {gone && (
          <div className="asset-note asset-missing" role="note">
            <TriangleAlert aria-hidden="true" />
            <div>
              {gone.original ? (
                <span>
                  <b>File missing.</b> This picture is no longer in the project folder, so {used ? 'the places below show nothing' : 'it can’t be shown'}. {used ? 'Every use and its alt text are kept: locate' : 'Locate'} the file to bring it back{used ? ', or show another image instead' : ''}.
                </span>
              ) : (
                <span>
                  <b>{copies === 1 ? 'A smaller copy is missing.' : `${copies} smaller copies are missing.`}</b> Some screen sizes may show nothing until {copies === 1 ? 'it is' : 'they are'} made again from the original.
                </span>
              )}
              <div className="asset-missing-actions">
                {gone.original ? (
                  <>
                    <button className="btn btn-sm" disabled={fixing} onClick={() => void fixFiles(() => api.project.locateAsset(sel.id))}>
                      <FileSearch /> Locate file…
                    </button>
                    {used > 0 && (
                      <button className="btn btn-sm asset-replace-open" onClick={openReplace}>
                        <Replace /> Use another image…
                      </button>
                    )}
                  </>
                ) : (
                  <button className="btn btn-sm" disabled={fixing} onClick={() => void fixFiles(() => api.project.regenerateAssetCopies(sel.id))}>
                    <RefreshCw /> Make copies again
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {sel.bytes > LARGE && (
          <div className="asset-note" role="note" data-testid="asset-large-note">
            <Info aria-hidden="true" />
            <div>
              <span>
                <b>Large file.</b>{' '}
                {sel.variants?.length ? `Pages load smaller copies, but the ${formatBytes(sel.bytes)} original is still part of the site.` : `At ${formatBytes(sel.bytes)} it will slow pages down.`}{' '}
                {webPlan
                  ? `A web-sized copy (${webPlan.format} · ${webPlan.width} × ${webPlan.height}) keeps it light. The original stays in Assets.`
                  : 'A copy under 1.5 MB keeps it light: export one and use it with Replace everywhere.'}
              </span>
              {webPlan && (
                <div className="asset-note-actions">
                  <button className="btn btn-sm" data-testid="asset-web-copy" disabled={copying} onClick={() => void makeWebCopy()}>
                    {copying ? <Spinner /> : <ImagePlus />} {used ? `Use a web-sized copy in ${plural(places.length || used, 'place', 'places')}` : 'Make a web-sized copy'}
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
          <button className="btn btn-sm btn-primary" disabled={!placement.at || !!gone?.original} aria-describedby="asset-place-where" onClick={() => void place()}>
            <ImageDown /> {placing ? 'Placing…' : 'Place on page'}
          </button>
          <p className="asset-why" id="asset-place-where" data-testid="asset-place-where">
            {gone?.original ? (
              'Locate the file to place this image.'
            ) : placement.at ? (
              <>
                Goes {placement.where.lead} <b>{placement.where.target}</b>
                {placement.where.node ? ` on ${placement.page}` : ''}. Select something on the page to put it elsewhere.
              </>
            ) : (
              placement.reason
            )}
          </p>
        </div>
        <section className="asset-uses" aria-labelledby="asset-uses-title">
          <h5 id="asset-uses-title">{used ? `Used in ${plural(places.length || used, 'place', 'places')}` : 'Not used anywhere yet'}</h5>
          {places.length > 0 && (
            <ul>
              {shownPlaces.map((p) => {
                const Icon = PLACE_ICON[p.icon];
                const inner = (
                  <>
                    <Icon aria-hidden="true" />
                    <span className="where">{p.where}</span>
                    {p.what && <span className="what">{p.what}</span>}
                    {p.count > 1 && <span className="times">{p.count}×</span>}
                    {p.go && <ChevronRight className="go" aria-hidden="true" />}
                  </>
                );
                return (
                  <li key={p.key}>
                    {p.go ? (
                      <button className="asset-use" onClick={p.go} title={`Show ${p.what ? `${p.what} on ` : ''}${p.where}`}>
                        {inner}
                      </button>
                    ) : (
                      <span className="asset-use static">{inner}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {places.length > 4 && (
            <button className="uses-toggle asset-more" aria-expanded={allPlaces} onClick={() => setAllPlaces(!allPlaces)}>
              {allPlaces ? 'Show fewer' : `Show all ${places.length} places`}
              <ChevronDown size={11} />
            </button>
          )}
          <div className="asset-actions">
            {/* Only the image's ID and name go to the AI; the picture stays on this computer. */}
            <button className="btn btn-sm asset-to-chat" title="Attach this image to your next AI message" onClick={() => attachToChat(snap.workspaceKey, sel.id)}>
              <Sparkles /> Use in AI chat
            </button>
            {used ? (
              <>
                <button className="btn btn-sm asset-replace-open" onClick={openReplace}>
                  <Replace /> Replace everywhere…
                </button>
                <p className="asset-why">To remove this image, replace it or take it out of {places.length === 1 ? 'the place' : 'the places'} above first.</p>
              </>
            ) : (
              <button className="btn btn-sm btn-danger" onClick={() => void removeOne(sel)}>
                <Trash2 /> Remove image
              </button>
            )}
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
            <DraftInput multiline rows={2} placeholder="For example: team photo outside the studio, summer" value={sel.description ?? ''} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, description: v }], 'Describe image')} />
          </Field>
          <Field label="Suggested alt text" hint="Filled in when you place the image, for people who can’t see it. Describe what matters, without “image of”. If it’s only decoration, mark it decorative where you place it.">
            <DraftInput multiline rows={2} value={sel.altSuggestion ?? ''} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, altSuggestion: v }], 'Edit alt suggestion')} />
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
          <small>JPEG, PNG, WebP, GIF, AVIF or SVG, WOFF2 or WOFF fonts, and documents such as PDFs</small>
        </button>
        <p>Images you add are copied into this project, so the site keeps working wherever it goes.</p>
      </div>
    );
  } else {
    const removable = shown.filter((a) => !usage[a.id]);
    tools = browseTools;
    body = (
      <>
        {mode === 'unused' && removable.length > 0 && (
          <div className="asset-cleanup">
            <p>{needle ? `${plural(removable.length, 'unused image matches', 'unused images match')} your search.` : `${plural(removable.length, 'image isn’t', 'images aren’t')} used anywhere.`}</p>
            <button className="btn btn-sm btn-danger" onClick={() => void removeMany(removable)}>
              <Trash2 /> {removable.length === 1 ? 'Remove it' : needle ? `Remove these ${removable.length}` : `Remove all ${removable.length}`}
            </button>
          </div>
        )}
        {shown.length ? grid((a) => setSelected(a.id), 'Images') : noMatches}
        {!needle && mode === 'all' && <p className="asset-drop-hint">You can also drop image files anywhere on this panel.</p>}
      </>
    );
  }

  return (
    <>
      <div className="panel-head">
        <h3>Assets</h3>
        {assets.length > 0 && !narrow && !replacing && <span className="context">{plural(assets.length, 'image', 'images')}</span>}
        {assets.length > 0 && !replacing && (
          <button className="btn btn-sm asset-add" onClick={() => void addImages()} disabled={importing} title="Choose images to add, or drop files anywhere on this panel">
            <ImagePlus /> Add images
          </button>
        )}
      </div>
      <div className="asset-host" {...dropProps} onKeyDown={sel ? onEscape(replacing ? closeReplace : back) : undefined}>
        {importing && (
          <p className="asset-importing" role="status">
            <Spinner decorative /> Adding files…
          </p>
        )}
        {tools}
        <div className={`panel-body${assets.length ? '' : ' asset-body-empty'}`}>
          {body}
          {!sel && !replacing && fonts.length > 0 && <FontList fonts={fonts} usage={usage} />}
          {!sel && !replacing && <DocumentList state={snap.state} docs={documents} usage={usage} missingOf={missingOf} reveal={shownDocument} onRevealed={revealed} onAdd={() => void addDocuments()} adding={importing} />}
          {!sel && !replacing && storage.info && <StorageSummary
              info={storage.info}
              onFree={() => {
                // The dialog shows the figures as they are when it opens.
                storage.refresh();
                setFreeing(true);
              }}
            />}
        </div>
        {freeing && storage.info && <FreeSpaceDialog info={storage.info} onClose={() => setFreeing(false)} refresh={storage.refresh} />}
        {over && assets.length > 0 && (
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
