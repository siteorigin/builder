import './StatusBar.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type ReactNode } from 'react';
import { Archive, ArrowDown, Bot, Check, ChevronRight, CircleAlert, CircleCheck, Component, Copy, Ellipsis, FileDiff, FileText, FolderOpen, Info, Link2, Lock, Network, Package, Pencil, RefreshCw, Share2, Stethoscope, TriangleAlert, Wrench, X } from 'lucide-react';
import type { ConflictChoice, Diagnostic, EditorDestination, FileText as FileContent, PackageChange, ProjectPackages, ProjectSnapshot, RuntimeState, SavedCopy } from '@shared/api';
import type { SeoFinding, SeoPillar } from '@shared/seo';
import { SEO_PILLARS } from '@shared/seo';
import { diagnosticKey } from '@engine/validate';
import { api, applyOps, confirmDialog, getState, setState, toast, useStore } from '../store';
import { refKey, type ElementRef, type ProjectState } from '@shared/types';
import { breadcrumb, inDefinition, type Crumb } from '../lib/model';
import { saveFailureNotice } from '../lib/savestate';
import { isRemoteOpening } from '../lib/remote-snapshot';
import { activeWorkspace, canvasCovered } from '../lib/workspace';
import { goToShellPart, groupCount, liveGroup, openAsset, openOutline, pageOutOfSight, selectPage } from '../lib/actions';
import { destinationForDiagnostic, destinationLabel } from '../lib/destinations';
import { openEditorDestination } from '../lib/open-destination';
import { findingHandoff } from '../lib/seoHandoff';
import { conflictPanes, diffCaption, lineDiff, sameVersions, savedCopyDay, savedCopyLabel, shownVersions, type ConflictVersions } from '../lib/conflict-versions';
import { AiHandoffButton } from '../components/AiHandoff';
import { HeldStyle } from './StylePaste';
import { Disclosure as Fold, DisclosureMark, Modal, Spinner, useMenu, type MenuItem } from '../components/ui';
import { useTransitionAnnouncement } from '../lib/announce';
import { GENERATED_DIR, defFile } from '@generator/index';
import { instancesOf } from '@engine/tree';
import { auditForHealth, matchesSeoFilter, needsFixing, seoCountsText, seoFilterCounts, seoPillarGroups, seoReadiness, seoSeverityChoices, SEO_PILLAR_NAMES, type SeoAuditResult, type SeoPillarFilter, type SeoSeverityFilter } from '../lib/seo-health';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "2 problems and 1 warning", or whichever of them there are. */
const countsText = (problems: number, warnings: number) => [problems && plural(problems, 'problem'), warnings && plural(warnings, 'warning')].filter(Boolean).join(' and ');

/** Where the preview is: `broken` (it failed), `starting` (the website tools), `opening` (the page), `ready`, `unavailable` or `stopped`. */
type PreviewPhase = 'broken' | 'starting' | 'opening' | 'ready' | 'unavailable' | 'stopped';

function runtimeInfo(runtime: RuntimeState, pageIssue: string | null, frameReady: boolean) {
  const broken = runtime.state === 'error' || (runtime.state === 'ready' && !!pageIssue);
  // "Ready" means the page itself has loaded, not only that the website tools are running.
  const opening = runtime.state === 'ready' && !frameReady && !broken;
  const dot = broken ? 'error' : opening ? 'busy' : runtime.state === 'ready' ? 'ready' : runtime.state === 'preparing' || runtime.state === 'starting' ? 'busy' : 'stopped';
  const label = broken ? 'Preview problem' : opening ? 'Opening page' : runtime.state === 'ready' ? 'Preview ready' : runtime.state === 'preparing' ? 'Setting up website tools' : runtime.state === 'starting' ? 'Starting preview' : runtime.state === 'unavailable' ? 'Preview unavailable' : 'Preview paused';
  const phase: PreviewPhase = broken ? 'broken' : opening ? 'opening' : dot === 'busy' ? 'starting' : dot === 'ready' ? 'ready' : runtime.state === 'unavailable' ? 'unavailable' : 'stopped';
  return { dot, label, broken, phase };
}

/**
 * What screen readers hear as Project health changes: the counts (never on a page switch), and the preview's own
 * turns. A failure is said at once; a restart after it is "Restarting the preview", and it is "working again" only once
 * its page has loaded. A first start is quiet until "Preview ready"; a pause or an unavailable preview is said; an
 * ordinary page switch (ready, opening, ready) stays quiet. The toolbar announces a conflict appearing or clearing, so
 * a change in conflicts alone is quiet here, but every count spoken includes them: this never says "No problems" while
 * a conflict remains. Used by the status bar, and by Project health while it is open (the editor behind a dialog is
 * inert, so the status bar and toolbar can't be heard then): there a conflict appearing is said too, unless it is one the
 * person just settled, which the dialog confirms itself.
 */
function useHealthAnnouncement(quietConflicts: () => boolean): string {
  const health = useStore((s) => {
    const d = s.snapshot?.diagnostics ?? [];
    const conflicts = s.snapshot?.conflicts.length ?? 0;
    const info = runtimeInfo(s.runtime, s.previewIssue, s.frameReady);
    const broken = info.broken;
    // A project's first page is outlined on the canvas, which says it is opening: to the status bar that is a start,
    // quiet until the page is ready, never "paused" for the moment before the preview begins.
    const phase = s.openingPage ? 'starting' : info.phase;
    return [d.filter((x) => x.severity === 'error' && x.code !== 'CONFLICT').length + conflicts + (broken ? 1 : 0) + (s.snapshot?.saveFailure ? 1 : 0), d.filter((x) => x.severity === 'warning').length, conflicts, phase].join(',');
  });
  const opened = health.split(',')[3];
  const recovering = useRef(opened === 'broken');
  const starting = useRef(opened === 'starting');
  return useTransitionAnnouncement(health, (prev, next) => {
    const [pe, pw, pc, pp] = prev.split(',');
    const [e, w, c, p] = next.split(',');
    const counts = countsText(Number(e), Number(w));
    if (p !== pp) {
      if (p === 'broken') {
        recovering.current = true;
        starting.current = false;
        return `Preview problem. ${counts} in this project`;
      }
      if (p === 'starting') {
        starting.current = true;
        if (recovering.current) return 'Restarting the preview';
      }
      // Recovering, the page is reloading: nothing is settled until it has loaded, so only a change in the project's
      // own counts (leaving out the preview's problem) is said meanwhile.
      if (p === 'opening' && recovering.current && Number(e) === Number(pe) - (pp === 'broken' ? 1 : 0) && w === pw && c === pc) return null;
      if (p === 'ready' && (recovering.current || starting.current)) {
        const again = recovering.current;
        recovering.current = starting.current = false;
        return again ? `Preview working again${counts ? `. ${counts} in this project` : ''}` : 'Preview ready';
      }
      if (p === 'unavailable' || p === 'stopped') {
        recovering.current = starting.current = false;
        return p === 'unavailable' ? 'Preview unavailable' : 'Preview paused';
      }
    }
    if (e === pe && w === pw && c === pc) return null;
    if (c !== pc && Number(e) - Number(c) === Number(pe) - Number(pc) && w === pw && quietConflicts()) return null;
    // While a failed preview restarts, an all-clear waits for "Preview working again".
    if (!counts && recovering.current) return null;
    return counts ? `${counts} in this project` : 'No problems';
  });
}

export function StatusBar() {
  const snap = useStore((s) => s.snapshot);
  const runtime = useStore((s) => s.runtime);
  const selection = useStore((s) => s.selection);
  const layerSet = useStore((s) => s.layerSet);
  const pageId = useStore((s) => s.pageId);
  const dev = useStore((s) => !!s.settings?.developerMode);
  const pageIssue = useStore((s) => s.previewIssue);
  const stylesOpen = useStore((s) => s.rightTab === 'styles' && s.dockOpen);
  const definitionMode = useStore((s) => s.definitionMode);
  // The post writer or the SEO view covers the canvas: no path leads to what is selected under it (#578, #700).
  const covered = useStore((s) => canvasCovered(activeWorkspace(s)));
  const frameReady = useStore((s) => s.frameReady);
  const menu = useMenu();
  /** The parent elements the open menu offers, as of this render, and the path it was opened from. */
  const parentRows = useRef<MenuItem[]>([]);
  const parentsNav = useRef<HTMLElement | null>(null);
  // The toolbar says when a conflict appears or clears.
  const announce = useHealthAnnouncement(() => true);
  // The preview's button becomes text once it recovers: if it had focus, the Project health count takes it.
  const previewHadFocus = useRef(false);
  const problemsRef = useRef<HTMLButtonElement>(null);
  const previewActionable = useStore((s) => !s.openingPage && ['broken', 'stopped', 'unavailable'].includes(runtimeInfo(s.runtime, s.previewIssue, s.frameReady).phase));
  // While the canvas outlines the project's first page, that outline is the opening's one sign: the preview's line waits.
  const openingPage = useStore((s) => s.openingPage);
  useLayoutEffect(() => {
    if (previewActionable || !previewHadFocus.current) return;
    previewHadFocus.current = false;
    if (!document.activeElement || document.activeElement === document.body) problemsRef.current?.focus();
  }, [previewActionable]);
  if (!snap) return null;
  // Problems = document errors plus file conflicts and a failed save, so this never says "No problems" while the toolbar
  // shows either.
  // The project's diagnostics already list each conflict (code CONFLICT); count each one once.
  // The project's first page on its way: a start, never a pause; said here only while the canvas is out of sight
  // (the SEO view or the post writer over it), since the outline on it says so otherwise.
  const info = runtimeInfo(runtime, pageIssue, frameReady);
  const { dot, label, broken, phase } = openingPage ? { ...info, dot: 'busy', label: info.phase === 'opening' ? 'Opening page' : 'Starting preview', phase: 'starting' as const } : info;
  const errors = snap.diagnostics.filter((d) => d.severity === 'error' && d.code !== 'CONFLICT').length + snap.conflicts.length + (broken ? 1 : 0) + (snap.saveFailure ? 1 : 0);
  const warnings = snap.diagnostics.filter((d) => d.severity === 'warning').length;
  // While editing a component everywhere, the path starts at the component (plum), never at a page: its
  // overview, then the design's own layers down to the selection.
  const def = definitionMode && !covered ? snap.state.components[definitionMode.definitionId] : undefined;
  const crumbs: Array<Crumb & { def?: boolean }> = def
    ? selection && inDefinition(selection, def.id)
      ? breadcrumb(snap.state, selection).map((c, i) => (i ? c : { ...c, def: true }))
      : [{ label: def.name, full: def.name, ref: null, def: true }]
    : selection && !stylesOpen && !covered
      ? breadcrumb(snap.state, selection)
      : [];
  // A deep path keeps its first item and the last two (the selection and its parent); the ones between
  // collapse into one menu button.
  const hidden = crumbs.length > 4 ? crumbs.slice(1, -2) : [];
  const shown = hidden.length ? [crumbs[0], null, ...crumbs.slice(-2)] : crumbs;
  // Selecting a crumb can shorten the path under the focused button: keep focus on the path's current item,
  // or, when the page itself was chosen and the path is gone, on the page preview.
  const select = (ref: Crumb['ref'], nav: HTMLElement | null) => {
    setState({ selection: ref });
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!nav || !(nav.contains(active) || !active || active === document.body)) return;
      (nav.querySelector<HTMLElement>('[aria-current]') ?? document.querySelector<HTMLElement>('main.canvas'))?.focus();
    });
  };
  // The open parent-elements menu reads this each render, so it offers the path as it is now, never an element an
  // edit has since moved or removed; when the path no longer needs the menu, its button goes and the menu closes.
  parentRows.current = hidden.map((h, i): MenuItem => ({ id: h.ref ? refKey(h.ref) : String(i), label: h.label, icon: h.component ? <Component /> : undefined, hint: h.component === 'custom' ? 'Custom' : undefined, onSelect: () => select(h.ref, parentsNav.current) }));
  // Several layers selected together in Layers: the path is the selection's, and the count says the rest come too.
  const picked = crumbs.length ? liveGroup({ snapshot: snap, selection, layerSet, pageId, definitionMode }) : null;
  const openHealth = () => setState({ modal: { kind: 'health' } });
  // A working or starting preview is only reported; one that failed, stopped or can't run leads to what to do about it.
  const actionable = phase === 'broken' || phase === 'stopped' || phase === 'unavailable';
  return (
    <footer className="status-bar">
      {openingPage && !covered ? null : actionable ? (
        <button
          className={`row preview-status${broken ? ' error' : ''}`}
          title={`${label}: open Project health`}
          onClick={openHealth}
          onFocus={() => (previewHadFocus.current = true)}
          onBlur={() => (previewHadFocus.current = false)}
        >
          {broken ? <CircleAlert aria-hidden="true" /> : <span className={`status-dot ${dot}`} aria-hidden="true" />}
          {label}
          <ChevronRight className="go" aria-hidden="true" />
        </button>
      ) : (
        <span className="row preview-status">
          <span className={`status-dot ${dot}`} aria-hidden="true" />
          {label}
        </span>
      )}
      {snap.readOnly && (
        <>
          <span className="status-sep" aria-hidden="true" />
          {isRemoteOpening(snap.workspaceKey) ? (
            // The host's project in a live session (#766): its health is the host's; the reason is all there is to say.
            // A copy editor (#1318) edits its words and pictures, unless editing is paused.
            <span className="read-only" title={snap.readOnly.reason}>
              {snap.readOnly.copyOnly && !snap.readOnly.copyOnly.paused ? (
                <>
                  <Pencil aria-hidden="true" />
                  Copy editing
                </>
              ) : (
                <>
                  <Lock aria-hidden="true" />
                  Read-only
                </>
              )}
            </span>
          ) : (
            <button className="read-only" title={`${snap.readOnly.reason} Open Project health for what you can do.`} onClick={openHealth}>
              <Lock aria-hidden="true" />
              Read-only
              <ChevronRight className="go" aria-hidden="true" />
            </button>
          )}
        </>
      )}
      {crumbs.length > 0 && <span className="status-sep" aria-hidden="true" />}
      {crumbs.length > 0 ? (
        <nav className="crumbs grow" aria-label="Selected element">
          <ol>
            {shown.map((c, i) => (
              // Keyed by what each item selects, so the overflow button is never reused as a crumb.
              <li key={c ? (c.ref ? refKey(c.ref) : 'start') : 'more'}>
                {i > 0 && <ChevronRight aria-hidden="true" />}
                {c ? (
                  <button
                    className={[c.def && 'def', c.component && 'component', c.component === 'custom' && 'custom'].filter(Boolean).join(' ') || undefined}
                    aria-current={i === shown.length - 1 ? 'location' : undefined}
                    aria-label={c.full !== c.label ? c.full : undefined}
                    title={c.full}
                    onClick={(e) => select(c.ref, e.currentTarget.closest('nav'))}
                  >
                    {/* A placed component's boundary, plum when it was made in this project. */}
                    {c.component && <Component className="crumb-mark" aria-hidden="true" />}
                    {c.label}
                  </button>
                ) : (
                  <button
                    className="more"
                    {...menu.triggerProps()}
                    aria-label={`${hidden.length} more parent elements`}
                    title={hidden.map((h) => h.label).join(' › ')}
                    onClick={(e) => {
                      parentsNav.current = e.currentTarget.closest('nav');
                      menu.openAt(e.currentTarget, () => parentRows.current, 'Parent elements');
                    }}
                  >
                    <Ellipsis />
                  </button>
                )}
              </li>
            ))}
          </ol>
          {picked && <span className="crumbs-count">{groupCount(picked)} selected</span>}
        </nav>
      ) : (
        <span className="grow" aria-hidden="true" />
      )}
      <HeldStyle />
      {/* Each severity keeps its own glyph and words, so both can be picked out at a glance; red rests only on problems. */}
      <button ref={problemsRef} className={`problems${errors ? ' error' : warnings ? ' warn' : ''}`} onClick={openHealth} title="Project health: check this project for problems">
        {errors > 0 && (
          <span className="tally error">
            <CircleAlert aria-hidden="true" />
            {plural(errors, 'problem')}
          </span>
        )}
        {errors > 0 && warnings > 0 && <span className="sr-only">, </span>}
        {warnings > 0 && (
          <span className="tally warn">
            <TriangleAlert aria-hidden="true" />
            {plural(warnings, 'warning')}
          </span>
        )}
        {!errors && !warnings && (
          <span className="tally ok">
            <CircleCheck aria-hidden="true" />
            No problems
          </span>
        )}
        <ChevronRight className="go" aria-hidden="true" />
      </button>
      <span className="sr-only" role="status">
        {announce}
      </span>
      {dev && <span className="faint" title="Document revision">rev {snap.revision}</span>}
      {menu.node}
    </footer>
  );
}

