import { useId, useMemo, useState } from 'react';
import { ArrowRight, ClipboardPaste, Paintbrush } from 'lucide-react';
import type { ProjectSnapshot } from '@shared/api';
import type { ElementRef, StyleValue } from '@shared/types';
import { STYLE_PROP_MAP } from '@shared/styles';
import { effectiveTokens } from '@generator/index';
import { Field, Modal, type MenuItem } from '../components/ui';
import { commitOps, getState, setState, toast, undoAction, useStore, type State } from '../store';
import { SCOPE_LABELS, captureStyle, planStylePaste, styleSelection, type PasteRow, type PasteScope } from '../lib/style-copy';
import { describeStyleValue } from './StyleControls';

/** Copy style: take the style changes the selection carries now, for Paste style onto another selection. */
export function copyStyle(ref: ElementRef) {
  const snap = getState().snapshot;
  const copy = snap ? captureStyle(snap.state, ref) : null;
  if (!snap || !copy) return;
  if (!copy.sets.length) return toast(`${copy.label} has no style changes of its own to copy.`, 'info');
  setState({ styleCopy: { ...copy, opening: snap.workspaceKey } });
  toast(`Copied the style of ${copy.label}. Select another section, part or element and choose Paste style.`, 'info');
}

function itemsFor(ref: ElementRef, snap: ProjectSnapshot | null, stored: State['styleCopy'], editingDesign: boolean): MenuItem[] {
  // Edit everywhere styles a component's design, for every placement: a paste there would be a different edit.
  if (!snap || editingDesign || !styleSelection(snap.state, ref)) return [];
  const copy = stored?.opening === snap.workspaceKey ? stored : null;
  return [
    { label: 'Copy style', icon: <Paintbrush />, onSelect: () => copyStyle(ref) },
    {
      label: 'Paste style…',
      icon: <ClipboardPaste />,
      hint: copy ? `From ${copy.label}` : undefined,
      disabled: !copy || !!snap.readOnly,
      onSelect: () => setState({ modal: { kind: 'paste-style', ref, opening: snap.workspaceKey } })
    }
  ];
}

/** Copy style and Paste style for a selection, for a menu opened now (Layers). None for what takes no style here. */
export function styleCopyItems(ref: ElementRef): MenuItem[] {
  const s = getState();
  return itemsFor(ref, s.snapshot, s.styleCopy, !!s.definitionMode);
}

/** The same items for an inspector's actions menu, kept current as a copy is taken. */
export function useStyleCopyItems(ref: ElementRef): MenuItem[] {
  const snap = useStore((s) => s.snapshot);
  const stored = useStore((s) => s.styleCopy);
  const editingDesign = useStore((s) => !!s.definitionMode);
  return itemsFor(ref, snap, stored, editingDesign);
}

const SCOPE_CHOICES: Array<{ value: PasteScope; label: string; hint: string }> = [
  { value: 'every', label: 'Every size', hint: 'Each pasted style ends up as the copy has it at every size, including sizes the copy leaves to All sizes.' },
  { value: 'base', label: 'All sizes only', hint: 'Only what the copy sets for All sizes. Changes either one makes for Phone, Tablet or Desktop stay as they are.' },
  { value: 'phone', label: 'Phone only', hint: 'Only what the copy sets for Phone. Every other size stays as it is.' },
  { value: 'tablet', label: 'Tablet only', hint: 'Only what the copy sets for Tablet. Every other size stays as it is.' },
  { value: 'desktop', label: 'Desktop only', hint: 'Only what the copy sets for Desktop. Every other size stays as it is.' }
];

