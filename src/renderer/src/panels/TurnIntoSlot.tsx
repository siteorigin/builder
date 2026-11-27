import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, CircleMinus, Info, ShieldCheck, SquareDashed } from 'lucide-react';
import type { ElementRef, ProjectState } from '@shared/types';
import { displayName } from '@engine/tree';
import { commitOps, getState, setState, useStore } from '../store';
import { Field, Modal } from '../components/ui';
import { BlockedNote, BlockedStatus, projectBlock, readOnlyBlock, type Blocked } from '../components/BlockedNote';
import { isImeComposing } from '../lib/ime';
import { SLOT_LABEL_MAX } from '../lib/slot-contract';
import { defaultSlotLabel, turnIntoSlotOp, turnIntoSlotPreflight, turnIntoSlotScope, turnIntoSlotTarget, type SlotKeep } from '../lib/turn-into-slot';
import { Badge, Count, Details, FormStatus, GONE_ID, GoneClose, GoneNotice, Subject, limitSaid, useSelectedOnOpen } from './Dialogs';

const placementsWord = (n: number) => (n === 1 ? '1 placement' : `${n} placements`);
/** How far the component reaches, as the subject's note says it. */
const placedWord = (n: number) => (n ? placementsWord(n) : 'Not placed anywhere');
const itemsWord = (n: number) => (n === 1 ? '1 item' : `${n} items`);

/**
 * Turn into slot… (#659): one container of a component's design becomes the place where each placement puts content of
 * its own. The dialog names the slot and, while the container holds something and the component is placed, asks
 * whether that moves into every placement or goes. Moving is the choice while it can be done; when it can't, the
 * dialog says why and the author picks the empty slot themselves, since that removes what the container holds. The
 * whole change is one, so one Undo puts the container's content back.
 */
