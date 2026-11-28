import './Canvas.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { canvasFoot } from '../lib/canvas-foot';
import { createPortal } from 'react-dom';
import { ArrowDown, Repeat, ArrowLeft, ArrowRight, ArrowUp, Ban, BookmarkPlus, Box, Check, ChevronLeft, ChevronRight, CircleHelp, Download, LocateFixed, Component, Copy, Ellipsis, Eye, GripVertical, Image, Layers, LayoutTemplate, Link2, PanelRight, Pencil, Plus, Rows3, Sparkles, Square, Trash2, TriangleAlert, Type, Unlink, Users } from 'lucide-react';
import { findParent } from '@engine/tree';
import { newId } from '@shared/ids';
import { applyOps, commitOps } from '../store';
import { activeWorkspace, canvasCovered } from '../lib/workspace';
import { CANVAS_DRAFT, reportRefused, setCanvasCommit } from '../lib/pending';
import { clickTargetIn, treeFor } from '../lib/model';
import { slotOverviews } from '../lib/slot-overview';
import { openInsertSearch } from '../lib/insert-focus';
import { editLabel } from '../lib/edit-label';
import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { aiActivity, api, commitDraft, errorText, getOverlay, getState, markDraft, openRunThread, saveLocal, setOverlay, setState, setViewport, stepHistory, toast, useOverlay, useStore, type Rect } from '../store';
import { appliedSteps, errorComponent, revertStep, stillNewest } from '../lib/preview-error';
import { acceptMessage, newSessionId, postToFrame, staleFor, viewAfter, type BridgeMessage, type FrameView } from '../lib/bridge';
import { bindDescOf, chainOf, descOrNull, emptyAreaOf, measuredRects, pointedAt, rectList, sameRects, slotBoxes, spaceSizes, spacingOf, type FrameEmptyArea, type FrameSpacing, type SlotBox } from '../lib/payload';
import { blocksFromDom, richDom } from '../lib/richtext';
import { collectionIndexRoutes } from '@shared/archives';
import { dropAt, dropReaches, moveIndex, shownOrder } from '../lib/reorder';
import { dropLineBox, edgeSpeed, type EdgeView } from '../lib/edge-scroll';
import { createPageGate, failedWithRevision, gatedPick, PAGE_CATCH_UP_MS, type PageGate, type SeenFailure } from '../lib/page-gate';
import { insertOps, insertRole, whereText, type InsertAt, type Where } from '../lib/insert-at';
import { dropRefusal, incomingOrder, insertDestination, measureIds, moveDestination, savingProblems, slotOfKey, type DropList, type ListSpec, type Measured, type MoveAim, type SlotSurface } from '../lib/insert-drop';
import { setInsertDropTarget, type InsertDrag } from '../lib/insert-drag';
import { setAssetDropTarget, type AssetDrag } from '../lib/asset-drag';
import { aimKey, assetAim, descKey, imageDropTargets, imageInsertOps, resolveImageDrop, type AssetAim, type ImageTarget } from '../lib/image-drop';
import { askFrame, followed, followReport, newFrameNav, samePath, sendsFrame } from '../lib/frame-nav';
import { inlineLinkProblem } from '../lib/link-problems';
import { revealTarget, sameTarget, type RevealTarget } from '../lib/reveal';
import { ARRIVAL_MS, arrivalShown, takeArrival } from '../lib/arrival';
import { externalLink } from '@shared/links';
import { confirmOpenExternal } from '../lib/open-external';
import { richTextToMarkdown } from '@shared/richtext';
import { hasDarkPalette } from '@shared/color-scheme';
import { repeatAsListTarget } from '../lib/repeat-as-list';
import { marksAnnouncement, marksNow, PeerMarks, SpotlightPrompts, trackedMarks, useCanvasMarks } from './CanvasMarks';
import { presenceOf } from '../lib/live-host';
import { boundaryOf, codeTextTarget, computedAt, createComponentTarget, definitionPick, descOf, designCtx, inDefinition, itemStep, needsStudio, placementsOn, refExists, refLabel, resolveRef, selectionFromChain, stepItem, studioDescOf, studioDesignCtx, studioPick, throughPlacement, toDefinitionRef, withoutSlot, type BridgeDesc, type CodeTextTarget } from '../lib/model';
import { NEW_STUDIO, StudioLoads, studioSpec } from '../lib/studio';
import { titleOnlyPage } from '../lib/page-start';
import { CHIP_H, chipLeft } from '../lib/chip-place';
import { askAiAbout, leaveLayout, writePageWithAi, canInlineEdit, canInlineEditCode, commitCodeText, commitText, dropAsset, dropAssetAt, deleteSelection, detachable, detachPlacement, duplicateLayers, duplicateSelection, insertHere, liveGroup, moveLayers, moveSelection, planOne, setMode, showsCodeText, showsInlineText, selectOnPage, structuralTarget, takeUnscrolled, ungroupLayers, wrapLayers } from '../lib/actions';
import { exportComponentFile, placedDefinition, saveToLibrary } from '../lib/saved-components';
import { wrapItems } from './WrapItems';
import { handleShortcut } from '../Editor';
import { notePointerInput, openMenus, Spinner, useMenu, type MenuTriggerProps } from '../components/ui';
import { PreviewStatus, StatusCard, openLayers, stoppedAnnouncement, useSlowWait } from './PreviewStatus';
import { CanvasSkeleton } from '../components/EditorSkeleton';
import { isRemoteOpening } from '../lib/remote-snapshot';
import { outlinesFirstPage } from '../lib/first-page';
import { projectDisplayName } from '@shared/project-name';
import { newPostOps } from '../lib/posts';
import { entryNounLower } from '../lib/content';
import { useTransitionAnnouncement } from '../lib/announce';
import { runPhase } from '../lib/savestate';
import { focusInspector } from '../lib/inspector-focus';
import { keyboardLeavesPage } from '../lib/clip-keys';
import { clampViewport, frameKeyResize, VIEWPORT_LIMITS, type PanelSide } from '../lib/layout';
import { formSendOf, formsOf, sendSettled, type FormSend, type PracticeResult, type PreviewForm } from '../lib/form-practice';
import { FormPractice } from './FormPractice';
import { isRemoteShell, loadedRevision } from '../lib/remote-session';
import { SpacingHandles } from './SpacingHandles';
import { QuickInsert } from './QuickInsert';
import { addPoints, offeredAt, pointLabel, resolvePoint, type AddPoint, type QuickItem } from '../lib/inline-insert';
import { placeAdds, underHeader, type AddBox } from '../lib/add-place';
import { copyPasteItems, PasteHere } from './CopyPaste';
import { copySelection, pasteFromMenu } from '../lib/clipboard';
import { isShellPart, showsPart } from '@shared/page-shell';
import { sampleEntries, shownView, templateOwner, viewAt, viewKey, type TemplateMode } from '../lib/template-view';
import { addressPath, frameEntry, NO_HISTORY, observe, siteAddresses, startJourney, stepTarget, type FrameEntry, type VisitorHistory } from '../lib/preview-history';
import { shortcutLabel } from '../lib/shortcut-keys';
import { settlePageClick } from '../lib/page-clicks';
import { askAiHint, useAskAiKeys } from '../lib/ask-ai-key';
import { perfCount, perfMark, perfOn, perfWork } from '../lib/perf';
import { aiRunning } from '../lib/blocked';

/** Whether two reports measured the same element (or both nothing). */
const sameMeasured = (a: BridgeDesc | null, b: BridgeDesc | null) => a === b || (!!a && !!b && a.ctx === b.ctx && a.node === b.node && (a.items || '') === (b.items || '') && (a.part || '') === (b.part || '') && a.slot === b.slot);

/** True while an inline text edit is open in the preview; shortcuts must not act on the selection then. */
export const inlineEdit = { active: false };
/** A text field inside the preview has focus, as the page reports it. It only keeps Undo, Delete and paste in that field; it never starts a project change. */
export const frameTextFocus = { active: false };

/** Shortcuts as this platform writes them: ⌘ and Meta on macOS, Ctrl and Control elsewhere. */
/** What an inline edit's element is named by, as its commit must name it again: a code placement's marked text by its marker too. */
const editDescKey = (d: BridgeDesc) => JSON.stringify(d.bind === undefined ? [d.ctx, d.node, d.items] : [d.ctx, d.node, d.items, d.bind]);
const isMac = api.platform === 'darwin';
const keys = (k: string) => shortcutLabel(k, api.platform);
const ariaKeys = (k: string) => (isMac ? k : k.replace('Meta', 'Control'));

/**
 * Open a page chosen in Pages a moment ago that is still waiting to (see settlePageClick): true when that takes the
 * canvas somewhere else, so a pick made meanwhile was on what is leaving and selects nothing. The page already shown,
 * opened again, leaves the pick to land as it would have.
 */
function leavingForPage(): boolean {
  const before = getState();
  if (!settlePageClick()) return false;
  const now = getState();
  return now.pageId !== before.pageId || now.definitionMode !== before.definitionMode || now.templateMode !== before.templateMode;
}

/** The site's page addresses as they are now (see siteAddresses). */
const siteNow = () => siteAddresses(Object.values(getState().snapshot?.state.pages ?? {}).map((pg) => pg.route));

/** Back and Forward through a visitor's journey in Preview, for the keyboard (see App and Editor). */
let visitorStep: ((dir: 'back' | 'forward') => boolean) | null = null;
/** Step back or forward in Preview; false when there is no such step, or while a workspace covers the canvas (#700). */
export function stepVisitor(dir: 'back' | 'forward'): boolean {
  if (canvasCovered(activeWorkspace(getState()))) return false;
  return visitorStep?.(dir) ?? false;
}

/** Set while the canvas is shown: opens an address that is no page of the editor's (a post), or the page shown again. */
let frameVisit: ((path: string | null, fullReload?: boolean) => boolean) | null = null;
/** The address visitAddress asked for, until showEditedPage: a new frame (the preview restarted) opens it again. */
let visitWanted: string | null = null;
let visitWantedReload = false;
/**
 * Show `path` in the preview, as the editor asks for a page: the editor's page stays the one it shows, and asking for
 * that page again (showEditedPage) overtakes this request even before the frame gets there. False while the preview
 * is not ready to be asked.
 */
export function visitAddress(path: string, fullReload = false): boolean {
  // Wanted either way: a preview still starting opens it once its frame is ready.
  visitWanted = path;
  visitWantedReload = fullReload;
  return frameVisit?.(path, fullReload) ?? false;
}
/** Back to the page the editor shows, from an address visitAddress opened. */
export function showEditedPage(): void {
  visitWanted = null;
  frameVisit?.(null);
}

