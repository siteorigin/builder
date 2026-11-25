import './Inspector.css';
import { axesOf, designLayers, designStyles, selectedVariants, selectedVariantStyles, startingVariants } from '@shared/variants';
import { propBindingSchema } from '@shared/bindings';
import { Children, Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code,
  Component,
  Copy,
  Ellipsis,
  Eye,
  FileCode2,
  FileText,
  Heading,
  House,
  Image as ImageIcon,
  Layers,
  Link as LinkIcon,
  List,
  MousePointerClick,
  Newspaper,
  Palette,
  PanelBottom,
  PanelTop,
  Pencil,
  Pilcrow,
  Shapes,
  Sparkles,
  Split,
  SquareDashed,
  Trash2,
  Unlink,
  Users,
  BookmarkPlus,
  Download,
  Repeat,
  Search
} from 'lucide-react';
import type { ComponentDefinition, DividerNode, ElementNode, ElementRef, GraphNode, ImageValue, InstanceNode, LinkValue, ListItem, ListProp, OwnerRef, PageDoc, ProjectState, PropSchema, ResponsiveScope, ResponsiveStyles, ScalarPropSchema, StyleState, StyleValue, TextNode } from '@shared/types';
import { DIVIDER_ICON, DIVIDER_SHAPES, isBinding, parseStyleScopeKey, styleScopeKey } from '@shared/types';
import { followNote } from '@shared/site-name';
import { headerHiddenProps } from '@shared/header-logo';
import { showsPart } from '@shared/page-shell';
import { pageParents, pageRows, pagesWithin, planRouteMove, routeLeaf } from '@shared/page-tree';
import { routeUrl, validateRoute } from '@shared/routes';
import { publicUrl } from '@shared/public-url';
import { isVideoContract, videoFieldNotes, type VideoFieldNotes } from '@shared/video';
import { isArticleDate, pageArticle, todayArticleDate } from '@shared/articles';
import { findEntry } from '@shared/collections';
import { postAt, postShown } from '../lib/posts';
import { activeWorkspace } from '../lib/workspace';
import { seoDocument } from '../lib/seo-view';
import { STATE_WORDS, cascadeStyles, columnLayoutPart, partStyleControls, placementStyleControls, styleSetFor } from '@shared/styles';
import { richTextToMarkdown, toRichText } from '@shared/richtext';
import { RichTextField } from '../components/RichTextField';
import type { EditOperation } from '@shared/ops';
import { effectiveTokens, isDraftPage } from '@generator/index';
import type { UnlinkedButton } from '@generator/checks';
import { catalogueComponent } from '@catalogue/index';
import { formFieldSettingsHidden, formFieldsAsSent, formKeyNote, formServiceSetup, namesFormFields, offersFormChoices, type FormServiceSetup } from '@catalogue/foundation/form';
import { anchorCapable, codeImportantProps, codeTakesOverrides, designAppear, enclosingRepeatProp, instancesOf, itemLinkPairs, shellMenu } from '@engine/tree';
import type { TableEdit } from '@engine/table';
import { stateActionRuns } from '@engine/schema';
import { inferredRole, placementRole, type InsertRole } from '@engine/insert-role';
import { previewedState } from '../lib/studio';
import { listEditLabel } from '../lib/list-editor';
import { contentLabel, editLabel, fieldLabel, forLabel, refTo, styleLabel, styleWords, subjectWords } from '../lib/edit-label';
import { applyOps, applyWith, commitOps, getState, renamePage, setState, toast, undoAction, useStore, type InspectorFocus, type PendingEdit } from '../store';
import { DraftInput, Field, FieldHome, openSection, Section, Segmented, SwitchRow, useMenu, type MenuItem } from '../components/ui';
import { CanonicalUrlField, RevisionDateField } from '../components/SeoFields';
import { StructuredDataFields, structuredSummary } from '../components/StructuredDataFields';
import { TEXT_LIMITS } from '@shared/text-limits';
import { itemStylesOf, liveItemStyles, repeatedPartList } from '@shared/item-styles';
import { itemReachKey, reachByItem, showReach } from '../lib/item-reach';
import { TagField } from './TagField';
import { ContactMismatch, FieldGroups, groupFields, ImageEditor, LinkEditor, openPageSettings, PropField, ScalarField, IconPicker, useRevealedItem, type ListFill, type ListItemNote, type ListOp } from './PropEditors';
import { StyleControls } from './StyleControls';
import { ConditionControls } from './ConditionControls';
import { ClickActionSection, OverlaySection, UiStateSection, overlayOffered } from './InteractionControls';
import { EntranceField, StaggerSwitch, appearSummary } from './EntranceControls';
import { FormToolFields } from './FormToolFields';
import { isWebMcpForm } from '@shared/webmcp';
import { useStyleCopyItems } from './StylePaste';
import { platformKeys, useCopyPasteItems, type CopyPasteActions } from './CopyPaste';
import { copySelection, pasteFromMenu } from '../lib/clipboard';
import type { FocusImage } from './FocusEditor';
import { repeatAsListTarget } from '../lib/repeat-as-list';
import { turnIntoSlotItem, turnIntoSlotTarget } from '../lib/turn-into-slot';
import { assetUrl, createComponentTarget, definitionView, isCodePart, ownerLabel, placedFeedRows, placedSlot, placementsOn, refLabel, resolveRef, shellPageNames, shellReach, shownOrDefault, throughPlacement, treeFor, withoutSlot } from '../lib/model';
import { enclosingGroup, partInInteractionGroup, withoutGroupStates } from '@shared/interaction-groups';
import { carriesAcross, exportComponentFile, saveToLibrary } from '../lib/saved-components';
import { askAiAbout, asPlanned, deleteLayers, deleteSelection, detachable, detachPlacement, duplicateLayers, groupCount, liveGroup, openPost, planFor, planLayers, selectPage, setMode, structuralTarget, ungroupLayers, wrapLayers } from '../lib/actions';
import { wrapItems } from './WrapItems';
import { linkClash, linkedGroup, pageLanguage, siteLanguage, translationPeers } from '@shared/languages';
import { hideAt, hideButtonOp, unlinkedAt, unlinkedField, unlinkedNote } from '../lib/unlinked';
import { teaserFieldNote } from '../lib/page-teasers';
import { searchSummary, sharingView } from '../lib/sharing';
import type { SeoSubject } from '@shared/seo';
import { openSiteSharing } from './SharingPreview';
import { LengthMeter, SeoPreview, subjectKey, useDocumentPreview, useTypedSeo } from './SeoPreview';
import { defaultReach, designContent, designContentOp, forwardedBinding, propDefaultOp, reachText, type ContentField, type DesignContent } from '../lib/design-content';
import { pickImagesField, pickOperations, planChoice } from '../lib/gallery-picks';
import { footerCopyPlan } from '../lib/page-navigation';
import { followsPageOrder } from '@engine/header-order';
import { FOLLOWING_MOVE_NOTE } from '../lib/header-menu-order';
import { HeaderMenuOrderSelect } from '../components/HeaderMenuOrder';
import { appliesLanded } from '../lib/pending';
import { BindingControl, PartSection, PropertiesSection, SlotsSection, StyleTargetField, TagBindingControl, VariantsSection, styleVariant, useVariantStyle } from './ContractControls';
import { PlacedSlotsSection } from './PlacedSlotsSection';
import { LivePreview } from './InsertPanel';
import { EntryBoundNote, EntryFieldsSection } from './EntryFields';
import { sampleEntries } from '../lib/template-view';
import { isHeadingLevel, placementOrder, variantStylable, type StyleTarget } from '../lib/component-contract';
import { useAskAiKeys } from '../lib/ask-ai-key';

type Tokens = ReturnType<typeof effectiveTokens>;
type Tone = 'local' | 'shared' | 'definition';

/** Inspector sections are headings one level below the selection's name. */
const LEVEL = 4;

/** Under each contact form field's name: the key its answer is sent under, or the other fields sent under it too. */
function formKeyNotes(def: ComponentDefinition, value: unknown): ((item: ListItem, index: number) => ListItemNote | undefined) | undefined {
  if (value !== undefined && !Array.isArray(value)) return undefined;
  const fields = formFieldsAsSent(def, value);
  return (_item, i) => ({ field: 'name', ...formKeyNote(fields, i) });
}

/**
 * Under a contact form's service setting: how to get it from the service. A value entered that the service won't
 * take is flagged here, beside it; a setting still empty is said in the problems above the sections.
 */
function formServiceHint(service: FormServiceSetup, entered: boolean): ReactNode {
  return (
    <>
      {entered && service.problem && <span className="field-warning">{service.problem}</span>}
      {service.setup}
    </>
  );
}

/** A property choosing a heading's level (Heading 1 to 6): it sets the page outline, not the look. */
const HEADING_LEVEL_HINT = 'Sets the page outline screen readers use, not the look. Use Heading 1 for the page title only.';

/** A video field's hint, when it has one. */
const videoHint = (note: VideoFieldNotes['url'] | VideoFieldNotes['title'] | undefined) => (note && 'hint' in note ? note.hint : undefined);

/**
 * Under the shared header's or footer's name and copyright line: whether it follows the site's name, which Site
 * details sets, and for a name of its own a way back to following it (#31).
 */
function siteNameHint(state: ProjectState, node: InstanceNode, prop: string, useSiteName: () => void): ReactNode | undefined {
  const note = followNote(state, node, prop);
  if (!note) return undefined;
  if (note.follows || prop !== 'siteName') return note.text;
  return (
    <>
      {note.text}{' '}
      <button type="button" className="link-btn" onClick={useSiteName}>
        Use the site name
      </button>
    </>
  );
}

const COPY_HEADER_MENU = 'Copy header menu to footer links';
const linkCount = (n: number) => `${n} link${n === 1 ? '' : 's'}`;

/**
 * Under the shared footer's links: copy the header menu's top-level links into them, replacing the footer's own, as
 * one step with an Undo (#575). None when the header has no links to copy.
 */
function footerCopyFill(state: ProjectState): ListFill | undefined {
  const plan = footerCopyPlan(state);
  if (!plan || plan.op.type !== 'instance.setProp') return undefined;
  const replaces = plan.replaces === 1 ? 'Replaces the link here.' : plan.replaces ? `Replaces the ${plan.replaces} links here.` : null;
  const fits = plan.left ? `Only the first ${plan.count} fit.` : null;
  return {
    id: `footer-links:${plan.op.nodeId}`,
    label: 'Copy from header menu',
    note: [replaces, fits].filter(Boolean).join(' ') || null,
    blocked: plan.matches ? 'These links already match the header menu.' : null,
    run: copyHeaderMenuToFooter
  };
}

/** A copy on its way, by the opening of its project: asked for again there (from a list editor shown again
 *  meanwhile), it is the same copy. */
let copying: { key: string; run: Promise<void> } | null = null;
/** How long a copy waits for saves already on their way before it is planned without them (and refused, if they
 *  land first): a save that never answers does not hold it. */
const COPY_WAIT_MS = 5000;

/**
 * Copy the header menu into the footer's links. A row edit saved as the author left it for the button lands first;
 * the copy is then planned on the project as it is and applied only to it, and never to a project opened meanwhile.
 * A row's field that has refused its text by then keeps the rows as they are (see ListFill).
 */
function copyHeaderMenuToFooter(refused: () => boolean): Promise<void> {
  const key = getState().snapshot?.workspaceKey ?? '';
  if (copying?.key === key) return copying.run;
  const run: Promise<void> = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([appliesLanded(), new Promise<void>((r) => (timer = setTimeout(r, COPY_WAIT_MS)))]);
    clearTimeout(timer);
    const now = getState().snapshot;
    if (!now || now.workspaceKey !== key || refused()) return;
    const plan = footerCopyPlan(now.state);
    if (!plan || plan.matches) return;
    const r = await commitOps([plan.op], COPY_HEADER_MENU, undefined, now.revision);
    if (!r || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
    toast(`The footer now lists the header menu’s ${linkCount(plan.count)}.`, 'info', undoAction(r));
  })().finally(() => {
    if (copying?.run === run) copying = null;
  });
  copying = { key, run };
  return run;
}

function listOps(owner: OwnerRef, nodeId: string, prop: string, op: Exclude<ListOp, { kind: 'pick' }>): EditOperation {
  switch (op.kind) {
    case 'insert':
      return { type: 'instance.listInsert', owner, nodeId, prop, ...(op.item ? { item: op.item } : {}) };
    case 'remove':
      return { type: 'instance.listRemove', owner, nodeId, prop, itemId: op.itemId };
    case 'move':
      return { type: 'instance.listMove', owner, nodeId, prop, itemId: op.itemId, index: op.index };
    case 'field':
    case 'repair':
      return { type: 'instance.setProp', owner, nodeId, prop, itemId: op.itemId, field: op.field, value: op.value };
  }
}

/**
 * Apply a list edit. A field edit joins the same field's last edit (`coalesceKey`); a repair the inspector offered
 * is its own undo step under its own name, on the project revision it was planned against.
 */
/**
 * A placement's value for a property as the project holds it now, with that revision: read when an edit is built,
 * after the edits before it have landed, rather than as the panel last rendered it.
 */
function readProp(owner: OwnerRef, nodeId: string, prop: string): { value: unknown; revision: number } | undefined {
  const snap = getState().snapshot;
  const node = snap ? treeFor(snap.state, owner)?.nodes[nodeId] : undefined;
  if (!snap || node?.kind !== 'instance') return undefined;
  const schema = snap.state.components[node.definitionId]?.properties[prop];
  return { value: node.props[prop] ?? schema?.default, revision: snap.revision };
}

/** Whether a page, a node, or a list row is still in the project: text kept for a field that belongs to one that
 *  goes is dropped and offered to copy (see DraftInput's keepWhile and FieldHome). */
const pageAlive = (id: string) => () => Object.hasOwn(getState().snapshot?.state.pages ?? {}, id);
const nodeAlive = (owner: OwnerRef, id: string) => () => {
  const s = getState().snapshot?.state;
  return !!s && Object.hasOwn(treeFor(s, owner)?.nodes ?? {}, id);
};
/** An article's own fields go when the page stops being an article. */
const articleAlive = (id: string) => () => {
  const pages = getState().snapshot?.state.pages ?? {};
  return Object.hasOwn(pages, id) && !!pageArticle(pages[id]);
};
/** A placement's property goes when its component no longer has it. */
const propAlive = (owner: OwnerRef, nodeId: string, prop: string) => () => {
  const s = getState().snapshot?.state;
  const node = s ? treeFor(s, owner)?.nodes[nodeId] : undefined;
  return node?.kind !== 'instance' || Object.hasOwn(s!.components[node.definitionId]?.properties ?? {}, prop);
};
/** One field of one row of a placement's list goes with the node, the list property, the row, or the field. */
const rowAlive = (owner: OwnerRef, nodeId: string, prop: string, itemId: string, field: string) => () => {
  const s = getState().snapshot?.state;
  const node = s ? treeFor(s, owner)?.nodes[nodeId] : undefined;
  if (!s || node?.kind !== 'instance') return false;
  const schema = s.components[node.definitionId]?.properties[prop];
  const list = node.props[prop] ?? schema?.default;
  return schema?.type === 'list' && Object.hasOwn(schema.fields, field) && Array.isArray(list) && list.some((x) => (x as ListItem | null)?.id === itemId);
};

/**
 * Add library images to a list in the order chosen, replacing the sample rows the author was shown, as one undo
 * step. It is planned against the project as it is now (see planChoice), and applies only to that revision, so
 * anything that lands in between refuses it and the picker stays open with the choice. Resolves to the rows it
 * added and how many it replaced, or null when nothing changed.
 */
async function applyPicks(owner: OwnerRef, nodeId: string, prop: string, op: Extract<ListOp, { kind: 'pick' }>): Promise<{ added: string[]; replaced: number } | null> {
  const snap = getState().snapshot;
  const node = snap ? treeFor(snap.state, owner)?.nodes[nodeId] : undefined;
  if (!snap || node?.kind !== 'instance') return null;
  const def = snap.state.components[node.definitionId];
  const schema = def?.properties[prop];
  const field = schema ? pickImagesField(def, prop, schema) : null;
  const value = node.props[prop] ?? schema?.default;
  if (schema?.type !== 'list' || !field || !Array.isArray(value)) return null;
  const plan = planChoice(schema, value as ListItem[], field, op.assetIds, op.replace, snap.state.assets.assets);
  if ('error' in plan) {
    toast(plan.error, 'error');
    return null;
  }
  const ops = pickOperations(owner, nodeId, prop, plan.steps);
  const results = await applyOps(ops, plan.label, undefined, snap.revision);
  if (!results) return null;
  const added = ops.flatMap((o, i) => (o.type === 'instance.listInsert' && typeof results[i]?.itemId === 'string' ? [results[i].itemId as string] : []));
  return { added, replaced: plan.steps.filter((st) => st.kind === 'remove').length };
}

function applyListOp(owner: OwnerRef, nodeId: string, prop: string, op: ListOp, label: string, coalesceKey?: string, everywhere = false) {
  if (op.kind === 'pick') return applyPicks(owner, nodeId, prop, op);
  if (op.kind === 'repair') return applyOps([listOps(owner, nodeId, prop, op)], op.label, undefined, op.revision);
  // History and Undo name the row and what was done to it; `label` is the fallback when the project can't say.
  const snap = getState().snapshot;
  const named = snap ? listEditLabel(snap.state, owner, nodeId, prop, op, label, everywhere) : label;
  return applyWith(op.kind === 'field' ? op.edit : undefined, [listOps(owner, nodeId, prop, op)], named, op.kind === 'field' ? coalesceKey : undefined);
}

/**
 * Apply one table edit by row and column ID. Typing in one cell (or one column's name) joins that cell's last edit;
 * adding, removing and moving rows or columns are each their own undo step.
 */
function applyTableEdit(owner: OwnerRef, nodeId: string, prop: string, edit: TableEdit, label: string): Promise<boolean> {
  const at = `${owner.kind}:${owner.id}:${nodeId}:${prop}`;
  const coalesceKey = edit.action === 'setCell' ? `${at}:${edit.rowId}:${edit.columnId}` : edit.action === 'renameColumn' ? `${at}:column:${edit.columnId}` : undefined;
  return applyOps([{ type: 'instance.editTable', owner, nodeId, prop, ...edit }], label, coalesceKey).then((r) => r !== null);
}


/**
 * A style edit's history key: changes to one property in a row merge into one Undo step. A focal point is the
 * exception: each drag, typed value or Center is its own step, so Undo goes back one drag at a time.
 */
const styleKey = (property: string, key: string) => (property === 'objectPosition' ? undefined : key);
/** A style change's size, and its interactive state (hover, focus, pressed) when it is for one. */
const styleAt = (scope: ResponsiveScope, inState?: StyleState) => (inState ? { scope, state: inState } : { scope });
/**
 * A design's rules on one of its nodes as its stylesheet writes them: without the group states no group of the design
 * around that node shows (see interaction-groups), so a dormant one never reads as what a placement starts from.
 */
const shownDesign = (def: ComponentDefinition, nodeId: string, styles: ResponsiveStyles | undefined) => (enclosingGroup(def.tree, nodeId) !== null ? styles : withoutGroupStates(styles));
const shownLayers = <L extends { styles?: ResponsiveStyles }>(def: ComponentDefinition, nodeId: string, layers: L[]): L[] =>
  enclosingGroup(def.tree, nodeId) !== null ? layers : layers.map((l) => ({ ...l, styles: withoutGroupStates(l.styles) }));
/** Whether an interaction group encloses a node of a document, so the node's group states can show. */
const inGroupAt = (state: ProjectState, owner: OwnerRef, nodeId: string) => enclosingGroup(treeFor(state, owner), nodeId) !== null;
/**
 * The resets a Style section asks for, as one step: every change at a size (or at every size), or only the changes
 * of some interactive states there.
 */
function styleResets(op: Omit<Extract<EditOperation, { type: 'node.resetStyles' }>, 'scope' | 'state'>, scope?: ResponsiveScope, states?: StyleState[]): EditOperation[] {
  return states?.length ? states.map((st) => ({ ...op, scope, state: st })) : [{ ...op, scope }];
}
/** A reset's name: `words`, or with only some states reset, which ones ("Reset hover and focus styles"). */
const RESET_STATE_WORDS: Record<StyleState, string> = { groupHover: 'group hover', groupFocus: 'group focus', hover: 'hover', focus: 'focus', active: 'active' };
const resetWords = (words: string, states?: StyleState[]) => {
  const names = (states ?? []).map((st) => RESET_STATE_WORDS[st]);
  return names.length ? `Reset ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]} styles` : words;
};

/** Where the preview serves pictures from, once it is running. */
const useDevUrl = () => useStore((s) => (s.runtime.state === 'ready' ? s.runtime.url : null));

/** An image as the page shows it, a repeated item's field default included (`shownOrDefault`). */
const shownImage = shownOrDefault;

/**
 * The picture an image shows, for choosing its focal point, with the style rules under its own. `value` is the
 * image as the page shows it (`shownValue`), undefined when that can't be told; `unknown` then says why.
 */
function focusImage(state: ProjectState, devUrl: string | null, value: unknown, below: FocusImage['below'], unknown: string, own?: ResponsiveStyles): FocusImage {
  if (value === undefined || isBinding(value)) return { src: null, below, own, missing: unknown };
  const assetId = (value as ImageValue | null)?.assetId;
  const asset = assetId && Object.hasOwn(state.assets.assets, assetId) ? state.assets.assets[assetId] : undefined;
  if (!asset) return { src: null, below, own, missing: 'No picture is chosen yet.' };
  return { src: assetUrl(devUrl, asset.file), width: asset.width, height: asset.height, below, own };
}

/**
 * What a single item shows under its own styles: the part's design, then the placement's shared changes, which win
 * over the design at every size (a shared all-sizes value beats the design's phone value). Cascaded the way the
 * stylesheet writes them, so each size carries the whole cascade.
 */
function sharedPartStyles(def: ComponentDefinition, nodeId: string, inst: InstanceNode, partId: string): ResponsiveStyles {
  const design = designLayers(def, nodeId, inst.variants);
  // The shared rule shows again what the node's own styles or its selected options hide, as the stylesheet writes it.
  return cascadeStyles([...design, { styles: inst.overrides?.[partId], strength: 3, wideColumns: true, unhides: design.map((l) => l.styles) }]);
}

/** The selection one level up: the component a part belongs to (what Escape selects). */
function parentOf(sel: ElementRef): ElementRef {
  return { owner: sel.owner, instancePath: sel.instancePath.slice(0, -1), nodeId: sel.instancePath[sel.instancePath.length - 1] };
}