/** The project's own documents, by the names the app uses for them. */
const DOCUMENT_NAMES: Record<string, string> = {
  'siteorigin/site.json': 'Site settings',
  'siteorigin/tokens.json': 'Site styles',
  'siteorigin/assets.json': 'Asset library',
  'siteorigin/theme-lock.json': 'Theme record',
  'siteorigin/brief.json': 'Project brief'
};

/** What a conflicted file holds, in the words the user knows it by. The path is shown beside it. */
function conflictSubject(state: ProjectState, path: string): string {
  // A design's own generated file is named for its component.
  const design = path.startsWith(`${GENERATED_DIR}/`) ? Object.values(state.components).find((d) => d.kind === 'managed' && !!d.tree && defFile(d) === path) : undefined;
  if (design) return `${design.name} component file`;
  // A project code component's own file is named for its component too.
  const code = path.startsWith('src/lib/siteorigin/custom/') ? Object.values(state.components).find((d) => d.kind === 'code' && d.sourcePath === path) : undefined;
  if (code) return `${code.name} code component file`;
  const page = /^siteorigin\/pages\/([^/]+)\.json$/.exec(path)?.[1];
  if (page) return Object.hasOwn(state.pages, page) ? `${state.pages[page].title} page` : 'Page file';
  const component = /^siteorigin\/components\/([^/]+)\//.exec(path)?.[1];
  // One no longer in the project (a saved copy from earlier, say) is named from its path.
  if (component) return Object.hasOwn(state.components, component) ? `${state.components[component].name} component` : `${capitalise(component.replace(/^[a-z]+\./, '').replace(/[-_.]+/g, ' '))} component`;
  if (Object.hasOwn(DOCUMENT_NAMES, path)) return DOCUMENT_NAMES[path];
  const route = /^src\/routes\/(.*)\+page\.svelte$/.exec(path)?.[1];
  const built = route === undefined ? undefined : Object.values(state.pages).find((p) => p.route === `/${route}`);
  if (built) return `${built.title} website file`;
  if (route !== undefined) return `${route ? capitalise(route.replace(/\/$/, '').split('/').pop()!.replace(/[-_]+/g, ' ')) : 'Home'} website file`;
  return 'Project file';
}

/** The SHA-256 of text as a file holds it (UTF-8), in hex: the bytes a conversion expects to find on disk. */
async function textDigest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A generated file's reason, without the word "generated". */
const conflictReason = (reason: string) =>
  reason === 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.'
    ? 'Edited outside SiteOrigin Builder, which can’t update this file until it is restored.'
    : reason === 'Changed outside SiteOrigin Builder during an AI run.' || reason === 'Changed outside SiteOrigin Builder during an interrupted AI run.'
      ? 'Changed outside SiteOrigin Builder while an AI request was working on it, so the request’s change to it was undone.'
      : reason;

/** Where settling a conflict put the versions not used, said only for those it kept. */
function keptAs(sides: SavedCopy['side'][]): string {
  const names = { external: 'the edited file', builder: 'SiteOrigin Builder’s version', attempted: 'the AI request’s attempted version' };
  const list = [...new Set(sides)].map((side) => names[side]);
  if (!list.length) return '';
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
  return ` ${capitalise(joined)} ${list.length > 1 ? 'are' : 'is'} under Saved copies.`;
}

/** Why a theme component stays as it is, in plain words where the engine's reason is about its stored data. */
const keptReason = (reason: string) => (reason === 'Its stored definition was changed outside the theme.' ? 'It has its own edits, so this update leaves it as it is.' : reason);

const capitalise = (s: string) => s.replace(/^\p{Ll}/u, (ch) => ch.toUpperCase());

/** The page or component a diagnostic is about, when its message opens with that name ("About: …"): such rows are listed under it. */
function diagnosticPlace(state: ProjectState, d: Diagnostic): { kind: 'page' | 'component'; id: string; name: string; rest: string } | null {
  const { kind, id } = d.owner ?? {};
  if (!id || (kind !== 'page' && kind !== 'component')) return null;
  const name = kind === 'page' ? (Object.hasOwn(state.pages, id) ? state.pages[id].title : null) : Object.hasOwn(state.components, id) ? state.components[id].name : null;
  return name && d.message.startsWith(`${name}: `) ? { kind, id, name, rest: capitalise(d.message.slice(name.length + 2)) } : null;
}

/** An image diagnostic's opening words (the image's name), set apart so a long list can be scanned by them. */
function assetLead(state: ProjectState, d: Diagnostic): { lead: string; rest: string } | null {
  if (d.owner?.kind !== 'asset') return null;
  const id = d.owner.id;
  const name = Object.hasOwn(state.assets.assets, id) ? state.assets.assets[id].name : undefined;
  return typeof name === 'string' && name && d.message.startsWith(`${name} `) ? { lead: name, rest: d.message.slice(name.length) } : null;
}

/** The element a diagnostic is about, when it can be selected on a page. */
function diagnosticTarget(state: ProjectState, d: Diagnostic): ElementRef | null {
  if (!d.nodeId || !d.owner) return null;
  const { kind, id } = d.owner;
  const tree = kind === 'page' && Object.hasOwn(state.pages, id) ? state.pages[id] : kind === 'shell' && (id === 'header' || id === 'footer') ? state.site.shell[id] : null;
  if (!tree || !Object.hasOwn(tree.nodes, d.nodeId)) return null;
  return { owner: d.owner as ElementRef['owner'], instancePath: [], nodeId: d.nodeId };
}

function showPage(pageId: string) {
  selectPage(pageId, null);
  // With the Inspector, which holds the page's own settings.
  setState({ modal: null, mode: 'edit', rightTab: 'inspect', dockOpen: true });
}

function showElement(ref: ElementRef) {
  const s = getState();
  if (ref.owner.kind === 'page') {
    if (pageOutOfSight(s, ref.owner.id)) selectPage(ref.owner.id);
  } else if (!goToShellPart(ref.owner.id)) {
    toast(`No page shows the shared ${ref.owner.id} right now.`, 'error');
    return;
  }
  setState({ modal: null, mode: 'edit', selection: ref, rightTab: 'inspect', dockOpen: true });
}

/**
 * Open a page's heading outline on the heading a warning is about, so the fix is the next thing in reach: the flagged
 * row for that heading, the page's own fix for a missing Heading 1, or the outline's first row otherwise.
 */
function showHeadings(pageId: string, d: Diagnostic) {
  openOutline(pageId);
  const land = () => {
    const view = document.querySelector<HTMLElement>('.outline-view');
    if (!view) return false;
    const summary = view.querySelector<HTMLElement>('.outline-summary button');
    const rows = d.nodeId && d.code !== 'HEADING_MISSING_H1' ? [...view.querySelectorAll<HTMLElement>(`.outline-row.warn[data-node="${CSS.escape(d.nodeId)}"]`)] : [];
    const wanted = d.code === 'HEADING_MULTIPLE_H1' ? rows.filter((r) => r.dataset.level === '1') : rows;
    // One heading is the warning's: select it (the page and Inspector follow) and focus its row. When a placement shows
    // several, or the page has no Heading 1, the outline's summary leads on from there.
    const target = wanted.length === 1 ? wanted[0] : null;
    if (target) {
      target.click();
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
    } else (summary ?? view).focus();
    return true;
  };
  // The outline mounts, then openOutline focuses its first row two frames on: land after that.
  let tries = 0;
  const step = () => (++tries > 2 && land()) || tries > 12 || requestAnimationFrame(step);
  requestAnimationFrame(step);
}

type Tone = 'danger' | 'warn' | 'quiet';

