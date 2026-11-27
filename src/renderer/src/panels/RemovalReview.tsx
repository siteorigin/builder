/**
 * Removing a slot that placements fill, or a component still in use (#663). The review lists each placement in the way,
 * where it is, with Go to placement beside it: that shows the placement where it is, selected. A slot can then go
 * together with what placements hold in it, in one change that one Undo puts back; a component goes once nothing uses
 * it. What the review lists, and what it removes, is the project as it is now: an Undo or the AI changing it meanwhile
 * changes the list before anything is removed.
 */
import { useMemo, useRef, useState } from 'react';
import { Code, Component, FileText, LayoutTemplate, PanelBottom, PanelTop, ShieldCheck, Trash2 } from 'lucide-react';
import type { OwnerRef } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { commitOps, getState, setState, showLayer, toast, undoAction, useStore } from '../store';
import { Modal } from '../components/ui';
import { BlockedNote, BlockedStatus, projectBlock, type Blocked } from '../components/BlockedNote';
import { treeFor } from '../lib/model';
import { openEditorDestination } from '../lib/open-destination';
import { componentRemovalReview, planSlotRemoval, type PlacementRow } from '../lib/removal-review';
import { Badge, Details, FormStatus, GONE_ID, GoneClose, GoneNotice, SafeButton, ScrollList, Subject, type Detail } from './Dialogs';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Names as a sentence lists them: "Ticker, Clock and Map". */
const listAll = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

function placeIcon(owner: OwnerRef) {
  if (owner.kind === 'shell') return owner.id === 'footer' ? <PanelBottom /> : <PanelTop />;
  if (owner.kind === 'template') return <LayoutTemplate />;
  return owner.kind === 'component' ? <Component /> : <FileText />;
}

/** A row's place and position, as Go to placement's name says it. */
const rowName = (r: PlacementRow) => `${r.place}${r.where ? `, ${r.where}` : ''}`;

