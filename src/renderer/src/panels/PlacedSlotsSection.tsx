import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ArrowUpFromLine, Plus, Trash2 } from 'lucide-react';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { refKey } from '@shared/types';
import { Section } from '../components/ui';
import { BlockedNote, BlockedStatus, useProjectBlock } from '../components/BlockedNote';
import { getState, useStore, type State } from '../store';
import { emptySlot, insertHere } from '../lib/actions';
import { slotItems, type QuickItem } from '../lib/inline-insert';
import { insertOps, nodeLabel, type InsertAt } from '../lib/insert-at';
import { layerLabel } from '../lib/layers';
import { treeFor } from '../lib/model';
import { dropRefusal, savingProblems } from '../lib/insert-drop';
import { moveOutRefusal, slotCountWords, slotOverviews, type SlotOverview } from '../lib/slot-overview';
import { QuickInsert } from './QuickInsert';

interface Props {
  state: ProjectState;
  owner: OwnerRef;
  node: InstanceNode;
  /** The placement, as it is selected. */
  selection: ElementRef;
  /** Select something a slot holds. */
  onSelect: (ref: ElementRef) => void;
  level: number;
}

/**
 * The slots of the selected placement (#654), in the order its component declares them: what each takes and holds,
 * an Add for what it takes, and the way to what is in it. Nothing for a component that declares none.
 */
export function PlacedSlotsSection({ level, ...props }: Props) {
  const rows = slotOverviews(props.state, props.owner, props.node);
  if (!rows.length) return null;
  return (
    <Section title="Slots" id="instance-slots" level={level} scope={rows.length === 1 ? '1 slot' : `${rows.length} slots`}>
      <SlotRows rows={rows} {...props} />
    </Section>
  );
}

/** An open Add list: the slot it adds to, and what the editor was showing as it opened. */
interface Adding {
  slot: string;
  label: string;
  trigger: HTMLElement;
  anchor: { left: number; top: number; width: number; height: number };
  items: QuickItem[];
  refused: string | null;
  seen: string;
}

/** What an Add list was opened on, as one value: any change to it puts the list away. */
const shownNow = (s: State) =>
  JSON.stringify([s.snapshot?.workspaceKey, s.snapshot?.revision, !!s.snapshot?.aiBusy, !!s.snapshot?.readOnly, s.selection && refKey(s.selection), s.mode, !!s.definitionMode, s.rightTab, s.dockOpen, !!s.settings?.developerMode]);

