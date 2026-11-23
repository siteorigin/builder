import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Component, History, House, Pencil, Redo2, Sparkles, Split, Trash2, Undo2, User } from 'lucide-react';
import type { ElementRef, OwnerRef } from '@shared/types';
import { displayName, instancesOf } from '@engine/tree';
import { planHomeChange } from '@engine/apply';
import { uniqueCopyName } from '@engine/definitions';
import type { PageLinkUse } from '@engine/page-links';
import { shellPageLinks, type ShellPageLink } from '@generator/checks';
import { isDraftPage } from '@generator/index';
import { applyOps, api, getState, setState, toast, useStore } from '../store';
import { Field, Modal, openSection } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { resolveRef, treeFor } from '../lib/model';
import { goToShellPart, selectPage } from '../lib/actions';
import { planPageRemoval, reviewPageRemoval, withoutCards } from '../lib/page-removal';
import { sectionOptions } from '../lib/sections';

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

/** A name field that opens with its text selected, so typing replaces the suggestion. */
function useSelectedOnOpen() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return ref;
}

/** Close this dialog, and only this one: a save that lands after it was dismissed leaves the next dialog open. */
function useCloseOwn() {
  const [own] = useState(() => getState().modal);
  return () => {
    if (getState().modal === own) setState({ modal: null });
  };
}

/**
 * Make one placement a separate component, under a name the author chooses. The suggestion is one no component has
 * yet, so repeated copies never stack "(unique)".
 */
export function MakeUniqueModal({ owner, nodeId, definitionId }: { owner: OwnerRef; nodeId: string; definitionId: string }) {
  const st = useStore((s) => s.snapshot?.state);
  const revision = useStore((s) => s.snapshot?.revision);
  const node = st ? treeFor(st, owner)?.nodes[nodeId] : undefined;
  // The placement chosen, still showing the component it showed then: an Undo or the AI may have changed it.
  const def = st && node?.kind === 'instance' && node.definitionId === definitionId ? st.components[definitionId] : undefined;
  // Suggested once, as the dialog opens, so the field never changes under the author.
  const [suggested] = useState(() => (st && def ? uniqueCopyName(st, def.name) : ''));
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const input = useSelectedOnOpen();
  const close = useCloseOwn();
  const ready = !!def && !!name.trim() && !busy;
  const make = async () => {
    if (!ready) return;
    const chosen = name.trim();
    setBusy(true);
    // An unchanged suggestion is left to the engine, which checks it against the project as it is by then. The
    // revision checked above goes with it, so a change still on its way (an Undo) can't swap the component copied.
    const r = await applyOps([{ type: 'component.makeUnique', owner, nodeId, ...(chosen === suggested ? {} : { name: chosen }) }], 'Make unique', undefined, revision);
    if (r) close();
    else setBusy(false);
  };
  return (
    <Modal
      title="Make unique"
      icon={<Split />}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => void make()}>
            Make unique
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {def ? (
          <p className="muted" style={{ margin: 0 }}>
            This placement gets its own copy of {def.name}, so its design can change on its own. Every other {def.name} stays as it is.
          </p>
        ) : (
          <p className="field-error" style={{ margin: 0 }}>
            This section has changed since you chose Make unique. Close this and select it again.
          </p>
        )}
        <Field label="Name for the copy" hint="Shown in Insert under Your components.">
          <input ref={input} className="input" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void make()} />
        </Field>
      </div>
    </Modal>
  );
}

/** Rename one of the project's components, and say what it is for. Every placement keeps showing it. */
export function RenameComponentModal({ definitionId }: { definitionId: string }) {
  const def = useStore((s) => (s.snapshot && Object.hasOwn(s.snapshot.state.components, definitionId) ? s.snapshot.state.components[definitionId] : undefined));
  const revision = useStore((s) => s.snapshot?.revision);
  // What the fields showed when the dialog opened: only a field the author changed is saved, so a change made
  // meanwhile (by the AI) to the other one is kept.
  const [shown] = useState(() => ({ name: def?.name.trim() ?? '', description: def?.description?.trim() ?? '' }));
  const [name, setName] = useState(def?.name ?? '');
  const [description, setDescription] = useState(def?.description ?? '');
  const [busy, setBusy] = useState(false);
  const input = useSelectedOnOpen();
  const close = useCloseOwn();
  const ready = def?.owner === 'project' && !!name.trim() && !busy;
  const save = async () => {
    if (!ready) return;
    const n = name.trim();
    const d = description.trim();
    const renamed = n !== shown.name;
    const described = d !== shown.description;
    if (!renamed && !described) return close();
    setBusy(true);
    // Checked against the revision shown, so the name kept when only the description changes is the current one.
    const r = await applyOps([{ type: 'component.rename', definitionId, name: renamed ? n : def.name, ...(described ? { description: d } : {}) }], `Rename component ${renamed ? n : def.name}`, undefined, revision);
    if (r) close();
    else setBusy(false);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && !isImeComposing(e) && void save();
  return (
    <Modal
      title="Rename component"
      icon={<Pencil />}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => void save()}>
            Rename
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {!def && (
          <p className="field-error" style={{ margin: 0 }}>
            This component has been deleted.
          </p>
        )}
        <Field label="Component name">
          <input ref={input} className="input" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} />
        </Field>
        <Field label="Description" hint="Optional. Shown when you point at it in Insert, and found by search.">
          <input className="input" maxLength={300} value={description} placeholder="What this version is for" onChange={(e) => setDescription(e.target.value)} onKeyDown={onKey} />
        </Field>
      </div>
    </Modal>
  );
}

