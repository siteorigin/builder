import { useState } from 'react';
import { Component, History, Redo2, Sparkles, Trash2, Undo2, User } from 'lucide-react';
import type { ElementRef } from '@shared/types';
import { instancesOf } from '@engine/tree';
import { pageLinkReferences } from '@engine/apply';
import { applyOps, api, getState, setState, useStore } from '../store';
import { Field, Modal } from '../components/ui';
import { resolveRef } from '../lib/model';
import { selectPage } from '../lib/actions';

export function CreateComponentModal({ target }: { target: ElementRef }) {
  const [name, setName] = useState('');
  const close = () => setState({ modal: null });
  const create = async () => {
    const r = await applyOps([{ type: 'component.createFromNode', owner: target.owner, nodeId: target.nodeId, name: name.trim() }], `Create component ${name.trim()}`);
    if (r?.[0]?.nodeId) setState({ modal: null, selection: { owner: target.owner, instancePath: [], nodeId: r[0].nodeId as string } });
  };
  return (
    <Modal
      title="Create component"
      icon={<Component />}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void create()}>
            Create component
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          Turn this into a component you can reuse. Each copy keeps its own text, images and buttons, while its layout and style stay in step everywhere.
        </p>
        <Field label="Component name">
          <input className="input" autoFocus value={name} placeholder="Feature highlight" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
        </Field>
      </div>
    </Modal>
  );
}

export function DeletePageModal({ pageId }: { pageId: string }) {
  const snap = useStore((s) => s.snapshot);
  const st = snap!.state;
  const page = st.pages[pageId];
  const others = st.site.pageOrder.filter((id) => id !== pageId);
  const [replacement, setReplacement] = useState(st.site.homePageId === pageId ? others[0] : st.site.homePageId);
  const refs = pageLinkReferences(st, pageId);
  const close = () => setState({ modal: null });
  if (!page) return null;
  return (
    <Modal
      title={`Delete “${page.title}”?`}
      icon={<Trash2 style={{ color: 'var(--red)' }} />}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn-danger-fill"
            onClick={async () => {
              if (await applyOps([{ type: 'page.remove', pageId, replacementPageId: refs || pageId === st.site.homePageId ? replacement : undefined }], `Delete page ${page.title}`)) {
                setState({ modal: null });
                selectPage(replacement ?? st.site.homePageId);
              }
            }}
          >
            Delete page
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p style={{ margin: 0 }}>The page and its content are removed from your site. You can undo this.</p>
        {(refs > 0 || pageId === st.site.homePageId) && (
          <Field
            label={pageId === st.site.homePageId ? 'New home page' : 'Point existing links to'}
            hint={refs ? `${refs} link${refs === 1 ? '' : 's'} (including navigation) currently point to this page.` : 'Another page must become Home.'}
          >
            <select className="select" value={replacement} onChange={(e) => setReplacement(e.target.value)}>
              {others.map((id) => (
                <option key={id} value={id}>
                  {st.pages[id].title}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function EditDefinitionModal({ target }: { target: ElementRef }) {
  const snap = useStore((s) => s.snapshot);
  const st = snap!.state;
  const r = resolveRef(st, target);
  const node = r.node?.kind === 'instance' ? r.node : null;
  const def = node ? st.components[node.definitionId] : undefined;
  if (!def || !node) return null;
  const uses = instancesOf(st, def.id);
  const close = () => setState({ modal: null });
  const go = async () => {
    let defId = def.id;
    if (def.owner === 'theme') {
      const res = await applyOps([{ type: 'component.fork', definitionId: def.id }], `Make ${def.name} a project component`);
      if (!res) return;
      defId = res[0].definitionId as string;
    }
    setState({
      modal: null,
      definitionMode: { definitionId: defId, returnPageId: getState().pageId! },
      selection: { owner: target.owner, instancePath: [node.id], nodeId: def.tree!.rootIds[0] },
      rightTab: 'inspect'
    });
  };
  return (
    <Modal
      title={`Change ${def.name} everywhere?`}
      icon={<Component style={{ color: 'var(--plum)' }} />}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void go()}>
            {def.owner === 'theme' ? 'Make a copy and edit' : 'Edit everywhere'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <p style={{ margin: 0 }}>
          Changes to its layout and styles apply to <strong>{uses.length === 1 ? 'its one placement' : `all ${uses.length} placements`}</strong>. Each placement keeps its own text and images, and any changes made to it directly.
        </p>
        <div className="field-label">Used on</div>
        <ul style={{ margin: '-6px 0 0', paddingLeft: 18 }}>
          {[...new Set(uses.map((u) => u.label))].map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {def.owner === 'theme' && (
          <div className="scope-note definition">
            <Component />
            <span>
              {def.name} comes with the Foundation theme. Editing it makes your own copy and switches {uses.length === 1 ? 'that placement' : `these ${uses.length} placements`} to it. The original stays available in Insert.
            </span>
          </div>
        )}
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          While editing, click parts on the page to change their styles. Choose Done editing in the bar at the top to return.
        </p>
      </div>
    </Modal>
  );
}

export function HistoryModal() {
  const snap = useStore((s) => s.snapshot);
  const entries = [...(snap?.history.entries ?? [])].reverse();
  return (
    <Modal
      title="History"
      icon={<History />}
      onClose={() => setState({ modal: null })}
      footer={
        <>
          <button className="btn" disabled={!snap?.history.canUndo} onClick={() => void api.project.undo()}>
            <Undo2 /> Undo
          </button>
          <button className="btn" disabled={!snap?.history.canRedo} onClick={() => void api.project.redo()}>
            <Redo2 /> Redo
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => setState({ modal: null })}>
            Close
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Your last 100 changes, newest first. Undo steps back one change at a time; anything undone can be redone until you make a new change.
      </p>
      {entries.length === 0 ? (
        <div className="empty-insp" style={{ padding: '28px 12px' }}>
          <History />
          <span>No changes yet. Your edits will appear here as you work.</span>
        </div>
      ) : (
        <ol className="history-list">
          {entries.map((e) => (
            <li key={e.id} className={e.applied ? '' : 'undone'}>
              {e.source === 'ai' ? <Sparkles aria-label="By AI" /> : <User aria-label="By you" />}
              <span className="grow ellipsis">{e.label}</span>
              {!e.applied && <span className="badge">Undone</span>}
              <time>{new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