/**
 * Select a list's component, open its Content and land in that list: on one row (expanded when `expand`), or
 * on its Add button when the list is empty.
 */
function openList(parent: ElementRef, listProp: string, rowId: string | undefined, expand: boolean) {
  setState({ selection: parent });
  setTimeout(() => {
    openSection('content');
    setTimeout(() => {
      const list = document.querySelector<HTMLElement>(`#dock-panel-inspect [data-list="${CSS.escape(listProp)}"]`);
      const head = rowId ? list?.querySelector<HTMLElement>(`#list-head-${CSS.escape(rowId)}`) : null;
      if (head && expand && head.getAttribute('aria-expanded') !== 'true') head.click();
      (head ?? list?.querySelector<HTMLElement>('.insp-add'))?.focus({ preventScroll: false });
    }, 250);
  }, 50);
}

/** How long an "Open in inspector" request waits for its component's Inspector, and then for the field to show. */
const REVEAL_MS = 5000;
const REVEAL_FIELD_MS = 1000;

/** Bring a content field into view, put focus on its control and ring it briefly. Nothing is clicked or changed. */
function revealField(slot: HTMLElement) {
  // A `display: contents` wrapper has no box of its own: ring the field inside it. A field that is its own slot rings itself.
  const box = getComputedStyle(slot).display === 'contents' ? ((slot.firstElementChild as HTMLElement | null) ?? slot) : slot;
  const control = slot.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select, [contenteditable="true"], button');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  control?.focus({ preventScroll: true });
  box.classList.remove('field-located');
  // Restarts the ring when the same field is opened again.
  void box.offsetWidth;
  box.classList.add('field-located');
  setTimeout(() => box.classList.remove('field-located'), 2600);
}

/** The field a request names in the Inspector: one of the component's own, or one of a list item's (once open). */
function findField(req: InspectorFocus): HTMLElement | null {
  const panel = document.getElementById('dock-panel-inspect');
  const own = [...(panel?.querySelectorAll<HTMLElement>(`[data-field="${CSS.escape(req.prop)}"]`) ?? [])].find((el) => !el.parentElement?.closest('.list-editor-body'));
  // One field of an object, inside the object's own fields.
  if (own && !req.itemId && req.field !== undefined) return own.querySelector<HTMLElement>(`[data-object-field="${CSS.escape(req.field)}"]`) ?? own;
  if (!own || !req.itemId) return own ?? null;
  const body = own.querySelector<HTMLElement>(`#list-item-${CSS.escape(req.itemId)}`);
  if (!body || body.hidden) return null;
  return body.querySelector<HTMLElement>(`[data-field="${CSS.escape(req.field ?? '')}"]`);
}

/**
 * Take an "Open in inspector" request meant for this component: open Content (the list item opens through
 * `reveal`), then reveal the field once it shows. The request is used once, found or not.
 */
function useFieldReveal(selection: ElementRef): InspectorFocus | null {
  const req = useStore((s) => {
    const f = s.inspectorFocus;
    const here = f && f.owner.kind === selection.owner.kind && f.owner.id === selection.owner.id && f.nodeId === selection.nodeId;
    return here && !selection.instancePath.length && !selection.partId && f.opening === s.snapshot?.workspaceKey ? f : null;
  });
  useEffect(() => {
    if (!req) return;
    const done = () => {
      if (getState().inspectorFocus?.seq === req.seq) setState({ inspectorFocus: null });
    };
    // Too late: the author has moved on since asking for it.
    if (Date.now() - req.at > REVEAL_MS) return done();
    openSection('content', { scroll: false });
    const until = Date.now() + REVEAL_FIELD_MS;
    let frame = 0;
    const step = () => {
      const el = findField(req);
      if (el) {
        revealField(el);
        done();
      } else if (Date.now() < until) frame = requestAnimationFrame(step);
      else {
        // It was there when the button was pressed, and has gone since (or is not shown here): say so.
        done();
        toast(`${req.label} is no longer in the Inspector.`, 'info');
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [req?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  return req;
}

/** Number of style values set across sizes. */
function countStyles(styles: ResponsiveStyles | undefined): number {
  return Object.values(styles ?? {}).reduce((n, sc) => n + Object.keys(sc ?? {}).length, 0);
}
const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;


/** The nearest repeat enclosing a node in a definition tree, if any. */
const enclosingRepeat = enclosingRepeatProp;

const focusName = () => requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('#dock-panel-inspect .insp-name h3')?.focus()));

/** Change the selection from inside the Inspector, then put focus on the new selection's name. */
function selectAndFocus(ref: ElementRef) {
  setState({ selection: ref });
  focusName();
}

/** Leave Edit everywhere for the page it was entered from; focus lands on that page's name, not the body. */
const doneEditing = () => {
  const dm = useStore.getState().definitionMode;
  if (!dm) return;
  setState({ definitionMode: null, pageId: dm.returnPageId, selection: null });
  focusName();
};

/** What kind of basic element a node is, in words and as an icon. */
function elementKind(node: GraphNode): { name: string; icon: ReactNode } {
  switch (node.kind) {
    case 'text':
      if (node.rich) return { name: 'Rich text', icon: <Pilcrow /> };
      if (typeof node.tag === 'string' && /^h[1-6]$/.test(node.tag)) return { name: 'Heading', icon: <Heading /> };
      return node.tag === 'p' ? { name: 'Paragraph', icon: <Pilcrow /> } : { name: 'Text', icon: <Pilcrow /> };
    case 'image':
      return { name: 'Image', icon: <ImageIcon /> };
    case 'link':
      return node.appearance === 'primary' || node.appearance === 'secondary' ? { name: 'Button', icon: <MousePointerClick /> } : { name: 'Link', icon: <LinkIcon /> };
    case 'icon':
      return { name: 'Icon', icon: <Shapes /> };
    case 'element':
      return { name: 'Container', icon: <SquareDashed /> };
    default:
      return { name: 'Element', icon: <SquareDashed /> };
  }
}

/**
 * The Inspector, with one status line that outlives every selection's panel: problems a selection brings are said
 * through it as the selection arrives.
 */
export function Inspector() {
  useFocusRecovery();
  return (
    <>
      <p id="insp-announce" className="sr-only" role="status" aria-live="polite" />
      <InspectorBody />
    </>
  );
}

/**
 * When the control that had focus is taken out of the Inspector (a selection change, an undo, a row removed) and
 * nothing else took focus, it goes to the selection's name rather than back to the start of the window. Focus that
 * moved to the canvas, Layers or a dialog is left where it is.
 */
function useFocusRecovery() {
  useEffect(() => {
    const panel = document.getElementById('dock-panel-inspect');
    if (!panel) return;
    // The Inspector control focus was last on, and only while focus stays in the Inspector: focus that has moved to
    // Layers, the canvas or a menu clears it, so their own handoffs are never overruled.
    let last: Element | null = null;
    const onIn = (e: FocusEvent) => (last = e.target instanceof Element && panel.contains(e.target) ? e.target : null);
    const mo = new MutationObserver(() => {
      if (!last || last.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
      last = null;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        panel.querySelector<HTMLElement>('.insp-name h3')?.focus();
      });
    });
    document.addEventListener('focusin', onIn);
    mo.observe(panel, { childList: true, subtree: true });
    return () => {
      document.removeEventListener('focusin', onIn);
      mo.disconnect();
    };
  }, []);
}

function InspectorBody() {
  const snap = useStore((s) => s.snapshot);
  // Text handed to a page's settings from elsewhere (an inline rename too long to save) is shown by them afresh.
  const handoff = useStore((s) => s.keptHandoff);
  const selection = useStore((s) => s.selection);
  const pageId = useStore((s) => s.pageId);
  const definitionMode = useStore((s) => s.definitionMode);
  const templateMode = useStore((s) => s.templateMode);
  const workspace = useStore(activeWorkspace);
  const tokens = useMemo(() => (snap ? effectiveTokens(snap.state) : []), [snap?.state.tokens, snap?.state.site.themeId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!snap) return null;
  const st = snap.state;
  // The SEO view covers the canvas: what it has chosen is what is in front, never the page or selection under it (#700).
  if (workspace === 'seo') return <SeoOverview state={st} />;
  // The post writer, or a post previewed: the post is what is in front, never the page under it (#578).
  if (workspace) return <PostOverview state={st} workspace={workspace} />;
  const editingDef = definitionMode ? st.components[definitionMode.definitionId] : undefined;
  // While editing a component everywhere, every route (canvas, Layers, nothing selected) shows that component.
  const throughPlacement = !!selection && selection.instancePath.length > 0 && (() => {
    const inst = resolveRef(st, { owner: selection.owner, instancePath: [], nodeId: selection.instancePath[0] }).node;
    return inst?.kind === 'instance' && inst.definitionId === editingDef?.id;
  })();
  if (editingDef && (!selection || (selection.owner.kind === 'component' && selection.owner.id === editingDef.id) || !throughPlacement)) {
    // Outside picks (another section) show the overview: the mode edits this component only. A part of a component
    // placed in the design (its row in Layers) shows that part, as this design sets it.
    const view = definitionView(st, editingDef.id, selection);
    return (
      <div className="panel-body insp" key={selection ? JSON.stringify(selection) : `def-overview:${editingDef.id}`}>
        {view.kind === 'node' ? (
          <DefinitionNodeInspector state={st} def={editingDef} node={view.node} tokens={tokens} />
        ) : view.kind === 'nested-part' ? (
          <PartInspector state={st} selection={selection!} tokens={tokens} everywhere={editingDef} />
        ) : (
          <DefinitionOverview state={st} def={editingDef} />
        )}
      </div>
    );
  }
  // A collection's layout with nothing selected: what it is, the entry it is shown on, and the way back.
  if (!selection && templateMode && st.collections[templateMode.collectionId])
    return (
      <div className="panel-body insp" key={`layout:${templateMode.collectionId}`}>
        <LayoutOverview state={st} collectionId={templateMode.collectionId} entryId={templateMode.entryId} />
      </div>
    );
  // Keyed by page: fields being typed in belong to their page, never to the one shown after it.
  if (!selection) return pageId ? <PageSettings key={`${pageId}:${handoff}`} page={st.pages[pageId]} state={st} /> : null;
  const r = resolveRef(st, selection);
  // A part a code component's author marked: the code has no nodes, so the part is named by its contract alone.
  if (!r.node && isCodePart(st, selection))
    return (
      <div className="panel-body insp" key={JSON.stringify(selection)}>
        <CodePartInspector state={st} selection={selection} tokens={tokens} />
      </div>
    );
  if (!r.node)
    return (
      <div className="empty-insp">
        <MousePointerClick />
        <span>The selected element no longer exists.</span>
      </div>
    );
  // A slot picked on the canvas by its empty box: what it is for, and its placement a click away (#652).
  const slot = placedSlot(st, selection);
  if (slot)
    return (
      <div className="panel-body insp" key={JSON.stringify(selection)}>
        <SlotInspector label={slot.label} description={slot.def.slots?.[slot.slot]?.description} placement={withoutSlot(selection)} placementName={refLabel(st, withoutSlot(selection))} />
      </div>
    );
  // Deeper inside the placement being edited (a component nested in it): stay in the design's own view.
  if (editingDef && throughPlacement && selection.instancePath.length > 1)
    return (
      <div className="panel-body insp" key={JSON.stringify(selection)}>
        <DefinitionOverview state={st} def={editingDef} nested />
      </div>
    );
  return (
    <div className="panel-body insp" key={JSON.stringify(selection)}>
      {definitionMode && selection.instancePath.length === 1 && r.def?.id === definitionMode.definitionId ? (
        <DefinitionNodeInspector state={st} def={r.def} node={r.node} tokens={tokens} />
      ) : !selection.instancePath.length && r.node.kind === 'instance' ? (
        <InstanceInspector state={st} owner={selection.owner} node={r.node} tokens={tokens} selection={selection} />
      ) : selection.instancePath.length ? (
        <PartInspector state={st} selection={selection} tokens={tokens} />
      ) : (
        <PrimitiveInspector state={st} owner={selection.owner} node={r.node} tokens={tokens} selection={selection} />
      )}
    </div>
  );
}

/**
 * A slot of a placement, picked by its empty box (#652). It has no settings or styles of its own: what is clicked in
 * Insert, or dragged onto it, goes in it. Its placement's own settings are one click away.
 */
function SlotInspector({ label, description, placement, placementName }: { label: string; description?: string; placement: ElementRef; placementName: string }) {
  return (
    <>
      <Header
        title={label}
        icon={<SquareDashed />}
        kind={
          <>
            Place for content in{' '}
            <button className="link-btn" onClick={() => selectAndFocus(placement)} title="Select the whole component (Esc)">
              {placementName}
            </button>
          </>
        }
      />
      {description?.trim() ? <p className="insp-note">{description.trim()}</p> : null}
      <p className="insp-note muted">Click an element or component in Insert, or drag one onto this place, to put it here.</p>
    </>
  );
}

/**
 * Sticky inspector header, the same anatomy for every selection: a kind tile, the name, what kind of thing it
 * is, then who a change affects. Commands for the selection sit at the right of the name.
 */
function Header({ title, kind, icon, tone = 'local', actions, children }: { title: string; kind: ReactNode; icon: ReactNode; tone?: Tone; actions?: ReactNode; children?: ReactNode }) {
  // The name takes focus (not a tab stop) when an Inspector link changes the selection, so focus stays here.
  // Keyboard focus scrolls fields clear of this header at whatever height it wraps to.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const body = el?.closest<HTMLElement>('.panel-body');
    if (!el || !body) return;
    // Written only when the height changes. The style controls measure this header for their own allowance.
    const ro = new ResizeObserver(() => {
      // Room for the label above a focused field as well as the field.
      const h = `${Math.ceil(el.offsetHeight) + 32}px`;
      if (body.style.getPropertyValue('--insp-head-h') !== h) body.style.setProperty('--insp-head-h', h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="insp-head insp-sel" ref={ref}>
      <div className="insp-id">
        <span className={`insp-kind ${tone}`} aria-hidden="true">
          {icon}
        </span>
        <div className="insp-name">
          <h3 title={title} tabIndex={-1}>
            {title}
          </h3>
          <span className="insp-kind-label">{kind}</span>
        </div>
        {actions && <div className="insp-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** One line saying who a change affects. Ordinary page-only edits stay quiet; shared and definition scopes keep their hue. */
function Scope({ tone, icon, children, aside }: { tone: Tone; icon: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className={`insp-scope ${tone}`}>
      {icon}
      <span className="grow">{children}</span>
      {aside}
    </div>
  );
}

/**
 * Setup problems that stop something working on the site, between the header and the sections, so a closed Content
 * can't hide them. The strip is always mounted, so a problem that appears while the panel is open is announced.
 */
function Problems({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children);
  const [all, setAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const said = useRef<string | null>(null);
  // Said through the Inspector's lasting status line, so a problem is heard when its selection arrives, not only
  // when it appears while the panel is already open. Each selection says its problems once; leaving clears them.
  useEffect(() => {
    const text = [...(ref.current?.querySelectorAll('.grow') ?? [])].map((el) => el.textContent ?? '').join(' ');
    if (text !== said.current) announce((said.current = text));
  });
  useEffect(() => () => announce(''), []);
  // Many broken list items would push Content out of view: the first stays, the rest are one click away.
  const shown = all || rows.length <= 2 ? rows : rows.slice(0, 1);
  return (
    <div className={rows.length ? 'insp-problems' : 'insp-problems empty'} ref={ref}>
      {shown}
      {shown.length < rows.length && (
        <button className="insp-mini insp-more" onClick={() => setAll(true)}>
          Show {rows.length - shown.length} more {rows.length - shown.length === 1 ? 'problem' : 'problems'}
        </button>
      )}
    </div>
  );
}

/** A list item by its title (“Planning & layout”), else by its place ("card 2"), for a problem row. */
function itemTitle(def: ComponentDefinition, value: unknown, prop: string, itemId: string): string {
  const schema = def.properties[prop];
  if (schema?.type !== 'list') return '';
  const items = (Array.isArray(value) ? value : schema.default) as ListItem[] | undefined;
  const i = Array.isArray(items) ? items.findIndex((it) => it?.id === itemId) : -1;
  if (i < 0) return '';
  const t = schema.titleField ? (items![i] as Record<string, unknown>)[schema.titleField] : undefined;
  return typeof t === 'string' && t.trim() ? `“${t.trim()}”` : `${schema.itemLabel.toLowerCase()} ${i + 1}`;
}

/**
 * The Inspector's status line, outside every selection's panel. Emptied first, so the same words said for the next
 * selection are heard again.
 */
function announce(text: string) {
  const el = document.getElementById('insp-announce');
  if (!el) return;
  el.textContent = '';
  if (text) requestAnimationFrame(() => (el.textContent = text));
}

/** One problem: what visitors will experience, then what is missing, with a way to the field when it is here. */
function Problem({ children, onGo, go = 'Go to field' }: { children: ReactNode; onGo?: () => void; go?: string }) {
  return (
    <div className="insp-scope danger">
      <CircleAlert />
      <span className="grow">{children}</span>
      {onGo && (
        <button className="insp-mini" onClick={onGo}>
          {go}
        </button>
      )}
    </div>
  );
}

/**
 * Open a section if it is closed, then bring one of its own fields (not a list item's) into view and focus it: for
 * an object, the one field of it named.
 */
function revealContentField(section: string, prop: string, field?: string) {
  openSection(section, { scroll: false });
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const slots = document.querySelectorAll<HTMLElement>(`#dock-panel-inspect [data-field="${CSS.escape(prop)}"]`);
      const slot = [...slots].find((el) => !el.parentElement?.closest('.list-editor-body'));
      const inner = slot && field !== undefined ? slot.querySelector<HTMLElement>(`[data-object-field="${CSS.escape(field)}"]`) : null;
      if (slot) revealField(inner ?? slot);
    })
  );
}

/** Open Content, open one list item's row, then bring one of its fields into view and focus it. */
function revealListField(prop: string, itemId: string, field: string) {
  openSection('content', { scroll: false });
  setTimeout(() => {
    const list = document.querySelector<HTMLElement>(`#dock-panel-inspect [data-list="${CSS.escape(prop)}"]`);
    const head = list?.querySelector<HTMLElement>(`#list-head-${CSS.escape(itemId)}`);
    if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const slot = document.querySelector<HTMLElement>(`#list-item-${CSS.escape(itemId)} [data-field="${CSS.escape(field)}"]`);
        if (slot) revealField(slot);
        else head?.focus();
      })
    );
  }, 60);
}

/** "both" for two, "all 3" for more. */
const allOf = (n: number) => (n === 2 ? 'both' : `all ${n}`);

/**
 * Several layers selected together in Layers: the fields below belong to the one everything follows, while
 * Duplicate and Delete (and their shortcuts) act on all of them. Said first, so neither surprises.
 */
function GroupScope({ plan, title }: { plan: ReturnType<typeof planLayers>; title: string }) {
  if (!plan?.several) return null;
  // Quiet like the page scope, with the selection blue on its icon alone: this is the live selection, not a reach.
  return (
    <div className="insp-scope local group">
      <Layers />
      <span className="grow">
        <strong>{groupCount(plan.group)} selected.</strong> Editing {title}. Duplicate and Delete affect {allOf(plan.group.ids.length)}.
      </span>
    </div>
  );
}

/**
 * The selection's commands, grouped by what they reach when several layers are selected together: the ones for
 * the selected layer alone under its name, then Duplicate and Delete under the count they act on.
 */
/**
 * Wrap in Stack, Row or Grid, and Ungroup, for what the Inspector's menu acts on (the layers selected together, or the
 * selection), followed by a separator unless `trail` is false: planned again as one is chosen, as Duplicate and Delete are.
 */
function wrapMenu(plan: ReturnType<typeof planLayers>, trail = true): MenuItem[] {
  const items = wrapItems(
    plan,
    {
      wrap: (k) => void asPlanned(plan, async (p) => void (await wrapLayers(k, p)))(),
      ungroup: () => void asPlanned(plan, async (p) => void (await ungroupLayers(p)))()
    },
    plan?.several ? groupCount(plan.group) : undefined
  );
  return items.length && trail ? [...items, { separator: true }] : items;
}

function groupedItems(plan: ReturnType<typeof planLayers>, title: string, own: MenuItem[], batch: MenuItem[]): MenuItem[] {
  const ownItems = own.filter((it, i, all) => !(it.separator && (i === 0 || i === all.length - 1 || all[i - 1]?.separator)));
  if (!plan?.several) return [...ownItems, ...(ownItems.length && batch.length ? [{ separator: true }] : []), ...batch];
  return [...(ownItems.length ? [{ heading: title }, ...ownItems, { separator: true }] : []), { heading: groupCount(plan.group) }, ...batch];
}

function OwnerScope({ owner, state, aside }: { owner: OwnerRef; state: ProjectState; aside?: ReactNode }) {
  const pageId = useStore((s) => s.pageId);
  if (owner.kind === 'shell') {
    const { pages: n, here } = shellReach(state, owner.id, pageId);
    // Which pages inherit it, by name: one edit here (a notice, a menu link) reaches every one of them.
    const names = shellPageNames(state, owner.id);
    return (
      <Scope tone="shared" icon={<Users />} aside={aside}>
        <strong>Shared {owner.id}.</strong> {here ? '' : 'Not shown on this page. '}
        {n === 0 ? (
          'No page shows it.'
        ) : (
          <>
            Changes show on {n === 1 ? 'the 1 page' : `all ${n} pages`} that use it:{' '}
            <span className="insp-scope-pages" title={names.all}>
              {names.text}
            </span>
            .
          </>
        )}
      </Scope>
    );
  }
  if (owner.kind === 'component')
    return (
      <Scope tone="definition" icon={<Pencil />}>
        <strong>Component design.</strong> Changes apply everywhere {state.components[owner.id]?.name ?? 'it'} is used.
      </Scope>
    );
  if (owner.kind === 'template') {
    const c = state.collections[owner.id];
    const n = c ? Object.keys(c.entries).length : 0;
    return (
      <Scope tone="shared" icon={<Users />} aside={aside}>
        <strong>{c?.settings.name ?? 'Collection'} layout.</strong> Changes show on {n === 1 ? 'its 1 entry' : `all ${n} of its entries`}.
      </Scope>
    );
  }
  return (
    <Scope tone="local" icon={<FileText />} aside={aside}>
      Only on the {ownerLabel(state, owner)} page
    </Scope>
  );
}

/**
 * A compact "Parts" menu: the way from a section down to one of its parts, beside the Style jump, and from one part
 * across to another (the current one checked).
 */
function PartsButton({ title, parts }: { title: string; parts: Array<{ label: string; select: () => void; current?: boolean }> }) {
  const menu = useMenu();
  return (
    <>
      <button className="insp-mini" aria-haspopup="menu" aria-expanded={menu.isOpen} title={`Select a part of ${title}`} onClick={(e) => menu.openAt(e.currentTarget, parts.map((p) => ({ label: p.label, onSelect: p.select, ...(p.current !== undefined ? { checked: p.current } : {}) })), `Parts of ${title}`)}>
        Parts <ChevronDown aria-hidden="true" />
      </button>
      {menu.node}
    </>
  );
}

/** What the Copy and Paste of the Inspector's actions do: Copy takes content from a page (the layers selected together
 *  with it, as planned when the menu was built), Paste goes after or inside the selection, on a page or in a component
 *  edited everywhere. */
function clipboardActions(owner: OwnerRef, plan: ReturnType<typeof planLayers>): CopyPasteActions {
  return { copy: plan && owner.kind === 'page' ? asPlanned(plan, async (p) => void copySelection(p)) : null, paste: () => void pasteFromMenu() };
}

/** Ask AI, plus a menu of everything else that can be done to the selection. */
function SelectionActions({ title, selection, items, group, ask = true }: { title: string; selection: ElementRef; items: MenuItem[]; group?: string; ask?: boolean }) {
  const menu = useMenu();
  const askKeys = useAskAiKeys();
  return (
    <>
      {ask && (
        <button className="icon-btn" aria-label={`Ask AI about ${title}`} title={`Ask AI about ${title} (${platformKeys(askKeys.hint)})`} onClick={() => askAiAbout(selection)}>
          <Sparkles />
        </button>
      )}
      {items.length > 0 && (
        <button
          className="icon-btn"
          aria-haspopup="menu"
          aria-expanded={menu.isOpen}
          aria-label={group ? `More actions for ${title} and the ${group} selected` : `More actions for ${title}`}
          title="More actions"
          onClick={(e) => menu.openAt(e.currentTarget, items, group ? `Actions for ${title} and the ${group} selected` : `Actions for ${title}`)}
        >
          <Ellipsis />
        </button>
      )}
      {menu.node}
    </>
  );
}

/**
 * A Section's columns, arranged where the Section is selected rather than through Parts: its Container's Arrange,
 * Columns, Column sizes and gaps (see columnLayoutPart). Any other change made to the Container shows here too, so
 * nothing that outranks a column change (a Custom CSS rule, say) is out of sight while the columns are set. Nothing for
 * a component that is no Section.
 */
/** A History label worked out from the project as it is now, or `fallback` while none is open. */
const named = (label: (st: ProjectState) => string, fallback: string) => {
  const st = getState().snapshot?.state;
  return st ? label(st) : fallback;
};

function ColumnLayout({ owner, def, node, variants, tokens, onSet }: { owner: OwnerRef; def: ComponentDefinition; node: InstanceNode; variants: Parameters<typeof designStyles>[2]; tokens: Tokens; onSet: (partId: string) => (property: string, value: StyleValue | null, expectedRevision?: number) => unknown }) {
  const columns = columnLayoutPart(def);
  const part = columns ? def.parts[columns.partId] : undefined;
  if (!columns || !part) return null;
  const set = countStyles(node.overrides?.[columns.partId]);
  return (
    <Section title="Column layout" id="columns" level={LEVEL} scope={[part.label, set ? changes(set) : ''].filter(Boolean).join(' · ')}>
      <StyleControls
        styles={node.overrides?.[columns.partId]}
        inherited={designStyles(def, part.nodeId, variants)}
        wideColumns
        allowed={columns.controls}
        tokens={tokens}
        onSet={onSet(columns.partId)}
        onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id, partId: columns.partId, scope: sc }], named((st) => forLabel(st, `Reset ${part.label.toLowerCase()}`, refTo(owner, node.id)), `Reset ${part.label.toLowerCase()}`))}
        // Column layout styles a part inside the selection, which the canvas does not show in a state.
        states={false}
        target={`the ${part.label.toLowerCase()}`}
      />
    </Section>
  );
}

