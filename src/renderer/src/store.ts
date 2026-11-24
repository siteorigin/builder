import { create } from 'zustand';
import type { AiEvent, AppSettings, ChatContext, ChatEditScope, ChatMessage, ChatMode, Conversation, ImportReviewRow, LocalWorkspaceState, PostImportPreview, PackRefusal, ProjectSnapshot, ProviderStatus, RunStatus, RuntimeState } from '@shared/api';
import type { ApplyResult, EditOperation } from '@shared/ops';
import { refKey, type ElementRef, type OwnerRef, type ResponsiveScope } from '@shared/types';
import type { SampleContactKind } from '@shared/sample-contact';
import { isAssetSort, type AssetSort } from '@shared/asset-order';
import { attachImage, chatStatePatch, draftFor, imagesFor, withDraft, type ChatDrafts, type ChatImages } from './lib/chatDrafts';
import { PANEL_DEFAULTS } from './lib/layout';
import { draftCount, HELD_DRAFT, refusedDraftCount, setDraft, trackApply, type ApplyOutcome } from './lib/pending';
import { checkHeld, fieldKey, placeOf, readFields, shownField, tableRowNameEdit, typedText, whereOf } from './lib/held';
import type { RevealedItem } from './lib/reveal';
import type { StyleCopy } from './lib/style-copy';
import type { LayerSet } from './lib/layer-set';
import type { PostRef } from './lib/posts';
import { notePlace, type PagePlaces } from './lib/page-place';
import type { TemplateMode } from './lib/template-view';
import type { DefinitionMode } from './lib/studio';
import type { ChatFocusRequest } from './lib/page-start';

export const api = window.builder;

export type LeftTab = 'pages' | 'posts' | 'layers' | 'insert' | 'assets';
export type { PostRef };
export type RightTab = 'inspect' | 'chat' | 'styles';
export type Modal = null | { kind: 'settings'; tab?: string } | { kind: 'export' } | { kind: 'source'; definitionId: string } | { kind: 'page-source'; pageId: string } | { kind: 'cmdk' } | { kind: 'find'; query?: string; sample?: SampleContactKind } | { kind: 'create-component'; ref: ElementRef } | { kind: 'make-unique'; owner: OwnerRef; nodeId: string; definitionId: string } | { kind: 'rename-component'; definitionId: string } | { kind: 'delete-page'; pageId: string } | { kind: 'set-home'; pageId: string } | { kind: 'history'; entryId?: string; tab?: 'versions'; review?: boolean } | { kind: 'new-code' } | { kind: 'new-component' } | { kind: 'edit-definition'; ref: ElementRef } | { kind: 'health'; section?: 'seo' } | { kind: 'import-review'; id: number; opening: string; rows: ImportReviewRow[] } | { kind: 'post-import'; opening: string; preview: PostImportPreview } | { kind: 'paste-style'; ref: ElementRef; opening: string };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A typed edit that could not be saved as it was made: typed while the AI was working, or into a field that
 * changed somewhere else while it was typed (`cause: 'elsewhere'`). It is kept until the author applies or
 * discards it.
 * waiting: the AI is (or was) working; the author can stop it and apply the edit.
 * applying: the AI is being stopped and the edit is applied once its changes are undone.
 * changed: a field it writes holds something else now (shown in `current`); the author decides.
 * gone: what it was for no longer exists. failed: the project refused it (`note` says why).
 */
export interface HeldEdit {
  id: number;
  /** The fields it writes: a newer edit of the same fields replaces it. */
  key: string;
  /** The opening of the project it was made in (its snapshot's workspaceKey). */
  workspace: string;
  operations: EditOperation[];
  label: string;
  /** What each field held when the author made the edit. */
  base: unknown[];
  /** Where the edit is (a page title, "Header"), for the author. */
  place: string;
  /** What the author typed, when it is plain text. */
  text: string | null;
  phase: 'waiting' | 'applying' | 'changed' | 'gone' | 'failed';
  /** Commit order: a newer commit of the same fields replaces it, never an older one. */
  seq: number;
  /** While applying: the AI is being stopped first. */
  stopping?: boolean;
  /** While applying: the save is on its way and can no longer be called back. */
  writing?: boolean;
  /** For "changed": what the fields hold now; checked again before the author's edit replaces it. */
  current?: unknown[];
  currentText?: string | null;
  /** For "gone": what no longer exists. For "failed" or "waiting": why. */
  note?: string;
  /** The handoff in progress; a reply for any other is ignored. */
  attempt?: number;
  /**
   * elsewhere: not typed while the AI was working, but into a field that changed somewhere else (a file edited
   * outside the app, say) while the author typed. Absent: typed while the AI was working.
   */
  cause?: 'elsewhere';
  /** For a page rename: the labels to offer once it is saved (see renamePage). Discarding the edit drops them. */
  rename?: PendingRename;
}

/**
 * How the last AI request ended, for the toolbar: `run` is its final status (null when a held edit was
 * applied after the request had already ended), `edit` what happened to a held edit applied after it.
 */
export interface AiOutcome {
  run: RunStatus | null;
  /** The request `run` is the ending of. */
  runId?: string;
  edit?: 'saved' | 'held';
}

/**
 * A page renamed by the author, once the rename is saved: the offer to bring the labels visitors read (its heading,
 * its menu links) along from `from` to the page's title. Shown while the page is still called `to`; what it offers is
 * read from the project as it is then, and it ends once there is nothing left to offer.
 */
export interface RenameOffer {
  /** The opening of the project it was made in (its snapshot's workspaceKey). */
  opening: string;
  pageId: string;
  from: string;
  to: string;
  /** The project's revision once the rename was saved: a snapshot older than that does not show it yet. */
  revision: number;
  /** A title the rename replaced that was not `from`: one changed elsewhere while the author typed. Its labels are old too. */
  also?: string;
}

/** A rename on its way, for the edit to carry if it is held (see renamePage): its offer, before it is saved. */
type PendingRename = Omit<RenameOffer, 'revision'>;

/** Counts AI activity (every status the AI reports). An edit typed while it changed knows the AI ran meanwhile. */
let aiEpoch = 0;
export const aiActivity = () => aiEpoch;

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void; undoes?: UndoTarget };
}

/** One committed change, in the opening of the project it was made in (see `undoAction`). */
export interface UndoTarget {
  entryId: string;
  workspaceKey: string;
  /** The revision the change produced: a snapshot older than this has not heard of the entry yet. */
  revision: number;
}

