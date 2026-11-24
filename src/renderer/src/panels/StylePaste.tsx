import { useId, useMemo, useState } from 'react';
import { ArrowRight, ClipboardPaste, Paintbrush, Palette } from 'lucide-react';
import type { ProjectSnapshot } from '@shared/api';
import type { ElementRef, StyleValue, TokenDef } from '@shared/types';
import { STYLE_PROP_MAP, cssRivals } from '@shared/styles';
import { effectiveTokens } from '@generator/index';
import { Field, Modal, type MenuItem } from '../components/ui';
import { commitOps, getState, setState, toast, undoAction, useStore, type State } from '../store';
import { SCOPE_LABELS, captureStyle, changeLabel, planStylePaste, styleSelection, type PasteRow, type PasteScope } from '../lib/style-copy';
import { styleScopeKey, type StyleState } from '@shared/types';
import { allSizesReach } from '../lib/style-source';
import { describeStyleValue, isStyleLink, styleLabel, styleSwatch } from './StyleControls';

/** Copy style: take the style changes the selection carries now, for Paste style onto another selection. */
export function copyStyle(ref: ElementRef) {
  const snap = getState().snapshot;
  const copy = snap ? captureStyle(snap.state, ref) : null;
  if (!snap || !copy) return;
  if (!copy.sets.length) return toast(`${copy.label} has no style changes of its own to copy.`, 'info');
  setState({ styleCopy: { ...copy, opening: snap.workspaceKey } });
  // A section's copy carries its parts' styles too, and says so.
  const parts = copy.sets.filter((s) => s.part && s.part !== 'root').map((s) => s.label.toLowerCase());
  const what = parts.length ? `${copy.label} and its ${listJoin(parts)}` : copy.label;
  toast(`Copied the style of ${what}. Select another section, part or element and choose Paste style.`, 'info');
}

const listJoin = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

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
  { value: 'every', label: 'Every size', hint: 'Each pasted style matches the copy at every size: where the copy has no value of its own for a size, that size’s own value here is cleared. Styles the copy doesn’t set stay as they are.' },
  { value: 'base', label: 'All sizes only', hint: 'Pastes the copy’s All sizes values. Changes saved here for Phone, Tablet or Desktop stay; sizes that use All sizes pick up the new value.' },
  { value: 'phone', label: 'Phone only', hint: 'Only what the copy sets for Phone. Every other size stays as it is.' },
  { value: 'tablet', label: 'Tablet only', hint: 'Only what the copy sets for Tablet. Every other size stays as it is.' },
  { value: 'desktop', label: 'Desktop only', hint: 'Only what the copy sets for Desktop. Every other size stays as it is.' }
];

/** Rows in the order they came, gathered under the part each lands on. */
function byTarget(rows: PasteRow[]): Array<[string, PasteRow[]]> {
  const groups = new Map<string, PasteRow[]>();
  for (const r of rows) groups.set(r.target, [...(groups.get(r.target) ?? []), r]);
  return [...groups];
}

