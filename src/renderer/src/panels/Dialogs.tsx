import { useState } from 'react';
import { Component, History, Sparkles, Trash2, User } from 'lucide-react';
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
      icon={<Component size={18} color="var(--violet)" />}
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
          The selection becomes a reusable project component. Its text, images and buttons become properties, so each copy can have its own content while sharing layout and style.
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
      icon={<Trash2 size={18} color="var(--red)" />}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            style={{ background: 'var(--red)' }}
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
        <p style={{ margin: 0 }}>You can undo this from the toolbar.</p>
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
      title={`Edit ${def.name} definition`}
      icon={<Component size={18} color="var(--violet)" />}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void go()}>
            {def.owner === 'theme' ? 'Create project copy and edit' : 'Edit definition'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <p style={{ margin: 0 }}>
          Changes to the definition's layout and default styles apply to <strong>{uses.length === 1 ? 'its 1 use' : `all ${uses.length} uses`}</strong>. Each use keeps its own content and its own overrides.
        </p>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          {[...new Set(uses.map((u) => u.label))].map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {def.owner === 'theme' && (
          <div className="scope-note definition">
            <Component />
            <span>
              {def.name} comes from the Foundation theme. Editing it first makes a project-owned copy and switches {uses.length === 1 ? 'that use' : `these ${uses.length} uses`} to it. The original stays available in Insert.
            </span>
          </div>
        )}
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          In definition mode, select parts on the canvas to change their default styles. Choose Done in the toolbar to return.
        </p>
      </div>
    </Modal>
  );
}

export function HistoryModal() {
  const snap = useStore((s) => s.snapshot);
  const entries = [...(snap?.history.entries ?? [])].reverse();
  return (
    <Modal title="History" icon={<History size={18} className="faint" />} onClose={() => setState({ modal: null })}>
      <p className="muted" style={{ marginTop: 0 }}>
        Undo moves back one change at a time. Changes after the current point can be redone.
      </p>
      <div className="list" style={{ padding: 0 }}>
        {entries.length === 0 && <p className="faint">No changes yet.</p>}
        {entries.map((e) => (
          <div key={e.id} className="list-item" style={{ opacity: e.applied ? 1 : 0.45 }}>
            {e.source === 'ai' ? <Sparkles color="var(--violet)" /> : <User />}
            <span className="grow ellipsis">{e.label}</span>
            <span className="faint" style={{ fontSize: 11 }}>
              {new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-sm" disabled={!snap?.history.canUndo} onClick={() => void api.project.undo()}>
          Undo
        </button>
        <button className="btn btn-sm" disabled={!snap?.history.canRedo} onClick={() => void api.project.redo()}>
          Redo
        </button>
      </div>
    </Modal>
  );
}
