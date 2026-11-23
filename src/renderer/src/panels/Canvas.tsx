import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Component, Copy, Ellipsis, Eye, GripVertical, MousePointerClick, Pencil, RefreshCcw, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { findParent } from '@engine/tree';
import { applyOps } from '../store';
import { treeFor } from '../lib/model';
import type { ElementRef } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { api, getState, markDraft, setState, toast, useStore, type Rect } from '../store';
import { acceptMessage, newSessionId, postToFrame } from '../lib/bridge';
import { boundaryOf, descOf, refLabel, resolveRef, selectionFromChain, type BridgeDesc } from '../lib/model';
import { askAiAbout, canInlineEdit, commitText, deleteSelection, duplicateSelection, moveSelection, structuralTarget } from '../lib/actions';
import { handleShortcut } from '../Editor';
import { Spinner, useMenu } from '../components/ui';
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
  const measureWaiters = useRef(new Map<string, (rects: Array<Rect | null>) => void>());
  const wrapRef = useRef<HTMLDivElement>(null);
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
  const frameH = Math.max(300, (size.h - 62) / zoom);

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
          syncPage(String(p.path));
          break;
        case 'navigated':
          pendingEdit.current = null;
          syncPage(String(p.path));
          break;
        case 'rects':
          setState({ rects: { selected: (p.selected as Rect[]) ?? [], hovered: (p.hovered as Rect[]) ?? [] } });
          break;
        case 'select': {
          if (!st) return;
          const chain = p.chain as BridgeDesc[];
          const next = chain.length ? selectionFromChain(st, chain, s.selection, !!p.alt || !!p.meta || !!s.definitionMode) : null;
          setState({ selection: next });
          if (next && s.rightTab === 'styles') setState({ rightTab: 'inspect' });
          break;
        }
        case 'dblclick': {
          if (!st) return;
          const chain = p.chain as BridgeDesc[];
          const ref = selectionFromChain(st, chain, s.selection, true);
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
          const ref = selectionFromChain(st, p.chain as BridgeDesc[], s.selection, false);
          if (ref) setState({ selection: ref });
          const fr = frameRef.current!.getBoundingClientRect();
          const z = currentZoom();
          openContextMenu(fr.left + Number(p.x) * z, fr.top + Number(p.y) * z, ref);
          break;
        }
        case 'externalLink':
          if (window.confirm(`Open ${p.href} in your browser?`)) void api.app.openExternal(String(p.href));
          break;
        case 'runtimeError':
          setFrameError(String(p.message).slice(0, 400));
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

  function syncTrack() {
    const s = getState();
    const st = s.snapshot?.state;
    if (!st) return;
    post('track', { selected: s.selection ? descOf(st, s.selection) : null, hovered: s.hover ? descOf(st, s.hover) : undefined });
  }

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
    post('navigate', { path: page.route });
  }, [pageId, page?.route, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  function openContextMenu(x: number, y: number, ref: ElementRef | null, trigger?: HTMLElement) {
    if (!ref || !state) return;
    const t = structuralTarget(ref);
    const r = resolveRef(state, boundaryOf(state, ref));
    const isInstance = r.node?.kind === 'instance';
    const parent = ref.instancePath.length ? { owner: ref.owner, instancePath: ref.instancePath.slice(0, -1), nodeId: ref.instancePath[ref.instancePath.length - 1] } : null;
    const locked = !t || t.owner.kind === 'shell';
    const items = [
        { heading: refLabel(state, ref) },
        ...(parent ? [{ label: `Select ${refLabel(state, parent)}`, icon: <Component />, shortcut: 'Esc', onSelect: () => setState({ selection: parent }) }] : []),
        { label: 'Ask AI about this', icon: <Sparkles />, shortcut: '⌘J', onSelect: () => askAiAbout(ref) },
        ...(t
          ? [
              { separator: true },
              { label: 'Move up', icon: <ArrowUp />, shortcut: '⇧⌘↑', onSelect: () => void moveSelection(-1) },
              { label: 'Move down', icon: <ArrowDown />, shortcut: '⇧⌘↓', onSelect: () => void moveSelection(1) },
              ...(locked ? [] : [{ label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: () => void duplicateSelection() }]),
              ...(!isInstance ? [{ label: 'Create component…', icon: <Component />, onSelect: () => setState({ modal: { kind: 'create-component' as const, ref: t } }) }] : []),
              ...(locked ? [] : [{ separator: true }, { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: () => void deleteSelection() }])
            ]
          : [])
      ];
    if (trigger) menu.openAt(trigger, items, refLabel(state, ref));
    else menu.open(x, y, items, refLabel(state, ref));
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
    const requestId = Math.random().toString(36).slice(2);
    const rects = await new Promise<Array<Rect | null>>((resolve) => {
      measureWaiters.current.set(requestId, resolve);
      post('measure', { requestId, descs: info.list.map((id) => descOf(st, { owner: t.owner, instancePath: [], nodeId: id })) });
      setTimeout(() => resolve([]), 1500);
    });
    if (rects.length !== info.list.length || rects.some((r) => !r)) return;
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
  const selLabel = selection && state ? refLabel(state, selection) : '';
  const hovering = hover && !sameRef(hover, selection);
  const firstSel = selBoxes[0];

  return (
    <main className={`canvas${selection?.owner.kind === 'shell' && !definitionMode ? ' sel-shared' : ''}`} aria-label="Website preview">
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
        <div className="ai-veil" role="status">
          <Sparkles size={15} className="spark" /> The AI is editing this site. You can look around while it works.
          <button className="btn btn-sm" onClick={() => void api.ai.stop()}>
            Stop
          </button>
        </div>
      )}
      <div className="canvas-scroll" ref={scrollRef} onMouseDown={(e) => e.target === e.currentTarget && setState({ selection: null })}>
        {url && initialSrc && (
          <div className="frame-wrap" ref={wrapRef} style={{ width: viewport * z, height: frameH * z, marginTop: 14 }}>
            <div className="frame-width-label" style={{ visibility: firstSel && isPart && !definitionMode ? 'hidden' : undefined }}>
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
                      {i === 0 && b.top > 22 && !selBoxes.some((sb) => Math.abs(sb.top - b.top) < 30 && Math.abs(sb.left - b.left) < 160) && (
                        <span className="ov-label" style={{ left: -1, top: 0 }}>
                          {state && hover ? refLabel(state, hover) : ''}
                        </span>
                      )}
                    </div>
                  ))}
                {selBoxes.map((b, i) => (
                  <div key={`s${i}`} className={`ov-box ov-selected${i > 0 ? ' dim' : ''}`} style={b} />
                ))}
                {reorder && <ReorderIndicator rects={reorder.rects.map(toBox)} to={reorder.to} />}
              </div>
              {firstSel && selection && !reorder && (
                <SelectionChip
                  box={firstSel}
                  frameWidth={viewport * z}
                  frameHeight={frameH * z}
                  name={definitionMode && selection.instancePath.length === 1 && state?.components[definitionMode.definitionId]?.tree?.rootIds[0] === selection.nodeId ? state.components[definitionMode.definitionId].name : selLabel}
                  parent={isPart && state && !definitionMode ? refLabel(state, { owner: selection.owner, instancePath: selection.instancePath.slice(0, -1), nodeId: selection.instancePath[selection.instancePath.length - 1] }) : null}
                  everywhere={!!definitionMode}
                  topLevel={!selection.instancePath.length}
                  repeats={selBoxes.length}
                  repeatsLabel={selLabel ? `${selLabel.toLowerCase()}${/s$/.test(selLabel) ? '' : 's'}` : 'items'}
                  onMore={(x, y, el) => openContextMenu(x, y, selection, el)}
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
        <div className="ai-veil issue" style={{ bottom: runStatus || mode === 'preview' ? 64 : 18 }} role="alert">
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

/**
 * The selection chip: the selection's name and its actions in one bar, placed outside the selection so it
 * never covers neighbouring content: above it when there is room, else inside its top edge for a tall
 * selection, else below it. It is kept inside the page frame horizontally and vertically.
 */
function SelectionChip({ box, frameWidth, frameHeight, name, parent, repeats, repeatsLabel, everywhere, topLevel, onMore, onGrip }: { box: { left: number; top: number; width: number; height: number }; frameWidth: number; frameHeight: number; name: string; parent: string | null; repeats: number; repeatsLabel: string; everywhere: boolean; topLevel: boolean; onMore: (x: number, y: number, el?: HTMLElement) => void; onGrip: (e: React.PointerEvent) => void }) {
  const selection = useStore((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(200);
  useLayoutEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  });
  const t = structuralTarget(selection);
  const H = 26;
  const GAP = 4;
  // A section is tall and starts with its own padding, so its chip sits inside its top edge, where it
  // covers nothing; outside-above would cover the header or the section before it. Smaller elements
  // get the chip above them, or below when there is no room above.
  // Parts (text, images and buttons inside a section) sit among other content, so their chip parks in the
  // strip above the page frame, lined up with the part; the outline marks the part itself.
  const parked = !topLevel && !everywhere;
  const inside = !parked && box.height > 120;
  const top = parked ? -H - 8 : inside ? box.top + GAP + 2 : box.top >= H + GAP + 2 ? box.top - H - GAP : Math.min(box.top + box.height + GAP, frameHeight - H - GAP);
  const left = Math.max(0, Math.min(inside ? box.left + GAP + 2 : box.left, frameWidth - w));
  const parentRef = selection?.instancePath.length ? { owner: selection.owner, instancePath: selection.instancePath.slice(0, -1), nodeId: selection.instancePath[selection.instancePath.length - 1] } : null;
  const canEdit = !!t && t.owner.kind !== 'shell';
  return (
    <div ref={ref} className="ov-chip" style={{ left, top }} role="toolbar" aria-label={`${name} actions`}>
      {t && !selection?.instancePath.length && (
        <button className="icon-btn grip" title="Drag to move" aria-label="Drag to move" onPointerDown={onGrip} style={{ cursor: 'grab' }}>
          <GripVertical />
        </button>
      )}
      <span className="name">
        {parent ? <MousePointerClick /> : <Component />}
        {name}
        {parent && parentRef && (
          <button className="of link" title={`Select ${parent} (Esc)`} onClick={() => setState({ selection: parentRef })}>
            in {parent}
          </button>
        )}
        {repeats > 1 && <span className="of">· all {repeats} {repeatsLabel}</span>}
      </span>
      <button className="icon-btn" title="Ask AI about this (⌘J)" aria-label="Ask AI about this" onClick={() => askAiAbout(selection)}>
        <Sparkles />
      </button>
      {t && !selection?.instancePath.length && (
        <>
          <button className="icon-btn" title="Move up (⇧⌘↑)" aria-label="Move up" onClick={() => void moveSelection(-1)}>
            <ArrowUp />
          </button>
          <button className="icon-btn" title="Move down (⇧⌘↓)" aria-label="Move down" onClick={() => void moveSelection(1)}>
            <ArrowDown />
          </button>
          {canEdit && (
            <button className="icon-btn" title="Duplicate (⌘D)" aria-label="Duplicate" onClick={() => void duplicateSelection()}>
              <Copy />
            </button>
          )}
          {canEdit && (
            <button className="icon-btn" title="Delete (⌫)" aria-label="Delete" onClick={() => void deleteSelection()}>
              <Trash2 />
            </button>
          )}
        </>
      )}
      <button
        className="icon-btn"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMore(r.left, r.bottom + 4, e.currentTarget);
        }}
      >
        <Ellipsis />
      </button>
    </div>
  );
}
