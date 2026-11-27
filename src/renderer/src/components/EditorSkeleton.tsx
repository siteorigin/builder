import './EditorSkeleton.css';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, useStore } from '../store';
import { Spinner, useWindowWidth } from './ui';
import { fitPanels, toolbarTier } from '../lib/layout';

/** An opening shorter than this shows only the outline: the one loading sign appears once the wait is noticeable
 *  (Fluent's one second: under it, no wait animation at all). */
const CHIP_AFTER_MS = 1000;
/** How long the sign takes to fade in (EditorSkeleton.css sk-chip-in). */
const CHIP_FADE_MS = 150;

/**
 * Whether the opening has run long enough to show its loading sign, and whether it is only now appearing (so it fades
 * in once, and the canvas's copy of a sign already showing on the outline before it does not fade in again).
 */
function useLoadingSign(): { shown: boolean; into: number | null } {
  const since = useStore((s) => s.openingSince);
  const [ticks, tick] = useState(0);
  const elapsed = since === null ? Infinity : performance.now() - since;
  const left = CHIP_AFTER_MS - elapsed;
  // A timer can wake a fraction of a millisecond early: it then sets another for what is left.
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.ceil(left) + 1);
    return () => clearTimeout(t);
  }, [since, ticks]); // eslint-disable-line react-hooks/exhaustive-deps
  // How far into its fade-in the sign is, so the canvas's copy of it carries on where the outline's left off.
  return { shown: left <= 0, into: left <= 0 && -left < CHIP_FADE_MS ? -left : null };
}

/**
 * The page the canvas is about to show, as an outline, with the one sign that the project is on its way. Drawn where the
 * page will be (the frame's size, under the strip above it), on the canvas's own dotted ground, so the page takes its
 * place without anything moving; on the editor's canvas it is given the frame's own size, and lifts off the page by a
 * short fade once the page has arrived (`leaving`). Decorative: the opening is announced once, by App.
 */
export function CanvasSkeleton({ label, leaving = false }: { label: string; leaving?: boolean }) {
  const sign = useLoadingSign();
  // A sign showing as the page arrives fades with the outline; one not showing yet never appears during the fade.
  const signedBefore = useRef(false);
  if (!leaving) signedBefore.current = sign.shown;
  // The frame's width as the canvas will draw it (Canvas.tsx zoom): at Fit the page's own width, narrowed to the
  // pasteboard; at a set zoom, scaled. Its height is the pasteboard's, under the strip (EditorSkeleton.css).
  const viewport = useStore((s) => s.viewport);
  const zoom = useStore((s) => s.zoom);
  const width: CSSProperties = { ['--sk-page-w' as string]: zoom === 'fit' ? `min(${viewport}px, 100% - 56px)` : `${viewport * zoom}px` };
  return (
    <div className={`canvas-skeleton${leaving ? ' leaving' : ''}`} aria-hidden="true" data-testid="canvas-skeleton">
      <div className="sk-page" style={width}>
        <div className="sk-page-nav">
          <span className="sk-bar sk-logo" />
          <span className="sk-page-links">
            <span className="sk-bar" />
            <span className="sk-bar" />
            <span className="sk-bar" />
            <span className="sk-bar sk-cta" />
          </span>
        </div>
        <span className="sk-section" />
        <span className="sk-bar sk-line" />
        <span className="sk-bar sk-line short" />
      </div>
      {/* Leaving, it fades with the outline. */}
      {sign.shown && (!leaving || signedBefore.current) && (
        <div className={`sk-loading${sign.into !== null ? ' fresh' : ''}`} style={sign.into !== null ? { animationDelay: `-${Math.round(sign.into)}ms` } : undefined}>
          <Spinner decorative />
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}

/** A panel's rows, of varying length, as a list of pages or a panel of fields reads. */
function Rows({ widths }: { widths: number[] }) {
  return (
    <div className="sk-rows">
      {widths.map((w, i) => (
        <span key={i} className="sk-bar" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

/**
 * The editor's outline while a project opens: its toolbar, the panel rail, the sidebar, the canvas and the right panel
 * at the widths the editor will draw them (lib/layout fitPanels, toolbarTier), so the editor replaces it in place. Shown
 * from the click on a recent project until the editor itself can show (App). Nothing in it takes focus or is read out.
 */
export function EditorSkeleton({ name }: { name: string | null }) {
  const windowWidth = useWindowWidth();
  // Before the snapshot the panels are at the store's starting values; once it is here, at the project's own widths,
  // with its own panels open.
  const leftTab = useStore((s) => s.leftTab);
  const dockOpen = useStore((s) => s.dockOpen);
  const leftWidth = useStore((s) => s.leftWidth);
  const rightWidth = useStore((s) => s.rightWidth);
  const shown = fitPanels(windowWidth, { left: leftTab ? leftWidth : null, right: dockOpen ? rightWidth : null });
  const mac = api.platform === 'darwin';
  return (
    <div className="editor-skeleton" aria-hidden="true" inert data-testid="editor-skeleton">
      <div className={`sk-toolbar${mac ? ' mac' : ''}`} data-tier={toolbarTier(windowWidth, mac)}>
        <div className="sk-toolbar-start">
          <span className="sk-bar sk-switcher" />
          <span className="sk-bar sk-title" />
        </div>
        <div className="sk-toolbar-mid">
          <span className="sk-bar sk-segment" />
          <span className="sk-bar sk-field" />
        </div>
        <div className="sk-toolbar-end">
          <span className="sk-bar sk-icon" />
          <span className="sk-bar sk-icon" />
          <span className="sk-bar sk-action" />
        </div>
      </div>
      <div className="sk-workspace">
        <div className="sk-rail">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="sk-bar sk-rail-btn" />
          ))}
        </div>
        {leftTab && (
          <div className="sk-side" style={{ width: shown.left }}>
            <div className="sk-head">
              <span className="sk-bar sk-head-title" />
            </div>
            <Rows widths={[72, 58, 64, 46, 52]} />
          </div>
        )}
        <div className="sk-canvas">
          <CanvasSkeleton label={name ? `Opening ${name}…` : 'Opening…'} />
        </div>
        {dockOpen && (
          <div className="sk-dock" style={{ width: shown.right }}>
            <div className="sk-head sk-tabs">
              <span className="sk-bar sk-tab" />
              <span className="sk-bar sk-tab" />
              <span className="sk-bar sk-tab" />
            </div>
            <Rows widths={[40, 88, 32, 88, 54]} />
          </div>
        )}
      </div>
      <div className="sk-status" />
    </div>
  );
}
