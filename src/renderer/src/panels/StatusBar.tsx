import { useState } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, Component, Ellipsis, Lock, RefreshCw, Stethoscope, TriangleAlert, Wrench } from 'lucide-react';
import type { RuntimeState } from '@shared/api';
import { api, applyOps, confirmDialog, setState, toast, useStore } from '../store';
import { refKey } from '@shared/types';
import { breadcrumb, inDefinition, type Crumb } from '../lib/model';
import { openAsset } from '../lib/actions';
import { Modal, useMenu } from '../components/ui';
import { useTransitionAnnouncement } from '../lib/announce';

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
    if (b !== pb) return b ? `Preview problem. ${e} problem${e === 1 ? '' : 's'} in this project` : `Preview working again${e ? `. ${e} problem${e === 1 ? '' : 's'} remain` : ''}`;
    if (c !== pc && e - c === pe - pc && w === pw) return null;
    return e ? `${e} problem${e === 1 ? '' : 's'} in this project` : w ? `${w} warning${w === 1 ? '' : 's'} in this project` : 'No problems';
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
  const problemText = errors ? `${errors} problem${errors === 1 ? '' : 's'}` : warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'No problems';
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
      </nav>
      <button className={`problems${errors ? ' error' : warnings ? ' warn' : ''}`} onClick={() => setState({ modal: { kind: 'health' } })} title="Project health: check this project for problems">
        {errors ? <CircleAlert /> : warnings ? <TriangleAlert /> : <CircleCheck />}
        {problemText}
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