export interface State {
  screen: 'welcome' | 'editor';
  /** Theme packs found at startup but refused, and where a person installs packs. */
  packs: { refused: PackRefusal[]; userDir: string };
  snapshot: ProjectSnapshot | null;
  runtime: RuntimeState;
  settings: AppSettings | null;
  providers: ProviderStatus[];
  pageId: string | null;
  /** The post open in the Posts workspace (shown while the Posts panel is), kept while other panels are. */
  post: PostRef | null;
  /** Whether the Posts workspace shows its writer, or the post on the canvas as visitors see it. */
  postView: 'write' | 'preview';
  /**
   * While the open post is previewed: the address the canvas last reported, a page or another post when a visitor's
   * link went on from the post; null until it reports (the post is on its way). Never saved (see lib/posts postShown).
   */
  postPreviewAt: string | null;
  /** A picture of the open post's text to bring into view once the writer shows it (Show in Assets). */
  postReveal: { entryId: string; picture: number; seq: number } | null;
  selection: ElementRef | null;
  /** Sibling layers selected in Layers together with `selection`, which is always one of them (lib/layer-set). */
  layerSet: LayerSet | null;
  /** The element last selected on each page, resumed when the page is opened again (lib/page-place). Never in the site. */
  pagePlaces: PagePlaces;
  /**
   * What was selected when Preview was entered, on which page, at which revision and in which component edited
   * everywhere: Edit selects it again when the visitor stayed where they were. A visitor's link, Back or Forward lets
   * it go (see Canvas), and so does opening a page.
   */
  previewReturn: { pageId: string; ref: ElementRef; revision: number; definitionId: string | null } | null;
  hover: ElementRef | null;
  viewport: number;
  zoom: number | 'fit';
  mode: 'edit' | 'preview';
  leftTab: LeftTab | null;
  /** What the Layers panel shows for a page: its layers, or the outline of the headings it renders. */
  layersView: 'layers' | 'outline';
  rightTab: RightTab;
  /** The preview page itself has loaded and connected (not just the website tools). */
  frameReady: boolean;
  /** Fields holding typed text that is not committed yet (the toolbar says "Editing…" rather than "Saved"). */
  drafting: number;
  /** Of those, fields whose text was refused as too long to save: kept for the author to shorten. */
  refusedDrafts: number;
  /** Bumped when text refused somewhere else (an inline rename) is handed to a page's settings: they show it afresh. */
  keptHandoff: number;
  /** The project is about to close (pending edits are saved): the editor takes no more input. */
  leaving: boolean;
  /** A problem the preview page itself reported (a component that failed to render), in plain words. */
  previewIssue: string | null;
  /** Whether the right dock (Inspector / AI / Site styles) is shown. */
  dockOpen: boolean;
  /** The widths the panels were given (lib/layout fits them to the window when it is too small for both). */
  leftWidth: number;
  rightWidth: number;
  styleScope: ResponsiveScope;
  /** `revealed`: the list item open in the inspector, outlined on the page (see revealedItem). */
  rects: { selected: Rect[]; hovered: Rect[]; revealed: Rect[] };
  /** The list item open in the inspector, revealed on the page while it is edited. Never saved. */
  revealedItem: RevealedItem | null;
  /** Bumped when a Layers row asks for its layer to be shown on the page, even one already selected (see showLayer). */
  showSelection: number;
  pendingSave: number;
  modal: Modal;
  toasts: Toast[];
  /** Definition editing mode: the project-owned definition being edited, and in Component Studio how it is shown. */
  definitionMode: DefinitionMode;
  /**
   * A collection's layout being edited on the canvas, shown on one of its entries (lib/template-view). The page that
   * was open stays `pageId`, shown again when the layout is closed; opening a page closes it.
   */
  templateMode: TemplateMode | null;
  /**
   * While editing a component everywhere: the variant option its Style section styles, across the layers the author
   * selects; the base design when null or when it names another component or an option that no longer exists.
   */
  variantStyle: { definitionId: string; axis: string; variant: string } | null;
  conversation: Conversation | null;
  runStatus: RunStatus | null;
  activeRunId: string | null;
  /** What kind of request is running, while `runStatus` is set: a question never holds the project. */
  runMode: ChatMode | null;
  /** Unsent messages per conversation of the open project (see lib/chatDrafts). */
  chatDrafts: ChatDrafts;
  /** Library images attached to those unsent messages, by asset ID (see lib/chatDrafts). */
  chatImages: ChatImages;
  /**
   * A request another part of the editor asked the chat to send (Create component's Build with AI). `held` once it
   * waits for the author to send it from the chat, or while it is being sent.
   */
  chatRequest: { id: string; text: string; context: ChatContext; workspaceKey: string; held?: boolean } | null;
  /** What the next message is about: the open page (or Home), and how far an edit may reach (see chatTarget.editScope). */
  chatContextEnabled: { page: boolean; scope: ChatEditScope };
  /** What the next message is: a change for the AI to make, or a read-only question. */
  chatMode: ChatMode;
  /**
   * Write with AI asked for the message box, for the page it was asked on in this opening of the project: Chat puts
   * focus there once it shows (a provider that is still loading can swap the box in late), then lets the request go.
   */
  chatFocus: ChatFocusRequest | null;
  /** Sample contact details the author chose to publish as they are, so the export stops reviewing them. */
  keptSamples: string[];
  /** A field to bring into view and focus once its component shows in the Inspector ("Open in inspector"). */
  inspectorFocus: InspectorFocus | null;
  /** Typed edits made while the AI was working (see HeldEdit). */
  heldEdits: HeldEdit[];
  aiOutcome: AiOutcome | null;
  /** How library images are listed, in Assets and in every image picker (see setAssetSort). */
  assetSort: AssetSort;
  /** What Copy style took, for Paste style in the same opening of the project (`opening`). Never saved. */
  styleCopy: (StyleCopy & { opening: string }) | null;
  /** The labels a rename left behind, offered until the author updates or keeps them. Never saved. */
  renameOffer: RenameOffer | null;
  /** What Copy last took and the project still holds, for the menus that offer Paste (kept by lib/clipboard). Never saved. */
  copyNote: { opening: string; label: string; count: number } | null;
  setState: (p: Partial<State>) => void;
}

/** The image order is this person's choice on this computer, kept across projects and restarts. */
const ASSET_SORT_KEY = 'siteorigin.assetSort';
function savedAssetSort(): AssetSort {
  try {
    const v = globalThis.localStorage?.getItem(ASSET_SORT_KEY);
    return isAssetSort(v) ? v : 'newest';
  } catch {
    return 'newest';
  }
}

/**
 * A selection made anywhere but Layers' own Shift and Cmd/Ctrl picks (a canvas click, a crumb, a plain row click,
 * even of the same layer) selects that one layer, so the layers picked with it are let go.
 */
const oneSelection = (p: Partial<State>): Partial<State> => ('selection' in p && !('layerSet' in p) ? { ...p, layerSet: null } : p);
/** Opening a page, or editing a component everywhere, closes a collection's layout: the canvas shows one thing. */
const oneView = (p: Partial<State>): Partial<State> => {
  const s = useStore.getState();
  if ('templateMode' in p || !s.templateMode) return p;
  if (!(('pageId' in p && p.pageId !== s.pageId) || p.definitionMode)) return p;
  // What was selected in the layout goes with it: nothing is ever acted on that the canvas no longer shows.
  const selection = 'selection' in p ? p.selection : s.selection;
  return { ...p, templateMode: null, ...(selection?.owner.kind === 'template' ? { selection: null } : {}) };
};

export const useStore = create<State>((set) => ({
  screen: 'welcome',
  packs: { refused: [], userDir: '' },
  snapshot: null,
  runtime: { state: 'idle' },
  settings: null,
  providers: [],
  pageId: null,
  post: null,
  postView: 'write',
  postPreviewAt: null,
  postReveal: null,
  selection: null,
  layerSet: null,
  pagePlaces: {},
  previewReturn: null,
  hover: null,
  viewport: 1280,
  zoom: 'fit',
  mode: 'edit',
  leftTab: 'pages',
  layersView: 'layers',
  rightTab: 'inspect',
  frameReady: false,
  drafting: 0,
  refusedDrafts: 0,
  keptHandoff: 0,
  leaving: false,
  previewIssue: null,
  dockOpen: true,
  leftWidth: PANEL_DEFAULTS.left,
  rightWidth: PANEL_DEFAULTS.right,
  styleScope: 'base',
  rects: { selected: [], hovered: [], revealed: [] },
  revealedItem: null,
  showSelection: 0,
  pendingSave: 0,
  modal: null,
  toasts: [],
  definitionMode: null,
  templateMode: null,
  variantStyle: null,
  conversation: null,
  runStatus: null,
  activeRunId: null,
  runMode: null,
  chatDrafts: {},
  chatImages: {},
  chatRequest: null,
  chatContextEnabled: { page: true, scope: 'selection' },
  chatMode: 'edit',
  chatFocus: null,
  keptSamples: [],
  inspectorFocus: null,
  heldEdits: [],
  aiOutcome: null,
  assetSort: savedAssetSort(),
  styleCopy: null,
  renameOffer: null,
  copyNote: null,
  setState: (p) => set(oneSelection(p))
}));

