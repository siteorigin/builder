import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Box, Check, LocateFixed, Component, Copy, Ellipsis, Eye, GripVertical, Image, Layers, LayoutTemplate, Link2, PanelRight, Pencil, Play, Plus, RefreshCcw, Rows3, Sparkles, Trash2, TriangleAlert, Type, Unlink, Users } from 'lucide-react';
import { findParent } from '@engine/tree';
import { applyOps, commitOps, undoAction } from '../store';
import { CANVAS_DRAFT, reportRefused, setCanvasCommit } from '../lib/pending';
import { treeFor } from '../lib/model';
import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { aiActivity, api, commitDraft, confirmDialog, getState, markDraft, saveLocal, setState, setViewport, toast, useStore, type Rect } from '../store';
import { acceptMessage, newSessionId, postToFrame } from '../lib/bridge';
import { chainOf, descOrNull, measuredRects, rectList, spaceSizes, spacingOf, type FrameSpacing } from '../lib/payload';
import { blocksFromDom, richDom } from '../lib/richtext';
import { dropAt, dropReaches, moveIndex, shownOrder } from '../lib/reorder';
import { insertOps, insertRole, whereFor, type InsertAt } from '../lib/insert-at';
import { dropListSpecs, dropRefusal, dropTarget, incomingOrder, measuredLists, measureIds, savingProblems, type DropList, type Measured } from '../lib/insert-drop';
import { setInsertDropTarget, type InsertDrag } from '../lib/insert-drag';
import { askFrame, followed, followReport, newFrameNav, samePath } from '../lib/frame-nav';
import { inlineLinkProblem } from '../lib/link-problems';
import { revealTarget, sameTarget, type RevealTarget } from '../lib/reveal';
import { ARRIVAL_MS, arrivalShown, markArrival, takeArrival } from '../lib/arrival';
import { externalLink } from '@shared/links';
import { richTextToMarkdown } from '@shared/richtext';
import { boundaryOf, computedAt, createComponentTarget, definitionPick, descOf, designCtx, inDefinition, placementsOn, refExists, refLabel, resolveRef, selectionFromChain, throughPlacement, toDefinitionRef, type BridgeDesc } from '../lib/model';
import { askAiAbout, canInlineEdit, commitText, deleteSelection, detachable, detachPlacement, duplicateLayers, duplicateSelection, liveGroup, moveLayers, moveSelection, setMode, showsInlineText, structuralTarget, takeUnscrolled } from '../lib/actions';
import { handleShortcut } from '../Editor';
import { notePointerInput, openMenus, Spinner, useMenu } from '../components/ui';
import { AppMark } from '../components/AppMark';
import { runPhase } from '../lib/savestate';
import { focusInspector } from '../lib/inspector-focus';
import { clampViewport, frameKeyResize, VIEWPORT_LIMITS, type PanelSide } from '../lib/layout';
import { formSendOf, formsOf, sendSettled, type FormSend, type PracticeResult, type PreviewForm } from '../lib/form-practice';
import { FormPractice } from './FormPractice';
import { SpacingHandles } from './SpacingHandles';
import { copyPasteItems, PasteHere } from './CopyPaste';
import { copySelection, pasteFromMenu } from '../lib/clipboard';
import { isShellPart, showsPart } from '@shared/page-shell';
import { sampleEntries, shownView, templateOwner, viewAt, viewKey, type TemplateMode } from '../lib/template-view';
import { addressPath, frameEntry, NO_HISTORY, observe, siteAddresses, startJourney, stepTarget, type FrameEntry, type VisitorHistory } from '../lib/preview-history';

/** True while an inline text edit is open in the preview; shortcuts must not act on the selection then. */
export const inlineEdit = { active: false };
/** A text field inside the preview has focus, as the page reports it. It only keeps Undo, Delete and paste in that field; it never starts a project change. */
export const frameTextFocus = { active: false };

/** Shortcuts as this platform writes them: ⌘ and Meta on macOS, Ctrl and Control elsewhere. */
const isMac = api.platform === 'darwin';
const keys = (k: string) => (isMac ? k : k.replace('⇧⌘', 'Ctrl+Shift+').replace('⌘', 'Ctrl+'));
const ariaKeys = (k: string) => (isMac ? k : k.replace('Meta', 'Control'));

/** The site's page addresses as they are now (see siteAddresses). */
const siteNow = () => siteAddresses(Object.values(getState().snapshot?.state.pages ?? {}).map((pg) => pg.route));

/** Back and Forward through a visitor's journey in Preview, for the keyboard (see App and Editor). */
let visitorStep: ((dir: 'back' | 'forward') => boolean) | null = null;
/** Step back or forward in Preview; false when there is no such step. */
export function stepVisitor(dir: 'back' | 'forward'): boolean {
  return visitorStep?.(dir) ?? false;
}

/** Set while the canvas is shown: opens an address that is no page of the editor's (a post), or the page shown again. */
let frameVisit: ((path: string | null) => boolean) | null = null;
/** The address visitAddress asked for, until showEditedPage: a new frame (the preview restarted) opens it again. */
let visitWanted: string | null = null;
/**
 * Show `path` in the preview, as the editor asks for a page: the editor's page stays the one it shows, and asking for
 * that page again (showEditedPage) overtakes this request even before the frame gets there. False while the preview
 * is not ready to be asked.
 */
export function visitAddress(path: string): boolean {
  // Wanted either way: a preview still starting opens it once its frame is ready.
  visitWanted = path;
  return frameVisit?.(path) ?? false;
}
/** Back to the page the editor shows, from an address visitAddress opened. */
export function showEditedPage(): void {
  visitWanted = null;
  frameVisit?.(null);
}

