import { useState } from 'react';
import { ChevronRight, CircleCheck, Cloud, FolderCode, Globe, TriangleAlert, Upload } from 'lucide-react';
import type { ExportFormat, ExportResult, RecentExport } from '@shared/api';
import { api, setState, useStore } from '../store';
import { Modal, Segmented, Spinner } from '../components/ui';

const NO_EXPORTS: RecentExport[] = [];

/** When an export finished: the time today, or the date and time on an earlier day. */
function finishedAt(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export function ExportModal() {
  const aiBusy = useStore((s) => !!s.runStatus);
  const conflicts = useStore((s) => s.snapshot?.conflicts.length ?? 0);
  // Kept by the project, not this dialog: closing and reopening it still shows what was handed off.
  const recent = useStore((s) => s.snapshot?.recentExports ?? NO_EXPORTS);
  const [busy, setBusy] = useState<'static' | 'source' | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [format, setFormat] = useState<ExportFormat>('folder');
  const close = () => !busy && setState({ modal: null });
  const run = async (kind: 'static' | 'source') => {
    setBusy(kind);
    setResult(null);
    try {
      const r = kind === 'static' ? await api.project.exportStatic(format) : await api.project.exportSource(format);
      if (r.message || !r.ok) setResult(r);
    } catch (e) {
      setResult({ ok: false, message: 'The export could not be completed.', warnings: [(e as Error).message] });
    } finally {
      setBusy(null);
    }
  };
  const blocked = aiBusy ? 'Wait for the AI to finish before exporting.' : conflicts ? 'A project file changed outside SiteOrigin Builder. Resolve it in Project health before exporting.' : null;
  return (
    <Modal title="Export your website" icon={<Upload />} onClose={close} busy={!!busy} footer={<button className="btn" onClick={close} disabled={!!busy}>Close</button>}>
      <div className="col" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: '0 0 4px' }}>
          Your website belongs to you. Put it on any web host, or hand it to a developer. It does not need SiteOrigin Builder to work.
        </p>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="muted" id="export-format-label">Save as</span>
          <Segmented
            label="Save as"
            value={format}
            onChange={(v) => !busy && setFormat(v)}
            options={[
              { value: 'folder', label: 'Folder' },
              { value: 'zip', label: 'ZIP file' }
            ]}
          />
        </div>
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
            <span>{format === 'zip' ? 'Every page as a finished website, in one ZIP file to upload to any web host.' : 'Every page as a finished website folder. Upload it to any web host.'}</span>
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
            {result.path && <span style={{ wordBreak: 'break-all', userSelect: 'text', color: 'var(--text-2)' }}>{result.path}</span>}
            {result.warnings.map((w, i) => (
              <span key={i}>• {w}</span>
            ))}
          </div>
        )}
        {recent.length > 0 && (
          <section className="export-history" aria-labelledby="export-history-title">
            <h3 id="export-history-title">Recent exports</h3>
            <p className="faint">Each website folder keeps its own preview running until you close this project, so you can compare them side by side.</p>
            <ul>
              {recent.map((e, i) => (
                <li key={`${e.path}\n${e.exportedAt}`}>
                  <div className="row export-history-head">
                    <strong className="grow">
                      {e.kind === 'site' ? 'Website' : 'Editable project'}
                      {e.format === 'zip' ? ' (ZIP file)' : ''}
                    </strong>
                    <span className="faint">
                      <time dateTime={e.exportedAt}>{finishedAt(e.exportedAt)}</time> · revision {e.revision}
                    </span>
                  </div>
                  <span className="export-history-path" id={`export-history-path-${i}`}>
                    {e.path}
                  </span>
                  <div className="row">
                    <button className="btn btn-sm" aria-describedby={`export-history-path-${i}`} onClick={() => void api.projects.reveal(e.path)}>
                      Show in folder
                    </button>
                    {e.previewUrl && (
                      <button className="btn btn-sm" aria-describedby={`export-history-path-${i}`} title={e.previewUrl} onClick={() => void api.app.openExternal(e.previewUrl!)}>
                        Preview in browser
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