function HealthGroup({ title, count, tone, anchor, note, children }: { title: string; count?: number; tone?: Tone; anchor?: string; note?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className={`health-group${tone ? ` ${tone}` : ''}`} aria-labelledby={id} data-group={anchor}>
      <h3 id={id} tabIndex={-1}>
        {title}{' '}
        {count !== undefined && <span className="health-count">{count}</span>}
      </h3>
      {note && <p className="health-note">{note}</p>}
      <ul className="health-list">{children}</ul>
    </section>
  );
}

/** One item: what happened, its actions (named by that text, since rows repeat them), and anything below across the text's width. */
function HealthRow({ tone, icon, actions, details, children }: { tone: Tone; icon: ReactNode; actions?: ReactNode; details?: ReactNode; children: ReactNode }) {
  const textId = useId();
  return (
    <li className={`health-row ${tone}`}>
      <span className="health-icon">{icon}</span>
      <div className="health-text" id={textId}>
        {children}
      </div>
      {actions && (
        <div className="health-actions" role="group" aria-labelledby={textId}>
          {actions}
        </div>
      )}
      {details && <div className="health-below">{details}</div>}
    </li>
  );
}

/** A disclosure in a row: a chevron that turns, then whatever it holds. `summaryLabel` names a repeated one by its row. */
function Disclosure({ label, summaryLabel, children }: { label: ReactNode; summaryLabel?: string; children: ReactNode }) {
  return (
    <Fold className="health-details" summary={label} summaryLabel={summaryLabel}>
      <div className="health-details-body">{children}</div>
    </Fold>
  );
}

/** Copy some text, saying so where it was asked for (and to screen readers), or that it couldn't. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div className="health-copy">
      <button className="btn btn-sm" onClick={() => void copy()}>
        {copied === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied === 'copied' ? 'Copied' : label}
      </button>
      <span className="health-copy-state" role="status">
        {copied === 'failed' ? 'Couldn’t copy. Select the text instead.' : copied === 'copied' ? <span className="sr-only">Copied.</span> : ''}
      </span>
    </div>
  );
}

/** Technical output, closed until asked for: it helps whoever is fixing the problem, and few others. */
function ErrorDetails({ text }: { text: string }) {
  return (
    <Disclosure label="Error details">
      <pre>
        {text.split('\n').map((line, i) => (
          <span key={i} className="health-log-line">
            {line || ' '}
          </span>
        ))}
      </pre>
      <CopyButton text={text} label="Copy details" />
    </Disclosure>
  );
}

const PILLAR_ICONS: Record<SeoPillar, ReactNode> = {
  technical: <Wrench aria-hidden="true" />,
  entity: <Network aria-hidden="true" />,
  agentic: <Bot aria-hidden="true" />,
  content: <Link2 aria-hidden="true" />,
  social: <Share2 aria-hidden="true" />
};
const SEVERITY_NAMES: Record<SeoSeverityFilter, string> = { all: 'All', error: 'Problems', warning: 'Warnings', info: 'Notes' };
/** How many findings it takes before Search & AI readiness offers its filters. */
const SEO_FILTER_FROM = 10;

/**
 * What keeps the website from being found, shared and read by search engines, link previews and AI agents (the SEO
 * audit), apart from the project's own checks above: counted on its own, so the status bar's count stays the project's.
 * Its findings are grouped by pillar and filtered by pillar and severity; each that one place fixes leads there, and
 * each the AI can fix offers Fix with AI.
 */
function SeoReadiness({ audit, state, focusOnOpen }: { audit: SeoAuditResult; state: ProjectState; focusOnOpen: boolean }) {
  const headId = useId();
  const pillarId = useId();
  const severityId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pillarRef = useRef<HTMLSelectElement>(null);
  // Chosen afresh each time the dialog opens, and kept while findings come and go.
  const [pillar, setPillar] = useState<SeoPillarFilter>('all');
  const [severity, setSeverity] = useState<SeoSeverityFilter>('all');
  const findings = audit.ok ? audit.findings : [];
  // The control in this section that last had focus: a row's action goes with its finding once that is fixed.
  const lastFocused = useRef<HTMLElement | null>(null);
  const keys = findings.map(diagnosticKey).join('\n');
  const opened = useRef(false);
  useEffect(() => {
    // Not on opening: the dialog chooses where focus starts.
    if (!opened.current) return void (opened.current = true);
    const active = document.activeElement;
    if ((!active || active === document.body) && lastFocused.current && !lastFocused.current.isConnected) headingRef.current?.focus();
  }, [keys]);
  const onFocus = (e: FocusEvent<HTMLElement>) => void (lastFocused.current = e.target);
  // Focus that moved elsewhere in the dialog is not this section's to bring back; focus lost with a removed row is.
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) lastFocused.current = null;
  };
  const counts = seoFilterCounts(findings, pillar, severity);
  const filtered = pillar !== 'all' || severity !== 'all';
  // A short list is read faster than two menus are worked: the filters come in once there are many findings (and stay
  // while one is in use).
  const filterable = findings.length >= SEO_FILTER_FROM || filtered;
  const due = findings.filter(needsFixing);
  // With something to fix, the notes (suggestions only) wait below it, folded, rather than sitting between warnings. An
  // area chosen with only notes in it shows them as its list.
  const inArea = findings.filter((f) => matchesSeoFilter(f, pillar, 'all'));
  const split = severity === 'all' && inArea.some(needsFixing) && inArea.some((f) => !needsFixing(f));
  const groups = seoPillarGroups(split ? due : findings, pillar, severity);
  const noteGroups = split ? seoPillarGroups(findings.filter((f) => !needsFixing(f)), pillar, 'all') : [];
  const noteCount = noteGroups.reduce((n, g) => n + g.findings.length, 0);
  const shown = groups.reduce((n, g) => n + g.findings.length, 0) + noteCount;
  const readiness = seoReadiness(findings);
  const pillarList = (list: typeof groups) => (
    <ul className="health-list">
      {list.map((g) => (
        <li key={g.pillar} className="health-place" data-pillar={g.pillar}>
          <h4>
            {PILLAR_ICONS[g.pillar]}
            {g.name}
          </h4>
          <ul>
            {sharedRuns(g.findings).map((run) => (run.length > 1 ? <SeoSharedRow key={diagnosticKey(run[0])} findings={run} state={state} /> : <SeoRow key={diagnosticKey(run[0])} finding={run[0]} state={state} />))}
          </ul>
        </li>
      ))}
    </ul>
  );
  const clear = () => {
    setPillar('all');
    setSeverity('all');
    pillarRef.current?.focus();
  };
  const tone = !audit.ok || readiness.tone === 'ok' ? 'quiet' : readiness.tone;
  return (
    <section className={`health-group seo-readiness ${tone}`} aria-labelledby={headId} data-group="seo" data-testid="health-seo" onFocus={onFocus} onBlur={onBlur}>
      <h3 id={headId} ref={headingRef} tabIndex={-1} data-autofocus={focusOnOpen || undefined}>
        Search &amp; AI readiness {findings.length > 0 && <span className="health-count">{due.length || findings.length}</span>}
      </h3>
      {!audit.ok ? (
        <p className="health-note seo-readiness-summary">
          <Info aria-hidden="true" />
          <span>Search &amp; AI readiness couldn’t be checked: {audit.message}</span>
        </p>
      ) : (
        <p className={`health-note seo-readiness-summary ${readiness.tone}`}>
          {readiness.tone === 'ok' ? <CircleCheck aria-hidden="true" /> : readiness.tone === 'warn' ? <TriangleAlert aria-hidden="true" /> : <Info aria-hidden="true" />}
          <span>
            <strong>{readiness.headline}.</strong> {readiness.detail}
          </span>
        </p>
      )}
      {filterable && (
        <div className="seo-filters">
          <label htmlFor={pillarId}>Area</label>
          <select id={pillarId} ref={pillarRef} className="select sm" value={pillar} onChange={(e) => setPillar(e.target.value as SeoPillarFilter)}>
            <option value="all">All areas ({counts.pillars.all})</option>
            {SEO_PILLARS.map((p) => (
              <option key={p} value={p}>
                {SEO_PILLAR_NAMES[p]} ({counts.pillars[p]})
              </option>
            ))}
          </select>
          <label htmlFor={severityId}>Severity</label>
          <select id={severityId} className="select sm" value={severity} onChange={(e) => setSeverity(e.target.value as SeoSeverityFilter)}>
            {[...new Set([...seoSeverityChoices(findings), severity])].map((s) => (
              <option key={s} value={s}>
                {SEVERITY_NAMES[s]} ({counts.severities[s]})
              </option>
            ))}
          </select>
          <span className="seo-showing" role="status">
            {filtered ? `${shown} of ${findings.length} match${noteCount ? `, including ${noteCount === 1 ? '1 optional note' : `${noteCount} optional notes`}` : ''}` : <span className="sr-only">All {findings.length} findings shown</span>}
          </span>
        </div>
      )}
      {groups.length > 0 ? (
        <>
          {pillarList(groups)}
          {noteCount > 0 && (
            <Fold className="seo-notes" summary={`${noteCount === 1 ? '1 note' : `${noteCount} notes`}, optional`}>
              <p className="health-note">Suggestions that help the website be found and shared. Nothing here needs fixing before you publish.</p>
              {pillarList(noteGroups)}
            </Fold>
          )}
        </>
      ) : (
        findings.length > 0 && (
          <p className="health-note seo-empty">
            <span>
              No {severity === 'all' ? 'findings' : SEVERITY_NAMES[severity].toLowerCase()}
              {pillar === 'all' ? '' : ` in ${SEO_PILLAR_NAMES[pillar]}`}.{' '}
              <button type="button" className="link-btn" onClick={clear}>
                Clear filters
              </button>
            </span>
          </p>
        )
      )}
    </section>
  );
}

/** One finding: what it is, why it matters, the way to where it is fixed when one place fixes it, and Fix with AI when the AI can. */
function SeoRow({ finding: f, state }: { finding: SeoFinding; state: ProjectState }) {
  const dest = f.destination;
  const fix = findingHandoff(state, f);
  return (
    <HealthRow
      tone={f.severity === 'error' ? 'danger' : f.severity === 'warning' ? 'warn' : 'quiet'}
      icon={f.severity === 'error' ? <CircleAlert /> : f.severity === 'warning' ? <TriangleAlert /> : <Info />}
      actions={
        dest || fix ? (
          <>
            {dest && (
              <button className="btn btn-sm" onClick={() => openEditorDestination(dest)}>
                {destinationLabel(dest)}
              </button>
            )}
            {fix && <AiHandoffButton label="Fix with AI" request={() => findingHandoff(getState().snapshot?.state ?? state, f)} />}
          </>
        ) : undefined
      }
      // With a way to the fix beside it, why it matters is there when asked for; without one, the explanation says what
      // to do, so it stays in view.
      details={
        dest || fix ? (
          <Disclosure label="Why it matters" summaryLabel={`Why it matters: ${f.message}`}>
            {f.explanation}
          </Disclosure>
        ) : undefined
      }
    >
      <span className="sr-only">{f.severity === 'error' ? 'Problem: ' : f.severity === 'warning' ? 'Warning: ' : 'Note: '}</span>
      {f.message}
      {!(dest || fix) && <span className="health-hint">{f.explanation}</span>}
    </HealthRow>
  );
}

/** What a "same description as" finding says: whose, which field, and the words they share. Null for any other finding. */
function sharedValue(f: SeoFinding): { name: string; what: string; value: string } | null {
  if (!f.code.endsWith('_DUPLICATE')) return null;
  const m = /^(.+?) has the same (.+?) as .+?: “(.*)”\.?$/su.exec(f.message);
  return m ? { name: m[1], what: m[2], value: m[3] } : null;
}

/** A pillar's findings in order, the pages sharing one description (or title) collected into one run. */
function sharedRuns(findings: SeoFinding[]): SeoFinding[][] {
  const runs: SeoFinding[][] = [];
  const byValue = new Map<string, SeoFinding[]>();
  for (const f of findings) {
    const v = sharedValue(f);
    const key = v && `${f.code}\n${v.value}`;
    const run = key ? byValue.get(key) : undefined;
    if (run) run.push(f);
    else {
      runs.push([f]);
      if (key) byValue.set(key, runs[runs.length - 1]);
    }
  }
  return runs;
}

/**
 * Pages that share one description: one item, said once with the words they share, and each page's way to its own
 * fix below it. The audit still counts one finding per page, since each page is fixed on its own.
 */