export function Canvas() {
  const runtime = useStore((s) => s.runtime);
  const snapshot = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const templateMode = useStore((s) => s.templateMode);
  const viewport = useStore((s) => s.viewport);
  const zoomSetting = useStore((s) => s.zoom);
  const mode = useStore((s) => s.mode);
  const selection = useStore((s) => s.selection);
  const hover = useStore((s) => s.hover);
  const rects = useStore((s) => s.rects);
  const revealedItem = useStore((s) => s.revealedItem);
  const showSelection = useStore((s) => s.showSelection);
  const inspectorShown = useStore((s) => s.dockOpen && s.rightTab === 'inspect');
  const runStatus = useStore((s) => s.runStatus);
  const reading = useStore((s) => s.runMode === 'ask');
  const devMode = useStore((s) => !!s.settings?.developerMode);
  const definitionMode = useStore((s) => s.definitionMode);
  // While Site styles is open, edits are site-wide; the element selection steps back.
  const stylesOpen = useStore((s) => s.rightTab === 'styles' && s.dockOpen);
  const styleScope = useStore((s) => s.styleScope);
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [session, setSession] = useState(() => newSessionId());
  const [ready, setReady] = useState(false);
  /** Forms in Preview (issue #193): the page's forms, the reply practice sends get, the last send, the live test on its way. */
  const [forms, setForms] = useState<PreviewForm[]>([]);
  const [practice, setPractice] = useState<PracticeResult>('success');
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
  const [practiceH, setPracticeH] = useState(0);
  // The page's own error is shared through the store, so the status bar and Project health tell the same story.
  const frameError = useStore((s) => s.previewIssue);
  const setFrameError = (m: string | null) => setState({ previewIssue: m });
  // After Try again, the problem stays reported as "Restarting preview" until the new page says it is ready.
  const [retrying, setRetrying] = useState(false);
  /** The problem shown is the canvas's own "took too long" report, which a late arrival of the page clears. */
  const timedOut = useRef(false);
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
  const menu = useMenu();
  /** The inline edit the editor started; the preview cannot commit text on its own. */
  /** Inline text edits in progress, with the project and the AI's activity when each began. */
  const pendingEdits = useRef(new Map<string, { ref: ElementRef; desc: string; base: ReturnType<typeof getState>['snapshot']; ai: number }>());
  /** The pages the editor asked the frame for, and which of its reports it follows (see lib/frame-nav). */
  const nav = useRef(newFrameNav());
  /** The list item the page was last asked to reveal (see syncReveal). */
  const sentReveal = useRef<RevealTarget | null>(null);
  /** The route the page last said it is showing, or null while a navigation the editor asked for is on its way. */
  const frameAt = useRef<string | null>(null);
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
  /** The pointer is on the name of a short hovered element, which sits outside it, off the page. */
  const overTag = useRef(false);
  /** Escape hides the hover tag (WCAG 1.4.13) until the pointer moves to another element. */
  const [tagHidden, setTagHidden] = useState(false);
  useEffect(() => setTagHidden(false), [hover && refKey(hover)]); // eslint-disable-line react-hooks/exhaustive-deps
  // A name that goes away under the pointer (dismissed, or its element no longer hovered) fires no pointer leave.
  useEffect(() => {
    overTag.current = false;
  }, [hover && refKey(hover), tagHidden]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && getState().hover && setTagHidden(true);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  /** While dragging to reorder: the insertion line in page pixels (null where the drop would change nothing) and
   *  the name of what is moving. */
  const [reorder, setReorder] = useState<{ line: Rect | null; name: string } | null>(null);
  /** While a tile from Insert is dragged: where the pointer is, and what dropping there does (in page pixels, the gap's
   *  line and the outline of the container it goes into; `refused` says why it can't go there). */
  const [insertDrop, setInsertDrop] = useState<{ name: string; x: number; y: number; over: boolean; line: Rect | null; outline: Rect | null; label: string; refused: string | null } | null>(null);
  const insertDrag = useRef<{ end: (commit: boolean) => void; remeasure: () => void } | null>(null);
  const url = runtime.state === 'ready' ? runtime.url : null;
  const origin = url ? new URL(url).origin : null;
  const state = snapshot?.state;
  const page = state && pageId ? state.pages[pageId] : null;
  // What the frame shows: the page, or a collection's layout on one of its entries (lib/template-view).
  const view = state ? shownView(state, pageId, templateMode) : null;
  // A layout with no entry to show it on keeps the page behind it, under its note, so the frame is there for what comes next.
  const initialRoute = view?.route ?? page?.route;
  const initialSrc = useMemo(() => (url && initialRoute ? url + initialRoute : null), [url, session]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Forms in Preview: the panel sits above the other bottom bars (the preview pill, the AI run and a page problem).
  const formsShown = mode === 'preview' && forms.length > 0;
  // A page problem can wrap, so the panel stands on its measured height rather than a fixed step.
  const issueShown = !!frameError && runtime.state === 'ready';
  const issueBottom = 18 + (mode === 'preview' ? 46 : 0) + (runStatus ? 46 : 0);
  const issueRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const [issueH, setIssueH] = useState(0);
  useLayoutEffect(() => {
    const el = issueRef.current;
    if (!el) return;
    setIssueH(el.offsetHeight);
    const ro = new ResizeObserver(() => setIssueH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [issueShown]);
  // When the bar closes with focus in it, focus moves to a control that stays. Read while rendering, because the
  // bar has already left the page by the time an effect runs.
  const focusInIssue = useRef(false);
  focusInIssue.current = !!issueRef.current?.contains(document.activeElement);
  useLayoutEffect(() => {
    if (!issueShown && focusInIssue.current) (getState().mode === 'preview' ? exitRef.current : canvasRef.current)?.focus({ preventScroll: true });
  }, [issueShown]);
  const practiceBottom = issueShown ? issueBottom + (issueH || 40) + 10 : 18 + 46 + (runStatus ? 46 : 0);
  // The panel and the page share the height above the bars: past this the panel scrolls, so it never covers the page.
  const practiceMax = Math.max(120, size.h - practiceBottom - 50 - 160 * zoom);
  // While a restarted page loads, the pill keeps naming the page it is on.
  const address = journey.at?.address ?? view?.route ?? '';
  // How many characters the address slot holds. An address that does not fit keeps both of its ends in view.
  const addressRef = useRef<HTMLOutputElement>(null);
  const [addressFit, setAddressFit] = useState(Infinity);
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
  // The page ends above the panel, so it never covers what it describes (a form's Send button at the foot of a page).
  const practiceRoom = formsShown && practiceH ? Math.max(0, practiceBottom + practiceH + 8 - 28) : 0;
  // While editing, a page problem sits below the page rather than over its foot (a card, a form's Send button).
  const issueRoom = issueShown && mode === 'edit' && !formsShown ? Math.max(0, issueBottom + (issueH || 40) + 8 - 28) : 0;
  // The frame's whole footprint (20px top padding + 14px label margin + 28px bottom padding) fits at Fit, so the pasteboard never needs its own scrollbar.
  const frameH = Math.max(formsShown ? 160 : 300, (size.h - 70 - practiceRoom - issueRoom) / zoom);

  // While editing, a page that never says it has opened (no reply, no error) is reported as a problem after a while,
  // so the canvas offers Try again instead of saying "Opening…" for ever with the page closed to picks. A restart
  // (Try again) gets the same deadline, and its expiry hands Try again back. Preview keeps its own recovery.
  useEffect(() => {
    if (!url || frameReady || runtime.state !== 'ready' || mode !== 'edit' || !(retrying || !frameError)) return;
    const t = setTimeout(() => {
      if (getState().frameReady) return;
      setRetrying(false);
      const s = getState();
      const shown = s.snapshot ? shownView(s.snapshot.state, s.pageId, s.templateMode) : null;
      setFrameError(`${shown?.template ? `The ${shown.title}` : shown ? `The ${shown.title} page` : 'The page'} took too long to open.`);
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
   *  step in the open space below them. `emptyTop` is where that space starts, in page pixels. */
  const emptyPage = mode === 'edit' && !definitionMode && !templateMode && !!page && page.rootIds.length === 0;
  const [emptyTop, setEmptyTop] = useState<number | null>(null);
  // Cleared only when the page changes or stops being empty, so the card does not blink while the frame is resized.
  useEffect(() => setEmptyTop(null), [pageId, emptyPage]);
  useEffect(() => {
    if (!emptyPage || !frameReady || !page) return;
    const st = getState().snapshot?.state;
    if (!st) return;
    const parts = (['header', 'footer'] as const).filter((part) => showsPart(page, part));
    const descs = parts.flatMap((part) => st.site.shell[part].rootIds.map((id) => descOf(st, { owner: { kind: 'shell', id: part }, instancePath: [], nodeId: id }) ?? { ctx: '', node: '', items: '' }));
    if (!descs.length) return setEmptyTop(0);
    const requestId = Math.random().toString(36).slice(2);
    let live = true;
    measureWaiters.current.set(requestId, (raw) => {
      if (!live) return;
      const found = (measuredRects(raw, descs.length) ?? []).filter((r): r is Rect & { order: number } => !!r);
      setEmptyTop(found.length ? Math.max(...found.map((r) => r.y + r.height)) : 0);
    });
    post('measure', { requestId, descs });
    return () => {
      live = false;
      measureWaiters.current.delete(requestId);
    };
  }, [emptyPage, frameReady, pageId, viewport, snapshot?.revision, applied]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = (type: string, payload: unknown = {}) => postToFrame(frameRef.current, origin, session, type, payload);
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

  /** The inline edit is over (committed, cancelled, or its page went away): shortcuts work again. */
  function endInlineEdit(editId?: string) {
    if (editId === undefined) pendingEdits.current.clear();
    else pendingEdits.current.delete(editId);
    inlineEdit.active = pendingEdits.current.size > 0;
    setEditing(inlineEdit.active);
    markDraft(CANVAS_DRAFT, inlineEdit.active);
  }
  /** Start editing an element's text on the page (a double-click, or Edit text in its menu). A double-click passes
   *  its gesture id (`hit`) so the edit starts at the word clicked. */
  function beginTextEdit(ref: ElementRef, desc: BridgeDesc, hit?: string) {
    const editId = Math.random().toString(36).slice(2);
    pendingEdits.current.set(editId, { ref, desc: JSON.stringify([desc.ctx, desc.node, desc.items]), base: getState().snapshot, ai: aiActivity() });
    inlineEdit.active = true;
    setEditing(true);
    markDraft(CANVAS_DRAFT, true);
    post('beginTextEdit', { desc, editId, hit });
  }
  /** Edit text from the editor's own controls (the chip's Edit text, or the menu's): the page takes focus for it,
   *  after a menu has closed and handed focus back, so the edit keeps the focus it is given. */
  function startTextEditFromChrome(ref: ElementRef) {
    setState({ selection: ref });
    setTimeout(() => {
      const desc = descFor(ref);
      if (!desc || !canInlineEdit(ref)) return;
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
  useEffect(() => () => endInlineEdit(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Bridge messages
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = acceptMessage(e, frameRef.current, origin, session);
      if (!m) return;
      const s = getState();
      const st = s.snapshot?.state;
      const p = m.payload as Record<string, unknown>;
      switch (m.type) {
        case 'ready': {
          const path = String(p.path);
          // A page loaded in full inside the same frame while previewing (a visitor's Back across documents) is
          // followed, so the editor and the frame agree on the page.
          const sameFrame = readySession.current === session;
          const reloaded = sameFrame && s.mode === 'preview';
          readySession.current = session;
          // The visitor left the page they were on.
          if (reloaded && s.previewReturn) setState({ previewReturn: null });
          setReady(true);
          setState({ frameReady: true });
          setFrameError(null);
          setRetrying(false);
          markTimedOut(false);
          frameAt.current = path;
          // A page loaded in full while the frame was already up (Try again, a load that could not go in place) shows the
          // selection, as an arrival in place does (`navigated`); the first load scrolls to it once the frame is ready.
          if (ready && getState().mode !== 'preview' && view?.route && samePath(view.route, path)) {
            const desc = descFor(getState().selection);
            if (desc) post('scrollTo', { desc });
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
          // A new page starts with nothing revealed.
          sentReveal.current = null;
          syncReveal();
          const request = nav.current.request;
          if (!sameFrame) {
            // A new frame (another server, Try again) opened the page shown when it was made, and a request sent
            // while it loaded never reached it: it is asked for the page shown now. Try again keeps the preview
            // ready, so the navigate effect does not run for it.
            nav.current.request = null;
            // An address visitAddress opened (a post previewed) is opened again in the new frame.
            if (visitWanted) visit(visitWanted);
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
          break;
        }
        case 'history': {
          const at = frameEntry(p);
          if (at && getState().mode === 'preview') visitorAt(at);
          if (at) setJourney(observe(journeyRef.current, at, getState().mode === 'preview'));
          break;
        }
        case 'navigated': {
          // Only the report for the page the editor last asked for counts while that request is on its way: a late
          // report for an earlier one must not switch back to a page the author has since left. In Preview, a
          // visitor's own link clicks then move the editor along with them; while editing, the page goes
          // nowhere the editor did not send it.
          const path = String(p.path);
          if (!followReport(nav.current, path, typeof p.navId === 'number' ? p.navId : null, viewKey(getState()), getState().mode === 'preview')) break;
          // The page the frame is showing, so following it below does not send the frame back there (which would
          // drop a #section the visitor's link went to, and its scroll position).
          frameAt.current = path;
          // In Preview the page the frame is on is a visit, also when the editor opened it (the page picker).
          const at = journeyRef.current.at;
          if (getState().mode === 'preview' && at && samePath(addressPath(at.address), path)) setJourney(observe(journeyRef.current, at, true));
          // An open edit is not ended here: one in the shared header outlives the page change, and the page
          // ends any other (its element goes away) with its own cancel.
          setState({ frameReady: true });
          // A page that arrived after the canvas reported it as too slow is no longer a problem.
          if (timedOut.current) {
            markTimedOut(false);
            setFrameError(null);
            setRetrying(false);
          }
          syncPage(path);
          followed(nav.current, viewKey(getState()));
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
            if (desc) post('scrollTo', { desc });
          }
          break;
        }
        case 'hover': {
          const chain = chainOf(p.chain);
          // The pointer left the page for the name of what it was over: the hover stays (WCAG 1.4.13).
          if (!chain.length && overTag.current) break;
          hoverChain.current = chain;
          resolveHover();
          break;
        }
        case 'rects': {
          const hovered = rectList(p.hovered);
          const selected = rectList(p.selected);
          // The pointer is on the name of what it was over: that element keeps its outline while it rests there.
          setState({ rects: { selected, hovered: !hovered.length && overTag.current ? getState().rects.hovered : hovered, revealed: rectList(p.revealed) } });
          // An element just inserted now shows in view (mounted, and scrolled to): its outline arrives with a brief
          // highlight. Only for a report measured for it, on its own page, while its outline is drawn (editing, the
          // frame showing the page the editor has, Site styles closed).
          const shownPage = st && s.pageId ? st.pages[s.pageId] : null;
          const drawn = s.mode === 'edit' && s.frameReady && !(s.rightTab === 'styles' && s.dockOpen);
          const own = drawn && shownPage && samePath(shownPage.route, frameAt.current) ? descFor(s.selection) : null;
          if (takeArrival(s.selection, arrivalShown(descOrNull(p.selectedDesc), own, selected[0], p.viewport)) && s.selection) setArrival({ key: refKey(s.selection), n: ++arrivals.current });
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
          // A pick on a page the editor has not yet confirmed (one leaving) selects nothing.
          if (!st || !s.frameReady) return;
          pagePick();
          const chain = chainOf(p.chain);
          const next = pick(chain, !!p.alt || !!p.meta);
          setState({ selection: next });
          if (next && s.rightTab === 'styles') setState({ rightTab: 'inspect' });
          break;
        }
        case 'dblclick': {
          if (!st || !s.frameReady) return;
          const chain = chainOf(p.chain);
          const ref = pick(chain, true);
          const desc = ref && canInlineEdit(ref) ? descFor(ref) : null;
          if (ref && desc) {
            setState({ selection: ref });
            // The double-click it answers, so the edit starts at the word clicked (and not after a newer one).
            const hit = typeof p.hit === 'string' && p.hit.length <= 20 ? p.hit : undefined;
            beginTextEdit(ref, desc, hit);
          } else if (ref) {
            setState({ selection: ref, rightTab: 'inspect' });
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
          if (!d || JSON.stringify([d.ctx, d.node, d.items]) !== edit.desc) break;
          // Text the editor keeps nothing of goes back to what the page showed, so it never looks saved.
          const putBack = () => post('restoreText', { editId });
          if (!edit.base && !canInlineEdit(edit.ref)) {
            putBack();
            break;
          }
          // Rich text arrives as a copy of its structure (marks, lists and links included), plain text as a string.
          const dom = p.rich !== undefined ? richDom(p.rich) : null;
          const rich = dom ? blocksFromDom(dom, getState().snapshot?.state.pages ?? {}) : null;
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
          if (snap?.aiBusy || aiActivity() !== edit.ai) commitDraft(edit.base, () => void commitText(edit.ref, value, edit.base).then(restore), typedText, { check: true });
          else {
            // Built from the field editing began on, and written only while it still holds what it held then (see
            // commitOps). Text handed back because an update re-rendered its element may have been typed over text
            // the page showed before it caught up with the project: then it waits for the author to look.
            // Rich text has no plain baseline to compare, so a re-rendered one always waits for the author to look.
            const shown = p.detached === true && typeof p.before === 'string' ? p.before : null;
            const review = !!edit.base && p.detached === true && (shown === null ? Array.isArray(value) : !showsInlineText(edit.base, edit.ref, shown));
            commitDraft(edit.base, () => void commitText(edit.ref, value, edit.base ?? undefined).then(restore), typedText, review ? { review, ...(shown !== null ? { shown } : {}) } : {});
          }
          break;
        }
        case 'checkLink': {
          // A destination typed in the page's link field, checked against the site's pages before the words are
          // linked: the field keeps it, and says what is wrong, until it names somewhere the site can link to.
          if (!pendingEdits.current.has(String(p.editId)) || typeof p.href !== 'string') break;
          const problem = inlineLinkProblem(p.href.slice(0, 2000), getState().snapshot?.state.pages ?? {});
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
          if (p.key === 'Escape' && getState().hover) setTagHidden(true);
          break;
        case 'textFocus':
          frameTextFocus.active = p.on === true;
          break;
        case 'contextmenu': {
          if (!st || !s.frameReady) return;
          pagePick();
          const chain = chainOf(p.chain);
          const ref = pick(chain, false);
          if (!ref && s.definitionMode) {
            setState({ selection: null });
            break;
          }
          if (ref) setState({ selection: ref, ...(s.rightTab === 'styles' ? { rightTab: 'inspect' as const } : {}) });
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
          const ask =
            link.kind === 'email'
              ? { title: 'Write an email?', confirmLabel: 'Open email app' }
              : link.kind === 'phone'
                ? { title: 'Call this number?', confirmLabel: 'Open phone app' }
                : { title: 'Open this link in your browser?', confirmLabel: 'Open in browser' };
          void confirmDialog({
            ...ask,
            // The button opens the phone app; it never places the call itself.
            title: link.kind === 'phone' ? 'Open this number in your phone app?' : ask.title,
            body: link.kind === 'email' ? 'A new email to this address opens in your email app.' : link.kind === 'phone' ? 'Your phone app opens, ready to call this number.' : 'It opens in your web browser, outside SiteOrigin Builder.',
            subject: link.target,
            subjectKind: link.kind,
            icon: link.kind
          }).then((ok) => ok === true && void api.app.openExternal(link.href));
          break;
        }
        case 'runtimeError':
          markTimedOut(false);
          setFrameError(String(p.message).slice(0, 400));
          setRetrying(false);
          break;
        case 'revisionApplied':
          // A change shown by the page clears its own error, not the canvas's report that a page never arrived.
          if (!timedOut.current) setFrameError(null);
          // The page now shows the latest change (a last section deleted): what is measured on it is measured again.
          setApplied((n) => n + 1);
          break;
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
            w(p.rects);
          }
          break;
        }
        case 'spaceMeasured': {
          const w = measureWaiters.current.get(String(p.requestId));
          if (w) {
            measureWaiters.current.delete(String(p.requestId));
            w(p.px);
          }
          break;
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }); // re-bind each render so handlers see fresh origin/session

  const currentZoom = () => {
    const s = getState();
    return s.zoom === 'fit' ? Math.min(1, (size.w - 56) / s.viewport) : s.zoom;
  };

  function syncPage(path: string) {
    const st = getState().snapshot?.state;
    if (!st) return;
    const s = getState();
    // While a collection's layout is open, another of its entries keeps it open on that entry; a page closes it.
    const to = viewAt(st, s.templateMode, path);
    // Another entry of the same collection keeps what is selected in its layout; another collection's starts afresh.
    if (to && 'templateMode' in to) setState({ templateMode: to.templateMode, definitionMode: null, ...(to.templateMode.collectionId === s.templateMode?.collectionId ? {} : { selection: null }) });
    else if (to && (to.pageId !== s.pageId || s.templateMode)) setState({ pageId: to.pageId, templateMode: null, selection: null });
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
    if (!sameRef(next, s.hover)) setState({ hover: next });
    // The same node of a component, now under the pointer in another of its placements.
    else if (next && hoverPlacement.current !== shownHover.current) syncTrack();
    shownHover.current = hoverPlacement.current;
    canvasHover.current = next;
  }

  // Pointer events inside the page never reach this window, so any move seen here (the pasteboard, the chip,
  // a panel) means the pointer has left the page and the page's hover ends. A hover a Layers row set stays.
  useEffect(() => {
    const leave = (e: PointerEvent) => {
      // Resting on the name of what is hovered keeps it hovered.
      if ((e.target as Element | null)?.closest?.('.ov-label.outside')) return;
      if (!hoverChain.current) return;
      hoverChain.current = null;
      const s = getState();
      if (s.hover && sameRef(s.hover, canvasHover.current)) setState({ hover: null });
      canvasHover.current = null;
    };
    window.addEventListener('pointermove', leave, true);
    return () => window.removeEventListener('pointermove', leave, true);
  }, []);

  function syncTrack() {
    const s = getState();
    const st = s.snapshot?.state;
    if (!st) return;
    post('track', { selected: descFor(s.selection), hovered: descFor(s.hover, hoverPlacement.current) });
  }

  // A click changes what the next click would select, even if the pointer has not moved.
  useEffect(() => {
    if (hoverChain.current) resolveHover();
  }, [selection && refKey(selection), mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the bridge in sync with selection, hover and document revisions.
  useEffect(() => {
    if (ready) syncTrack();
  }, [ready, selection, hover, snapshot?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new selection is scrolled to once the frame shows its page, and so is one a Layers row asks to show again
  // (showLayer). Asked from Layers, one taller than the page shows from its top. One made with a page change (a page
  // opened at its remembered place, a usage on another page) is scrolled to when the page says it has arrived
  // (`navigated`). The selection Edit makes again after Preview stays where the visitor left the page.
  const shownFor = useRef(showSelection);
  useEffect(() => {
    // A request is for the moment it is made: one the page could not take then never carries over to a later pick.
    const show = shownFor.current !== showSelection;
    shownFor.current = showSelection;
    const quiet = takeUnscrolled(selection);
    const desc = ready && view?.route && samePath(view.route, frameAt.current) ? descFor(selection) : null;
    if (desc && (show || !quiet)) post('scrollTo', show ? { desc, show } : { desc });
  }, [ready, selection && refKey(selection), showSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The list item open in the inspector, revealed on the page while it is edited (see lib/reveal): only while
   * editing, with the inspector in view. The page is told only when that changes.
   */
  function syncReveal() {
    const s = getState();
    const st = s.snapshot?.state;
    const r = s.revealedItem;
    const at = st && r && s.mode === 'edit' && s.dockOpen && s.rightTab === 'inspect' ? pageRefFor(r.ref) : null;
    const ctx = st && at ? designCtx(st, at) : undefined;
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
  useEffect(() => {
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
    frameVisit = (path) => {
      if (path === null) {
        if (ready) openShownPage();
        return ready;
      }
      if (!ready) return false;
      return visit(path);
    };
    return () => {
      frameVisit = null;
    };
  });
  /** Ask the frame for an address that is no page of the editor's (see visitAddress). */
  function visit(path: string): boolean {
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
    post('navigate', { path, navId });
    return true;
  }

  /** Ask the frame for the page the editor shows, unless it is there already or already asked for. */
  function openShownPage() {
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
    frameAt.current = null;
    post('navigate', { path: shown.route, navId });
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
    if (ready && view?.route && (moved || !visitWanted)) openShownPage();
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
    const hit = definitionPick(st, dm.definitionId, chain);
    if (hovering) hoverPlacement.current = hit?.placement ?? null;
    else if (hit) placementRef.current = hit.placement;
    return hit?.ref ?? null;
  }

  /** The element the page shows for a reference: a component's own node is shown through one of its
   *  placements (the one it was picked through, else the first on this page); null when there is none. */
  function descFor(ref: ElementRef | null, via: ElementRef | null = null): BridgeDesc | null {
    const st = getState().snapshot?.state;
    const at = pageRefFor(ref, via);
    return st && at ? descOf(st, at) : null;
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
    const parent = ref.instancePath.length ? { owner: ref.owner, instancePath: ref.instancePath.slice(0, -1), nodeId: ref.instancePath[ref.instancePath.length - 1] } : null;
    const locked = !t || t.owner.kind === 'shell';
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
    const items = [
        { heading: name },
        ...(editable ? [{ label: 'Edit text', icon: <Pencil />, onSelect: editText }] : []),
        ...(parent ? [{ label: `Select ${chromeLabel(state, parent)}`, icon: <Component />, onSelect: live(parent, () => setState({ selection: parent })) }] : []),
        { label: 'Ask AI about this', icon: <Sparkles />, shortcut: keys('⌘J'), onSelect: live(ref, () => askAiAbout(ref)) },
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
              ...(locked ? [] : [...clipboard, { label: 'Duplicate', icon: <Copy />, shortcut: keys('⌘D'), onSelect: on(duplicateSelection) }]),
              ...(create ? [{ label: 'Create component…', icon: <Component />, onSelect: on(() => setState({ modal: { kind: 'create-component' as const, ref: create } })) }] : []),
              ...(!definitionMode && detachable(state, ref) ? [{ label: 'Detach component', icon: <Unlink />, onSelect: on(() => detachPlacement(ref)) }] : []),
              ...(locked ? [] : [{ separator: true }, { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: on(deleteSelection) }])
            ]
          : [])
      ];
    if (trigger) return menu.openAt(trigger, items, `${name} actions`, { focusLast });
    // A right-click on the page: once the chip for the new selection has rendered, its More actions button
    // is where focus returns, so the keyboard picks up in the toolbar rather than inside the page.
    requestAnimationFrame(() => menu.open(x, y, items, `${name} actions`, wrapRef.current?.querySelector<HTMLElement>('.ov-chip [aria-haspopup="menu"]') ?? canvasRef.current));
  }

  /** Drag a selected element to reorder it among its siblings, with a live insertion indicator. */
  async function startReorder(e: React.PointerEvent) {
    e.preventDefault();
    const s = getState();
    const t = structuralTarget(s.selection);
    const st = s.snapshot?.state;
    if (!t || !st) return;
    const tree = treeFor(st, t.owner);
    const info = tree && findParent(tree, t.nodeId);
    if (!info || info.list.length < 2) return;
    // A quick press can be released before the siblings are measured: catch it, so the drag never starts.
    let released = false;
    const early = () => (released = true);
    window.addEventListener('pointerup', early, { once: true });
    window.addEventListener('pointercancel', early, { once: true });
    window.addEventListener('blur', early, { once: true });
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
    // The line shows only where a drop would change the order; over the element's own place there is none.
    setReorder({ line: null, name });
    const move = (ev: PointerEvent) => {
      const box = wrapRef.current?.getBoundingClientRect();
      if (!box) return;
      const z = currentZoom();
      const inside = ev.clientX >= box.left && ev.clientX <= box.right && ev.clientY >= box.top && ev.clientY <= box.bottom;
      const drop = dropAt(boxes, (ev.clientX - box.left) / z, (ev.clientY - box.top) / z);
      // Outside the page, or over the element's own place, a release moves nothing. A gap among siblings of
      // another order is one no move reaches: no line shows there either.
      to = inside ? drop.to : null;
      setReorder({ line: to !== null && moveIndex(shown, from, to, order) !== null ? drop.line : null, name });
    };
    const end = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      setDragging(false);
      setReorder(null);
      if (commit && to !== null && !dropReaches(shown, from, to, order)) {
        toast('Its Order style keeps it out of that spot at this size, so it stays where it was. Change Order in its styles to move it there.', 'info');
        return;
      }
      const index = commit && to !== null ? moveIndex(shown, from, to, order) : null;
      if (index !== null) void announcedMove(() => applyOps([{ type: 'node.move', owner: t.owner, nodeId: t.nodeId, parentId: info.parentId, slot: info.slot, index }], 'Move'));
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

  /** Each spacing site style's size as padding on the box `desc` finds (null where it has none); null when the page
   *  doesn't answer. */
  const measureSpace = (vars: string[], desc: BridgeDesc) =>
    new Promise<Array<number | null> | null>((resolve) => {
      const requestId = Math.random().toString(36).slice(2);
      measureWaiters.current.set(requestId, (raw) => resolve(spaceSizes(raw, vars.length)));
      post('measureSpace', { requestId, vars, desc });
      setTimeout(() => {
        measureWaiters.current.delete(requestId);
        resolve(null);
      }, 1500);
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
    if (!snap || snap.readOnly || s.mode !== 'edit' || s.definitionMode || !s.pageId || !getState().frameReady || dragging || insertDrag.current || resizeDrag.current) return false;
    const st = snap.state;
    const owner: OwnerRef = s.templateMode ? templateOwner(s.templateMode) : { kind: 'page', id: s.pageId };
    const opening = snap.workspaceKey;
    const revision = snap.revision;
    const role = insertRole(st, drag.spec);
    const own = incomingOrder(st, drag.spec);
    const specs = dropListSpecs(st, owner);
    if (!specs.length) return false;
    let lists: DropList[] | null = null;
    let point = { x: start.x, y: start.y };
    let done = false;
    // Released while the page was still being measured: the drop waits for the measure, at the release point.
    let released = false;
    // Where a release would put it now: the place, or why it can't go there, and whether the pointer is on the page.
    let aim: { at: InsertAt | null; refused: string | null; over: boolean } = { at: null, refused: null, over: false };
    // Whether the project takes it in a list, tried once on a copy, against the problems the project already has.
    const checked = new Map<string, string | null>();
    let problems: ReturnType<typeof savingProblems> | null = null;
    const refusal = (at: InsertAt) => {
      const key = JSON.stringify([at.parentId, at.slot ?? null]);
      if (!checked.has(key)) checked.set(key, dropRefusal(st, insertOps(at, drag.spec, role), () => (problems ??= savingProblems(st))));
      return checked.get(key) ?? null;
    };
    const show = () => {
      const wrap = wrapRef.current?.getBoundingClientRect();
      const view = canvasRef.current?.querySelector('.canvas-scroll')?.getBoundingClientRect();
      const inBox = (b: DOMRect | undefined) => !!b && point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom;
      const over = inBox(wrap) && inBox(view);
      aim = { at: null, refused: null, over };
      let line: Rect | null = null;
      let outline: Rect | null = null;
      let label = over ? `Placing ${drag.name}` : `Drag ${drag.name} onto the page`;
      if (over && lists && wrap) {
        // The page's scale as it is drawn now (the panels beside the canvas can change it mid-drag).
        const z = wrap.width / getState().viewport;
        const t = dropTarget(lists, role, (point.x - wrap.left) / z, (point.y - wrap.top) / z, INSERT_EDGE / z, own);
        if (t) {
          const at: InsertAt = { owner, parentId: t.list.parentId, ...(t.list.slot ? { slot: t.list.slot } : {}), ...(t.index !== null ? { index: t.index } : {}) };
          const refused = t.refused ?? (t.index === null ? null : refusal(at));
          aim = { at: refused || t.index === null ? null : at, refused, over };
          // An empty row measures as a line: its outline is drawn at least 4 screen pixels tall.
          outline = t.list.box && t.list.box.height * z < 4 ? { ...t.list.box, y: t.list.box.y - 2 / z, height: 4 / z } : t.list.box;
          line = refused ? null : t.line;
          const w = refused ? null : whereFor(st, at, role);
          label = refused ? `Can’t place ${drag.name} here` : w ? `${drag.name} ${w.lead} ${w.within ? `${w.target} in ${w.within}` : w.target}` : label;
        }
      }
      setInsertDrop({ name: drag.name, x: point.x, y: point.y, over, line, outline, label, refused: aim.refused });
    };
    const drop = async (at: InsertAt) => {
      if (getState().snapshot?.workspaceKey !== opening) return;
      const w = whereFor(st, at, role);
      const r = await commitOps(insertOps(at, drag.spec, role), `Insert ${drag.name}`, undefined, revision);
      if (!r?.ok || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
      const id = r.results?.at(-1)?.nodeId as string | undefined;
      const now = getState();
      // Selected while the author is still on the page (or layout) it went on, with the arrival cue once the page shows it.
      const here = owner.kind === 'template' ? now.templateMode?.collectionId === owner.id : now.pageId === owner.id && !now.templateMode;
      if (id && here && now.mode === 'edit' && !now.definitionMode) {
        const ref: ElementRef = { owner, instancePath: [], nodeId: id };
        markArrival(ref);
        setState({ selection: ref, rightTab: 'inspect' });
      }
      toast(`Added ${drag.name}${w ? ` ${w.lead} ${w.within ? `${w.target} in ${w.within}` : w.target}` : ''}.`, 'info', undoAction(r));
    };
    const requests: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One measure on its way at a time; asked for again meanwhile (a burst of wheel steps), one more follows it.
    let measuring = false;
    let again = false;
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
      document.documentElement.classList.remove('insert-dragging');
      insertDrag.current = null;
      setDragging(false);
      setInsertDrop(null);
      if (!commit || !aim.over) return;
      if (aim.refused) return void toast(`${drag.name} wasn’t added: ${aim.refused}`, 'info');
      if (aim.at) void drop(aim.at);
    };
    /** Measure the page's lists, in batches the page answers (it reads at most 200 at a time); a node it can't show
     *  measures as nothing. What was measured before no longer counts until it lands. */
    const measure = () => {
      lists = null;
      if (measuring) {
        again = true;
        return;
      }
      measuring = true;
      again = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (lists || done) return;
        end(false);
        toast(`The page didn’t answer, so ${drag.name} can’t be dragged onto it now. Click its tile to add it instead.`, 'info');
      }, 3000);
      const ids = measureIds(specs);
      const measured = new Map<string, Measured | null>();
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += 200) batches.push(ids.slice(i, i + 200));
      void Promise.all(
        batches.map(
          (batch) =>
            new Promise<void>((resolve) => {
              const requestId = Math.random().toString(36).slice(2);
              requests.push(requestId);
              measureWaiters.current.set(requestId, (raw) => {
                measureWaiters.current.delete(requestId);
                const rects = measuredRects(raw, batch.length);
                batch.forEach((id, i) => measured.set(id, rects?.[i] ?? null));
                resolve();
              });
              post('measure', { requestId, descs: batch.map((id) => descFor({ owner, instancePath: [], nodeId: id }) ?? { ctx: '', node: '', items: '' }) });
            })
        )
      ).then(() => {
        measuring = false;
        if (done) return;
        if (again) return measure();
        clearTimeout(timer);
        lists = measuredLists(specs, measured);
        show();
        if (released) end(true);
      });
    };
    const mine = (ev: PointerEvent) => ev.pointerId === start.pointerId;
    const move = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      point = { x: ev.clientX, y: ev.clientY };
      show();
    };
    const up = (ev: PointerEvent) => {
      if (!mine(ev)) return;
      point = { x: ev.clientX, y: ev.clientY };
      show();
      if (lists || !aim.over) return end(true);
      // Released on the page before it was measured: dropped where it was let go, once it is.
      released = true;
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
      measure();
      show();
    };
    // Release and cancel are heard from the start, before the page is measured.
    listen(true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    document.documentElement.classList.add('insert-dragging');
    insertDrag.current = { end, remeasure: measure };
    setDragging(true);
    show();
    measure();
    return true;
  }
  useEffect(() => {
    setInsertDropTarget(startInsertDrag);
    return () => setInsertDropTarget(null);
  });
  // A drag in progress ends with the canvas, and with the page, project or editing it was planned on.
  useEffect(() => () => insertDrag.current?.end(false), []);
  useEffect(() => insertDrag.current?.end(false), [view?.key, mode, session, snapshot?.workspaceKey, !!definitionMode]); // eslint-disable-line react-hooks/exhaustive-deps
  // The page now shows a newer version: what a drag measured on it is measured again.
  useEffect(() => insertDrag.current?.remeasure(), [applied]);

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

  if (!snapshot) return <div className="canvas" />;

  const runtimeCard = (() => {
    if (runtime.state === 'ready') return null;
    if (runtime.state === 'unavailable')
      return (
        <div className="canvas-card" role="status">
          <AppMark size={40} />
          <h3>Preview unavailable</h3>
          <p style={{ maxWidth: 360 }}>{runtime.message}</p>
          <p>Your work is safe. You can keep editing in Layers and the Inspector.</p>
          <button
            className="btn"
            onClick={() => {
              setState({ leftTab: 'layers' });
              // Focus follows into Layers, so the keyboard carries on there.
              requestAnimationFrame(() => document.querySelector<HTMLElement>('.side-panel-view:not([hidden]) :is([role="tree"] [tabindex="0"], button)')?.focus());
            }}
          >
            <Layers /> Open Layers
          </button>
        </div>
      );
    if (runtime.state === 'error')
      return (
        <div className="canvas-card" role="alert">
          <TriangleAlert size={26} color="var(--red)" />
          <h3>{runtime.message}</h3>
          <p>Your work is safe. You can keep editing in Layers and the Inspector while the preview is stopped.</p>
          {runtime.detail && devMode && <pre>{runtime.detail}</pre>}
          <div className="row">
            <button className="btn btn-primary" onClick={() => void api.project.retryPreview()}>
              <RefreshCcw /> Try again
            </button>
            <button className="btn" onClick={() => setState({ modal: { kind: 'health' } })}>
              Open project health
            </button>
          </div>
        </div>
      );
    if (runtime.state !== 'preparing' && runtime.state !== 'starting')
      return (
        <div className="canvas-card" role="status">
          <AppMark size={40} />
          <h3>Preview is paused</h3>
          <p>Your work is safe. Start the preview to see and edit your site on the page.</p>
          <button className="btn btn-primary" onClick={() => void api.project.retryPreview()}>
            <Play /> Start preview
          </button>
        </div>
      );
    return (
      <div className="canvas-card" role="status">
        <span className="starting-mark">
          <AppMark size={40} />
          <Spinner large />
        </span>
        <h3>{runtime.state === 'preparing' ? 'Setting up website tools' : 'Starting preview'}</h3>
        <p style={{ maxWidth: 360 }}>{runtime.state === 'preparing' ? runtime.message : 'Opening your site. This usually takes a few seconds.'}</p>
      </div>
    );
  })();

  // The frame shows a page the editor has not confirmed (one leaving, or one that never arrived): it takes no picks,
  // nothing is drawn on it, and it steps back. "Opening" is that, before anything has been reported wrong.
  const staleFrame = !runtimeCard && !!url && !frameReady && mode === 'edit';
  const opening = staleFrame && !frameError;
  // While editing, a page that is showing but threw is not "couldn't be previewed": something on it went wrong.
  // Preview's own wording is left as it is.
  const issueText = mode !== 'edit' ? 'This page couldn’t be previewed.' : slowPage && frameError ? frameError : frameReady ? 'Something on this page didn’t work.' : 'This page couldn’t be previewed.';
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
  // The drop line keeps the same weight at any zoom: centred on the gap the geometry gives, 2px of colour between
  // its keylines, in screen pixels. It starts at the centre of its ring, 7px in, and stays at least 6px inside the
  // page, so its keylines and ring are never clipped.
  const dropBox = (r: Rect) => {
    const vertical = r.height > r.width;
    const b = toBox(r);
    const within = (v: number, max: number) => Math.max(6, Math.min(v, max - 8));
    return vertical
      ? { left: snap(within(b.left + b.width / 2 - 1, frameW)), top: b.top + 7, width: 2, height: Math.max(4, b.height - 9), vertical }
      : { left: b.left + 7, top: snap(within(b.top + b.height / 2 - 1, frameH * z)), width: Math.max(4, b.width - 9), height: 2, vertical };
  };
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
  // Text being edited always has its chip parked above the page, never over the words.
  const placement = firstSel && selection ? chipPlacement(firstSel, !isPart && !editing, frameH * z) : null;
  // Spacing handles sit on the selected box itself (not its outline's breathing room), while editing and not while
  // text is being typed, a block moved, the page resized or a component's design edited everywhere.
  const spaceDesc = selection ? descFor(selection) : null;
  // The page's report must be for this selection: one from before it changed measured something else.
  const spaceFor = !!spacing && !!spaceDesc && spacing.desc.ctx === spaceDesc.ctx && spacing.desc.node === spaceDesc.node && spacing.desc.items === spaceDesc.items;
  const spaceShown = selBoxes.length > 0 && spaceFor && !!state && !editing && !reorder && !resizing && !definitionMode && !snapshot?.aiBusy && !snapshot?.readOnly;
  const device = viewport < 768 ? 'Phone' : viewport < 1024 ? 'Tablet' : 'Desktop';
  const scalePct = Math.round(z * 100);
  // The width label shares the strip with a parked chip: in full, then the width and zoom, then just the width,
  // then not at all, whichever fits beside the chip. While the frame is being resized it always shows in full.
  // The same goes for what the strip says on its left (a page opening, a section moving), which never takes more
  // room than leaves the width itself.
  const chipEnd = placement === 'strip' && !reorder && !resizing && firstSel ? Math.max(0, Math.min(firstSel.left, frameW - chipW)) + chipW + 12 : 0;
  const leftEnd = chipEnd || (stripLeftW ? stripLeftW + 12 : 0);
  const labelMode = resizing || leftEnd + labelW.full <= frameW ? 'full' : scalePct !== 100 && leftEnd + labelW.mid <= frameW ? 'mid' : leftEnd + labelW.short <= frameW ? 'short' : 'gone';
  const stripRoom = Math.max(80, frameW - labelW.short - 12);
  // The empty-page card needs about 210px under the shared header and footer (its height and margins); with less,
  // the strip says it instead.
  const emptyFits = emptyTop !== null && emptyTop * z + 24 + 186 <= frameH * z;
  const addSections = () => {
    setState({ leftTab: 'insert' });
    // Into the Insert panel, where the first section is chosen; it goes on this page.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.side-panel-view:not([hidden]) :is(input, button, [tabindex="0"])')?.focus());
  };

  return (
    <main
      ref={canvasRef}
      tabIndex={-1}
      className={`canvas${mode === 'edit' ? ' edit-mode' : ''}${selection?.owner.kind === 'shell' && !definitionMode ? ' sel-shared' : ''}${reorder ? ' reordering' : ''}${insertDrop ? ' placing' : ''}${resizing ? ' resizing' : ''}`}
      aria-label="Website preview"
      // Read by the test driver's UI snapshots (tests/driver): which opening of a project this is, whether the frame's
      // page is ready, the selection as the editor holds it, and where it shows on the page as the page's own element
      // ids (absent: nothing selected; empty: a selection with no place on this page).
      data-opening={workspaceKey}
      data-frame={frameReady ? 'ready' : 'loading'}
      data-selected-ref={selection ? JSON.stringify(selection) : undefined}
      data-selection={selection ? (spaceDesc ? JSON.stringify(spaceDesc) : '') : undefined}
    >
      {runtimeCard && <div className="canvas-state">{runtimeCard}</div>}
      {/* Said in the strip above the page (see frame-status below), and here for screen readers. */}
      <p className="sr-only" role="status">
        {opening ? `Opening ${view?.title ?? 'the page'}…` : ''}
      </p>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {mode === 'preview' && (
        <div className="preview-pill" role="group" aria-label="Preview">
          <span className="pill-note" title="Links and menus work as they will for visitors">
            <Eye aria-hidden="true" /> Previewing
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
          <output ref={addressRef} className="pill-address" aria-label="Page address" title={address || undefined} tabIndex={elided ? 0 : undefined}>
            {elided ? (
              <>
                <span className="sr-only">{address}</span>
                <span aria-hidden="true">{elided}</span>
              </>
            ) : (
              address
            )}
          </output>
          {elided && (
            <span className="pill-address-full" aria-hidden="true">
              {address}
            </span>
          )}
          <button ref={exitRef} onClick={() => setMode('edit')}>
            <Pencil size={13} /> Back to editing
          </button>
        </div>
      )}
      {/* Mounted before they have anything to say, so both are announced. The problem clears during a restart, so a
          restart that fails is announced again. */}
      <p className="sr-only" role="alert">
        {issueShown && !retrying ? `${issueText} Your work is safe.` : ''}
      </p>
      <p className="sr-only" role="status">
        {issueShown && retrying ? 'Restarting preview…' : ''}
      </p>
      {issueShown && (
        // Bottom bars stack: preview pill, then the AI run, then a page problem, each one step up. It comes right after
        // the pill in the tab order, ahead of the form panel and the page, so recovery is close at hand.
        <div ref={issueRef} className={`ai-veil issue${retrying ? ' retrying' : ''}`} style={{ bottom: issueBottom }} role="group" aria-label="Page problem">
          {retrying ? <Spinner decorative /> : <TriangleAlert size={15} aria-hidden="true" />}
          <span>
            <strong>{retrying ? 'Restarting preview…' : issueText}</strong> Your work is safe.
          </span>
          {/* Not natively disabled, so focus stays here while the page restarts. */}
          <button
            className="btn btn-sm"
            aria-disabled={retrying || undefined}
            onClick={() => {
              if (retrying) return;
              setRetrying(true);
              setSession(newSessionId());
            }}
          >
            Try again
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setState({ modal: { kind: 'health' } })}>
            Details
          </button>
        </div>
      )}
      {/* Said once when a page with forms opens, for an author whose focus stays in the page and never meets the panel. */}
      <p className="sr-only" role="status">
        {formsShown ? `Form sends are simulated in Preview. ${forms.some((f) => f.live) ? 'Nothing is sent unless you test live delivery.' : 'Nothing is sent.'}` : ''}
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
          bottom={practiceBottom}
          maxHeight={practiceMax}
          onHeight={setPracticeH}
        />
      )}
      {runStatus && (
        <div className="ai-veil" role="status" style={{ bottom: mode === 'preview' ? 64 : 18 }}>
          <Sparkles size={15} className="spark" />{' '}
          {runStatus === 'awaiting-input' ? (
            <>
              The AI has a question for you.{' '}
              <button className="link-btn" onClick={() => setState({ dockOpen: true, rightTab: 'chat' })}>
                Answer it
              </button>
            </>
          ) : (
            reading ? (
              runStatus === 'stopping' ? 'Stopping the question.' : 'The AI is reading the site to answer your question. You can keep editing.'
            ) : runPhase(runStatus) === 'checking' ? (
              'The AI is checking its changes. You can look around while it works.'
            ) : runPhase(runStatus) === 'stopping' ? (
              'Stopping the AI and undoing its changes.'
            ) : (
              'The AI is editing this site. You can look around while it works.'
            )
          )}
          <button className="btn btn-sm" onClick={() => void api.ai.stop()}>
            Stop
          </button>
        </div>
      )}
      <div
        className="canvas-scroll"
        ref={scrollRef}
        onMouseDown={(e) => e.target === e.currentTarget && setState({ selection: null })}
      >
        {url && initialSrc && (
          <div className={`frame-wrap${staleFrame ? ' stale' : ''}${opening || retrying ? ' waiting' : ''}`} ref={wrapRef} style={{ width: frameW, height: frameH * z, marginTop: 14, transform: nudge.x || nudge.y ? `translate(${-nudge.x}px, ${-nudge.y}px)` : undefined }}>
            {/* The strip above the page: what the page is doing on the left, its screen size on the right. */}
            {opening && !resizing && !templateMode && (
              <div className="frame-status" ref={stripLeft} style={{ maxWidth: stripRoom }} aria-hidden="true">
                <Spinner decorative />
                <span>Opening {view?.title ?? 'the page'}…</span>
              </div>
            )}
            {/* Stays while another entry opens, so the entry picker keeps focus as the author steps through entries. */}
            {templateMode && mode === 'edit' && state && !resizing && !insertDrop && !reorder && <TemplateStrip state={state} mode={templateMode} maxWidth={stripRoom} opening={opening} />}
            {templateMode && state && !view?.route && <TemplateNoEntries state={state} mode={templateMode} />}
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
            {emptyPage && emptyTop !== null && !staleFrame && !emptyFits && !resizing && !reorder && !insertDrop && !(placement === 'strip' && firstSel) && (
              <div className="frame-status empty" ref={stripLeft} style={{ maxWidth: stripRoom }}>
                <span>This page has no sections yet</span>
                <button className="link-btn" onClick={addSections}>
                  <Plus /> Add a section
                </button>
              </div>
            )}
            {insertDrop && (
              <div className={`ov-moving ov-placing${insertDrop.refused ? ' refused' : ''}`} ref={stripLeft} style={{ maxWidth: stripRoom }} title={insertDrop.refused ?? undefined} data-testid="insert-drop-label">
                <Plus />
                <span className="what">{insertDrop.label}</span>
                <span className="sep">·</span>
                <span className="hint">Esc to cancel</span>
              </div>
            )}
            {reorder && firstSel && (
              <div className="ov-moving" ref={stripLeft} style={{ maxWidth: stripRoom }} aria-hidden="true">
                <GripVertical />
                <span className="what">Moving {reorder.name}</span>
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
                style={{ pointerEvents: dragging || staleFrame ? 'none' : undefined }}
                tabIndex={staleFrame ? -1 : undefined}
              />
            </div>
            <div className="overlay-layer">
              <div className="overlay-clip">
                {hovering &&
                  hovBoxes.map((b, i) => {
                    const tall = b.height >= 40;
                    // A tall element carries its name inside its top-left corner (kept in view when its top has scrolled
                    // out of the page); a short one, above it, or below when it sits at the top of the page.
                    // Near the page's right edge the name is anchored to the element's right, so the page edge never cuts it.
                    const side = b.left > frameW - 160 ? (tall ? { left: 'auto', right: 4 } : { left: 'auto', right: 0 }) : tall ? {} : { left: 0 };
                    const tagAt = { ...side, ...(tall ? (b.top < 0 ? { top: 4 - b.top } : {}) : b.top >= 24 ? { top: -19 } : { top: b.height - 1 }) };
                    const show = i === 0 && !tagHidden && b.top + b.height > (tall ? 30 : 0) && !(placement === 'inside' && firstSel && Math.abs(firstSel.top - b.top) < 34 && Math.abs(firstSel.left - b.left) < chipW + 8);
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
                                    if (hover) setState({ selection: hover, ...(getState().rightTab === 'styles' ? { rightTab: 'inspect' as const } : {}) });
                                  }
                            }
                            onPointerEnter={() => (overTag.current = true)}
                            onPointerLeave={() => (overTag.current = false)}
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
                {selBoxes.map((b, i) => (
                  // The arrival cue's box is a new one, so the next insertion's cue starts from its beginning.
                  <div
                    key={i === 0 && arriving ? `s0-${arrival.n}` : `s${i}`}
                    className={`ov-box ov-selected${i > 0 && selection?.itemPath?.length ? ' dim' : ''}${i === 0 && reorder ? ' moving' : ''}${i === 0 && editing ? ' editing' : ''}${i === 0 && arriving ? ' arriving' : ''}`}
                    style={b}
                  />
                ))}
                {spaceShown && (
                  <SpacingHandles
                    // A drag belongs to one selection, at one size, zoom and page: any change ends it.
                    key={JSON.stringify([session, pageId, refKey(selection!), selection!.itemPath ?? [], styleScope, viewport, z])}
                    state={state!}
                    selection={selection!}
                    desc={spaceDesc!}
                    box={toBox(rects.selected[0])}
                    spacing={spacing!}
                    zoom={z}
                    post={post}
                    measureSpace={measureSpace}
                    onDragging={setDragging}
                    focusCanvas={() => canvasRef.current?.focus({ preventScroll: true })}
                  />
                )}
                {reorder?.line &&
                  (() => {
                    const d = dropBox(reorder.line);
                    return <div className={`ov-drop${d.vertical ? ' vertical' : ''}`} style={{ left: d.left, top: d.top, width: d.width, height: d.height }} role="presentation" />;
                  })()}
                {insertDrop?.outline && <div className={`ov-box ov-drop-target${insertDrop.refused ? ' refused' : ''}`} style={toBox(insertDrop.outline)} data-testid="insert-drop-target" />}
                {insertDrop?.line &&
                  (() => {
                    const d = dropBox(insertDrop.line);
                    return <div className={`ov-drop${d.vertical ? ' vertical' : ''}`} style={{ left: d.left, top: d.top, width: d.width, height: d.height }} role="presentation" data-testid="insert-drop-line" />;
                  })()}
              </div>
              {emptyPage && emptyTop !== null && !staleFrame && emptyFits && (
                <div className="canvas-empty" style={{ top: emptyTop * z + 24 }}>
                  <div className="canvas-card empty-card" role="group" aria-labelledby="canvas-empty-title" data-testid="canvas-empty-page">
                    <h3 id="canvas-empty-title">This page has no sections yet</h3>
                    <p>Add a first section to start building it. Visitors never see this note.</p>
                    <button className="btn btn-primary" onClick={addSections}>
                      <Plus /> Add a section
                    </button>
                    <PasteHere className="btn" />
                  </div>
                </div>
              )}
              {firstSel && selection && state && placement && !reorder && !resizing && (
                <SelectionChip
                  box={firstSel}
                  frameWidth={viewport * z}
                  placement={placement}
                  name={defRoot ? state.components[definitionMode!.definitionId].name : selLabel}
                  icon={kindIcon(state, selection)}
                  parent={isPart && !definitionMode ? chromeLabel(state, { owner: selection.owner, instancePath: selection.instancePath.slice(0, -1), nodeId: selection.instancePath[selection.instancePath.length - 1] }) : null}
                  repeats={selBoxes.length}
                  item={itemOf(state, selection)}
                  repeatsLabel={selLabel ? `${selLabel.toLowerCase()}${/s$/.test(selLabel) ? '' : 's'}` : 'items'}
                  sib={siblings(state, structuralTarget(selection))}
                  onWidth={setChipW}
                  onLostFocus={() => canvasRef.current?.focus({ preventScroll: true })}
                  onMore={(el, focusLast) => openContextMenu(0, 0, selection, el, focusLast)}
                  onGrip={startReorder}
                  editing={editing}
                  onDone={() => post('commitTextEdit')}
                  onMove={(dir) => void announcedMove(() => moveLayers(dir))}
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
            {frameHandle('left')}
            {frameHandle('right')}
          </div>
        )}
      </div>
      {menu.node}
      {/* What a drag from Insert carries, beside the pointer wherever it is in the window. */}
      {insertDrop &&
        createPortal(
          <div className={`insert-ghost${insertDrop.refused ? ' refused' : ''}`} style={{ left: insertDrop.x + 14, top: insertDrop.y + 12 }} aria-hidden="true">
            <Plus />
            <span>{insertDrop.name}</span>
          </div>,
          document.body
        )}
    </main>
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

/** The name the canvas chrome uses: the shared header and footer say so, since the green alone cannot. */
function chromeLabel(state: ProjectState, ref: ElementRef): string {
  if (ref.owner.kind === 'shell' && !ref.instancePath.length && boundaryOf(state, ref).nodeId === ref.nodeId) return ref.owner.id === 'header' ? 'Shared header' : 'Shared footer';
  return refLabel(state, ref);
}

/** The same glyphs Layers uses for each kind of part. */
function kindIcon(state: ProjectState, ref: ElementRef) {
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

/** For a part picked in one repeated item (one card of three), which item it is: "2 of 3". */
function itemOf(state: ProjectState, ref: ElementRef): { n: number; count: number } | null {
  const itemId = ref.itemPath?.[0];
  if (!itemId || !ref.instancePath.length) return null;
  const inst = resolveRef(state, { owner: ref.owner, instancePath: [], nodeId: ref.instancePath[0] }).node;
  if (inst?.kind !== 'instance') return null;
  for (const [key, prop] of Object.entries(state.components[inst.definitionId]?.properties ?? {})) {
    const list = prop.type === 'list' ? (inst.props as Record<string, unknown> | undefined)?.[key] : null;
    const n = Array.isArray(list) ? list.findIndex((it) => !!it && typeof it === 'object' && (it as { id?: unknown }).id === itemId) : -1;
    if (n >= 0) return { n: n + 1, count: (list as unknown[]).length };
  }
  return null;
}

const CHIP_H = 28;
/** Near a container's top or bottom edge, in screen pixels, a dragged element goes beside it rather than into it. */
const INSERT_EDGE = 10;
const CHIP_GAP = 4;

/**
 * Where the chip goes. A tall section (with its top on screen) carries it inside its top edge, where its own
 * padding is. A smaller element gets it above, when there is room inside the page. Everything else (parts,
 * which sit among other content, and anything scrolled past the top or bottom of the visible page) parks it
 * in the strip above the page frame, lined up with the selection, so it never covers the page or floats off
 * it. `frameHeight` is the visible page's height, in the same (zoomed) pixels as the box.
 */
function chipPlacement(box: { top: number; height: number }, topLevel: boolean, frameHeight: number): 'inside' | 'above' | 'strip' {
  if (!topLevel) return 'strip';
  if (box.top >= 0 && box.height > 120 && box.top + CHIP_H + CHIP_GAP + 2 <= frameHeight) return 'inside';
  if (box.top >= CHIP_H + CHIP_GAP + 2 && box.top < frameHeight) return 'above';
  return 'strip';
}

/**
 * The selection chip: a toolbar of the selection's name and actions. Its place comes from chipPlacement and
 * it stays inside the page frame horizontally. One Tab stop: Left/Right/Home/End move between its buttons
 * (WAI-ARIA APG toolbar); the drag handle is pointer-only, with Move up and Move down as its keyboard
 * equivalent. Delete is not here: it lives at the end of More actions, in red, and on the Delete key.
 */
function SelectionChip({ box, frameWidth, placement, name, icon, parent, repeats, repeatsLabel, item, sib, editing, onMore, onGrip, onWidth, onLostFocus, onDone, onMove, onEditText, onReveal }: { box: { left: number; top: number; width: number; height: number }; frameWidth: number; placement: 'inside' | 'above' | 'strip'; name: string; icon: React.ReactNode; parent: string | null; repeats: number; repeatsLabel: string; item: { n: number; count: number } | null; sib: { index: number; count: number } | null; editing: boolean; onMore: (el: HTMLElement, focusLast?: boolean) => void; onGrip: (e: React.PointerEvent) => void; onWidth: (w: number) => void; onLostFocus: () => void; onDone: () => void; onMove: (dir: -1 | 1) => void; onEditText: (() => void) | null; onReveal: (() => void) | null }) {
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
  /** Too narrow for everything (a phone frame, many actions): the parent link and Edit text, which More actions
   *  also offers, step out of the chip rather than being clipped while still focusable. */
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => setCompact(false), [key, frameWidth, editing]);
  useLayoutEffect(() => {
    const width = ref.current?.offsetWidth ?? 0;
    if (width && width !== w) (setW(width), onWidth(width));
    const nameEl = ref.current?.querySelector<HTMLElement>('.name');
    if (!compact && nameEl && nameEl.scrollWidth > nameEl.clientWidth + 1) setCompact(true);
    // Roving tab stop: exactly one button is in the Tab order, the last one used.
    const list = buttons();
    const keep = Math.min(current.current, list.length - 1);
    list.forEach((b, i) => (b.tabIndex = i === keep ? 0 : -1));
    if (orphaned()) list[keep]?.focus();
    // The menu button starts closed; useMenu owns aria-expanded from then on.
    const more = ref.current?.querySelector('[aria-haspopup="menu"]');
    if (more && !more.hasAttribute('aria-expanded')) more.setAttribute('aria-expanded', 'false');
  });
  // When the chip itself goes (the selection was deleted or cleared) while it had focus, the canvas keeps it.
  useEffect(
    () => () => {
      if (focusIn.current) requestAnimationFrame(() => orphaned() && onLostFocus());
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const t = structuralTarget(selection);
  const top = placement === 'strip' ? -CHIP_H - 6 : placement === 'inside' ? box.top + CHIP_GAP + 2 : box.top - CHIP_H - CHIP_GAP;
  const left = Math.max(0, Math.min(placement === 'inside' ? box.left + CHIP_GAP + 2 : box.left, frameWidth - w));
  const parentRef = selection?.instancePath.length ? { owner: selection.owner, instancePath: selection.instancePath.slice(0, -1), nodeId: selection.instancePath[selection.instancePath.length - 1] } : null;
  const structural = !!t && !selection?.instancePath.length;
  const canEdit = structural && t!.owner.kind !== 'shell';
  // With layers selected together in Layers, the chip's commands (like their shortcuts) move and duplicate them all.
  const group = layerSet ? liveGroup() : null;
  const canReorder = structural && !!sib && sib.count > 1;
  const canUp = group ? group.indexes[0] > 0 : !!sib && sib.index > 0;
  const canDown = group ? group.indexes[group.indexes.length - 1] < group.list.length - 1 : !!sib && sib.index < sib.count - 1;
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
      <div ref={ref} className={`ov-chip ${placement} editing`} style={{ left, top, maxWidth: frameWidth }} role="toolbar" aria-label={`Editing ${what}`} onKeyDown={onKeyDown} onFocus={trackFocus} onBlur={trackBlur}>
        <span className="name">
          <Pencil />
          <span className="label">Editing {what}</span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span className="of">Esc to cancel</span>
        </span>
        <button className="chip-text" title={`Done (${keys('⌘↩')})`} aria-keyshortcuts={ariaKeys('Meta+Enter')} onClick={onDone}>
          <Check /> Done <kbd>{keys('⌘↩')}</kbd>
        </button>
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={`ov-chip ${placement}`}
      style={{ left, top, maxWidth: frameWidth }}
      role="toolbar"
      // Which of a repeated part it acts on (one card, or every card) is part of what the toolbar is for.
      aria-label={`${name}${item ? `, ${item.n} of ${item.count}` : repeats > 1 ? `, all ${repeats} ${repeatsLabel}` : ''} actions`}
      onKeyDown={onKeyDown}
      onFocus={trackFocus}
      onBlur={trackBlur}
    >
      {canReorder && !group && (
        // Pointer-only, so it is hidden from assistive tech: Move up and Move down are its equivalent. A drag moves one
        // element, so it is not offered while layers are selected together (the arrows move them all).
        <span className="icon-btn grip" aria-hidden="true" title="Drag to move" aria-label="Drag to move" onPointerDown={onGrip}>
          <GripVertical />
        </span>
      )}
      <span className="name">
        {icon}
        <span className="label">{name}</span>
        {parent && parentRef && !compact && (
          <button className="of link" title={`Select ${parent} (Esc)`} aria-label={`in ${parent}: select it`} aria-keyshortcuts="Escape" onClick={() => setState({ selection: parentRef })}>
            <span className="ellipsis">in {parent}</span>
          </button>
        )}
        {/* One card picked on the page vs the part in every card (picked in Layers): say which. */}
        {item ? <span className="of">· {item.n} of {item.count}</span> : repeats > 1 && <span className="of">· all {repeats} {repeatsLabel}</span>}
      </span>
      <span className="chip-sep" aria-hidden="true" />
      <button className="icon-btn" title={`Ask AI about this (${keys('⌘J')})`} aria-label="Ask AI about this" aria-keyshortcuts={ariaKeys('Meta+J')} onClick={() => askAiAbout(selection)}>
        <Sparkles />
      </button>
      {onEditText && !compact && (
        <button className="icon-btn" title="Edit text (double-click)" aria-label="Edit text" onClick={onEditText}>
          <Pencil />
        </button>
      )}
      {/* Scrolled right out of view, the selection has no outline on the page: this brings it back. */}
      {onReveal && (
        <button className="chip-text" title="Scroll the page back to it" aria-label="Show on the page" onClick={onReveal}>
          <LocateFixed /> Show
        </button>
      )}
      {inspectorHidden && (
        <button
          className="chip-text"
          title="Show this in the inspector"
          onClick={() => {
            setState({ dockOpen: true, rightTab: 'inspect' });
            // Focus follows into the inspector, landing on the selection's first control.
            focusInspector();
          }}
        >
          <PanelRight /> Edit
        </button>
      )}
      {(canReorder || canEdit) && <span className="chip-sep" aria-hidden="true" />}
      {canReorder && (
        <>
          <button className="icon-btn" title={`Move up (${keys('⇧⌘↑')})`} aria-label="Move up" aria-keyshortcuts={ariaKeys('Shift+Meta+ArrowUp')} aria-disabled={!canUp || undefined} onClick={guard(canUp, () => onMove(-1))}>
            <ArrowUp />
          </button>
          <button className="icon-btn" title={`Move down (${keys('⇧⌘↓')})`} aria-label="Move down" aria-keyshortcuts={ariaKeys('Shift+Meta+ArrowDown')} aria-disabled={!canDown || undefined} onClick={guard(canDown, () => onMove(1))}>
            <ArrowDown />
          </button>
        </>
      )}
      {canEdit && (
        <button className="icon-btn" title={`Duplicate (${keys('⌘D')})`} aria-label="Duplicate" aria-keyshortcuts={ariaKeys('Meta+D')} onClick={() => void duplicateLayers()}>
          <Copy />
        </button>
      )}
      <span className="chip-sep" aria-hidden="true" />
      <button
        className="icon-btn more"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
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

/**
 * The strip above the page while a collection's layout is edited: whose layout it is, the entry it is shown on (any
 * of the collection's, to see the layout with other words and pictures), and the way back to the page.
 */
function TemplateStrip({ state, mode, maxWidth, opening }: { state: ProjectState; mode: TemplateMode; maxWidth: number; opening: boolean }) {
  const collection = state.collections[mode.collectionId];
  const samples = sampleEntries(state, mode.collectionId);
  if (!collection) return null;
  return (
    <div className="frame-status template-strip" style={{ maxWidth }} role="group" aria-label={`${collection.settings.name} layout`} aria-busy={opening || undefined} data-testid="template-strip">
      {opening ? <Spinner decorative /> : <LayoutTemplate aria-hidden="true" />}
      <span className="template-strip-name">{collection.settings.name} layout</span>
      {samples.length > 0 && (
        <label className="template-strip-sample">
          <span>shown on</span>
          <select
            className="select sm"
            value={mode.entryId ?? ''}
            aria-label="Entry the layout is shown on"
            data-testid="template-sample"
            onChange={(e) => setState({ templateMode: { collectionId: mode.collectionId, entryId: e.target.value } })}
          >
            {samples.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title || e.slug}
                {e.draft !== false ? ' (draft)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="link-btn" onClick={() => setState({ templateMode: null, selection: null })}>
        Done
      </button>
    </div>
  );
}

/** A layout with no entry to show it on: it says so over the page, which stays the one that was open. */
function TemplateNoEntries({ state, mode }: { state: ProjectState; mode: TemplateMode }) {
  const name = state.collections[mode.collectionId]?.settings.name ?? 'This collection';
  return (
    <div className="template-no-entries" data-testid="template-no-entries">
      <div className="canvas-card" role="group" aria-labelledby="template-empty-title">
        <h3 id="template-empty-title">{name} has no entries yet</h3>
        <p>Its layout is shown on one of its entries. Add an entry to see it here; its layers can be edited in Layers now.</p>
        <button className="btn btn-sm" onClick={() => setState({ templateMode: null, selection: null })}>
          Done
        </button>
      </div>
    </div>
  );
}