/** How a link in the review reads: its label in quotes, where it is, and the section it jumps to. */
function RemovedPageLink({ use }: { use: PageLinkUse }) {
  return (
    <li>
      <span className="delete-page-link-label">“{use.label}”</span> <span className="muted">{use.card ? 'card ' : ''}in {use.where}</span>
      {use.link.anchor && <span className="delete-page-route"> #{use.link.anchor}</span>}
    </li>
  );
}

/** A choice for a missing section that has not been made yet: the select shows its prompt. */
const UNCHOSEN = '\u0000unchosen';

/** No page chosen yet: shown when the replacement picked before has gone. */
const NO_PAGE = '';

export function DeletePageModal({ pageId }: { pageId: string }) {
  const snap = useStore((s) => s.snapshot);
  const st = snap!.state;
  const page = st.pages[pageId];
  const isHome = st.site.homePageId === pageId;
  // The Home page is always published: a draft is never offered to replace it.
  const others = st.site.pageOrder.filter((id) => id !== pageId && !(isHome && st.pages[id] && isDraftPage(st, st.pages[id])));
  const [picked, setPicked] = useState(isHome ? others[0] : st.site.homePageId);
  // A replacement that has gone since it was picked (an undo, the assistant) is never swapped for another page
  // without asking: the author chooses again.
  const replacement = picked && picked !== pageId && Object.hasOwn(st.pages, picked) && !(isHome && isDraftPage(st, st.pages[picked])) ? picked : undefined;
  // Section choices hold only for the replacement and the project they were made for: a new replacement or any
  // change to the project (an undo, the assistant) asks again.
  const [sections, setSections] = useState<{ key: string; choices: Map<string, string> }>({ key: '', choices: new Map() });
  const key = [snap?.workspaceKey, pageId, replacement, snap?.revision].join('\u0000');
  const choices = sections.key === key ? sections.choices : new Map<string, string>();
  const [busy, setBusy] = useState(false);
  const review = reviewPageRemoval(st, pageId, replacement);
  const refs = review.uses.length;
  const plan = planPageRemoval(st, pageId, replacement, choices);
  const target = replacement ? st.pages[replacement] : undefined;
  const aiBusy = !!snap?.aiBusy;
  // A page deleted some other way (the assistant) takes its dialog with it, so an undo never brings the dialog back.
  useEffect(() => {
    const modal = getState().modal;
    if (!page && !busy && modal?.kind === 'delete-page' && modal.pageId === pageId) setState({ modal: null });
  }, [page, busy, pageId]);
  const close = () => !busy && setState({ modal: null });
  if (!page) return null;
  const choose = (fragment: string, value: string) => setSections({ key, choices: new Map(choices).set(fragment, value) });
  // The replacement page's sections as they will be once this page's cards have left their lists.
  const { options } = sectionOptions(review.cards.length ? withoutCards(st, pageId) : st, replacement);
  const remove = async () => {
    if (!plan.operations || busy || aiBusy) return;
    const workspaceKey = snap?.workspaceKey;
    setBusy(true);
    let done: Awaited<ReturnType<typeof applyOps>> = null;
    try {
      done = await applyOps(plan.operations, `Delete page ${page.title}`, undefined, snap?.revision);
    } finally {
      setBusy(false);
    }
    // Only this dialog closes, and only in the project it was opened in.
    const now = getState();
    if (!done || now.snapshot?.workspaceKey !== workspaceKey) return;
    if (now.modal?.kind === 'delete-page' && now.modal.pageId === pageId) setState({ modal: null });
    // Only leave the current page when it is the one that went.
    const current = getState().pageId;
    if (current === pageId || !getState().snapshot?.state.pages[current ?? '']) selectPage(replacement ?? st.site.homePageId);
    // The row that opened this is gone: keyboard focus goes to the current page's row.
    setTimeout(() => document.querySelector<HTMLElement>('[role="listbox"][aria-label="Pages"] [role="option"][aria-selected="true"]')?.focus(), 0);
  };
  const linkHint = refs ? ` The ${refs} link${refs === 1 ? '' : 's'} below that point here will point to it.` : '';
  return (
    <Modal
      title={`Delete “${page.title}”?`}
      describedBy="delete-page-desc"
      icon={<Trash2 style={{ color: 'var(--red)' }} />}
      onClose={close}
      busy={busy}
      footer={
        <>
          <button className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger-fill" disabled={!plan.operations || busy || aiBusy} onClick={() => void remove()}>
            Delete page
          </button>
        </>
      }
    >
      <div className="col delete-page-body" style={{ gap: 12 }}>
        <p id="delete-page-desc" style={{ margin: 0 }}>
          The page at <span className="delete-page-route">{page.route}</span> and its content are removed from your site. You can undo this.
        </p>
        {(refs > 0 || isHome) && (
          <Field
            label={isHome ? 'New home page' : 'Point existing links to'}
            hint={
              isHome
                ? target
                  ? `${target.title} becomes the home page and moves from ${target.route} to /.${linkHint}`
                  : others.length
                    ? 'Another page must become the home page.'
                    : 'Every other page is a draft. Publish one to make it the home page.'
                : `The ${refs} link${refs === 1 ? '' : 's'} below point${refs === 1 ? 's' : ''} to this page now.`
            }
          >
            <select className="select" value={replacement ?? NO_PAGE} disabled={busy} onChange={(e) => setPicked(e.target.value)}>
              {!replacement && (
                <option value={NO_PAGE} disabled>
                  Choose a page…
                </option>
              )}
              {others.map((id) => {
                // Pages that share a title are told apart by their address.
                const p = st.pages[id];
                const shared = others.some((o) => o !== id && st.pages[o].title.trim().toLowerCase() === p.title.trim().toLowerCase());
                return (
                  <option key={id} value={id}>
                    {/* Links sent to a draft stop the website export until it is published. */}
                    {shared ? `${p.title} (${p.route})` : p.title}
                    {isDraftPage(st, p) ? ' · draft' : ''}
                  </option>
                );
              })}
            </select>
          </Field>
        )}
        {refs > 0 && (
          <ul className="delete-page-links" aria-label={`Links that will go to ${target?.title ?? 'the new page'}`}>
            {review.uses.map((u, i) => (
              <RemovedPageLink key={i} use={u} />
            ))}
          </ul>
        )}
        {review.cards.length > 0 && (
          <div className="col" style={{ gap: 6 }}>
            <p className="delete-page-note" id="delete-page-cards" style={{ margin: 0 }}>
              {review.cards.length === 1 ? 'Its card is removed from the page list it is in:' : `Its ${review.cards.length} cards are removed from the page lists they are in:`}
            </p>
            <ul className="delete-page-links" aria-labelledby="delete-page-cards">
              {review.cards.map((u, i) => (
                <RemovedPageLink key={i} use={u} />
              ))}
            </ul>
          </div>
        )}
        {target &&
          review.missing.map((m) => {
            const labels = m.uses.map((u) => `“${u.label}”`);
            return (
              <Field
                key={m.fragment}
                label={`Links to #${m.fragment}`}
                hint={`${target.title} has no section with this ID. Choose where ${labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]} go` : `${labels[0]} goes`} instead.`}
              >
                <select className="select" value={choices.get(m.fragment) ?? UNCHOSEN} disabled={busy} onChange={(e) => choose(m.fragment, e.target.value)}>
                  <option value={UNCHOSEN} disabled>
                    Choose a section…
                  </option>
                  <option value="">Top of page</option>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.text}
                    </option>
                  ))}
                </select>
              </Field>
            );
          })}
        {plan.lost.length > 0 && (
          <p className="delete-page-note" role="alert">
            Giving those sections new IDs would take {plan.lost.map((id) => `#${id}`).join(', ')} away from {target?.title}, where other links still go. Choose a different section for one of them.
          </p>
        )}
        {aiBusy && <p className="delete-page-note">The AI is making changes. Stop it to delete this page.</p>}
      </div>
    </Modal>
  );
}

/** Select the header or footer element a link is in, with its content open, so its words can be checked. */
function reviewShellLink(link: ShellPageLink) {
  // The link may have gone since (an undo, an edit): leave the selection as it is.
  if (!getState().snapshot?.state.site.shell[link.part].nodes[link.nodeId]) return toast('That link is no longer in the header or footer.', 'info');
  if (!goToShellPart(link.part)) return toast(`No page shows the shared ${link.part}, so the link is not on any page.`, 'info');
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
  const gone = !!st && (!page || st.site.homePageId === pageId || isDraftPage(st, page));
  // The page was removed, made Home or kept as a draft elsewhere (an undo, the AI): this question no longer applies.
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
