import { useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { api, applyOps, toast, useStore } from '../store';
import { Field, DraftInput } from '../components/ui';
import { assetUrl } from '../lib/model';

export function AssetsPanel() {
  const snap = useStore((s) => s.snapshot);
  const runtime = useStore((s) => s.runtime);
  const [over, setOver] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  if (!snap) return null;
  const assets = Object.values(snap.state.assets.assets).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const sel = selected ? snap.state.assets.assets[selected] : null;
  const unused = assets.filter((a) => !snap.assetUsage[a.id]);

  const importFiles = async (paths?: string[]) => {
    const r = await api.project.importAssets(paths);
    if (r.message) toast(r.message, r.ok ? 'info' : 'error');
    else if (r.assetIds.length) toast(`Imported ${r.assetIds.length} image${r.assetIds.length === 1 ? '' : 's'}.`);
  };

  return (
    <>
      <div className="panel-head">
        <h3>Assets</h3>
        <button className="icon-btn sm" title="Import images" aria-label="Import images" onClick={() => void importFiles()}>
          <ImagePlus />
        </button>
      </div>
      <div
        className="panel-body"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
          if (paths.length) void importFiles(paths);
          else void importFiles();
        }}
      >
        <button className={`dropzone${over ? ' over' : ''}`} style={{ width: 'calc(100% - 20px)' }} onClick={() => void importFiles()}>
          Drop images here or click to import
          <br />
          <span style={{ fontSize: 11 }}>JPEG, PNG, WebP, GIF, AVIF or plain SVG</span>
        </button>
        {assets.length === 0 ? (
          <p className="faint" style={{ padding: '8px 16px' }}>
            No images yet.
          </p>
        ) : (
          <div className="asset-grid">
            {assets.map((a) => (
              <button key={a.id} className={`asset-tile${selected === a.id ? ' selected' : ''}`} onClick={() => setSelected(selected === a.id ? null : a.id)} title={a.name}>
                <div className="thumb">{devUrl ? <img src={assetUrl(devUrl, a.file)!} alt="" loading="lazy" /> : null}</div>
                <span className="ellipsis">{a.name}</span>
                <span className={`badge uses${snap.assetUsage[a.id] ? ' accent' : ''}`}>{snap.assetUsage[a.id] ? `${snap.assetUsage[a.id]} use${snap.assetUsage[a.id] === 1 ? '' : 's'}` : 'Unused'}</span>
              </button>
            ))}
          </div>
        )}
        {sel && (
          <div className="col" style={{ padding: '4px 12px 16px', gap: 10 }}>
            <Field label="Name">
              <DraftInput value={sel.name} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, name: v }], 'Rename image')} />
            </Field>
            <Field label="Description" hint="Helps you and the AI choose images. The AI never sees image contents.">
              <DraftInput multiline value={sel.description ?? ''} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, description: v }], 'Describe image')} />
            </Field>
            <Field label="Suggested alt text" hint="Used as the starting alt text when you place this image.">
              <DraftInput value={sel.altSuggestion ?? ''} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, altSuggestion: v }], 'Edit alt suggestion')} />
            </Field>
            <p className="faint" style={{ margin: 0, fontSize: 11.5 }}>
              {sel.width && sel.height ? `${sel.width} × ${sel.height}px · ` : ''}
              {(sel.bytes / 1024).toFixed(0)} KB · {sel.mime}
              {sel.bytes > 1_500_000 && <span style={{ color: 'var(--amber)' }}> · Large file</span>}
            </p>
            <div className="row">
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const r = await api.project.importAssets();
                  const id = r.assetIds[0];
                  if (id && id !== sel.id && (await applyOps([{ type: 'asset.replace', assetId: sel.id, withAssetId: id }], 'Replace image'))) toast(`Replaced every use of ${sel.name}.`);
                }}
              >
                Replace everywhere…
              </button>
              <button
                className="btn btn-sm btn-danger"
                disabled={!!snap.assetUsage[sel.id]}
                title={snap.assetUsage[sel.id] ? 'Remove its uses first' : 'Remove image'}
                onClick={async () => {
                  if (await applyOps([{ type: 'asset.remove', assetId: sel.id }], 'Remove image')) setSelected(null);
                }}
              >
                <Trash2 /> Remove
              </button>
            </div>
          </div>
        )}
        {unused.length > 1 && (
          <div style={{ padding: '0 12px 16px' }}>
            <button className="btn btn-sm btn-ghost" onClick={() => void applyOps(unused.map((a) => ({ type: 'asset.remove' as const, assetId: a.id })), 'Remove unused images')}>
              <Trash2 /> Remove {unused.length} unused images
            </button>
          </div>
        )}
      </div>
    </>
  );
}