function SlotRows({ rows, state, owner, node, selection, onSelect }: Omit<Props, 'level'> & { rows: SlotOverview[] }) {
  const id = useId();
  const hold = useProjectBlock('change what the slots hold');
  const locked = hold?.text ?? null;
  const moveWhy = moveOutRefusal(owner);
  const [adding, setAdding] = useState<Adding | null>(null);
  // A second choice from a list already acted on adds nothing.
  const choosing = useRef(false);

  /** Put the list away; `back` hands focus back to its button, or to the selection's name once the button is off. */
  const close = (back: boolean) => {
    const trigger = adding?.trigger;
    setAdding(null);
    if (!back) return;
    // Only focus the list left behind: anything that took focus meanwhile keeps it.
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      // The slot filled or the project locked: Add can't take focus then.
      const to = trigger instanceof HTMLButtonElement && trigger.isConnected && !trigger.disabled ? trigger : document.querySelector<HTMLElement>('#dock-panel-inspect .insp-name h3');
      to?.focus({ preventScroll: true });
    });
  };
  // An open list goes with what it was opened on: an Undo, the AI, another selection or Preview.
  useEffect(() => {
    if (!adding) return;
    const check = () => {
      if (shownNow(getState()) !== adding.seen) close(true);
    };
    check();
    return useStore.subscribe(check);
  }, [adding]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Open a slot's Add list. What fits is worked out only now: each is tried on a copy of the project. */
  const open = (row: SlotOverview, trigger: HTMLElement) => {
    const s = getState();
    if (!s.snapshot) return;
    const at: InsertAt = { owner, parentId: node.id, slot: row.slot };
    const r = trigger.getBoundingClientRect();
    setAdding({ slot: row.slot, label: row.label, trigger, anchor: { left: r.left, top: r.top, width: r.width, height: r.height }, items: slotItems(s.snapshot.state, at, !!s.settings?.developerMode), refused: null, seen: shownNow(s) });
  };
  /** Add what was chosen to the slot, as one change; a choice the slot refuses stays in the list, saying why. */
  const choose = (it: QuickItem) => {
    const a = adding;
    const s = getState();
    const snap = s.snapshot;
    if (!a || !snap || choosing.current) return;
    if (shownNow(s) !== a.seen) return close(true);
    const at: InsertAt = { owner, parentId: node.id, slot: a.slot };
    const refused = dropRefusal(snap.state, insertOps(at, it.spec, 'element'), () => savingProblems(snap.state));
    if (refused) return setAdding({ ...a, refused: `${it.name} can’t go here. ${refused}` });
    choosing.current = true;
    setAdding(null);
    // Back in the Inspector, so focus follows to the new element's name once it takes the selection.
    a.trigger.focus({ preventScroll: true });
    void insertHere(it.spec, it.name, 'element', at, snap).finally(() => (choosing.current = false));
  };

  return (
    <>
      {/* Mounted before the lock comes, so it is heard when the AI starts or the project turns read-only. */}
      <BlockedStatus block={hold} lifted="You can change what the slots hold now." />
      {hold && <BlockedNote block={hold} id={`${id}-locked`} live={false} className="slots-blocked" />}
      {rows.map((row, i) => {
        const addWhy = row.damaged ? 'Undo the change that damaged this slot before adding to it.' : row.closed;
        const takeOutWhy = row.shared ?? moveWhy;
        // What each control is off for: the lock said once above, else the slot's own reason below it.
        const lockNote = locked ? `${id}-locked` : undefined;
        const addNote = lockNote ?? (addWhy ? `${id}-add-${i}` : undefined);
        const takeOutNote = !locked && takeOutWhy && row.children.length ? `${id}-take-${i}` : undefined;
        return (
          <div key={row.slot} className="contract-group placed-slot" role="group" aria-label={row.label} data-instance-slot={row.slot}>
            <div className="contract-row">
              <div className="contract-row-main">
                <strong className="slot-name">{row.label}</strong>
                {row.description && <span className="faint contract-meta">{row.description}</span>}
                {row.contract && (
                  <span className="faint contract-meta" data-slot-contract>
                    {row.contract}
                  </span>
                )}
                {row.damaged && <span className="field-error">{row.damaged}</span>}
                <span className="faint contract-meta" data-slot-count>
                  {slotCountWords(row.count)}
                </span>
              </div>
              <button type="button" className="btn btn-sm" disabled={!!(locked ?? addWhy)} aria-label={`Add to ${row.label}`} aria-describedby={addNote} aria-haspopup="dialog" aria-expanded={adding?.slot === row.slot} onClick={(e) => open(row, e.currentTarget)}>
                <Plus aria-hidden="true" /> Add…
              </button>
            </div>
            {!locked && addWhy && (
              <p className="insp-note muted" id={addNote} data-slot-why>
                {addWhy}
              </p>
            )}
            {row.children.length > 0 && (
              <>
                <ul className="slot-content" aria-label={`In ${row.label}`}>
                  {row.children.map((child) => {
                    // As Layers names it, so two pieces of text are told apart by their words.
                    const { label, full } = layerLabel(state, treeFor(state, owner)!.nodes[child]);
                    return (
                      <li key={child}>
                        <button type="button" className="insp-mini" aria-label={`Select ${label}`} title={`Select ${full}`} onClick={() => onSelect({ owner, instancePath: [], nodeId: child })}>
                          <span>{label}</span>
                          <ArrowRight aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="contract-actions">
                  <button type="button" className="btn btn-sm" disabled={!!(locked ?? takeOutWhy)} aria-label={`Move ${row.label} content out`} aria-describedby={lockNote ?? takeOutNote} title={`Move what it holds to just after ${nodeLabel(state, owner, selection.nodeId)}`} onClick={() => void emptySlot(selection, row.slot, 'move')}>
                    <ArrowUpFromLine aria-hidden="true" /> Move out
                  </button>
                  <button type="button" className="btn btn-sm" disabled={!!(locked ?? row.shared)} aria-label={`Clear ${row.label}`} aria-describedby={lockNote ?? (row.shared ? takeOutNote : undefined)} title="Delete what it holds" onClick={() => void emptySlot(selection, row.slot, 'clear')}>
                    <Trash2 aria-hidden="true" /> Clear
                  </button>
                </div>
                {takeOutNote && (
                  <p className="insp-note muted" id={takeOutNote}>
                    {takeOutWhy}
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}
      {adding && <QuickInsert title={`Add to ${adding.label}`} search="Search what fits" items={adding.items} anchor={adding.anchor} trigger={adding.trigger} under={adding.trigger.closest<HTMLElement>('.contract-row')} refused={adding.refused} onChoose={choose} onClose={close} />}
    </>
  );
}
