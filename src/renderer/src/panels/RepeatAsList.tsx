import { useMemo, useRef, useState } from 'react';
import { Box, ListPlus, Repeat, ShieldCheck } from 'lucide-react';
import type { ElementRef, ProjectState } from '@shared/types';
import { displayName, instancesOf } from '@engine/tree';
import { commitOps, getState, setState, useStore } from '../store';
import { Field, Modal } from '../components/ui';
import { BlockedNote, BlockedStatus, projectBlock, readOnlyBlock, type Blocked } from '../components/BlockedNote';
import { isImeComposing } from '../lib/ime';
import { planRepeatAsList, repeatAsListPreflight, repeatAsListTarget, STARTER_ITEMS, type RepeatPlan } from '../lib/repeat-as-list';
import { Badge, Count, Details, FormStatus, GONE_ID, GoneClose, GoneNotice, Subject, limitSaid, useSelectedOnOpen } from './Dialogs';

/** The longest name a list property can have. */
const LABEL_MAX = 80;

const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

/**
 * Repeat as list… (#369): one container of a component's design becomes the first item of a new list each placement
 * fills in. The dialog names the list and says what each item will hold, then makes the whole change at once, so one
 * Undo puts the single container back.
 */
export function RepeatAsListModal({ target, workspaceKey }: { target: ElementRef; workspaceKey?: string }) {
  const snap = useStore((s) => s.snapshot);
  // The project opening this dialog was opened in: another one (or this project opened again) is not where it acts.
  // Named by the menu that opened it, since the dialog can outlive a close and mount again in the next opening.
  const [workspace] = useState(() => workspaceKey ?? snap?.workspaceKey);
  const [own] = useState(() => getState().modal);
  const sameOpening = !!snap && snap.workspaceKey === workspace;
  const st = sameOpening ? snap.state : undefined;
  const def = st && target.owner.kind === 'component' ? st.components[target.owner.id] : undefined;
  const node = def?.tree?.nodes[target.nodeId];
  const [busy, setBusy] = useState(false);
  // Why the last Repeat as list was refused before it was sent, when the project changed since the dialog said it could.
  const [refused, setRefused] = useState<{ state: ProjectState; why: string } | null>(null);
  const [opened] = useState(() => (st && def && node ? { name: displayName(st, node, def), plan: planRepeatAsList(st, def, target.nodeId) } : null));
  const [label, setLabel] = useState(() => (opened && !('problem' in opened.plan) ? opened.plan.label : 'Items'));
  // Planned again as the project or the name changes, so what the dialog says is what Repeat as list does; the IDs are
  // made new when it is chosen.
  const plan = useMemo(() => (st && def ? planRepeatAsList(st, def, target.nodeId, { label }) : null), [st, def, target.nodeId, label]);
  // Tried on a copy of the project once for each version of it (the name never decides whether it lands).
  const preflight = useMemo(() => {
    if (!st || !def) return null;
    const p = planRepeatAsList(st, def, target.nodeId);
    return 'problem' in p ? null : repeatAsListPreflight(st, p);
  }, [st, def, target.nodeId]);
  // While the change is saving, the summary stays as it was confirmed: the project it lands in has the list already.
  const confirmed = useRef<RepeatPlan | null>(null);
  const ready = plan && !('problem' in plan) ? plan : busy ? confirmed.current : null;
  // The container is still there after the change, inside its new repeat: only one that went counts as gone.
  const gone = !busy && (!sameOpening || !node);
  // Read-only is a state, not a fault: said as the session's reason, in the info face, in place of the form.
  const hold = busy || gone ? null : readOnlyBlock(snap);
  const problem = busy || gone || hold ? null : plan && 'problem' in plan ? plan.problem : refused && refused.state === st ? refused.why : preflight;
  // The AI at work only holds the change: the form stays as it is, with why under it.
  const runStatus = useStore((s) => s.runStatus);
  const wait: Blocked | null = busy || gone || hold ? null : projectBlock({ aiBusy: snap?.aiBusy }, 'repeat it as a list', runStatus);
  const input = useSelectedOnOpen();
  const close = () => {
    if (getState().modal === own) setState({ modal: null });
  };
  const labelError = label.trim() ? undefined : 'Enter a name for the list.';
  const placements = st && def ? instancesOf(st, def.id).length : 0;
  const repeat = async () => {
    if (!ready || busy || labelError || problem || hold || wait) return;
    // Checked and planned against the project as it is now, and made only if nothing changes it first.
    const now = getState().snapshot;
    if (!now || now.workspaceKey !== workspace || now.readOnly) return;
    const at = repeatAsListTarget(now, target);
    const fresh = at ? planRepeatAsList(now.state, now.state.components[target.owner.id], target.nodeId, { label }) : null;
    if (!fresh || 'problem' in fresh) return;
    const why = now.state === st ? preflight : repeatAsListPreflight(now.state, fresh);
    if (why) return setRefused({ state: now.state, why });
    confirmed.current = fresh;
    setBusy(true);
    let r: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      r = await commitOps(fresh.operations, `Repeat ${opened?.name ?? 'container'} as a list`, undefined, now.revision);
    } finally {
      if (!r?.ok) setBusy(false);
    }
    // Only while this dialog is still the one open, in the same opening: another view has taken over otherwise.
    if (r?.ok && getState().modal === own && getState().snapshot?.workspaceKey === workspace) setState({ modal: null, selection: target });
  };
  const name = opened?.name ?? 'This container';
  return (
    <Modal
      title="Repeat as list"
      icon={<Badge icon={<Repeat />} tone={gone || problem ? 'caution' : 'definition'} />}
      onClose={close}
      busy={busy}
      describedBy={gone || problem || hold ? GONE_ID : `repeat-list-desc repeat-list-subject repeat-list-details${wait ? ' repeat-list-wait' : ''}`}
      footer={
        gone || problem || hold ? (
          <GoneClose onClose={close} />
        ) : (
          <>
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!ready || !!labelError || !!wait || busy} aria-describedby={wait ? 'repeat-list-wait' : undefined} onClick={() => void repeat()}>
              {busy ? 'Repeating…' : 'Repeat as list'}
            </button>
          </>
        )
      }
    >
      <BlockedStatus block={hold ?? wait} lifted="You can repeat it as a list now." />
      {gone ? (
        <GoneNotice>
          {sameOpening ? (
            <>
              <strong>{name}</strong> was removed, so nothing was repeated.
            </>
          ) : (
            'The project was closed or opened again, so nothing was repeated.'
          )}
        </GoneNotice>
      ) : hold ? (
        <BlockedNote block={hold} id={GONE_ID} live={false} />
      ) : problem ? (
        <GoneNotice>{problem}</GoneNotice>
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
          {wait && <BlockedNote block={wait} id="repeat-list-wait" live={false} />}
        </div>
      )}
    </Modal>
  );
}
