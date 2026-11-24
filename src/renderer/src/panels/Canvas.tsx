import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Box, Component, Copy, Ellipsis, Eye, GripVertical, Image, Link2, PanelRight, Pencil, RefreshCcw, Rows3, Sparkles, Trash2, TriangleAlert, Type, Users } from 'lucide-react';
import { findParent } from '@engine/tree';
import { applyOps } from '../store';
import { CANVAS_DRAFT, reportRefused, setCanvasCommit } from '../lib/pending';
import { treeFor } from '../lib/model';
import type { ElementRef, ProjectState } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { aiActivity, api, commitDraft, confirmDialog, getState, markDraft, saveLocal, setState, toast, useStore, type Rect } from '../store';
import { acceptMessage, newSessionId, postToFrame } from '../lib/bridge';
import { chainOf, descOrNull, measuredRects, rectList } from '../lib/payload';
import { blocksFromDom, richDom } from '../lib/richtext';
import { dropAt, moveIndex } from '../lib/reorder';
import { revealTarget, sameTarget, type RevealTarget } from '../lib/reveal';
import { externalLink } from '@shared/links';
import { richTextToMarkdown } from '@shared/richtext';
import { boundaryOf, computedAt, definitionPick, descOf, inDefinition, placementsOn, refLabel, resolveRef, selectionFromChain, throughPlacement, toDefinitionRef, type BridgeDesc } from '../lib/model';
import { askAiAbout, canInlineEdit, commitText, deleteSelection, duplicateLayers, duplicateSelection, liveGroup, moveLayers, moveSelection, structuralTarget } from '../lib/actions';
import { handleShortcut } from '../Editor';
import { notePointerInput, openMenus, Spinner, useMenu } from '../components/ui';
import { AppMark } from '../components/AppMark';
import { runPhase } from '../lib/savestate';
import { formSendOf, formsOf, sendSettled, type FormSend, type PracticeResult, type PreviewForm } from '../lib/form-practice';
import { FormPractice } from './FormPractice';
import { isShellPart, showsPart } from '@shared/page-shell';
import { addressPath, frameEntry, NO_HISTORY, observe, siteAddresses, startJourney, stepTarget, type VisitorHistory } from '../lib/preview-history';

/** True while an inline text edit is open in the preview; shortcuts must not act on the selection then. */
export const inlineEdit = { active: false };
/** A text field inside the preview has focus, as the page reports it. It only keeps Undo, Delete and paste in that field; it never starts a project change. */
export const frameTextFocus = { active: false };

/** Shortcuts as this platform writes them: ⌘ and Meta on macOS, Ctrl and Control elsewhere. */
const isMac = api.platform === 'darwin';
const keys = (k: string) => (isMac ? k : k.replace('⇧⌘', 'Ctrl+Shift+').replace('⌘', 'Ctrl+'));
const ariaKeys = (k: string) => (isMac ? k : k.replace('Meta', 'Control'));

const samePath = (a: string, b: string | null) => !!b && (a === b || a === b + '/' || a + '/' === b);
/** The site's page addresses as they are now (see siteAddresses). */
const siteNow = () => siteAddresses(Object.values(getState().snapshot?.state.pages ?? {}).map((pg) => pg.route));

/** Back and Forward through a visitor's journey in Preview, for the keyboard (see App and Editor). */
let visitorStep: ((dir: 'back' | 'forward') => boolean) | null = null;
/** Step back or forward in Preview; false when there is no such step. */
export function stepVisitor(dir: 'back' | 'forward'): boolean {
  return visitorStep?.(dir) ?? false;
}