function SeoSharedRow({ findings, state }: { findings: SeoFinding[]; state: ProjectState }) {
  const textId = useId();
  const shared = findings.map(sharedValue);
  const first = findings[0];
  const names = shared.map((v) => v!.name);
  const listed = names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join(' and ');
  return (
    <HealthRow
      tone={first.severity === 'error' ? 'danger' : first.severity === 'warning' ? 'warn' : 'quiet'}
      icon={first.severity === 'error' ? <CircleAlert /> : first.severity === 'warning' ? <TriangleAlert /> : <Info />}
      details={
        <>
          <ul className="seo-shared-pages">
            {findings.map((f, k) => {
              const dest = f.destination;
              const fix = findingHandoff(state, f);
              return (
                <li key={diagnosticKey(f)}>
                  <span id={`${textId}-${k}`} className="seo-shared-name">
                    {names[k]}
                  </span>
                  {/* Named by the page and the finding, so each page's actions say whose they are. */}
                  <div className="seo-shared-actions" role="group" aria-labelledby={`${textId}-${k} ${textId}`}>
                    {dest && (
                      <button className="btn btn-sm" onClick={() => openEditorDestination(dest)}>
                        {destinationLabel(dest)}
                      </button>
                    )}
                    {fix && <AiHandoffButton label="Fix with AI" request={() => findingHandoff(getState().snapshot?.state ?? state, f)} />}
                  </div>
                </li>
              );
            })}
          </ul>
          <Disclosure label="Why it matters" summaryLabel={`Why it matters: ${listed} have the same ${shared[0]!.what}`}>
            {first.explanation}
          </Disclosure>
        </>
      }
    >
      <span className="sr-only">{first.severity === 'error' ? 'Problem: ' : first.severity === 'warning' ? 'Warning: ' : 'Note: '}</span>
      <span id={textId}>
        {listed} have the same {shared[0]!.what}: “{shared[0]!.value}”{/[.!?…]$/.test(shared[0]!.value) ? '' : '.'}
      </span>
    </HealthRow>
  );
}

