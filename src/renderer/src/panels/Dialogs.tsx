import './Dialogs.css';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, Bookmark, Box, CircleAlert, CircleMinus, Component, Copy, CornerDownRight, FileText, FolderSync, History, House, Info, Newspaper, Package, PanelBottom, PanelTop, Pencil, Redo2, ShieldCheck, Sparkles, Split, Trash2, TriangleAlert, Undo2, User, Users } from 'lucide-react';
import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import type { AiTurnReview, ProjectSnapshot } from '@shared/api';
import type { ApplyResult } from '@shared/ops';
import { newId } from '@shared/ids';
import { displayName, placesOf } from '@engine/tree';
import { planHomeChange } from '@engine/apply';
import { wasPublishedFor } from '@shared/published';
import { uniqueCopyName } from '@engine/definitions';
import { placementRole } from '@engine/insert-role';
import { planSwap, type SwapCarry, type SwapPlan } from '@engine/swap';
import type { LinkHolder, PageLinkUse } from '@engine/page-links';
import { shellPageLinks, type ShellPageLink } from '@generator/checks';
import { isDraftPage } from '@generator/index';
import { applyOps, api, commitOps, errorText, getState, projectHistory, revertAiTurn, saveLocal, setState, shownAt, stepHistory, toast, useStore } from '../store';
import { Field, Modal, openMenus, openSection, Tabs } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { createComponentTarget, resolveRef, treeFor } from '../lib/model';
import { goToShellPart, insertionPoint, openComponentStudio, selectPage, setMode } from '../lib/actions';
import { duplicateName, duplicateOperation } from '../lib/duplicate-component';
import { componentRequest, componentRequestContext, newComponentPlace, startBlankOps } from '../lib/new-component';
import { NEW_HOME, planPageRemoval, reviewPageRemoval, withoutCards, type PageReplacement } from '../lib/page-removal';
import { SECTION_NODE, sectionOptions } from '../lib/sections';
import { HistoryNote, historyLock, SavedVersionsPanel } from './SavedVersions';
import { clock, dayAndTime, dayKey, dayName, fullWhen, lowerDay } from '../lib/when';
import { appliedCount, historyStep } from '../lib/history-steps';
import { reviewPlan, stepChangeText, turnName } from '../lib/turn-review';
import { swapChoices, type SwapChoice } from '../lib/swap-choices';

/** The longest name a component can have. */
const NAME_MAX = 60;
/** The longest description a component can have. */
const DESCRIPTION_MAX = 300;
const WHERE_NAMES_SHOW = 'Shown in Insert under Your components.';
/** The note under a name field: where the name shows, until it reaches the limit. */
const nameHint = (name: string, hint: string) => (name.length >= NAME_MAX ? `Names can be up to ${NAME_MAX} characters.` : hint);

export const GONE_ID = 'component-dialog-gone';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/*
 * The component dialogs share the confirmation dialogs' order (ConfirmDialog.tsx): a badge for the action, what it
 * acts on set apart, one line for each thing that changes or stays safe, then the one field it asks for. Plum, the
 * colour of a component's design, marks only Edit everywhere, the one that changes every placement at once.
 */

/** The title's badge: the action's glyph in a tinted disc. `caution` once the dialog's subject has gone. */
export function Badge({ icon, tone = 'neutral' }: { icon: React.ReactNode; tone?: 'neutral' | 'definition' | 'caution' }) {
  return (
    <span className="confirm-icon authoring-badge" data-tone={tone} aria-hidden="true">
      {icon}
    </span>
  );
}