export function Canvas() {
  const runtime = useStore((s) => s.runtime);
  const snapshot = useStore((s) => s.snapshot);
  const pageId = useStore((s) => s.pageId);
  const viewport = useStore((s) => s.viewport);
  const zoomSetting = useStore((s) => s.zoom);
  const mode = useStore((s) => s.mode);
  const selection = useStore((s) => s.selection);
  const hover = useStore((s) => s.hover);
  const rects = useStore((s) => s.rects);
  const revealedItem = useStore((s) => s.revealedItem);
  const inspectorShown = useStore((s) => s.dockOpen && s.rightTab === 'inspect');
  const runStatus = useStore((s) => s.runStatus);
  const reading = useStore((s) => s.runMode === 'ask');
  const devMode = useStore((s) => !!s.settings?.developerMode);
  const definitionMode = useStore((s) => s.definitionMode);
  // While Site styles is open, edits are site-wide; the element selection steps back.
  const stylesOpen = useStore((s) => s.rightTab === 'styles' && s.dockOpen);
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
  const [dragging, setDragging] = useState(false);
  const menu = useMenu();
  /** The inline edit the editor started; the preview cannot commit text on its own. */
  /** Inline text edits in progress, with the project and the AI's activity when each began. */
  const pendingEdits = useRef(new Map<string, { ref: ElementRef; desc: string; base: ReturnType<typeof getState>['snapshot']; ai: number }>());
  /** The route the editor last asked the page to show; its acknowledgement is the one that counts. */
  const pendingNav = useRef<string | null>(null);
  /** The list item the page was last asked to reveal (see syncReveal). */
  const sentReveal = useRef<RevealTarget | null>(null);
  /** The route the page last said it is showing, or null while a navigation the editor asked for is on its way. */
  const frameAt = useRef<string | null>(null);
  /** The frame session whose page has said it is ready at least once. */
  const readySession = useRef<string | null>(null);
  const measureWaiters = useRef(new Map<string, (rects: unknown) => void>());
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
  /** Escape hides the hover tag (WCAG 1.4.13) until the pointer moves to another element. */
  const [tagHidden, setTagHidden] = useState(false);
  useEffect(() => setTagHidden(false), [hover && refKey(hover)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && getState().hover && setTagHidden(true);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  /** While dragging to reorder: the insertion line, in page pixels. */
  const [reorder, setReorder] = useState<{ line: Rect } | null>(null);
  const url = runtime.state === 'ready' ? runtime.url : null;
  const origin = url ? new URL(url).origin : null;
  const state = snapshot?.state;
  const page = state && pageId ? state.pages[pageId] : null;
  const initialSrc = useMemo(() => (url && page ? url + page.route : null), [url, session]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setState({ frameReady: false }), [url, session]);

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
  const address = journey.at?.address ?? page?.route ?? '';
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
  // The frame's whole footprint (20px top padding + 14px label margin + 28px bottom padding) fits at Fit, so the pasteboard never needs its own scrollbar.
  const frameH = Math.max(formsShown ? 160 : 300, (size.h - 70 - practiceRoom) / zoom);

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
    markDraft(CANVAS_DRAFT, inlineEdit.active);
  }
  // A new page load (another server, Try again) or closing the editor ends any edit the old page had open.
  useEffect(() => {
    frameAt.current = null;
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
          const reloaded = readySession.current === session && s.mode === 'preview';
          readySession.current = session;
          setReady(true);
          setState({ frameReady: true });
          setFrameError(null);
          setRetrying(false);
          frameAt.current = path;
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
          // A page chosen while the preview was starting wins: the navigate effect opens it next.
          if (!s.pageId || reloaded) syncPage(path);
          break;
        }
        case 'history': {
          const at = frameEntry(p);
          if (at) setJourney(observe(journeyRef.current, at, getState().mode === 'preview'));
          break;
        }
        case 'navigated': {
          // While editing, only the reply for the page the editor last asked for counts: a late reply for an
          // earlier request must not undo the page the user has since chosen. In Preview, a visitor's own
          // link clicks move the editor along with them.
          const path = String(p.path);
          if (getState().mode !== 'preview' && pendingNav.current && !samePath(path, pendingNav.current)) break;
          pendingNav.current = path;
          // The page the frame is showing, so following it below does not send the frame back there (which would
          // drop a #section the visitor's link went to, and its scroll position).
          frameAt.current = path;
          // In Preview the page the frame is on is a visit, also when the editor opened it (the page picker).
          const at = journeyRef.current.at;
          if (getState().mode === 'preview' && at && samePath(addressPath(at.address), path)) setJourney(observe(journeyRef.current, at, true));
          // An open edit is not ended here: one in the shared header outlives the page change, and the page
          // ends any other (its element goes away) with its own cancel.
          setState({ frameReady: true });
          syncPage(path);
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
        case 'hover':
          hoverChain.current = chainOf(p.chain);
          resolveHover();
          break;
        case 'rects':
          setState({ rects: { selected: rectList(p.selected), hovered: rectList(p.hovered), revealed: rectList(p.revealed) } });
          break;
        case 'select': {
          if (!st) return;
          pagePick();
          const chain = chainOf(p.chain);
          const next = pick(chain, !!p.alt || !!p.meta);
          setState({ selection: next });
          if (next && s.rightTab === 'styles') setState({ rightTab: 'inspect' });
          break;
        }
        case 'dblclick': {
          if (!st) return;
          const chain = chainOf(p.chain);
          const ref = pick(chain, true);
          const desc = ref && canInlineEdit(ref) ? descFor(ref) : null;
          if (ref && desc) {
            setState({ selection: ref });
            const editId = Math.random().toString(36).slice(2);
            pendingEdits.current.set(editId, { ref, desc: JSON.stringify([desc.ctx, desc.node, desc.items]), base: getState().snapshot, ai: aiActivity() });
            inlineEdit.active = true;
            markDraft(CANVAS_DRAFT, true);
            post('beginTextEdit', { desc, editId });
          } else if (ref) {
            setState({ selection: ref, rightTab: 'inspect' });
            const r = resolveRef(st, ref);
            const bound = r.node?.kind === 'text' ? r.node.text : r.node?.kind === 'link' ? r.node.label : undefined;
            // A News card or article header shows a page's article details, changed in that page's settings.
            if (computedAt(st, ref, bound)) toast('This comes from the article’s page settings. Open the article’s page to change its title, date, byline or excerpt.', 'info');
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
          // Accept only the commit for an edit the editor started, on that exact element.
          if (!d || JSON.stringify([d.ctx, d.node, d.items]) !== edit.desc || !canInlineEdit(edit.ref)) break;
          // Rich text arrives as a copy of its structure (marks, lists and links included), plain text as a string.
          const dom = p.rich !== undefined ? richDom(p.rich) : null;
          const rich = dom ? blocksFromDom(dom, getState().snapshot?.state.pages ?? {}) : null;
          const value = rich ? rich.blocks : p.rich === undefined && typeof p.text === 'string' && p.text.length <= 20000 ? p.text : null;
          if (rich?.droppedLinks) {
            toast('A link pointed to something that is not a page, web address, email or phone number, so it was removed.', 'error');
            reportRefused('A link pointed to something that is not a page, web address, email or phone number, so it was removed.');
          }
          if (value === null || (Array.isArray(value) && value.length > 500)) {
            toast('That text change could not be saved. Try editing it in the inspector.', 'error');
            reportRefused('That text change could not be saved. Try editing it in the inspector.');
            break;
          }
          // Typed on the page, like any typed edit: if the AI ran meanwhile, it is the edit of the text as it was
          // when editing began, checked before it is applied (held while the AI works).
          const snap = getState().snapshot;
          const typedText = typeof value === 'string' ? value : richTextToMarkdown(value, snap?.state.pages ?? {});
          // An edit that leaves the field as it was rebuilds nothing: the page puts back the text it showed.
          const restore = (r: 'restore' | void) => void (r === 'restore' && post('restoreText', { editId }));
          if (snap?.aiBusy || aiActivity() !== edit.ai) commitDraft(edit.base, () => void commitText(edit.ref, value, edit.base).then(restore), typedText, { check: true });
          else commitDraft(null, () => void commitText(edit.ref, value).then(restore), typedText);
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
            toast('That text is too long to edit on the page. Edit it in the inspector instead.', 'error');
            reportRefused('That text is too long to edit on the page. Edit it in the inspector instead.');
          }
          break;
        case 'key':
          // Ignored: shortcuts are taken from trusted keyboard input (see App), never from the page.
          break;
        case 'textFocus':
          frameTextFocus.active = p.on === true;
          break;
        case 'contextmenu': {
          if (!st) return;
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
          setFrameError(String(p.message).slice(0, 400));
          setRetrying(false);
          break;
        case 'revisionApplied':
          setFrameError(null);
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
    const match = Object.values(st.pages).find((pg) => pg.route === path || pg.route === path + '/');
    if (match && match.id !== getState().pageId) setState({ pageId: match.id, selection: null });
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
    const leave = () => {
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

  useEffect(() => {
    const desc = ready ? descFor(selection) : null;
    if (desc) post('scrollTo', { desc });
  }, [ready, selection && refKey(selection)]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The list item open in the inspector, revealed on the page while it is edited (see lib/reveal): only while
   * editing, with the inspector in view. The page is told only when that changes.
   */
  function syncReveal() {
    const s = getState();
    const st = s.snapshot?.state;
    const r = s.revealedItem;
    const ctx = st && r && s.mode === 'edit' && s.dockOpen && s.rightTab === 'inspect' ? descFor(r.ref)?.ctx : undefined;
    const target = st && r && ctx ? revealTarget(st, r, ctx) : null;
    if (sameTarget(target, sentReveal.current)) return;
    sentReveal.current = target;
    post('reveal', { target });
  }
  useEffect(() => {
    if (ready) syncReveal();
  }, [ready, revealedItem, mode, inspectorShown, snapshot?.revision, pageId, definitionMode]); // eslint-disable-line react-hooks/exhaustive-deps

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
  useEffect(() => {
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

  // Navigate when the current page changes.
  useEffect(() => {
    if (!ready || !page) return;
    // The page already went there itself (a link clicked while previewing): leave it where it is.
    if (samePath(page.route, frameAt.current)) return;
    // Until the page confirms the navigation, it is "opening", not ready.
    setState({ frameReady: false });
    pendingNav.current = page.route;
    frameAt.current = null;
    post('navigate', { path: page.route });
  }, [pageId, page?.route, ready]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const s = getState();
    const st = s.snapshot?.state;
    if (!ref || !st) return null;
    const dm = s.definitionMode;
    if (!dm || !inDefinition(ref, dm.definitionId)) return descOf(st, ref);
    // A remembered placement counts only while it is on the page the canvas shows.
    const page = s.pageId ? st.pages[s.pageId] : undefined;
    const isPlacement = (pl: ElementRef | null) => {
      if (!pl || !page || (pl.owner.kind === 'page' ? pl.owner.id !== page.id : pl.owner.kind !== 'shell' || !isShellPart(pl.owner.id) || !showsPart(page, pl.owner.id))) return false;
      const n = resolveRef(st, pl).node;
      return n?.kind === 'instance' && n.definitionId === dm.definitionId;
    };
    const placement = [via, placementRef.current].find(isPlacement) ?? (s.pageId ? placementsOn(st, dm.definitionId, s.pageId)[0] : undefined);
    return placement ? descOf(st, throughPlacement(ref, placement)) : null;
  }

  // The component being edited went away (its copy was undone): editing it everywhere ends.
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
    const r = resolveRef(state, boundaryOf(state, ref));
    const isInstance = r.node?.kind === 'instance';
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
    const items = [
        { heading: name },
        ...(parent ? [{ label: `Select ${chromeLabel(state, parent)}`, icon: <Component />, onSelect: () => setState({ selection: parent }) }] : []),
        { label: 'Ask AI about this', icon: <Sparkles />, shortcut: keys('⌘J'), onSelect: () => askAiAbout(ref) },
        ...(t
          ? [
              ...(reorderable || !locked || !isInstance ? [{ separator: true }] : []),
              ...(reorderable
                ? [
                    { label: 'Move up', icon: <ArrowUp />, shortcut: keys('⇧⌘↑'), disabled: sib!.index === 0, onSelect: on(() => moveSelection(-1)) },
                    { label: 'Move down', icon: <ArrowDown />, shortcut: keys('⇧⌘↓'), disabled: sib!.index >= sib!.count - 1, onSelect: on(() => moveSelection(1)) }
                  ]
                : []),
              ...(locked ? [] : [{ label: 'Duplicate', icon: <Copy />, shortcut: keys('⌘D'), onSelect: on(duplicateSelection) }]),
              ...(!isInstance ? [{ label: 'Create component…', icon: <Component />, onSelect: () => setState({ modal: { kind: 'create-component' as const, ref: t } }) }] : []),
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
    const requestId = Math.random().toString(36).slice(2);
    const rects = await new Promise<Array<Rect | null> | null>((resolve) => {
      measureWaiters.current.set(requestId, (raw) => resolve(measuredRects(raw, info.list.length)));
      // A sibling the page cannot show (no placement) is asked for by a descriptor that matches nothing.
      // Siblings share the selection's repeated item, so every box comes from the same copy of the list.
      const itemPath = s.selection?.itemPath;
      post('measure', { requestId, descs: info.list.map((id) => descFor({ owner: t.owner, instancePath: [], nodeId: id, ...(itemPath?.length ? { itemPath } : {}) }) ?? { ctx: '', node: '', items: '' }) });
      setTimeout(() => resolve(null), 1500);
    });
    window.removeEventListener('pointerup', early);
    const from = info.index;
    // Siblings hidden at this width take no space on the page: the drag moves among the visible ones.
    const visible = rects ? rects.flatMap((r, i) => (r ? [i] : [])) : [];
    if (released || !rects?.[from] || visible.length < 2) return;
    const boxes = visible.map((i) => rects[i]!);
    let to: number | null = null;
    setDragging(true);
    setReorder({ line: dropAt(boxes, rects[from]!.x + 1, rects[from]!.y + 1).line });
    const move = (ev: PointerEvent) => {
      const box = wrapRef.current?.getBoundingClientRect();
      if (!box) return;
      const z = currentZoom();
      const drop = dropAt(boxes, (ev.clientX - box.left) / z, (ev.clientY - box.top) / z);
      to = drop.to;
      setReorder({ line: drop.line });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      setReorder(null);
      const index = to === null ? null : moveIndex(visible, from, to);
      if (index !== null) void applyOps([{ type: 'node.move', owner: t.owner, nodeId: t.nodeId, parentId: info.parentId, slot: info.slot, index }], 'Move');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Drag-to-resize viewport
  const startResize = (e: React.PointerEvent, side: 'left' | 'right') => {
    e.preventDefault();
    const startX = e.clientX;
    const start = getState().viewport;
    const z = zoom;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const d = ((ev.clientX - startX) / z) * 2 * (side === 'right' ? 1 : -1);
      setState({ viewport: Math.round(Math.max(320, Math.min(1920, start + d))) });
    };
    const up = () => {
      setDragging(false);
      saveLocal({ viewport: getState().viewport });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!snapshot) return <div className="canvas" />;

  const runtimeCard = (() => {
    if (runtime.state === 'ready') return null;
    if (runtime.state === 'unavailable')
      return (
        <div className="canvas-card" role="status">
          <AppMark size={40} />
          <h3>Preview unavailable</h3>
          <p style={{ maxWidth: 360 }}>{runtime.message}</p>
        </div>
      );
    if (runtime.state === 'error')
      return (
        <div className="canvas-card" role="alert">
          <TriangleAlert size={26} color="var(--red)" />
          <h3>{runtime.message}</h3>
          <p>Your work is safe and editing keeps working. The live preview needs the website tools to be set up.</p>
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
        <div className="canvas-card">
          <AppMark size={40} />
          <h3>Preview is paused</h3>
          <p>Your work is saved. Start the preview to see and edit your site on the page.</p>
          <button className="btn btn-primary" onClick={() => void api.project.retryPreview()}>
            <RefreshCcw /> Start preview
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

  const z = zoom;
  const toBox = (r: Rect) => ({ left: r.x * z, top: r.y * z, width: r.width * z, height: r.height * z });
  // Text and other small parts get a few pixels of breathing room, so the outline never touches the glyphs.
  // While editing everywhere, the component's own nodes are its parts; its root stands for the whole design.
  const inDef = !!definitionMode && inDefinition(selection, definitionMode.definitionId);
  const defRoot = inDef && !selection!.instancePath.length && state?.components[definitionMode!.definitionId]?.tree?.rootIds[0] === selection!.nodeId;
  const isPart = !!selection?.instancePath.length || (inDef && !defRoot);
  const pad = isPart ? 3 : 0;
  const selBoxes = mode === 'edit' && !stylesOpen ? rects.selected.map(toBox).map((b) => ({ left: b.left - pad, top: b.top - pad, width: b.width + pad * 2, height: b.height + pad * 2 })) : [];
  const hovBoxes = mode === 'edit' ? rects.hovered.map(toBox) : [];
  // A part of a repeated item selected on the page, and outlined there, already marks its item: the item stays
  // revealed, without a second outline.
  const selShown = rects.selected.some((r) => r.y + r.height > 0 && r.y < frameH);
  const revBoxes = mode === 'edit' && !(selection?.itemPath?.length && selShown) ? rects.revealed.map(toBox) : [];
  const selLabel = selection && state ? chromeLabel(state, selection) : '';
  const hovering = hover && !sameRef(hover, selection) && !reorder && !dragging && !menu.isOpen;
  const firstSel = selBoxes[0];
  const placement = firstSel && selection ? chipPlacement(firstSel, !isPart, frameH * z) : null;

  return (
    <main ref={canvasRef} tabIndex={-1} className={`canvas${selection?.owner.kind === 'shell' && !definitionMode ? ' sel-shared' : ''}`} aria-label="Website preview">
      {runtimeCard && <div className="canvas-state">{runtimeCard}</div>}
      {!runtimeCard && url && !frameReady && !frameError && (
        <div className="canvas-state soft" role="status">
          <div className="canvas-card compact">
            <Spinner />
            <span>Opening {page?.title ?? 'the page'}…</span>
          </div>
        </div>
      )}
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
          <button ref={exitRef} onClick={() => setState({ mode: 'edit' })}>
            <Pencil size={13} /> Back to editing
          </button>
        </div>
      )}
      {/* Mounted before they have anything to say, so both are announced. The problem clears during a restart, so a
          restart that fails is announced again. */}
      <p className="sr-only" role="alert">
        {issueShown && !retrying ? 'This page couldn’t be previewed. Your work is safe.' : ''}
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
            <strong>{retrying ? 'Restarting preview…' : 'This page couldn’t be previewed.'}</strong> Your work is safe.
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
          <div className="frame-wrap" ref={wrapRef} style={{ width: viewport * z, height: frameH * z, marginTop: 14 }}>
            <div className={`frame-width-label${placement === 'strip' && !reorder ? (Math.min(firstSel.left, viewport * z - chipW) + chipW + 12 > viewport * z - 190 ? ' gone' : ' aside') : ''}`}>
              <b>{viewport}</b> px {viewport < 768 ? '· Phone range' : viewport < 1024 ? '· Tablet range' : '· Desktop range'}
            </div>
            <div className="frame-box" style={{ width: viewport, height: frameH, transform: `scale(${z})` }}>
              <iframe
                key={session}
                ref={frameRef}
                name={session}
                title="Website preview"
                src={initialSrc}
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{ pointerEvents: dragging ? 'none' : undefined }}
              />
            </div>
            <div className="overlay-layer">
              <div className="overlay-clip">
                {hovering &&
                  hovBoxes.map((b, i) => (
                    <div key={`h${i}`} className="ov-box ov-hover" style={b}>
                      {i === 0 && !tagHidden && b.height >= 40 && b.top + b.height > 30 && !(placement === 'inside' && firstSel && Math.abs(firstSel.top - b.top) < 34 && Math.abs(firstSel.left - b.left) < chipW + 8) && (
                        // Kept in view when the element's top has scrolled out of the page.
                        <span className="ov-label" style={b.top < 0 ? { top: 3 - b.top } : undefined}>
                          {state && hover ? chromeLabel(state, hover) : ''}
                        </span>
                      )}
                    </div>
                  ))}
                {revBoxes.map((b, i) => (
                  <div key={`r${i}`} className="ov-box ov-revealed" style={b} />
                ))}
                {selBoxes.map((b, i) => (
                  <div key={`s${i}`} className={`ov-box ov-selected${i > 0 && selection?.itemPath?.length ? ' dim' : ''}`} style={b} />
                ))}
                {reorder && <div className="ov-drop" style={toBox(reorder.line)} role="presentation" />}
              </div>
              {firstSel && selection && state && placement && !reorder && (
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
                />
              )}
            </div>
            <div className={`frame-handle left${dragging ? ' dragging' : ''}`} onPointerDown={(e) => startResize(e, 'left')} title="Drag to resize" />
            <div className={`frame-handle right${dragging ? ' dragging' : ''}`} onPointerDown={(e) => startResize(e, 'right')} title="Drag to resize" />
          </div>
        )}
      </div>
      {menu.node}
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
function SelectionChip({ box, frameWidth, placement, name, icon, parent, repeats, repeatsLabel, item, sib, onMore, onGrip, onWidth, onLostFocus }: { box: { left: number; top: number; width: number; height: number }; frameWidth: number; placement: 'inside' | 'above' | 'strip'; name: string; icon: React.ReactNode; parent: string | null; repeats: number; repeatsLabel: string; item: { n: number; count: number } | null; sib: { index: number; count: number } | null; onMore: (el: HTMLElement, focusLast?: boolean) => void; onGrip: (e: React.PointerEvent) => void; onWidth: (w: number) => void; onLostFocus: () => void }) {
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
  useLayoutEffect(() => {
    const width = ref.current?.offsetWidth ?? 0;
    if (width && width !== w) (setW(width), onWidth(width));
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
  return (
    <div
      ref={ref}
      className={`ov-chip ${placement}`}
      style={{ left, top, maxWidth: frameWidth }}
      role="toolbar"
      aria-label={`${name} actions`}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        focusIn.current = true;
        lastFocused.current = e.target as HTMLElement;
        const i = buttons().indexOf(e.target as HTMLElement);
        if (i >= 0) current.current = i;
      }}
      onBlur={(e) => {
        // Focus moving to nothing may mean its control was removed; orphaned() tells that from a plain blur.
        if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) focusIn.current = false;
      }}
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
        {parent && parentRef && (
          <button className="of link" title={`Select ${parent} (Esc)`} onClick={() => setState({ selection: parentRef })}>
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
      {inspectorHidden && (
        <button
          className="chip-text"
          title="Show this in the inspector"
          onClick={() => {
            setState({ dockOpen: true, rightTab: 'inspect' });
            // Focus follows into the inspector, landing on the selection's first control.
            setTimeout(() => document.querySelector<HTMLElement>('#dock-panel-inspect :is(input, textarea, select, button.link, .insp-jump button)')?.focus(), 120);
          }}
        >
          <PanelRight /> Edit
        </button>
      )}
      {(canReorder || canEdit) && <span className="chip-sep" aria-hidden="true" />}
      {canReorder && (
        <>
          <button className="icon-btn" title={`Move up (${keys('⇧⌘↑')})`} aria-label="Move up" aria-keyshortcuts={ariaKeys('Shift+Meta+ArrowUp')} aria-disabled={!canUp || undefined} onClick={guard(canUp, () => void moveLayers(-1))}>
            <ArrowUp />
          </button>
          <button className="icon-btn" title={`Move down (${keys('⇧⌘↓')})`} aria-label="Move down" aria-keyshortcuts={ariaKeys('Shift+Meta+ArrowDown')} aria-disabled={!canDown || undefined} onClick={guard(canDown, () => void moveLayers(1))}>
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
