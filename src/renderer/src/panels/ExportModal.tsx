import { useState } from 'react';
import { ChevronRight, CircleCheck, Cloud, FolderCode, Globe, TriangleAlert, Upload } from 'lucide-react';
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
  const blocked = aiBusy ? 'Wait for the AI to finish before exporting.' : conflicts ? 'A project file changed outside SiteOrigin Builder. Resolve it in Project health before exporting.' : null;
  return (
    <Modal title="Export your website" icon={<Upload />} onClose={close} footer={<button className="btn" onClick={close} disabled={!!busy}>Close</button>}>
      <div className="col" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: '0 0 4px' }}>
          Your website belongs to you. Put it on any web host, or hand it to a developer. It does not need SiteOrigin Builder to work.
        </p>
        {blocked && (
          <div className="scope-note site" role="status">
            <TriangleAlert />
            <span className="grow">{blocked}</span>
            {conflicts > 0 && !aiBusy && (
              <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'health' } })}>
                Open project health
              </button>
            )}
          </div>
        )}
        <button className="welcome-action" disabled={!!busy || !!blocked} onClick={() => void run('static')}>
          <span className="ico">{busy === 'static' ? <Spinner decorative /> : <Globe size={18} />}</span>
          <span className="grow">
            <strong>Website files, ready to upload</strong>
            <span>Every page as a finished website folder. Upload it to any web host.</span>
          </span>
          <ChevronRight className="chev" />
        </button>
        <button className="welcome-action secondary" disabled={!!busy || !!blocked} onClick={() => void run('source')}>
          <span className="ico">{busy === 'source' ? <Spinner decorative /> : <FolderCode size={18} />}</span>
          <span className="grow">
            <strong>Editable project, for a developer</strong>
            <span>The complete project, so a developer can keep building it with standard tools.</span>
          </span>
          <ChevronRight className="chev" />
        </button>
        {busy === 'static' && (
          <p className="muted" role="status" style={{ margin: 0 }}>
            Building your website and checking every page…
          </p>
        )}
        <p className="faint" style={{ margin: '2px 0 0', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <Cloud size={14} /> One-click publishing with SiteOrigin Hosting is coming soon.
        </p>
        {result && result.message && (
          <div className={`scope-note ${result.ok ? 'shared' : 'danger'}`} role={result.ok ? 'status' : 'alert'} style={{ flexDirection: 'column', gap: 8 }}>
            <div className="row">
              {result.ok ? <CircleCheck size={15} /> : <TriangleAlert size={15} />}
              <strong>{result.message}</strong>

            </div>
            {result.path && <span style={{ wordBreak: 'break-all', userSelect: 'text', color: 'var(--text-2)' }}>{result.path.replace(/^\/Users\/[^/]+/, '~')}</span>}
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
