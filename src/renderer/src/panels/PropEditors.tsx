import './PropEditors.css';
import { createElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, CornerDownRight, FilePlus, Hash, Image as ImageIcon, ImageOff, ImagePlus, Images, List, Plus, Search, Trash2, TriangleAlert, Upload } from 'lucide-react';
import type { AssetRecord, ChoiceOption, ChoicesProp, ElementRef, PageDoc, GraphNode, ImageValue, LinkRel, LinkValue, ListItem, ListProp, NumberProp, ObjectProp, ProjectState, PropSchema, ScalarPropSchema } from '@shared/types';
import { isEntryBinding, refKey } from '@shared/types';
import { copiesWrong } from '@shared/api';
import { ICONS } from '@shared/icons';
import { api, copyTextAction, getState, markDraft, setState, toast, useStore, type PendingEdit } from '../store';
import { isImeComposing } from '../lib/ime';
import { linkFieldProblem } from '../lib/link-problems';
import { readNumberDraft } from '../lib/number-draft';
import type { ListPlace } from '../lib/reveal';
import { DisclosureMark, DraftInput, Field, FieldHome, InfoTip, missingNote, openMenus, openSection, RequiredMark, Switch, SwitchRow, useFieldHome } from '../components/ui';
import { TEXT_LIMITS } from '@shared/text-limits';
import { isSettling, refusedWithin, registerUnsent, savesInFlight } from '../lib/pending';
import { announcementText } from '../lib/announce';
import { MAX_CHOICES as MAX_CHOICE_ROWS } from '@engine/values';
import { declaredTokens } from '@engine/tokens';
import { applyChoiceAction, choiceText, sameChoice, staleRename, type ChoiceAction } from '../lib/choices';

const MOVE_PENDING_MS = 3000;
import { addLimitNote, countLabel, countText, moveAnnouncement, moveFocusTarget, removeLimitNote, type MoveDirection } from '../lib/list-editor';
import { emptyPickNote, pickAnnouncement, pickRoom, sampleRows, startingSamples } from '../lib/gallery-picks';
import { importAndPlace, showAsset } from '../lib/place';
import { AssetImage } from '../components/AssetImage';
import { fitFor } from '../components/AssetPicture';
import { WindowedGrid, type WindowedGridApi } from '../components/WindowedGrid';
import { AssetOrderControls, shortName, useAssetSeries } from '../components/AssetOrder';
import { assetLabels, inSeries, sortAssets } from '@shared/asset-order';
import { richTextToMarkdown, toRichText } from '@shared/richtext';
import { RichTextField } from '../components/RichTextField';
import { LINK_REL_LABELS, LinkRelControls } from '../components/LinkRelControls';
import { canonicalRels, withRels } from '@shared/link-rel';
import { pageIds, planSectionPick, sharedPageIds } from '@generator/checks';
import { contactMismatch } from '@shared/contact-links';
import { SECTION_NODE, sectionOptions } from '../lib/sections';
import { pagesToAdd, teaserFieldNote } from '../lib/page-teasers';
import type { PictureStandIn } from '../lib/sharing';
import { effectiveItem, teaserPage } from '@shared/page-teasers';
import { articleRows, feedLimit, pageArticle } from '@shared/articles';
import { entryQuery, feedCollection, hasCollections, listedEntries, publishedEntries, termsNamed, type EntryQuery } from '@shared/entry-feed';
import { findEntry } from '@shared/collections';
import { linkIndexes } from '../lib/link-indexes';
import { openPost, selectPage } from '../lib/actions';
import { placedFeedRows, resolveRef, sampleQuery } from '../lib/model';
import { groupFields, listItemImage, listRowTitle, type PropGroup } from '@shared/fields';
import type { TableEdit } from '@engine/table';
import { TableEditor } from './TableEditor';
import { menuGroups, shownUnder } from '@engine/tree';
import { ImagesPicker, missingKey, pickGridKeys, windowedPickKeys } from './ImagesPicker';
import { isShellPart, type ShellPart } from '@shared/page-shell';
import { documentDetails, documentLabels, isLibraryDocument, libraryDocuments } from '../lib/documents';
import { assetArrived } from '../lib/import-review';

export { groupFields };

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Which section of a page a link jumps to: the page's sections by their headings (a section without an ID gets one
 * from its heading when it is chosen), the shared header and footer's IDs, or any ID typed in, which a button beside
 * the list offers (a command is never an option in it). `top` offers the top of the page (no section); without it an
 * empty value asks for a choice.
 */