function InstanceInspector({ state, owner, node, tokens, selection }: { state: ProjectState; owner: OwnerRef; node: InstanceNode; tokens: Tokens; selection: ElementRef }) {
  // Layers selected together with this one (the menu's Duplicate and Delete act on them all): followed so the menu
  // is rebuilt when they change, and planned with it, so what the menu says is what it does.
  useStore((s) => {
    const g = s.layerSet ? liveGroup(s) : null;
    return g ? g.ids.join(' ') : null;
  });
  const plan = planLayers();
  const scope = useStore((s) => s.styleScope);
  const dev = useStore((s) => !!s.settings?.developerMode);
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  const devUrl = useDevUrl();
  // Which declared part of a code component the Style section edits.
  const [codePart, setCodePart] = useState('root');
  const reveal = useFieldReveal(selection);
  const styleItems = useStyleCopyItems(selection);
  const clipboard = useCopyPasteItems(clipboardActions(owner, plan));
  const def = state.components[node.definitionId];
  // The part the Style section styles (see styledPart below).
  const partStyled = def?.kind === 'code' && def.parts[codePart] ? codePart : 'root';
  // Another part styled (chosen, or the one styled is gone: an Undo, the AI) is styled at rest until a state is chosen
  // for it, and the canvas lets go of the part it showed in a state.
  useEffect(() => {
    const s = getState();
    if (s.styleState && s.styleStatePart !== (partStyled === 'root' ? null : partStyled)) setState({ styleState: null, styleStatePart: null });
  }, [partStyled]);
  if (!def) return null;
  const title = node.name ?? def.name;
  const shell = owner.kind === 'shell';
  // An axis with one option is not a choice. Every kind of component offers its axes, code components included.
  const axes = axesOf(def).filter(([, a]) => Object.keys(a.options).length > 1);
  const selectedAxes = selectedVariants(def, node.variants);
  const uses = instancesOf(state, def.id).length;
  const partIds = def.kind === 'managed' ? Object.keys(def.parts).filter((p) => p !== 'root') : [];
  const rootPart = def.parts.root;
  // A code component takes style changes only when it places the classes it is given.
  const codeStyled = def.kind === 'code' && codeTakesOverrides(def);
  // Styles set here beat any selector of the component's own, but not a value its code marks important.
  const codeImportant = codeStyled ? codeImportantProps(def) : [];
  // A design whose root is a placed code component: its whole-section styles land on that code's root.
  const rootCode = def.kind === 'managed' ? renderedCode(state, node) : undefined;
  const styledPart = partStyled;
  // Making a code component unique copies its source into the project, which is only editable in developer mode.
  const canMakeUnique = def.kind === 'managed' || dev;
  // An entrance lands on the design's root element, which only a design built in the editor places.
  const entrance = anchorCapable(state, def);
  const origin = def.owner === 'project' ? (def.kind === 'code' ? 'Code component' : 'Your component') : 'From the theme';
  // Inside a column, container or slot, or made to go inside layouts, a placement is a component, not a section (#661).
  const noun = placementNoun(state, selection);
  const here = refTo(owner, node.id);
  const set = (prop: string, value: unknown, edit?: PendingEdit) => applyWith(edit, [{ type: 'instance.setProp', owner, nodeId: node.id, prop, value }], fieldLabel(state, def.properties[prop]?.label ?? prop, here), `${node.id}:${prop}`);
  const onStyle = (partId: string) => (property: string, value: StyleValue | null, expectedRevision?: number, inState?: StyleState) =>
    commitOps([{ type: 'node.setStyle', owner, nodeId: node.id, partId, ...styleAt(scope, inState), property, value }], styleLabel(state, property, here, partId === 'root' ? undefined : (def.parts[partId]?.label ?? partId), value, inState), styleKey(property, `${node.id}:${partId}:${styleScopeKey(scope, inState)}:${property}`), expectedRevision);
  // A component whose whole design is one image (made from a cropped page image) chooses its focus here.
  const rootNodeId = rootPart?.nodeId ?? def.tree?.rootIds[0];
  const rootNode = rootNodeId ? def.tree?.nodes[rootNodeId] : undefined;
  const rootImage =
    rootNode?.kind === 'image' && rootNodeId
      ? focusImage(state, devUrl, shownImage(state, { owner, instancePath: [node.id], nodeId: rootNodeId }, rootNode.image), [selectedVariantStyles(def, node.variants, rootNodeId), [rootNode.styles]], 'This picture can’t be shown here.')
      : undefined;
  const overrides = countStyles(node.overrides?.[styledPart]);
  const selectPart = (p: string) => selectAndFocus({ owner, instancePath: [node.id], nodeId: def.parts[p].nodeId, partId: p });
  const editEverywhere = () => setState({ modal: { kind: 'edit-definition', ref: selection } });
  const makeUnique = () => setState({ modal: { kind: 'make-unique', owner, nodeId: node.id, definitionId: def.id } });
  // A section (or a card inside one) can show another design where it is, keeping its content (#374). The shared
  // header and footer keep theirs, and a placement inside a design is changed in that design.
  const swappable = !shell && !readOnly && !selection.instancePath.length && !selection.partId && (owner.kind === 'page' || owner.kind === 'template');
  const top = swappable && !!treeFor(state, owner)?.rootIds.includes(node.id);
  const swapDesign = () => setState({ modal: { kind: 'swap-component', owner, nodeId: node.id, definitionId: def.id } });
  // A section holding content of its own (not a copy of its design, which Make unique makes) becomes a component
  // with that content. Not while other layers are selected with it: the menu's other commands act on them all.
  const create = plan?.several ? null : createComponentTarget({ state, readOnly }, selection);
  const viewSource = () => setState({ modal: { kind: 'source', definitionId: def.id } });
  // The copy's structure is now edited in source, so offer to open it straight away.
  const convertToCode = async () => {
    const r = await applyOps([{ type: 'component.convertToCode', owner, nodeId: node.id }], 'Convert to code');
    const id = r?.[0]?.definitionId as string | undefined;
    if (id) toast('Converted to a code component. Its properties stay editable here.', 'info', { label: 'Open code', run: () => setState({ modal: { kind: 'source', definitionId: id } }) });
  };
  // Parts are reached from the Parts menu on the scope line, so this menu keeps to commands.
  const items = groupedItems(
    plan,
    title,
    [
      ...(def.kind === 'managed' ? [{ label: 'Edit everywhere…', icon: <Pencil />, onSelect: editEverywhere }] : []),
      ...(swappable ? [{ label: top && noun === 'section' ? 'Change section design…' : 'Change design…', icon: <ArrowRightLeft />, hint: 'Keeps its content', onSelect: swapDesign }] : []),
      ...(canMakeUnique ? [{ label: 'Make unique…', icon: <Split />, onSelect: makeUnique }] : []),
      ...(create ? [{ label: 'Create component…', icon: <Component />, hint: 'With its content', onSelect: () => setState({ modal: { kind: 'create-component', ref: create } }) }] : []),
      ...(detachable(state, selection) ? [{ label: 'Detach component', icon: <Unlink />, hint: 'Into elements', onSelect: () => void detachPlacement(selection) }] : []),
      ...(dev && def.kind === 'managed' ? [{ label: 'Convert to code', icon: <Code />, onSelect: () => void convertToCode() }] : []),
      ...(dev ? [{ label: def.kind === 'code' && def.owner === 'project' ? 'Edit code' : 'View source', icon: <FileCode2 />, onSelect: viewSource }] : []),
      // Kept for every project, or sent as a file (#372).
      ...(carriesAcross(def) && (dev || def.kind !== 'code')
        ? [
            { label: 'Save to personal library', icon: <BookmarkPlus />, hint: 'For every project', onSelect: () => void saveToLibrary(def) },
            { label: 'Export component…', icon: <Download />, hint: 'As a file', onSelect: () => void exportComponentFile(def) }
          ]
        : []),
      { separator: true },
      ...styleItems
    ],
    shell
      ? []
      : [
          ...wrapMenu(plan),
          ...clipboard,
          // With layers selected together in Layers, these act on all of them, as their shortcuts do, and say so.
          { label: plan?.several ? `Duplicate ${groupCount(plan.group)}` : 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: asPlanned(plan, duplicateLayers) },
          { label: plan?.several ? `Delete ${groupCount(plan.group)}` : 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: asPlanned(plan, deleteLayers) }
        ]
  );
  // A contact form shows only the setting its service needs. The others keep their values for a switch back.
  const service = formServiceSetup(def, node.props);
  // A header without a logo leaves out the logo's size; it keeps its value for the next logo.
  const headerHidden = headerHiddenProps(state, def, node.props);
  // A heading level changes the page outline, not the look: it comes after the content rather than between a
  // heading and the words under it.
  const fields = groupFields(
    placementOrder(def)
      .filter((key) => !service?.hidden.includes(key) && !headerHidden.includes(key))
      .map((key) => ({ key, schema: def.properties[key], data: null }))
  );
  // Buttons with no link are left out of the site: flag each at the field that sets its link. Hide is offered there
  // only when that field and the label belong to the same one button (not a link or label every item shares).
  const unlinked = unlinkedAt(state, owner, node.id);
  const hideAction = (b: UnlinkedButton | undefined) => (b?.hide ? { label: 'Hide button', run: () => void applyOps([hideButtonOp(owner, node.id, b.hide!)], `Hide ${b.label ? `“${b.label}” ` : ''}button in ${subjectWords(state, here)}`) } : undefined);
  const formNotes = (key: string) => (key === 'fields' && namesFormFields(def) ? formKeyNotes(def, node.props.fields) : undefined);
  const notes = (key: string) => {
    const form = formNotes(key);
    if (!unlinked.some((b) => b.link?.prop === key && b.link.itemId)) return form;
    return (item: ListItem, i: number): ListItemNote | undefined => {
      const b = unlinked.find((x) => x.link?.prop === key && x.link.itemId === item.id);
      const own = hideAt(b, item.id);
      return form?.(item, i) ?? (b?.link?.field ? { field: b.link.field, error: unlinkedNote({ hide: own?.hide }), action: hideAction(own) } : undefined);
    };
  };
  // Buttons whose link this placement cannot set (it comes from the design or a component inside it).
  const fixedUnlinked = unlinked.filter((b) => !b.link);
  // A video (the section or the compact block) says whether its address is a video visitors can play, where it loads
  // from, and when it needs a title.
  const video = isVideoContract(def.componentId) ? videoFieldNotes(node.props) : undefined;
  // The shared footer's menu takes the header menu's links in one step (#575).
  const footerMenuId = owner.kind === 'shell' && owner.id === 'footer' ? shellMenu(state, 'footer')?.node.id : undefined;
  // The shared header's menu chooses its order over its links: its own, or the Pages order (#749).
  const headerMenuId = owner.kind === 'shell' && owner.id === 'header' ? shellMenu(state, 'header')?.node.id : undefined;
  const videoNote = (key: string) => (key === 'url' || key === 'title' ? video?.[key as keyof VideoFieldNotes] : undefined);
  const videoEmpty = !!video && !String(node.props.url ?? '').trim();
  // A renamed section still says what it is: the name is the author's, the kind line the component's.
  const what = node.name && node.name !== def.name ? def.name : noun === 'component' ? 'Component' : shell ? `Shared ${owner.id}` : 'Section';
  const whole = `Whole ${noun}`;
  const goToField = (prop: string, field?: string) => revealContentField('content', prop, field);
  return (
    <>
      <Header
        title={title}
        kind={`${what} · ${origin.toLowerCase()}`}
        tone={shell || owner.kind === 'template' ? 'shared' : 'local'}
        icon={shell ? owner.id === 'footer' ? <PanelBottom /> : <PanelTop /> : <Component />}
        actions={<SelectionActions title={title} selection={selection} items={items} group={plan?.several ? groupCount(plan.group) : undefined} />}
      >
        <GroupScope plan={plan} title={title} />
        <OwnerScope
          owner={owner}
          state={state}
          aside={
            (def.kind === 'managed' || codeStyled) && (
              <span className="insp-mini-row">
                {partIds.length > 0 && <PartsButton title={title} parts={partIds.map((p) => ({ label: def.parts[p].label, select: () => selectPart(p) }))} />}
                <button className="insp-mini" onClick={() => openSection('style')} title="Open Style and scroll to it">
                  Style <ArrowDown aria-hidden="true" />
                </button>
              </span>
            )
          }
        />
      </Header>
      <Problems>
        {service?.problem && (
          <Problem onGo={() => goToField(service.prop)} go={`Go to ${(def.properties[service.prop]?.label ?? 'the setting').replace(/^Form /, '')}`}>
            <strong>This form can’t send messages yet.</strong> {service.problem}
          </Problem>
        )}
        {video && (video.url?.error || videoEmpty) && (
          <Problem onGo={() => goToField('url')} go={videoEmpty ? 'Add an address' : 'Go to address'}>
            <strong>Visitors see no video yet.</strong> {videoEmpty ? 'Paste the address of a YouTube or Vimeo video.' : `The address isn’t one this ${noun} can play.`}
          </Problem>
        )}
        {/* A button whose link this placement sets: one row each, straight to its link, a list item's row opened for it. */}
        {unlinked
          .filter((b) => b.link)
          .map((b, i) => {
            const at = b.link!;
            const where = at.itemId ? itemTitle(def, node.props[at.prop], at.prop, at.itemId) : '';
            return (
              <Problem key={`own-${i}`} onGo={() => (at.itemId && at.field ? revealListField(at.prop, at.itemId, at.field) : goToField(at.prop, at.field))} go="Choose a link">
                <strong>Visitors won’t see “{b.label}”{where ? ` in ${where}` : ''}.</strong> It has no link yet.
              </Problem>
            );
          })}
        {fixedUnlinked.map((b, i) => (
          <Problem key={`design-${i}`} onGo={def.kind === 'managed' ? editEverywhere : undefined} go="Edit everywhere…">
            <strong>Visitors won’t see “{b.label}”.</strong> Its link is set in the {noun}’s design: edit it everywhere and select the button to give it one.
          </Problem>
        ))}
      </Problems>
      <EntryFieldsSection state={state} owner={owner} node={node} />
      <Section title="Content" id="content" level={LEVEL} remember={fields.length > 0}>
        {fields.length === 0 && <p className="faint insp-note">This {noun} has no content of its own. Add elements inside it from Insert.</p>}
        <FieldHome root={`${owner.kind}:${owner.id}:${node.id}`} alive={nodeAlive(owner, node.id)}>
          <FieldGroups
            groups={fields}
            render={({ key, schema, label }) => {
              // An object's button is flagged at the object, whichever of its fields holds the missing link.
              const found = schema.type === 'object' ? unlinked.find((b) => b.link?.prop === key && b.link.itemId === undefined) : unlinkedField(unlinked, key);
              const own = hideAt(found);
              // A property showing each entry's own value is chosen in Entry content, not typed here.
              if (owner.kind === 'template' && isBinding(node.props[key])) return <EntryBoundNote key={key} state={state} owner={owner} value={node.props[key]} label={label ?? schema.label} />;
              return (
                <PropField
                  key={key}
                  name={key}
                  schema={isHeadingLevel(schema) ? { ...schema, description: HEADING_LEVEL_HINT } : schema}
                  label={label}
                  hint={service && key === service.prop ? formServiceHint(service, !!String(node.props[key] ?? '').trim()) : (videoHint(videoNote(key)) ?? siteNameHint(state, node, key, () => void applyOps([{ type: 'instance.setProp', owner, nodeId: node.id, prop: key, value: state.site.name }], `Use the site name in ${subjectWords(state, here)}`)))}
                  value={node.props[key] ?? schema.default}
                  onChange={(v, edit) => set(key, v, edit)}
                  onField={(field, v, edit) => applyWith(edit, [{ type: 'instance.setProp', owner, nodeId: node.id, prop: key, field, value: v }], fieldLabel(state, schema.label, here), `${node.id}:${key}:${field}`)}
                  onList={(op) => applyListOp(owner, node.id, key, op, fieldLabel(state, schema.label, here), op.kind === 'field' ? `${node.id}:${key}:${op.itemId}:${op.field}` : undefined)}
                  read={() => readProp(owner, node.id, key)}
                  alive={propAlive(owner, node.id, key)}
                  itemAlive={(itemId, field) => rowAlive(owner, node.id, key, itemId, field)}
                  onTable={(edit) => applyTableEdit(owner, node.id, key, edit, fieldLabel(state, schema.label, here))}
                  state={state}
                  openItem={reveal?.prop === key && reveal.itemId ? { seq: reveal.seq, itemId: reveal.itemId } : undefined}
                  annotate={notes(key)}
                  hiddenFields={key === 'fields' && offersFormChoices(def) ? formFieldSettingsHidden : undefined}
                  linkPairs={schema.type === 'list' ? itemLinkPairs(def, key) : undefined}
                  error={found ? unlinkedNote({ hide: own?.hide }) : videoNote(key)?.error}
                  action={hideAction(own)}
                  place={schema.type === 'list' ? { ref: selection, list: key } : undefined}
                  pickImages={pickImagesField(def, key, schema)}
                  fill={key === 'links' && footerMenuId === node.id ? footerCopyFill(state) : undefined}
                  order={key === 'links' && headerMenuId === node.id ? { control: <HeaderMenuOrderSelect state={state} />, locked: followsPageOrder(state) ? FOLLOWING_MOVE_NOTE : null } : undefined}
                />
              );
            }}
          />
        </FieldHome>
      </Section>
      <PlacedSlotsSection state={state} owner={owner} node={node} selection={selection} onSelect={selectAndFocus} level={LEVEL} />
      <ColumnLayout owner={owner} def={def} node={node} variants={node.variants} tokens={tokens} onSet={onStyle} />
      {axes.length > 0 && (
        <Section title="Design" id="design" level={LEVEL}>
          {axes.map(([axisId, axis]) => (
            <Field key={axisId} label={axis.label}>
              {isBinding(selectedAxes[axisId]) ? (
                // Chosen by a property of the component this one sits in.
                <select className="select" value="" disabled>
                  <option value="">Set by a property</option>
                </select>
              ) : (
                <select className="select" value={String(selectedAxes[axisId])} onChange={(e) => void applyOps([{ type: 'instance.setVariant', owner, nodeId: node.id, axis: axisId, variant: e.target.value }], `Change ${axis.label.toLowerCase()} of ${subjectWords(state, here)}`)}>
                  {Object.entries(axis.options).map(([id, v]) => (
                    <option key={id} value={id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ))}
        </Section>
      )}
      {def.kind === 'managed' && (
        <Section title="Style" id="style" defaultOpen={false} level={LEVEL} scope={overrides ? `${whole} · ${changes(overrides)}` : whole}>
          {rootCode && <CodeImportantNote name={rootCode.name} props={codeImportantProps(rootCode)} />}
          {partIds.length > 0 && (
            <div className="insp-parts" role="group" aria-label="Style one part instead">
              <span className="faint">Style one part:</span>
              {partIds.map((p) => (
                <button key={p} className="insp-mini" onClick={() => selectPart(p)}>
                  {def.parts[p].label}
                </button>
              ))}
            </div>
          )}
          <StyleControls
            styles={node.overrides?.root}
            inherited={shownDesign(def, rootPart?.nodeId ?? def.tree!.rootIds[0], designStyles(def, rootPart?.nodeId ?? def.tree!.rootIds[0], node.variants))}
            layers={shownLayers(def, rootPart?.nodeId ?? def.tree!.rootIds[0], designLayers(def, rootPart?.nodeId ?? def.tree!.rootIds[0], node.variants))}
            wideColumns
            allowed={placementStyleControls(def, 'root', codeStyled) ?? undefined}
            grouped={partInInteractionGroup(def, 'root', inGroupAt(state, owner, node.id))}
            tokens={tokens}
            image={rootImage}
            onSet={onStyle('root')}
            onReset={(sc, states) => void applyOps(styleResets({ type: 'node.resetStyles', owner, nodeId: node.id, partId: 'root' }, sc, states), forLabel(state, resetWords('Reset overrides', states), refTo(owner, node.id)))}
            target={`the ${def.name.toLowerCase()} itself`}
          />
        </Section>
      )}
      {codeStyled && (
        <Section title="Style" id="style" defaultOpen={false} level={LEVEL} scope={[styledPart === 'root' ? whole : (def.parts[styledPart]?.label ?? whole), overrides ? changes(overrides) : ''].filter(Boolean).join(' · ')}>
          {Object.keys(def.parts).length > 1 && (
            <Field label="Part">
              <select
                className="select"
                value={styledPart}
                onChange={(e) => setCodePart(e.target.value)}
              >
                {Object.entries(def.parts).map(([id, p]) => (
                  <option key={id} value={id}>
                    {id === 'root' ? `Whole ${def.name.toLowerCase()}` : p.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <CodeImportantNote name={def.name} props={codeImportant} />
          <StyleControls
            key={styledPart}
            styles={node.overrides?.[styledPart]}
            inherited={undefined}
            wideColumns
            allowed={placementStyleControls(def, styledPart, codeStyled) ?? undefined}
            grouped={partInInteractionGroup(def, styledPart, inGroupAt(state, owner, node.id))}
            tokens={tokens}
            onSet={onStyle(styledPart)}
            onReset={(sc, states) => void applyOps(styleResets({ type: 'node.resetStyles', owner, nodeId: node.id, partId: styledPart }, sc, states), forLabel(state, resetWords('Reset overrides', states), here, styledPart === 'root' ? undefined : def.parts[styledPart]?.label))}
            statePart={styledPart === 'root' ? undefined : styledPart}
            target={styledPart === 'root' ? `the ${def.name.toLowerCase()} itself` : `the ${def.parts[styledPart].label.toLowerCase()}`}
          />
        </Section>
      )}
      <Section title="Component" id="component" defaultOpen={false} level={LEVEL} scope={shell ? undefined : `Used ${uses === 1 ? 'once' : `${uses} times`}`}>
        <p className="insp-note muted">
          {def.description ? `${def.description} ` : ''}
          <span className="faint">{def.owner === 'project' ? (def.kind === 'code' ? 'A code component in this project.' : 'Made in this project.') : 'From the site’s theme.'}</span>
        </p>
        <div className="action-grid">
          {def.kind === 'managed' && (
            <button className="btn btn-sm" onClick={editEverywhere}>
              <Pencil /> Edit everywhere…
            </button>
          )}
          {canMakeUnique && (
            <button className="btn btn-sm" onClick={makeUnique} title="Make a separate copy of this component for this placement, so its design can change on its own">
              <Split /> Make unique…
            </button>
          )}
          {dev && def.kind === 'managed' && (
            <button className="btn btn-sm" onClick={() => void convertToCode()} title="Create an editable Svelte copy">
              <Code /> Convert to code
            </button>
          )}
          {dev && (
            <button className="btn btn-sm" onClick={viewSource}>
              <FileCode2 /> {def.kind === 'code' && def.owner === 'project' ? 'Edit code' : 'View source'}
            </button>
          )}
        </div>
      </Section>
      <Section title="Advanced" id="advanced" defaultOpen={false} level={LEVEL} scope={[node.anchor && `#${node.anchor}`, entrance && appearSummary(node, designAppear(state, def))].filter(Boolean).join(' · ') || undefined}>
        <Field label="Layer name" hint="Shown in Layers. Not visible on the site.">
          <DraftInput value={node.name ?? ''} placeholder={def.name} onCommit={(v) => void applyOps([{ type: 'node.rename', owner, nodeId: node.id, name: v }], editLabel(state, 'Rename', here, v.trim() ? `to ${v.trim()}` : undefined))} />
        </Field>
        {def.kind === 'managed' && (
          <Field label="Anchor ID" hint={`Lets links jump straight to this ${shell && noun === 'section' ? 'part of every page that shows it' : noun}, as #${node.anchor || 'pricing'}. Choose it in a link’s Section.`}>
            <DraftInput value={node.anchor ?? ''} placeholder="e.g. pricing" onCommit={(v) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'anchor', value: v.trim() }], forLabel(state, v.trim() ? 'Set anchor' : 'Clear anchor', here))} />
          </Field>
        )}
        {entrance && <EntranceField owner={owner} node={node} design={designAppear(state, def)} />}
        {isWebMcpForm(def) && <FormToolFields state={state} owner={owner} node={node} def={def} />}
        {dev && (
          <p className="mono faint insp-note" style={{ userSelect: 'text' }}>
            {node.id} · {def.id}
          </p>
        )}
      </Section>
    </>
  );
}

/** Says which properties a code component's own code marks important, which styles set here cannot beat. */
/**
 * Marks a container as an interaction group (a card): hovering it, or focus inside it, shows the group states of the
 * elements inside it.
 */
function GroupSwitch({ owner, node }: { owner: OwnerRef; node: ElementNode }) {
  return (
    <SwitchRow
      checked={node.interactionGroup === true}
      label="Interaction group"
      hint="Hovering it, or focus anywhere inside it, shows the Group hover and Group focus styles of the elements inside it. A group inside it is a group of its own: what that one holds follows it instead."
      onChange={(v) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'interactionGroup', value: v }], v ? 'Make interaction group' : 'Turn off interaction group')}
    />
  );
}

function CodeImportantNote({ name, props }: { name: string; props: string[] }) {
  if (!props.length) return null;
  return (
    <p className="insp-note muted">
      {name}’s own code marks {props.map((p) => `“${p}”`).join(', ')} as !important, so a style set here for {props.length === 1 ? 'it' : 'those'} may not show. Remove !important from the component’s source to let these styles win.
    </p>
  );
}

/** The code component a placement renders: its own, or the one at the root of the designs it places. */
function renderedCode(state: ProjectState, node: GraphNode): ComponentDefinition | undefined {
  for (let n: GraphNode | undefined = node, seen = new Set<string>(); n?.kind === 'instance' && !seen.has(n.definitionId); ) {
    seen.add(n.definitionId);
    const def: ComponentDefinition | undefined = state.components[n.definitionId];
    if (def?.kind === 'code') return def;
    n = def?.tree?.nodes[def.tree.rootIds[0]];
  }
  return undefined;
}

/**
 * A part of a placed component. `everywhere` is the component being edited everywhere when the part belongs to a
 * component placed in its design: changes then go to that design, for every placement of it.
 */
/**
 * What the placement a selection belongs to is called (#661): a component when it sits inside another component, a
 * layout or a slot, or is made to go inside layouts; otherwise one of the page's sections.
 */
function placementNoun(state: ProjectState, sel: ElementRef): 'section' | 'component' {
  return sel.instancePath.length > 1 || placementRole(state, sel.owner, sel.instancePath[0] ?? sel.nodeId) === 'element' ? 'component' : 'section';
}

function PartInspector({ state, selection, tokens, everywhere }: { state: ProjectState; selection: ElementRef; tokens: Tokens; everywhere?: ComponentDefinition }) {
  const templateMode = useStore((s) => s.templateMode);
  const scope = useStore((s) => s.styleScope);
  const styleItems = useStyleCopyItems(selection);
  const devUrl = useDevUrl();
  const r = resolveRef(state, selection);
  const def = r.def!;
  const inst = r.instance!;
  const node = r.node!;
  const nested = selection.instancePath.length > 1;
  const owner = selection.owner;
  const partId = selection.partId;
  const part = partId ? def.parts[partId] : undefined;
  const parent = parentOf(selection);
  const noun = placementNoun(state, selection);
  const itemId = selection.itemPath?.[selection.itemPath.length - 1];
  const title = part?.label ?? refLabel(state, selection);

  // Content bound to this part
  const bindings: Array<{ prop?: string; item?: string; kind: string }> = [];
  const pushB = (v: unknown, kind: string) => {
    if (!isBinding(v) || '$entry' in v) return;
    const b = '$prop' in v ? { prop: v.$prop, kind } : { item: v.$item, kind };
    const seen = bindings.find((x) => x.prop === b.prop && x.item === b.item);
    if (!seen) bindings.push(b);
    // One object can hold a button's label and its link: it is flagged where the link is.
    else if (kind === 'link') seen.kind = 'link';
  };
  if (node.kind === 'text') pushB(node.text, 'text');
  // A heading's level, when its placement chooses it, sits beside its words: it changes the outline, never the look.
  // A level shared by every item is left to the section when the words are each item's own, so neither says "this one only" wrongly.
  if (node.kind === 'text' && !(isBinding(node.text) && '$item' in node.text && isBinding(node.tag) && '$prop' in node.tag)) pushB(node.tag, 'tag');
  if (node.kind === 'image') pushB(node.image, 'image');
  if (node.kind === 'link') (pushB(node.label, 'label'), pushB(node.link, 'link'), pushB(node.icon, 'icon'));
  if (node.kind === 'element') pushB(node.link, 'link');
  if (node.kind === 'icon') pushB(node.icon, 'icon');
  // A component placed in the design (in one of its lists, say) shows what its values are bound to: the selected
  // item's own fields, or the section's properties.
  if (node.kind === 'instance') for (const v of Object.values(node.props)) pushB(v, 'value');
  const contentList = Object.entries(def.properties).find(([, p]) => p.type === 'list' && bindings.some((b) => b.item && b.item in (p as { fields: object }).fields))?.[0];
  // A structural part (a card itself) has no content binding, but it still repeats once per list item:
  // find the list from the repeat that encloses it, so its Style scope says "All 3 cards" too.
  const repeatList = enclosingRepeatProp(def, node.id);
  // The repeat that encloses the part names its list exactly; a field-name match is only a fallback.
  const listProp = (repeatList && def.properties[repeatList]?.type === 'list' ? repeatList : undefined) ?? contentList;
  const listSchema = listProp ? (def.properties[listProp] as Extract<ComponentDefinition['properties'][string], { type: 'list' }>) : undefined;
  // A computed list's items are the pages it shows where it is placed (each row's ID is its page's).
  // In a collection's layout, the rows of the entry the canvas shows it on.
  const sample = templateMode && parent.owner.kind === 'template' && !parent.instancePath.length ? { entryId: templateMode.entryId, nodeId: parent.nodeId } : undefined;
  const feedRows = listSchema?.feed ? placedFeedRows(state, listSchema, parent?.owner, def.properties, inst.props as Record<string, unknown>, sample) : undefined;
  // A list the outer design fills in from one of its own properties is not this placement's to list here.
  const ownList = listProp ? (inst.props[listProp] ?? listSchema?.default) : undefined;
  const listItems = feedRows ?? (Array.isArray(ownList) ? (ownList as Array<Record<string, unknown>>) : []);
  const itemLabel = listSchema?.itemLabel.toLowerCase() ?? 'item';
  const listLabel = listSchema?.label.toLowerCase() ?? 'items';
  const itemIndex = itemId ? listItems.findIndex((x) => x.id === itemId) : -1;
  const partName = (part?.label ?? 'part').toLowerCase();
  const n = listItems.length;
  const instOwner = owner;
  const instNodeId = selection.instancePath[0];
  // Edits join the same field's last edit. In a component's design the same node IDs can recur in another design
  // copied from it, so the key names the design too, as its row in Layers does.
  const keyAt = everywhere ? `${everywhere.id}:${instNodeId}` : instNodeId;
  // A part shown once per item of the list (a card) can also be styled for the selected item alone.
  const itemList = !nested && partId && owner.kind !== 'component' ? repeatedPartList(def, partId) : undefined;
  const canStyleItem = !!itemList && itemList === listProp && !!itemId && itemIndex >= 0;
  // The selected item has left the list (removed, or an undo took it back): neither its own style nor the shared
  // one is what the author picked, so nothing is offered until they select again.
  const itemGone = !!itemList && itemList === listProp && !!itemId && itemIndex < 0;
  const ownItemStyles = canStyleItem ? itemStylesOf(def, inst, partId!, itemId!) : undefined;
  // Another part of the same card keeps the choice made there: "This card" stays this card.
  const reachKey = canStyleItem ? itemReachKey(owner, selection.instancePath[0], itemId!) : '';
  const [reach, setReachState] = useState<'all' | 'item'>(() => (reachKey && reachByItem.get(reachKey)) || (ownItemStyles ? 'item' : 'all'));
  const setReach = (r: 'all' | 'item') => {
    if (reachKey) reachByItem.set(reachKey, r);
    setReachState(r);
  };
  // The canvas's spacing handles write where this says.
  useEffect(() => (reachKey ? showReach(reachKey, reach) : undefined), [reachKey, reach]);
  const oneItem = canStyleItem && reach === 'item';
  const itemName = (it: Record<string, unknown> | undefined, i: number) => {
    const t = listSchema?.titleField ? it?.[listSchema.titleField] : undefined;
    return typeof t === 'string' && t.trim() ? `“${t.trim()}”` : `${listSchema?.itemLabel ?? 'Item'} ${i + 1}`;
  };
  const thisItem = itemIndex >= 0 ? itemName(listItems[itemIndex], itemIndex) : '';
  // Items of this placement that keep styles of their own, listed under the shared style so they can be found again.
  const styledItems = itemList && itemList === listProp && partId ? Object.keys(liveItemStyles(def, inst, partId)?.items ?? {}).map((id) => ({ id, index: listItems.findIndex((x) => x.id === id) })).filter((x) => x.index >= 0) : [];
  // Style reach, worded the same in the header and on the Style heading.
  const styleReach = oneItem ? `this ${partName} only` : n === 1 ? `the 1 ${partName}` : `all ${n} ${partName}s`;
  const kind = elementKind(node);
  const parentName = inst.name ?? def.name;
  // Which item of the list this part is in, or that it is in every one: said once, beside the section it belongs to.
  const itemPos = !listSchema || nested ? '' : itemIndex >= 0 ? `${itemLabel} ${itemIndex + 1} of ${n}` : itemId ? '' : n === 1 ? `the one ${itemLabel}` : `every ${itemLabel}`;
  const parentLink = (
    <>
      Part of{' '}
      <button className="link-btn" onClick={() => selectAndFocus(parent)} title={`Select the whole ${noun} (Esc)`}>
        {parentName}
      </button>
      {itemPos ? (
        <>
          {' '}
          <span className="insp-kind-pos">· {itemPos}</span>
        </>
      ) : null}
    </>
  );
  // The section's other parts, one click away; this one checked. A part repeated over the same list as this one stays
  // on the same item, so moving from one card's title to its icon never widens the edit to every card.
  const siblings = !nested && !everywhere && def.kind === 'managed' ? Object.keys(def.parts).filter((p) => p !== 'root') : [];
  const selectSibling = (p: string) => {
    if (p === partId) return focusName();
    const sameItem = !!selection.itemPath?.length && !!repeatList && enclosingRepeatProp(def, def.parts[p].nodeId) === repeatList;
    selectAndFocus({ owner, instancePath: selection.instancePath, nodeId: def.parts[p].nodeId, partId: p, ...(sameItem ? { itemPath: selection.itemPath } : {}) });
  };
  const reachId = useId();
  const hasContent = !nested && bindings.length > 0;
  // A repeated link whose visible text and destination are two fields of the selected item (a contact method).
  const textField = node.kind === 'link' && isBinding(node.label) && '$item' in node.label ? node.label.$item : undefined;
  const linkField = node.kind === 'link' && isBinding(node.link) && '$item' in node.link ? node.link.$item : undefined;
  const linkPair = !nested && listProp && textField && linkField ? itemLinkPairs(def, listProp).find((p) => p.text === textField && p.link === linkField) : undefined;
  const pairedItem = linkPair && itemId ? listItems.find((x) => x.id === itemId) : undefined;
  // A clicked button with no link (the one rendered for this item): flag its link field and offer to hide it, then
  // select the section, since the button is gone.
  const at = (selection.itemPath ?? []).join(',');
  const unlinked = node.kind === 'link' && !nested ? unlinkedAt(state, instOwner, instNodeId).find((b) => b.defNodeId === node.id && (b.itemPath ?? []).join(',') === at) : undefined;
  const hideAction = unlinked?.hide
    ? {
        label: 'Hide button',
        run: async () => {
          if (await applyOps([hideButtonOp(instOwner, instNodeId, unlinked.hide!)], `Hide ${unlinked.label ? `“${unlinked.label}” ` : ''}button in ${subjectWords(state, refTo(instOwner, instNodeId))}`)) selectAndFocus(parent);
        }
      }
    : undefined;
  const flagged = (kind: string) => (kind === 'link' && unlinked?.link ? { error: unlinkedNote(unlinked), action: hideAction } : {});
  // The field that sets the flagged button's link, for the problem row's way to it.
  const linkBinding = bindings.find((b) => b.kind === 'link');
  const linkSlot = linkBinding?.prop ?? linkBinding?.item;
  // Content reach comes from the binding: an item field is per item, a section property is shared by every item.
  const perItem = bindings.some((b) => b.item);
  // A placed component can read both an item's fields and the section's properties: no one reach covers them all.
  const mixedReach = !!listSchema && !nested && perItem && bindings.some((b) => b.prop);
  // The item this part belongs to stays revealed on the page while it is selected: picking an answer inside a question
  // the inspector opened must not close that question under the pointer.
  const reveal = useRevealedItem(!nested && listProp && !feedRows && itemIndex >= 0 ? { ref: parent, list: listProp } : undefined, itemIndex >= 0 ? (listItems[itemIndex] as ListItem) : undefined, true);
  // A cropped image part chooses its focal point on its own picture (the selected item's, for a repeated one),
  // over the rules the exported site puts under this placement's: the selected variants, then the design.
  const partImage =
    part && node.kind === 'image'
      ? focusImage(state, devUrl, shownImage(state, selection, node.image), [selectedVariantStyles(def, inst.variants, part.nodeId), [def.tree?.nodes[part.nodeId]?.styles]], listSchema && !itemId ? `Select one ${itemLabel} on the page to see its picture here.` : 'This picture can’t be shown here.')
      : undefined;
  // One item's picture: the style every item shares is the strongest rule under the item's own.
  const itemImage =
    part && node.kind === 'image' && oneItem
      ? focusImage(state, devUrl, shownImage(state, selection, node.image), [[inst.overrides?.[partId!]], selectedVariantStyles(def, inst.variants, part.nodeId), [def.tree?.nodes[part.nodeId]?.styles]], 'This picture can’t be shown here.')
      : undefined;
  // Rows the shared style uses show for one item too, so the item can change what every item was given.
  // Resting values only: a hover, focus or pressed value has no control of its own here.
  const sharedRows = (controls: string[] | undefined) =>
    controls && [...new Set([...controls, ...Object.entries(inst.overrides?.[partId!] ?? {}).flatMap(([k, sc]) => (parseStyleScopeKey(k)?.state === undefined ? Object.keys(sc ?? {}) : []))])];

  return (
    <>
      <Header
        title={title}
        kind={parentLink}
        tone={everywhere ? 'definition' : owner.kind === 'shell' || owner.kind === 'template' ? 'shared' : 'local'}
        icon={kind.icon}
        actions={everywhere ? <DoneButton /> : <SelectionActions title={title} selection={selection} items={[{ label: `Select ${parentName}`, icon: <Component />, shortcut: 'Esc', onSelect: () => selectAndFocus(parent) }, ...(styleItems.length ? [{ separator: true }, ...styleItems] : [])]} />}
      >
        {everywhere ? (
          <EverywhereScope state={state} def={everywhere} />
        ) : (
          <OwnerScope
            owner={owner}
            state={state}
            aside={
              siblings.length > 1 && (
                <span className="insp-mini-row">
                  <PartsButton title={parentName} parts={siblings.map((p) => ({ label: def.parts[p].label, current: p === partId, select: () => selectSibling(p) }))} />
                </span>
              )
            }
          />
        )}
      </Header>
      <Problems>
        {unlinked?.link && linkSlot && (
          <Problem onGo={() => revealContentField('part-content', linkSlot)} go="Choose a link">
            <strong>Visitors won’t see this button.</strong> It has no link yet.
          </Problem>
        )}
        {unlinked && !unlinked.link && !everywhere && (
          <Problem onGo={def.kind === 'managed' ? () => setState({ modal: { kind: 'edit-definition', ref: parent } }) : undefined} go="Edit everywhere…">
            <strong>Visitors won’t see this button.</strong> Its link is set in the {noun}’s design: edit it everywhere and select the button to give it one.
          </Problem>
        )}
      </Problems>
      {nested ? (
        <Section title="Content" id="part-content" level={LEVEL}>
          <p className="muted insp-note">This belongs to a component inside {def.name}. Change it with Edit everywhere on that component, or make {def.name} unique.</p>
        </Section>
      ) : bindings.length ? (
        // When some of this part's words are the card's own and some every card shares, each field says which instead.
        <Section title="Content" id="part-content" level={LEVEL} scope={mixedReach ? undefined : listSchema ? (perItem ? (itemId ? `This ${itemLabel} only` : `Each ${itemLabel}`) : `Every ${itemLabel}`) : everywhere ? 'Same in every placement' : undefined}>
          {/* The placement this part belongs to: the same place its whole-section fields have. */}
          <FieldHome root={`${instOwner.kind}:${instOwner.id}:${instNodeId}`} alive={nodeAlive(instOwner, instNodeId)}>
            {bindings.map((b, i) => {
              if (b.prop) {
                const schema = def.properties[b.prop];
                if (!schema) return null;
                // Filled in from a property of the design this component sits in: that property's default.
                const forwarded = everywhere ? forwardedBinding(inst.props[b.prop]) : null;
                if (forwarded) return <ForwardedDefault key={i} state={state} def={everywhere!} binding={forwarded} />;
                // Filled in from each item of a list the design repeats it over.
                if (isBinding(inst.props[b.prop]))
                  return (
                    <p key={i} className="muted insp-note">
                      {schema.label}: each item of the list it repeats over has its own.
                    </p>
                  );
                return (
                  <div key={i} data-field={b.prop}>
                  <PropField
                    name={b.prop}
                    schema={schema}
                    value={inst.props[b.prop] ?? schema.default}
                    state={state}
                    hint={mixedReach ? `Same in every ${itemLabel}.` : everywhere ? undefined : siteNameHint(state, inst, b.prop, () => void applyOps([{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: b.prop!, value: state.site.name }], `Use the site name in ${subjectWords(state, refTo(instOwner, instNodeId))}`))}
                    everywhere={!!everywhere}
                    onChange={(v, edit) => void applyWith(edit, [{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: b.prop!, value: v }], fieldLabel(state, schema.label, refTo(instOwner, instNodeId)), `${keyAt}:${b.prop}`)}
                    onField={(field, v, edit) => void applyWith(edit, [{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: b.prop!, field, value: v }], fieldLabel(state, schema.label, refTo(instOwner, instNodeId)), `${keyAt}:${b.prop}:${field}`)}
                    onList={(op) => applyListOp(instOwner, instNodeId, b.prop!, op, fieldLabel(state, schema.label, refTo(instOwner, instNodeId)), undefined, !!everywhere)}
                    read={() => readProp(instOwner, instNodeId, b.prop!)}
                    alive={propAlive(instOwner, instNodeId, b.prop!)}
                    itemAlive={(itemId, field) => rowAlive(instOwner, instNodeId, b.prop!, itemId, field)}
                    onTable={(edit) => applyTableEdit(instOwner, instNodeId, b.prop!, edit, fieldLabel(state, schema.label, refTo(instOwner, instNodeId)))}
                    linkPairs={schema.type === 'list' ? itemLinkPairs(def, b.prop!) : undefined}
                    {...flagged(b.kind)}
                    place={schema.type === 'list' ? { ref: parent, list: b.prop! } : undefined}
                    pickImages={pickImagesField(def, b.prop, schema)}
                  />
                  </div>
                );
              }
              // A computed row's fields come from its page: said once, below.
              if (feedRows) return null;
              if (listProp && listSchema && itemId) {
                const field = listSchema.fields[b.item!];
                const item = listItems.find((x) => x.id === itemId);
                if (!field || !item) return null;
                const edit = (v: unknown, pending?: PendingEdit) => void applyWith(pending, [{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: listProp, itemId, field: b.item!, value: v }], listEditLabel(getState().snapshot?.state ?? state, instOwner, instNodeId, listProp, { kind: 'field', itemId, field: b.item! }, `Edit ${field.label}`, !!everywhere), `${keyAt}:${listProp}:${itemId}:${b.item}`);
                // A page list's card says where an empty field's text comes from.
                const teaser = teaserFieldNote(state, listSchema, item, b.item!);
                // An item without its own value for the field shows the field's default, on the site and here.
                const value = Object.hasOwn(item, b.item!) ? item[b.item!] : field.default;
                return (
                  <div key={`${itemId}:${b.item}`} data-field={b.item} {...reveal.handlers}>
                    {/* The same place as this row's field in the section's own list, so text kept there is found here too. */}
                    <FieldHome part={`prop:${listProp}|item:${itemId}:${b.item}`} alive={rowAlive(instOwner, instNodeId, listProp, itemId, b.item!)}>
                      <ScalarField schema={field} value={value} state={state} onChange={edit} hint={teaser?.hint ?? (mixedReach ? `This ${itemLabel} only.` : undefined)} placeholder={teaser?.placeholder} onLive={field.type === 'string' ? reveal.typed(b.item!) : undefined} {...flagged(b.kind)} />
                    </FieldHome>
                  </div>
                );
              }
              return null;
            })}
          </FieldHome>
          {linkPair && pairedItem && itemId && (
            <ContactMismatch text={pairedItem[linkPair.text]} link={pairedItem[linkPair.link]} onRepair={(link, label, revision) => applyListOp(instOwner, instNodeId, listProp!, { kind: 'repair', itemId, field: linkPair.link, value: link, label, revision }, label)} />
          )}
          {feedRows && perItem && <ComputedItemNote state={state} pageId={itemId && feedRows.some((r) => r.id === itemId) ? itemId : undefined} listLabel={listLabel} />}
          {listSchema && !feedRows && perItem && !itemId && <p className="muted insp-note">Each {itemLabel} has its own text. {everywhere ? (Array.isArray(ownList) ? 'Open the list to edit them.' : `Each placement of ${everywhere.name} fills them in.`) : 'Click one on the page to change it, or open the list to edit them all.'}</p>}
          {listSchema && !feedRows && Array.isArray(ownList) && (
            <button className="btn btn-sm insp-inline-btn" onClick={() => openList(parent, listProp!, itemId ?? (listItems[0]?.id as string | undefined), !!itemId)}>
              <List /> {itemId ? `Show in ${listLabel} list` : `Open ${listLabel} list`}
            </button>
          )}
        </Section>
      ) : node.kind === 'element' ? null : (
        // A structural part (a container) has nothing to write in, so it opens on Style. Fixed words or pictures say where they are set.
        <Section title="Content" id="part-content" level={LEVEL}>
          <p className="muted insp-note">
            {everywhere
              ? `This is fixed in the ${def.name} design. To change it, click Done editing, then edit ${def.name} everywhere.`
              : `This is fixed in the ${noun}’s design. To change it, select ${parentName} and choose Edit everywhere, or Make unique for just this placement.`}
          </p>
        </Section>
      )}
      {part && !nested && def.kind === 'managed' && (
        <Section
          title="Style"
          id="part-style"
          level={LEVEL}
          // Said here even with the choice below, so a closed Style still says which cards it changes.
          scope={[listSchema ? styleReach.charAt(0).toUpperCase() + styleReach.slice(1) : '', countStyles(oneItem ? ownItemStyles : inst.overrides?.[partId!]) ? changes(countStyles(oneItem ? ownItemStyles : inst.overrides?.[partId!])) : ''].filter(Boolean).join(' · ') || undefined}
        >
          {canStyleItem && (
            <div className="field">
              {/* Named "Apply to: style which plan cards", so the choice says what it is for when heard on its own. */}
              <div className="field-label" id={reachId}>
                Apply to<span className="sr-only">: style which {partName}s</span>
              </div>
              <Segmented
                full
                labelledBy={reachId}
                value={reach}
                onChange={setReach}
                options={[
                  // Named by their visible text: a title would replace it as the accessible name.
                  { value: 'all', label: n === 1 ? `The ${partName}` : `All ${n} ${partName}s` },
                  { value: 'item', label: `This ${partName}` }
                ]}
                describedBy={oneItem ? `${reachId}-note` : undefined}
              />
              {oneItem && (
                <div className="field-hint" id={`${reachId}-note`}>
                  Only {thisItem} changes. Anything it doesn’t set follows the style all {listLabel} share.
                </div>
              )}
            </div>
          )}
          {(() => {
            // A part that is a code component placed in the design: styles beat its selectors, not its important values.
            const code = renderedCode(state, node);
            return code && codeTakesOverrides(code) ? <CodeImportantNote name={code.name} props={codeImportantProps(code)} /> : null;
          })()}
          {itemGone ? (
            <p className="muted insp-note">
              This {itemLabel} is no longer in the list. Select another {itemLabel}, or{' '}
              <button className="link-btn" onClick={() => selectAndFocus(parent)}>
                select {parentName}
              </button>
              .
            </p>
          ) : oneItem ? (
            <>
              <StyleControls
                key={`item:${itemId}`}
                styles={ownItemStyles}
                inherited={sharedPartStyles(def, part.nodeId, inst, partId!)}
                wideColumns
                // Rows the shared style uses show here too, so the item can change what every item was given.
                allowed={sharedRows(partStyleControls(def, partId!))}
                grouped={partInInteractionGroup(def, partId!, inGroupAt(state, owner, inst.id))}
                tokens={tokens}
                image={itemImage}
                resetLabel="Reset to shared style"
                target={thisItem}
                layers={[...designLayers(def, part.nodeId, inst.variants), { styles: inst.overrides?.[partId!], strength: 3 }]}
                onSet={(property, value, expectedRevision, inState) =>
                  commitOps(
                    [{ type: 'node.setStyle', owner: instOwner, nodeId: instNodeId, partId, itemId, ...styleAt(scope, inState), property, value }],
                    styleLabel(state, property, refTo(instOwner, instNodeId), thisItem, value, inState),
                    styleKey(property, JSON.stringify([keyAt, partId, itemId, styleScopeKey(scope, inState), property])),
                    expectedRevision
                  )
                }
                onReset={(sc, states) =>
                  void applyOps(
                    styleResets({ type: 'node.resetStyles', owner: instOwner, nodeId: instNodeId, partId, itemId }, sc, states),
                    states?.length ? forLabel(state, resetWords('', states), refTo(instOwner, instNodeId), thisItem) : `Reset ${thisItem} to shared style in ${subjectWords(state, refTo(instOwner, instNodeId))}`
                  )
                }
              />
            </>
          ) : (
            <>
              {styledItems.length > 0 && (
                <p className="muted insp-note">
                  {styledItems.length === 1 ? 'Styled on its own: ' : 'Styled on their own: '}
                  {styledItems.map((x, i) => (
                    <span key={x.id}>
                      {i > 0 ? ', ' : ''}
                      <button
                        className="link-btn"
                        // The selected card's own style is one choice away; any other card is selected.
                        onClick={() => {
                          if (x.id !== itemId || !canStyleItem) return selectAndFocus({ ...selection, itemPath: [x.id] });
                          // This link goes with the switch: focus moves to the choice it made.
                          setReach('item');
                          requestAnimationFrame(() => document.querySelector<HTMLElement>(`#dock-panel-inspect [aria-labelledby="${CSS.escape(reachId)}"] button[aria-pressed="true"]`)?.focus());
                        }}
                        title={`Show ${itemName(listItems[x.index], x.index)}’s own style, to change or reset it`}
                      >
                        {itemName(listItems[x.index], x.index)}
                      </button>
                    </span>
                  ))}
                  . Their own changes win over the shared style.
                </p>
              )}
              <StyleControls
                key="all"
                styles={inst.overrides?.[partId!]}
                inherited={shownDesign(def, part.nodeId, designStyles(def, part.nodeId, inst.variants))}
                layers={shownLayers(def, part.nodeId, designLayers(def, part.nodeId, inst.variants))}
                wideColumns
                allowed={partStyleControls(def, partId!)}
                grouped={partInInteractionGroup(def, partId!, inGroupAt(state, owner, inst.id))}
                tokens={tokens}
                image={partImage}
                onSet={(property, value, expectedRevision, inState) =>
                  commitOps([{ type: 'node.setStyle', owner: instOwner, nodeId: instNodeId, partId, ...styleAt(scope, inState), property, value }], styleLabel(state, property, refTo(instOwner, instNodeId), part.label, value, inState), styleKey(property, `${keyAt}:${partId}:${styleScopeKey(scope, inState)}:${property}`), expectedRevision)
                }
                onReset={(sc, states) => void applyOps(styleResets({ type: 'node.resetStyles', owner: instOwner, nodeId: instNodeId, partId }, sc, states), forLabel(state, resetWords('Reset overrides', states), refTo(instOwner, instNodeId), part.label))}
              />
            </>
          )}
        </Section>
      )}
    </>
  );
}

/**
 * A part of a code placement that its author marked in the code (`data-so-part`): styled for this placement through
 * the part classes the code places, as the placement's own Part choice does.
 */
function CodePartInspector({ state, selection, tokens }: { state: ProjectState; selection: ElementRef & { partId: string }; tokens: Tokens }) {
  const scope = useStore((s) => s.styleScope);
  const styleItems = useStyleCopyItems(selection);
  const r = resolveRef(state, selection);
  const def = r.def!;
  const inst = r.instance!;
  const owner = selection.owner;
  const partId = selection.partId;
  const part = def.parts[partId];
  const parent: ElementRef = { owner, instancePath: [], nodeId: inst.id };
  const parentName = inst.name ?? def.name;
  const noun = placementNoun(state, parent);
  const here = refTo(owner, inst.id);
  // Styles reach the part only through the classes the code places on it (so_o).
  const codeStyled = codeTakesOverrides(def);
  const allowed = placementStyleControls(def, partId, codeStyled);
  const overrides = countStyles(inst.overrides?.[partId]);
  const siblings = Object.keys(def.parts).filter((p) => p !== 'root');
  const selectSibling = (p: string) => (p === partId ? focusName() : selectAndFocus({ owner, instancePath: [inst.id], nodeId: def.parts[p].nodeId, partId: p }));
  return (
    <>
      <Header
        title={part.label}
        kind={
          <>
            Part of{' '}
            <button className="link-btn" onClick={() => selectAndFocus(parent)} title={`Select the whole ${noun} (Esc)`}>
              {parentName}
            </button>
          </>
        }
        tone={owner.kind === 'shell' || owner.kind === 'template' ? 'shared' : 'local'}
        icon={<Code />}
        actions={<SelectionActions title={part.label} selection={selection} items={[{ label: `Select ${parentName}`, icon: <Component />, shortcut: 'Esc', onSelect: () => selectAndFocus(parent) }, ...(styleItems.length ? [{ separator: true }, ...styleItems] : [])]} />}
      >
        <OwnerScope
          owner={owner}
          state={state}
          aside={
            siblings.length > 1 && (
              <span className="insp-mini-row">
                <PartsButton title={parentName} parts={siblings.map((p) => ({ label: def.parts[p].label, current: p === partId, select: () => selectSibling(p) }))} />
              </span>
            )
          }
        />
      </Header>
      <Section title="Style" id="part-style" level={LEVEL} scope={overrides ? changes(overrides) : undefined}>
        {allowed === null ? (
          <p className="muted insp-note">
            {def.name}’s code doesn’t place the classes it is given, so styles set here can’t reach {part.label.toLowerCase()}. Add <code>{`class={so_o?.${/^[A-Za-z_$][\w$]*$/.test(partId) ? partId : `[${JSON.stringify(partId)}]`}}`}</code> to the element in its code.
          </p>
        ) : (
          <>
            <CodeImportantNote name={def.name} props={codeImportantProps(def)} />
            <StyleControls
              styles={inst.overrides?.[partId]}
              inherited={undefined}
              wideColumns
              allowed={allowed}
              grouped={partInInteractionGroup(def, partId, inGroupAt(state, owner, inst.id))}
              tokens={tokens}
              onSet={(property, value, expectedRevision, inState) =>
                commitOps(
                  [{ type: 'node.setStyle', owner, nodeId: inst.id, partId, ...styleAt(scope, inState), property, value }],
                  styleLabel(state, property, here, part.label, value, inState),
                  styleKey(property, `${inst.id}:${partId}:${styleScopeKey(scope, inState)}:${property}`),
                  expectedRevision
                )
              }
              onReset={(sc, states) => void applyOps(styleResets({ type: 'node.resetStyles', owner, nodeId: inst.id, partId }, sc, states), forLabel(state, resetWords('Reset overrides', states), here, part.label))}
              target={`the ${part.label.toLowerCase()}`}
            />
          </>
        )}
      </Section>
    </>
  );
}

function PrimitiveInspector({ state, owner, node, tokens, selection }: { state: ProjectState; owner: OwnerRef; node: GraphNode; tokens: Tokens; selection: ElementRef }) {
  // Layers selected together with this one (the menu's Duplicate and Delete act on them all): followed so the menu
  // is rebuilt when they change, and planned with it, so what the menu says is what it does.
  useStore((s) => {
    const g = s.layerSet ? liveGroup(s) : null;
    return g ? g.ids.join(' ') : null;
  });
  const plan = planLayers();
  const scope = useStore((s) => s.styleScope);
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  const devUrl = useDevUrl();
  const content = (field: Extract<EditOperation, { type: 'node.setContent' }>['field'], value: unknown, edit?: PendingEdit) => void applyWith(edit, [{ type: 'node.setContent', owner, nodeId: node.id, field, value }], contentLabel(state, field, refTo(owner, node.id)), `${node.id}:${field}`);
  const t = structuralTarget(selection);
  const title = refLabel(state, selection);
  const kind = elementKind(node);
  const iconId = useId();
  // A button with no link is left out of the site: say so under its link, and offer to remove it.
  const unlinked = node.kind === 'link' && unlinkedAt(state, owner, node.id).some((b) => !b.defNodeId);
  // A button with an anchor may be where another link goes: removing it would take that target away.
  const removable = !!t && owner.kind !== 'shell' && !node.anchor;
  const styleItems = useStyleCopyItems(selection);
  const clipboard = useCopyPasteItems(clipboardActions(owner, plan));
  const structural = !!t && owner.kind !== 'shell';
  // Not while other layers are selected with this one: the menu's other commands act on them all.
  const create = plan?.several ? null : createComponentTarget({ state, readOnly }, selection);
  const items = groupedItems(
    plan,
    title,
    [...(create ? [{ label: 'Create component…', icon: <Component />, onSelect: () => setState({ modal: { kind: 'create-component', ref: create } }) }, { separator: true }] : []), ...styleItems],
    structural
      ? [
          ...wrapMenu(plan),
          ...clipboard,
          // With layers selected together in Layers, these act on all of them, as their shortcuts do, and say so.
          { label: plan?.several ? `Duplicate ${groupCount(plan.group)}` : 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: asPlanned(plan, duplicateLayers) },
          { label: plan?.several ? `Delete ${groupCount(plan.group)}` : 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: asPlanned(plan, deleteLayers) }
        ]
      : []
  );
  return (
    <>
      <Header title={title} kind={title.toLowerCase().startsWith(kind.name.toLowerCase()) ? 'Basic element' : `${kind.name} · basic element`} tone={owner.kind === 'shell' || owner.kind === 'template' ? 'shared' : owner.kind === 'component' ? 'definition' : 'local'} icon={kind.icon} actions={<SelectionActions title={title} selection={selection} items={items} group={plan?.several ? groupCount(plan.group) : undefined} />}>
        <GroupScope plan={plan} title={title} />
        <OwnerScope owner={owner} state={state} />
      </Header>
      <Problems>
        {unlinked && (
          <Problem onGo={() => revealContentField('prim-content', 'link')} go="Choose a link">
            <strong>Visitors won’t see this button.</strong> It has no link yet.
          </Problem>
        )}
      </Problems>
      <EntryFieldsSection state={state} owner={owner} node={node} />
      <Section title="Content" id="prim-content" level={LEVEL}>
        <EntryBoundNote state={state} owner={owner} value={node.kind === 'text' ? node.text : node.kind === 'image' ? node.image : undefined} label={node.kind === 'image' ? 'Image' : 'Text'} />
        {node.kind === 'text' && !node.rich && !isBinding(node.tag) && <TagField state={state} owner={owner} node={node} onChange={(v) => content('tag', v)} />}
        {node.kind === 'text' && !isBinding(node.text) && (
          <>
            <div data-field="text">
              {node.rich && !isBinding(node.text) ? (
                <Field label="Text" hint="Or double-click the text on the page to edit it there." controlId={`${node.id}-text`}>
                  <RichTextField id={`${node.id}-text`} describedBy={`${node.id}-text-note`} value={richTextToMarkdown(toRichText(node.text), state.pages)} onCommit={(v, edit) => content('text', v, edit)} pages={state.pages} />
                </Field>
              ) : (
                <Field label="Text" hint="Or double-click the text on the page to edit it there.">
                  <DraftInput multiline rows={2} value={Array.isArray(node.text) ? richTextToMarkdown(toRichText(node.text), state.pages) : isBinding(node.text) ? '' : String(node.text)} onCommit={(v) => content('text', v)} />
                </Field>
              )}
            </div>
          </>
        )}
        {node.kind === 'image' && !isBinding(node.image) && (
          <div className="field" role="group" aria-label="Image">
            <FieldHome root={`${owner.kind}:${owner.id}:${node.id}:image`} alive={nodeAlive(owner, node.id)}>
              <ImageEditor value={node.image} onChange={(v) => content('image', v)} state={state} />
            </FieldHome>
          </div>
        )}
        {node.kind === 'link' && (
          <>
            {isBinding(node.label) ? (
              <EntryBoundNote state={state} owner={owner} value={node.label} label="Label" />
            ) : (
              <div data-field="label">
                <Field label="Label">
                  <DraftInput value={String(node.label)} onCommit={(v) => content('label', v)} />
                </Field>
              </div>
            )}
            <EntryBoundNote state={state} owner={owner} value={node.link} label="Link" />
            {!isBinding(node.link) && (
              <div className="field" data-field="link" role="group" aria-labelledby={`${node.id}-dest`}>
                <div className="field-label" id={`${node.id}-dest`}>
                  Link
                </div>
                <LinkEditor value={node.link} onChange={(v, edit) => content('link', v, edit)} state={state} label={kind.name} />
                {/* The problem itself is said once, above the sections; beside the control is the other way out. */}
                {unlinked && removable && (
                  <button className="btn btn-sm insp-inline-btn" onClick={() => void deleteSelection()}>
                    <Trash2 /> Remove button
                  </button>
                )}
              </div>
            )}
            <Field label="Appearance">
              <select className="select" value={String(node.appearance)} onChange={(e) => content('appearance', e.target.value)}>
                <option value="primary">Primary button</option>
                <option value="secondary">Secondary button</option>
                <option value="text">Text with arrow</option>
                <option value="link">Underlined link</option>
              </select>
            </Field>
          </>
        )}
        {node.kind === 'icon' && (
          <Field label="Icon" controlId={iconId}>
            <IconPicker id={iconId} value={isBinding(node.icon) ? 'sparkles' : String(node.icon)} onChange={(v) => content('icon', v)} />
          </Field>
        )}
        {node.kind === 'divider' && <DividerShapeFields node={node} onChange={(field, v) => content(field, v)} />}
        {node.kind === 'element' && (
          <>
            {!isBinding(node.tag) && <TagField state={state} owner={owner} node={node} onChange={(v) => content('tag', v)} />}
            <GroupSwitch owner={owner} node={node} />
            <p className="faint insp-note">
              A container with {node.children.length} item{node.children.length === 1 ? '' : 's'}. With it selected, add elements inside it from Insert.
            </p>
          </>
        )}
      </Section>
      <Section title="Style" id="prim-style" level={LEVEL} scope={countStyles(node.styles) ? changes(countStyles(node.styles)) : undefined}>
        <StyleControls
          styles={node.styles}
          inherited={undefined}
          allowed={styleSetFor(node)}
          grouped={inGroupAt(state, owner, node.id)}
          tokens={tokens}
          image={node.kind === 'image' ? focusImage(state, devUrl, shownImage(state, selection, node.image), [], 'This picture can’t be shown here.') : undefined}
          onSet={(property, value, expectedRevision, inState) =>
            commitOps([{ type: 'node.setStyle', owner, nodeId: node.id, ...styleAt(scope, inState), property, value }], styleLabel(state, property, refTo(owner, node.id), undefined, value, inState), styleKey(property, `${node.id}:${styleScopeKey(scope, inState)}:${property}`), expectedRevision)
          }
          onReset={(sc, states) => void applyOps(styleResets({ type: 'node.resetStyles', owner, nodeId: node.id }, sc, states), forLabel(state, resetWords('Reset styles', states), refTo(owner, node.id)))}
        />
      </Section>
      <Section title="Advanced" id="prim-advanced" defaultOpen={false} level={LEVEL} scope={[node.anchor && `#${node.anchor}`, node.kind === 'element' && appearSummary(node)].filter(Boolean).join(' · ') || undefined}>
        <Field label="Anchor ID" hint="Lets links jump straight to this element, as #services.">
          <DraftInput value={node.anchor ?? ''} placeholder="e.g. services" onCommit={(v) => content('anchor', v)} />
        </Field>
        {node.kind === 'element' && <EntranceField owner={owner} node={node} />}
      </Section>
    </>
  );
}

/** A divider's shape, and the icon of one drawn around an icon: part of the design, never bound to a property. */
function DividerShapeFields({ node, onChange }: { node: DividerNode; onChange: (field: 'shape' | 'icon', value: string) => void }) {
  const shapeId = useId();
  const iconId = useId();
  // As the site shows it: a shape or icon a hand-edited document names that cannot be drawn shows as a line, or the
  // default icon (validation reports it).
  const shape = (DIVIDER_SHAPES as readonly unknown[]).includes(node.shape) ? (node.shape ?? 'line') : 'line';
  return (
    <>
      <Field label="Shape" controlId={shapeId} hint={shape !== 'line' ? 'Decorative: drawn in this divider’s text color, and hidden from screen readers.' : 'A plain line, which screen readers announce as a separator.'}>
        <select id={shapeId} className="select" value={shape} onChange={(e) => onChange('shape', e.target.value)}>
          <option value="line">Line</option>
          <option value="angle">Angle</option>
          <option value="wave">Wave</option>
          <option value="icon">Line with icon</option>
        </select>
      </Field>
      {shape === 'icon' && (
        <Field label="Icon" controlId={iconId}>
          <IconPicker id={iconId} value={typeof node.icon === 'string' ? node.icon : DIVIDER_ICON} onChange={(v) => onChange('icon', v)} />
        </Field>
      )}
    </>
  );
}

/** Where a component is used, in words: "Home and About", "Home, About and 3 more". */
function placesText(state: ProjectState, def: ComponentDefinition): string {
  const places = [...new Set(instancesOf(state, def.id).map((u) => u.label))];
  if (!places.length) return 'nowhere yet';
  if (places.length === 1) return places[0];
  if (places.length <= 3) return `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}`;
  return `${places.slice(0, 2).join(', ')} and ${places.length - 2} more`;
}

const DoneButton = () => (
  <button className="btn btn-sm" onClick={doneEditing}>
    Done editing
  </button>
);

/** Component editing with nothing selected: what is being edited, where it is used, and how to start. */
function DefinitionOverview({ state, def, nested }: { state: ProjectState; def: ComponentDefinition; nested?: boolean }) {
  const studio = useStore((s) => !!s.definitionMode?.studio);
  return (
    <>
      <Header title={def.name} kind="Component design" tone="definition" icon={<Component />} actions={<DoneButton />}>
        <EverywhereScope state={state} def={def} />
      </Header>
      <div className="insp-empty">
        <MousePointerClick aria-hidden="true" />
        {def.kind === 'code' ? (
          <p>{def.name} is a code component: its layout and styles are in its code. Choose a variant and sample content above to see how it looks.</p>
        ) : (
          <p>
            {nested ? `That belongs to a component inside ${def.name}, so it can’t be changed here. ` : ''}Click a part of {def.name} {studio ? 'in the preview' : 'on the page'}, or choose one:
          </p>
        )}
        <div className="insp-part-list" role="group" aria-label={`Parts of ${def.name}`}>
          {def.tree?.rootIds[0] && (
            <button className="btn btn-sm" onClick={() => selectAndFocus({ owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: def.tree!.rootIds[0] })}>
              Whole {def.name}
            </button>
          )}
          {Object.entries(def.parts)
            .filter(([id]) => id !== 'root' && def.kind === 'managed')
            .map(([id, p]) => (
              <button key={id} className="btn btn-sm" onClick={() => selectAndFocus({ owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: p.nodeId, partId: id })}>
                {p.label}
              </button>
            ))}
        </div>
      </div>
      <PlacementRoleSection state={state} def={def} />
      {def.kind === 'managed' && def.tree && (
        <>
          <PropertiesSection def={def} level={LEVEL} />
          <SlotsSection def={def} level={LEVEL} />
          <VariantsSection def={def} level={LEVEL} onStyle={(target) => styleLook(def, target)} />
          <UiStateSection def={def} level={LEVEL} />
        </>
      )}
    </>
  );
}

const ROLE_WORDS: Record<InsertRole, string> = { section: 'Page section', element: 'Subcomponent / inside layouts' };

/**
 * Where Insert and + put a new placement of a project component (#661): one of a page's sections, or inside a column,
 * container or slot. Automatic leaves it to the editor, which tells from the design (inferredRole) and says which.
 */
function PlacementRoleSection({ state, def }: { state: ProjectState; def: ComponentDefinition }) {
  if (def.owner !== 'project' || def.category === 'shell') return null;
  const automatic = inferredRole(state, def.id);
  const chosen = def.insertAs === 'section' || def.insertAs === 'element' ? def.insertAs : null;
  const choose = (value: string) => {
    const insertAs = value === 'section' || value === 'element' ? value : null;
    if (insertAs === chosen) return;
    void applyOps(
      [{ type: 'component.setInsertAs', definitionId: def.id, insertAs }],
      insertAs ? `Insert ${def.name} as ${insertAs === 'section' ? 'a page section' : 'a subcomponent'}` : `Let the editor choose where ${def.name} is inserted`
    );
  };
  return (
    <Section title="Placement" id="def-placement" level={LEVEL} scope={ROLE_WORDS[chosen ?? automatic]}>
      <Field label="Placement role" hint="Where Insert and + put it: among a page’s sections, or inside a column, container or slot. Placements already made stay where they are.">
        <select className="select" data-placement-role value={chosen ?? ''} onChange={(e) => choose(e.target.value)}>
          <option value="">Automatic ({ROLE_WORDS[automatic].toLowerCase()})</option>
          <option value="section">{ROLE_WORDS.section}</option>
          <option value="element">{ROLE_WORDS.element}</option>
        </select>
      </Field>
    </Section>
  );
}

/**
 * Style one look of a component (or its base design again). From the overview, the whole design is selected so its
 * Style section is there to open; Style then opens once, where focus goes.
 */
function styleLook(def: ComponentDefinition, target: StyleTarget) {
  styleVariant(def, target);
  if (!target) return;
  const rootId = def.tree?.rootIds[0];
  const snap = getState().snapshot;
  const onNode = !!snap && definitionView(snap.state, def.id, getState().selection).kind === 'node';
  if (!onNode && rootId) setState({ selection: { owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: rootId } });
  const chosen = getState().selection;
  setTimeout(() => {
    if (getState().selection === chosen) openSection('def-style', { scroll: true });
  });
}

/** Who a change made while editing a component everywhere reaches. */
function EverywhereScope({ state, def, aside }: { state: ProjectState; def: ComponentDefinition; aside?: ReactNode }) {
  const uses = instancesOf(state, def.id).length;
  return (
    <Scope tone="definition" icon={<Pencil />} aside={aside}>
      <strong>Editing everywhere.</strong>{' '}
      {uses === 0
        ? 'Not placed on any page yet. Changes apply wherever you add it.'
        : uses === 1
          ? `Used on ${placesText(state, def)} and wherever you add it later. A placement’s own changes still win.`
          : `Used ${uses} times, on ${placesText(state, def)}. A placement’s own changes still win.`}
    </Scope>
  );
}

const FIELD_NAME: Record<ContentField, string> = { text: 'text', label: 'button text', link: 'link', image: 'image', icon: 'icon' };

/** A property default's field: its editor, then which placements show it. `content`: the node's field it fills in. */
function DefaultField({ state, def, prop, schema, onChange, label, content }: { state: ProjectState; def: ComponentDefinition; prop: string; schema: ScalarPropSchema; onChange: (v: unknown, edit?: PendingEdit) => void; label?: string; content?: ContentField }) {
  return (
    <div data-field={prop} data-content={content}>
      <FieldHome root={`default:${def.id}:${prop}`} alive={() => Object.hasOwn(getState().snapshot?.state.components[def.id]?.properties ?? {}, prop)}>
        <ScalarField schema={schema} value={schema.default} state={state} label={label ?? schema.label} hint={`Each placement fills this in. ${reachText(defaultReach(state, def.id, prop))}`} onChange={onChange} everywhere />
      </FieldHome>
    </div>
  );
}

/**
 * A nested component's input that the design fills in from one of its own properties: that property's default,
 * which every placement without its own value shows.
 */
function ForwardedDefault({ state, def, binding }: { state: ProjectState; def: ComponentDefinition; binding: { $prop: string; field?: string } }) {
  const prop = binding.$prop;
  // One field of an object reads that field, with the object's default for it.
  const schema = propBindingSchema(def.properties, binding);
  if (!schema) return null;
  if (schema.type === 'list' || schema.type === 'table' || schema.type === 'object') return <p className="muted insp-note">Each placement of {def.name} fills this in, as its {schema.label.toLowerCase()}.</p>;
  const field = binding.field;
  const change = (v: unknown, edit?: PendingEdit) =>
    void applyWith(edit, [propDefaultOp(def.id, prop, field === undefined ? v : { [field]: v })], `Edit ${schema.label} default in the ${def.name} design`, `${def.id}:default:${prop}${field === undefined ? '' : `:${field}`}`);
  return <DefaultField state={state} def={def} prop={prop} schema={schema} onChange={change} />;
}

/** The content a node of the design holds: defaults each placement fills in, values fixed in the design, per-item notes. */
function DesignContentSection({ state, def, node }: { state: ProjectState; def: ComponentDefinition; node: GraphNode }) {
  const iconId = useId();
  const fields = designContent(def, node);
  const tag = designTag(def, node);
  // A tag each placement chooses, through whatever property: it can be made the design's own again.
  const tagBinding = (node.kind === 'element' || (node.kind === 'text' && !node.rich)) && isBinding(node.tag) && '$prop' in node.tag ? node.tag : null;
  if (!fields.length && !tag && !tagBinding && node.kind !== 'divider') return null;
  const kind = elementKind(node).name;
  const set = (f: DesignContent, label: string) => (v: unknown, edit?: PendingEdit) => void applyWith(edit, [designContentOp(def, node.id, f.field, v)], label, `${def.id}:${node.id}:${f.field}`);
  // The node in its design, for History: "Heading in the Pricing card design".
  const here = refTo({ kind: 'component', id: def.id }, node.id);
  // The design's own tag, or the default of the choice each placement makes: either way the node's tag edit.
  const setTag = (v: unknown, edit?: PendingEdit) => void applyWith(edit, [{ type: 'node.setContent', owner: { kind: 'component', id: def.id }, nodeId: node.id, field: 'tag', value: v }], fieldLabel(state, 'tag', here, true), `${def.id}:${node.id}:tag`);
  const items = fields.filter((f): f is Extract<DesignContent, { source: 'item' }> => f.source === 'item');
  const list = items[0]?.list ? (def.properties[items[0].list] as ListProp | undefined) : undefined;
  const sources = new Set([...fields.map((f) => f.source), ...(tag ? [tag.source] : [])]);
  // A divider's shape is the design's own: the same in every placement.
  const scope = sources.size > 1 ? undefined : sources.has('design') || (!sources.size && node.kind === 'divider') ? 'Same in every placement' : sources.has('default') ? 'Filled in on each placement' : `Each ${list?.itemLabel.toLowerCase() ?? 'item'}`;
  return (
    <Section title="Content" id="def-content" level={LEVEL} scope={scope}>
      {tag?.source === 'design' && <TagField state={state} owner={{ kind: 'component', id: def.id }} node={tag.node} onChange={(v) => setTag(v)} hint={sources.size > 1 ? 'Same in every placement.' : undefined} />}
      {tag?.source === 'default' && <DefaultField state={state} def={def} prop={tag.prop} schema={tag.schema} label="Default tag" onChange={setTag} />}
      {tagBinding && <TagBindingControl key={`${tagBinding.$prop}:${tagBinding.field ?? ''}`} def={def} node={node} binding={tagBinding} />}
      {node.kind === 'divider' && (
        <DividerShapeFields
          node={node}
          onChange={(field, v) => void applyOps([{ type: 'node.setContent', owner: { kind: 'component', id: def.id }, nodeId: node.id, field, value: v }], fieldLabel(state, field, here, true), `${def.id}:${node.id}:${field}`)}
        />
      )}
      {fields.map((f) => {
        if (f.source === 'item') return null;
        return (
          <Fragment key={f.field}>
            {editor(f)}
            {/* Keyed by where the field's content comes from, so a form opened for one never shows for the other. */}
            <BindingControl key={f.source === 'default' ? `default:${f.prop}` : f.source} def={def} node={node} content={f} />
          </Fragment>
        );
      })}
      {items.length > 0 && (
        <p className="muted insp-note">
          Each {list?.itemLabel.toLowerCase() ?? 'item'} has its own {listJoin(items.map((f) => FIELD_NAME[f.field]))}. Change {items.length === 1 ? 'it' : 'them'} in the {list?.label.toLowerCase() ?? 'items'} list of each placement.
        </p>
      )}
    </Section>
  );

  /** The editor of one field: its property's default, or the value fixed in the design. */
  function editor(f: Exclude<DesignContent, { source: 'item' }>) {
    if (f.source === 'default') return <DefaultField key={f.field} state={state} def={def} prop={f.prop} schema={f.schema} label={f.field === 'label' ? `${kind} text` : undefined} content={f.field} onChange={set(f, `Edit ${f.schema.label} default in the ${def.name} design`)} />;
    const hint = sources.size > 1 ? 'Same in every placement.' : undefined;
    switch (f.field) {
      case 'text':
        return (
          <div key={f.field} data-field="text">
            {node.kind === 'text' && node.rich ? (
              <Field label="Text" hint={hint} controlId={`${def.id}-${node.id}-text`}>
                <RichTextField id={`${def.id}-${node.id}-text`} describedBy={hint ? `${def.id}-${node.id}-text-note` : undefined} value={richTextToMarkdown(toRichText(f.value), state.pages)} onCommit={(v, edit) => void applyWith(edit, [designContentOp(def, node.id, 'text', v)], editLabel(state, 'Edit', here), `${def.id}:${node.id}:text`)} pages={state.pages} />
              </Field>
            ) : (
              <Field label="Text" hint={hint}>
                <DraftInput multiline rows={2} value={Array.isArray(f.value) ? richTextToMarkdown(toRichText(f.value), state.pages) : String(f.value ?? '')} onCommit={(v) => void applyOps([designContentOp(def, node.id, 'text', v)], editLabel(state, 'Edit', here), `${def.id}:${node.id}:text`)} />
              </Field>
            )}
          </div>
        );
      case 'label':
        return (
          <div key={f.field} data-field="label">
            <Field label={`${kind} text`} hint={hint}>
              <DraftInput value={String(f.value ?? '')} onCommit={(v) => void applyOps([designContentOp(def, node.id, 'label', v)], editLabel(state, 'Edit', here), `${def.id}:${node.id}:label`)} />
            </Field>
          </div>
        );
      case 'link':
        // A destination fixed in the design: a button without one is left out of every placement.
        return (
          <div key={f.field} className="field" data-field="link" role="group" aria-labelledby={`${node.id}-def-dest`}>
            <div className="field-label" id={`${node.id}-def-dest`}>
              Link
            </div>
            <LinkEditor value={f.value as LinkValue} onChange={set(f, fieldLabel(state, 'link', here, true))} state={state} label={kind} everywhere />
            {hint && <div className="field-hint">{hint}</div>}
          </div>
        );
      case 'image':
        return (
          <div key={f.field} className="field" data-field="image" role="group" aria-label="Image">
            <FieldHome root={`component:${def.id}:${node.id}:image`} alive={nodeAlive({ kind: 'component', id: def.id }, node.id)}>
              <ImageEditor value={f.value as ImageValue} onChange={set(f, editLabel(state, 'Edit', here))} state={state} />
            </FieldHome>
            {hint && <div className="field-hint">{hint}</div>}
          </div>
        );
      case 'icon':
        return (
          <div key={f.field} data-field="icon">
            <Field label="Icon" controlId={iconId} hint={hint}>
              <IconPicker id={iconId} value={String(f.value ?? '')} onChange={set(f, fieldLabel(state, 'icon', here, true))} />
            </Field>
          </div>
        );
    }
  }
}

/**
 * The tag of a container or plain text in a component's design, and who owns it: fixed in the design, or the default
 * of the choice it is bound to (each placement chooses its own). A tag each list item sets is changed with the list.
 */
function designTag(def: ComponentDefinition, node: GraphNode): { source: 'design'; node: ElementNode | TextNode } | { source: 'default'; prop: string; schema: ScalarPropSchema } | null {
  if (node.kind !== 'element' && !(node.kind === 'text' && !node.rich)) return null;
  if (!isBinding(node.tag)) return { source: 'design', node };
  if (!('$prop' in node.tag)) return null;
  const schema = Object.hasOwn(def.properties, node.tag.$prop) ? def.properties[node.tag.$prop] : undefined;
  return schema?.type === 'enum' ? { source: 'default', prop: node.tag.$prop, schema } : null;
}

/** A component placed in the design: the inputs the design gives it, the same in every placement. */
function NestedInputs({ state, def, node, placedDef }: { state: ProjectState; def: ComponentDefinition; node: InstanceNode; placedDef: ComponentDefinition }) {
  const owner: OwnerRef = { kind: 'component', id: def.id };
  // A Project health finding about a form in the design (Go to form) opens its setting here, as on a page.
  const reveal = useFieldReveal({ owner, instancePath: [], nodeId: node.id });
  const fields = groupFields(Object.entries(placedDef.properties).map(([key, schema]) => ({ key, schema: schema as PropSchema, data: null })));
  if (!fields.length) return null;
  return (
    <Section title="Content" id="content" level={LEVEL} scope="Same in every placement">
      <FieldHome root={`${owner.kind}:${owner.id}:${node.id}`} alive={nodeAlive(owner, node.id)}>
        <FieldGroups
          groups={fields}
          render={({ key, schema, label }) => {
            const raw = node.props[key];
            const forwarded = forwardedBinding(raw);
            if (forwarded) return <ForwardedDefault key={key} state={state} def={def} binding={forwarded} />;
            if (isBinding(raw))
              return (
                <p key={key} className="muted insp-note">
                  {label ?? schema.label}: each item of the list has its own.
                </p>
              );
            return (
              <PropField
                key={key}
                name={key}
                schema={schema}
                label={label}
                value={raw ?? schema.default}
                onChange={(v, edit) => void applyWith(edit, [{ type: 'instance.setProp', owner, nodeId: node.id, prop: key, value: v }], fieldLabel(state, schema.label, refTo(owner, node.id)), `${def.id}:${node.id}:${key}`)}
                onField={(field, v, edit) => void applyWith(edit, [{ type: 'instance.setProp', owner, nodeId: node.id, prop: key, field, value: v }], fieldLabel(state, schema.label, refTo(owner, node.id)), `${def.id}:${node.id}:${key}:${field}`)}
                onList={(op) => applyListOp(owner, node.id, key, op, fieldLabel(state, schema.label, refTo(owner, node.id)), op.kind === 'field' ? `${def.id}:${node.id}:${key}:${op.itemId}:${op.field}` : undefined, true)}
                read={() => readProp(owner, node.id, key)}
                alive={propAlive(owner, node.id, key)}
                itemAlive={(itemId, field) => rowAlive(owner, node.id, key, itemId, field)}
                onTable={(edit) => applyTableEdit(owner, node.id, key, edit, fieldLabel(state, schema.label, refTo(owner, node.id)))}
                state={state}
                linkPairs={schema.type === 'list' ? itemLinkPairs(placedDef, key) : undefined}
                openItem={reveal?.prop === key && reveal.itemId ? { seq: reveal.seq, itemId: reveal.itemId } : undefined}
                everywhere
                pickImages={pickImagesField(placedDef, key, schema)}
              />
            );
          }}
        />
      </FieldHome>
    </Section>
  );
}

const listJoin = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function DefinitionNodeInspector({ state, def, node, tokens }: { state: ProjectState; def: ComponentDefinition; node: GraphNode; tokens: Tokens }) {
  const scope = useStore((s) => s.styleScope);
  const devUrl = useDevUrl();
  // In Component Studio the canvas shows the component on its own, never through a placement on the page.
  const pageId = useStore((s) => (s.definitionMode?.studio ? null : s.pageId));
  const studio = useStore((s) => !!s.definitionMode?.studio);
  const selection = useStore((s) => s.selection);
  const owner: OwnerRef = { kind: 'component', id: def.id };
  const uses = instancesOf(state, def.id).length;
  const partId = Object.entries(def.parts).find(([, p]) => p.nodeId === node.id)?.[0];
  const isRoot = def.tree?.rootIds[0] === node.id;
  // The look the Style section styles: one option of a choice placements make, or the base design.
  const target = useVariantStyle(def);
  const lookable = variantStylable(def, node);
  const look = target && lookable ? target : null;
  const lookAxis = look ? def.variantAxes![look.axis] : undefined;
  const lookOption = look ? lookAxis!.options[look.variant] : undefined;
  // Component Studio previews the design's UI state at the values its toolbar shows: a component placed in the design
  // whose variant follows that state is styled as the canvas shows it.
  const studioView = useStore((s) => (s.definitionMode?.definitionId === def.id ? s.definitionMode.studio : undefined));
  const stateShown = previewedState(def, studioView);
  // A component placed in the design: its choices as the site starts them. One this design's state or property sets
  // shows that one's default.
  const startChoices: InstanceNode['variants'] =
    node.kind === 'instance'
      ? Object.fromEntries(
          Object.entries(startingVariants(node.variants, stateShown) ?? {}).map(([axis, v]) => [axis, isBinding(v) && '$prop' in v ? ((propBindingSchema(def.properties, v)?.default as string | undefined) ?? v) : v])
        )
      : undefined;
  // Under a look's own rules: what the design gives this element at each size without them (its own styles and the
  // default of every other choice), and for a component placed in the design, that component's design and the
  // changes this design makes to it.
  // Every rule on this element with the look chosen, the look's own included, weakest first: what a hover, focus or
  // pressed state of the look shows through is worked out among them (see stateUnder).
  const lookLayers = look
    ? node.kind === 'instance'
      ? (() => {
          const placed = state.components[node.definitionId];
          const rootId = placed?.parts.root?.nodeId ?? placed?.tree?.rootIds[0];
          const inner = placed?.kind === 'managed' && rootId ? designLayers(placed, rootId, startChoices) : [];
          // The other choices of this design style the placed component too, as their defaults. Their rules and the
          // placed design's own are equally specific, so the stylesheet's order decides: definitions by ID.
          // Each definition's stylesheet is written whole, its states included, before the next: its block.
          const outerFirst = def.id.localeCompare(node.definitionId) < 0;
          const outer = designLayers(def, node.id, { [look.axis]: look.variant })
            .filter((l) => l.styles)
            .map((l) => ({ ...l, block: outerFirst ? 0 : 1 }));
          const innerBlocks = inner.map((l) => ({ ...l, block: outerFirst ? 1 : 0 }));
          const layers = outerFirst ? [...outer, ...innerBlocks] : [...innerBlocks, ...outer];
          return [...layers, { styles: node.overrides?.root, strength: 3, wideColumns: true, unhides: inner.map((l) => l.styles) }];
        })()
      : designLayers(def, node.id, { [look.axis]: look.variant })
    : undefined;
  const lookInherited = lookLayers ? cascadeStyles(lookLayers.filter((l) => l.styles !== lookOption!.styles?.[node.id])) : undefined;
  // The look's preview renders only while the Inspector is on screen: a hidden one would prepare it again on every change.
  const inspecting = useStore((s) => s.dockOpen && s.rightTab === 'inspect');
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  // Several layers selected together in Layers: Create would package only this one, so it is not offered.
  const several = useStore((s) => (s.layerSet ? (liveGroup(s)?.ids.length ?? 0) > 1 : false));
  // The design's own node, even when it was reached through a placement on the page.
  const create = several ? null : createComponentTarget({ state, readOnly }, { owner, instancePath: [], nodeId: node.id });
  // A container of the design becomes the item of a new list: the same as the canvas and Layers.
  // Worked out once for each version of the project, not on every render: it reads the design (and, for rich text, every placement).
  const repeat = useMemo(() => (several ? null : repeatAsListTarget({ state, readOnly }, { owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: node.id })), [several, state, readOnly, def.id, node.id]);
  // A container of the design becomes a slot each placement fills, or says why it can't: the same as the canvas and Layers.
  const slot = useMemo(() => (several ? null : turnIntoSlotTarget({ state, readOnly }, { owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: node.id })), [several, state, readOnly, def.id, node.id]);
  // Wrap and Ungroup act on the design's own node, also when it was reached through a placement on the page, or on the
  // layers selected with it in Layers: followed, so the menu is rebuilt when they change.
  useStore((s) => {
    const g = s.layerSet ? liveGroup(s) : null;
    return g ? g.ids.join(' ') : null;
  });
  const designRef: ElementRef = { owner, instancePath: [], nodeId: node.id };
  const designPlan = isRoot ? null : planFor(designRef);
  const designWraps = wrapMenu(designPlan, false);
  const designItems: MenuItem[] = [
    ...(create ? [{ label: 'Create component…', icon: <Component />, onSelect: () => setState({ modal: { kind: 'create-component', ref: create } }) }] : []),
    ...(repeat ? [{ label: 'Repeat as list…', icon: <Repeat />, onSelect: () => setState({ modal: { kind: 'repeat-as-list', ref: repeat, workspaceKey: getState().snapshot?.workspaceKey } }) }] : []),
    ...(slot ? [{ ...turnIntoSlotItem(slot, (ref) => setState({ modal: { kind: 'turn-into-slot' as const, ref, workspaceKey: getState().snapshot?.workspaceKey } })), icon: <SquareDashed /> }] : []),
    ...((create || repeat || slot) && designWraps.length ? [{ separator: true }] : []),
    ...designWraps
  ];
  const title = partId && partId !== 'root' ? def.parts[partId].label : isRoot ? def.name : refLabel(state, { owner, instancePath: [], nodeId: node.id });
  // A copy of a theme component compares against the theme's design, so only real changes show as changes.
  const original = def.componentId ? catalogueComponent(state.site.themeId, def.componentId)?.tree?.nodes[node.id]?.styles : undefined;
  const changed: ResponsiveStyles | undefined = original
    ? Object.fromEntries(
        Object.entries(node.styles ?? {})
          .map(([sc, vals]) => [sc, Object.fromEntries(Object.entries(vals ?? {}).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((original as ResponsiveStyles)[sc as keyof ResponsiveStyles]?.[k])))])
          .filter(([, vals]) => Object.keys(vals as object).length)
      )
    : node.styles;
  // A part inside a repeat is styled once for every item, in every placement.
  const repeated = enclosingRepeat(def, node.id);
  // The picture as the canvas shows it, through this component's one placement on the page (with the item
  // picked there); else the design's own picture, or its default for one each placement chooses. With several
  // placements on the page the canvas's choice isn't known here, so the default stands. The crop follows the
  // node's complete styles: `changed` lists only what differs from the theme's design.
  const onPage = pageId ? placementsOn(state, def.id, pageId) : [];
  const placement = onPage.length === 1 ? onPage[0] : undefined;
  const bound = node.kind === 'image' && isBinding(node.image) ? node.image : undefined;
  const ownRef = selection?.owner.kind === 'component' && selection.owner.id === def.id && selection.nodeId === node.id ? selection : undefined;
  const placedImage = node.kind === 'image' && bound && placement && ownRef ? shownImage(state, throughPlacement(ownRef, placement), bound) : undefined;
  // That placement (or the variants it picks) may set its own crop over the design's.
  const placed = placement ? resolveRef(state, placement).node : undefined;
  const cropKeys = ['aspectRatio', 'objectFit', 'objectPosition'];
  const setsCrop = (rs: ResponsiveStyles | undefined) => Object.values(rs ?? {}).some((sc) => cropKeys.some((k) => sc?.[k] !== undefined));
  const placementCrops =
    placed?.kind === 'instance' && ((partId !== undefined && setsCrop(placed.overrides?.[partId])) || selectedVariantStyles(def, placed.variants, node.id).some(setsCrop));
  const defImage =
    node.kind === 'image'
      ? {
          ...focusImage(
            state,
            devUrl,
            placedImage ?? (!bound ? node.image : '$prop' in bound ? propBindingSchema(def.properties, bound)?.default : undefined),
            [],
            'Each one shows its own picture. Select one on the page to see it here.',
            node.styles ?? {}
          ),
          note: placementCrops ? 'The placement on this page sets its own crop, so the canvas may differ.' : undefined
        }
      : undefined;
  const placedDef = node.kind === 'instance' ? state.components[node.definitionId] : undefined;
  // A button with words and no destination in the design: the site leaves it out of every placement, unless it changes
  // the component's UI state (a tab, a toggle), which makes it a real button.
  const fixedLink = node.kind === 'link' && !isBinding(node.link) ? (node.link as LinkValue | null | undefined) : undefined;
  const designUnlinked =
    node.kind === 'link' &&
    !isBinding(node.link) &&
    !stateActionRuns(def, node.stateAction, node.id) &&
    (node.appearance === 'primary' || node.appearance === 'secondary') &&
    typeof node.label === 'string' &&
    !!node.label.trim() &&
    (!fixedLink || fixedLink.type === 'none' || !fixedLink.target);
  const itemWord = repeated ? (def.properties[repeated] as { itemLabel?: string } | undefined)?.itemLabel?.toLowerCase() : undefined;
  const placements = uses === 1 ? '1 placement' : `${uses} placements`;
  // The design's parts, the whole design first, this one checked: across to another part without the overview.
  const rootId = def.tree?.rootIds[0];
  const designParts = [
    ...(rootId ? [{ label: `Whole ${def.name}`, current: isRoot, select: () => selectAndFocus({ owner, instancePath: [], nodeId: rootId }) }] : []),
    ...Object.entries(def.parts)
      .filter(([id]) => id !== 'root')
      .map(([id, p]) => ({ label: p.label, current: p.nodeId === node.id, select: () => selectAndFocus({ owner, instancePath: [], nodeId: p.nodeId, partId: id }) }))
  ];
  const kindLine = isRoot ? (
    'Component design'
  ) : (
    <>
      Part of{' '}
      {/* Back to the design's parts, as Esc goes: the whole design is one of them. */}
      <button
        className="link-btn"
        onClick={() => {
          setState({ selection: null });
          focusName();
        }}
        title={`Show the parts of ${def.name} (Esc)`}
      >
        {def.name}
      </button>
      {repeated ? (
        <>
          {' '}
          <span className="insp-kind-pos">· every {itemWord ?? 'item'}</span>
        </>
      ) : null}
    </>
  );
  return (
    <>
      <Header
        title={title}
        kind={kindLine}
        tone="definition"
        icon={isRoot ? <Component /> : elementKind(node).icon}
        actions={
          <>
            {designItems.length > 0 && <SelectionActions title={title} selection={create ?? designRef} ask={false} items={designItems} group={several ? groupCount(designPlan!.group) : undefined} />}
            <DoneButton />
          </>
        }
      >
        <EverywhereScope
          state={state}
          def={def}
          aside={
            designParts.length > 1 && (
              <span className="insp-mini-row">
                <PartsButton title={def.name} parts={designParts} />
              </span>
            )
          }
        />
      </Header>
      <Problems>
        {designUnlinked && (
          <Problem onGo={() => revealContentField('def-content', 'link')} go="Choose a link">
            <strong>Visitors won’t see this button.</strong> It has no link in the design, so no placement shows it.
          </Problem>
        )}
      </Problems>
      <DesignContentSection state={state} def={def} node={node} />
      {/* A component placed in the design: what it is given here, the same in every placement. */}
      {node.kind === 'instance' && placedDef && <NestedInputs state={state} def={def} node={node} placedDef={placedDef} />}
      <PartSection def={def} node={node} level={LEVEL} />
      {isRoot && <PlacementRoleSection state={state} def={def} />}
      {isRoot && <PropertiesSection def={def} level={LEVEL} />}
      <SlotsSection def={def} node={node} level={LEVEL} />
      {isRoot && <VariantsSection def={def} level={LEVEL} onStyle={(t) => styleLook(def, t)} />}
      {isRoot && <UiStateSection def={def} level={LEVEL} />}
      <ConditionControls def={def} node={node} level={LEVEL} />
      {node.kind === 'element' && (
        <Section title="Interaction group" id="def-group" defaultOpen={false} level={LEVEL} scope={node.interactionGroup ? 'On' : undefined}>
          <GroupSwitch owner={owner} node={node} />
        </Section>
      )}
      {node.kind === 'link' && <ClickActionSection def={def} node={node} level={LEVEL} />}
      {overlayOffered(def, node) && <OverlaySection def={def} node={node} level={LEVEL} />}
      {node.kind === 'instance' && isWebMcpForm(placedDef) && (
        <Section title="Agent tool" id="def-webmcp" defaultOpen={false} level={LEVEL}>
          <FormToolFields state={state} owner={owner} node={node} def={placedDef} />
        </Section>
      )}
      {(node.kind === 'element' || node.kind === 'repeat' || (node.kind === 'instance' && anchorCapable(state, placedDef))) && (
        <Section
          title="Entrance"
          id="def-entrance"
          defaultOpen={false}
          level={LEVEL}
          scope={node.kind === 'repeat' ? (node.appearStagger ? 'Staggered' : undefined) : appearSummary(node, node.kind === 'instance' ? designAppear(state, placedDef) : undefined)}
        >
          {node.kind === 'repeat' ? <StaggerSwitch owner={owner} node={node} /> : <EntranceField owner={owner} node={node} design={node.kind === 'instance' ? designAppear(state, placedDef) : undefined} />}
        </Section>
      )}
      {/* The placed Section's own columns, for every look: hidden while a look is styled, which they would not follow. */}
      {node.kind === 'instance' && placedDef?.kind === 'managed' && !look && (
        <ColumnLayout
          owner={owner}
          def={placedDef}
          node={node}
          variants={startChoices}
          tokens={tokens}
          onSet={(partId) => (property, value, expectedRevision) =>
            commitOps([{ type: 'node.setStyle', owner, nodeId: node.id, partId, scope, property, value }], styleLabel(state, property, refTo(owner, node.id), placedDef?.parts[partId]?.label, value), styleKey(property, `${def.id}:${node.id}:${partId}:${scope}:${property}`), expectedRevision)
          }
        />
      )}
      <Section title="Style" id="def-style" level={LEVEL} scope={[look ? `${lookAxis!.label}: ${lookOption!.label}` : '', repeated ? `Every ${itemWord ?? 'item'}` : '', placements].filter(Boolean).join(' · ')}>
        <StyleTargetField def={def} target={look} disabledReason={lookable ? undefined : 'A look styles the elements inside this, not this itself.'} />
        {look ? (
          <>
            {inspecting && !studio && (
              <div className="contract-preview" aria-label={`${def.name} with ${lookOption!.label}`}>
                <LivePreview spec={{ definitionId: def.id, variants: { [look.axis]: look.variant } }} label={lookOption!.label} maxH={180} fallback={<span className="faint insp-note">{def.name}</span>} />
              </div>
            )}
            <StyleControls
              key={`${look.axis}:${look.variant}`}
              styles={lookOption!.styles?.[node.id]}
              inherited={lookInherited}
              layers={lookLayers}
              wideColumns
              tokens={tokens}
              allowed={node.kind === 'instance' ? (placedDef?.parts.root?.styleControls ?? styleSetFor(node)) : styleSetFor(node)}
              grouped={inGroupAt(state, owner, node.id)}
              onSet={(property, value, expectedRevision, inState) =>
                commitOps(
                  [{ type: 'node.setStyle', owner, nodeId: node.id, variant: look.variant, axis: look.axis, ...styleAt(scope, inState), property, value }],
                  `${value === null ? 'Reset' : 'Set'} ${styleWords(property)}${inState ? ` ${STATE_WORDS[inState]}` : ''} for the ${lookOption!.label} look of ${subjectWords(state, refTo(owner, node.id))}`,
                  styleKey(property, `${def.id}:${node.id}:${look.axis}:${look.variant}:${styleScopeKey(scope, inState)}:${property}`),
                  expectedRevision
                )
              }
              onReset={(sc, states) =>
                void applyOps(
                  styleResets({ type: 'node.resetStyles', owner, nodeId: node.id, variant: look.variant, axis: look.axis }, sc, states),
                  states?.length ? `${resetWords('', states)} of the ${lookOption!.label} look of ${subjectWords(state, refTo(owner, node.id))}` : `Clear the ${lookOption!.label} look of ${subjectWords(state, refTo(owner, node.id))}`
                )
              }
              resetLabel={`Clear the ${lookOption!.label} look here`}
              target={`the ${lookOption!.label} look of this element`}
            />
          </>
        ) : node.kind === 'instance' ? (
          <StyleControls
            styles={node.overrides?.root}
            inherited={placedDef?.kind === 'managed' && placedDef.tree ? designStyles(placedDef, placedDef.parts.root?.nodeId ?? placedDef.tree.rootIds[0], startingVariants(node.variants, stateShown)) : undefined}
            wideColumns
            tokens={tokens}
            allowed={placedDef?.parts.root?.styleControls ?? styleSetFor(node)}
            grouped={inGroupAt(state, owner, node.id)}
            layers={placedDef?.kind === 'managed' && placedDef.tree ? designLayers(placedDef, placedDef.parts.root?.nodeId ?? placedDef.tree.rootIds[0], startingVariants(node.variants, stateShown)) : undefined}
            onSet={(property, value, expectedRevision, inState) =>
              commitOps([{ type: 'node.setStyle', owner, nodeId: node.id, partId: 'root', ...styleAt(scope, inState), property, value }], styleLabel(state, property, refTo(owner, node.id), undefined, value, inState), styleKey(property, `${def.id}:${node.id}:root:${styleScopeKey(scope, inState)}:${property}`), expectedRevision)
            }
            onReset={(sc, states) => void applyOps(styleResets({ type: 'node.resetStyles', owner, nodeId: node.id, partId: 'root' }, sc, states), forLabel(state, resetWords('Reset overrides', states), refTo(owner, node.id)))}
            target={`the ${(node.name ?? placedDef?.name ?? 'component').toLowerCase()} itself`}
          />
        ) : (
        <StyleControls
          styles={changed}
          inherited={original}
          designSizesWin
          tokens={tokens}
          allowed={styleSetFor(node)}
          // A list or a slot renders no element of its own: nothing would show a state of it.
          states={node.kind !== 'repeat' && node.kind !== 'slot'}
          grouped={inGroupAt(state, owner, node.id)}
          image={defImage}
          onSet={(property, value, expectedRevision, inState) => {
            // Resetting a value restores the original design's value, when there is one.
            const restore = value === null ? original?.[styleScopeKey(scope, inState)]?.[property] : undefined;
            return commitOps(
              [{ type: 'node.setStyle', owner, nodeId: node.id, ...styleAt(scope, inState), property, value: restore ?? value }],
              styleLabel(state, property, refTo(owner, node.id), undefined, restore ?? value, inState),
              styleKey(property, `${def.id}:${node.id}:${styleScopeKey(scope, inState)}:${property}`),
              expectedRevision
            );
          }}
          onReset={
            original
              ? (only, states) => {
                  const ops: EditOperation[] = [];
                  // A size restores its resting style and its states; without one, every rule that changed. With
                  // states, only their rules.
                  for (const key of Object.keys(changed ?? {}) as Array<keyof ResponsiveStyles>) {
                    const at = parseStyleScopeKey(key);
                    if (!at || (only && at.scope !== only) || (states?.length && !(at.state && states.includes(at.state)))) continue;
                    for (const prop of Object.keys(changed?.[key] ?? {})) ops.push({ type: 'node.setStyle', owner, nodeId: node.id, scope: at.scope, ...(at.state ? { state: at.state } : {}), property: prop, value: (original[key]?.[prop] ?? null) as StyleValue | null });
                  }
                  if (ops.length) void applyOps(ops, forLabel(state, states?.length ? resetWords('', states) : 'Restore the design’s styles', refTo(owner, node.id)));
                }
              : (sc, states) => void applyOps(styleResets({ type: 'node.resetStyles', owner, nodeId: node.id }, sc, states), forLabel(state, resetWords('Clear styles', states), refTo(owner, node.id)))
          }
          resetLabel={original ? 'Restore original design' : 'Clear styles on this element'}
        />
        )}
      </Section>
    </>
  );
}

/** The language a page is written in, and the same page in other languages. */
function PageLanguage({ page, state }: { page: PageDoc; state: ProjectState }) {
  const site = siteLanguage(state.site);
  const peers = translationPeers(state, page);
  const group = linkedGroup(state, page);
  const own = typeof page.language === 'string' ? page.language : '';
  // A page with translations joins only pages without any of their own: two sets are never merged. A page whose
  // language one of the versions already has is shown, but cannot be chosen until one of them changes language.
  const candidates = state.site.pageOrder
    .map((id) => state.pages[id])
    .filter((p) => p && p.id !== page.id && !peers.includes(p) && (!group || !linkedGroup(state, p)))
    .map((p) => ({ page: p, clash: linkClash(state, page, p) }));
  const link = (pageId: string, to: string | null, label: string) => void applyOps([{ type: 'page.update', pageId, linkTranslationTo: to }], label);
  // Closed until wanted: its heading says what the page is written in and how many versions it has.
  const name = languageName(own || site);
  const summary = peers.length ? `${name} · ${peers.length} translation${peers.length === 1 ? '' : 's'}` : own ? name : `${name} · site language`;
  return (
    <Section title="Language" id="page-language" level={LEVEL} defaultOpen={false} scope={summary}>
      <Field label="Page language" hint={own ? 'A language code, such as fr or en-GB. Clear it to use the site language.' : 'Uses the site language. Enter a code such as fr or en-GB if this page is written in another language.'}>
        <DraftInput value={own} placeholder={site} onCommit={(v) => void applyOps([{ type: 'page.update', pageId: page.id, language: v.trim() }], `Change page language (${page.title})`)} ariaLabel="Page language" />
      </Field>
      <Field label="Translations" hint="Browsers and search engines learn which pages are the same page in other languages. For visitors to switch, add a link or button to the other version and choose it under Page.">
        {peers.length > 0 && (
          <ul className="insp-translations" aria-label="Translations of this page">
            {peers.map((p) => (
              <li key={p.id}>
                <button
                  className="insp-mini grow ellipsis"
                  onClick={() => {
                    selectPage(p.id);
                    focusName();
                  }}
                  title={`Open ${p.title}`}
                >
                  {p.title}
                </button>
                <span className="mono faint">
                  {pageLanguage(state.site, p)}
                  {isDraftPage(state, p) ? ' · draft' : ''}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    link(p.id, null, 'Unlink translation');
                    // The row goes with the link: focus moves on to the menu for linking another version.
                    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('#dock-panel-inspect [aria-label="Link a translation"]')?.focus()));
                  }}
                  aria-label={`Unlink ${p.title}`}
                >
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        )}
        <select className="select" value="" aria-label="Link a translation" onChange={(e) => e.target.value && link(page.id, e.target.value, 'Link translation')}>
          <option value="">{peers.length ? 'Link another version…' : 'Link the same page in another language…'}</option>
          {candidates.map(({ page: p, clash }) => (
            <option key={p.id} value={p.id} disabled={!!clash}>
              {p.title} ({pageLanguage(state.site, p)}){clash ? ` · two versions would be in ${clash.language}` : ''}
            </option>
          ))}
        </select>
      </Field>
    </Section>
  );
}

/** What a part of a computed list shows, and where to change it: the article page, or the post, it comes from. */
function ComputedItemNote({ state, pageId, listLabel }: { state: ProjectState; pageId?: string; listLabel: string }) {
  const post = pageId ? findEntry(state, pageId) : undefined;
  if (post)
    return (
      <>
        <p className="muted insp-note">
          From “{post.entry.title}” in {post.collection.settings.name}, and follows it: its title, date, author, excerpt, featured image and categories are changed there, and every feed shows the change.
        </p>
        <button className="btn btn-sm insp-inline-btn" onClick={() => void openPost(post.collection.settings.id, post.entry.id)}>
          Edit {post.entry.title}
        </button>
      </>
    );
  const page = pageId ? state.pages[pageId] : undefined;
  if (!page) return <p className="muted insp-note">The {listLabel} come from the site’s pages or posts. Click one on the page to see where it comes from.</p>;
  return (
    <>
      <p className="muted insp-note">
        From {page.title}’s page settings, and follows them: its title, publication date, byline and excerpt are changed there, and every News list shows the change.
      </p>
      <button className="btn btn-sm insp-inline-btn" onClick={() => openPageSettings(page.id)}>
        Edit {page.title}
      </button>
    </>
  );
}

/**
 * Whether a page is a dated article, and its date, byline, excerpt and place in News lists. The title is the page's
 * own (above), so renaming the page renames the article everywhere it is listed.
 */
function ArticleSettings({ page, draft, upd }: { page: PageDoc; draft: boolean; upd: (patch: Record<string, unknown>, label?: string) => void }) {
  const article = pageArticle(page);
  // Open for an article; an ordinary page keeps it closed, with "Off" beside the heading.
  return (
    // Remembered apart for articles and ordinary pages, so closing one never hides the other.
    <Section title="Article" id={article ? 'page-article' : 'page-article-off'} level={LEVEL} defaultOpen={!!article} scope={article ? (draft ? 'Dated · draft' : 'Dated') : 'Off'}>
      <SwitchRow
        checked={!!article}
        onChange={(v) => upd(v ? { articleDate: todayArticleDate() } : { article: false }, v ? 'Make page an article' : 'Make article an ordinary page')}
        label="Dated article"
        hint={
          article
            ? 'Turning this off removes its date, byline and excerpt.'
            : 'For news and announcements: give the page a date, byline and excerpt, and News lists show it automatically.'
        }
      />
      {article && (
        <>
          <Field label="Article date" hint="Orders it in News lists. An earlier date backdates it.">
            {/* A date left incomplete (or cleared) changes nothing: the saved date comes back. */}
            <DraftInput type="date" value={article.date} onCommit={(v) => (isArticleDate(v) && v !== article.date ? upd({ articleDate: v }, 'Change publication date') : undefined)} />
          </Field>
          <Field label="Byline" hint="Optional. Shown as written.">
            <DraftInput limit={TEXT_LIMITS.byline} keep={`page:${page.id}:byline`} keepWhile={articleAlive(page.id)} placeholder="By Ana Ruiz" value={typeof article.byline === 'string' ? article.byline : ''} onCommit={(v) => upd({ byline: v }, 'Change byline')} />
          </Field>
          <Field label="Excerpt" hint="A sentence or two for News lists and the Article header, under the title.">
            <DraftInput multiline limit={TEXT_LIMITS.excerpt} keep={`page:${page.id}:excerpt`} keepWhile={articleAlive(page.id)} value={typeof article.excerpt === 'string' ? article.excerpt : ''} onCommit={(v) => upd({ excerpt: v }, 'Change excerpt')} />
          </Field>
          <SwitchRow
            checked={article.hidden !== true}
            onChange={(v) => upd({ newsHidden: !v }, v ? 'Show article in news lists' : 'Hide article from news lists')}
            label={draft ? 'Include in News lists once published' : 'Include in News lists'}
            hint={
              article.hidden === true
                ? draft
                  ? 'Left out of every News list, even after the page is published.'
                  : 'Left out of every News list. The page itself stays published at its address.'
                : draft
                  ? 'Drafts stay out of News lists until the page is published.'
                  : 'News lists show the newest articles first, up to each list’s limit.'
            }
          />
        </>
      )}
    </Section>
  );
}

/**
 * Which page this page is inside, chosen from a list: the page moves into that page's folder, keeping the last part
 * of its address ("/kitchens/" inside Lookbook becomes "/lookbook/kitchens/"), with the pages inside it. A page that
 * could not move there (too deep, or onto an address in use) is offered disabled. Where its link sits in the header
 * menu is chosen in the menu itself.
 */
function PageLocation({ page, state }: { page: PageDoc; state: ProjectState }) {
  // The version of the project these choices come from: a move is sent against it, so a page that moved meanwhile
  // asks the author to choose again rather than landing somewhere else.
  const revision = useStore((s) => s.snapshot?.revision);
  const rows = pageRows(state.pages, state.site.pageOrder);
  const parentId = pageParents(Object.values(state.pages)).get(page.id) ?? '';
  const leaf = routeLeaf(page.route);
  const branch = new Set([page.id, ...pagesWithin(state.pages, page.id)]);
  /** Why the page cannot move to `to`, or null. */
  const problem = (to: string) => (to === page.route ? null : (validateRoute(to) ?? (planRouteMove(state, page.id, to, validateRoute) as { error?: string }).error ?? null));
  const choices = rows
    .filter((r) => r.id !== state.site.homePageId && !branch.has(r.id))
    .map((r) => {
      const to = `${state.pages[r.id].route}${leaf}/`;
      return { ...r, to, err: problem(to) };
    });
  const atTop = `/${leaf}/`;
  const topErr = problem(atTop);
  // An address with folders no page uses ("/lookbook/2026/kitchens/") is shown as it is, so its parent (or the top
  // level) can still be chosen to move it straight there.
  const exact = (parentId ? `${state.pages[parentId].route}${leaf}/` : atTop) === page.route;
  const move = (id: string) => {
    if (id === HERE) return;
    const to = id ? choices.find((c) => c.id === id)?.to : atTop;
    if (!to || to === page.route) return;
    void applyOps([{ type: 'page.update', pageId: page.id, route: to }], id ? `Move page ${page.title} into ${state.pages[id].title}` : `Move page ${page.title} to the top level`, undefined, revision);
  };
  return (
    <Field label="Inside" hint={exact ? 'Moves the page and its address. Its link in the header menu stays where it is.' : `Its address, ${page.route}, has folders of its own. Choosing a page moves it straight inside that page.`}>
      <select className="select" value={exact ? parentId : HERE} onChange={(e) => move(e.target.value)} aria-label="Inside page">
        {!exact && (
          <option value={HERE} disabled>
            {parentId ? `${state.pages[parentId].title}, at ${page.route}` : `Top level, at ${page.route}`}
          </option>
        )}
        <option value="" disabled={!!topErr} title={topErr ?? undefined}>
          Top level{topErr ? ' (not possible)' : ''}
        </option>
        {choices.map((c) => (
          <option key={c.id} value={c.id} disabled={!!c.err} title={c.err ?? undefined}>
            {'\u2003'.repeat(c.depth)}
            {state.pages[c.id].title} ({state.pages[c.id].route}){c.err ? ' (not possible)' : ''}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The Inside choice standing for where a page with folders of its own in its address is now. */
const HERE = ':here';

/** A language code by name ("fr" → "French"), or the code itself when it isn't one the system knows. */
function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/** Which shared parts a page shows, for its closed section's heading. */
const shellSummary = (header: boolean, footer: boolean) => (header && footer ? 'Both shown' : header ? 'Header only' : footer ? 'Footer only' : 'Both hidden');

/**
 * A page's Search & sharing settings, with previews of its search result, link card and structured data that follow
 * its title, description and canonical URL as they are typed. Its own component, so typing re-renders only this.
 */
function PageSearchSettings({ page, state, draft, upd }: { page: PageDoc; state: ProjectState; draft: boolean; upd: (patch: Record<string, unknown>, label?: string) => void }) {
  // The structured data reads the whole website: it is worked out only while the Inspector shows.
  const shown = useStore((s) => s.dockOpen && s.rightTab === 'inspect');
  const subject = useMemo<SeoSubject>(() => ({ kind: 'page', pageId: page.id }), [page.id]);
  const { typed, on: typedOn } = useTypedSeo(subjectKey(subject));
  const { overlay, doc: seoDoc } = useDocumentPreview(state, subject, typed);
  const isHome = page.id === state.site.homePageId;
  // How a shared link to the page looks, and whose sharing image it carries.
  const sharing = sharingView(state, page);
  const base = publicUrl(state.site);
  const ownUrl = base ? base + routeUrl(page.route) : null;
  return (
    <>
      <SeoPreview state={state} subject={subject} overlay={overlay} typed={typed} doc={seoDoc} shown={shown} />
      <Field
        label="Browser title"
        hint={
          <>
            Leave empty to use “{isHome ? state.site.name : `${page.title} · ${state.site.name}`}”.
            <LengthMeter kind="title" doc={seoDoc} />
          </>
        }
      >
        <DraftInput id="page-seo-title" limit={TEXT_LIMITS.seoTitle} keep={`page:${page.id}:seoTitle`} keepWhile={pageAlive(page.id)} value={page.seo.title ?? ''} onDirty={typedOn.title} onCommit={(v) => upd({ seoTitle: v }, 'Change browser title')} />
      </Field>
      <Field
        label="Description"
        hint={
          <>
            Shown by search engines and link previews.
            <LengthMeter kind="description" doc={seoDoc} />
          </>
        }
      >
        <DraftInput id="page-seo-description" multiline limit={TEXT_LIMITS.pageDescription} keep={`page:${page.id}:description`} keepWhile={pageAlive(page.id)} value={page.seo.description ?? ''} placeholder={state.site.description || 'Describe this page'} onDirty={typedOn.description} onCommit={(v) => upd({ description: v }, 'Change page description')} />
      </Field>
      {/* The page's own choice, or the site's while it has none: the picker shows both, and Use the site’s image returns to it. */}
      <div className="col" style={{ gap: 4 }} data-seo-field="socialImage">
        <ImageEditor
          title="Sharing image"
          value={{ assetId: page.seo.socialImage || null, alt: '' }}
          state={state}
          picture={sharing.picker}
          onChange={(v) => upd({ socialImage: v.assetId }, v.assetId ? 'Change sharing image' : sharing.picker.inherited ? 'Use the site’s sharing image' : 'Remove sharing image')}
        />
        <div className="field-hint">{sharing.imageNote}</div>
        <button type="button" className="insp-mini" style={{ alignSelf: 'flex-start', marginLeft: -6 }} onClick={() => openSiteSharing('socialImage')}>
          Change the site’s sharing image
        </button>
      </div>
      <SwitchRow
        id="page-seo-noindex"
        checked={!!page.seo.noindex}
        onChange={(v) => upd({ noindex: v })}
        label="Hide from search engines"
        hint={
          draft
            ? 'Once published, search engines are asked not to list it. Anyone with the address can still open it.'
            : 'Search engines are asked not to list it. Anyone with the address can still open it.'
        }
      />
      <SwitchRow checked={!!page.seo.searchHidden} onChange={(v) => upd({ searchHidden: v })} label="Hide from site search" hint={draft ? 'Once published, leaves this page out of the site’s own Site search results.' : 'Leaves this page out of the site’s own Site search results.'} />
      <CanonicalUrlField id="page-seo-canonical" value={page.seo.canonical} ownUrl={ownUrl} what="page" onTyped={typedOn.canonical} onCommit={(url) => upd({ canonical: url }, url ? 'Change canonical URL' : 'Clear canonical URL')} />
      <RevisionDateField
        id="page-seo-updated"
        label="Last revised"
        hint="When the page’s content last changed, for the sitemap. Leave empty to give no date."
        value={page.updatedAt}
        onSet={(v) => upd({ updatedAt: v }, 'Change revision date')}
        onClear={() => upd({ updatedAt: null }, 'Clear revision date')}
      />
    </>
  );
}

function PageSettings({ page, state }: { page: PageDoc; state: ProjectState }) {
  const previewing = useStore((s) => s.mode === 'preview');
  const dev = useStore((s) => !!s.settings?.developerMode);
  const [titleError, setTitleError] = useState<string | null>(null);
  if (!page) return null;
  // History says which page each setting was changed on: "Change browser title (About)".
  const upd = (patch: Record<string, unknown>, label = 'Update page settings') => void applyOps([{ type: 'page.update', pageId: page.id, ...patch } as EditOperation], `${label} (${page.title})`);
  const isHome = page.id === state.site.homePageId;
  const draft = isDraftPage(state, page);
  const inside = pagesWithin(state.pages, page.id);
  return (
    <div className="panel-body insp">
      <Header title={page.title} kind={`${isHome ? 'Home page' : draft ? 'Draft page' : 'Page'} · ${isHome ? '/' : page.route}`} icon={isHome ? <House /> : <FileText />}>
        {previewing ? (
          <Scope
            tone="local"
            icon={<Eye />}
            aside={
              // The button goes with Preview, so focus moves on to the page's name.
              <span className="insp-mini-row">
                <button
                  className="insp-mini"
                  onClick={() => {
                    setMode('edit');
                    focusName();
                  }}
                >
                  Back to Edit
                </button>
              </span>
            }
          >
            <strong>Previewing.</strong> Page settings stay editable.
          </Scope>
        ) : (
          <Scope tone="local" icon={<MousePointerClick />}>
            Page settings. Select anything on the page to edit it.
          </Scope>
        )}
      </Header>
      <Section title="Page" id="page-basic" level={LEVEL}>
        <Field label="Title" error={titleError}>
          <DraftInput
            value={page.title}
            limit={TEXT_LIMITS.pageTitle}
            keep={`page:${page.id}:title`}
            keepWhile={pageAlive(page.id)}
            onCommit={(v) => {
              if (!v.trim()) {
                setTitleError(`A page needs a title. Kept “${page.title}”.`);
                return false;
              }
              setTitleError(null);
              // The labels that still say the old title are offered alongside once the rename is saved.
              void renamePage(page.id, page.title, v.trim());
            }}
          />
        </Field>
        <Field label="Address" hint={isHome ? 'The home page is always at /.' : `Links to this page update automatically when you change it, and its old address keeps working.${inside.length ? ` The ${inside.length === 1 ? 'page' : `${inside.length} pages`} inside it move${inside.length === 1 ? 's' : ''} with it.` : ''}`}>
          {isHome ? <input className="input" value="/" readOnly aria-label="Page address" /> : <DraftInput value={page.route} onCommit={(v) => upd({ route: v }, 'Change page address')} ariaLabel="Page address" />}
        </Field>
        {!isHome && <PageLocation page={page} state={state} />}
        {/* The Home page is the website's front door: it is always published. */}
        {!isHome && (
          <SwitchRow
            checked={draft}
            onChange={(v) => upd({ draft: v }, v ? 'Keep page as draft' : 'Publish page')}
            label="Keep as draft"
            hint={
              draft
                ? 'Left out of the exported website. You can still edit and preview it.'
                : 'Keep working on this page without publishing it. The website export leaves drafts out.'
            }
          />
        )}
      </Section>
      {/* Settings most pages leave alone sit closed, each heading saying where it stands, so Search & sharing is in reach. */}
      <ArticleSettings page={page} draft={draft} upd={upd} />
      <PageLanguage page={page} state={state} />
      <Section title="Header & footer" id="page-shell" level={LEVEL} defaultOpen={false} scope={shellSummary(showsPart(page, 'header'), showsPart(page, 'footer'))}>
        <SwitchRow checked={showsPart(page, 'header')} onChange={(v) => upd({ showHeader: v }, v ? 'Show shared header on page' : 'Hide shared header on page')} label="Show shared header" />
        <SwitchRow checked={showsPart(page, 'footer')} onChange={(v) => upd({ showFooter: v }, v ? 'Show shared footer on page' : 'Hide shared footer on page')} label="Show shared footer" />
        <p className="insp-note field-hint">For this page only; other pages keep their own choice. Editing the header or footer changes it on every page that shows it.</p>
      </Section>
      <Section title="Search & sharing" id="page-seo" level={LEVEL} scope={searchSummary(page)}>
        <PageSearchSettings page={page} state={state} draft={draft} upd={upd} />
      </Section>
      {/* What the page is for search engines: a service, product, event or guide of the publisher's, with its facts. */}
      <Section title="Structured data" id="page-structured-data" level={LEVEL} defaultOpen={false} keepMounted scope={structuredSummary(page)}>
        <StructuredDataFields page={page} upd={upd} />
      </Section>
      {dev && (
        <Section title="Advanced" id="page-adv" defaultOpen={false} level={LEVEL}>
          <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setState({ modal: { kind: 'page-source', pageId: page.id } })}>
            <FileCode2 /> View generated source
          </button>
          <p className="mono faint insp-note" style={{ userSelect: 'text' }}>
            {page.id}
          </p>
        </Section>
      )}
      <button className="insp-goto" onClick={() => setState({ rightTab: 'styles' })}>
        <span className="insp-kind local" aria-hidden="true">
          <Palette />
        </span>
        <span className="grow">
          <strong>Site styles</strong>
          <span>Colors, fonts and spacing for every page</span>
        </span>
        <ChevronRight aria-hidden="true" className="chev" />
      </button>
    </div>
  );
}

/**
 * The Inspector while the Posts workspace is in front (#578): the post being written or previewed, or where a visitor
 * went on to from its preview. The page under the writer, its sections and its settings stay out of reach until it
 * shows again, so nothing changed here lands on it. The post's own details are edited in the writer.
 */
/** While the SEO view covers the canvas (#700): the document it has chosen, and that nothing here changes the page under it. */
function SeoOverview({ state }: { state: ProjectState }) {
  const subject = useStore((s) => s.seoSubject);
  const doc = seoDocument(state, subject);
  const kind = !doc ? 'Nothing chosen' : doc.subject.kind === 'page' ? (doc.draft ? 'Draft page' : 'Page') : doc.draft ? 'Draft post' : 'Published post';
  return (
    <div className="panel-body insp" key={`seo:${doc?.key ?? ''}`}>
      <Header title={doc?.title ?? 'SEO'} kind={kind} icon={<Search />} />
      <div className="insp-empty">
        <Search aria-hidden="true" />
        <p>{doc ? `The SEO view shows ${doc.subject.kind === 'page' ? 'this page' : 'this post'} in the canvas’s place. Nothing here changes the page under it.` : 'Choose a page or post in the SEO list. The SEO view covers the canvas, and nothing here changes the page under it.'}</p>
      </div>
    </div>
  );
}

function PostOverview({ state, workspace }: { state: ProjectState; workspace: 'write' | 'preview' }) {
  const post = useStore((s) => s.post);
  const at = useStore((s) => s.postPreviewAt);
  const shown = postShown(state, workspace, post, at);
  const opened = postAt(state, post);
  const openedTitle = opened ? `“${opened.title || 'Untitled'}”` : 'the post';
  // The writer shows again even when the sidebar was hidden or showed another panel during the preview.
  const back = (
    <button className="btn btn-sm" onClick={() => setState({ postView: 'write', leftTab: 'posts' })}>
      <ArrowLeft aria-hidden="true" /> Back to writing
    </button>
  );
  const key = `post:${workspace}:${post?.collectionId ?? ''}:${post?.entryId ?? ''}`;
  if (shown.kind === 'post' && !shown.ref)
    return (
      <div className="panel-body insp" key={key}>
        <Header title="Posts" kind="No post open" icon={<Newspaper />} />
        <div className="insp-empty">
          <Newspaper aria-hidden="true" />
          <p>Choose a post in the list, or start a new one. A post’s text and details are edited in the writer.</p>
        </div>
      </div>
    );
  if (shown.kind === 'post') {
    const other = workspace === 'preview' && !!post && (shown.ref!.entryId !== post.entryId || shown.ref!.collectionId !== post.collectionId);
    return (
      <div className="panel-body insp" key={key}>
        <Header title={shown.title} kind={`${shown.draft ? 'Draft post' : 'Published post'}${workspace === 'preview' ? ' · preview' : ''}`} icon={<Newspaper />} actions={workspace === 'preview' ? back : undefined} />
        <div className="insp-empty">
          <Newspaper aria-hidden="true" />
          <p>
            {workspace === 'write'
              ? 'Its text, address, date, author, excerpt and featured image are edited in the writer. Nothing here changes a page.'
              : other
                ? `A visitor’s link went on from ${openedTitle}. Back to writing returns to it.`
                : 'Showing the post as visitors see it. Back to writing to change it.'}
          </p>
        </div>
      </div>
    );
  }
  const page = shown.kind === 'page' && Object.hasOwn(state.pages, shown.pageId) ? state.pages[shown.pageId] : undefined;
  const home = !!page && page.id === state.site.homePageId;
  return (
    <div className="panel-body insp" key={key}>
      <Header title={page ? page.title : shown.kind === 'address' ? shown.path : ''} kind={page ? (home ? 'Home page · preview' : 'Page · preview') : 'Preview'} icon={home ? <House /> : page ? <FileText /> : <Eye />} actions={back} />
      <div className="insp-empty">
        <Eye aria-hidden="true" />
        <p>A visitor’s link went on from {openedTitle}. Back to writing returns to it; pages are changed once the preview ends.</p>
      </div>
    </div>
  );
}

/** A collection's layout with nothing selected: whose layout it is, what it changes, the entry it is shown on, and Done. */
function LayoutOverview({ state, collectionId, entryId }: { state: ProjectState; collectionId: string; entryId: string | null }) {
  const c = state.collections[collectionId];
  const samples = sampleEntries(state, collectionId);
  return (
    <>
      <Header
        title={`${c.settings.name} layout`}
        kind="Collection layout"
        tone="shared"
        icon={<FileText />}
        actions={
          <button className="btn btn-sm" onClick={() => setState({ templateMode: null, selection: null })}>
            Done
          </button>
        }
      >
        <OwnerScope owner={{ kind: 'template', id: collectionId }} state={state} />
      </Header>
      <div className="insp-empty">
        <MousePointerClick aria-hidden="true" />
        <p>Every entry of {c.settings.name} is shown with this layout, each with its own title, text, pictures and details. Click part of it on the page, or in Layers, to change it for all of them.</p>
      </div>
      {samples.length > 0 && (
        <Section title="Preview" id="layout-preview" level={LEVEL}>
          <Field label="Shown on" hint="The layout with this entry’s words and pictures. Switch to see it with another." controlId="layout-sample">
            <select id="layout-sample" className="select" value={entryId ?? ''} onChange={(e) => setState({ templateMode: { collectionId, entryId: e.target.value } })}>
              {samples.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title || e.slug}
                  {e.draft !== false ? ' (draft)' : ''}
                </option>
              ))}
            </select>
          </Field>
        </Section>
      )}
    </>
  );
}

