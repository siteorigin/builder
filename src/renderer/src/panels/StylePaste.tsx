import './StylePaste.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronRight, CircleCheck, ClipboardPaste, Eraser, Info, Lock, Paintbrush, Palette, X } from 'lucide-react';
import type { ProjectSnapshot } from '@shared/api';
import type { ElementRef, StyleValue, TokenDef } from '@shared/types';
import { STYLE_PROP_MAP, cssRivals } from '@shared/styles';
import { effectiveTokens } from '@generator/index';
import { ChoiceField, Modal, Spinner, type MenuItem } from '../components/ui';
import { commitOps, dismissToast, getState, setState, toast, undoAction, useStore, type State } from '../store';
import { SCOPE_LABELS, STATE_LABELS, captureStyle, changeSize, planStylePaste, styleSelection, type PasteRow, type PasteScope } from '../lib/style-copy';
import { CONTAINER_SCOPES, isContainerScope, styleScopeKey, type StyleState } from '@shared/types';
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
      // Unavailable, it says why: the project is read-only, or nothing is copied yet.
      hint: snap.readOnly ? 'Read-only' : copy ? `From ${copy.label}` : 'Copy a style first',
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

const SCOPE_CHOICES: Array<{ value: PasteScope; label: string }> = [
  { value: 'every', label: 'Match the copy' },
  { value: 'base', label: 'All sizes' },
  { value: 'phone', label: 'Phone' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'desktop', label: 'Desktop' }
];

