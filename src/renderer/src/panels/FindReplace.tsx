import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes } from 'react';
import { ArrowRight, ChevronRight, CircleAlert, CircleCheck, Link2, Lock, PanelBottom, PanelRightOpen, PanelTop, Replace, Undo2 } from 'lucide-react';
import { Modal, openSection } from '../components/ui';
import { api, commitOps, getState, setState, toast, undoAction, undoAvailable, useStore } from '../store';
import { selectPage } from '../lib/actions';
import { contentFields, contentTarget, findContent, planReplace, sampleContactMatches, type ContentChange, type ContentField, type ContentMatch } from '../lib/find-content';
import type { SampleContactKind } from '@shared/sample-contact';
import { pagesShowing } from '@shared/page-shell';
import { refKey, type ElementRef } from '@shared/types';

/** The reveal waiting for the inspector, so a newer one replaces it. */
let pendingReveal = 0;

/**
 * Runs `found` once `find` sees its element, checking each frame for about a second. It stops when a newer reveal
 * starts or the selection moves on, so it never focuses a field of something the author has since chosen.
 */
function whenShown(selection: ElementRef, find: () => HTMLElement | null | undefined, found: (el: HTMLElement) => void, onTick?: (frame: number) => void) {
  const token = ++pendingReveal;
  const key = refKey(selection);
  let frame = 0;
  const tick = () => {
    const now = getState().selection;
    if (token !== pendingReveal || !now || refKey(now) !== key) return;
    const el = find();
    if (el) return found(el);
    onTick?.(frame);
    if (++frame < 60) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const panel = () => document.getElementById('dock-panel-inspect');
/** The control to type in for a field: its text box (a link's address, not its kind), else its first control. */
const controlIn = (el: Element | null | undefined) => el?.querySelector<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]') ?? el?.querySelector<HTMLElement>('select, input, button') ?? null;
const anchor = (name: string) => `[data-field="${CSS.escape(name)}"]`;

/**
 * Show where a match is: its page (for the shared header and footer, the page on screen when it shows them), the
 * element in the inspector with its Content open, and the field itself, focused. A list item's field the selection
 * alone does not show (a code component's) is opened in its list.
 */
export function openContentMatch(field: ContentField) {
  const s = getState();
  const state = s.snapshot?.state;
  if (!state) return;
  const target = contentTarget(state, field, s.pageId);
  if (!target) return toast('That content is no longer on the site.', 'error');
  if (s.modal) setState({ modal: null });
  if (s.pageId !== target.pageId || s.definitionMode) selectPage(target.pageId);
  setState({ mode: 'edit', selection: target.selection, rightTab: 'inspect', dockOpen: true });
  // Content may have been closed: open it once the new selection's inspector is there (and again, in case it was late).
  const openContent = (frame: number) => (frame === 1 || frame === 12) && openSection(target.section);
  const { reveal, focus } = target;
  if (!reveal) {
    if (focus) whenShown(target.selection, () => controlIn(panel()?.querySelector(anchor(focus))), (el) => el.focus(), openContent);
    else whenShown(target.selection, () => (openSection(target.section), panel()), () => undefined);
    return;
  }
  const list = () => panel()?.querySelector<HTMLElement>(`[data-list="${CSS.escape(reveal.prop)}"]`);
  whenShown(
    target.selection,
    () => list()?.querySelector<HTMLElement>(`#list-head-${CSS.escape(reveal.itemId!)}`),
    (head) => {
      if (head.getAttribute('aria-expanded') !== 'true') head.click();
      whenShown(target.selection, () => {
        const body = list()?.querySelector(`#list-item-${CSS.escape(reveal.itemId!)}`);
        return controlIn(reveal.field ? body?.querySelector(anchor(reveal.field)) : body);
      }, (el) => el.focus());
    },
    openContent
  );
}

/** Where a field is shown: on its own page, or on every page that shows the shared header or footer. */
function reach(f: ContentField): string {
  if (f.sharedPages === undefined) return 'This page only';
  return `Shared ${f.owner.id} · on ${f.sharedPages} page${f.sharedPages === 1 ? '' : 's'}`;
}

interface MatchGroup {
  key: string;
  where: string;
  reach: string;
  shared: boolean;
  shell?: string;
  /** For a shared part: how many pages show it. */
  pages?: number;
  matches: ContentMatch[];
}

/** The result groups: one per page or shared part, in reading order. */
function groupsOf(matches: ContentMatch[]): MatchGroup[] {
  const out = new Map<string, MatchGroup>();
  for (const m of matches) {
    const key = `${m.field.owner.kind}:${m.field.owner.id}`;
    const shared = m.field.sharedPages !== undefined;
    const g = out.get(key) ?? { key, where: m.field.where, reach: reach(m.field), shared, ...(shared ? { shell: m.field.owner.id, pages: m.field.sharedPages } : {}), matches: [] };
    g.matches.push(m);
    out.set(key, g);
  }
  return [...out.values()];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const matchCount = (n: number) => plural(n, 'match', 'matches');

/** Where the matches are, in words: "on 3 pages and the shared footer", with how far a shared part reaches if asked. */
function placesText(groups: MatchGroup[], withReach = false): string {
  const pages = groups.filter((g) => !g.shared).length;
  const shared = groups.filter((g) => g.shared);
  const reachOf = (g: MatchGroup) => (withReach ? ` (on ${plural(g.pages ?? 0, 'page')})` : '');
  // The header and footer read as one place when they reach the same number of pages.
  const sharedPlaces = shared.length === 2 && shared[0].pages === shared[1].pages ? [`the shared header and footer${reachOf(shared[0])}`] : shared.map((g) => `the shared ${g.shell}${reachOf(g)}`);
  const places = [...(pages ? [plural(pages, 'page')] : []), ...sharedPlaces];
  const list = places.length > 1 ? `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}` : places[0];
  return `${pages ? 'on' : 'in'} ${list}`;
}

/** A field's path inside its group, without repeating the group or the section. */
function pathOf(f: ContentField): string {
  if (f.section === f.where || f.label === f.section || f.label.startsWith(`${f.section} › `)) return f.label;
  return `${f.section} › ${f.label}`;
}

/** The words around a match, starting and ending on whole words. */
const fromWord = (t: string) => t.replace(/^…\S*\s+/, '…');
const toWord = (t: string) => t.replace(/\s+\S*…$/, '…');

/** A plain text or address as the chosen matches would literally leave it; undefined for rich text. */
function literalResult(m: ContentMatch, chosen: ContentMatch[], replacement: string): string | undefined {
  const v = m.field.value as { type?: string; target?: unknown } | string;
  const text = m.part === 't' && typeof v === 'string' ? v : m.part === 'l' && typeof v === 'object' && typeof v?.target === 'string' ? (v.type === 'anchor' ? `#${v.target}` : v.target) : undefined;
  if (text === undefined) return undefined;
  let out = text;
  for (const x of chosen.filter((c) => c.field.key === m.field.key && c.part === m.part).sort((a, b) => b.start - a.start)) out = out.slice(0, x.start) + replacement + out.slice(x.end);
  return out;
}

function Check({ mixed, ...props }: InputHTMLAttributes<HTMLInputElement> & { mixed?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed;
  }, [mixed, props.checked]);
  return (
    <label className="find-check">
      <input ref={ref} type="checkbox" {...props} />
    </label>
  );
}

/** The match in its words; while reviewing, what it becomes. */
function Excerpt({ m, preview, replacement }: { m: ContentMatch; preview: boolean; replacement: string }) {
  return (
    <span className="find-excerpt">
      {fromWord(m.before)}
      {preview ? (
        <>
          <del>{m.match}</del>
          {replacement && (
            <>
              <ArrowRight className="find-becomes" aria-hidden />
              <span className="sr-only"> becomes </span>
              <ins>{replacement}</ins>
            </>
          )}
        </>
      ) : (
        <mark>{m.match}</mark>
      )}
      {toWord(m.after)}
    </span>
  );
}

function ChangeRow({ c }: { c: ContentChange }) {
  return (
    <li className="find-match">
      <div className="grow find-match-text">
        <span className="find-where">{c.field.where === c.field.section ? c.field.label : `${c.field.where} › ${pathOf(c.field)}`}</span>
        <span className="find-excerpt">
          <del>{c.before || 'Empty'}</del>
          <ArrowRight className="find-becomes" aria-hidden />
              <span className="sr-only"> becomes </span>
          <ins>{c.after || 'Empty'}</ins>
        </span>
      </div>
    </li>
  );
}

/** What the author had open when they went to look at a match, so coming back carries on from there. */
interface KeptSearch {
  workspaceKey: string;
  query: string;
  sample: SampleSearch | null;
  matchCase: boolean;
  replacement: string;
  replacing: boolean;
  touched: boolean;
  picked: { search: string; ids: Set<string> } | null;
  finished: Finished | null;
}
let kept: KeptSearch | null = null;

/** A search opened for one of the starter's sample contact details, and the words it was opened with. */
interface SampleSearch {
  kind: SampleContactKind;
  query: string;
}

type Applied = NonNullable<Awaited<ReturnType<typeof commitOps>>>;
interface Finished {
  text: string;
  /** The search it was made from, so "no matches left" is said only of that search. */
  query: string;
  result: Applied;
  phase: 'done' | 'undoing' | 'undone' | 'failed';
}

/**
 * `sample` opens the search for one of the starter's sample contact details (from the export's review): while the
 * search is the one it opened with, it finds that detail wherever the published website shows it, written in any
 * way and as its links dial it, so one replacement changes them all. Changing the search goes back to finding words.
 */
export function FindReplaceModal({ initial, sample: forSample }: { initial?: string; sample?: SampleContactKind }) {
  const snap = useStore((s) => s.snapshot);
  // Back from looking at a match in the same project: the search, replacement and choices are as they were.
  const [resumed] = useState(() => (initial === undefined && kept?.workspaceKey === getState().snapshot?.workspaceKey ? kept : null));
  const [sample] = useState<SampleSearch | null>(() => (forSample && initial !== undefined ? { kind: forSample, query: initial } : (resumed?.sample ?? null)));
  const [query, setQuery] = useState(initial ?? resumed?.query ?? '');
  const [matchCase, setMatchCase] = useState(resumed?.matchCase ?? false);
  const [replacement, setReplacement] = useState(resumed?.replacement ?? '');
  const [replacing, setReplacing] = useState(resumed?.replacing ?? false);
  // An empty replacement removes the words, so it counts only once the author has typed or asked for that.
  const [touched, setTouched] = useState(resumed?.touched ?? false);
  // The matches the author chose, for one search. Opening the replace step fixes the choice, so a match the site
  // gains later (or one an edit moves) starts unticked.
  const [picked, setPicked] = useState<{ search: string; ids: Set<string> } | null>(resumed?.picked ?? null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [finished, setFinished] = useState<Finished | null>(resumed?.finished ?? null);
  const [busy, setBusy] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const findId = useId();
  const replaceId = useId();
  const summaryId = useId();
  const errorId = useId();
  const searched = useDeferredValue(query);
  const state = snap?.state;
  const fields = useMemo(() => (state ? contentFields(state) : []), [state]);
  const sampleShown = !!sample && searched === sample.query;
  const matches = useMemo(() => {
    if (!state) return [];
    if (sampleShown) return sampleContactMatches(state).find((g) => g.kind === sample!.kind)?.matches ?? [];
    return findContent(state, searched, { matchCase }, fields);
  }, [state, searched, matchCase, fields, sampleShown, sample]);
  const search = `${sampleShown ? `sample:${sample!.kind}\u0000` : ''}${searched}\u0000${matchCase}`;
  // The list must show the search as typed: Replace never applies the matches of a search being replaced.
  const settled = searched === query;
  // A choice holds for one match as the author saw it: if its field or its reach changes, it has to be made again.
  const shownOn = useMemo(() => (state ? { header: pagesShowing(state, 'header').map((p) => p.id).join(), footer: pagesShowing(state, 'footer').map((p) => p.id).join() } : { header: '', footer: '' }), [state]);
  const choiceKeys = useMemo(() => new Map(matches.map((m) => [m.id, `${m.id}\u0001${m.field.owner.kind !== 'shell' ? '' : m.field.owner.id === 'footer' ? shownOn.footer : shownOn.header}\u0001${JSON.stringify(m.field.value)}`])), [matches, shownOn]);
  const keyOf = (m: ContentMatch) => choiceKeys.get(m.id) ?? m.id;
  const replaceableKeys = useMemo(() => matches.filter((m) => !m.blocked).map((m) => choiceKeys.get(m.id) ?? m.id), [matches, choiceKeys]);
  const ticked = useMemo(() => new Set(picked?.search === search ? replaceableKeys.filter((k) => picked.ids.has(k)) : replaceableKeys), [picked, search, replaceableKeys]);
  const chosen = useMemo(() => matches.filter((m) => !m.blocked && ticked.has(choiceKeys.get(m.id) ?? m.id)), [matches, ticked, choiceKeys]);
  const needAnotherLook = picked?.search === search ? [...picked.ids].filter((k) => !replaceableKeys.includes(k)).length : 0;
  const preview = replacing && (touched || replacement !== '');
  // The review is worked out on the project as this render shows it; Replace applies exactly that, or nothing.
  const plan = useMemo(() => (state && preview && chosen.length ? { ...planReplace(state, chosen, replacement), revision: snap?.revision, workspaceKey: snap?.workspaceKey } : null), [state, preview, chosen, replacement, snap?.revision, snap?.workspaceKey]);
  // The plan reports one error for the batch, so each chosen link is tried alone to say which ones are refused.
  const refused = useMemo(() => (state && plan?.error && replacement === '' ? new Set(chosen.filter((m) => m.kind === 'link' && planReplace(state, [m], '').error).map((m) => m.id)) : new Set<string>()), [state, plan?.error, replacement, chosen]);
  const groups = groupsOf(matches);
  const replaceable = matches.filter((m) => !m.blocked).length;
  const needInspector = matches.length - replaceable;
  const readOnly = !!snap?.readOnly;
  const aiBusy = !!snap?.aiBusy;

  useEffect(() => {
    kept = null;
  }, []);
  useEffect(() => {
    if (replacing && settled && picked?.search !== search) setPicked({ search, ids: new Set(replaceableKeys) });
  }, [replacing, settled, picked?.search, search, replaceableKeys]);
  // An update took away the row that had focus: keep the keyboard in the dialog.
  useEffect(() => {
    if (document.activeElement === document.body) findRef.current?.focus();
  }, [matches]);
  // A finished undo stops being news once the author moves on; a replacement keeps its Undo while they check it.
  useEffect(() => {
    setFinished((f) => (f && (f.phase === 'undone' || f.phase === 'failed') && f.query !== query.trim() ? null : f));
  }, [query]);

  // What the plan really changes, per field: a chosen match outside it already reads as the replacement.
  const changedFields = useMemo(() => new Set((plan?.changes ?? []).filter((c) => !c.knockOn).map((c) => `${c.field.key}:${c.kind}`)), [plan]);
  const unchanged = (m: ContentMatch) => !!plan && !plan.error && (!changedFields.has(`${m.field.key}:${m.kind}`) || (m.match === replacement && !/\s/.test(m.match)));
  const effective = plan && !plan.error ? chosen.filter((m) => !unchanged(m)).length : chosen.length;
  const alsoChanges = plan && !plan.error ? plan.changes.filter((c) => c.knockOn) : [];
  const noteFor = (m: ContentMatch) => {
    const c = plan?.changes.find((x) => !x.knockOn && x.field.key === m.field.key && x.kind === m.kind);
    if (!c) return undefined;
    if (c.after === 'Not shown') return 'This field stops showing on the page.';
    if (c.after === 'No link') return 'This link will be removed.';
    if (c.after.endsWith('(spacing changed)')) return 'Only the spacing changes.';
    const literal = literalResult(m, chosen, replacement);
    if (literal === undefined) return undefined;
    const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
    const differs = m.kind === 'text' ? flat(c.after) !== flat(literal) : !c.after.includes(flat(literal).replace(/^#/, ''));
    return differs ? `Will show as: ${c.after}` : undefined;
  };
  const removing = preview && replacement === '';
  const verb = removing ? 'Remove' : 'Replace';
  const canReplace = !!plan && settled && !plan.error && plan.operations.length > 0 && !busy && !readOnly && !aiBusy && finished?.phase !== 'undoing';
  const canLeaveOutLinks = removing && !!plan?.error && refused.size > 0;
  const undoTarget = finished ? undoAction(finished.result)?.undoes : undefined;
  const canUndo = !!undoTarget && undoAvailable(undoTarget, snap ?? null);

  /** Leaving the dialog with a replacement just made: its Undo moves to the toast, which can show it once this closes. */
  const handOffUndo = () => {
    if (finished?.phase === 'done') toast(finished.text, 'info', undoAction(finished.result));
  };
  const close = () => {
    if (busy) return;
    handOffUndo();
    setState({ modal: null });
  };
  const openMatch = (m: ContentMatch) => {
    openContentMatch(m.field);
    // A match that has gone says so and leaves the dialog open, with nothing to hand over.
    if (getState().modal) return;
    handOffUndo();
    kept = snap?.workspaceKey ? { workspaceKey: snap.workspaceKey, query, sample, matchCase, replacement, replacing, touched, picked, finished } : null;
  };
  const toggle = (m: ContentMatch, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(keyOf(m));
    else next.delete(keyOf(m));
    setPicked({ search, ids: next });
  };
  const setMany = (list: ContentMatch[], on: boolean) => {
    const next = new Set(ticked);
    for (const m of list) if (!m.blocked) (on ? next.add(keyOf(m)) : next.delete(keyOf(m)));
    setPicked({ search, ids: next });
  };
  const startReplacing = () => {
    setPicked({ search, ids: new Set(replaceableKeys) });
    setReplacing(true);
    requestAnimationFrame(() => replaceRef.current?.focus());
  };
  const replace = async () => {
    if (!plan || !canReplace) return;
    // The button disables itself while this runs, so the keyboard waits in the field.
    replaceRef.current?.focus();
    setBusy(true);
    setApplyFailed(false);
    let done: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      done = await commitOps(plan.operations, `Replace “${searched.trim()}” with “${replacement}”`, undefined, plan.revision);
    } finally {
      setBusy(false);
    }
    if (getState().snapshot?.workspaceKey !== plan.workspaceKey) return;
    if (!done) {
      setApplyFailed(true);
      replaceRef.current?.focus();
      return;
    }
    setFinished({ text: `${removing ? 'Removed' : 'Replaced'} ${matchCount(effective)} ${placesText(groupsOf(chosen.filter((m) => !unchanged(m))), true)}.`, query: searched.trim(), result: done, phase: 'done' });
    // Done: what is left (matches left unticked, or ones the edit made) waits for a new choice.
    setReplacing(false);
    // The next batch starts from an empty replacement, so it can't commit the last one's words by accident.
    setReplacement('');
    setTouched(false);
    setPicked(null);
    findRef.current?.focus();
  };
  const undo = async () => {
    const entryId = finished?.result.entryId;
    if (!finished || !entryId) return;
    findRef.current?.focus();
    setFinished({ ...finished, phase: 'undoing' });
    let ok = false;
    try {
      ok = (await api.project.undoEntry(entryId, finished.result.workspaceKey)).ok;
    } catch {
      ok = false;
    }
    setFinished((f) => f && { ...f, phase: ok ? 'undone' : 'failed' });
    findRef.current?.focus();
  };

  const result = !finished
    ? ''
    : finished.phase === 'undone'
      ? 'Undone. Everything is back as it was.'
      : finished.phase === 'failed'
        ? 'That replacement could not be undone. History shows what changed since.'
        : finished.phase === 'undoing'
          ? 'Undoing…'
          : finished.text;
  const chosenPlaces = chosen.length ? ` ${placesText(groupsOf(chosen), true)}` : '';
  const summary = !searched.trim()
    ? 'Search the words on every page, the shared header and footer, and where their links go.'
    : !settled
      ? 'Searching…'
      : !matches.length
        ? finished?.phase === 'done' && finished.query === searched.trim()
          ? `No matches left for “${searched.trim()}”.`
          : `Nothing on the site matches “${searched.trim()}”.${matchCase ? '' : ' Check the spelling, or try fewer words.'}`
        : replacing
          ? `${chosen.length} of ${matchCount(matches.length)} chosen${chosenPlaces}.${needInspector ? ` ${needInspector} ${needInspector === 1 ? 'needs' : 'need'} the inspector.` : ''}${needAnotherLook ? ` The site changed, so ${needAnotherLook === 1 ? '1 choice needs' : `${needAnotherLook} choices need`} another look.` : ''}`
          : `${matchCount(matches.length)} ${placesText(groups)}.`;
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));

  return (
    <Modal
      title="Find and replace"
      icon={<Replace />}
      wide
      onClose={close}
      busy={busy}
      describedBy={summaryId}
      footer={
        <>
          {replacing && (readOnly || aiBusy) && <span className="faint grow find-foot-note">{readOnly ? 'This project is open for viewing only.' : 'Wait for the assistant to finish changing the site.'}</span>}
          <button className="btn" onClick={close} disabled={busy}>
            Close
          </button>
          {replacing ? (
            <button className="btn btn-primary" disabled={!canReplace} onClick={() => void replace()}>
              {busy ? 'Replacing…' : `${verb} ${matchCount(effective)}`}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!replaceable || !settled} onClick={startReplacing}>
              Replace…
            </button>
          )}
        </>
      }
    >
      <div className="col find-body">
        <div className="find-fields">
          <div className="find-row">
            <label htmlFor={findId}>Find</label>
            <input
              id={findId}
              ref={findRef}
              className="input grow"
              autoFocus
              value={query}
              placeholder="Words or an address, such as books@example.org"
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="find-case">
              <input type="checkbox" checked={matchCase} disabled={sampleShown} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
            </label>
          </div>
          {sampleShown && (
            <p className="faint find-hint" data-testid="find-sample-note">
              Every place the published website shows the starter’s sample {sample!.kind === 'email' ? 'email address' : sample!.kind === 'phone' ? 'phone number, as written and as its links dial it' : 'street address'}. Change the search to find anything else.
            </p>
          )}
          {replacing && (
            <div className="find-row">
              <label htmlFor={replaceId}>Replace with</label>
              <input
                id={replaceId}
                ref={replaceRef}
                className="input grow"
                value={replacement}
                placeholder={touched && !plan?.error ? 'Empty: the words will be removed' : 'The new words'}
                aria-invalid={!!plan?.error}
                aria-describedby={plan?.error ? errorId : undefined}
                onChange={(e) => {
                  setApplyFailed(false);
                  setTouched(true);
                  setReplacement(e.target.value);
                }}
              />
            </div>
          )}
          {replacing && !preview && (
            <p className="faint find-hint">
              Type the new words, or{' '}
              <button
                className="link-btn"
                onClick={() => {
                  setTouched(true);
                  replaceRef.current?.focus();
                }}
              >
                remove these words
              </button>{' '}
              instead.
            </p>
          )}
          {preview && plan?.error && (
            <div className="find-error" id={errorId} role="alert">
              <CircleAlert aria-hidden />
              <span className="grow">{canLeaveOutLinks ? 'A link can’t be left empty. Type a new address, or leave the links out to remove only the words.' : plan.error}</span>
              {canLeaveOutLinks && (
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setMany(chosen.filter((m) => refused.has(m.id)), false);
                    replaceRef.current?.focus();
                  }}
                >
                  Leave out the links
                </button>
              )}
            </div>
          )}
          {applyFailed && (
            <div className="find-error" role="alert">
              <CircleAlert aria-hidden />
              <span className="grow">The replacement didn’t go through. Check the matches and try again.</span>
            </div>
          )}
        </div>
        <div className={`find-result${finished ? ' on' : ''}${finished?.phase === 'failed' ? ' failed' : ''}`}>
          {finished && (finished.phase === 'failed' ? <CircleAlert aria-hidden /> : <CircleCheck aria-hidden />)}
          <p role="status">{result}</p>
          {finished?.phase === 'done' && canUndo && (
            <button className="btn btn-sm" disabled={busy} onClick={() => void undo()}>
              <Undo2 /> Undo
            </button>
          )}
          {finished?.phase === 'failed' && finished.result.entryId && (
            <button className="btn btn-sm" disabled={busy} onClick={() => setState({ modal: { kind: 'history', entryId: finished.result.entryId } })}>
              Open History
            </button>
          )}
        </div>
        <div className="find-status">
          <p className="faint find-summary" id={summaryId} role="status">
            {summary}
          </p>
          {!matches.length && matchCase && !!searched.trim() && settled && (
            <button className="link-btn" onClick={() => setMatchCase(false)}>
              Turn off Match case
            </button>
          )}
          {replacing && replaceable > 1 && (
            <button className="link-btn" onClick={() => setMany(matches, chosen.length < replaceable)}>
              {chosen.length < replaceable ? 'Choose all' : 'Choose none'}
            </button>
          )}
          {groups.length > 1 && (
            <button className="link-btn" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)))}>
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
        </div>
        {(groups.length > 0 || alsoChanges.length > 0) && (
          <div className="find-results scroll" aria-busy={!settled} inert={!settled || undefined}>
            {alsoChanges.length > 0 && (
              <section className="find-group" aria-label="Also changes">
                <h3 className="find-group-head">
                  <CircleAlert aria-hidden />
                  <span className="grow find-group-name">Also changes</span>
                  <span className="find-count">{plural(alsoChanges.length, 'field')}</span>
                </h3>
                <ul>
                  {alsoChanges.map((c, i) => (
                    <ChangeRow key={i} c={c} />
                  ))}
                </ul>
              </section>
            )}
            {groups.map((g, gi) => {
              const open = !collapsed.has(g.key);
              const listId = `${summaryId}-list-${gi}`;
              const eligible = g.matches.filter((m) => !m.blocked);
              const on = eligible.filter((m) => ticked.has(keyOf(m))).length;
              const locked = g.matches.length - eligible.length;
              const count = !replacing ? matchCount(g.matches.length) : !eligible.length ? `${locked} in the inspector` : `${on} of ${eligible.length} chosen${locked ? ` · ${locked} in the inspector` : ''}`;
              const ReachIcon = g.shell === 'footer' ? PanelBottom : PanelTop;
              return (
                <section key={g.key} className="find-group" aria-label={`${g.where}, ${g.reach.toLowerCase()}`}>
                  <h3 className="find-group-head">
                    {replacing &&
                      (eligible.length ? (
                        <Check aria-label={`Choose ${locked ? 'the replaceable' : 'all'} matches in ${g.where}`} checked={on === eligible.length} mixed={on > 0 && on < eligible.length} onChange={(e) => setMany(eligible, e.target.checked)} />
                      ) : (
                        <span className="find-check" />
                      ))}
                    <button
                      className="find-toggle grow"
                      aria-expanded={open}
                      aria-controls={listId}
                      title={g.where}
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (open) next.add(g.key);
                        else next.delete(g.key);
                        setCollapsed(next);
                      }}
                    >
                      <ChevronRight aria-hidden />
                      <span className="find-group-name">{g.where}</span>
                    </button>
                    <span className="find-count">{count}</span>
                    <span className={`badge${g.shared ? ' green' : ''}`}>
                      {g.shared && <ReachIcon aria-hidden />}
                      {g.reach}
                    </span>
                  </h3>
                  <ul id={listId} hidden={!open}>
                    {g.matches.map((m, mi) => {
                      const name = pathOf(m.field);
                      // The tag says it is a link address, so the path need not end in the same words.
                      const shownName = m.kind === 'link' ? name.replace(/ › (Destination|Link)$/, '') : name;
                      // Each row's words name its checkbox and describe its Open, so two matches in one field differ.
                      const rowId = `${summaryId}-${gi}-${mi}`;
                      const isOn = !m.blocked && ticked.has(keyOf(m));
                      const same = isOn && unchanged(m);
                      // A refused edit is not shown as if it will happen: only what the project accepts is previewed.
                      const refusedLink = isOn && refused.has(m.id);
                      const showDiff = preview && isOn && !same && !refusedLink && (!plan?.error || canLeaveOutLinks);
                      const note = isOn && !same && !plan?.error ? noteFor(m) : undefined;
                      return (
                        <li key={m.id} className={`find-match${m.blocked ? ' blocked' : ''}${replacing && !m.blocked && !isOn ? ' off' : ''}`}>
                          {replacing &&
                            (m.blocked ? (
                              <span className="find-check find-lock">
                                <Lock aria-hidden />
                              </span>
                            ) : (
                              <Check aria-labelledby={rowId} checked={isOn} onChange={(e) => toggle(m, e.target.checked)} />
                            ))}
                          <div className="grow find-match-text" id={rowId}>
                            <span className="find-where">
                              <span>{shownName}</span>
                              {m.kind === 'link' && (
                                <span className="find-kind">
                                  <Link2 aria-hidden /> Link address
                                </span>
                              )}
                            </span>
                            <Excerpt m={m} preview={showDiff} replacement={replacement} />
                            {same && <span className="faint find-note">Already reads this way.</span>}
                            {refusedLink && (
                              <span className="find-note find-refused">
                                <CircleAlert aria-hidden /> A link needs an address.
                              </span>
                            )}
                            {note && <span className="faint find-note">{note}</span>}
                            {m.blocked && <span className="faint find-note">{m.blocked}</span>}
                          </div>
                          <button className="btn btn-sm btn-ghost" disabled={busy || finished?.phase === 'undoing'} aria-label={`Open ${name} in the inspector`} aria-describedby={rowId} onClick={() => openMatch(m)} title="Show it on the page and in the inspector">
                            <PanelRightOpen /> Open
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