export function TurnIntoSlotModal({ target, workspaceKey }: { target: ElementRef; workspaceKey?: string }) {
  const snap = useStore((s) => s.snapshot);
  // The project opening this dialog was opened in: another one (or this project opened again) is not where it acts.
  const [workspace] = useState(() => workspaceKey ?? snap?.workspaceKey);
  const [own] = useState(() => getState().modal);
  const sameOpening = !!snap && snap.workspaceKey === workspace;
  const st = sameOpening ? snap.state : undefined;
  const def = st && target.owner.kind === 'component' ? st.components[target.owner.id] : undefined;
  const node = def?.tree?.nodes[target.nodeId];
  const [busy, setBusy] = useState(false);
  // Why the last attempt was refused before it was sent, when the project changed since the dialog said it could.
  const [refused, setRefused] = useState<{ state: ProjectState; why: string } | null>(null);
  const [name] = useState(() => (st && def && node ? displayName(st, node, def) : 'This container'));
  const [label, setLabel] = useState(() => (def ? defaultSlotLabel(def, target.nodeId) : 'Content'));
  const [choice, setChoice] = useState<SlotKeep | null>(null);
  // Said when a confirmation met a project that had changed since the dialog showed it, so nothing was sent.
  const [notice, setNotice] = useState<string | null>(null);
  const scope = useMemo(() => (st && def ? turnIntoSlotScope(st, def, target.nodeId) : { children: 0, placements: 0, code: [] }), [st, def, target.nodeId]);
  // Only content shown somewhere is a choice; otherwise the slot starts empty. Once the dialog has offered to move it,
  // it keeps asking: a change under it (an Undo, the AI) that leaves nowhere to move it never turns that into removing
  // it unasked.
  const choosable = scope.children > 0 && scope.placements + scope.code.length > 0;
  const offeredMove = useRef(false);
  if (choosable) offeredMove.current = true;
  const asking = scope.children > 0 && (choosable || offeredMove.current);
  // Each way is tried on a copy of the project once for each version of it: the slot's name never decides whether it lands.
  const tried = useMemo(() => {
    if (!st || !def) return null;
    const attempt = (keep: SlotKeep) => {
      const op = turnIntoSlotOp(st, def, target.nodeId, defaultSlotLabel(def, target.nodeId), keep);
      return op ? turnIntoSlotPreflight(st, op) : null;
    };
    return { placements: choosable ? attempt('placements') : null, none: attempt('none') };
  }, [st, def, target.nodeId, choosable]);
  const moveRefused = !asking ? null : !choosable ? `${def ? `“${def.name}”` : 'The component'} isn’t placed anywhere now, so there is nowhere to move what it holds.` : (tried?.placements ?? null);
  // A way chosen that can't be taken now is let go rather than kept: the author picks again, told which way is open, and
  // it stays let go if the way opens again, so a removal is never confirmed without a fresh choice.
  const invalidated = (choice === 'placements' && !!moveRefused) || (choice === 'none' && !!tried?.none);
  useEffect(() => {
    if (invalidated && !busy) setChoice(null);
  }, [invalidated, busy]);
  const keep: SlotKeep | null = !asking ? 'none' : invalidated ? null : (choice ?? (moveRefused ? null : 'placements'));
  // While the change is saving, the dialog stays as it was confirmed: the project it lands in has the slot already.
  const confirmed = useRef({ scope, asking, moveRefused, keep, component: def?.name });
  if (!busy) confirmed.current = { scope, asking, moveRefused, keep, component: def?.name };
  const shown = confirmed.current;
  // Read as an editable project would be, so a read-only one says so rather than calling the container gone.
  const offered = st && node ? turnIntoSlotTarget({ state: st }, target) : null;
  const gone = !busy && !offered;
  // Read-only is a state, not a fault: said as the session's reason, in the info face, in place of the form.
  const hold = busy || gone ? null : readOnlyBlock(snap);
  const problem = busy || gone || hold ? null : (offered?.problem ?? null);
  // The AI at work only holds the change: the form stays as it is, with why under it.
  const runStatus = useStore((s) => s.runStatus);
  const wait: Blocked | null = busy || gone || hold ? null : projectBlock({ aiBusy: snap?.aiBusy }, 'turn it into a slot', runStatus);
  const why = busy ? null : refused && refused.state === st ? refused.why : keep === 'none' ? (tried?.none ?? null) : null;
  const input = useSelectedOnOpen();
  const close = () => {
    if (getState().modal === own) setState({ modal: null });
  };
  const labelError = label.trim() ? undefined : 'Enter a name for the slot.';
  // The way chosen removes what the container holds: the confirmation then says so, in the loss face.
  const removes = shown.keep === 'none' && shown.scope.children > 0;
  // Moving was the way and can't be now: nothing is chosen until the author picks the empty slot, and this says so.
  // The empty slot is checked the same way, so the dialog never points the author at a way that would be refused too.
  const emptyRefused = shown.asking && !busy ? (tried?.none ?? null) : null;
  const nextStep = !shown.asking || shown.keep ? null : shown.moveRefused && !emptyRefused ? 'Choose Leave the slot empty to continue.' : emptyRefused && !shown.moveRefused ? 'Choose Move it into each placement to continue.' : shown.moveRefused && emptyRefused ? 'Neither way can be taken now: cancel, and change the design first.' : null;
  // The note that says the next step: on the way that can't be taken.
  const nextNote = nextStep ? (shown.moveRefused ? 'turn-into-slot-placements-note' : 'turn-into-slot-none-note') : undefined;
  const turn = async () => {
    if (!keep || busy || labelError || problem || hold || wait || gone || why) return;
    setNotice(null);
    // Checked and planned against the project as it is now, and made only if nothing changes it first.
    const now = getState().snapshot;
    if (!now || now.workspaceKey !== workspace || now.readOnly) return;
    // Only the change the dialog showed: a project that changed since is shown again, for the author to confirm.
    if (now.revision !== snap?.revision) return setNotice('The project changed while this was open. Check what this will do, then choose Turn into slot again.');
    const at = turnIntoSlotTarget(now, target);
    if (!at || at.problem) return setRefused({ state: now.state, why: at?.problem ?? `${name} was removed, so nothing changed.` });
    const op = turnIntoSlotOp(now.state, now.state.components[target.owner.id], target.nodeId, label, keep);
    if (!op) return;
    const refusal = turnIntoSlotPreflight(now.state, op);
    if (refusal) return setRefused({ state: now.state, why: refusal });
    setBusy(true);
    let r: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      r = await commitOps([op], `Turn ${name} into a slot`, undefined, now.revision);
    } finally {
      if (!r?.ok) setBusy(false);
    }
    // Only while this dialog is still the one open, in the same opening: another view has taken over otherwise.
    if (r?.ok && getState().modal === own && getState().snapshot?.workspaceKey === workspace) setState({ modal: null, selection: target });
  };
  const choose = (value: SlotKeep) => {
    setChoice(value);
    setRefused(null);
    setNotice(null);
  };
  const option = (value: SlotKeep, text: string, note: string, off?: string | null) => (
    // The whole card picks its way, not only its first line. An unavailable way is drawn off, not as a fault: its
    // reason is information, and the way that removes content is the one marked as a loss.
    <div
      className="page-dialog-option"
      data-unavailable={off ? true : undefined}
      onClick={(e) => {
        if (off || busy) return;
        // Focus follows to the radio, so arrow keys carry on from the way just picked.
        e.currentTarget.querySelector('input')?.focus();
        if (shown.keep !== value) choose(value);
      }}
    >
      <label>
        <input
          type="radio"
          name="turn-into-slot-keep"
          value={value}
          checked={shown.keep === value}
          disabled={busy || !!off}
          aria-describedby={`turn-into-slot-${value}-note`}
          onChange={() => choose(value)}
        />
        <span>{text}</span>
      </label>
      <p id={`turn-into-slot-${value}-note`} className="page-dialog-option-note" data-kind={!off && value === 'none' ? 'lose' : undefined}>
        {off ? <Info /> : value === 'placements' ? <ShieldCheck /> : <CircleMinus />}
        <span>{off ? `${off}${nextStep && nextNote === `turn-into-slot-${value}-note` ? ` ${nextStep}` : ''}` : note}</span>
      </p>
    </div>
  );
  return (
    <Modal
      title="Turn into slot"
      icon={<Badge icon={<SquareDashed />} tone={gone ? 'caution' : problem ? 'neutral' : 'definition'} />}
      onClose={close}
      busy={busy}
      describedBy={gone || problem || hold ? GONE_ID : `turn-into-slot-desc turn-into-slot-subject turn-into-slot-details${wait ? ' turn-into-slot-wait' : ''}`}
      footer={
        gone || problem || hold ? (
          <GoneClose onClose={close} />
        ) : (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className={`btn ${removes ? 'btn-danger' : 'btn-primary'}`} disabled={!keep || !!labelError || !!why || !!wait || busy} aria-describedby={wait ? 'turn-into-slot-wait' : nextNote} onClick={() => void turn()}>
              {busy ? 'Turning into a slot…' : removes ? 'Turn into slot and remove content' : 'Turn into slot'}
            </button>
          </>
        )
      }
    >
      <BlockedStatus block={hold ?? wait} lifted="You can turn it into a slot now." />
      {gone ? (
        <GoneNotice>{sameOpening ? <>{name} was removed, so nothing changed.</> : 'The project was closed or opened again, so nothing changed.'}</GoneNotice>
      ) : hold ? (
        <BlockedNote block={hold} id={GONE_ID} live={false} />
      ) : problem ? (
        <GoneNotice refused>{problem}</GoneNotice>
      ) : (
        <div className="authoring-form" data-testid="turn-into-slot-dialog">
          <FormStatus text={busy ? 'Turning into a slot' : (labelError ?? notice ?? (nextStep ? `${shown.moveRefused ?? emptyRefused} ${nextStep}` : limitSaid(label.length, SLOT_LABEL_MAX, 'Names')))} />
          <p id="turn-into-slot-desc" className="confirm-lead">
            This container becomes a slot: the place where each placement of the component puts content of its own.
          </p>
          <Subject
            id="turn-into-slot-subject"
            icon={<Box />}
            name={st && def && node ? displayName(st, node, def) : name}
            note={shown.component ? `${shown.component} · ${placedWord(shown.scope.placements)}${shown.scope.code.length ? ` · in the code of ${shown.scope.code.join(', ')}` : ''}` : undefined}
            tone="definition"
          />
          <Details
            id="turn-into-slot-details"
            items={[
              { kind: 'keep', icon: <ShieldCheck />, text: 'It keeps its place, its layout and its styles.' },
              ...(shown.scope.children && !shown.asking
                ? [{ kind: 'lose' as const, icon: <CircleMinus />, text: `${shown.scope.children === 1 ? 'Its 1 item is' : `Its ${itemsWord(shown.scope.children)} are`} removed: ${shown.component ? `“${shown.component}”` : 'the component'} isn’t placed anywhere yet, so there is nowhere to move ${shown.scope.children === 1 ? 'it' : 'them'}.` }]
                : []),
              ...(!shown.scope.children ? [{ kind: 'change' as const, icon: <SquareDashed />, text: 'It holds nothing yet, so every placement starts with the slot empty.' }] : []),
              { kind: 'keep', icon: <ShieldCheck />, text: shown.scope.children ? 'Undo turns it back into a container, with what it holds.' : 'Undo turns it back into a container.' }
            ]}
          />
          <Field label="Slot name" hint={label.length >= SLOT_LABEL_MAX ? `Names can be up to ${SLOT_LABEL_MAX} characters.` : 'What Insert and each placement call the slot.'} error={labelError} extra={<Count length={label.length} max={SLOT_LABEL_MAX} />}>
            <input
              ref={input}
              className="input"
              autoFocus
              readOnly={busy}
              aria-required="true"
              maxLength={SLOT_LABEL_MAX}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setNotice(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void turn()}
            />
          </Field>
          {shown.asking && (
            <fieldset className="slot-keep">
              <legend>What it holds now</legend>
              {option('placements', 'Move it into each placement', `${shown.scope.placements === 1 ? 'The one placement keeps' : `Each of the ${placementsWord(shown.scope.placements)} keeps`} its own copy of ${shown.scope.children === 1 ? 'this item' : `these ${itemsWord(shown.scope.children)}`}. New placements start with the slot empty.`, shown.moveRefused)}
              {option('none', 'Leave the slot empty', `${shown.scope.children === 1 ? 'Its 1 item is' : `Its ${itemsWord(shown.scope.children)} are`} removed from the design, and every placement starts with the slot empty.`, emptyRefused)}
            </fieldset>
          )}
          {/* Said on its card when it is the empty slot's own refusal. */}
          {why && why !== emptyRefused && (
            <p className="field-error" role="alert">
              {why}
            </p>
          )}
          {notice && !why && (
            <p className="field-hint">
              {notice}
            </p>
          )}
          {wait && <BlockedNote block={wait} id="turn-into-slot-wait" live={false} />}
        </div>
      )}
    </Modal>
  );
}
