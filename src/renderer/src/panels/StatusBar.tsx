import './StatusBar.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { Archive, ArrowDown, Bot, Check, ChevronRight, CircleAlert, CircleCheck, Component, Copy, Ellipsis, FileDiff, FileText, FolderOpen, GitCompareArrows, Info, Link2, Lock, Network, RefreshCw, Share2, Stethoscope, TriangleAlert, Wrench, X } from 'lucide-react';
import type { Diagnostic, EditorDestination, FileText as FileContent, ProjectSnapshot, RuntimeState, SavedCopy } from '@shared/api';
import type { SeoFinding, SeoPillar } from '@shared/seo';
import { SEO_PILLARS } from '@shared/seo';
import { diagnosticKey } from '@engine/validate';
import { api, applyOps, confirmDialog, getState, setState, toast, useStore } from '../store';
import { refKey, type ElementRef, type ProjectState } from '@shared/types';
import { breadcrumb, inDefinition, type Crumb } from '../lib/model';
import { saveFailureNotice } from '../lib/savestate';
import { activeWorkspace, canvasCovered } from '../lib/workspace';
import { goToShellPart, groupCount, liveGroup, openAsset, openOutline, pageOutOfSight, selectPage } from '../lib/actions';
import { destinationForDiagnostic, destinationLabel } from '../lib/destinations';
import { openEditorDestination } from '../lib/open-destination';
import { findingHandoff } from '../lib/seoHandoff';
import { AiHandoffButton } from '../components/AiHandoff';
import { Modal, Spinner, useMenu } from '../components/ui';
import { useTransitionAnnouncement } from '../lib/announce';
import { auditForHealth, needsFixing, seoCountsText, seoFilterCounts, seoPillarGroups, seoReadiness, seoSeverityChoices, SEO_PILLAR_NAMES, type SeoAuditResult, type SeoPillarFilter, type SeoSeverityFilter } from '../lib/seo-health';

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
    const { broken, phase } = runtimeInfo(s.runtime, s.previewIssue, s.frameReady);
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
  // The toolbar says when a conflict appears or clears.
  const announce = useHealthAnnouncement(() => true);
  // The preview's button becomes text once it recovers: if it had focus, the Project health count takes it.
  const previewHadFocus = useRef(false);
  const problemsRef = useRef<HTMLButtonElement>(null);
  const previewActionable = useStore((s) => ['broken', 'stopped', 'unavailable'].includes(runtimeInfo(s.runtime, s.previewIssue, s.frameReady).phase));
  useLayoutEffect(() => {
    if (previewActionable || !previewHadFocus.current) return;
    previewHadFocus.current = false;
    if (!document.activeElement || document.activeElement === document.body) problemsRef.current?.focus();
  }, [previewActionable]);
  if (!snap) return null;
  // Problems = document errors plus file conflicts and a failed save, so this never says "No problems" while the toolbar
  // shows either.
  // The project's diagnostics already list each conflict (code CONFLICT); count each one once.
  const { dot, label, broken, phase } = runtimeInfo(runtime, pageIssue, frameReady);
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
  // Several layers selected together in Layers: the path is the selection's, and the count says the rest come too.
  const picked = crumbs.length ? liveGroup({ snapshot: snap, selection, layerSet, pageId, definitionMode }) : null;
  const openHealth = () => setState({ modal: { kind: 'health' } });
  // A working or starting preview is only reported; one that failed, stopped or can't run leads to what to do about it.
  const actionable = phase === 'broken' || phase === 'stopped' || phase === 'unavailable';
  return (
    <footer className="status-bar">
      {actionable ? (
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
          <button className="read-only" title={`${snap.readOnly.reason} Open Project health for what you can do.`} onClick={openHealth}>
            <Lock aria-hidden="true" />
            Read-only
            <ChevronRight className="go" aria-hidden="true" />
          </button>
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
                    aria-haspopup="menu"
                    aria-expanded={false}
                    aria-label={`${hidden.length} more parent elements`}
                    title={hidden.map((h) => h.label).join(' › ')}
                    onClick={(e) => {
                      const nav = e.currentTarget.closest('nav');
                      menu.openAt(e.currentTarget, hidden.map((h) => ({ label: h.label, icon: h.component ? <Component /> : undefined, hint: h.component === 'custom' ? 'Custom' : undefined, onSelect: () => select(h.ref, nav) })), 'Parent elements');
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
  const page = /^siteorigin\/pages\/([^/]+)\.json$/.exec(path)?.[1];
  if (page) return Object.hasOwn(state.pages, page) ? `${state.pages[page].title} page` : 'Page file';
  const component = /^siteorigin\/components\/([^/]+)\//.exec(path)?.[1];
  if (component) return Object.hasOwn(state.components, component) ? `${state.components[component].name} component` : 'Component file';
  if (Object.hasOwn(DOCUMENT_NAMES, path)) return DOCUMENT_NAMES[path];
  const route = /^src\/routes\/(.*)\+page\.svelte$/.exec(path)?.[1];
  const built = route === undefined ? undefined : Object.values(state.pages).find((p) => p.route === `/${route}`);
  return built ? `${built.title} website file` : 'Project file';
}

/** A generated file's reason, without the word "generated". */
const conflictReason = (reason: string) =>
  reason === 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.' ? 'Edited outside SiteOrigin Builder, which can’t update this file until it is restored.' : reason;

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

/** A disclosure in a row: a chevron that turns, then whatever it holds. */
function Disclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <details className="health-details">
      <summary>
        <ChevronRight aria-hidden="true" />
        {label}
      </summary>
      <div className="health-details-body">{children}</div>
    </details>
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
  const groups = seoPillarGroups(findings, pillar, severity);
  const shown = groups.reduce((n, g) => n + g.findings.length, 0);
  const readiness = seoReadiness(findings);
  const filtered = pillar !== 'all' || severity !== 'all';
  const clear = () => {
    setPillar('all');
    setSeverity('all');
    pillarRef.current?.focus();
  };
  const tone = !audit.ok || readiness.tone === 'ok' ? 'quiet' : readiness.tone;
  return (
    <section className={`health-group seo-readiness ${tone}`} aria-labelledby={headId} data-group="seo" data-testid="health-seo" onFocus={onFocus} onBlur={onBlur}>
      <h3 id={headId} ref={headingRef} tabIndex={-1} data-autofocus={focusOnOpen || undefined}>
        Search &amp; AI readiness {findings.length > 0 && <span className="health-count">{findings.length}</span>}
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
      {findings.length > 0 && (
        <div className="seo-filters">
          <label htmlFor={pillarId}>Pillar</label>
          <select id={pillarId} ref={pillarRef} className="select sm" value={pillar} onChange={(e) => setPillar(e.target.value as SeoPillarFilter)}>
            <option value="all">All pillars ({counts.pillars.all})</option>
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
            {filtered ? `Showing ${shown} of ${findings.length}` : ''}
          </span>
        </div>
      )}
      {groups.length > 0 ? (
        <ul className="health-list">
          {groups.map((g) => (
            <li key={g.pillar} className="health-place" data-pillar={g.pillar}>
              <h4>
                {PILLAR_ICONS[g.pillar]}
                {g.name}
                <span className="seo-pillar-count">{g.findings.length}</span>
              </h4>
              <ul>
                {g.findings.map((f) => (
                  <SeoRow key={diagnosticKey(f)} finding={f} state={state} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
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
    >
      <span className="sr-only">{f.severity === 'error' ? 'Problem: ' : f.severity === 'warning' ? 'Warning: ' : 'Note: '}</span>
      {f.message}
      <span className="health-hint">{f.explanation}</span>
    </HealthRow>
  );
}

export function HealthModal() {
  const snap = useStore((s) => s.snapshot);
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
   * read again), so no other choice can start meanwhile.
   */
  const resolve = async (path: string, choice: 'keep' | 'restore', check?: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(path);
    try {
      if (check && !(await check())) return;
      settling.current = { path, before: snap.conflicts.map((c) => c.path) };
      const r = await api.project.resolveConflict(path, choice);
      if (!r.ok) {
        settling.current = null;
        if (r.message) toast(r.message, 'error');
      } else setStatus(`${conflictSubject(st, path)} settled. The version you replaced is under Saved copies.`);
    } catch (e) {
      settling.current = null;
      toast(`The conflict could not be resolved: ${(e as Error).message}`, 'error');
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
        : 'No problems found';
  const guidance = problems
    ? warnings.length
      ? `Fix the ${problems === 1 ? 'problem' : 'problems'} first, then check the warnings.`
      : problems === 1
        ? 'Below is what happened and how to fix it.'
        : 'Each one says what happened and how to fix it.'
    : warnings.length
      ? 'Worth checking before you publish.'
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
    { key: 'seo', label: 'Search & AI', count: seoFindings.length, tone: seoDue.length ? 'warn' : 'quiet' },
    { key: 'updates', label: 'Updates', count: updates.length, tone: 'quiet' },
    { key: 'saved', label: 'Saved copies', count: saved.length, tone: 'quiet' }
  ].filter((j) => j.count > 0);
  const jumpTo = (key: string) => {
    const heading = bodyRef.current?.querySelector<HTMLElement>(`[data-group="${key}"] h3`);
    heading?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    heading?.focus({ preventScroll: true });
  };

  const diagnosticRow = (d: Diagnostic, i: number, rest?: string) => {
    // An image whose files are missing keeps its uses: say how many, and open it where it can be fixed.
    const asset = d.code === 'ASSET_FILE_MISSING' && d.owner?.kind === 'asset' ? d.owner.id : null;
    const uses = asset ? (snap.assetUsage[asset] ?? 0) : 0;
    // A page's heading outline is reviewed (and fixed) in its outline, beside the page.
    const outlinePage = d.code.startsWith('HEADING_') && d.owner?.kind === 'page' ? d.owner.id : null;
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
        {asset && <> {uses ? `It is used ${uses === 1 ? 'once' : uses === 2 ? 'twice' : `${uses} times`}, and every use is kept.` : 'Nothing uses it.'}</>}
      </HealthRow>
    );
  };
  /** A severity's items, with those about one page or component listed together under its name. */
  const diagnosticRows = (list: Diagnostic[], keyPrefix: string) => {
    const places = new Map<string, { kind: 'page' | 'component'; name: string; rows: ReactNode[] }>();
    const out: Array<ReactNode | string> = [];
    list.forEach((d, i) => {
      const place = diagnosticPlace(st, d);
      if (!place) return out.push(diagnosticRow(d, i));
      const key = `${place.kind}:${place.id}`;
      if (!places.has(key)) {
        places.set(key, { kind: place.kind, name: place.name, rows: [] });
        out.push(key);
      }
      places.get(key)!.rows.push(diagnosticRow(d, i, place.rest));
    });
    return out.map((item) => {
      if (typeof item !== 'string') return item;
      const p = places.get(item)!;
      return (
        <li key={`${keyPrefix}:${item}`} className="health-place">
          <h4>
            {p.kind === 'page' ? <FileText aria-hidden="true" /> : <Component aria-hidden="true" />}
            {p.kind === 'page' ? `${p.name} page` : `${p.name} component`}
          </h4>
          <ul>{p.rows}</ul>
        </li>
      );
    });
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
                  The version you replace is kept under Saved copies.
                </p>
                <ul>
                  {snap.conflicts.map((c) => (
                    <ConflictRow key={c.path} conflict={c} state={st} dir={snap.dir} busy={!!busy} readOnly={readOnly} canUnlock={!!snap.readOnly?.canUnlock} recoveryNote={recoveryNote} onResolve={(choice, check) => void resolve(c.path, choice, check)} />
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
                <Disclosure label={kept.length ? `See which ones (${kept.length} more can’t be updated)` : 'See which ones'}>
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
        {saved.length > 0 && <SavedCopies copies={saved} state={st} dir={snap.dir} readOnly={readOnly} />}
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
      </div>
    </Modal>
  );
}

/** Why a version of a file is not shown as text. */
const NOT_SHOWN: Record<Exclude<FileContent['state'], 'text'>, string> = {
  missing: 'There is no file.',
  binary: 'This file is not text (a font or an image, say), so it can’t be shown here.',
  'too-large': 'This file is too large to show here.',
  unreadable: 'This file can’t be read.'
};

/** One version of a file, as read-only text, or why it is not shown. */
function VersionText({ label, version }: { label: string; version: FileContent | undefined }) {
  return (
    <figure className="version-pane">
      <figcaption>{label}</figcaption>
      {version?.state === 'text' ? <pre className="code-view">{version.text || ' '}</pre> : <p className="faint">{version ? NOT_SHOWN[version.state] : 'This file can’t be read.'}</p>}
    </figure>
  );
}

/**
 * A file in conflict: what it is and what happened, the two versions to look at, then each choice beside what it
 * does. Both choices weigh the same: whichever version is not used is kept under Saved copies.
 */
function ConflictRow({
  conflict: c,
  state,
  dir,
  busy,
  readOnly,
  canUnlock,
  recoveryNote,
  onResolve
}: {
  conflict: ProjectSnapshot['conflicts'][number];
  state: ProjectState;
  dir: string;
  busy: boolean;
  readOnly: boolean;
  canUnlock: boolean;
  /** The band's line saying the version replaced is kept: every choice is described by it too. */
  recoveryNote: string;
  onResolve: (choice: 'keep' | 'restore', check?: () => Promise<boolean>) => void;
}) {
  // An older snapshot without a kind: generated conflicts were the ones whose reason says so.
  const kind = c.kind ?? (c.reason.startsWith('Generated') ? 'generated' : 'canonical');
  const [versions, setVersions] = useState<{ builder?: FileContent; disk?: FileContent } | 'loading' | null>(null);
  // Only the latest request's reply is shown; hiding the versions drops one still on its way.
  const asked = useRef(0);
  const subject = conflictSubject(state, c.path);
  const ids = useId();
  const compareRef = useRef<HTMLButtonElement>(null);
  // The versions were shown but couldn't be read again before a choice: say so here, and choose nothing.
  const [recheck, setRecheck] = useState(false);
  const load = async () => {
    const ask = ++asked.current;
    setRecheck(false);
    setVersions('loading');
    const r = await api.project.compareConflict(c.path).catch((e: Error) => ({ ok: false as const, message: e.message, builder: undefined, disk: undefined }));
    if (ask !== asked.current) return;
    if (!r.ok) {
      setVersions(null);
      return toast(r.message ?? 'The two versions could not be read.', 'error');
    }
    setVersions({ builder: r.builder, disk: r.disk });
  };
  const compare = () => {
    if (!versions) return void load();
    ++asked.current;
    setRecheck(false);
    setVersions(null);
  };
  // Choices wait for versions still loading. With the versions shown, a choice is made against them: they are read
  // again first (the dialog held meanwhile), and one that changed, or can't be read, is shown and nothing is chosen.
  const held = busy || versions === 'loading';
  const choose = (choice: 'keep' | 'restore') => {
    if (held) return;
    const shown = versions;
    if (!shown) return onResolve(choice);
    const check = async () => {
      const ask = ++asked.current;
      const opening = getState().snapshot?.workspaceKey;
      const r = await api.project.compareConflict(c.path).catch(() => null);
      // Only for the project it was asked in, and only the latest ask.
      if (ask !== asked.current || getState().snapshot?.workspaceKey !== opening) return false;
      if (!r?.ok) {
        setRecheck(true);
        return false;
      }
      if (JSON.stringify(r.builder) !== JSON.stringify(shown.builder) || JSON.stringify(r.disk) !== JSON.stringify(shown.disk)) {
        setVersions({ builder: r.builder, disk: r.disk });
        toast('The file changed since you compared the versions. Look again, then choose.', 'info');
        return false;
      }
      setRecheck(false);
      return true;
    };
    onResolve(choice, check);
  };
  const ours = kind === 'generated' ? 'SiteOrigin Builder’s version, made from your pages' : 'SiteOrigin Builder’s version';
  const restoreDoes = kind === 'generated' ? (c.builderMissing ? 'Removes the file, which your pages no longer make. Your version is kept as a copy.' : 'Makes the file again from your pages. To keep a change to it, make the change in the page or in a code component.') : c.builderMissing ? 'Removes the file, which SiteOrigin Builder’s version doesn’t have.' : 'Puts back the version you were editing.';
  return (
    <HealthRow
      tone="danger"
      icon={<CircleAlert />}
      actions={
        <>
          <button ref={compareRef} className="btn btn-sm btn-ghost" aria-expanded={!!versions} onClick={() => void compare()}>
            <GitCompareArrows aria-hidden="true" />
            {versions ? 'Hide versions' : 'Compare versions'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => void api.projects.reveal(`${dir}/${c.path}`)}>
            <FolderOpen aria-hidden="true" />
            Show in folder
          </button>
        </>
      }
      details={
        <>
          {/* The path runs the row's full width, under the actions, so a long one wraps less. */}
          <span className="health-path">{c.path}</span>
          {versions === 'loading' ? (
            <Spinner />
          ) : versions ? (
            <div className="versions">
              <VersionText label={ours} version={versions.builder} />
              <VersionText label="The file on disk, edited outside SiteOrigin Builder" version={versions.disk} />
            </div>
          ) : null}
          {recheck && (
            <p className="health-hint health-recheck" role="status">
              The two versions couldn’t be read again to check they haven’t changed.{' '}
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
            <p className="health-hint">{canUnlock ? 'Unlock the project to settle this.' : 'This can be settled once the project is editable.'}</p>
          ) : (
            <div className="health-choices" role="group" aria-label={kind === 'generated' ? `Restore the ${subject}` : `Choose a version of the ${subject}`} aria-describedby={recoveryNote}>
              {kind === 'canonical' && (
                <div className="health-choice">
                  {/* Held, not disabled, while a choice is being made: focus stays where it was. */}
                  <button className="btn btn-sm" aria-disabled={held || undefined} aria-describedby={`${ids}-keep`} onClick={() => choose('keep')}>
                    Keep the file on disk
                  </button>
                  <span id={`${ids}-keep`}>{c.builderMissing ? 'Adds the file to the project as it is now.' : 'Uses the edited file as it is now.'}</span>
                </div>
              )}
              <div className="health-choice">
                <button className="btn btn-sm" aria-disabled={held || undefined} aria-describedby={`${ids}-restore`} onClick={() => choose('restore')}>
                  {c.builderMissing ? 'Use SiteOrigin Builder’s version (remove the file)' : 'Use SiteOrigin Builder’s version'}
                </button>
                <span id={`${ids}-restore`}>{restoreDoes}</span>
              </div>
            </div>
          )}
        </>
      }
    >
      <strong>{subject}.</strong> {conflictReason(c.reason)}
    </HealthRow>
  );
}

/** The versions not used when conflicts were settled: still there to read, find in the folder, or take off the list. */
function SavedCopies({ copies, state, dir, readOnly }: { copies: SavedCopy[]; state: ProjectState; dir: string; readOnly: boolean }) {
  return (
    <HealthGroup title="Saved copies" count={copies.length} tone="quiet" anchor="saved" note="The versions replaced when a file was changed in two places. Each stays in this project’s recovery folder, even after you take it off this list.">
      {copies.map((c) => (
        <SavedCopyRow key={c.id} copy={c} state={state} dir={dir} readOnly={readOnly} />
      ))}
    </HealthGroup>
  );
}

function SavedCopyRow({ copy: c, state, dir, readOnly }: { copy: SavedCopy; state: ProjectState; dir: string; readOnly: boolean }) {
  const [content, setContent] = useState<FileContent | 'loading' | null>(null);
  const asked = useRef(0);
  const which = c.side === 'external' ? 'The file as edited outside SiteOrigin Builder' : 'SiteOrigin Builder’s version';
  const when = new Date(c.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const view = async () => {
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
    const r = await api.project.dismissSavedCopy(c.id).catch((e: Error) => ({ ok: false, message: e.message }));
    if (!r.ok) toast(r.message ?? 'That saved copy could not be removed from the list.', 'error');
  };
  return (
    <HealthRow
      tone="quiet"
      icon={<Archive />}
      details={
        <>
          <div className="health-inline-actions" role="group" aria-label={`${conflictSubject(state, c.path)}, saved copy`}>
            <button className="btn btn-sm" aria-expanded={!!content} onClick={() => void view()}>
              {content ? 'Hide copy' : 'View copy'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => void api.projects.reveal(`${dir}/${c.file}`)}>
              <FolderOpen aria-hidden="true" />
              Show in folder
            </button>
            {!readOnly && (
              <button className="btn btn-sm btn-ghost" title="The file stays in the recovery folder." onClick={() => void dismiss()}>
                <X aria-hidden="true" />
                Remove from list
              </button>
            )}
          </div>
          {content === 'loading' ? (
            <Spinner />
          ) : content ? (
            <>
              <div className="versions">
                <VersionText label={`${which}, as saved`} version={content} />
              </div>
              {content.state === 'text' && <CopyButton text={content.text} label="Copy text" />}
            </>
          ) : null}
        </>
      }
    >
      <strong>{conflictSubject(state, c.path)}.</strong> {which}, saved {when}.
      <span className="health-path">{c.path}</span>
    </HealthRow>
  );
}
