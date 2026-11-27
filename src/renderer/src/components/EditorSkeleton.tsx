import './EditorSkeleton.css';
import { api, useStore } from '../store';
import { Spinner, useWindowWidth } from './ui';
import { fitPanels } from '../lib/layout';

/**
 * The page the canvas is about to show, as an outline, with the one sign that the project is on its way. Drawn where the
 * page will be (the canvas's padding and the strip above the page), on the canvas's own dotted ground, so the page
 * takes its place without anything moving. Decorative: the opening is announced once, by App.
 */
export function CanvasSkeleton({ label }: { label: string }) {
  return (
    <div className="canvas-skeleton" aria-hidden="true" data-testid="canvas-skeleton">
      <div className="sk-page">
        <div className="sk-page-nav">
          <span className="sk-bar sk-logo" />
          <span className="sk-page-links">
            <span className="sk-bar" />
            <span className="sk-bar" />
            <span className="sk-bar" />
          </span>
        </div>
        <div className="sk-page-hero">
          <span className="sk-bar sk-heading" />
          <span className="sk-bar sk-line" />
          <span className="sk-bar sk-line short" />
          <span className="sk-bar sk-button" />
        </div>
        <div className="sk-page-cards">
          <span className="sk-card" />
          <span className="sk-card" />
          <span className="sk-card" />
        </div>
      </div>
      <div className="sk-loading">
        <Spinner decorative />
        <span>{label}</span>
      </div>
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
 * at the widths the editor will draw them (lib/layout fitPanels), so the editor replaces it in place. Shown from the
 * click on a recent project until the editor itself can show (App). Nothing in it takes focus or is read out.
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
  return (
    <div className="editor-skeleton" aria-hidden="true" inert data-testid="editor-skeleton">
      <div className={`sk-toolbar${api.platform === 'darwin' ? ' mac' : ''}`}>
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