export function HealthModal() {
  const snap = useStore((s) => s.snapshot);
  // Converting a design's edited file makes code, which needs Developer mode as all code does.
  const codeEnabled = useStore((s) => !!s.settings?.developerMode);
  const runtime = useStore((s) => s.runtime);
  const pageIssue = useStore((s) => s.previewIssue);
  const frameReady = useStore((s) => s.frameReady);
  // Opened at Search & AI readiness (from the export dialog's preflight): its heading takes focus, not the summary.
  const atSeo = useStore((s) => s.modal?.kind === 'health' && s.modal.section === 'seo');
  // The SEO audit reads the project as it is now, while the dialog is open.
  const projectState = snap?.state;
  const seoAudit = useMemo(() => (projectState ? auditForHealth(projectState) : null), [projectState]);
  // An audit finding that is also one of the project's own (an entry's picture without a description) leads to the same place.
  const seoDestinations = useMemo(() => new Map<string, EditorDestination>(seoAudit?.ok ? seoAudit.findings.flatMap((f) => (f.destination ? [[diagnosticKey(f), f.destination] as const] : [])) : []), [seoAudit]);
  const [busy, setBusy] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const recoveryNote = useId();
  // The conflict being settled here: its own removal is said by this dialog, not again as a count. Any other conflict
  // appearing or clearing meanwhile is still said.
  const settling = useRef<{ path: string; before: string[] } | null>(null);
  // Reinstalling the website tools: held while asked, and a failure said beside the action, with its details closed.
  const [repair, setRepair] = useState<'asking' | { failed: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // What the last action did: its row may be gone by the time it finishes.
  const [status, setStatus] = useState('');
  const previewNews = useHealthAnnouncement(() => {
    const was = settling.current;
    if (!was) return false;
    // Quiet only when exactly the settled file left the list and nothing else about it changed.
    const now = (getState().snapshot?.conflicts ?? []).map((c) => c.path);
    const left = was.before.filter((p) => p !== was.path);
    settling.current = null;
    return now.length === left.length && left.every((p) => now.includes(p));
  });
  // Opened from a status-bar item that is gone by the time the dialog closes (a preview that recovered): carry on from
  // the Project health count, which is always there.
  useEffect(
    () => () =>
      void requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>('.status-bar .problems')?.focus();
      }),
    []
  );
  // Settling a problem (or removing a saved copy) removes the row holding the focused button, and one that failed may
  // have left focus nowhere: carry on from the summary, which says what is left.
  // The Search & AI readiness count too: the summary's jump to it goes once its last finding is fixed.
  const listed = [snap?.diagnostics.length ?? 0, snap?.conflicts.length ?? 0, snap?.themeUpdates?.available.length ?? 0, snap?.savedCopies?.length ?? 0, !!snap?.saveFailure, runtime.state, !!pageIssue, seoAudit?.ok ? seoAudit.findings.length : -1].join();
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) summaryRef.current?.focus();
  }, [listed, status, busy]);
  if (!snap) return null;
  const st = snap.state;
  const readOnly = !!snap.readOnly;
  // The tools line describes the website tools only; a page problem is listed separately.
  const { label } = runtimeInfo(runtime, null, true);
  // Until the page itself has loaded (a restart after a failure, say), nothing is settled yet.
  const phase = runtimeInfo(runtime, pageIssue, frameReady).phase;
  const close = () => setState({ modal: null });
  /**
   * Settle a conflict. The dialog is held from the moment a choice is pressed, through `check` (the compared versions
   * read again, giving what a conversion expects to find), so no other choice can start meanwhile. A conversion's
   * refusal is the row's to show, beside its choice (`onRefused`); Keep's and Restore's are said as before.
   */
  const resolve = async (path: string, choice: ConflictChoice, check?: () => Promise<false | { expect?: string }>, onRefused?: (message: string) => void) => {
    if (busy) return;
    setBusy(path);
    try {
      const checked: false | { expect?: string } = check ? await check() : {};
      if (!checked) return;
      settling.current = { path, before: snap.conflicts.map((c) => c.path) };
      const subject = conflictSubject(st, path);
      const held = snap.conflicts.find((c) => c.path === path);
      const deleted = held ? deletedCodeOf(st, held) : null;
      // A conversion or a removal names the opening it was chosen in; a conversion, the bytes it was compared as.
      const r = await api.project.resolveConflict(path, choice, choice === 'convert' ? { opening: snap.workspaceKey, ...(checked.expect ? { expect: checked.expect } : {}) } : choice === 'remove' ? { opening: snap.workspaceKey } : undefined);
      if (!r.ok) {
        settling.current = null;
        const message = r.message ?? (choice === 'convert' ? 'The file could not be converted.' : undefined);
        if (message && choice === 'convert' && onRefused) onRefused(message);
        else if (message) toast(message, 'error');
      } else if (choice === 'convert') setStatus(r.message ?? `${subject} is now a code component, which the component’s placements use. The edited file is also under Saved copies.`);
      else if (choice === 'remove') setStatus(`${deleted?.name ?? 'The component'}${deleted?.placements ? ' and its placements were' : ' was'} removed. Undo puts ${deleted?.placements ? 'them' : 'it'} back.`);
      else if (deleted && choice === 'restore') setStatus(`${subject} is back, with the code SiteOrigin Builder last loaded.`);
      else setStatus(`${subject} ${choice === 'keep' ? 'now uses the file on disk.' : 'uses SiteOrigin Builder’s version again.'}${keptAs(r.saved ?? [])}`);
    } catch (e) {
      settling.current = null;
      if (choice === 'convert' && onRefused) onRefused(`The file could not be converted: ${(e as Error).message}`);
      else toast(`The conflict could not be resolved: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const updateTheme = async () => {
    const count = plural(snap.themeUpdates?.available.length ?? 0, 'component');
    setBusy('theme');
    setStatus(`Updating ${count}…`);
    try {
      const done = await applyOps([{ type: 'theme.refresh' }], 'Update theme components');
      setStatus(done ? `${count} updated.` : '');
    } catch (e) {
      setStatus('');
      throw e;
    } finally {
      setBusy(null);
    }
  };
  const unlock = async () => {
    const ok = await confirmDialog({
      title: 'Unlock this project?',
      body: 'Only unlock it once the other copy of SiteOrigin Builder has closed this project.',
      details: [
        { kind: 'risk', text: 'If both copies stay open, each can overwrite the other’s changes.' },
        { kind: 'keep', text: 'Unlocking deletes nothing.' }
      ],
      confirmLabel: 'Unlock and edit',
      cancelLabel: 'Keep read-only',
      tone: 'danger',
      icon: 'unlock'
    });
    if (ok !== true) return;
    const r = await api.project.unlock().catch((e: Error) => ({ ok: false, message: e.message }));
    if (!r.ok && r.message) toast(r.message, 'error');
    else close();
  };
  const repairTools = async () => {
    if (repair === 'asking') return;
    setRepair('asking');
    try {
      await api.project.repairDependencies();
      setRepair(null);
    } catch (e) {
      setRepair({ failed: (e as Error).message || String(e) });
    }
  };
  const repairFailed =
    repair && repair !== 'asking' ? (
      <div className="health-inline-result" role="status">
        <p className="health-hint">The website tools couldn’t be reinstalled. Try again, or check the details.</p>
        <ErrorDetails text={repair.failed} />
      </div>
    ) : (
      <span className="sr-only" role="status" />
    );
  const reinstall = (text: string, kind: 'primary' | 'quiet') => (
    <button className={`btn btn-sm${kind === 'primary' ? ' btn-primary' : ' btn-ghost'}`} disabled={runtime.state === 'preparing'} aria-disabled={repair === 'asking' || undefined} onClick={() => void repairTools()}>
      {kind === 'quiet' && <RefreshCw aria-hidden="true" />}
      {text}
    </button>
  );

  // Conflicts are listed with their actions, so their diagnostic copies are skipped. The counts match the status bar's.
  const listedDiagnostics = snap.diagnostics.filter((d) => d.code !== 'CONFLICT');
  const errors = listedDiagnostics.filter((d) => d.severity === 'error');
  const warnings = listedDiagnostics.filter((d) => d.severity === 'warning');
  const notes = listedDiagnostics.filter((d) => d.severity === 'info');
  const toolsFailed = runtime.state === 'error';
  const pageFailed = !!pageIssue && runtime.state === 'ready';
  const starting = !toolsFailed && (phase === 'starting' || phase === 'opening');
  // The website tools' own state (the page loading is the summary's to say).
  const toolsBusy = runtime.state === 'preparing' || runtime.state === 'starting';
  const failure = snap.saveFailure ? saveFailureNotice(snap.saveFailure) : null;
  const problems = errors.length + snap.conflicts.length + (toolsFailed || pageFailed ? 1 : 0) + (failure ? 1 : 0);
  const updates = snap.themeUpdates?.available ?? [];
  const kept = snap.themeUpdates?.kept ?? [];
  const saved = snap.savedCopies ?? [];
  const tone = problems ? 'danger' : warnings.length ? 'warn' : starting ? 'busy' : 'ok';
  const seoFindings = seoAudit?.ok ? seoAudit.findings : [];
  const seoDue = seoFindings.filter(needsFixing);
  // With nothing else to fix, what the SEO audit asks for is said too: the project checking out is not the website being ready.
  const seoLine = seoDue.length ? ` Search & AI readiness has ${seoCountsText(seoDue)} worth fixing before you publish.` : '';
  const headline = problems
    ? `${plural(problems, 'problem')}${warnings.length ? ` and ${plural(warnings.length, 'warning')}` : ''}`
    : warnings.length
      ? plural(warnings.length, 'warning')
      : starting
        ? 'No problems so far'
        : seoDue.length
          ? 'No problems in the project'
          : 'No problems found';
  const guidance = problems
    ? warnings.length
      ? `Fix the ${problems === 1 ? 'problem' : 'problems'} first, then check the warnings.`
      : problems === 1
        ? 'Below is what happened and how to fix it.'
        : 'Each one says what happened and how to fix it.'
    : warnings.length
      ? seoDue.length
        ? `Worth checking before you publish, as are ${seoCountsText(seoDue)} in Search & AI readiness.`
        : 'Worth checking before you publish.'
      : starting
        ? 'The preview is still starting. This list updates once it’s running.'
        : phase === 'unavailable'
          ? `Nothing in the project needs fixing, but the preview can’t run here: ${runtime.state === 'unavailable' ? runtime.message : ''}${seoLine}`
          : phase === 'stopped'
            ? `Nothing in the project needs fixing. The preview is paused; it starts again when you edit a page.${seoLine}`
            : seoLine
              ? `Every page, component and style in this project checks out.${seoLine}`
              : updates.length || saved.length
          ? `Nothing needs fixing. Everything below is optional${notes.length ? ', or for your information' : ''}.`
          : notes.length
            ? `Nothing needs fixing. ${notes.length === 1 ? 'A note below is' : 'The notes below are'} for your information.`
            : 'Every page, component and style in this project checks out.';
  // With several kinds of item listed, the summary also leads to each list.
  const jumps = [
    { key: 'problems', label: 'Problems', count: problems, tone: 'danger' },
    { key: 'warnings', label: 'Warnings', count: warnings.length, tone: 'warn' },
    { key: 'notes', label: 'Notes', count: notes.length, tone: 'quiet' },
    // What needs fixing is counted while there is any; the notes are counted only when they are all there is.
    { key: 'seo', label: 'Search & AI', count: seoDue.length || seoFindings.length, tone: seoDue.length ? 'warn' : 'quiet' },
    { key: 'updates', label: 'Updates', count: updates.length, tone: 'quiet' },
    { key: 'saved', label: 'Saved copies', count: saved.length, tone: 'quiet' }
  ].filter((j) => j.count > 0);
  const jumpTo = (key: string) => {
    const heading = bodyRef.current?.querySelector<HTMLElement>(`[data-group="${key}"] h3`);
    heading?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    heading?.focus({ preventScroll: true });
  };

  /** The element an item's row would show on the page: only when nothing else (Assets, the outline, a setting) fixes it. */
  const elementOf = (d: Diagnostic): ElementRef | null => {
    if (d.code === 'ASSET_FILE_MISSING' && d.owner?.kind === 'asset') return null;
    if (d.code.startsWith('HEADING_') && d.owner?.kind === 'page') return null;
    if (destinationForDiagnostic(st, d) ?? seoDestinations.get(diagnosticKey(d))) return null;
    return diagnosticTarget(st, d);
  };
  const diagnosticRow = (d: Diagnostic, i: number, rest?: string) => {
    // An image whose files are missing keeps its uses: say how many, and open it where it can be fixed. One too large
    // to make copies of is opened there too, to be replaced everywhere.
    const missing = d.code === 'ASSET_FILE_MISSING';
    const asset = (missing || d.code === 'ASSET_PIXEL_LIMIT') && d.owner?.kind === 'asset' ? d.owner.id : null;
    const uses = asset ? (snap.assetUsage[asset] ?? 0) : 0;
    // A page's heading outline is reviewed (and fixed) in its outline, beside the page.
    const outlinePage = d.code.startsWith('HEADING_') && d.owner?.kind === 'page' ? d.owner.id : null;
    // A page with nothing on it has no element to show: the page itself is opened.
    const blankPage = d.code === 'PAGE_EMPTY' && d.owner?.kind === 'page' ? d.owner.id : null;
    // A form's settings or a site setting: opened where it is fixed, as an export's notes do.
    const dest = asset || outlinePage ? null : (destinationForDiagnostic(st, d) ?? seoDestinations.get(diagnosticKey(d)) ?? null);
    const target = asset || outlinePage || dest ? null : diagnosticTarget(st, d);
    const lead = rest === undefined ? assetLead(st, d) : null;
    return (
      <HealthRow
        key={`${d.code}:${d.owner?.id ?? ''}:${d.nodeId ?? ''}:${i}`}
        tone={d.severity === 'error' ? 'danger' : d.severity === 'warning' ? 'warn' : 'quiet'}
        icon={d.severity === 'error' ? <CircleAlert /> : d.severity === 'warning' ? <TriangleAlert /> : <Info />}
        actions={
          asset ? (
            <button className="btn btn-sm" onClick={() => openAsset(asset)}>
              Open in Assets
            </button>
          ) : outlinePage ? (
            <button className="btn btn-sm" onClick={() => showHeadings(outlinePage, d)}>
              Show headings
            </button>
          ) : blankPage ? (
            <button className="btn btn-sm" onClick={() => showPage(blankPage)}>
              Open page
            </button>
          ) : dest ? (
            <button className="btn btn-sm" onClick={() => openEditorDestination(dest)}>
              {destinationLabel(dest)}
            </button>
          ) : target ? (
            <button className="btn btn-sm" onClick={() => showElement(target)}>
              Show on page
            </button>
          ) : undefined
        }
      >
        {rest !== undefined ? (
          rest
        ) : lead ? (
          <>
            <strong>{lead.lead}</strong>
            {lead.rest}
          </>
        ) : (
          d.message
        )}
        {asset && missing && <> {uses ? `It is used ${uses === 1 ? 'once' : uses === 2 ? 'twice' : `${uses} times`}, and every use is kept.` : 'Nothing uses it.'}</>}
      </HealthRow>
    );
  };
  /**
   * The same item said about several elements of one page (three sections' "Start a project" buttons, say): one row,
   * with the sections it is in, each leading to its own element. Read as one thing to fix in several places, not as
   * several things.
   */
  const repeatedRow = (items: { d: Diagnostic; i: number }[], rest?: string) => {
    const first = items[0].d;
    const targets = items.map(({ d }) => elementOf(d)!);
    const rowId = `${recoveryNote}-r${items[0].i}`;
    const names = targets.map((t) => {
      const crumbs = breadcrumb(st, t!);
      return (crumbs[1] ?? crumbs[crumbs.length - 1]).label;
    });
    // Sections with the same name are told apart by their order on the page.
    const labels = names.map((n, k) => (names.filter((m) => m === n).length > 1 ? `${n} ${names.slice(0, k + 1).filter((m) => m === n).length}` : n));
    return (
      <HealthRow
        key={`${first.code}:${first.owner?.id ?? ''}:${items[0].i}:x${items.length}`}
        tone={first.severity === 'error' ? 'danger' : first.severity === 'warning' ? 'warn' : 'quiet'}
        icon={first.severity === 'error' ? <CircleAlert /> : first.severity === 'warning' ? <TriangleAlert /> : <Info />}
        details={
          <div className="health-places" role="group" aria-labelledby={`${rowId} ${rowId}-p`}>
            <span className="health-places-label" id={`${rowId}-p`}>
              In {items.length} places
            </span>
            {targets.map((t, k) => (
              <button key={k} className="btn btn-sm" aria-label={`Show ${labels[k]} on the page`} onClick={() => showElement(t!)}>
                {labels[k]}
              </button>
            ))}
          </div>
        }
      >
        <span id={rowId}>{rest ?? first.message}</span>
      </HealthRow>
    );
  };
  /** Items in their order, those saying exactly the same thing collected into one row. */
  const collected = (entries: { d: Diagnostic; i: number; rest?: string }[]) => {
    const groups = new Map<string, { d: Diagnostic; i: number; rest?: string }[]>();
    for (const e of entries) {
      const key = `${e.d.code}\n${e.d.owner?.kind ?? ''}:${e.d.owner?.id ?? ''}\n${e.rest ?? e.d.message}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    // Collected only when every one leads to an element; anything else is listed as it is, one row each. Several said
    // about the same element are one place, so the row offers one way to each element.
    return [...groups.values()].flatMap((g) => {
      if (g.length < 2 || !g.every((e) => elementOf(e.d))) return g.map((e) => diagnosticRow(e.d, e.i, e.rest));
      const seen = new Set<string>();
      const places = g.filter((e) => {
        const key = refKey(elementOf(e.d)!);
        return !seen.has(key) && !!seen.add(key);
      });
      return [places.length > 1 ? repeatedRow(places, g[0].rest) : diagnosticRow(g[0].d, g[0].i, g[0].rest)];
    });
  };
  /** A severity's items, with those about one page or component listed together under its name. */
  const diagnosticRows = (list: Diagnostic[], keyPrefix: string) => {
    const places = new Map<string, { kind: 'page' | 'component'; name: string; entries: { d: Diagnostic; i: number; rest?: string }[] }>();
    const out: Array<{ d: Diagnostic; i: number } | string> = [];
    list.forEach((d, i) => {
      const place = diagnosticPlace(st, d);
      if (!place) return out.push({ d, i });
      const key = `${place.kind}:${place.id}`;
      if (!places.has(key)) {
        places.set(key, { kind: place.kind, name: place.name, entries: [] });
        out.push(key);
      }
      places.get(key)!.entries.push({ d, i, rest: place.rest });
    });
    // Standalone items are collected too, each run of them between the places in its own order.
    const rendered: ReactNode[] = [];
    let loose: { d: Diagnostic; i: number }[] = [];
    const flush = () => (rendered.push(...collected(loose)), (loose = []));
    for (const item of out) {
      if (typeof item !== 'string') {
        loose.push(item);
        continue;
      }
      flush();
      rendered.push(placeGroup(item));
    }
    flush();
    return rendered;
    function placeGroup(item: string) {
      const p = places.get(item)!;
      return (
        <li key={`${keyPrefix}:${item}`} className="health-place">
          <h4>
            {p.kind === 'page' ? <FileText aria-hidden="true" /> : <Component aria-hidden="true" />}
            {p.kind === 'page' ? `${p.name} page` : `${p.name} component`}
          </h4>
          <ul>{collected(p.entries)}</ul>
        </li>
      );
    }
  };

  return (
    <Modal
      title="Project health"
      icon={<Stethoscope />}
      onClose={() => close()}
      wide={problems + warnings.length + notes.length + updates.length + saved.length + seoFindings.length > 0}
      footer={
        <button className="btn" onClick={() => close()}>
          Close
        </button>
      }
    >
      <div className="health-body" ref={bodyRef}>
        <div ref={summaryRef} className={`health-summary ${tone}`} tabIndex={-1} data-autofocus={!atSeo || undefined}>
          <span className="health-badge" aria-hidden="true">
            {tone === 'danger' ? <CircleAlert /> : tone === 'warn' ? <TriangleAlert /> : tone === 'busy' ? <Spinner decorative /> : <CircleCheck />}
          </span>
          <div className="health-summary-text">
            <p>
              <strong>{headline}</strong>
              <span>
                {guidance}
                {status && ` ${status}`}
              </span>
            </p>
            {(jumps.length > 1 || jumps[0]?.key === 'seo') && (
              <div className="health-jumps" role="group" aria-label="Go to">
                {jumps.map((j) => (
                  <button key={j.key} className={`health-jump ${j.tone}`} onClick={() => jumpTo(j.key)}>
                    {j.tone === 'danger' ? <CircleAlert aria-hidden="true" /> : j.tone === 'warn' ? <TriangleAlert aria-hidden="true" /> : null}
                    {j.label}
                    <span className="health-jump-count">{j.count}</span>
                    <ArrowDown className="health-jump-go" aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <span className="sr-only" role="status">
          {status}
        </span>
        <span className="sr-only" role="status">
          {previewNews}
        </span>
        {snap.readOnly && (
          <div className="scope-note site health-callout">
            <Lock />
            <span className="grow">
              <strong>Read-only.</strong> {snap.readOnly.reason}
            </span>
            {snap.readOnly.canUnlock && (
              <button className="btn btn-sm" onClick={() => void unlock()}>
                Unlock…
              </button>
            )}
          </div>
        )}
        {problems > 0 && (
          <HealthGroup title="Problems" count={problems} tone="danger" anchor="problems">
            {/* First: until a save succeeds again, the project on disk is behind what the editor shows. */}
            {failure && (
              <HealthRow tone="danger" icon={<CircleAlert />} details={snap.saveFailure!.kind === 'failed' ? <ErrorDetails text={snap.saveFailure!.message} /> : undefined}>
                <strong>{failure.what}</strong> {failure.next}
              </HealthRow>
            )}
            {toolsFailed && (
              <HealthRow
                tone="danger"
                icon={<CircleAlert />}
                actions={!readOnly ? reinstall('Reinstall website tools', 'primary') : undefined}
                details={
                  <>
                    {runtime.detail || runtime.message ? <ErrorDetails text={runtime.detail || runtime.message} /> : null}
                    {!readOnly && repairFailed}
                  </>
                }
              >
                <strong>The preview couldn’t start.</strong> {readOnly ? 'The error details show what went wrong.' : 'Reinstalling the website tools may help. If it doesn’t, the error details show what went wrong.'}
              </HealthRow>
            )}
            {pageFailed && (
              <HealthRow tone="danger" icon={<CircleAlert />} details={<ErrorDetails text={pageIssue!} />}>
                <strong>This page couldn’t be previewed.</strong> Something on it failed to show. {readOnly ? 'The error details show what went wrong.' : 'Undo your last change, or choose Try again on the preview.'}
              </HealthRow>
            )}
            {diagnosticRows(errors, 'e')}
            {/* Conflicts come after the problems that stand alone: each is a decision, and they take more room. */}
            {snap.conflicts.length > 0 && (
              <li className="health-place">
                <h4>
                  <FileDiff aria-hidden="true" />
                  {snap.conflicts.length === 1 ? 'A file changed in two places' : `${snap.conflicts.length} files changed in two places`}
                </h4>
                <p className="health-place-note" id={recoveryNote}>
                  <Archive aria-hidden="true" />
                  {readOnly ? 'Once the project is editable, choose a version of each to carry on editing.' : 'Choose a version of each to carry on editing.'} The one not used is kept under Saved copies.
                </p>
                <ul>
                  {snap.conflicts.map((c) => (
                    <ConflictRow
                      // A deleted code component's file that turns into a changed one (or back) is a new decision: what was compared goes.
                      key={`${c.path}:${c.deletedCode ? 'deleted' : 'changed'}`}
                      conflict={c}
                      state={st}
                      dir={snap.dir}
                      busy={!!busy}
                      settling={busy === c.path}
                      readOnly={readOnly}
                      canUnlock={!!snap.readOnly?.canUnlock}
                      codeEnabled={codeEnabled}
                      recoveryNote={recoveryNote}
                      onResolve={(choice, check, onRefused) => void resolve(c.path, choice, check, onRefused)}
                    />
                  ))}
                </ul>
              </li>
            )}
          </HealthGroup>
        )}
        {warnings.length > 0 && (
          <HealthGroup title="Warnings" count={warnings.length} tone="warn" anchor="warnings">
            {diagnosticRows(warnings, 'w')}
          </HealthGroup>
        )}
        {notes.length > 0 && (
          <HealthGroup title="Notes" count={notes.length} tone="quiet" anchor="notes">
            {diagnosticRows(notes, 'n')}
          </HealthGroup>
        )}
        {seoAudit && projectState && <SeoReadiness audit={seoAudit} state={projectState} focusOnOpen={atSeo} />}
        {updates.length > 0 && (
          <HealthGroup title="Updates" count={updates.length} tone="quiet" anchor="updates">
            <HealthRow
              tone="quiet"
              icon={<RefreshCw />}
              actions={
                readOnly ? undefined : (
                  // Held, not disabled, while busy: focus stays on it.
                  <button className="btn btn-sm" aria-disabled={!!busy || undefined} disabled={!!snap.conflicts.length} onClick={() => !busy && void updateTheme()}>
                    Update {plural(updates.length, 'component')}
                  </button>
                )
              }
              details={
                <Disclosure label={kept.length ? `See which components (${kept.length} more can’t be updated)` : 'See which components'}>
                  <dl className="health-terms">
                    <dt>Will update</dt>
                    <dd>{updates.map((u) => u.name).join(', ')}</dd>
                    {kept.length > 0 && (
                      <>
                        <dt>{kept.length === 1 ? 'Stays as it is' : 'Stay as they are'}</dt>
                        {kept.map((k) => (
                          <dd key={k.id}>
                            <strong>{k.name}.</strong> {keptReason(k.reason)}
                          </dd>
                        ))}
                      </>
                    )}
                  </dl>
                </Disclosure>
              }
            >
              <strong>
                {updates.length} theme component{updates.length === 1 ? ' has' : 's have'} an update.
              </strong>{' '}
              {readOnly ? `${updates.length === 1 ? 'It' : 'They'} can be updated once the project is editable.` : 'Your content and changes stay. Components you copied and edited are not touched, and you can undo this.'}
              {!!snap.conflicts.length && !readOnly && <span className="health-hint">Settle the file conflicts above to update.</span>}
            </HealthRow>
          </HealthGroup>
        )}
        {/* Kept mounted with no copies: one just taken off the list keeps its Undo in its place. */}
        <SavedCopies copies={saved} state={st} dir={snap.dir} readOnly={readOnly} />
        {!toolsFailed && (
          <HealthGroup title="Website tools" tone="quiet">
            <HealthRow
              tone="quiet"
              icon={toolsBusy ? <Spinner decorative /> : <Wrench />}
              actions={!readOnly && runtime.state !== 'unavailable' && !toolsBusy ? reinstall('Reinstall', 'quiet') : undefined}
              details={!readOnly && repair && repair !== 'asking' ? repairFailed : undefined}
            >
              <strong>{runtime.state === 'ready' ? 'Ready' : label}.</strong>{' '}
              {toolsBusy ? 'This can take a minute.' : runtime.state === 'unavailable' ? runtime.message : readOnly ? 'The website tools are set up inside this project folder.' : 'The website tools are set up inside this project folder. Reinstall them if the preview won’t start.'}
            </HealthRow>
          </HealthGroup>
        )}
        {/* Outside the tools' group: a package whose setup failed keeps the controls that can take it out again. */}
        {codeEnabled && !isRemoteOpening(snap.workspaceKey) && <PackagesGroup opening={snap.workspaceKey} readOnly={readOnly} />}
      </div>
    </Modal>
  );
}

/**
 * The project's npm packages (#1480), in Developer mode: the ones its code components may import, each with the
 * version set up in the website tools, and those tools themselves, which stay as they are. A package is added by name
 * (with a version if wanted), updated to its latest version, or removed; each change sets the website tools up again
 * for it, which the group says while it runs.
 */
function PackagesGroup({ opening, readOnly }: { opening: string; readOnly: boolean }) {
  const [list, setList] = useState<ProjectPackages | null>(null);
  // Why the list couldn't be read: never shown as a project with no packages.
  const [unread, setUnread] = useState<string | null>(null);
  const [spec, setSpec] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // What is being changed now, as the group says it: one change at a time.
  const [working, setWorking] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const runtimeState = useStore((s) => s.runtime.state);
  const inputId = useId();
  const asked = useRef(0);
  const load = () => {
    const ask = ++asked.current;
    return api.project.packages().then(
      (r) => {
        if (ask !== asked.current) return;
        setList(r);
        setUnread(null);
      },
      (e: Error) => {
        if (ask !== asked.current) return;
        setList(null);
        setUnread(`The project’s packages couldn’t be read: ${e.message || String(e)}`);
      }
    );
  };
  // Read again as the tools finish being set up, so the versions shown are the ones the preview runs.
  useEffect(() => void load(), [opening, runtimeState]);
  /** Make a change; `typed` when it is what was typed to add, which goes once it is made. */
  const change = async (c: PackageChange, doing: string, typed = false) => {
    if (working) return;
    setWorking(doing);
    setResult(null);
    try {
      const r = await api.project.changePackage(c, opening);
      setResult({ ok: r.ok, message: r.message ?? (r.ok ? 'Done.' : 'Nothing was changed.') });
      if (r.ok && typed) setSpec('');
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message || String(e) });
    } finally {
      setWorking(null);
      await load();
      // A removed package's row goes with the button that removed it: focus moves to adding one, never to nowhere.
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (!at || at === document.body || !at.isConnected) inputRef.current?.focus();
      });
    }
  };
  const own = list?.packages.filter((p) => !p.tool) ?? [];
  const tools = list?.packages.filter((p) => p.tool) ?? [];
  const changeable = !readOnly && !!list && !list.locked;
  const held = !!working || undefined;
  return (
    <HealthGroup title="Packages" tone="quiet" anchor="packages" note="Code components can import these npm packages and their parts, such as searchsocket/svelte. Code the assistant writes can’t.">
      {own.map((p) => (
        <HealthRow
          key={p.name}
          tone="quiet"
          icon={<Package />}
          actions={
            changeable ? (
              // Held, not disabled, while a change runs: focus stays on it.
              <>
                <button className="btn btn-sm btn-ghost" aria-disabled={held} onClick={() => void change({ add: `${p.name}@latest` }, `Updating “${p.name}”…`)}>
                  Update
                </button>
                <button className="btn btn-sm btn-ghost" aria-disabled={held} onClick={() => void change({ remove: p.name }, `Removing “${p.name}”…`)}>
                  Remove
                </button>
              </>
            ) : undefined
          }
        >
          <strong>{p.name}</strong> {p.installed ?? <span className="health-hint">{p.wanted ? `${p.wanted}, not set up yet` : 'Not set up yet'}</span>}
        </HealthRow>
      ))}
      {unread && (
        <HealthRow tone="danger" icon={<CircleAlert />}>
          {unread}
        </HealthRow>
      )}
      {list && !own.length && (
        <HealthRow tone="quiet" icon={<Package />}>
          No packages yet. Add one to import it in a code component.
        </HealthRow>
      )}
      {changeable && (
        <li className="health-row quiet">
          <span className="health-icon">{working ? <Spinner decorative /> : <Package />}</span>
          <form
            className="health-text packages-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (spec.trim()) void change({ add: spec.trim() }, `Adding “${spec.trim()}”…`, true);
            }}
          >
            <label className="field-label" htmlFor={inputId}>
              Add a package
            </label>
            <span className="packages-add-row">
              <input ref={inputRef} id={inputId} className="input sm mono" value={spec} placeholder="zod or zod@4.1.0" spellCheck={false} autoCapitalize="off" autoComplete="off" onChange={(e) => setSpec(e.target.value)} />
              <button type="submit" className="btn btn-sm" aria-disabled={held || !spec.trim() || undefined}>
                Add
              </button>
            </span>
          </form>
        </li>
      )}
      <li className="sr-only" role="status">
        {working ? `${working} This can take a minute.` : (result?.message ?? unread)}
      </li>
      {(working || result) && (
        <HealthRow tone={!working && result && !result.ok ? 'danger' : 'quiet'} icon={working ? <Spinner decorative /> : result?.ok ? <Check /> : <CircleAlert />}>
          {working ? `${working} The website tools are set up again for it, which can take a minute.` : result?.message}
        </HealthRow>
      )}
      {list?.locked && !readOnly && (
        <HealthRow tone="quiet" icon={<Lock />}>
          {list.locked}
        </HealthRow>
      )}
      {tools.length > 0 && (
        <HealthRow tone="quiet" icon={<Wrench />}>
          <strong>Website tools.</strong> {tools.map((t) => `${t.name} ${t.installed ?? t.wanted}`).join(', ')}. These stay at the versions the site was made with.
        </HealthRow>
      )}
    </HealthGroup>
  );
}