function SectionPicker({ state, pageId, value, onPick, label, top, shared, id, invalid, describedBy, onTyping, note, always }: { state: ProjectState; pageId: string | null | undefined; value: string; onPick: (anchor: string, edit?: PendingEdit) => void; label: string; top?: boolean; shared?: ShellPart; id?: string; invalid?: boolean; describedBy?: string; onTyping?: (typing: boolean) => void; /** What the saved link does, said under an ID that can't be used, and while typing with `always`. */ note?: string; always?: boolean }) {
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
  const noteId = useId();
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
    const bad = a.match(/[^\w-]/)?.[0];
    return !bad ? '' : bad === ' ' ? 'An ID can’t have spaces: use hyphens between words.' : `An ID can’t use “${bad}”: use letters, numbers, hyphens or underscores.`;
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
          } else if (why && typed.trim()) {
            // A click or Tab elsewhere goes there: an ID that can't be used stays in its field with the reason under
            // it, as a typed address does, until it is fixed or abandoned with Esc.
            setProblem(why);
          } else backToList(enter && !why);
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
          aria-describedby={[problem ? problemId : '', problem ? '' : hintId, note && (problem || always) ? noteId : '', describedBy ?? ''].filter(Boolean).join(' ')}
          aria-invalid={!!problem || undefined}
          placeholder={top ? 'Empty for the top of the page' : 'pricing'}
          autoFocus
          check={(t) => {
            const why = idProblem(t);
            return why && t.trim() ? { message: why } : null;
          }}
          onProblem={(p) => setProblem(p?.message ?? '')}
          onLive={() => problem && setProblem('')}
          onCommit={(t) => {
            // An ID that can't be used is left in the field: the blur that follows says why and keeps it open.
            if (idProblem(t)) return;
            const a = t.trim().replace(/^#/, '');
            if (a !== value) onPick(a);
          }}
        />
        {/* An ID that can't be used: the reason, then what the saved link does meanwhile, in place of the rule it broke. */}
        {problem ? (
          <span className="field-error" id={problemId} role="alert">
            {problem}
          </span>
        ) : (
          <span className="field-hint" id={hintId}>
            The name after # in the section’s address. Start with a letter, then use letters, numbers, hyphens or underscores.
          </span>
        )}
        {note && (problem || always) && (
          <span className="field-hint" id={noteId}>
            {note}
          </span>
        )}
        <button type="button" className="btn btn-sm btn-ghost insp-link-aside" onClick={() => backToList(true)}>
          <List aria-hidden="true" /> Choose from the list
        </button>
      </span>
    );
  return (
    <span className="insp-link-pair">
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
      </select>
      {/* A rare way in, so it takes a glyph's width and leaves the section's name the room to be read. */}
      <button type="button" className="btn btn-sm insp-link-id" aria-label={`Type an ID for ${label.toLowerCase()}`} title="Type a section ID" onClick={() => setTyping(true)}>
        <Hash aria-hidden="true" />
      </button>
    </span>
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
function DocumentPicker({ state, value, label, importFor, onPick, details, invalid, describedBy, id }: { state: ProjectState; value: string; label: string; importFor: string; onPick: (id: string) => void; details?: ReactNode; invalid?: boolean; describedBy?: string; id?: string }) {
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
      const r: { ok: boolean; assetIds: string[]; message?: string; note?: string } = await api.project.importAssets(undefined, 'document').catch((e: Error) => ({ ok: false, assetIds: [] as string[], message: `The document couldn’t be added: ${e.message}` }));
      const said = [r.note, r.message].filter(Boolean).join(' ');
      if (said) toast(said, r.message && !r.ok ? 'error' : 'info');
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
        id={id}
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
      {!docs.length && !value && <p className="insp-link-file">Import a PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV or ZIP file for visitors to download.</p>}
      {/* Importing links the new document here as well as adding it to Assets, and the button says so. */}
      <button type="button" className="btn btn-sm insp-link-import" disabled={importing} aria-label={`Import and link a document for ${importFor}`} onClick={() => void importOne()}>
        <FilePlus />
        {importing ? 'Importing…' : 'Import and link…'}
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
  // The note about a section a page change let go lasts only while the link is still that page's top.
  useEffect(() => {
    const d = dropped.current;
    if (d && !(value?.type === 'page' && value.target === d.page && !value.anchor)) dropped.current = null;
  }, [valueKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // The section a page change let go, and the page it was let go for.
  const dropped = useRef<{ page: string; section: string } | null>(null);
  if (v.type === 'page' && state.pages[v.target]) lastPage.current = v.target;
  // The collections whose index a link can go to, and the one it last went to.
  const indexes = useMemo(() => linkIndexes(state), [state]);
  const lastIndex = useRef<string | null>(null);
  if (v.type === 'collection' && indexes.some((x) => x.id === v.target)) lastIndex.current = v.target;
  // Likewise the document it last went to.
  const lastDocument = useRef<string | null>(null);
  const linkedDocument = v.type === 'document' && Object.hasOwn(state.assets.assets, v.target) && isLibraryDocument(state.assets.assets[v.target]) ? state.assets.assets[v.target] : undefined;
  if (linkedDocument) lastDocument.current = v.target;
  const pickType = (t: LinkValue['type']) => {
    if (t === v.type) return setPending(null);
    if (t === 'none') onChange({ type: 'none', target: '' });
    else if (t === 'collection' && indexes.length) onChange({ type: t, target: indexes.find((x) => x.id === lastIndex.current)?.id ?? indexes[0].id, ...(v.newTab ? { newTab: true } : {}) });
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
  // What visitors get while the field shows something else: a kind still waiting for its destination, or typed text
  // the project would refuse. Said once, after the reason, so the author knows the saved link still works.
  const saved = savedDestination(v, state, savedSectionGone, shared);
  const still = pending && v.type !== 'none' ? `Until you choose where it goes, the link still ${saved}.` : problem && v.type === type && v.target ? `Until it’s corrected, the link still ${saved}.` : null;
  const kindId = `${pendingId}-kind`;
  const destId = `${pendingId}-dest`;
  const destLabel = type === 'page' ? 'Page' : type === 'collection' ? 'Collection' : type === 'document' ? 'Document' : type === 'anchor' ? 'Section' : type === 'tel' ? 'Number' : 'Address';
  const destMissing = !pending && v.type === 'collection' && !indexes.some((x) => x.id === v.target);
  // A section the newly chosen page doesn't have was let go: said once, quietly, while the link still opens that page's top.
  const droppedNote = dropped.current && v.type === 'page' && v.target === dropped.current.page && !v.anchor && !pageIds(state, v.target).has(dropped.current.section) ? `${state.pages[v.target]?.title ?? 'That page'} has no “#${dropped.current.section}” section, so the link opens at its top.` : null;
  return (
    <div className="insp-link">
      {/* Each control has its name beside it (stacked when the panel is narrow), and what is wrong with a control is
          said under that control, once. */}
      <div className="insp-link-grid">
        <label className="insp-link-sub" htmlFor={kindId}>
          Type
        </label>
        <select id={kindId} className="select sm" value={type} aria-label={named('Link type')} aria-invalid={(invalid && !pending) || undefined} aria-describedby={describedBy} onChange={(e) => pickType(e.target.value as LinkValue['type'])}>
          <option value="none">No link</option>
          <optgroup label="On this site">
            <option value="page">Page</option>
            {(!everywhere || type === 'anchor') && <option value="anchor">Section on this page</option>}
            {(indexes.length > 0 || type === 'collection' || v.type === 'collection') && <option value="collection">Collection index</option>}
            <option value="document">Document</option>
          </optgroup>
          <optgroup label="Elsewhere">
            <option value="url">Web address</option>
            <option value="email">Email</option>
            <option value="tel">Phone</option>
          </optgroup>
        </select>
        {type !== 'none' && (
          <>
            <label className="insp-link-sub" htmlFor={destId}>
              {destLabel}
            </label>
            <div className="insp-link-control">
              {type === 'page' ? (
                <PagePicker
                  state={state}
                  id={destId}
                  value={v.target}
                  label={named('Page')}
                  // A section the new page also has goes with the link; one it lacks is dropped, so it opens at the top.
                  onPick={(id) => {
                    const keep = !!v.anchor && (id === v.target || pageIds(state, id).has(v.anchor));
                    dropped.current = v.anchor && !keep ? { page: id, section: v.anchor } : null;
                    onChange(withAnchor({ ...v, target: id }, keep ? v.anchor : undefined));
                  }}
                />
              ) : type === 'collection' ? (
                <select
                  id={destId}
                  className="select sm"
                  value={indexes.some((x) => x.id === v.target) ? v.target : ''}
                  aria-label={named('Collection')}
                  aria-invalid={destMissing || undefined}
                  aria-describedby={destMissing ? missingId : undefined}
                  onChange={(e) => e.target.value && onChange({ type: 'collection', target: e.target.value, ...(v.newTab ? { newTab: true } : {}) })}
                >
                  {!indexes.some((x) => x.id === v.target) && (
                    <option value="" disabled>
                      {indexName(state, v.target) ?? 'Missing collection'}
                    </option>
                  )}
                  {indexes.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} ({x.route})
                    </option>
                  ))}
                </select>
              ) : type === 'document' ? (
                <DocumentPicker
                  state={state}
                  id={destId}
                  value={target}
                  label={named('Document')}
                  importFor={base && base.toLowerCase() !== 'link' ? base.toLowerCase() : 'this link'}
                  invalid={!pending && !linkedDocument && !!v.target}
                  describedBy={!pending && !linkedDocument && v.target ? missingId : still ? pendingId : undefined}
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
                <span className="insp-link-fixed" id={destId}>
                  #{target}
                </span>
              ) : type === 'anchor' ? (
                <SectionPicker state={state} id={destId} pageId={currentPageId} value={target} label={named('Section')} shared={shared} invalid={missing} describedBy={missing ? missingId : still ? pendingId : undefined} onTyping={setTypingSection} note={still ?? (v.type === 'none' ? undefined : `Until it’s corrected, the link still ${saved}.`)} always={!!still} onPick={(a, edit) => a && onChange({ type: 'anchor', target: a }, edit)} />
              ) : (
                <DraftInput
                  key={type}
                  id={destId}
                  className={`input sm${type === 'tel' ? '' : ' insp-link-address'}`}
                  // A long address wraps, so the part that tells two links on one site apart is never hidden.
                  wrap={type !== 'tel'}
                  value={target}
                  autoFocus={!!pending}
                  aria-describedby={[problem ? problemId : '', still ? pendingId : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined}
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
                    // A web address typed over another keeps what the author said about the site; any other kind has none.
                    onChange(withRels({ type, target: t.trim(), newTab: type === 'url' ? v.newTab : undefined }, v.type === type ? v.rel : undefined));
                  }}
                />
              )}
              {/* Mounted with a page link, so the note a page change leaves is announced. */}
              {type === 'page' && (
                <div className="field-hint insp-link-status" role="status">
                  {droppedNote}
                </div>
              )}
              {problem && (
                <div className="field-error" id={problemId} role="alert">
                  {problem}
                </div>
              )}
              {type === 'anchor' && missingText && (
                <div className="field-error" id={missingId}>
                  {missingText}
                </div>
              )}
              {destMissing && (
                <div className="field-error" id={missingId}>
                  {indexName(state, v.target) ? `${indexName(state, v.target)} has no index on the website, so the link shows its words alone. Turn on its index, or choose another destination.` : 'This collection is no longer in the project, so the link goes nowhere. Choose another destination.'}
                </div>
              )}
              {/* A kind of link that still needs its destination, or text that can't be saved: the saved link is the one visitors get. */}
              {still && !(type === 'anchor' && typingSection) && (
                <div className="field-hint" id={pendingId}>
                  {still}
                </div>
              )}
            </div>
          </>
        )}
        {type === 'page' && (
          <>
            <label className="insp-link-sub" htmlFor={sectionId}>
              Section
            </label>
            <div className="insp-link-control">
              <div className="insp-link-row">
                <SectionPicker state={state} pageId={v.target} value={v.anchor ?? ''} label={named('Section on the page')} top id={sectionId} invalid={missing} describedBy={missing ? missingId : undefined} onTyping={setTypingSection} note={`Until it’s corrected, the link still ${saved}.`}
                  onPick={(a, edit) => {
                    dropped.current = null;
                    onChange(withAnchor(v, a || undefined), edit);
                  }}
                />
              </div>
              {missingText && (
                <div className="field-error" id={missingId}>
                  {missingText}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {/* A new tab only means something for pages and web addresses; mail and phone links open their own apps. */}
      {!pending && (v.type === 'page' || v.type === 'url' || v.type === 'collection') && <SwitchRow checked={!!v.newTab} onChange={(n) => onChange({ ...v, newTab: n })} label="Open in a new tab" />}
      {!pending && v.type === 'url' && <LinkRelDisclosure value={v.rel} onChange={(rel) => onChange(withRels(v, rel))} />}
    </div>
  );
}

/**
 * What a link to another site tells search engines, folded under one line that says what is ticked: a setting most
 * links never need, so it stays out of the way until it is wanted, and says so when it is set.
 */
function LinkRelDisclosure({ value, onChange }: { value: readonly string[] | undefined; onChange: (rel: LinkRel[]) => void }) {
  const on = canonicalRels(value);
  const [open, setOpen] = useState(false);
  return (
    <details className="insp-link-more" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <ChevronRight aria-hidden="true" className="chev" />
        <span>Search engines</span>
        <span className="insp-link-more-state">{on.length ? on.map((r) => LINK_REL_LABELS[r].label.toLowerCase()).join(', ').replace(/^./, (c) => c.toUpperCase()) : 'None'}</span>
      </summary>
      <LinkRelControls value={value} onChange={onChange} />
    </details>
  );
}

/**
 * A link's page, chosen from a list that can be searched by title or address. Closed, it shows the page's title and
 * its address apart, so the address is never what a long title pushes out of view. Open, it is a search field over
 * the site's pages (the APG combobox: focus stays in the field, the arrow keys move through the pages, Enter chooses,
 * Escape closes and changes nothing).
 */
function PagePicker({ state, value, label, id, onPick, pages, currentNote = 'linked now', describedBy, onActive }: { state: ProjectState; value: string; label: string; id?: string; onPick: (id: string) => void; /** Only these pages, in Pages order (a page list offers the pages it doesn't list yet). */ pages?: readonly string[]; /** What the chosen page is, said after its name in the list. */ currentNote?: string; describedBy?: string; /** The highlighted page while open (null when the search matches none), undefined once closed. */ onActive?: (id: string | null | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<string | null>(null);
  // The highlight the keys set (not a passing pointer), for what onActive reports.
  const keyed = useRef<string | null>(null);
  const listId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // A click between rows or on the scrollbar focuses the list, which hands focus straight back to the field.
  const field = useRef<HTMLInputElement>(null);
  const page = Object.hasOwn(state.pages, value) ? state.pages[value] : undefined;
  const all = state.site.pageOrder.filter((p) => Object.hasOwn(state.pages, p) && (!pages || pages.includes(p)));
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter((p) => state.pages[p].title.toLowerCase().includes(needle) || state.pages[p].route.toLowerCase().includes(needle)) : all;
  // The highlighted page: the one moved to while it is still shown, else the linked one, else the first.
  // While searching, the first match: Enter takes what was typed for, not the page already linked.
  const current = active && shown.includes(active) ? active : !needle && shown.includes(value) ? value : (shown[0] ?? null);
  const optionId = (p: string) => `${listId}-${p}`;
  // Reported while open: the page the keys or the search point at (the chosen one while neither does), so a pointer
  // crossing the list on its way to a button beside it doesn't change what that button takes.
  const reported = keyed.current && shown.includes(keyed.current) ? keyed.current : !needle && shown.includes(value) ? value : (shown[0] ?? null);
  useEffect(() => onActive?.(open ? reported : undefined), [open, reported]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onActive?.(undefined), []); // eslint-disable-line react-hooks/exhaustive-deps
  // The highlighted page is kept in view by scrolling the list alone, never the Inspector around it.
  useEffect(() => {
    const box = list.current;
    const row = open && current ? document.getElementById(optionId(current)) : null;
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [open, current, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = (focus: boolean) => {
    setOpen(false);
    setQ('');
    setActive(null);
    keyed.current = null;
    if (focus) requestAnimationFrame(() => btn.current?.focus());
  };
  const choose = (p: string) => {
    if (p !== value) onPick(p);
    close(true);
  };
  const keys = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    const at = current ? shown.indexOf(current) : -1;
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 8 : e.key === 'PageUp' ? -8 : 0;
    if (step && shown.length) {
      e.preventDefault();
      const next = shown[Math.max(0, Math.min(shown.length - 1, at + step))];
      keyed.current = next;
      setActive(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current) choose(current);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };
  return (
    <div
      className="insp-page-picker"
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={btn}
        type="button"
        id={id}
        className="select sm insp-page-btn"
        aria-label={page ? `${label}: ${page.title}, ${page.route}` : label}
        aria-describedby={describedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (open || isImeComposing(e)) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), setOpen(true));
          // Typing on it, as on the selects beside it, opens the list searched for what was typed (Space stays a press).
          else if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) (e.preventDefault(), setQ(e.key), setOpen(true));
        }}
      >
        {page ? (
          <>
            <span className="insp-page-title">{page.title}</span>
            <span className="insp-page-route">{page.route}</span>
          </>
        ) : (
          <span className="insp-page-title faint">Choose a page…</span>
        )}
      </button>
      {open && (
        <div className="insp-pick insp-page-pick">
          <label className="insp-page-search-label" htmlFor={`${listId}-q`}>
            Search pages
          </label>
          <div className="insp-page-search">
            <Search aria-hidden="true" />
            <input
              ref={field}
              id={`${listId}-q`}
              type="text"
              role="combobox"
              className="input sm"
              placeholder="By title or address"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={current ? optionId(current) : undefined}
              autoFocus
              value={q}
              onChange={(e) => ((keyed.current = null), setQ(e.target.value), setActive(null))}
              onKeyDown={keys}
            />
          </div>
          {/* Mounted while open, empty or not, so the field always controls a list; never a tab stop of its own. */}
          <div ref={list} className="insp-page-list" role="listbox" id={listId} aria-label={label} tabIndex={-1} hidden={!shown.length} onFocus={(e) => e.target === e.currentTarget && field.current?.focus()}>
            {shown.map((p) => (
              <div
                key={p}
                id={optionId(p)}
                role="option"
                aria-selected={p === current}
                className={`insp-page-option${p === value ? ' current' : ''}${p === current ? ' active' : ''}`}
                // The field keeps focus: a click chooses without the list closing first.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => p !== current && setActive(p)}
                onClick={() => choose(p)}
              >
                <span className="insp-page-title">{state.pages[p].title}</span>
                <span className="insp-page-route">{state.pages[p].route}</span>
                {p === value && (
                  <>
                    <Check aria-hidden="true" className="insp-page-check" />
                    <span className="sr-only">, {currentNote}</span>
                  </>
                )}
              </div>
            ))}
          </div>
          {!shown.length && <p className="faint insp-note">No pages match “{q.trim()}”.</p>}
          {/* Mounted with the list, so a search's count is announced as it changes. */}
          <span className="sr-only" role="status">
            {needle ? (shown.length ? `${shown.length} ${shown.length === 1 ? 'page' : 'pages'}` : `No pages match “${q.trim()}”.`) : ''}
          </span>
        </div>
      )}
    </div>
  );
}

/** A collection's name, while the project has it. */
const indexName = (state: ProjectState, id: string): string | null => (Object.hasOwn(state.collections ?? {}, id) ? state.collections[id].settings.name : null);

/** Where a saved link takes visitors, as the end of "the link still …", for while another kind of link is being set up. */
function savedDestination(v: LinkValue, state: ProjectState, sectionGone: boolean, shellPart?: ShellPart): string {
  const page = v.type === 'page' && Object.hasOwn(state.pages, v.target) ? state.pages[v.target] : null;
  // A section by the name the picker gives it, when it has one.
  const section = (pageId: string | null | undefined, id: string) => sectionOptions(state, pageId, undefined).options.find((o) => o.value === `#${id}`)?.text ?? `#${id}`;
  // A title another page shares is told apart by its address, since the page list isn't showing while this is said.
  const shared = page && Object.values(state.pages).some((p) => p.id !== page.id && p.title.trim().toLowerCase() === page.title.trim().toLowerCase());
  if (page) return `goes to ${sectionGone || !v.anchor ? 'the top of ' : ''}${page.title}${shared ? ` (${page.route})` : ''}${v.anchor && !sectionGone ? `, ${section(page.id, v.anchor)}` : ''}`;
  if (v.type === 'collection') {
    const index = linkIndexes(state).find((x) => x.id === v.target);
    return index ? `goes to the ${index.name} index` : 'goes nowhere';
  }
  if (v.type === 'document') return Object.hasOwn(state.assets.assets, v.target) && isLibraryDocument(state.assets.assets[v.target]) ? `downloads ${state.assets.assets[v.target].name}` : 'goes nowhere';
  if (v.type === 'email') return `emails ${v.target}`;
  if (v.type === 'tel') return `calls ${v.target}`;
  // In a shared header or footer, a section some of its pages lack still works on the ones that have it.
  if (v.type === 'anchor') return !sectionGone ? `goes to #${v.target}` : shellPart ? `goes to #${v.target} on the pages that have it` : 'does nothing';
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

/**
 * A site-level image that carries no description: the browser tab icon (shown square) or the picture shown when
 * the site is shared (shown at the 1.91:1 shape link previews crop it to), and a post's featured image.
 */
export type PlainImage = 'favicon' | 'social' | 'logo' | 'featured';

/** The picker for a site image: the image editor's thumbnail, search, import and keyboard grid, with None as Remove. */
export function SiteImageField({ value, onChange, state, title, plain, describedBy }: { value: string | null | undefined; onChange: (assetId: string | null) => void; state: ProjectState; title: string; plain: PlainImage; /** The ID of its guidance, read with the card's name. */ describedBy?: string }) {
  return <ImageEditor value={{ assetId: value ?? null, alt: '' }} onChange={(v) => onChange(v.assetId ?? null)} state={state} title={title} plain={plain} describedBy={describedBy} />;
}

/** Images whose description was kept from the picture they replaced and not yet checked, by field, image and
 *  description: the flag outlives the editor (a list item closed and opened again) until the description is checked or
 *  changed, and belongs to the one field it was raised in. */
const carriedDescriptions = new Set<string>();
const carryKey = (x: ImageValue | null | undefined, project: string | undefined, field: string) => (x?.assetId ? `${project ?? ''}\u0000${field}\u0000${x.assetId}\u0000${x.alt}` : '');

/**
 * Image editor: one card holding the picture, its description and whether it is decorative. `title` puts the
 * field's name inside the card (like the other field groups); a standalone image passes none. `picture` makes it a
 * picture and nothing else, with no description to write and never decorative (a page's sharing image; see
 * PictureStandIn). Change opens the library in a popover over the Inspector (as the icon picker does), so the fields
 * under the card stay where they are while a picture is chosen; an image file dropped on the card or the popover is
 * imported and used. The rule the pickers share: a tall grid that commits on one click opens in a popover (icons, one
 * image); a short list (a page) or a choice that is reviewed before it is added (a gallery's images) opens in the flow.
 */
export function ImageEditor({ value, onChange, state, title, plain, picture, mark, info, describedBy, copyOnly }: { value: ImageValue; onChange: (v: ImageValue) => void; state: ProjectState; title?: string; plain?: PlainImage; picture?: PictureStandIn; /** Said after the title (that the component requires a picture). */ mark?: ReactNode; /** The picture's explanation, behind an info button beside the title (see InfoTip). */ info?: ReactNode; describedBy?: string; /** For a live session's copy editor (#1318): a picture already set is replaced from the library and described, and nothing more. */ copyOnly?: boolean }) {
  const runtime = useStore((s) => s.runtime);
  // The project as this editor shows it: an import checks its placement against it.
  const snapshot = useStore((s) => s.snapshot);
  const altId = useId();
  const titleId = useId();
  // Where this image sits in the project, so a description refused for being too long waits for it there.
  const home = useFieldHome();
  const v = value ?? { assetId: null, alt: '' };
  // Only what the library has as an image is shown: a saved ID that names a document or font is said to be not an
  // image, and one that is no record at all is an image that is gone.
  const named = v.assetId && Object.hasOwn(state.assets.assets, v.assetId) ? state.assets.assets[v.assetId] : null;
  const asset = named?.kind === 'image' && typeof named.file === 'string' && named.file ? named : null;
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  // A description saved on leaving its field, and the value shown then (#1393). Leaving the description for the
  // Decorative switch, or Remove, saves it, and that change is made before the save comes back from the project: until
  // the value shown moves on (the save came back, or something else changed the image), changes build on it.
  const saving = useRef<{ alt: string; from: ImageValue; field?: string } | null>(null);
  if (saving.current && (!sameImage(saving.current.from, v) || saving.current.field !== home?.key)) saving.current = null;
  // The value as it is now, for work that finishes later (an import) and for each change made from here.
  const latest = useRef(v);
  latest.current = saving.current ? { ...v, alt: saving.current.alt } : v;
  // The same, as this render has it: what a description typed from here is saved onto. The field may save it with the
  // callback it had when typing began (the AI ran meanwhile), and then it must be saved onto the image shown then.
  const shownNow = latest.current;
  // The value shown when the description began to be typed. Its save is checked against where typing began, and held
  // when the image changed since (another window replaced it): then nothing builds on it (see commitDraft).
  const typedOn = useRef<ImageValue | null>(null);
  // A description carried over from the previous image may no longer be true; say so until it is checked or edited.
  const [, redraw] = useState(0);
  const project = snapshot?.workspaceKey;
  const field = home?.key ?? '';
  const carried = carriedDescriptions.has(carryKey(v, project, field));
  // Said once when a pick keeps the old description, since the note appears away from where focus goes.
  const [carriedSaid, setCarriedSaid] = useState({ text: '', count: 0 });
  const setCarried = (on: boolean, of: ImageValue = latest.current) => {
    // A site image carries no description, and must never clear the flag another field has for the same picture.
    if (plain) return;
    const k = carryKey(of, project, field);
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
  const [over, setOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const browseId = useId();
  const card = useRef<HTMLDivElement>(null);
  const chooseBtn = useRef<HTMLButtonElement>(null);
  const browser = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const closeBrowser = (focus = true) => {
    setBrowsing(false);
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
        // On screen: mounted, and not in a dock tab that is hidden (AI, Site styles) or a closed disclosure (a post's
        // details), which can still give an offset parent.
        shown: () => alive.current && !!chooseBtn.current?.isConnected && chooseBtn.current.offsetParent !== null && chooseBtn.current.checkVisibility(),
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
  // The popover is drawn over the Inspector but is part of this card: drags over it reach these handlers too.
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!over) setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      const to = e.relatedTarget as Node | null;
      if (!e.currentTarget.contains(to) && !browser.current?.contains(to)) setOver(false);
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
  const fallback = picture && !v.assetId && picture.inherited && Object.hasOwn(state.assets.assets, picture.inherited) && state.assets.assets[picture.inherited].kind === 'image' ? state.assets.assets[picture.inherited] : null;
  const shownAsset = asset ?? fallback;
  // Files gone from the project folder while Assets still has the picture: the original (nothing to show), or only
  // some of its smaller copies (the picture still shows, and the site would lose sizes).
  const damage = shownAsset ? snapshot?.missingAssets.find((m) => m.assetId === shownAsset.id) : undefined;
  const fileGone = !!damage?.original;
  const copiesDamaged = !!damage && copiesWrong(damage) === 'damaged';
  const status = gone ? (named ? 'Not an image' : 'Missing') : damage ? (fileGone ? 'Missing' : copiesDamaged ? 'Copy damaged' : 'Copy missing') : null;
  const statusNote = gone ? (named ? 'Choose an image instead.' : 'Choose another image, or remove it.') : damage ? (fileGone ? 'Its file is not in the project folder.' : copiesDamaged ? 'Some of its smaller copies are damaged in the project folder.' : 'Some of its smaller copies are not in the project folder.') : null;
  // Remove takes its own button away: focus that was on it goes to the chooser once the image is gone.
  const removedAt = useRef(0);
  useEffect(() => {
    if (asset || v.assetId || !removedAt.current) return;
    const recent = Date.now() - removedAt.current < MOVE_PENDING_MS;
    removedAt.current = 0;
    const at = document.activeElement;
    if (recent && (!at || at === document.body)) chooseBtn.current?.focus();
  }, [asset, v.assetId]);
  const thing = title ? title.toLowerCase() : 'image';
  const emptyName = picture?.none ?? 'No image chosen';
  const name = shownAsset ? (labels(state, shownAsset.id) ?? shownAsset.name) : gone ? (named ? named.name : 'Removed from Assets') : emptyName;
  return (
    <div
      ref={card}
      className={`insp-image${over ? ' drop-over' : ''}${plain ? ` plain-${plain}` : ''}${shownAsset ? ' filled' : ''}`}
      role={title ? 'group' : undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={title ? [describedBy ?? '', info ? `${titleId}-info` : ''].filter(Boolean).join(' ') || undefined : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && browsing && !e.defaultPrevented) (e.stopPropagation(), closeBrowser());
      }}
      {...(copyOnly ? {} : dropProps)}
    >
      {title &&
        (info ? (
          // Beside the title, not in it: the title names the group.
          <div className="field-head">
            <div className="insp-group-title" id={titleId}>
              {title}
              {mark}
            </div>
            <InfoTip label={title}>{info}</InfoTip>
            <span id={`${titleId}-info`} hidden>
              {info}
            </span>
          </div>
        ) : (
          <div className="insp-group-title" id={titleId}>
            {title}
            {mark}
          </div>
        ))}
      <span className="sr-only" role="status">
        {carriedSaid.text}
      </span>
      <div className="insp-image-top">
        {/* A second way to open the library for a pointer; the button beside it is the one keyboard stop. */}
        <div className={`insp-image-thumb${shownAsset && !fileGone ? '' : ' empty'}`} data-testid={plain ? `${plain}-preview` : undefined} aria-hidden="true" onClick={() => !importing && (browsing ? closeBrowser() : setBrowsing(true))}>
          {shownAsset && devUrl && !fileGone ? <AssetImage key={missingKey(snapshot, shownAsset.id)} asset={shownAsset} devUrl={devUrl} cover={!fitFor(shownAsset).contain} className={fitFor(shownAsset).contain ? 'contain' : undefined} alt="" /> : gone || fileGone ? <ImageOff /> : <ImageIcon />}
        </div>
        <div className="insp-image-body">
          <span className={`insp-image-name${shownAsset || gone ? '' : ' none'}`} id={`${titleId}-now`} title={shownAsset?.name}>
            {name}
          </span>
          {/* Whose image this is, when it is not the field's own. */}
          {fallback && <span className="faint insp-note">{picture!.from}</span>}
          {status && (
            <span className="insp-image-state" id={`${titleId}-state`}>
              <span className="insp-pick-gone">
                <TriangleAlert aria-hidden="true" /> {status}
              </span>
              <span className="insp-image-state-note">{statusNote}</span>
              {damage && snapshot && (
                <button type="button" className="link-btn" onClick={() => showAsset(snapshot.workspaceKey, shownAsset!.id)}>
                  Fix in Assets
                </button>
              )}
            </span>
          )}
          <span className="insp-image-acts">
            {/* A copy editor replaces a picture but never adds one where there is none: that changes the layout. */}
            {(!copyOnly || asset) && <button
              ref={chooseBtn}
              type="button"
              className="btn btn-sm"
              aria-describedby={`${titleId}-now${status ? ` ${titleId}-state` : ''}`}
              aria-haspopup="dialog"
              aria-expanded={browsing}
              aria-controls={browsing ? browseId : undefined}
              onClick={() => (browsing ? closeBrowser(false) : setBrowsing(true))}
              disabled={importing}
            >
              <ImagePlus />
              {importing ? 'Adding…' : asset || gone ? 'Change…' : 'Choose image…'}
            </button>}
            {(asset || gone) && !copyOnly && (
              <button
                type="button"
                className={`btn btn-sm${picture?.inherited ? '' : ' btn-ghost insp-image-remove'}`}
                aria-label={picture ? picture.back : `Remove ${thing}`}
                title={picture ? undefined : `Take the ${thing} out of this field. It stays in Assets.`}
                onClick={() => {
                  if (!picture) setCarried(false);
                  removedAt.current = Date.now();
                  onChange({ assetId: null, alt: latest.current.alt, decorative: latest.current.decorative });
                }}
              >
                {picture ? picture.back : 'Remove'}
              </button>
            )}
          </span>
        </div>
        {over && (
          <div className="insp-image-drop" aria-hidden="true">
            <Upload />
            <b>{shownAsset || gone ? 'Drop to replace this image' : 'Drop to use this image'}</b>
          </div>
        )}
      </div>
      {browsing && (
        <ImageBrowser
          id={browseId}
          box={browser}
          anchor={card}
          trigger={chooseBtn}
          label={title ? `Choose ${title.toLowerCase()}` : 'Choose an image'}
          state={state}
          value={v.assetId}
          importing={importing}
          onImport={copyOnly ? undefined : () => void importAndPick()}
          onPick={(a) => {
            pick(a.id, a.altSuggestion);
            closeBrowser();
          }}
          onClose={closeBrowser}
        />
      )}
      {details && !v.decorative && (
        <Field
          label="Image description"
          hint={
            carried ? (
              // The problem under the field, and its one repair under that: not a box of its own inside the card.
              <span className="insp-check">
                <TriangleAlert aria-hidden="true" />
                Kept from the previous image. Check it still describes this one.
              </span>
            ) : asset && !v.alt.trim() ? (
              'Say what it shows, for screen readers and when it can’t load. Or mark it decorative.'
            ) : (
              'For screen readers, and shown if the image can’t load.'
            )
          }
        >
          <DraftInput
            id={altId}
            multiline
            rows={2}
            className="textarea insp-alt"
            value={v.alt}
            placeholder="What the image shows"
            limit={TEXT_LIMITS.imageAlt}
            keep={home ? `${home.key}|alt` : undefined}
            keepWhile={home?.alive}
            onDirty={(dirty) => {
              if (!dirty) typedOn.current = null;
              else typedOn.current ??= v;
            }}
            onCommit={(alt) => {
              setCarried(false);
              // Built on only when the save will be made: typed on the image shown, with the AI idle.
              if ((!typedOn.current || sameImage(typedOn.current, v)) && !useStore.getState().snapshot?.aiBusy) {
                saving.current = { alt, from: v, field: home?.key };
                latest.current = { ...latest.current, alt };
              }
              onChange({ ...shownNow, alt });
            }}
          />
        </Field>
      )}
      {details && !v.decorative && carried && (
        <button
          type="button"
          className="btn btn-sm insp-image-fits"
          onClick={() => {
            setCarried(false);
            requestAnimationFrame(() => document.getElementById(altId)?.focus());
          }}
        >
          It still fits
        </button>
      )}
      {details && !copyOnly && <SwitchRow checked={!!v.decorative} onChange={(d) => onChange({ ...latest.current, decorative: d })} label="Decorative image" hint={v.decorative ? 'Screen readers skip it, so it needs no description.' : undefined} />}
    </div>
  );
}

const sameImage = (a: ImageValue, b: ImageValue) => a.assetId === b.assetId && a.alt === b.alt && !!a.decorative === !!b.decorative;

/** An image's name as the library shows it (with its ID when another image has the same name). */
const labels = (state: ProjectState, id: string) => {
  const images = Object.values(state.assets.assets).filter((a) => a.kind === 'image');
  const own = assetLabels(images).get(id);
  const twin = twinDetails(images).get(id);
  return own && twin ? `${own.name} (${twin})` : own?.label;
};
const added = (iso: string, time: boolean) => {
  const d = new Date(iso);
  const day = `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })}`;
  return `added ${day}${time ? `, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}`;
};
/**
 * What tells pictures with the same name apart, in the author's terms, for each picture that shares its name: the file
 * it came from, else the day it was added (a starter sample or a copy made in Assets has no file of the author's), with
 * the time when that is shared too, and its ID only when nothing else differs. The day comes first, so it survives.
 */
function twinDetails(images: readonly AssetRecord[]): Map<string, string> {
  const named = assetLabels(images);
  const groups = new Map<string, AssetRecord[]>();
  for (const a of images) {
    const n = named.get(a.id);
    if (!n || n.label === n.name) continue;
    const k = n.name.toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out = new Map<string, string>();
  const unique = (group: AssetRecord[], detail: (a: AssetRecord) => string) => {
    const seen = new Map<string, number>();
    for (const a of group) seen.set(detail(a), (seen.get(detail(a)) ?? 0) + 1);
    return (a: AssetRecord) => seen.get(detail(a)) === 1;
  };
  for (const group of groups.values()) {
    const first = (a: AssetRecord) => a.originalName || added(a.createdAt, false);
    const second = (a: AssetRecord) => (a.originalName ? `${a.originalName}, ${added(a.createdAt, true)}` : added(a.createdAt, true));
    const once = unique(group, first);
    const twice = unique(group, second);
    for (const a of group) out.set(a.id, once(a) ? first(a) : twice(a) ? second(a) : `${second(a)} · ${a.id}`);
  }
  return out;
}

/**
 * The image library for one image field, in a popover under the card: search past six pictures, the order and series
 * shared with Assets, Import, and the pictures as one listbox (arrow keys move, Enter or a click chooses). It opens on
 * the search, else the chosen or first picture, else Import, with the chosen picture in view; Escape, a press
 * elsewhere, or tabbing past either end puts it away. A picture whose file is gone says so and can't be chosen.
 */
function ImageBrowser({ id, box, anchor, trigger, label, state, value, importing, onImport, onPick, onClose }: { id: string; box: React.RefObject<HTMLDivElement | null>; anchor: React.RefObject<HTMLDivElement | null>; trigger: React.RefObject<HTMLButtonElement | null>; label: string; state: ProjectState; value: string | null; importing: boolean; /** Absent where nothing may be added to the library (a copy editor's field). */ onImport?: () => void; onPick: (a: AssetRecord) => void; onClose: (focus?: boolean) => void }) {
  const runtime = useStore((s) => s.runtime);
  const snapshot = useStore((s) => s.snapshot);
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const grid = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  // In the order Assets lists them, and changing the order here changes it there.
  const assetSort = useStore((s) => s.assetSort);
  const all = state.assets.assets;
  const images = useMemo(() => sortAssets(Object.values(all).filter((a) => a.kind === 'image'), assetSort), [all, assetSort]);
  const names = useMemo(() => assetLabels(images), [images]);
  const twins = useMemo(() => twinDetails(images), [images]);
  const series = useAssetSeries(images, snapshot?.workspaceKey);
  const needle = q.trim().toLowerCase();
  // What tells two same-named pictures apart is searched too, as it is shown.
  const shown = images.filter((a) => (!series.key || inSeries(a, series.key)) && (!needle || `${a.name} ${twins.get(a.id) ?? ''} ${a.description ?? ''} ${a.altSuggestion ?? ''}`.toLowerCase().includes(needle)));
  const searchable = images.length > 6 || !!q;
  // The grid's one tab stop: the tile last moved to while it is still shown, else the image chosen, else the first.
  const [rover, setRover] = useState<string | null>(null);
  const tabStop = shown.some((a) => a.id === rover) ? rover : shown.some((a) => a.id === value) ? value : (shown[0]?.id ?? null);
  // The grid draws only the rows in and near its view (#973), and always the Tab stop's and the chosen image's.
  const gridApi = useRef<WindowedGridApi | null>(null);
  const chosenAt = shown.findIndex((a) => a.id === value);
  const damageOf = (assetId: string) => snapshot?.missingAssets.find((m) => m.assetId === assetId);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight?: number; minHeight?: number } | null>(null);
  const natural = useRef(0);
  // The side it opened on and its height then, kept while a search changes what it holds, so the search box never moves
  // under the typing (above the card it keeps its opening size, standing on the card); a resized window starts again.
  const side = useRef<'under' | 'over' | null>(null);
  const opened = useRef(0);
  // Pictures above the grid's top edge: the controls over it take a hairline and a soft lift (as the icon picker's do),
  // so a row cut there reads as more to scroll to, and no picture or focus ring is dimmed.
  const [cut, setCut] = useState(false);
  const measure = () => setCut(!!grid.current && grid.current.scrollTop > 1);

  // The editor's own shortcuts stay out of the way while it is open, as for a menu.
  useEffect(() => {
    openMenus.count++;
    return () => void openMenus.count--;
  }, []);
  // A press anywhere else, or focus going into the preview frame, puts it away; the trigger toggles it itself.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      if (t && !box.current?.contains(t) && !trigger.current?.contains(t) && !(t instanceof Element && t.closest('.insp-image-thumb') && anchor.current?.contains(t))) onClose(false);
    };
    const intoFrame = () => setTimeout(() => document.activeElement instanceof HTMLIFrameElement && onClose(false));
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', intoFrame);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', intoFrame);
    };
  });
  // Under the card's picture row, as wide as the card (236 to 440px), or above it when it only fits there; in a window
  // too short for either it takes the roomier side and its grid shrinks. It follows the card as the Inspector scrolls,
  // and goes when Change scrolls out of view.
  useLayoutEffect(() => {
    const place = () => {
      const el = box.current;
      const c = anchor.current?.getBoundingClientRect();
      const row = anchor.current?.querySelector('.insp-image-top')?.getBoundingClientRect();
      if (!el || !c || !row) return;
      const width = Math.round(Math.min(Math.max(c.width, 236), 440, window.innerWidth - 16));
      if (!el.style.maxHeight && !el.style.minHeight) natural.current = el.offsetHeight;
      const h = natural.current;
      const below = window.innerHeight - row.bottom - 14;
      const above = row.top - 14;
      if (!side.current) {
        side.current = h <= below || (h > above && below >= above) ? 'under' : 'over';
        opened.current = h;
      }
      const under = side.current === 'under';
      const room = under ? below : above;
      const tall = under ? h : Math.max(h, opened.current);
      const maxHeight = tall > room ? Math.max(200, room) : undefined;
      const minHeight = under ? undefined : (maxHeight ?? tall);
      const top = under ? row.bottom + 6 : row.top - 6 - (maxHeight ?? tall);
      const left = Math.max(8, Math.min(c.left, window.innerWidth - width - 8));
      setPos((p) => (p && p.left === left && p.top === top && p.width === width && p.maxHeight === maxHeight && p.minHeight === minHeight ? p : { left, top, width, maxHeight, minHeight }));
    };
    const resized = () => {
      side.current = null;
      place();
    };
    const scrolled = (e: Event) => {
      if (e.target instanceof Node && box.current?.contains(e.target)) return;
      const a = trigger.current?.getBoundingClientRect();
      const at = a && document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
      if (!at || !(trigger.current?.contains(at) || box.current?.contains(at))) onClose(false);
      else place();
    };
    place();
    window.addEventListener('resize', resized);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      window.removeEventListener('resize', resized);
      document.removeEventListener('scroll', scrolled, true);
    };
  });
  // Opens on whole rows with the chosen picture in view (a cut row only at the bottom, where it reads as more), and
  // focus on the first useful thing: once it has its place and size, since a short window shrinks the grid.
  const revealed = useRef(false);
  // Until it has opened on the chosen image, the rows up to a full view above it are drawn too (the grid is never more
  // than 312px tall, a row at least 60px), so it can open on whole rows with that image on the last.
  const opening = revealed.current || chosenAt < 0 ? [] : Array.from({ length: 6 }, (_, k) => chosenAt - 3 * (k + 1));
  useLayoutEffect(() => {
    if (!pos || revealed.current) return;
    revealed.current = true;
    const g = grid.current;
    const tile = g?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (g && tile) {
      // The rows a view above the chosen image are drawn while it opens (see `opening`), so this finds its whole row.
      const rows = [...new Set([...g.querySelectorAll<HTMLElement>('[role="option"]')].map((t) => t.offsetTop))].sort((a, b) => a - b);
      const top = rows.find((r) => r + g.clientHeight >= tile.offsetTop + tile.offsetHeight + 2) ?? tile.offsetTop;
      g.scrollTop = Math.max(0, top - 2);
    }
    measure();
    (search.current ?? g?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? box.current?.querySelector<HTMLElement>('.insp-image-import'))?.focus({ preventScroll: true });
  }, [pos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clears the words only: a series chosen stays chosen, and says so in the result line.
  const clear = () => {
    setQ('');
    search.current?.focus();
  };
  const noMatch = q.trim() ? `No images ${series.key ? `in ${series.label} ` : ''}match “${q.trim()}”.` : `No images in ${series.label}.`;
  return createPortal(
    <div
      ref={box}
      id={id}
      className="insp-image-pop"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={pos ?? { left: 0, top: 0, width: 300, opacity: 0 }}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        // Tabbing or clicking away puts it away; the trigger is part of it.
        if (to && !e.currentTarget.contains(to) && !trigger.current?.contains(to)) onClose(false);
      }}
      onKeyDown={(e) => {
        // Tab past either end goes on from the trigger, so focus continues through the form rather than from the end
        // of the document, where the popover is drawn.
        if (e.key === 'Tab') {
          const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('input, select, button:not([tabindex="-1"]):not(:disabled), [role="option"][tabindex="0"]')];
          const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
          if (document.activeElement !== edge && document.activeElement !== e.currentTarget) return;
          if (e.shiftKey) e.preventDefault();
          trigger.current?.focus();
          onClose(false);
          return;
        }
        if (e.key !== 'Escape' || e.defaultPrevented || isImeComposing(e)) return;
        e.preventDefault();
        e.stopPropagation();
        // One Escape closes from anywhere in it, as the icon picker's does; Clear search and the field's own × clear words.
        onClose(true);
      }}
    >
      <div className={`insp-image-pop-head${cut ? ' lifted' : ''}`}>
        <div className="insp-pick-tools">
          {/* Kept while a search is typed, so it can always be cleared. */}
          {searchable && (
            <input
              ref={search}
              type="search"
              className="input sm grow"
              placeholder="Search images"
              aria-label="Search images"
              value={q}
              onChange={(e) => (setQ(e.target.value), setRover(null))}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowDown' || isImeComposing(e)) return;
                e.preventDefault();
                grid.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
              }}
            />
          )}
          {onImport && (
            <button type="button" className="btn btn-sm insp-image-import" onClick={() => !importing && onImport()} aria-disabled={importing || undefined}>
              <Plus /> {importing ? 'Adding…' : 'Import…'}
            </button>
          )}
        </div>
        {/* Kept while a series is chosen, so it can always be cleared. */}
        {(images.length > 6 || !!series.key) && <AssetOrderControls series={series.list} value={series.key} onSeries={series.choose} />}
      </div>
      {shown.length > 0 ? (
        <WindowedGrid
          gridRef={grid}
          api={gridApi}
          className="insp-pick-grid"
          role="listbox"
          aria-label="Your images"
          onScroll={measure}
          onKeyDown={(e) => windowedPickKeys(e, shown.length, 3, gridApi, (to) => setRover(shown[to]?.id ?? null))}
          count={shown.length}
          keep={[shown.findIndex((a) => a.id === tabStop), chosenAt, ...opening]}
          // The rows measured hold while the same images are shown.
          layoutKey={JSON.stringify([needle, series.key, assetSort])}
          tile={(i) => {
            const a = shown[i];
            const hurt = damageOf(a.id);
            const current = a.id === value;
            // A picture whose file is gone can't be chosen here; the one already chosen keeps its place and says so.
            const blocked = !!hurt?.original && !current;
            const twin = twins.get(a.id);
            const shownName = twin ? `${names.get(a.id)?.name ?? a.name} (${twin})` : (names.get(a.id)?.name ?? a.name);
            const why = hurt ? (hurt.original ? 'its file is missing, so fix it in Assets first' : `some of its smaller copies are ${copiesWrong(hurt)}`) : '';
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={current}
                aria-disabled={blocked || undefined}
                aria-label={why ? `${shownName}: ${why}` : shownName}
                aria-posinset={i + 1}
                aria-setsize={shown.length}
                tabIndex={a.id === tabStop ? 0 : -1}
                className={`insp-pick-tile${current ? ' current' : ''}`}
                title={why ? `${shownName}: ${why}` : shownName}
                onFocus={() => setRover(a.id)}
                onClick={() => !blocked && onPick(a)}
              >
                {hurt?.original || !devUrl ? (
                  <span className="insp-pick-frame" aria-hidden="true">
                    <ImageOff />
                  </span>
                ) : (
                  <AssetImage key={missingKey(snapshot, a.id)} asset={a} devUrl={devUrl} cover={!fitFor(a).contain} className={fitFor(a).contain ? 'contain' : undefined} alt="" loading="lazy" />
                )}
                <span className="insp-pick-name" aria-hidden="true">
                  {shortName(names.get(a.id)?.name ?? a.name, 22)}
                </span>
                {/* Another image has this name: the file it came from, or when it was added, on a line of its own. */}
                {twin && (
                  // Shortened in the middle, so a file name keeps the ending that tells it from its twin.
                  <span className="insp-pick-id insp-image-twin" aria-hidden="true">
                    {shortName(twin, 30)}
                  </span>
                )}
                {hurt && (
                  <span className="insp-pick-gone" aria-hidden="true">
                    <TriangleAlert /> {hurt.original ? 'Missing' : `Copy ${copiesWrong(hurt)}`}
                  </span>
                )}
              </button>
            );
          }}
        />
      ) : images.length ? (
        <div className="insp-pick-nomatch">
          <p className="faint insp-note insp-image-echo">{noMatch}</p>
          {needle && (
            <button type="button" className="btn btn-sm" onClick={clear}>
              Clear search
            </button>
          )}
        </div>
      ) : (
        <p className="insp-note insp-image-none">No images in Assets yet.</p>
      )}
      {/* Mounted with the browser, so each search's result is announced as it changes. */}
      <p className={(needle || series.key) && shown.length ? 'faint insp-note insp-pick-result' : 'sr-only'} role="status">
        {needle || series.key ? (shown.length ? `${shown.length} of ${images.length} ${images.length === 1 ? 'image' : 'images'}${series.key ? ` · ${series.label}` : ''}` : noMatch) : ''}
      </p>
      <p className="insp-image-pop-foot">
        <Upload aria-hidden="true" /> Or drop an image file here to use it.
      </p>
    </div>,
    document.body
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

/** Names that read better than the icon's file name. */
const ICON_LABELS: Record<string, string> = {
  'building-2': 'Building',
  'flower-2': 'Flower',
  'circle-check': 'Check in a circle',
  'badge-check': 'Verified badge',
  'shield-check': 'Shield with a check',
  'chart-line': 'Line chart',
  'pen-tool': 'Pen',
  'map-pin': 'Location pin',
  'message-circle': 'Speech bubble',
  'layout-grid': 'Grid',
  'book-open': 'Open book',
  'chevron-down': 'Chevron',
  utensils: 'Knife and fork',
  zap: 'Lightning',
  x: 'Cross',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  github: 'GitHub',
  'x-twitter': 'X (Twitter)'
};
const iconName = (k: string) => ICON_LABELS[k] ?? sentence(k.replace(/-/g, ' '));

/** Words people search with for what an icon means, beside its name. */
const ICON_WORDS: Record<string, string> = {
  'arrow-right': 'next go forward continue more',
  'arrow-up-right': 'external link visit open out',
  check: 'tick yes done included',
  'circle-check': 'tick yes done complete success included',
  'badge-check': 'verified certified approved accredited qualified',
  star: 'rating review favorite featured quality',
  heart: 'love like favorite care wellbeing wedding',
  leaf: 'eco green organic natural sustainable environment plant',
  house: 'home residential property real estate family',
  'building-2': 'office company commercial business apartment',
  hammer: 'build construction builder carpentry carpenter repair renovation handyman',
  wrench: 'repair fix maintenance service plumber plumbing mechanic tools handyman',
  paintbrush: 'paint painter decorating decorator',
  palette: 'color art design creative',
  'pen-tool': 'design illustration graphic vector write edit pencil',
  ruler: 'measure plan drawing architect design',
  sparkles: 'new magic special clean cleaning shine spa beauty',
  sun: 'summer day light weather solar',
  moon: 'night evening sleep',
  'shield-check': 'secure security safe safety protection insurance guarantee trust',
  clock: 'time hours opening',
  calendar: 'date booking appointment schedule event diary',
  phone: 'call telephone mobile contact',
  mail: 'email envelope message contact newsletter inbox',
  'map-pin': 'location address place directions find map visit',
  'message-circle': 'chat talk comment speech message support help question faq',
  users: 'team people staff group community clients family',
  user: 'person profile account customer',
  briefcase: 'work job career business professional services',
  'chart-line': 'growth graph results analytics stats finance accounting sales',
  target: 'goal aim focus mission',
  lightbulb: 'idea tip advice insight innovation',
  rocket: 'launch startup fast growth',
  compass: 'direction navigation explore planning strategy guide',
  camera: 'photo photography photographer',
  image: 'picture photo gallery',
  coffee: 'cafe drink tea break cup',
  gift: 'present voucher offer',
  globe: 'world web website international online',
  lock: 'secure private password privacy',
  zap: 'fast speed quick energy power electric electrician',
  award: 'prize winner certificate quality',
  handshake: 'partnership deal agreement trust welcome',
  'thumbs-up': 'like approve good recommend',
  scissors: 'cut hair salon barber hairdresser tailor',
  truck: 'delivery shipping transport removals moving van',
  stethoscope: 'health medical doctor clinic care',
  'graduation-cap': 'education school study training course learn',
  layers: 'stack levels',
  'layout-grid': 'apps gallery dashboard',
  quote: 'testimonial review quotation',
  plus: 'add more',
  minus: 'remove less',
  menu: 'hamburger list',
  x: 'close cancel no',
  'chevron-down': 'expand more down',
  sofa: 'furniture interior living room couch',
  trees: 'forest garden landscaping outdoors park',
  'flower-2': 'florist garden plant spring spa beauty wedding',
  dumbbell: 'fitness gym exercise workout training',
  utensils: 'food restaurant dining eat menu kitchen chef cook',
  music: 'audio song sound band',
  'book-open': 'read learn guide library story',
  code: 'developer software programming web',
  'heart-handshake': 'care support charity volunteer community',
  instagram: 'social',
  facebook: 'social',
  linkedin: 'social',
  youtube: 'social video',
  github: 'social code',
  'x-twitter': 'social twitter tweet'
};

/** Symbols typed into the search that name an icon. */
const ICON_SYMBOLS: Record<string, string[]> = {
  '+': ['plus'],
  '-': ['minus'],
  '−': ['minus'],
  '×': ['x'],
  '→': ['arrow-right'],
  '->': ['arrow-right'],
  '↗': ['arrow-up-right'],
  '✓': ['check', 'circle-check'],
  '✔': ['check', 'circle-check'],
  '*': ['star'],
  '★': ['star'],
  '♥': ['heart'],
  '❤': ['heart'],
  '@': ['mail'],
  '"': ['quote'],
  '“': ['quote'],
  '<>': ['code'],
  '</>': ['code']
};

/** The icons in browsing order, grouped by what they are for; any icon not named here is listed last. */
const ICON_GROUPS: { name: string; icons: string[] }[] = (() => {
  const groups = [
    { name: 'Business', icons: ['briefcase', 'chart-line', 'target', 'lightbulb', 'rocket', 'compass', 'award', 'badge-check', 'shield-check', 'lock', 'zap', 'handshake', 'heart-handshake'] },
    { name: 'Contact and places', icons: ['phone', 'mail', 'message-circle', 'map-pin', 'globe', 'clock', 'calendar', 'users', 'user', 'house', 'building-2'] },
    { name: 'Trades and making', icons: ['hammer', 'wrench', 'paintbrush', 'palette', 'pen-tool', 'ruler', 'scissors', 'truck', 'sofa', 'camera', 'image'] },
    { name: 'Life and nature', icons: ['leaf', 'trees', 'flower-2', 'sun', 'moon', 'coffee', 'utensils', 'gift', 'music', 'dumbbell', 'stethoscope', 'graduation-cap', 'book-open'] },
    { name: 'Marks and shapes', icons: ['star', 'heart', 'thumbs-up', 'sparkles', 'quote', 'check', 'circle-check', 'arrow-right', 'arrow-up-right', 'plus', 'minus', 'x', 'chevron-down', 'menu', 'layers', 'layout-grid', 'code'] },
    { name: 'Social', icons: ['instagram', 'facebook', 'linkedin', 'youtube', 'github', 'x-twitter'] }
  ].map((g) => ({ ...g, icons: g.icons.filter((k) => Object.hasOwn(ICONS, k)) }));
  const grouped = new Set(groups.flatMap((g) => g.icons));
  const rest = Object.keys(ICONS).filter((k) => !grouped.has(k));
  return rest.length ? [...groups, { name: 'More', icons: rest }] : groups;
})();
const ICON_ORDER = ICON_GROUPS.flatMap((g) => g.icons);

/**
 * Icons for a search: every word must start a word of the icon's name or of what it means. The icon the query names
 * exactly comes first (Enter takes it), then other name matches, then matches by meaning.
 */
function searchIcons(query: string): string[] {
  // Emoji and text presentation selectors are dropped, so a pasted ❤️ is the ❤ it shows.
  const typed = query.replace(/[\uFE0E\uFE0F]/g, '').trim();
  const words = typed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!typed) return ICON_ORDER;
  // A symbol on its own finds the icon that draws it, and nothing else.
  if (!words.length) return (ICON_SYMBOLS[typed] ?? []).filter((k) => Object.hasOwn(ICONS, k));
  const whole = words.join(' ');
  // A word is also its singular ("arrows", "boxes"), so a plural finds what the word does.
  const forms = words.map((w) => [w, ...(w.length > 3 && w.endsWith('s') ? [w.slice(0, -1)] : []), ...(w.length > 4 && w.endsWith('es') ? [w.slice(0, -2)] : [])]);
  const ranked: [string, number][] = [];
  for (const k of ICON_ORDER) {
    const label = iconName(k).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const named = [...k.split('-'), ...label];
    const meant = (ICON_WORDS[k] ?? '').split(' ');
    // Each word is ranked by its best match: a whole word of the name, then a whole word of the meaning, then the
    // start of a word in either; the icon ranks by its weakest word. "care" finds care before career.
    const rank = (f: string[]) =>
      named.some((p) => f.includes(p)) ? 1 : meant.some((p) => f.includes(p)) ? 2 : named.some((p) => p.startsWith(f[0])) ? 3 : meant.some((p) => p.startsWith(f[0])) ? 4 : 0;
    const ranks = forms.map(rank);
    if (label.join(' ') === whole || k.replace(/-/g, ' ') === whole) ranked.push([k, 0]);
    else if (ranks.every(Boolean)) ranked.push([k, Math.max(...ranks)]);
  }
  return ranked.sort((a, b) => a[1] - b[1]).map(([k]) => k);
}

/** The option a 2D arrow key moves to: the next or previous tile in reading order, or the nearest one in the row above or below. */
function iconStep(tiles: HTMLElement[], from: HTMLElement, key: string): HTMLElement | null {
  const i = tiles.indexOf(from);
  if (key === 'ArrowRight') return tiles[i + 1] ?? null;
  if (key === 'ArrowLeft') return tiles[i - 1] ?? null;
  if (key === 'Home') return tiles[0] ?? null;
  if (key === 'End') return tiles[tiles.length - 1] ?? null;
  const down = key === 'ArrowDown';
  const at = from.getBoundingClientRect();
  const boxes = tiles.map((t) => [t, t.getBoundingClientRect()] as const);
  const rows = boxes.map(([, r]) => r.top).filter((top) => (down ? top > at.top + 2 : top < at.top - 2));
  if (!rows.length) return null;
  const row = down ? Math.min(...rows) : Math.max(...rows);
  const middle = at.left + at.width / 2;
  let best: HTMLElement | null = null;
  let gap = Infinity;
  for (const [t, r] of boxes) {
    const d = Math.abs(r.left + r.width / 2 - middle);
    if (Math.abs(r.top - row) < 2 && d < gap) (best = t), (gap = d);
  }
  return best;
}

/**
 * The icon control: a field showing the current icon, which opens a popover over the Inspector (so the fields under it
 * stay where they are) with a search box and every icon drawn as it will look, grouped by what it is for. Search
 * matches names and what icons mean ("email" finds Mail). The icons are one tab stop: arrow keys move, Enter or a
 * click chooses, Escape closes; a press or focus anywhere else puts it away.
 */
export function IconPicker({ value, onChange, label = 'Icon', id, describedBy }: { value: string; onChange: (v: string) => void; label?: string; id?: string; describedBy?: string }) {
  const [open, setOpen] = useState(false);
  const popId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) requestAnimationFrame(() => btn.current?.focus());
  };
  return (
    <div className="insp-icon-picker">
      <button
        ref={btn}
        type="button"
        className="input insp-icon-btn"
        id={id}
        aria-describedby={[describedBy, id ? `${popId}-cur` : undefined].filter(Boolean).join(' ') || undefined}
        aria-label={id ? undefined : `${label}: ${iconName(value)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span className="insp-icon-swatch" aria-hidden="true">
          <IconGlyph name={value} size={16} />
        </span>
        <span className="grow ellipsis" id={`${popId}-cur`}>
          {Object.hasOwn(ICONS, value) ? iconName(value) : 'Choose an icon'}
        </span>
        <ChevronDown aria-hidden="true" className="faint" />
      </button>
      {open && (
        <IconPopover
          id={popId}
          value={value}
          label={label}
          trigger={btn}
          onClose={close}
          onPick={(k) => {
            if (k !== value) onChange(k);
            close(true);
          }}
        />
      )}
    </div>
  );
}

function IconPopover({ id, value, label, trigger, onPick, onClose }: { id: string; value: string; label: string; trigger: React.RefObject<HTMLButtonElement | null>; onPick: (k: string) => void; onClose: (focus: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  // The icons' one tab stop: the tile last moved to while it is still shown.
  const [rover, setRover] = useState<string | null>(null);
  // Pointed at and focused are kept apart, so the footer never names one while Enter would take the other.
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [inSearch, setInSearch] = useState(true);
  // Once something has been searched, clearing it announces the whole set again.
  const [searched, setSearched] = useState(false);
  // More of the list past an edge: the fixed part beside that edge takes a hairline and a soft lift, as in the Share
  // popover, so groups under the fold are not taken as missing and no icon is dimmed.
  const [edges, setEdges] = useState({ above: false, below: false });
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight?: number } | null>(null);
  // The popover's full height, measured while nothing caps it, and where the pointer last was.
  const natural = useRef(0);
  const pointer = useRef('');
  const query = q.trim();
  const shown = useMemo(() => searchIcons(query), [query]);
  const tabStop = rover && shown.includes(rover) ? rover : query || !shown.includes(value) ? shown[0] : value;
  // While searching, the first result is what Enter in the search box takes, and it is marked as such.
  const next = query && inSearch ? shown[0] : undefined;
  const named = hovered ?? focused ?? next ?? value;
  // What Enter takes right now: the focused icon, or the first result from the search field.
  const target = focused ?? next;

  // The editor's own shortcuts stay out of the way while it is open, as for a menu.
  useEffect(() => {
    openMenus.count++;
    return () => void openMenus.count--;
  }, []);
  // A press anywhere else, or focus going into the preview frame, puts it away; the trigger toggles it itself.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      if (t && !box.current?.contains(t) && !trigger.current?.contains(t)) onClose(false);
    };
    const intoFrame = () => setTimeout(() => document.activeElement instanceof HTMLIFrameElement && onClose(false));
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', intoFrame);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', intoFrame);
    };
  });
  // Under the trigger, its left edge with the trigger's, or above it when it only fits there. In a window too short for
  // either, it takes the roomier side and its list shrinks to fit, so it never covers its own trigger. It follows the
  // trigger as the Inspector scrolls.
  useLayoutEffect(() => {
    const place = () => {
      const el = box.current;
      const a = trigger.current?.getBoundingClientRect();
      if (!el || !a) return;
      const width = Math.round(Math.min(Math.max(a.width, 236), 440, window.innerWidth - 16));
      if (!el.style.maxHeight) natural.current = el.offsetHeight;
      const h = natural.current;
      const below = window.innerHeight - a.bottom - 14;
      const above = a.top - 14;
      const under = h <= below || (h > above && below >= above);
      const room = under ? below : above;
      const maxHeight = h > room ? Math.max(160, room) : undefined;
      const top = under ? a.bottom + 6 : a.top - 6 - (maxHeight ?? h);
      const left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8));
      setPos((p) => (p && p.left === left && p.top === top && p.width === width && p.maxHeight === maxHeight ? p : { left, top, width, maxHeight }));
    };
    // Scrolled away, or under the Inspector's sticky head, the trigger is gone from view and the popover goes with it.
    const scrolled = (e: Event) => {
      if (e.target instanceof Node && box.current?.contains(e.target)) return;
      const a = trigger.current?.getBoundingClientRect();
      const at = a && document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
      if (!at || !(trigger.current?.contains(at) || box.current?.contains(at))) onClose(false);
      else place();
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', scrolled, true);
    };
  });
  // Opens with the current icon's row in the middle of the list.
  useLayoutEffect(() => {
    const l = list.current;
    const tile = l?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (l && tile) l.scrollTop = tile.offsetTop - (l.clientHeight - tile.offsetHeight) / 2;
  }, []);
  const measure = () => {
    const l = list.current;
    const above = !!l && l.scrollTop > 1;
    const below = !!l && l.scrollTop + l.clientHeight < l.scrollHeight - 2;
    setEdges((e) => (e.above === above && e.below === below ? e : { above, below }));
  };
  useLayoutEffect(measure, [query]);

  const go = (tile: HTMLElement | null | undefined) => {
    if (!tile) return;
    // A key press is the latest thing the user did: a pointer parked over another tile no longer names it.
    setHovered(null);
    setRover(tile.dataset.icon ?? null);
    tile.focus();
    tile.scrollIntoView({ block: 'nearest' });
  };
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const from = e.target as HTMLElement;
    if (from.getAttribute('role') !== 'option') return;
    // Typing while on an icon goes on with the search.
    if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) return search.current?.focus();
    if (e.key === 'Backspace') {
      e.preventDefault();
      setQ((v) => v.slice(0, -1));
      setRover(null);
      setHovered(null);
      return search.current?.focus();
    }
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const to = iconStep([...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')], from, e.key);
    if (to) go(to);
    else if (e.key === 'ArrowUp') search.current?.focus();
  };
  const tile = (k: string) => (
    <button
      key={k}
      type="button"
      role="option"
      data-icon={k}
      aria-selected={k === value}
      aria-label={iconName(k)}
      tabIndex={k === tabStop ? 0 : -1}
      className={`insp-icon-tile${k === value ? ' current' : ''}${k === (hovered ?? next) ? ' pointed' : ''}`}
      onFocus={() => (setFocused(k), setHovered(null))}
      onMouseMove={(e) => {
        // Only a pointer that moved points: the move Chromium sends when a key scrolls tiles under a still pointer is not.
        const at = `${e.clientX},${e.clientY}`;
        if (at === pointer.current) return;
        pointer.current = at;
        if (hovered !== k) setHovered(k);
      }}
      onMouseLeave={() => setHovered(null)}
      onClick={() => onPick(k)}
    >
      <IconGlyph name={k} size={20} />
      {few && <span className="ellipsis">{iconName(k)}</span>}
    </button>
  );
  const count = shown.length === 1 ? '1 icon' : `${shown.length} icons`;
  // A search down to a few icons names each one beside its glyph, so none has to be pointed at to be told apart.
  const few = !!query && shown.length <= 3;

  return createPortal(
    <div
      ref={box}
      id={id}
      className="insp-icon-pop"
      role="dialog"
      aria-label={`Choose ${label === 'Icon' ? 'an icon' : label}`}
      tabIndex={-1}
      style={pos ?? { left: 0, top: 0, width: 300, opacity: 0 }}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        // Tabbing or clicking away puts it away; the trigger is part of it.
        if (to && !e.currentTarget.contains(to) && !trigger.current?.contains(to)) onClose(false);
      }}
      onKeyDown={(e) => {
        // Tab past either end goes on from the trigger, so focus continues through the form rather than from the end
        // of the document, where the popover is drawn: forward to the next field, backward onto the trigger itself.
        if (e.key === 'Tab') {
          const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('input, [role="option"][tabindex="0"], .insp-icon-empty button')];
          const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
          if (document.activeElement !== edge && document.activeElement !== e.currentTarget) return;
          if (e.shiftKey) e.preventDefault();
          trigger.current?.focus();
          onClose(false);
          return;
        }
        if (e.key !== 'Escape' || e.defaultPrevented || isImeComposing(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      }}
    >
      <div className={`insp-icon-head${edges.above ? ' lifted' : ''}`}>
        <input
          ref={search}
          type="search"
          className="input sm insp-icon-search"
          placeholder="Search icons"
          aria-label="Search icons"
          value={q}
          autoFocus
          onFocus={() => setInSearch(true)}
          onBlur={() => setInSearch(false)}
          onChange={(e) => (setQ(e.target.value), setRover(null), setHovered(null), setSearched(true))}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              go(list.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]'));
            } else if (e.key === 'Enter' && next) {
              e.preventDefault();
              onPick(next);
            }
          }}
        />
      </div>
      {shown.length ? (
        <div
          ref={list}
          className="insp-icon-list"
          role="listbox"
          aria-label={label}
          onKeyDown={keys}
          onScroll={measure}
          // A wheel moves the list on purpose, so the icon then under the still pointer is pointed at.
          onWheel={() => (pointer.current = '')}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(null)}
        >
          {query ? (
            <div className={`insp-icon-grid${few ? ' few' : ''}`}>{shown.map(tile)}</div>
          ) : (
            ICON_GROUPS.map((g, i) => (
              <div key={g.name} className="insp-icon-group" role="group" aria-labelledby={`${id}-g${i}`}>
                <div className="insp-icon-group-name" id={`${id}-g${i}`}>
                  {g.name}
                </div>
                <div className="insp-icon-grid">{g.icons.map(tile)}</div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="insp-icon-empty">
          <p className="insp-icon-echo">No icons match “{query}”.</p>
          <p className="faint">Try a word for what it shows, like phone, team or delivery.</p>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setQ('');
              setHovered(null);
              search.current?.focus();
            }}
          >
            Clear search
          </button>
        </div>
      )}
      {/* Names the icon pointed at, moved to, or that Enter would take; each tile already names itself to assistive tech. */}
      <div className={`insp-icon-foot${edges.below && shown.length ? ' lifted' : ''}`} aria-hidden="true">
        <IconGlyph name={named} size={16} />
        <span className="grow ellipsis">{iconName(named)}</span>
        {target && named !== target ? (
          // Pointing at one icon while Enter would take another: the footer says which Enter takes.
          <span className="insp-icon-note">Enter picks {iconName(target)}</span>
        ) : named === value ? (
          <span className="insp-icon-note">Current</span>
        ) : next && named === next ? (
          <span className="insp-icon-note">Enter to choose</span>
        ) : null}
      </div>
      {/* Mounted with the popover, so each search's result, and what Enter would choose, is announced. */}
      <span className="sr-only" role="status">
        {query ? (shown.length ? `${count}. Enter chooses ${iconName(shown[0])}.` : `No icons match “${query}”.`) : searched ? `All ${ICON_ORDER.length} icons.` : ''}
      </span>
    </div>,
    document.body
  );
}

