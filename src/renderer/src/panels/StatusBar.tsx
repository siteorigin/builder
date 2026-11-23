import { useState } from 'react';
import { ChevronRight, CircleAlert, TriangleAlert, Wrench } from 'lucide-react';
import { api, setState, useStore } from '../store';
import { breadcrumb } from '../lib/model';
import { Modal } from '../components/ui';

export function StatusBar() {
  const snap = useStore((s) => s.snapshot);
  const runtime = useStore((s) => s.runtime);
  const selection = useStore((s) => s.selection);
  const viewport = useStore((s) => s.viewport);
  const [showDiag, setShowDiag] = useState(false);
  if (!snap) return null;
  const errors = snap.diagnostics.filter((d) => d.severity === 'error');
  const warnings = snap.diagnostics.filter((d) => d.severity === 'warning');
  const dot = runtime.state === 'ready' ? 'ready' : runtime.state === 'error' ? 'error' : 'busy';
  const label = runtime.state === 'ready' ? 'Preview ready' : runtime.state === 'error' ? 'Preview error' : runtime.state === 'preparing' ? 'Setting up website tools' : runtime.state === 'starting' ? 'Starting preview' : 'Preview stopped';
  const crumbs = selection ? breadcrumb(snap.state, selection) : [];
  return (
    <footer className="status-bar">
      <span className="row" style={{ gap: 6 }}>
        <span className={`status-dot ${dot}`} />
        {label}
      </span>
      <span className="faint">·</span>
      <span className="faint">{viewport < 768 ? 'Phone' : viewport < 1024 ? 'Tablet' : 'Desktop'} styles</span>
      <nav className="crumbs grow" aria-label="Selection path">
        {crumbs.map((c, i) => (
          <span key={i} className="row" style={{ gap: 2 }}>
            {i > 0 && <ChevronRight />}
            <button onClick={() => setState({ selection: c.ref })}>{c.label}</button>
          </span>
        ))}
      </nav>
      <button onClick={() => setShowDiag(true)} title="Show diagnostics">
        {errors.length ? <CircleAlert color="var(--red)" /> : warnings.length ? <TriangleAlert color="var(--amber)" /> : <Wrench />}
        {errors.length ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'No problems'}
      </button>
      <span className="faint">rev {snap.revision}</span>
      {showDiag && (
        <Modal title="Diagnostics" onClose={() => setShowDiag(false)} wide>
          <div className="scope-note info" style={{ marginBottom: 12, alignItems: 'center' }}>
            <span className={`status-dot ${dot}`} />
            <span className="grow">
              <strong>Website tools:</strong> {label.toLowerCase()}. They are bundled with SiteOrigin Builder and installed into this project's node_modules folder.
            </span>
            <button className="btn btn-sm" disabled={runtime.state === 'preparing'} onClick={() => void api.project.repairDependencies()}>
              Reinstall
            </button>
          </div>
          {snap.diagnostics.length === 0 && <p className="muted">No problems found in the project documents.</p>}
          <div className="col" style={{ gap: 6 }}>
            {snap.diagnostics.map((d, i) => (
              <div key={i} className={`scope-note ${d.severity === 'error' ? 'site' : 'info'}`}>
                {d.severity === 'error' ? <CircleAlert /> : <TriangleAlert />}
                <span className="grow">{d.message}</span>
              </div>
            ))}
            {snap.conflicts.map((c) => (
              <div key={c.path} className="scope-note site">
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
      )}
    </footer>
  );
}