/** Paste style: review what the copied style changes on the selection, at the sizes chosen, then apply it as one edit. */
export function PasteStyleModal({ target, opening }: { target: ElementRef; opening: string }) {
  const snap = useStore((s) => s.snapshot);
  const stored = useStore((s) => s.styleCopy);
  const [scope, setScope] = useState<PasteScope>('every');
  const [busy, setBusy] = useState(false);
  const summaryId = useId();
  // The copy and the selection belong to the opening the dialog was opened in, and to nothing after it.
  const current = !!snap && snap.workspaceKey === opening;
  const copy = current && stored?.opening === opening ? stored : null;
  const state = current ? snap.state : undefined;
  const plan = useMemo(() => (state && copy ? planStylePaste(state, copy, target, scope) : null), [state, copy, target, scope]);
  const tokens = useMemo(() => (state ? effectiveTokens(state) : []), [state]);
  const destination = plan?.destination ?? null;
  const rows = plan?.rows ?? [];
  const changing = rows.filter((r) => r.status === 'change');
  const same = rows.filter((r) => r.status === 'same');
  const skipped = rows.filter((r) => r.status === 'skip');
  const readOnly = !!snap?.readOnly;
  const aiBusy = !!snap?.aiBusy;
  const canPaste = !!plan && plan.operations.length > 0 && !busy && !readOnly && !aiBusy;
  const close = () => !busy && setState({ modal: null });
  const show = (r: PasteRow, v: StyleValue) => (Object.hasOwn(STYLE_PROP_MAP, r.property) ? describeStyleValue(STYLE_PROP_MAP[r.property], v, tokens) : String(v));
  const paste = async () => {
    if (!plan || !copy || !destination || !canPaste) return;
    setBusy(true);
    let done: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      // Exactly the reviewed edits, on the project as reviewed: if it has moved on, nothing is pasted and the review updates.
      done = await commitOps(plan.operations, 'Paste style', undefined, snap?.revision);
    } finally {
      setBusy(false);
    }
    if (!done || getState().snapshot?.workspaceKey !== opening) return;
    setState({ modal: null });
    toast(`Pasted the style of ${copy.label} onto ${destination.label}.`, 'info', undoAction(done));
  };
  const scopeHint = SCOPE_CHOICES.find((c) => c.value === scope)!.hint;
  const footNote = readOnly ? 'This project is open read-only.' : aiBusy ? 'The AI is changing the site. Paste once it is done.' : null;

  return (
    <Modal
      title="Paste style"
      icon={<ClipboardPaste />}
      onClose={close}
      busy={busy}
      describedBy={summaryId}
      footer={
        <>
          {footNote && <span className="faint grow find-foot-note">{footNote}</span>}
          <button className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canPaste} onClick={() => void paste()}>
            Paste style
          </button>
        </>
      }
    >
      <div className="col find-body">
        {!copy ? (
          <p className="field-error" id={summaryId} style={{ margin: 0 }}>
            Nothing copied is available to paste. Choose Copy style on a section, part or element first.
          </p>
        ) : !destination ? (
          <p className="field-error" id={summaryId} style={{ margin: 0 }}>
            The selection has changed since you chose Paste style, and takes no style changes now. Close this and select it again.
          </p>
        ) : (
          <>
            <p className="find-summary" id={summaryId}>
              From <strong>{copy.label}</strong> onto <strong>{destination.label}</strong> <span className="faint">{destination.where}</span>.{' '}
              <span className="faint">Only style changes are pasted: text, links, images and design options stay as they are.</span>
            </p>
            <Field label="Sizes" hint={scopeHint}>
              <select className="select" value={scope} onChange={(e) => setScope(e.target.value as PasteScope)}>
                {SCOPE_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            {destination.targets.some((t) => t.reach) && destination.kind === 'single' && <p className="faint find-note">This styles {destination.targets[0].reach}.</p>}
            <section className="find-review" aria-label="Changes">
              <h3>{changing.length ? `Changes ${changing.length === 1 ? '1 style' : `${changing.length} styles`}` : 'Nothing to change'}</h3>
              {changing.length ? (
                <ul>
                  {changing.map((r) => (
                    <li key={`${r.target}:${r.property}`} className="find-change">
                      <span>
                        <strong>{r.label}</strong> <span className="faint">· {r.target}</span>
                      </span>
                      {r.changes.map((c) => (
                        <span key={c.scope} className="find-diff">
                          <span className="faint">{SCOPE_LABELS[c.scope]}:</span>
                          {c.from !== undefined && <del>{show(r, c.from)}</del>}
                          {c.from !== undefined && c.to !== undefined && <ArrowRight aria-label="becomes" />}
                          {c.to !== undefined ? <ins>{show(r, c.to)}</ins> : <span className="faint">removed</span>}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="faint">{same.length ? `${destination.label} already has this style.` : 'None of the copied style applies here.'}</p>
              )}
              {changing.length > 0 && same.length > 0 && <p className="faint find-note">Already the same: {same.map((r) => `${r.label.toLowerCase()} (${r.target.toLowerCase()})`).join(', ')}.</p>}
            </section>
            {skipped.length > 0 && (
              <section className="find-review" aria-label="Not pasted">
                <h3>Not pasted here</h3>
                <ul>
                  {skipped.map((r) => (
                    <li key={`${r.target}:${r.property}`} className="find-change">
                      <span>
                        <strong>{r.label}</strong> <span className="faint">· {r.target}</span>
                      </span>
                      <span className="faint">{r.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
