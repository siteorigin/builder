import { ChevronRight, CircleAlert, CircleCheck, Stethoscope, TriangleAlert, Wrench } from 'lucide-react';
import type { RuntimeState } from '@shared/api';
import { api, setState, useStore } from '../store';
import { breadcrumb } from '../lib/model';
import { Modal } from '../components/ui';

function runtimeInfo(runtime: RuntimeState, pageIssue: string | null, frameReady: boolean) {
  const broken = runtime.state === 'error' || (runtime.state === 'ready' && !!pageIssue);
  // "Ready" means the page itself has loaded, not only that the website tools are running.
  const opening = runtime.state === 'ready' && !frameReady && !broken;
  const dot = broken ? 'error' : opening ? 'busy' : runtime.state === 'ready' ? 'ready' : runtime.state === 'preparing' || runtime.state === 'starting' ? 'busy' : 'stopped';
  const label = broken ? 'Preview problem' : opening ? 'Opening page' : runtime.state === 'ready' ? 'Preview ready' : runtime.state === 'preparing' ? 'Setting up website tools' : runtime.state === 'starting' ? 'Starting preview' : 'Preview paused';
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
  if (!snap) return null;
  // Problems = document errors plus file conflicts, so this never says "No problems" while the toolbar shows a conflict.
  const { dot, label, broken } = runtimeInfo(runtime, pageIssue, frameReady);
  const errors = snap.diagnostics.filter((d) => d.severity === 'error').length + snap.conflicts.length + (broken ? 1 : 0);
  const warnings = snap.diagnostics.filter((d) => d.severity === 'warning').length;
  // While editing a component everywhere, the path starts at the component (plum), never at a page.
  const def = definitionMode ? snap.state.components[definitionMode.definitionId] : undefined;
  const crumbs = def
    ? [{ label: def.name, ref: null as null | NonNullable<typeof selection>, def: true }, ...(selection && selection.nodeId !== def.tree?.rootIds[0] ? [{ label: selection.partId ? def.parts[selection.partId]?.label ?? 'Part' : 'Element', ref: selection, def: false }] : [])]
    : selection && !stylesOpen
      ? breadcrumb(snap.state, selection).map((c) => ({ ...c, def: false }))
      : [];
  return (
    <footer className="status-bar">
      <button className="row" style={{ gap: 6 }} aria-live="polite" title="Preview status: open Project health" onClick={() => setState({ modal: { kind: 'health' } })}>
        <span className={`status-dot ${dot}`} aria-hidden="true" />
        {label}
      </button>
      {crumbs.length > 0 && <span className="faint" aria-hidden="true">·</span>}
      <nav className="crumbs grow" aria-label="Selected element">
        {crumbs.map((c, i) => (
          <span key={i} className="row" style={{ gap: 2 }}>
            {i > 0 && <ChevronRight />}
            <button className={c.def ? 'def' : undefined} onClick={() => setState({ selection: c.ref })}>
              {c.label}
            </button>
          </span>
        ))}
      </nav>
      <button onClick={() => setState({ modal: { kind: 'health' } })} title="Project health: check this project for problems">
        {errors ? <CircleAlert color="var(--red)" /> : warnings ? <TriangleAlert color="var(--amber)" /> : <CircleCheck color="var(--green)" />}
        {errors ? `${errors} problem${errors === 1 ? '' : 's'}` : warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'No problems'}
      </button>
      {dev && <span className="faint" title="Document revision">rev {snap.revision}</span>}
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
              <strong>Website tools: {label.toLowerCase()}.</strong> They come with SiteOrigin Builder and are set up inside this project folder. Reinstall them if the preview will not start.
            </span>
            <button className="btn btn-sm" disabled={runtime.state === 'preparing'} onClick={() => void api.project.repairDependencies()}>
              Reinstall
            </button>
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
          {snap.diagnostics.length === 0 && snap.conflicts.length === 0 && !pageIssue && runtime.state !== 'error' && (
            <div className="scope-note shared">
              <CircleCheck />
              <span>No problems found. Every page, component and style in this project checks out.</span>
            </div>
          )}
          <div className="col" style={{ gap: 6 }}>
            {snap.diagnostics.map((d, i) => (
              <div key={i} className={`scope-note ${d.severity === 'error' ? 'danger' : 'site'}`}>
                {d.severity === 'error' ? <CircleAlert /> : <TriangleAlert />}
                <span className="grow">{d.message}</span>
              </div>
            ))}
            {snap.conflicts.map((c) => (
              <div key={c.path} className="scope-note danger">
                <CircleAlert />
                <span className="grow">
                  <strong>{c.path}</strong>: {c.reason}
                </span>
                {c.reason.startsWith('Generated') && (
                  <button className="btn btn-sm" onClick={() => void api.project.restoreGenerated(c.path)}>
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
