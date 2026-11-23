import { createElement, Fragment, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ImageOff, ImagePlus, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { GraphNode, ImageValue, LinkValue, ListItem, ListProp, ProjectState, PropSchema, ScalarPropSchema } from '@shared/types';
import { refKey } from '@shared/types';
import { ICONS } from '@catalogue/foundation/icons';
import { api, getState, setState, toast, useStore, type PendingEdit } from '../store';
import { isImeComposing } from '../lib/ime';
import type { ListPlace } from '../lib/reveal';
import { DraftInput, Field, Switch, SwitchRow } from '../components/ui';
import { isSettling } from '../lib/pending';
import { announcementText } from '../lib/announce';

const MOVE_PENDING_MS = 3000;
import { addLimitNote, countLabel, countText, moveAnnouncement, moveFocusTarget, removeLimitNote, type MoveDirection } from '../lib/list-editor';
import { importAndPlace } from '../lib/place';
import { assetUrl } from '../lib/model';
import { richTextToMarkdown, toRichText } from '@shared/richtext';
import { pageIds, planSectionPick, sharedPageIds } from '@generator/checks';
import { contactMismatch } from '@shared/contact-links';
import { SECTION_NODE, sectionOptions } from '../lib/sections';

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const OTHER_SECTION = '\u0000other';

/**
 * Which section of a page a link jumps to: the page's sections by their headings (a section without an ID gets one
 * from its heading when it is chosen), the shared header and footer's IDs, or any ID typed in. `top` offers the top
 * of the page (no section); without it an empty value asks for a choice.
 */
function SectionPicker({ state, pageId, value, onPick, label, top, shared }: { state: ProjectState; pageId: string | null | undefined; value: string; onPick: (anchor: string, edit?: PendingEdit) => void; label: string; top?: boolean; shared?: boolean }) {
  const [typing, setTyping] = useState(false);
  const picker = useRef<HTMLSelectElement>(null);
  const revision = useStore((s) => s.snapshot?.revision);
  const page = pageId ? state.pages[pageId] : undefined;
  // A shared header or footer link to a section "on this page" shows on every page with the header, so only IDs all
  // of those pages have will work there, and choosing one never gives a section on one page a new ID.
  const { ids, options } = sectionOptions(state, pageId, shared);
  // A section that is gone (or was typed in) stays visible until another is chosen.
  if (value && !options.some((o) => o.value === `#${value}`)) options.push({ value: `#${value}`, text: ids.has(value) ? `#${value}` : `#${value} (not found)` });
  // Leaving the typed ID (a commit, Escape or a plain blur) goes back to the list.
  const backToList = (refocus: boolean) => {
    setTyping(false);
    if (refocus) requestAnimationFrame(() => picker.current?.focus());
  };
  if (typing)
    return (
      <span
        className="grow"
        style={{ display: 'flex', minWidth: 0 }}
        // While the project is being left, a refused ID stays in its field, for Keep editing to return to.
        onBlur={() => !isSettling() && backToList(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.stopPropagation(), backToList(true));
        }}
      >
        <DraftInput
          className="input sm grow"
          value={value}
          ariaLabel={label}
          placeholder={top ? 'Top of page, or a section ID' : 'section-id'}
          autoFocus
          onCommit={(t) => {
            const a = t.trim().replace(/^#/, '');
            if (a && !/^[A-Za-z][\w-]{0,60}$/.test(a)) {
              toast('Section IDs start with a letter and use letters, numbers, - and _.', 'error');
              return false;
            }
            backToList(true);
            if (a !== value) onPick(a);
          }}
        />
      </span>
    );
  return (
    <select
      ref={picker}
      className="select sm grow"
      value={value ? `#${value}` : ''}
      aria-label={label}
      onChange={(e) => {
        const v = e.target.value;
        if (v === OTHER_SECTION) return setTyping(true);
        // A pick from the list holds only for the project it was shown from: an undo in flight could remove the ID.
        if (!v.startsWith(SECTION_NODE)) return onPick(v.replace(/^#/, ''), v ? { operations: [], expectedRevision: revision } : undefined);
        const plan = page ? planSectionPick(state, page.id, v.slice(SECTION_NODE.length)) : null;
        if (plan) onPick(plan.anchor, { operations: plan.operations, expectedRevision: revision });
      }}
    >
      {top ? <option value="">Top of page</option> : !value && <option value="" disabled>Choose a section…</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.text}
        </option>
      ))}
      <option value={OTHER_SECTION}>Another section ID…</option>
    </select>
  );
}

/**
 * Link editor: what kind of destination, then the destination itself. `label` names the field it belongs to
 * ("Primary button"), so each control has a name that still makes sense out of context. Choosing a section that
 * has no ID yet passes the edit that gives it one, to be saved with the link.
 */
/**
 * A link's kind and destination. `everywhere` is for a link in a component's design, which shows on every page that
 * places it: it offers no section "on this page", since one page's section is not on the others.
 */
