import { useState } from 'react';
import { CircleCheck, FolderCode, Globe, TriangleAlert } from 'lucide-react';
import type { ExportResult } from '@shared/api';
import { api, setState, useStore } from '../store';
import { Modal, Spinner } from '../components/ui';

export function ExportModal() {
  const aiBusy = useStore((s) => !!s.runStatus);
  const conflicts = useStore((s) => s.snapshot?.conflicts.length ?? 0);
  const [busy, setBusy] = useState<'static' | 'source' | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const close = () => !busy && setState({ modal: null });
  const run = async (kind: 'static' | 'source') => {
    setBusy(kind);
    setResult(null);
    const r = kind === 'static' ? await api.project.exportStatic() : await api.project.exportSource();
    setBusy(null);
    if (r.message || !r.ok) setResult(r);
  };
  const blocked = aiBusy ? 'Wait for the AI to finish before exporting.' : conflicts ? 'Resolve file conflicts (see diagnostics) before exporting.' : null;
  return (
    <Modal title="Export" onClose={close} footer={<button className="btn" onClick={close} disabled={!!busy}>Close</button>}>
      <div className="col" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: '0 0 4px' }}>
          Your website belongs to you. Export it and put it on any web host, or hand the project to a developer. It does not need SiteOrigin Builder to work.
        </p>
        {blocked && <div className="scope-note site">{blocked}</div>}
        <button className="welcome-action" disabled={!!busy || !!blocked} onClick={() => void run('static')}>
          <span className="ico">{busy === 'static' ? <Spinner /> : <Globe size={18} />}</span>
          <span className="grow">
            <strong>Static website</strong>
            <span>Plain HTML, CSS and images for every page. Upload the folder to any web host.</span>
          </span>
        </button>
        <button className="welcome-action secondary" disabled={!!busy || !!blocked} onClick={() => void run('source')}>
          <span className="ico">{busy === 'source' ? <Spinner /> : <FolderCode size={18} />}</span>
          <span className="grow">
            <strong>Source project</strong>
            <span>The complete SvelteKit project. Builds with npm without SiteOrigin Builder.</span>
          </span>
        </button>
        {busy === 'static' && <p className="muted" style={{ margin: 0 }}>Building the production site and checking every page…</p>}
        <div className="scope-note info">
          <span>
            <strong>Coming soon: SiteOrigin Hosting.</strong> Publish in one click, with your own domain. Until then, any static host works: upload the exported folder.
          </span>
        </div>
        {result && result.message && (
          <div className={`scope-note ${result.ok ? 'shared' : 'site'}`} style={{ flexDirection: 'column', gap: 8 }}>
            <div className="row">
              {result.ok ? <CircleCheck size={15} /> : <TriangleAlert size={15} />}
              <strong>{result.message}</strong>
              {result.revision !== undefined && <span className="faint">Revision {result.revision}</span>}
            </div>
            {result.path && <span className="mono" style={{ wordBreak: 'break-all', userSelect: 'text' }}>{result.path}</span>}
            {result.warnings.map((w, i) => (
              <span key={i}>• {w}</span>
            ))}
            {result.ok && (
              <div className="row">
                <button className="btn btn-sm" onClick={() => void api.projects.reveal(result.path)}>
                  Show in folder
                </button>
                {result.previewUrl && (
                  <button className="btn btn-sm" onClick={() => void api.app.openExternal(result.previewUrl!)}>
                    Preview in browser
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