/** Why a version of a file is not shown as text. */
const NOT_SHOWN: Record<Exclude<FileContent['state'], 'text'>, string> = {
  missing: 'There is no file.',
  binary: 'This file is not text (a font or an image, say), so it can’t be shown here.',
  'too-large': 'This file is too large to show here.',
  unreadable: 'This file can’t be read.'
};

/** How far a line is indented, in character widths (a tab is two, as code is shown), so a wrapped line hangs under it. */
const indentOf = (line: string) => [...(/^[\t ]*/.exec(line)?.[0] ?? '')].reduce((n, ch) => n + (ch === '\t' ? 2 : 1), 0);

/**
 * One version of a file, as read-only text, or why it is not shown. Given the version it is compared with, the lines
 * that differ are marked (a bar and a tint), the places where the other has lines this one lacks get a rule, the
 * caption says which, and the first is scrolled into view. Alone (a saved copy), the caption counts its lines.
 */
function VersionText({ label, version, against, versus }: { label: string; version: FileContent | undefined; against?: FileContent; versus?: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const labelId = useId();
  const text = version?.state === 'text' ? version.text : null;
  const other = against?.state === 'text' ? against.text : null;
  const diff = useMemo(() => (text !== null && other !== null ? lineDiff(text, other) : null), [text, other]);
  const lines = useMemo(() => (text === null ? [] : text.split('\n')), [text]);
  // Where each difference starts: a run of changed lines, or a place where the other version has lines this one lacks.
  const starts = useMemo(() => (diff ? [...new Set([...[...diff.changed].filter((i) => !diff.changed.has(i - 1)), ...[...diff.gaps].map((i) => Math.min(i, lines.length - 1))])].sort((x, y) => x - y) : []), [diff, lines.length]);
  const marks = () => [...(preRef.current?.querySelectorAll<HTMLElement>('[data-diff-start]') ?? [])];
  const scrollTo = (line: HTMLElement) => preRef.current && (preRef.current.scrollTop = Math.max(0, line.offsetTop - 2 * line.offsetHeight));
  useLayoutEffect(() => {
    const first = marks()[0];
    if (first) scrollTo(first);
  }, [diff]);
  // For a file changed in several places: the difference shown, stepped through in order and round to the first after
  // the last (one near the end may not scroll any further, so the step is counted, not read from the scroll).
  const [at, setAt] = useState(0);
  useEffect(() => setAt(0), [diff]);
  const next = () => {
    const all = marks();
    if (!all.length) return;
    const to = (at + 1) % all.length;
    setAt(to);
    scrollTo(all[to]);
  };
  const count = diff ? diffCaption(diff, versus) : text !== null && !against ? plural(lines.length, 'line') : null;
  return (
    <figure className="version-pane">
      <figcaption>
        <span id={labelId}>{label}</span>
        {count && (
          <span className="version-count">
            {count}
            {starts.length > 1 && (
              <button className="version-next" aria-describedby={labelId} onClick={next}>
                Next difference
                <span className="version-step">
                  ({at + 1} of {starts.length})
                </span>
                <ArrowDown aria-hidden="true" />
              </button>
            )}
          </span>
        )}
      </figcaption>
      {text !== null ? (
        <pre ref={preRef} className="code-view" tabIndex={0} role="group" aria-labelledby={labelId}>
          {lines.map((line, i) => {
            const changed = diff?.changed.has(i);
            const gap = diff?.gaps.has(i) ? ' gap-before' : i === lines.length - 1 && diff?.gaps.has(lines.length) ? ' gap-after' : '';
            return (
              <span key={i} className={`version-line${changed ? ' changed' : ''}${gap}`} data-diff-start={starts.includes(i) || undefined} style={{ '--indent': `${indentOf(line)}ch` } as CSSProperties}>
                {gap === ' gap-before' && <span className="sr-only">Lines only in the other version go here. </span>}
                {changed && <span className="sr-only">Changed: </span>}
                {line || ' '}
                {gap === ' gap-after' && <span className="sr-only"> Lines only in the other version follow.</span>}
              </span>
            );
          })}
        </pre>
      ) : (
        <p className="version-missing">{version ? NOT_SHOWN[version.state as Exclude<FileContent['state'], 'text'>] : 'This file can’t be read.'}</p>
      )}
    </figure>
  );
}

/** What a choice is doing while it runs, said on its button. */
const RUNNING: Record<ConflictChoice, string> = { keep: 'Keeping the file on disk…', restore: 'Putting back SiteOrigin Builder’s version…', convert: 'Converting…', remove: 'Removing…' };

/** A code component whose file was deleted outside the app, still in the project (#1540), with how many placements it has. */
function deletedCodeOf(state: ProjectState, c: ProjectSnapshot['conflicts'][number]): { name: string; placements: number } | null {
  const id = c.deletedCode?.definitionId;
  const def = id && Object.hasOwn(state.components, id) ? state.components[id] : undefined;
  return def && def.sourcePath === c.path ? { name: def.name, placements: instancesOf(state, def.id).length } : null;
}

/**
 * A file in conflict: what it is and what happened, then each choice beside what it does and where the other version
 * goes. Compared, each version sits in the card of the choice that uses it, with the lines that differ marked. Both
 * choices weigh the same: whichever version is not used is kept under Saved copies. A conflict an AI request's
 * rollback left also shows what the request tried to save, for inspection only; it is kept under Saved copies too.
 */
function ConflictRow({
  conflict: c,
  state,
  dir,
  busy,
  settling,
  readOnly,
  canUnlock,
  codeEnabled,
  recoveryNote,
  onResolve
}: {
  conflict: ProjectSnapshot['conflicts'][number];
  state: ProjectState;
  dir: string;
  busy: boolean;
  /** This row's choice is the one running. */
  settling: boolean;
  readOnly: boolean;
  canUnlock: boolean;
  /** Developer mode: a design's edited file can become a code component only with it on. */
  codeEnabled: boolean;
  /** The band's line saying the version not used is kept: every choice is described by it too. */
  recoveryNote: string;
  onResolve: (choice: ConflictChoice, check?: () => Promise<false | { expect?: string }>, onRefused?: (message: string) => void) => void;
}) {
  // An older snapshot without a kind: generated conflicts were the ones whose reason says so.
  const kind = c.kind ?? (c.reason.startsWith('Generated') ? 'generated' : 'canonical');
  const [versions, setVersions] = useState<ConflictVersions | 'loading' | null>(null);
  // Only the latest request's reply is shown; hiding the versions drops one still on its way.
  const asked = useRef(0);
  const subject = conflictSubject(state, c.path);
  const ids = useId();
  // Why the edited file did not become a code component, said beside that choice until another is made.
  const [refused, setRefused] = useState<string | null>(null);
  const compareRef = useRef<HTMLButtonElement>(null);
  // The versions were shown but couldn't be read again before a choice: say so here, and choose nothing.
  const [recheck, setRecheck] = useState(false);
  // The choice pressed, said on its button while it runs.
  const [pending, setPending] = useState<ConflictChoice | null>(null);
  useEffect(() => {
    if (!busy) setPending(null);
  }, [busy]);
  const load = async () => {
    const ask = ++asked.current;
    setRecheck(false);
    setVersions('loading');
    const r = await api.project.compareConflict(c.path).catch((e: Error) => ({ ok: false as const, message: e.message, builder: undefined, disk: undefined, attempted: undefined }));
    if (ask !== asked.current) return;
    if (!r.ok) {
      setVersions(null);
      return toast(r.message ?? 'The versions could not be read.', 'error');
    }
    setVersions(shownVersions(r));
  };
  const compare = () => {
    // Held while this row's choice is checked against the versions shown, and while the versions are being read.
    if (settling || versions === 'loading') return;
    if (!versions) return void load();
    ++asked.current;
    setRecheck(false);
    setVersions(null);
  };
  // Choices wait for versions still loading. With the versions shown, a choice is made against them: they are read
  // again first (the dialog held meanwhile), and one that changed, or can't be read, is shown and nothing is chosen.
  const held = busy || versions === 'loading';
  const choose = (choice: ConflictChoice) => {
    if (held) return;
    setRefused(null);
    setPending(choice);
    const onRefused = choice === 'convert' ? setRefused : undefined;
    const shown = versions;
    if (!shown) return onResolve(choice, undefined, onRefused);
    const check = async (): Promise<false | { expect?: string }> => {
      const ask = ++asked.current;
      const opening = getState().snapshot?.workspaceKey;
      const r = await api.project.compareConflict(c.path).catch(() => null);
      // Only for the project it was asked in, and only the latest ask.
      if (ask !== asked.current || getState().snapshot?.workspaceKey !== opening) return false;
      if (!r?.ok) {
        setRecheck(true);
        return false;
      }
      if (!sameVersions(shown, shownVersions(r))) {
        setVersions(shownVersions(r));
        toast('The file changed since you compared the versions. Look again, then choose.', 'info');
        return false;
      }
      setRecheck(false);
      // A conversion takes exactly the file compared: read again just before, any other bytes there are refused.
      return choice === 'convert' && shown.disk?.state === 'text' ? { expect: await textDigest(shown.disk.text) } : {};
    };
    onResolve(choice, check, onRefused);
  };
  const shown = versions && versions !== 'loading' ? versions : null;
  const panes = shown ? conflictPanes(kind, shown) : [];
  /** A version, compared with the one it would replace (the other choice's), its differing lines marked. */
  const pane = (key: 'builder' | 'disk' | 'attempted') => {
    const p = panes.find((x) => x.key === key);
    if (!p) return null;
    if (key === 'attempted') return <VersionText label={p.label} version={p.version} against={shown?.builder} versus="SiteOrigin Builder’s version" />;
    return <VersionText label={p.label} version={p.version} against={key === 'disk' ? shown?.builder : shown?.disk} />;
  };
  // Where the version not used goes, said only when there is one: a file deleted outside leaves nothing to keep.
  const diskGoes = shown?.disk?.state === 'missing' ? ' There’s no edited file on disk to save.' : ' The edited file goes to Saved copies.';
  // Known only once compared: the file was deleted outside, so keeping "the file on disk" keeps it deleted.
  const diskDeleted = shown?.disk?.state === 'missing';
  const keepDoes = c.builderMissing
    ? 'Adds the file to the project as it is now.'
    : diskDeleted
      ? 'The file was deleted outside SiteOrigin Builder, and this keeps it deleted. SiteOrigin Builder’s version goes to Saved copies.'
      : 'Uses the file as it was edited outside SiteOrigin Builder. SiteOrigin Builder’s version goes to Saved copies.';
  const restoreDoes =
    kind === 'generated'
      ? c.builderMissing
        ? `Removes the file, which your pages no longer make.${diskGoes}`
        : `Makes the file again from your pages.${diskGoes} To keep a change, make it in the page or in a code component.`
      : c.builderMissing
        ? `Removes the file, which SiteOrigin Builder’s version doesn’t have.${diskGoes}`
        : `${c.aiRun ? 'Uses the version from before the AI request.' : 'Puts back the version you had in SiteOrigin Builder.'}${diskGoes}`;
  // A code component's file deleted outside the app (#1540): put back, or the component removed with its placements.
  const deleted = deletedCodeOf(state, c);
  const removeLabel = deleted ? (deleted.placements ? `Remove ${deleted.name} and its ${deleted.placements === 1 ? 'placement' : `${deleted.placements} placements`}` : `Remove ${deleted.name}`) : '';
  const button = (choice: ConflictChoice, label: string, unavailable = false) => (
    // Held, not disabled, while a choice is being made: focus stays where it was.
    <button className="btn btn-sm" aria-disabled={held || unavailable || undefined} aria-describedby={`${ids}-${choice}`} onClick={() => !unavailable && choose(choice)}>
      {settling && pending === choice ? (
        <>
          <Spinner decorative />
          {RUNNING[choice]}
        </>
      ) : (
        label
      )}
    </button>
  );
  return (
    <HealthRow
      tone="danger"
      icon={<CircleAlert />}
      actions={
        <>
          <button ref={compareRef} className="btn btn-sm btn-ghost" aria-expanded={!!shown} aria-disabled={settling || versions === 'loading' || undefined} onClick={() => void compare()}>
            {versions === 'loading' ? <Spinner decorative /> : <DisclosureMark />}
            {versions === 'loading' ? 'Reading versions…' : shown ? 'Hide versions' : 'Compare versions'}
          </button>
          {/* A file that is gone is shown by its folder. */}
          <button className="btn btn-sm btn-ghost" onClick={() => void api.projects.reveal(`${dir}/${deleted ? c.path.slice(0, c.path.lastIndexOf('/')) : c.path}`)}>
            <FolderOpen aria-hidden="true" />
            Show in folder
          </button>
        </>
      }
      details={
        <>
          {/* The path runs the row's full width, under the actions, so a long one wraps less. */}
          <span className="health-path">{c.path}</span>
          {recheck && (
            <p className="health-hint health-recheck" role="status">
              The versions couldn’t be read again to check they haven’t changed.{' '}
              <button
                className="btn btn-sm"
                onClick={() => {
                  // This note goes once the versions are read again: carry on from the row's Compare control.
                  compareRef.current?.focus();
                  void load();
                }}
              >
                Compare again
              </button>
            </p>
          )}
          {readOnly ? (
            <>
              {shown && (
                <div className="versions">
                  {kind === 'generated' ? pane('builder') : pane('disk')}
                  {kind === 'generated' ? pane('disk') : pane('builder')}
                  {pane('attempted')}
                </div>
              )}
              <p className="health-hint">{canUnlock ? 'Unlock the project to choose a version.' : 'A version can be chosen once the project is editable.'}</p>
            </>
          ) : (
            <>
              <div className={`health-choices${shown ? ' compared' : ''}`} role="group" aria-label={deleted ? `Put back the ${subject}, or remove ${deleted.name}` : kind === 'generated' ? (c.convert ? `Restore or convert the ${subject}` : `Restore the ${subject}`) : `Choose a version of the ${subject}`} aria-describedby={deleted ? undefined : recoveryNote}>
                {deleted ? (
                  <>
                    <div className="health-choice">
                      {pane('builder')}
                      {button('restore', 'Put the file back')}
                      <span id={`${ids}-restore`}>Puts back the code SiteOrigin Builder last loaded for {deleted.name}.</span>
                    </div>
                    <div className="health-choice">
                      {button('remove', removeLabel)}
                      <span id={`${ids}-remove`}>{deleted.placements ? `Removes ${deleted.name} from the project, with everything in its placements. Undo puts them back.` : `Removes ${deleted.name} from the project. Undo puts it back.`}</span>
                    </div>
                  </>
                ) : (
                  <>
                    {kind === 'canonical' && (
                      <div className="health-choice">
                        {pane('disk')}
                        {button('keep', diskDeleted && !c.builderMissing ? 'Keep the file deleted' : 'Keep the file on disk')}
                        <span id={`${ids}-keep`}>{keepDoes}</span>
                      </div>
                    )}
                    <div className="health-choice">
                      {pane('builder')}
                      {button('restore', c.builderMissing ? 'Use SiteOrigin Builder’s version (remove the file)' : 'Use SiteOrigin Builder’s version')}
                      <span id={`${ids}-restore`}>{restoreDoes}</span>
                    </div>
                  </>
                )}
                {kind === 'generated' && c.convert ? (
                  <div className="health-choice">
                    {pane('disk')}
                    {/* Shown without Developer mode too, held, with why: a choice left out would say nothing. */}
                    {button('convert', 'Convert to code component', !codeEnabled)}
                    <span id={`${ids}-convert`}>{codeEnabled ? 'Makes the edited file a code component that this component’s placements use.' : 'Custom code needs Developer mode. Turn it on in Settings to make the edited file a code component.'}</span>
                    {refused && (
                      <p className="health-hint health-refused" role="alert">
                        {refused}
                      </p>
                    )}
                  </div>
                ) : (
                  // A generated file with one way back: its edit is still shown, beside the choice that replaces it.
                  kind === 'generated' && shown && <div className="health-choice view-only">{pane('disk')}</div>
                )}
              </div>
              {/* What an AI request tried to save: not a choice, so it sits below them, across the row. */}
              {shown?.attempted !== undefined && (
                <div className="versions attempted">
                  {pane('attempted')}
                  {shown.attempted?.state !== 'unreadable' && <p className="health-hint">Whichever version you choose, this one is kept under Saved copies too.</p>}
                </div>
              )}
            </>
          )}
        </>
      }
    >
      <strong>{subject}.</strong> {conflictReason(c.reason)}
    </HealthRow>
  );
}

/**
 * The versions not used when conflicts were settled: still there to read, find in the folder, or take off the list.
 * Listed newest first under the day each was saved, so a copy from an earlier day says which day. A copy taken off
 * the list while the dialog is open leaves a line in its place with Undo, until it is put back or the dialog closes.
 */
function SavedCopies({ copies, state, dir, readOnly }: { copies: SavedCopy[]; state: ProjectState; dir: string; readOnly: boolean }) {
  // Taken off in this dialog: `focus` when the focus was on the row as it went, so Undo carries it on.
  const [taken, setTaken] = useState<Array<{ copy: SavedCopy; focus: boolean }>>([]);
  // Put back by Undo: that row takes the focus Undo had.
  const [back, setBack] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  // Said afresh each time, even when the words are the same as the last: the region is emptied first.
  const say = (text: string) => {
    setSaid('');
    requestAnimationFrame(() => setSaid(text));
  };
  const shownTaken = taken.filter((t) => !copies.some((c) => c.id === t.copy.id));
  if (!copies.length && !shownTaken.length) return null;
  const now = Date.now();
  const days: Array<{ day: string; copies: SavedCopy[] }> = [];
  for (const c of [...copies, ...shownTaken.map((t) => t.copy)].sort((a, b) => b.savedAt - a.savedAt)) {
    const day = savedCopyDay(c.savedAt, now);
    const last = days[days.length - 1];
    if (last?.day === day) last.copies.push(c);
    else days.push({ day, copies: [c] });
  }
  return (
    <HealthGroup
      title="Saved copies"
      count={copies.length}
      tone="quiet"
      anchor="saved"
      note={`The versions not used when a file was changed in two places. Each saved file stays in this project’s recovery folder${readOnly ? '.' : ', even after you take it off this list.'}`}
    >
      {days.map((d) => (
        <li key={d.day} className="health-place saved-day">
          <h4>{d.day}</h4>
          <ul>
            {d.copies.map((c) => {
              const t = shownTaken.find((x) => x.copy === c);
              return t ? (
                <TakenCopyRow
                  key={c.id}
                  copy={c}
                  state={state}
                  focus={t.focus}
                  readOnly={readOnly}
                  onUndone={(hadFocus) => {
                    setTaken((list) => list.filter((x) => x.copy.id !== c.id));
                    setBack(hadFocus ? c.id : null);
                    say(`${conflictSubject(state, c.path)}, ${whichInSentence(c)}, is back on the list.`);
                  }}
                />
              ) : (
                <SavedCopyRow
                  key={c.id}
                  copy={c}
                  state={state}
                  dir={dir}
                  readOnly={readOnly}
                  autoFocus={back === c.id}
                  onTaken={(focus) => {
                    // A focus hand-off asked for by an earlier Undo of this copy is spent.
                    setBack(null);
                    say(`${conflictSubject(state, c.path)}, ${whichInSentence(c)}, is off the list.`);
                    setTaken((list) => [...list.filter((x) => x.copy.id !== c.id), { copy: c, focus }]);
                  }}
                />
              );
            })}
          </ul>
        </li>
      ))}
      <li className="sr-only">
        <span role="status">{said}</span>
      </li>
    </HealthGroup>
  );
}

/** A saved copy's source in the middle of a sentence: "the file as edited outside SiteOrigin Builder". */
const whichInSentence = (c: SavedCopy) => savedCopyLabel(c).replace(/^The /, 'the ');

/**
 * A copy just taken off the list, said in its place with Undo. Undo takes the focus when the row had it as it went,
 * and an Undo that fails stays, with why, to try again.
 */
function TakenCopyRow({ copy: c, state, focus, readOnly, onUndone }: { copy: SavedCopy; state: ProjectState; focus: boolean; readOnly: boolean; onUndone: (hadFocus: boolean) => void }) {
  const [undoing, setUndoing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (focus) undoRef.current?.focus();
  }, [focus]);
  const textId = useId();
  const undo = async () => {
    if (undoing) return;
    // Asked before the list changes: the row put back can replace this one before the answer arrives.
    const hadFocus = document.activeElement === undoRef.current;
    setUndoing(true);
    setFailed(null);
    const r = await api.project.restoreSavedCopy(c.id).catch((e: Error) => ({ ok: false, message: e.message }));
    setUndoing(false);
    const active = document.activeElement;
    if (r.ok) onUndone(hadFocus && (!active || active === document.body || active === undoRef.current || active.classList.contains('health-summary')));
    else setFailed(r.message ?? 'That saved copy couldn’t be put back on the list.');
  };
  const time = new Date(c.savedAt).toLocaleTimeString(undefined, { timeStyle: 'short' });
  return (
    <HealthRow
      tone="quiet"
      icon={<Check />}
      actions={
        // Read-only since (another copy of the app took the project): nothing can be written, so nothing is offered.
        readOnly ? undefined : (
          <button ref={undoRef} className="btn btn-sm" aria-disabled={undoing || undefined} aria-describedby={textId} onClick={() => void undo()}>
            {undoing && <Spinner decorative />}
            {undoing ? 'Putting back…' : failed ? 'Try Undo again' : 'Undo'}
          </button>
        )
      }
      details={
        failed ? (
          <p className="health-hint health-refused" role="alert">
            {failed}
          </p>
        ) : undefined
      }
    >
      <span className="saved-taken" id={textId}>
        <strong>{conflictSubject(state, c.path)}</strong>, {whichInSentence(c)} ({time}), is off the list.{!c.removed && ' Its file is still in the recovery folder.'}{readOnly && ' It can be put back once the project is editable.'}
      </span>
    </HealthRow>
  );
}