export function HealthModal() {
  const snap = useStore((s) => s.snapshot);
  const runtime = useStore((s) => s.runtime);
  const pageIssue = useStore((s) => s.previewIssue);
  const frameReady = useStore((s) => s.frameReady);
  if (!snap) return null;
  // The tools line describes the website tools only; a page problem is listed separately below.
  const { label } = runtimeInfo(runtime, null, true);
  void frameReady;
  const close = () => setState({ modal: null });
  const [busy, setBusy] = useState<string | null>(null);
  const resolve = async (path: string, choice: 'keep' | 'restore') => {
    setBusy(path);
    try {
      const r = await api.project.resolveConflict(path, choice);
      if (!r.ok && r.message) toast(r.message, 'error');
    } catch (e) {
      toast(`The conflict could not be resolved: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const updateTheme = async () => {
    setBusy('theme');
    try {
      await applyOps([{ type: 'theme.refresh' }], 'Update theme components');
    } finally {
      setBusy(null);
    }
  };
  const unlock = async () => {
    const ok = await confirmDialog({
      title: 'Unlock this project?',
      body: 'Only unlock it if SiteOrigin Builder is no longer running on the other computer or account. Two apps editing the same project can overwrite each other’s changes.',
      confirmLabel: 'Unlock and edit',
      cancelLabel: 'Keep read-only',
      danger: true
    });
    if (ok !== true) return;
    const r = await api.project.unlock().catch((e: Error) => ({ ok: false, message: e.message }));
    if (!r.ok && r.message) toast(r.message, 'error');
    else close();
  };
  return (
   <Modal
          title="Project health"
          icon={<Stethoscope />}
          onClose={() => close()}
          wide={snap.diagnostics.length + snap.conflicts.length > 0 || (runtime.state === 'error' && !!runtime.detail)}
          footer={
            <button className="btn" onClick={() => close()}>
              Close
            </button>
          }
        >
          <div className="scope-note info" style={{ marginBottom: 12, alignItems: 'center' }}>
            <Wrench />
            <span className="grow">
              <strong>Website tools: {label.toLowerCase()}.</strong> They are set up inside this project folder. Reinstall them if the preview will not start.
            </span>
            {!snap.readOnly && (
              <button className="btn btn-sm" disabled={runtime.state === 'preparing'} onClick={() => void api.project.repairDependencies()}>
                Reinstall
              </button>
            )}
          </div>
          {pageIssue && runtime.state === 'ready' && (
            <div className="scope-note danger" style={{ marginBottom: 12 }}>
              <CircleAlert />
              <span className="grow">
                <strong>This page couldn’t be previewed.</strong> Something on it failed to show. Undo your last change, or try again.
                <span className="mono" style={{ display: 'block', marginTop: 4, fontSize: 12, color: 'var(--text-2)', userSelect: 'text', overflowWrap: 'anywhere' }}>
                  {pageIssue}
                </span>
              </span>
            </div>
          )}
          {snap.readOnly && (
            <div className="scope-note info" style={{ marginBottom: 12, alignItems: 'center' }}>
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
          {!!snap.themeUpdates?.available.length && (
            <div className="scope-note info" style={{ marginBottom: 12, alignItems: 'center' }}>
              <RefreshCw />
              <span className="grow" title={snap.themeUpdates.available.map((u) => u.name).join(', ')}>
                <strong>
                  {snap.themeUpdates.available.length} theme component{snap.themeUpdates.available.length === 1 ? ' has' : 's have'} an update.
                </strong>{' '}
                Your content and changes stay. Components you forked are not touched, and you can undo this.
                {!!snap.themeUpdates.kept.length && ` ${snap.themeUpdates.kept.length} more can’t be updated automatically.`}
              </span>
              <button className="btn btn-sm" disabled={!!busy || !!snap.conflicts.length} onClick={() => void updateTheme()}>
                Update
              </button>
            </div>
          )}
          {snap.diagnostics.length === 0 && snap.conflicts.length === 0 && !pageIssue && runtime.state !== 'error' && (
            <div className="scope-note shared">
              <CircleCheck />
              <span>No problems found. Every page, component and style in this project checks out.</span>
            </div>
          )}
          <div className="col" style={{ gap: 6 }}>
            {/* Conflicts are listed below with their actions, so their diagnostic copies are skipped here. */}
            {snap.diagnostics.filter((d) => d.code !== 'CONFLICT').map((d, i) => {
              // An image whose files are missing keeps its uses: say how many, and open it where it can be fixed.
              const asset = d.code === 'ASSET_FILE_MISSING' && d.owner?.kind === 'asset' ? d.owner.id : null;
              const uses = asset ? (snap.assetUsage[asset] ?? 0) : 0;
              return (
                <div key={i} className={`scope-note ${d.severity === 'error' ? 'danger' : 'site'}`} style={asset ? { alignItems: 'center' } : undefined}>
                  {d.severity === 'error' ? <CircleAlert /> : <TriangleAlert />}
                  <span className="grow">
                    {d.message}
                    {asset && <> {uses ? `It is used ${uses === 1 ? 'once' : uses === 2 ? 'twice' : `${uses} times`}, and every use is kept.` : 'Nothing uses it.'}</>}
                  </span>
                  {asset && (
                    <button className="btn btn-sm" onClick={() => openAsset(asset)}>
                      Open in Assets
                    </button>
                  )}
                </div>
              );
            })}
            {snap.conflicts.map((c) => (
              <div key={c.path} className="scope-note danger">
                <CircleAlert />
                <span className="grow">
                  <strong>{c.path}</strong>: {c.reason}
                </span>
                {/* An older snapshot without a kind: generated conflicts were the ones whose reason says so. */}
                {(c.kind ?? (c.reason.startsWith('Generated') ? 'generated' : 'canonical')) === 'canonical' ? (
                  <>
                    <button className="btn btn-sm" disabled={!!busy} title="Use the file as it is now on disk" onClick={() => void resolve(c.path, 'keep')}>
                      Keep external changes
                    </button>
                    <button className="btn btn-sm" disabled={!!busy} title="Put back SiteOrigin Builder’s version. The external file is saved in the project’s recovery folder." onClick={() => void resolve(c.path, 'restore')}>
                      Restore Builder version
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => void resolve(c.path, 'restore')}>
                    Restore
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => void api.projects.reveal(`${snap.dir}/${c.path}`)}>
                  Show file
                </button>
              </div>
            ))}
          </div>
          {runtime.state === 'error' && runtime.detail && <pre className="code-view" style={{ height: 'auto', maxHeight: 240, marginTop: 12 }}>{runtime.detail}</pre>}
        </Modal>
  );
}
