import { createElement, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CornerDownRight, FilePlus, Image as ImageIcon, ImageOff, ImagePlus, Images, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { ChoiceOption, ChoicesProp, ElementRef, GraphNode, ImageValue, LinkValue, ListItem, ListProp, ObjectProp, ProjectState, PropSchema, ScalarPropSchema } from '@shared/types';
import { refKey } from '@shared/types';
import { ICONS } from '@catalogue/foundation/icons';
import { api, getState, markDraft, setState, toast, useStore, type PendingEdit } from '../store';
import { isImeComposing } from '../lib/ime';
import { linkFieldProblem } from '../lib/link-problems';
import type { ListPlace } from '../lib/reveal';
import { DraftInput, Field, FieldHome, openSection, Switch, SwitchRow, useFieldHome } from '../components/ui';
import { TEXT_LIMITS } from '@shared/text-limits';
import { isSettling, savesInFlight } from '../lib/pending';
import { announcementText } from '../lib/announce';
import { MAX_CHOICES as MAX_CHOICE_ROWS } from '@engine/values';
import { declaredTokens } from '@engine/tokens';
import { applyChoiceAction, choiceText, sameChoice, staleRename, type ChoiceAction } from '../lib/choices';

const MOVE_PENDING_MS = 3000;
import { addLimitNote, countLabel, countText, moveAnnouncement, moveFocusTarget, removeLimitNote, type MoveDirection } from '../lib/list-editor';
import { emptyPickNote, pickAnnouncement, pickRoom, sampleRows, startingSamples } from '../lib/gallery-picks';
import { importAndPlace } from '../lib/place';
import { AssetImage } from '../components/AssetImage';
import { fitFor } from '../components/AssetPicture';
import { AssetOrderControls, useAssetSeries } from '../components/AssetOrder';
import { assetLabels, inSeries, sortAssets } from '@shared/asset-order';
import { richTextToMarkdown, toRichText } from '@shared/richtext';
import { RichTextField } from '../components/RichTextField';
import { pageIds, planSectionPick, sharedPageIds } from '@generator/checks';
import { contactMismatch } from '@shared/contact-links';
import { SECTION_NODE, sectionOptions } from '../lib/sections';
import { pagesToAdd, teaserFieldNote } from '../lib/page-teasers';
import type { PictureStandIn } from '../lib/sharing';
import { effectiveItem } from '@shared/page-teasers';
import { feedLimit } from '@shared/articles';
import { entryQuery, feedCollection } from '@shared/entry-feed';
import { findEntry } from '@shared/collections';
import { openPost, selectPage } from '../lib/actions';
import { placedFeedRows, resolveRef } from '../lib/model';
import { groupFields, listItemImage, listRowTitle, type PropGroup } from '@shared/fields';
import type { TableEdit } from '@engine/table';
import { TableEditor } from './TableEditor';
import { menuGroups, shownUnder } from '@engine/tree';
import { ImagesPicker, missingKey, pickGridKeys } from './ImagesPicker';
import { isShellPart, type ShellPart } from '@shared/page-shell';
import { documentDetails, documentLabels, isLibraryDocument, libraryDocuments } from '../lib/documents';
import { assetArrived } from '../lib/import-review';

export { groupFields };

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const OTHER_SECTION = '\u0000other';

/**
 * Which section of a page a link jumps to: the page's sections by their headings (a section without an ID gets one
 * from its heading when it is chosen), the shared header and footer's IDs, or any ID typed in. `top` offers the top
 * of the page (no section); without it an empty value asks for a choice.
 */
function SectionPicker({ state, pageId, value, onPick, label, top, shared, id, invalid, describedBy, onTyping }: { state: ProjectState; pageId: string | null | undefined; value: string; onPick: (anchor: string, edit?: PendingEdit) => void; label: string; top?: boolean; shared?: ShellPart; id?: string; invalid?: boolean; describedBy?: string; onTyping?: (typing: boolean) => void }) {
  const [typing, setTypingState] = useState(false);
  const setTyping = (on: boolean) => {
    setTypingState(on);
    onTyping?.(on);
  };
  // A picker that goes while an ID is being typed (another kind of link, another selection) ends the typing it reported.
  const typingReport = useRef(onTyping);
  typingReport.current = onTyping;
  useEffect(() => () => typingReport.current?.(false), []);
  const picker = useRef<HTMLSelectElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  // Only Enter goes back to the list with focus; leaving the field another way lets focus go where it went.
  const byKey = useRef(false);
  // An ID that can't be used stays in its field, with the reason under it, until it is fixed or abandoned with Esc.
  const [problem, setProblem] = useState('');
  const escaping = useRef(false);
  const hintId = useId();
  const problemId = useId();
  const revision = useStore((s) => s.snapshot?.revision);
  const page = pageId ? state.pages[pageId] : undefined;
  // A shared header or footer link to a section "on this page" shows on every page with that header or footer, so only
  // IDs all of those pages have will work there, and choosing one never gives a section on one page a new ID.
  const { ids, options } = sectionOptions(state, pageId, shared);
  // A section that is gone (or was typed in) stays visible until another is chosen.
  if (value && !options.some((o) => o.value === `#${value}`)) options.push({ value: `#${value}`, text: ids.has(value) ? `#${value}` : `#${value} (not found)` });
  // Leaving the typed ID (a commit, Escape or a plain blur) goes back to the list.
  const backToList = (refocus: boolean) => {
    setTyping(false);
    setProblem('');
    escaping.current = false;
    if (refocus) requestAnimationFrame(() => picker.current?.focus());
  };
  // Why a typed ID can't be used, or '' when it can. A link to a section on this page needs one; Top of page doesn't.
  const idProblem = (typed: string) => {
    const a = typed.trim().replace(/^#/, '');
    if (!a) return top ? '' : 'Enter a section ID, or press Esc to choose from the list.';
    if (!/^[A-Za-z]/.test(a)) return 'An ID has to start with a letter.';
    if (a.length > 61) return 'That ID is too long: use 61 characters or fewer.';
    return /^[A-Za-z][\w-]*$/.test(a) ? '' : 'That ID has a character an ID can’t use.';
  };
  if (typing)
    return (
      <span
        ref={box}
        className="insp-link-typing grow"
        // While the project is being left, a refused ID stays in its field, for Keep editing to return to.
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null) || isSettling()) return;
          const enter = byKey.current;
          byKey.current = false;
          if (escaping.current) return;
          // The text as it is left, a retry included: one that can't be used keeps the field open with its reason.
          const typed = box.current?.querySelector('input')?.value ?? '';
          const why = idProblem(typed);
          if (why && enter) {
            // Enter stays in the field to fix it, with the reason under it.
            setProblem(why);
            requestAnimationFrame(() => box.current?.querySelector('input')?.focus());
          } else if (why) {
            // A click or Tab elsewhere goes there: an ID that couldn't be used is dropped, and the reason said.
            if (typed.trim()) toast(`That section ID wasn’t used. ${why}`, 'error');
            backToList(false);
          } else backToList(enter);
        }}
        onKeyDownCapture={(e) => {
          if (isImeComposing(e)) return;
          byKey.current = e.key === 'Enter';
          escaping.current = e.key === 'Escape';
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !isImeComposing(e)) (e.stopPropagation(), backToList(true));
        }}
      >
        <DraftInput
          className="input sm"
          id={id}
          value={value}
          ariaLabel={label}
          aria-describedby={[problem ? problemId : '', hintId, describedBy ?? ''].filter(Boolean).join(' ')}
          aria-invalid={!!problem || undefined}
          placeholder={top ? 'Top of page, or a section ID' : 'A section ID, such as pricing'}
          autoFocus
          onLive={() => problem && setProblem('')}
          onCommit={(t) => {
            // An ID that can't be used is left in the field: the blur that follows says why and keeps it open.
            if (idProblem(t)) return;
            const a = t.trim().replace(/^#/, '');
            if (a !== value) onPick(a);
          }}
        />
        {problem && (
          <span className="field-error" id={problemId}>
            {problem}
          </span>
        )}
        <span className="field-hint" id={hintId}>
          Start with a letter, then use letters, numbers, hyphens or underscores. Esc goes back to the list.
        </span>
      </span>
    );
  return (
    <select
      ref={picker}
      id={id}
      className="select sm grow"
      value={value ? `#${value}` : ''}
      title={value ? options.find((o) => o.value === `#${value}`)?.text : undefined}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
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
 * A link's document: one from the library, or one imported here, which the link then goes to. An import that
 * finishes after the link moved on (another selection, an undo, another project) changes nothing.
 */
function DocumentPicker({ state, value, label, importFor, onPick, details, invalid, describedBy }: { state: ProjectState; value: string; label: string; importFor: string; onPick: (id: string) => void; details?: ReactNode; invalid?: boolean; describedBy?: string }) {
  const docs = libraryDocuments(state);
  const labels = documentLabels(docs);
  const [importing, setImporting] = useState(false);
  const turn = useRef(0);
  useEffect(() => () => void turn.current++, []);
  useEffect(() => void turn.current++, [value]);
  const chosen = value && Object.hasOwn(state.assets.assets, value) && isLibraryDocument(state.assets.assets[value]) ? state.assets.assets[value] : undefined;
  const importOne = async () => {
    if (importing) return;
    const mine = ++turn.current;
    const at = getState();
    const opening = at.snapshot?.workspaceKey;
    const selection = JSON.stringify(at.selection ?? null);
    setImporting(true);
    try {
      const r = await api.project.importAssets(undefined, 'document').catch((e: Error) => ({ ok: false, assetIds: [] as string[], message: `The document couldn’t be added: ${e.message}` }));
      if (r.message) toast(r.message, r.ok ? 'info' : 'error');
      const id = r.assetIds[0];
      // The new record reaches this window with the next snapshot, which may come after the reply.
      if (!id || !opening || !(await assetArrived(id, opening))) return;
      const now = getState();
      if (mine !== turn.current || now.snapshot?.workspaceKey !== opening || JSON.stringify(now.selection ?? null) !== selection) return;
      if (isLibraryDocument(now.snapshot?.state.assets.assets[id])) onPick(id);
    } finally {
      setImporting(false);
    }
  };
  return (
    <>
      <select
        className="select sm"
        value={chosen ? value : ''}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        title={chosen ? labels.get(chosen.id) : undefined}
        onChange={(e) => {
          if (!e.target.value) return;
          // A document chosen here wins over an import still on its way.
          turn.current++;
          onPick(e.target.value);
        }}
      >
        {!chosen && (
          <option value="" disabled>
            {value ? 'Missing document' : docs.length ? 'Choose a document…' : 'No documents yet'}
          </option>
        )}
        {docs.map((d) => (
          <option key={d.id} value={d.id}>
            {labels.get(d.id)}
          </option>
        ))}
      </select>
      {details}
      <button type="button" className="btn btn-sm insp-link-import" disabled={importing} aria-label={`Import a document for ${importFor}`} title="Import a document (PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV or ZIP)" onClick={() => void importOne()}>
        <FilePlus />
        {importing ? 'Importing…' : 'Import…'}
      </button>
    </>
  );
}

/**
 * A link's kind and destination. `everywhere` is for a link in a component's design, which shows on every page that
 * places it: it offers no section "on this page", since one page's section is not on the others.
 */
export function LinkEditor({ value, onChange, state, label, everywhere, invalid, describedBy }: { value: LinkValue; onChange: (v: LinkValue, edit?: PendingEdit) => void; state: ProjectState; label?: string; everywhere?: boolean; invalid?: boolean; describedBy?: string }) {
  const v = value ?? { type: 'none', target: '' };
  const sectionId = useId();
  const missingId = useId();
  // While a section ID is being typed, the note about the saved one waits: the typed one may replace it.
  const [typingSection, setTypingSection] = useState(false);
  const pendingId = useId();
  const currentPageId = useStore((s) => s.pageId);
  // A link in the shared header or footer shows on every page that shows that part.
  const shared = useStore((s) => (s.selection?.owner.kind === 'shell' && isShellPart(s.selection.owner.id) ? s.selection.owner.id : undefined));
  // A type that needs a destination before it is a valid link (an address, a number) waits here until one
  // is entered; a new value (an undo, another selection) ends the wait.
  const [pending, setPending] = useState<LinkValue['type'] | null>(null);
  // What is wrong with a destination typed for an address, email or phone link, shown beside the field, which
  // keeps the text, unsent, until it is corrected or discarded with Escape (the project would refuse it).
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();
  const valueKey = JSON.stringify(value ?? null);
  useEffect(() => setPending(null), [valueKey]);
  const type = pending ?? v.type;
  // Another kind of link is another field (keyed by type): what the last one kept goes with it.
  useEffect(() => setProblem(null), [type]);
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
  // Likewise the document it last went to.
  const lastDocument = useRef<string | null>(null);
  const linkedDocument = v.type === 'document' && Object.hasOwn(state.assets.assets, v.target) && isLibraryDocument(state.assets.assets[v.target]) ? state.assets.assets[v.target] : undefined;
  if (linkedDocument) lastDocument.current = v.target;
  const pickType = (t: LinkValue['type']) => {
    if (t === v.type) return setPending(null);
    if (t === 'none') onChange({ type: 'none', target: '' });
    else if (t === 'document' && lastDocument.current && Object.hasOwn(state.assets.assets, lastDocument.current) && isLibraryDocument(state.assets.assets[lastDocument.current])) onChange({ type: t, target: lastDocument.current });
    else if (t === 'page') {
      // Back to the page it pointed at before; else the page being edited, where a carried section lives; else Home.
      const page = lastPage.current && state.pages[lastPage.current] ? lastPage.current : anchor && currentPageId && state.pages[currentPageId] ? currentPageId : state.site.homePageId;
      onChange(withAnchor({ type: t, target: page, newTab: v.newTab }, anchor));
    }
    // A section carries over only when it is on this page; otherwise one is chosen first.
    else if (t === 'anchor' && anchor && currentPageId && (shared ? sharedPageIds(state, shared) : pageIds(state, currentPageId)).has(anchor)) onChange({ type: t, target: anchor });
    else setPending(t);
  };
  // A section the link jumps to that is no longer there: the picker keeps it, and says so under it.
  const sectionPage = type === 'anchor' ? currentPageId : type === 'page' ? v.target : null;
  const sectionValue = pending ? '' : type === 'anchor' && !everywhere ? target : type === 'page' ? (v.anchor ?? '') : '';
  const missing = !!sectionValue && !sectionOptions(state, sectionPage, type === 'anchor' ? shared : undefined).ids.has(sectionValue);
  // The same, for the saved link while another kind is being set up: what it does now is what the hint says.
  const savedSection = v.type === 'anchor' && !everywhere ? v.target : v.type === 'page' ? (v.anchor ?? '') : '';
  const savedSectionGone = !!savedSection && !sectionOptions(state, v.type === 'anchor' ? currentPageId : v.target, v.type === 'anchor' ? shared : undefined).ids.has(savedSection);
  const onPage = type === 'page' && state.pages[v.target] ? state.pages[v.target].title : null;
  const missingText = !missing || typingSection
    ? null
    : onPage
      ? `“#${sectionValue}” isn’t on ${onPage} any more, so the link opens the top of the page. Choose another section.`
      : shared
        ? `“#${sectionValue}” isn’t on every page with this ${shared}, so the link does nothing there. Choose another section.`
        : `“#${sectionValue}” isn’t on this page any more, so the link does nothing. Choose another section.`;
  return (
    <div className="insp-link">
      <select className="select sm" value={type} aria-label={named('Link type')} aria-invalid={invalid || undefined} aria-describedby={describedBy} onChange={(e) => pickType(e.target.value as LinkValue['type'])}>
        <option value="none">No link</option>
        <option value="page">Page</option>
        <option value="url">Web address</option>
        <option value="document">Document</option>
        <option value="email">Email</option>
        <option value="tel">Phone</option>
        {(!everywhere || type === 'anchor') && <option value="anchor">On this page</option>}
      </select>
      {/* The destination gets the panel's full width, so where the link goes can be read without opening it. */}
      {type === 'page' ? (
        <select className="select sm" value={v.target} title={state.pages[v.target] ? `${state.pages[v.target].title} (${state.pages[v.target].route})` : undefined} aria-label={named('Page')} onChange={(e) => onChange(withAnchor({ ...v, target: e.target.value }, e.target.value === v.target ? v.anchor : undefined))}>
          {state.site.pageOrder.map((id) => (
            <option key={id} value={id}>
              {state.pages[id].title} ({state.pages[id].route})
            </option>
          ))}
        </select>
      ) : type === 'document' ? (
        <DocumentPicker
          state={state}
          value={target}
          label={named('Document')}
          importFor={base && base.toLowerCase() !== 'link' ? base.toLowerCase() : 'this link'}
          invalid={!pending && !linkedDocument && !!v.target}
          describedBy={!pending && !linkedDocument && v.target ? missingId : pending && v.type !== 'none' ? pendingId : undefined}
          onPick={(id) => onChange({ type: 'document', target: id })}
          details={
            pending ? null : linkedDocument ? (
              <p className="insp-link-file">{documentDetails(linkedDocument)}. Visitors download it.</p>
            ) : v.target ? (
              <div className="field-error" id={missingId}>
                This document is no longer in Assets, so the link goes nowhere. Choose another, or import it again.
              </div>
            ) : null
          }
        />
      ) : type === 'anchor' && everywhere ? (
        // A design's section "on this page" is one every page placing it must have: shown, not re-picked here.
        <span className="insp-link-fixed">#{target}</span>
      ) : type === 'anchor' ? (
        <SectionPicker state={state} pageId={currentPageId} value={target} label={named('Section')} shared={shared} invalid={missing} describedBy={missing ? missingId : pending && v.type !== 'none' ? pendingId : undefined} onTyping={setTypingSection} onPick={(a, edit) => a && onChange({ type: 'anchor', target: a }, edit)} />
      ) : type !== 'none' ? (
        <DraftInput
          key={type}
          className="input sm"
          value={target}
          autoFocus={!!pending}
          aria-describedby={[problem ? problemId : '', pending && v.type !== 'none' ? pendingId : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined}
          aria-invalid={problem ? true : undefined}
          check={(t) => {
            const wrong = linkFieldProblem(type, t, state);
            return wrong ? { message: wrong } : null;
          }}
          onProblem={(p) => setProblem(p?.message ?? null)}
          ariaLabel={named(type === 'url' ? 'Web address' : type === 'email' ? 'Email address' : 'Phone number')}
          placeholder={type === 'url' ? 'https://example.com' : type === 'email' ? 'hello@example.com' : '+1 555 0100'}
          onCommit={(t) => {
            if (!t.trim()) return;
            onChange({ type, target: t.trim(), newTab: type === 'url' ? v.newTab : undefined });
          }}
        />
      ) : null}
      {/* A kind of link that still needs its destination: until it has one, the saved link is the one visitors get. */}
      {problem && (
        <div className="field-error" id={problemId} role="alert">
          {problem}
        </div>
      )}
      {pending && v.type !== 'none' && (
        <div className="field-hint" id={pendingId}>
          Until you choose where it goes, the link still {savedDestination(v, state, savedSectionGone)}.
        </div>
      )}
      {type === 'page' && (
        <div className="insp-link-row">
          <label className="insp-link-sub" htmlFor={sectionId}>
            Section
          </label>
          <SectionPicker state={state} pageId={v.target} value={v.anchor ?? ''} label={named('Section on the page')} top id={sectionId} invalid={missing} describedBy={missing ? missingId : undefined} onTyping={setTypingSection} onPick={(a, edit) => onChange(withAnchor(v, a || undefined), edit)} />
        </div>
      )}
      {missingText && (
        <div className="field-error" id={missingId}>
          {missingText}
        </div>
      )}
      {/* A new tab only means something for pages and web addresses; mail and phone links open their own apps. */}
      {!pending && (v.type === 'page' || v.type === 'url') && <SwitchRow checked={!!v.newTab} onChange={(n) => onChange({ ...v, newTab: n })} label="Open in a new tab" />}
    </div>
  );
}

/** Where a saved link takes visitors, as the end of "the link still …", for while another kind of link is being set up. */
function savedDestination(v: LinkValue, state: ProjectState, sectionGone: boolean): string {
  const page = v.type === 'page' && Object.hasOwn(state.pages, v.target) ? state.pages[v.target] : null;
  // A section by the name the picker gives it, when it has one.
  const section = (pageId: string | null | undefined, id: string) => sectionOptions(state, pageId, undefined).options.find((o) => o.value === `#${id}`)?.text ?? `#${id}`;
  if (page) return `goes to ${sectionGone || !v.anchor ? 'the top of ' : ''}${page.title}${v.anchor && !sectionGone ? `, ${section(page.id, v.anchor)}` : ''}`;
  if (v.type === 'document') return Object.hasOwn(state.assets.assets, v.target) && isLibraryDocument(state.assets.assets[v.target]) ? `downloads ${state.assets.assets[v.target].name}` : 'goes nowhere';
  if (v.type === 'email') return `emails ${v.target}`;
  if (v.type === 'tel') return `calls ${v.target}`;
  if (v.type === 'anchor') return sectionGone ? 'does nothing' : `goes to #${v.target}`;
  if (v.type === 'url' && v.target) return `goes to ${v.target}`;
  return 'goes nowhere';
}

/** The value for a newly chosen image, from the one it replaces: its suggested description, else the old one,
 *  which is then `carried` (flagged until it is checked), and whether it is decorative. */
function chosen(from: ImageValue, assetId: string, suggestion?: string): { value: ImageValue; carried: boolean } {
  const cur = from ?? { assetId: null, alt: '' };
  // A description kept with no image (after Remove) was still written for another picture.
  return { value: { assetId, alt: suggestion || cur.alt || '', decorative: cur.decorative }, carried: !suggestion && !!cur.alt };
}

/** Scrolls a picker grid (only the grid, never the Inspector around it) so its chosen tile is in view. */
function revealInGrid(grid: HTMLElement | null) {
  const tile = grid?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!grid || !tile) return;
  const g = grid.getBoundingClientRect();
  const r = tile.getBoundingClientRect();
  if (r.bottom > g.bottom) grid.scrollTop += r.bottom - g.bottom + 4;
  else if (r.top < g.top) grid.scrollTop -= g.top - r.top + 4;
}

/**
 * A site-level image that carries no description: the browser tab icon (shown square) or the picture shown when
 * the site is shared (shown at the 1.91:1 shape link previews crop it to).
 */
export type PlainImage = 'favicon' | 'social';

/** The picker for a site image: the image editor's thumbnail, search, import and keyboard grid, with None as Remove. */
export function SiteImageField({ value, onChange, state, title, plain }: { value: string | null | undefined; onChange: (assetId: string | null) => void; state: ProjectState; title: string; plain: PlainImage }) {
  return <ImageEditor value={{ assetId: value ?? null, alt: '' }} onChange={(v) => onChange(v.assetId ?? null)} state={state} title={title} plain={plain} />;
}

/** Images whose description was kept from the picture they replaced and not yet checked, by image and description:
 *  the flag outlives the editor (a list item closed and opened again) until the description is checked or changed. */
const carriedDescriptions = new Set<string>();
const carryKey = (x: ImageValue | null | undefined, project: string | undefined) => (x?.assetId ? `${project ?? ''}\u0000${x.assetId}\u0000${x.alt}` : '');

/**
 * Image editor: one card holding the picture, its description and whether it is decorative. `title` puts the
 * field's name inside the card (like the other field groups); a standalone image passes none. `picture` makes it a
 * picture and nothing else, with no description to write and never decorative (a page's sharing image; see
 * PictureStandIn).
 */
export function ImageEditor({ value, onChange, state, title, plain, picture }: { value: ImageValue; onChange: (v: ImageValue) => void; state: ProjectState; title?: string; plain?: PlainImage; picture?: PictureStandIn }) {
  const runtime = useStore((s) => s.runtime);
  // The project as this editor shows it: an import checks its placement against it.
  const snapshot = useStore((s) => s.snapshot);
  const altId = useId();
  const titleId = useId();
  // Where this image sits in the project, so a description refused for being too long waits for it there.
  const home = useFieldHome();
  const v = value ?? { assetId: null, alt: '' };
  // A picture-only field (a sharing image) shows only what the library has as an image: a saved ID that names a
  // document or font, or is no record at all, is the same as an image that is gone.
  const named = v.assetId && Object.hasOwn(state.assets.assets, v.assetId) ? state.assets.assets[v.assetId] : null;
  const asset = picture ? (named?.kind === 'image' ? named : null) : v.assetId ? state.assets.assets[v.assetId] : null;
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  // The value as it is now, for work that finishes later (an import).
  const latest = useRef(v);
  latest.current = v;
  // A description carried over from the previous image may no longer be true; say so until it is checked or edited.
  const [, redraw] = useState(0);
  const project = snapshot?.workspaceKey;
  const carried = carriedDescriptions.has(carryKey(v, project));
  // Said once when a pick keeps the old description, since the note appears away from where focus goes.
  const [carriedSaid, setCarriedSaid] = useState({ text: '', count: 0 });
  const setCarried = (on: boolean, of: ImageValue = latest.current) => {
    // A site image carries no description, and must never clear the flag another field has for the same picture.
    if (plain) return;
    const k = carryKey(of, project);
    if (on && !of.decorative && !carriedDescriptions.has(k)) setCarriedSaid((s) => announcementText('The description was kept from the previous image. Check it still describes this one.', s.count) ?? s);
    if (!k) return;
    if (on) carriedDescriptions.add(k);
    else carriedDescriptions.delete(k);
    redraw((n) => n + 1);
  };
  const pick = (id: string, suggestion?: string) => {
    const cur = latest.current;
    if (id === cur.assetId) return;
    // A picture with no description to carry over: only the choice is written.
    if (picture) return onChange({ assetId: id, alt: '' });
    const next = chosen(cur, id, suggestion);
    setCarried(next.carried, next.value);
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
  // In the order Assets lists them, and changing the order here changes it there.
  const assetSort = useStore((s) => s.assetSort);
  const library = state.assets.assets;
  const images = useMemo(() => sortAssets(Object.values(library).filter((a) => a.kind === 'image'), assetSort), [library, assetSort]);
  const labels = useMemo(() => assetLabels(images), [images]);
  const series = useAssetSeries(images, snapshot?.workspaceKey);
  const needle = q.trim().toLowerCase();
  const shown = images.filter((a) => (!series.key || inSeries(a, series.key)) && (!needle || `${a.name} ${a.description ?? ''} ${a.altSuggestion ?? ''}`.toLowerCase().includes(needle)));
  // The grid's one tab stop: the tile last moved to while it is still shown, else the image chosen, else the first.
  const [rover, setRover] = useState<string | null>(null);
  const tabStop = shown.some((a) => a.id === rover) ? rover : shown.some((a) => a.id === v.assetId) ? v.assetId : (shown[0]?.id ?? null);
  const noMatch = q.trim() ? `No images ${series.key ? `in ${series.label} ` : ''}match “${q.trim()}”.` : `No images in ${series.label} yet.`;
  // The browser opens on the image chosen, scrolled into view when it is further down.
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (browsing) requestAnimationFrame(() => revealInGrid(grid.current));
  }, [browsing]);
  const closeBrowser = (focus = true) => {
    setBrowsing(false);
    setQ('');
    setRover(null);
    series.choose('');
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
    let carry: { on: boolean; value: ImageValue } | null = null;
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
          if (picture) return write({ assetId: a.id, alt: '' });
          const next = chosen(start, a.id, a.altSuggestion);
          carry = { on: next.carried, value: next.value };
          write(next.value);
          if (next.carried && !start.decorative) return 'Check its description still fits.';
        }
      });
      if (r.kind !== 'placed' || !alive.current) return;
      const placed = carry as { on: boolean; value: ImageValue } | null;
      if (placed) setCarried(placed.on, placed.value);
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
  // Until there is an image (or something already set about it), the chooser is the only thing to do.
  const details = !plain && !picture && (!!asset || !!v.alt || !!v.decorative);
  // An image the field still names but Assets no longer has: said, and removable, rather than shown as empty.
  const gone = !!v.assetId && !asset;
  // The image a picture with none of its own stands for, while the library still has it.
  const fallback = picture && !v.assetId && picture.inherited && Object.hasOwn(library, picture.inherited) && library[picture.inherited].kind === 'image' ? library[picture.inherited] : null;
  const shownAsset = asset ?? fallback;
  // Remove takes its own button away: focus that was on it goes to the chooser once the image is gone.
  const removedAt = useRef(0);
  useEffect(() => {
    if (asset || v.assetId || !removedAt.current) return;
    const recent = Date.now() - removedAt.current < MOVE_PENDING_MS;
    removedAt.current = 0;
    const at = document.activeElement;
    if (recent && (!at || at === document.body)) chooseBtn.current?.focus();
  }, [asset, v.assetId]);
  return (
    <div
      className={`insp-image${over ? ' drop-over' : ''}${plain ? ` plain-${plain}` : ''}`}
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
      <span className="sr-only" role="status">
        {carriedSaid.text}
      </span>
      <div className="insp-image-top">
        <div className={`insp-image-thumb${shownAsset ? '' : ' empty'}`} data-testid={plain ? `${plain}-preview` : undefined}>{shownAsset && devUrl ? <AssetImage key={missingKey(snapshot, shownAsset.id)} asset={shownAsset} devUrl={devUrl} cover={!fitFor(shownAsset).contain} className={fitFor(shownAsset).contain ? 'contain' : undefined} alt="" /> : gone ? <ImageOff aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}</div>
        <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
          <span className={`insp-image-name${shownAsset ? '' : gone ? ' gone' : ' none'}`} id={`${titleId}-now`} title={shownAsset?.name}>
            {shownAsset ? (labels.get(shownAsset.id)?.label ?? shownAsset.name) : over ? 'Drop to use this image' : gone ? (named ? 'This file is not an image' : 'This image is no longer in Assets') : (picture?.none ?? (plain ? 'None' : 'No image chosen'))}
          </span>
          {/* Whose image this is, when it is not the field's own. */}
          {fallback && !over && <span className="faint insp-note">{picture!.from}</span>}
          <span className="row" style={{ gap: 4, flexWrap: picture ? 'wrap' : undefined }}>
            <button ref={chooseBtn} className="btn btn-sm" aria-describedby={gone || plain ? `${titleId}-now` : undefined} aria-expanded={browsing} aria-controls={browsing ? browseId : undefined} onClick={() => (browsing ? closeBrowser(false) : setBrowsing(true))} disabled={importing}>
              <ImagePlus />
              {importing ? 'Adding…' : asset || gone ? 'Change…' : 'Choose image…'}
            </button>
            {(asset || gone) && (
              <button
                className={`btn btn-sm${picture?.inherited ? '' : ' insp-image-remove'}`}
                aria-label={picture ? picture.back : `Remove ${title ? title.toLowerCase() : 'image'}`}
                onClick={() => {
                  if (!picture) setCarried(false);
                  removedAt.current = Date.now();
                  onChange({ assetId: null, alt: v.alt, decorative: v.decorative });
                }}
              >
                {picture ? picture.back : 'Remove'}
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
            {/* Kept while a search is typed, so it can always be cleared. */}
            {(images.length > 6 || !!q) && <input type="search" className="input sm grow" placeholder="Search images" aria-label="Search images" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />}
            <button className="btn btn-sm" onClick={() => void importAndPick()} disabled={importing} autoFocus={images.length <= 6}>
              <Plus /> Import…
            </button>
          </div>
          {/* Kept while a series is chosen, so it can always be cleared. */}
          {(images.length > 6 || !!series.key) && <AssetOrderControls series={series.list} value={series.key} onSeries={series.choose} />}
          {shown.length > 0 ? (
            <div ref={grid} className="insp-pick-grid" role="listbox" aria-label="Your images" onKeyDown={(e) => pickGridKeys(e, (to) => setRover(shown[to]?.id ?? null))}>
              {shown.map((a) => (
                <button
                  key={a.id}
                  role="option"
                  aria-selected={a.id === v.assetId}
                  tabIndex={a.id === tabStop ? 0 : -1}
                  className={`insp-pick-tile${a.id === v.assetId ? ' current' : ''}`}
                  title={labels.get(a.id)?.label}
                  onClick={() => {
                    pick(a.id, a.altSuggestion);
                    closeBrowser();
                  }}
                >
                  {devUrl ? <AssetImage key={missingKey(snapshot, a.id)} asset={a} devUrl={devUrl} cover={!fitFor(a).contain} className={fitFor(a).contain ? 'contain' : undefined} alt="" loading="lazy" /> : <ImageOff aria-hidden="true" />}
                  <span className="ellipsis">{labels.get(a.id)?.name}</span>
                  {/* Another image has this name: its ID, on a line of its own, tells them apart. */}
                  {labels.get(a.id)?.label !== labels.get(a.id)?.name && <span className="ellipsis insp-pick-id">{a.id}</span>}
                </button>
              ))}
            </div>
          ) : (
            <p className="faint insp-note">{images.length ? noMatch : 'No images yet. Import one, or drop an image file here.'}</p>
          )}
          {/* Mounted with the browser, so the first time a search finds nothing it is announced. */}
          <span className="sr-only" role="status">
            {shown.length || !images.length ? '' : noMatch}
          </span>
          {images.length > 0 && <p className="faint insp-note">You can also drop an image file here.</p>}
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
            limit={TEXT_LIMITS.imageAlt}
            keep={home ? `${home.key}|alt` : undefined}
            keepWhile={home?.alive}
            onCommit={(alt) => (setCarried(false), onChange({ ...v, alt }))}
          />
          {carried ? (
            // The problem and its one repair read as one note; a description that still fits is confirmed as it stands.
            <div className="insp-check-note">
              <span className="field-hint insp-check" id={`${altId}-h`}>
                <TriangleAlert aria-hidden="true" />
                Kept from the previous image. Check it still describes this one.
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setCarried(false);
                  requestAnimationFrame(() => document.getElementById(altId)?.focus());
                }}
              >
                It still fits
              </button>
            </div>
          ) : (
            <span className="field-hint" id={`${altId}-h`}>
              For screen readers, and shown if the image can’t load.
            </span>
          )}
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
  // The grid's one tab stop: the tile last moved to while it is still shown, else the chosen icon, else the first.
  const [rover, setRover] = useState<string | null>(null);
  // The icon named under the grid: the one pointed at or moved to, else the chosen one.
  const [peek, setPeek] = useState<string | null>(null);
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
    setRover(null);
    setPeek(null);
    if (focus) requestAnimationFrame(() => btn.current?.focus());
  };
  useEffect(() => {
    if (open) requestAnimationFrame(() => revealInGrid(grid.current));
  }, [open]);
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
    const i = tiles.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    // Up and down stay in their column: at the top or bottom row they stay put.
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? tiles.length - 1 : step !== undefined ? (vertical && (i + step < 0 || i + step >= tiles.length) ? i : Math.max(0, Math.min(tiles.length - 1, i + step))) : -1;
    if (to < 0) return;
    e.preventDefault();
    setRover(shown[to] ?? null);
    tiles[to].focus();
  };
  const tabStop = rover && shown.includes(rover) ? rover : shown.includes(value) ? value : shown[0];
  const named = peek && shown.includes(peek) ? peek : shown.includes(value) ? value : (tabStop ?? null);
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
            <div
              ref={grid}
              className="insp-icon-grid"
              role="listbox"
              aria-label={label}
              onKeyDown={keys}
              onMouseLeave={() => setPeek(null)}
              onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setPeek(null)}
            >
              {shown.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="option"
                  aria-selected={k === value}
                  aria-label={iconName(k)}
                  title={iconName(k)}
                  tabIndex={k === tabStop ? 0 : -1}
                  className={`insp-icon-tile${k === value ? ' current' : ''}`}
                  onFocus={() => setPeek(k)}
                  onMouseEnter={() => setPeek(k)}
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
          {/* Mounted with the picker, so the first time a search finds nothing it is announced. */}
          <span className="sr-only" role="status">
            {shown.length ? '' : `No icons match “${q.trim()}”.`}
          </span>
          {/* Names the icon pointed at or moved to; each tile already names itself to assistive tech. */}
          {named && (
            <p className="insp-icon-name" aria-hidden="true">
              {iconName(named)}
              {named === value && <span className="faint"> · current</span>}
            </p>
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
export function ScalarEditor({ schema, value, onChange, state, label, id, describedBy, invalid, onLive, placeholder, everywhere }: { schema: ScalarPropSchema; value: unknown; onChange: (v: unknown, edit?: PendingEdit) => unknown; state: ProjectState; label?: string; id?: string; describedBy?: string; invalid?: boolean; onLive?: (text: string) => void; placeholder?: string; everywhere?: boolean }) {
  const name = id ? undefined : (label ?? schema.label);
  const wired = { id, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined };
  switch (schema.type) {
    case 'string':
      return <DraftInput {...wired} multiline={schema.multiline} rows={2} value={String(value ?? '')} onCommit={onChange} onLive={onLive} ariaLabel={name} placeholder={placeholder} />;
    case 'richtext':
      return (
        <RichTextField
          id={id}
          describedBy={describedBy}
          invalid={invalid}
          value={richTextToMarkdown(toRichText(value, schema.plainAs), state.pages, schema.plainAs)}
          onCommit={onChange}
          pages={state.pages}
          plainAs={schema.plainAs}
          ariaLabel={name}
          placeholder={'One paragraph per line; end a line with \\ to break it inside the paragraph. Use **bold**, *italic*, [a link](/about/), "- " for lists and "### " for headings.'}
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
      return <LinkEditor value={value as LinkValue} onChange={onChange} state={state} label={label ?? schema.label} everywhere={everywhere} />;
    case 'image':
      return <ImageEditor value={value as ImageValue} onChange={onChange} state={state} title={label ?? schema.label} />;
    case 'icon':
      return <IconPicker id={id} describedBy={describedBy} value={String(value ?? schema.default)} onChange={onChange} label={label ?? schema.label} />;
    case 'choices':
      return <ChoicesEditor schema={schema} value={value} onChange={onChange} label={label} />;
    case 'token': {
      // The site's tokens of the property's group, by name. One a theme switch took away stays shown until changed.
      const ref = value && typeof value === 'object' ? (value as { token?: unknown }).token : undefined;
      const current = typeof ref === 'string' ? ref : schema.default.token;
      const tokens = declaredTokens(state).filter((t) => t.group === schema.tokenGroup);
      return (
        <select className="select" {...wired} value={current} onChange={(e) => onChange({ token: e.target.value })} aria-label={name}>
          {!tokens.some((t) => t.id === current) && <option value={current}>Missing style: {current}</option>}
          {tokens.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      );
    }
  }
}

const isChoiceRow = (o: unknown): o is ChoiceOption => !!o && typeof o === 'object' && typeof (o as ChoiceOption).id === 'string' && typeof (o as ChoiceOption).label === 'string';
const choiceRows = (value: unknown) => (Array.isArray(value) ? value : []).filter(isChoiceRow);

/**
 * A choice's label, edited as a draft: committed on Enter or on leaving it, put back on Escape. A rename says the
 * label it was typed over, so one changed meanwhile (by the AI, or in the file outside the app) is not overwritten.
 * A refused label is not lost either: it stays in the field, unsaved, until the author presses Enter to use it
 * anyway or Escape to keep what the project holds.
 */
/** How a choice change ended: saved, refused, or refused because the choice was renamed meanwhile (to `changedTo`). */
type ChoiceDone = boolean | { changedTo: string };

function ChoiceLabel({ choice, index, describedBy, onRename, clash, onClash }: { choice: ChoiceOption; index: number; describedBy?: string; onRename: (label: string, from: string[]) => Promise<ChoiceDone>; clash?: (label: string) => boolean; onClash?: (label: string | null) => void }) {
  const [draft, setDraft] = useState(choice.label);
  const saved = useRef(choice.label);
  saved.current = choice.label;
  // The label most recently committed here, until the project has it: typing again starts from it.
  const sent = useRef<string | null>(null);
  // From the first keystroke until the commit: the label shown when the author started typing over it, and every label
  // the choice may have when the rename lands without anyone else touching it (the saved one, or one sent from here).
  const from = useRef<{ shown: string; labels: string[] } | null>(null);
  // Follows the project until the author types, so typing always starts from what the project holds.
  useEffect(() => {
    if (from.current === null) setDraft(choice.label);
  }, [choice.label]);
  // A label kept after its rename was refused because the choice changed meanwhile: an unsaved draft, which only
  // Enter (or typing again) commits, and Escape gives up.
  const kept = useRef(false);
  const attempts = useRef(0);
  const draftKey = useId();
  const mounted = useRef(true);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The field closes (its question was collapsed or removed) with a label typed in it that was not saved: the label
  // is offered once more, to copy.
  const offer = (text: string, other?: string) =>
    toast(`Your label “${text}” for this choice was not saved${other !== undefined ? `, because the choice became “${other}” while you were typing` : ''}.`, 'error', {
      label: 'Copy text',
      run: () => void navigator.clipboard?.writeText(text).catch(() => undefined)
    });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const over = from.current;
      const text = choiceText(draftRef.current);
      if (over && text && text !== over.shown) offer(text, kept.current ? over.shown : undefined);
      markDraft(draftKey, false);
    };
  }, [draftKey]);
  const keep = (on: boolean) => {
    kept.current = on;
    markDraft(draftKey, on);
  };
  const commit = (explicit: boolean) => {
    const over = from.current;
    if (over === null || (kept.current && !explicit)) return;
    from.current = null;
    keep(false);
    const text = choiceText(draft);
    // An emptied label puts the saved one back: a choice is removed with its own button.
    if (!text || text === over.shown) return setDraft(sent.current ?? saved.current);
    // Another choice already has this label: the row keeps its own, and says why under it.
    if (clash?.(text)) {
      onClash?.(text);
      return setDraft(sent.current ?? saved.current);
    }
    onClash?.(null);
    sent.current = text;
    const attempt = ++attempts.current;
    void onRename(text, over.labels).then((done) => {
      if (sent.current === text) sent.current = null;
      // A newer label was sent from here since: this one was given up for it.
      if (done !== true && attempt !== attempts.current) return;
      if (done === true) {
        // Landed: a label typed since can no longer have been typed over the one this replaced.
        if (from.current && from.current.labels.length > 1) from.current = { shown: from.current.shown, labels: from.current.labels.filter((l) => !over.labels.includes(l) || l === text) };
        return;
      }
      if (from.current !== null) return;
      // Refused (the choice was renamed somewhere else while this was typed, say): the label stays here, unsaved,
      // beside whatever the project holds, or is offered to copy once the field has closed. The field may already
      // have followed the project to the newer label: the typed one is put back.
      const now = done === false ? saved.current : done.changedTo;
      if (!mounted.current) return offer(text, done === false ? undefined : now);
      from.current = { shown: now, labels: [now] };
      setDraft(text);
      keep(true);
    });
  };
  return (
    <input
      className="input sm"
      value={draft}
      aria-label={`Choice ${index + 1}`}
      aria-describedby={describedBy}
      title={kept.current ? 'Not saved. Press Enter to save it, or Escape to keep the label the project has.' : undefined}
      data-choice-focus={`input-${choice.id}`}
      onChange={(e) => {
        onClash?.(null);
        from.current ??= { shown: sent.current ?? saved.current, labels: sent.current === null ? [saved.current] : [saved.current, sent.current] };
        // Typing again after a refusal is editing again: leaving the field commits, as it always does.
        if (kept.current) keep(false);
        setDraft(e.target.value);
      }}
      onBlur={() => commit(false)}
      onKeyDown={(e) => {
        if (isImeComposing(e)) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(true);
        } else if (e.key === 'Escape' && from.current !== null) {
          e.preventDefault();
          from.current = null;
          keep(false);
          setDraft(sent.current ?? saved.current);
        }
      }}
    />
  );
}

/**
 * The answers to a single-choice question: each one's label, what it is sent as, its place and a way to remove it,
 * then a box to add the next. Each change names its choice by id and waits for the one before it to land, then
 * applies to the set as the project holds it at that moment (`read`), on that revision (lib/choices). So a change
 * made right after another, such as a move just after a rename, never undoes it; one the project refuses never takes
 * the next with it; one built before something else changed the project (Undo, the AI) is refused, not replayed over
 * it; and changes still waiting when the question is closed are still made. While the AI is working every change is
 * refused, as moving a list item is.
 */
function ChoicesEditor({ schema, value, onChange, read, label }: { schema: ChoicesProp; value: unknown; onChange: (v: unknown, edit?: PendingEdit) => unknown; read?: () => ReadValue | undefined; label?: string }) {
  const choices = choiceRows(value);
  const labelId = useId();
  const hintId = useId();
  const addId = useId();
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  // A rename refused because another choice has that label: which row, and the label it was refused.
  const [clashAt, setClashAt] = useState<{ id: string; label: string } | null>(null);
  // A duplicate the author was told about stops being one once the other choice is renamed or removed.
  const labelsKey = choices.map((c) => c.label).join('\u0000');
  useEffect(() => {
    setProblem('');
    setClashAt(null);
  }, [labelsKey]);
  const rootRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(choices);
  shownRef.current = choices;
  const queue = useRef<Array<{ action: ChoiceAction; done: (ok: ChoiceDone) => void }>>([]);
  const busy = useRef(false);
  const refocus = useRef<{ target: string; fallback: string } | null>(null);
  const pump = () => {
    while (!busy.current && queue.current.length) {
      // Read once every save on its way has landed (the question's label, say), so the set and revision are current.
      if (read && savesInFlight()) {
        setTimeout(pump, 25);
        return;
      }
      const { action, done } = queue.current.shift()!;
      // The project's new state reaches the store before its reply, so this is the set the last change made.
      const now = read?.();
      const saved = now ? choiceRows(now.value) : shownRef.current;
      const stale = staleRename(saved, action);
      if (stale && action.kind === 'rename')
        toast(`That choice became “${stale.label}” while you were typing, so it was not renamed to “${action.label}”. Your label is still in the field: press Enter to use it, or Escape to keep “${stale.label}”.`, 'error');
      const next = applyChoiceAction(saved, action);
      if (!next) {
        done(stale && action.kind === 'rename' ? { changedTo: stale.label } : false);
        continue;
      }
      busy.current = true;
      void Promise.resolve(onChange(next, now ? { operations: [], expectedRevision: now.revision } : undefined))
        .then(
          (r) => r !== null,
          () => false
        )
        .then((ok) => {
          busy.current = false;
          // Refused because the project moved on as it was written: a rename whose choice was renamed meanwhile says so.
          const late = !ok && action.kind === 'rename' && read ? staleRename(choiceRows(read()?.value), action) : undefined;
          done(late ? { changedTo: late.label } : ok);
          pump();
        });
    }
  };
  const act = (action: ChoiceAction) =>
    new Promise<ChoiceDone>((done) => {
      queue.current.push({ action, done });
      pump();
    });
  const ids = choices.map((c) => c.id).join(',');
  useEffect(() => {
    const to = refocus.current;
    if (!to) return;
    refocus.current = null;
    // Only where focus was lost with the change (a moved or removed row), never away from where the author went.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const find = (key: string) => rootRef.current?.querySelector<HTMLElement>(`[data-choice-focus="${CSS.escape(key)}"]`);
    const target = find(to.target);
    (target && !(target as HTMLButtonElement).disabled ? target : find(to.fallback))?.focus();
  }, [ids]);
  const shown = label ?? schema.label;
  const full = choices.length >= MAX_CHOICE_ROWS;
  const add = () => {
    const text = choiceText(draft);
    if (!text || full) return;
    if (choices.some((c) => sameChoice(c.label, text))) {
      setProblem(`“${text}” is already a choice.`);
      // Add goes disabled with the problem: focus goes to the box that fixes it.
      requestAnimationFrame(() => document.getElementById(addId)?.focus());
      return;
    }
    setProblem('');
    setDraft('');
    // A refused choice comes back to the box, unless something else has been typed there since.
    void act({ kind: 'add', label: text }).then((ok) => {
      if (!ok) setDraft((d) => d || text);
    });
  };
  // A move is announced once it lands, as a list item's is.
  const [said, setSaid] = useState({ text: '', count: 0 });
  const move = (c: ChoiceOption, by: -1 | 1) => {
    const direction = by < 0 ? 'up' : 'down';
    refocus.current = { target: `${direction}-${c.id}`, fallback: `input-${c.id}` };
    void act({ kind: 'move', id: c.id, by }).then((ok) => {
      if (!ok) return;
      // Where it landed, in the order the project now holds (a queued change may have moved others first).
      const now = read?.();
      const order = now ? choiceRows(now.value) : shownRef.current;
      const at = order.findIndex((x) => x.id === c.id);
      if (at >= 0) setSaid((s) => announcementText(moveAnnouncement(`“${c.label}”`, at, order.length), s.count) ?? s);
    });
  };
  const remove = (c: ChoiceOption, i: number) => {
    const after = choices[i + 1] ?? choices[i - 1];
    refocus.current = { target: after ? `input-${after.id}` : 'add', fallback: 'add' };
    void act({ kind: 'remove', id: c.id });
  };
  return (
    <div className="field choices-editor" role="group" aria-labelledby={labelId} aria-describedby={schema.description ? hintId : undefined} ref={rootRef}>
      <div className="field-label" id={labelId}>
        <span className="grow">{shown}</span>
        <span className="insp-count">
          <span aria-hidden="true">{countText(choices.length, MAX_CHOICE_ROWS)}</span>
          <span className="sr-only">{`${choices.length} of at most ${MAX_CHOICE_ROWS} choices`}</span>
        </span>
      </div>
      {choices.length > 0 ? (
        <ol className="choices-list">
          {choices.map((c, i) => {
            const name = `“${c.label}”`;
            return (
              <li key={c.id} className="choices-row">
                <div className="choices-row-controls">
                  <ChoiceLabel
                    choice={c}
                    index={i}
                    describedBy={[clashAt?.id === c.id ? `${hintId}-clash` : '', c.value !== c.label ? `${hintId}-${i}` : ''].filter(Boolean).join(' ') || undefined}
                    clash={(text) => choices.some((o) => o.id !== c.id && sameChoice(o.label, text))}
                    onClash={(text) => setClashAt(text ? { id: c.id, label: text } : null)}
                    onRename={(text, from) => act({ kind: 'rename', id: c.id, label: text, from })}
                  />
                  <button type="button" className="icon-btn sm" aria-label={`Move ${name} up`} data-choice-focus={`up-${c.id}`} disabled={i === 0} onClick={() => move(c, -1)}>
                    <ArrowUp />
                  </button>
                  <button type="button" className="icon-btn sm" aria-label={`Move ${name} down`} data-choice-focus={`down-${c.id}`} disabled={i === choices.length - 1} onClick={() => move(c, 1)}>
                    <ArrowDown />
                  </button>
                  <button type="button" className="icon-btn sm list-editor-remove" aria-label={`Remove ${name}`} onClick={() => remove(c, i)}>
                    <Trash2 />
                  </button>
                </div>
                {clashAt?.id === c.id && (
                  <div className="field-error" id={`${hintId}-clash`} role="alert">
                    “{clashAt.label}” is already a choice, so this one keeps its name.
                  </div>
                )}
                {/* Renaming keeps what the choice is sent as, so answers to it stay together. */}
                {c.value !== c.label && (
                  <div className="field-hint" id={`${hintId}-${i}`}>
                    Sent as “{c.value}”
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="field-hint insp-note">No choices yet.</p>
      )}
      <div className="choices-add">
        <input
          className="input sm"
          id={addId}
          data-choice-focus="add"
          value={draft}
          placeholder={full ? `At most ${MAX_CHOICE_ROWS} choices` : 'Add a choice'}
          aria-label="New choice"
          aria-invalid={problem ? true : undefined}
          readOnly={full}
          aria-describedby={problem ? `${addId}-problem` : full ? `${addId}-full` : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem('');
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || isImeComposing(e)) return;
            e.preventDefault();
            add();
          }}
        />
        <button type="button" className="btn btn-sm" onClick={add} disabled={full || !draft.trim() || !!problem}>
          <Plus /> Add
        </button>
      </div>
      {problem && (
        <div className="field-error" id={`${addId}-problem`} role="alert">
          {problem}
        </div>
      )}
      {full && <p className="field-hint insp-note" id={`${addId}-full`}>This question has the most choices it can hold, {MAX_CHOICE_ROWS}. Remove one to add another.</p>}
      {schema.description && (
        <div className="field-hint" id={hintId}>
          {schema.description}
        </div>
      )}
      <span className="sr-only" role="status">
        {said.text}
      </span>
    </div>
  );
}

/** A value as the project holds it now, and the revision it was read at. */
export interface ReadValue {
  value: unknown;
  revision: number;
}


/** One field of one list item, from a list read as the project holds it now. */
function readItemField(list: ReadValue | undefined, itemId: string, field: string): ReadValue | undefined {
  const item = list && Array.isArray(list.value) ? (list.value as ListItem[]).find((x) => x?.id === itemId) : undefined;
  return item && list ? { value: item[field], revision: list.revision } : undefined;
}

/** A one-click fix offered under a field's problem, such as hiding a button that has no link. */
export interface FieldAction {
  label: string;
  run: () => void;
}

/**
 * One scalar field with its visible label wired to its control. Booleans sit on one line; images are their own
 * titled card. `hint` replaces the schema's description and `error` replaces both, for text and link fields; a
 * link can also offer an `action` that fixes its problem. `everywhere` is for a value in a component's design,
 * which shows on every page that places it (see LinkEditor).
 */
export function ScalarField({ schema, value, onChange, read, state, label, hint, error, action, onLive, placeholder, everywhere, notedBy }: { schema: ScalarPropSchema; value: unknown; onChange: (v: unknown, edit?: PendingEdit) => unknown; read?: () => ReadValue | undefined; state: ProjectState; label?: string; hint?: ReactNode; error?: string; action?: FieldAction; onLive?: (text: string) => void; placeholder?: string; everywhere?: boolean; notedBy?: string }) {
  const id = useId();
  const shown = label ?? schema.label;
  const note = hint ?? schema.description;
  // A set of choices names itself and says what it is under its own rows.
  if (schema.type === 'choices') return <ChoicesEditor schema={schema} value={value} onChange={onChange} read={read} label={shown} />;
  if (schema.type === 'boolean') return <SwitchRow checked={!!value} onChange={onChange} label={shown} hint={schema.description} />;
  if (schema.type === 'image')
    return hint ? (
      <div className="col" style={{ gap: 4 }}>
        <ImageEditor value={value as ImageValue} onChange={onChange} state={state} title={shown} />
        <div className="field-hint">{hint}</div>
      </div>
    ) : (
      <ImageEditor value={value as ImageValue} onChange={onChange} state={state} title={shown} />
    );
  // A link is two controls (kind and destination) that name themselves; the label names the pair.
  if (schema.type === 'link')
    return (
      <div className="field" role="group" aria-labelledby={`${id}-l`} aria-describedby={error || note ? `${id}-note` : undefined}>
        <div className="field-label" id={`${id}-l`}>
          {shown}
        </div>
        <LinkEditor value={value as LinkValue} onChange={onChange} state={state} label={schema.label} everywhere={everywhere} invalid={!!error} describedBy={[error ? `${id}-note` : '', notedBy ?? ''].filter(Boolean).join(' ') || undefined} />
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
      <ScalarEditor schema={schema} value={value} onChange={onChange} state={state} id={id} describedBy={note || error ? `${id}-note` : undefined} invalid={!!error} onLive={onLive} placeholder={placeholder} everywhere={everywhere} />
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

/**
 * An edit to a list: `repair` is an explicit fix the inspector offers, its own undo step under `label`. `pick` adds
 * library images in order and takes away the sample rows in `replace` (those the author was shown), as one undo step;
 * it resolves to the rows it added and how many it replaced, or null when nothing changed.
 */
export type ListOp =
  | { kind: 'insert'; item?: Record<string, unknown> }
  | { kind: 'pick'; assetIds: string[]; replace: string[] }
  | { kind: 'remove'; itemId: string }
  | { kind: 'move'; itemId: string; index: number }
  | { kind: 'field'; itemId: string; field: string; value: unknown; edit?: PendingEdit }
  | { kind: 'repair'; itemId: string; field: string; value: unknown; label: string; revision?: number };

/** A request to open one list item, named by `seq` so the same item can be opened again. */
export interface ListReveal {
  seq: number;
  itemId: string;
}

/** Item fields that are one link's visible text and its destination (see itemLinkPairs). */
export type LinkPairs = ReadonlyArray<{ text: string; link: string }>;

export function PropField({ name, schema, value, onChange, onField, onList, onTable, read, alive, itemAlive, state, focusItem, openItem, label, hint, annotate, hiddenFields, linkPairs, error, action, place, everywhere, pickImages }: {
  name: string;
  schema: PropSchema;
  value: unknown;
  onChange: (v: unknown, edit?: PendingEdit) => unknown;
  /** For an object: an edit of one field, which keeps the others. Without it the field is sent as `{ [field]: value }`. */
  onField?: (field: string, v: unknown, edit?: PendingEdit) => unknown;
  onList: (op: ListOp) => unknown;
  /** A table edit: one cell, row or column by ID. Resolves to whether it was applied. */
  onTable: (edit: TableEdit) => Promise<boolean>;
  /** The value as the project holds it now and its revision, for an edit built after earlier ones land. */
  read?: () => ReadValue | undefined;
  /** Whether the property is still the node's: text kept for its fields goes with it (see FieldHome). */
  alive?: () => boolean;
  /** For a list: whether a row's field is still there (the row, and the field in the list's schema). */
  itemAlive?: (itemId: string, field: string) => () => boolean;
  state: ProjectState;
  focusItem?: string;
  /** For a list: open this item, once per request ("Open in inspector"); the author can close it again. */
  openItem?: ListReveal;
  /** A shorter visible label, when a group heading already says what the field belongs to. */
  label?: string;
  /** For a scalar: what to say under it in place of the schema's description. */
  hint?: ReactNode;
  /** For a list: what to say about each item, such as the key a form field is sent under. */
  annotate?: (item: ListItem, index: number) => ListItemNote | undefined;
  /** For a list: the fields of an item that do nothing for it (a form field's choices while it asks for text). */
  hiddenFields?: (item: ListItem) => readonly string[];
  linkPairs?: LinkPairs;
  /** For a single field: a problem to show under it, and a fix for it. */
  error?: string;
  action?: FieldAction;
  /** For a list: the placement it belongs to, so the item open here is revealed on the page (see lib/reveal). */
  place?: ListPlace;
  /** A value in a component's design, shown on every page that places it (see ScalarField). */
  everywhere?: boolean;
  /** For a list that takes several library images at once (a Gallery): the item field each image goes in. */
  pickImages?: string | null;
}) {
  if (schema.type === 'list' && schema.feed) return <ComputedList name={name} schema={schema} state={state} place={place} />;
  // Fields inside belong to this property of the node around them (see FieldHome).
  if (schema.type === 'list')
    return (
      <FieldHome part={`prop:${name}`} alive={alive}>
        <ListEditor name={name} schema={schema} items={Array.isArray(value) ? (value as ListItem[]) : []} onList={onList} itemAlive={itemAlive} state={state} focusItem={focusItem} openItem={openItem} annotate={annotate} hiddenFields={hiddenFields} linkPairs={linkPairs} place={place} read={read} everywhere={everywhere} pickImages={pickImages ?? undefined} />
      </FieldHome>
    );
  if (schema.type === 'table') return <TableEditor name={name} schema={schema} value={value} onTable={onTable} />;
  if (schema.type === 'object')
    return (
      <FieldHome part={`prop:${name}`} alive={alive}>
        <ObjectEditor name={name} schema={schema} value={value} onField={onField ?? ((f, v, edit) => onChange({ [f]: v }, edit))} state={state} label={label} everywhere={everywhere} error={error} action={action} />
      </FieldHome>
    );
  return (
    <FieldHome part={`prop:${name}`} alive={alive}>
      <ScalarField schema={schema} value={value} onChange={onChange} read={read} state={state} label={label} hint={hint} error={error} action={action} everywhere={everywhere} />
    </FieldHome>
  );
}

/** An object property: its fields under its name, each edited on its own. */
function ObjectEditor({ name, schema, value, onField, state, label, everywhere, error, action }: { name: string; schema: ObjectProp; value: unknown; onField: (field: string, v: unknown, edit?: PendingEdit) => unknown; state: ProjectState; label?: string; everywhere?: boolean; error?: string; action?: FieldAction }) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : schema.default;
  return (
    <fieldset className="insp-group" data-object={name}>
      <legend className="insp-group-title">{label ?? schema.label}</legend>
      {schema.description && <div className="field-hint">{schema.description}</div>}
      {Object.entries(schema.fields).map(([key, f]) => (
        <div key={key} data-object-field={key} style={{ display: 'contents' }}>
          {/* Each field is its own place within the object's (see FieldHome). */}
          <FieldHome part={`field:${key}`}>
            <ScalarField schema={f} value={Object.hasOwn(v, key) ? v[key] : Object.hasOwn(schema.default, key) ? schema.default[key] : f.default} onChange={(x, edit) => onField(key, x, edit)} state={state} everywhere={everywhere} />
          </FieldHome>
        </div>
      ))}
      {/* A problem with the object as a whole, such as a button whose link is missing, and its fix. */}
      {error && <div className="field-error">{error}</div>}
      {action && (
        <button className="btn btn-sm insp-inline-btn" onClick={action.run}>
          {action.label}
        </button>
      )}
    </fieldset>
  );
}

/** The page a placement's computed lists are worked out for: the page it is on, or none (the shared header and footer). */
export function placedOnPage(ref: ElementRef | undefined): string | undefined {
  return ref && ref.owner.kind === 'page' ? ref.owner.id : undefined;
}

/** Open a page's settings in the inspector, where an article's title, date, byline and excerpt are changed. */
export function openPageSettings(pageId: string) {
  selectPage(pageId, null);
  setState({ rightTab: 'inspect', dockOpen: true });
  // Once the page's settings are showing, open its Article section (it may have been collapsed) and bring it into view.
  setTimeout(() => openSection('page-article'), 120);
}

/**
 * A computed list (news, an article's header): what it shows where it is placed, and where each of those things is
 * changed. It holds nothing of its own to edit.
 */
function ComputedList({ name, schema, state, place }: { name: string; schema: ListProp; state: ProjectState; place?: ListPlace }) {
  const pageId = placedOnPage(place?.ref);
  const limit = feedLimit(schema);
  const node = place ? resolveRef(state, place.ref).node : undefined;
  const instance = node?.kind === 'instance' ? node : undefined;
  const properties = (instance && state.components[instance.definitionId]?.properties) || {};
  // In a collection's layout, the rows of the entry the canvas shows it on.
  const templateMode = useStore((s) => s.templateMode);
  const sample = templateMode && place?.ref.owner.kind === 'template' && !place.ref.instancePath.length ? { entryId: templateMode.entryId, nodeId: place.ref.nodeId } : undefined;
  const rows = placedFeedRows(state, schema, place?.ref.owner, properties, (instance?.props ?? {}) as Record<string, unknown>, sample) as unknown as Array<{ id: string; title: string; date?: string; dateLabel?: string }>;
  const page = pageId && Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  const hintId = useId();
  if (schema.feed === 'entries') {
    const query = entryQuery(properties, (instance?.props ?? {}) as Record<string, unknown>);
    const collection = feedCollection(state, query, place?.ref.owner.kind === 'template' ? { entry: { collectionId: place.ref.owner.id, entryId: '' } } : {});
    const count = Math.min(limit, query.count ?? Infinity);
    return (
      <div className="field computed-list" data-list={name}>
        <div className="field-label">
          {schema.label} <span className="faint">· newest first</span>
        </div>
        {rows.length ? (
          <ol className="computed-rows" aria-label={`${schema.label} shown here`}>
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  className="link-btn"
                  onClick={() => {
                    // Each row's own collection: one read from the entry a layout is shown on can be another.
                    const found = findEntry(state, r.id);
                    if (found) void openPost(found.collection.settings.id, r.id);
                  }}
                  title={`Open ${r.title} in Posts`}
                >
                  {r.title}
                </button>
                {r.dateLabel && <span className="faint"> · {r.dateLabel}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="insp-note muted">{collection ? 'No published entries to show here yet.' : query.collection ? `This project has no collection “${query.collection}”.` : 'This project has no collection yet. Start a blog in Posts.'}</p>
        )}
        <p className="insp-note field-hint">
          Filled in from {collection ? `${collection.settings.name}’s` : 'a collection’s'} published entries{query.category ? `, in ${query.category}` : ''}
          {query.tag ? `, tagged ${query.tag}` : ''}
          {Number.isFinite(count) ? `, up to ${count}` : ''}. Choose which with the settings above. Write, date and publish them in Posts; drafts are left out
          {place?.ref.owner.kind === 'template' ? ', and so is the entry whose page shows the list' : ''}.
        </p>
      </div>
    );
  }
  if (schema.feed === 'currentPage')
    return (
      <div className="field computed-list" data-list={name}>
        <div className="field-label">{schema.label}</div>
        <p className="insp-note field-hint" id={hintId}>
          {page
            ? `Shows this page’s title${rows[0]?.date ? ', publication date, byline and excerpt' : ''}${rows[0]?.date ? '' : '. Make it a dated article in its page settings to show a date, byline and excerpt too'}.`
            : 'Shows the title and article details of the page it is on. In the shared header or footer it has no page of its own and shows nothing.'}
        </p>
        {page && (
          <button className="btn btn-sm insp-inline-btn" aria-describedby={hintId} onClick={() => openPageSettings(page.id)}>
            Edit in page settings
          </button>
        )}
      </div>
    );
  return (
    <div className="field computed-list" data-list={name}>
      <div className="field-label">
        {schema.label} <span className="faint">· newest first</span>
      </div>
      {rows.length ? (
        <ol className="computed-rows" aria-label={`${schema.label} shown here`}>
          {rows.map((r) => (
            <li key={r.id}>
              <button className="link-btn" onClick={() => openPageSettings(r.id)} title={`Open ${r.title}’s page settings`}>
                {r.title}
              </button>
              {r.dateLabel && <span className="faint"> · {r.dateLabel}</span>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="insp-note muted">No articles to show yet.</p>
      )}
      <p className="insp-note field-hint">
        Filled in from the site’s dated articles{Number.isFinite(limit) ? `, up to ${limit}` : ''}. Add one with Add page → Dated article. Change an article’s title, date, byline or excerpt, or hide it from news lists, in its page settings. Drafts are left out.
      </p>
    </div>
  );
}

/** Renders grouped fields: a group gets a heading and a quiet frame, a lone field renders as itself. */
/** Names the field it holds, so a search result can open the inspector at that field. Takes no space of its own. */
function FieldSlot({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div data-field={name} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

export function FieldGroups<T>({ groups, render }: { groups: Array<PropGroup<T>>; render: (item: PropGroup<T>['items'][number]) => ReactNode }) {
  return (
    <>
      {groups.map((g, gi) =>
        g.title ? (
          <fieldset key={gi} className="insp-group">
            <legend className="insp-group-title">{g.title}</legend>
            {/* A declared group draws the buttons inside it as groups of their own. */}
            {g.groups ? (
              <FieldGroups groups={g.groups} render={render} />
            ) : (
              g.items.map((it) => (
                <FieldSlot key={it.key} name={it.key}>
                  {render(it)}
                </FieldSlot>
              ))
            )}
          </fieldset>
        ) : (
          <FieldSlot key={g.items[0].key} name={g.items[0].key}>
            {render(g.items[0])}
          </FieldSlot>
        )
      )}
    </>
  );
}

/**
 * Visible contact text and a link that open different addresses or numbers: both are shown, with one explicit
 * repair that points the link at what visitors see. Nothing shows for a deliberate label ("Call reception").
 */
export function ContactMismatch({ text, link, onRepair, field, id }: { text: unknown; link: unknown; onRepair: (link: LinkValue, label: string, revision: number | undefined) => void; field?: string; id?: string }) {
  // The repair is planned on the project this render shows, and applies only to it.
  const revision = useStore((s) => s.snapshot?.revision);
  const note = useRef<HTMLDivElement>(null);
  // A repair asked for here: when it lands the note goes, and focus that went with its button moves to the link it
  // fixed (`field`), never away from somewhere the author has gone since.
  const repaired = useRef<{ host: HTMLElement | null; at: number } | null>(null);
  const m = contactMismatch(text, link);
  const showing = !!m;
  useEffect(() => {
    const r = repaired.current;
    if (showing || !r) return;
    repaired.current = null;
    const at = document.activeElement;
    if (field && Date.now() - r.at < MOVE_PENDING_MS && (!at || at === document.body)) r.host?.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"] select`)?.focus();
  }, [showing, field]);
  if (!m) return null;
  const action = m.kind === 'email' ? 'Use displayed email as destination' : 'Use displayed number as destination';
  // What the link opens, as people write it: the address or number, without its mailto: or tel:.
  const opens = m.opens.replace(/^(mailto|tel):/i, '');
  const verb = /^mailto:/i.test(m.opens) ? 'Link emails' : /^tel:/i.test(m.opens) ? 'Link calls' : 'Link opens';
  const repair = () => {
    repaired.current = { host: note.current?.parentElement ?? null, at: Date.now() };
    onRepair(m.repair, action, revision);
  };
  return (
    <div className="scope-note site contact-mismatch" role="note" ref={note} id={id}>
      <div className="contact-mismatch-head">
        <TriangleAlert aria-hidden="true" />
        <p className="insp-note">The link doesn’t open what visitors see.</p>
      </div>
      <div className="grow">
        <dl className="contact-mismatch-pair">
          <dt>Visitors see</dt>
          <dd>{m.shown}</dd>
          <dt>{verb}</dt>
          <dd>{opens}</dd>
        </dl>
        <button className="btn btn-sm" onClick={repair}>
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
function ListEditor({ name, schema, items, onList, read, itemAlive, state, focusItem, openItem, annotate, hiddenFields, linkPairs, place, everywhere, pickImages }: { name: string; schema: ListProp; items: ListItem[]; onList: (op: ListOp) => unknown; read?: () => ReadValue | undefined; itemAlive?: (itemId: string, field: string) => () => boolean; state: ProjectState; focusItem?: string; openItem?: ListReveal; annotate?: (item: ListItem, index: number) => ListItemNote | undefined; hiddenFields?: (item: ListItem) => readonly string[]; linkPairs?: LinkPairs; place?: ListPlace; everywhere?: boolean; pickImages?: string }) {
  // Opens on the item of this list already revealed on the page (a part of it was selected, and the list is shown
  // now), so the page keeps that item open while the list takes it over.
  const [open, setOpen] = useState<string | null>(() => {
    const r = getState().revealedItem;
    return place && r && r.list === place.list && refKey(r.ref) === refKey(place.ref) && items.some((x) => x.id === r.itemId) ? r.itemId : null;
  });
  // "Open in inspector" opens an item as local state, so it then opens and closes as if the author had opened it.
  useEffect(() => {
    if (openItem) setOpen(openItem.itemId);
  }, [openItem?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const labelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const after = useRef<{ kind: 'added'; before: string[] } | { kind: 'removed'; focus: string | null } | { kind: 'moved'; id: string; direction: MoveDirection; index: number; from: number; title: string; at: number } | null>(null);
  // Images added in one pass, named by the rows the change made: focus goes to the first once this list shows it.
  const [landed, setLanded] = useState<{ ids: string[]; said: string; at: number } | null>(null);
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
      requestAnimationFrame(() => {
        // From Add, or nowhere (the page); an author who has gone to another field keeps their place.
        const active = document.activeElement;
        if (active && active !== document.body && !root?.contains(active)) return;
        focusRow(added.id);
      });
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
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && !root?.contains(active)) return;
        focusRow(a.focus);
      });
    }
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!landed) return;
    // Rows that don't show here soon (undone before this list heard of them) claim nothing later, such as a Redo.
    if (Date.now() - landed.at > MOVE_PENDING_MS) return setLanded(null);
    const first = landed.ids.find((id) => items.some((x) => x.id === id));
    if (!first) return;
    setLanded(null);
    setSaid((p) => announcementText(landed.said, p.count) ?? p);
    // Each new row stays closed under its name. Focus moves only from where Add left it: the picker's Add button, or
    // the page once the picker has closed. An author who has moved on, even within this list, keeps their place.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest('.insp-pick-many')) return;
      rootRef.current?.querySelector<HTMLElement>(`#list-head-${CSS.escape(first)}`)?.focus();
    });
  }, [ids, landed]); // eslint-disable-line react-hooks/exhaustive-deps
  const openId = focusItem ?? open;
  const reveal = useRevealedItem(place, openId ? items.find((x) => x.id === openId) : undefined);
  // A page list names each card by the title it shows: the page's own while the card has none. A row without a
  // title is named by the image it shows.
  const imageOf = (raw: ListItem) => listItemImage(schema, effectiveItem(state, schema, raw), state.assets.assets);
  const titleOf = (raw: ListItem, i: number) => listRowTitle(schema, effectiveItem(state, schema, raw), i, imageOf(raw)?.name);
  // The text a row is named by when it has some (see listRowTitle), so a blank row is told from one titled "Card 4".
  const ownTitle = (x: ListItem) => {
    const t = schema.titleField ? x[schema.titleField] : Object.values(x).find((v) => typeof v === 'string' && v && v !== x.id);
    return typeof t === 'string' ? t.trim() : '';
  };
  // In a menu with submenus, the link each item shows under (null for a top-level one), so the rows show the
  // grouping the website will: moving or removing a link can regroup the ones after it.
  const underOf: Array<string | null> = [];
  if (menuGroups(schema)) {
    const under = shownUnder(items);
    let top: string | null = null;
    items.forEach((it, i) => {
      if (!under[i]) top = titleOf(it, i);
      underOf[i] = under[i] ? top : null;
    });
  }
  const runtime = useStore((st) => st.runtime);
  const snapshot = useStore((st) => st.snapshot);
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const [picking, setPicking] = useState(false);
  const pickBtn = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  const closePicker = (refocus: boolean) => {
    setPicking(false);
    if (refocus) requestAnimationFrame(() => pickBtn.current?.focus());
  };
  // While picked images are being added, the picker stays open: its own Cancel waits too (see ImagesPicker).
  const addingPicks = useRef(false);
  const [savingPicks, setSavingPicks] = useState(false);
  const addPicks = async (assetIds: string[], replace: string[]) => {
    addingPicks.current = true;
    setSavingPicks(true);
    const r = (await Promise.resolve(L({ kind: 'pick', assetIds, replace })).finally(() => {
      addingPicks.current = false;
      setSavingPicks(false);
    })) as { added: string[]; replaced: number } | null | undefined;
    if (!r) return false;
    setLanded({ ids: r.added, said: pickAnnouncement(r.added.length, r.replaced), at: Date.now() });
    return true;
  };
  // A gallery with nothing of its own yet says how to fill it. Its samples make room for the images that replace them.
  const samples = pickImages ? sampleRows(schema, items) : [];
  const samplesOnly = !!pickImages && startingSamples(schema, items);
  const pickFull = pickRoom(schema, items.length, samples.length) <= 0;
  const currentPageId = useStore((st) => st.pageId);
  // While a page is being added, Add waits until the list changes (or a moment passes, so a request that failed does not
  // block it for good): a second press adds neither a duplicate nor whichever page the picker moves on to.
  const [asked, setAsked] = useState<string | null>(null);
  const addPending = asked !== null && asked === ids;
  useEffect(() => {
    if (asked === null) return;
    const t = setTimeout(() => setAsked(null), MOVE_PENDING_MS);
    return () => clearTimeout(t);
  }, [asked]);
  const addable = schema.pageTeaser ? pagesToAdd(state, schema, items, currentPageId) : [];
  const [toAdd, setToAdd] = useState('');
  const adding = addable.includes(toAdd) ? toAdd : (addable[0] ?? '');
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
  // Settings that do nothing for an item are left out of its editor; what they hold stays for a switch back.
  const fieldsOf = (it: ListItem) => {
    const hidden = hiddenFields?.(it);
    return hidden?.length ? groupFields(Object.entries(schema.fields).filter(([key]) => !hidden.includes(key)).map(([key, s]) => ({ key, schema: s, data: null }))) : fields;
  };
  return (
    <div className="field" role="group" aria-labelledby={labelId} data-list={name} ref={rootRef}>
      <div className="field-label" id={labelId}>
        <span className="grow">{schema.label}</span>
        <span className="insp-count">
          <span aria-hidden="true">{countText(items.length, schema.max)}</span>
          <span className="sr-only">{countLabel(items.length, schema.itemLabel, schema.max)}</span>
        </span>
      </div>
      <div className="list-editor">
        {pickImages && (
          <>
            {!picking && (items.length === 0 || samplesOnly) && <p className="insp-note muted">{items.length ? `These are sample ${schema.itemLabel.toLowerCase()}s. Choose images from Assets to replace them.` : emptyPickNote(schema)}</p>}
            {/* Stays while the picker is open, as the disclosure that shows and hides it. */}
            <button
              ref={pickBtn}
              className={`btn btn-sm insp-pick-open${!picking && (items.length === 0 || samplesOnly) ? ' btn-primary' : ''}`}
              aria-expanded={picking}
              aria-controls={picking ? pickerId : undefined}
              aria-disabled={(pickFull && !picking) || savingPicks ? true : undefined}
              aria-busy={savingPicks || undefined}
              aria-describedby={pickFull && !picking && addNote ? addNoteId : undefined}
              title={pickFull && !picking ? (addNote ?? undefined) : undefined}
              onClick={() => {
                if (picking) return addingPicks.current ? undefined : closePicker(true);
                if (pickFull) return;
                setPicking(true);
              }}
            >
              <Images /> Choose images…
            </button>
            {picking && (
              <div id={pickerId}>
                <ImagesPicker schema={schema} items={items} state={state} onAdd={addPicks} onClose={closePicker} />
              </div>
            )}
          </>
        )}
        {items.map((it, i) => {
          const note = annotate?.(it, i);
          const thumb = imageOf(it);
          const title = titleOf(it, i);
          // A row with nothing to name it by says so, rather than passing its place in the list off as a title.
          const untitled = !thumb && !ownTitle(effectiveItem(state, schema, it));
          // A contact link that opens something other than its text is flagged on the closed row too.
          const flag = note?.error ?? (linkPairs?.some((p) => contactMismatch(it[p.text], it[p.link])) ? 'The link doesn’t open what visitors see.' : undefined);
          return (
          <div key={it.id} className={`list-editor-item${focusItem === it.id ? ' focused' : ''}${underOf[i] ? ' nested' : ''}`}>
            <div className="list-editor-head">
              {/* The chevron and title are one disclosure button, so the whole leading area opens the item. */}
              <button className="title" id={`list-head-${it.id}`} aria-expanded={openId === it.id} aria-controls={`list-item-${it.id}`} aria-describedby={flag ? `list-flag-${it.id}` : undefined} onClick={() => setOpen(openId === it.id ? null : it.id)}>
                <ChevronRight size={12} style={{ transform: openId === it.id ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
                {thumb && devUrl && (
                  <span className="list-editor-thumb" aria-hidden="true">
                    <AssetImage key={missingKey(snapshot, thumb.id)} asset={thumb} devUrl={devUrl} cover alt="" loading="lazy" />
                  </span>
                )}
                {underOf[i] && <CornerDownRight size={12} className="faint list-editor-under" aria-hidden="true" />}
                <span className={`list-editor-name${untitled ? ' untitled' : ''}`}>
                  {untitled ? `Untitled ${schema.itemLabel.toLowerCase()}` : title}
                  {/* Its place in the list, which its move and remove buttons are named by. */}
                  {untitled && <span className="sr-only">, {title}</span>}
                </span>
                {underOf[i] && <span className="sr-only">, under {underOf[i]}</span>}
                {/* A closed item still shows it needs attention. */}
                {flag && (
                  <span className="list-editor-flag" title={flag} aria-hidden="true">
                    <TriangleAlert />
                  </span>
                )}
              </button>
              {/* Outside the button, so the problem describes the row without becoming part of its name. */}
              {flag && (
                <span className="sr-only" id={`list-flag-${it.id}`}>
                  {flag}
                </span>
              )}
              <button className="icon-btn sm" aria-label={`Move ${titleOf(it, i)} up`} id={`list-up-${it.id}`} disabled={i === 0} onClick={() => move(it, i, 'up')}>
                <ArrowUp />
              </button>
              <button className="icon-btn sm" aria-label={`Move ${titleOf(it, i)} down`} id={`list-down-${it.id}`} disabled={i === items.length - 1} onClick={() => move(it, i, 'down')}>
                <ArrowDown />
              </button>
              <button className="icon-btn sm list-editor-remove" aria-label={`Remove ${titleOf(it, i)}`} aria-disabled={removeNote ? true : undefined} aria-describedby={removeNote ? (removeNoteShared ? addNoteId : removeNoteId) : undefined} title={removeNote ?? undefined} onClick={() => {
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
                    groups={fieldsOf(it)}
                    render={({ key, schema: fs, label }) => {
                      const teaser = teaserFieldNote(state, schema, it, key);
                      return (
                        <FieldHome key={key} part={`item:${it.id}:${key}`} alive={itemAlive?.(it.id, key)}>
                          <ScalarField
                            schema={fs as ScalarPropSchema}
                            label={label}
                            value={Object.hasOwn(it, key) ? it[key] : (fs as { default?: unknown }).default}
                            onChange={(v, edit) => L({ kind: 'field', itemId: it.id, field: key, value: v, edit })}
                            read={read && (() => readItemField(read(), it.id, key))}
                            state={state}
                            hint={note?.field === key ? note.hint : teaser?.hint}
                            placeholder={teaser?.placeholder}
                            error={note?.field === key ? note.error : undefined}
                            action={note?.field === key ? note.action : undefined}
                            onLive={fs.type === 'string' ? reveal.typed(key) : undefined}
                            notedBy={linkPairs?.some((p) => p.link === key && contactMismatch(it[p.text], it[p.link])) ? `contact-${it.id}-${key}` : undefined}
                            everywhere={everywhere}
                          />
                        </FieldHome>
                      );
                    }}
                  />
                  {linkPairs?.map((p) => (
                    <ContactMismatch key={p.link} id={`contact-${it.id}-${p.link}`} field={p.link} text={it[p.text]} link={it[p.link]} onRepair={(link, label, revision) => L({ kind: 'repair', itemId: it.id, field: p.link, value: link, label, revision })} />
                  ))}
                </>
              )}
            </div>
          </div>
          );
        })}
        {schema.pageTeaser ? (
          // A page list adds a card for a page chosen here; each page appears once.
          addable.length > 0 ? (
            <div className="insp-link-row">
              <select className="select sm grow" value={adding} aria-label={`${schema.itemLabel} to add`} aria-describedby={addNote ? addNoteId : undefined} onChange={(e) => setToAdd(e.target.value)}>
                {addable.map((id) => (
                  <option key={id} value={id}>
                    {state.pages[id].title} ({state.pages[id].route})
                  </option>
                ))}
              </select>
              <button className="btn btn-sm insp-add" aria-disabled={addNote || addPending ? true : undefined} aria-describedby={addNote ? addNoteId : undefined} title={addNote ?? undefined} onClick={() => {
                  if (addNote || addPending || !adding) return;
                  after.current = { kind: 'added', before: items.map((x) => x.id) };
                  setAsked(ids);
                  L({ kind: 'insert', item: { [schema.pageTeaser!.link]: { type: 'page', target: adding } } });
                }}>
                <Plus /> Add {schema.itemLabel.toLowerCase()}
              </button>
            </div>
          ) : (
            <p className="insp-note muted">{items.length ? 'Every other page of the site is in this list.' : 'Add another page to the site to list it here.'}</p>
          )
        ) : (
          <button className="btn btn-sm insp-add" aria-disabled={addNote ? true : undefined} aria-describedby={addNote ? addNoteId : undefined} title={addNote ?? undefined} onClick={() => {
              if (addNote) return;
              after.current = { kind: 'added', before: items.map((x) => x.id) };
              L({ kind: 'insert' });
            }}>
            <Plus /> Add {schema.itemLabel.toLowerCase()}
          </button>
        )}
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
