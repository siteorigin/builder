import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, CircleAlert, CircleMinus, Component, CornerDownRight, FileText, History, House, Info, Newspaper, Package, PanelBottom, PanelTop, Pencil, Redo2, ShieldCheck, Sparkles, Split, Trash2, TriangleAlert, Undo2, User } from 'lucide-react';
import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import { newId } from '@shared/ids';
import { displayName, placesOf } from '@engine/tree';
import { planHomeChange } from '@engine/apply';
import { uniqueCopyName } from '@engine/definitions';
import type { LinkHolder, PageLinkUse } from '@engine/page-links';
import { shellPageLinks, type ShellPageLink } from '@generator/checks';
import { isDraftPage } from '@generator/index';
import { applyOps, api, getState, projectHistory, saveLocal, setState, toast, useStore } from '../store';
import { Field, Modal, openMenus, openSection } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { createComponentTarget, resolveRef, treeFor } from '../lib/model';
import { goToShellPart, insertionPoint, selectPage, setMode } from '../lib/actions';
import { componentRequest, componentRequestContext, newComponentPlace, startBlankOps } from '../lib/new-component';
import { planPageRemoval, reviewPageRemoval, withoutCards } from '../lib/page-removal';
import { SECTION_NODE, sectionOptions } from '../lib/sections';
import { HistoryTabs, SavedVersionsModal } from './SavedVersions';

/** The longest name a component can have. */
const NAME_MAX = 60;
/** The longest description a component can have. */
const DESCRIPTION_MAX = 300;
const WHERE_NAMES_SHOW = 'Shown in Insert under Your components.';
/** The note under a name field: where the name shows, until it reaches the limit. */
const nameHint = (name: string, hint: string) => (name.length >= NAME_MAX ? `Names can be up to ${NAME_MAX} characters.` : hint);

const GONE_ID = 'component-dialog-gone';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/*
 * The component dialogs share the confirmation dialogs' order (ConfirmDialog.tsx): a badge for the action, what it
 * acts on set apart, one line for each thing that changes or stays safe, then the one field it asks for. Plum, the
 * colour of a component's design, marks only Edit everywhere, the one that changes every placement at once.
 */

/** The title's badge: the action's glyph in a tinted disc. `caution` once the dialog's subject has gone. */
function Badge({ icon, tone = 'neutral' }: { icon: React.ReactNode; tone?: 'neutral' | 'definition' | 'caution' }) {
  return (
    <span className="confirm-icon authoring-badge" data-tone={tone} aria-hidden="true">
      {icon}
    </span>
  );
}

/** What the dialog acts on, with how far it reaches. */
function Subject({ id, icon, name, note, tone }: { id?: string; icon: React.ReactNode; name: React.ReactNode; note?: React.ReactNode; tone?: 'definition' }) {
  return (
    <div id={id} className="confirm-subject authoring-subject" data-tone={tone}>
      {icon}
      <span className="confirm-subject-text">
        <span className="confirm-subject-name">{name}</span>
        {note && <span className="confirm-subject-note">{note}</span>}
      </span>
    </div>
  );
}