export function RemovalReviewModal({ opening, definitionId, slot }: { opening: string; definitionId: string; slot?: string }) {
  const snap = useStore((s) => s.snapshot);
  const [own] = useState(() => getState().modal);
  const same = !!snap && snap.workspaceKey === opening;
  const st = same ? snap.state : undefined;
  const def = st && Object.hasOwn(st.components, definitionId) ? st.components[definitionId] : undefined;
  const decl = def && slot !== undefined && def.slots && Object.hasOwn(def.slots, slot) ? def.slots[slot] : undefined;
  // Named as they were when the review opened, for the notice once they have gone.
  const [opened] = useState(() => ({ name: def?.name ?? 'This component', label: typeof decl?.label === 'string' && decl.label.trim() ? decl.label : (slot ?? '') }));
  const name = def?.name ?? opened.name;
  const label = typeof decl?.label === 'string' && decl.label.trim() ? decl.label : opened.label;
  const plan = useMemo(() => (st && slot !== undefined ? planSlotRemoval(st, definitionId, slot) : null), [st, definitionId, slot]);
  const review = useMemo(() => (st && slot === undefined && def ? componentRemovalReview(st, definitionId) : null), [st, def, definitionId, slot]);
  const [busy, setBusy] = useState(false);
  // While the removal saves, the review stays as it was confirmed: the project it lands in has nothing left to list.
  const confirmed = useRef<{ rows: PlacementRow[]; items: number } | null>(null);
  const close = () => {
    if (getState().modal === own) setState({ modal: null });
  };
  const gone = !busy && (!same || !def || (slot !== undefined && !decl));
  const rows = busy && confirmed.current ? confirmed.current.rows : (plan?.rows ?? review?.rows ?? []);
  const items = busy && confirmed.current ? confirmed.current.items : (plan?.items ?? 0);
  const dependents = review?.dependents ?? [];
  // What the button removes now: the slot with its content, the slot alone once nothing fills it, or the component
  // once nothing uses it. Nothing while something is in the way that this review can't remove.
  const operations: EditOperation[] | undefined = slot !== undefined ? plan?.operations : review && !review.rows.length && !dependents.length ? [{ type: 'component.remove', definitionId }] : undefined;
  // Read-only, or the AI at work while there is something to remove, only holds the review: said in the info face.
  const runStatus = useStore((s) => s.runStatus);
  const hold: Blocked | null = gone || busy ? null : projectBlock({ readOnly: snap?.readOnly, aiBusy: !!snap?.aiBusy && !!operations }, slot !== undefined ? 'remove this slot' : 'delete this component', runStatus);
  const problem = gone || busy || hold ? undefined : plan?.problem;
  // Whether the review can remove anything now, which decides what it says it does.
  const can = !!operations && !problem && !hold && !busy;
  // The revision the remove button was pressed on: a press the project changed under (a held Space, a slow click)
  // acts on content the author was not shown, so it is let go and a fresh press is needed.
  const pressed = useRef<number | null>(null);
  const arm = () => {
    pressed.current = snap?.revision ?? null;
  };

  /** Show one placement where it is, as the project is now: an Undo or the AI may have moved or changed it since. */
  const go = (r: PlacementRow) => {
    const now = getState().snapshot;
    if (!now || now.workspaceKey !== opening || busy) return;
    const tree = treeFor(now.state, r.owner);
    const node = tree && Object.hasOwn(tree.nodes, r.nodeId) ? tree.nodes[r.nodeId] : undefined;
    if (node?.kind !== 'instance' || node.definitionId !== definitionId) return void toast('That placement has been removed since the list was shown.', 'info');
    // Already selected, choosing it again would not move the canvas: it is asked to show it.
    const was = getState().selection;
    const again = !!was && was.owner.kind === r.owner.kind && was.owner.id === r.owner.id && was.nodeId === r.nodeId && !was.instancePath.length;
    openEditorDestination({ kind: 'element', owner: r.owner, nodeId: r.nodeId });
    if (again && getState().modal !== own) showLayer({ owner: r.owner, instancePath: [], nodeId: r.nodeId });
  };

  const remove = async () => {
    const now = getState().snapshot;
    const shown = pressed.current;
    pressed.current = null;
    if (shown !== null && shown !== snap?.revision) return;
    if (!operations || busy || problem || hold || !snap || !now || now.workspaceKey !== opening) return;
    const what = slot === undefined ? `Delete component ${name}` : rows.length ? `Remove ${label} slot and its content` : `Remove ${label} slot`;
    confirmed.current = { rows, items };
    setBusy(true);
    let r: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      // Checked against the project this review shows, so what goes is what it listed.
      r = await commitOps(operations, what, undefined, snap.revision);
    } finally {
      if (!r?.ok) setBusy(false);
    }
    if (!r?.ok) return;
    close();
    if (getState().snapshot?.workspaceKey !== r.workspaceKey) return;
    toast(slot === undefined ? `Deleted ${name}` : rows.length ? `Removed the ${label} slot and its content` : `Removed the ${label} slot`, 'info', undoAction(r));
  };

  const title = slot === undefined ? `Delete ${name}?` : `Remove the ${label} slot?`;
  const code = listAll(dependents.map((d) => d.name));
  const lead =
    slot !== undefined
      ? rows.length
        ? `It holds content on ${plural(rows.length, 'placement')}. ${can ? 'Go to a placement to move what you want to keep, or remove the slot with its content.' : 'Go to a placement to see what it holds there.'}`
        : can
          ? 'No placement holds content in it now, so it can go with its place in the design.'
          : 'No placement holds content in it now.'
      : rows.length
        ? `It is still in use. Delete or replace ${rows.length === 1 ? 'its placement' : 'each placement'} first: Go to placement shows it, selected.${dependents.length ? ` The code of ${code} needs it too.` : ''}`
        : dependents.length
          ? `The code of ${code} needs it. Change that code so it no longer does first.`
          : can
            ? 'Nothing uses it now, so it can be deleted.'
            : 'Nothing uses it now.';
  // What removing does, said only while it can be done.
  const details: Detail[] = !can
    ? []
    : slot === undefined
      ? [{ kind: 'keep', icon: <ShieldCheck />, text: 'Undo brings it back.' }]
      : [
          ...(rows.length ? [{ kind: 'lose' as const, icon: <Trash2 />, text: `What ${rows.length === 1 ? 'the placement holds' : `the ${rows.length} placements hold`} in it goes too: ${plural(items, 'item')}, with everything inside ${items === 1 ? 'it' : 'them'}.` }] : []),
          { kind: 'change', icon: <Component />, text: `Its place in the ${name} design goes with it.` },
          { kind: 'keep', icon: <ShieldCheck />, text: rows.length ? 'Undo puts the slot and its content back.' : 'Undo puts the slot back.' }
        ];
  const action = slot === undefined ? 'Delete component' : rows.length ? 'Remove slot and its content' : 'Remove slot';
  return (
    <Modal
      title={title}
      icon={<Badge icon={<Trash2 />} tone={gone || problem ? 'caution' : 'neutral'} />}
      onClose={close}
      busy={busy}
      describedBy={gone ? GONE_ID : `removal-review-desc removal-review-subject${details.length ? ' removal-review-details' : ''}${problem || hold ? ` ${GONE_ID}` : ''}`}
      footer={
        gone ? (
          <GoneClose onClose={close} />
        ) : (
          <>
            <SafeButton onClick={close} disabled={busy}>
              {operations ? 'Cancel' : 'Close'}
            </SafeButton>
            {operations && (
              <button className="btn btn-danger" disabled={busy || !!problem || !!hold} onPointerDown={arm} onKeyDown={(e) => {
                  if (e.key !== ' ' && e.key !== 'Enter') return;
                  // A held key repeats: only its first press counts, and only for what was shown then.
                  if (e.repeat) return e.preventDefault();
                  arm();
                }} onClick={() => void remove()}>
                {busy ? 'Removing…' : action}
              </button>
            )}
          </>
        )
      }
    >
      {gone ? (
        <GoneNotice>
          {!same ? (
            'The project was closed or opened again, so nothing was removed.'
          ) : !def ? (
            <>
              <strong>{opened.name}</strong> has been deleted, so there is nothing left to remove.
            </>
          ) : (
            <>
              The “{opened.label}” slot has been removed, so there is nothing left to remove. Undo brings it back.
            </>
          )}
        </GoneNotice>
      ) : (
        <div className="authoring-form">
          <FormStatus text={busy ? 'Removing' : undefined} />
          <p id="removal-review-desc" className="confirm-lead">
            {lead}
          </p>
          <Subject id="removal-review-subject" icon={<Component />} name={slot === undefined ? name : label} note={slot === undefined ? (rows.length ? `Placed ${rows.length === 1 ? 'once' : `${rows.length} times`}` : dependents.length ? 'Not placed anywhere' : 'Not used anywhere') : `Slot of ${name}`} />
          {(rows.length > 0 || dependents.length > 0) && (
            <div className="placement-block">
              <div className="field-label" id="removal-review-places">
                {slot === undefined ? 'Used by' : 'Holds content on'}
              </div>
              <ScrollList className="placement-list removal-list" labelledBy="removal-review-places">
                {rows.map((r) => (
                  <li key={`${r.owner.kind}:${r.owner.id}:${r.nodeId}`} data-node={r.nodeId}>
                    <span className="placement-icon" aria-hidden="true">
                      {placeIcon(r.owner)}
                    </span>
                    <span className="grow">
                      {r.place}
                      {r.where && <span className="placement-reach"> · {r.where}</span>}
                    </span>
                    <button className="btn btn-sm" disabled={busy} aria-label={`Go to placement: ${rowName(r)}`} onClick={() => go(r)}>
                      Go to placement
                    </button>
                  </li>
                ))}
                {dependents.map((d) => (
                  <li key={`code:${d.id}`}>
                    <span className="placement-icon" aria-hidden="true">
                      <Code />
                    </span>
                    <span className="grow">
                      {d.name}
                      <span className="placement-reach"> · its code needs {name}</span>
                    </span>
                  </li>
                ))}
              </ScrollList>
            </div>
          )}
          {details.length > 0 && <Details id="removal-review-details" items={details} />}
          <BlockedStatus block={hold} lifted={slot !== undefined ? 'You can remove this slot now.' : 'You can delete this component now.'} />
          {hold && <BlockedNote block={hold} id={GONE_ID} live={false} />}
          {problem && <GoneNotice>{problem}</GoneNotice>}
        </div>
      )}
    </Modal>
  );
}
