import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Archive, ChevronRight, CircleAlert, CircleCheck, Component, Ellipsis, Info, Lock, RefreshCw, Stethoscope, TriangleAlert, Wrench } from 'lucide-react';
import type { Diagnostic, FileText, ProjectSnapshot, RuntimeState, SavedCopy } from '@shared/api';
import { api, applyOps, confirmDialog, getState, setState, toast, useStore } from '../store';
import { refKey, type ElementRef, type ProjectState } from '@shared/types';
import { breadcrumb, inDefinition, type Crumb } from '../lib/model';
import { goToShellPart, groupCount, liveGroup, openAsset, openOutline, selectPage } from '../lib/actions';
import { Modal, Spinner, useMenu } from '../components/ui';
import { useTransitionAnnouncement } from '../lib/announce';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "2 problems and 1 warning", or whichever of them there are. */
const countsText = (problems: number, warnings: number) => [problems && plural(problems, 'problem'), warnings && plural(warnings, 'warning')].filter(Boolean).join(' and ');

function runtimeInfo(runtime: RuntimeState, pageIssue: string | null, frameReady: boolean) {
  const broken = runtime.state === 'error' || (runtime.state === 'ready' && !!pageIssue);
  // "Ready" means the page itself has loaded, not only that the website tools are running.
  const opening = runtime.state === 'ready' && !frameReady && !broken;
  const dot = broken ? 'error' : opening ? 'busy' : runtime.state === 'ready' ? 'ready' : runtime.state === 'preparing' || runtime.state === 'starting' ? 'busy' : 'stopped';
  const label = broken ? 'Preview problem' : opening ? 'Opening page' : runtime.state === 'ready' ? 'Preview ready' : runtime.state === 'preparing' ? 'Setting up website tools' : runtime.state === 'starting' ? 'Starting preview' : runtime.state === 'unavailable' ? 'Preview unavailable' : 'Preview paused';
  return { dot, label, broken };
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
  const frameReady = useStore((s) => s.frameReady);
  const menu = useMenu();
  // Project health as "problems,warnings,conflicts,broken", for announcing a change once (never on a page
  // switch). The toolbar announces a conflict appearing or clearing, so a change in conflicts alone is quiet
  // here, but every count spoken includes them: this never says "No problems" while a conflict remains.
  const health = useStore((s) => {
    const d = s.snapshot?.diagnostics ?? [];
    const conflicts = s.snapshot?.conflicts.length ?? 0;
    const broken = s.runtime.state === 'error' || (s.runtime.state === 'ready' && !!s.previewIssue) ? 1 : 0;
    return [d.filter((x) => x.severity === 'error' && x.code !== 'CONFLICT').length + conflicts + broken, d.filter((x) => x.severity === 'warning').length, conflicts, broken].join(',');
  });
  const announce = useTransitionAnnouncement(health, (prev, next) => {
    const [pe, pw, pc, pb] = prev.split(',').map(Number);
    const [e, w, c, b] = next.split(',').map(Number);
    const counts = countsText(e, w);
    if (b !== pb) return b ? `Preview problem. ${counts} in this project` : `Preview working again${counts ? `. ${counts} in this project` : ''}`;
    if (c !== pc && e - c === pe - pc && w === pw) return null;
    return counts ? `${counts} in this project` : 'No problems';
  });
  if (!snap) return null;
  // Problems = document errors plus file conflicts, so this never says "No problems" while the toolbar shows a conflict.
  // The project's diagnostics already list each conflict (code CONFLICT); count each one once.
  const { dot, label, broken } = runtimeInfo(runtime, pageIssue, frameReady);
  const errors = snap.diagnostics.filter((d) => d.severity === 'error' && d.code !== 'CONFLICT').length + snap.conflicts.length + (broken ? 1 : 0);
  const warnings = snap.diagnostics.filter((d) => d.severity === 'warning').length;
  // While editing a component everywhere, the path starts at the component (plum), never at a page: its
  // overview, then the design's own layers down to the selection.
  const def = definitionMode ? snap.state.components[definitionMode.definitionId] : undefined;
  const crumbs: Array<Crumb & { def?: boolean }> = def
    ? selection && inDefinition(selection, def.id)
      ? breadcrumb(snap.state, selection).map((c, i) => (i ? c : { ...c, def: true }))
      : [{ label: def.name, full: def.name, ref: null, def: true }]
    : selection && !stylesOpen
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
  const problemText = errors ? plural(errors, 'problem') : warnings ? plural(warnings, 'warning') : 'No problems';
  return (
    <footer className="status-bar">
      <button className={`row preview-status${broken ? ' error' : ''}`} style={{ gap: 6 }} title="Preview status: open Project health" onClick={() => setState({ modal: { kind: 'health' } })}>
        {broken ? <CircleAlert aria-hidden="true" /> : <span className={`status-dot ${dot}`} aria-hidden="true" />}
        {label}
      </button>
      {snap.readOnly && (
        <>
          <span className="status-sep" aria-hidden="true" />
          <button className="read-only" title={snap.readOnly.reason} onClick={() => setState({ modal: { kind: 'health' } })}>
            <Lock aria-hidden="true" />
            Read-only
          </button>
        </>
      )}
      {crumbs.length > 0 && <span className="status-sep" aria-hidden="true" />}
      <nav className="crumbs grow" aria-label="Selected element">
        {crumbs.length > 0 && (
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
        )}
        {picked && <span className="crumbs-count">{groupCount(picked)} selected</span>}
      </nav>
      <button className={`problems${errors ? ' error' : warnings ? ' warn' : ''}`} onClick={() => setState({ modal: { kind: 'health' } })} title="Project health: check this project for problems">
        {errors ? <CircleAlert /> : warnings ? <TriangleAlert /> : <CircleCheck />}
        {problemText}
        {errors > 0 && warnings > 0 && <span className="also">, {plural(warnings, 'warning')}</span>}
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
  'siteorigin/theme-lock.json': 'Theme record'
};

/** What a conflicted file holds, in the words the user knows it by. The path is shown beside it. */
function conflictSubject(state: ProjectState, path: string): string {
  const page = /^siteorigin\/pages\/([^/]+)\.json$/.exec(path)?.[1];
  if (page && Object.hasOwn(state.pages, page)) return `${state.pages[page].title} page`;
  const component = /^siteorigin\/components\/([^/]+)\//.exec(path)?.[1];
  if (component && Object.hasOwn(state.components, component)) return `${state.components[component].name} component`;
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

/** A diagnostic's opening words (the page or image it is about), set apart so a long list can be scanned by them. */
function diagnosticLead(state: ProjectState, d: Diagnostic): { lead: string; rest: string } | null {
  const { kind, id } = d.owner ?? {};
  if (!id) return null;
  if (kind === 'asset') {
    const name = Object.hasOwn(state.assets.assets, id) ? state.assets.assets[id].name : undefined;
    return typeof name === 'string' && name && d.message.startsWith(`${name} `) ? { lead: name, rest: d.message.slice(name.length) } : null;
  }
  const where = kind === 'page' && Object.hasOwn(state.pages, id) ? state.pages[id].title : kind === 'component' && Object.hasOwn(state.components, id) ? state.components[id].name : null;
  return where && d.message.startsWith(`${where}: `) ? { lead: `${where}:`, rest: d.message.slice(where.length + 1) } : null;
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
    if (s.pageId !== ref.owner.id || s.definitionMode) selectPage(ref.owner.id);
  } else if (!goToShellPart(ref.owner.id)) {
    toast(`No page shows the shared ${ref.owner.id} right now.`, 'error');
    return;
  }
  setState({ modal: null, mode: 'edit', selection: ref, rightTab: 'inspect', dockOpen: true });
}

function HealthGroup({ title, count, note, children }: { title: string; count?: number; note?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="health-group" aria-labelledby={id}>
      <h3 id={id}>
        {title}
        {count !== undefined && <span className="health-count">{count}</span>}
      </h3>
      {note && <p className="health-note">{note}</p>}
      <ul className="health-list">{children}</ul>
    </section>
  );
}

/** One item: what happened, its actions (named by that text, since rows repeat them), and any details across the full width. */
function HealthRow({ tone, icon, stacked, actions, details, children }: { tone: 'danger' | 'warn' | 'quiet'; icon: ReactNode; stacked?: boolean; actions?: ReactNode; details?: ReactNode; children: ReactNode }) {
  const textId = useId();
  return (
    <li className={`health-row ${tone}${stacked ? ' stacked' : ''}`}>
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

/** Technical output, closed until asked for: it helps whoever is fixing the problem, and few others. */
function ErrorDetails({ text }: { text: string }) {
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
    <details className="health-details">
      <summary>Error details</summary>
      <pre>{text}</pre>
      <button className="btn btn-sm" onClick={() => void copy()}>
        {copied === 'copied' ? 'Copied' : 'Copy details'}
      </button>
      <span className="health-copy-state" role="status">
        {copied === 'failed' ? 'Couldn’t copy. Select the text above instead.' : ''}
      </span>
    </details>
  );
}

export function HealthModal() {
  const snap = useStore((s) => s.snapshot);
  const runtime = useStore((s) => s.runtime);
  const pageIssue = useStore((s) => s.previewIssue);
  const [busy, setBusy] = useState<string | null>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  // What the last action did: its row may be gone by the time it finishes.
  const [status, setStatus] = useState('');
  // Settling a problem removes the row holding the focused button: carry on from the summary, which now says what is left.
  const listed = [snap?.diagnostics.length ?? 0, snap?.conflicts.length ?? 0, snap?.themeUpdates?.available.length ?? 0, runtime.state, !!pageIssue].join();
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) summaryRef.current?.focus();
  }, [listed, status]);
  if (!snap) return null;
  const st = snap.state;
  const readOnly = !!snap.readOnly;
  // The tools line describes the website tools only; a page problem is listed separately.
  const { label } = runtimeInfo(runtime, null, true);
  const close = () => setState({ modal: null });
  const resolve = async (path: string, choice: 'keep' | 'restore') => {
    setBusy(path);
    try {
      const r = await api.project.resolveConflict(path, choice);
      if (!r.ok && r.message) toast(r.message, 'error');
      else if (r.ok) setStatus(`${conflictSubject(st, path)} conflict resolved.`);
    } catch (e) {
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
  const reinstall = (text: string) => (
    <button className="btn btn-sm" disabled={runtime.state === 'preparing'} onClick={() => void api.project.repairDependencies()}>
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
  const problems = errors.length + snap.conflicts.length + (toolsFailed || pageFailed ? 1 : 0);
  const updates = snap.themeUpdates?.available ?? [];
  const kept = snap.themeUpdates?.kept ?? [];
  const headline = problems ? `${plural(problems, 'problem')}${warnings.length ? ` and ${plural(warnings.length, 'warning')}` : ''}` : warnings.length ? plural(warnings.length, 'warning') : 'No problems found';
  const guidance = problems ? (warnings.length ? `Fix the ${problems === 1 ? 'problem' : 'problems'} first, then check the warnings.` : problems === 1 ? 'Here’s what to do next.' : 'Each one says what to do next.') : warnings.length ? 'Worth checking before you publish.' : 'Every page, component and style in this project checks out.';

  const diagnosticRow = (d: Diagnostic, i: number) => {
    // An image whose files are missing keeps its uses: say how many, and open it where it can be fixed.
    const asset = d.code === 'ASSET_FILE_MISSING' && d.owner?.kind === 'asset' ? d.owner.id : null;
    const uses = asset ? (snap.assetUsage[asset] ?? 0) : 0;
    // A page's heading outline is reviewed (and fixed) in its outline, beside the page.
    const outlinePage = d.code.startsWith('HEADING_') && d.owner?.kind === 'page' ? d.owner.id : null;
    const target = asset || outlinePage ? null : diagnosticTarget(st, d);
    const lead = diagnosticLead(st, d);
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
            <button className="btn btn-sm" onClick={() => openOutline(outlinePage)}>
              Show headings
            </button>
          ) : target ? (
            <button className="btn btn-sm" onClick={() => showElement(target)}>
              Show on page
            </button>
          ) : undefined
        }
      >
        {lead ? (
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

  return (
    <Modal
      title="Project health"
      icon={<Stethoscope />}
      onClose={() => close()}
      wide={problems + warnings.length + notes.length + (snap.savedCopies?.length ?? 0) > 0}
      footer={
        <button className="btn" onClick={() => close()}>
          Close
        </button>
      }
    >
      <p ref={summaryRef} className={`health-summary ${problems ? 'error' : warnings.length ? 'warn' : 'ok'}`} tabIndex={-1} data-autofocus>
        {problems ? <CircleAlert /> : warnings.length ? <TriangleAlert /> : <CircleCheck />}
        <span>
          <strong>{headline}</strong>
          {guidance}
          {status && ` ${status}`}
        </span>
      </p>
      <span className="sr-only" role="status">
        {status}
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
        <HealthGroup
          title="Problems"
          count={problems}
          note={snap.conflicts.length > 0 ? 'Whichever version of a file you choose, the one it replaces is kept under Saved copies.' : undefined}
        >
          {toolsFailed && (
            <HealthRow
              tone="danger"
              icon={<CircleAlert />}
              actions={!readOnly ? reinstall('Reinstall website tools') : undefined}
              details={runtime.detail || runtime.message ? <ErrorDetails text={runtime.detail || runtime.message} /> : undefined}
            >
              <strong>The preview couldn’t start.</strong> {readOnly ? 'The error details show what went wrong.' : 'Reinstalling the website tools may help. If it doesn’t, the error details show what went wrong.'}
            </HealthRow>
          )}
          {pageFailed && (
            <HealthRow tone="danger" icon={<CircleAlert />} details={<ErrorDetails text={pageIssue!} />}>
              <strong>This page couldn’t be previewed.</strong> Something on it failed to show. Undo your last change, or choose Try again on the preview.
            </HealthRow>
          )}
          {snap.conflicts.map((c) => (
            <ConflictRow key={c.path} conflict={c} state={st} dir={snap.dir} busy={!!busy} readOnly={readOnly} onResolve={(choice) => void resolve(c.path, choice)} />
          ))}
          {errors.map(diagnosticRow)}
        </HealthGroup>
      )}
      {warnings.length > 0 && (
        <HealthGroup title="Warnings" count={warnings.length}>
          {warnings.map(diagnosticRow)}
        </HealthGroup>
      )}
      {notes.length > 0 && (
        <HealthGroup title="Notes" count={notes.length}>
          {notes.map(diagnosticRow)}
        </HealthGroup>
      )}
      {updates.length > 0 && (
        <HealthGroup title="Updates">
          <HealthRow
            tone="quiet"
            icon={<RefreshCw />}
            actions={
              <button className="btn btn-sm" disabled={!!busy || readOnly || !!snap.conflicts.length} onClick={() => void updateTheme()}>
                Update {plural(updates.length, 'component')}
              </button>
            }
            details={
              <details className="health-details">
                <summary>{kept.length ? `See which ones (${kept.length} more can’t be updated)` : 'See which ones'}</summary>
                <ul>
                  <li>
                    <strong>Will update:</strong> {updates.map((u) => u.name).join(', ')}
                  </li>
                  {kept.map((k) => (
                    <li key={k.id}>
                      <strong>{k.name}.</strong> {keptReason(k.reason)}
                    </li>
                  ))}
                </ul>
              </details>
            }
          >
            <strong>
              {updates.length} theme component{updates.length === 1 ? ' has' : 's have'} an update.
            </strong>{' '}
            Your content and changes stay. Components you copied and edited are not touched, and you can undo this.
            {!!snap.conflicts.length && <span className="health-hint">Resolve the file conflicts above to update.</span>}
          </HealthRow>
        </HealthGroup>
      )}
      {!!snap.savedCopies?.length && <SavedCopies copies={snap.savedCopies} dir={snap.dir} readOnly={readOnly} />}
      {!toolsFailed && (
        <HealthGroup title="Website tools">
          <HealthRow tone="quiet" icon={<Wrench />} actions={!readOnly && runtime.state !== 'unavailable' ? reinstall('Reinstall') : undefined}>
            <strong>{runtime.state === 'ready' ? 'Ready' : label}.</strong>{' '}
            {runtime.state === 'preparing' ? 'This can take a minute.' : runtime.state === 'unavailable' ? runtime.message : readOnly ? 'The website tools are set up inside this project folder.' : 'The website tools are set up inside this project folder. Reinstall them if the preview won’t start.'}
          </HealthRow>
        </HealthGroup>
      )}
    </Modal>
  );
}

/** Why a version of a file is not shown as text. */
const NOT_SHOWN: Record<Exclude<FileText['state'], 'text'>, string> = {
  missing: 'There is no file.',
  binary: 'This file is not text (a font or an image, say), so it can’t be shown here.',
  'too-large': 'This file is too large to show here.',
  unreadable: 'This file can’t be read.'
};

/** One version of a file, as read-only text, or why it is not shown. */
function VersionText({ label, version }: { label: string; version: FileText | undefined }) {
  return (
    <figure className="version-pane">
      <figcaption>{label}</figcaption>
      {version?.state === 'text' ? <pre className="code-view">{version.text || ' '}</pre> : <p className="faint">{version ? NOT_SHOWN[version.state] : 'This file can’t be read.'}</p>}
    </figure>
  );
}

/**
 * A file in conflict: what happened, which version each choice keeps, and both versions side by side on request.
 * Whichever version is not used is kept under Saved copies.
 */
function ConflictRow({
  conflict: c,
  state,
  dir,
  busy,
  readOnly,
  onResolve
}: {
  conflict: ProjectSnapshot['conflicts'][number];
  state: ProjectState;
  dir: string;
  busy: boolean;
  readOnly: boolean;
  onResolve: (choice: 'keep' | 'restore') => void;
}) {
  // An older snapshot without a kind: generated conflicts were the ones whose reason says so.
  const kind = c.kind ?? (c.reason.startsWith('Generated') ? 'generated' : 'canonical');
  const [versions, setVersions] = useState<{ builder?: FileText; disk?: FileText } | 'loading' | null>(null);
  // Only the latest request's reply is shown; hiding the versions drops one still on its way.
  const asked = useRef(0);
  const compare = async () => {
    const ask = ++asked.current;
    if (versions) return setVersions(null);
    setVersions('loading');
    const r = await api.project.compareConflict(c.path).catch((e: Error) => ({ ok: false as const, message: e.message, builder: undefined, disk: undefined }));
    if (ask !== asked.current) return;
    if (!r.ok) {
      setVersions(null);
      return toast(r.message ?? 'The two versions could not be read.', 'error');
    }
    setVersions({ builder: r.builder, disk: r.disk });
  };
  // With the versions shown, a choice is made against them: one that changed since is shown again first.
  const choose = async (choice: 'keep' | 'restore') => {
    if (versions && versions !== 'loading') {
      const ask = ++asked.current;
      const opening = getState().snapshot?.workspaceKey;
      const r = await api.project.compareConflict(c.path).catch(() => null);
      // Only for the project it was asked in, and only the latest ask.
      if (ask !== asked.current || getState().snapshot?.workspaceKey !== opening) return;
      if (r?.ok && (JSON.stringify(r.builder) !== JSON.stringify(versions.builder) || JSON.stringify(r.disk) !== JSON.stringify(versions.disk))) {
        setVersions({ builder: r.builder, disk: r.disk });
        return toast('The file changed since you compared the versions. Look again, then choose.', 'info');
      }
    }
    onResolve(choice);
  };
  const ours = kind === 'generated' ? 'SiteOrigin Builder’s version, made from your pages' : 'SiteOrigin Builder’s version';
  const help =
    kind === 'generated'
      ? 'Using SiteOrigin Builder’s version keeps the file on disk under Saved copies, then makes the file again from your pages. To keep a change to it, make it in the page or in a code component.'
      : c.builderMissing
        ? 'In SiteOrigin Builder’s version this file does not exist. Keep the file on disk to use it, or use SiteOrigin Builder’s version to remove it: the file is kept under Saved copies first.'
        : 'Keep the file on disk to use it as it is now, or use SiteOrigin Builder’s version to put back the one you were editing. The version you don’t use is kept under Saved copies.';
  return (
    <HealthRow
      tone="danger"
      icon={<CircleAlert />}
      stacked
      actions={
        <>
          <button className="btn btn-sm" aria-expanded={!!versions} onClick={() => void compare()}>
            {versions ? 'Hide versions' : 'Compare versions'}
          </button>
          <button className="btn btn-sm" onClick={() => void api.projects.reveal(`${dir}/${c.path}`)}>
            Show in folder
          </button>
          <span className="grow" />
          {kind === 'canonical' && (
            <button className="btn btn-sm" disabled={busy || readOnly} onClick={() => void choose('keep')}>
              Keep the file on disk
            </button>
          )}
          <button className="btn btn-sm" disabled={busy || readOnly} onClick={() => void choose('restore')}>
            {c.builderMissing ? 'Use SiteOrigin Builder’s version (remove the file)' : 'Use SiteOrigin Builder’s version'}
          </button>
        </>
      }
      details={
        versions === 'loading' ? (
          <Spinner />
        ) : versions ? (
          <div className="versions">
            <VersionText label={ours} version={versions.builder} />
            <VersionText label="The file on disk, edited outside SiteOrigin Builder" version={versions.disk} />
          </div>
        ) : undefined
      }
    >
      <strong>{conflictSubject(state, c.path)}.</strong> {conflictReason(c.reason)}
      <span className="health-path">{c.path}</span>
      <span className="health-hint">{help}</span>
    </HealthRow>
  );
}

/** The versions not used when conflicts were settled: still there to read, find in the folder, or take off the list. */
function SavedCopies({ copies, dir, readOnly }: { copies: SavedCopy[]; dir: string; readOnly: boolean }) {
  return (
    <HealthGroup title="Saved copies" count={copies.length} note="The versions you didn’t use when a file was changed in two places. They stay in this project’s recovery folder.">
      {copies.map((c) => (
        <SavedCopyRow key={c.id} copy={c} dir={dir} readOnly={readOnly} />
      ))}
    </HealthGroup>
  );
}

function SavedCopyRow({ copy: c, dir, readOnly }: { copy: SavedCopy; dir: string; readOnly: boolean }) {
  const [content, setContent] = useState<FileText | 'loading' | null>(null);
  const asked = useRef(0);
  const which = c.side === 'external' ? 'The file as edited outside SiteOrigin Builder' : 'SiteOrigin Builder’s version';
  const when = new Date(c.savedAt).toLocaleString();
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
      stacked
      actions={
        <>
          <button className="btn btn-sm" aria-expanded={!!content} onClick={() => void view()}>
            {content ? 'Hide copy' : 'View copy'}
          </button>
          {content && content !== 'loading' && content.state === 'text' && (
            <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(content.text).catch(() => undefined)}>
              Copy text
            </button>
          )}
          <button className="btn btn-sm" onClick={() => void api.projects.reveal(`${dir}/${c.file}`)}>
            Show in folder
          </button>
          {!readOnly && (
            <button className="btn btn-sm" title="The file stays in the recovery folder." onClick={() => void dismiss()}>
              Remove from list
            </button>
          )}
        </>
      }
      details={content === 'loading' ? <Spinner /> : content ? <div className="versions"><VersionText label={`${which}, as saved`} version={content} /></div> : undefined}
    >
      <strong>{which}</strong> of {c.path}, saved {when}.
    </HealthRow>
  );
}
