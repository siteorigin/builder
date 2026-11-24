import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { ArrowRight, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleAlert, CircleCheck, FileText, Link2, ListChecks, ListX, Lock, PanelBottom, PanelRightOpen, PanelTop, Replace, Search, SearchX, Undo2 } from 'lucide-react';
import { Modal, openSection } from '../components/ui';
import { api, commitOps, getState, setState, toast, trackHistory, undoAction, undoAvailable, useStore } from '../store';
import { pageOutOfSight, selectPage } from '../lib/actions';
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
  if (pageOutOfSight(s, target.pageId)) selectPage(target.pageId);
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
const clip = (t: string, max = 90) => (t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, '')}…` : t);
const matchCount = (n: number) => plural(n, 'match', 'matches');

/** Where the matches are, in words: "on 3 pages and the shared footer", with how far a shared part reaches if asked. */
function placesText(groups: MatchGroup[], withReach = false, samePages = false): string {
  const pages = groups.filter((g) => !g.shared).length;
  const shared = groups.filter((g) => g.shared);
  const reachOf = (g: MatchGroup) => (withReach ? ` (shown on ${plural(g.pages ?? 0, 'page')})` : '');
  // The header and footer read as one place only when they show on the same pages.
  const sharedPlaces = shared.length === 2 && samePages ? [`the shared header and footer${reachOf(shared[0])}`] : shared.map((g) => `the shared ${g.shell}${reachOf(g)}`);
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

/** What a change leaves: the new words, or a plain "removed" when the replacement is empty. */
function Becomes({ to }: { to: string }) {
  return (
    <>
      <ArrowRight className="find-becomes" aria-hidden />
      {to ? (
        <>
          <span className="sr-only"> becomes </span>
          <ins>{to}</ins>
        </>
      ) : (
        <>
          <span className="sr-only"> </span>
          <span className="find-removed">removed</span>
        </>
      )}
    </>
  );
}

/** The match in its words; while reviewing, what it becomes. A removal is struck through in place, and what is left
 *  is spelled out below it, so a removal inside a word can't read as new words. */
function Excerpt({ m, preview, replacement, leaves }: { m: ContentMatch; preview: boolean; replacement: string; leaves?: string | null }) {
  const before = fromWord(m.before);
  const after = toWord(m.after);
  const removal = preview && !replacement;
  // The excerpt stands for the whole field only when neither end was cut.
  const left = leaves !== undefined ? leaves : before.startsWith('…') || after.endsWith('…') ? null : `${before}${after}`.replace(/\s+/g, ' ').trim();
  return (
    <>
      <span className="find-excerpt">
        {before}
        {preview ? (
          <>
            <del>{m.match}</del>
            {removal ? <span className="sr-only"> (removed) </span> : <Becomes to={replacement} />}
          </>
        ) : (
          <mark>{m.match}</mark>
        )}
        {after}
      </span>
      {removal && left !== null && <span className="find-note find-leaves">{left ? <>Leaves “{left}”</> : 'Leaves the field empty'}</span>}
    </>
  );
}

/** A field's path, quiet, with the field itself named last and a little stronger. */
function Path({ name }: { name: string }) {
  const parts = name.split(' › ');
  const field = parts.pop();
  return (
    <span className="find-path">
      {parts.map((p, i) => (
        <span key={i}>{p} › </span>
      ))}
      <span className="find-field">{field}</span>
    </span>
  );
}

function ChangeRow({ c }: { c: ContentChange }) {
  return (
    <li className="find-match">
      <div className="grow find-match-text">
        <span className="find-where">
          <Path name={c.field.where === c.field.section ? c.field.label : `${c.field.where} › ${pathOf(c.field)}`} />
        </span>
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

/** The author's choices for one search, and the matches they deliberately left out, which stay out as the search is refined. */
interface Picked {
  search: string;
  ids: Set<string>;
  out: Set<string>;
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
  picked: Picked | null;
  finished: Finished | null;
  collapsed: Set<string>;
  /** The match they opened, shown again where they left it. */
  opened: string;
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
  /** The whole search it was made from (with Match case), so Undo brings the review back only to that search. */
  search: string;
  /** The words replaced (each spelling, for a search that ignored case) and what replaced them, shown beside Undo. */
  from: string;
  /** Further spellings changed beyond the ones named. */
  more: number;
  to: string;
  /** Other fields the replacement changed with it (a link's label following its address). */
  also: number;
  /** Matches that were found but not changed: left out by the author, or needing the inspector. */
  leftOut: number;
  result: Applied;
  phase: 'done' | 'undoing' | 'undone' | 'failed';
  /** The review it was made from, put back by Undo so a typo can be fixed and tried again. */
  review: { replacement: string; touched: boolean; picked: Picked | null };
}

const mod = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

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
  // An empty replacement removes the words, so it counts only once the author has asked for that.
  const [touched, setTouched] = useState(resumed?.touched ?? false);
  // The matches the author chose, for one search. Opening the replace step fixes the choice, so a match the site
  // gains later (or one an edit moves) starts unticked.
  const [picked, setPicked] = useState<Picked | null>(resumed?.picked ?? null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => resumed?.collapsed ?? new Set());
  const [recent] = useState(resumed?.opened ?? null);
  const [finished, setFinished] = useState<Finished | null>(resumed?.finished ?? null);
  const [busy, setBusy] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false);
  // Once a search has started, the dialog keeps its full height for the rest of the session.
  const [expanded, setExpanded] = useState(() => !!resumed);
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef('');
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
  // The search as typed right now (not as last settled), so Undo and stale notes compare against what the author sees.
  const liveSearch = `${sample && query === sample.query ? `sample:${sample.kind}\u0000` : ''}${query}\u0000${matchCase}`;
  searchRef.current = liveSearch;
  // The list must show the search as typed: Replace never applies the matches of a search being replaced.
  const settled = searched === query;
  // A choice holds for one match as the author saw it: if its field or its reach changes, it has to be made again.
  const shownOn = useMemo(() => (state ? { header: pagesShowing(state, 'header').map((p) => p.id).join(), footer: pagesShowing(state, 'footer').map((p) => p.id).join() } : { header: '', footer: '' }), [state]);
  const choiceKeys = useMemo(() => new Map(matches.map((m) => [m.id, `${m.id}\u0001${m.field.owner.kind !== 'shell' ? '' : m.field.owner.id === 'footer' ? shownOn.footer : shownOn.header}\u0001${JSON.stringify(m.field.value)}`])), [matches, shownOn]);
  const keyOf = (m: ContentMatch) => choiceKeys.get(m.id) ?? m.id;
  const samePages = shownOn.header === shownOn.footer;
  const replaceableKeys = useMemo(() => matches.filter((m) => !m.blocked).map((m) => choiceKeys.get(m.id) ?? m.id), [matches, choiceKeys]);
  // A refined search keeps what the author left out: a match they unticked stays unticked while it is still found.
  const ticked = useMemo(() => new Set(picked?.search === search ? replaceableKeys.filter((k) => picked.ids.has(k)) : replaceableKeys.filter((k) => !picked?.out.has(k))), [picked, search, replaceableKeys]);
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
  // Where one field holds several matches, each row says which one it is.
  const nth = useMemo(() => {
    const seen = new Map<string, string[]>();
    for (const m of matches) {
      const k = `${m.field.key}\u0000${m.part}`;
      seen.set(k, [...(seen.get(k) ?? []), m.id]);
    }
    const out = new Map<string, string>();
    for (const ids of seen.values()) if (ids.length > 1) ids.forEach((id, i) => out.set(id, `${i + 1} of ${ids.length} in this field`));
    return out;
  }, [matches]);

  useEffect(() => {
    kept = null;
    // Back from the inspector: the match that was opened is where the author left it.
    if (recent) requestAnimationFrame(() => listRef.current?.querySelector(`[data-match="${CSS.escape(recent)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, []);
  useEffect(() => {
    if (replacing && settled && picked?.search !== search) setPicked({ search, ids: new Set(replaceableKeys.filter((k) => !picked?.out.has(k))), out: picked?.out ?? new Set() });
  }, [replacing, settled, picked?.search, picked?.out, search, replaceableKeys]);
  // An update took away the row that had focus: keep the keyboard in the dialog.
  useEffect(() => {
    if (document.activeElement === document.body) findRef.current?.focus();
  }, [matches]);
  // A finished undo stops being news once the author moves on; a replacement keeps its Undo while they check it.
  useEffect(() => {
    setFinished((f) => (f && (f.phase === 'undone' || f.phase === 'failed') && f.search !== liveSearch ? null : f));
    setApplyFailed(false);
  }, [liveSearch]);
  // A new search needs its own decision to remove words: "remove these words" covers only the matches it was asked for.
  const removalFor = useRef(search);
  useEffect(() => {
    if (removalFor.current === search) return;
    removalFor.current = search;
    if (!replacement) setTouched(false);
  }, [search, replacement]);

  // What the plan really changes, per field: a chosen match outside it already reads as the replacement.
  const changedFields = useMemo(() => new Set((plan?.changes ?? []).filter((c) => !c.knockOn).map((c) => `${c.field.key}:${c.kind}`)), [plan]);
  const unchanged = (m: ContentMatch) => !!plan && !plan.error && (!changedFields.has(`${m.field.key}:${m.kind}`) || (m.match === replacement && !/\s/.test(m.match)));
  const removing = preview && replacement === '';
  // Leaving the refused links out is offered only when what is left would really go through.
  const remainderOk = useMemo(() => {
    if (!state || !refused.size) return false;
    const rest = chosen.filter((m) => !refused.has(m.id));
    return rest.length > 0 && !planReplace(state, rest, '').error;
  }, [state, refused, chosen]);
  const canLeaveOutLinks = removing && !!plan?.error && refused.size > 0 && remainderOk;
  // The count is what will change: matches that already read this way, and links the project refuses to empty, are
  // never in it, whether or not leaving those links out would help.
  const hasRefused = removing && !!plan?.error && refused.size > 0;
  const effective = plan && !plan.error ? chosen.filter((m) => !unchanged(m)).length : chosen.length - (hasRefused ? refused.size : 0);
  const alsoChanges = plan && !plan.error ? plan.changes.filter((c) => c.knockOn) : [];
  const knockOnFor = (m: ContentMatch) => alsoChanges.find((c) => c.field.key === m.field.key && c.kind === m.kind);
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
  const verb = removing ? 'Remove' : 'Replace';
  const canReplace = !!plan && settled && !plan.error && plan.operations.length > 0 && !busy && !readOnly && !aiBusy && finished?.phase !== 'undoing';
  const undoTarget = finished ? undoAction(finished.result)?.undoes : undefined;
  const canUndo = !!undoTarget && undoAvailable(undoTarget, snap ?? null);
  const filled = expanded || !!query.trim() || !!finished;
  useEffect(() => {
    if (filled && !expanded) setExpanded(true);
  }, [filled, expanded]);

  /** Leaving the dialog with a replacement just made: its Undo moves to the toast, which can show it once this closes. */
  const handOffUndo = () => {
    if (finished?.phase === 'done' && canUndo) toast(finished.text, 'info', undoAction(finished.result));
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
    // A replacement's Undo has gone to the toast and the site may change in the inspector, so no receipt comes back.
    kept = snap?.workspaceKey ? { workspaceKey: snap.workspaceKey, query, sample, matchCase, replacement, replacing, touched, picked, finished: null, collapsed, opened: m.id } : null;
  };
  /** Tick or untick matches; an unticked one is remembered as left out, so refining the search does not bring it back. */
  const setMany = (list: ContentMatch[], on: boolean) => {
    const ids = new Set(ticked);
    const out = new Set(picked?.out);
    for (const m of list) {
      if (m.blocked) continue;
      const k = keyOf(m);
      if (on) {
        ids.add(k);
        out.delete(k);
      } else {
        ids.delete(k);
        out.add(k);
      }
    }
    setPicked({ search, ids, out });
    setFinished((f) => (f?.phase === 'undone' ? null : f));
    setApplyFailed(false);
  };
  const startReplacing = () => {
    setPicked({ search, ids: new Set(replaceableKeys), out: new Set() });
    setReplacing(true);
    requestAnimationFrame(() => replaceRef.current?.focus());
  };
  const replace = async () => {
    if (!plan || !canReplace) return;
    // The button disables itself while this runs, so the keyboard waits in the field.
    replaceRef.current?.focus();
    setBusy(true);
    setApplyFailed(false);
    setFinished((f) => (f?.phase === 'done' ? f : null));
    let done: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      done = await commitOps(plan.operations, removing ? `Remove “${searched.trim()}”` : `Replace “${searched.trim()}” with “${replacement}”`, undefined, plan.revision);
    } finally {
      setBusy(false);
    }
    if (getState().snapshot?.workspaceKey !== plan.workspaceKey) return;
    if (!done) {
      setApplyFailed(true);
      replaceRef.current?.focus();
      return;
    }
    const changed = chosen.filter((m) => !unchanged(m));
    const spellings = [...new Set(changed.map((m) => m.match))];
    setFinished({
      text: `${removing ? 'Removed' : 'Replaced'} ${matchCount(effective)} ${placesText(groupsOf(changed), true, samePages)}.`,
      query: searched.trim(),
      search,
      from: spellings.slice(0, 3).join(' / '),
      more: Math.max(0, spellings.length - 3),
      to: replacement,
      also: alsoChanges.length,
      leftOut: matches.filter((m) => !changed.includes(m) && !knockOnFor(m)).length,
      result: done,
      phase: 'done',
      review: { replacement, touched, picked }
    });
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
      ok = (await trackHistory(api.project.undoEntry(entryId, finished.result.workspaceKey))).ok;
    } catch {
      ok = false;
    }
    setFinished((f) => f && { ...f, phase: ok ? 'undone' : 'failed' });
    // Undone while still on the same search: the review comes back as it was, so a typo can be fixed and tried again.
    if (ok && searchRef.current === finished.search) {
      setReplacement(finished.review.replacement);
      setTouched(finished.review.touched);
      setPicked(finished.review.picked);
      setReplacing(true);
      requestAnimationFrame(() => replaceRef.current?.focus());
    } else findRef.current?.focus();
  };
  /** Enter in Find goes to the results (or on to the replacement); Enter in Replace with goes to the action. */
  const toResults = () => {
    const list = listRef.current;
    (list?.querySelector<HTMLElement>('ul:not([hidden]) .find-match :is(button, input):not(:disabled)') ?? list?.querySelector<HTMLElement>('.find-toggle'))?.focus();
  };
  // Enter pressed while the search is still settling is honoured once the results it asked for are there.
  const enterWaiting = useRef(false);
  useEffect(() => {
    if (!settled || !enterWaiting.current) return;
    enterWaiting.current = false;
    if (document.activeElement === findRef.current) requestAnimationFrame(toResults);
  }, [settled, matches]);
  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (replacing) return replaceRef.current?.focus();
    if (!settled) enterWaiting.current = true;
    else toResults();
  };
  const onReplaceKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canReplace) actionRef.current?.focus();
  };
  /** ⌘Enter anywhere in the dialog, header and footer included, takes the next step: review a replacement, then make it. */
  const nextStep = useRef<() => void>(() => undefined);
  nextStep.current = () => {
    if (replacing) void replace();
    else if (replaceable && settled && !busy && finished?.phase !== 'undoing') startReplacing();
  };
  useEffect(() => {
    const dialog = findRef.current?.closest<HTMLElement>('.modal');
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      nextStep.current();
    };
    dialog?.addEventListener('keydown', onKey);
    return () => dialog?.removeEventListener('keydown', onKey);
  }, []);

  const result = !finished
    ? ''
    : finished.phase === 'undone'
      ? 'Undone. Everything is back as it was.'
      : finished.phase === 'failed'
        ? 'That replacement could not be undone. History shows what changed since.'
        : finished.phase === 'undoing'
          ? 'Undoing…'
          : finished.text;
  const doneHere = (finished?.phase === 'done' || finished?.phase === 'undoing') && finished.search === search;
  const q = searched.trim();
  const empty = !!q && settled && !matches.length;
  // Nothing found with Match case on: how many it would find without it, so the way out is only offered when it leads somewhere.
  const caseless = useMemo(() => (state && empty && matchCase && !sampleShown ? findContent(state, searched, { matchCase: false }, fields).length : 0), [state, empty, matchCase, sampleShown, searched, fields]);
  // Left out means left as it is: an unticked match that changes anyway (it follows a chosen one) is not among them.
  const leftOut = matches.filter((m) => !m.blocked && !ticked.has(keyOf(m)) && !knockOnFor(m)).length;
  const already = plan && !plan.error ? chosen.filter((m) => unchanged(m)).length : 0;
  const refusedCount = hasRefused ? refused.size : 0;
  // While reviewing, one account of the batch: everything found, then what happens to it.
  const facts = replacing
    ? [
        !replaceable ? '' : chosen.length === matches.length && matches.length > 1 ? `all ${matches.length} chosen` : `${chosen.length} chosen`,
        leftOut > 0 && chosen.length > 0 ? `${leftOut} left out` : '',
        already ? `${already} already ${already === 1 ? 'reads' : 'read'} this way` : '',
        needInspector ? `${needInspector} ${needInspector === 1 ? 'needs' : 'need'} the inspector` : '',
        refusedCount ? `${plural(refusedCount, 'link')} ${refusedCount === 1 ? 'needs' : 'need'} an address` : '',
        needAnotherLook ? `the site changed, so ${needAnotherLook === 1 ? '1 choice needs' : `${needAnotherLook} choices need`} another look` : ''
      ].filter(Boolean)
    : [];
  const emptyHead = doneHere ? `No matches left for “${q}”.` : `Nothing on the site matches “${q}”.`;
  const summary = !q ? (
    'Search the words on every page, the shared header and footer, and where their links go.'
  ) : !settled ? (
    'Searching…'
  ) : !matches.length ? (
    caseless && !doneHere ? `${emptyHead} ${matchCount(caseless)} ${caseless === 1 ? 'differs' : 'differ'} only in capitals.` : emptyHead
  ) : (
    <>
      <strong>{matchCount(matches.length)}</strong> {placesText(groups, true, samePages)}
      {facts.map((f, i) => (
        <span key={f}>
          {' '}
          <span className="find-fact">
            ·{' '}
            <span className={i === 0 && replaceable ? 'find-fact-chosen' : undefined}>{f}</span>
          </span>
        </span>
      ))}
      {facts.length ? '' : '.'}
    </>
  );
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));

  // The footer says what the action will do, or what it is waiting for.
  const sharedChosen = plan && !plan.error ? groupsOf(chosen.filter((m) => !unchanged(m))).filter((g) => g.shared) : [];
  const footNote = !replacing ? (
    matches.length && !replaceable && settled ? (
      <span className="find-foot-note">
        <Lock aria-hidden />
        Open each match to change it in the inspector.
      </span>
    ) : null
  ) : readOnly ? (
    <span className="find-foot-note">This project is open for viewing only.</span>
  ) : aiBusy ? (
    <span className="find-foot-note">Wait for the assistant to finish changing the site.</span>
  ) : matches.length && !replaceable && settled ? (
    <span className="find-foot-note">
      <Lock aria-hidden />
      Open each match to change it in the inspector.
    </span>
  ) : replaceable && !chosen.length && settled ? (
    <span className="find-foot-note">
      <CircleAlert aria-hidden />
      Choose at least one match to {verb.toLowerCase()}.
    </span>
  ) : hasRefused && !canLeaveOutLinks ? (
    <span className="find-foot-note find-foot-refused">
      <CircleAlert aria-hidden />
      Type a new address for {refused.size === 1 ? 'this link' : `these ${refused.size} links`}.
    </span>
  ) : canLeaveOutLinks ? (
    <span className="find-foot-note find-foot-refused">
      <CircleAlert aria-hidden />
      Leave out {refused.size === 1 ? 'the link' : `the ${refused.size} links`} to {verb.toLowerCase()} {matchCount(effective)}.
    </span>
  ) : plan && !plan.error && chosen.length && !effective ? (
    <span className="find-foot-note">
      <CircleCheck aria-hidden />
      Every chosen match already reads this way.
    </span>
  ) : sharedChosen.length ? (
    <span className="find-foot-note find-foot-shared">
      {sharedChosen.length === 1 && sharedChosen[0].shell === 'footer' ? <PanelBottom aria-hidden /> : <PanelTop aria-hidden />}
      {sharedChosen.length === 2 && samePages
        ? `Changes the shared header and footer on ${plural(sharedChosen[0].pages ?? 0, 'page')}.`
        : `Changes ${sharedChosen.map((g) => `the shared ${g.shell} on ${plural(g.pages ?? 0, 'page')}`).join(' and ')}.`}
    </span>
  ) : null;
  const footId = `${summaryId}-foot`;
  // A long list gets a row of its places, so every page is one click away without scrolling past the first.
  const dense = settled && groups.length > 2 && matches.length > 10;
  const jumpTo = (key: string) => {
    setCollapsed((c) => {
      const next = new Set(c);
      next.delete(key);
      return next;
    });
    requestAnimationFrame(() => {
      const list = listRef.current;
      const section = list?.querySelector<HTMLElement>(`[data-group="${CSS.escape(key)}"]`);
      if (!list || !section) return;
      // Scrolled so the group's own heading is the one held at the top, not the previous group's.
      list.scrollTop += section.getBoundingClientRect().top - list.getBoundingClientRect().top - 12;
      section.querySelector<HTMLElement>('.find-toggle')?.focus({ preventScroll: true });
    });
  };

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
          <span className="grow find-foot" id={footId}>
            {footNote}
          </span>
          <button className="btn" onClick={close} disabled={busy}>
            Close
          </button>
          {replacing ? (
            <button ref={actionRef} className="btn btn-primary" disabled={!canReplace} onClick={() => void replace()} aria-describedby={footNote ? footId : undefined} title={`${verb} the chosen matches (${mod}↩)`}>
              {busy ? (removing ? 'Removing…' : 'Replacing…') : `${verb} ${matchCount(effective)}`}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!replaceable || !settled || finished?.phase === 'undoing'} onClick={startReplacing} aria-describedby={footNote ? footId : undefined} title={`Choose matches and what replaces them (${mod}↩)`}>
              Replace…
            </button>
          )}
        </>
      }
    >
      <div className={`col find-body${filled ? ' filled' : ''}`}>
        <div className="find-fields">
          <label className="find-label" htmlFor={findId}>
            Find
          </label>
          <input id={findId} ref={findRef} className="input find-input" autoFocus value={query} readOnly={busy} placeholder="Words or an address, such as books@example.org" onChange={(e) => setQuery(e.target.value)} onKeyDown={onFindKey} />
          <label className="find-case">
            <input type="checkbox" checked={matchCase} disabled={sampleShown || busy} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
          </label>
          {sampleShown && (
            <p className="find-hint" data-testid="find-sample-note">
              Every place the published website shows the starter’s sample {sample!.kind === 'email' ? 'email address' : sample!.kind === 'phone' ? 'phone number, as written and as its links dial it' : 'street address'}. Change the search to find anything else.
            </p>
          )}
          {replacing && (
            <>
              <label className="find-label" htmlFor={replaceId}>
                Replace with
              </label>
              <input
                id={replaceId}
                ref={replaceRef}
                className="input find-input"
                value={replacement}
                readOnly={busy}
                placeholder={touched && !plan?.error ? 'Empty: the words will be removed' : 'The new words'}
                aria-invalid={!!plan?.error}
                aria-describedby={plan?.error ? errorId : undefined}
                onKeyDown={onReplaceKey}
                onChange={(e) => {
                  setApplyFailed(false);
                  // Clearing the field is not a request to remove the words: only "remove these words" is.
                  if (!e.target.value) setTouched(false);
                  setReplacement(e.target.value);
                  setFinished((f) => (f?.phase === 'undone' ? null : f));
                }}
              />
            </>
          )}
          {replacing && !preview && replaceable > 0 && (
            <p className="find-hint">
              Type the new words, or{' '}
              <button
                className="link-btn"
                onClick={() => {
                  setApplyFailed(false);
                  setTouched(true);
                  replaceRef.current?.focus();
                }}
              >
                remove these words
              </button>{' '}
              instead.
            </p>
          )}
          {/* Mounted throughout, so a refusal that appears as the author types is announced. */}
          <div className="find-error" id={errorId} role="status">
            {preview && plan?.error && (
              <>
                <CircleAlert aria-hidden />
                <span className="grow">
                  {canLeaveOutLinks ? `${refused.size === 1 ? 'A link' : `${refused.size} links`} can’t be left empty. Type a new address, or leave ${refused.size === 1 ? 'it' : 'them'} out to remove only the words.` : plan.error}
                </span>
                {canLeaveOutLinks && (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setMany(chosen.filter((m) => refused.has(m.id)), false);
                      replaceRef.current?.focus();
                    }}
                  >
                    {refused.size === 1 ? 'Leave out the link' : 'Leave out the links'}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="find-error" role="alert">
            {applyFailed && (
              <>
                <CircleAlert aria-hidden />
                <span className="grow">The {removing ? 'removal' : 'replacement'} didn’t go through. Check the matches and try again.</span>
              </>
            )}
          </div>
        </div>
        <div className={`find-result${finished ? ' on' : ''}${finished?.phase === 'failed' ? ' failed' : ''}`}>
          {finished && (finished.phase === 'failed' ? <CircleAlert aria-hidden /> : finished.phase === 'done' ? <CircleCheck aria-hidden /> : <Undo2 aria-hidden />)}
          <div className="find-result-text">
            <p role="status">{result}</p>
            {finished?.phase === 'done' && (
              <span className="find-excerpt find-result-change" id={`${summaryId}-change`}>
                <del>{finished.from}</del>
                {finished.more > 0 && <span className="find-result-left"> and {finished.more} more</span>}
                <Becomes to={finished.to} />
                {finished.also > 0 && <span className="find-result-left"> · also {plural(finished.also, 'other field')}</span>}
                {finished.leftOut > 0 && <span className="find-result-left"> · {finished.leftOut === 1 ? '1 match left as it was' : `${finished.leftOut} matches left as they were`}</span>}
              </span>
            )}
          </div>
          {finished?.phase === 'done' && canUndo && (
            <button className="btn btn-sm" disabled={busy} onClick={() => void undo()} aria-describedby={`${summaryId}-change`}>
              <Undo2 /> Undo
            </button>
          )}
          {finished?.phase === 'failed' && finished.result.entryId && (
            <button className="btn btn-sm" disabled={busy} onClick={() => setState({ modal: { kind: 'history', entryId: finished.result.entryId } })}>
              Open History
            </button>
          )}
        </div>
        <div className={`find-status${empty || (filled && !q) ? ' quiet' : ''}`}>
          <p className="find-summary" id={summaryId} role="status">
            {summary}
          </p>
          {replacing && replaceable > 1 && (
            <button className="btn btn-sm btn-ghost" disabled={!settled || busy} onClick={() => setMany(matches, chosen.length < replaceable)}>
              {chosen.length < replaceable ? <ListChecks aria-hidden /> : <ListX aria-hidden />}
              {chosen.length < replaceable ? 'Choose all' : 'Choose none'}
            </button>
          )}
          {groups.length > 1 && (
            <button className="btn btn-sm btn-ghost" disabled={!settled} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)))}>
              {allCollapsed ? <ChevronsUpDown aria-hidden /> : <ChevronsDownUp aria-hidden />}
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
        </div>
        {dense && (
          <nav className="find-jump" aria-label="Places with matches">
            {groups.map((g) => {
              const allLocked = g.matches.every((m) => m.blocked);
              const JumpIcon = allLocked ? Lock : !g.shared ? FileText : g.shell === 'footer' ? PanelBottom : PanelTop;
              return (
                <button key={g.key} className={`find-jump-item${g.shared ? ' shared' : ''}`} disabled={!settled} onClick={() => jumpTo(g.key)} title={g.where} aria-label={`${g.where}, ${matchCount(g.matches.length)}${allLocked ? ', all need the inspector' : ''}`}>
                  <JumpIcon aria-hidden />
                  <span className="find-jump-name">{g.where}</span>
                  <span className="find-jump-count">{g.matches.length}</span>
                </button>
              );
            })}
          </nav>
        )}
        {filled && (
          <div ref={listRef} className="find-results scroll" aria-busy={!settled} inert={!settled || undefined}>
            {filled && !q && (
              <div className="find-empty">
                <Search aria-hidden />
                <p className="find-empty-head">Search the whole site</p>
                <p>Type words or an address to find them on every page, the shared header and footer, and where their links go.</p>
              </div>
            )}
            {empty && (
              <div className="find-empty">
                {!doneHere && <SearchX aria-hidden />}
                <p className="find-empty-head" aria-hidden>
                  {emptyHead}
                </p>
                <p>
                  {doneHere
                    ? finished?.to.trim()
                      ? 'Search for the new words to see each place they landed.'
                      : 'Every match you chose has been removed.'
                    : caseless
                      ? `${matchCount(caseless)} ${caseless === 1 ? 'differs' : 'differ'} only in capitals.`
                      : 'Check the spelling, or try fewer words.'}
                </p>
                {doneHere && finished?.phase === 'done' && finished.to.trim() && (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setQuery(finished.to);
                      findRef.current?.focus();
                    }}
                  >
                    Search for “{finished.to}”
                  </button>
                )}
                {!doneHere && caseless > 0 && (
                  <button className="btn btn-sm" onClick={() => setMatchCase(false)}>
                    Turn off Match case
                  </button>
                )}
              </div>
            )}
            {alsoChanges.length > 0 && (
              <section className="find-group" aria-label="Also changes">
                <h3 className="find-group-head">
                  <CircleAlert className="find-group-icon" aria-hidden />
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
              const lockedText = `${locked} ${locked === 1 ? 'needs' : 'need'} the inspector`;
              const refusedIn = hasRefused ? g.matches.filter((m) => refused.has(m.id)).length : 0;
              const count = !replacing ? matchCount(g.matches.length) : !eligible.length ? lockedText : `${on} of ${eligible.length} chosen${locked ? ` · ${lockedText}` : ''}${refusedIn ? ` · ${refusedIn} ${refusedIn === 1 ? 'needs' : 'need'} an address` : ''}`;
              const GroupIcon = !g.shared ? FileText : g.shell === 'footer' ? PanelBottom : PanelTop;
              return (
                <section key={g.key} data-group={g.key} className="find-group" aria-label={`${g.where}, ${g.reach.toLowerCase()}`}>
                  <h3 className={`find-group-head${!eligible.length ? ' locked' : ''}`}>
                    {replacing &&
                      (eligible.length ? (
                        <Check aria-label={`Choose ${locked ? 'the replaceable' : 'all'} matches in ${g.where}`} checked={on === eligible.length} mixed={on > 0 && on < eligible.length} disabled={busy} onChange={(e) => setMany(eligible, e.target.checked)} />
                      ) : (
                        <span className="find-check find-lock">
                          <Lock aria-hidden />
                        </span>
                      ))}
                    <button
                      className="find-toggle grow"
                      aria-expanded={open}
                      aria-controls={listId}
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (open) next.add(g.key);
                        else next.delete(g.key);
                        setCollapsed(next);
                      }}
                    >
                      <ChevronRight className="find-chevron" aria-hidden />
                      <GroupIcon className="find-group-icon" aria-hidden />
                      <span className="find-group-name">{g.where}</span>
                      <span className="find-count">{count}</span>
                    </button>
                    {g.shared && (
                      <span className="badge green">
                        <GroupIcon aria-hidden />
                        {g.reach}
                      </span>
                    )}
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
                      const which = nth.get(m.id);
                      // A removal says what the field is left with, worked out for every chosen match in it together.
                      const result = showDiff && !replacement ? literalResult(m, chosen, '') : undefined;
                      const shared = showDiff && !replacement && chosen.filter((c) => c.field.key === m.field.key && c.part === m.part).length > 1;
                      const leaves = note ? null : result !== undefined ? clip(result.replace(/\s+/g, ' ').trim()) : shared ? null : undefined;
                      // An unticked match that changes anyway, because it follows one that was chosen.
                      const follows = replacing && !isOn && !m.blocked ? knockOnFor(m) : undefined;
                      return (
                        <li key={m.id} data-match={m.id} aria-current={m.id === recent ? 'location' : undefined} className={`find-match${m.blocked ? ' blocked' : ''}${replacing && !m.blocked && !isOn ? ' off' : ''}${refusedLink ? ' refused' : ''}${m.id === recent ? ' recent' : ''}`}>
                          {replacing &&
                            (m.blocked ? (
                              <span className="find-check find-lock">
                                <Lock aria-hidden />
                              </span>
                            ) : (
                              <Check aria-labelledby={rowId} checked={isOn} disabled={busy} onChange={(e) => setMany([m], e.target.checked)} />
                            ))}
                          <div className="grow find-match-text" id={rowId}>
                            <span className="find-where">
                              <Path name={shownName} />
                              {which && <span className="find-nth">· {which}</span>}
                              {m.kind === 'link' && (
                                <span className="find-kind">
                                  <Link2 aria-hidden /> Link address
                                </span>
                              )}
                              {m.id === recent && <span className="find-kind find-recent">Last opened</span>}
                            </span>
                            <Excerpt m={m} preview={showDiff} replacement={replacement} leaves={leaves} />
                            {same && <span className="find-note">Already reads this way.</span>}
                            {follows && (
                              <span className="find-note find-follows">
                                Changes anyway, with a match you chose:{' '}
                                <span className="find-excerpt">
                                  <del>{follows.before}</del>
                                  <Becomes to={follows.after} />
                                </span>
                              </span>
                            )}
                            {refusedLink && (
                              <span className="find-note find-refused">
                                <CircleAlert aria-hidden /> A link needs an address.
                              </span>
                            )}
                            {note && <span className="find-note">{note}</span>}
                            {m.blocked && (
                              <span className="find-note find-locked">
                                {!replacing && <Lock aria-hidden />}
                                {m.blocked}
                              </span>
                            )}
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