export function LinkEditor({ value, onChange, state, label, everywhere }: { value: LinkValue; onChange: (v: LinkValue, edit?: PendingEdit) => void; state: ProjectState; label?: string; everywhere?: boolean }) {
  const v = value ?? { type: 'none', target: '' };
  const currentPageId = useStore((s) => s.pageId);
  // A link in the shared header or footer shows on every page that has them.
  const shared = useStore((s) => s.selection?.owner.kind === 'shell');
  // A type that needs a destination before it is a valid link (an address, a number) waits here until one
  // is entered; a new value (an undo, another selection) ends the wait.
  const [pending, setPending] = useState<LinkValue['type'] | null>(null);
  const valueKey = JSON.stringify(value ?? null);
  useEffect(() => setPending(null), [valueKey]);
  const type = pending ?? v.type;
  const target = pending ? '' : v.target;
  const base = label?.replace(/ link$/i, '');
  const named = (what: string) => (base && base.toLowerCase() !== 'link' ? `${base} ${what.toLowerCase()}` : what);
  // The section a link jumps to survives a change of link type: a page link's #section becomes the anchor
  // link's target and back again.
  const anchor = v.type === 'anchor' ? v.target : v.anchor;
  const withAnchor = (l: LinkValue, a: string | undefined): LinkValue => {
    const out: LinkValue = { ...l };
    if (a) out.anchor = a;
    else delete out.anchor;
    return out;
  };
  // The page a link last pointed at, so a trip through another link type comes back to it.
  const lastPage = useRef<string | null>(null);
  if (v.type === 'page' && state.pages[v.target]) lastPage.current = v.target;
  const pickType = (t: LinkValue['type']) => {
    if (t === v.type) return setPending(null);
    if (t === 'none') onChange({ type: 'none', target: '' });
    else if (t === 'page') {
      // Back to the page it pointed at before; else the page being edited, where a carried section lives; else Home.
      const page = lastPage.current && state.pages[lastPage.current] ? lastPage.current : anchor && currentPageId && state.pages[currentPageId] ? currentPageId : state.site.homePageId;
      onChange(withAnchor({ type: t, target: page, newTab: v.newTab }, anchor));
    }
    // A section carries over only when it is on this page; otherwise one is chosen first.
    else if (t === 'anchor' && anchor && currentPageId && (shared ? sharedPageIds(state) : pageIds(state, currentPageId)).has(anchor)) onChange({ type: t, target: anchor });
    else setPending(t);
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="insp-link-row">
        <select className={`select sm${type === 'none' ? ' grow' : ' insp-link-type'}`} value={type} aria-label={named('Link type')} onChange={(e) => pickType(e.target.value as LinkValue['type'])}>
          <option value="none">No link</option>
          <option value="page">Page</option>
          <option value="url">Web address</option>
          <option value="email">Email</option>
          <option value="tel">Phone</option>
          {(!everywhere || type === 'anchor') && <option value="anchor">On this page</option>}
        </select>
        {type === 'page' ? (
          <select className="select sm grow" value={v.target} aria-label={named('Page')} onChange={(e) => onChange(withAnchor({ ...v, target: e.target.value }, e.target.value === v.target ? v.anchor : undefined))}>
            {state.site.pageOrder.map((id) => (
              <option key={id} value={id}>
                {state.pages[id].title} ({state.pages[id].route})
              </option>
            ))}
          </select>
        ) : type === 'anchor' && everywhere ? (
          // A design's section "on this page" is one every page placing it must have: shown, not re-picked here.
          <span className="faint ellipsis grow">#{target}</span>
        ) : type === 'anchor' ? (
          <SectionPicker state={state} pageId={currentPageId} value={target} label={named('Section')} shared={shared} onPick={(a, edit) => a && onChange({ type: 'anchor', target: a }, edit)} />
        ) : type !== 'none' ? (
          <DraftInput
            key={type}
            className="input sm grow"
            value={target}
            autoFocus={!!pending}
            ariaLabel={named(type === 'url' ? 'Web address' : type === 'email' ? 'Email address' : 'Phone number')}
            placeholder={type === 'url' ? 'https://example.com' : type === 'email' ? 'hello@example.com' : '+1 555 0100'}
            onCommit={(t) => {
              if (!t.trim()) return;
              onChange({ type, target: t.trim(), newTab: type === 'url' ? v.newTab : undefined });
            }}
          />
        ) : null}
      </div>
      {type === 'page' && (
        <div className="insp-link-row">
          <span className="insp-link-type faint insp-link-sub">Section</span>
          <SectionPicker state={state} pageId={v.target} value={v.anchor ?? ''} label={named('Section on the page')} top onPick={(a, edit) => onChange(withAnchor(v, a || undefined), edit)} />
        </div>
      )}
      {/* A new tab only means something for pages and web addresses; mail and phone links open their own apps. */}
      {!pending && (v.type === 'page' || v.type === 'url') && <SwitchRow checked={!!v.newTab} onChange={(n) => onChange({ ...v, newTab: n })} label="Open in a new tab" />}
    </div>
  );
}

/** The value for a newly chosen image, from the one it replaces: its suggested description, else the old one,
 *  which is then `carried` (flagged until it is checked), and whether it is decorative. */
function chosen(from: ImageValue, assetId: string, suggestion?: string): { value: ImageValue; carried: boolean } {
  const cur = from ?? { assetId: null, alt: '' };
  return { value: { assetId, alt: suggestion || cur.alt || '', decorative: cur.decorative }, carried: !suggestion && !!cur.alt && !!cur.assetId };
}

/**
 * Image editor: one card holding the picture, its description and whether it is decorative. `title` puts the
 * field's name inside the card (like the other field groups); a standalone image passes none.
 */
