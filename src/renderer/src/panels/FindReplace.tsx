import { useDeferredValue, useId, useMemo, useState } from 'react';
import { ArrowRight, Link2, Replace, SquareArrowOutUpRight } from 'lucide-react';
import { Modal, openSection } from '../components/ui';
import { commitOps, getState, setState, toast, undoAction, useStore } from '../store';
import { selectPage } from '../lib/actions';
import { contentFields, contentTarget, findContent, planReplace, type ContentChange, type ContentField, type ContentMatch } from '../lib/find-content';

/** The reveal waiting for the inspector, so a newer one replaces it. */
let pendingReveal = 0;

/** Runs `found` once `find` sees its element, checking each frame for about a second. */
function whenShown(find: () => HTMLElement | null | undefined, found: (el: HTMLElement) => void, onTick?: (frame: number) => void) {
  const token = ++pendingReveal;
  let frame = 0;
  const tick = () => {
    if (token !== pendingReveal) return;
    const el = find();
    if (el) return found(el);
    onTick?.(frame);
    if (++frame < 60) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const CONTROL = 'input, textarea, select, [contenteditable="true"]';
const panel = () => document.getElementById('dock-panel-inspect');

/**
 * Show where a match is: its page (for the shared header and footer, the page on screen when it shows them), the
 * element in the inspector, and the field itself, focused. A field the selection alone does not show (a code
 * component's, or one list item's) is opened in the section's Content.
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
  const reveal = target.reveal;
  if (!reveal) {
    whenShown(
      () => panel()?.querySelector<HTMLElement>(`.section-body :is(${CONTROL})`),
      (el) => el.focus()
    );
    return;
  }
  // The Content section may be closed: open it (again, once the new selection's inspector is there).
  const openContent = (frame: number) => (frame === 1 || frame === 12) && openSection('content');
  if (!reveal.itemId) {
    whenShown(() => panel()?.querySelector<HTMLElement>(`[data-field="${CSS.escape(reveal.prop)}"] :is(${CONTROL})`), (el) => el.focus(), openContent);
    return;
  }
  const head = () => panel()?.querySelector<HTMLElement>(`[data-list="${CSS.escape(reveal.prop)}"] #list-head-${CSS.escape(reveal.itemId!)}`);
  whenShown(
    head,
    (h) => {
      if (h.getAttribute('aria-expanded') !== 'true') h.click();
      whenShown(
        () => panel()?.querySelector<HTMLElement>(`#list-item-${CSS.escape(reveal.itemId!)} ${reveal.field ? `[data-field="${CSS.escape(reveal.field)}"] ` : ''}:is(${CONTROL})`),
        (el) => el.focus()
      );
    },
    openContent
  );
}

/** Where a field is shown: on its own page, or on every page that shows the shared header or footer. */
function reach(f: ContentField): string {
  if (f.sharedPages === undefined) return 'This page only';
  return `Shared ${f.owner.id} · on ${f.sharedPages} page${f.sharedPages === 1 ? '' : 's'}`;
}

/** The result groups: one per page or shared part, in reading order. */
function groupsOf(matches: ContentMatch[]): Array<{ key: string; where: string; reach: string; shared: boolean; matches: ContentMatch[] }> {
  const out = new Map<string, { key: string; where: string; reach: string; shared: boolean; matches: ContentMatch[] }>();
  for (const m of matches) {
    const key = `${m.field.owner.kind}:${m.field.owner.id}`;
    const g = out.get(key) ?? { key, where: m.field.where, reach: reach(m.field), shared: m.field.sharedPages !== undefined, matches: [] };
    g.matches.push(m);
    out.set(key, g);
  }
  return [...out.values()];
}

function ChangeRow({ c }: { c: ContentChange }) {
  return (
    <li className="find-change">
      <span className="find-where">
        {c.field.where} › {c.field.section} › {c.field.label}
        {c.knockOn && <span className="badge amber">Also changes</span>}
      </span>
      <span className="find-diff">
        <del>{c.before || 'Empty'}</del>
        <ArrowRight aria-label="becomes" />
        <ins>{c.after || 'Empty'}</ins>
      </span>
    </li>
  );
}

export function FindReplaceModal({ initial }: { initial?: string }) {
  const snap = useStore((s) => s.snapshot);
  const [query, setQuery] = useState(initial ?? '');
  const [matchCase, setMatchCase] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [replacing, setReplacing] = useState(false);
  // Matches the author unticked. Every other replaceable match is chosen, including ones a later edit adds.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const findId = useId();
  const replaceId = useId();
  const summaryId = useId();
  const searched = useDeferredValue(query);
  const state = snap?.state;
  const fields = useMemo(() => (state ? contentFields(state) : []), [state]);
  const matches = useMemo(() => (state ? findContent(state, searched, { matchCase }, fields) : []), [state, searched, matchCase, fields]);
  const chosen = useMemo(() => matches.filter((m) => !m.blocked && !unticked.has(m.id)), [matches, unticked]);
  // The review is worked out on the project as this render shows it; Replace applies exactly that, or nothing.
  const plan = useMemo(() => (state && replacing && chosen.length ? { ...planReplace(state, chosen, replacement), revision: snap?.revision, workspaceKey: snap?.workspaceKey } : null), [state, replacing, chosen, replacement, snap?.revision, snap?.workspaceKey]);
  const groups = groupsOf(matches);
  const replaceable = matches.filter((m) => !m.blocked).length;
  const readOnly = !!snap?.readOnly;
  const aiBusy = !!snap?.aiBusy;
  const close = () => !busy && setState({ modal: null });
  const toggle = (id: string, on: boolean) => {
    const next = new Set(unticked);
    if (on) next.delete(id);
    else next.add(id);
    setUnticked(next);
  };
  const setAll = (on: boolean) => setUnticked(on ? new Set() : new Set(matches.filter((m) => !m.blocked).map((m) => m.id)));
  const texts = plan?.changes.filter((c) => c.kind === 'text') ?? [];
  const destinations = plan?.changes.filter((c) => c.kind === 'link') ?? [];
  const canReplace = !!plan && !plan.error && plan.operations.length > 0 && !busy && !readOnly && !aiBusy;
  const replace = async () => {
    if (!plan || !canReplace) return;
    setBusy(true);
    let done: Awaited<ReturnType<typeof commitOps>> = null;
    try {
      done = await commitOps(plan.operations, `Replace “${searched.trim()}” with “${replacement}”`, undefined, plan.revision);
    } finally {
      setBusy(false);
    }
    if (!done || getState().snapshot?.workspaceKey !== plan.workspaceKey) return;
    const n = chosen.length;
    toast(`Replaced ${n} match${n === 1 ? '' : 'es'}.`, 'info', undoAction(done));
    setUnticked(new Set());
  };
  const summary = !searched.trim()
    ? 'Search the words on every page, the shared header and footer, and where their links go.'
    : matches.length
      ? `${matches.length} match${matches.length === 1 ? '' : 'es'} on ${groups.length} ${groups.length === 1 ? 'page or shared part' : 'pages and shared parts'}.`
      : `Nothing on the site matches “${searched.trim()}”.`;

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
          {replacing && plan?.error && <span className="field-error grow find-foot-note">{plan.error}</span>}
          {replacing && !plan?.error && (readOnly || aiBusy) && <span className="faint grow find-foot-note">{readOnly ? 'This project is open for viewing only.' : 'Wait for the assistant to finish changing the site.'}</span>}
          <button className="btn" onClick={close} disabled={busy}>
            Close
          </button>
          {replacing ? (
            <button className="btn btn-primary" disabled={!canReplace} onClick={() => void replace()}>
              Replace {chosen.length} match{chosen.length === 1 ? '' : 'es'}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!replaceable} onClick={() => setReplacing(true)}>
              Replace…
            </button>
          )}
        </>
      }
    >
      <div className="col find-body">
        <div className="find-row">
          <label htmlFor={findId}>Find</label>
          <input
            id={findId}
            className="input grow"
            autoFocus
            value={query}
            placeholder="Words or an address, such as books@example.org"
            onChange={(e) => (setQuery(e.target.value), setUnticked(new Set()))}
          />
          <label className="find-case">
            <input type="checkbox" checked={matchCase} onChange={(e) => (setMatchCase(e.target.checked), setUnticked(new Set()))} /> Match case
          </label>
        </div>
        {replacing && (
          <div className="find-row">
            <label htmlFor={replaceId}>Replace with</label>
            <input id={replaceId} className="input grow" autoFocus value={replacement} placeholder="Leave empty to remove the words" onChange={(e) => setReplacement(e.target.value)} />
          </div>
        )}
        <p className="faint find-summary" id={summaryId} role="status">
          {summary}
          {replacing && replaceable > 1 && (
            <>
              {' '}
              <button className="link-btn" onClick={() => setAll(chosen.length < replaceable)}>
                {chosen.length < replaceable ? 'Choose all' : 'Choose none'}
              </button>
            </>
          )}
        </p>
        {groups.length > 0 && (
          <div className="find-results">
            {groups.map((g) => (
              <section key={g.key} className="find-group" aria-label={`${g.where}, ${g.reach.toLowerCase()}`}>
                <h3 className="find-group-head">
                  <span className="grow">{g.where}</span>
                  <span className={`badge${g.shared ? ' plum' : ''}`}>{g.reach}</span>
                </h3>
                <ul>
                  {g.matches.map((m) => {
                    const name = `${m.field.section} › ${m.field.label}`;
                    return (
                      <li key={m.id} className="find-match">
                        {replacing && <input type="checkbox" aria-label={`Replace in ${name}`} checked={!m.blocked && !unticked.has(m.id)} disabled={!!m.blocked} title={m.blocked} onChange={(e) => toggle(m.id, e.target.checked)} />}
                        <div className="grow find-match-text">
                          <span className="find-where">
                            {m.kind === 'link' && <Link2 aria-label="Destination:" />}
                            {name}
                          </span>
                          <span className="find-excerpt">
                            {m.before}
                            <mark>{m.match}</mark>
                            {m.after}
                          </span>
                          {m.blocked && <span className="faint find-note">{m.blocked}</span>}
                        </div>
                        <button className="btn btn-sm" onClick={() => openContentMatch(m.field)} title="Show it on the page and in the inspector">
                          <SquareArrowOutUpRight /> Open
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
        {replacing && plan && !plan.error && plan.changes.length > 0 && (
          <div className="find-review">
            <h3>Review</h3>
            {texts.length > 0 && (
              <>
                <p className="faint">Text that will change</p>
                <ul aria-label="Text that will change">
                  {texts.map((c, i) => (
                    <ChangeRow key={i} c={c} />
                  ))}
                </ul>
              </>
            )}
            <p className="faint">{destinations.length ? 'Destinations that will change' : 'No link destinations will change. Link labels stay as they are unless their own words were chosen.'}</p>
            {destinations.length > 0 && (
              <ul aria-label="Destinations that will change">
                {destinations.map((c, i) => (
                  <ChangeRow key={i} c={c} />
                ))}
              </ul>
            )}
            <p className="faint">Everything above is one change: one Undo puts it all back.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
