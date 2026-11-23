import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Component, Copy, GripVertical, MousePointerClick, RefreshCcw, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { findParent } from '@engine/tree';
import { applyOps } from '../store';
import { treeFor } from '../lib/model';
import type { ElementRef } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { api, getState, setState, toast, useStore, type Rect } from '../store';
import { acceptMessage, newSessionId, postToFrame } from '../lib/bridge';
import { boundaryOf, descOf, refLabel, resolveRef, selectionFromChain, type BridgeDesc } from '../lib/model';
import { askAiAbout, canInlineEdit, commitText, deleteSelection, duplicateSelection, moveSelection, structuralTarget } from '../lib/actions';
import { handleShortcut } from '../Editor';
import { Spinner, useMenu } from '../components/ui';

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [session, setSession] = useState(() => newSessionId());
  const [ready, setReady] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
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

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoom = zoomSetting === 'fit' ? Math.min(1, (size.w - 56) / viewport) : zoomSetting;
  const frameH = Math.max(300, (size.h - 48) / zoom);

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
          setFrameError(null);
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
          const d = p.desc as { ctx?: string; node?: string; items?: string } | undefined;
          const text = p.text;
          const validText = typeof text === 'string' ? text.length <= 20000 : Array.isArray(text) && text.length <= 500 && text.every((t) => typeof t === 'string' && t.length <= 20000);
          // Accept only the commit for the edit the editor started, on that exact element.
          if (edit && d && validText && JSON.stringify([d.ctx, d.node, d.items]) === edit.desc && canInlineEdit(edit.ref)) void commitText(edit.ref, text as string | string[]);
          break;
        }
        case 'textCancel':
          pendingEdit.current = null;
          break;
        case 'key': {
          handleShortcut(String(p.key), !!p.meta || !!p.ctrl, !!p.shift);
          break;
        }
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

  function openContextMenu(x: number, y: number, ref: ElementRef | null) {
    if (!ref || !state) return;
    const t = structuralTarget(ref);
    const r = resolveRef(state, boundaryOf(state, ref));
    const isInstance = r.node?.kind === 'instance';
    menu.open(x, y, [
      { heading: refLabel(state, ref) },
      { label: 'Ask AI about this', icon: <Sparkles />, shortcut: '⌘J', onSelect: () => askAiAbout(ref) },
      { separator: true },
      { label: 'Move up', icon: <ArrowUp />, disabled: !t, onSelect: () => void moveSelection(-1) },
      { label: 'Move down', icon: <ArrowDown />, disabled: !t, onSelect: () => void moveSelection(1) },
      { label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', disabled: !t || t.owner.kind === 'shell', onSelect: () => void duplicateSelection() },
      ...(t && !isInstance ? [{ label: 'Create component…', icon: <Component />, onSelect: () => setState({ modal: { kind: 'create-component' as const, ref: t } }) }] : []),
      { separator: true },
      { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, disabled: !t || t.owner.kind === 'shell', onSelect: () => void deleteSelection() }
    ]);
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
        <div className="canvas-card">
          <TriangleAlert size={26} color="var(--red)" />
          <h3>{runtime.message}</h3>
          <p>Your work is safe and editing keeps working. The live preview needs the website tools to be set up.</p>
          {runtime.detail && <pre>{runtime.detail}</pre>}
          <div className="row">
            <button className="btn btn-primary" onClick={() => void api.project.retryPreview()}>
              <RefreshCcw /> Try again
            </button>
            <button className="btn" onClick={() => void api.project.repairDependencies()}>
              Reinstall website tools
            </button>
          </div>
        </div>
      );
    return (
      <div className="canvas-card">
        <Spinner large />
        <h3>{runtime.state === 'preparing' ? 'Setting up website tools' : 'Starting preview'}</h3>
        <p className="ellipsis" style={{ maxWidth: 360 }}>
          {runtime.state === 'preparing' ? runtime.message : 'Opening your site…'}
        </p>
      </div>
    );
  })();

  const z = zoom;
  const toBox = (r: Rect) => ({ left: r.x * z, top: r.y * z, width: r.width * z, height: r.height * z });
  const selBoxes = mode === 'edit' ? rects.selected.map(toBox) : [];
  const hovBoxes = mode === 'edit' ? rects.hovered.map(toBox) : [];
  const isPart = !!selection?.instancePath.length;
  const selLabel = selection && state ? refLabel(state, selection) : '';
  const hovering = hover && !sameRef(hover, selection);
  const firstSel = selBoxes[0];

  return (
    <main className="canvas" aria-label="Website preview">
      {runtimeCard && <div className="canvas-state">{runtimeCard}</div>}
      {mode === 'preview' && (
        <div className="preview-pill">
          Previewing <button onClick={() => setState({ mode: 'edit' })}>Back to editing</button>
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
            <div className="frame-width-label">
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
              {hovering &&
                hovBoxes.map((b, i) => (
                  <div key={`h${i}`} className="ov-box ov-hover" style={b}>
                    {i === 0 && b.top > 22 && <span className="ov-label hover" style={{ left: -1, top: 0 }}>{state && hover ? refLabel(state, hover) : ''}</span>}
                  </div>
                ))}
              {selBoxes.map((b, i) => (
                <div key={`s${i}`} className={`ov-box ov-selected${isPart ? ' part' : ''}${i > 0 ? ' dim' : ''}`} style={b} />
              ))}
              {firstSel && selection && (
                <>
                  <span className={`ov-label${isPart ? ' part' : ''}`} style={{ left: firstSel.left, top: Math.max(firstSel.top, 22) }}>
                    {isPart ? <MousePointerClick /> : <Component />}
                    {selLabel}
                  </span>
                  {!reorder && <SelectionActions box={firstSel} frameWidth={viewport * z} onMore={(x, y) => openContextMenu(x, y, selection)} onGrip={startReorder} />}
                </>
              )}
              {reorder && <ReorderIndicator rects={reorder.rects.map(toBox)} to={reorder.to} />}
            </div>
            <div className={`frame-handle left${dragging ? ' dragging' : ''}`} onPointerDown={(e) => startResize(e, 'left')} title="Drag to resize" />
            <div className={`frame-handle right${dragging ? ' dragging' : ''}`} onPointerDown={(e) => startResize(e, 'right')} title="Drag to resize" />
          </div>
        )}
      </div>
      {frameError && mode === 'edit' && (
        <div className="ai-veil" style={{ bottom: runStatus ? 64 : 18, borderColor: 'var(--red)' }} role="alert">
          <TriangleAlert size={15} color="var(--red)" />
          <span className="ellipsis" style={{ maxWidth: 480 }}>
            {frameError}
          </span>
          <button className="btn btn-sm" onClick={() => setSession(newSessionId())}>
            Reload preview
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

function SelectionActions({ box, frameWidth, onMore, onGrip }: { box: { left: number; top: number; width: number; height: number }; frameWidth: number; onMore: (x: number, y: number) => void; onGrip: (e: React.PointerEvent) => void }) {
  const selection = useStore((s) => s.selection);
  const t = structuralTarget(selection);
  const width = 180;
  const left = Math.min(Math.max(0, box.left + box.width - width), frameWidth - width);
  const top = box.top + box.height;
  return (
    <div className="ov-actions" style={{ left, top }}>
      {t && (
        <button className="icon-btn grip" title="Drag to reorder" aria-label="Drag to reorder" onPointerDown={onGrip} style={{ cursor: 'grab' }}>
          <GripVertical />
        </button>
      )}
      <button className="icon-btn ai" title="Ask AI about this (⌘J)" aria-label="Ask AI about this" onClick={() => askAiAbout(selection)}>
        <Sparkles />
      </button>
      <button className="icon-btn" title="Move up" aria-label="Move up" disabled={!t} onClick={() => void moveSelection(-1)}>
        <ArrowUp />
      </button>
      <button className="icon-btn" title="Move down" aria-label="Move down" disabled={!t} onClick={() => void moveSelection(1)}>
        <ArrowDown />
      </button>
      <button className="icon-btn" title="Duplicate (⌘D)" aria-label="Duplicate" disabled={!t || t.owner.kind === 'shell'} onClick={() => void duplicateSelection()}>
        <Copy />
      </button>
      <button className="icon-btn" title="Delete" aria-label="Delete" disabled={!t || t.owner.kind === 'shell'} onClick={(e) => (e.shiftKey ? onMore(e.clientX, e.clientY) : void deleteSelection())}>
        <Trash2 />
      </button>
    </div>
  );
}
