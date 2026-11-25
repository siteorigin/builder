import { useMemo, useRef, useState } from 'react';
import { Box, CircleMinus, ShieldCheck, SquareDashed, TriangleAlert } from 'lucide-react';
import type { ElementRef, ProjectState } from '@shared/types';
import { displayName } from '@engine/tree';
import { commitOps, getState, setState, useStore } from '../store';
import { Field, Modal } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { SLOT_LABEL_MAX } from '../lib/slot-contract';
import { defaultSlotLabel, turnIntoSlotOp, turnIntoSlotPreflight, turnIntoSlotScope, turnIntoSlotTarget, type SlotKeep } from '../lib/turn-into-slot';
import { Badge, Count, Details, FormStatus, GONE_ID, GoneClose, GoneNotice, Subject, limitSaid, useSelectedOnOpen } from './Dialogs';

const placementsWord = (n: number) => (n === 1 ? '1 placement' : `${n} placements`);

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
  const moveRefused = !asking ? null : !choosable ? `${def ? `“${def.name}”` : 'The component'} isn’t used anywhere now, so there is nowhere to move what it holds.` : (tried?.placements ?? null);
  const keep: SlotKeep | null = !asking ? 'none' : choice === 'placements' && moveRefused ? null : (choice ?? (moveRefused ? null : 'placements'));
  // While the change is saving, the dialog stays as it was confirmed: the project it lands in has the slot already.
  const confirmed = useRef({ scope, asking, moveRefused, keep, component: def?.name });
  if (!busy) confirmed.current = { scope, asking, moveRefused, keep, component: def?.name };
  const shown = confirmed.current;
  // Read as an editable project would be, so a read-only one says so rather than calling the container gone.
  const offered = st && node ? turnIntoSlotTarget({ state: st }, target) : null;
  const gone = !busy && !offered;
  const problem = busy || gone ? null : snap?.readOnly ? 'This project is open read-only, so nothing can change.' : (offered?.problem ?? null);
  const why = busy ? null : refused && refused.state === st ? refused.why : keep === 'none' ? (tried?.none ?? null) : null;
  const input = useSelectedOnOpen();
  const close = () => {
    if (getState().modal === own) setState({ modal: null });
  };
  const labelError = label.trim() ? undefined : 'Enter a name for the slot.';
  const turn = async () => {
    if (!keep || busy || labelError || problem || gone || why) return;
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
  const option = (value: SlotKeep, text: string, note: string, off?: string | null) => (
    <div className="page-dialog-option" data-off={off ? true : undefined}>
      <label>
        <input
          type="radio"
          name="turn-into-slot-keep"
          value={value}
          checked={shown.keep === value}
          disabled={busy || !!off}
          aria-describedby={`turn-into-slot-${value}-note`}
          onChange={() => {
            setChoice(value);
            setRefused(null);
            setNotice(null);
          }}
        />
        <span>{text}</span>
      </label>
      <p id={`turn-into-slot-${value}-note`} className="page-dialog-option-note">
        {off ? <TriangleAlert /> : value === 'placements' ? <ShieldCheck /> : <CircleMinus />}
        <span>{off ?? note}</span>
      </p>
    </div>
  );
  return (
    <Modal
      title="Turn into slot"
      icon={<Badge icon={<SquareDashed />} tone={gone || problem ? 'caution' : 'definition'} />}
      onClose={close}
      busy={busy}
      describedBy={gone || problem ? GONE_ID : 'turn-into-slot-desc turn-into-slot-subject turn-into-slot-details'}
      footer={
        gone || problem ? (
          <GoneClose onClose={close} />
        ) : (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!keep || !!labelError || !!why || busy} onClick={() => void turn()}>
              {busy ? 'Turning into a slot…' : 'Turn into slot'}
            </button>
          </>
        )
      }
    >
      {gone ? (
        <GoneNotice>{sameOpening ? <>{name} was removed, so nothing changed.</> : 'The project was closed or opened again, so nothing changed.'}</GoneNotice>
      ) : problem ? (
        <GoneNotice>{problem}</GoneNotice>
      ) : (
        <div className="authoring-form" data-testid="turn-into-slot-dialog">
          <FormStatus text={busy ? 'Turning into a slot' : (labelError ?? limitSaid(label.length, SLOT_LABEL_MAX, 'Names'))} />
          <p id="turn-into-slot-desc" className="confirm-lead">
            This container becomes a slot: the place where each placement of the component puts content of its own.
          </p>
          <Subject
            id="turn-into-slot-subject"
            icon={<Box />}
            name={name}
            note={shown.component ? `${shown.component} · ${placementsWord(shown.scope.placements)}${shown.scope.code.length ? ` · in the code of ${shown.scope.code.join(', ')}` : ''}` : undefined}
            tone="definition"
          />
          <Details
            id="turn-into-slot-details"
            items={[
              { kind: 'keep', icon: <ShieldCheck />, text: 'It keeps its place, its layout and its styles.' },
              ...(shown.scope.children && !shown.asking
                ? [{ kind: 'lose' as const, icon: <CircleMinus />, text: `What it holds is removed: ${shown.component ? `“${shown.component}”` : 'the component'} isn’t placed anywhere yet, so there is nowhere to move it.` }]
                : []),
              ...(!shown.scope.children ? [{ kind: 'change' as const, icon: <SquareDashed />, text: 'It holds nothing yet, so every placement starts with the slot empty.' }] : [])
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
              {option('placements', 'Move it into each placement', `Each of the ${placementsWord(shown.scope.placements)} keeps what it shows here now, as its own content in the slot.`, shown.moveRefused)}
              {option('none', 'Leave the slot empty', 'What it holds is removed from the design, and every placement starts with the slot empty.')}
            </fieldset>
          )}
          {why && (
            <p className="field-error" role="alert">
              {why}
            </p>
          )}
          {notice && !why && (
            <p className="field-hint" role="status">
              {notice}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