export function ImageEditor({ value, onChange, state, title }: { value: ImageValue; onChange: (v: ImageValue) => void; state: ProjectState; title?: string }) {
  const runtime = useStore((s) => s.runtime);
  // The project as this editor shows it: an import checks its placement against it.
  const snapshot = useStore((s) => s.snapshot);
  const altId = useId();
  const titleId = useId();
  // A description carried over from the previous image may no longer be true; say so until it is edited.
  const [carried, setCarried] = useState(false);
  const v = value ?? { assetId: null, alt: '' };
  const asset = v.assetId ? state.assets.assets[v.assetId] : null;
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  // The value as it is now, for work that finishes later (an import).
  const latest = useRef(v);
  latest.current = v;
  const pick = (id: string, suggestion?: string) => {
    const cur = latest.current;
    if (id === cur.assetId) return;
    const next = chosen(cur, id, suggestion);
    setCarried(next.carried);
    onChange(next.value);
  };
  const [browsing, setBrowsing] = useState(false);
  const [q, setQ] = useState('');
  const [over, setOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const browseId = useId();
  const chooseBtn = useRef<HTMLButtonElement>(null);
  const browser = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const images = Object.values(state.assets.assets).filter((a) => a.kind === 'image');
  const needle = q.trim().toLowerCase();
  const shown = needle ? images.filter((a) => `${a.name} ${a.description ?? ''} ${a.altSuggestion ?? ''}`.toLowerCase().includes(needle)) : images;
  const closeBrowser = (focus = true) => {
    setBrowsing(false);
    setQ('');
    if (focus) requestAnimationFrame(() => chooseBtn.current?.focus());
  };
  /**
   * Import through the file picker (no paths) or dropped files, then use the first image that arrived. The image
   * goes to this field as it was when the import began, through the change handler it had then, even if the author
   * has moved to another section meanwhile; a change made to the field since (another image, a description, the
   * section removed) wins, and the image is kept in Assets with a note saying so (see importAndPlace).
   */
  const importAndPick = async (paths?: string[]) => {
    if (importing) return;
    setImporting(true);
    const start = latest.current;
    const write = onChange;
    let carry: boolean | null = null;
    // Where focus may come back to the chooser from: the image browser this closes, the chooser, or nowhere.
    const fromChooser = () => {
      const at = document.activeElement;
      return !at || at === document.body || at === chooseBtn.current || !!browser.current?.contains(at);
    };
    try {
      const r = await importAndPlace({
        paths,
        base: snapshot,
        // On screen: mounted, and not in a dock tab that is hidden (AI, Site styles).
        shown: () => alive.current && !!chooseBtn.current?.isConnected && chooseBtn.current.offsetParent !== null,
        holds: (a) => a.id === start.assetId,
        place: (a) => {
          // The same picture again: the field is checked, not written.
          if (a.id === start.assetId) return write(start);
          const next = chosen(start, a.id, a.altSuggestion);
          carry = next.carried;
          write(next.value);
          if (next.carried) return 'Check its description still fits.';
        }
      });
      if (r.kind !== 'placed' || !alive.current) return;
      if (carry !== null) setCarried(carry);
      // Never from a field the author has moved to meanwhile, the description included; checked again when the
      // browser has closed, in case focus moved in between.
      const refocus = fromChooser();
      closeBrowser(false);
      if (refocus) requestAnimationFrame(() => alive.current && fromChooser() && chooseBtn.current?.focus());
    } finally {
      if (alive.current) setImporting(false);
    }
  };
  const isFileDrag = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!over) setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setOver(false);
      const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
      if (paths.length) void importAndPick(paths);
    }
  };
  // Arrow keys move between thumbnails; the grid is one tab stop.
  const gridKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>('.insp-pick-tile')];
    const i = tiles.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[e.key];
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? tiles.length - 1 : step !== undefined ? Math.max(0, Math.min(tiles.length - 1, i + step)) : -1;
    if (to < 0) return;
    e.preventDefault();
    tiles.forEach((t, k) => (t.tabIndex = k === to ? 0 : -1));
    tiles[to].focus();
  };
  // Until there is an image (or something already set about it), the chooser is the only thing to do.
  const details = !!asset || !!v.alt || !!v.decorative;
  return (
    <div
      className={`insp-image${over ? ' drop-over' : ''}`}
      role={title ? 'group' : undefined}
      aria-labelledby={title ? titleId : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && browsing) (e.stopPropagation(), closeBrowser());
      }}
      {...dropProps}
    >
      {title && (
        <div className="insp-group-title" id={titleId}>
          {title}
        </div>
      )}
      <div className="insp-image-top">
        <div className={`insp-image-thumb${asset ? '' : ' empty'}`}>{asset && devUrl ? <img src={assetUrl(devUrl, asset.file)!} alt="" /> : <ImageOff aria-hidden="true" />}</div>
        <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
          <span className={`ellipsis insp-image-name${asset ? '' : ' none'}`} title={asset?.name}>{asset ? asset.name : over ? 'Drop to use this image' : 'No image chosen'}</span>
          <span className="row" style={{ gap: 4 }}>
            <button ref={chooseBtn} className="btn btn-sm" aria-expanded={browsing} aria-controls={browsing ? browseId : undefined} onClick={() => (browsing ? closeBrowser(false) : setBrowsing(true))} disabled={importing}>
              <ImagePlus />
              {importing ? 'Adding…' : asset ? 'Change…' : 'Choose image…'}
            </button>
            {asset && (
              <button className="icon-btn sm" aria-label={`Remove ${title ? title.toLowerCase() : 'image'}`} title="Remove image" onClick={() => onChange({ assetId: null, alt: v.alt, decorative: v.decorative })}>
                <ImageOff />
              </button>
            )}
          </span>
        </div>
      </div>
      {browsing && (
        <div
          ref={browser}
          className="insp-pick"
          id={browseId}
          role="group"
          aria-label={title ? `Choose ${title.toLowerCase()}` : 'Choose an image'}
        >
          <div className="insp-pick-tools">
            {images.length > 6 && <input type="search" className="input sm grow" placeholder="Search images" aria-label="Search images" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />}
            <button className="btn btn-sm" onClick={() => void importAndPick()} disabled={importing} autoFocus={images.length <= 6}>
              <Plus /> Import…
            </button>
          </div>
          {shown.length > 0 ? (
            <div className="insp-pick-grid" role="listbox" aria-label="Your images" onKeyDown={gridKeys}>
              {shown.map((a, i) => (
                <button
                  key={a.id}
                  role="option"
                  aria-selected={a.id === v.assetId}
                  tabIndex={a.id === v.assetId || (i === 0 && !shown.some((x) => x.id === v.assetId)) ? 0 : -1}
                  className={`insp-pick-tile${a.id === v.assetId ? ' current' : ''}`}
                  title={a.name}
                  onClick={() => {
                    pick(a.id, a.altSuggestion);
                    closeBrowser();
                  }}
                >
                  {devUrl ? <img src={assetUrl(devUrl, a.file)!} alt="" loading="lazy" /> : <ImageOff aria-hidden="true" />}
                  <span className="ellipsis">{a.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="faint insp-note">{images.length ? `No images match “${q.trim()}”.` : 'No images yet. Import one, or drop an image file here.'}</p>
          )}
          {images.length > 0 && <p className="faint insp-note">You can also drop an image file on this card.</p>}
        </div>
      )}
      {details && !v.decorative && (
        <div className="field">
          <label htmlFor={altId}>Image description</label>
          <DraftInput
            id={altId}
            multiline
            rows={2}
            className="textarea insp-alt"
            value={v.alt}
            placeholder="What the image shows"
            aria-describedby={`${altId}-h`}
            onCommit={(alt) => (setCarried(false), onChange({ ...v, alt }))}
          />
          <span className={`field-hint${carried ? ' insp-check' : ''}`} id={`${altId}-h`}>
            {carried && <TriangleAlert aria-hidden="true" />}
            {carried ? 'Kept from the previous image. Check it still describes this one.' : 'For screen readers, and shown if the image can’t load.'}
          </span>
        </div>
      )}
      {details && <SwitchRow checked={!!v.decorative} onChange={(d) => onChange({ ...v, decorative: d })} label="Decorative image" hint={v.decorative ? 'Screen readers skip it, so it needs no description.' : undefined} />}
    </div>
  );
}

/** One of the site's icons, drawn from the same data the generated site uses. */
export function IconGlyph({ name, size = 18 }: { name: string; size?: number }) {
  const nodes = Object.hasOwn(ICONS, name) ? ICONS[name] : ICONS.sparkles;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {nodes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

const iconName = (k: string) => sentence(k.replace(/-/g, ' '));

/**
 * The icon control: a button showing the current icon, which opens a searchable grid of every icon drawn as
 * it will look. The grid is one tab stop; arrow keys move, Enter or a click chooses, Escape closes.
 */
export function IconPicker({ value, onChange, label = 'Icon', id, describedBy }: { value: string; onChange: (v: string) => void; label?: string; id?: string; describedBy?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const gridId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const names = Object.keys(ICONS);
  const needle = q.trim().toLowerCase();
  const shown = needle ? names.filter((k) => k.includes(needle.replace(/\s+/g, '-')) || iconName(k).toLowerCase().includes(needle)) : names;
  const COLS = 6;
  const close = (focus = true) => {
    setOpen(false);
    setQ('');
    if (focus) requestAnimationFrame(() => btn.current?.focus());
  };
  useEffect(() => {
    if (open) requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  }, [open]);
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
    const i = tiles.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? tiles.length - 1 : step !== undefined ? Math.max(0, Math.min(tiles.length - 1, i + step)) : -1;
    if (to < 0) return;
    e.preventDefault();
    tiles.forEach((t, k) => (t.tabIndex = k === to ? 0 : -1));
    tiles[to].focus();
  };
  const current = shown.includes(value) ? value : shown[0];
  return (
    <div
      className="insp-icon-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) (e.stopPropagation(), close());
      }}
    >
      <button
        ref={btn}
        type="button"
        className="select insp-icon-btn"
        id={id}
        aria-describedby={[describedBy, id ? `${gridId}-cur` : undefined].filter(Boolean).join(' ') || undefined}
        aria-label={id ? undefined : `${label}: ${iconName(value)}`}
        aria-expanded={open}
        aria-controls={open ? gridId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <IconGlyph name={value} />
        <span className="grow ellipsis" id={`${gridId}-cur`}>
          {iconName(value)}
        </span>
        <ChevronDown aria-hidden="true" className="faint" />
      </button>
      {open && (
        <div
          className="insp-pick"
          id={gridId}
        >
          <input type="search" className="input sm" placeholder="Search icons" aria-label="Search icons" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
          {shown.length ? (
            <div ref={grid} className="insp-icon-grid" role="listbox" aria-label={label} onKeyDown={keys}>
              {shown.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="option"
                  aria-selected={k === value}
                  aria-label={iconName(k)}
                  title={iconName(k)}
                  tabIndex={k === current ? 0 : -1}
                  className={`insp-icon-tile${k === value ? ' current' : ''}`}
                  onClick={() => {
                    if (k !== value) onChange(k);
                    close();
                  }}
                >
                  <IconGlyph name={k} size={20} />
                </button>
              ))}
            </div>
          ) : (
            <p className="faint insp-note">No icons match “{q.trim()}”.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The control for one scalar value. With `id`, a visible <label htmlFor> names it and `describedBy` points at
 * its hint; without, it names itself with aria-label.
 */
export function ScalarEditor({ schema, value, onChange, state, label, id, describedBy, invalid, onLive }: { schema: ScalarPropSchema; value: unknown; onChange: (v: unknown, edit?: PendingEdit) => void; state: ProjectState; label?: string; id?: string; describedBy?: string; invalid?: boolean; onLive?: (text: string) => void }) {
  const name = id ? undefined : (label ?? schema.label);
  const wired = { id, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined };
  switch (schema.type) {
    case 'string':
      return <DraftInput {...wired} multiline={schema.multiline} rows={2} value={String(value ?? '')} onCommit={onChange} onLive={onLive} ariaLabel={name} />;
    case 'richtext':
      return (
        <DraftInput
          {...wired}
          multiline
          rows={4}
          value={richTextToMarkdown(toRichText(value, schema.plainAs), state.pages, schema.plainAs)}
          onCommit={onChange}
          ariaLabel={name}
          placeholder={'One paragraph per line. Use **bold**, *italic*, [a link](/about/), "- " for lists and "### " for headings.'}
        />
      );
    case 'number':
      return <DraftInput {...wired} value={String(value ?? schema.default)} onCommit={(t) => onChange(Number(t))} ariaLabel={name} />;
    case 'boolean':
      return <Switch id={id} describedBy={describedBy} checked={!!value} onChange={onChange} label={name ?? schema.label} />;
    case 'enum':
      return (
        <select className="select" {...wired} value={String(value ?? schema.default)} onChange={(e) => onChange(e.target.value)} aria-label={name}>
          {schema.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'link':
      return <LinkEditor value={value as LinkValue} onChange={onChange} state={state} label={label ?? schema.label} />;
    case 'image':
      return <ImageEditor value={value as ImageValue} onChange={onChange} state={state} title={label ?? schema.label} />;
    case 'icon':
      return <IconPicker id={id} describedBy={describedBy} value={String(value ?? schema.default)} onChange={onChange} label={label ?? schema.label} />;
  }
}

/** A one-click fix offered under a field's problem, such as hiding a button that has no link. */
export interface FieldAction {
  label: string;
  run: () => void;
}

/**
 * One scalar field with its visible label wired to its control. Booleans sit on one line; images are their own
 * titled card. `hint` replaces the schema's description and `error` replaces both, for text and link fields; a
 * link can also offer an `action` that fixes its problem.
 */
export function ScalarField({ schema, value, onChange, state, label, hint, error, action, onLive }: { schema: ScalarPropSchema; value: unknown; onChange: (v: unknown, edit?: PendingEdit) => void; state: ProjectState; label?: string; hint?: ReactNode; error?: string; action?: FieldAction; onLive?: (text: string) => void }) {
  const id = useId();
  const shown = label ?? schema.label;
  const note = hint ?? schema.description;
  if (schema.type === 'boolean') return <SwitchRow checked={!!value} onChange={onChange} label={shown} hint={schema.description} />;
  if (schema.type === 'image') return <ImageEditor value={value as ImageValue} onChange={onChange} state={state} title={shown} />;
  // A link is two controls (kind and destination) that name themselves; the label names the pair.
  if (schema.type === 'link')
    return (
      <div className="field" role="group" aria-labelledby={`${id}-l`} aria-describedby={error || note ? `${id}-note` : undefined}>
        <div className="field-label" id={`${id}-l`}>
          {shown}
        </div>
        <LinkEditor value={value as LinkValue} onChange={onChange} state={state} label={schema.label} />
        {error ? (
          <div className="field-error" id={`${id}-note`}>
            {error}
          </div>
        ) : note ? (
          <div className="field-hint" id={`${id}-note`}>
            {note}
          </div>
        ) : null}
        {action && (
          <button className="btn btn-sm insp-inline-btn" onClick={action.run}>
            {action.label}
          </button>
        )}
      </div>
    );
  return (
    <Field label={shown} hint={note} error={error} controlId={id}>
      <ScalarEditor schema={schema} value={value} onChange={onChange} state={state} id={id} describedBy={note || error ? `${id}-note` : undefined} invalid={!!error} onLive={onLive} />
    </Field>
  );
}

/** What the editor says about one field of a list item: a note under it, or a problem that also marks the item. */
export interface ListItemNote {
  field: string;
  hint?: ReactNode;
  error?: string;
  /** A fix for the problem, offered under the field. */
  action?: FieldAction;
}

/** An edit to a list: `repair` is an explicit fix the inspector offers, its own undo step under `label`. */
export type ListOp =
  | { kind: 'insert' }
  | { kind: 'remove'; itemId: string }
  | { kind: 'move'; itemId: string; index: number }
  | { kind: 'field'; itemId: string; field: string; value: unknown; edit?: PendingEdit }
  | { kind: 'repair'; itemId: string; field: string; value: unknown; label: string; revision?: number };

/** Item fields that are one link's visible text and its destination (see itemLinkPairs). */
export type LinkPairs = ReadonlyArray<{ text: string; link: string }>;

export function PropField({ name, schema, value, onChange, onList, state, focusItem, label, hint, annotate, linkPairs, error, action, place }: {
  name: string;
  schema: PropSchema;
  value: unknown;
  onChange: (v: unknown, edit?: PendingEdit) => void;
  onList: (op: ListOp) => void;
  state: ProjectState;
  focusItem?: string;
  /** A shorter visible label, when a group heading already says what the field belongs to. */
  label?: string;
  /** For a scalar: what to say under it in place of the schema's description. */
  hint?: ReactNode;
  /** For a list: what to say about each item, such as the key a form field is sent under. */
  annotate?: (item: ListItem, index: number) => ListItemNote | undefined;
  linkPairs?: LinkPairs;
  /** For a single field: a problem to show under it, and a fix for it. */
  error?: string;
  action?: FieldAction;
  /** For a list: the placement it belongs to, so the item open here is revealed on the page (see lib/reveal). */
  place?: ListPlace;
}) {
  if (schema.type === 'list') return <ListEditor name={name} schema={schema} items={(value as ListItem[]) ?? []} onList={onList} state={state} focusItem={focusItem} annotate={annotate} linkPairs={linkPairs} place={place} />;
  return <ScalarField schema={schema} value={value} onChange={onChange} state={state} label={label} hint={hint} error={error} action={action} />;
  void name;
}

export interface PropGroup<T> {
  /** Heading for fields that belong together ("Primary button"), or none for a field that stands alone. */
  title?: string;
  items: Array<{ key: string; schema: PropSchema | ScalarPropSchema; label?: string; data: T }>;
}

/**
 * Group content fields the way they appear on the page. A schema's own `group` wins; otherwise a text field
 * named "X label" followed by a link named "X link" (or just "Link") is one thing on the page, a button or a
 * link, so it becomes a group "X" with fields "Label" and "Link". Everything else stays in schema order.
 */
export function groupFields<T>(entries: Array<{ key: string; schema: PropSchema | ScalarPropSchema; data: T }>): Array<PropGroup<T>> {
  const out: Array<PropGroup<T>> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const g = e.schema.group;
    if (g) {
      const last = out[out.length - 1];
      if (last?.title === g) last.items.push({ ...e, label: shorten(e.schema.label, g) });
      else out.push({ title: g, items: [{ ...e, label: shorten(e.schema.label, g) }] });
      continue;
    }
    const next = entries[i + 1];
    const m = /^(.*) label$/i.exec(e.schema.label);
    if (m && e.schema.type === 'string' && next && next.schema.type === 'link' && !next.schema.group) {
      const prefix = m[1];
      const nl = next.schema.label.toLowerCase();
      if (nl === `${prefix} link`.toLowerCase() || nl === 'link') {
        out.push({ title: prefix, items: [{ ...e, label: 'Label' }, { ...next, label: prefix.toLowerCase() === 'link' ? 'Destination' : 'Link' }] });
        i++;
        continue;
      }
    }
    out.push({ items: [e] });
  }
  return out;
}

function shorten(label: string, group: string): string | undefined {
  if (!label.toLowerCase().startsWith(group.toLowerCase() + ' ')) return undefined;
  return sentence(label.slice(group.length + 1));
}

/** Renders grouped fields: a group gets a heading and a quiet frame, a lone field renders as itself. */
export function FieldGroups<T>({ groups, render }: { groups: Array<PropGroup<T>>; render: (item: PropGroup<T>['items'][number]) => ReactNode }) {
  return (
    <>
      {groups.map((g, gi) =>
        g.title ? (
          <fieldset key={gi} className="insp-group">
            <legend className="insp-group-title">{g.title}</legend>
            {g.items.map((it) => (
              <Fragment key={it.key}>{render(it)}</Fragment>
            ))}
          </fieldset>
        ) : (
          <Fragment key={g.items[0].key}>{render(g.items[0])}</Fragment>
        )
      )}
    </>
  );
}

/**
 * Visible contact text and a link that open different addresses or numbers: both are shown, with one explicit
 * repair that points the link at what visitors see. Nothing shows for a deliberate label ("Call reception").
 */
export function ContactMismatch({ text, link, onRepair }: { text: unknown; link: unknown; onRepair: (link: LinkValue, label: string, revision: number | undefined) => void }) {
  // The repair is planned on the project this render shows, and applies only to it.
  const revision = useStore((s) => s.snapshot?.revision);
  const m = contactMismatch(text, link);
  if (!m) return null;
  const action = m.kind === 'email' ? 'Use displayed email as destination' : 'Use displayed number as destination';
  return (
    <div className="scope-note site contact-mismatch" role="note">
      <TriangleAlert aria-hidden="true" />
      <div className="grow">
        <p className="insp-note">
          Visitors see <strong>{m.shown}</strong>, but the link opens <strong>{m.opens}</strong>.
        </p>
        <button className="btn btn-sm" onClick={() => onRepair(m.repair, action, revision)}>
          {action}
        </button>
      </div>
    </div>
  );
}

/** Who holds a revealed item between a part's inspector going and its section's list showing: one per hand-over. */
let handOvers = 0;

/**
 * Reveals a list item on the page while it is open in the inspector (see lib/reveal): its disclosure opened and
 * outlined, and what is typed into its plain text fields shown there before it is saved. The item is claimed when it
 * opens and whenever its fields take focus, and only its own claimant clears or changes it, so a second list opened
 * later keeps the page. It is followed by its id through saves and moves. Spread `handlers` on the element holding
 * the item's fields; `typed(field)` is a plain text field's live-text callback. With `handOver`, going to the item's
 * own section hands the item to the list there instead of ending the reveal.
 */
export function useRevealedItem(place: ListPlace | undefined, item: ListItem | undefined, handOver = false) {
  const owner = useId();
  // Escape in a field cancels what was typed there: the page shows its own text again at once.
  const cancelling = useRef<string | null>(null);
  const itemId = place && item ? item.id : null;
  const claim = () => {
    if (!place || !itemId) return;
    const r = getState().revealedItem;
    if (r?.owner === owner && r.itemId === itemId && r.list === place.list && refKey(r.ref) === refKey(place.ref)) return;
    setState({ revealedItem: { owner, ref: place.ref, list: place.list, itemId, draft: null } });
  };
  useEffect(() => {
    claim();
    return () => {
      const r = getState().revealedItem;
      if (r?.owner !== owner) return;
      // A part's inspector on the way to the section its item belongs to: the list there takes the item over once it
      // shows (see ListEditor), so the page keeps it open in between. Anything else ends the reveal now.
      const sel = getState().selection;
      if (handOver && place && sel && refKey(sel) === refKey(place.ref)) {
        const held = `handed-over-${++handOvers}`;
        setState({ revealedItem: { ...r, owner: held, draft: null, cancelled: undefined } });
        setTimeout(() => getState().revealedItem?.owner === held && setState({ revealedItem: null }), 1000);
      } else setState({ revealedItem: null });
    };
  }, [place && refKey(place.ref), place?.list, itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = (draft: { field: string; text: string } | null, cancelled?: string) => {
    const r = getState().revealedItem;
    if (!itemId || r?.owner !== owner || r.itemId !== itemId) return;
    const next = draft ? undefined : cancelled;
    if (draft ? r.draft?.field === draft.field && r.draft.text === draft.text : !r.draft && r.cancelled === next) return;
    setState({ revealedItem: { ...r, draft, cancelled: next } });
  };
  return {
    typed: (field: string) => (itemId ? (text: string) => show({ field, text }) : undefined),
    handlers: {
      onFocus: claim,
      // Typing ended: the page shows the saved text again once the save has arrived, or at once when it was cancelled.
      onBlur: () => {
        show(null, cancelling.current ?? undefined);
        cancelling.current = null;
      },
      // A text field leaves on Escape, putting back what was saved (see DraftInput): the field typed in is cancelled.
      onKeyDownCapture: (e: ReactKeyboardEvent) => {
        if (e.key === 'Escape' && !isImeComposing(e) && (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) cancelling.current = getState().revealedItem?.draft?.field ?? null;
      }
    }
  };
}

/**
 * A repeatable list. Focus follows the edit: a new item opens with its row focused, and removing an item moves
 * focus to the row that takes its place (or to Add when the list is empty). A moved item keeps focus on the button
 * that moved it, and on its own disclosure once that button is disabled at the end of the list; the new position is
 * announced. The limits are stated where they bite: the count shows the maximum, and Add and Remove stay focusable
 * with the reason once the list is full or at its minimum.
 */
function ListEditor({ name, schema, items, onList, state, focusItem, annotate, linkPairs, place }: { name: string; schema: ListProp; items: ListItem[]; onList: (op: ListOp) => void; state: ProjectState; focusItem?: string; annotate?: (item: ListItem, index: number) => ListItemNote | undefined; linkPairs?: LinkPairs; place?: ListPlace }) {
  // Opens on the item of this list already revealed on the page (a part of it was selected, and the list is shown
  // now), so the page keeps that item open while the list takes it over.
  const [open, setOpen] = useState<string | null>(() => {
    const r = getState().revealedItem;
    return place && r && r.list === place.list && refKey(r.ref) === refKey(place.ref) && items.some((x) => x.id === r.itemId) ? r.itemId : null;
  });
  const labelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const after = useRef<{ kind: 'added'; before: string[] } | { kind: 'removed'; focus: string | null } | { kind: 'moved'; id: string; direction: MoveDirection; index: number; from: number; title: string; at: number } | null>(null);
  const [said, setSaid] = useState({ text: '', count: 0 });
  const addNoteId = useId();
  const removeNoteId = useId();
  const ids = items.map((i) => i.id).join(',');
  useEffect(() => {
    const a = after.current;
    if (!a) return;
    const root = rootRef.current;
    const focusRow = (id: string | null) => ((id && root?.querySelector<HTMLElement>(`#list-head-${CSS.escape(id)}`)) || root?.querySelector<HTMLElement>('.insp-add'))?.focus();
    if (a.kind === 'added') {
      const added = items.find((i) => !a.before.includes(i.id));
      if (!added) return;
      after.current = null;
      setOpen(added.id);
      requestAnimationFrame(() => focusRow(added.id));
    } else if (a.kind === 'moved') {
      // The move lands with a later saved revision. Until then the item is still where it was (another item's move
      // may land first) and the request stays pending. Once the item is anywhere but where the move put it, or the
      // request is old, it was rejected or overtaken: it is dropped, so it can't claim a later change such as Undo.
      const at = items.findIndex((x) => x.id === a.id);
      if (Date.now() - a.at > MOVE_PENDING_MS || (at !== a.index && at !== a.from)) after.current = null;
      if (at !== a.index) return;
      after.current = null;
      const target = moveFocusTarget(a.direction, a.index, items.length);
      requestAnimationFrame(() => {
        // Only put focus back where it was taken from: still on the button that moved the item, or on the page body
        // (that button was moved in the DOM or went disabled). Someone who has tabbed elsewhere keeps their place.
        const active = document.activeElement;
        if (active && active !== document.body && active.id !== `list-${a.direction}-${a.id}`) return;
        const el = root?.querySelector<HTMLElement>(`#list-${target}-${CSS.escape(a.id)}`) ?? root?.querySelector<HTMLElement>(`#list-head-${CSS.escape(a.id)}`);
        el?.focus();
      });
      setSaid((p) => announcementText(moveAnnouncement(a.title, a.index, items.length), p.count) ?? p);
    } else {
      after.current = null;
      requestAnimationFrame(() => focusRow(a.focus));
    }
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const openId = focusItem ?? open;
  const reveal = useRevealedItem(place, openId ? items.find((x) => x.id === openId) : undefined);
  const titleOf = (it: ListItem, i: number) => {
    const t = schema.titleField ? it[schema.titleField] : Object.values(it).find((v) => typeof v === 'string' && v && v !== it.id);
    return (typeof t === 'string' && t) || `${schema.itemLabel} ${i + 1}`;
  };
  const L = onList;
  const move = (it: ListItem, i: number, direction: MoveDirection) => {
    const index = direction === 'up' ? i - 1 : i + 1;
    after.current = { kind: 'moved', id: it.id, direction, index, from: i, title: titleOf(it, i), at: Date.now() };
    L({ kind: 'move', itemId: it.id, index });
  };
  const addNote = addLimitNote(items.length, schema.itemLabel, schema.max, schema.min);
  const removeNote = removeLimitNote(items.length, schema.itemLabel, schema.min, schema.max);
  // A fixed-size list gives one reason for both actions.
  const removeNoteShared = removeNote !== null && removeNote === addNote;
  const fields = groupFields(Object.entries(schema.fields).map(([key, s]) => ({ key, schema: s, data: null })));
  return (
    <div className="field" role="group" aria-labelledby={labelId} data-list={name} ref={rootRef}>
      <div className="field-label" id={labelId}>
        <span className="grow">{schema.label}</span>
        <span className="insp-count" aria-label={countLabel(items.length, schema.itemLabel, schema.max)}>
          {countText(items.length, schema.max)}
        </span>
      </div>
      <div className="list-editor">
        {items.map((it, i) => {
          const note = annotate?.(it, i);
          return (
          <div key={it.id} className={`list-editor-item${focusItem === it.id ? ' focused' : ''}`}>
            <div className="list-editor-head">
              {/* The chevron and title are one disclosure button, so the whole leading area opens the item. */}
              <button className="title" id={`list-head-${it.id}`} aria-expanded={openId === it.id} aria-controls={`list-item-${it.id}`} aria-describedby={note?.error ? `list-flag-${it.id}` : undefined} onClick={() => setOpen(openId === it.id ? null : it.id)}>
                <ChevronRight size={12} className="faint" style={{ transform: openId === it.id ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
                <span className="ellipsis">{titleOf(it, i)}</span>
                {/* A closed item still shows it needs attention. */}
                {note?.error && (
                  <span className="list-editor-flag" title={note.error} aria-hidden="true">
                    <TriangleAlert />
                  </span>
                )}
              </button>
              {/* Outside the button, so the problem describes the row without becoming part of its name. */}
              {note?.error && (
                <span className="sr-only" id={`list-flag-${it.id}`}>
                  {note.error}
                </span>
              )}
              <button className="icon-btn sm" aria-label={`Move ${titleOf(it, i)} up`} id={`list-up-${it.id}`} disabled={i === 0} onClick={() => move(it, i, 'up')}>
                <ArrowUp />
              </button>
              <button className="icon-btn sm" aria-label={`Move ${titleOf(it, i)} down`} id={`list-down-${it.id}`} disabled={i === items.length - 1} onClick={() => move(it, i, 'down')}>
                <ArrowDown />
              </button>
              <button className="icon-btn sm" aria-label={`Remove ${titleOf(it, i)}`} aria-disabled={removeNote ? true : undefined} aria-describedby={removeNote ? (removeNoteShared ? addNoteId : removeNoteId) : undefined} title={removeNote ?? undefined} onClick={() => {
                  if (removeNote) return;
                  after.current = { kind: 'removed', focus: (items[i + 1] ?? items[i - 1])?.id ?? null };
                  L({ kind: 'remove', itemId: it.id });
                }}>
                <Trash2 />
              </button>
            </div>
            {/* The controlled region always exists, so aria-controls resolves while the item is closed. */}
            <div className="list-editor-body" id={`list-item-${it.id}`} hidden={openId !== it.id} {...(openId === it.id ? reveal.handlers : {})}>
              {openId === it.id && (
                <>
                  <FieldGroups
                    groups={fields}
                    render={({ key, schema: fs, label }) => (
                      <ScalarField
                        key={key}
                        schema={fs as ScalarPropSchema}
                        label={label}
                        value={it[key]}
                        onChange={(v, edit) => L({ kind: 'field', itemId: it.id, field: key, value: v, edit })}
                        state={state}
                        hint={note?.field === key ? note.hint : undefined}
                        error={note?.field === key ? note.error : undefined}
                        action={note?.field === key ? note.action : undefined}
                        onLive={fs.type === 'string' ? reveal.typed(key) : undefined}
                      />
                    )}
                  />
                  {linkPairs?.map((p) => (
                    <ContactMismatch key={p.link} text={it[p.text]} link={it[p.link]} onRepair={(link, label, revision) => L({ kind: 'repair', itemId: it.id, field: p.link, value: link, label, revision })} />
                  ))}
                </>
              )}
            </div>
          </div>
          );
        })}
        <button className="btn btn-sm insp-add" aria-disabled={addNote ? true : undefined} aria-describedby={addNote ? addNoteId : undefined} title={addNote ?? undefined} onClick={() => {
            if (addNote) return;
            after.current = { kind: 'added', before: items.map((x) => x.id) };
            L({ kind: 'insert' });
          }}>
          <Plus /> Add {schema.itemLabel.toLowerCase()}
        </button>
        {addNote && (
          <p className="insp-note muted" id={addNoteId}>
            {addNote}
          </p>
        )}
        {removeNote && !removeNoteShared && (
          <p className="insp-note muted" id={removeNoteId}>
            {removeNote}
          </p>
        )}
        <span className="sr-only" role="status">
          {said.text}
        </span>
      </div>
    </div>
  );
}