interface Detail {
  /** `change`: what the action does. `keep`: what stays as it is. `lose`: what goes with it. `risk`: what may break. `note`: anything else worth knowing. */
  kind: 'change' | 'keep' | 'note' | 'lose' | 'risk';
  icon: React.ReactNode;
  text: React.ReactNode;
}
function Details({ id, items }: { id?: string; items: Detail[] }) {
  return (
    <ul id={id} className="confirm-details authoring-details">
      {items.map((d, i) => (
        <li key={i} data-kind={d.kind}>
          {d.icon}
          <span>{d.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A name field's length beside its label, once it is close to the limit. The hint says the limit in words. */
function Count({ length, max }: { length: number; max: number }) {
  if (length < max * 0.8) return null;
  return (
    <span className="authoring-count" data-full={length >= max || undefined} aria-hidden="true">
      {length}/{max}
    </span>
  );
}

/** A list that can be scrolled by keyboard, with a tab stop only when it actually overflows. */
function ScrollList({ className, labelledBy, label, children }: { className: string; labelledBy?: string; label?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setScrolls(el.scrollHeight > el.clientHeight + 1);
  });
  return (
    <ul ref={ref} className={className} aria-labelledby={labelledBy} aria-label={label} tabIndex={scrolls ? 0 : undefined}>
      {children}
    </ul>
  );
}

/** How far a placement inside a shared part or another component shows: the copy shows there too. */
function whereItShows(st: ProjectState, owner: OwnerRef): string {
  if (owner.kind === 'shell') return ', on every page';
  if (owner.kind !== 'component') return '';
  const r = reachOf(st, placesOf(st, owner.id));
  return r.everyPage ? ', on every page' : r.pages ? `, on ${listAll(r.titles)}${r.appears > 1 ? `, ${r.appears} times` : ''}` : '';
}

/** Said aloud once a field reaches its limit, since the counter beside it is only seen. */
const limitSaid = (length: number, max: number, what: string) => (length >= max ? `${what} can be up to ${max} characters.` : undefined);

/** Where a placement or element is: a page, a shared part, or inside another component. */
function placeOf(st: ProjectState, owner: OwnerRef): string {
  if (owner.kind === 'shell') return `In the shared ${owner.id}`;
  if (owner.kind === 'component') return `Inside ${st.components[owner.id]?.name ?? 'another component'}`;
  return `On ${st.pages[owner.id]?.title ?? 'this page'}`;
}

/**
 * How far a component reaches: its placements, and the pages they show on. A placement in a shared part shows on
 * every page; one inside another component shows wherever that component is placed, followed all the way out.
 */
function reachOf(st: ProjectState, places: ReturnType<typeof placesOf>) {
  const pages = new Set<string>();
  let everyPage = false;
  const seen = new Set<string>();
  const walk = (list: ReturnType<typeof placesOf>) => {
    for (const p of list) {
      if (p.owner.kind === 'page') pages.add(p.owner.id);
      else if (p.owner.kind === 'shell') everyPage = true;
      else if (!seen.has(p.owner.id)) {
        seen.add(p.owner.id);
        walk(placesOf(st, p.owner.id));
      }
    }
  };
  walk(places);
  const placements = places.reduce((n, p) => n + p.nodeIds.length, 0);
  // How many times it actually shows: a placement inside a component shows once for each time that one does.
  const shows = (list: ReturnType<typeof placesOf>, depth = 0): number =>
    list.reduce((n, p) => n + p.nodeIds.length * (p.owner.kind === 'component' ? (depth > 8 ? 1 : shows(placesOf(st, p.owner.id), depth + 1)) : 1), 0);
  const appears = shows(places);
  // When nesting makes it show more often than it is placed, say how often, so a wide reach is never unexplained.
  const times = !everyPage && appears > placements ? `, shown ${appears} times` : '';
  const where = everyPage ? 'shown on every page' : pages.size ? `on ${plural(pages.size, 'page')}` : 'on no page yet';
  const titles = [...pages].map((id) => st.pages[id]?.title ?? 'a page');
  return { placements, appears, pages: pages.size, titles, everyPage, text: placements ? `${plural(placements, 'placement')}${times} ${where}` : 'Not placed anywhere yet' };
}

/** Every page title, as a phrase: "Home, About and Contact". The list it sits in scrolls, so none is left out. */
function listAll(titles: string[]): string {
  return titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : (titles[0] ?? '');
}

/** A dialog's safe button, holding focus past a closing menu like the name fields do. */
function SafeButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useHeldFocus(ref);
  return (
    <button ref={ref} className="btn" data-autofocus onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/**
 * Keep focus on `ref` while the menu that opened the dialog finishes closing: the menu hands focus back to its
 * trigger as it goes, which would leave the dialog open with nothing focused.
 */
function useHeldFocus(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    let settled = 0;
    let raf = 0;
    const hold = () => {
      const el = ref.current;
      if (!el) return;
      if (!el.closest('.modal')?.contains(document.activeElement)) el.focus();
      settled = openMenus.count ? 0 : settled + 1;
      if (settled < 6) raf = requestAnimationFrame(hold);
    };
    raf = requestAnimationFrame(hold);
    return () => cancelAnimationFrame(raf);
  }, [ref]);
}

/** Says a required-name error or a save in progress aloud, since neither moves focus. */
function FormStatus({ text }: { text?: string }) {
  return (
    <span className="sr-only" role="status">
      {text ?? ''}
    </span>
  );
}

/** Why a dialog can no longer do what it was opened for. It replaces the form, so nothing dead stays editable. */
function GoneNotice({ children }: { children: React.ReactNode }) {
  return (
    <div id={GONE_ID} className="scope-note danger authoring-gone" role="alert">
      <CircleAlert />
      <span>{children}</span>
    </div>
  );
}

/** The only way out of a dialog whose subject has gone. It takes focus, because the field that had it is removed. */
function GoneClose({ onClose }: { onClose: () => void }) {
  return <SafeButton onClick={onClose}>Close</SafeButton>;
}

export function CreateComponentModal({ target }: { target: ElementRef }) {
  const snap = useStore((s) => s.snapshot);
  const st = snap?.state;
  const targetNode = st ? resolveRef(st, target).node : undefined;
  const [busy, setBusy] = useState(false);
  // The element is replaced by its component as the save lands: the form stays until the dialog closes.
  const gone = !busy && !!st && !targetNode;
  // Still there, but no longer something to make a component from (a section emptied while the dialog was open).
  const unfit = !busy && !gone && !!st && !createComponentTarget(snap, target);
  const [targetName] = useState(() => (st && targetNode ? displayName(st, targetNode) : null));
  const [where] = useState(() => (st ? `${placeOf(st, target.owner)}${whereItShows(st, target.owner)}` : ''));
  const input = useRef<HTMLInputElement>(null);
  useHeldFocus(input);
  const [name, setName] = useState('');
  // Asked for only once the author has typed or pressed Enter, so the dialog never opens on an error.
  const [touched, setTouched] = useState(false);
  const close = () => setState({ modal: null });
  const ready = !gone && !unfit && !!name.trim() && !busy;
  const nameError = touched && !name.trim() ? 'Enter a name for this component.' : undefined;
  const create = async () => {
    setTouched(true);
    if (!ready) return;
    // Checked against the project as it is now, and made only if nothing changed it before the change lands (a
    // removal of the section's last element still saving would otherwise leave an empty component).
    const now = getState().snapshot;
    if (!createComponentTarget(now, target)) return;
    setBusy(true);
    let r: Awaited<ReturnType<typeof applyOps>> = null;
    try {
      r = await applyOps([{ type: 'component.createFromNode', owner: target.owner, nodeId: target.nodeId, name: name.trim() }], `Create component ${name.trim()}`, undefined, now?.revision);
    } finally {
      if (!r?.[0]?.nodeId) setBusy(false);
    }
    if (r?.[0]?.nodeId) setState({ modal: null, selection: { owner: target.owner, instancePath: [], nodeId: r[0].nodeId as string } });
  };
  return (
    <Modal
      title="Create component"
      icon={<Badge icon={<Component />} tone={gone || unfit ? 'caution' : 'neutral'} />}
      onClose={close}
      busy={busy}
      describedBy={gone || unfit ? GONE_ID : 'create-component-desc create-component-subject create-component-details'}
      footer={
        gone || unfit ? (
          <GoneClose onClose={close} />
        ) : (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!ready} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create component'}
            </button>
          </>
        )
      }
    >
      {gone ? (
        <GoneNotice>{targetName ? <><strong>{targetName}</strong> was removed, so no component was made.</> : 'This element was removed, so no component was made.'}</GoneNotice>
      ) : unfit ? (
        <GoneNotice>
          {snap?.readOnly ? (
            'This project is open read-only, so no component was made.'
          ) : targetNode?.kind === 'instance' ? (
            <>
              {targetName ? <strong>{targetName}</strong> : 'This section'} no longer holds any content of its own, so no component was made.
            </>
          ) : (
            'This element can no longer be made into a component, so none was made.'
          )}
        </GoneNotice>
      ) : (
        <div className="authoring-form">
          <FormStatus text={busy ? 'Creating component' : (nameError ?? limitSaid(name.length, NAME_MAX, 'Names'))} />
          <p id="create-component-desc" className="confirm-lead">
            This element becomes the component’s first placement. Its layout and style then stay in step wherever you place it.
          </p>
          <Subject id="create-component-subject" icon={<Box />} name={targetName ?? 'This element'} note={where} />
          <Details id="create-component-details" items={[{ kind: 'keep', icon: <ShieldCheck />, text: 'Each placement keeps its own text, images and buttons.' }]} />
          <Field label="Component name" hint={nameHint(name, WHERE_NAMES_SHOW)} error={nameError} extra={<Count length={name.length} max={NAME_MAX} />}>
            <input
              ref={input}
              className="input"
              autoFocus
              readOnly={busy}
              aria-required="true"
              maxLength={NAME_MAX}
              value={name}
              placeholder="e.g. Feature highlight"
              onChange={(e) => {
                setTouched(true);
                setName(e.target.value);
              }}
              onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void create()}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/** Where Create component would place a new component now, by the editor's own insertion point. */
function newComponentPlaceNow() {
  const s = getState();
  const st = s.snapshot?.state;
  if (!st) return null;
  const at = s.definitionMode ? null : insertionPoint('section');
  return newComponentPlace(st, s, at && !at.parentId && at.owner.kind === 'page' ? at.index : undefined);
}

/**
 * Create component, from Your components in Insert or the command menu: a new component started blank, placed on the
 * page and opened for editing, or described for the AI to build from the components the site already has.
 */
export function NewComponentModal() {
  const snap = useStore((s) => s.snapshot);
  const running = useStore((s) => !!s.runStatus);
  const waiting = useStore((s) => !!s.chatRequest);
  // The page Start blank places it on, said as it is now: the page on screen, or the one a design was opened from.
  const pageId = useStore((s) => s.definitionMode?.returnPageId ?? s.pageId);
  const readOnly = !!snap?.readOnly;
  const input = useRef<HTMLInputElement>(null);
  useHeldFocus(input);
  const close = useCloseOwn();
  const [own] = useState(() => getState().modal);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Asked for only once the author has typed or tried to start, so the dialog never opens on an error.
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const pageTitle = pageId && snap && Object.hasOwn(snap.state.pages, pageId) ? snap.state.pages[pageId].title : undefined;
  const nameError = touched && !name.trim() ? 'Enter a name for this component.' : undefined;
  const canBuild = !readOnly && !busy && !running && !waiting && !!(name.trim() || description.trim());

  const start = async () => {
    setTouched(true);
    if (busy || readOnly || !name.trim()) return;
    const now = getState().snapshot;
    // Placed where the editor points as the change is made: the page may have changed since the dialog opened.
    const at = newComponentPlaceNow();
    if (!now || !at) return void toast('Open a page to place the new component on.', 'info');
    const plan = startBlankOps(at, name, description);
    setBusy(true);
    let r: Awaited<ReturnType<typeof applyOps>> = null;
    try {
      r = await applyOps(plan.ops, `Create component ${name.trim()}`, undefined, now.revision);
    } finally {
      if (!r) setBusy(false);
    }
    if (!r) return;
    const after = getState();
    // Named by the change itself, which the snapshot may not show yet.
    const root = typeof r[0]?.rootNodeId === 'string' ? r[0].rootNodeId : null;
    const shown = after.snapshot?.state;
    // An Undo or another change that landed meanwhile can have taken the placement away again: then nothing opens.
    const gone = !!shown?.components[plan.definitionId] && !shown.pages[at.pageId]?.nodes[plan.nodeId];
    const mine = after.modal === own;
    if (after.snapshot?.workspaceKey !== now.workspaceKey || !root || gone) {
      setBusy(false);
      if (mine) setState({ modal: null });
      return;
    }
    // The new design opens for editing on its placement, as Edit everywhere opens one. Another dialog opened meanwhile
    // stays open over it.
    if (after.mode !== 'edit') setMode('edit');
    if (after.pageId !== at.pageId) saveLocal({ pageId: at.pageId });
    setState({
      ...(mine ? { modal: null } : {}),
      pageId: at.pageId,
      definitionMode: { definitionId: plan.definitionId, returnPageId: at.pageId },
      selection: { owner: { kind: 'page', id: at.pageId }, instancePath: [plan.nodeId], nodeId: root },
      rightTab: 'inspect',
      dockOpen: true
    });
  };

  const build = () => {
    setTouched(true);
    const s = getState();
    if (!canBuild || !s.snapshot) return;
    // The chat sends it, as its own Send would, once it can; its own unsent message stays as it is.
    setState({
      modal: null,
      chatRequest: { id: newId('req'), text: componentRequest(name, description), context: componentRequestContext(s.snapshot.state, newComponentPlaceNow(), s.viewport), workspaceKey: s.snapshot.workspaceKey },
      rightTab: 'chat',
      dockOpen: true
    });
  };

  const details: Detail[] = [
    { kind: 'change', icon: <Component />, text: pageTitle ? `Start blank adds it to ${pageTitle} and opens its design, ready for elements.` : 'Start blank adds it to Your components and opens its design, ready for elements.' },
    { kind: 'note', icon: <Sparkles />, text: 'Build with AI sends the name and description to the AI, which builds it from the components your site already has.' },
    { kind: 'keep', icon: <Undo2 />, text: 'Either way, one Undo takes it back.' }
  ];
  return (
    <Modal
      title="Create component"
      icon={<Badge icon={<Component />} tone={readOnly ? 'caution' : 'neutral'} />}
      onClose={close}
      busy={busy}
      describedBy={readOnly ? GONE_ID : 'new-component-desc new-component-details'}
      footer={
        readOnly ? (
          <GoneClose onClose={close} />
        ) : (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn" disabled={!canBuild} title={running ? 'The AI is working on another request.' : waiting ? 'Another request is waiting to be sent in the chat.' : undefined} onClick={build}>
              <Sparkles aria-hidden="true" />
              Build with AI
            </button>
            <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void start()}>
              {busy ? 'Creating…' : 'Start blank'}
            </button>
          </>
        )
      }
    >
      {readOnly ? (
        <GoneNotice>This project is open read-only, so no component can be made.</GoneNotice>
      ) : (
        <div className="authoring-form">
          <FormStatus text={busy ? 'Creating component' : (nameError ?? limitSaid(name.length, NAME_MAX, 'Names'))} />
          <p id="new-component-desc" className="confirm-lead">
            A component is a design you place on any page and keep in step everywhere. Start with an empty one, or describe it for the AI.
          </p>
          <Details id="new-component-details" items={details} />
          <Field label="Component name" hint={nameHint(name, WHERE_NAMES_SHOW)} error={nameError} extra={<Count length={name.length} max={NAME_MAX} />}>
            <input
              ref={input}
              className="input"
              autoFocus
              readOnly={busy}
              aria-required="true"
              maxLength={NAME_MAX}
              value={name}
              placeholder="e.g. Pricing card"
              onChange={(e) => {
                setTouched(true);
                setName(e.target.value);
              }}
              onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void start()}
            />
          </Field>
          <Field
            label="Description"
            hint={description.length >= DESCRIPTION_MAX ? `Descriptions can be up to ${DESCRIPTION_MAX} characters.` : 'What it shows and how it looks. The AI builds from it, and Insert shows it.'}
            extra={<Count length={description.length} max={DESCRIPTION_MAX} />}
          >
            <textarea
              className="textarea"
              rows={3}
              readOnly={busy}
              maxLength={DESCRIPTION_MAX}
              value={description}
              placeholder="e.g. One plan with its name, price, a short list of features and a button"
              onChange={(e) => setDescription(e.target.value.replace(/\s*\n\s*/g, ' '))}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/** A name field that opens with its text selected, so typing replaces the suggestion. */
function useSelectedOnOpen() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  useHeldFocus(ref);
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
  const current = st && node?.kind === 'instance' && node.definitionId === definitionId ? st.components[definitionId] : undefined;
  // Suggested once, as the dialog opens, so the field never changes under the author.
  const [suggested] = useState(() => (st && current ? uniqueCopyName(st, current.name) : ''));
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  // The placement moves to its new copy as the save lands: the form stays until the dialog closes.
  const def = current ?? (busy && st ? st.components[definitionId] : undefined);
  // The name, kept for the notice if the placement goes. The reach is the project's as it is now.
  const [opened] = useState(() => (current ? { name: current.name } : null));
  const reach = st && def ? reachOf(st, placesOf(st, definitionId)) : null;
  const input = useSelectedOnOpen();
  const close = useCloseOwn();
  const ready = !!def && !!name.trim() && !busy;
  const nameError = name.trim() ? undefined : 'Enter a name for the copy.';
  const make = async () => {
    if (!ready) return;
    const chosen = name.trim();
    setBusy(true);
    // An unchanged suggestion is left to the engine, which checks it against the project as it is by then. The
    // revision checked above goes with it, so a change still on its way (an Undo) can't swap the component copied.
    let r: Awaited<ReturnType<typeof applyOps>> = null;
    try {
      r = await applyOps([{ type: 'component.makeUnique', owner, nodeId, ...(chosen === suggested ? {} : { name: chosen }) }], 'Make unique', undefined, revision);
    } finally {
      if (!r) setBusy(false);
    }
    if (r) close();
  };
  return (
    <Modal
      title="Make unique"
      icon={<Badge icon={<Split />} tone={def ? 'neutral' : 'caution'} />}
      onClose={close}
      busy={busy}
      describedBy={def ? 'make-unique-desc make-unique-subject make-unique-details' : GONE_ID}
      footer={
        def ? (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!ready} onClick={() => void make()}>
              {busy ? 'Making unique…' : 'Make unique'}
            </button>
          </>
        ) : (
          <GoneClose onClose={close} />
        )
      }
    >
      {def ? (
        <div className="authoring-form">
          <FormStatus text={busy ? 'Making a unique copy' : (nameError ?? limitSaid(name.length, NAME_MAX, 'Names'))} />
          <p id="make-unique-desc" className="confirm-lead">
            This placement switches to its own copy and stops following {def.name}.
          </p>
          <Subject id="make-unique-subject" icon={<Component />} name={def.name} note={st ? `${placeOf(st, owner)}${whereItShows(st, owner)} · ${reach && reach.placements > 1 ? `1 of ${reach.placements} placements` : 'its only placement'}` : undefined} />
          <Details
            id="make-unique-details"
            items={[
              {
                kind: 'keep',
                icon: <ShieldCheck />,
                text: reach && reach.placements > 1 ? `${reach.placements === 2 ? 'The other placement keeps' : `The other ${reach.placements - 1} placements keep`} following ${def.name}.` : `${def.name} stays in Insert, ready to place again.`
              }
            ]}
          />
          <Field label="Name for the copy" hint={nameHint(name, WHERE_NAMES_SHOW)} error={nameError} extra={<Count length={name.length} max={NAME_MAX} />}>
            <input ref={input} className="input" autoFocus readOnly={busy} aria-required="true" maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void make()} />
          </Field>
        </div>
      ) : (
        <GoneNotice>
          {node?.kind === 'instance' ? (
            'This placement now shows a different component, so no copy was made. Select it again to make it unique.'
          ) : opened ? (
            <>
              This placement of <strong>{opened.name}</strong> was removed, so there is nothing to make unique.
            </>
          ) : (
            'This placement was removed, so there is nothing to make unique.'
          )}
        </GoneNotice>
      )}
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
  const st = useStore((s) => s.snapshot?.state);
  const reach = st && def ? reachOf(st, placesOf(st, definitionId)).text : undefined;
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
    let r: Awaited<ReturnType<typeof applyOps>> = null;
    try {
      r = await applyOps([{ type: 'component.rename', definitionId, name: renamed ? n : def.name, ...(described ? { description: d } : {}) }], `Rename component ${renamed ? n : def.name}`, undefined, revision);
    } finally {
      if (!r) setBusy(false);
    }
    if (r) close();
  };
  const nameError = name.trim() ? undefined : 'Enter a component name.';
  // Enter saves from either field, so the description wraps but stays one paragraph.
  const onKey = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || isImeComposing(e)) return;
    e.preventDefault();
    void save();
  };
  return (
    <Modal
      title="Rename component"
      icon={<Badge icon={<Pencil />} tone={def ? 'neutral' : 'caution'} />}
      onClose={close}
      busy={busy}
      describedBy={def ? 'rename-component-desc rename-component-subject' : GONE_ID}
      footer={
        def ? (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!ready} onClick={() => void save()}>
              {busy ? 'Renaming…' : 'Rename'}
            </button>
          </>
        ) : (
          <GoneClose onClose={close} />
        )
      }
    >
      {def ? (
        <div className="authoring-form">
          <FormStatus text={busy ? 'Renaming component' : (nameError ?? ([limitSaid(name.length, NAME_MAX, 'Names'), limitSaid(description.length, DESCRIPTION_MAX, 'Descriptions')].filter(Boolean).join(' ') || undefined))} />
          <p id="rename-component-desc" className="confirm-lead">
            The new name shows in Insert and on every placement. Its design and content stay as they are.
          </p>
          <Subject id="rename-component-subject" icon={<Component />} name={shown.name} note={reach} />
          <Field label="Component name" hint={nameHint(name, WHERE_NAMES_SHOW)} error={nameError} extra={<Count length={name.length} max={NAME_MAX} />}>
            <input ref={input} className="input" autoFocus readOnly={busy} aria-required="true" maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} />
          </Field>
          <Field
            label={
              <>
                Description <span className="authoring-optional">(optional)</span>
              </>
            }
            hint={description.length >= DESCRIPTION_MAX ? `Descriptions can be up to ${DESCRIPTION_MAX} characters.` : 'Shown when you point at it in Insert, and found by search.'}
            extra={<Count length={description.length} max={DESCRIPTION_MAX} />}
          >
            <textarea className="textarea" rows={2} readOnly={busy} maxLength={DESCRIPTION_MAX} value={description} placeholder="What this component is for" onChange={(e) => setDescription(e.target.value.replace(/\s*\n\s*/g, ' '))} onKeyDown={onKey} />
          </Field>
        </div>
      ) : (
        <GoneNotice>
          <strong>{shown.name || 'This component'}</strong> has been deleted, so there is nothing to rename.
        </GoneNotice>
      )}
    </Modal>
  );
}

/*
 * The page dialogs join the confirmation family too: a badge for the action, the page set apart with its address,
 * the decision the action needs (where links go, where links to its sections land), then one line for each thing
 * that changes, goes, stays and can be undone. Deleting a page can be undone, so it takes the recoverable step
 * (an outlined red action), as a discard does; making a page Home is the accent's.
 */

/**
 * The glyph for where a link lives: the shared header or footer, a page, a component, or a collection entry's text
 * (a post or case study, shown with the glyph the Pages panel gives a dated article).
 */
function holderIcon(owner: LinkHolder) {
  if (owner.kind === 'shell') return owner.id === 'header' ? <PanelTop data-shared="" /> : <PanelBottom data-shared="" />;
  if (owner.kind === 'entry') return <Newspaper />;
  return owner.kind === 'component' ? <Component /> : <FileText />;
}

/**
 * How a link in the review reads: where it is, its label in quotes, and where it will land. A link that jumped to a
 * section shows that section's ID, then the place chosen for it on the new page (or that one is still to choose).
 */
function RemovedPageLink({ use, landing }: { use: PageLinkUse; landing?: { text: string; pending?: boolean } }) {
  return (
    <li>
      {holderIcon(use.owner)}
      <span className="page-dialog-where">{use.where}</span>
      <span className="page-dialog-label">“{use.label}”</span>
      {use.link.anchor && (
        <span className="page-dialog-dest">
          <span className="page-dialog-address" data-old={landing ? '' : undefined}>
            #{use.link.anchor}
          </span>
          {landing && (
            <>
              <span className="page-dialog-arrow" aria-hidden="true">
                →
              </span>
              <span className="sr-only">{landing.pending ? 'still needs a place' : 'will open'}</span>
              <span className="page-dialog-landing" data-pending={landing.pending || undefined} aria-hidden={landing.pending || undefined}>
                {landing.text}
              </span>
            </>
          )}
        </span>
      )}
    </li>
  );
}

/** A choice for a missing section that has not been made yet: the select shows its prompt. */
const UNCHOSEN = '\u0000unchosen';

/** No page chosen yet: shown when the replacement picked before has gone. */
const NO_PAGE = '';

/** Pages filed under `page` by address (`/services/garden-design/` under `/services/`): deleting it leaves them. */
function pagesUnder(st: ProjectState, pageId: string) {
  const route = st.pages[pageId]?.route;
  if (!route || route === '/') return [];
  return st.site.pageOrder.filter((id) => id !== pageId && st.pages[id]?.route.startsWith(route)).map((id) => st.pages[id]);
}

/** Labels in quotes, joined the way a sentence lists them. */
const quoted = (uses: PageLinkUse[]) => listAll([...new Set(uses.map((u) => `“${u.label}”`))]);

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
  const body = useRef<HTMLDivElement>(null);
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
  const draft = isDraftPage(st, page);
  const asks = refs > 0 || isHome;
  const missing = target ? review.missing : [];
  const open = missing.filter((m) => !choices.has(m.fragment)).length;
  const under = pagesUnder(st, pageId);
  const linkWord = (n: number) => `${n} link${n === 1 ? '' : 's'}`;
  // Home with only drafts beside it: nothing can take its place until another page is published.
  const noHome = isHome && !others.length;
  // What the replacement choice means, said under it where it needs saying: a page still to choose, a draft that
  // would stop the export, or the new home page's move. A published page needs nothing: the line below says it.
  const outcome = !target ? (
    noHome ? (
      'Every other page is a draft. Publish one to make it the home page.'
    ) : (
      `Choose the page ${isHome ? 'that becomes the home page' : `its ${linkWord(refs)} open instead`}.`
    )
  ) : isHome ? (
    <>
      “{target.title}” moves from <span className="page-dialog-address">{target.route}</span> to <span className="page-dialog-address">/</span>, the home page’s address.
    </>
  ) : isDraftPage(st, target) ? (
    `“${target.title}” is a draft: your site can’t be exported until it is published, or until you choose a published page here.`
  ) : undefined;
  // Where each section the links jump to will land on the replacement page, as chosen so far.
  const landings = new Map<string, { text: string; pending?: boolean }>();
  for (const m of missing) {
    const choice = choices.get(m.fragment);
    const text = choice === undefined ? undefined : choice === '' ? 'top of page' : options.find((o) => o.value === choice)?.text;
    landings.set(m.fragment, text === undefined ? { text: 'to choose', pending: true } : { text: choice === '' ? text : `“${text}”` });
  }
  // Once every section has a place and the plan is still refused, the choices behind it: those giving a section a
  // new ID when that would take an ID away, else one that no longer fits the page, else every section picked.
  const refused = !!target && !open && !plan.operations;
  // Top of page ('') can never be refused, so only a section picked is a candidate.
  const placed = missing.filter((m) => !!choices.get(m.fragment));
  const named = placed.filter((m) => (plan.lost.length ? choices.get(m.fragment)!.startsWith(SECTION_NODE) : !options.some((o) => o.value === choices.get(m.fragment))));
  const implicated = new Set(refused ? (named.length ? named : placed).map((m) => m.fragment) : []);
  // Several new IDs that together take one away can't be told apart: the tray says so as a group, blaming no field.
  const jointly = refused && plan.lost.length > 0 && implicated.size > 1;
  const lostIds = plan.lost.map((id) => `#${id}`).join(', ');
  // Why Delete page cannot be pressed yet, said beside it, with a way straight to the choice that unblocks it.
  const need: { text: string; act?: string } | null =
    !asks || plan.operations
      ? null
      : !target
        ? noHome
          ? { text: 'Publish another page to delete this one.' }
          : { text: isHome ? 'The site needs a new home page.' : 'Its links need a page to go to.', act: 'Choose' }
        : open
          ? { text: `${open === 1 ? 'A section still needs' : `${open} sections still need`} a place on “${target.title}”.`, act: 'Choose' }
          : plan.lost.length
            ? jointly
              ? { text: `${implicated.size} choices together would break other links.`, act: 'Change one' }
              : { text: 'One choice would break other links.', act: 'Change it' }
            : implicated.size > 1
              ? { text: 'Sections chosen can’t be used now.', act: 'Choose again' }
              : { text: 'A section chosen can’t be used now.', act: 'Choose again' };
  // While the AI works, whatever else still blocks the deletion stays in view.
  const blocked = aiBusy ? { text: `The AI is making changes.${need ? ` ${need.text}` : ' You can delete this page when it stops.'}`, act: need?.act } : need;
  // The first choice still open or refused: its field (label included) scrolled into view, then the select focused.
  const goToChoice = () => {
    const el = body.current?.querySelector<HTMLSelectElement>('select[data-unset], select[aria-invalid="true"], select[data-refused]');
    (el?.closest<HTMLElement>('.field') ?? el)?.scrollIntoView({ block: 'nearest' });
    el?.focus({ preventScroll: true });
  };
  const details: Detail[] = [];
  // The address the new home page leaves stops working: said right under the choice that decides it, ahead of any
  // section choices.
  const homeRisk: Detail | null =
    isHome && target
      ? {
          kind: 'risk',
          icon: <TriangleAlert />,
          text: (
            <>
              Once your site is published again, <span className="page-dialog-address">{target.route}</span> stops working, so bookmarks and links from other sites to it will break.
            </>
          )
        }
      : null;
  if (refs)
    details.push({
      kind: 'change',
      icon: <CornerDownRight />,
      text: (
        <>
          <span>
            {linkWord(refs)} on your site {target ? <>will open <strong>“{target.title}”</strong></> : 'will open the page you choose'}.{' '}
            <span className="page-dialog-quiet">{refs === 1 ? 'Its' : 'Their'} words stay as they are.</span>
          </span>
          <ScrollList className="page-dialog-list" labelledBy="delete-page-links">
            {review.uses.map((u, i) => (
              <RemovedPageLink key={i} use={u} landing={u.link.anchor && target ? (landings.get(u.link.anchor) ?? { text: 'same section' }) : undefined} />
            ))}
          </ScrollList>
        </>
      )
    });
  if (review.cards.length)
    details.push({
      kind: 'lose',
      icon: <CircleMinus />,
      text: (
        <>
          <span id="delete-page-cards">{review.cards.length === 1 ? 'Its card is removed from the page list it is in.' : `Its ${review.cards.length} cards are removed from the page lists they are in.`}</span>
          <ScrollList className="page-dialog-list" labelledBy="delete-page-cards">
            {review.cards.map((u, i) => (
              <RemovedPageLink key={i} use={u} />
            ))}
          </ScrollList>
        </>
      )
    });
  if (under.length)
    details.push({
      kind: 'keep',
      icon: <ShieldCheck />,
      text:
        under.length === 1
          ? `“${under[0].title}” stays on your site at its own address.`
          : `${listAll(under.slice(0, 2).map((p) => `“${p.title}”`).concat(under.length > 2 ? [`${under.length - 2} more`] : []))} stay on your site at their own addresses.`
    });
  details.push({ kind: 'note', icon: <Undo2 />, text: 'You can undo this.' });
  return (
    <Modal
      title={`Delete “${page.title}”?`}
      describedBy="delete-page-desc"
      icon={<Badge icon={<Trash2 />} tone="caution" />}
      onClose={close}
      busy={busy}
      footer={
        <>
          <span className="page-dialog-status" role="status">
            {blocked && (
              <>
                {aiBusy ? <Sparkles /> : <Info />}
                <span>
                  {blocked.text}
                  {blocked.act && (
                    <>
                      {' '}
                      <button type="button" className="page-dialog-status-action" onClick={goToChoice}>
                        {blocked.act}
                      </button>
                    </>
                  )}
                </span>
              </>
            )}
          </span>
          <SafeButton onClick={close} disabled={busy}>
            Cancel
          </SafeButton>
          <button className="btn btn-danger" disabled={!plan.operations || busy || aiBusy} onClick={() => void remove()}>
            Delete page
          </button>
        </>
      }
    >
      <div ref={body} className="confirm page-dialog">
        <p id="delete-page-desc" className="confirm-lead">
          The page and everything on it are removed from your site.
          {/* Its own address keeps no redirect (the engine moves only addresses already kept for it); a draft was never published. */}
          {!isHome && !draft && ' Once you publish again, bookmarks and links from other sites to its address stop working.'}
        </p>
        <Subject
          icon={isHome ? <House /> : <FileText />}
          name={page.title}
          note={
            <>
              <span className="page-dialog-address">{page.route}</span>
              {isHome ? ' · Home page' : draft ? ' · Draft' : ''}
            </>
          }
        />
        {asks && (
          <Field label={isHome ? 'New home page' : `Send its ${linkWord(refs)} to`} hint={outcome}>
            <select className="select" aria-required="true" data-unset={(!replacement && !noHome) || undefined} value={replacement ?? NO_PAGE} disabled={busy || noHome} onChange={(e) => setPicked(e.target.value)}>
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
        {homeRisk && <Details items={[homeRisk]} />}
        {target && missing.length > 0 && (
          <div className="page-dialog-sections" role="group" aria-labelledby="delete-page-sections" aria-describedby="delete-page-sections-note">
            <div>
              <div className="page-dialog-heading" id="delete-page-sections">
                Links to sections “{target.title}” doesn’t have
              </div>
              <p className="page-dialog-block-note" id="delete-page-sections-note">
                Choose where each lands on “{target.title}”. The list below shows where every link will go.
              </p>
            </div>
            {missing.map((m) => {
              const choice = choices.get(m.fragment);
              // A refused choice says why beside itself, and the footer's action brings the author here.
              const error = !implicated.has(m.fragment) || jointly
                ? undefined
                : plan.lost.length
                  ? `This would take ${lostIds} away from “${target.title}”, where other links still go. Choose Top of page or another section.`
                  : 'This section can’t take these links now. Choose again, or choose Top of page.';
              return (
                <Field
                  key={m.fragment}
                  label={
                    <>
                      {quoted(m.uses)} <span className="page-dialog-address">#{m.fragment}</span>
                    </>
                  }
                  error={error}
                >
                  <select className="select" aria-required="true" data-unset={choice === undefined || undefined} data-refused={(jointly && implicated.has(m.fragment)) || undefined} value={choice ?? UNCHOSEN} disabled={busy} onChange={(e) => choose(m.fragment, e.target.value)}>
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
            {jointly && (
              <div className="scope-note danger" role="alert">
                <CircleAlert />
                <span>
                  Together, the sections chosen would take <span className="page-dialog-address">{lostIds}</span> away from “{target.title}”, where other links still go. Choose Top of page for one of them.
                </span>
              </div>
            )}
          </div>
        )}
        <span id="delete-page-links" hidden>
          {`Links that will open ${target?.title ?? 'the page you choose'}`}
        </span>
        <Details items={details} />
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
    return { moves, to: new Map(moves.map((m) => [m.pageId, m.to])), first: links[0], rows: [...rows.values()], total: links.length };
  }, [st, page, gone, pageId, keep]);
  if (!snap || !st || !page || !review) return null;
  const { moves, to, first, rows, total } = review;
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
  const former = moves.find((m) => m.pageId !== pageId);
  // Which shared parts hold the links, so the heading names only those.
  const parts = [rows.some((r) => r.link.part === 'header') && 'header', rows.some((r) => r.link.part === 'footer') && 'footer'].filter(Boolean).join(' and ');
  return (
    <Modal
      title={`Make “${page.title}” the home page?`}
      describedBy="set-home-desc"
      icon={<Badge icon={<House />} />}
      onClose={close}
      busy={busy}
      footer={
        <>
          <span className="page-dialog-status" role="status">
            {snap.aiBusy && (
              <>
                <Sparkles />
                The AI is making changes. You can change the home page when it stops.
              </>
            )}
          </span>
          <SafeButton onClick={close} disabled={busy}>
            Cancel
          </SafeButton>
          <button className="btn btn-primary" onClick={() => void confirm()} disabled={busy || snap.aiBusy}>
            Make home page
          </button>
        </>
      }
    >
      <div className="confirm page-dialog">
        <p id="set-home-desc" className="confirm-lead">
          Visitors who open your site’s address will land on “{page.title}”.{former ? ` “${st.pages[former.pageId].title}” moves to an address of its own.` : ''} Links inside your site follow both pages.
        </p>
        <ul className="page-dialog-moves" aria-label="Address changes">
          {moves.map((m) => (
            <li key={m.pageId} data-home={m.pageId === pageId || undefined}>
              {m.pageId === pageId ? <House /> : <FileText />}
              <span className="page-dialog-move-title">{st.pages[m.pageId].title}</span>
              <span className="page-dialog-move-path">
                <span className="page-dialog-address" data-old="">
                  {m.from}
                </span>
                <span className="page-dialog-arrow" aria-hidden="true">
                  →
                </span>
                <span className="sr-only">moves to</span>
                <span className="page-dialog-address">{m.to}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="page-dialog-option" data-off={!keep || undefined}>
          <label>
            <input type="checkbox" checked={keep} disabled={busy} aria-describedby="set-home-keep-note" onChange={(e) => setKeep(e.target.checked)} />
            <span>
              Keep <span className="page-dialog-address">{vacated}</span> working
            </span>
          </label>
          <p id="set-home-keep-note" className="page-dialog-option-note" aria-live="polite">
            {keep ? <ShieldCheck /> : <TriangleAlert />}
            <span>
              {keep ? (
                <>
                  Bookmarks and links from other sites to <span className="page-dialog-address">{vacated}</span> are sent to “{page.title}” at <span className="page-dialog-address">/</span> instead of breaking.
                </>
              ) : taker ? (
                <>
                  Once your site is published again, <span className="page-dialog-address">{vacated}</span> shows “{st.pages[taker.pageId].title}”, so bookmarks and links from other sites to it reach the wrong page.
                </>
              ) : (
                <>
                  Once your site is published again, <span className="page-dialog-address">{vacated}</span> stops working, so bookmarks and links from other sites to it will break.
                </>
              )}
            </span>
          </p>
        </div>
        {rows.length > 0 && (
          <div className="page-dialog-block">
            <div className="page-dialog-heading" id="set-home-links">
              {total === 1 ? `A ${parts} link will use a new address` : `${total} ${parts} links will use new addresses`}
            </div>
            <p className="page-dialog-block-note">{total === 1 ? 'Its words stay as they are, so check it still reads right.' : 'Their words stay as they are, so check they still read right.'}</p>
            <ScrollList className="page-dialog-list page-dialog-links" label="Header and footer links to review">
              {rows.map(({ link: l, where, count }, i) => (
                <li key={`${l.part}:${l.nodeId}:${i}`}>
                  {l.part === 'header' ? <PanelTop data-shared="" /> : <PanelBottom data-shared="" />}
                  <span className="page-dialog-where">{where}</span>
                  <span className="page-dialog-label">
                    {l.label ? `“${l.label}”` : 'A link without text'}
                    {count > 1 ? ` (${count} links)` : ''}
                  </span>
                  <span className="page-dialog-dest">
                    <span className="page-dialog-arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="sr-only">will go to</span>
                    <span className="page-dialog-address">
                      {to.get(l.pageId)}
                      {l.anchor ? `#${l.anchor}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ScrollList>
          </div>
        )}
        <Details items={[{ kind: 'note', icon: <Undo2 />, text: 'You can undo this.' }]} />
      </div>
    </Modal>
  );
}

export function EditDefinitionModal({ target }: { target: ElementRef }) {
  const snap = useStore((s) => s.snapshot);
  const st = snap!.state;
  const r = resolveRef(st, target);
  const node = r.node?.kind === 'instance' ? r.node : null;
  // The component this dialog was opened for: if the placement comes to show another, the dialog never moves to it.
  const [openedId] = useState(() => node?.definitionId);
  const [openedName] = useState(() => (node ? st.components[node.definitionId]?.name : undefined));
  const [busy, setBusy] = useState(false);
  const def = node && openedId && (node.definitionId === openedId || busy) ? st.components[openedId] : undefined;
  const close = () => setState({ modal: null });
  if (!def || !node)
    return (
      <Modal title="Edit component" icon={<Badge icon={<Component />} tone="caution" />} onClose={close} describedBy={GONE_ID} footer={<GoneClose onClose={close} />}>
        <GoneNotice>
          {node ? (
            'This placement now shows a different component. Select it again to edit its design.'
          ) : openedName ? (
            <>
              This placement of <strong>{openedName}</strong> was removed, so there is nothing to edit.
            </>
          ) : (
            'This placement was removed, so there is nothing to edit.'
          )}
        </GoneNotice>
      </Modal>
    );
  const isTheme = def.owner === 'theme';
  const allPlaces = placesOf(st, def.id);
  // Uses inside a theme's own components stay on the original when it is copied, so they are not counted as changing.
  const places = allPlaces.filter((p) => !(isTheme && p.owner.kind === 'component' && st.components[p.owner.id]?.owner !== 'project'));
  const countOf = (list: typeof places) => list.reduce((n, p) => n + p.nodeIds.length, 0);
  const count = countOf(places);
  const staying = countOf(allPlaces) - count;
  const reach = reachOf(st, places);
  const pageTitles = places.filter((p) => p.owner.kind === 'page').map((p) => p.label);
  // Pages that share a title are told apart by their address.
  const placeName = (p: (typeof places)[number]) => {
    if (p.owner.kind === 'shell') return `Shared ${p.label.toLowerCase()}`;
    if (p.owner.kind === 'component') return `Inside ${p.label}`;
    return pageTitles.indexOf(p.label) !== pageTitles.lastIndexOf(p.label) ? `${p.label} (${st.pages[p.owner.id]?.route ?? ''})` : p.label;
  };
  const placeIcon = (p: (typeof places)[number]) => (p.owner.kind === 'shell' ? p.owner.id === 'footer' ? <PanelBottom /> : <PanelTop /> : p.owner.kind === 'component' ? <Component /> : <FileText />);
  /** The pages a shared or nested placement actually reaches, so the list never leaves them to be inferred. */
  const reachOfPlace = (p: (typeof places)[number]) => {
    if (p.owner.kind === 'shell') return 'shows on every page';
    if (p.owner.kind !== 'component') return '';
    const nested = reachOf(st, placesOf(st, p.owner.id));
    const times = p.nodeIds.length * Math.max(nested.appears, 1);
    return nested.everyPage ? 'shows on every page' : nested.pages ? `shows on ${listAll(nested.titles)}${times > 1 ? `, ${times} times` : ''}` : 'not on a page yet';
  };
  // One placement in a shared part, or inside a component placed on several pages, still changes many pages.
  const wide = count > 1 || reach.everyPage || reach.pages > 1 || reach.appears > 1;
  const go = async () => {
    if (busy) return;
    let defId = def.id;
    if (isTheme) {
      setBusy(true);
      let res: Awaited<ReturnType<typeof applyOps>> = null;
      try {
        // Checked against the project shown, so the copy is made of what this dialog described.
        res = await applyOps([{ type: 'component.fork', definitionId: def.id }], `Make ${def.name} a project component`, undefined, snap?.revision);
      } finally {
        if (!res) setBusy(false);
      }
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
  const title = isTheme ? (wide ? `Edit a copy of ${def.name} everywhere?` : `Edit a copy of ${def.name}?`) : wide ? `Edit ${def.name} everywhere?` : `Edit the ${def.name} design?`;
  // Says what the button does (opens the design for editing) and where those edits land.
  const lead = isTheme
    ? count > 1
      ? `You edit a copy, added to Your components. ${staying ? `These ${count} placements` : `All ${count} placements`} switch to it and follow its layout, styles and starting content.`
      : wide
        ? 'You edit a copy, added to Your components. This placement switches to it, so its layout, styles and starting content apply everywhere it shows, below.'
        : 'You edit a copy, added to Your components. This placement switches to it and follows its layout, styles and starting content.'
    : count > 1
      ? 'Changes you make to its layout, styles and starting content apply to every placement below.'
      : wide
        ? 'Changes you make to its layout, styles and starting content apply everywhere it shows, below.'
        : 'Changes you make to its layout, styles and starting content apply here, and anywhere you place it later.';
  const once = places[0];
  const note = count === 1 && !wide ? (once?.owner.kind === 'component' ? `Used once, inside ${once.label}` : `Used once, on ${once ? placeName(once) : 'this page'}`) : reach.text.replace(/^./, (c) => c.toUpperCase());
  const details: Detail[] = [{ kind: 'keep', icon: <ShieldCheck />, text: count > 1 ? 'Each placement keeps its own text, images and changes made on the page.' : 'This placement keeps its own text, images and changes made on the page.' }];
  if (isTheme) details.push({ kind: 'keep', icon: <Package />, text: `The original ${def.name} stays in Insert, as it came with the Foundation theme.` });
  if (isTheme && staying > 0) details.push({ kind: 'note', icon: <Info />, text: `${staying === 1 ? 'One use' : `${staying} uses`} inside other theme components stay${staying === 1 ? 's' : ''} on the original.` });
  return (
    <Modal
      title={title}
      icon={<Badge icon={<Component />} tone="definition" />}
      onClose={close}
      busy={busy}
      describedBy="edit-definition-desc edit-definition-subject edit-definition-details"
      footer={
        <>
          <SafeButton onClick={close} disabled={busy}>
            Cancel
          </SafeButton>
          <button className="btn btn-primary" disabled={busy} onClick={() => void go()}>
            {busy ? 'Making a copy…' : isTheme ? 'Make a copy and edit' : wide ? 'Edit everywhere' : 'Edit design'}
          </button>
        </>
      }
    >
      <div className="authoring-form">
        <FormStatus text={busy ? 'Making a copy' : undefined} />
        <p id="edit-definition-desc" className="confirm-lead">
          {lead}
        </p>
        <Subject id="edit-definition-subject" icon={<Component />} tone="definition" name={def.name} note={isTheme ? `Foundation theme · ${note}` : note} />
        {(count > 1 || wide) && (
          <div className="placement-block">
            <div className="field-label" id="edit-definition-places">
              Used on
            </div>
            <ScrollList className="placement-list" labelledBy="edit-definition-places">
              {places.map((p) => (
                <li key={`${p.owner.kind}:${p.owner.id}`}>
                  <span className="placement-icon" aria-hidden="true">
                    {placeIcon(p)}
                  </span>
                  <span className="grow">
                    {placeName(p)}
                    {reachOfPlace(p) && <span className="placement-reach"> · {reachOfPlace(p)}</span>}
                  </span>
                  <span className="placement-count">{plural(p.nodeIds.length, 'placement')}</span>
                </li>
              ))}
            </ScrollList>
          </div>
        )}
        <Details id="edit-definition-details" items={details} />
      </div>
    </Modal>
  );
}

export function HistoryModal() {
  const versions = useStore((s) => s.modal?.kind === 'history' && s.modal.tab === 'versions');
  return versions ? <SavedVersionsModal /> : <ChangesModal />;
}

function ChangesModal() {
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
          <button className="btn" disabled={!snap?.history.canUndo} onClick={() => projectHistory('undo')}>
            <Undo2 /> Undo
          </button>
          <button className="btn" disabled={!snap?.history.canRedo} onClick={() => projectHistory('redo')}>
            <Redo2 /> Redo
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => setState({ modal: null })}>
            Close
          </button>
        </>
      }
    >
      <HistoryTabs tab="changes" />
      <p className="muted" style={{ marginTop: 0 }}>
        Your last 100 changes, newest first. Undo steps back one change at a time; anything undone can be redone until you make a new change. To keep a version of the site for longer, save it in Saved versions.
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