/** Lists images in this order everywhere at once, and remembers it where storage allows. */
export function setAssetSort(sort: AssetSort) {
  useStore.setState({ assetSort: sort });
  try {
    globalThis.localStorage?.setItem(ASSET_SORT_KEY, sort);
  } catch {
    // Not remembered: the order still holds until the editor closes.
  }
}

/**
 * One request to focus a content field, taken by the Inspector of the component named. `opening` is the
 * project opening it was made in, and a request that no Inspector took soon after is dropped.
 */
export interface InspectorFocus {
  seq: number;
  at: number;
  opening: string;
  owner: OwnerRef;
  nodeId: string;
  prop: string;
  itemId?: string;
  field?: string;
  /** The field's label, to say it has gone. */
  label: string;
}

let focusSeq = 0;
/** A new request to focus a content field (see InspectorFocus), numbered apart from every earlier one. */
export const inspectorFocusRequest = (f: Omit<InspectorFocus, 'seq' | 'at'>): InspectorFocus => ({ ...f, seq: ++focusSeq, at: Date.now() });

/** The status of a request that may change the site; a read-only question is not one. */
export const editRunStatus = (s: Pick<State, 'runStatus' | 'runMode'>) => (s.runMode === 'ask' ? null : s.runStatus);

export const getState = () => useStore.getState();
export const setState = (p: Partial<State>) => useStore.setState(oneSelection(scopeFollows(oneView(p))));

/**
 * What the next AI message may change starts again from the selected element (or, with none, the page) whenever what
 * the editor shows changes: another page, a component edited everywhere or not, another element or none. A choice
 * made for one view never carries into the next. An update that says its own scope ("Edit and try again", Ask AI
 * about this) keeps it.
 */
function scopeFollows(p: Partial<State>): Partial<State> {
  if (p.chatContextEnabled) return p;
  const s = useStore.getState();
  if (s.chatContextEnabled.scope === 'selection') return p;
  const key = (r: ElementRef | null | undefined) => (r ? refKey(r) : null);
  const moved =
    ('pageId' in p && p.pageId !== s.pageId) ||
    ('definitionMode' in p && (p.definitionMode?.definitionId ?? null) !== (s.definitionMode?.definitionId ?? null)) ||
    ('templateMode' in p && (p.templateMode?.collectionId ?? null) !== (s.templateMode?.collectionId ?? null)) ||
    ('selection' in p && key(p.selection) !== key(s.selection));
  return moved ? { ...p, chatContextEnabled: { ...s.chatContextEnabled, scope: 'selection' } } : p;
}

/** Selects one layer from Layers and scrolls the page to it, also when it is selected already and has scrolled away. */
export function showLayer(ref: ElementRef) {
  setState({ selection: ref, showSelection: getState().showSelection + 1 });
}

/** Save workspace state (open page, viewport, tabs) to the project that is open now. */
export function saveLocal(state: LocalWorkspaceState) {
  const key = getState().snapshot?.workspaceKey;
  if (key) void api.project.saveLocalState(state, key);
}

/** Show the preview at `width` and remember it for this project, wherever the width was chosen. */
export function setViewport(width: number) {
  setState({ viewport: width });
  saveLocal({ viewport: width });
}

/** Follow an Undo or Redo like an edit, so Save (and leaving) waits for it and hears if it failed. One refused
 *  before writing anything (nothing left to undo) is no failure. */
export function trackHistory<T extends ApplyResult | null | undefined>(run: Promise<T>): Promise<T> {
  trackApply(run.then((r) => ({ ok: !r || r.ok || r.error?.code === 'INVALID_ARGUMENT', message: r?.error?.message })));
  return run;
}

/** Undo or redo the project, from any button, shortcut or menu. A failure is said at once. */
export function projectHistory(action: 'undo' | 'redo') {
  void trackHistory(action === 'redo' ? api.project.redo() : api.project.undo()).then(
    (r) => r && !r.ok && r.error && toast(r.error.message, 'error'),
    (e: unknown) => toast(errorText(e), 'error')
  );
}

/**
 * Step History to an entry chosen in it, `count` changes away (api.project.stepHistory), followed like an Undo. It
 * goes only as far as History stood in `snap`: once History has moved on it is refused, for the author to choose again.
 */
export function stepHistory(entryId: string, direction: 'undo' | 'redo', count: number, snap: ProjectSnapshot): Promise<ApplyResult> {
  return trackHistory(api.project.stepHistory(entryId, direction, { revision: snap.revision, count }, snap.workspaceKey));
}

/**
 * Undo an AI turn on its own as reviewed in History (issue 164), followed like an Undo. Refused once the project has
 * moved on from the revision the review was worked out at, for the author to look again.
 */
export function revertAiTurn(entryId: string, revision: number, snap: ProjectSnapshot): Promise<ApplyResult> {
  return trackHistory(api.project.revertAiTurn(entryId, { revision }, snap.workspaceKey));
}

/** Zoom the preview and remember it for this project. */
export function setZoom(zoom: number | 'fit') {
  setState({ zoom });
  saveLocal({ zoom });
}

/** The unsent message of the open conversation. */
export const selectChatDraft = (s: State) => draftFor(s.chatDrafts, s.conversation?.id);

/** Set the unsent message of one conversation (an edit while no conversation is shown has nowhere to go). */
export function setChatDraft(conversationId: string | null | undefined, text: string) {
  if (!conversationId) return;
  const drafts = getState().chatDrafts;
  const next = withDraft(drafts, conversationId, text);
  if (next !== drafts) setState({ chatDrafts: next });
}

/** The images attached to the open conversation's unsent message. */
export const selectChatImages = (s: State) => imagesFor(s.chatImages, s.conversation?.id);

/**
 * Attach a library image to the AI message being written, and show it there. It goes to the open conversation of
 * the project it was chosen in; while a question waits, the message (and its images) waits beside it.
 */
export function attachToChat(opening: string, assetId: string) {
  const s = getState();
  if (s.snapshot?.workspaceKey !== opening) return;
  const asset = s.snapshot.state.assets.assets[assetId];
  if (asset?.kind !== 'image') return toast('That image is no longer in Assets.', 'info');
  if (!s.conversation) return toast('The AI conversation is still loading. Try again in a moment.', 'info');
  const r = attachImage(s.chatImages, s.conversation.id, assetId);
  if (r.outcome === 'full') toast('A message can carry up to 4 images. Remove one from the message first.', 'info');
  else if (r.outcome === 'already') toast(`${(typeof asset.name === 'string' && asset.name.trim()) || 'This image'} is already in your message.`, 'info');
  setState({ chatImages: r.images, rightTab: 'chat', dockOpen: true });
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());
}

/** Save drafts and the open conversation to the project they belong to, as they change. */
export function persistChatState(s: State, prev: State) {
  const out = chatStatePatch(
    { key: prev.snapshot?.workspaceKey ?? null, drafts: prev.chatDrafts, images: prev.chatImages, conversationId: prev.conversation?.id ?? null },
    { key: s.snapshot?.workspaceKey ?? null, drafts: s.chatDrafts, images: s.chatImages, conversationId: s.conversation?.id ?? null }
  );
  if (out) void api.project.saveLocalState(out.patch, out.key);
}

/**
 * Remember the element selected on each page as the author selects it (lib/page-place), and save the places to the
 * opening they belong to, as they change. A new opening brings its own, which are not saved back.
 */
