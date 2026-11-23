import { useState } from 'react';
import { ArrowLeft, ImagePlus, Trash2 } from 'lucide-react';
import { api, applyOps, toast, useStore } from '../store';
import { Field, DraftInput } from '../components/ui';
import { assetUrl } from '../lib/model';

export function AssetsPanel() {
  const snap = useStore((s) => s.snapshot);
  const runtime = useStore((s) => s.runtime);
  const [over, setOver] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const back = () => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-asset="${id}"]`)?.focus());
  };
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
        {!sel && (
          <button className={`dropzone${over ? ' over' : ''}`} onClick={() => void importFiles()} title="JPEG, PNG, WebP, GIF, AVIF or SVG">
            <ImagePlus />
            <b>Add images</b>
            <span>Drop them here, or click to choose</span>
          </button>
        )}
        {/* An image's details replace the grid (in place, with its own picture), so the fields are where
            the eye and the keyboard go next; Back returns to the same tile. */}
        {sel && (
          <div className="asset-detail col" id="asset-detail" style={{ gap: 10 }}>
            <button className="btn btn-sm btn-ghost asset-back" autoFocus onClick={back}>
              <ArrowLeft /> All images
            </button>
            {devUrl && (
              <div className="asset-preview">
                <img src={assetUrl(devUrl, sel.file)!} alt="" />
              </div>
            )}
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong className="ellipsis">{sel.name}</strong>
              <span className="faint" style={{ fontSize: 12, flex: 'none' }}>
                {snap.assetUsage[sel.id] ? `Used ${snap.assetUsage[sel.id] === 1 ? 'once' : `${snap.assetUsage[sel.id]} times`}` : 'Not used yet'}
              </span>
            </div>
            <Field label="Name">
              <DraftInput value={sel.name} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, name: v }], 'Rename image')} />
            </Field>
            <Field label="Description" hint="Helps you and the AI choose images. The AI never sees image contents.">
              <DraftInput multiline value={sel.description ?? ''} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, description: v }], 'Describe image')} />
            </Field>
            <Field label="Suggested alt text" hint="Used as the starting alt text when you place this image.">
              <DraftInput value={sel.altSuggestion ?? ''} onCommit={(v) => void applyOps([{ type: 'asset.update', assetId: sel.id, altSuggestion: v }], 'Edit alt suggestion')} />
            </Field>
            <p className="faint" style={{ margin: 0, fontSize: 12 }}>
              {sel.width && sel.height ? `${sel.width} × ${sel.height}px · ` : ''}
              {(sel.bytes / 1024).toFixed(0)} KB · {sel.mime.replace(/^image\//, '').toUpperCase()}
              {sel.bytes > 1_500_000 && <span style={{ color: 'var(--amber)' }}> · Large file</span>}
            </p>
            <div className="row wrap">
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
                title={snap.assetUsage[sel.id] ? 'This image is in use. Replace or remove it on the page first.' : 'Remove image'}
                onClick={async () => {
                  if (await applyOps([{ type: 'asset.remove', assetId: sel.id }], 'Remove image')) setSelected(null);
                }}
              >
                <Trash2 /> Remove
              </button>
            </div>
            {!!snap.assetUsage[sel.id] && <p className="field-hint" style={{ margin: 0 }}>To remove this image, replace it or take it off the page first.</p>}
          </div>
        )}
        {sel ? null : assets.length === 0 ? (
          <p className="muted" style={{ padding: '8px 16px', margin: 0 }}>
            No images yet. Images you add are copied into this project, so the site keeps working wherever it goes.
          </p>
        ) : (
          <div className="asset-grid">
            {assets.map((a) => (
              <button key={a.id} data-asset={a.id} className={`asset-tile${selected === a.id ? ' selected' : ''}`} aria-pressed={selected === a.id} aria-controls={selected === a.id ? 'asset-detail' : undefined} onClick={() => setSelected(a.id)} title={a.name}>
                <div className="thumb">{devUrl ? <img src={assetUrl(devUrl, a.file)!} alt="" loading="lazy" /> : null}</div>
                <span>
                  <span className="ellipsis">{a.name}</span>
                  {!snap.assetUsage[a.id] && (
                    <span className="uses none" title="Not used on any page">
                      Unused
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
        {!sel && unused.length > 1 && (
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