/** A pasted value as the inspector names it, with its colour beside it when it is one. */
function PasteValue({ row, value, tokens, text }: { row: PasteRow; value: StyleValue; tokens: TokenDef[]; text: string }) {
  const def = Object.hasOwn(STYLE_PROP_MAP, row.property) ? STYLE_PROP_MAP[row.property] : undefined;
  const color = def ? styleSwatch(def, value, tokens) : undefined;
  // A Site style carries the inspector's mark: its colour, or the Site styles glyph, and says so to a screen reader.
  const linked = def ? isStyleLink(def, value) : typeof value === 'object' && value !== null;
  return (
    <>
      {color ? <span className="paste-swatch" style={{ background: color }} aria-hidden="true" /> : linked && <Palette className="paste-lead" aria-hidden="true" />}
      {text}
      {linked && <span className="sr-only">, from Site styles</span>}
    </>
  );
}

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
    // A click handled after another opening took over would otherwise send this review's edits to that project.
    if (!plan || !copy || !destination || !canPaste || getState().snapshot?.workspaceKey !== opening) return;
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
  // A section's paste can land on several of its parts: the review groups the changes under each.
  const sectionWide = destination?.kind === 'section';
  // What a size's own value falls back to once cleared: the All sizes value the destination ends with, if any.
  // A state's own size value falls back to the All sizes value for the same state.
  const allSizesAfter = (r: PasteRow, state?: StyleState) => {
    const pasted = r.changes.find((c) => c.scope === 'base' && c.state === state);
    if (pasted) return pasted.to;
    const at = destination?.targets.find((t) => t.part === r.part) ?? (destination?.targets.length === 1 ? destination.targets[0] : undefined);
    return at?.styles?.[styleScopeKey('base', state)]?.[r.property];
  };
  // "Uses All sizes" only where the stylesheet carries that value to the size (a multi-column value on a placement
  // skips phones) and no other control writing the same CSS keeps its own value there (Column sizes over Columns).
  const targetOf = (r: PasteRow) => destination?.targets.find((t) => t.part === r.part) ?? (destination?.targets.length === 1 ? destination.targets[0] : undefined);
  const fallsToAll = (r: PasteRow, size: PasteRow['changes'][number]['scope'], state?: StyleState) => {
    const at = targetOf(r);
    // A rival's value at this size as the paste leaves it: what the review writes or clears, else what is there now.
    const rivalAfter = (rv: string) => {
      const planned = rows.find((x) => x.part === r.part && x.property === rv && x.status === 'change')?.changes.find((c) => c.scope === size && c.state === state);
      return planned ? planned.to : at?.styles?.[styleScopeKey(size, state)]?.[rv];
    };
    const rivalHere = cssRivals(r.property).some((rv) => rivalAfter(rv) !== undefined);
    return !rivalHere && allSizesReach(r.property, allSizesAfter(r, state), size, at?.partId !== undefined);
  };
  // A part inside a repeat is styled once for all of them: its heading says so.
  const reachOf = (where: string) => destination?.targets.find((t) => t.label === where)?.reach;
  const named = (r: PasteRow) => styleLabel(r.property, r.label);
  // What a screen reader hears when the sizes change the review: the counts, or that nothing will change.
  const status = !destination ? '' : changing.length ? `${changing.length === 1 ? '1 style changes' : `${changing.length} styles change`}${skipped.length ? `, ${skipped.length} not pasted` : ''}.` : `Nothing to change${scope === 'every' ? '' : ` for ${SCOPE_LABELS[scope]}`}.`;
  // An empty review says why, for the sizes chosen.
  const empty = scope === 'every'
    ? same.length
      ? skipped.length
        ? `${destination?.label} already has the styles that apply here.`
        : `${destination?.label} already has this style.`
      : 'None of the copied style applies here.'
    : same.length
      ? `${destination?.label} already matches for ${SCOPE_LABELS[scope]}.`
      : `The copy has no changes for ${SCOPE_LABELS[scope]} that apply here.`;
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
      <div className="paste-body">
        {!copy ? (
          <p className="field-error paste-error" id={summaryId}>
            Nothing copied is available to paste. Choose Copy style on a section, part or element first.
          </p>
        ) : !destination ? (
          <p className="field-error paste-error" id={summaryId}>
            The selection has changed since you chose Paste style, and takes no style changes now. Close this and select it again.
          </p>
        ) : (
          <>
            <p className="paste-summary" id={summaryId}>
              From <strong>{copy.label}</strong> onto <strong>{destination.label}</strong> <span className="faint">{destination.where}</span>.{' '}
              <span className="faint">Only style changes are pasted: text, links, images and design options stay as they are.</span>
            </p>
            <Field label="Sizes" hint={scopeHint}>
              <select className="select" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value as PasteScope)}>
                {SCOPE_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            {destination.targets.some((t) => t.reach) && destination.kind === 'single' && <p className="faint paste-note">This styles {destination.targets[0].reach}.</p>}
            <p className="sr-only" role="status">
              {status}
            </p>
            <section className="paste-section" aria-label="Changes">
              <h3 className="paste-heading">
                {changing.length ? `Changes to ${changing.length === 1 ? '1 style' : `${changing.length} styles`}` : 'Nothing to change'}
              </h3>
              {changing.length ? (
                byTarget(changing).map(([where, list]) => (
                  <div key={where} className="paste-group">
                    {sectionWide && (
                      <h4 className="paste-target">
                        {where}
                        {reachOf(where) && <span className="paste-reach"> · {reachOf(where)}</span>}
                      </h4>
                    )}
                    <ul className="paste-list">
                      {list.map((r) => {
                        return (
                          <li key={`${r.part}:${r.property}`} className="paste-row">
                            <span className="paste-prop">{named(r)}</span>
                            <span className="paste-changes">
                              {r.changes.map((c) => (
                                <span key={styleScopeKey(c.scope, c.state)} className="paste-change">
                                  <span className="paste-size">{changeLabel(c)}</span>
                                  <span className="paste-values">
                                    {/* Before and after: what this size has of its own now, or that it has nothing of its own. */}
                                    {c.from !== undefined ? (
                                      <del className="paste-from">
                                        <PasteValue row={r} value={c.from} tokens={tokens} text={show(r, c.from)} />
                                      </del>
                                    ) : (
                                      <span className="paste-unset">not set</span>
                                    )}
                                    <ArrowRight className="paste-arrow" aria-hidden="true" />
                                    <span className="sr-only"> becomes </span>
                                    {c.to !== undefined ? (
                                      <ins className="paste-to">
                                        <PasteValue row={r} value={c.to} tokens={tokens} text={show(r, c.to)} />
                                      </ins>
                                    ) : (
                                      <span className="paste-cleared">{c.scope !== 'base' && fallsToAll(r, c.scope, c.state) ? 'cleared, uses All sizes' : 'cleared'}</span>
                                    )}
                                  </span>
                                </span>
                              ))}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              ) : (
                <p className="paste-empty">{empty}</p>
              )}
              {changing.length > 0 && same.length > 0 && <p className="faint paste-note">Already the same: {same.map((r) => (sectionWide ? `${named(r).toLowerCase()} (${r.target.toLowerCase()})` : named(r).toLowerCase())).join(', ')}.</p>}
            </section>
            {skipped.length > 0 && (
              <section className="paste-section paste-skipped" aria-label="Not pasted">
                <h3 className="paste-heading">Not pasted</h3>
                {byTarget(skipped).map(([where, list]) => (
                  <div key={where} className="paste-group">
                    {sectionWide && <h4 className="paste-target">{where}</h4>}
                    <ul className="paste-list">
                      {list.map((r) => (
                        <li key={`${r.part}:${r.property}`} className="paste-row">
                          <span className="paste-prop">
                            {named(r)}
                            {/* Onto one part or element, a skipped row names the copied part it came from. */}
                            {!sectionWide && r.part !== null && <span className="paste-part">{r.target}</span>}
                          </span>
                          <span className="paste-reason">{r.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