/** Rows in the order they came, gathered under the part each lands on. */
function byTarget(rows: PasteRow[]): Array<[string, PasteRow[]]> {
  const groups = new Map<string, PasteRow[]>();
  for (const r of rows) groups.set(r.target, [...(groups.get(r.target) ?? []), r]);
  return [...groups];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

/** The copied style, while one is held for this project: named in the status bar, and let go of there. */
export function HeldStyle() {
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  const held = useStore((s) => s.styleCopy);
  if (!held || !opening || held.opening !== opening) return null;
  return (
    <span className="held-style" title={`Style copied from ${held.label}. Choose Paste style on another section, part or element.`}>
      <Paintbrush aria-hidden="true" />
      <span className="held-style-label">
        <span className="sr-only">Copied style: </span>
        <span aria-hidden="true">Style of </span>
        {held.label}
      </span>
      <button className="held-style-clear" aria-label={`Forget the style copied from ${held.label}`} title="Forget the copied style" onClick={() => setState({ styleCopy: null })}>
        <X aria-hidden="true" />
      </button>
    </span>
  );
}

/** Paste style: review what the copied style changes on the selection, at the sizes chosen, then apply it as one edit. */
export function PasteStyleModal({ target, opening }: { target: ElementRef; opening: string }) {
  const snap = useStore((s) => s.snapshot);
  const stored = useStore((s) => s.styleCopy);
  const [scope, setScope] = useState<PasteScope>('every');
  const [busy, setBusy] = useState(false);
  // Not pasted folds away under its count while there are changes to read; it is the whole answer when there are none.
  const [skippedOpen, setSkippedOpen] = useState<boolean | null>(null);
  const summaryId = useId();
  const skippedId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  // The Copy style notice has done its job once the review is open; left up, its band would move the footer as it goes.
  useEffect(() => {
    for (const t of getState().toasts) if (t.text.startsWith('Copied the style of ')) dismissToast(t.id);
  }, []);
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
  // A value at a size as the paste leaves it: what the review writes or clears, else what is there now.
  const valueAfter = (r: PasteRow, property: string, size: PasteRow['changes'][number]['scope'], state?: StyleState) => {
    const planned = rows.find((x) => x.part === r.part && x.property === property && x.status === 'change')?.changes.find((c) => c.scope === size && c.state === state);
    return planned ? planned.to : targetOf(r)?.styles?.[styleScopeKey(size, state)]?.[property];
  };
  const fallsToAll = (r: PasteRow, size: PasteRow['changes'][number]['scope'], state?: StyleState) => {
    // A container width's value cleared falls to whatever the screen sizes give, not to All sizes alone; and where a
    // container width has a value of its own once the paste is done (kept, or written by this same paste), that wins
    // over All sizes wherever it holds.
    if (isContainerScope(size)) return false;
    if (CONTAINER_SCOPES.some((c) => valueAfter(r, r.property, c, state) !== undefined)) return false;
    const at = targetOf(r);
    const rivalHere = cssRivals(r.property).some((rv) => valueAfter(r, rv, size, state) !== undefined);
    return !rivalHere && allSizesReach(r.property, allSizesAfter(r, state), size, at?.partId !== undefined);
  };
  // A part inside a repeat is styled once for all of them: its heading says so.
  const reachOf = (where: string) => destination?.targets.find((t) => t.label === where)?.reach;
  const named = (r: PasteRow) => styleLabel(r.property, r.label);
  const cleared = changing.reduce((n, r) => n + r.changes.filter((c) => c.to === undefined).length, 0);
  // What the chosen sizes do, in one line, with this paste's own consequence: how many values it clears.
  const scopeHint =
    scope === 'every'
      ? cleared
        ? `Matches the copy at every size, and clears ${plural(cleared, 'value')} the copy doesn’t have.`
        : 'Matches the copy at every size. Nothing set here is cleared.'
      : scope === 'base'
        ? 'Pastes the All sizes values. Other sizes use them, unless they have values of their own.'
        : `Pastes only what the copy sets for ${SCOPE_LABELS[scope]}. Other sizes stay as they are.`;
  // What a screen reader hears when the sizes change the review: the counts, or that nothing will change.
  const status = !destination
    ? ''
    : changing.length
      ? `${changing.length === 1 ? '1 style changes' : `${changing.length} styles change`}${cleared ? `, ${plural(cleared, 'value')} cleared` : ''}${skipped.length ? `, ${skipped.length} not pasted` : ''}.`
      : `Nothing to change${scope === 'every' ? '' : ` for ${SCOPE_LABELS[scope]}`}.`;
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
  // Why Paste style can't be pressed, said once, icon first, beside it.
  const blocked = readOnly
    ? { icon: <Lock aria-hidden="true" />, text: 'This project is open read-only.' }
    : aiBusy
      ? { icon: <Spinner decorative />, text: 'The AI is changing the site. Paste once it’s done.' }
      : destination && !changing.length
        ? { icon: <Info aria-hidden="true" />, text: empty }
        : null;
  const showSkipped = skippedOpen ?? !changing.length;
  // The copy is gone, or the selection takes no style now: there is nothing to review, only the reason and a way out.
  const gone = !copy
    ? 'Nothing copied is available to paste. Choose Copy style on a section, part or element first.'
    : !destination
      ? 'This selection can no longer take styles. Close this and choose another selection.'
      : null;
  // One live region for the whole dialog, so a screen reader hears why Paste style stops (or starts) being available.
  const announced = gone ?? (blocked ? blocked.text : status);
  // When the review gives way to a reason, focus goes to the one way out rather than being lost with the review.
  useEffect(() => {
    if (!gone) return;
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected) closeRef.current?.focus();
    });
  }, [gone]);
  // "5 not pasted" opens the list it counts, brings its heading up under the pinned strip and puts focus on it.
  const showSkippedList = () => {
    setSkippedOpen(true);
    requestAnimationFrame(() => {
      disclosureRef.current?.focus({ preventScroll: true });
      disclosureRef.current?.scrollIntoView({ block: 'start' });
    });
  };
  // The pinned strip's height, for the scroller: what is scrolled to or focused lands below it, and a property's name
  // stays beside its sizes while they scroll under it.
  const hasContext = !!copy && !!destination;
  useLayoutEffect(() => {
    const strip = contextRef.current;
    const body = strip?.closest<HTMLElement>('.modal-body');
    if (!strip || !body) return;
    const set = () => body.style.setProperty('--paste-pin', `${strip.offsetHeight}px`);
    set();
    const watch = new ResizeObserver(set);
    watch.observe(strip);
    return () => {
      watch.disconnect();
      body.style.removeProperty('--paste-pin');
    };
  }, [hasContext]);

  return (
    <Modal
      title="Paste style"
      icon={<ClipboardPaste />}
      onClose={close}
      busy={busy}
      describedBy={summaryId}
      footer={
        gone ? (
          <button ref={closeRef} className="btn" onClick={close}>
            Close
          </button>
        ) : (
          <>
            {blocked && (
              <span className="paste-foot-note grow">
                {blocked.icon}
                {blocked.text}
              </span>
            )}
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary paste-go" disabled={!canPaste} onClick={() => void paste()}>
              {busy ? 'Pasting…' : changing.length ? `Paste ${plural(changing.length, 'style')}` : 'Paste style'}
            </button>
          </>
        )
      }
    >
      <div className="paste-body">
        <p className="sr-only" role="status">
          {announced}
        </p>
        {gone || !copy || !destination ? (
          <div className="scope-note info paste-gone" id={summaryId}>
            <Info aria-hidden="true" />
            <span>{gone}</span>
          </div>
        ) : (
          <>
            {/* Where it comes from and goes, and the sizes it goes at: kept in view however long the review runs. */}
            <div ref={contextRef} className="paste-context">
              <p className="paste-route" id={summaryId}>
                <strong>{copy.label}</strong>
                <ArrowRight className="paste-route-arrow" aria-hidden="true" />
                <span className="sr-only"> onto </span>
                <strong>{destination.label}</strong> <span className="faint">{destination.where}</span>
              </p>
              <ChoiceField label="Sizes" hint={scopeHint} value={scope} full options={SCOPE_CHOICES.map((c) => ({ value: c.value, label: c.label, disabled: busy }))} onChange={(v) => !busy && setScope(v)} />
            </div>
            {destination.targets.some((t) => t.reach) && destination.kind === 'single' && <p className="faint paste-note">This styles {destination.targets[0].reach}.</p>}
            <section className="paste-section" aria-label="Changes">
              <h3 className="paste-heading">
                {changing.length ? `Changes to ${plural(changing.length, 'style')}` : 'Nothing to change'}
                {(cleared > 0 || (changing.length > 0 && skipped.length > 0)) && (
                  <span className="paste-heading-note">
                    {cleared > 0 && `${plural(cleared, 'value')} cleared`}
                    {cleared > 0 && changing.length > 0 && skipped.length > 0 && ' · '}
                    {changing.length > 0 && skipped.length > 0 && (
                      <button type="button" className="paste-heading-link" aria-controls={skippedId} onClick={showSkippedList}>
                        {skipped.length} not pasted
                      </button>
                    )}
                  </span>
                )}
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
                      {list.map((r) => (
                        <li key={`${r.part}:${r.property}`} className="paste-row">
                          <span className="paste-prop">{named(r)}</span>
                          <span className="paste-changes">
                            {r.changes.map((c) => (
                              <span key={styleScopeKey(c.scope, c.state)} className="paste-change">
                                <span className="paste-size">
                                  {changeSize(c)}
                                  {c.state && <span className="paste-state"> ({STATE_LABELS[c.state]})</span>}
                                </span>
                                <span className="paste-values">
                                  {/* Before and after: what this size has of its own now, or that it has nothing of its own. */}
                                  {c.from !== undefined ? (
                                    <del className="paste-from">
                                      <PasteValue row={r} value={c.from} tokens={tokens} text={show(r, c.from)} />
                                    </del>
                                  ) : (
                                    <span className="paste-unset">not set</span>
                                  )}
                                  {/* The arrow goes with the new value, so a row that has to wrap breaks before it. */}
                                  <span className="paste-after">
                                    <ArrowRight className="paste-arrow" aria-hidden="true" />
                                    <span className="sr-only"> becomes </span>
                                    {c.to !== undefined ? (
                                      <ins className="paste-to">
                                        <PasteValue row={r} value={c.to} tokens={tokens} text={show(r, c.to)} />
                                      </ins>
                                    ) : (
                                      // A removal is drawn as one, not as a new value: a quiet ringed token, then what the size uses instead.
                                      <>
                                        <span className="paste-cleared">
                                          <Eraser aria-hidden="true" />
                                          cleared
                                        </span>
                                        {c.scope !== 'base' && fallsToAll(r, c.scope, c.state) && <span className="paste-fallback">uses All sizes</span>}
                                      </>
                                    )}
                                  </span>
                                </span>
                              </span>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              ) : null}
              {changing.length > 0 && same.length > 0 && (
                <p className="paste-same">
                  <CircleCheck aria-hidden="true" />
                  <span>Already the same: {same.map((r) => (sectionWide ? `${named(r).toLowerCase()} (${r.target.toLowerCase()})` : named(r).toLowerCase())).join(', ')}.</span>
                </p>
              )}
            </section>
            {skipped.length > 0 && (
              <section className="paste-section paste-skipped" aria-label="Not pasted">
                <h3 className="paste-heading">
                  <button ref={disclosureRef} type="button" className="paste-disclosure" aria-expanded={showSkipped} aria-controls={skippedId} onClick={() => setSkippedOpen(!showSkipped)}>
                    <ChevronRight className="chev" aria-hidden="true" />
                    {`Not pasted: ${plural(skipped.length, 'style')}`}
                  </button>
                </h3>
                <div id={skippedId} hidden={!showSkipped}>
                  {byTarget(skipped).map(([where, list]) => (
                    <div key={where} className="paste-group">
                      {sectionWide && <h4 className="paste-target">{where}</h4>}
                      <ul className="paste-skip-list">
                        {list.map((r) => (
                          <li key={`${r.part}:${r.property}`} className="paste-skip">
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
                </div>
              </section>
            )}
            <p className="faint paste-note">Only styles are pasted. Content, links and design options stay as they are.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
