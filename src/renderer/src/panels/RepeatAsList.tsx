import { useState } from 'react';
import { Box, ListPlus, Repeat, ShieldCheck } from 'lucide-react';
import type { ElementRef } from '@shared/types';
import { displayName, instancesOf } from '@engine/tree';
import { commitOps, getState, setState, useStore } from '../store';
import { Field, Modal } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { planRepeatAsList, repeatAsListTarget, STARTER_ITEMS } from '../lib/repeat-as-list';
import { Badge, Count, Details, FormStatus, GONE_ID, GoneClose, GoneNotice, Subject, limitSaid, useCloseOwn, useSelectedOnOpen } from './Dialogs';

/** The longest name a list property can have. */
const LABEL_MAX = 80;

const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

/**
 * Repeat as list… (#369): one container of a component's design becomes the first item of a new list each placement
 * fills in. The dialog names the list and says what each item will hold, then makes the whole change at once, so one
 * Undo puts the single container back.
 */
export function RepeatAsListModal({ target }: { target: ElementRef }) {
  const snap = useStore((s) => s.snapshot);
  const st = snap?.state;
  const def = st && target.owner.kind === 'component' ? st.components[target.owner.id] : undefined;
  const node = def?.tree?.nodes[target.nodeId];
  const [busy, setBusy] = useState(false);
  // Planned again as the project changes, so what the dialog says is what Repeat as list does; the IDs are made new
  // when it is chosen.
  const [opened] = useState(() => (st && def && node ? { name: displayName(st, node, def), plan: planRepeatAsList(st, def, target.nodeId) } : null));
  const [label, setLabel] = useState(() => (opened && !('problem' in opened.plan) ? opened.plan.label : 'Items'));
  const plan = st && def ? planRepeatAsList(st, def, target.nodeId, { label }) : null;
  const ready = !!plan && !('problem' in plan) ? plan : null;
  // The container is still there after the change, inside its new repeat: only one that went counts as gone.
  const gone = !busy && !!st && !node;
  const problem = !busy && !gone && plan && 'problem' in plan ? plan.problem : null;
  const input = useSelectedOnOpen();
  const close = useCloseOwn();
  const labelError = label.trim() ? undefined : 'Enter a name for the list.';
  const placements = st && def ? instancesOf(st, def.id).length : 0;
  const repeat = async () => {
    if (!ready || busy || labelError) return;
    // Checked and planned against the project as it is now, and made only if nothing changes it first.
    const now = getState().snapshot;
    const at = repeatAsListTarget(now, target);
    const fresh = now && at ? planRepeatAsList(now.state, now.state.components[target.owner.id], target.nodeId, { label }) : null;
    if (!now || !fresh || 'problem' in fresh) return;
    setBusy(true);
    let r: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      r = await commitOps(fresh.operations, `Repeat ${opened?.name ?? 'container'} as a list`, undefined, now.revision);
    } finally {
      if (!r?.ok) setBusy(false);
    }
    if (r?.ok) {
      close();
      setState({ selection: target });
    }
  };
  const name = opened?.name ?? 'This container';
  return (
    <Modal
      title="Repeat as list"
      icon={<Badge icon={<Repeat />} tone={gone || problem ? 'caution' : 'definition'} />}
      onClose={close}
      busy={busy}
      describedBy={gone || problem ? GONE_ID : 'repeat-list-desc repeat-list-subject repeat-list-details'}
      footer={
        gone || problem ? (
          <GoneClose onClose={close} />
        ) : (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!ready || !!labelError || busy} onClick={() => void repeat()}>
              {busy ? 'Repeating…' : 'Repeat as list'}
            </button>
          </>
        )
      }
    >
      {gone ? (
        <GoneNotice>
          <strong>{name}</strong> was removed, so nothing was repeated.
        </GoneNotice>
      ) : problem ? (
        <GoneNotice>{snap?.readOnly ? 'This project is open read-only, so nothing was repeated.' : problem}</GoneNotice>
      ) : (
        <div className="authoring-form">
          <FormStatus text={busy ? 'Repeating as a list' : (labelError ?? limitSaid(label.length, LABEL_MAX, 'Names'))} />
          <p id="repeat-list-desc" className="confirm-lead">
            This container becomes the first item of a list. Each placement can then add, remove and edit its own items.
          </p>
          <Subject id="repeat-list-subject" icon={<Box />} name={name} note={def ? `${def.name} · ${placements === 1 ? '1 placement' : `${placements} placements`}` : undefined} tone="definition" />
          {ready && (
            <Details
              id="repeat-list-details"
              items={[
                { kind: 'change', icon: <ListPlus />, text: `Each item has its own ${listed(ready.fields.map((f) => f.label.toLowerCase()))}.` },
                { kind: 'change', icon: <Repeat />, text: `${placements > 0 ? 'Every placement starts' : 'The list starts'} with ${STARTER_ITEMS} items, each a copy of this one.` },
                ...(ready.shared ? [{ kind: 'keep' as const, icon: <ShieldCheck />, text: `${ready.shared === 1 ? 'One value stays' : `${ready.shared} values stay`} the same in every item.` }] : [])
              ]}
            />
          )}
          <Field label="List name" hint={label.length >= LABEL_MAX ? `Names can be up to ${LABEL_MAX} characters.` : 'What each placement’s Content calls the list.'} error={labelError} extra={<Count length={label.length} max={LABEL_MAX} />}>
            <input
              ref={input}
              className="input"
              autoFocus
              readOnly={busy}
              aria-required="true"
              maxLength={LABEL_MAX}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && void repeat()}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