/** What the dialog acts on, with how far it reaches. */
export function Subject({ id, icon, name, note, tone }: { id?: string; icon: React.ReactNode; name: React.ReactNode; note?: React.ReactNode; tone?: 'definition' }) {
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

export interface Detail {
  /** `change`: what the action does. `keep`: what stays as it is. `lose`: what goes with it. `risk`: what may break. `note`: anything else worth knowing. */
  kind: 'change' | 'keep' | 'note' | 'lose' | 'risk';
  icon: React.ReactNode;
  text: React.ReactNode;
}
export function Details({ id, items }: { id?: string; items: Detail[] }) {
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
export function Count({ length, max }: { length: number; max: number }) {
  if (length < max * 0.8) return null;
  return (
    <span className="authoring-count" data-full={length >= max || undefined} aria-hidden="true">
      {length}/{max}
    </span>
  );
}

/** A list that can be scrolled by keyboard, with a tab stop only when it actually overflows. */
export function ScrollList({ className, labelledBy, label, children }: { className: string; labelledBy?: string; label?: string; children: React.ReactNode }) {
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
export const limitSaid = (length: number, max: number, what: string) => (length >= max ? `${what} can be up to ${max} characters.` : undefined);

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
export function SafeButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
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
export function FormStatus({ text }: { text?: string }) {
  return (
    <span className="sr-only" role="status">
      {text ?? ''}
    </span>
  );
}

/** Why a dialog can no longer do what it was opened for. It replaces the form, so nothing dead stays editable. */
export function GoneNotice({ children }: { children: React.ReactNode }) {
  return (
    <div id={GONE_ID} className="scope-note danger authoring-gone" role="alert">
      <CircleAlert />
      <span>{children}</span>
    </div>
  );
}

/** The only way out of a dialog whose subject has gone. It takes focus, because the field that had it is removed. */
export function GoneClose({ onClose }: { onClose: () => void }) {
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
    let r: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      r = await commitOps(plan.ops, `Create component ${name.trim()}`, undefined, now.revision);
    } finally {
      if (!r) setBusy(false);
    }
    if (!r) return;
    const root = typeof r.results?.[0]?.rootNodeId === 'string' ? r.results[0].rootNodeId : null;
    // Opened once the editor shows the change. An Undo or another change that landed meanwhile can have taken the
    // component or its placement away again: then nothing opens.
    await shownAt(r.revision, now.workspaceKey);
    const after = getState();
    const shown = after.snapshot?.state;
    const gone = !shown?.components[plan.definitionId] || !shown.pages[at.pageId]?.nodes[plan.nodeId];
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
export function useSelectedOnOpen() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  useHeldFocus(ref);
  return ref;
}

/** Close this dialog, and only this one: a save that lands after it was dismissed leaves the next dialog open. */
export function useCloseOwn() {
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

/** One piece of carried content as the preview says it: "Supporting text → Text", "Cards → Plans (6 items)". */
const carryText = (k: SwapCarry) => `${k.from === k.to ? k.from : `${k.from} → ${k.to}`}${k.items ? ` (${plural(k.items, 'item')})` : ''}`;

/**
 * Show one placement as another design where it is (#374). The author picks the design and sees, before confirming,
 * which of its content carries over and which would be dropped: the same plan the change itself follows. One change,
 * so one Undo brings the old design back.
 */
export function SwapComponentModal({ owner, nodeId, definitionId }: { owner: OwnerRef; nodeId: string; definitionId: string }) {
  const st = useStore((s) => s.snapshot?.state);
  const revision = useStore((s) => s.snapshot?.revision);
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  const dev = useStore((s) => !!s.settings?.developerMode);
  const tree = st ? treeFor(st, owner) : undefined;
  const node = tree && Object.hasOwn(tree.nodes, nodeId) ? tree.nodes[nodeId] : undefined;
  // The placement chosen, still showing the design it showed then: an Undo or the AI may have changed it.
  const current = node?.kind === 'instance' && node.definitionId === definitionId ? node : undefined;
  const def = st && current ? st.components[definitionId] : undefined;
  const [opened] = useState(() => (def && current ? { name: current.name ?? def.name, top: !!tree?.rootIds.includes(nodeId) && placementRole(st!, owner, nodeId) === 'section' } : null));
  const choices = useMemo(() => (st && current ? swapChoices(st, current, dev) : []), [st, current, dev]);
  const [key, setKey] = useState(() => choices[0]?.key ?? '');
  // Only the design picked: one that has gone since (an Undo, the AI) is never swapped for another without a word.
  const choice = choices.find((c) => c.key === key);
  const plan = useMemo(() => (st && tree && current && choice ? planSwap(st, owner, tree, current, choice.def) : null), [st, tree, current, choice, owner]);
  // What the dialog showed when the change was sent: the placement shows the new design as it lands, before the reply.
  const [sent, setSent] = useState<{ plan: SwapPlan; choice: SwapChoice; choices: SwapChoice[]; name: string } | null>(null);
  const busy = !!sent;
  const offered = sent?.choices ?? choices;
  const designName = sent?.name ?? def?.name;
  const id = useId();
  const close = useCloseOwn();
  const title = opened?.top === false ? 'Change design' : 'Change section design';
  const ready = !!plan && !plan.problems.length && !busy && !readOnly;
  // A collection's layout is shared by every entry shown with it.
  const where = st ? (owner.kind === 'template' ? `In the layout of ${st.collections?.[owner.id]?.settings.name ?? 'a collection'}, shown for every entry` : placeOf(st, owner)) : undefined;
  const change = async () => {
    if (!ready || !plan || !choice || !def) return;
    setSent({ plan, choice, choices, name: def.name });
    // Checked against the revision previewed, so a change on its way (an Undo, the AI) can't alter what was shown.
    let r: Awaited<ReturnType<typeof applyOps>> = null;
    try {
      r = await applyOps([{ type: 'instance.swapComponent', owner, nodeId, ...choice.spec, ...(plan.dropped.length ? { allowDrops: true } : {}) }], `Change ${opened?.name ?? 'section'} to ${choice.def.name}`, undefined, revision);
    } finally {
      if (!r) setSent(null);
    }
    if (r) close();
  };
  const shown = sent ?? (plan && choice ? { plan, choice } : null);
  const dropped = shown?.plan.dropped ?? [];
  const details: Detail[] = shown
    ? [
        {
          kind: 'keep',
          icon: <ShieldCheck />,
          text: shown.plan.kept.length ? `Carries over ${listAll(shown.plan.kept.map(carryText))}.` : `None of its content has a place in ${shown.choice.def.name}.`
        },
        ...dropped.map((d): Detail => ({ kind: 'lose', icon: <CircleMinus />, text: `Drops ${d.label}${d.reason ? `: ${d.reason}` : ''}.` })),
        ...(shown.plan.restyled.length ? [{ kind: 'note' as const, icon: <Info />, text: `Not in the new design: ${listAll(shown.plan.restyled)}.` }] : []),
        { kind: 'keep', icon: <ShieldCheck />, text: 'It stays where it is. One Undo brings the old design back.' }
      ]
    : [];
  return (
    <Modal
      title={title}
      icon={<Badge icon={<ArrowRightLeft />} tone={def ? 'neutral' : 'caution'} />}
      onClose={close}
      busy={busy}
      describedBy={(def || busy) && offered.length ? `${id}-lead${shown ? ` ${id}-details` : ''}` : GONE_ID}
      footer={
        (def || busy) && offered.length ? (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className={dropped.length ? 'btn btn-danger-fill' : 'btn btn-primary'} disabled={!ready} onClick={() => void change()}>
              {busy ? 'Changing…' : dropped.length ? `Change and drop ${plural(dropped.length, 'field')}` : 'Change design'}
            </button>
          </>
        ) : (
          <GoneClose onClose={close} />
        )
      }
    >
      {(def || busy) && offered.length ? (
        <div className="authoring-form" data-testid="swap-component-dialog">
          <FormStatus text={busy && shown ? `Changing to ${shown.choice.def.name}` : undefined} />
          <p id={`${id}-lead`} className="confirm-lead">
            Show {opened?.name ?? 'it'} as another design, in the same place. Its content moves to the fields of the same name or meaning.
          </p>
          {designName && <Subject icon={<Component />} name={designName} note={where} />}
          <Field label="New design" hint={shown ? undefined : 'The design picked is no longer available. Pick another.'}>
            <select className="select" value={shown?.choice.key ?? ''} disabled={busy} onChange={(e) => setKey(e.target.value)}>
              {!shown && (
                <option value="" disabled>
                  Pick a design
                </option>
              )}
              {['Similar sections', 'Similar blocks', 'Your components', 'Other sections', 'Other blocks'].map((group) => {
                const list = offered.filter((c) => c.group === group);
                return list.length ? (
                  <optgroup key={group} label={group}>
                    {list.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </Field>
          {shown?.plan.problems.length ? (
            <div id={`${id}-details`} className="scope-note danger" role="alert">
              <CircleAlert />
              <span>{shown.plan.problems[0]}</span>
            </div>
          ) : shown ? (
            <Details id={`${id}-details`} items={details} />
          ) : null}
        </div>
      ) : (
        <GoneNotice>
          {def && !offered.length
            ? `No other design can stand here in place of ${def.name}.`
            : node?.kind === 'instance'
              ? 'This placement now shows a different design. Select it again to change it.'
              : 'This placement was removed, so there is nothing to change.'}
        </GoneNotice>
      )}
    </Modal>
  );
}

/**
 * Copy a component's definition as a new project component (spec §8.4). Nothing placed moves to the copy, which is
 * what sets it apart from Make unique.
 */
export function DuplicateComponentModal({ definitionId, openedIn }: { definitionId: string; openedIn?: string }) {
  const st = useStore((s) => s.snapshot?.state);
  const workspaceKey = useStore((s) => s.snapshot?.workspaceKey);
  // Bound to the project it was asked for in: another made from the same theme can hold the same component ID.
  const def = st && workspaceKey === openedIn && Object.hasOwn(st.components, definitionId) ? st.components[definitionId] : undefined;
  // Suggested once, as the dialog opens, so the field never changes under the author.
  const [suggested] = useState(() => (st && def ? duplicateName(st, def.name) : ''));
  const [opened] = useState(() => def?.name);
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const count = st && def ? placesOf(st, definitionId).reduce((n, p) => n + p.nodeIds.length, 0) : 0;
  const input = useSelectedOnOpen();
  const close = useCloseOwn();
  const ready = !!def && !!name.trim() && !busy;
  const nameError = name.trim() ? undefined : 'Enter a name for the copy.';
  const duplicate = async () => {
    const snap = getState().snapshot;
    if (!ready || !snap || snap.workspaceKey !== openedIn || !Object.hasOwn(snap.state.components, definitionId)) return;
    const op = duplicateOperation(snap.state, snap.state.components[definitionId], name.trim(), suggested);
    setBusy(true);
    // The name was checked against this revision, so it goes with the change.
    let r: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      r = await commitOps([op], `Duplicate component ${def.name}`, undefined, snap.revision);
    } finally {
      if (!r) setBusy(false);
    }
    if (!r) return;
    close();
    const made = r.results?.[0]?.definitionId as string | undefined;
    if (!made || getState().snapshot?.workspaceKey !== openedIn || op.type !== 'component.duplicate') return;
    toast(`Duplicated ${def.name} as ${op.name}`, 'info', {
      label: 'Open in Component Studio',
      run: () => {
        if (getState().snapshot?.workspaceKey !== openedIn) return;
        if (!openComponentStudio(made)) toast(`${op.name} is no longer in this project.`, 'info');
      }
    });
  };
  return (
    <Modal
      title="Duplicate component"
      icon={<Badge icon={<Copy />} tone={def ? 'neutral' : 'caution'} />}
      onClose={close}
      busy={busy}
      describedBy={def ? 'duplicate-component-desc duplicate-component-subject duplicate-component-details' : GONE_ID}
      footer={
        def ? (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!ready} onClick={() => void duplicate()}>
              {busy ? 'Duplicating…' : 'Duplicate'}
            </button>
          </>
        ) : (
          <GoneClose onClose={close} />
        )
      }
    >
      {def ? (
        <div className="authoring-form">
          <FormStatus text={busy ? 'Duplicating component' : (nameError ?? limitSaid(name.length, NAME_MAX, 'Names'))} />
          <p id="duplicate-component-desc" className="confirm-lead">
            Makes a new component with the same design, which you can change on its own.
          </p>
          <Subject id="duplicate-component-subject" icon={<Component />} name={def.name} note={st ? reachOf(st, placesOf(st, definitionId)).text : undefined} />
          <Details
            id="duplicate-component-details"
            items={[{ kind: 'keep', icon: <ShieldCheck />, text: count ? `${count === 1 ? 'Its placement keeps' : `All ${count} placements keep`} following ${def.name}.` : `${def.name} stays as it is.` }]}
          />
          <Field label="Name for the copy" hint={nameHint(name, WHERE_NAMES_SHOW)} error={nameError} extra={<Count length={name.length} max={NAME_MAX} />}>
            <input ref={input} className="input" autoFocus readOnly={busy} aria-required="true" maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void duplicate()} />
          </Field>
        </div>
      ) : (
        <GoneNotice>
          <strong>{opened ?? 'This component'}</strong> is no longer in this project, so there is nothing to duplicate.
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
  // Home can leave a new blank Home in its place instead: the choice made when no other page can take over, and
  // the only one while none can.
  const [blankChosen, setBlankChosen] = useState(isHome && !others.length);
  const blank = isHome && (blankChosen || !others.length);
  // Once it is the only choice it stays chosen: a page published again later (an undo, the assistant) never
  // brings back a page pick the author can no longer see.
  useEffect(() => {
    if (isHome && !others.length) setBlankChosen(true);
  }, [isHome, others.length]);
  const homeChoice = useId();
  // A replacement that has gone since it was picked (an undo, the assistant) is never swapped for another page
  // without asking: the author chooses again. So too when the blank Home was chosen and this page has since
  // stopped being Home: the page picked before that is never used without asking.
  const pagePicked = !blank && !blankChosen && picked && picked !== pageId && Object.hasOwn(st.pages, picked) && !(isHome && isDraftPage(st, st.pages[picked])) ? picked : undefined;
  const replacement: PageReplacement = blank ? NEW_HOME : pagePicked;
  // Section choices hold only for the replacement and the project they were made for: a new replacement or any
  // change to the project (an undo, the assistant) asks again.
  const [sections, setSections] = useState<{ key: string; choices: Map<string, string> }>({ key: '', choices: new Map() });
  const key = [snap?.workspaceKey, pageId, pagePicked, snap?.revision].join('\u0000');
  const choices = sections.key === key ? sections.choices : new Map<string, string>();
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const review = reviewPageRemoval(st, pageId, replacement);
  const follows = st.site.headerMenuOrder === 'follow';
  const refs = review.uses.length;
  const plan = planPageRemoval(st, pageId, replacement, choices);
  const target = pagePicked ? st.pages[pagePicked] : undefined;
  const aiBusy = !!snap?.aiBusy;
  // A page deleted some other way (the assistant) takes its dialog with it, so an undo never brings the dialog back.
  useEffect(() => {
    const modal = getState().modal;
    if (!page && !busy && modal?.kind === 'delete-page' && modal.pageId === pageId) setState({ modal: null });
  }, [page, busy, pageId]);
  const close = () => !busy && setState({ modal: null });
  if (!page) return null;
  const pick = (id: string) => (setBlankChosen(false), setPicked(id));
  const choose = (fragment: string, value: string) => setSections({ key, choices: new Map(choices).set(fragment, value) });
  // The replacement page's sections as they will be once this page's cards have left their lists.
  const { options } = sectionOptions(review.cards.length ? withoutCards(st, pageId) : st, pagePicked);
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
    // A new blank Home is the Home page the deletion left.
    if (current === pageId || !getState().snapshot?.state.pages[current ?? '']) selectPage(pagePicked ?? getState().snapshot?.state.site.homePageId ?? st.site.homePageId);
    // The row that opened this is gone: keyboard focus goes to the current page's row.
    setTimeout(() => document.querySelector<HTMLElement>('[role="listbox"][aria-label="Pages"] [role="option"][aria-selected="true"]')?.focus(), 0);
  };
  const draft = isDraftPage(st, page);
  const asks = refs > 0 || isHome;
  const missing = target ? review.missing : [];
  const open = missing.filter((m) => !choices.has(m.fragment)).length;
  const under = pagesUnder(st, pageId);
  const linkWord = (n: number) => `${n} link${n === 1 ? '' : 's'}`;
  // What the blank Home choice means, said under it: and, when it is the only choice, why.
  const blankNote = !blank
    ? undefined
    : `An empty page at /, with the header and footer, becomes the home page. No other page changes address.${others.length ? '' : st.site.pageOrder.length > 1 ? ' Every other page is a draft, so none can be the home page.' : ''}`;
  // What the replacement choice means, said under it where it needs saying: a page still to choose, a draft that
  // would stop the export, or the new home page's move. A published page needs nothing: the line below says it.
  const outcome = !target ? (
    `Choose the page ${isHome ? 'that becomes the home page' : `its ${linkWord(refs)} open instead`}.`
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
        ? { text: isHome ? 'The site needs a new home page.' : 'Its links need a page to go to.', act: 'Choose' }
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
            {linkWord(refs)} on your site {blank ? <>will open the top of the new blank Home</> : target ? <>will open <strong>“{target.title}”</strong></> : 'will open the page you choose'}.{' '}
            <span className="page-dialog-quiet">{refs === 1 ? 'Its' : 'Their'} words stay as they are.</span>
          </span>
          <ScrollList className="page-dialog-list" labelledBy="delete-page-links">
            {review.uses.map((u, i) => (
              <RemovedPageLink key={i} use={u} landing={u.link.anchor ? (blank ? { text: 'top of page' } : target ? (landings.get(u.link.anchor) ?? { text: 'same section' }) : undefined) : undefined} />
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
  if (review.menu.length)
    details.push({
      kind: 'lose',
      icon: <CircleMinus />,
      text: (
        <>
          <span id="delete-page-menu">{review.menu.length === 1 ? (follows ? 'Its link is removed from the header menu, which follows the page order.' : 'Its link is removed from the header menu, which already links to the new Home page.') : `Its ${review.menu.length} links are removed from the header menu, which ${follows ? 'follows the page order' : 'already links to the new Home page'}.`}</span>
          <ScrollList className="page-dialog-list" labelledBy="delete-page-menu">
            {review.menu.map((label, i) => (
              <li key={i}>
                {holderIcon({ kind: 'shell', id: 'header' })}
                <span className="page-dialog-where">Header</span>
                <span className="page-dialog-label">“{label}”</span>
              </li>
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
        {isHome && (
          <div className="page-dialog-home" role="radiogroup" aria-labelledby={`${homeChoice}-label`}>
            <div className="page-dialog-heading" id={`${homeChoice}-label`}>
              New home page
            </div>
            {others.length > 0 && (
              <label className="page-dialog-choice">
                <input type="radio" name={homeChoice} checked={!blank} disabled={busy} onChange={() => setBlankChosen(false)} /> Make another page Home
              </label>
            )}
            <label className="page-dialog-choice">
              <input type="radio" name={homeChoice} checked={blank} disabled={busy} aria-describedby={blankNote ? `${homeChoice}-note` : undefined} onChange={() => setBlankChosen(true)} /> Leave a new blank Home
            </label>
            {blankNote && (
              <p className="page-dialog-block-note" id={`${homeChoice}-note`}>
                {blankNote}
              </p>
            )}
          </div>
        )}
        {asks && !blank && (
          <Field label={isHome ? 'Page that becomes Home' : `Send its ${linkWord(refs)} to`} hint={outcome}>
            <select className="select" aria-required="true" data-unset={!pagePicked || undefined} value={pagePicked ?? NO_PAGE} disabled={busy} onChange={(e) => pick(e.target.value)}>
              {!pagePicked && (
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
          {`Links that will open ${blank ? 'the new blank Home' : (target?.title ?? 'the page you choose')}`}
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
  // Only an address the website was exported with can be in anyone's bookmarks: one never exported is not kept.
  const published = wasPublishedFor(st, vacated, pageId);
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
        {published ? (
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
        ) : (
          <p className="page-dialog-option-note">
            <span>
              The website hasn’t been exported with “{page.title}” at <span className="page-dialog-address">{vacated}</span>, so no old address is kept for it there.
            </span>
          </p>
        )}
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

/**
 * An AI turn reviewed in History (issue 164): what its step changed, with the values it had and was given; every
 * change made after it, and whether it depends on the turn; and the two ways back, each saying what it takes and
 * keeps. Undoing the turn on its own keeps every later change, and is offered only when none depends on it. History's
 * step to it is always offered: it takes back every change in between, newest first, and they can be redone.
 */
function TurnReview({
  entryId,
  snap,
  locked,
  focusRef,
  onStep,
  onRevert
}: {
  entryId: string;
  snap: ProjectSnapshot;
  locked: boolean;
  focusRef: (el: HTMLElement | null) => void;
  onStep: (index: number) => void;
  onRevert: (reviewed: { revision: number; history: string }, done: string) => void;
}) {
  const headId = useId();
  const revertNote = useId();
  const stepNote = useId();
  const headRef = useRef<HTMLElement | null>(null);
  const head = useCallback(
    (el: HTMLElement | null) => {
      headRef.current = el;
      focusRef(el);
    },
    [focusRef]
  );
  // An action taken goes with what it changed (the turn is undone): focus comes back to the review, never the page.
  const acted = useRef(false);
  useEffect(() => {
    if (!acted.current || (document.activeElement && document.activeElement !== document.body)) return;
    acted.current = false;
    headRef.current?.focus();
  });
  const entries = snap.history.entries;
  // Worked out again whenever the project or History moves: what was shown before is never acted on.
  const key = `${snap.workspaceKey}|${entryId}|${snap.revision}|${entries.map((e) => `${e.id}:${e.applied ? 1 : 0}`).join(',')}`;
  const [got, setGot] = useState<{ key: string; review?: AiTurnReview; message?: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.project.reviewAiTurn(entryId, snap.workspaceKey).then(
      (r) => live && setGot({ key, ...(r.ok && r.review ? { review: r.review } : { message: r.message ?? 'This turn can’t be reviewed.' }) }),
      (e: unknown) => live && setGot({ key, message: errorText(e) })
    );
    return () => {
      live = false;
    };
    // The key says everything the review depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const review = got?.review;
  // Answered for the project as shown: a review queued behind a change that has not reached the editor yet waits.
  const current = got?.key === key && (!review || review.revision === snap.revision);
  const plan = review ? reviewPlan(review, entries) : null;
  const off = locked || !current;
  const name = review ? turnName(review.label) : '';
  return (
    <section
      className="turn-review"
      aria-labelledby={headId}
      aria-busy={!current || undefined}
      // A key held down from the card that opened History repeats here too: only a fresh press acts.
      onKeyDown={(e) => e.repeat && (e.key === 'Enter' || e.key === ' ') && e.preventDefault()}
    >
      <h3 id={headId} ref={head} tabIndex={-1} data-autofocus>
        <Sparkles aria-hidden="true" /> {review ? `AI turn: ${name}` : 'AI turn'}
      </h3>
      {!got ? (
        <p className="muted">Looking at what this turn changed…</p>
      ) : !review ? (
        <p className="muted">{got.message}</p>
      ) : (
        <>
          <p className="muted turn-review-standing">
            {review.revertedBy ? `Undone on its own by “${review.revertedBy.label}”.` : review.applied ? 'In the site now.' : 'Undone.'}
          </p>
          <h4>What it changed</h4>
          {review.changes.length ? (
            <ul className="turn-review-changes" aria-label="What this turn changed">
              {review.changes.map((c, i) => (
                <li key={i}>{stepChangeText(c)}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">{review.detailsLost ? 'History no longer holds what it changed.' : 'Nothing it changed can be described here.'}</p>
          )}
          {review.later.length > 0 && (
            <>
              <h4>Changes made after it</h4>
              <ul className="turn-review-later" aria-label="Changes made after this turn">
                {review.later.map((l) => (
                  <li key={l.entryId}>
                    <span className="turn-review-label">
                      {l.source === 'ai' ? <Sparkles aria-hidden="true" /> : <User aria-hidden="true" />}
                      <span className="grow">{l.label}</span>
                      {l.relation === 'depends' ? <span className="badge amber">Depends on this turn</span> : plan?.revert.ok ? <span className="badge green">Kept</span> : null}
                    </span>
                    {l.reason && <span className="turn-review-reason">{l.reason}</span>}
                    {l.changes.length > 0 && (
                      <ul>
                        {l.changes.map((c, i) => (
                          <li key={i}>{stepChangeText(c)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan && (
            <div className="turn-review-actions">
              {plan.revert.ok ? (
                <div className="turn-review-action">
                  <button className="btn btn-sm btn-primary" disabled={off} aria-describedby={revertNote} onClick={() => ((acted.current = true), onRevert({ revision: review.revision, history: review.history }, `Undid “${name}” on its own.`))}>
                    <Undo2 /> Undo this turn only
                  </button>
                  <p id={revertNote}>
                    {plan.revert.text}
                    {plan.revert.lost ? ` ${plan.revert.lost}` : ''}
                  </p>
                </div>
              ) : (
                <p className="turn-review-reason">It can’t be undone on its own. {plan.revert.reason}</p>
              )}
              {plan.step && (
                <div className="turn-review-action">
                  <button className="btn btn-sm" disabled={off} aria-label={plan.step.name} aria-describedby={stepNote} onClick={() => ((acted.current = true), onStep(plan.step!.index))}>
                    {plan.step.direction === 'undo' ? <Undo2 /> : <Redo2 />} {plan.step.text}
                  </button>
                  <p id={stepNote}>{plan.step.note}</p>
                  {plan.step.count > 1 && (
                    <ol aria-label={plan.step.direction === 'undo' ? 'Undone, in this order' : 'Redone, in this order'}>
                      {plan.step.takes.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

type HistoryTab = 'changes' | 'versions';
/** No element: a panel opened on the other tab holds on to no focus. */
const NO_FOCUS: React.RefObject<HTMLElement | null> = { current: null };

/**
 * History: one dialog with two tabs (the shared APG Tabs), Changes and Saved versions. Both panels stay mounted, so a
 * name being typed, a list's scroll and a review survive switching, and the dialog keeps its place and its height.
 * Each panel pins what it needs above its list (a note on why History is held, the intro, the save form) and scrolls
 * only the list; each puts its own actions in the dialog's footer while it is shown.
 */
export function HistoryModal() {
  const tab = useStore((s): HistoryTab => (s.modal?.kind === 'history' && s.modal.tab === 'versions' ? 'versions' : 'changes'));
  const [foot, setFoot] = useState<HTMLElement | null>(null);
  // A version being saved, renamed, restored or deleted: the dialog waits for it before it can close.
  const [busy, setBusy] = useState(false);
  const show = (next: HistoryTab) => {
    const m = getState().modal;
    if (m?.kind === 'history') setState({ modal: { ...m, tab: next === 'versions' ? 'versions' : undefined } });
  };
  return (
    <Modal title="History" icon={<History />} onClose={() => setState({ modal: null })} busy={busy} footer={<span ref={setFoot} className="history-foot" />}>
      <div className="history-body">
        <Tabs<HistoryTab>
          value={tab}
          onChange={show}
          label="History"
          idBase="history"
          keepMounted
          panelClassName="history-panel"
          options={[
            { value: 'changes', label: 'Changes', icon: <Undo2 aria-hidden="true" />, panel: () => <ChangesPanel active={tab === 'changes'} foot={foot} holding={busy} /> },
            { value: 'versions', label: 'Saved versions', icon: <Bookmark aria-hidden="true" />, panel: () => <SavedVersionsPanel active={tab === 'versions'} foot={foot} onBusy={setBusy} /> }
          ]}
        />
      </div>
    </Modal>
  );
}

type Entry = ProjectSnapshot['history']['entries'][number];
/** Who made a change, as its row says it. */
const changeBy = (e: Entry) => (e.source === 'ai' ? 'AI' : e.source === 'system' ? 'Outside the app' : e.guestName ? `${e.guestName} (guest)` : 'You');
/** Its glyph: a person for you, two for a live-session guest, the AI's sparkles, a synced folder for a change made outside. */
function ChangeGlyph({ e }: { e: Entry }) {
  if (e.source === 'ai') return <Sparkles aria-hidden="true" />;
  if (e.source === 'system') return <FolderSync aria-hidden="true" />;
  return e.guestName ? <Users aria-hidden="true" /> : <User aria-hidden="true" />;
}

/** `holding`: a saved version is being saved, renamed, restored or deleted, and the dialog waits for it to close. */
function ChangesPanel({ active, foot, holding }: { active: boolean; foot: HTMLElement | null; holding: boolean }) {
  const snap = useStore((s) => s.snapshot);
  // Opened from a notification whose change could not be undone on its own: show that change, with focus on it.
  // Otherwise focus starts where History stands now.
  const focusId = useStore((s) => (s.modal?.kind === 'history' ? s.modal.entryId : undefined));
  // Opened from an AI turn's card to review it (issue 164): its review leads, and focus starts on it, never on a row
  // that would step History at a key press.
  const reviewing = useStore((s) => (s.modal?.kind === 'history' && s.modal.review && s.modal.opening === s.snapshot?.workspaceKey ? s.modal.entryId : undefined));
  const all = snap?.history.entries ?? [];
  const cursor = appliedCount(all);
  // Newest first, each with its place in History, which is oldest first.
  const entries = all.map((e, i) => ({ e, i })).reverse();
  const has = (id: string | null | undefined): id is string => !!id && all.some((e) => e.id === id);
  // The list is one Tab stop: the row last focused, else the change asked for, else where History stands now.
  const [stop, setStop] = useState<string | null>(null);
  const tabId = has(stop) ? stop : has(focusId) ? focusId : (all[cursor - 1] ?? all[cursor] ?? all.at(-1))?.id;
  // Until the pointer is used in the list, the row focus started on keeps its ring: the dialog's safe default is seen.
  const [fresh, setFresh] = useState(true);
  // The row pointed at or focused: the rows its step would take with it are marked, so its reach is seen.
  const [aim, setAim] = useState<number | null>(null);
  // What the last step chosen here did, for History as it stood then (`at`): once History moves on (another step, the
  // AI, a guest, the footer's Undo) or is held, it no longer describes what is on screen and is not shown.
  const [saidAt, setSaid] = useState<{ text: string; failed: boolean; at: string; want?: number } | null>(null);
  // One step at a time, until the project shows where it went: a second chosen before then would be planned on
  // History as it was.
  const stepping = useRef(false);
  const [waitFor, setWaitFor] = useState<number | null>(null);
  const busy = waitFor !== null && (snap?.revision ?? 0) < waitFor;
  // While the AI works History is its to change, and a read-only project can't be changed at all: a step chosen now
  // could take back more than its row says, or nothing. The rows stay readable, and the reason is pinned above them.
  const lock = historyLock(snap, 'changes');
  const locked = busy || !!lock;
  const historyAt = `${snap?.revision ?? 0}|${all.length}|${cursor}|${all.at(-1)?.id ?? ''}`;
  // A step's success is pinned to History once the project shows where the step went.
  useEffect(() => {
    if (!saidAt || saidAt.at || saidAt.want === undefined || snap?.revision === undefined) return;
    // Bound to History at exactly the revision the step produced; one that went past it (a guest's edit landed first)
    // is no longer what the message describes, so it is dropped.
    if (snap.revision === saidAt.want) setSaid({ ...saidAt, at: historyAt });
    else if (snap.revision > saidAt.want) setSaid(null);
  }, [saidAt, snap?.revision, historyAt]);
  const said = saidAt && !lock && saidAt.at === historyAt ? saidAt : null;
  const noteId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // Where History stands stays in sight: when its row is scrolled away, the line above the list offers to show it.
  const [nowSeen, setNowSeen] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const nowRow = useRef<HTMLLIElement | null>(null);
  const nowRef = useCallback((el: HTMLLIElement | null) => {
    nowRow.current = el;
  }, []);
  useEffect(() => {
    const el = nowRow.current;
    const root = el?.closest<HTMLElement>('.history-scroll');
    if (!el || !root || typeof IntersectionObserver === 'undefined') return setNowSeen(true);
    // Under the sticky day heading counts as out of sight.
    const seen = new IntersectionObserver(([e]) => setNowSeen(e.isIntersecting), { root, rootMargin: '-30px 0px 0px 0px', threshold: 0.6 });
    seen.observe(el);
    return () => seen.disconnect();
  }, [cursor, all.length, active]);
  const showNow = () => {
    const el = nowRow.current;
    el?.scrollIntoView({ block: 'center' });
    el?.querySelector<HTMLElement>('.history-step')?.focus({ preventScroll: true });
  };
  // Focus starts on the list's Tab stop, and stays there while the menu that opened History finishes closing.
  const startRef = useRef<HTMLElement | null>(null);
  const openedHere = useRef(active).current;
  useHeldFocus(openedHere ? startRef : NO_FOCUS);
  const start = useCallback((el: HTMLElement | null) => {
    startRef.current = el;
    el?.scrollIntoView({ block: 'nearest' });
  }, []);
  // The row that had focus went with its change (dropped by a newer one): focus goes on to the list's Tab stop, so
  // the keys still move through the list rather than out of the dialog.
  useEffect(() => {
    if (active && stop && !all.some((e) => e.id === stop) && (!document.activeElement || document.activeElement === document.body))
      listRef.current?.querySelector<HTMLElement>('.history-step[tabindex="0"]')?.focus();
  });
  /** Make one change to History (`run`), saying `done` once it is made or why it could not be. */
  const act = (run: (snap: ProjectSnapshot) => Promise<ApplyResult>, done: string) => {
    if (!snap || stepping.current || locked) return;
    const key = snap.workspaceKey;
    stepping.current = true;
    setWaitFor(Infinity);
    run(snap).then(
      (r) => {
        if (getState().snapshot?.workspaceKey !== key) return;
        // A step that was made is said for History as the step left it; one that failed, for History as it is.
        const now = getState().snapshot;
        const nowAll = now?.history.entries ?? [];
        const here = (revision: number, entries: typeof nowAll) => `${revision}|${entries.length}|${appliedCount(entries)}|${entries.at(-1)?.id ?? ''}`;
        setSaid(r.ok ? { text: done, failed: false, at: '', want: r.revision } : { text: r.error?.message ?? 'That step could not be made.', failed: true, at: here(now?.revision ?? 0, nowAll) });
        setWaitFor(r.ok ? r.revision : null);
      },
      (e: unknown) => {
        const now = getState().snapshot;
        const nowAll = now?.history.entries ?? [];
        setSaid({ text: errorText(e), failed: true, at: `${now?.revision ?? 0}|${nowAll.length}|${appliedCount(nowAll)}|${nowAll.at(-1)?.id ?? ''}` });
        setWaitFor(null);
      }
    ).finally(() => (stepping.current = false));
  };
  const go = (i: number) => {
    const step = historyStep(all, i);
    act((at) => stepHistory(all[i].id, step.direction, step.count, at), step.done);
  };
  // Up and Down move between the rows (Home and End to the newest and oldest), across the day headings; Enter or
  // Space steps to one.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // A key held down from whatever opened History (Enter on its menu item) repeats onto the row focus starts on:
    // only a fresh press steps.
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) return e.preventDefault();
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.history-step')];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
    if (!rows[n] || n === at) return;
    e.preventDefault();
    rows[n].focus();
  };
  // The rows a step to the aimed row takes, the aimed row among them: down to it from where History stands (it goes
  // too), or up to it through what is undone (it comes back too).
  const aimed = aim !== null && aim < all.length && !locked ? historyStep(all, aim) : null;
  const inStep = (i: number) => !!aimed && (aimed.direction === 'undo' ? i >= aim! && i < cursor : i >= cursor && i <= aim!);
  // Where History stands, and what tells it apart from a change of the same name: when, and what is undone after it.
  // Non-breaking: a space leading a flex item would collapse against the name.
  const nowWhere = `${cursor > 0 ? `\u00a0· ${lowerDay(dayAndTime(all[cursor - 1].time))}` : ''}\u00a0· ${cursor === all.length ? 'the latest change' : `${all.length - cursor} newer ${all.length - cursor === 1 ? 'change' : 'changes'} undone`}`;
  const nowText = `Now at ${cursor === 0 ? 'before these changes' : all[cursor - 1]?.label}${nowWhere}`;
  // Newest first, under the day they were made.
  const days: Array<{ key: string; name: string; rows: typeof entries }> = [];
  for (const row of entries) {
    const key = dayKey(row.e.time);
    const last = days.at(-1);
    if (last?.key === key) last.rows.push(row);
    else days.push({ key, name: dayName(row.e.time), rows: [row] });
  }
  const footer = (
    <>
      <button className="btn" disabled={!snap?.history.canUndo || locked} title={snap?.history.undoLabel ? `Undo “${snap.history.undoLabel}”` : undefined} onClick={() => (setSaid(null), projectHistory('undo'))}>
        <Undo2 /> Undo
      </button>
      <button className="btn" disabled={!snap?.history.canRedo || locked} title={snap?.history.redoLabel ? `Redo “${snap.history.redoLabel}”` : undefined} onClick={() => (setSaid(null), projectHistory('redo'))}>
        <Redo2 /> Redo
      </button>
      {/* What a step chosen in the list did, said politely, or why it could not, said as an error: in sight however far
          the list is scrolled. */}
      <span className="history-said" title={said?.text}>
        <span className="ellipsis" role="status">
          {said && !said.failed ? said.text : ''}
        </span>
        {said?.failed && (
          <span className="history-said-failed" role="alert">
            <CircleAlert aria-hidden="true" />
            <span className="ellipsis">{said.text}</span>
          </span>
        )}
      </span>
      <button className="btn" disabled={holding} onClick={() => setState({ modal: null })}>
        Close
      </button>
    </>
  );
  return (
    <>
      {active && foot && createPortal(footer, foot)}
      <div className={`history-pinned${scrolled ? ' scrolled' : ''}`}>
        {lock && (
          <HistoryNote id={noteId} tone="info" icon={lock.icon}>
            {lock.text}
          </HistoryNote>
        )}
        {entries.length > 0 && (
          <>
            <p className="history-intro">
              {all.length === 1 ? 'Your one change so far.' : `Your last ${all.length} changes, newest first.`}
              {!lock && ' Choosing one undoes or redoes every change up to it.'}
            </p>
            {/* Where History stands, told apart from a change with the same name by when it was made and what is after it. */}
            <p className="history-now" title={nowText}>
              <span className="history-now-what">
                Now at <strong>{cursor === 0 ? 'before these changes' : all[cursor - 1].label}</strong>
              </span>
              <span className="history-now-where">{nowWhere}</span>
              <button type="button" className="link" hidden={nowSeen} onClick={showNow}>
                Show it
              </button>
            </p>
          </>
        )}
      </div>
      <div className="history-scroll" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
        {reviewing && snap && (
          <TurnReview
            entryId={reviewing}
            snap={snap}
            locked={locked}
            focusRef={start}
            onStep={go}
            onRevert={(reviewed, done) => act((at) => revertAiTurn(reviewing, reviewed, at), done)}
          />
        )}
        {entries.length === 0 ? (
          <div className="empty-insp history-empty">
            <History />
            <span>No changes yet. Your edits will appear here as you work.</span>
          </div>
        ) : (
          <div ref={listRef} className={`history-steps${locked ? ' locked' : ''}`} role="group" aria-label="Changes" onKeyDown={onKeyDown} onPointerDown={() => setFresh(false)}>
            {days.map((day, d) => (
              <section key={day.key} className="history-day" aria-labelledby={`history-day-${day.key}`}>
                <h3 className="history-day-head" id={`history-day-${day.key}`}>
                  {day.name}
                </h3>
                <ol className="history-list">
                  {day.rows.map(({ e, i }) => {
                    const step = historyStep(all, i);
                    const current = i === cursor - 1;
                    const meta = `history-meta-${e.id}`;
                    const by = changeBy(e);
                    return (
                      <li key={e.id} ref={current ? nowRef : undefined} className={`${e.applied ? '' : 'undone'}${e.id === focusId ? ' focus' : ''}${inStep(i) ? ' in-step' : ''}${aimed && i === aim ? ' aim' : ''}`}>
                        <button
                          ref={e.id === tabId && !reviewing ? start : undefined}
                          className="history-step"
                          tabIndex={e.id === tabId ? 0 : -1}
                          data-autofocus={e.id === tabId && fresh && !reviewing ? true : undefined}
                          aria-label={step.name}
                          aria-describedby={lock ? `${meta} ${noteId}` : meta}
                          aria-current={current ? 'step' : undefined}
                          aria-disabled={locked || undefined}
                          onFocus={() => (setStop(e.id), setAim(i))}
                          onBlur={() => setAim((a) => (a === i ? null : a))}
                          onMouseEnter={() => setAim(i)}
                          onMouseLeave={() => setAim((a) => (a === i ? null : a))}
                          onClick={() => go(i)}
                        >
                          <ChangeGlyph e={e} />
                          <span className="history-step-text">
                            <span className="grow ellipsis" title={e.label}>
                              {e.label}
                            </span>
                            <span className="history-step-meta" aria-hidden="true">
                              {current && <span className="badge accent">Current</span>}
                              {!e.applied && <span className="badge">Undone</span>}
                              <span className="ellipsis">
                                {by} ·{' '}
                                <time dateTime={e.time} title={fullWhen(e.time)}>
                                  {clock(e.time)}
                                </time>
                              </span>
                            </span>
                          </span>
                          <span className="step-action" aria-hidden="true">
                            {step.text}
                          </span>
                          <span id={meta} className="sr-only">
                            {`${e.source === 'ai' ? 'By AI' : e.source === 'system' ? 'From outside the app' : e.guestName ? `By ${e.guestName}, a guest` : 'By you'}, ${fullWhen(e.time)}${e.applied ? '' : ', undone'}`}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {cursor === 0 && d === days.length - 1 && (
                    <li ref={nowRef} className="history-start" aria-current="step">
                      <span className="grow">Before these changes</span>
                      <span className="badge accent">Current</span>
                    </li>
                  )}
                </ol>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
