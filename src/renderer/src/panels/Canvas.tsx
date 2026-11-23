import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Box, Component, Copy, Ellipsis, Eye, GripVertical, Image, Link2, PanelRight, Pencil, RefreshCcw, Rows3, Sparkles, Trash2, TriangleAlert, Type, Users } from 'lucide-react';
import { findParent } from '@engine/tree';
import { applyOps } from '../store';
import { treeFor } from '../lib/model';
import type { ElementRef, ProjectState } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { api, confirmDialog, getState, markDraft, setState, toast, useStore, type Rect } from '../store';
import { acceptMessage, newSessionId, postToFrame } from '../lib/bridge';
import { boundaryOf, descOf, refLabel, resolveRef, selectionFromChain, type BridgeDesc } from '../lib/model';
import { askAiAbout, canInlineEdit, commitText, deleteSelection, duplicateSelection, moveSelection, structuralTarget } from '../lib/actions';
import { handleShortcut } from '../Editor';
import { notePointerInput, openMenus, Spinner, useMenu } from '../components/ui';
import { AppMark } from '../components/AppMark';

/** True while an inline text edit is open in the preview; shortcuts must not act on the selection then. */
export const inlineEdit = { active: false };

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
  const runStatus = useStore((s) => s.runStatus);
  const devMode = useStore((s) => !!s.settings?.developerMode);
  const definitionMode = useStore((s) => s.definitionMode);
  // While Site styles is open, edits are site-wide; the element selection steps back.
  const stylesOpen = useStore((s) => s.rightTab === 'styles' && s.dockOpen);
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [session, setSession] = useState(() => newSessionId());
  const [ready, setReady] = useState(false);
  // The page's own error is shared through the store, so the status bar and Project health tell the same story.
  const frameError = useStore((s) => s.previewIssue);
  const setFrameError = (m: string | null) => setState({ previewIssue: m });
  // After Try again, the problem stays reported as "Restarting preview" until the new page says it is ready.
  const [retrying, setRetrying] = useState(false);
  const frameReady = useStore((s) => s.frameReady);
  const [dragging, setDragging] = useState(false);
  const menu = useMenu();
  /** The inline edit the editor started; the preview cannot commit text on its own. */
  const pendingEdit = useRef<{ ref: ElementRef; desc: string } | null>(null);
  /** The route the editor last asked the page to show; its acknowledgement is the one that counts. */
  const pendingNav = useRef<string | null>(null);
  const measureWaiters = useRef(new Map<string, (rects: Array<Rect | null>) => void>());
  /** The element chain under the pointer in the page, so hover can be re-resolved when the selection changes. */
  const hoverChain = useRef<BridgeDesc[] | null>(null);
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
  const [reorder, setReorder] = useState<{ rects: Rect[]; from: number; to: number } | null>(null);
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
  // The frame's whole footprint (20px top padding + 14px label margin + 28px bottom padding) fits at Fit, so the pasteboard never needs its own scrollbar.
  const frameH = Math.max(300, (size.h - 70) / zoom);

  const post = (type: string, payload: unknown = {}) => postToFrame(frameRef.current, origin, session, type, payload);

  // Reset the frame whenever the preview server changes.
  useEffect(() => {
    setReady(false);
    setSession(newSessionId());
  }, [url]);

  // Bridge messages
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = acceptMessage(e, frameRef.current, origin, session);
      if (!m) return;
      const s = getState();
      const st = s.snapshot?.state;
      const p = m.payload as Record<string, unknown>;
      switch (m.type) {
        case 'ready':
          setReady(true);
          setState({ frameReady: true });
          setFrameError(null);
          setRetrying(false);
          post('mode', { mode: getState().mode });
          syncTrack();
          // A page chosen while the preview was starting wins: the navigate effect opens it next.
          if (!getState().pageId) syncPage(String(p.path));
          break;
        case 'navigated': {
          // While editing, only the reply for the page the editor last asked for counts: a late reply for an
          // earlier request must not undo the page the user has since chosen. In Preview, a visitor's own
          // link clicks move the editor along with them.
          const path = String(p.path);
          const same = (a: string, b: string | null) => !!b && (a === b || a === b + '/' || a + '/' === b);
          if (getState().mode !== 'preview' && pendingNav.current && !same(path, pendingNav.current)) break;
          pendingNav.current = path;
          pendingEdit.current = null;
          setState({ frameReady: true });
          syncPage(path);
          break;
        }
        case 'hover':
          hoverChain.current = (p.chain as BridgeDesc[]) ?? null;
          resolveHover();
          break;
        case 'rects':
          setState({ rects: { selected: (p.selected as Rect[]) ?? [], hovered: (p.hovered as Rect[]) ?? [] } });
          break;
        case 'select': {
          if (!st) return;
          pagePick();
          const chain = p.chain as BridgeDesc[];
          const next = withinDefinition(chain.length ? selectionFromChain(st, chain, s.selection, !!p.alt || !!p.meta || !!s.definitionMode) : null);
          setState({ selection: next });
          if (next && s.rightTab === 'styles') setState({ rightTab: 'inspect' });
          break;
        }
        case 'dblclick': {
          if (!st) return;
          const chain = p.chain as BridgeDesc[];
          const ref = withinDefinition(selectionFromChain(st, chain, s.selection, true));
          if (ref && canInlineEdit(ref)) {
            setState({ selection: ref });
            const desc = descOf(st, ref);
            pendingEdit.current = { ref, desc: JSON.stringify([desc.ctx, desc.node, desc.items]) };
            inlineEdit.active = true;
            markDraft('canvas-text', true);
            post('beginTextEdit', { desc });
          } else if (ref) {
            setState({ selection: ref, rightTab: 'inspect' });
            const r = resolveRef(st, ref);
            if (r.node?.kind === 'text') toast('This text is part of the component design. Use Edit definition or Make unique to change it.');
          }
          break;
        }
        case 'textCommit': {
          const edit = pendingEdit.current;
          pendingEdit.current = null;
          inlineEdit.active = false;
          markDraft('canvas-text', false);
          const d = p.desc as { ctx?: string; node?: string; items?: string } | undefined;
          const text = p.text;
          const validText = typeof text === 'string' ? text.length <= 20000 : Array.isArray(text) && text.length <= 500 && text.every((t) => typeof t === 'string' && t.length <= 20000);
          // Accept only the commit for the edit the editor started, on that exact element.
          if (edit && d && validText && JSON.stringify([d.ctx, d.node, d.items]) === edit.desc && canInlineEdit(edit.ref)) void commitText(edit.ref, text as string | string[]);
          break;
        }
        case 'textCancel':
          pendingEdit.current = null;
          inlineEdit.active = false;
          markDraft('canvas-text', false);
          break;
        case 'key':
          // Ignored: shortcuts are taken from trusted keyboard input (see App), never from the page.
          break;
        case 'contextmenu': {
          if (!st) return;
          pagePick();
          const ref = withinDefinition(selectionFromChain(st, p.chain as BridgeDesc[], s.selection, false));
          if (!ref && s.definitionMode) {
            setState({ selection: null });
            break;
          }
          if (ref) setState({ selection: ref, ...(s.rightTab === 'styles' ? { rightTab: 'inspect' as const } : {}) });
          const fr = frameRef.current!.getBoundingClientRect();
          const z = currentZoom();
          openContextMenu(fr.left + Number(p.x) * z, fr.top + Number(p.y) * z, ref);
          break;
        }
        case 'externalLink':
          void confirmDialog({ title: 'Open this link in your browser?', body: String(p.href), confirmLabel: 'Open in browser' }).then((ok) => ok === true && void api.app.openExternal(String(p.href)));
          break;
        case 'runtimeError':
          setFrameError(String(p.message).slice(0, 400));
          setRetrying(false);
          setRetrying(false);
          break;
        case 'revisionApplied':
          setFrameError(null);
          break;
        case 'measured': {
          const w = measureWaiters.current.get(String(p.requestId));
          if (w) {
            measureWaiters.current.delete(String(p.requestId));
            w(p.rects as Array<Rect | null>);
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
    const next = st && chain?.length && s.mode === 'edit' && !inlineEdit.active && !openMenus.count ? withinDefinition(selectionFromChain(st, chain, s.selection, false)) : null;
    if (!sameRef(next, s.hover)) setState({ hover: next });
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
    post('track', { selected: s.selection ? descOf(st, s.selection) : null, hovered: s.hover ? descOf(st, s.hover) : null });
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
    if (ready && selection && state) post('scrollTo', { desc: descOf(state, selection) });
  }, [ready, selection && refKey(selection)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ready) post('mode', { mode });
  }, [mode, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Navigate when the current page changes.
  useEffect(() => {
    if (!ready || !page) return;
    // Until the page confirms the navigation, it is "opening", not ready.
    setState({ frameReady: false });
    pendingNav.current = page.route;
    post('navigate', { path: page.route });
  }, [pageId, page?.route, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  /** While editing a component everywhere, a pick outside it selects nothing (the overview), so the
   *  canvas, chip and inspector never describe a different section under the "everywhere" band. */
  function withinDefinition(ref: ElementRef | null): ElementRef | null {
    const dm = getState().definitionMode;
    const st = getState().snapshot?.state;
    if (!dm || !ref || !st) return ref;
    if (ref.owner.kind === 'component' && ref.owner.id === dm.definitionId) return ref;
    const inst = ref.instancePath.length ? resolveRef(st, { owner: ref.owner, instancePath: [], nodeId: ref.instancePath[0] }).node : resolveRef(st, ref).node;
    return inst?.kind === 'instance' && inst.definitionId === dm.definitionId ? (ref.instancePath.length ? ref : { ...ref, instancePath: [ref.nodeId], nodeId: st.components[dm.definitionId]?.tree?.rootIds[0] ?? ref.nodeId }) : null;
  }

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
      if (!sameRef(getState().selection, ref)) setState({ selection: ref });
      void fn();
    };
    const items = [
        { heading: name },
        ...(parent ? [{ label: `Select ${chromeLabel(state, parent)}`, icon: <Component />, onSelect: () => setState({ selection: withinDefinition(parent) }) }] : []),
        { label: 'Ask AI about this', icon: <Sparkles />, shortcut: '⌘J', onSelect: () => askAiAbout(ref) },
        ...(t
          ? [
              ...(reorderable || !locked || !isInstance ? [{ separator: true }] : []),
              ...(reorderable
                ? [
                    { label: 'Move up', icon: <ArrowUp />, shortcut: '⇧⌘↑', disabled: sib!.index === 0, onSelect: on(() => moveSelection(-1)) },
                    { label: 'Move down', icon: <ArrowDown />, shortcut: '⇧⌘↓', disabled: sib!.index >= sib!.count - 1, onSelect: on(() => moveSelection(1)) }
                  ]
                : []),
              ...(locked ? [] : [{ label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: on(duplicateSelection) }]),
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
    const rects = await new Promise<Array<Rect | null>>((resolve) => {
      measureWaiters.current.set(requestId, resolve);
      post('measure', { requestId, descs: info.list.map((id) => descOf(st, { owner: t.owner, instancePath: [], nodeId: id })) });
      setTimeout(() => resolve([]), 1500);
    });
    window.removeEventListener('pointerup', early);
    if (released || rects.length !== info.list.length || rects.some((r) => !r)) return;
    const list = rects as Rect[];
    const horizontal = list.length > 1 && Math.abs(list[1].y - list[0].y) < 4;
    const from = info.index;
    setDragging(true);
    setReorder({ rects: list, from, to: from });
    let to = from;
    const move = (ev: PointerEvent) => {
      const box = wrapRef.current?.getBoundingClientRect();
      if (!box) return;
      const z = currentZoom();
      const pos = horizontal ? (ev.clientX - box.left) / z : (ev.clientY - box.top) / z;
      to = list.filter((r) => (horizontal ? r.x + r.width / 2 : r.y + r.height / 2) < pos).length;
      setReorder({ rects: list, from, to });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      setReorder(null);
      const index = to > from ? to - 1 : to;
      if (index !== from) void applyOps([{ type: 'node.move', owner: t.owner, nodeId: t.nodeId, parentId: info.parentId, slot: info.slot, index }], 'Move');
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
      void api.project.saveLocalState({ viewport: getState().viewport });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!snapshot) return <div className="canvas" />;

  const runtimeCard = (() => {
    if (runtime.state === 'ready') return null;
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
  const pad = selection?.instancePath.length ? 3 : 0;
  const selBoxes = mode === 'edit' && !stylesOpen ? rects.selected.map(toBox).map((b) => ({ left: b.left - pad, top: b.top - pad, width: b.width + pad * 2, height: b.height + pad * 2 })) : [];
  const hovBoxes = mode === 'edit' ? rects.hovered.map(toBox) : [];
  const isPart = !!selection?.instancePath.length;
  const selLabel = selection && state ? chromeLabel(state, selection) : '';
  const hovering = hover && !sameRef(hover, selection) && !reorder && !dragging && !menu.isOpen;
  const firstSel = selBoxes[0];
  const defRoot = !!definitionMode && !!selection && selection.instancePath.length === 1 && state?.components[definitionMode.definitionId]?.tree?.rootIds[0] === selection.nodeId;
  const placement = firstSel && selection ? chipPlacement(firstSel, !selection.instancePath.length || defRoot) : null;

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
        <div className="preview-pill" role="status">
          <Eye /> Previewing: links and menus work as they will for visitors
          <button onClick={() => setState({ mode: 'edit' })}>
            <Pencil size={13} /> Back to editing
          </button>
        </div>
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
            'The AI is editing this site. You can look around while it works.'
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
                {selBoxes.map((b, i) => (
                  <div key={`s${i}`} className={`ov-box ov-selected${i > 0 && selection?.itemPath?.length ? ' dim' : ''}`} style={b} />
                ))}
                {reorder && <ReorderIndicator rects={reorder.rects.map(toBox)} to={reorder.to} />}
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
      {frameError && runtime.state === 'ready' && (
        // Bottom bars stack: preview pill, then the AI run, then a page problem, each one step up.
        <div className="ai-veil issue" style={{ bottom: 18 + (mode === 'preview' ? 46 : 0) + (runStatus ? 46 : 0) }} role="alert">
          <TriangleAlert size={15} />
          <span>
            <strong>This page couldn’t be previewed.</strong> Your work is safe.
          </span>
          <button className="btn btn-sm" disabled={retrying} onClick={() => (setRetrying(true), setSession(newSessionId()))}>
            {retrying ? <Spinner decorative /> : null}
            {retrying ? 'Restarting preview…' : 'Try again'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setState({ modal: { kind: 'health' } })}>
            Details
          </button>
        </div>
      )}
      {menu.node}
    </main>
  );
}

function ReorderIndicator({ rects, to }: { rects: Array<{ left: number; top: number; width: number; height: number }>; to: number }) {
  const horizontal = rects.length > 1 && Math.abs(rects[1].top - rects[0].top) < 4;
  const ref = rects[Math.min(to, rects.length - 1)];
  const style = horizontal
    ? { left: to >= rects.length ? ref.left + ref.width : ref.left - 2, top: ref.top, width: 3, height: ref.height }
    : { left: ref.left, top: to >= rects.length ? ref.top + ref.height - 1 : ref.top - 1, width: ref.width, height: 3 };
  return <div className="ov-drop" style={style} role="presentation" />;
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
 * which sit among other content, and anything at or scrolled past the top of the page) parks it in the strip
 * above the page frame, lined up with the selection, so it never covers the page.
 */
function chipPlacement(box: { top: number; height: number }, topLevel: boolean): 'inside' | 'above' | 'strip' {
  if (!topLevel) return 'strip';
  if (box.top >= 0 && box.height > 120) return 'inside';
  if (box.top >= CHIP_H + CHIP_GAP + 2) return 'above';
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
  const canReorder = structural && !!sib && sib.count > 1;
  const canUp = !!sib && sib.index > 0;
  const canDown = !!sib && sib.index < sib.count - 1;
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
      {canReorder && (
        // Pointer-only, so it is hidden from assistive tech: Move up and Move down are its equivalent.
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
      <button className="icon-btn" title="Ask AI about this (⌘J)" aria-label="Ask AI about this" aria-keyshortcuts="Meta+J" onClick={() => askAiAbout(selection)}>
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
          <button className="icon-btn" title="Move up (⇧⌘↑)" aria-label="Move up" aria-keyshortcuts="Shift+Meta+ArrowUp" aria-disabled={!canUp || undefined} onClick={guard(canUp, () => void moveSelection(-1))}>
            <ArrowUp />
          </button>
          <button className="icon-btn" title="Move down (⇧⌘↓)" aria-label="Move down" aria-keyshortcuts="Shift+Meta+ArrowDown" aria-disabled={!canDown || undefined} onClick={guard(canDown, () => void moveSelection(1))}>
            <ArrowDown />
          </button>
        </>
      )}
      {canEdit && (
        <button className="icon-btn" title="Duplicate (⌘D)" aria-label="Duplicate" aria-keyshortcuts="Meta+D" onClick={() => void duplicateSelection()}>
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