/**
 * A number property's field. Text that is not a number in range ("12px") is never sent: it stays in the field with
 * the reason under it until it is corrected or put back with Escape. An emptied field sends nothing, and the saved
 * value comes back. The reason belongs to this field alone, so it goes with it.
 */
function NumberInput({ schema, value, onChange, id, describedBy, invalid, ariaLabel }: { schema: NumberProp; value: unknown; onChange: (v: unknown, edit?: PendingEdit) => unknown; id?: string; describedBy?: string; invalid?: boolean; ariaLabel?: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = `${useId()}-problem`;
  return (
    <>
      <DraftInput
        id={id}
        aria-describedby={[problem ? problemId : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined}
        aria-invalid={invalid || !!problem || undefined}
        value={String(value ?? schema.default)}
        check={(t) => {
          const read = readNumberDraft(t, schema);
          return 'problem' in read ? { message: read.problem } : null;
        }}
        onProblem={(p) => setProblem(p?.message ?? null)}
        // Checked against the property as it is when the field is left (see check); here only that it is a number,
        // since a commit made after the AI ran is the one built when typing began, and the engine checks the range.
        onCommit={(t, edit) => {
          const read = readNumberDraft(t);
          return 'value' in read ? onChange(read.value, edit) : 'empty' in read ? undefined : false;
        }}
        ariaLabel={ariaLabel}
      />
      {problem && (
        <div className="field-error" id={problemId} role="alert">
          {problem}
        </div>
      )}
    </>
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
      return <NumberInput schema={schema} value={value} onChange={onChange} id={id} describedBy={describedBy} invalid={invalid} ariaLabel={name} />;
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
  // A label being typed when a live session ends is offered back to copy (see registerUnsent).
  useEffect(
    () =>
      registerUnsent(() => {
        const over = from.current;
        const text = choiceText(draftRef.current);
        return over && text && text !== over.shown ? { key: draftKey, label: `Edit choice “${over.shown}”`, text } : null;
      }),
    [draftKey]
  );
  // The field closes (its question was collapsed or removed) with a label typed in it that was not saved: the label
  // is offered once more, to copy.
  const offer = (text: string, other?: string) =>
    toast(`Your label “${text}” for this choice was not saved${other !== undefined ? `, because the choice became “${other}” while you were typing` : ''}.`, 'error', copyTextAction(text, 'Edit a choice’s label'));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const over = from.current;
      const text = choiceText(draftRef.current);
      // Only while a project is open: one that has just closed (a live session ending) kept the label itself.
      if (over && text && text !== over.shown && useStore.getState().snapshot) offer(text, kept.current ? over.shown : undefined);
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
  // A textarea that grows with its label (see .choices-label), so a long answer is read whole before it is moved or
  // removed; Enter still saves, never a new line.
  return (
    <textarea
      className="input sm choices-label"
      rows={1}
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
function ChoicesEditor({ schema, value, onChange, read, label, error }: { schema: ChoicesProp; value: unknown; onChange: (v: unknown, edit?: PendingEdit) => unknown; read?: () => ReadValue | undefined; label?: string; error?: string }) {
  const choices = choiceRows(value);
  const labelId = useId();
  const hintId = useId();
  const addId = useId();
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  // A choice being added when a live session ends is offered back to copy (see registerUnsent).
  const adding = useRef(draft);
  adding.current = draft;
  useEffect(() => registerUnsent(() => (adding.current.trim() ? { key: addId, label: `Add a choice${label ? ` to ${label}` : ''}`, text: adding.current } : null)), [addId, label]);
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
    // Add disables as the box empties: from the button, focus goes back to the box for the next choice.
    if (document.activeElement !== document.getElementById(addId)) requestAnimationFrame(() => document.getElementById(addId)?.focus());
    // A refused choice comes back to the box, unless something else has been typed there since.
    void act({ kind: 'add', label: text }).then((ok) => {
      if (!ok) setDraft((d) => d || text);
    });
  };
  // A move is announced once it lands, as a list item's is.
  const [said, setSaid] = useState({ text: '', count: 0 });
  const move = (c: ChoiceOption, by: -1 | 1) => {
    const direction = by < 0 ? 'up' : 'down';
    // At the end of the list the arrow it was on goes unavailable: focus moves to the other arrow, so reordering
    // never turns into typing in the label.
    refocus.current = { target: `${direction}-${c.id}`, fallback: `${by < 0 ? 'down' : 'up'}-${c.id}` };
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
    void act({ kind: 'remove', id: c.id }).then((ok) => {
      if (!ok) return;
      const left = (read ? choiceRows(read()?.value) : shownRef.current.filter((x) => x.id !== c.id)).length;
      setSaid((s) => announcementText(`Removed “${c.label}”. ${left === 1 ? '1 choice' : `${left} choices`} left.`, s.count) ?? s);
    });
  };
  return (
    <div className="field choices-editor" role="group" aria-labelledby={labelId} aria-describedby={[error ? `${hintId}-error` : '', schema.description ? hintId : ''].filter(Boolean).join(' ') || undefined} ref={rootRef}>
      <div className="field-label" id={labelId}>
        <span className="grow">
          {shown}
          {schema.required && <RequiredMark />}
        </span>
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
        <p className="field-hint insp-note choices-none">No choices yet. Add at least two.</p>
      )}
      {choices.length === 1 && <p className="field-hint insp-note">Add one more, so a visitor has a choice to make.</p>}
      <div className="choices-add">
        <input
          className="input sm"
          id={addId}
          data-choice-focus="add"
          value={draft}
          placeholder="Add a choice"
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
      {full && (
        <p className="field-hint insp-note choices-full-note" id={`${addId}-full`}>
          All {MAX_CHOICE_ROWS} choices are in use. Remove one to add another.
        </p>
      )}
      {error && (
        <div className="field-error" id={`${hintId}-error`}>
          {error}
        </div>
      )}
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
export function ScalarField({ schema, value, onChange, read, state, label, hint, error, action, onLive, placeholder, everywhere, notedBy, copyOnly }: { schema: ScalarPropSchema; value: unknown; onChange: (v: unknown, edit?: PendingEdit) => unknown; read?: () => ReadValue | undefined; state: ProjectState; label?: string; hint?: ReactNode; error?: string; action?: FieldAction; onLive?: (text: string) => void; placeholder?: string; everywhere?: boolean; notedBy?: string; copyOnly?: boolean }) {
  const id = useId();
  const shown = label ?? schema.label;
  // A hint the caller gives is what the field is doing now, under it; the schema's description says what the field is
  // for, behind the info button beside its label. A given hint replaces the description, as it always has.
  const note = hint;
  const info = hint === undefined ? schema.description : undefined;
  // A value the component requires says so in its name, and while it is empty, that it needs one.
  const mark = schema.required ? <RequiredMark /> : null;
  const named = (
    <>
      {shown}
      {mark}
    </>
  );
  error ??= missingNote(schema, value);
  // A set of choices names itself and says what it is under its own rows.
  if (schema.type === 'choices') return <ChoicesEditor schema={schema} value={value} onChange={onChange} read={read} label={shown} error={error} />;
  if (schema.type === 'boolean') return <SwitchRow checked={!!value} onChange={onChange} label={shown} info={schema.description} />;
  if (schema.type === 'image')
    return hint || error ? (
      <div className="col" style={{ gap: 4 }}>
        <ImageEditor value={value as ImageValue} onChange={onChange} state={state} title={shown} mark={mark} describedBy={`${id}-note`} copyOnly={copyOnly} />
        <div className={error ? 'field-error' : 'field-hint'} id={`${id}-note`}>
          {error ?? hint}
        </div>
      </div>
    ) : (
      <ImageEditor value={value as ImageValue} onChange={onChange} state={state} title={shown} mark={mark} copyOnly={copyOnly} />
    );
  // A link is two controls (kind and destination) that name themselves; the label names the pair.
  if (schema.type === 'link')
    return (
      <div className="field" role="group" aria-labelledby={`${id}-l`} aria-describedby={[error || note ? `${id}-note` : '', info ? `${id}-info` : ''].filter(Boolean).join(' ') || undefined}>
        {info ? (
          <div className="field-head">
            <div className="field-label" id={`${id}-l`}>
              {named}
            </div>
            <InfoTip label={shown}>{info}</InfoTip>
          </div>
        ) : (
          <div className="field-label" id={`${id}-l`}>
            {named}
          </div>
        )}
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
        {info && (
          <span id={`${id}-info`} hidden>
            {info}
          </span>
        )}
      </div>
    );
  return (
    <Field label={named} infoLabel={shown} hint={note} info={info} error={error} controlId={id}>
      <ScalarEditor schema={schema} value={value} onChange={onChange} state={state} id={id} describedBy={[note || error ? `${id}-note` : '', info ? `${id}-info` : ''].filter(Boolean).join(' ') || undefined} invalid={!!error} onLive={onLive} placeholder={placeholder} everywhere={everywhere} />
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
  | { kind: 'remove'; itemId: string; /** The row's name, for the notice that offers Undo. */ title?: string }
  | { kind: 'move'; itemId: string; index: number }
  | { kind: 'field'; itemId: string; field: string; value: unknown; edit?: PendingEdit }
  | { kind: 'repair'; itemId: string; field: string; value: unknown; label: string; revision?: number };

/** A request to open one list item, named by `seq` so the same item can be opened again. */
export interface ListReveal {
  seq: number;
  itemId: string;
}

/**
 * The list editor showing each fill's list now, by fill: a fill that waits for saves before it is made checks the
 * rows shown when it is made, in whichever editor shows them by then (the author may have moved away and back).
 */
const fillRoots = new Map<string, HTMLElement>();

/** The drag data a list row carries: its item ID, for a move within the same list. */
const LIST_DRAG = 'application/x-siteorigin-list-item';
/** The first words of a text, up to about 60 characters and ending on a whole word, for a row with no title. */
const openingWords = (text: string | undefined): string | undefined => {
  const t = text?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  if (t.length <= 60) return t;
  const cut = t.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60).replace(/[,;:.]$/, '')}…`;
};
/** "A", "A and B", "A, B and C". */
const listWords = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? ''));

/** Item fields that are one link's visible text and its destination (see itemLinkPairs). */
export type LinkPairs = ReadonlyArray<{ text: string; link: string }>;

/** A way to fill a list in one step from elsewhere in the project, offered under it (the footer's links from the header menu). */
export interface ListFill {
  /** Names the list it fills, the same for every editor that shows that list. */
  id: string;
  /** What its button says. */
  label: string;
  /** Said under the button: what it does to the rows already here. */
  note: string | null;
  /** Why there is nothing to do now (the list already holds what it would bring), or null when there is. */
  blocked: string | null;
  /**
   * Make the change: settles once it has been applied or refused. Just before it is made, `refused()` says whether
   * a row's field keeps text it refused (and points the author at it), so the change waits for that to be settled.
   */
  run: (refused: () => boolean) => Promise<unknown>;
}

/**
 * A list whose order is chosen elsewhere (the header menu, which can follow the Pages order): the control for that
 * choice, shown over its rows, and while the order is not the author's to set here, why its rows offer no move.
 */
export interface ListOrder {
  control: ReactNode;
  locked: string | null;
}

export function PropField({ name, schema, value, onChange, onField, onList, onTable, read, alive, itemAlive, state, openItem, label, hint, annotate, hiddenFields, linkPairs, error, action, place, everywhere, pickImages, fill, order, refused, setProps, copyOnly }: {
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
  /** For a list: a way to fill it from elsewhere in the project in one step. */
  fill?: ListFill;
  /** For a list: its order, when that is chosen elsewhere. */
  order?: ListOrder;
  /**
   * Why the last edit of the property, one field of an object (`field`) or one field of a list item (`itemId` and
   * `field`) was refused, said at that field in place of an error toast (see claimRefusals).
   */
  refused?: (at: { field?: string; itemId?: string }) => string | undefined;
  /** For a computed list: change other properties of the placement (its category, say) as one edit, from its empty state. */
  setProps?: (patch: Record<string, unknown>, label: string) => void;
  /** A live session's copy editor's field (#1318): a picture is replaced from the library and described, nothing more. */
  copyOnly?: boolean;
}) {
  if (schema.type === 'list' && schema.feed) return <ComputedList name={name} schema={schema} state={state} place={place} setProps={setProps} />;
  // Fields inside belong to this property of the node around them (see FieldHome).
  if (schema.type === 'list')
    return (
      <FieldHome part={`prop:${name}`} alive={alive}>
        <ListEditor name={name} schema={schema} items={Array.isArray(value) ? (value as ListItem[]) : []} onList={onList} itemAlive={itemAlive} state={state} openItem={openItem} annotate={annotate} hiddenFields={hiddenFields} linkPairs={linkPairs} place={place} read={read} everywhere={everywhere} pickImages={pickImages ?? undefined} fill={fill} order={order} refused={refused} error={refused?.({}) ?? missingNote(schema, value)} />
      </FieldHome>
    );
  if (schema.type === 'table') return <TableEditor name={name} schema={schema} value={value} onTable={onTable} refused={refused?.({})} />;
  if (schema.type === 'object')
    return (
      <FieldHome part={`prop:${name}`} alive={alive}>
        <ObjectEditor name={name} schema={schema} value={value} onField={onField ?? ((f, v, edit) => onChange({ [f]: v }, edit))} state={state} label={label} everywhere={everywhere} error={error ?? refused?.({}) ?? missingNote(schema, value)} action={action} refused={refused && ((field) => refused({ field }))} />
      </FieldHome>
    );
  return (
    <FieldHome part={`prop:${name}`} alive={alive}>
      <ScalarField schema={schema} value={value} onChange={onChange} read={read} state={state} label={label} hint={hint} error={refused?.({}) ?? error} action={action} everywhere={everywhere} copyOnly={copyOnly} />
    </FieldHome>
  );
}

/** An object property: its fields under its name, each edited on its own. */
function ObjectEditor({ name, schema, value, onField, state, label, everywhere, error, action, refused }: { name: string; schema: ObjectProp; value: unknown; onField: (field: string, v: unknown, edit?: PendingEdit) => unknown; state: ProjectState; label?: string; everywhere?: boolean; error?: string; action?: FieldAction; refused?: (field: string) => string | undefined }) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : schema.default;
  const errorId = useId();
  return (
    <fieldset className="insp-group" data-object={name} aria-describedby={error ? `${errorId}` : undefined}>
      <legend className="insp-group-title">
        {label ?? schema.label}
        {schema.required && <RequiredMark />}
      </legend>
      {schema.description && <div className="field-hint">{schema.description}</div>}
      {Object.entries(schema.fields).map(([key, f]) => (
        <div key={key} data-object-field={key} style={{ display: 'contents' }}>
          {/* Each field is its own place within the object's (see FieldHome). */}
          <FieldHome part={`field:${key}`}>
            <ScalarField schema={f} value={Object.hasOwn(v, key) ? v[key] : Object.hasOwn(schema.default, key) ? schema.default[key] : f.default} onChange={(x, edit) => onField(key, x, edit)} state={state} everywhere={everywhere} error={refused?.(key)} />
          </FieldHome>
        </div>
      ))}
      {/* A problem with the object as a whole, such as a button whose link is missing, and its fix. */}
      {error && (
        <div className="field-error" id={errorId}>
          {error}
        </div>
      )}
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

/**
 * Open a page's settings in the inspector, where an article's title, date, byline and excerpt are changed, at its
 * Article section: the one with its details on an article, the one with the "Dated article" switch on any other page.
 */
export function openPageSettings(pageId: string) {
  const page = getState().snapshot?.state.pages[pageId];
  selectPage(pageId, null);
  setState({ rightTab: 'inspect', dockOpen: true });
  // Once the page's settings are showing, open that section (it may have been collapsed) and bring it into view.
  setTimeout(() => openSection(pageArticle(page) ? 'page-article' : 'page-article-off'), 120);
}

/** Open the Content panel, where a collection's entries are written and published, or a blog is started. */
function openContentPanel() {
  setState({ leftTab: 'posts' });
}

/** The properties of a post feed's placement that name a collection and its terms, chosen by name (see FeedQueryField). */
export const FEED_QUERY_PICKS = ['collection', 'category', 'tag'] as const;
export type FeedQueryPick = (typeof FEED_QUERY_PICKS)[number];

/**
 * A post feed's collection, category or tag, chosen by name from the project's collections and their terms rather
 * than typed as an ID. Empty is the default: the blog (in a layout, the entry's own collection), every category, every
 * tag. A value that names nothing in the project stays listed, marked as not found, until another is chosen.
 */
export function FeedQueryField({ prop, label, value, query: own, layout, state, onChange }: { prop: FeedQueryPick; label: string; value: unknown; query: EntryQuery; layout?: { collectionId: string; nodeId: string; properties: Record<string, PropSchema> }; state: ProjectState; onChange: (v: string) => void }) {
  const current = typeof value === 'string' ? value.trim() : '';
  // In a layout, the terms offered are those of the collection the preview shows: the query as read on its entry.
  const templateMode = useStore((s) => s.templateMode);
  const layoutOf = layout?.collectionId;
  const sampleId = layout && templateMode?.entryId ? templateMode.entryId : undefined;
  const query = (layout && sampleId && sampleQuery(state, layout.collectionId, sampleId, layout.nodeId, layout.properties)) || own;
  const where = layoutOf ? { entry: { collectionId: layoutOf, entryId: sampleId ?? '' } } : {};
  const collection = feedCollection(state, query, where);
  let options: Array<{ value: string; label: string }>;
  let selected = current;
  let hint: string | undefined;
  if (prop === 'collection') {
    const auto = feedCollection(state, { collection: '' }, where);
    const all = Object.values(state.collections ?? {})
      .map((c) => ({ value: c.settings.id, label: c.settings.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    options = [{ value: '', label: !all.length ? 'No collection yet' : layoutOf ? `This entry’s collection${auto ? ` (${auto.settings.name})` : ''}` : auto ? `The blog (${auto.settings.name})` : 'The blog' }, ...all];
  } else {
    // With no collection (none at all, or one that is not there) there is nothing to filter: the list above says so
    // and offers the fix.
    if (!collection && !current) return null;
    const taxonomy = prop === 'category' ? 'categories' : 'tags';
    const terms = (collection && Object.hasOwn(collection.settings.taxonomies ?? {}, taxonomy) ? collection.settings.taxonomies[taxonomy].terms : undefined) ?? {};
    options = [{ value: '', label: prop === 'category' ? 'Every category' : 'Every tag' }, ...Object.entries(terms).map(([id, t]) => ({ value: id, label: t.label || id }))];
    if (current && collection) {
      // Saved by name, or several at once ("News, Craft"): the one term it names is selected; several stay as written.
      const found = termsNamed(collection, taxonomy, current);
      selected = found.length === 1 ? found[0] : current;
      if (found.length > 1) options.push({ value: current, label: current });
    }
    // Said only of a collection that exists: with none, the list above already says so and offers the fix.
    if (collection && !Object.keys(terms).length) hint = `${collection.settings.name} has no ${prop === 'category' ? 'categories' : 'tags'} yet.`;
  }
  if (selected && !options.some((o) => o.value === selected)) options.push({ value: selected, label: `“${selected}” (not found)` });
  // Nothing to choose but the default: drawn unavailable, unless a saved value is still there to be cleared.
  const dead = options.length === 1 && !selected;
  return (
    <Field label={label} hint={hint}>
      <select className="select" value={selected} data-feed-pick={prop} disabled={dead} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A computed list's row: what it shows, and where selecting it goes. */
interface ComputedRow {
  id: string;
  title: string;
  meta?: string;
  open: () => void;
}

/** Why a computed list shows nothing here, and the one thing that changes that. */
interface ComputedEmpty {
  text: ReactNode;
  action?: { label: string; run: () => void };
}

/**
 * The rows a computed list shows, each a button that opens where that item is changed, or why it shows none. The
 * count says how many of the items that could show are shown; one row (a featured post) is shown without a number.
 */
function ComputedRows({ label, rows, total, source, opens, rule, empty, single }: { label: string; rows: ComputedRow[]; total?: number; source?: ReactNode; opens: string; rule: string; empty: ComputedEmpty; single?: boolean }) {
  const labelId = useId();
  const opensId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  // A featured post shows one row, unnumbered; its count still says how many it was chosen from.
  const counted = rows.length > 0 && total !== undefined && (!single || total > 1);
  // What the list shows now, said once each time a setting changes it (never on first showing).
  const summary = rows.length ? `${label}:${total === undefined ? '' : ` ${total > rows.length ? `${rows.length} of ${total}` : rows.length} shown.`}${source ? ` ${source}` : ''}` : typeof empty.text === 'string' ? empty.text : '';
  const [said, setSaid] = useState({ text: '', count: 0 });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaid((s) => announcementText(summary, s.count) ?? s);
  }, [summary]);
  // An empty state's fix (show every category, say) fills the list in place: focus goes to its first row, where the
  // button it was on was.
  const recovering = useRef(false);
  useEffect(() => {
    if (!recovering.current || !rows.length) return;
    recovering.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) listRef.current?.querySelector<HTMLButtonElement>('.computed-row')?.focus();
  }, [rows.length]);
  return (
    <div className="field computed-list-body">
      <div className="field-label" id={labelId}>
        <span className="grow">{label}</span>
        {counted && (
          <span className="insp-count">
            <span aria-hidden="true">{total !== undefined && total > rows.length ? `${rows.length} of ${total}` : rows.length}</span>
            <span className="sr-only">{total !== undefined && total > rows.length ? `${rows.length} shown of ${total}` : `${rows.length} shown`}</span>
          </span>
        )}
      </div>
      {source && <p className="computed-source">{source}</p>}
      {rows.length ? (
        <ol ref={listRef} className={`computed-rows${single ? ' single' : ''}`} aria-labelledby={labelId}>
          {rows.map((r, i) => (
            <li key={r.id}>
              {/* Named by its title; its date and where it opens are its description. */}
              <button type="button" className="computed-row" aria-labelledby={`${opensId}-t${i}`} aria-describedby={[r.meta ? `${opensId}-m${i}` : '', opensId].filter(Boolean).join(' ')} onClick={r.open}>
                {!single && (
                  <span className="computed-row-num" aria-hidden="true">
                    {i + 1}
                  </span>
                )}
                <span className="computed-row-text">
                  <span className="computed-row-title" id={`${opensId}-t${i}`}>
                    {r.title}
                  </span>
                  {r.meta && (
                    <span className="computed-row-meta" id={`${opensId}-m${i}`}>
                      {r.meta}
                    </span>
                  )}
                </span>
                <ChevronRight className="computed-row-go" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="computed-empty">
          <p>{empty.text}</p>
          {empty.action && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                recovering.current = true;
                empty.action!.run();
              }}
            >
              {empty.action.label}
            </button>
          )}
        </div>
      )}
      <span className="sr-only" role="status">
        {said.text}
      </span>
      {rows.length > 0 && (
        <p className="computed-opens field-hint">
          <span id={opensId}>{opens}</span> {rule}
        </p>
      )}
    </div>
  );
}

/** A date and a byline as a row's quiet second line. */
const rowMeta = (...parts: Array<string | undefined>) => parts.filter((p) => p && p.trim()).join(' · ') || undefined;

/**
 * A computed list (a post feed, a news list, an article header): what it shows where it is placed, and where each of
 * those things is changed. It holds nothing of its own to edit; `setProp` changes the placement's other settings,
 * so an empty list can offer the one change that fills it (show every category, use the blog).
 */
function ComputedList({ name, schema, state, place, setProps }: { name: string; schema: ListProp; state: ProjectState; place?: ListPlace; setProps?: (patch: Record<string, unknown>, label: string) => void }) {
  const pageId = placedOnPage(place?.ref);
  const limit = feedLimit(schema);
  const node = place ? resolveRef(state, place.ref).node : undefined;
  const instance = node?.kind === 'instance' ? node : undefined;
  const properties = (instance && state.components[instance.definitionId]?.properties) || {};
  const props = (instance?.props ?? {}) as Record<string, unknown>;
  // In a collection's layout, the rows of the entry the canvas shows it on.
  const templateMode = useStore((s) => s.templateMode);
  const inLayout = place?.ref.owner.kind === 'template';
  const sample = templateMode && inLayout && !place!.ref.instancePath.length ? { entryId: templateMode.entryId, nodeId: place!.ref.nodeId } : undefined;
  const raw = placedFeedRows(state, schema, place?.ref.owner, properties, props, sample) as unknown as Array<{ id: string; title: string; date?: string; dateLabel?: string; byline?: string; excerpt?: string }>;
  const page = pageId && Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  const single = limit === 1;
  if (schema.feed === 'entries') {
    // In a layout, the entry the canvas shows it on: the rows, the count and the summary all read the query as the
    // placement reads it there (a category read from that entry, say).
    const layoutId = inLayout ? place!.ref.owner.id : undefined;
    const shown = layoutId && sample?.entryId ? sampleQuery(state, layoutId, sample.entryId, sample.nodeId, properties) : undefined;
    const query = shown ?? entryQuery(properties, props);
    // A layout read of the entry with no entry to read it on: the rows are every entry's, so no count is given.
    const unread = !!layoutId && !shown && ['collection', 'category', 'tag', 'count'].some((k) => isEntryBinding(props[k]));
    const where = layoutId ? { entry: { collectionId: layoutId, entryId: sample?.entryId ?? '' } } : {};
    const collection = feedCollection(state, query, where);
    const named = collection?.settings.name ?? 'the blog';
    // Every entry that could show here, before the placement's own number and the list's limit; and the same with the
    // entry this layout page shows put back, which tells a filter matching only that entry from one matching nothing.
    const total = collection ? listedEntries(state, { ...query, count: undefined }, where).entries.length : 0;
    const withHere = collection && layoutId ? listedEntries(state, { ...query, count: undefined }, { entry: { collectionId: layoutId, entryId: '' } }).entries.length : total;
    const published = collection ? publishedEntries(state, collection).length : 0;
    const fallback = feedCollection(state, { collection: '' }, where);
    const rows: ComputedRow[] = raw.map((r) => ({
      id: r.id,
      title: r.title,
      meta: rowMeta(r.dateLabel, r.byline),
      open: () => {
        // Each row's own collection: one read from the entry a layout is shown on can be another.
        const found = findEntry(state, r.id);
        if (found) void openPost(found.collection.settings.id, r.id);
      }
    }));
    // A filter by the names its terms have now, as the selects show them; a value naming no term, as it was written.
    const termWords = (taxonomy: 'categories' | 'tags', wanted: string) => {
      const terms = collection && Object.hasOwn(collection.settings.taxonomies ?? {}, taxonomy) ? collection.settings.taxonomies[taxonomy].terms : undefined;
      const ids = collection && wanted ? termsNamed(collection, taxonomy, wanted) : [];
      return ids.length ? ids.map((id) => `“${terms?.[id]?.label || id}”`).join(' or ') : `“${wanted}”`;
    };
    const missingTerm = (taxonomy: 'categories' | 'tags', wanted: string) => !!collection && !!wanted && !termsNamed(collection, taxonomy, wanted).length;
    const inWords = query.category ? `in ${termWords('categories', query.category)}` : '';
    const taggedWords = query.tag ? `tagged ${termWords('tags', query.tag)}` : '';
    // A filter read from each entry (in a layout) is changed in Entry content, never cleared from here.
    const bound = (prop: 'category' | 'tag') => isEntryBinding(props[prop]);
    // How many could show with `patch` applied: a fix is offered only when it would fill the list.
    const after = (patch: Partial<EntryQuery>) => (collection ? listedEntries(state, { ...query, ...patch, count: undefined }, where).entries.length : 0);
    const fix = (patch: Partial<EntryQuery>, words: string): ComputedEmpty['action'] => (setProps && after(patch) > 0 && !(Object.keys(patch) as Array<'category' | 'tag'>).some(bound) ? { label: words, run: () => setProps(patch, words) } : undefined);
    const another = 'Publish another entry to fill it.';
    const filterFix = (patch: Partial<EntryQuery>, words: string, text: string): ComputedEmpty => {
      const action = fix(patch, words);
      if (action) return { text, action };
      // Clearing it would not help: in a layout, the page's own entry is all there is; or the filter is read from each
      // entry.
      if ((Object.keys(patch) as Array<'category' | 'tag'>).some(bound)) return { text: `${text} That filter is read from each entry, in Entry content.` };
      return { text: `${text} ${another}`, action: { label: 'Open Content', run: openContentPanel } };
    };
    const both = !!(query.category && query.tag);
    const empty: ComputedEmpty = !hasCollections(state)
      ? { text: 'This site has no blog or other collection yet. Start one in Content.', action: { label: 'Open Content', run: openContentPanel } }
      : !collection
        ? isEntryBinding(props.collection)
          ? { text: `There is no collection called “${query.collection}”. The collection is read from each entry, in Entry content.` }
          : setProps && fallback && listedEntries(state, { ...query, collection: '', count: undefined }, where).entries.length > 0
            ? { text: `There is no collection called “${query.collection}”.`, action: { label: `Use ${fallback.settings.name} instead`, run: () => setProps({ collection: '' }, `Show ${fallback.settings.name}`) } }
            : { text: `There is no collection called “${query.collection}”. Choose one under Which entries.` }
        : missingTerm('categories', query.category)
          ? filterFix({ category: '' }, 'Show every category', `${named} has no category called “${query.category}”.`)
          : missingTerm('tags', query.tag)
            ? filterFix({ tag: '' }, 'Show every tag', `${named} has no tag called “${query.tag}”.`)
            : !published
              ? { text: `Nothing in ${named} is published yet. Drafts don’t show.`, action: { label: 'Open Content', run: openContentPanel } }
              : withHere > 0 && (query.category || query.tag) && fix(both ? { category: '', tag: '' } : query.category ? { category: '' } : { tag: '' }, 'x')
                ? filterFix(both ? { category: '', tag: '' } : query.category ? { category: '' } : { tag: '' }, both ? 'Clear both filters' : query.category ? 'Show every category' : 'Show every tag', `The only published entry ${[inWords, taggedWords].filter(Boolean).join(' and ')} is the one this page shows, and a list leaves that one out.`)
              : withHere > 0
                ? {
                    text: `The only published entry${query.category || query.tag ? ` ${[inWords, taggedWords].filter(Boolean).join(' and ')}` : ` in ${named}`} is the one this page shows, and a list leaves that one out. ${another}`,
                    action: { label: 'Open Content', run: openContentPanel }
                  }
                : query.category || query.tag
                  ? filterFix(both ? { category: '', tag: '' } : query.category ? { category: '' } : { tag: '' }, both ? 'Clear both filters' : query.category ? 'Show every category' : 'Show every tag', `${named} has nothing published ${[inWords, taggedWords].filter(Boolean).join(' and ')}.`)
                  : { text: `Nothing in ${named} can show here. ${another}`, action: { label: 'Open Content', run: openContentPanel } };
    const filters = [inWords, taggedWords].filter(Boolean).join(', ');
    // A layout with no entry to show it on: which entries appear depends on that entry, so none are listed as if they did.
    const unresolved = !!layoutId && !shown;
    if (unresolved)
      return (
        <div className="field computed-list" data-list={name}>
          <ComputedRows label={schema.label} rows={[]} opens="" rule="" empty={{ text: 'Which entries show here depends on the entry the layout is shown for. Choose an entry to preview the layout on, and they are listed here.' }} />
        </div>
      );
    return (
      <div className="field computed-list" data-list={name}>
        <ComputedRows
          label={schema.label}
          rows={rows}
          total={unread ? undefined : total}
          single={single}
          // Said only of a collection that exists: with none, the box below says what is wrong. With nothing to show,
          // only where it fills from: the box names the filter.
          source={!collection ? undefined : !raw.length ? `Fills itself from ${named}.` : single ? `Fills itself with the newest published entry of ${named}${filters ? ` ${filters}` : ''}.` : `Fills itself from ${named}${filters ? `, ${filters}` : ''}, newest first.`}
          opens={single ? 'Select the entry to open it in Content.' : 'Select one to open it in Content.'}
          rule={`Drafts are left out${inLayout ? ', and so is the entry whose page shows the list' : ''}.`}
          empty={empty}
        />
      </div>
    );
  }
  if (schema.feed === 'currentPage') {
    const row = raw[0];
    const dated = !!row?.date;
    return (
      <div className="field computed-list" data-list={name}>
        <div className="field-label">{schema.label}</div>
        {page ? (
          <div className="computed-page">
            <div className="computed-page-title">{row?.title || page.title}</div>
            <div className="computed-page-meta">{dated ? rowMeta(row.dateLabel, row.byline) : 'Not a dated article, so only its title shows. Turn on Dated article in its page settings to show a date too.'}</div>
            {dated && row.excerpt?.trim() && <div className="computed-page-excerpt">{row.excerpt}</div>}
            <button type="button" className="btn btn-sm" onClick={() => openPageSettings(page.id)}>
              {dated ? 'Edit in page settings' : 'Open page settings'}
            </button>
          </div>
        ) : (
          <div className="computed-empty">
            <p>Shows the title and date of the page it is on. In the shared header or footer there is no page, so it shows nothing.</p>
          </div>
        )}
      </div>
    );
  }
  // Every dated article that could show here, before the list's limit.
  const total = articleRows(state, schema.feed!, pageId).length;
  // Why no article shows, from what keeps each one out (a draft, hidden from news lists, this page itself), and the
  // one step that would show one, when a single step would.
  const openPages: ComputedEmpty['action'] = { label: 'Open Pages', run: () => setState({ leftTab: 'pages' }) };
  const newsEmpty = (): ComputedEmpty => {
    const articles = Object.values(state.pages).filter((p) => pageArticle(p));
    if (!articles.length) return { text: 'This site has no dated articles yet. Add one in Pages with Add page → Dated article.', action: openPages };
    const others = articles.filter((p) => p.id !== pageId);
    if (!others.length) return { text: 'The only dated article is this page, and a news list leaves its own page out. Add another in Pages.', action: openPages };
    const draft = (p: PageDoc) => p.draft === true && p.id !== state.site.homePageId;
    const hidden = (p: PageDoc) => pageArticle(p)!.hidden === true;
    const one = others.length === 1;
    // “Other” only when this page is an article too.
    const other = others.length < articles.length ? ' other' : '';
    if (others.every((p) => draft(p) && !hidden(p))) return { text: `${one ? `The one${other} dated article is a draft. Publish it` : `All ${others.length}${other} dated articles are drafts. Publish one`} to show it here.`, action: one ? { label: 'Open page settings', run: () => openPageSettings(others[0].id) } : openPages };
    if (others.every((p) => hidden(p) && !draft(p))) return { text: `${one ? `The one${other} dated article is hidden from news lists. Show it` : `All ${others.length}${other} dated articles are hidden from news lists. Show one`} in its page settings.`, action: one ? { label: 'Open page settings', run: () => openPageSettings(others[0].id) } : openPages };
    return { text: 'No dated article can show here: drafts, articles hidden from news lists and this page itself are left out.', action: openPages };
  };
  const rows: ComputedRow[] = raw.map((r) => ({ id: r.id, title: r.title, meta: rowMeta(r.dateLabel, r.byline), open: () => openPageSettings(r.id) }));
  return (
    <div className="field computed-list" data-list={name}>
      <ComputedRows
        label={schema.label}
        rows={rows}
        total={total}
        single={single}
        source={raw.length ? 'Fills itself from the site’s dated articles, newest first.' : 'Fills itself from the site’s dated articles.'}
        opens={single ? 'Select the article to open its page settings.' : 'Select one to open its page settings.'}
        rule="Drafts and articles hidden from news lists are left out."
        empty={newsEmpty()}
      />
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
 * A repeatable list. Each row is a disclosure named by its item, with what is wrong with the item said under its name
 * in words while it is closed, and a submenu link says which link it shows under. Focus follows the edit: a new item
 * opens with its row focused and is announced, and removing an item moves focus to the row that takes its place (or
 * to Add when the list is empty) while a notice offers Undo. A row moves one place with its buttons, or anywhere by
 * dragging it; a moved item keeps focus on the button that moved it, and on its own disclosure once that button is
 * disabled at the end of the list, and the new position (and any link that changed submenu with it) is announced.
 * The limits are stated where they bite: the count shows the maximum, and Add and Remove stay focusable with the
 * reason once the list is full or at its minimum. While the order is set elsewhere the rows have no moves at all,
 * and the note above them says why.
 */
function ListEditor({ name, schema, items, onList, read, itemAlive, state, openItem, annotate, hiddenFields, linkPairs, place, everywhere, pickImages, fill, order, refused, error }: { name: string; schema: ListProp; items: ListItem[]; onList: (op: ListOp) => unknown; read?: () => ReadValue | undefined; itemAlive?: (itemId: string, field: string) => () => boolean; state: ProjectState; openItem?: ListReveal; annotate?: (item: ListItem, index: number) => ListItemNote | undefined; hiddenFields?: (item: ListItem) => readonly string[]; linkPairs?: LinkPairs; place?: ListPlace; everywhere?: boolean; pickImages?: string; fill?: ListFill; order?: ListOrder; refused?: (at: { field?: string; itemId?: string }) => string | undefined; /** A problem with the list as a whole (a required list with no items, or a refused removal of its last). */ error?: string }) {
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
  const after = useRef<{ kind: 'added'; before: string[] } | { kind: 'removed'; focus: string | null } | { kind: 'moved'; id: string; direction: MoveDirection; index: number; from: number; title: string; at: number; parents: Map<string, string | null> } | null>(null);
  // Each row's submenu parent as last shown (a menu with submenus), so a move can say which links it regrouped.
  const parents = useRef(new Map<string, string | null>());
  // A row being dragged within this list, and where it would land: before the row at `at` (items.length: at the end).
  const [drag, setDrag] = useState<{ id: string; at: number | null } | null>(null);
  const [dropTop, setDropTop] = useState<number | null>(null);
  // Images added in one pass, named by the rows the change made: focus goes to the first once this list shows it.
  const [landed, setLanded] = useState<{ ids: string[]; said: string; at: number } | null>(null);
  const [said, setSaid] = useState({ text: '', count: 0 });
  const addNoteId = useId();
  const removeNoteId = useId();
  const fillNoteId = useId();
  const lockedNoteId = useId();
  // Rows whose order is set elsewhere stay where they are, and their move buttons say why.
  const locked = order?.locked ?? null;
  // While a fill is being applied it can't be asked for again.
  const [filling, setFilling] = useState(false);
  const fillId = fill?.id;
  useEffect(() => {
    const root = rootRef.current;
    if (!fillId || !root) return;
    fillRoots.set(fillId, root);
    return () => void (fillRoots.get(fillId) === root && fillRoots.delete(fillId));
  }, [fillId]);
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
      setSaid((p) => announcementText(`Added ${nameOf(added, items.indexOf(added))}.`, p.count) ?? p);
      // Opened and focused only from where Add left it: Add (or the page picker beside it), or nowhere (the page). An
      // author who has gone on to a field meanwhile, even in another row of this list, keeps it open and keeps their place.
      const active = document.activeElement;
      const fromAdd = (el: Element | null) => !el || el === document.body || (!!root?.contains(el) && !!el.closest('.insp-add, .list-editor-add-page'));
      if (!fromAdd(active)) return;
      setOpen(added.id);
      requestAnimationFrame(() => fromAdd(document.activeElement) && focusRow(added.id));
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
      // Links whose submenu changed with the move: the one moved, or the ones after it it took into or out of a submenu.
      const regrouped = [...parents.current].filter(([id, under]) => a.parents.has(id) && a.parents.get(id) !== under);
      const moved = [moveAnnouncement(nameOf(items[at], at), a.index, items.length), ...regrouped.map(([id, under]) => {
        const t = titleOf(items.find((x) => x.id === id)!, items.findIndex((x) => x.id === id));
        const parent = under ? items.find((x) => x.id === under) : undefined;
        return parent ? `${t} now shows under ${titleOf(parent, items.indexOf(parent))}.` : `${t} now shows in the menu itself.`;
      })].join(' ');
      setSaid((p) => announcementText(moved, p.count) ?? p);
    } else {
      after.current = null;
      requestAnimationFrame(() => {
        // The Remove button went with its row, leaving focus on the page: anywhere else, the author has moved on.
        const active = document.activeElement;
        if (active && active !== document.body) return;
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
  const openId = open;
  const reveal = useRevealedItem(place, openId ? items.find((x) => x.id === openId) : undefined);
  // A page list names each card by the title it shows: the page's own while the card has none. A row without a
  // title is named by the image it shows.
  const imageOf = (raw: ListItem) => listItemImage(schema, effectiveItem(state, schema, raw), state.assets.assets);
  const titleOf = (raw: ListItem, i: number) => listRowTitle(schema, effectiveItem(state, schema, raw), i, imageOf(raw)?.name);
  // A page list's cards that share a title are told apart by their page's address, seen and in their buttons' names.
  const routeOf = (raw: ListItem) => (schema.pageTeaser ? teaserPage(state, schema.pageTeaser, raw)?.route : undefined);
  const titleCount = new Map<string, number>();
  if (schema.pageTeaser) items.forEach((x, i) => titleCount.set(titleOf(x, i), (titleCount.get(titleOf(x, i)) ?? 0) + 1));
  const twinRoute = (raw: ListItem, i: number) => ((titleCount.get(titleOf(raw, i)) ?? 0) > 1 ? routeOf(raw) : undefined);
  const nameOf = (raw: ListItem, i: number) => (twinRoute(raw, i) ? `${titleOf(raw, i)} (${twinRoute(raw, i)})` : titleOf(raw, i));
  // The text a row is named by when it has some (see listRowTitle), so a blank row is told from one titled "Card 4".
  const ownTitle = (x: ListItem) => {
    const t = schema.titleField ? x[schema.titleField] : Object.values(x).find((v) => typeof v === 'string' && v && v !== x.id);
    return typeof t === 'string' ? t.trim() : '';
  };
  // In a menu with submenus, the link each item shows under (null for a top-level one), so the rows show the
  // grouping the website will: moving or removing a link can regroup the ones after it.
  const underOf: Array<string | null> = [];
  const underId: Array<string | null> = [];
  if (menuGroups(schema)) {
    const under = shownUnder(items);
    let top: { id: string; title: string } | null = null;
    items.forEach((it, i) => {
      if (!under[i]) top = { id: it.id, title: titleOf(it, i) };
      underOf[i] = under[i] && top ? top.title : null;
      underId[i] = under[i] && top ? top.id : null;
    });
  }
  // By ID, so a move between two links of the same name is still a regroup.
  parents.current = new Map(underId.length ? items.map((it, i) => [it.id, underId[i]]) : []);
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
  // While the page chooser is open: the page it highlights, or null when its search matches none.
  const [searching, setSearching] = useState<string | null | undefined>(undefined);
  const adding = addable.includes(toAdd) ? toAdd : (addable[0] ?? '');
  const L = onList;
  const moveTo = (it: ListItem, i: number, index: number) => {
    if (locked || index === i || index < 0 || index >= items.length) return;
    after.current = { kind: 'moved', id: it.id, direction: index < i ? 'up' : 'down', index, from: i, title: titleOf(it, i), at: Date.now(), parents: new Map(parents.current) };
    L({ kind: 'move', itemId: it.id, index });
  };
  const move = (it: ListItem, i: number, direction: MoveDirection) => moveTo(it, i, direction === 'up' ? i - 1 : i + 1);
  // Dragging a row: rows drag by their head, as layers do, and only within their own list. The line shows between
  // rows where it will land; the move buttons stay the way to do it without dragging.
  const canDrag = !locked && items.length > 1;
  // Off the rows (Add, the notes, outside the list) nothing would land: the line goes, and a drop there does nothing.
  const dragAway = () => {
    if (drag?.at !== null && drag) setDrag({ id: drag.id, at: null });
    setDropTop(null);
  };
  // Where a held row would land, from the pointer's height over the rows: before the first row whose middle is below
  // it. Over the rows, the 4px between them and a nested row's indent alike; off them (the order control, Add, the
  // notes, or past either end) nothing would land. `null` is no move: off the rows, or where the row already is.
  const slotAt = (e: React.DragEvent): { at: number; top: number } | 'off' | null => {
    if (!drag || !e.dataTransfer.types.includes(LIST_DRAG)) return 'off';
    const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>(':scope .list-editor > .list-editor-item') ?? [])];
    const first = rows[0]?.getBoundingClientRect();
    const last = rows[rows.length - 1]?.getBoundingClientRect();
    const target = e.target as Element;
    const off = !target.closest?.('.list-editor-item') && target.closest?.('.list-editor-order, .insp-add, .insp-link-row, .insp-note, .insp-pick-open, .insp-fill');
    if (off || !first || !last || e.clientY < first.top - 8 || e.clientY >= last.bottom + 4) return 'off';
    const at = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top + b.height / 2 < e.clientY;
    }).length;
    const from = items.findIndex((x) => x.id === drag.id);
    if (from < 0 || at === from || at === from + 1) return null;
    const near = rows[Math.min(at, rows.length - 1)];
    return { at, top: at < rows.length ? near.offsetTop - 3 : near.offsetTop + near.offsetHeight + 1 };
  };
  const dragOver = (e: React.DragEvent) => {
    const slot = slotAt(e);
    if (slot === 'off') return dragAway();
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drag && drag.at !== (slot?.at ?? null)) setDrag({ id: drag.id, at: slot?.at ?? null });
    setDropTop(slot?.top ?? null);
  };
  // Read from the drop itself, so the last place shown is the one taken even before the list has drawn it.
  const drop = (e: React.DragEvent) => {
    if (!drag) return;
    const slot = slotAt(e);
    if (slot !== 'off') e.preventDefault();
    const from = items.findIndex((x) => x.id === drag.id);
    if (from >= 0 && slot && slot !== 'off') moveTo(items[from], from, slot.at > from ? slot.at - 1 : slot.at);
    setDrag(null);
    setDropTop(null);
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
    <div
      className="field"
      role="group"
      aria-labelledby={labelId}
      aria-describedby={[error && `${labelId}-error`, locked && lockedNoteId].filter(Boolean).join(' ') || undefined}
      data-list={name}
      ref={rootRef}
      // The whole field takes a held row (dragOver), so the line above the first row, over the gap under the label,
      // takes a drop as surely as the rows do.
      onDragOver={drag ? dragOver : undefined}
      onDragLeave={drag ? (e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && dragAway() : undefined}
      onDrop={drop}
    >
      <div className="field-label" id={labelId}>
        <span className="grow">
          {schema.label}
          {schema.required && <RequiredMark />}
        </span>
        <span className="insp-count">
          <span aria-hidden="true">{countText(items.length, schema.max)}</span>
          <span className="sr-only">{countLabel(items.length, schema.itemLabel, schema.max)}</span>
        </span>
      </div>
      {error && (
        <div className="field-error" id={`${labelId}-error`}>
          {error}
        </div>
      )}
      <div className="list-editor" data-drag={drag ? '' : undefined}>
        {order && (
          <div className="list-editor-order">
            {order.control}
            {locked && (
              <p className="insp-note muted" id={lockedNoteId}>
                {locked}
              </p>
            )}
          </div>
        )}
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
          // Fields the component requires that this item leaves empty: the closed row says it is incomplete.
          const empty = Object.entries(schema.fields).filter(([k, f]) => !hiddenFields?.(it).includes(k) && missingNote(f, Object.hasOwn(it, k) ? it[k] : f.default));
          const required = empty.length ? `${listWords(empty.map(([, f]) => f.label))} ${empty.length === 1 ? 'is' : 'are'} required.` : undefined;
          const incomplete = required && `Incomplete: ${required}`;
          // An edit of one of its fields that was refused is said on the closed row too, until the row is opened.
          const refusedHere = refused ? Object.keys(schema.fields).map((k) => refused({ itemId: it.id, field: k })).find(Boolean) : undefined;
          // A contact link that opens something other than its text is a caution; the rest are problems to fix.
          const mismatch = linkPairs?.map((p) => contactMismatch(it[p.text], it[p.link])).find(Boolean);
          // Where the link goes, as the open row's note words it (ContactMismatch): the visible text is already the name.
          const caution = mismatch ? `${/^mailto:/i.test(mismatch.opens) ? 'Link emails' : /^tel:/i.test(mismatch.opens) ? 'Link calls' : 'Link opens'} ${mismatch.opens.replace(/^(mailto|tel):/i, '')}.` : undefined;
          const problem = refusedHere ?? note?.error;
          const flag = problem ?? caution ?? incomplete;
          // What the closed row says under its name, in words: red as its field says it once open, amber for a caution.
          const says = [problem ? { text: problem, tone: 'error' } : caution ? { text: caution, tone: 'caution' } : null, required && required !== problem ? { text: required, tone: 'error' } : null].filter((x): x is { text: string; tone: string } => !!x);
          // An item with nothing to name it by is told from others like it by the opening words of what it does have.
          const excerpt = untitled ? openingWords(Object.entries(it).find(([k, v]) => k !== 'id' && k !== schema.titleField && schema.fields[k] && typeof v === 'string' && v.trim())?.[1] as string | undefined) : undefined;
          const isOpen = openId === it.id;
          return (
          <div
            key={it.id}
            className={`list-editor-item${underOf[i] ? ' nested' : ''}`}
            data-dragging={drag?.id === it.id || undefined}
          >
            <div
              className="list-editor-head"
              draggable={canDrag}
              onDragStart={(e) => {
                if (!canDrag) return;
                e.dataTransfer.setData(LIST_DRAG, it.id);
                e.dataTransfer.effectAllowed = 'move';
                // The head alone, so an open row's form doesn't cover the places it could go.
                e.dataTransfer.setDragImage(e.currentTarget, 16, 16);
                setDrag({ id: it.id, at: null });
              }}
              onDragEnd={() => {
                setDrag(null);
                setDropTop(null);
              }}
            >
              {/* The chevron and title are one disclosure button, so the whole leading area opens the item. */}
              <button className="title" id={`list-head-${it.id}`} aria-expanded={openId === it.id} aria-controls={`list-item-${it.id}`} aria-describedby={flag ? `list-flag-${it.id}` : undefined} onClick={() => setOpen(openId === it.id ? null : it.id)}>
                <DisclosureMark />
                {thumb && devUrl && (
                  <span className="list-editor-thumb" aria-hidden="true">
                    <AssetImage key={missingKey(snapshot, thumb.id)} asset={thumb} devUrl={devUrl} cover alt="" loading="lazy" />
                  </span>
                )}
                {underOf[i] && <CornerDownRight size={12} className="list-editor-under" aria-hidden="true" />}
                <span className="list-editor-text">
                  <span className={`list-editor-name${untitled ? ' untitled' : ''}`}>
                    {untitled ? `Untitled ${schema.itemLabel.toLowerCase()}` : title}
                    {/* Its place in the list, which its move and remove buttons are named by. */}
                    {untitled && <span className="sr-only">, {title}</span>}
                  </span>
                  {underOf[i] && (
                    <span className="list-editor-meta">
                      <span className="sr-only">, </span>Under {underOf[i]}
                    </span>
                  )}
                  {twinRoute(it, i) && (
                    <span className="list-editor-meta">
                      <span className="sr-only">, </span>
                      {twinRoute(it, i)}
                    </span>
                  )}
                  {excerpt && (
                    <span className="list-editor-meta list-editor-excerpt">
                      <span className="sr-only">, </span>
                      {excerpt}
                    </span>
                  )}
                  {/* Read once, as the row's description (below); seen here while the row is closed. */}
                  {!isOpen &&
                    says.map((x) =>
                      x.tone === 'error' ? (
                        <span key={x.text} className="field-error list-editor-status" aria-hidden="true">
                          {x.text}
                        </span>
                      ) : (
                        <span key={x.text} className="insp-check list-editor-status" aria-hidden="true">
                          <TriangleAlert />
                          {x.text}
                        </span>
                      )
                    )}
                </span>
              </button>
              {/* Outside the button, so the problem describes the row without becoming part of its name. */}
              {flag && (
                <span className="sr-only" id={`list-flag-${it.id}`}>
                  {says.map((x) => x.text).join(' ')}
                </span>
              )}
              {/* While the order is set elsewhere, or the list has one item, there is no move to offer; a locked list's
                  note above the rows says why. */}
              {canDrag && (
                <>
                  <button className="icon-btn sm" aria-label={`Move ${nameOf(it, i)} up`} id={`list-up-${it.id}`} disabled={i === 0} onClick={() => move(it, i, 'up')}>
                    <ArrowUp />
                  </button>
                  <button className="icon-btn sm" aria-label={`Move ${nameOf(it, i)} down`} id={`list-down-${it.id}`} disabled={i === items.length - 1} onClick={() => move(it, i, 'down')}>
                    <ArrowDown />
                  </button>
                </>
              )}
              <button className="icon-btn sm list-editor-remove" aria-label={`Remove ${nameOf(it, i)}`} aria-disabled={removeNote ? true : undefined} aria-describedby={removeNote ? (removeNoteShared ? addNoteId : removeNoteId) : undefined} title={removeNote ?? undefined} onClick={() => {
                  if (removeNote) return;
                  after.current = { kind: 'removed', focus: (items[i + 1] ?? items[i - 1])?.id ?? null };
                  L({ kind: 'remove', itemId: it.id, title: nameOf(it, i) });
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
                            error={refused?.({ itemId: it.id, field: key }) ?? (note?.field === key ? note.error : undefined)}
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
        {dropTop !== null && <div className="list-editor-drop" style={{ top: dropTop }} aria-hidden="true" />}
        {schema.pageTeaser ? (
          // A page list adds a card for a page chosen here; each page appears once.
          addable.length > 0 ? (
            <div className="insp-link-row list-editor-add-page">
              {/* One page left: the button names it. Otherwise the page chooser the link editor uses, offering the pages
                  this list doesn't have yet. */}
              {addable.length > 1 && <PagePicker key={ids} state={state} pages={addable} value={adding} label={`${schema.itemLabel} to add`} currentNote="chosen" describedBy={addNote ? addNoteId : undefined} onPick={setToAdd} onActive={setSearching} />}
              {/* While the chooser is open, Add takes the page it highlights (Enter's choice), and a press keeps focus in
                  it so the list doesn't close and move Add out from under the pointer. */}
              <button
                className="btn btn-sm insp-add"
                aria-label={addable.length === 1 ? `Add ${state.pages[addable[0]].title}, ${state.pages[addable[0]].route}` : undefined}
                aria-disabled={addNote || addPending || searching === null ? true : undefined}
                aria-describedby={addNote ? addNoteId : undefined}
                title={addNote ?? undefined}
                onMouseDown={searching !== undefined ? (e) => e.preventDefault() : undefined}
                onClick={() => {
                  const page = searching === undefined ? adding : searching;
                  if (addNote || addPending || !page) return;
                  after.current = { kind: 'added', before: items.map((x) => x.id) };
                  setAsked(ids);
                  L({ kind: 'insert', item: { [schema.pageTeaser!.link]: { type: 'page', target: page } } });
                }}
              >
                <Plus /> Add {addable.length === 1 ? state.pages[addable[0]].title : schema.itemLabel.toLowerCase()}
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
            {/* Beside Choose images…, this one adds a row to fill in by hand. */}
            <Plus /> Add {schema.itemLabel.toLowerCase()}
            {pickImages ? ' manually' : ''}
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
        {fill && (
          <>
            {/* Stays focusable while there is nothing to do, saying why. */}
            <button
              className="btn btn-sm insp-fill"
              aria-disabled={fill.blocked || filling ? true : undefined}
              aria-busy={filling || undefined}
              aria-describedby={(fill.blocked ?? fill.note) ? fillNoteId : undefined}
              onClick={() => {
                if (fill.blocked || filling) return;
                // Text a row's field refused would go with the rows it replaces: it is corrected or discarded first.
                const id = fill.id;
                const refused = () => {
                  const root = fillRoots.get(id) ?? rootRef.current;
                  const kept = root && refusedWithin(root);
                  if (!kept) return false;
                  toast(`${kept.message} Correct it or press Escape in it, then ${fill.label.toLowerCase()} again.`, 'error');
                  kept.field.focus();
                  return true;
                };
                if (refused()) return;
                setFilling(true);
                void fill.run(refused).finally(() => setFilling(false));
              }}
            >
              <Copy /> {fill.label}
            </button>
            {(fill.blocked ?? fill.note) && (
              <p className="insp-note muted" id={fillNoteId}>
                {fill.blocked ?? fill.note}
              </p>
            )}
          </>
        )}
        <span className="sr-only" role="status">
          {said.text}
        </span>
      </div>
    </div>
  );
}