export function persistPlaces(s: State, prev: State) {
  const places = notePlace(prev, s);
  if (places !== s.pagePlaces) return setState({ pagePlaces: places });
  const key = s.snapshot?.workspaceKey;
  // The page the author is working on is saved with it: a page a visitor's link opened becomes the one to reopen at
  // once the author works there.
  if (key && s.pagePlaces !== prev.pagePlaces && key === prev.snapshot?.workspaceKey) void api.project.saveLocalState({ pagePlaces: s.pagePlaces, ...(s.pageId ? { pageId: s.pageId } : {}) }, key);
}

/** The readable part of an error from the main process (Electron prefixes rejected IPC calls). */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
  const id = ++toastId;
  setState({ toasts: [...getState().toasts, { id, text, kind, action }] });
  setTimeout(() => setState({ toasts: getState().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 4000);
}

/** Options for a typed edit (see commitDraft). */
interface DraftOptions {
  check?: boolean;
  shown?: string;
  review?: boolean;
}

/** The typed edit being committed (see commitDraft). */
let draft: ({ base: ProjectSnapshot | null; text: string | null } & DraftOptions) | null = null;

/**
 * Commit a typed edit: `commit` calls applyOps. `base` is the project as the author saw it when editing
 * began and `text` what was typed. Only edits committed this way are held while the AI works (gestures
 * are not): one held is checked against `base` before it is applied. `check` says the AI ran while the
 * author typed: the edit is then never applied blindly, but held and checked, at once when the AI is idle.
 * Otherwise it is written only while each field it writes still holds what it held in `base` (see
 * writeTyped). `review` says the author typed over something other than `base` holds (the page had not
 * caught up), so the edit waits for them to look at the field, unless it holds just `shown`, the text
 * they typed over.
 */
export function commitDraft<T>(base: ProjectSnapshot | null, commit: () => T, text: string | null = null, opts: DraftOptions = {}): T {
  const prev = draft;
  draft = { base, text, ...opts, check: !!opts.check };
  try {
    return commit();
  } finally {
    draft = prev;
  }
}

/** Orders commits, so a late reply for an older one never replaces a newer edit of the same field. */
let commitSeq = 0;
/** The newest commit of each field, by opening and field key, held or not, discarded or not. */
const newestCommit = new Map<string, number>();
const fieldOf = (workspace: string | undefined, operations: EditOperation[]) => `${workspace ?? ''}\n${fieldKey(operations)}`;

/** Edits a change needs first, saved in the same batch: a section's new ID before the link that jumps to it. */
export interface PendingEdit {
  operations: EditOperation[];
  /** The project revision the edits were planned against: the batch is refused if the project has moved on. */
  expectedRevision?: number;
  /** Its own undo step, never joined to the field's last edit: a formatting command, as opposed to typing. */
  separate?: boolean;
}

/**
 * Apply operations through the shared command service. Returns per-op results or null on failure. With
 * `expectedRevision`, the batch applies only to the project as it was at that revision.
 */
export async function applyOps(operations: EditOperation[], label: string, coalesceKey?: string, expectedRevision?: number): Promise<Array<Record<string, unknown>> | null> {
  const r = await commitOps(operations, label, coalesceKey, expectedRevision);
  return r ? (r.results ?? []) : null;
}

/**
 * Like `applyOps`, but returns the whole result: with the history entry the change made, for an Undo beside it.
 * `replanStale`: an edit planned against `expectedRevision` that finds the project has moved on is answered quietly,
 * with the refusal itself (`ok: false`), for the caller to plan again against the project's own copy.
 */
export async function commitOps(operations: EditOperation[], label: string, coalesceKey?: string, expectedRevision?: number, opts: { replanStale?: boolean } = {}): Promise<(ApplyResult & { workspaceKey: string }) | null> {
  // Asked for earlier and checked before it is applied (commitIfUnchanged), whose caller follows it until it lands.
  if (checked) return applyChecked(checked, operations, label, coalesceKey, expectedRevision);
  // Followed until it lands, so saving and leaving the project wait for it and hear if it failed.
  let landed!: (o: ApplyOutcome) => void;
  trackApply(new Promise<ApplyOutcome>((r) => (landed = r)));
  const s = getState();
  // A rename being committed goes with its typed edit, so whichever way that edit is held (now, when main answers
  // that the AI has just started, or because the title changed elsewhere) it carries the rename's offer.
  const typed = draft ? { base: draft.base ?? s.snapshot, text: draft.text, seq: ++commitSeq, check: !!draft.check, shown: draft.shown, review: !!draft.review, rename: renaming } : null;
  if (typed) newestCommit.set(fieldOf(typed.base?.workspaceKey, operations), typed.seq);
  if (s.snapshot?.aiBusy) {
    landed({ ok: false, message: refuseWhileAiBusy(typed, operations, label) });
    return null;
  }
  // Typed while the AI ran: checked against what the author saw before it is applied, never blindly.
  if (typed?.check && typed.base) {
    const held = holdEdit(typed.base, operations, label, { text: typed.text, seq: typed.seq, rename: typed.rename });
    if (held) {
      const id = held.id;
      if (id === null) landed({ ok: true });
      else void applyHeld(id).then(() => landed(heldById(id) ? { ok: false, message: HELD_MESSAGE } : { ok: true }));
      return null;
    }
  }
  // A typed edit is written only while each field it writes holds what it held when typing began.
  const guard = typed && !opts.replanStale ? typedGuard(typed.base, operations) : null;
  const workspaceKey = s.snapshot?.workspaceKey ?? '';
  setState({ pendingSave: s.pendingSave + 1 });
  try {
    let r: ApplyResult;
    if (guard && typed) {
      const kept = await writeTyped(guard, typed, operations, label, coalesceKey, expectedRevision);
      if (kept.held) {
        landed(kept.outcome);
        return null;
      }
      r = kept.result;
    }
    // Named by the opening of its project, so a change sent just as that project closes never lands in the next.
    else r = await api.project.apply(expectedRevision === undefined ? { operations } : { operations, expectedRevision }, { label, coalesceKey, opening: s.snapshot?.workspaceKey });
    if (!r.ok && opts.replanStale && r.error?.code === 'STALE_REVISION') {
      landed({ ok: true });
      return { ...r, workspaceKey };
    }
    if (!r.ok) {
      // The AI started between the last snapshot and this edit.
      const message =
        r.error?.code === 'BUSY' ? refuseWhileAiBusy(typed, operations, label) : r.error?.code === 'STALE_REVISION' ? 'The project changed while you were choosing. Choose again.' : (r.error?.message ?? 'That change could not be applied.');
      if (r.error?.code !== 'BUSY') toast(message, 'error');
      landed({ ok: false, message });
      return null;
    }
    landed({ ok: true });
    return { ...r, workspaceKey };
  } catch (e) {
    const message = `That change could not be saved${e instanceof Error && e.message ? `: ${e.message}` : '.'}`;
    toast(message, 'error');
    landed({ ok: false, message });
    return null;
  } finally {
    setState({ pendingSave: Math.max(0, getState().pendingSave - 1) });
  }
}

const HELD_MESSAGE = 'An edit you made has not been saved yet.';

/** The revision each field's latest typed save made, by opening and field (see writeTyped). */
const ownSaves = new Map<string, { revision: number; text: string | null }>();

/** A typed edit's fields as they were when typing began: what it is checked against before it is written. */
function typedGuard(base: ProjectSnapshot | null, operations: EditOperation[]): { base: ProjectSnapshot; before: unknown[] } | null {
  if (!base) return null;
  const reads = readFields(base.state, operations);
  // Not an edit of fields that can be read back: written as it is.
  if (!reads || reads.some((r) => !r.found)) return null;
  return { base, before: reads.map((r) => (r.found ? r.value : undefined)) };
}

/**
 * Write a typed edit only while every field it writes still holds what it held when the author began typing
 * (`guard.base`). The project may have moved on meanwhile (a file saved outside the app, say): a change to other
 * fields stays and the edit is written beside it, but a field that changed is never written over. The edit is
 * held instead, beside the newer value, for the author to replace it or not. Checked on this window's copy of the
 * project first, and on the project's own once that copy proves to be behind (the write is refused as stale, or the
 * file was saved outside the app before the app read it).
 */
async function writeTyped(
  guard: { base: ProjectSnapshot; before: unknown[] },
  typed: { text: string | null; seq: number; shown?: string; review: boolean; rename: PendingRename | null },
  operations: EditOperation[],
  label: string,
  coalesceKey: string | undefined,
  /** The revision the caller built the edit on (the image focus editor builds on the value it reads then): the edit
   *  applies only there, and a refusal is the caller's to answer. */
  expected?: number
): Promise<{ held: true; outcome: ApplyOutcome } | { held: false; result: ApplyResult }> {
  const { base, before } = guard;
  const hold = (opts: Parameters<typeof holdEdit>[3]): { held: true; outcome: ApplyOutcome } => {
    const held = holdEdit(base, operations, label, { text: typed.text, seq: typed.seq, cause: 'elsewhere', rename: typed.rename, ...opts });
    // Nothing to hold: the author has committed the same field again since.
    return { held: true, outcome: held && held.id === null ? { ok: true } : { ok: false, message: HELD_MESSAGE } };
  };
  const field = fieldOf(base.workspaceKey, operations);
  let snap: ProjectSnapshot | null = getState().snapshot;
  for (let tries = 0; ; tries++) {
    // The project closed (or another opened): sent as it is, for the project to refuse.
    if (!snap || snap.workspaceKey !== base.workspaceKey) return { held: false, result: await api.project.apply({ operations }, { label, coalesceKey, opening: base.workspaceKey }) };
    if (snap.revision !== base.revision || typed.review) {
      const check = checkHeld(snap.state, operations, before);
      if (check.kind === 'gone') return hold({ phase: 'gone', note: check.what });
      const current = check.kind === 'changed' ? check.current : (readFields(snap.state, operations) ?? []).map((r) => (r.found ? r.value : undefined));
      // Changed only by the author's own save of this field, which typing began before this window heard of, and
      // nothing since: nothing they did not see is lost.
      // The only change since the base is that save, so nothing else it reads (a route a link names, say) moved.
      const own = ownSaves.get(field)?.revision;
      const ownOnly = own !== undefined && own === base.revision + 1 && own === snap.revision;
      // Tab can start the next cell before this window hears that it saved the row's first cell.
      const rowName = check.kind === 'changed' ? tableRowNameEdit(operations, before, current) : null;
      const rowNameSave = rowName ? ownSaves.get(fieldOf(base.workspaceKey, [rowName])) : undefined;
      const ownRowName =
        rowName && rowNameSave && rowNameSave.revision > base.revision && rowNameSave.revision <= snap.revision &&
        rowNameSave.text === typedText(rowName);
      // Typed over text the page showed before it caught up: written only while the field holds just that text.
      const words = (t: string) => t.replace(/\s+/g, ' ').trim();
      const now = operations.length === 1 ? shownField(operations[0], current[0]) : null;
      const asShown = typed.shown !== undefined && typeof now === 'string' && words(now) === words(typed.shown);
      if (typed.review ? !asShown : check.kind === 'changed' && !ownOnly && !ownRowName) return hold({ phase: 'changed', current });
    }
    const r = await api.project.apply({ operations, expectedRevision: expected ?? snap.revision }, { label, coalesceKey, opening: base.workspaceKey });
    if (r.ok) {
      const [op] = operations;
      const text = operations.length === 1 && op.type === 'instance.editTable' && op.action === 'setCell' ? typed.text : null;
      ownSaves.set(field, { revision: r.revision, text });
      return { held: false, result: r };
    }
    const code = r.error?.code;
    // Built on a revision of the caller's: its refusal is the caller's to answer.
    if (expected !== undefined || (code !== 'STALE_REVISION' && code !== 'CONFLICT')) return { held: false, result: r };
    if (tries < 2 && (code === 'STALE_REVISION' || r.error?.recoverable)) {
      // Saved outside the app since the app last read it: read it now, then check again.
      if (code === 'CONFLICT') await api.project.reloadFromDisk().catch(() => undefined);
      try {
        snap = await api.project.snapshot();
      } catch (e) {
        // Never written without the check: kept, with why, for the author to try again.
        return hold({ phase: 'failed', note: `The project could not be read to check your edit: ${errorText(e)}` });
      }
      continue;
    }
    // Still refused (a file in conflict, one that cannot be read): kept, with why, so nothing typed is lost.
    return hold({ phase: 'failed', note: r.error?.message });
  }
}

/** A typed field edit is held for the author to apply once the AI stops; anything else is refused. Returns
 *  what became of it, for a save or a leave that is waiting on it. */
function refuseWhileAiBusy(typed: { base: ProjectSnapshot | null; text: string | null; seq: number; rename: PendingRename | null } | null, operations: EditOperation[], label: string): string {
  if (typed?.base && holdEdit(typed.base, operations, label, { text: typed.text, seq: typed.seq, rename: typed.rename })) return HELD_MESSAGE;
  const message = 'The AI is making changes. Stop it to edit manually.';
  toast(message, 'error', { label: 'Stop AI', run: () => void api.ai.stop() });
  return message;
}

let heldSeq = 0;
let attemptSeq = 0;
/** The rename renamePage is committing, during its call to commitOps, which hands it to the typed edit it makes. */
let renaming: PendingRename | null = null;

/**
 * Hold a typed edit made against `base`. Returns null when it is not a field edit that can be checked
 * later, otherwise the held edit's ID, or null as the ID when there is nothing to hold: its project has
 * closed, or the author has committed the same fields since (`seq` orders commits), even if that newer
 * edit was saved or discarded meanwhile.
 */
export function holdEdit(
  base: ProjectSnapshot,
  operations: EditOperation[],
  label: string,
  opts: { text?: string | null; seq?: number; cause?: HeldEdit['cause']; phase?: 'changed' | 'gone' | 'failed'; current?: unknown[]; note?: string; rename?: PendingRename | null } = {}
): { id: number | null } | null {
  // A reply that arrives after its project closed has nothing to be held in.
  if (getState().snapshot?.workspaceKey !== base.workspaceKey) return { id: null };
  const reads = readFields(base.state, operations);
  if (!reads || reads.some((r) => !r.found)) return null;
  const key = fieldKey(operations);
  const seq = opts.seq ?? ++commitSeq;
  if ((newestCommit.get(fieldOf(base.workspaceKey, operations)) ?? -1) > seq) return { id: null };
  const held = getState().heldEdits;
  const edit: HeldEdit = {
    id: ++heldSeq,
    seq,
    key,
    workspace: base.workspaceKey,
    operations,
    label,
    base: reads.map((r) => (r.found ? r.value : undefined)),
    place: placeOf(base.state, operations[0]),
    text: opts.text !== undefined && opts.text !== null ? opts.text : typedText(operations[0]),
    phase: opts.phase ?? 'waiting',
    ...(opts.cause ? { cause: opts.cause } : {}),
    ...(opts.current ? { current: opts.current, currentText: shownField(operations[0], opts.current[0]) } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(isRenameOf(operations, opts.rename) ? { rename: opts.rename } : {})
  };
  // A newer edit of the same fields replaces the older one (and any handoff still running for it).
  // One already being written cannot be called back: it stays until its save answers.
  setState({ heldEdits: [...held.filter((h) => h.key !== key || h.workspace !== base.workspaceKey || h.writing), edit] });
  return { id: edit.id };
}

/** Whether the edit is exactly that page's rename, so a held edit carries the rename's offer only when it is one. */
function isRenameOf(operations: EditOperation[], rename: PendingRename | null | undefined): rename is PendingRename {
  const op = operations.length === 1 ? operations[0] : null;
  return !!rename && op?.type === 'page.update' && op.pageId === rename.pageId && op.title === rename.to && Object.keys(op).length === 3;
}

const heldById = (id: number) => getState().heldEdits.find((h) => h.id === id);
function patchHeld(id: number, patch: Partial<HeldEdit>, extra: Partial<State> = {}) {
  setState({ heldEdits: getState().heldEdits.map((h) => (h.id === id ? { ...h, ...patch } : h)), ...extra });
}
const removeHeld = (id: number) => getState().heldEdits.filter((h) => h.id !== id);

/** Discard a held edit. One whose save is already on its way cannot be called back. */
export function discardHeld(id: number) {
  if (heldById(id)?.writing) return;
  // Nothing was saved: the toolbar must not announce an earlier save as this one's.
  const outcome = getState().aiOutcome;
  setState({ heldEdits: removeHeld(id), aiOutcome: outcome ? { run: outcome.run, runId: outcome.runId } : null });
}

/**
 * Apply a held edit: "Stop AI and apply my edit" (`stopRunId`: the request the author chose to stop),
 * "Apply my edit" after the AI ended, or with `replace`, the author's choice to replace what a changed
 * field holds now. Only the named request is stopped, and the edit applies after its changes are rolled
 * back, and only while every field it writes still holds what the author edited (or, with `replace`,
 * what the author reviewed).
 */
export async function applyHeld(id: number, opts: { replace?: boolean; stopRunId?: string } = {}): Promise<void> {
  const held = heldById(id);
  if (!held || held.phase === 'applying' || (opts.replace && held.phase !== 'changed')) return;
  const attempt = ++attemptSeq;
  const expected = opts.replace ? held.current! : held.base;
  patchHeld(id, { phase: 'applying', attempt, stopping: !!opts.stopRunId, writing: false, note: undefined });
  const live = () => {
    const h = heldById(id);
    return h && h.attempt === attempt ? h : null;
  };
  const settle = (patch: Partial<HeldEdit>, extra: Partial<State> = {}) => patchHeld(id, { attempt: undefined, stopping: false, writing: false, ...patch }, extra);
  // How the request this stopped ended; null when it stopped none.
  let run: RunStatus | null = null;
  if (opts.stopRunId) {
    // Resolves once that request has ended and its changes are rolled back. Another request is left alone.
    let stopped: Awaited<ReturnType<typeof api.ai.stop>> | null = null;
    try {
      stopped = await api.ai.stop(opts.stopRunId);
    } catch {
      /* The snapshot below says whether it ended. */
    }
    if (stopped?.stopped) run = stopped.status ?? 'cancelled';
    else {
      // It had already ended on its own: that is how it ended, if its last status was for that request.
      const last = getState().aiOutcome;
      run = last?.runId === opts.stopRunId ? last.run : null;
    }
    if (!live()) return;
    // Only a request that ended cleanly (rolled back, or finished before the stop reached it) leaves a
    // project the edit can be checked against. One whose rollback failed or kept changes for review does not.
    if (run !== null && run !== 'cancelled' && run !== 'completed' && run !== 'no-changes')
      return settle({ phase: 'failed', note: 'The AI request did not end cleanly, so your edit was not applied. Check the page, then try again.' }, { aiOutcome: { run, edit: 'held' } });
    patchHeld(id, { stopping: false });
  }
  // The toolbar tells how an AI request ended and what became of an edit held for it. An edit held because its
  // field changed somewhere else has nothing to do with the AI: it leaves that alone.
  const aiHeld = held.cause !== 'elsewhere';
  const outcome = (edit: AiOutcome['edit']): Partial<State> => (aiHeld ? { aiOutcome: { run, ...(run && opts.stopRunId ? { runId: opts.stopRunId } : {}), edit } } : {});
  for (let tries = 0; ; tries++) {
    let snap: ProjectSnapshot | null;
    try {
      snap = await api.project.snapshot();
    } catch (e) {
      if (live()) settle({ phase: 'failed', note: (e as Error).message });
      return;
    }
    const h = live();
    // Discarded, replaced by a newer edit, or the project closed meanwhile.
    if (!h) return;
    // The edit belongs to a project that is no longer open.
    if (!snap || snap.workspaceKey !== h.workspace) return setState({ heldEdits: removeHeld(id) });
    if (snap.aiBusy) return settle({ phase: 'waiting', note: 'The AI is working on another request.' });
    const check = checkHeld(snap.state, h.operations, expected);
    if (check.kind === 'gone') return settle({ phase: 'gone', note: check.what }, outcome('held'));
    if (check.kind === 'changed') return settle({ phase: 'changed', current: check.current, currentText: shownField(h.operations[0], check.current[0]) }, outcome('held'));
    patchHeld(id, { stopping: false, writing: true });
    setState({ pendingSave: getState().pendingSave + 1 });
    const writing = api.project
      .apply({ operations: h.operations, expectedRevision: snap.revision }, { label: h.label, opening: h.workspace })
      .catch((e: Error) => ({ ok: false as const, revision: 0, error: { code: 'FAILED', message: e.message } }));
    // Followed like any change on its way, so saving or leaving the project waits for it.
    trackApply(writing.then((x) => ({ ok: x.ok, message: x.error?.message })));
    const r = await writing;
    const pendingSave = Math.max(0, getState().pendingSave - 1);
    // The project closed while the save was on its way.
    if (!live()) return setState({ pendingSave });
    // In one update, so the toolbar goes straight from the AI to "your edit was saved".
    if (r.ok) return setState({ pendingSave, heldEdits: removeHeld(id), ...outcome('saved'), ...landedRename(id, r.revision, shownField(h.operations[0], expected[0])) });
    setState({ pendingSave });
    // Something else changed the project between the check and the write: check again.
    if (r.error?.code === 'STALE_REVISION' && tries < 2) {
      patchHeld(id, { writing: false });
      continue;
    }
    if (r.error?.code === 'BUSY')
      return getState().snapshot?.aiBusy
        ? settle({ phase: 'waiting', note: 'The AI is working on another request.' })
        : settle({ phase: 'failed', note: 'The project is still locked by an AI request that did not end cleanly. Reopen the project, then try again.' }, outcome('held'));
    return settle({ phase: 'failed', note: r.error?.message ?? 'That change could not be applied.' }, outcome('held'));
  }
}

/** A rename held while the AI worked is saved now: its offer shows. */
function landedRename(heldId: number, revision: number, replaced: unknown): Partial<State> {
  const rename = heldById(heldId)?.rename;
  if (!rename) return {};
  // Replacing a title changed elsewhere meanwhile: labels with that title are as old as the ones with the author's.
  const also = typeof replaced === 'string' && replaced && replaced !== rename.from && replaced !== rename.to ? { also: replaced } : {};
  return { renameOffer: { ...rename, revision, ...also } };
}

/**
 * Rename a page as the author typed it (from Pages or the inspector; called inside the typed edit's commitDraft), then
 * offer to bring along the labels that still say its old name. `from` is the title the author renamed: when the page
 * was renamed from it moments ago and that offer is still open, the labels still say the name before that one.
 */
export function renamePage(pageId: string, from: string, title: string): Promise<unknown> {
  const opening = getState().snapshot?.workspaceKey ?? '';
  const prev = getState().renameOffer;
  const original = prev && prev.opening === opening && prev.pageId === pageId && prev.to === from ? prev.from : from;
  const offer: PendingRename = { opening, pageId, from: original, to: title };
  const operations: EditOperation[] = [{ type: 'page.update', pageId, title }];
  // commitOps takes the rename with its typed edit before it awaits anything: an edit held while the AI works carries
  // the offer, shown once it is saved and dropped with it. A rename the project refused is not held, and offers nothing.
  renaming = original === title ? null : offer;
  let saved: ReturnType<typeof commitOps>;
  try {
    saved = commitOps(operations, `Rename page ${from} to ${title}`);
  } finally {
    renaming = null;
  }
  return saved.then((r) => {
    if (r?.ok && original !== title && r.workspaceKey === opening && getState().snapshot?.workspaceKey === opening) setState({ renameOffer: { ...offer, revision: r.revision } });
  });
}

/**
 * Apply `operations` after the edits they need first, as one batch and one undo step, against the revision the
 * edit was planned on. A batch that adds edits of its own is its own undo step, never merged into the last one.
 */
export function applyWith(edit: PendingEdit | undefined, operations: EditOperation[], label: string, coalesceKey?: string) {
  if (!edit) return applyOps(operations, label, coalesceKey);
  return applyOps([...edit.operations, ...operations], label, edit.operations.length || edit.separate ? undefined : coalesceKey, edit.expectedRevision);
}

/**
 * The Undo for a notification about one committed change (a `commitOps` result). It undoes that history entry, in
 * the project it was made in, and never whatever happens to be newest: when later edits leave it no way to do that
 * on its own, it says why and opens History at the entry. None when the change made no history entry, or its
 * project is no longer the one open.
 */
export function undoAction(r: { entryId?: string; revision: number; workspaceKey: string }): Toast['action'] {
  const { entryId, workspaceKey } = r;
  if (!entryId || !workspaceKey || getState().snapshot?.workspaceKey !== workspaceKey) return undefined;
  // History opens at the entry only while its project is still the one open.
  const history = {
    label: 'History',
    run: () => {
      if (getState().snapshot?.workspaceKey === workspaceKey) setState({ modal: { kind: 'history', entryId } });
    }
  };
  return {
    label: 'Undo',
    undoes: { entryId, workspaceKey, revision: r.revision },
    run: () =>
      void trackHistory(api.project.undoEntry(entryId, workspaceKey)).then(
        (res) => {
          if (!res.ok) toast(res.error?.message ?? 'That change could not be undone.', 'error', res.error?.code === 'CONFLICT' ? history : undefined);
        },
        () => toast('That change could not be undone.', 'error', history)
      )
  };
}

/** Whether a notification's Undo still has its change to undo: same project, and the entry is still applied. */
export function undoAvailable(t: UndoTarget, snap: ProjectSnapshot | null): boolean {
  if (!snap || snap.workspaceKey !== t.workspaceKey) return false;
  if (snap.revision < t.revision) return true;
  return snap.history.entries.some((e) => e.id === t.entryId && e.applied);
}

/** What became of an edit committed with commitIfUnchanged. `where` names what it writes ("Split hero on Home"). */
export type CheckedOutcome =
  | { kind: 'applied'; where: string }
  /** Checked only (`checkOnly`): every field it writes still holds what it held, and nothing was written. */
  | { kind: 'unchanged'; where: string }
  /** Something it writes was edited meanwhile: applying it would replace that newer edit. */
  | { kind: 'changed'; where: string }
  /** What it writes was removed meanwhile: `what` says what is missing ("list item", "element", "page"). */
  | { kind: 'gone'; what: string; where: string }
  /** The project is busy: the AI is working on it, or (with `message`) the project said why it is locked. */
  | { kind: 'busy'; message?: string }
  /** The project it was asked for in is no longer open. */
  | { kind: 'closed' }
  | { kind: 'failed'; message: string };

interface CheckedCommit {
  base: ProjectSnapshot;
  checkOnly: boolean;
  outcome: Promise<CheckedOutcome> | null;
}
/** The commit in progress in commitIfUnchanged: commitOps checks the edit it is handed. */
let checked: CheckedCommit | null = null;

/**
 * Commit an edit the author asked for earlier, once the work it waited on (an import) has finished, wherever the
 * author is by then. `commit` calls the change handler of the field the edit was asked for, kept from that moment,
 * so the edit goes to that field and never to whatever is selected now. `base` is the project as that field's
 * editor showed it then. The edit applies only in the same opening of the project, and only while every field it
 * writes still holds what it held in `base`: it never replaces a newer edit, and never lands on something removed
 * meanwhile. With `checkOnly`, the edit names the field and is checked the same way, but not written (the field
 * already holds what was asked for). One edit per commit. The caller follows the work as a save in flight, from
 * where it began.
 */
export function commitIfUnchanged(base: ProjectSnapshot, commit: () => unknown, opts: { checkOnly?: boolean } = {}): Promise<CheckedOutcome> {
  const prev = checked;
  const c: CheckedCommit = { base, checkOnly: !!opts.checkOnly, outcome: null };
  checked = c;
  try {
    commit();
  } catch (e) {
    c.outcome ??= Promise.resolve({ kind: 'failed', message: errorText(e) });
  } finally {
    checked = prev;
  }
  return c.outcome ?? Promise.resolve({ kind: 'failed', message: 'That change could not be made.' });
}

function applyChecked(c: CheckedCommit, operations: EditOperation[], label: string, coalesceKey?: string, expectedRevision?: number): Promise<(ApplyResult & { workspaceKey: string }) | null> {
  // One edit per commit: a second one is never applied, checked or not.
  if (c.outcome) return Promise.resolve(null);
  let result: (ApplyResult & { workspaceKey: string }) | null = null;
  c.outcome = checkAndApply(c, operations, label, coalesceKey, expectedRevision, (r) => (result = { ...r, workspaceKey: c.base.workspaceKey }));
  return c.outcome.then(() => result);
}

async function checkAndApply(c: CheckedCommit, operations: EditOperation[], label: string, coalesceKey: string | undefined, expectedRevision: number | undefined, done: (result: ApplyResult) => void): Promise<CheckedOutcome> {
  const { base } = c;
  const reads = readFields(base.state, operations);
  if (!reads || reads.some((r) => !r.found)) return { kind: 'failed', message: 'That change could not be checked.' };
  const before = reads.map((r) => (r.found ? r.value : undefined));
  // Checked first against the project as this window has it. That copy can be behind: a refusal is made only
  // after checking the project itself, and a write sent from a copy that was behind is refused and checked again.
  let snap = getState().snapshot;
  let fresh = false;
  for (let tries = 0; ; ) {
    if (!snap || snap.workspaceKey !== base.workspaceKey) return { kind: 'closed' };
    const check = checkHeld(snap.state, operations, before);
    const where = whereOf(check.kind === 'gone' ? base.state : snap.state, operations[0]);
    const refusal: CheckedOutcome | null = snap.aiBusy
      ? { kind: 'busy' }
      : check.kind === 'gone'
        ? { kind: 'gone', what: check.what, where }
        : // Edits planned against a revision (a section's new ID before the link to it) hold only for that revision.
          check.kind === 'changed' || (expectedRevision !== undefined && snap.revision !== expectedRevision)
          ? { kind: 'changed', where }
          : null;
    if (refusal && fresh) return refusal;
    // Nothing is written to refuse a check made on a copy that is behind, so it is made on the project's own.
    if (!refusal && c.checkOnly && fresh) return { kind: 'unchanged', where };
    if (!refusal && !c.checkOnly) {
      const r = await api.project
        .apply({ operations, expectedRevision: snap.revision }, { label, coalesceKey, opening: base.workspaceKey })
        .catch((e: unknown) => ({ ok: false as const, revision: 0, error: { code: 'FAILED' as const, message: errorText(e) } }));
      if (r.ok) {
        done(r);
        return { kind: 'applied', where };
      }
      if (r.error?.code === 'BUSY') return { kind: 'busy', message: r.error.message };
      if (r.error?.code !== 'STALE_REVISION' || ++tries > 2) return { kind: 'failed', message: r.error?.message ?? 'That change could not be applied.' };
    }
    try {
      snap = await api.project.snapshot();
      fresh = true;
    } catch (e) {
      return { kind: 'failed', message: errorText(e) };
    }
  }
}

let providersRequest = 0;

/**
 * Read the providers' status again (what is set up, and what the local server last showed). Only the latest
 * request's answer is kept, whichever part of the app asked; a failure leaves the status as it was.
 */
/** Providers' status as an answer just gave it: kept, and any older read still under way is dropped. */
export function setProviders(providers: ProviderStatus[]) {
  providersRequest++;
  setState({ providers });
}

export function refreshProviders(): Promise<void> {
  const id = ++providersRequest;
  return Promise.resolve()
    .then(() => api.ai.providers())
    .then(
      (providers) => {
        if (id === providersRequest) setState({ providers });
      },
      () => undefined
    );
}

export function applyAiEvent(e: AiEvent) {
  const s = getState();
  if (e.kind === 'status') {
    const terminal = ['completed', 'no-changes', 'cancelled', 'failed', 'conflicted'].includes(e.status!);
    // A question never changes the site, so edits typed while it runs are not held or checked against it.
    const ask = e.mode === 'ask';
    if (!ask) aiEpoch++;
    setState(
      terminal
        ? { runStatus: null, activeRunId: null, runMode: null, ...(ask ? {} : { aiOutcome: { run: e.status!, runId: e.runId } }) }
        : { runStatus: e.status!, activeRunId: e.runId, runMode: ask ? 'ask' : 'edit' }
    );
    // What the request learned about a local server (it answered, or it is down) is what Chat shows next.
    if (terminal && getState().settings?.ai.provider === 'local') void refreshProviders();
    return;
  }
  const conv = s.conversation;
  // A run's messages belong to the conversation it was filed in: one shown in any other thread (or from a project
  // closed mid-run, tagged with none) would look sent there while being saved elsewhere. Status stays app-wide.
  if (!conv || e.conversationId !== conv.id) return;
  if (e.kind === 'message' && e.message) {
    const msgs = [...conv.messages];
    const i = msgs.findIndex((m) => m.id === e.message!.id);
    if (i >= 0) msgs[i] = e.message;
    else msgs.push(e.message);
    setState({ conversation: { ...conv, messages: msgs }, activeRunId: e.runId || s.activeRunId });
  } else if (e.kind === 'text') {
    const msgs = conv.messages.map((m): ChatMessage => (m.runId === e.runId && m.role === 'assistant' ? { ...m, text: e.text ?? '' } : m));
    setState({ conversation: { ...conv, messages: msgs } });
  }
}

/** Mark or clear an uncommitted edit (a field, an inline rename, canvas text) so the toolbar says "Editing…". */
// Held edits are unsaved work: saving or leaving the project says so, as it does for any open draft.
useStore.subscribe((s, prev) => {
  if (s.heldEdits !== prev.heldEdits) markDraft(HELD_DRAFT, s.heldEdits.length > 0);
});

// The look Edit everywhere styles belongs to that one visit: leaving the component, or editing another, starts again
// on its base design. A look that is gone (an Undo, a removal) is forgotten whatever is on screen, so one made again
// later under the same ID is not styled without being chosen.
useStore.subscribe((s, prev) => {
  const v = s.variantStyle;
  if (!v) return;
  if (s.definitionMode?.definitionId !== prev.definitionMode?.definitionId) return void useStore.setState({ variantStyle: null });
  if (s.snapshot === prev.snapshot) return;
  const options = s.snapshot?.state.components[v.definitionId]?.variantAxes?.[v.axis]?.options;
  if (!options || !Object.hasOwn(options, v.variant)) useStore.setState({ variantStyle: null });
});

export function markDraft(key: string, on: boolean, note?: string) {
  if (!setDraft(key, on, note)) return;
  useStore.setState({ drafting: draftCount(), refusedDrafts: refusedDraftCount() });
  // A new draft retires any "saved" notice still on screen: it no longer describes what you are typing.
  if (on) {
    const toasts = useStore.getState().toasts;
    if (toasts.some((t) => t.kind === 'success')) useStore.setState({ toasts: toasts.filter((t) => t.kind !== 'success') });
  }
}

export type ConfirmIcon = 'delete' | 'discard' | 'revert' | 'replace' | 'unlock' | 'leave' | 'key' | 'web' | 'email' | 'phone' | 'warning';
export interface ConfirmDetail {
  kind: 'lose' | 'risk' | 'keep' | 'undo' | 'final' | 'note';
  text: string;
}
export interface ConfirmRequest {
  /** Each question has its own id, so one replacing another starts again on its own safe choice. */
  id: number;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** A third, safe choice ("Keep editing") that resolves like a dismissal and takes the initial focus, so
   *  a second Enter never discards anything. */
  stayLabel?: string;
  /** Shorthand for tone 'danger'. */
  danger?: boolean;
  /** What is at stake, shown by the icon and the confirm button. 'danger': lost for good, or saved work at risk
   *  (a red button). 'caution': unsaved or recoverable work is lost (an outlined red button). 'neutral' (the
   *  default): nothing is lost. */
  tone?: 'danger' | 'caution' | 'neutral';
  /** The glyph beside the title, naming the kind of action. */
  icon?: ConfirmIcon;
  /** The one thing the answer acts on (a version's name, a link's address), set apart so it can be checked. */
  subject?: string;
  subjectKind?: 'version' | 'component' | 'field' | 'web' | 'email' | 'phone';
  /** A quiet fact about the subject, such as the space it takes. */
  subjectNote?: string;
  /** One short line each: what is lost, what is at risk, what stays safe, how to take it back or that it can't
   *  be, and anything else to know. Shown in the order given, each with its own icon. */
  details?: ConfirmDetail[];
  /** true = confirm, false = the cancel button, null = dismissed (Escape, ×, backdrop): stay where you were. */
  resolve: (ok: boolean | null) => void;
}
/** The open question first, then the ones waiting their turn, in the order they were asked. */
let confirmQueue: ConfirmRequest[] = [];
const confirmListeners = new Set<() => void>();
const notifyConfirm = () => confirmListeners.forEach((f) => f());
/** The question on screen. */
export function getConfirm() {
  return confirmQueue[0] ?? null;
}
/** Every question not yet answered, the one on screen first. */
export function pendingConfirms(): readonly ConfirmRequest[] {
  return confirmQueue;
}
export function onConfirmChange(fn: () => void) {
  confirmListeners.add(fn);
  return () => confirmListeners.delete(fn);
}
/** Ask a yes/no question in the app's own dialog (never the system's), resolving to the answer. A question
 *  asked while another is open waits its turn, so every caller hears its own answer. */
let confirmIds = 0;
export function confirmDialog(req: Omit<ConfirmRequest, 'resolve' | 'id'>): Promise<boolean | null> {
  return new Promise((resolve) => {
    const entry: ConfirmRequest = {
      ...req,
      id: ++confirmIds,
      resolve: (ok) => {
        // Answered once: a second click or a late dismissal finds it already gone.
        if (!confirmQueue.includes(entry)) return;
        const wasOpen = confirmQueue[0] === entry;
        confirmQueue = confirmQueue.filter((q) => q !== entry);
        // The host only shows the question on screen: a waiting one that leaves changes nothing it draws.
        if (wasOpen) notifyConfirm();
        resolve(ok);
      }
    };
    confirmQueue = [...confirmQueue, entry];
    // Only a question that takes the screen changes what the host shows.
    if (confirmQueue.length === 1) notifyConfirm();
  });
}