export function Canvas() {
  // Each render of the canvas, for the performance harness (scripts/perf/README.md, the `canvas` scenario).
  perfCount('canvas.renders');
  const runtime = useStore((s) => s.runtime);
  const snapshot = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const templateMode = useStore((s) => s.templateMode);
  const viewport = useStore((s) => s.viewport);
  // On a site with a dark palette, the canvas can show either palette whatever this computer's setting: the frame's
  // own color scheme is what the page's prefers-color-scheme reads (see styles.css), never the editor's Appearance.
  const frameScheme = useStore((s) => (s.previewScheme !== 'system' && hasDarkPalette(s.snapshot?.state.tokens) ? s.previewScheme : undefined));
  const zoomSetting = useStore((s) => s.zoom);
  const mode = useStore((s) => s.mode);
  const selection = useStore((s) => s.selection);
  const hover = useOverlay((s) => s.hover);
  const rects = useOverlay((s) => s.rects);
  const revealedItem = useStore((s) => s.revealedItem);
  const showSelection = useStore((s) => s.showSelection);
  const showMoved = useStore((s) => s.showMoved);
  const inspectorShown = useStore((s) => s.dockOpen && s.rightTab === 'inspect');
  const runStatus = useStore((s) => s.runStatus);
  // A request the AI has started on, before its first status arrives (as Chat counts it).
  const turnOpen = useStore((s) => !!s.activeRunId && !!s.conversation?.messages.some((m) => m.role === 'assistant' && m.runId === s.activeRunId && !m.result));
  const reading = useStore((s) => s.runMode === 'ask');
  const activeRunId = useStore((s) => s.activeRunId);
  // The question waits in the thread that asked it: Answer in chat goes back to that thread, whichever the chat shows
  // (#1125). A request whose project closed mid-run belongs to no thread here.
  const asked = useStore((s) => s.runStatus === 'awaiting-input' && !!s.runConversationId);
  const devMode = useStore((s) => !!s.settings?.developerMode);
  const definitionMode = useStore((s) => s.definitionMode);
  // While Site styles is open, edits are site-wide; the element selection steps back.
  const stylesOpen = useStore((s) => s.rightTab === 'styles' && s.dockOpen);
  const styleScope = useStore((s) => s.styleScope);
  const styleState = useStore((s) => s.styleState);
  const styleStatePart = useStore((s) => s.styleStatePart);
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [session, setSession] = useState(() => newSessionId());
  const [ready, setReady] = useState(false);
  /** Forms in Preview (issue #193): the page's forms, the reply practice sends get, the last send, the live test on its way. */
  const [forms, setForms] = useState<PreviewForm[]>([]);
  const [practice, setPractice] = useState<PracticeResult>('success');
  // The forms panel folded to its title line, kept from page to page while Preview is open.
  const [practiceFolded, setPracticeFolded] = useState(false);
  const [lastSend, setLastSend] = useState<FormSend | null>(null);
  const [liveRequest, setLiveRequestState] = useState<string | null>(null);
  /** The live test the editor is waiting on, read by message handlers that may run before React re-renders. */
  const liveRequestRef = useRef<string | null>(null);
  const setLiveRequest = (id: string | null) => {
    liveRequestRef.current = id;
    setLiveRequestState(id);
  };
  /** Changes with each page shown, so a live-test confirmation never outlives the page it was opened on. */
  const [formsView, setFormsView] = useState(0);
  // The page's own error is shared through the store, so the status bar and Project health tell the same story.
  const frameError = useStore((s) => s.previewIssue);
  const setFrameError = (m: string | null) => setState({ previewIssue: m });
  // After Try again, the problem stays reported as "Restarting preview" until the new page says it is ready.
  const [retrying, setRetrying] = useState(false);
  /** The problem shown is the canvas's own "took too long" report, which a late arrival of the page clears. */
  const timedOut = useRef(false);
  /**
   * What the page's own error can be put down to (#738), for the message it came with: the component it was thrown in
   * (Open source), and the change that could have caused it (Revert), worked out from History as it was when the error
   * happened and offered only while that change is still History's newest.
   */
  const [issueCause, setIssueCause] = useState<{ message: string; definitionId: string | null; revert: { id: string; label: string; key: string } | null } | null>(null);
  /** The change the page had been told of, or the editor had made, when its error happened: showing it does not mend it. */
  const errorAt = useRef<number | null>(null);
  /**
   * History's applied steps when the page was last seen working: in the project and on the page it was seen on (a
   * page's own problem is never put down to a change made while another page was shown). See notePageWorking.
   */
  const healthy = useRef<{ workspaceKey: string; target: string | null; steps: string[] } | null>(null);
  const healthyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Undoing the change Revert names: Try again and Revert wait for it, whatever else the page reports meanwhile. */
  const [reverting, setReverting] = useState(false);
  /** What the frame shows, for the page-working baseline: the component in Component Studio, with its sample and
   *  variant, or the page's path. */
  const previewTarget = () => {
    if (!showsStudio()) return frameAt.current;
    const s = getState();
    return `studio:${JSON.stringify([studioAt.current!.definitionId, s.definitionMode?.studio, s.variantStyle])}`;
  };
  /**
   * The page loaded, arrived or showed a change, with nothing wrong: once it has gone a moment without an error it
   * counts as working with the project as it is now, for Revert to name what changed after. The moment matters,
   * because a change's error can arrive after the page says the change is shown, and a page's own error after it says
   * it loaded. `revision` is the change the page says it shows: one the editor has already moved past vouches for
   * nothing.
   */
  const notePageWorking = (revision?: number) => {
    if (healthyTimer.current) clearTimeout(healthyTimer.current);
    healthyTimer.current = null;
    const snap = getState().snapshot;
    if (!snap || (revision !== undefined && revision !== snap.revision)) return;
    const { workspaceKey, revision: at } = snap;
    const steps = appliedSteps(snap.history);
    const target = previewTarget();
    healthyTimer.current = setTimeout(() => {
      healthyTimer.current = null;
      const now = getState();
      if (now.previewIssue || now.snapshot?.workspaceKey !== workspaceKey || now.snapshot.revision !== at || previewTarget() !== target) return;
      healthy.current = { workspaceKey, target, steps };
    }, 1500);
  };
  /**
   * The page reported a problem: it has not been seen working with the project as it is now, and what the problem can
   * be put down to is kept with it. `revision` is the change the page had been told of; the editor's own may be newer
   * (a change's update can reach the page before word of the change does), and either may be the cause. A component
   * preview names its own (`studio`): one prepared before the latest change cannot be put down to it.
   */
  const noteIssue = (message: string, texts: Array<string | undefined>, revision: number | null, studio?: { definitionId: string; revision: number | undefined }) => {
    if (healthyTimer.current) clearTimeout(healthyTimer.current);
    healthyTimer.current = null;
    const snap = getState().snapshot;
    errorAt.current = Math.max(revision ?? 0, snap?.revision ?? 0);
    const base = healthy.current;
    const current = !studio || studio.revision === snap?.revision;
    const seen = current && base && snap && base.workspaceKey === snap.workspaceKey && base.target === previewTarget() ? base.steps : null;
    setIssueCause(snap ? { message, definitionId: studio?.definitionId ?? errorComponent(texts, snap.state.components, snap.dir), revert: revertStep(snap.history, seen) } : null);
  };
  useEffect(
    () => () => {
      if (healthyTimer.current) clearTimeout(healthyTimer.current);
    },
    []
  );
  const [slowPage, setSlowPage] = useState(false);
  /** Counts the changes the page has finished showing, so measurements of it can follow. */
  const [applied, setApplied] = useState(0);
  const markTimedOut = (on: boolean) => {
    timedOut.current = on;
    setSlowPage(on);
  };
  const frameReady = useStore((s) => s.frameReady);
  const workspaceKey = useStore((s) => s.snapshot?.workspaceKey);
  /** A visitor's journey through the site in Preview (see lib/preview-history): the frame's own history entries,
   *  and which of them were visited while previewing. Kept apart from project Undo. */
  const [journey, setJourneyState] = useState<VisitorHistory>(NO_HISTORY);
  const journeyRef = useRef(journey);
  const setJourney = (h: VisitorHistory) => {
    journeyRef.current = h;
    setJourneyState(h);
  };
  /** The frame's entry when Preview was entered, or null until the page reports one: a visitor who leaves it (a link,
   *  a section jump, Back or Forward) has moved on, and Edit then selects nothing again (see setMode). */
  const previewFrom = useRef<FrameEntry | null>(null);
  function visitorAt(at: FrameEntry) {
    const from = previewFrom.current;
    // The first entry of the page Edit would return to is where the visitor starts (a report of the page it replaces
    // is not).
    if (!from) {
      const back = getState().previewReturn;
      const route = back && getState().snapshot?.state.pages[back.pageId]?.route;
      if (route && samePath(addressPath(at.address), route)) previewFrom.current = at;
    } else if ((from.key !== at.key || from.address !== at.address) && getState().previewReturn) setState({ previewReturn: null });
  }
  const [dragging, setDragging] = useState(false);
  /** A frame resize in progress: the pointer, where it started, and the opening its width belongs to. */
  const resizeDrag = useRef<{ el: HTMLDivElement; pointer: number; x: number; from: number; zoom: number; opening: string | undefined; changed: boolean; onKey: (e: KeyboardEvent) => void } | null>(null);
  /** Resizing the frame by a handle, which alone lights the handles (a section drag does not). */
  const [resizing, setResizing] = useState<'left' | 'right' | null>(null);
  /** An inline text edit is open on the page: the selection and chip say so, with a way to finish. */
  const [editing, setEditing] = useState(false);
  /** Said to screen readers after a move, since the drop line and the new order are visual only. */
  const [announcement, setAnnouncement] = useState('');
  /** Ways the selection chip's Previous or Next item found no item showing the part in, for the selection and page as
   *  they were (see stepItemSelection). */
  const [stepBlocked, setStepBlocked] = useState<{ key: string; prev: boolean; next: boolean } | null>(null);
  // What the page shows can change without a new version of the project (an answer opened): a new pick asks again.
  useEffect(() => setStepBlocked(null), [selection && refKey(selection)]); // eslint-disable-line react-hooks/exhaustive-deps
  const menu = useMenu();
  /** The inline edit the editor started; the preview cannot commit text on its own. */
  /** Inline text edits in progress, with the project and the AI's activity when each began. */
  const pendingEdits = useRef(new Map<string, { ref: ElementRef; desc: string; base: ReturnType<typeof getState>['snapshot']; ai: number; code?: CodeTextTarget }>());
  /** The pages the editor asked the frame for, and which of its reports it follows (see lib/frame-nav). */
  const nav = useRef(newFrameNav());
  /** The list item the page was last asked to reveal (see syncReveal). */
  const sentReveal = useRef<RevealTarget | null>(null);
  /** The route the page last said it is showing, or null while a navigation the editor asked for is on its way. */
  const frameAt = useRef<string | null>(null);
  const frameLoadFailed = useRef(false);
  const recoverySeq = useRef(0);
  /** The frame session whose page has said it is ready at least once. */
  const readySession = useRef<string | null>(null);
  const measureWaiters = useRef(new Map<string, (rects: unknown) => void>());
  /** The selected element's padding, border and margin as the page last reported them, for its spacing handles. */
  const [spacing, setSpacing] = useState<FrameSpacing | null>(null);
  const spacingSeen = useRef('null');
  /** The selection just inserted, outlined with the arrival cue for a moment (see lib/arrival); `n` counts insertions. */
  const [arrival, setArrival] = useState<{ key: string; n: number } | null>(null);
  const arrivals = useRef(0);
  useEffect(() => {
    if (!arrival) return;
    // Only this cue ends: a next one may already be on its way to the screen.
    const t = setTimeout(() => setArrival((a) => (a === arrival ? null : a)), ARRIVAL_MS);
    return () => clearTimeout(t);
  }, [arrival]);
  // Preview hides it, and Edit after it shows the selection as it is, without the rest of a cue.
  useEffect(() => {
    if (mode !== 'edit') setArrival(null);
  }, [mode]);
  /** The element chain under the pointer in the page, so hover can be re-resolved when the selection changes. */
  const hoverChain = useRef<BridgeDesc[] | null>(null);
  /** While editing a component everywhere: the placement the last pick went through, and the one under the
   *  pointer. The component's own nodes are outlined through them. */
  const placementRef = useRef<ElementRef | null>(null);
  const hoverPlacement = useRef<ElementRef | null>(null);
  const shownHover = useRef<ElementRef | null>(null);
  const canvasHover = useRef<ElementRef | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** The canvas itself: where focus goes when the chip control that had it goes away. */
  const canvasRef = useRef<HTMLElement>(null);
  const [chipW, setChipW] = useState(0);
  /** The pointer is on the name of a short hovered element, which sits outside it, off the page, or on one of the
   *  hover's Add buttons. */
  const overTag = useRef(false);
  /** The page said the pointer left it while the pointer rested on the hover's name or Add button, and the hover was
   *  kept (see the 'hover' report). */
  const heldHover = useRef(false);
  /** Escape hides the hover tag (WCAG 1.4.13) until the pointer moves to another element. */
  const [tagHidden, setTagHidden] = useState(false);
  useEffect(() => setTagHidden(false), [hover && refKey(hover)]); // eslint-disable-line react-hooks/exhaustive-deps
  // A name that goes away under the pointer (dismissed, or its element no longer hovered) fires no pointer leave.
  useEffect(() => {
    overTag.current = false;
  }, [hover && refKey(hover), tagHidden]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // An open menu or Add list takes its own Escape.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !openMenus.count && getOverlay().hover && setTagHidden(true);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  /** While dragging to reorder: the insertion line in page pixels (null where the drop would change nothing) and
   *  the name of what is moving. */
  const [reorder, setReorder] = useState<{ line: Rect | null; name: string; clip?: EdgeView | null; refused?: Rect | null } | null>(null);
  /** While a tile from Insert, or the selection by its grip (`moving`), is dragged onto the page: what dropping where
   *  the pointer is does (in page pixels, the gap's line and the outline of the container it goes into; `refused` says
   *  why it can't go there). It changes only when what it draws does: the pointer itself is `insertPoint`. */
  const [insertDrop, setInsertDrop] = useState<{ name: string; moving?: boolean; over: boolean; line: Rect | null; outline: Rect | null; label: string; refused: string | null; surfaces: SlotSurface[]; clip?: EdgeView | null } | null>(null);
  /** Where the pointer of a drag onto the page is, for what it carries beside the pointer (DragGhost), which follows it
   *  without the canvas rendering again. */
  const insertPoint = useRef<DragPoint>({ x: 0, y: 0, moved: null });
  /** The drag onto the page that is running (see startCanvasDrop); `source`: the selection a move drags. */
  const insertDrag = useRef<{ end: (commit: boolean) => void; remeasure: () => void; source?: string } | null>(null);
  /** What the page measured the selected and hovered boxes for, so an Add button is drawn only on the box of what it
   *  belongs to, never on one measured for the selection before. */
  const rectsFor = useRef<{ selected: BridgeDesc | null; hovered: BridgeDesc | null }>({ selected: null, hovered: null });
  /** With timing marks on: the last report from the page as it came, and the hover whose outline is still to be painted,
   *  with when the pointer moved onto it in the page (the `canvas` scenario). */
  const lastReport = useRef('');
  const hoverTimed = useRef<{ key: string; at: number } | null>(null);
  /** The boxes of the empty slots a selected placement shows several of, each with what it was measured for, for their
   *  Add buttons (#657); kept only when they change, since the page reports every frame while it scrolls. */
  const [slotRects, setSlotRects] = useState<SlotBox[]>([]);
  const slotRectsSeen = useRef('[]');
  /** The others in a live session on this page (#768), and each one's box as the page last measured it, by key. */
  const peerMarks = useCanvasMarks();
  // What the page is asked to measure, so the page is asked again whenever any of it changes.
  const peerMarksKey = JSON.stringify(peerMarks.marks.map((m) => [m.key, m.ref, m.point]));
  const [markBoxes, setMarkBoxes] = useState<Record<string, Rect>>({});
  const markBoxesSeen = useRef('{}');
  /**
   * The Add button whose list is open (#387): its place, its button, where the button was drawn (in the overlay) and
   * its box on screen as it opened, what it offers, and the project, page and revision it was opened on (any change
   * puts it away). `empty`: why nothing fits, when its place is a slot that is full or takes nothing. `refused`: why the
   * last choice can't go there.
   */
  const [adding, setAdding] = useState<{ point: AddPoint; trigger: HTMLElement; at: { left: number; top: number }; box: AddBox; anchor: { left: number; top: number; width: number; height: number }; items: QuickItem[]; empty: string | null; opening: string; view: string; revision: number; refused: string | null } | null>(null);
  /** Set while a choice from it is being added, so a second Enter adds nothing more. */
  const choosing = useRef(false);
  /** An Add button has keyboard focus. One that goes away with it (its hover moved on, its section scrolled out of
   *  view) hands focus to the canvas rather than dropping it on the document. */
  const addFocused = useRef(false);
  useLayoutEffect(() => {
    if (!addFocused.current || canvasRef.current?.querySelector('.ov-add:focus')) return;
    addFocused.current = false;
    const a = document.activeElement;
    if (!a || a === document.body) canvasRef.current?.focus({ preventScroll: true });
  });
  /** While an image from Assets is dragged: where the pointer is, the image a drop there changes (outlined, in page
   *  pixels; none where no image takes it), and what the strip says. */
  const [imageDrop, setImageDrop] = useState<{ name: string; x: number; y: number; over: boolean; idle: boolean; outline: Rect | null; line: Rect | null; list: Rect | null; label: string; refused: string | null; surfaces: SlotSurface[]; clip: EdgeView | null } | null>(null);
  const assetDrag = useRef<{ end: (commit: boolean) => void; remeasure: () => void } | null>(null);
  /** The project revision the page shows: as it loads, the one the editor has; then each one it says it has applied. */
  const shownRevision = useRef(0);
  /** The selection asked to be shown (showSelection) before the page it is on arrived, by its refKey. */
  const showOnArrival = useRef<string | null>(null);
  /** The scroll to the selection as its page arrives: shown as asked, when it was asked to be shown on its way. */
  const arrivalScroll = (desc: BridgeDesc) => {
    const sel = getState().selection;
    const show = !!sel && showOnArrival.current === refKey(sel);
    showOnArrival.current = null;
    return show ? { desc, show } : { desc };
  };
  /**
   * Whether the page still shows an older version of the project than the editor has: a save's update has not reached
   * it yet (lib/page-gate). What is picked or measured on it would be the old page, so picks and canvas
   * edits wait, and work again once the page says it shows the new version, reports that the update failed, or has
   * been waited for long enough. A click made meanwhile is taken again then.
   */
  const gate = useRef<PageGate | null>(null);
  // The host's project in a live session has no fallback (#766): every change it sends is published to its preview and
  // followed by a reload, so a page behind it is shown again soon, and one that waited too long could be edited blind.
  gate.current ??= createPageGate(
    () => getState().snapshot?.revision ?? 0,
    undefined,
    () => (isRemoteShell(getState()) ? Infinity : PAGE_CATCH_UP_MS)
  );
  const pageBehind = () => gate.current!.behind();
  /** The latest render's handling of a message from the page, for a click the gate held to be taken with. */
  const pageMessage = useRef<((m: BridgeMessage, unmeasured: boolean, held?: HeldPick) => void) | null>(null);
  useEffect(() => () => gate.current?.drop(), []);
  /** The navigation and revision the frame of `session` last reported showing; reports about any other are stale. */
  const frameView = useRef<{ session: string; view: FrameView | null }>({ session: '', view: null });
  const url = runtime.state === 'ready' ? runtime.url : null;
  const origin = url ? new URL(url).origin : null;
  const state = snapshot?.state;
  const page = state && pageId ? state.pages[pageId] : null;
  // What the frame shows: the page, or a collection's layout on one of its entries (lib/template-view).
  const view = state ? shownView(state, pageId, templateMode) : null;
  // A layout with no entry to show it on keeps the page behind it, under its note, so the frame is there for what comes next.
  const initialRoute = view?.route ?? page?.route;
  /**
   * Component Studio (see lib/studio): the component edited everywhere shown on its own, in an isolated preview the
   * editor prepares for what the studio shows and the project as it is now. Each one is a new preview, loaded in a
   * frame of its own (a new session), so nothing the last one reports is taken for it. `studioAt` is the preview the
   * frame was given, and on which server; `studioLoads` numbers the requests, so only the latest is shown, and releases
   * every other preview's files.
   */
  const studioAt = useRef<{ url: string; path: string; revision: number | undefined; definitionId: string } | null>(null);
  /** What the preview in the frame (or on its way there) was made from, so the same request is never made twice. */
  const studioFrom = useRef<string | null>(null);
  /** The studio has stopped the frame taking picks until its first preview of the component arrives. */
  const studioPending = useRef(false);
  const studioLoads = useRef<StudioLoads | null>(null);
  studioLoads.current ??= new StudioLoads((key) => void api.project.releaseComponentPreview(key).catch(() => undefined));
  const [studioRetry, setStudioRetry] = useState(0);
  const studioView = useStore((s) => (s.definitionMode?.studio ? s.definitionMode : null));
  const variantStyle = useStore((s) => s.variantStyle);
  const studioDef = studioView && state && Object.hasOwn(state.components, studioView.definitionId) ? state.components[studioView.definitionId] : null;
  // A placement's content is read from the project as it is now: an edit to that placement (or its removal) is a new request.
  const studioPlacementState = studioView?.studio?.placement ? state : undefined;
  const studioRequest = useMemo(
    () => (studioView?.studio && studioDef ? JSON.stringify(studioSpec(studioDef, studioView.studio, variantStyle, studioPlacementState ?? undefined)) : null),
    [studioView, studioDef, variantStyle, studioPlacementState]
  );
  /** The frame shows (or is being given) a component preview, on the server running now. */
  const showsStudio = () => !!studioAt.current && studioAt.current.url === url;
  /** The name of the component edited everywhere, for what the canvas says about its preview. */
  const studioDefName = () => {
    const s = getState();
    const id = s.definitionMode?.definitionId;
    return id && s.snapshot && Object.hasOwn(s.snapshot.state.components, id) ? s.snapshot.state.components[id].name : undefined;
  };
  const initialSrc = useMemo(() => (url && studioAt.current?.url === url ? url + studioAt.current.path : url && initialRoute ? url + initialRoute : null), [url, session]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new frame (another server, or Try again) is not ready until it says so: nothing is sent to it before then.
  useEffect(() => {
    setState({ frameReady: false });
    setReady(false);
  }, [url, session]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoom = zoomSetting === 'fit' ? Math.min(1, (size.w - 56) / viewport) : zoomSetting;
  // Forms in Preview: the panel stands at the top of the canvas's foot.
  const formsShown = mode === 'preview' && forms.length > 0;
  const issueShown = !!frameError && runtime.state === 'ready';
  const runRef = useRef<HTMLDivElement>(null);
  const issueRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  // The canvas's foot (Canvas.css): the Previewing bar, the AI's notice, a page problem and Form practice, stacked
  // bottom-up in one column, each at its own height, so a bar that wraps lifts the ones above it. Measured in one place:
  // how far above the canvas floor its top stands (0 while nothing is in it), where Form practice starts, and the
  // canvas's height, which the page, the panel's height, the state card and the window's notices all keep clear of.
  const footRef = useRef<HTMLDivElement>(null);
  const [foot, setFoot] = useState({ top: 0, practice: 0, canvas: 0 });
  useLayoutEffect(() => {
    const el = footRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const measure = () => {
      const floor = canvas.getBoundingClientRect().bottom;
      const panel = el.querySelector<HTMLElement>(':scope > .form-practice');
      const top = el.offsetHeight ? Math.ceil(floor - el.getBoundingClientRect().top) : 0;
      const practice = panel ? Math.floor(floor - panel.getBoundingClientRect().bottom) : 0;
      const height = canvas.clientHeight;
      setFoot((was) => (was.top === top && was.practice === practice && was.canvas === height ? was : { top, practice, canvas: height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);
  // The window's notices stand above the foot too (lib/canvas-foot.ts).
  useLayoutEffect(() => canvasFoot(footRef.current), []);
  // Stop leaves the notice once the AI is stopping, and the notice leaves when the run ends: focus that was on it moves
  // to a control that stays. Read while rendering, because the button has gone by the time an effect runs.
  const focusInRun = useRef(false);
  focusInRun.current = !!runRef.current?.contains(document.activeElement);
  useLayoutEffect(() => {
    if (focusInRun.current && !runRef.current?.contains(document.activeElement)) (getState().mode === 'preview' ? exitRef.current : canvasRef.current)?.focus({ preventScroll: true });
  }, [runStatus]);
  // When the bar closes with focus in it, focus moves to a control that stays. Read while rendering, because the
  // bar has already left the page by the time an effect runs.
  const focusInIssue = useRef(false);
  focusInIssue.current = !!issueRef.current?.contains(document.activeElement);
  useLayoutEffect(() => {
    if (!issueShown && focusInIssue.current) (getState().mode === 'preview' ? exitRef.current : canvasRef.current)?.focus({ preventScroll: true });
  }, [issueShown]);
  // The panel and the page share the canvas above the bars below it: past this the panel scrolls, so the page keeps its
  // floor (PAGE_FLOOR at this zoom) with the pasteboard's padding and the frame's label above it and FOOT_CLEAR below.
  const practiceMax = Math.max(120, foot.canvas - foot.practice - (PASTEBOARD_PAD + FRAME_LABEL + FOOT_CLEAR) - PAGE_FLOOR * zoom);
  // While a restarted page loads, the pill keeps naming the page it is on.
  const address = journey.at?.address ?? view?.route ?? '';
  // How many characters the address slot holds. An address that does not fit keeps both of its ends in view.
  const addressRef = useRef<HTMLOutputElement>(null);
  const [addressFit, setAddressFit] = useState(Infinity);
  /** The whole address shows: keyboard focus is on an elided one, and Escape has not put it away. */
  const [addressOpen, setAddressOpen] = useState(false);
  useLayoutEffect(() => {
    const el = addressRef.current;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!el || !ctx) return;
    const measure = () => {
      const css = getComputedStyle(el);
      ctx.font = css.font;
      const room = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      setAddressFit(Math.max(3, Math.floor(room / ctx.measureText('0').width)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);
  const elided = elideAddress(address, addressFit);
  // While the foot holds anything, the pasteboard's scroll area ends FOOT_CLEAR above it, without its bottom padding, in
  // Edit and in Preview: no bar ever stands on the page's own foot (a footer's links, a form's Send button), and a page
  // held at its floor, or one scrolled at a fixed zoom, is clipped above the bars rather than passing under them.
  const footRoom = foot.top ? foot.top + FOOT_CLEAR : 0;
  // A collection's layout being edited has its band (TemplateStrip) over the pasteboard, which starts below it.
  const layoutBand = !!templateMode && mode === 'edit';
  // The frame's whole footprint (the pasteboard's padding above and below and the label's room) fits at Fit, so the
  // pasteboard needs no scrollbar of its own until the page is held at its floor.
  const frameH = Math.max(foot.top ? PAGE_FLOOR : 300, (size.h - (footRoom ? 1 : 2) * PASTEBOARD_PAD - FRAME_LABEL) / zoom);
  // Said once on opening a collection's layout and once on leaving it, as editing a component everywhere is; stepping
  // through its entries says nothing.
  const layoutKey = layoutBand && state && templateMode && Object.hasOwn(state.collections, templateMode.collectionId) ? `${layoutTitle(state, templateMode)}\n${layoutScope(state, templateMode)}` : null;
  const layoutSaid = useTransitionAnnouncement(layoutKey, (prev, next) => (next ? `Editing the ${next.split('\n')[0]}. ${next.split('\n')[1]}.` : prev ? `Finished editing the ${prev.split('\n')[0]}` : null));

  // While editing, a page that never says it has opened (no reply, no error) is reported as a problem after a while,
  // so the canvas offers Try again instead of saying "Opening…" for ever with the page closed to picks. A restart
  // (Try again) gets the same deadline, and its expiry hands Try again back, in Preview too. Otherwise Preview keeps its
  // own recovery: a visitor's own navigation is never timed.
  useEffect(() => {
    if (!url || frameReady || runtime.state !== 'ready' || (mode !== 'edit' && !retrying) || !(retrying || !frameError)) return;
    const t = setTimeout(() => {
      if (getState().frameReady) return;
      setRetrying(false);
      const s = getState();
      const shown = s.snapshot ? shownView(s.snapshot.state, s.pageId, s.templateMode) : null;
      const name = s.definitionMode?.studio ? studioDefName() : undefined;
      setFrameError(`${name ?? (shown?.template ? `The ${shown.title}` : shown ? `The ${shown.title} page` : 'The page')} took too long to open.`);
      markTimedOut(true);
    }, 20000);
    return () => clearTimeout(t);
  }, [url, session, view?.key, frameReady, frameError, retrying, mode, runtime.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page frame is centred, which can put its origin on half a device pixel; it is nudged onto a whole one, so the
  // page and the 1px keylines drawn over it are crisp (the overlay edges are snapped relative to this origin).
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const d = window.devicePixelRatio || 1;
    const frac = (v: number) => (((v * d) % 1) + 1) % 1 / d;
    const x = frac(r.left + nudge.x);
    const y = frac(r.top + nudge.y);
    if (Math.abs(x - nudge.x) > 0.01 || Math.abs(y - nudge.y) > 0.01) setNudge({ x, y });
  });

  /** The width label's three forms, measured off screen: the width; the width and zoom; and the width with its screen
   *  size and zoom. */
  const labelMeasure = useRef<HTMLSpanElement>(null);
  const [labelW, setLabelW] = useState({ short: 60, mid: 100, full: 200 });
  /** What the strip shows on its left (a page opening, a section moving), and how wide it is. */
  const stripLeft = useRef<HTMLDivElement>(null);
  const [stripLeftW, setStripLeftW] = useState(0);
  useLayoutEffect(() => {
    const [short, mid, full] = [...(labelMeasure.current?.children ?? [])].map((el) => (el as HTMLElement).offsetWidth);
    if (short && mid && full && (short !== labelW.short || mid !== labelW.mid || full !== labelW.full)) setLabelW({ short, mid, full });
    const left = stripLeft.current?.offsetWidth ?? 0;
    if (left !== stripLeftW) setStripLeftW(left);
  });

  /** A page with nothing on it (only the shared header and footer, if it shows them): the canvas offers the first
   *  step between them, where the page's sections will go. The page keeps that much room in its empty <main> while
   *  editing, and reports where it is with its other outlines, so the card follows a scroll. */
  const emptyPage = mode === 'edit' && !definitionMode && !templateMode && !!page && page.rootIds.length === 0;
  /** A page with only its title (see titleOnlyPage): the strip offers the same first steps as an empty page. A project
   *  open read-only takes none of them. */
  const titleOnly = mode === 'edit' && !definitionMode && !templateMode && !!page && !!state && !snapshot?.readOnly && titleOnlyPage(state, page);
  const [emptyArea, setEmptyArea] = useState<FrameEmptyArea | null>(null);
  // Cleared only when the page changes or stops being empty, so the card does not blink while the frame is resized.
  useEffect(() => setEmptyArea(null), [session, pageId, emptyPage]);
  /** The card's height as last drawn (its actions wrap in a narrow page); until then, its height on one row. */
  const emptyCardRef = useRef<HTMLDivElement>(null);
  const [emptyCardH, setEmptyCardH] = useState(186);
  useLayoutEffect(() => {
    const h = emptyCardRef.current?.offsetHeight;
    if (h && h !== emptyCardH) setEmptyCardH(h);
  });
  // While the strip stands in for the card it can't be measured, so a frame of another width is tried afresh.
  useEffect(() => {
    if (!emptyCardRef.current) setEmptyCardH(186);
  }, [viewport * zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  // The card and the same space above and below it, in page pixels.
  const emptyRoom = Math.ceil((emptyCardH + 48) / zoom);
  useEffect(() => {
    if (!frameReady) return;
    const st = getState().snapshot?.state;
    if (!emptyPage || !page || !st) return post('emptySpace', { space: null });
    const header = showsPart(page, 'header') ? st.site.shell.header.rootIds.flatMap((id) => descOf(st, { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: id }) ?? []) : [];
    post('emptySpace', { space: { key: page.id, height: emptyRoom, header } });
    // Said again to every page the frame loads or arrives at (formsView counts those), and after every change it shows.
  }, [emptyPage, emptyRoom, frameReady, pageId, formsView, snapshot?.revision, applied]); // eslint-disable-line react-hooks/exhaustive-deps

  /** What the frame of the current session shows, as it last reported (null before it reported a page). */
  const viewNow = () => (frameView.current.session === session ? frameView.current.view : null);
  const post = (type: string, payload: unknown = {}) => postToFrame(frameRef.current, origin, session, type, payload, viewNow());
  const recoverRoute = (route: string, revision: number, openingSession: string) => {
    const seq = ++recoverySeq.current;
    void (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const frame = frameRef.current;
        if (seq !== recoverySeq.current || !frame || frame.name !== openingSession) return;
        if (samePath(route, frameAt.current) && !frameLoadFailed.current) return;
        const live = getState().runtime;
        if (live.state !== 'ready') continue;
        const canServe = await api.project.previewRouteReady(route, revision).catch(() => false);
        if (seq !== recoverySeq.current || !canServe || frameRef.current !== frame) continue;
        if (samePath(route, frameAt.current) && !frameLoadFailed.current) return;
        frameLoadFailed.current = false;
        frame.src = live.url + route;
        return;
      }
    })();
  };
  useEffect(() => api.on('preview:load-failed', ({ url: failedUrl }) => {
    const frame = frameRef.current;
    if (!origin || !frame || frame.name !== session) return;
    let failed: URL;
    try { failed = new URL(failedUrl); } catch { return; }
    if (failed.origin !== origin) return;
    const requested = nav.current.request?.path;
    const loaded = frameAt.current;
    const initial = new URL(frame.src).pathname;
    if (![requested, loaded, initial].some((path) => path && samePath(failed.pathname, path))) return;
    frameLoadFailed.current = true;
    frameAt.current = null;
    setState({ frameReady: false });
    const s = getState();
    const shown = s.snapshot ? shownView(s.snapshot.state, s.pageId, s.templateMode) : null;
    if (shown?.route) recoverRoute(shown.route, s.snapshot!.revision, session);
  }), [origin, session]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The selection's outline while the page scrolls (#1307): the page draws it in its own document, which its compositor
   * moves with the page in the same frame, where the editor's own would follow a frame behind. `ghostKey` is what the
   * page should draw as this render has it (set below, from the outline's own conditions), null whenever the editor
   * draws anything but the plain outline; `paged` is the selection whose outline the page says it is drawing, and the
   * key it drew it for, while the editor's own (and the controls on it, which would trail) is kept out of sight.
   */
  const ghostKey = useRef<string | null>(null);
  const ghostSent = useRef<string | null | undefined>(undefined);
  const [paged, setPaged] = useState<string | null>(null);
  // Not drawing the plain outline (nothing selected, Preview, a frame on its way, a control in use): whatever the page
  // said of its own no longer stands, and is not reused once the outline is drawn again before it says it anew.
  useEffect(() => {
    if (paged && !ghostKey.current) setPaged(null);
  });
  const pagedWas = useRef(false);
  function syncGhost(force = false) {
    const key = ghostKey.current;
    if (!force && key === ghostSent.current) return;
    ghostSent.current = key;
    if (!key) return post('outlineGhost', { spec: null });
    const { pad, z } = JSON.parse(key) as { pad: number; z: number };
    const color = (canvasRef.current && getComputedStyle(canvasRef.current).getPropertyValue('--select').trim()) || '#1766c0';
    post('outlineGhost', { spec: { key, color, pad, z } });
  }
  useEffect(() => syncGhost());
  // A frame of another session knows nothing of it.
  useEffect(() => {
    ghostSent.current = undefined;
    setPaged(null);
  }, [session]);
  // The editor's outline is back where the page's is: once a frame has shown it, the page's can go.
  useEffect(() => {
    if (paged) {
      pagedWas.current = true;
      return;
    }
    if (!pagedWas.current) return;
    pagedWas.current = false;
    let second = 0;
    const first = requestAnimationFrame(() => (second = requestAnimationFrame(() => post('outlineGhostDone'))));
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [paged]); // eslint-disable-line react-hooks/exhaustive-deps
  // Saving or leaving the project asks the preview to hand back an inline edit that is still open.
  useEffect(() => {
    setCanvasCommit(() => post('commitTextEdit'));
    return () => setCanvasCommit(null);
  });

  // Reset the frame whenever the preview server changes.
  useEffect(() => {
    setReady(false);
    setSession(newSessionId());
  }, [url]);

  /**
   * The host's preview changed, in a live session this app is a guest in (#766): no hot update reaches the page
   * through the relay, so the page is loaded again in a frame of its own (a new session), and the revision that frame
   * shows is the one the host had said its preview serves as it started loading. A report from an earlier frame is
   * another session's, so no page loaded before a change can pass for one after it. An inline edit open on the page is
   * left to finish first: the reload follows it.
   */
  const remoteReloadSeq = useStore((s) => (isRemoteShell(s) ? s.remoteReload.seq : 0));
  const remoteReloadOwed = useRef(false);
  const mounted = useRef(true);
  /**
   * The revision each frame's page shows, read as the frame is made: in the render that gives it its address, before
   * the page can start loading, so nothing published after that is taken for what it shows.
   */
  const frameRevision = useRef<{ session: string; revision: number } | null>(null);
  if (frameRevision.current?.session !== session) frameRevision.current = { session, revision: loadedRevision(getState()) };
  const reloadRemoteFrame = () => {
    if (!mounted.current) return;
    if (inlineEdit.active) return void (remoteReloadOwed.current = true);
    remoteReloadOwed.current = false;
    setSession(newSessionId());
  };
  useEffect(() => {
    if (remoteReloadSeq) reloadRemoteFrame();
  }, [remoteReloadSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** The inline edit is over (committed, cancelled, or its page went away): shortcuts work again. */
  function endInlineEdit(editId?: string) {
    if (editId === undefined) pendingEdits.current.clear();
    else pendingEdits.current.delete(editId);
    inlineEdit.active = pendingEdits.current.size > 0;
    setEditing(inlineEdit.active);
    markDraft(CANVAS_DRAFT, inlineEdit.active);
    // A reload of the host's preview waited for the edit (#766): its text is on its way to the host now.
    if (!inlineEdit.active && remoteReloadOwed.current) setTimeout(reloadRemoteFrame);
  }
  /** Start editing an element's text on the page (a double-click, or Edit text in its menu). A double-click passes
   *  its gesture id (`hit`) so the edit starts at the word clicked. Text a code placement's author marked (`code`) is
   *  edited where `desc` finds it, while `ref` (the placement, or its part) stays selected. */
  function beginTextEdit(ref: ElementRef, desc: BridgeDesc, hit?: string, code?: CodeTextTarget) {
    // A Component Studio preview made before the project's latest change shows text that may be gone: typing over it
    // would put it back. The next preview is on its way.
    if (showsStudio() && studioAt.current!.revision !== getState().snapshot?.revision) {
      toast('The preview is catching up with the latest change. Try again in a moment.', 'info');
      return;
    }
    // Nor is text on a page a save has not reached yet (#755): it is about to be replaced.
    if (pageBehind()) return;
    const editId = Math.random().toString(36).slice(2);
    pendingEdits.current.set(editId, { ref, desc: editDescKey(desc), base: getState().snapshot, ai: aiActivity(), ...(code ? { code } : {}) });
    inlineEdit.active = true;
    setEditing(true);
    markDraft(CANVAS_DRAFT, true);
    // Marked text is edited as the text its property is: the page refuses an element that shows it otherwise.
    post('beginTextEdit', { desc, editId, hit, ...(code ? { rich: code.rich } : {}) });
  }
  /** Edit text from the editor's own controls (the chip's Edit text, or the menu's): the page takes focus for it,
   *  after a menu has closed and handed focus back, so the edit keeps the focus it is given. */
  function startTextEditFromChrome(ref: ElementRef) {
    setState({ selection: ref });
    setTimeout(() => {
      const desc = descFor(ref);
      if (!desc || !canInlineEdit(ref) || pageBehind()) return;
      frameRef.current?.focus();
      beginTextEdit(ref, desc);
    }, 60);
  }
  /** Run a move of the selection and tell screen readers where it went among its siblings, from and to. */
  async function announcedMove(move: () => Promise<unknown>) {
    const before = getState().snapshot?.state;
    const t = structuralTarget(getState().selection);
    const from = before && t ? siblings(before, t) : null;
    const name = before && t ? chromeLabel(before, t) : '';
    await move();
    const after = getState().snapshot?.state;
    const to = after && t && resolveRef(after, t).node ? siblings(after, t) : null;
    if (!from || !to || from.index === to.index) return;
    setAnnouncement(`${name} moved from position ${from.index + 1} to ${to.index + 1} of ${to.count}.`);
  }
  // A new page load (another server, Try again) or closing the editor ends any edit the old page had open.
  useEffect(() => {
    frameAt.current = null;
    nav.current = newFrameNav();
    frameTextFocus.active = false;
    endInlineEdit();
  }, [url, session]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new frame (another server, Try again) or another project starts a fresh journey, on the site as it is now.
  useEffect(() => setJourney({ ...NO_HISTORY, site: siteNow() }), [url, session, workspaceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // An address visited in one opening of a project (a post previewed) is nothing to another.
  useEffect(() => {
    visitWanted = null;
  }, [workspaceKey]);
  useEffect(() => () => endInlineEdit(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Component Studio: a preview of what it shows, prepared again whenever that or the project changes (a quick run of
  // changes is one preview). While an inline text edit is open the frame is left as it is, since replacing it would
  // lose what is being typed: the edit's own commit changes the project, and the preview after it follows.
  useEffect(() => {
    const loads = studioLoads.current!;
    if (!studioRequest || !url || editing) return void loads.supersede();
    const revision = getState().snapshot?.revision;
    // The preview shown already (an inline edit cancelled, say, changes nothing) is kept, with what the author opened in it.
    const from = JSON.stringify([studioRequest, revision, url, workspaceKey, studioRetry]);
    if (from === studioFrom.current && showsStudio()) {
      // Back to what is shown (Long copy, then Starting content again, before it arrived): what was on its way is
      // dropped, and the preview on screen takes picks again.
      loads.supersede();
      if (studioPending.current && readySession.current === session) {
        studioPending.current = false;
        setState({ frameReady: true });
      }
      return;
    }
    const request = loads.begin();
    const spec = JSON.parse(studioRequest) as { definitionId: string };
    // Until the first preview of this component is there, what the frame shows (the page, or another component) is
    // not what is being edited: it takes no picks.
    const first = !showsStudio() || studioAt.current!.definitionId !== spec.definitionId;
    if (first) {
      studioPending.current = true;
      setState({ frameReady: false });
    }
    const server = url;
    const failed = (message: string) => {
      if (!loads.latest(request)) return;
      setFrameError(message);
      setRetrying(false);
    };
    const timer = setTimeout(
      () =>
        api.project.prepareComponentPreview(spec).then(
          (prepared) => {
            if (!prepared.ok) return failed(prepared.message);
            if (!loads.prepared(request, prepared.key)) return;
            studioAt.current = { url: server, path: prepared.path, revision, definitionId: prepared.definitionId };
            studioFrom.current = from;
            setSession(newSessionId());
          },
          (e: unknown) => failed(`The component preview could not be prepared: ${e instanceof Error ? e.message : String(e)}`)
        ),
      first ? 0 : 120
    );
    return () => clearTimeout(timer);
  }, [studioRequest, snapshot?.revision, url, workspaceKey, editing, studioRetry]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the studio releases its preview, and the frame opens the page again.
  // An inline edit still open there is finished first (committed, or kept for the author when it no longer can be), so
  // leaving never loses what was typed; a preview that does not answer is left without it after a while.
  const inStudio = !!studioView;
  useEffect(() => {
    if (inStudio) return;
    studioLoads.current!.end();
    studioFrom.current = null;
    // Left before the first preview arrived: the page it stopped taking picks is opened again.
    const pending = studioPending.current;
    studioPending.current = false;
    if (!studioAt.current) return void (pending && setSession(newSessionId()));
    if (editing) {
      post('commitTextEdit');
      // A preview that does not answer at all can no longer give the text back.
      const t = setTimeout(() => endInlineEdit(), 10000);
      return () => clearTimeout(t);
    }
    studioAt.current = null;
    setSession(newSessionId());
  }, [inStudio, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => studioLoads.current?.end(), []);

  // Bridge messages
  useEffect(() => {
    const handle = (m: BridgeMessage, unmeasured: boolean, held?: HeldPick) => {
      const s = getState();
      const st = s.snapshot?.state;
      const p = m.payload as Record<string, unknown>;
      // A click held for the page to catch up is taken only on the frame, the navigation, the page and the way of
      // editing it was made in, while nothing else has been selected since (in Layers, say), and only when the element clicked is still in
      // the project, inside what the page showed around it.
      if (held && (held.session !== session || m.navigationId !== viewNow()?.navigationId || held.scene !== sceneKey(s) || held.selection !== selectionKey(s) || !st || !clickTargetIn(st, chainOf(p.chain)))) return;
      // While a save is publishing, a pick waits for the page to show it (#755): a click is taken again
      // once the page catches up, resolved against the project as it is then; a double-click or menu is dropped, and so
      // is any pick the canvas would not take anyway (one from a page that is leaving).
      const gated = gatedPick(m.type, s.mode);
      if (gated && pageBehind()) {
        if (gated === 'hold' && st && s.frameReady && !leavingForPage() && !canvasCovered(activeWorkspace(s))) {
          const at: HeldPick = { session, scene: sceneKey(s), selection: selectionKey(s) };
          // Taken after whatever opened the gate (a page's `ready`) has finished with the frame.
          gate.current!.hold(() => setTimeout(() => pageMessage.current?.(m, false, at)));
        }
        return;
      }
      switch (m.type) {
        case 'ready': {
          const path = String(p.path);
          const intended = s.snapshot ? shownView(s.snapshot.state, s.pageId, s.templateMode) : null;
          if (intended?.route && samePath(intended.route, path) && typeof p.title === 'string' && /^Error (404|500)$/.test(p.title)) {
            frameLoadFailed.current = true;
            frameAt.current = null;
            setState({ frameReady: false });
            recoverRoute(intended.route, s.snapshot!.revision, session);
            break;
          }
          // A component preview reports whether the component is on the page; only the one the frame was last given counts.
          const studio = showsStudio();
          // A preview of a component the author has since moved on from is set up, but takes no picks until they come
          // back to it (or the next preview replaces it).
          let elsewhere = false;
          if (studio) {
            const shown = p.preview as { key?: unknown; mounted?: unknown; error?: unknown } | undefined;
            if (!studioLoads.current!.shows(shown?.key)) break;
            elsewhere = studioAt.current!.definitionId !== s.definitionMode?.definitionId;
            if (shown?.mounted !== true) {
              // Another component's failure is not this one's to report.
              if (elsewhere) break;
              const name = studioDefName() ?? 'The component';
              const failed = `${name} couldn’t be shown${typeof shown?.error === 'string' && shown.error ? `: ${shown.error.slice(0, 300)}` : '.'}`;
              // The component shown is the one that failed, and the change that failed it can be reverted.
              noteIssue(failed, [], null, studioAt.current!);
              setFrameError(failed);
              setRetrying(false);
              markTimedOut(false);
              break;
            }
            if (!elsewhere) studioPending.current = false;
          }
          // A page loaded in full inside the same frame while previewing (a visitor's Back across documents) is
          // followed, so the editor and the frame agree on the page.
          // A page loaded again while an image from Assets is dragged over it will answer nothing the drag asked: it ends.
          assetDrag.current?.end(false);
          // The page shows the project as the preview served it: the editor's revision locally, and for the host's
          // project in a live session, the revision its host last said its preview serves (#766).
          shownRevision.current = isRemoteShell(s) && frameRevision.current?.session === session ? frameRevision.current.revision : loadedRevision(s);
          gate.current!.shown(shownRevision.current);
          const sameFrame = readySession.current === session;
          const reloaded = sameFrame && s.mode === 'preview';
          readySession.current = session;
          // The page's bridge is ready for the author to work on it (src/shared/perf.ts).
          perfMark('canvas.ready', { revision: shownRevision.current, path, mode: s.mode, studio });
          // The visitor left the page they were on.
          if (reloaded && s.previewReturn) setState({ previewReturn: null });
          setReady(true);
          frameLoadFailed.current = false;
          // A page that arrives after Component Studio was opened, before its first preview, takes no picks either.
          setState({ frameReady: !elsewhere && (studio || !studioPending.current) });
          // What is reported about the preview on its way (it could not be prepared) stays until that one arrives.
          if (!elsewhere) {
            setFrameError(null);
            setRetrying(false);
            markTimedOut(false);
            errorAt.current = null;
          }
          frameAt.current = path;
          // A visitor may open another page while an earlier editor route's recovery timer is waiting. That timer
          // belongs to the page it asked for and must never send the visitor back after this page has loaded.
          if (s.mode === 'preview' && !nav.current.request) recoverySeq.current++;
          // Scheduled once the frame's page is known, which the baseline belongs to.
          if (!elsewhere) notePageWorking();
          // A page loaded in full while the frame was already up (Try again, a load that could not go in place) shows the
          // selection, as an arrival in place does (`navigated`); the first load scrolls to it once the frame is ready.
          if ((studio || ready || nav.current.request) && getState().mode !== 'preview' && (studio || (view?.route && samePath(view.route, path)))) {
            const desc = descFor(getState().selection);
            if (desc) post('scrollTo', arrivalScroll(desc));
          }
          frameTextFocus.active = false;
          endInlineEdit();
          post('mode', { mode: getState().mode });
          // A new page load knows nothing of the last one's forms or sends.
          setForms([]);
          setLastSend(null);
          setLiveRequest(null);
          setFormsView((v) => v + 1);
          post('formPractice', { result: practice });
          syncTrack();
          // A new page load draws no outline of its own until it scrolls.
          setPaged(null);
          syncGhost(true);
          // A new page starts with nothing revealed.
          sentReveal.current = null;
          syncReveal();
          syncForcedState();
          // A component preview has no address of its own to go to: the frame stays on it.
          if (studio) break;
          const request = nav.current.request;
          if (!sameFrame) {
            // A new frame (another server, Try again) opened the page shown when it was made, and a request sent
            // while it loaded never reached it: it is asked for the page shown now. Try again keeps the preview
            // ready, so the navigate effect does not run for it.
            nav.current.request = null;
            // An address visitAddress opened (a post previewed) is opened again in the new frame.
            if (visitWanted) visit(visitWanted, visitWantedReload);
            else if (viewKey(s)) openShownPage();
            else {
              syncPage(path);
              followed(nav.current, viewKey(getState()));
            }
          } else if (request) {
            // A new document loaded while the editor's request was on its way (the request's own fallback, or a
            // visitor's link): the request still stands, and goes to the new document if it is not there already.
            if (samePath(path, request.path)) nav.current.request = null;
            else {
              frameAt.current = null;
              post('navigate', { path: request.path, navId: request.id });
            }
          }
          // A page chosen in the editor that the frame has not been asked for yet wins: the navigate effect opens it.
          else if (reloaded && viewKey(s) === nav.current.asked) {
            syncPage(path);
            followed(nav.current, viewKey(getState()));
          }
          // A document a visitor opened in full that loads after Edit began goes back to the editor's page.
          else if (sameFrame) backToShownPage(path);
          notePostPreviewAt(path);
          break;
        }
        case 'history': {
          if (showsStudio()) break;
          const at = frameEntry(p);
          if (at && getState().mode === 'preview') visitorAt(at);
          if (at) setJourney(observe(journeyRef.current, at, getState().mode === 'preview'));
          break;
        }
        case 'colorScheme':
          // The site's Light/Dark switch, pressed in the preview: the canvas previews that palette, as its own control would.
          if ((p.scheme === 'light' || p.scheme === 'dark') && hasDarkPalette(st?.tokens)) setState({ previewScheme: p.scheme });
          break;
        case 'navigated': {
          if (showsStudio()) break;
          // Only the report for the page the editor last asked for counts while that request is on its way: a late
          // report for an earlier one must not switch back to a page the author has since left. In Preview, a
          // visitor's own link clicks then move the editor along with them; while editing, the page goes
          // nowhere the editor did not send it.
          const path = String(p.path);
          if (!followReport(nav.current, path, typeof p.navId === 'number' ? p.navId : null, viewKey(getState()), getState().mode === 'preview')) {
            // A visitor's own step that lands after Edit began goes back to the editor's page.
            if (typeof p.navId !== 'number') backToShownPage(path);
            break;
          }
          // The page the frame is showing, so following it below does not send the frame back there (which would
          // drop a #section the visitor's link went to, and its scroll position).
          frameAt.current = path;
          if (getState().mode === 'preview' && typeof p.navId !== 'number') recoverySeq.current++;
          notePostPreviewAt(path);
          // The page arrived: it counts as working once it has gone a moment without an error.
          if (!getState().previewIssue) notePageWorking();
          // In Preview the page the frame is on is a visit, also when the editor opened it (the page picker).
          const at = journeyRef.current.at;
          if (getState().mode === 'preview' && at && samePath(addressPath(at.address), path)) setJourney(observe(journeyRef.current, at, true));
          // An open edit is not ended here: one in the shared header outlives the page change, and the page
          // ends any other (its element goes away) with its own cancel.
          setState({ frameReady: !studioPending.current });
          // A page that arrived after the canvas reported it as too slow is no longer a problem.
          if (timedOut.current) {
            markTimedOut(false);
            setFrameError(null);
            setRetrying(false);
          }
          syncPage(path);
          followed(nav.current, viewKey(getState()));
          // A visitor's step followed in Edit (the frame was never asked for a page, so any address is followed) that
          // left the editor's page goes back to it.
          if (typeof p.navId !== 'number') backToShownPage(path);
          // What is outlined may be shown through a different placement on this page.
          syncTrack();
          // What the panel said about the last page's sends is not about this one, and nor is a live test's answer.
          setLastSend(null);
          setLiveRequest(null);
          setFormsView((v) => v + 1);
          // A selection made with the page change (a usage list showing a placement on another page) asked to be
          // scrolled to before this page was there: now it is.
          if (getState().mode !== 'preview') {
            const desc = descFor(getState().selection);
            if (desc) post('scrollTo', arrivalScroll(desc));
          }
          break;
        }
        case 'hover': {
          const chain = chainOf(p.chain);
          // The pointer left the page for the name of what it was over, or for its Add button: the hover stays (WCAG 1.4.13).
          if (!chain.length && overTag.current) {
            heldHover.current = true;
            break;
          }
          // Back on the page after a kept hover: the page dropped what it outlined when the pointer left, so it is told
          // again even when the hover is the same.
          const held = heldHover.current;
          heldHover.current = false;
          hoverChain.current = chain;
          const was = perfOn ? getOverlay().hover : null;
          resolveHover();
          if (held) syncTrack();
          // The pointer reached another element: its outline is timed from the move in the page to the frame that
          // paints it (the `canvas` scenario).
          if (perfOn) {
            perfCount('canvas.hoverReports');
            const now = getOverlay().hover;
            if (now && !sameRef(now, was)) hoverTimed.current = { key: refKey(now), at: typeof p.at === 'number' ? p.at : NaN };
          }
          break;
        }
        case 'rects': {
          if (perfOn) {
            perfCount('canvas.rectReports');
            // The page's own time measuring is not part of what it reports.
            const { measureMs: _measureMs, ...report } = p;
            const seen = JSON.stringify(report);
            if (seen === lastReport.current) perfCount('canvas.rectReportsSame');
            lastReport.current = seen;
          }
          const hovered = rectList(p.hovered);
          const selected = rectList(p.selected);
          // The page drawing the selection's outline as it scrolls, as the editor would draw it now (the key it was drawn
          // for: the room, the zoom, the colour), for the selection the editor has: its own steps aside.
          const sel = s.selection;
          setPaged(typeof p.ghost === 'string' && p.ghost === ghostKey.current && sel && JSON.stringify(descFor(sel)) === JSON.stringify(p.selectedDesc ?? null) ? JSON.stringify([refKey(sel), p.ghost]) : null);
          // The pointer is on the name of what it was over (or its Add button): that element keeps its outline while it
          // rests there.
          const kept = !hovered.length && overTag.current;
          const measuredBefore = rectsFor.current;
          rectsFor.current = { selected: descOrNull(p.selectedDesc), hovered: kept ? rectsFor.current.hovered : descOrNull(p.hoveredDesc) };
          // A list that did not move keeps the one drawn, and a report where nothing moved changes nothing: the canvas is
          // not drawn again for it (the page reports every frame while anything moves). One measured for something else
          // is drawn, even with the same boxes: two elements can share a box, and what is drawn on it (an Add button)
          // belongs to the one it was measured for.
          const was = getOverlay().rects;
          const next = { selected: sameRects(selected, was.selected), hovered: kept ? was.hovered : sameRects(hovered, was.hovered), revealed: sameRects(rectList(p.revealed), was.revealed), headers: sameRects(rectList(p.headers), was.headers) };
          const remeasured = !sameMeasured(measuredBefore.selected, rectsFor.current.selected) || !sameMeasured(measuredBefore.hovered, rectsFor.current.hovered);
          if (remeasured || next.selected !== was.selected || next.hovered !== was.hovered || next.revealed !== was.revealed || next.headers !== was.headers) setOverlay({ rects: next });
          // The others' marks: kept only when they move, as the slots' are.
          const peerBoxes: Record<string, Rect> = {};
          if (Array.isArray(p.marks)) for (const m of p.marks.slice(0, 32)) if (m && typeof m.key === 'string') for (const r of rectList([m.box])) peerBoxes[m.key] = r;
          const peerSeen = JSON.stringify(peerBoxes);
          if (peerSeen !== markBoxesSeen.current) {
            markBoxesSeen.current = peerSeen;
            setMarkBoxes(peerBoxes);
          }
          const slots = slotBoxes(p.slots);
          const slotsSeen = JSON.stringify(slots);
          if (slotsSeen !== slotRectsSeen.current) {
            slotRectsSeen.current = slotsSeen;
            setSlotRects(slots);
          }
          // An element just inserted now shows in view (mounted, and scrolled to): its outline arrives with a brief
          // highlight. Only for a report measured for it, on its own page, while its outline is drawn (editing, the
          // frame showing the page the editor has, Site styles closed).
          const shownPage = st && s.pageId ? st.pages[s.pageId] : null;
          const drawn = s.mode === 'edit' && s.frameReady && !(s.rightTab === 'styles' && s.dockOpen);
          const own = drawn && shownPage && samePath(shownPage.route, frameAt.current) ? descFor(s.selection) : null;
          if (takeArrival(s.selection, arrivalShown(descOrNull(p.selectedDesc), own, selected[0], p.viewport)) && s.selection) setArrival({ key: refKey(s.selection), n: ++arrivals.current });
          const area = emptyAreaOf(p.empty);
          setEmptyArea((was) => (JSON.stringify(was) === JSON.stringify(area) ? was : area));
          // Kept only when it changes: the page reports every frame while it scrolls.
          const sp = spacingOf(p.spacing);
          const seen = JSON.stringify(sp);
          if (seen !== spacingSeen.current) {
            spacingSeen.current = seen;
            setSpacing(sp);
          }
          break;
        }
        case 'select': {
          // A pick on a page the editor has not yet confirmed (one leaving) selects nothing: also one made while another
          // page chosen in Pages a moment ago waits to open, which then opens. Nor does one that arrives once a workspace
          // covers the canvas (#700): the page is out of sight. One on a page a save has not reached yet waits for it
          // (#735, #755: see the gate above the switch).
          if (!st || !s.frameReady || leavingForPage() || canvasCovered(activeWorkspace(s))) return;
          perfMark('canvas.select');
          pagePick();
          const chain = chainOf(p.chain);
          const next = pick(chain, !!p.alt || !!p.meta);
          selectOnPage(next);
          if (next && s.rightTab === 'styles') setState({ rightTab: 'inspect' });
          // A press of the pointer on the page makes the selection the keyboard's target (lib/clip-keys, #1361). Blurred
          // rather than moved, as pagePick does: the window's last input was a key, so a moved focus would draw a ring.
          if (keyboardLeavesPage(keyboardAt(s), { pointer: p.pointer, picked: !!next, held: !!held })) frameRef.current?.blur();
          break;
        }
        case 'dblclick': {
          if (!st || !s.frameReady || leavingForPage() || canvasCovered(activeWorkspace(s))) return;
          const chain = chainOf(p.chain);
          const ref = pick(chain, true);
          // Text a code placement's author marked as showing one of its properties, or a list item's field: typed
          // over where it shows, with what the double-click selects (the placement, or its part) selected.
          const bound = bindDescOf(p.bind);
          const code = bound && ref && !s.definitionMode ? codeTextTarget(st, bound) : null;
          if (ref && bound && canInlineEditCode(code)) {
            selectOnPage(ref);
            const hit = typeof p.hit === 'string' && p.hit.length <= 20 ? p.hit : undefined;
            beginTextEdit(ref, bound, hit, code);
            break;
          }
          // In Component Studio the element double-clicked is the one edited, as the preview names it: a list's item
          // the selection leaves out (one only a sample has, or one inside another list's item) is still that item.
          const clicked = ref && s.definitionMode?.studio ? studioClicked(chain, ref) : null;
          const desc = ref && canInlineEdit(ref) ? (clicked ?? descFor(ref)) : null;
          if (ref && desc) {
            selectOnPage(ref);
            // The double-click it answers, so the edit starts at the word clicked (and not after a newer one).
            const hit = typeof p.hit === 'string' && p.hit.length <= 20 ? p.hit : undefined;
            beginTextEdit(ref, desc, hit);
          } else if (ref) {
            selectOnPage(ref, { rightTab: 'inspect' });
            const r = resolveRef(st, ref);
            const bound = r.node?.kind === 'text' ? r.node.text : r.node?.kind === 'link' ? r.node.label : undefined;
            // A News card or article header shows a page's article details, changed in that page's settings.
            if (computedAt(st, ref, bound)) toast('This comes from the article’s page settings. Open the article’s page to change its title, date, byline or excerpt.', 'info');
            else if (ref.owner.kind === 'template' && (r.node?.kind === 'text' || r.node?.kind === 'link'))
              toast('This shows each entry’s own words, so it is edited in the entry. Choose what it shows in the Inspector.', 'info');
            else if (r.node?.kind === 'text' || r.node?.kind === 'link')
              toast(
                s.definitionMode && inDefinition(ref, s.definitionMode.definitionId)
                  ? 'Each placement fills in this text. Change its default in the Inspector, or click Done editing to change it on a page.'
                  : 'This text is part of the component design. Use Edit everywhere or Make unique to change it.'
              );
          }
          break;
        }
        case 'textCommit': {
          const editId = String(p.editId);
          const edit = pendingEdits.current.get(editId);
          if (!edit) break;
          endInlineEdit(editId);
          const d = descOrNull(p.desc);
          // Accept only the commit for an edit the editor started, on that exact element. Text whose element changed
          // or went away while it was typed (the page was updated from somewhere else) is still committed, against
          // the element as it was: it is checked before it is applied and kept for the author if it cannot be.
          if (!d || editDescKey(d) !== edit.desc) break;
          // Text the editor keeps nothing of goes back to what the page showed, so it never looks saved.
          const putBack = () => post('restoreText', { editId });
          if (!edit.base && !(edit.code ? canInlineEditCode(edit.code) : canInlineEdit(edit.ref))) {
            putBack();
            break;
          }
          // Rich text arrives as a copy of its structure (marks, lists and links included), plain text as a string.
          const dom = p.rich !== undefined ? richDom(p.rich) : null;
          const live = getState().snapshot?.state;
          const rich = dom ? blocksFromDom(dom, live?.pages ?? {}, undefined, live ? collectionIndexRoutes(live) : {}) : null;
          const value = rich ? rich.blocks : p.rich === undefined && typeof p.text === 'string' && p.text.length <= 20000 ? p.text : null;
          if (rich?.droppedLinks) {
            toast('A link pointed to something that is not a page, web address, email or phone number, so it was removed.', 'error');
            reportRefused('A link pointed to something that is not a page, web address, email or phone number, so it was removed.');
          }
          if (value === null || (Array.isArray(value) && value.length > 500)) {
            toast('That text change could not be saved. Try editing it in the Inspector.', 'error');
            reportRefused('That text change could not be saved. Try editing it in the Inspector.');
            putBack();
            break;
          }
          // Typed on the page, like any typed edit: if the AI ran meanwhile, it is the edit of the text as it was
          // when editing began, checked before it is applied (held while the AI works).
          const snap = getState().snapshot;
          const typedText = typeof value === 'string' ? value : richTextToMarkdown(value, snap?.state.pages ?? {});
          // An edit that leaves the field as it was rebuilds nothing: the page puts back the text it showed.
          const restore = (r: 'restore' | void) => void (r === 'restore' && putBack());
          const commit = (base: typeof edit.base | undefined) => (edit.code ? commitCodeText(edit.code, value, base) : commitText(edit.ref, value, base));
          if (snap?.aiBusy || aiActivity() !== edit.ai) commitDraft(edit.base, () => void commit(edit.base).then(restore), typedText, { check: true });
          else {
            // Built from the field editing began on, and written only while it still holds what it held then (see
            // commitOps). Text handed back because an update re-rendered its element may have been typed over text
            // the page showed before it caught up with the project: then it waits for the author to look.
            // Rich text has no plain baseline to compare, so a re-rendered one always waits for the author to look.
            const shown = p.detached === true && typeof p.before === 'string' ? p.before : null;
            const shows = (base: NonNullable<typeof edit.base>, words: string) => (edit.code ? showsCodeText(base, edit.code, words) : showsInlineText(base, edit.ref, words));
            const review = !!edit.base && p.detached === true && (shown === null ? Array.isArray(value) : !shows(edit.base, shown));
            commitDraft(edit.base, () => void commit(edit.base ?? undefined).then(restore), typedText, review ? { review, ...(shown !== null ? { shown } : {}) } : {});
          }
          break;
        }
        case 'checkLink': {
          // A destination typed in the page's link field, checked against the site's pages before the words are
          // linked: the field keeps it, and says what is wrong, until it names somewhere the site can link to.
          if (!pendingEdits.current.has(String(p.editId)) || typeof p.href !== 'string') break;
          const live = getState().snapshot?.state;
          const problem = inlineLinkProblem(p.href.slice(0, 2000), live?.pages ?? {}, live ? collectionIndexRoutes(live) : {});
          post('linkChecked', { check: p.check, ...(problem ? { problem } : {}) });
          break;
        }
        case 'linkDropped':
          // Saving or leaving handed back the text without the link still being typed there.
          if (pendingEdits.current.has(String(p.editId))) {
            toast('The link you were typing on the page was not applied, so it was left out.', 'error');
            reportRefused('The link you were typing on the page was not applied, so it was left out.');
          }
          break;
        case 'textCancel':
          if (!pendingEdits.current.has(String(p.editId))) break;
          endInlineEdit(String(p.editId));
          if (p.reason === 'too-large') {
            toast('That text is too long to edit on the page. Edit it in the Inspector instead.', 'error');
            reportRefused('That text is too long to edit on the page. Edit it in the Inspector instead.');
          }
          break;
        case 'key':
          // Shortcuts are taken from trusted keyboard input (see App), never from the page. Escape only hides the
          // hover name (WCAG 1.4.13), which changes nothing in the project, so the page's report of it counts.
          if (p.key === 'Escape' && getOverlay().hover) setTagHidden(true);
          break;
        case 'textFocus':
          frameTextFocus.active = p.on === true;
          break;
        case 'editLeftByKey':
          // Enter or Escape ended an edit of the page's text, which keeps the focus: it comes back for the selection.
          if (keyboardLeavesPage(keyboardAt(s))) frameRef.current?.blur();
          break;
        case 'contextmenu': {
          if (!st || !s.frameReady || leavingForPage() || canvasCovered(activeWorkspace(s))) return;
          pagePick();
          const chain = chainOf(p.chain);
          const ref = pick(chain, false);
          if (!ref && s.definitionMode) {
            setState({ selection: null });
            break;
          }
          if (ref) selectOnPage(ref, s.rightTab === 'styles' ? { rightTab: 'inspect' } : {});
          const fr = frameRef.current!.getBoundingClientRect();
          const z = currentZoom();
          const at = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
          openContextMenu(fr.left + at(p.x) * z, fr.top + at(p.y) * z, ref);
          break;
        }
        case 'download': {
          // Previewing: a link to one of the site's documents. Visitors download it; the preview does not.
          const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'the document';
          toast(`Visitors download ${name} from this link. The preview doesn’t download files; export the website to try it.`, 'info');
          break;
        }
        case 'externalLink': {
          // Previewing: a link that leaves the site opens outside the app, after the visitor's-eye check here.
          const link = externalLink(p.href);
          if (!link) {
            toast('This link can’t be opened from the preview.', 'error');
            break;
          }
          confirmOpenExternal(link);
          break;
        }
        case 'runtimeError': {
          const message = String(p.message).slice(0, 400);
          const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
          noteIssue(message, [text(p.file), text(p.stack), message], typeof p.revision === 'number' && Number.isSafeInteger(p.revision) ? p.revision : null);
          markTimedOut(false);
          setFrameError(message);
          setRetrying(false);
          // A page waiting for a save's update that failed to build will not show it: picks work again, on the page as
          // it is. Any other error on the page (a script of the site's own) says nothing about the update.
          if (p.build === true) gate.current!.failed();
          break;
        }
        case 'revisionApplied': {
          const at = typeof p.revision === 'number' && Number.isSafeInteger(p.revision) ? p.revision : undefined;
          // The page shows that revision now (src/shared/perf.ts).
          perfMark('canvas.revisionApplied', { revision: at ?? null });
          if (at !== undefined) {
            shownRevision.current = at;
            gate.current!.shown(at);
          }
          // A change shown by the page clears its own error, not the canvas's report that a page never arrived, and not
          // an error the page had while showing this same change (the change that broke it, shown a moment later).
          const sameChange = at !== undefined && errorAt.current !== null && at <= errorAt.current;
          if (!timedOut.current && !sameChange) {
            setFrameError(null);
            errorAt.current = null;
            notePageWorking(at);
          }
          // The page now shows the latest change (a last section deleted): what is measured on it is measured again.
          setApplied((n) => n + 1);
          break;
        }
        case 'forms':
          setForms(formsOf(p.forms));
          break;
        case 'formResult': {
          const send = formSendOf(p);
          // A live test's reports count only for the test the editor asked for.
          if (!send || (send.kind === 'live' && send.requestId !== liveRequestRef.current)) break;
          if (send.kind === 'live' && sendSettled(send)) setLiveRequest(null);
          setLastSend(send);
          break;
        }
        case 'measured': {
          const w = measureWaiters.current.get(String(p.requestId));
          if (w) {
            measureWaiters.current.delete(String(p.requestId));
            w(unmeasured ? null : p.rects);
          }
          break;
        }
        case 'spaceMeasured': {
          const w = measureWaiters.current.get(String(p.requestId));
          if (w) {
            measureWaiters.current.delete(String(p.requestId));
            w(unmeasured ? null : p.px);
          }
          break;
        }
        case 'pointed': {
          const w = measureWaiters.current.get(String(p.requestId));
          if (w) {
            measureWaiters.current.delete(String(p.requestId));
            w(unmeasured ? null : p);
          }
          break;
        }
      }
    };
    pageMessage.current = handle;
    const onMsg = (e: MessageEvent) => {
      const known = viewNow();
      const m = acceptMessage(e, frameRef.current, origin, session, known);
      if (!m) return;
      // A page loaded, moved on in place or caught up with a change: what it reports from here on is about that.
      frameView.current = { session, view: viewAfter(m, known) };
      // A measurement the editor waits on, taken from a page or revision since left (or asked of one the frame had
      // left when it got the request), answers as nothing measured.
      const unmeasured = staleFor(m, frameView.current.view) || m.payload.unmeasured === true;
      // The page's reports of what moved under the pointer and where its outlines are, timed with the render and
      // commit each sets off (the `canvas` scenario).
      // A report of where the outlines are says how long the page spent measuring them (`pageMs`).
      if (perfOn && (m.type === 'rects' || m.type === 'hover')) perfWork(`canvas.${m.type}`, () => handle(m, unmeasured), typeof m.payload.measureMs === 'number' ? { pageMs: m.payload.measureMs } : undefined);
      else handle(m, unmeasured);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }); // re-bind each render so handlers see fresh origin/session

  const currentZoom = () => {
    const s = getState();
    return s.zoom === 'fit' ? Math.min(1, (size.w - 56) / s.viewport) : s.zoom;
  };

  /**
   * While a post is previewed, the address the frame is now on, for the toolbar and the Inspector to name (lib/posts
   * postShown): the post, or wherever a visitor's link went on to. Not while the editor's own request is on its way,
   * so the page being left is never named in the post's place.
   */
  function notePostPreviewAt(path: string) {
    const s = getState();
    if (s.postView === 'preview' && !nav.current.request && s.postPreviewAt !== path) setState({ postPreviewAt: path });
  }

  function syncPage(path: string) {
    const st = getState().snapshot?.state;
    if (!st) return;
    const s = getState();
    // While a collection's layout is open, another of its entries keeps it open on that entry; a page closes it.
    const to = viewAt(st, s.templateMode, path);
    // While a post is visited (visitAddress), an entry's page is that visit, not its collection's layout opened for
    // editing: the editor keeps the page it shows, and Back to writing returns the canvas there.
    if (to && 'templateMode' in to && visitWanted !== null) return;
    // Another entry of the same collection keeps what is selected in its layout; another collection's starts afresh.
    if (to && 'templateMode' in to) setState({ templateMode: to.templateMode, definitionMode: null, ...(to.templateMode.collectionId === s.templateMode?.collectionId ? {} : { selection: null }) });
    else if (to && (to.pageId !== s.pageId || s.templateMode)) setState({ pageId: to.pageId, templateMode: null, selection: null });
  }

  /** Where the keyboard is, for whether it comes back from the page (lib/clip-keys). */
  function keyboardAt(s: ReturnType<typeof getState>) {
    return { frameFocused: !!frameRef.current && document.activeElement === frameRef.current, mode: s.mode, inlineEdit: inlineEdit.active };
  }

  /** A click in the page is pointer input this window never sees: menus opened from it should not jump to
   *  an item, and a chip button that kept focus from an earlier keyboard visit should not keep its ring. */
  function pagePick() {
    notePointerInput();
    // Blur rather than move focus: the window's last input was a key, so a moved focus would draw a ring.
    // The editor's shortcuts (Delete, ⌘D) still act on the selection from the page body.
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest('.ov-chip')) active.blur();
  }

  /** Hover previews what a click would select: the same resolution as a click, against the current
   *  selection. Nothing while previewing, editing text, reordering or with a menu open. */
  function resolveHover() {
    const s = getState();
    const st = s.snapshot?.state;
    const chain = hoverChain.current;
    const next = st && chain?.length && s.mode === 'edit' && !inlineEdit.active && !openMenus.count ? pick(chain, false, true) : null;
    if (!sameRef(next, getOverlay().hover)) setOverlay({ hover: next });
    // The same node of a component, now under the pointer in another of its placements.
    else if (next && hoverPlacement.current !== shownHover.current) syncTrack();
    shownHover.current = hoverPlacement.current;
    canvasHover.current = next;
  }

  // Pointer events inside the page never reach this window, so any move seen here (the pasteboard, the chip,
  // a panel) means the pointer has left the page and the page's hover ends. A hover a Layers row set stays.
  useEffect(() => {
    const leave = (e: PointerEvent) => {
      // Resting on the name of what is hovered, or on one of its Add buttons, keeps it hovered.
      if ((e.target as Element | null)?.closest?.('.ov-label.outside, .ov-add')) return;
      if (!hoverChain.current) return;
      heldHover.current = false;
      hoverChain.current = null;
      const was = getOverlay().hover;
      if (was && sameRef(was, canvasHover.current)) setOverlay({ hover: null });
      canvasHover.current = null;
    };
    window.addEventListener('pointermove', leave, true);
    return () => window.removeEventListener('pointermove', leave, true);
  }, []);

  /**
   * The pointer has left the hover's name or Add button. A hover kept while it rested there ends now: the page has
   * already said the pointer left it, and says nothing more if it comes back to the same element or to none, so the
   * hover would otherwise outlive the pointer, or lose its outline while the pointer is back on it. Back on the page, the
   * page reports what it is over again.
   */
  function leaveHoverChrome(e: React.PointerEvent) {
    // Straight onto another of them (two Add buttons of a short section): the hover is still being rested on.
    if (e.relatedTarget instanceof Element && e.relatedTarget.closest('.ov-label.outside, .ov-add')) return;
    overTag.current = false;
    if (!heldHover.current) return;
    heldHover.current = false;
    hoverChain.current = null;
    const was = getOverlay().hover;
    if (was && sameRef(was, canvasHover.current)) setOverlay({ hover: null });
    canvasHover.current = null;
  }

  /**
   * Whether the frame shows the place the others' marks are for (#768): the editor's page, not another the frame has
   * gone on to (a link followed in Preview, a page not found), whose boxes would put them on something else.
   */
  function marksOnFrame(): boolean {
    const at = presenceOf(getState()).previewPath;
    const shown = frameAt.current;
    // The page reports its path decoded (readablePath in the bridge), the editor's place is URL-encoded: both are read decoded.
    const plain = (path: string) => {
      const bare = path.split('?', 1)[0];
      try {
        return decodeURI(bare);
      } catch {
        return bare;
      }
    };
    return !at || !shown || samePath(plain(at), plain(shown));
  }

  function syncTrack() {
    const s = getState();
    const st = s.snapshot?.state;
    if (!st) return;
    // With timing marks on, the page times its measuring too (the `canvas` scenario).
    post('track', { selected: descFor(s.selection), hovered: descFor(getOverlay().hover, hoverPlacement.current), slots: trackedSlots(), marks: trackedMarks(st, marksNow(s).marks), ...(perfOn ? { timed: true } : {}) });
  }

  /** The empty slots of the selected placement whose Add buttons are drawn on their own boxes (#657), for the page to
   *  measure with the selection's outline. */
  function trackedSlots(): BridgeDesc[] {
    const s = getState();
    const st = s.snapshot?.state;
    const owner: OwnerRef | null = s.templateMode ? templateOwner(s.templateMode) : s.pageId ? { kind: 'page', id: s.pageId } : null;
    if (!st || !owner || !s.selection || s.definitionMode) return [];
    const sel = s.selection;
    return addPoints(st, owner, sel)
      .filter((p) => p.onSlot)
      .flatMap((p) => descFor({ ...sel, slot: p.slot }) ?? []);
  }

  // A click changes what the next click would select, even if the pointer has not moved.
  useEffect(() => {
    if (hoverChain.current) resolveHover();
  }, [selection && refKey(selection), mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // How long the page has been behind is counted from when the editor took the revision. A save that failed after its
  // revision was taken (its files had reached the preview) arrives as that revision with the failure, and sends the
  // page no revision: picks stop waiting for one, and the save indicator shows the failure. A save that failed before
  // its revision moved leaves the one still publishing to be waited for.
  const saveFailed = snapshot?.saveFailure ? JSON.stringify(snapshot.saveFailure) : null;
  const seenFailure = useRef<SeenFailure>({ revision: 0, failure: null });
  useEffect(() => {
    const now = { revision: snapshot?.revision ?? 0, failure: saveFailed };
    gate.current!.took(now.revision);
    if (failedWithRevision(seenFailure.current, now)) gate.current!.failed();
    seenFailure.current = now;
  }, [snapshot?.revision, saveFailed]);

  // With timing marks on: the first commit that draws the hovered element's outline where the page measured it for that
  // element, marked once the frame it is in is painted (the `canvas` scenario).
  useLayoutEffect(() => {
    const timed = hoverTimed.current;
    if (!perfOn || !timed) return;
    const now = getOverlay().hover;
    if (!now || refKey(now) !== timed.key) return void (hoverTimed.current = null);
    const want = descFor(now, hoverPlacement.current);
    const got = rectsFor.current.hovered;
    if (!want || !got || got.ctx !== want.ctx || got.node !== want.node || (got.items || '') !== (want.items || '') || (got.part || '') !== (want.part || '') || got.slot !== want.slot) return;
    if (!wrapRef.current?.querySelector('.ov-hover')) return;
    hoverTimed.current = null;
    requestAnimationFrame(() => perfMark('canvas.hoverOutlined', { movedAt: timed.at }));
  });

  // Keep the bridge in sync with selection, hover and document revisions. Asked again when Site styles opens or closes,
  // or Edit and Preview change places, so the page reports afresh what the canvas can draw again (an insertion's
  // arrival cue waits for that, and the page sends no report that would only repeat the last).
  useEffect(() => {
    if (ready) syncTrack();
  }, [ready, selection, hover, snapshot?.revision, stylesOpen, mode, peerMarksKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new selection is scrolled to once the frame shows its page (not one picked on the page: selectOnPage), and so
  // is one a Layers row asks to show again (showLayer). Asked from Layers, one taller than the page shows from its top. One made with a page change (a page
  // opened at its remembered place, a usage on another page) is scrolled to when the page says it has arrived
  // (`navigated`). The selection Edit makes again after Preview stays where the visitor left the page.
  const shownFor = useRef(showSelection);
  useEffect(() => {
    // A request is for the moment it is made: one the page could not take then never carries over to a later pick,
    // except to the page it is on its way to (a section picked from the command menu on another page, issue #902).
    const show = shownFor.current !== showSelection;
    shownFor.current = showSelection;
    const quiet = takeUnscrolled(selection);
    const desc = ready && (showsStudio() || (view?.route && samePath(view.route, frameAt.current))) ? descFor(selection) : null;
    // Kept through the frame becoming ready on the page it is leaving; let go once delivered or another is selected.
    const key = selection ? refKey(selection) : null;
    if (show && !desc) showOnArrival.current = key;
    else if (desc || showOnArrival.current !== key) showOnArrival.current = null;
    if (desc && (show || !quiet)) post('scrollTo', show ? { desc, show } : { desc });
  }, [ready, selection && refKey(selection), showSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  // A selection moved from the keyboard (issue #902) is shown where it went. The page may still show it in its old
  // place, so one the page does not have yet is asked about the move's revision: the page waits for it, and the
  // author scrolling or clicking there meanwhile ends the wait. Asked once, and only while it is still selected.
  useEffect(() => {
    if (!showMoved) return;
    setState({ showMoved: null });
    if (!ready || getState().mode === 'preview' || getState().selection !== showMoved.ref) return;
    const desc = showsStudio() || (view?.route && samePath(view.route, frameAt.current)) ? descFor(showMoved.ref) : null;
    if (!desc) return;
    post('scrollTo', shownRevision.current >= showMoved.revision ? { desc } : { desc, revision: showMoved.revision });
  }, [showMoved]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The list item open in the inspector, revealed on the page while it is edited (see lib/reveal): only while
   * editing, with the inspector in view. The page is told only when that changes.
   */
  function syncReveal() {
    const s = getState();
    const st = s.snapshot?.state;
    const r = s.revealedItem;
    const dm = s.definitionMode;
    const shown = !!st && !!r && s.mode === 'edit' && s.dockOpen && s.rightTab === 'inspect';
    const at = shown && !dm?.studio ? pageRefFor(r.ref) : null;
    const ctx = !shown ? undefined : dm?.studio ? (studioDesignCtx(st, dm.definitionId, r.ref) ?? undefined) : at ? designCtx(st, at) : undefined;
    const target = st && r && ctx ? revealTarget(st, r, ctx) : null;
    if (sameTarget(target, sentReveal.current)) return;
    sentReveal.current = target;
    post('reveal', { target });
  }
  useEffect(() => {
    if (ready) syncReveal();
  }, [ready, revealedItem, mode, inspectorShown, snapshot?.revision, view?.key, definitionMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ready) post('mode', { mode });
  }, [mode, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The hover, focus or pressed state the Inspector edits, shown on the selected element (or the part of it being
   * styled) so its changes can be seen without the pointer on the page: only while editing, with the inspector in
   * view. Anything else (Default, Preview, another selection, the inspector closed) clears it.
   */
  function syncForcedState() {
    const s = getState();
    const shown = !!s.styleState && s.mode === 'edit' && s.dockOpen && s.rightTab === 'inspect';
    const desc = shown ? descFor(s.selection) : null;
    post('forceState', desc ? { state: s.styleState, desc, part: s.styleStatePart } : { state: null });
  }
  useEffect(() => {
    if (ready) syncForcedState();
    // The selection itself, not its key: in Edit everywhere a click on the same node in another placement shows it there.
  }, [ready, mode, styleState, styleStatePart, inspectorShown, selection, snapshot?.revision, view?.key, definitionMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each visit to Preview starts practising successful sends, with nothing said about earlier ones.
  useEffect(() => {
    setLastSend(null);
    setLiveRequest(null);
    setFormsView((v) => v + 1);
    if (mode === 'preview') setPractice('success');
  }, [mode]);
  useEffect(() => {
    if (ready) post('formPractice', { result: practice });
  }, [practice, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveTest = (form: PreviewForm) => {
    const requestId = `live-${Date.now()}`;
    setLiveRequest(requestId);
    setLastSend(null);
    // The address the author was shown: the page refuses the test if the form would now send anywhere else.
    post('formLiveTest', { id: form.id, target: form.destination, requestId });
  };

  // Entering Preview starts the visitor's journey where the frame is (or carries on with the last one, when the
  // author went back to editing, opened no other page and moved none). A page the editor is still opening is where
  // it starts, once the frame is there.
  // What Edit returns to, chosen again while previewing (Preview pressed with a layer picked), starts from where the
  // frame is then.
  const previewReturn = useStore((s) => s.previewReturn);
  useEffect(() => {
    if (getState().mode === 'preview' && previewReturn) previewFrom.current = frameAt.current !== null ? journeyRef.current.at : null;
  }, [previewReturn]);
  const modeBefore = useRef(mode);
  /** The page and the address the frame was last sent back from while editing (see backToShownPage). */
  const sentBack = useRef<string | null>(null);
  useEffect(() => {
    const left = modeBefore.current === 'preview' && mode === 'edit';
    modeBefore.current = mode;
    if (mode === 'preview') sentBack.current = null;
    // Back in Edit, the canvas shows the page the editor names, wherever Preview went (the blog index, a post): an
    // address visited there is not reopened, and the frame goes back unless it is on that page already (#868). Called
    // here rather than through showEditedPage, whose frameVisit is not set again until a later effect of this render.
    if (left) {
      visitWanted = null;
      if (ready) openShownPage();
    }
    // Where the frame is when Preview is entered (or, while a page is still opening, the first entry it reports).
    previewFrom.current = mode === 'preview' && frameAt.current !== null ? journeyRef.current.at : null;
    if (mode !== 'preview') return;
    setJourney(startJourney(journeyRef.current, siteNow(), frameAt.current !== null));
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Back or Forward: the frame steps through its own history, so the site restores the page and its scroll. */
  function step(dir: 'back' | 'forward'): boolean {
    const key = getState().mode === 'preview' ? stepTarget(journeyRef.current, dir) : null;
    if (!key) return false;
    post('traverse', { key });
    return true;
  }
  useEffect(() => {
    visitorStep = step;
    return () => {
      visitorStep = null;
    };
  });
  useEffect(() => {
    frameVisit = (path, fullReload = false) => {
      if (path === null) {
        if (ready) openShownPage();
        return ready;
      }
      if (!ready) return false;
      return visit(path, fullReload);
    };
    return () => {
      frameVisit = null;
    };
  });
  /** Ask the frame for an address that is no page of the editor's (see visitAddress). */
  function visit(path: string, fullReload = false): boolean {
    // Already there, with nothing asked for since.
    if (!nav.current.request && samePath(path, frameAt.current)) return true;
    // As a page the editor opens: "opening" until the frame says it is there, and a problem reported was about the
    // address it is leaving. The request is the editor's latest, so a page asked for after it (Back to writing)
    // overtakes it, and its late report is never followed.
    setState({ frameReady: false });
    markTimedOut(false);
    setFrameError(null);
    setRetrying(false);
    if (document.activeElement === frameRef.current) canvasRef.current?.focus({ preventScroll: true });
    const navId = askFrame(nav.current, viewKey(getState()) ?? '', path);
    frameAt.current = null;
    post('navigate', { path, navId, fullReload });
    // A post previewed is on its way: what the frame showed before is not named in its place (see notePostPreviewAt).
    if (getState().postView === 'preview' && getState().postPreviewAt !== null) setState({ postPreviewAt: null });
    return true;
  }

  /**
   * While editing, the frame shows the editor's page: one it reached on its own at `path` (a visitor's link or Back
   * followed just as Preview ended) is sent back, unless the editor has a request of its own on the way (#868).
   */
  function backToShownPage(path: string) {
    const s = getState();
    if (s.mode !== 'edit' || nav.current.request || showsStudio() || !s.snapshot) return;
    const shown = shownView(s.snapshot.state, s.pageId, s.templateMode);
    if (!shown?.route || samePath(shown.route, path)) return;
    // Once for each page and address until Preview is entered again: a page that sends itself on to `path` each time
    // it loads stays where it went rather than going back and forth.
    const from = `${shown.key}\n${path}`;
    if (sentBack.current === from) return;
    sentBack.current = from;
    frameAt.current = path;
    openShownPage();
  }

  /** Ask the frame for the page the editor shows, unless it is there already or already asked for. */
  function openShownPage() {
    // The frame shows a component on its own in Component Studio: it opens the page again when that ends.
    if (showsStudio()) return;
    // The editor's page is what the frame shows from now on, not an address visited before.
    visitWanted = null;
    const s = getState();
    const shown = s.snapshot ? shownView(s.snapshot.state, s.pageId, s.templateMode) : null;
    if (!shown?.route) return;
    const request = nav.current.request;
    if (request && nav.current.asked === shown.key && samePath(shown.route, request.path)) return;
    // The page already went there itself (a link clicked while previewing): leave it where it is.
    if (samePath(shown.route, frameAt.current)) return void askFrame(nav.current, shown.key, null);
    // A page the editor opens while previewing (a new address, a page picked) is where the visitor starts again; Edit
    // no longer returns to a selection on another page.
    if (getState().mode === 'preview') {
      previewFrom.current = null;
      if (getState().previewReturn && getState().previewReturn?.pageId !== shown.key) setState({ previewReturn: null });
    }
    // Until the page confirms the navigation, it is "opening", not ready. Focus in the leaving page moves to the
    // canvas, which stays.
    setState({ frameReady: false });
    // Any problem reported was about the page that is leaving.
    markTimedOut(false);
    setFrameError(null);
    setRetrying(false);
    if (document.activeElement === frameRef.current) canvasRef.current?.focus({ preventScroll: true });
    const navId = askFrame(nav.current, shown.key, shown.route);
    recoverySeq.current++;
    frameAt.current = null;
    // A newly published entry can be on disk before Vite serves its route. This applies to ordinary pages as well
    // as template pages: navigating during that gap can leave the canvas on Vite's error page.
    // Ask the preview to compile the route first. The request remains authoritative while the old page reports
    // its final state during the wait. A guest in a live session has no preview of its own to ask (#1529).
    const asked = nav.current;
    const remote = isRemoteShell(s);
    void api.project.previewRouteReady(shown.route, s.snapshot!.revision).catch(() => false).then((canServe) => {
      // Another page asked for meanwhile, or another frame since: a late answer sends neither frame back here.
      if (nav.current !== asked || asked.request?.id !== navId) return;
      if (sendsFrame(canServe, remote)) post('navigate', { path: shown.route, navId, fullReload: true });
      recoverRoute(shown.route!, s.snapshot!.revision, session);
    });
  }
  // Navigate when the current page changes. A frame that has just become ready while a post is visited (the preview
  // restarted) stays on the post its 'ready' report asked for again.
  const shownBefore = useRef<string | null>(null);
  useEffect(() => {
    const key = `${view?.key}\n${view?.route}`;
    const first = shownBefore.current === null;
    const moved = shownBefore.current !== key;
    shownBefore.current = key;
    // Another page chosen is what the frame shows from now on, even before it is ready.
    if (moved && !first) visitWanted = null;
    if (ready && view?.route && !showsStudio() && (moved || !visitWanted)) openShownPage();
  }, [view?.key, view?.route, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * What a pick in the page selects. Normally the selection steps in one level per click (see
   * selectionFromChain). While a component is edited everywhere it is the component's own node under the
   * pointer, any node of the design, and a pick outside the component selects nothing (the overview), so the
   * canvas, chip and inspector never describe a different section under the "everywhere" band.
   */
  function pick(chain: BridgeDesc[], deep: boolean, hovering = false): ElementRef | null {
    const s = getState();
    const st = s.snapshot?.state;
    if (!st || !chain.length) return null;
    const dm = s.definitionMode;
    if (!dm) return selectionFromChain(st, chain, s.selection, deep);
    // In Component Studio the component is not placed anywhere on screen: its own nodes are picked directly.
    if (dm.studio) return studioPick(st, dm.definitionId, chain);
    const hit = definitionPick(st, dm.definitionId, chain);
    if (hovering) hoverPlacement.current = hit?.placement ?? null;
    else if (hit) placementRef.current = hit.placement;
    return hit?.ref ?? null;
  }

  /** The element the page shows for a reference: a component's own node is shown through one of its
   *  placements (the one it was picked through, else the first on this page); null when there is none. */
  function descFor(ref: ElementRef | null, via: ElementRef | null = null): BridgeDesc | null {
    const dm = getState().definitionMode;
    const st = getState().snapshot?.state;
    if (dm?.studio) return st ? studioDescOf(st, dm.definitionId, ref) : null;
    const at = pageRefFor(ref, via);
    return st && at ? descOf(st, at) : null;
  }

  /** In Component Studio, the element of a pick's chain that a reference of the design names, as the preview names it. */
  function studioClicked(chain: BridgeDesc[], ref: ElementRef): BridgeDesc | null {
    const want = descFor({ ...ref, itemPath: [] });
    return want ? (chain.find((d) => d.ctx === want.ctx && d.node === want.node) ?? null) : null;
  }

  /** Where a reference shows on the page: itself, or while editing everywhere, through a placement there. */
  function pageRefFor(ref: ElementRef | null, via: ElementRef | null = null): ElementRef | null {
    const s = getState();
    const st = s.snapshot?.state;
    if (!ref || !st) return null;
    const dm = s.definitionMode;
    if (!dm || !inDefinition(ref, dm.definitionId)) return ref;
    // A remembered placement counts only while it is on the page the canvas shows.
    const page = s.pageId ? st.pages[s.pageId] : undefined;
    const isPlacement = (pl: ElementRef | null) => {
      if (!pl || !page || (pl.owner.kind === 'page' ? pl.owner.id !== page.id : pl.owner.kind !== 'shell' || !isShellPart(pl.owner.id) || !showsPart(page, pl.owner.id))) return false;
      const n = resolveRef(st, pl).node;
      return n?.kind === 'instance' && n.definitionId === dm.definitionId;
    };
    const placement = [via, placementRef.current].find(isPlacement) ?? (s.pageId ? placementsOn(st, dm.definitionId, s.pageId)[0] : undefined);
    return placement ? throughPlacement(ref, placement) : null;
  }

  // The component being edited went away (its copy was undone): editing it everywhere ends. A snapshot that takes it
  // away ends the mode itself (keepViewValid); this covers a mode entered for a component that had already gone.
  useEffect(() => {
    if (definitionMode && state && !state.components[definitionMode.definitionId]) setState({ definitionMode: null, pageId: definitionMode.returnPageId, selection: null });
  }, [definitionMode, state]);
  // Editing everywhere a component the page no longer places (its last placement there removed or undone): Component
  // Studio shows it on its own, so the canvas still has it to edit. Not while previewing, where a visitor's link moves
  // the page on: back in Edit, it is shown there.
  useEffect(() => {
    const s = getState();
    // A request the AI is still working on can take a placement away and put it back (stopped, it is rolled back): the
    // view follows the project once it settles.
    if (state && s.mode === 'edit' && !s.snapshot?.aiBusy && needsStudio(state, s.definitionMode, s.pageId)) setState({ definitionMode: { ...s.definitionMode!, studio: NEW_STUDIO } });
  }, [definitionMode, state, pageId, mode, snapshot?.aiBusy]);
  // A new component being edited starts without a remembered placement (declared first: it runs before the
  // effect below, which may set one).
  useEffect(() => {
    placementRef.current = null;
    hoverPlacement.current = null;
  }, [definitionMode?.definitionId]);
  // While editing everywhere, a selection made through a placement (entering the mode, the page's own
  // commands) becomes the component's own node, so Layers, the inspector and edits all name the design.
  useEffect(() => {
    const st = state;
    if (!definitionMode || !selection || !st || inDefinition(selection, definitionMode.definitionId)) return;
    const hit = toDefinitionRef(st, definitionMode.definitionId, selection);
    if (hit) placementRef.current = hit.placement;
    setState({ selection: hit?.ref ?? null });
  }, [definitionMode?.definitionId, selection && refKey(selection)]); // eslint-disable-line react-hooks/exhaustive-deps

  function openContextMenu(x: number, y: number, ref: ElementRef | null, trigger?: HTMLElement, focusLast?: boolean) {
    if (!ref || !state) return;
    const t = structuralTarget(ref);
    // Elements and basic elements, and a section together with its content: the same as Layers and the inspector.
    const create = createComponentTarget(getState().snapshot, t);
    // A container of the design edited everywhere: the same as Layers and the inspector.
    const repeat = repeatAsListTarget(getState().snapshot, t);
    const parent =
      ref.slot !== undefined
        ? withoutSlot(ref)
        : ref.instancePath.length
          ? { owner: ref.owner, instancePath: ref.instancePath.slice(0, -1), nodeId: ref.instancePath[ref.instancePath.length - 1] }
          : null;
    const locked = !t || t.owner.kind === 'shell';
    const kept = definitionMode ? undefined : placedDefinition(state, t, devMode);
    const sib = siblings(state, t);
    const reorderable = !!sib && sib.count > 1;
    const name = chromeLabel(state, ref);
    // Commands act on the element the menu names, even if the selection moved on while it was open (a
    // Duplicate that finished selects its copy); one that no longer exists does nothing.
    const on = (fn: () => unknown) => () => {
      const now = getState().snapshot?.state;
      if (!now || !resolveRef(now, ref).node) return;
      // The menu names one element: layers selected with it in Layers are let go, so it acts on that one alone.
      if (!sameRef(getState().selection, ref) || getState().layerSet) setState({ selection: ref });
      void fn();
    };
    // A menu left open while the project changed (the AI, the files on disk) never selects what has gone since.
    const live = (target: ElementRef, fn: () => unknown) => () => {
      const now = getState().snapshot?.state;
      if (now && refExists(now, target)) void fn();
    };
    // Text that can be edited on the page can be reached without a double-click: the keyboard's way in. Focus goes
    // into the page with the text, where Tab reaches its formatting toolbar.
    const editable = mode === 'edit' && canInlineEdit(ref) && !!descFor(ref);
    const editText = live(ref, () => startTextEditFromChrome(ref));
    // Copy takes content from a page; Paste goes after (or inside) what the menu names, here or in a component edited
    // everywhere. The shared header and footer take neither.
    const clipboard = ref.owner.kind === 'shell' ? [] : copyPasteItems({ copy: t && t.owner.kind === 'page' ? on(() => copySelection()) : null, paste: on(() => pasteFromMenu()) });
    // Wrap the element in a Stack, Row or Grid, or ungroup it, where it is: the same as Layers and the inspector.
    const wraps = locked ? [] : wrapItems(planOne(t), { wrap: (k) => on(() => wrapLayers(k))(), ungroup: on(() => ungroupLayers()) });
    const items = [
        { heading: name },
        ...(editable ? [{ label: 'Edit text', icon: <Pencil />, onSelect: editText }] : []),
        ...(parent ? [{ label: `Select ${chromeLabel(state, parent)}`, icon: <Component />, onSelect: live(parent, () => setState({ selection: parent })) }] : []),
        { label: 'Ask AI about this', icon: <Sparkles />, shortcut: keys(askAiHint()), onSelect: live(ref, () => askAiAbout(ref)) },
        // A part of a placed section has no place of its own to paste at (nor a Duplicate): only a component's own root, edited everywhere, does.
        ...(!t && clipboard.length && ref.owner.kind === 'component' && !ref.instancePath.length ? [{ separator: true }, ...clipboard] : []),
        ...(t
          ? [
              ...(reorderable || !locked || create ? [{ separator: true }] : []),
              ...(reorderable
                ? [
                    { label: 'Move up', icon: <ArrowUp />, shortcut: keys('⇧⌘↑'), disabled: sib!.index === 0, onSelect: on(() => announcedMove(() => moveSelection(-1))) },
                    { label: 'Move down', icon: <ArrowDown />, shortcut: keys('⇧⌘↓'), disabled: sib!.index >= sib!.count - 1, onSelect: on(() => announcedMove(() => moveSelection(1))) }
                  ]
                : []),
              ...(wraps.length ? [...(reorderable ? [{ separator: true }] : []), ...wraps, { separator: true }] : []),
              ...(locked ? [] : [...clipboard, { label: 'Duplicate', icon: <Copy />, shortcut: keys('⌘D'), onSelect: on(duplicateSelection) }]),
              ...(create ? [{ label: 'Create component…', icon: <Component />, onSelect: on(() => setState({ modal: { kind: 'create-component' as const, ref: create } })) }] : []),
              ...(repeat ? [{ label: 'Repeat as list…', icon: <Repeat />, onSelect: on(() => setState({ modal: { kind: 'repeat-as-list' as const, ref: repeat, workspaceKey: getState().snapshot?.workspaceKey } })) }] : []),
              ...(!definitionMode && detachable(state, ref) ? [{ label: 'Detach component', icon: <Unlink />, onSelect: on(() => detachPlacement(ref)) }] : []),
              // Kept for every project, or sent as a file (#372).
              ...(kept ? [{ label: 'Save to personal library', icon: <BookmarkPlus />, onSelect: live(ref, () => saveToLibrary(kept)) }, { label: 'Export component…', icon: <Download />, onSelect: live(ref, () => exportComponentFile(kept)) }] : []),
              ...(locked ? [] : [{ separator: true }, { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: on(deleteSelection) }])
            ]
          : [])
      ];
    if (trigger) return menu.openAt(trigger, items, `${name} actions`, { focusLast });
    // A right-click on the page: once the chip for the new selection has rendered, its More actions button
    // is where focus returns, so the keyboard picks up in the toolbar rather than inside the page.
    // A workspace that covered the canvas meanwhile (#700) leaves the menu unopened: it would act on the page out of sight.
    requestAnimationFrame(() => !canvasCovered(activeWorkspace(getState())) && menu.open(x, y, items, `${name} actions`, wrapRef.current?.querySelector<HTMLElement>('.ov-chip [aria-haspopup="menu"]') ?? canvasRef.current));
  }

  /**
   * The part of the page the canvas shows now, in screen pixels (`view`) and from the frame's top left corner (`clip`),
   * and the canvas's own scrolling area (`scroller`), less its scrollbars. Null without a frame.
   */
  const shownFrame = () => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const el = scrollRef.current;
    if (!wrap || !el) return null;
    const r = el.getBoundingClientRect();
    const scroller = { left: r.left + el.clientLeft, top: r.top + el.clientTop, right: r.left + el.clientLeft + el.clientWidth, bottom: r.top + el.clientTop + el.clientHeight };
    const view = { left: Math.max(wrap.left, scroller.left), top: Math.max(wrap.top, scroller.top), right: Math.min(wrap.right, scroller.right), bottom: Math.min(wrap.bottom, scroller.bottom) };
    return { wrap, scroller, view, clip: { left: view.left - wrap.left, top: view.top - wrap.top, right: view.right - wrap.left, bottom: view.bottom - wrap.top } };
  };

  /** Drag a selected element to reorder it among its siblings, with a live insertion indicator. */
  async function startReorder(e: React.PointerEvent) {
    e.preventDefault();
    const s = getState();
    const t = structuralTarget(s.selection);
    const st = s.snapshot?.state;
    if (!t || !st || pageBehind()) return;
    const revision = s.snapshot!.revision;
    const tree = treeFor(st, t.owner);
    const info = tree && findParent(tree, t.nodeId);
    if (!info || info.list.length < 2) return;
    // A quick press can be released before the siblings are measured: catch it, so the drag never starts.
    let released = false;
    const early = () => (released = true);
    window.addEventListener('pointerup', early, { once: true });
    window.addEventListener('pointercancel', early, { once: true });
    window.addEventListener('blur', early, { once: true });
    // Where the pointer is while they are measured, so what it carries first shows beside it.
    const pointer = { x: e.clientX, y: e.clientY };
    const follow = (ev: PointerEvent) => {
      pointer.x = ev.clientX;
      pointer.y = ev.clientY;
    };
    window.addEventListener('pointermove', follow);
    const requestId = Math.random().toString(36).slice(2);
    const rects = await new Promise<Array<(Rect & { order: number }) | null> | null>((resolve) => {
      measureWaiters.current.set(requestId, (raw) => resolve(measuredRects(raw, info.list.length)));
      // A sibling the page cannot show (no placement) is asked for by a descriptor that matches nothing.
      // Siblings share the selection's repeated item, so every box comes from the same copy of the list.
      const itemPath = s.selection?.itemPath;
      post('measure', { requestId, descs: info.list.map((id) => descFor({ owner: t.owner, instancePath: [], nodeId: id, ...(itemPath?.length ? { itemPath } : {}) }) ?? { ctx: '', node: '', items: '' }) });
      setTimeout(() => resolve(null), 1500);
    });
    window.removeEventListener('pointerup', early);
    window.removeEventListener('pointercancel', early);
    window.removeEventListener('blur', early);
    window.removeEventListener('pointermove', follow);
    const from = info.index;
    // Siblings hidden at this width take no space on the page: the drag moves among the visible ones, in the
    // order the page shows them (an Order style can show one before siblings the document puts first).
    const visible = rects ? rects.flatMap((r, i) => (r ? [i] : [])) : [];
    if (released || !rects?.[from] || visible.length < 2) return;
    const order = (i: number) => rects[i]?.order ?? 0;
    const shown = shownOrder(visible, order);
    const boxes = shown.map((i) => rects[i]!);
    const name = chromeLabel(st, t);
    let to: number | null = null;
    setDragging(true);
    // Keys reach this window, not the page, while dragging: Escape cancels.
    canvasRef.current?.focus({ preventScroll: true });
    // The gesture's cursor holds over the whole window, as for the other drags.
    document.documentElement.classList.add('insert-dragging');
    insertPoint.current.x = pointer.x;
    insertPoint.current.y = pointer.y;
    // The line shows only where a drop would change the order; over the element's own place there is none.
    setReorder({ line: null, name });
    const move = (ev: PointerEvent) => {
      const seen = shownFrame();
      if (!seen) return;
      const box = seen.wrap;
      const z = currentZoom();
      // On the part of the page the canvas shows: a frame larger than the canvas runs on under the panels beside it.
      const v = seen.view;
      const inside = ev.clientX >= v.left && ev.clientX <= v.right && ev.clientY >= v.top && ev.clientY <= v.bottom;
      const drop = dropAt(boxes, (ev.clientX - box.left) / z, (ev.clientY - box.top) / z);
      // Outside the page, or over the element's own place, a release moves nothing. A gap among siblings of
      // another order is one no move reaches: no line shows there either.
      to = inside ? drop.to : null;
      // A gap its Order style keeps it out of says so while it is held there, as a refused place does: no line, the
      // strip and what it carries in the refusal's red, the no-drop pointer, and why, hung from the gap. Its own place
      // stays quiet.
      const refused = to !== null && !dropReaches(shown, from, to, order) ? drop.line : null;
      document.documentElement.classList.toggle('drop-refused', !!refused);
      const p = insertPoint.current;
      p.x = ev.clientX;
      p.y = ev.clientY;
      p.moved?.();
      setReorder({ line: to !== null && moveIndex(shown, from, to, order) !== null ? drop.line : null, name, clip: seen.clip, refused });
    };
    const end = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      setDragging(false);
      setReorder(null);
      document.documentElement.classList.remove('insert-dragging', 'drop-refused');
      if (commit && to !== null && !dropReaches(shown, from, to, order)) {
        toast('Its Order style keeps it out of that spot at this size, so it stays where it was. Change Order in its styles to move it there.', 'info');
        return;
      }
      const index = commit && to !== null ? moveIndex(shown, from, to, order) : null;
      if (index === null) return;
      // The siblings were measured on the page before a save that has since reached the editor (#755): where it would
      // go was read from the page before the save.
      if (getState().snapshot?.revision !== revision || pageBehind()) return void toast(`${name} wasn’t moved: the page was still updating. Drag it again.`, 'info');
      void announcedMove(() => applyOps([{ type: 'node.move', owner: t.owner, nodeId: t.nodeId, parentId: info.parentId, slot: info.slot, index }], editLabel(st, 'Move', t), undefined, revision));
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
  }

  /** The chip's grip: the selection moves anywhere on the page a drop can take it, or else among its siblings. */
  const onGrip = (e: React.PointerEvent) => {
    const started = startMoveDrag(e);
    if (started === 'unsupported') void startReorder(e);
  };

  /**
   * Drag the selected element by its chip's grip to another place on the page (#658): among its siblings, or into any
   * container, grid column or component slot on the page that takes it (see moveDestination), measured and shown as a
   * drag from Insert is (see startCanvasDrop). A place the project would refuse (a slot's contract, a place inside
   * itself, a link inside a card that is a link) says why while the pointer is on it, and on release. The release
   * moves it there as one node.move, planned on the project as the drag found it; let go where it was picked up, on its
   * own place, or off the page, nothing changes, and Escape (or another selection) cancels. 'unsupported' when the
   * selection is not one this drag moves (a component's own design, one of a repeated list's items, content the page's
   * lists don't hold), for the grip to keep it among its siblings; 'blocked' when nothing can move now.
   */
  function startMoveDrag(e: React.PointerEvent): 'started' | 'blocked' | 'unsupported' {
    const s = getState();
    const snap = s.snapshot;
    if (!snap || snap.readOnly || snap.aiBusy || s.mode !== 'edit' || !s.frameReady || dragging || insertDrag.current || assetDrag.current || resizeDrag.current) return 'blocked';
    const t = structuralTarget(s.selection);
    if (!t || !s.selection || s.definitionMode || !s.pageId || s.selection.itemPath?.length || s.selection.instancePath.length) return 'unsupported';
    const owner: OwnerRef = s.templateMode ? templateOwner(s.templateMode) : { kind: 'page', id: s.pageId };
    if (t.owner.kind !== owner.kind || t.owner.id !== owner.id) return 'unsupported';
    const st = snap.state;
    const dest = moveDestination(st, owner, t.nodeId);
    if (!dest) return 'unsupported';
    const source = refKey(s.selection);
    e.preventDefault();
    // Keys reach this window, not the page, while dragging: Escape cancels.
    canvasRef.current?.focus({ preventScroll: true });
    const name = chromeLabel(st, t);
    const label = editLabel(st, 'Move', t);
    const from = { x: e.clientX, y: e.clientY };
    // Let go where it was picked up (the grip can sit over another place on the page): nothing moves.
    const still = (point: { x: number; y: number }) => Math.hypot(point.x - from.x, point.y - from.y) < 4;
    startCanvasDrop<{ op: NonNullable<MoveAim['op']>; where: Where }>(
      {
        owner,
        name,
        moving: true,
        source,
        still,
        specs: dest.specs,
        lists: dest.lists,
        surfaces: dest.surfaces,
        idle: () => `Moving ${name}`,
        aim: (lists, x, y, z, point) => {
          if (still(point)) return null;
          const a = dest.aim(lists, x, y, z);
          return a && { at: a.op && { op: a.op, where: a.where }, refused: a.refused, line: a.line, outline: a.outline, label: a.refused ? `Can’t move ${name} here` : a.where ? `${name} ${whereText(a.where)}` : null };
        },
        drop: ({ op, where }) =>
          void (async () => {
            // Planned on the project as the drag found it, for what was selected then: a project that has moved on since,
            // or another selection, takes none of it.
            const now = getState();
            if (now.snapshot?.workspaceKey !== snap.workspaceKey || !now.selection || refKey(now.selection) !== source) return;
            const r = await applyOps([op], label, undefined, snap.revision);
            if (r && where) setAnnouncement(`${name} moved ${whereText(where)}.`);
          })(),
        refuse: (why) => toast(`${name} wasn’t moved: ${why}`, 'info'),
        unanswered: () => toast(`The page didn’t answer, so ${name} can’t be dragged now. Move it in Layers instead.`, 'info')
      },
      { x: e.clientX, y: e.clientY, pointerId: e.pointerId }
    );
    return 'started';
  }

  /** Each site style's size as padding on the box `desc` finds (null where it has none), a percentage taken of the
   *  page, the box's width or height, or its container (`basis`); null when the page doesn't answer. */
  const measureSpace = (vars: string[], desc: BridgeDesc, basis: 'page' | 'box' | 'boxHeight' | 'parent' = 'page') =>
    new Promise<Array<number | null> | null>((resolve) => {
      const requestId = Math.random().toString(36).slice(2);
      measureWaiters.current.set(requestId, (raw) => resolve(spaceSizes(raw, vars.length)));
      post('measureSpace', { requestId, vars, desc, basis });
      setTimeout(() => {
        measureWaiters.current.delete(requestId);
        resolve(null);
      }, 1500);
    });

  /**
   * Measure what the page shows for `descs`, in batches it answers (it reads at most 200 at a time); one it can't show
   * measures as nothing. Each batch's request goes in `requests`, for a drag that ends meanwhile to drop: its answer
   * then never comes.
   */
  function measureDescs(descs: BridgeDesc[], requests: string[]): Promise<Array<Measured | null>> {
    const out: Array<Measured | null> = descs.map(() => null);
    const starts: number[] = [];
    for (let i = 0; i < descs.length; i += 200) starts.push(i);
    return Promise.all(
      starts.map(
        (from) =>
          new Promise<void>((resolve) => {
            const batch = descs.slice(from, from + 200);
            const requestId = Math.random().toString(36).slice(2);
            requests.push(requestId);
            measureWaiters.current.set(requestId, (raw) => {
              measureWaiters.current.delete(requestId);
              const rects = measuredRects(raw, batch.length);
              batch.forEach((_, i) => (out[from + i] = rects?.[i] ?? null));
              resolve();
            });
            post('measure', { requestId, descs: batch.map((d) => ({ ctx: d.ctx, node: d.node, items: d.items, ...(d.slot !== undefined ? { slot: d.slot } : {}) })) });
          })
      )
    ).then(() => out);
  }
  /**
   * Previous (-1) or Next (1) item from the selection chip: the same part in the nearest item that way the page shows
   * it in, measured when asked, so a part a rule hides in some items (a button whose link is left empty) is never
   * selected where it has no outline. A way with no item showing it is then marked as one there is nothing to step
   * to. A page that doesn't answer leaves the plain neighbour. Presses take turns, each from where the last one went,
   * so a held key steps once per press. Only the selection changes; the new position is announced.
   */
  /** Presses waiting their turn, and what the next one steps from: where the press that started them was, then where
   *  each step went. Another selection meanwhile (a click, an Undo) drops the rest. */
  const stepping = useRef({ chain: Promise.resolve(), waiting: 0, from: '' });
  const onStep = (dir: -1 | 1) => {
    const q = stepping.current;
    if (!q.waiting) q.from = stepKey(getState());
    q.waiting++;
    q.chain = q.chain
      .then(() => stepItemSelection(dir))
      .catch(() => {})
      .finally(() => q.waiting--);
  };
  async function stepItemSelection(dir: -1 | 1) {
    const q = stepping.current;
    const s = getState();
    const st = s.snapshot?.state;
    const from = s.selection;
    const asked = stepKey(s);
    if (asked !== q.from) return;
    const info = st && from ? itemStep(st, from, s.templateMode ?? undefined) : null;
    if (!st || !from || !info || !stepItem(info.parts, info.n, dir)) return;
    // A page still showing an older version of the project tells nothing, and one that catches up while it answers may
    // have answered part of it from the older one.
    const current = shownRevision.current >= (s.snapshot?.revision ?? 0);
    const requests: string[] = [];
    const descs = info.parts.map((p) => (p && descFor(p)) ?? { ctx: '', node: '', items: '' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let measured: Array<Measured | null> | null;
    try {
      measured = await Promise.race([measureDescs(descs, requests), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), 1500)))]);
    } finally {
      clearTimeout(timer);
      for (const id of requests) measureWaiters.current.delete(id);
    }
    // A step answered after the selection, the project or what the page shows moved on (another click, an Undo, another
    // entry for a layout) is dropped.
    const now = getState();
    if (stepKey(now) !== asked) return;
    if (!current) measured = null;
    const to = stepItem(info.parts, info.n, dir, measured?.map((m) => !!m));
    if (!to) {
      if (measured) setStepBlocked((b) => ({ key: asked, prev: dir === -1 || (b?.key === asked && b.prev), next: dir === 1 || (b?.key === asked && b.next) }));
      return;
    }
    setState({ selection: to });
    q.from = stepKey(getState());
    const at = itemStep(st, to, s.templateMode ?? undefined);
    if (at) setAnnouncement(`${refLabel(st, to)}, ${at.n} of ${at.count}.`);
  }
  /** The elements the page shows for nodes of `owner`'s own tree (a drop's lists), and for a placement's empty slot (a
   *  slot key, see insert-drop) its placeholder; one that shows none named so. */
  const listDescs = (owner: OwnerRef, ids: string[]): BridgeDesc[] =>
    ids.map((id) => {
      const slot = slotOfKey(id);
      return descFor(slot ? { owner, instancePath: [], nodeId: slot.parentId, slot: slot.slot } : { owner, instancePath: [], nodeId: id }) ?? { ctx: '', node: '', items: '' };
    });

  /**
   * Drag a new section or element from Insert onto the page. The lists on the page that can take it are measured (and
   * measured again when the page shows a newer version or scrolls under the wheel); the pointer then picks a list and a
   * gap in it (lib/insert-drop), shown by a line and the outline of the container, and the release inserts it there as
   * one change, planned on the project as the drag found it. A place the project would refuse, or that no position
   * reaches, is shown as refused and says why on release. Escape, leaving the window, or releasing off the page
   * cancels. Only the pointer that started it moves or drops it. Returns false when the canvas can't take a drag now.
   */
  function startInsertDrag(drag: InsertDrag, start: { x: number; y: number; pointerId: number }): boolean {
    const s = getState();
    const snap = s.snapshot;
    if (!snap || snap.readOnly || s.mode !== 'edit' || s.definitionMode || !s.pageId || !getState().frameReady || dragging || insertDrag.current || assetDrag.current || resizeDrag.current) return false;
    const st = snap.state;
    const owner: OwnerRef = s.templateMode ? templateOwner(s.templateMode) : { kind: 'page', id: s.pageId };
    const role = insertRole(st, drag.spec);
    const dest = insertDestination(st, owner, role, incomingOrder(st, drag.spec), (at) => insertOps(at, drag.spec, role));
    if (!dest.specs.length) return false;
    startCanvasDrop<InsertAt>(
      {
        owner,
        name: drag.name,
        specs: dest.specs,
        lists: dest.lists,
        surfaces: dest.surfaces,
        idle: (over) => (over ? `Placing ${drag.name}` : `Drag ${drag.name} onto the page`),
        aim: (lists, x, y, z) => {
          const t = dest.aim(lists, x, y, z);
          return t && { at: t.at, refused: t.refused, line: t.line, outline: t.outline, label: t.refused ? `Can’t place ${drag.name} here` : t.where ? `${drag.name} ${whereText(t.where)}` : null };
        },
        // Planned on the project as the drag found it (see insertHere).
        drop: (at) => void insertHere(drag.spec, drag.name, role, at, snap, drag.tile),
        refuse: (why) => toast(`${drag.name} wasn’t added: ${why}`, 'info'),
        unanswered: () => toast(`The page didn’t answer, so ${drag.name} can’t be dragged onto it now. Click its tile to add it instead.`, 'info')
      },
      start
    );
    return true;
  }

  /**
   * A drag of something onto the page (see startInsertDrag, startMoveDrag). The lists on the page that can take it are
   * measured (and measured again when the page shows a newer version or scrolls under the wheel); the pointer then picks
   * a list and a gap in it, shown by a line and the outline of the container, and the release drops it there. A place
   * that is refused says why on release. Escape, leaving the window, or releasing off the page cancels. Only the pointer
   * that started it moves or drops it. `aim`'s label is null where the idle one says enough.
   */
  function startCanvasDrop<A>(
    d: {
      owner: OwnerRef;
      name: string;
      moving?: boolean;
      /** The selection it moves (see refKey): another selection meanwhile cancels it. */
      source?: string;
      /** Let go at this point, nothing is dropped, whether or not the page has been measured. */
      still?: (point: { x: number; y: number }) => boolean;
      specs: ListSpec[];
      lists: (measured: Map<string, Measured | null>) => DropList[];
      surfaces: (lists: DropList[]) => SlotSurface[];
      idle: (over: boolean) => string;
      aim: (lists: DropList[], x: number, y: number, scale: number, point: { x: number; y: number }) => { at: A | null; refused: string | null; line: Rect | null; outline: Rect | null; label: string | null } | null;
      drop: (at: A) => void;
      refuse: (why: string) => void;
      unanswered: () => void;
    },
    start: { x: number; y: number; pointerId: number }
  ) {
    const { owner, specs } = d;
    let lists: DropList[] | null = null;
    // The empty slots it can go into, drawn while it runs at the size a drop finds them (#652).
    let surfaces: SlotSurface[] = [];
    let point = { x: start.x, y: start.y };
    let done = false;
    // Released while the page was still being measured: the drop waits for the measure, at the release point.
    let released = false;
    // Where a release would put it now: the place, or why it can't go there, and whether the pointer is on the page.
    let aim: { at: A | null; refused: string | null; over: boolean } = { at: null, refused: null, over: false };
    /** What the canvas last drew for the drag: it renders again only when that changes, never for the pointer alone. */
    let drawn = '';
    const show = () => {
      perfCount('canvas.dropShows');
      const wrap = wrapRef.current?.getBoundingClientRect();
      const view = canvasRef.current?.querySelector('.canvas-scroll')?.getBoundingClientRect();
      const inBox = (b: DOMRect | undefined) => !!b && point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom;
      const over = inBox(wrap) && inBox(view);
      aim = { at: null, refused: null, over };
      let line: Rect | null = null;
      let outline: Rect | null = null;
      let label = d.idle(over);
      if (over && lists && wrap) {
        // The page's scale as it is drawn now (the panels beside the canvas can change it mid-drag).
        const z = wrap.width / getState().viewport;
        const t = d.aim(lists, (point.x - wrap.left) / z, (point.y - wrap.top) / z, z, point);
        if (t) {
          aim = { at: t.at, refused: t.refused, over };
          outline = t.outline;
          line = t.line;
          label = t.label ?? label;
        }
      }
      // Over a place that refuses it, the pointer says so too (see html.drop-refused).
      document.documentElement.classList.toggle('drop-refused', !!aim.refused);
      const clip = shownFrame()?.clip ?? null;
      // What it carries moves only once the page's boxes have been read: moved first, it would make the reads lay the window out again.
      const p = insertPoint.current;
      p.x = point.x;
      p.y = point.y;
      p.moved?.();
      const shown = { name: d.name, ...(d.moving ? { moving: true } : {}), over, line, outline, label, refused: aim.refused, surfaces: lists ? surfaces : [], clip };
      const key = JSON.stringify(shown);
      if (key === drawn) return;
      drawn = key;
      setInsertDrop(shown);
    };
    const requests: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One measure on its way at a time; asked for again meanwhile (a burst of wheel steps), one more follows it.
    let measuring = false;
    /** The lists were measured while the page still showed an older version of the project. */
    let listsBehind = false;
    let again = false;
    /** The lists were measured after the page's last scroll: only then does a release drop by them, at the place on the
     *  page now under the pointer. Until then the ones measured before it still show the line (a measure behind), so a
     *  scroll never takes it away. */
    let fresh = false;
    /** A measure asked for since the one on its way was asked for, of a page that has changed (not only scrolled): what
     *  that one finds is of the page before the change, and shows nothing. */
    let invalid = false;
    // Held near the canvas's top or bottom edge, the page scrolls (#904): one animation frame at a time while the pointer
    // stays in the band, by the distance its speed covers in the time since the last (`owed`, carried while a measure
    // is on its way, so the page scrolls only once what it shows has been measured).
    let scrollFrame = 0;
    let lastFrame = 0;
    let owed = 0;
    const listen = (on: boolean) => {
      if (on) {
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', cancel, true);
      } else {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', cancel, true);
      }
    };
    const end = (commit: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const id of requests) measureWaiters.current.delete(id);
      listen(false);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', wheel, true);
      cancelAnimationFrame(scrollFrame);
      document.documentElement.classList.remove('insert-dragging', 'drop-refused');
      insertDrag.current = null;
      setDragging(false);
      setInsertDrop(null);
      if (!commit || !aim.over) return;
      if (aim.refused) return void d.refuse(aim.refused);
      // Aimed on a page a save had not reached yet: where it would go was read from the page before the save.
      if (aim.at && (listsBehind || pageBehind())) return void d.refuse('the page was still updating. Drag it again.');
      if (aim.at) d.drop(aim.at);
    };
    /** Measure the page's lists, in batches the page answers (it reads at most 200 at a time); a node it can't show
     *  measures as nothing. A release drops by them only once they land. What was measured before no longer shows
     *  either, unless the page has only scrolled (`scrolled`): then it shows until the new measure replaces it. */
    const measure = (scrolled = false) => {
      fresh = false;
      if (!scrolled) {
        lists = null;
        invalid = true;
      }
      if (measuring) {
        again = true;
        return;
      }
      measuring = true;
      again = false;
      invalid = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (fresh || done) return;
        end(false);
        d.unanswered();
      }, 3000);
      const ids = measureIds(specs);
      // Measured on a page a save has not reached yet: where a drop would go is read from the page before the save.
      const behind = pageBehind();
      const asked = perfOn ? performance.now() : 0;
      perfCount('canvas.dropMeasures');
      perfCount('canvas.dropMeasured', ids.length);
      void measureDescs(listDescs(owner, ids), requests).then((rects) => {
        measuring = false;
        if (perfOn) perfMark('canvas.dropMeasure', { ms: performance.now() - asked, lists: ids.length });
        if (done) return;
        const take = () => {
          listsBehind = behind;
          lists = d.lists(new Map(ids.map((id, i) => [id, rects[i]])));
          surfaces = d.surfaces(lists);
          show();
        };
        // Scrolled again meanwhile: what this found shows until the next one lands, but drops nothing.
        if (again) {
          if (!invalid) take();
          return measure(true);
        }
        clearTimeout(timer);
        fresh = true;
        take();
        if (released) end(true);
      });
    };
    /** Scroll by `px` screen pixels: the canvas first, where it cuts off the frame's edge that way, and the page in its
     *  frame by the rest, measured again where it then shows. */
    const scrollStep = (px: number) => {
      const shown = shownFrame();
      const el = scrollRef.current;
      if (!shown || !el) return;
      let rest = px;
      const cut = px > 0 ? shown.wrap.bottom - shown.scroller.bottom : shown.wrap.top - shown.scroller.top;
      if ((px > 0 && cut > 0) || (px < 0 && cut < 0)) {
        const before = el.scrollTop;
        el.scrollTop += px > 0 ? Math.min(px, cut) : Math.max(px, cut);
        rest -= el.scrollTop - before;
      }
      if (Math.abs(rest) >= 1) {
        post('scrollBy', { y: rest / (shown.wrap.width / getState().viewport) });
        measure(true);
      }
      perfCount('canvas.dropScrolls');
      show();
    };
    const tick = (now: number) => {
      scrollFrame = 0;
      if (done || released) return;
      const shown = shownFrame();
      // Only on the page: off it (the room above it, say) a release cancels, and nothing scrolls under the pointer.
      const speed = shown && !d.still?.(point) ? edgeSpeed(point.x, point.y, shown.view) : 0;
      if (!speed) {
        // Out of the band it stops, until the pointer comes back to it.
        lastFrame = 0;
        owed = 0;
        return;
      }
      // A frame that came late (a busy renderer) scrolls no further than a tenth of a second does.
      const dt = lastFrame ? Math.min(now - lastFrame, 100) : 16;
      lastFrame = now;
      // Gone over to the other edge while a measure was on its way: what was owed the old way is dropped.
      if (owed * speed < 0) owed = 0;
      owed = Math.max(-200, Math.min(200, owed + (speed * dt) / 1000));
      if (!measuring && Math.abs(owed) >= 1) {
        const px = owed;
        owed = 0;
        scrollStep(px);
      }
      scrollFrame = requestAnimationFrame(tick);
    };
    const edge = () => {
      if (!scrollFrame && !done && !released) scrollFrame = requestAnimationFrame(tick);
    };
    const mine = (ev: PointerEvent) => ev.pointerId === start.pointerId;
    const move = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      point = { x: ev.clientX, y: ev.clientY };
      show();
      edge();
    };
    const up = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      point = { x: ev.clientX, y: ev.clientY };
      if (d.still?.(point)) return end(false);
      show();
      if ((lists && fresh) || !aim.over) return end(true);
      // Released on the page before it was measured where it now shows (scrolled since, say): dropped where it was let
      // go, once it is.
      released = true;
      cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      listen(false);
    };
    const cancel = (ev?: Event) => {
      if (ev instanceof PointerEvent && !mine(ev)) return;
      end(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    // The page scrolls inside its frame, which takes no pointer while a drag runs: the wheel over the canvas scrolls it
    // there, and what was measured is measured again where it now shows.
    const wheel = (ev: WheelEvent) => {
      if (released || !aim.over || !ev.deltaY) return;
      ev.preventDefault();
      post('scrollBy', { y: ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY });
      measure(true);
      show();
    };
    // Release and cancel are heard from the start, before the page is measured.
    listen(true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    document.documentElement.classList.add('insert-dragging');
    // Measured again, what was drawn from the old measures goes until the new ones land.
    insertDrag.current = {
      end,
      ...(d.source !== undefined ? { source: d.source } : {}),
      remeasure: () => {
        measure();
        show();
      }
    };
    setDragging(true);
    show();
    measure();
    // Picked up already in the band along an edge (a tile dragged straight there): it scrolls without another move.
    edge();
  }
  useEffect(() => {
    setInsertDropTarget(startInsertDrag);
    return () => setInsertDropTarget(null);
  });
  // A drag in progress ends with the canvas, and with the page, project or editing it was planned on.
  useEffect(() => () => insertDrag.current?.end(false), []);
  useEffect(() => insertDrag.current?.end(false), [view?.key, mode, session, snapshot?.workspaceKey, !!definitionMode]); // eslint-disable-line react-hooks/exhaustive-deps
  // A move ends with the selection it drags: another one meanwhile (in Layers, say) is not what it would move.
  const selectedKey = selection ? refKey(selection) : '';
  useEffect(() => {
    const d = insertDrag.current;
    if (d?.source !== undefined && d.source !== selectedKey) d.end(false);
  }, [selectedKey]);

  /**
   * Open an Add button's list (#387), for the place it stands for in the project as it is now: what fits there, as the
   * Insert panel would place each, less what the place would refuse (see offeredAt). `at`: where the button is drawn,
   * on `box`.
   */
  function openAdd(p: AddPoint, trigger: HTMLElement, at: { left: number; top: number }, box: AddBox) {
    const s = getState();
    const snap = s.snapshot;
    const to = snap && resolvePoint(snap.state, p);
    if (!snap || !view || !to || pageBehind()) return;
    const r = trigger.getBoundingClientRect();
    const items = offeredAt(snap.state, to, p.role, !!s.settings?.developerMode);
    // Nothing fits a placed component's slot that is full or takes nothing: the list says so, as the Inspector does.
    const parent = !items.length && to.parentId && to.slot !== undefined ? treeFor(snap.state, to.owner)?.nodes[to.parentId] : undefined;
    const empty = parent?.kind === 'instance' ? (slotOverviews(snap.state, to.owner, parent).find((o) => o.slot === to.slot)?.closed ?? null) : null;
    setAdding({ point: p, trigger, at, box, anchor: { left: r.left, top: r.top, width: r.width, height: r.height }, items, empty, opening: snap.workspaceKey, view: view.key, revision: snap.revision, refused: null });
  }
  /** Put the list away; `back` hands focus back to its button (or the canvas, once the button has gone). */
  function closeAdd(back: boolean) {
    const trigger = adding?.trigger;
    setAdding(null);
    if (!back) return;
    // Only focus the list left behind: anything that took focus meanwhile keeps it.
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body) (trigger?.isConnected ? trigger : canvasRef.current)?.focus({ preventScroll: true });
    });
  }
  /**
   * Add what was chosen at the list's place, as one change (see insertHere), on the project the list was made for: a
   * list the project, page or editing has moved on from (its closing not yet drawn) adds nothing. A choice the place
   * refuses stays in the list, saying why; a place that has gone says so.
   */
  function chooseAdd(it: QuickItem) {
    const a = adding;
    const s = getState();
    const snap = s.snapshot;
    if (!a || !snap || choosing.current) return;
    if (!addListHolds(a, s)) return closeAdd(true);
    const at = resolvePoint(snap.state, a.point);
    if (!at) {
      closeAdd(true);
      toast(`That place has changed, so ${it.name} wasn’t added. Try again.`, 'info');
      return;
    }
    const refused = dropRefusal(snap.state, insertOps(at, it.spec, a.point.role), () => savingProblems(snap.state));
    if (refused) return setAdding({ ...a, refused: `${it.name} can’t go here. ${refused}` });
    choosing.current = true;
    setAdding(null);
    // Focus stays on the canvas, where the new element is selected.
    canvasRef.current?.focus({ preventScroll: true });
    void insertHere(it.spec, it.name, a.point.role, at, snap).finally(() => (choosing.current = false));
  }
  // An open list goes with the page, project, revision or editing it was opened on, and in Preview. Focus its search
  // had goes to the canvas.
  useEffect(() => {
    if (!adding || addListHolds(adding, getState())) return;
    setAdding(null);
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body) canvasRef.current?.focus({ preventScroll: true });
    });
  }, [adding, mode, snapshot?.workspaceKey, snapshot?.revision, snapshot?.aiBusy, snapshot?.readOnly, view?.key, definitionMode]);
  // The page now shows a newer version: what a drag measured on it is measured again.
  useEffect(() => insertDrag.current?.remeasure(), [applied]);

  /**
   * Drag an image from Assets onto the page (#505, #506). As the pointer moves the page is asked what is under it. The
   * image a drop there changes (lib/image-drop) is outlined: the image itself, or off any image, the one empty image of
   * the component or list item the pointer is in. Where no image is targeted, the drop goes between content as a new
   * Image element, shown by the line and container outline an Insert tile shows there (the destination they share,
   * lib/insert-drop); a place that can't hold one shows no line. The release does what the page says is at the release
   * point, measured again there, as one change planned on the project as the drag found it; when that is not what the
   * drag showed as it was let go (the pointer outran the page's answers, or the page moved under it), nothing changes.
   * Escape, leaving the window, or releasing off the page cancels. Only the pointer that started it moves or drops it. Returns false when the canvas can't take a drag
   * now.
   */
  function startAssetDrag(drag: AssetDrag, start: { x: number; y: number; pointerId: number }): boolean {
    const s = getState();
    const snap = s.snapshot;
    if (!snap || snap.readOnly || s.mode !== 'edit' || s.definitionMode || s.templateMode || !s.pageId || !getState().frameReady || dragging || insertDrag.current || assetDrag.current || resizeDrag.current) return false;
    const st = snap.state;
    const opening = snap.workspaceKey;
    const revision = snap.revision;
    const owner: OwnerRef = { kind: 'page', id: s.pageId };
    const targets = imageDropTargets(st, s.pageId);
    // Between content, a new Image element holding the image, where an Insert tile's Image would go (it has no Order).
    const dest = insertDestination(st, owner, 'element', 0, (at) => imageInsertOps(at, drag.assetId, newId('n')), 'use Place on page');
    const listIds = measureIds(dest.specs);
    // What is outlined for an empty image the pointer is not on (its own box, or the card that will show it); an empty
    // image whose box the page does not show now (in a tab not chosen) is not counted.
    const boxes = [...new Map(targets.filter((t) => t.unfilled).map((t) => [descKey(t.box), t.box])).values()];
    const boxOf = (t: ImageTarget) => {
      const m = measured?.get(descKey(t.box));
      // An image shown more than once can't say which copy would be outlined.
      return m && !m.many ? { x: m.x, y: m.y, width: m.width, height: m.height } : null;
    };
    // Shown now, once or more: every such empty image counts, though only one shown once can be outlined.
    const showing = (t: ImageTarget) => !!measured?.get(descKey(t.box));
    // The empty images' boxes and the page's lists, measured together where the page is now scrolled to.
    let measured: Map<string, Measured | null> | null = null;
    let lists: DropList[] | null = null;
    let point = { x: start.x, y: start.y };
    let done = false;
    // The page's latest answer, and the point it was asked about.
    let pointed: (NonNullable<ReturnType<typeof pointedAt>> & { at: { x: number; y: number } }) | null = null;
    // Released on the page: the drop waits for the page's answer about the release point, asked after the release (the
    // page may have moved under a pointer that did not), and for the boxes and lists it needs.
    let released = false;
    let fresh = false;
    // What a release now does, and whether the pointer is on the page.
    let aim: AssetAim = { kind: 'none' };
    let over = false;
    // What the drag last showed a drop on the page would do, once known (an aim pending a moment, after a wheel step,
    // leaves it on screen until the next is drawn), and what it showed as it was let go.
    let seen: AssetAim = { kind: 'pending' };
    let shown: AssetAim = { kind: 'pending' };
    // Let go anywhere but on an image: the page is measured again once, after its answer about the release point.
    let remeasured = false;
    // Counts the wheel steps: the page's answer to a question asked before the latest one says what was there before it
    // scrolled.
    let scrolls = 0;
    const requests: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asking = false;
    let askAgain = false;
    let measuring = false;
    let measureAgain = false;
    // The page's scroll the boxes were measured at (as the latest answer had it): the page scrolled since, they are
    // measured again.
    let scrolled: string | null = null;
    let measuredAt: string | null = null;
    const word = drag.name;
    /** The window point in the page's own pixels, and the page's scale, when it is over the page on screen and nothing of
     *  the editor's (a menu, a note) covers it there. The page takes no pointer while the drag runs, so the window finds
     *  what is over it. */
    const onPage = (): { x: number; y: number; z: number } | null => {
      const wrap = wrapRef.current?.getBoundingClientRect();
      const view = canvasRef.current?.querySelector('.canvas-scroll')?.getBoundingClientRect();
      const inBox = (b: DOMRect | undefined) => !!b && point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom;
      if (!wrap || !inBox(wrap) || !inBox(view)) return null;
      const top = document.elementFromPoint(point.x, point.y);
      if (!top || !wrapRef.current?.contains(top)) return null;
      const z = wrap.width / getState().viewport;
      return { x: (point.x - wrap.left) / z, y: (point.y - wrap.top) / z, z };
    };
    const show = () => {
      // A drag that has ended (an answer it was waiting on found the pointer off the page) shows nothing again.
      if (done) return;
      const page = onPage();
      over = !!page;
      aim = { kind: 'pending' };
      if (page && pointed) {
        const picture = pointed.picture ? { src: pointed.picture.src, own: pointed.picture.own } : null;
        const hit = resolveImageDrop(st, targets, { chain: pointed.chain, picture }, showing);
        // On the image, the element under the pointer; off it, the empty image's box.
        const outline = hit ? (hit.direct ? (hit.target.code ? (pointed.picture?.rect ?? null) : pointed.rect) : boxOf(hit.target)) : null;
        aim = assetAim(hit, outline, !!measured && !!lists, () => (lists ? dest.aim(lists, page.x, page.y, page.z) : null));
      }
      // Off the page nothing is shown to go anywhere.
      if (!over) seen = { kind: 'pending' };
      else if (aim.kind !== 'pending') seen = aim;
      const ins = aim.kind === 'insert' ? aim.aim : null;
      const label = !over
        ? `Drag ${word} onto the page`
        : aim.kind === 'image'
          ? aim.target.unfilled
            ? `Place ${word} as ${aim.target.label}`
            : `Replace ${aim.target.label} with ${word}`
          : ins?.refused
            ? `Can’t place ${word} here`
            : ins?.where
              ? `Place ${word} ${whereText(ins.where)}`
              : aim.kind === 'pending'
                ? `Place ${word} on the page`
                : `Point at an image or between content to put ${word} there`;
      const idle = over && aim.kind !== 'image' && !ins?.at && !ins?.refused;
      // Where it isn't filling an image, the empty slots a new Image could go into light up, as for an Insert tile.
      const surfaces = over && aim.kind !== 'image' && lists ? dest.surfaces(lists) : [];
      document.documentElement.classList.toggle('drop-refused', !!ins?.refused);
      // The part of the page the canvas shows, so the line and the reason stay where they are seen (#904).
      const clip = shownFrame()?.clip ?? null;
      setImageDrop({ name: word, x: point.x, y: point.y, over, idle, outline: aim.kind === 'image' ? aim.outline : null, line: ins?.line ?? null, list: ins?.outline ?? null, label, refused: ins?.refused ?? null, surfaces, clip });
    };
    // An image the page says is at the release point needs nothing measured; anywhere else, what was measured after the
    // page's answer about it (see `ask`).
    const ready = () => released && fresh && !!pointed && pointed.at.x === point.x && pointed.at.y === point.y && !asking && (aim.kind === 'image' || (!!measured && !!lists));
    /** Ask the page what is under the pointer; one question on its way at a time, the latest place asked after it. */
    const ask = () => {
      if (done) return;
      if (asking) {
        askAgain = true;
        return;
      }
      const at = onPage();
      if (!at) {
        pointed = null;
        show();
        if (released) end(false);
        return;
      }
      asking = true;
      askAgain = false;
      const asked = { ...point };
      const late = released;
      const step = scrolls;
      const requestId = Math.random().toString(36).slice(2);
      requests.push(requestId);
      measureWaiters.current.set(requestId, (raw) => {
        measureWaiters.current.delete(requestId);
        asking = false;
        if (done) return;
        // An answer from a page still showing an older version of the project than the drag found counts for nothing
        // (its elements may show other fields): the page is asked again once it shows that version (see `applied`). Nor
        // does one asked before the page last scrolled, which is asked again (see `wheel`).
        const p = shownRevision.current >= revision && step === scrolls ? pointedAt(raw) : null;
        pointed = p ? { ...p, at: asked } : null;
        if (late && p) fresh = true;
        if (p) scrolled = p.scroll;
        const moved = !!p && p.scroll !== measuredAt;
        if (moved) measure();
        if (askAgain) ask();
        if (done) return;
        // Covered since it was let go (a menu or note of the editor's over the release point): nothing changes.
        if (late && p && !onPage()) return end(false);
        show();
        // Let go anywhere but on an image: the place goes by the page as it lays out now (a picture or font that loaded
        // while the pointer was still can move it without a scroll), measured again after this answer, never ahead of it.
        if (late && p && !remeasured && aim.kind !== 'image') {
          remeasured = true;
          if (!moved) measure();
          return;
        }
        if (ready()) end(true);
      });
      post('pointAt', { requestId, x: at.x, y: at.y });
    };
    /** Measure the boxes outlined for empty images and the page's lists, together. */
    const measure = () => {
      if (done) return;
      measured = null;
      lists = null;
      if (measuring) {
        measureAgain = true;
        return;
      }
      measuring = true;
      measureAgain = false;
      measuredAt = scrolled;
      void measureDescs([...boxes, ...listDescs(owner, listIds)], requests).then((rects) => {
        measuring = false;
        if (done) return;
        if (measureAgain) return measure();
        measured = new Map(boxes.map((d, i) => [descKey(d), rects[i]]));
        lists = dest.lists(new Map(listIds.map((id, i) => [id, rects[boxes.length + i]])));
        show();
        if (ready()) end(true);
      });
    };
    const listen = (on: boolean) => {
      if (on) {
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', cancel, true);
      } else {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', cancel, true);
      }
    };
    const end = (commit: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const id of requests) measureWaiters.current.delete(id);
      listen(false);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', wheel, true);
      document.documentElement.classList.remove('insert-dragging', 'drop-refused');
      assetDrag.current = null;
      setDragging(false);
      setImageDrop(null);
      if (!commit || !over || getState().snapshot?.workspaceKey !== opening) return;
      const at = aim.kind === 'insert' ? aim.aim.at : null;
      // What is at the release point is not what the drag showed there as it was let go (the pointer outran the page's
      // answers, or the page moved under it): neither is done. Nothing shown yet promised nothing, so it is done.
      const promised = aimKey(shown);
      if (promised !== null && promised !== aimKey(aim)) {
        const acts = (a: AssetAim) => a.kind === 'image' || (a.kind === 'insert' && !!a.aim.at);
        if (acts(shown) || acts(aim)) toast(`Where ${word} would go changed as it was let go, so it wasn’t placed. Drag it again.`, 'info');
        return;
      }
      if (aim.kind === 'image') void dropAsset(drag.assetId, aim.target, revision);
      else if (at) void dropAssetAt(drag.assetId, at, revision);
      else if (aim.kind === 'insert' && aim.aim.refused) toast(`${word} wasn’t placed: ${aim.aim.refused}`, 'info');
    };
    const mine = (ev: PointerEvent) => ev.pointerId === start.pointerId;
    const move = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      point = { x: ev.clientX, y: ev.clientY };
      show();
      ask();
    };
    const up = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      point = { x: ev.clientX, y: ev.clientY };
      released = true;
      listen(false);
      // Let go off the page (or over the editor's own menus and notes): nothing changes.
      if (!onPage()) return end(false);
      // What the drag last showed on the page as it is let go: a release does that, or nothing.
      shown = seen;
      // The drop goes where it was let go, once the page has said what is there now.
      timer = setTimeout(() => {
        if (done) return;
        end(false);
        toast(`The page didn’t answer, so ${word} wasn’t placed. Drag it again.`, 'info');
      }, 3000);
      ask();
    };
    const cancel = (ev?: Event) => {
      if (ev instanceof PointerEvent && !mine(ev)) return;
      end(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    // The page scrolls inside its frame, which takes no pointer while a drag runs: the wheel over the canvas scrolls it
    // there. What the page said and what was measured no longer hold until it is asked again where it now shows (its
    // answer then has the boxes and lists measured again).
    const wheel = (ev: WheelEvent) => {
      if (released || !onPage() || !ev.deltaY) return;
      ev.preventDefault();
      post('scrollBy', { y: ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY });
      scrolls++;
      pointed = null;
      measuredAt = null;
      show();
      ask();
    };
    listen(true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    document.documentElement.classList.add('insert-dragging');
    assetDrag.current = {
      end,
      remeasure: () => {
        measure();
        ask();
      }
    };
    setDragging(true);
    show();
    // The boxes and lists are measured once the page has said where it is scrolled to.
    ask();
    return true;
  }
  useEffect(() => {
    setAssetDropTarget(startAssetDrag);
    return () => setAssetDropTarget(null);
  });
  // As for a drag from Insert: it ends with the canvas, and with the page, project or editing it was planned on.
  useEffect(() => () => assetDrag.current?.end(false), []);
  useEffect(() => assetDrag.current?.end(false), [view?.key, mode, session, snapshot?.workspaceKey, !!definitionMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => assetDrag.current?.remeasure(), [applied]);

  // Drag-to-resize viewport. The frame stays centered, so both edges follow the pointer, within the widths the
  // toolbar's width field accepts. The handle captures the pointer (as the panel splitters do), so the drag always
  // hears its release; the width is remembered once, for the opening it was made in. One drag at a time: a second
  // pointer, or one pressed during a block reorder, is ignored.
  const startResize = (e: React.PointerEvent<HTMLDivElement>, side: PanelSide) => {
    if (e.button !== 0 || resizeDrag.current || dragging) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Escape puts the width back where the drag found it.
    const onKey = (ev: KeyboardEvent) => {
      const d = resizeDrag.current;
      if (ev.key !== 'Escape' || !d) return;
      ev.preventDefault();
      ev.stopPropagation();
      d.changed = false;
      setState({ viewport: d.from });
      endResize();
    };
    window.addEventListener('keydown', onKey, true);
    resizeDrag.current = { el: e.currentTarget, pointer: e.pointerId, x: e.clientX, from: getState().viewport, zoom, opening: getState().snapshot?.workspaceKey, changed: false, onKey };
    setDragging(true);
    setResizing(side);
  };
  const moveResize = (e: React.PointerEvent<HTMLDivElement>, side: PanelSide) => {
    const d = resizeDrag.current;
    if (d?.pointer !== e.pointerId) return;
    // Another project opened under the drag: it is not this one's to resize.
    if (getState().snapshot?.workspaceKey !== d.opening) return endResize();
    const w = clampViewport(d.from + ((e.clientX - d.x) / d.zoom) * 2 * (side === 'right' ? 1 : -1));
    if (w === getState().viewport) return;
    setState({ viewport: w });
    d.changed = true;
  };
  /** End the resize in progress, if any (only `pointer`'s, when given): on release, or when its handle goes away. */
  const endResize = (pointer?: number) => {
    const d = resizeDrag.current;
    if (!d || (pointer !== undefined && d.pointer !== pointer)) return;
    resizeDrag.current = null;
    window.removeEventListener('keydown', d.onKey, true);
    setDragging(false);
    setResizing(null);
    if (d.el.isConnected && d.el.hasPointerCapture(d.pointer)) d.el.releasePointerCapture(d.pointer);
    if (d.changed && getState().snapshot?.workspaceKey === d.opening) saveLocal({ viewport: getState().viewport });
  };
  // The handles go with the frame (the preview restarting, the project closing) and the canvas: a drag they held
  // ends where it is, so the frame never stays unclickable behind a drag nobody can release.
  const frameShown = !!(url && initialSrc);
  useEffect(() => {
    if (!frameShown) endResize();
  }, [frameShown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => endResize(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const frameHandle = (side: PanelSide) => (
    <div
      // Only the edge being dragged lights up (a block reorder lights neither).
      className={`frame-handle ${side}${resizing === side ? ' dragging' : ''}`}
      tabIndex={0}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={viewport}
      aria-valuemin={VIEWPORT_LIMITS.min}
      aria-valuemax={VIEWPORT_LIMITS.max}
      aria-valuetext={`${viewport} pixels`}
      aria-label={`Preview width, ${side} edge`}
      title="Drag to resize, or use the arrow keys"
      onPointerDown={(e) => startResize(e, side)}
      onPointerMove={(e) => moveResize(e, side)}
      onPointerUp={(e) => endResize(e.pointerId)}
      onPointerCancel={(e) => endResize(e.pointerId)}
      onLostPointerCapture={(e) => endResize(e.pointerId)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const w = frameKeyResize(side, e.key, getState().viewport);
        if (w !== null) setViewport(w);
      }}
    />
  );

  // A project's first page keeps the outline the window showed from the click on its card (App, EditorSkeleton) until
  // it is ready to edit: the preview being started, then the page loading, read as one wait. Only a wait that has
  // something to say takes its card instead: the website tools being set up, a start running long, a stop, a page
  // that failed. Each opening has its first page once; later pages, restarts and retries show as they always have.
  // Not for a project followed from another computer, whose preview is the host's to start or pause.
  const slowWait = useSlowWait(runtime);
  const [firstPageOf, setFirstPageOf] = useState<string | null>(null);
  // Marked by this opening's own frame: a new opening starts with the frame not ready and no page problem (App's
  // openSnapshot), so nothing the project open before reported can mark it.
  useEffect(() => {
    if (frameReady && runtime.state === 'ready' && workspaceKey) setFirstPageOf(workspaceKey);
  }, [frameReady, runtime.state, workspaceKey]);
  const outlined = outlinesFirstPage({
    pending: !!workspaceKey && firstPageOf !== workspaceKey && !isRemoteOpening(workspaceKey) && !frameError && !retrying,
    runtime: runtime.state,
    slow: slowWait,
    frameShown,
    frameReady,
    onPage: mode === 'edit' && !templateMode && !studioView
  });
  // The opening's one loading sign: the status bar and the announcements leave the first page's wait to it.
  useLayoutEffect(() => {
    if (getState().openingPage !== outlined) setState({ openingPage: outlined });
  }, [outlined]);
  useEffect(() => () => setState({ openingPage: false }), []);
  // The page arriving takes the outline's place by a short fade, the outline lifting off the page underneath; with
  // reduced motion, or when the wait ended any other way (a card, a problem), at once.
  const [fadingOutline, setFadingOutline] = useState(false);
  const wasOutlined = useRef(false);
  // The render the page arrives in keeps the outline mounted (the same one, its sign included), before the effect
  // below starts its fade: never a frame without it, nor a fresh copy of it.
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pageArriving = !outlined && wasOutlined.current && frameReady && !reduced;
  useEffect(() => {
    const was = wasOutlined.current;
    wasOutlined.current = outlined;
    if (outlined || !was || !frameReady || reduced) return setFadingOutline(false);
    setFadingOutline(true);
    const t = setTimeout(() => setFadingOutline(false), OUTLINE_FADE_MS);
    return () => clearTimeout(t);
  }, [outlined]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snapshot) return <div className="canvas" />;

  // The frame shows a page the editor has not confirmed (one leaving, or one that never arrived): it takes no picks,
  // nothing is drawn on it, and it steps back. "Opening" is that, before anything has been reported wrong.
  const staleFrame = runtime.state === 'ready' && !!url && !frameReady && mode === 'edit';
  // A layout with no entry to show it on: the page left behind is covered, and out of the tab order with it.
  const noEntries = !!templateMode && !!state && !view?.route;
  const opening = staleFrame && !frameError;
  // A page that is showing but threw is not "couldn't be previewed", while editing or in Preview: something on it went
  // wrong. Only while editing does a page that never opened say how long it was waited for.
  // What the page's error can be put down to, while it still holds: the same error, the change still History's newest
  // and undoable (not while the AI works), the component still in the project.
  const cause = issueCause && issueCause.message === frameError && !slowPage ? issueCause : null;
  const revertOffered = cause?.revert && snapshot?.history.canUndo && !snapshot.aiBusy && !snapshot.readOnly && stillNewest(snapshot.history, cause.revert.key) ? cause.revert : null;
  const sourceOffered = cause?.definitionId && snapshot?.state.components[cause.definitionId] ? cause.definitionId : null;
  /** What went wrong, under the bar's own words, naming the component it was put down to (#1526). */
  const issueDetail = cause && frameReady && !slowPage ? (sourceOffered ? `${snapshot!.state.components[sourceOffered].name}: ${cause.message}` : cause.message) : null;
  /** Load the page again, as Try again does. In Component Studio the preview is prepared again, from the project as it is now. */
  const restartPreview = () => {
    if (reverting) return;
    setRetrying(true);
    if (getState().definitionMode?.studio) setStudioRetry((n) => n + 1);
    else setSession(newSessionId());
  };
  /** Undo the change the page broke after, then load the page again so it comes back without it. */
  const revertIssue = () => {
    const snap = getState().snapshot;
    if (retrying || reverting || !revertOffered || !snap) return;
    setReverting(true);
    void stepHistory(revertOffered.id, 'undo', 1, snap).then(
      (r) => {
        setReverting(false);
        if (!r.ok) return toast(r.error?.message ?? 'That change couldn’t be reverted.', 'error');
        setRetrying(true);
        if (getState().definitionMode?.studio) setStudioRetry((n) => n + 1);
        else setSession(newSessionId());
      },
      (e: unknown) => {
        setReverting(false);
        toast(errorText(e), 'error');
      }
    );
  };
  const issueText = mode === 'edit' && slowPage && frameError ? frameError : frameReady ? 'Something on this page didn’t work.' : 'This page couldn’t be previewed.';
  const z = zoom;
  const frameW = viewport * z;
  // Edges land on device pixels, so a 1px keyline at a fractional zoom is one crisp pixel, not two faint ones.
  const dpr = window.devicePixelRatio || 1;
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const toBox = (r: Rect) => {
    const left = snap(r.x * z);
    const top = snap(r.y * z);
    return { left, top, width: snap((r.x + r.width) * z) - left, height: snap((r.y + r.height) * z) - top };
  };
  // The drop line keeps the same weight at any zoom (see dropLineBox), inside the part of the page the canvas shows
  // (`clip`, from the drag; the whole frame without one), so the place a drop takes is always seen (#904).
  const dropBox = (r: Rect, clip?: EdgeView | null) => dropLineBox(toBox(r), clip ?? { left: 0, top: 0, right: frameW, bottom: frameH * z }, snap);
  // Text and other small parts get a few pixels of breathing room, so the outline (drawn inside its box) never
  // touches the glyphs. While editing everywhere, the component's own nodes are its parts; its root stands for
  // the whole design.
  const inDef = !!definitionMode && inDefinition(selection, definitionMode.definitionId);
  const defRoot = inDef && !selection!.instancePath.length && state?.components[definitionMode!.definitionId]?.tree?.rootIds[0] === selection!.nodeId;
  const isPart = !!selection?.instancePath.length || (inDef && !defRoot);
  // Text and links placed straight on the page get the same room as parts: the ring is drawn inside the box.
  const textKind = (ref: ElementRef | null) => !!ref && !!state && ['text', 'link'].includes(resolveRef(state, ref).node?.kind ?? '');
  const pad = isPart || textKind(selection) ? 6 : 0;
  // While another page opens, what is outlined belongs to the page that is leaving: nothing is drawn on it.
  const selBoxes = mode === 'edit' && !stylesOpen && !staleFrame ? rects.selected.map(toBox).map((b) => ({ left: b.left - pad, top: b.top - pad, width: b.width + pad * 2, height: b.height + pad * 2 })) : [];
  // A hovered part gets the same room as a selected one, so its outline does not jump when it is clicked.
  const hovDef = !!definitionMode && inDefinition(hover, definitionMode.definitionId);
  const hovPad = hover?.instancePath.length || textKind(hover) || (hovDef && !(!hover!.instancePath.length && state?.components[definitionMode!.definitionId]?.tree?.rootIds[0] === hover!.nodeId)) ? 6 : 0;
  const hovBoxes = mode === 'edit' && !staleFrame ? rects.hovered.map(toBox).map((b) => ({ left: b.left - hovPad, top: b.top - hovPad, width: b.width + hovPad * 2, height: b.height + hovPad * 2 })) : [];
  // A part of a repeated item selected on the page, and outlined there, already marks its item: the item stays
  // revealed, without a second outline.
  const selShown = rects.selected.some((r) => r.y + r.height > 0 && r.y < frameH);
  const revBoxes = mode === 'edit' && !staleFrame && !(selection?.itemPath?.length && selShown) ? rects.revealed.map(toBox) : [];
  const selLabel = selection && state ? chromeLabel(state, selection) : '';
  const hovering = hover && !sameRef(hover, selection) && !reorder && !dragging && !menu.isOpen;
  const firstSel = selBoxes[0];
  // Only on the inserted element's own outline, and not once it is being moved or its text typed.
  const arriving = !!arrival && !!selection && arrival.key === refKey(selection) && !reorder && !editing;
  // What the page draws of the selection's outline while it scrolls: the plain outline only, as drawn below (no repeated
  // items dimmed, nothing moved, placed, typed or arriving), and not while a control on it is in use.
  const plainInk = selBoxes.length > 0 && !!selection && !(selection.itemPath?.length && selBoxes.length > 1) && !insertDrop && !imageDrop && !reorder && !editing && !arriving && !adding && !dragging && !resizing;
  ghostKey.current = plainInk ? JSON.stringify({ pad, z, dpr, shared: selection?.owner.kind === 'shell', defining: !!definitionMode }) : null;
  // Only while the page's outline is drawn for what the editor would draw now: a change of zoom shows the editor's own
  // until the page has drawn the outline again for it.
  const inkPaged = plainInk && !!paged && paged === JSON.stringify([refKey(selection!), ghostKey.current]);
  // Spacing handles sit on the selected box itself (not its outline's breathing room), while editing and not while
  // text is being typed, a block moved, the page resized or a component's design edited everywhere.
  const spaceDesc = selection ? descFor(selection) : null;
  // The page's report must be for this selection: one from before it changed measured something else.
  // A code component's marked part has no spacing handles: a report for its placement is never one for the part.
  const spaceFor = !!spacing && !!spaceDesc && !spaceDesc.part && spaceDesc.slot === undefined && spacing.desc.ctx === spaceDesc.ctx && spacing.desc.node === spaceDesc.node && spacing.desc.items === spaceDesc.items;
  // The selection's chip is parked in the strip above the page (see chipLeft). A collection layout's band is a row of
  // its own above that strip, so the chip always has the strip's whole width.
  const chipShown = !!firstSel && !!selection;
  const spaceShown = selBoxes.length > 0 && spaceFor && !!state && !editing && !reorder && !insertDrop && !imageDrop && !resizing && !definitionMode && !snapshot?.aiBusy && !snapshot?.readOnly;
  // The canvas's Add buttons (#387), on the box of the selection and of what is hovered, each only on a box the page
  // measured for it (one copy: a repeated item's place would be every item's). Below one section and above the next
  // are one place, drawn once, the selection's first. While a list is open, only its own button is drawn, where it was.
  const addOwner: OwnerRef | null = templateMode ? templateOwner(templateMode) : pageId ? { kind: 'page', id: pageId } : null;
  // Whether the grip can drag the selection to another place on the page (see startMoveDrag): an element of the page's
  // own tree, inside a section, as the page shows it once.
  const canMoveSelection = (() => {
    const t = state && mode === 'edit' && !definitionMode && !snapshot?.readOnly && !snapshot?.aiBusy && addOwner && selection && !selection.itemPath?.length && !selection.instancePath.length ? structuralTarget(selection, { state }) : null;
    if (!t || t.owner.kind !== addOwner!.kind || t.owner.id !== addOwner!.id) return false;
    const tree = treeFor(state!, t.owner);
    return !!tree && !!findParent(tree, t.nodeId)?.parentId;
  })();
  const addReady = mode === 'edit' && !!state && !!addOwner && frameReady && !staleFrame && !stylesOpen && !definitionMode && !editing && !reorder && !resizing && !insertDrop && !dragging && !snapshot?.readOnly && !snapshot?.aiBusy && !menu.isOpen;
  const measuredFor = (a: BridgeDesc | null, b: BridgeDesc | null) => !!a && !!b && a.ctx === b.ctx && a.node === b.node && (a.items || '') === (b.items || '') && (a.part || '') === (b.part || '') && a.slot === b.slot;
  /** Where a selected placement's Add button is drawn: on the selection's box, or on its own slot's (onSlot), once the
   *  page has measured that slot for it. */
  const selectedBox = (p: AddPoint): AddBox | null => {
    if (!p.onSlot) return toBox(rects.selected[0]);
    const d = selection ? descFor({ ...selection, slot: p.slot }) : null;
    const hit = slotRects.find((r) => measuredFor(r.desc, d));
    return hit ? toBox(hit.box) : null;
  };
  // The selection's own writing direction, from the page's report for it: its inside + goes in the trailing corner.
  const selRtl = spaceFor && !!spacing?.rtl;
  const addButtons: Array<{ p: AddPoint; box: AddBox; rtl?: boolean }> = adding
    ? [{ p: adding.point, box: adding.box }]
    : !addReady
    ? []
    : [
        ...(rects.selected.length === 1 && measuredFor(rectsFor.current.selected, spaceDesc)
          ? addPoints(state!, addOwner!, selection).flatMap((p) => {
              const box = selectedBox(p);
              return box ? [{ p, box, rtl: selRtl }] : [];
            })
          : []),
        ...(hovering && rects.hovered.length === 1 && measuredFor(rectsFor.current.hovered, descFor(hover)) ? addPoints(state!, addOwner!, hover, true).map((p) => ({ p, box: toBox(rects.hovered[0]) })) : [])
      ].filter((b, i, all) => all.findIndex((o) => o.p.key === b.p.key) === i);
  // The shared header's boxes as the page shows them now: an edge's Add button keeps off them (see placeAdd).
  const headerBoxes = rects.headers.map(toBox);
  const placedAdds = placeAdds(
    addButtons.map((b) => ({ ...b, key: b.p.key, side: b.p.side })),
    { width: frameW, height: frameH * z },
    headerBoxes,
    adding?.at
  );
  const device = viewport < 768 ? 'Phone' : viewport < 1024 ? 'Tablet' : 'Desktop';
  const scalePct = Math.round(z * 100);
  // The width label shares the strip with a parked chip: in full, then the width and zoom, then just the width,
  // then not at all, whichever fits beside the chip. While the frame is being resized it always shows in full.
  // The same goes for what the strip says on its left (a page opening, a section moving), which never takes more
  // room than leaves the width itself.
  const chipEnd = chipShown && !reorder && !resizing && !insertDrop && !imageDrop && firstSel ? chipLeft(firstSel.left, chipW, frameW) + chipW + 12 : 0;
  const leftEnd = chipEnd || (stripLeftW ? stripLeftW + 12 : 0);
  const labelMode = resizing || leftEnd + labelW.full <= frameW ? 'full' : scalePct !== 100 && leftEnd + labelW.mid <= frameW ? 'mid' : leftEnd + labelW.short <= frameW ? 'short' : 'gone';
  const stripRoom = Math.max(80, frameW - labelW.short - 12);
  // Where the card goes, in page pixels: at the top of the empty page's room, below a header that covers its start.
  // Where the room or the frame is too short for it (scrolled away, a low window), the strip says it instead.
  const emptyAt = emptyArea && emptyArea.key === pageId ? Math.max(emptyArea.top, emptyArea.headerBottom) : null;
  // The room counts as the size asked for until the page reports it, so a change of zoom never swaps the card (and
  // the focus on its buttons) for the strip while the page catches up.
  const emptyEnd = emptyArea ? emptyArea.top + Math.max(emptyArea.height, emptyRoom) : 0;
  const emptyFits = emptyAt !== null && emptyAt * z + 24 + emptyCardH <= frameH * z && 24 + emptyCardH <= (emptyEnd - emptyAt) * z + 1;
  // While the AI works, the page's copy waits: a question it asks would take over the message box, and the copy would
  // become the answer. A project open read-only takes no AI edits.
  const aiWorking = !!runStatus || turnOpen;
  const writeWithAi = (className: string) =>
    snapshot?.readOnly ? null : (
      <button
        className={className}
        disabled={aiWorking}
        title={aiWorking || runStatus === 'awaiting-input' ? aiRunning(runStatus, 'use this') : 'Open the AI panel to paste copy for this page or describe what goes on it'}
        onClick={() => pageId && writePageWithAi(pageId)}
      >
        <Sparkles /> <span>Write with AI</span>
      </button>
    );
  // The strip offers the first steps when there is no room for the card, or on a page that has only its title.
  // Where a drag of something new would go between content, the same for a tile from Insert and an image from Assets.
  const between = insertDrop ?? (imageDrop && { outline: imageDrop.list, line: imageDrop.line, refused: imageDrop.refused, surfaces: imageDrop.surfaces, clip: imageDrop.clip });
  /** Where a refusal's reason hangs (#652): from the top edge of the place it is about, outside it, so what the pointer
   *  carries (below and right of the pointer, inside the place) never covers it; below the place where the shown page
   *  has no room above it, and just inside the top of the part of the place that shows where it has room for neither.
   *  It starts at the place's start, or ends at its end where the shown page's edge is nearer, so it stays on screen
   *  however narrow the place; it is measured in its own type, and past about 400px, or the page's width, it wraps. */
  const reasonAt = (b: { left: number; top: number; width: number; height: number }, text: string, clip?: EdgeView | null): { style: React.CSSProperties; edge: 'above' | 'below' | 'inside' } => {
    const view = clip ?? { left: 0, top: 0, right: frameW, bottom: frameH * z };
    // The tag's glyph, gap and padding take 32px, each line 16px and its padding 6px; it stands 5px off the place.
    const most = Math.min(Math.max(b.width - 12, 400), view.right - view.left - 8);
    const wrapped = wrapLabel(text, most - 32);
    const width = Math.ceil(wrapped.widest) + 34;
    const need = wrapped.lines * 16 + 6 + 5 + 4;
    const edge = b.top - view.top >= need ? 'above' : view.bottom - (b.top + b.height) >= need ? 'below' : 'inside';
    const inset = edge === 'inside' ? 6 : 0;
    const top = edge === 'above' ? b.top : edge === 'below' ? b.top + b.height + 5 : Math.max(b.top, view.top) + inset;
    const left = b.left + inset + width <= view.right - 4 ? Math.max(view.left + 4, b.left + inset) : Math.max(view.left + 4, Math.min(b.left + b.width - inset, view.right - 4) - width);
    return { edge, style: { top, left, width } };
  };
  // The empty slot under the pointer, among those lit, takes the place's filled name tag.
  const sameBox = (a: Rect | null | undefined, b: Rect) => !!a && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
  // The shared header or footer selected turns the canvas's marks green; placing something new on the page, which the
  // selection steps aside for, keeps the page's blue.
  const selShared = selection?.owner.kind === 'shell' && !definitionMode && !(insertDrop && !insertDrop.moving) && !imageDrop;
  const stripStart = !staleFrame && !resizing && !reorder && !insertDrop && !imageDrop && !chipShown && ((emptyPage && emptyAt !== null && !emptyFits) || titleOnly);

  return (
    <main
      ref={canvasRef}
      tabIndex={-1}
      className={`canvas${mode === 'edit' ? ' edit-mode' : ''}${selShared ? ' sel-shared' : ''}${reorder ? ' reordering' : ''}${insertDrop || imageDrop ? ' placing' : ''}${resizing ? ' resizing' : ''}`}
      aria-label="Website preview"
      // How high the foot stands, for the state card to keep clear of (PreviewStatus.css).
      style={{ '--foot-top': `${foot.top}px` } as React.CSSProperties}
      // Read by the test driver's UI snapshots (tests/driver): which opening of a project this is, whether the frame's
      // page is ready, the selection as the editor holds it, and where it shows on the page as the page's own element
      // ids (absent: nothing selected; empty: a selection with no place on this page).
      data-opening={workspaceKey}
      data-frame={frameReady ? 'ready' : 'loading'}
      data-selected-ref={selection ? JSON.stringify(selection) : undefined}
      data-selection={selection ? (spaceDesc ? JSON.stringify(spaceDesc) : '') : undefined}
    >
      {runtime.state !== 'ready' && (
        <div className="canvas-state">
          <PreviewStatus runtime={runtime} slow={slowWait} outlined={outlined} />
        </div>
      )}
      {(outlined || fadingOutline || pageArriving) && <CanvasSkeleton label={`Opening ${projectDisplayName(snapshot.state)}…`} leaving={!outlined} />}
      {/* Said in the strip above the page (see frame-status below), and here for screen readers. The project's first
          page is part of its opening, which App announces. */}
      <p className="sr-only" role="status">
        {opening && !outlined ? `Opening ${view?.title ?? 'the page'}…` : ''}
      </p>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {/* The canvas's foot: one column of bars, bottom-up from its floor (Canvas.css). In tab order the Previewing bar
          comes first, then a page problem (recovery close at hand), Form practice and the AI's notice. */}
      <div ref={footRef} className="canvas-foot">
        {mode === 'preview' && (
          <div className="preview-pill" role="group" aria-label="Preview">
            <span className="pill-note" title="Links and menus work as they will for visitors">
              <Eye aria-hidden="true" /> <span className="pill-word">Previewing</span>
            </span>
            {/* Not natively disabled: a step that reaches the end of the journey keeps keyboard focus. */}
            <button className="pill-step" aria-label="Back" title={isMac ? 'Back (⌘[)' : 'Back (Alt+Left)'} aria-keyshortcuts={isMac ? 'Meta+[' : 'Alt+ArrowLeft'} aria-disabled={!stepTarget(journey, 'back') || undefined} onClick={() => step('back')}>
              <ArrowLeft />
            </button>
            <button className="pill-step" aria-label="Forward" title={isMac ? 'Forward (⌘])' : 'Forward (Alt+Right)'} aria-keyshortcuts={isMac ? 'Meta+]' : 'Alt+ArrowRight'} aria-disabled={!stepTarget(journey, 'forward') || undefined} onClick={() => step('forward')}>
              <ArrowRight />
            </button>
            {/* The address the visitor is at, #section included. Stays mounted, so it is announced as it changes. One
                that does not fit takes focus, which shows it in full for anyone not using a pointer. */}
            <output
              ref={addressRef}
              className="pill-address"
              aria-label="Page address"
              title={address || undefined}
              tabIndex={elided ? 0 : undefined}
              onFocus={(e) => setAddressOpen(e.currentTarget.matches(':focus-visible'))}
              onKeyDown={(e) => {
                if (e.key !== 'Escape' || !elided || !addressOpen) return;
                // Escape puts the full address away with focus left where it is (WCAG 1.4.13); the next focus shows it again.
                e.stopPropagation();
                setAddressOpen(false);
              }}
              onBlur={() => setAddressOpen(false)}
            >
              {elided ? (
                <>
                  <span className="sr-only">{address}</span>
                  <span aria-hidden="true">{elided}</span>
                </>
              ) : (
                address
              )}
            </output>
            <button ref={exitRef} onClick={() => setMode('edit')}>
              <Pencil size={13} /> Back to editing
            </button>
          </div>
        )}
        {/* The whole of an address too long for its slot, while a keyboard user is on it: a row of the foot just above
            the bar, so it lifts the bars over it rather than covering them, and the page and the notices keep clear of
            it as of any bar. Escape puts it away with focus left on the address. */}
        {mode === 'preview' && elided && addressOpen && (
          <div className="pill-address-full" aria-hidden="true">
            {address}
          </div>
        )}
        {/* Mounted before they have anything to say, so both are announced. The problem clears during a restart, so a
            restart that fails is announced again. */}
        <p className="sr-only" role="alert">
          {issueShown && !retrying ? `${issueText}${issueDetail ? ` ${issueDetail}.` : ''} Your work is safe.` : stoppedAnnouncement(runtime)}
        </p>
        <p className="sr-only" role="status">
          {issueShown && retrying ? 'Reloading the page…' : ''}
        </p>
        {issueShown && (
          // Above the AI's notice in the foot, and right after the Previewing bar in the tab order, ahead of the form
          // panel and the page, so recovery is close at hand.
          <div ref={issueRef} className={`canvas-notice issue${retrying ? ' retrying' : ''}`} role="group" aria-label="Page problem">
            <span className="canvas-notice-icon">{retrying ? <Spinner decorative /> : <TriangleAlert aria-hidden="true" />}</span>
            <span className="canvas-notice-text issue-text">
              <strong>{retrying ? 'Reloading the page…' : issueText}</strong> <span className="issue-safe">Your work is safe.</span>
              {issueDetail && !retrying && (
                <span className="issue-detail" title={issueDetail}>
                  {issueDetail}
                </span>
              )}
            </span>
            {/* Help first, then the way back, with the one filled button last. Try again is the primary because it keeps
                the work as it is; Revert, when there is a change to put down to, undoes it. The group wraps below the
                words as one row when the canvas is narrow. Not natively disabled, so focus stays here while the page
                reloads. */}
            <div className="canvas-notice-actions">
              <button className="btn btn-sm btn-ghost" onClick={() => setState({ modal: { kind: 'health' } })}>
                Project health
              </button>
              {sourceOffered && (
                <button className="btn btn-sm btn-ghost" onClick={() => setState({ modal: { kind: 'source', definitionId: sourceOffered } })}>
                  Open source
                </button>
              )}
              {revertOffered && (
                <button className="btn btn-sm" aria-disabled={retrying || reverting || undefined} aria-label={`Revert “${revertOffered.label}”`} title={`Undo “${revertOffered.label}”, the change made before this problem started`} onClick={revertIssue}>
                  Revert
                </button>
              )}
              <button
                className="btn btn-sm btn-primary"
                aria-disabled={retrying || reverting || undefined}
                onClick={() => {
                  if (retrying) return;
                  restartPreview();
                }}
              >
                Try again
              </button>
            </div>
          </div>
        )}
        <p className="sr-only" role="status">
          {layoutSaid}
        </p>
        {/* Said once when a page with forms opens, for an author whose focus stays in the page and never meets the panel. */}
        <p className="sr-only" role="status">
          {formsShown ? `Form sends are practice in Preview. ${forms.some((f) => f.live) ? 'Only a real test is sent.' : 'Nothing is sent.'}` : ''}
        </p>
        {formsShown && (
          <FormPractice
            key={formsView}
            forms={forms}
            practice={practice}
            onPractice={setPractice}
            last={lastSend}
            liveBusy={!!liveRequest}
            onLiveTest={liveTest}
            folded={practiceFolded}
            onFold={setPracticeFolded}
            maxHeight={practiceMax}
          />
        )}
        {runStatus && (
          // What the AI is doing, as a status card of the canvas notices: the spinner while it works, its phase first, and
          // what that leaves you free to do after it. No live region of its own: the chat (from outside the dock) and the
          // toolbar's save state already say each phase, wherever focus is. It never takes focus; Stop (which undoes an
          // edit's changes, so it says so) and Answer are in the tab order, and Stop leaves once the AI is stopping, since
          // there is nothing left to press.
          <div ref={runRef} className={`canvas-notice ai-run${runStatus === 'awaiting-input' ? ' attention' : runStatus === 'stopping' ? ' stopping' : ''}`} role="group" aria-label="AI at work">
            <span className="canvas-notice-icon">{runStatus === 'awaiting-input' ? <CircleHelp aria-hidden="true" /> : <Spinner key={runStatus === 'stopping' ? 'stopping' : 'working'} decorative />}</span>
            <span className="canvas-notice-text">
              {runStatus === 'awaiting-input' ? (
                <strong>The AI has a question for you.</strong>
              ) : reading ? (
                runStatus === 'stopping' ? (
                  <strong>Stopping the question.</strong>
                ) : (
                  <>
                    <strong>The AI is reading the site to answer your question.</strong> <span className="canvas-notice-more">You can keep editing.</span>
                  </>
                )
              ) : runPhase(runStatus) === 'stopping' ? (
                <strong>Stopping the AI and undoing its changes.</strong>
              ) : (
                <>
                  <strong>{runPhase(runStatus) === 'checking' ? 'The AI is checking its changes.' : 'The AI is editing this site.'}</strong> <span className="canvas-notice-more">You can look around.</span>
                </>
              )}
            </span>
            {runStatus !== 'stopping' && (
              <span className="canvas-notice-actions">
                <button
                  className="btn btn-sm btn-ghost"
                  title={reading ? 'Stop this question' : 'Stop this request and undo its changes'}
                  onClick={() => {
                    // That request, and its thread as it is now (it may end before the thread opens): the chat goes
                    // back to it, where its outcome shows.
                    const thread = getState().runConversationId;
                    if (activeRunId) void api.ai.stop(activeRunId);
                    void openRunThread(thread);
                  }}
                >
                  <Square fill="currentColor" aria-hidden="true" /> {reading ? 'Stop' : 'Stop and undo'}
                </button>
                {asked && (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      // To the answer box itself, as Write with AI does, in the thread that asked: the chat takes the
                      // request once it shows.
                      const { snapshot: snap, pageId: page } = getState();
                      setState({ dockOpen: true, rightTab: 'chat' });
                      void openRunThread().then((shown) => shown && snap && page && getState().snapshot?.workspaceKey === snap.workspaceKey && setState({ chatFocus: { workspaceKey: snap.workspaceKey, pageId: page, at: Date.now() } }));
                    }}
                  >
                    Answer in chat
                  </button>
                )}
              </span>
            )}
          </div>
        )}
      </div>
      {/* Over the pasteboard, never scrolled away, at every zoom and through every drag, and while the preview is not
          running. Stays while another entry opens, so the entry picker keeps focus as the author steps through
          entries. As wide as the frame within the canvas's margins, and at least wide enough for its words, so it is
          centred over a narrow frame. */}
      {layoutBand && state && templateMode && (
        <TemplateStrip state={state} mode={templateMode} width={Math.max(0, Math.min(Math.max(frameW, TEMPLATE_BAND_MIN), size.w - 56))} left={size.w / 2} opening={opening} />
      )}
      <div
        className="canvas-scroll"
        style={layoutBand || footRoom ? { top: layoutBand ? TEMPLATE_BAND_ROOM : undefined, bottom: footRoom || undefined, paddingBottom: footRoom ? 0 : undefined } : undefined}
        ref={scrollRef}
        onMouseDown={(e) => e.target === e.currentTarget && setState({ selection: null })}
      >
        {url && initialSrc && (
          // Under the outline, the page loading is out of reach, to screen readers too, until it is the one shown.
          <div className={`frame-wrap${staleFrame ? ' stale' : ''}${opening || retrying ? ' waiting' : ''}`} inert={outlined || undefined} ref={wrapRef} style={{ width: frameW, height: frameH * z, marginTop: FRAME_LABEL, transform: nudge.x || nudge.y ? `translate(${-nudge.x}px, ${-nudge.y}px)` : undefined }}>
            {/* The strip above the page: what the page is doing on the left, its screen size on the right. */}
            {opening && !outlined && !resizing && !templateMode && (
              <div className="frame-status" ref={stripLeft} style={{ maxWidth: stripRoom }} aria-hidden="true">
                <Spinner decorative />
                <span>Opening {(studioView && studioDef?.name) ?? view?.title ?? 'the page'}…</span>
              </div>
            )}
            {noEntries && state && templateMode && <TemplateNoEntries state={state} mode={templateMode} readOnly={!!snapshot?.readOnly} />}
            <div className={`frame-width-label${labelMode === 'gone' ? ' gone' : ''}${resizing ? ' live' : ''}`} title={scalePct !== 100 ? `${viewport} px wide, shown at ${scalePct}%` : `${viewport} px wide, shown at actual size`}>
              <b>{viewport}</b>&nbsp;px
              {labelMode === 'mid' && (
                <>
                  <span className="sep">·</span>
                  {scalePct}%
                </>
              )}
              {labelMode === 'full' && (
                <>
                  <span className="sep">·</span>
                  {device}
                  {scalePct !== 100 && (
                    <>
                      <span className="sep">·</span>
                      {scalePct}% zoom
                    </>
                  )}
                </>
              )}
            </div>
            <span className="frame-width-label measure" ref={labelMeasure} aria-hidden="true">
              <span>
                <b>{viewport}</b>&nbsp;px
              </span>
              <span>
                <b>{viewport}</b>&nbsp;px<span className="sep">·</span>
                {scalePct}%
              </span>
              <span>
                <b>{viewport}</b>&nbsp;px<span className="sep">·</span>
                {device}
                {scalePct !== 100 && (
                  <>
                    <span className="sep">·</span>
                    {scalePct}% zoom
                  </>
                )}
              </span>
            </span>
            {/* A chip parked in the strip (the shared header selected) takes the strip; Layers keeps its own Add sections. */}
            {stripStart && (
              <div className="frame-status empty" ref={stripLeft} style={{ maxWidth: stripRoom }} data-testid="canvas-start-strip">
                <span>{emptyPage ? 'This page has no sections yet' : 'Start this page'}</span>
                <button className="link-btn" onClick={openInsertSearch}>
                  <Plus /> <span>Add a section</span>
                </button>
                {writeWithAi('link-btn')}
              </div>
            )}
            {insertDrop && (
              <div className={`ov-moving ov-placing${insertDrop.refused ? ' refused' : ''}`} ref={stripLeft} style={{ maxWidth: stripRoom }} data-testid="insert-drop-label">
                {insertDrop.refused ? <Ban /> : insertDrop.moving ? <GripVertical /> : <Plus />}
                <span className="what">{insertDrop.label}</span>
                <span className="sep">·</span>
                <span className="hint">Esc to cancel</span>
              </div>
            )}
            {imageDrop && (
              <div className={`ov-moving ov-placing${imageDrop.refused ? ' refused' : imageDrop.idle ? ' idle' : ''}`} ref={stripLeft} style={{ maxWidth: stripRoom }} data-testid="image-drop-label">
                {imageDrop.refused ? <Ban /> : <Image />}
                <span className="what">{imageDrop.label}</span>
                <span className="sep">·</span>
                <span className="hint">Esc to cancel</span>
              </div>
            )}
            {reorder && firstSel && (
              <div className={`ov-moving${reorder.refused ? ' refused' : ''}`} ref={stripLeft} style={{ maxWidth: stripRoom }} aria-hidden="true">
                {reorder.refused ? <Ban /> : <GripVertical />}
                <span className="what">{reorder.refused ? `Can’t move ${reorder.name} here` : `Moving ${reorder.name}`}</span>
                <span className="sep">·</span>
                <span className="hint">Esc to cancel</span>
              </div>
            )}
            <div className="frame-box" style={{ width: viewport, height: frameH, transform: `scale(${z})` }}>
              <iframe
                key={session}
                ref={frameRef}
                name={session}
                title="Website preview"
                src={initialSrc}
                sandbox="allow-scripts allow-same-origin allow-forms"
                // While a drag runs, and while another page is on its way, picks on the page would act on what is leaving.
                style={{ pointerEvents: dragging || staleFrame ? 'none' : undefined, colorScheme: frameScheme }}
                tabIndex={staleFrame || noEntries ? -1 : undefined}
              />
            </div>
            <div className={`overlay-layer${inkPaged ? ' paged' : ''}`}>
              <div className="overlay-clip">
                {/* The others in a live session, under everything of the editor's own. */}
                {!staleFrame && peerMarks.marks.length > 0 && marksOnFrame() && <PeerMarks marks={peerMarks.marks} boxes={markBoxes} toBox={toBox} width={frameW} height={frameH * z} />}
                {hovering &&
                  hovBoxes.map((b, i) => {
                    // A tall container carries its name inside its top-left corner (kept in view when its top has
                    // scrolled out of the page); a short element, and text or a button of any height, whose first line
                    // the name would cover, above it, or below when it sits at the top of the page (#905). Text with no
                    // room either side (as tall as the visible page) keeps it inside, so it is still shown.
                    const tall = b.height >= 40 && (!textKind(hover) || (b.top < 24 && b.top + b.height + 20 > frameH * z));
                    // Near the page's right edge the name is anchored to the element's right, so the page edge never cuts it.
                    const side = b.left > frameW - 160 ? (tall ? { left: 'auto', right: 4 } : { left: 'auto', right: 0 }) : tall ? {} : { left: 0 };
                    const tagAt = { ...side, ...(tall ? (b.top < 0 ? { top: 4 - b.top } : {}) : b.top >= 24 ? { top: -19 } : { top: b.height - 1 }) };
                    const show = i === 0 && !tagHidden && b.top + b.height > (tall ? 30 : 0);
                    return (
                      <div key={`h${i}`} className="ov-box ov-hover" style={b}>
                        {show && (
                          // Outside its element the name is hoverable (WCAG 1.4.13): the pointer can rest on it without the
                          // hover moving on, and a click there selects what it names, as a click on the element would.
                          <span className={`ov-label${tall ? '' : b.top >= 24 ? ' outside' : ' outside below'}`} style={tagAt} onClick={
                              tall
                                ? undefined
                                : () => {
                                    overTag.current = false;
                                    pagePick();
                                    if (hover) selectOnPage(hover, getState().rightTab === 'styles' ? { rightTab: 'inspect' } : {});
                                  }
                            }
                            onPointerEnter={() => (overTag.current = true)}
                            onPointerLeave={leaveHoverChrome}
                          >
                            {state && hover ? chromeLabel(state, hover) : ''}
                          </span>
                        )}
                      </div>
                    );
                  })}
                {revBoxes.map((b, i) => (
                  <div key={`r${i}`} className="ov-box ov-revealed" style={b} />
                ))}
                {/* Placing something new, the selection steps aside: the marks are where it goes, not what is picked. */}
                {!(insertDrop && !insertDrop.moving) && !imageDrop && selBoxes.map((b, i) => (
                  // The arrival cue's box is a new one, so the next insertion's cue starts from its beginning.
                  <div
                    key={i === 0 && arriving ? `s0-${arrival.n}` : `s${i}`}
                    className={`ov-box ov-selected${i > 0 && selection?.itemPath?.length ? ' dim' : ''}${i === 0 && (reorder || insertDrop?.moving) ? ' moving' : ''}${i === 0 && editing ? ' editing' : ''}${i === 0 && arriving ? ' arriving' : ''}${inkPaged ? ' paged' : ''}`}
                    style={b}
                  />
                ))}
                {placedAdds.map(({ p, box, at }) => {
                  const label = pointLabel(p);
                  return (
                    <span key={p.key} className="ov-add-at">
                      <button
                        type="button"
                        className={`ov-add ${p.side}`}
                        style={at}
                        aria-label={label}
                        title={label}
                        aria-haspopup="dialog"
                        aria-expanded={!!adding}
                        data-testid="canvas-add"
                        data-side={p.side}
                        data-node={p.nodeId}
                        data-slot={p.slot}
                        onPointerEnter={() => (overTag.current = true)}
                        onPointerLeave={leaveHoverChrome}
                        onFocus={() => (addFocused.current = true)}
                        onBlur={(e) => {
                          addFocused.current = false;
                          // Gone with its focus (its hover moved on): focus goes to the canvas, as below.
                          const el = e.currentTarget;
                          requestAnimationFrame(() => {
                            const a = document.activeElement;
                            if (!el.isConnected && (!a || a === document.body)) canvasRef.current?.focus({ preventScroll: true });
                          });
                        }}
                        onClick={(e) => (adding ? closeAdd(true) : openAdd(p, e.currentTarget, at, box))}
                      >
                        <Plus aria-hidden="true" />
                      </button>
                      {/* Where it lands, shown while the button is pointed at, focused or open: the edge it adds at, or the box it adds into. */}
                      {p.side === 'inside' ? (
                        <span className="ov-add-mark zone" style={box} aria-hidden="true" />
                      ) : underHeader(p.side === 'before' ? box.top : box.top + box.height, box, headerBoxes) ? null : (
                        <span className="ov-add-mark line" style={{ left: box.left, top: p.side === 'before' ? box.top : box.top + box.height, width: box.width }} aria-hidden="true" />
                      )}
                    </span>
                  );
                })}
                {spaceShown && (
                  <SpacingHandles
                    // A drag belongs to one selection, at one size, zoom and page: any change ends it.
                    key={JSON.stringify([session, pageId, refKey(selection!), selection!.itemPath ?? [], styleScope, viewport, z])}
                    state={state!}
                    selection={selection!}
                    desc={spaceDesc!}
                    box={toBox(rects.selected[0])}
                    frame={{ width: viewport * z, height: frameH * z }}
                    spacing={spacing!}
                    zoom={z}
                    post={post}
                    measureSpace={measureSpace}
                    onDragging={setDragging}
                    focusCanvas={() => canvasRef.current?.focus({ preventScroll: true })}
                    pageBehind={pageBehind}
                  />
                )}
                {reorder?.refused &&
                  (() => {
                    // Why a gap among its siblings can't take it, at the gap (the place a line would be).
                    const why = 'Its Order style keeps it out of here at this size.';
                    const r = reasonAt(dropBox(reorder.refused, reorder.clip), why, reorder.clip);
                    return (
                      <div className={`ov-drop-reason ${r.edge}`} style={r.style}>
                        <Ban aria-hidden="true" />
                        <span>{why}</span>
                      </div>
                    );
                  })()}
                {reorder?.line &&
                  (() => {
                    const d = dropBox(reorder.line, reorder.clip);
                    return <div className={`ov-drop${d.vertical ? ' vertical' : ''}`} style={{ left: d.left, top: d.top, width: d.width, height: d.height }} role="presentation" />;
                  })()}
                {between?.surfaces.map((sf) => (
                  <div key={sf.key} className={`ov-box ov-slot-surface${!between.refused && sameBox(between.outline, sf.box) ? ' aimed' : ''}`} style={toBox(sf.box)} data-testid="insert-slot-surface" data-slot={sf.label}>
                    <span>{sf.label}</span>
                  </div>
                ))}
                {between?.outline && <div className={`ov-box ov-drop-target${between.refused ? ' refused' : ''}`} style={toBox(between.outline)} data-testid="insert-drop-target" />}
                {between?.outline &&
                  between.refused &&
                  (() => {
                    // Why it can't go here, said at the place itself while the drag holds it (#652).
                    const r = reasonAt(toBox(between.outline), between.refused, between.clip);
                    return (
                      <div className={`ov-drop-reason ${r.edge}`} style={r.style} data-testid="insert-drop-reason">
                        <Ban aria-hidden="true" />
                        <span>{between.refused}</span>
                      </div>
                    );
                  })()}
                {imageDrop?.outline && <div className="ov-box ov-image-drop" style={toBox(imageDrop.outline)} data-testid="image-drop-target" />}
                {between?.line &&
                  (() => {
                    const d = dropBox(between.line, between.clip);
                    return <div className={`ov-drop${d.vertical ? ' vertical' : ''}`} style={{ left: d.left, top: d.top, width: d.width, height: d.height }} role="presentation" data-testid="insert-drop-line" />;
                  })()}
              </div>
              {emptyPage && !staleFrame && emptyFits && (
                <div className="canvas-empty" style={{ top: emptyAt! * z + 24 }}>
                  <div className="canvas-card empty-card" ref={emptyCardRef} role="group" aria-labelledby="canvas-empty-title" data-testid="canvas-empty-page">
                    <h3 id="canvas-empty-title">This page has no sections yet</h3>
                    <p>{snapshot?.readOnly ? 'Add a first section to start building it.' : 'Add a first section, or write it with AI.'} Visitors never see this note.</p>
                    <div className="empty-actions">
                      <button className="btn btn-primary" onClick={openInsertSearch}>
                        <Plus /> Add a section
                      </button>
                      {writeWithAi('btn')}
                      <PasteHere className="btn" />
                    </div>
                  </div>
                </div>
              )}
              {firstSel && selection && state && chipShown && !reorder && !insertDrop && !resizing && !imageDrop && (
                <SelectionChip
                  box={firstSel}
                  frameWidth={viewport * z}
                  name={defRoot ? state.components[definitionMode!.definitionId].name : selLabel}
                  icon={kindIcon(state, selection)}
                  parent={isPart && !definitionMode ? chromeLabel(state, { owner: selection.owner, instancePath: selection.instancePath.slice(0, -1), nodeId: selection.instancePath[selection.instancePath.length - 1] }) : null}
                  repeats={selBoxes.length}
                  item={itemStep(state, selection, templateMode ?? undefined)}
                  repeatsLabel={selLabel ? `${selLabel.toLowerCase()}${/s$/.test(selLabel) ? '' : 's'}` : 'items'}
                  sib={siblings(state, structuralTarget(selection))}
                  onWidth={setChipW}
                  onLostFocus={() => canvasRef.current?.focus({ preventScroll: true })}
                  onMore={(el, focusLast) => openContextMenu(0, 0, selection, el, focusLast)}
                  more={menu.triggerProps('chip')}
                  onGrip={onGrip}
                  canMove={canMoveSelection}
                  editing={editing}
                  onDone={() => post('commitTextEdit')}
                  onMove={(dir) => void announcedMove(() => moveLayers(dir))}
                  onStep={onStep}
                  stepBlocked={stepBlocked && stepBlocked.key === stepKey(getState()) ? stepBlocked : null}
                  onEditText={canInlineEdit(selection) && descFor(selection) ? () => startTextEditFromChrome(selection) : null}
                  onReveal={
                    selShown
                      ? null
                      : () => {
                          const desc = descFor(selection);
                          if (desc) post('scrollTo', { desc });
                        }
                  }
                />
              )}
            </div>
            {/* A guest pointed at another page: who, where, and a way there (#768). */}
            <SpotlightPrompts away={peerMarks.away} />
            <span className="sr-only" role="status">
              {marksAnnouncement(peerMarks.marks, peerMarks.away)}
            </span>
            {/* Not while the page is outlined: drawn over, they would still take focus and a drag. */}
            {!outlined && frameHandle('left')}
            {!outlined && frameHandle('right')}
          </div>
        )}
      </div>
      {menu.node}
      {adding && <QuickInsert title={pointLabel(adding.point)} search={adding.point.role === 'section' ? 'Search sections' : 'Search elements'} items={adding.items} anchor={adding.anchor} trigger={adding.trigger} empty={adding.empty} refused={adding.refused} onChoose={chooseAdd} onClose={closeAdd} />}
      {/* The image a drag from Assets carries, beside the pointer wherever it is in the window. */}
      {imageDrop &&
        createPortal(
          <div className={`insert-ghost${imageDrop.refused ? ' refused' : ''}`} style={{ left: imageDrop.x + 14, top: imageDrop.y + 12 }} aria-hidden="true">
            {imageDrop.refused ? <Ban /> : <Image />}
            <span>{imageDrop.name}</span>
          </div>,
          document.body
        )}
      {/* What a move among its siblings carries, beside the pointer, as a move anywhere on the page does. */}
      {reorder &&
        createPortal(
          <DragGhost point={insertPoint} className={`insert-ghost${reorder.refused ? ' refused' : ''}${selShared ? ' sel-shared' : ''}`}>
            {reorder.refused ? <Ban /> : <GripVertical />}
            <span>{reorder.name}</span>
          </DragGhost>,
          document.body
        )}
      {/* What a drag from Insert carries, beside the pointer wherever it is in the window. */}
      {insertDrop &&
        createPortal(
          <DragGhost point={insertPoint} className={`insert-ghost${insertDrop.refused ? ' refused' : ''}${selShared ? ' sel-shared' : ''}`}>
            {insertDrop.refused ? <Ban /> : insertDrop.moving ? <GripVertical /> : <Plus />}
            <span>{insertDrop.name}</span>
          </DragGhost>,
          document.body
        )}
    </main>
  );
}

/** The width of `text` in the type of the canvas's labels (12px semibold, the app's font), measured once per string. */
const labelWidths = new Map<string, number>();
let labelContext: CanvasRenderingContext2D | null | undefined;
function labelWidth(text: string): number {
  const known = labelWidths.get(text);
  if (known !== undefined) return known;
  if (labelContext === undefined) {
    labelContext = document.createElement('canvas').getContext('2d');
    if (labelContext) labelContext.font = `600 12px ${getComputedStyle(document.body).fontFamily}`;
  }
  // Where nothing can measure it, about 6.6px a character.
  const width = labelContext ? labelContext.measureText(text).width : text.length * 6.6;
  if (labelWidths.size > 400) labelWidths.clear();
  labelWidths.set(text, width);
  return width;
}

/** The lines `text` breaks into between words at `width`, in the canvas's label type, and how wide the widest is. */
function wrapLabel(text: string, width: number): { lines: number; widest: number } {
  let lines = 1;
  let widest = 0;
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && labelWidth(next) > width) {
      widest = Math.max(widest, labelWidth(line));
      lines++;
      line = word;
    } else line = next;
  }
  return { lines, widest: Math.min(width, Math.max(widest, labelWidth(line))) };
}

/** Where a drag's pointer is, and what moves with it (DragGhost's own placing, while it is shown). */
interface DragPoint {
  x: number;
  y: number;
  moved: (() => void) | null;
}

/** What a drag carries, 14 px right of and 12 px below the pointer, placed on every move of it (`point.moved`) without
 *  a render: a pointer move that changes nothing else the drag shows renders nothing. */
function DragGhost({ point, className, children }: { point: React.MutableRefObject<DragPoint>; className: string; children: React.ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const p = point.current;
    const place = () => {
      if (!el.current) return;
      el.current.style.left = `${p.x + 14}px`;
      el.current.style.top = `${p.y + 12}px`;
    };
    place();
    p.moved = place;
    return () => {
      if (p.moved === place) p.moved = null;
    };
  }, [point]);
  return (
    <div ref={el} className={className} aria-hidden="true">
      {children}
    </div>
  );
}

/** An address too long for its slot with the middle taken out, keeping more of the end, which tells pages apart. */
function elideAddress(address: string, fit: number): string | null {
  if (address.length <= fit) return null;
  const tail = Math.ceil((fit - 1) * 0.6);
  return `${address.slice(0, fit - 1 - tail)}…${address.slice(-tail)}`;
}

/** Where a structural target sits among its siblings, for the move controls and the drag handle. */
function siblings(state: ProjectState, t: ElementRef | null): { index: number; count: number } | null {
  if (!t) return null;
  const tree = treeFor(state, t.owner);
  const info = tree && findParent(tree, t.nodeId);
  return info ? { index: info.index, count: info.list.length } : null;
}

/** Whether an Add list opened on `list` (its project, revision and page) still stands for the editor as `s` has it:
 *  editing that page, outside Component Studio, with the project writable and the AI not working. */
function addListHolds(list: { opening: string; revision: number; view: string }, s: ReturnType<typeof getState>): boolean {
  const snap = s.snapshot;
  const shown = snap ? shownView(snap.state, s.pageId, s.templateMode) : null;
  return !!snap && s.mode === 'edit' && !s.definitionMode && !snap.aiBusy && !snap.readOnly && snap.workspaceKey === list.opening && snap.revision === list.revision && shown?.key === list.view;
}

/** The name the canvas chrome uses: the shared header and footer say so, since the green alone cannot. */
function chromeLabel(state: ProjectState, ref: ElementRef): string {
  if (ref.owner.kind === 'shell' && !ref.instancePath.length && ref.slot === undefined && boundaryOf(state, ref).nodeId === ref.nodeId) return ref.owner.id === 'header' ? 'Shared header' : 'Shared footer';
  return refLabel(state, ref);
}

/** The same glyphs Layers uses for each kind of part. */
function kindIcon(state: ProjectState, ref: ElementRef) {
  if (ref.slot !== undefined) return <Box />;
  if (ref.owner.kind === 'shell' && !ref.instancePath.length) return <Users />;
  switch (resolveRef(state, ref).node?.kind) {
    case 'instance':
      return <Component />;
    case 'text':
      return <Type />;
    case 'image':
      return <Image />;
    case 'link':
      return <Link2 />;
    case 'element':
      return <Rows3 />;
    default:
      return <Box />;
  }
}

/** What a step of the selection chip is taken from: the selection, the project, and what the page shows. */
/** Where a click the page gate held was made: the frame, the view and way of editing it, and what was selected then. */
type HeldPick = { session: string; scene: string; selection: string | null };
const selectionKey = (s: ReturnType<typeof getState>): string | null => (s.selection ? refKey(s.selection) : null);
const sceneKey = (s: ReturnType<typeof getState>): string => JSON.stringify([viewKey(s), s.mode, s.definitionMode?.definitionId ?? null, !!s.definitionMode?.studio]);

function stepKey(s: ReturnType<typeof getState>): string {
  return JSON.stringify([s.selection ? refKey(s.selection) : null, s.snapshot?.revision ?? null, s.pageId, s.templateMode ?? null, s.definitionMode?.definitionId ?? null, s.viewport]);
}

/**
 * The selection chip: a toolbar of the selection's name and actions. It is parked in the strip above the page frame,
 * lined up with the selection (see chipLeft), so it never covers the page. One Tab stop: Left/Right/Home/End move between its buttons
 * (WAI-ARIA APG toolbar); the drag handle is pointer-only, with Move up and Move down as its keyboard
 * equivalent. Delete is not here: it lives at the end of More actions, in red, and on the Delete key.
 */
function SelectionChip({ box, frameWidth, name, icon, parent, repeats, repeatsLabel, item, sib, canMove, editing, onMore, more, onGrip, onWidth, onLostFocus, onDone, onMove, onStep, stepBlocked, onEditText, onReveal }: { box: { left: number; top: number; width: number; height: number }; frameWidth: number; name: string; icon: React.ReactNode; parent: string | null; repeats: number; repeatsLabel: string; item: ReturnType<typeof itemStep>; sib: { index: number; count: number } | null; canMove: boolean; editing: boolean; onMore: (el: HTMLElement, focusLast?: boolean) => void; more: MenuTriggerProps; onGrip: (e: React.PointerEvent) => void; onWidth: (w: number) => void; onLostFocus: () => void; onDone: () => void; onMove: (dir: -1 | 1) => void; onStep: (dir: -1 | 1) => void; stepBlocked: { prev: boolean; next: boolean } | null; onEditText: (() => void) | null; onReveal: (() => void) | null }) {
  const askKeys = useAskAiKeys();
  const selection = useStore((s) => s.selection);
  const layerSet = useStore((s) => s.layerSet);
  // With the inspector out of sight (dock closed, or AI / Site styles showing), the chip offers the way back.
  const inspectorHidden = useStore((s) => !s.dockOpen || s.rightTab !== 'inspect');
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef(0);
  /** Whether focus is in the chip, so a control that disappears under it (the parent link, after its
   *  click) hands focus to a neighbour rather than dropping it on the page body. */
  const focusIn = useRef(false);
  const lastFocused = useRef<HTMLElement | null>(null);
  /** Focus fell to the page body because the chip control holding it was removed (not because it was blurred). */
  const orphaned = () => focusIn.current && !!lastFocused.current && !lastFocused.current.isConnected && (!document.activeElement || document.activeElement === document.body);
  const [w, setW] = useState(200);
  const buttons = () => [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])];
  // A new selection starts the toolbar's Tab stop at its first control.
  const key = selection ? refKey(selection) : '';
  useLayoutEffect(() => {
    current.current = 0;
  }, [key]);
  /** Too narrow for everything (a phone frame, many actions), the selection's name is the last thing to give way.
   *  First Ask AI and Edit text, which More actions also offers, step out and the labelled buttons keep only their
   *  icon; if the name is still cut, the parent link goes too (Escape still selects the parent). */
  const [compact, setCompact] = useState(0);
  useLayoutEffect(() => setCompact(0), [key, frameWidth, editing, !!onReveal, inspectorHidden, !!onEditText, name, parent, layerSet]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const width = ref.current?.offsetWidth ?? 0;
    if (width && width !== w) (setW(width), onWidth(width));
    // Pressure is the name, or its parent, cut short of its own cap (a long name at its cap is not short of room). The
    // parent link counts only at the first step: the second takes it away.
    const cut = (text: HTMLElement | null | undefined, box = text) => !!text && !!box && text.scrollWidth > text.clientWidth + 1 && box.clientWidth < parseFloat(getComputedStyle(box).maxWidth) - 1;
    const label = ref.current?.querySelector<HTMLElement>('.name .label');
    const link = ref.current?.querySelector<HTMLElement>('.name .of.link');
    if (compact < 2 && (cut(label) || (compact < 1 && cut(link?.querySelector<HTMLElement>('.ellipsis'), link)))) setCompact(compact + 1);
    // Roving tab stop: exactly one button is in the Tab order, the last one used. A control that keeps focus while
    // the selection changes under it (Previous or Next item) keeps the Tab stop, wherever the chip's controls now are.
    const list = buttons();
    const focused = list.indexOf(document.activeElement as HTMLElement);
    if (focused >= 0) current.current = focused;
    const keep = Math.min(current.current, list.length - 1);
    list.forEach((b, i) => (b.tabIndex = i === keep ? 0 : -1));
    if (orphaned()) list[keep]?.focus();
  });
  // When the chip itself goes (the selection was deleted or cleared) while it had focus, the canvas keeps it.
  useEffect(
    () => () => {
      if (focusIn.current) requestAnimationFrame(() => orphaned() && onLostFocus());
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const t = structuralTarget(selection);
  const top = -CHIP_H - 6;
  const left = chipLeft(box.left, w, frameWidth);
  const parentRef = selection?.instancePath.length ? { owner: selection.owner, instancePath: selection.instancePath.slice(0, -1), nodeId: selection.instancePath[selection.instancePath.length - 1] } : null;
  const structural = !!t && !selection?.instancePath.length;
  const canEdit = structural && t!.owner.kind !== 'shell';
  // With layers selected together in Layers, the chip's commands (like their shortcuts) move and duplicate them all.
  const group = layerSet ? liveGroup() : null;
  const canReorder = structural && !!sib && sib.count > 1;
  // A drag takes it among its siblings, or (a lone card in a column too) to another place on the page.
  const canGrip = canReorder || (structural && canMove);
  const canUp = group ? group.indexes[0] > 0 : !!sib && sib.index > 0;
  const canDown = group ? group.indexes[group.indexes.length - 1] < group.list.length - 1 : !!sib && sib.index < sib.count - 1;
  const canPrev = !!item && !stepBlocked?.prev && !!stepItem(item.parts, item.n, -1);
  const canNext = !!item && !stepBlocked?.next && !!stepItem(item.parts, item.n, 1);
  // An unavailable control says why, in its tooltip and as its description.
  const whyId = useId();
  const why = (ok: boolean, reason: string, which: string) => (ok ? {} : { title: reason, 'aria-describedby': `${whyId}-${which}` });
  const prevWhy = item?.n === 1 ? 'This is the first item' : 'No earlier item shows this part';
  const nextWhy = item && item.n === item.count ? 'This is the last item' : 'No later item shows this part';
  // Layers selected together are held back by whichever of them is at the end, not always the one named.
  const upWhy = group ? 'One of these is already first' : 'Already first';
  const downWhy = group ? 'One of these is already last' : 'Already last';
  // Layers selected together: the chip names the one picked and counts the rest, which its moves and Duplicate act on too.
  const others = group ? group.indexes.length - 1 : 0;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const n = e.key === 'ArrowRight' ? (i + 1) % list.length : e.key === 'ArrowLeft' ? (i - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    e.stopPropagation();
    current.current = n;
    list.forEach((b, j) => (b.tabIndex = j === n ? 0 : -1));
    list[n].focus();
  };
  // A disabled move stays focusable (APG toolbar), so it is marked aria-disabled and ignores the press.
  const guard = (ok: boolean, fn: () => void) => () => ok && fn();
  const trackFocus = (e: React.FocusEvent) => {
    focusIn.current = true;
    lastFocused.current = e.target as HTMLElement;
    const list = buttons();
    const i = list.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    // A press or a programmatic focus moves the toolbar's one Tab stop too, as the arrow keys do.
    current.current = i;
    list.forEach((b, j) => (b.tabIndex = j === i ? 0 : -1));
  };
  // Focus moving to nothing may mean its control was removed; orphaned() tells that from a plain blur.
  const trackBlur = (e: React.FocusEvent) => {
    if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) focusIn.current = false;
  };
  // While its text is being edited on the page, the chip says so and offers the way out: Done keeps the change
  // (as a click anywhere else does), Escape on the page puts the text back.
  if (editing) {
    const what = /^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name;
    return (
      <div ref={ref} className="ov-chip strip editing" style={{ left, top, maxWidth: frameWidth }} role="toolbar" aria-label={`Editing ${what}`} onKeyDown={onKeyDown} onFocus={trackFocus} onBlur={trackBlur}>
        <span className="name">
          <Pencil />
          <span className="label">Editing {what}</span>
          <span className="dot" aria-hidden="true">
            ·
          </span>
          <span className="of">Esc to cancel</span>
        </span>
        <button className="chip-text raised" title={`Done (${keys('⌘↩')})`} aria-keyshortcuts={ariaKeys('Meta+Enter')} onClick={onDone}>
          <Check /> Done <kbd>{keys('⌘↩')}</kbd>
        </button>
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="ov-chip strip"
      style={{ left, top, maxWidth: frameWidth }}
      role="toolbar"
      // Which of a repeated part it acts on (one card, or every card) is part of what the toolbar is for.
      aria-label={`${name}${others > 0 ? ` and ${others} more` : item ? `, ${item.n} of ${item.count}` : repeats > 1 ? `, all ${repeats} ${repeatsLabel}` : ''} actions`}
      onKeyDown={onKeyDown}
      onFocus={trackFocus}
      onBlur={trackBlur}
    >
      {canGrip && !group && (
        // Pointer-only, so it is hidden from assistive tech: Move up and Move down are its equivalent. A drag moves one
        // element, so it is not offered while layers are selected together (the arrows move them all).
        <span className="icon-btn grip" aria-hidden="true" title="Drag to move" onPointerDown={onGrip}>
          <GripVertical />
        </span>
      )}
      <span className="name">
        {icon}
        <span className="label">{name}</span>
        {parent && parentRef && compact < 2 && (
          <button className="of link" title={`Select ${parent} (Esc)`} aria-label={`in ${parent}: select it`} aria-keyshortcuts="Escape" onClick={() => setState({ selection: parentRef })}>
            <span className="ellipsis">in {parent}</span>
          </button>
        )}
        {/* The part in every card (picked in Layers): say so. One card picked on the page says which, beside it. */}
        {!item && repeats > 1 && <span className="of">· all {repeats} {repeatsLabel}</span>}
        {others > 0 && <span className="of">and {others} more</span>}
      </span>
      {item && (
        // The same part in the card before or after: the selection moves, the list never changes. Outside the name,
        // which gives way first, so the steps are never clipped while they can be focused.
        <>
          <span className="chip-sep" aria-hidden="true" />
          <span className="chip-step">
            <button className="icon-btn step" title="Previous item" aria-label="Previous item" aria-disabled={!canPrev || undefined} {...why(canPrev, prevWhy, 'prev')} onClick={guard(canPrev, () => onStep(-1))}>
              <ChevronLeft />
            </button>
            <span className="of" data-testid="chip-item-pos">
              {item.n} of {item.count}
            </span>
            <button className="icon-btn step" title="Next item" aria-label="Next item" aria-disabled={!canNext || undefined} {...why(canNext, nextWhy, 'next')} onClick={guard(canNext, () => onStep(1))}>
              <ChevronRight />
            </button>
            {!canPrev && <span id={`${whyId}-prev`} hidden>{prevWhy}</span>}
            {!canNext && <span id={`${whyId}-next`} hidden>{nextWhy}</span>}
          </span>
        </>
      )}
      {(!compact || onReveal || inspectorHidden) && <span className="chip-sep" aria-hidden="true" />}
      {!compact && (
        <button className="icon-btn" title={`Ask AI about this (${keys(askKeys.hint)})`} aria-label="Ask AI about this" aria-keyshortcuts={askKeys.aria} onClick={() => askAiAbout(selection)}>
          <Sparkles />
        </button>
      )}
      {onEditText && !compact && (
        <button className="icon-btn" title="Edit text (double-click)" aria-label="Edit text" onClick={onEditText}>
          <Pencil />
        </button>
      )}
      {/* Scrolled right out of view, the selection has no outline on the page: this brings it back. */}
      {onReveal && (
        <button className={`chip-text${compact ? ' icon-only' : ''}`} title="Scroll the page back to it" aria-label="Show on the page" onClick={onReveal}>
          <LocateFixed />
          {!compact && 'Show'}
        </button>
      )}
      {inspectorHidden && (
        <button
          className={`chip-text${compact ? ' icon-only' : ''}`}
          title="Show this in the inspector"
          aria-label="Inspect"
          onClick={() => {
            setState({ dockOpen: true, rightTab: 'inspect' });
            // Focus follows into the inspector, landing on the selection's first control.
            focusInspector();
          }}
        >
          <PanelRight />
          {!compact && 'Inspect'}
        </button>
      )}
      {(canReorder || canEdit) && <span className="chip-sep" aria-hidden="true" />}
      {canReorder && (
        <>
          <button className="icon-btn" title={`Move up (${keys('⇧⌘↑')})`} aria-label="Move up" aria-keyshortcuts={ariaKeys('Shift+Meta+ArrowUp')} aria-disabled={!canUp || undefined} {...why(canUp, upWhy, 'up')} onClick={guard(canUp, () => onMove(-1))}>
            <ArrowUp />
          </button>
          <button className="icon-btn" title={`Move down (${keys('⇧⌘↓')})`} aria-label="Move down" aria-keyshortcuts={ariaKeys('Shift+Meta+ArrowDown')} aria-disabled={!canDown || undefined} {...why(canDown, downWhy, 'down')} onClick={guard(canDown, () => onMove(1))}>
            <ArrowDown />
          </button>
          {!canUp && <span id={`${whyId}-up`} hidden>{upWhy}</span>}
          {!canDown && <span id={`${whyId}-down`} hidden>{downWhy}</span>}
        </>
      )}
      {canEdit && (
        <button className="icon-btn" title={`Duplicate${others > 0 ? ` all ${others + 1}` : ''} (${keys('⌘D')})`} aria-label={others > 0 ? `Duplicate all ${others + 1}` : 'Duplicate'} aria-keyshortcuts={ariaKeys('Meta+D')} onClick={() => void duplicateLayers()}>
          <Copy />
        </button>
      )}
      <span className="chip-sep" aria-hidden="true" />
      <button
        className="icon-btn more"
        // With layers selected together, its menu acts on the one named, not on the group the moves and Duplicate take.
        title={others > 0 ? `More actions for ${name}` : 'More actions'}
        aria-label={others > 0 ? `More actions for ${name}` : 'More actions'}
        {...more}
        onClick={(e) => onMore(e.currentTarget)}
        onKeyDown={(e) => {
          // APG menu button: Down opens on the first item, Up on the last. Modified arrows stay shortcuts
          // (⇧⌘↑/↓ moves the section).
          if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
          e.preventDefault();
          e.stopPropagation();
          onMore(e.currentTarget, e.key === 'ArrowUp');
        }}
      >
        <Ellipsis />
      </button>
    </div>
  );
}

/** The least height the page keeps, in its own pixels, while the foot stands below it. */
const PAGE_FLOOR = 160;
/** How far above the canvas's foot the page ends, in screen pixels. */
const FOOT_CLEAR = 8;
/** The pasteboard's padding round the page (Canvas.css, .canvas-scroll), in screen pixels. */
const PASTEBOARD_PAD = 28;
/** The frame's top margin, which holds the strip above the page (its label, the selection's chip), in screen pixels. */
const FRAME_LABEL = 14;
/** How long the outline of a project's first page takes to lift off the page once it has arrived (EditorSkeleton.css). */
const OUTLINE_FADE_MS = 150;

/** How far down the pasteboard starts under a collection layout's band (8px above it, 42px high), in screen pixels. */
const TEMPLATE_BAND_ROOM = 50;
/** The narrowest the band is drawn, room permitting: over a narrower frame (a phone's) it is centred and wider than the
 *  page, so its words and the entry's title keep their room. */
const TEMPLATE_BAND_MIN = 960;

/** What a collection's layout is called on the canvas: "Journal layout", "Journal index layout". */
const layoutTitle = (state: ProjectState, mode: TemplateMode) => `${state.collections[mode.collectionId]?.settings.name ?? 'Collection'} ${mode.archive ? 'index layout' : 'layout'}`;
/** Who an edit to it reaches. */
const layoutScope = (state: ProjectState, mode: TemplateMode) => (mode.archive ? 'Applies to every page of the index' : `Applies to every ${entryNounLower(state.collections[mode.collectionId])}`);

/**
 * The band over the canvas while a collection's layout is edited, a row of its own above the strip (so the selection's
 * chip and the width keep the strip): whose layout it is and that an edit reaches every entry, the entry it is shown
 * with (any of the collection's, to see the layout with other words and pictures; an index is shown with its first
 * page), and the way back. Neutral, like the canvas: layouts have no hue of their own. As it narrows, the words around
 * the controls go, the picker narrows to its floor, and then the collection's name is cut; who an edit reaches and Done
 * stay whole (Canvas.css).
 */
function TemplateStrip({ state, mode, width, left, opening }: { state: ProjectState; mode: TemplateMode; width: number; left: number; opening: boolean }) {
  const collection = state.collections[mode.collectionId];
  const samples = sampleEntries(state, mode.collectionId);
  if (!collection) return null;
  const kind = mode.archive ? 'index layout' : 'layout';
  const shown = samples.find((e) => e.id === mode.entryId);
  const entryText = (e: (typeof samples)[number]) => `${e.draft !== false ? 'Draft · ' : ''}${e.title || e.slug}`;
  const busy = <span className="template-strip-busy">{opening && <Spinner decorative />}</span>;
  return (
    <div className="template-strip" style={{ width, left: left - width / 2 }} role="group" aria-label={`Editing the ${layoutTitle(state, mode)}`} aria-busy={opening || undefined} data-testid="template-strip">
      <div className="template-strip-row">
        <LayoutTemplate className="template-strip-mark" aria-hidden="true" />
        <span className="template-strip-text">
          <span className="template-strip-title" title={layoutTitle(state, mode)}>
            <span className="template-strip-verb">Editing</span>
            <span className="template-strip-name">{collection.settings.name}</span>
            <span className="template-strip-kind">{kind}</span>
          </span>
          <span className="template-strip-scope">
            {/* An index in a narrow band says which of its pages is shown here, where the wide one says it beside Done. */}
            <span className="template-strip-scope-full">{layoutScope(state, mode)}</span>
            {mode.archive && <span className="template-strip-scope-short">Every index page · showing page 1</span>}
          </span>
        </span>
        {/* The spinner sits just before the picker while the chosen entry opens, in room that is kept (in a narrow band,
            over the mode glyph), so nothing moves as the author steps through entries. */}
        <span className="template-strip-end">
          {mode.archive ? (
            <span className="template-strip-sample">
              {busy}
              <span className="template-strip-label">Shown with its first page</span>
            </span>
          ) : (
            samples.length > 0 && (
              <label className="template-strip-sample">
                {busy}
                <span className="template-strip-label">Shown with</span>
                <select
                  className="select sm"
                  value={mode.entryId ?? ''}
                  title={shown ? `Shown with: ${entryText(shown)}` : undefined}
                  aria-label="Entry the layout is shown with"
                  data-testid="template-sample"
                  onChange={(e) => setState({ templateMode: { collectionId: mode.collectionId, entryId: e.target.value } })}
                >
                  {samples.map((e) => (
                    <option key={e.id} value={e.id}>
                      {/* "Draft · " first, so a long title cut short in the closed picker still says it. */}
                      {entryText(e)}
                    </option>
                  ))}
                </select>
              </label>
            )
          )}
        </span>
        <button className="btn btn-sm template-strip-done" title="Finish editing the layout. Esc also finishes once nothing is selected." onClick={leaveLayout}>
          <Check aria-hidden="true" />
          Done<span className="template-strip-done-more"> editing</span>
        </button>
      </div>
    </div>
  );
}

/**
 * A layout with no entry to show it on: it says so over the page, which stays the one that was open, and offers the
 * first entry. A new one is an untitled draft, and the layout is shown on it at once; Layers is already open (openLayout).
 */
function TemplateNoEntries({ state, mode, readOnly }: { state: ProjectState; mode: TemplateMode; readOnly: boolean }) {
  const collection = state.collections[mode.collectionId];
  const name = collection?.settings.name ?? 'This collection';
  const noun = entryNounLower(collection);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const add = async () => {
    const s = getState().snapshot;
    if (adding || !s || !Object.hasOwn(s.state.collections, mode.collectionId)) return;
    setAdding(true);
    const { ops, ref } = newPostOps(s.state, mode.collectionId, `Untitled ${noun}`);
    // The button goes with the card, so focus that was on it moves to the picker naming the new entry.
    const focused = addRef.current === document.activeElement;
    const r = await commitOps(ops, `New ${noun}`);
    setAdding(false);
    // Shown on the new entry, unless another layout or the page was chosen meanwhile.
    if (!r || getState().templateMode?.collectionId !== mode.collectionId) return;
    setState({ templateMode: { collectionId: mode.collectionId, entryId: ref.entryId } });
    if (focused) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="template-sample"]')?.focus());
  };
  return (
    <div className="template-no-entries">
      <StatusCard
        testId="template-no-entries"
        mark={<LayoutTemplate className="status-card-icon" aria-hidden="true" />}
        title={`${name} has no entries yet`}
        actions={
          readOnly ? (
            <button className="btn btn-sm btn-primary" onClick={openLayers}>
              <Layers aria-hidden="true" /> Open Layers
            </button>
          ) : (
            <>
              <button className="btn btn-sm" onClick={openLayers}>
                <Layers aria-hidden="true" /> Edit in Layers
              </button>
              <button ref={addRef} className="btn btn-sm btn-primary" aria-disabled={adding || undefined} onClick={() => void add()}>
                <Plus aria-hidden="true" /> Add {/^[aeiou]/i.test(noun) ? 'an' : 'a'} {noun}
              </button>
            </>
          )
        }
      >
        {/* Read-only, nothing can be added: the layout can still be looked through in Layers. */}
        <p>{readOnly ? 'A layout is shown on one of the collection’s entries, and it has none yet. You can look through the layout in Layers.' : 'A layout is shown on one of the collection’s entries. Add the first one to see it here, or edit the layout in Layers now.'}</p>
      </StatusCard>
    </div>
  );
}

