import { useCallback, useEffect, useMemo, useState } from 'react';
import { Component, History, House, Redo2, Sparkles, Trash2, Undo2, User } from 'lucide-react';
import type { ElementRef } from '@shared/types';
import { displayName, instancesOf } from '@engine/tree';
import { pageLinkReferences, planHomeChange } from '@engine/apply';
import { shellPageLinks, type ShellPageLink } from '@generator/checks';
import { applyOps, api, getState, setState, toast, useStore } from '../store';
import { Field, Modal, openSection } from '../components/ui';
import { isImeComposing } from '../lib/ime';
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
          <input className="input" autoFocus value={name} placeholder="Feature highlight" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && name.trim() && void create()} />
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
      describedBy="delete-page-desc"
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
                // Only leave the current page when it is the one that went.
                const current = getState().pageId;
                if (current === pageId || !getState().snapshot?.state.pages[current ?? '']) selectPage(replacement ?? st.site.homePageId);
                // The row that opened this is gone: keyboard focus goes to the current page's row.
                setTimeout(() => document.querySelector<HTMLElement>('[role="listbox"][aria-label="Pages"] [role="option"][aria-selected="true"]')?.focus(), 0);
              }
            }}
          >
            Delete page
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p id="delete-page-desc" style={{ margin: 0 }}>
          The page at <span className="delete-page-route">{page.route}</span> and its content are removed from your site. You can undo this.
        </p>
        {(refs > 0 || pageId === st.site.homePageId) && (
          <Field
            label={pageId === st.site.homePageId ? 'New home page' : 'Point existing links to'}
            hint={
              pageId === st.site.homePageId
                ? refs
                  ? `It becomes the home page, and the ${refs} link${refs === 1 ? '' : 's'} (including navigation) that point here will point to it.`
                  : 'Another page must become the home page.'
                : `${refs} link${refs === 1 ? '' : 's'} (including navigation) currently point${refs === 1 ? 's' : ''} to this page.`
            }
          >
            <select className="select" value={replacement} onChange={(e) => setReplacement(e.target.value)}>
              {others.map((id) => {
                // Pages that share a title are told apart by their address.
                const p = st.pages[id];
                const shared = others.some((o) => o !== id && st.pages[o].title.trim().toLowerCase() === p.title.trim().toLowerCase());
                return (
                  <option key={id} value={id}>
                    {shared ? `${p.title} (${p.route})` : p.title}
                  </option>
                );
              })}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** Select the header or footer element a link is in, with its content open, so its words can be checked. */
function reviewShellLink(link: ShellPageLink) {
  // The link may have gone since (an undo, an edit): leave the selection as it is.
  if (!getState().snapshot?.state.site.shell[link.part].nodes[link.nodeId]) return toast('That link is no longer in the header or footer.', 'info');
  setState({ selection: { owner: { kind: 'shell', id: link.part }, instancePath: [], nodeId: link.nodeId }, rightTab: 'inspect', dockOpen: true, definitionMode: null });
  setTimeout(() => openSection('content'), 50);
}

/**
 * Making another page Home moves two pages: it says where each goes before anything changes, offers to keep the
 * page's old address working for links and bookmarks from elsewhere, and lists the header and footer links whose
 * destination changes while their words stay the same.
 */
export function SetHomeModal({ pageId }: { pageId: string }) {
  const snap = useStore((s) => s.snapshot);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const close = () => setState({ modal: null });
  const st = snap?.state;
  const page = st?.pages[pageId];
  const gone = !!st && (!page || st.site.homePageId === pageId);
  // The page was removed or made Home elsewhere (an undo, the AI): this question no longer applies.
  useEffect(() => {
    if (gone) setState({ modal: null });
  }, [gone]);
  // Planned on the snapshot shown, and applied against its revision: a change made meanwhile asks again.
  const review = useMemo(() => {
    if (!st || !page || gone) return null;
    const moves = planHomeChange(st, pageId, keep).moved.filter((m) => st.pages[m.pageId]);
    const links = shellPageLinks(st, moves.map((m) => m.pageId));
    // Header and footer elements are told apart by name when one part holds links in more than one of them.
    const owners = new Map<string, Set<string>>();
    for (const l of links) owners.set(l.part, (owners.get(l.part) ?? new Set<string>()).add(l.nodeId));
    // The same link repeated (once per item of a long list) is one row, with a count.
    const rows = new Map<string, { link: ShellPageLink; where: string; count: number }>();
    for (const l of links) {
      const key = [l.part, l.nodeId, l.label, l.pageId, l.anchor ?? ''].join('\u0000');
      const row = rows.get(key);
      if (row) {
        row.count++;
        continue;
      }
      const part = l.part === 'header' ? 'Header' : 'Footer';
      const n = st.site.shell[l.part].nodes[l.nodeId];
      rows.set(key, { link: l, where: owners.get(l.part)!.size > 1 && n ? `${part} · ${displayName(st, n)}` : part, count: 1 });
    }
    return { moves, to: new Map(moves.map((m) => [m.pageId, m.to])), first: links[0], rows: [...rows.values()] };
  }, [st, page, gone, pageId, keep]);
  if (!snap || !st || !page || !review) return null;
  const { moves, to, first, rows } = review;
  const vacated = page.route;
  const taker = keep ? undefined : moves.find((m) => m.to === vacated);
  const confirm = async () => {
    setBusy(true);
    let r: Awaited<ReturnType<typeof applyOps>> = null;
    try {
      r = await applyOps([{ type: 'page.setHome', pageId, keepOldAddress: keep }], 'Change home page', undefined, snap.revision);
    } catch {
      toast('The home page could not be changed. Try again.', 'error');
    } finally {
      setBusy(false);
    }
    if (!r) return;
    close();
    toast(`${page.title} is now the home page.`, 'info', first ? { label: 'Review links', run: () => reviewShellLink(first) } : undefined);
  };
  return (
    <Modal
      title={`Make “${page.title}” the home page?`}
      describedBy="set-home-desc"
      icon={<House />}
      onClose={close}
      busy={busy}
      footer={
        <>
          <button className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void confirm()} disabled={busy || snap.aiBusy} title={snap.aiBusy ? 'The AI is making changes. Stop it to change the home page.' : undefined}>
            Make home page
          </button>
        </>
      }
    >
      <div className="col set-home" style={{ gap: 14 }}>
        <div>
          <p id="set-home-desc" style={{ margin: '0 0 8px' }}>
            {moves.length === 1 ? 'This page' : 'These pages'} change address. Links inside your site follow them; links from other sites and bookmarks still use the old addresses.
          </p>
          <ul className="set-home-moves" aria-label="Address changes">
            {moves.map((m) => (
              <li key={m.pageId}>
                <span className="set-home-title">{st.pages[m.pageId].title}</span>
                <span className="set-home-route">{m.from}</span>
                <span aria-hidden="true">→</span>
                <span className="sr-only">moves to</span>
                <span className="set-home-route">{m.to}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <label className="set-home-keep">
            <input type="checkbox" checked={keep} disabled={busy} onChange={(e) => setKeep(e.target.checked)} />
            Keep {vacated} working
          </label>
          <p className="field-hint" style={{ margin: '4px 0 0 22px' }}>
            {keep
              ? `Visitors with an old link or bookmark to ${vacated} are sent to ${page.title} at /.`
              : taker
                ? `${vacated} will show ${st.pages[taker.pageId].title} instead, once your site is published again.`
                : `${vacated} stops working once your site is published again.`}
          </p>
        </div>
        {rows.length > 0 && (
          <div>
            <div className="set-home-heading">Links to review</div>
            <ul className="set-home-links" aria-label="Header and footer links to review">
              {rows.map(({ link: l, where, count }, i) => (
                <li key={`${l.part}:${l.nodeId}:${i}`}>
                  <span className="set-home-part">{where}</span>
                  <span className="set-home-label">
                    {l.label ? `“${l.label}”` : 'A link without text'}
                    {count > 1 ? ` (${count} links)` : ''}
                  </span>
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">will go to</span>
                  <span className="set-home-route">
                    {to.get(l.pageId)}
                    {l.anchor ? `#${l.anchor}` : ''}
                  </span>
                </li>
              ))}
            </ul>
            <p className="field-hint" style={{ margin: '4px 0 0' }}>
              Their words stay as they are. Edit the header or footer if they should read differently.
            </p>
          </div>
        )}
        {snap.aiBusy && <p className="field-hint" style={{ margin: 0 }}>The AI is making changes. Stop it to change the home page.</p>}
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
      title={uses.length === 1 ? `Edit the ${def.name} design?` : `Change ${def.name} everywhere?`}
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
        {uses.length === 1 ? (
          <p style={{ margin: 0 }}>
            Used once, on <strong>{uses[0].label}</strong>. This changes its layout and styles, here and anywhere you add it later. It keeps its text, images and changes made on the page.
          </p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              This changes the layout and styles of <strong>all {uses.length} placements</strong>. Each keeps its own text, images and changes made on the page.
            </p>
            <div className="field-label">Used on</div>
            <ul style={{ margin: '-6px 0 0', paddingLeft: 18 }}>
              {[...new Set(uses.map((u) => u.label))].map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        )}
        {def.owner === 'theme' && (
          <div className="scope-note definition">
            <Component />
            <span>
              It comes with the Foundation theme, so you edit your own copy. The original stays in Insert.
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function HistoryModal() {
  const snap = useStore((s) => s.snapshot);
  // Opened from a notification whose change could not be undone on its own: show that change.
  const focusId = useStore((s) => (s.modal?.kind === 'history' ? s.modal.entryId : undefined));
  const entries = [...(snap?.history.entries ?? [])].reverse();
  const focused = useCallback((el: HTMLLIElement | null) => el?.scrollIntoView({ block: 'nearest' }), []);
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
            <li key={e.id} ref={e.id === focusId ? focused : undefined} className={`${e.applied ? '' : 'undone'}${e.id === focusId ? ' focus' : ''}`} aria-current={e.id === focusId ? 'true' : undefined}>
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