function SavedCopyRow({ copy: c, state, dir, readOnly, autoFocus, onTaken }: { copy: SavedCopy; state: ProjectState; dir: string; readOnly: boolean; autoFocus: boolean; onTaken: (focus: boolean) => void }) {
  const [content, setContent] = useState<FileContent | 'loading' | null>(null);
  const [removing, setRemoving] = useState(false);
  const asked = useRef(0);
  const actionsRef = useRef<HTMLDivElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  // Put back by Undo, which had the focus: it carries on from this row's first action.
  useLayoutEffect(() => {
    if (autoFocus) actionsRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [autoFocus]);
  const which = savedCopyLabel(c);
  const subject = conflictSubject(state, c.path);
  const at = new Date(c.savedAt);
  const time = at.toLocaleTimeString(undefined, { timeStyle: 'short' });
  const full = at.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
  const view = async () => {
    // Held while the copy is read: a second press would drop the read.
    if (content === 'loading') return;
    const ask = ++asked.current;
    if (content) return setContent(null);
    setContent('loading');
    const r = await api.project.readSavedCopy(c.id).catch((e: Error) => ({ ok: false as const, message: e.message, content: undefined }));
    if (ask !== asked.current) return;
    if (!r.ok || !r.content) {
      setContent(null);
      return toast(r.message ?? 'That saved copy could not be read.', 'error');
    }
    setContent(r.content);
  };
  const dismiss = async () => {
    if (removing) return;
    const hadFocus = document.activeElement === removeRef.current;
    setRemoving(true);
    const r = await api.project.dismissSavedCopy(c.id).catch((e: Error) => ({ ok: false, message: e.message }));
    setRemoving(false);
    if (!r.ok) return toast(r.message ?? 'That saved copy could not be removed from the list.', 'error');
    // The row may be gone already, its focus with it (to the summary, by the dialog): Undo carries it on, unless it
    // has moved somewhere else meanwhile.
    const active = document.activeElement;
    onTaken(hadFocus && (!active || active === document.body || active === removeRef.current || active.classList.contains('health-summary')));
  };
  const shown = content && content !== 'loading' ? content : null;
  return (
    <HealthRow
      tone="quiet"
      icon={<Archive />}
      details={
        <>
          <div ref={actionsRef} className="health-inline-actions" role="group" aria-label={`${subject}, ${which}, saved ${full}`}>
            {!c.removed && (
              <button className="btn btn-sm" aria-expanded={!!shown} aria-disabled={content === 'loading' || undefined} onClick={() => void view()}>
                {content === 'loading' ? <Spinner decorative /> : <DisclosureMark />}
                {content === 'loading' ? 'Opening…' : shown ? 'Hide copy' : 'View copy'}
              </button>
            )}
            {!c.removed && (
              <button className="btn btn-sm btn-ghost" onClick={() => void api.projects.reveal(`${dir}/${c.file}`)}>
                <FolderOpen aria-hidden="true" />
                Show in folder
              </button>
            )}
            {!readOnly && (
              // Held, not disabled, while it runs: focus stays on it until the row goes.
              <button ref={removeRef} className="btn btn-sm btn-ghost" aria-disabled={removing || undefined} onClick={() => void dismiss()}>
                {removing ? <Spinner decorative /> : <X aria-hidden="true" />}
                {removing ? 'Removing from list…' : 'Remove from list'}
              </button>
            )}
          </div>
          {shown && (
            <>
              <div className="versions">
                <VersionText label={`${which}, as saved`} version={shown} />
              </div>
              {shown.state === 'text' && <CopyButton text={shown.text} label="Copy text" />}
            </>
          )}
        </>
      }
    >
      <strong>{subject}.</strong> {which}, saved at{' '}
      <time dateTime={at.toISOString()} title={full}>
        {time}
      </time>
      .{c.removed && ' There’s no file to open.'}
      <span className="health-path">{c.path}</span>
    </HealthRow>
  );
}
