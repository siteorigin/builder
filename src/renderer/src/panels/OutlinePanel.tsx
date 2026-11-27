import { useId, useMemo, useRef, useState } from 'react';
import { CircleCheck, FileText, Info, PanelBottom, PanelTop, Plus, TriangleAlert } from 'lucide-react';
import { sameRef, type ElementRef, type ProjectState } from '@shared/types';
import type { OutlineHeading } from '@generator/checks';
import { applyOps, getState, setState, useStore, type InspectorFocus } from '../store';
import { openInsertSearch } from '../lib/insert-focus';
import { headingLevelOps, headingTarget, headingWords, pageOutline, type OutlineRow } from '../lib/outline';
import { BlockedNote, BlockedStatus, useProjectBlock } from '../components/BlockedNote';

const WHERE: Record<string, string> = { header: 'Shared header', footer: 'Shared footer' };

/** What a flagged row is flagged for, for its badge and its accessible name. */
function rowFlag(r: OutlineRow): string | null {
  if (r.extraTitle) return r.heading.repeated && !r.fix ? 'Heading 1 shown more than once' : 'Another Heading 1';
  if (r.skip) return `Skips Heading ${r.skip.suggest}`;
  return null;
}

/** Why a heading's level is not offered for change here. */
function fixedWhy(h: OutlineHeading): string {
  if (h.rich) return 'A subheading inside rich text: change its level in the text.';
  if (h.levelSource) return '';
  return h.owner.kind === 'shell' ? 'Its level is part of the shared header’s or footer’s design.' : 'Its level is part of the component’s design. Edit the component everywhere to change it.';
}

/** The level that settles a flagged heading. */
const wanted = (r: OutlineRow) => r.skip?.suggest ?? 2;

/** Whether a placement's level field offers the level that settles a flagged heading. */
const offered = (r: OutlineRow) => !r.heading.levels || r.heading.levels.includes(wanted(r));

/** The next step for a flagged heading that has no one-click fix here. */
function flagHint(r: OutlineRow): string | null {
  const h = r.heading;
  if (r.fix || !(r.extraTitle || r.skip)) return null;
  if (r.extraTitle && h.repeated) return 'It repeats on this page, so each copy counts as another title. Give it a lower level, and the page a title shown once.';
  const n = wanted(r);
  // Rich text writes a subheading's level as the hashes that start its line ("### " is Heading 3, "#### " Heading 4);
  // it has no Heading 1, 5 or 6, and Heading 2 only in an article's text.
  if (h.rich) {
    if (n === 3 || n === 4) return `In the Inspector, change the “${'#'.repeat(h.level)}” at the start of its line in the text to “${'#'.repeat(n)}”.`;
    // Text can't reach Heading 2 itself: a Heading 2 above it settles the skip, with this one moved up to 3 if it is deeper.
    return h.level > 3
      ? `Text holds only Heading 3 and 4 subheadings: add a Heading ${n} above it, then change its “${'#'.repeat(h.level)}” to “###”.`
      : `Text holds only Heading 3 and 4 subheadings: add a Heading ${n} above this one instead.`;
  }
  if (!h.levelSource) return fixedWhy(h);
  if (!offered(r)) return `Its design doesn’t offer Heading ${n} here. Edit the component everywhere to allow it.`;
  return r.sharedLevel
    ? `One setting chooses the level of several headings here, so changing it to Heading ${n} in the Inspector changes them together.`
    : `Change it to Heading ${n} in the Inspector.`;
}

/** The placement field that sets a heading's level, for the Inspector to open with focus on it, when it can. */
function levelField(state: ProjectState, h: OutlineHeading): Omit<InspectorFocus, 'seq' | 'at' | 'opening'> | null {
  const src = h.levelSource;
  const target = headingTarget(state, h);
  if (src?.kind !== 'prop' || target.nodeId !== h.nodeId || target.instancePath.length !== 0) return null;
  return { owner: h.owner, nodeId: h.nodeId, prop: src.prop, ...(src.itemId !== undefined ? { itemId: src.itemId, field: src.field } : {}), label: 'Heading level' };
}

/** Whether a flagged heading's level is changed in a field the Inspector can open with focus on it, so the row leads there. */
const editable = (state: ProjectState, r: OutlineRow) => !r.fix && !!(r.extraTitle || r.skip) && !(r.extraTitle && r.heading.repeated) && !r.heading.rich && offered(r) && !!levelField(state, r.heading);

/** "A second Heading 1 and a skipped level": what the page's flagged headings are, in one phrase. */
function diagnosis(rows: OutlineRow[]): string {
  const titles = rows.filter((r) => r.extraTitle).length;
  const skips = rows.filter((r) => r.skip && !r.extraTitle).length;
  const parts = [titles ? (titles === 1 ? 'a second Heading 1' : `${titles} more Heading 1s`) : '', skips ? (skips === 1 ? 'a skipped level' : `${skips} skipped levels`) : ''].filter(Boolean);
  const text = parts.join(' and ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const rowSelector = (key: string) => `.outline-list .outline-row[data-heading="${CSS.escape(key)}"]`;

/**
 * The current page's headings as visitors' screen readers list them: each with its level and words, indented by
 * level, selectable, and flagged where the page has a second title or skips a level, with a one-step fix that changes
 * the level and never the look.
 *
 * The list is one tab stop, like the Layers tree beside it: the row focus is on (else the selected heading's, else
 * the first) takes Tab; ↑/↓/Home/End and typing a heading's first letters move between rows and select as they go;
 * and Tab from a focused row reaches its own next step before leaving the list.
 */
export function OutlinePanel({ pageId }: { pageId: string }) {
  const snap = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const state = snap?.state;
  const outline = useMemo(() => (state && Object.hasOwn(state.pages, pageId) ? pageOutline(state, pageId) : null), [state, pageId]);
  // The row focus is on while it is in the list; it takes Tab ahead of the selection, so Tab reaches its own fix.
  const [focused, setFocused] = useState<string | null>(null);
  // The row chosen here, with the selection it made: it stays the marked row only while that selection stands.
  const [picked, setPicked] = useState<{ key: string; selection: ElementRef } | null>(null);
  const uid = useId();
  const typed = useRef({ text: '', at: 0 });
  // Held (read-only, or the AI changing the site), nothing here can be fixed: why is said once on its own note, and no
  // warning promises a fix.
  const hold = useProjectBlock('change heading levels');
  if (!snap || !state || !outline) return null;
  const page = state.pages[pageId];
  const { rows, review, titleFix } = outline;
  // Read-only, or held while the AI changes the site: no level can be changed, so no fix is offered.
  const held = !!snap.readOnly || !!snap.aiBusy;
  const revision = snap.revision;

  // Several headings can select one element (subheadings in one text): the row chosen here is the one marked current.
  const select = (r: OutlineRow) => {
    const target = headingTarget(state, r.heading);
    setPicked({ key: r.key, selection: target });
    setState({ mode: 'edit', selection: target, rightTab: 'inspect', dockOpen: true });
  };
  /**
   * Edit a flagged heading's level where it is set: select it, and open the placement's field that sets it in the
   * Inspector with focus on it. A heading in rich text is changed in its text, which the row's hint says how.
   */
  const editLevel = (r: OutlineRow) => {
    const field = levelField(state, r.heading);
    if (!field) return;
    const target = headingTarget(state, r.heading);
    setPicked({ key: r.key, selection: target });
    setState({ mode: 'edit', selection: target, rightTab: 'inspect', dockOpen: true, inspectorFocus: { seq: Date.now(), at: Date.now(), opening: snap.workspaceKey, ...field } });
  };
  /**
   * Give a heading another level. Focus stays in the outline, on the same heading's row once it has its new level,
   * unless the edit did not land or another page is shown by then.
   */
  const setLevel = (row: OutlineRow, level: number) => {
    const h = row.heading;
    const ops = headingLevelOps(h, level);
    if (!ops) return;
    const key = row.key;
    void applyOps(ops, `Make “${headingWords(h)}” Heading ${level}`, undefined, revision).then((done) => {
      if (!done || getState().pageId !== pageId) return;
      requestAnimationFrame(() => document.querySelector<HTMLElement>(rowSelector(key))?.focus());
    });
  };

  const flaggedRows = rows.filter((r) => r.extraTitle || r.skip);
  const flagged = flaggedRows.length;
  // Lead to the first heading to check: select it on the page, and put focus on its row with its next step below.
  const goToFirst = () => {
    const first = flaggedRows[0];
    if (!first) return;
    select(first);
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(rowSelector(first.key));
      row?.focus();
      // The heading with its next step below it.
      row?.closest('.outline-item')?.scrollIntoView({ block: 'nearest' });
    });
  };

  // The selected heading's row: the one picked here when it is among those that select it, else the first of them.
  const matching = rows.filter((r) => sameRef(selection, headingTarget(state, r.heading)));
  const current = (picked?.selection === selection ? matching.find((r) => r.key === picked.key) : undefined) ?? matching[0];
  // The one row that takes Tab: the one focus is on, else the selected heading's, else the first.
  const stop = (focused && rows.some((r) => r.key === focused) ? focused : null) ?? current?.key ?? rows[0]?.key;

  const onListKey = (e: React.KeyboardEvent<HTMLOListElement>) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains('outline-row') || e.altKey || e.metaKey || e.ctrlKey) return;
    const at = rows.findIndex((r) => r.key === t.dataset.heading);
    if (at < 0) return;
    let to = -1;
    if (!e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
      to = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    } else if (e.key.length === 1 && (e.key !== ' ' || Date.now() - typed.current.at < 700)) {
      // Typing a heading's first letters jumps to the next one they start; a repeated letter cycles through them.
      const now = Date.now();
      const key = e.key.toLowerCase();
      let text = (now - typed.current.at < 700 ? typed.current.text : '') + key;
      // The same letter again steps to the next heading starting with it, as in Layers, rather than looking for "hh".
      if (text.length > 1 && [...text].every((c) => c === key)) text = key;
      typed.current = { text, at: now };
      const start = text.length === 1 ? at + 1 : at;
      const order = [...rows.slice(start), ...rows.slice(0, start)];
      const hit = order.find((r) => headingWords(r.heading).toLowerCase().startsWith(text));
      if (!hit) return;
      to = rows.indexOf(hit);
    } else return;
    e.preventDefault();
    if (to === at) return;
    const next = rows[to];
    select(next);
    const row = document.querySelector<HTMLElement>(rowSelector(next.key));
    row?.focus();
    // The whole heading, with its next step below it, comes into view.
    row?.closest('.outline-item')?.scrollIntoView({ block: 'nearest' });
  };
  const onListBlur = (e: React.FocusEvent<HTMLOListElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
  };

  const promise = held ? '' : 'Changing a level never changes how a heading looks.';
  const goTo =
    flagged > 0 ? (
      <button className="btn btn-sm outline-summary-action" onClick={goToFirst}>
        {flagged === 1 ? 'Go to it' : 'Go to the first one'}
      </button>
    ) : null;
  const summary = review.missingTitle ? (
    <div className="scope-note instance outline-check" role="note">
      <TriangleAlert aria-hidden="true" />
      <span className="grow">
        <strong>No main heading.</strong> Screen readers have no Heading 1 to start from. {promise}
        {!titleFix && !held && rows.length > 0 && ' In the Inspector, choose Heading 1 for the heading that titles this page, or add a section that starts with a title.'}
        {flagged > 0 && ` ${flagged === 1 ? 'One heading also skips a level' : `${flagged} headings also skip a level`}.`}
        {titleFix && !held ? (
          <button className="btn btn-sm outline-summary-action" onClick={() => setLevel(titleFix, 1)}>
            Make “{headingWords(titleFix.heading)}” Heading 1
          </button>
        ) : (
          goTo
        )}
      </span>
    </div>
  ) : flagged ? (
    <div className="scope-note instance outline-check" role="note">
      <TriangleAlert aria-hidden="true" />
      <span className="grow">
        <strong>{diagnosis(rows)}.</strong> {promise}
        {goTo}
      </span>
    </div>
  ) : !review.titles.length && outline.uninspected ? (
    <div className="scope-note info" role="note">
      <Info aria-hidden="true" />
      <span className="grow">No Heading 1 is listed. Custom code on this page may show one; check the page in Preview.</span>
    </div>
  ) : !review.titles.length && rows.length > 0 && rows.every((r) => r.heading.owner.kind === 'shell') ? (
    <div className="scope-note info" role="note">
      <Info aria-hidden="true" />
      <span className="grow">
        This page has no headings of its own yet. Its title should be its one Heading 1.
        {!held && (
          <button className="btn btn-sm outline-summary-action" onClick={openInsertSearch}>
            <Plus aria-hidden="true" /> Add sections
          </button>
        )}
      </span>
    </div>
  ) : review.titles.length ? (
    <div className="scope-note info outline-ok" role="note">
      <CircleCheck aria-hidden="true" />
      <span className="grow">One main heading, no skipped levels.</span>
    </div>
  ) : null;

  // "Main heading" only tells the page's title apart where another Heading 1 could be taken for it.
  const titled = rows.some((r) => r.extraTitle);

  return (
    <div className="panel-body outline-view" aria-label={`Headings on ${page.title}`} role="region" tabIndex={-1}>
      {/* A fix that settles the last flag changes the summary while focus stays on the row: it is announced. */}
      {/* Said by its own status, outside the summary's live region, so it is heard once. */}
      <BlockedStatus block={hold} lifted="You can change heading levels now." />
      {hold && <BlockedNote block={hold} live={false} className="outline-held" />}
      <div className="outline-summary" aria-live="polite">
        {summary}
      </div>
      {rows.length === 0 ? (
        <div className="outline-empty">
          <p>
            <strong>No headings yet.</strong> Start with one Heading 1 as the page’s title, then a Heading 2 for each section.
          </p>
          {!held && (
            <button className="btn btn-sm" onClick={openInsertSearch}>
              <Plus aria-hidden="true" /> Add sections
            </button>
          )}
        </div>
      ) : (
        <ol className="outline-list" onKeyDown={onListKey} onBlur={onListBlur}>
          {rows.map((r, i) => {
            const h = r.heading;
            const flag = rowFlag(r);
            const prev = rows[i - 1]?.heading.owner;
            // Labels where the shared header's or footer's headings start, and where the page's own start after the header's.
            const group = h.owner.kind === 'shell' ? (prev?.kind !== 'shell' || prev.id !== h.owner.id ? WHERE[h.owner.id] : null) : prev?.kind === 'shell' ? 'Page content' : null;
            const words = headingWords(h);
            const why = fixedWhy(h);
            // A held project says why once, above the list, rather than offering edits on every row.
            const hint = held ? null : flagHint(r);
            const shellName = h.owner.kind === 'shell' ? WHERE[h.owner.id] : null;
            const mainNote = r.title && titled ? 'Main heading' : null;
            const tab = r.key === stop ? 0 : -1;
            const isCurrent = r === current;
            const hintId = hint ? `${uid}-hint-${i}` : undefined;
            // The fix is a stop only while focus is on its heading, so Shift+Tab into the list reaches the heading first.
            const fixTab = focused === r.key ? 0 : -1;
            return (
              <li key={r.key} className={h.owner.kind === 'shell' ? 'shared' : undefined} style={{ '--level': h.level } as React.CSSProperties}>
                {/* Each of its rows says it is shared, so the label is for the eye only; it matches Layers' own. */}
                {group && (
                  <span className="outline-group" aria-hidden="true">
                    {h.owner.kind === 'page' ? <FileText /> : h.owner.id === 'header' ? <PanelTop /> : <PanelBottom />}
                    {group}
                  </span>
                )}
                <div className="outline-item">
                  <button
                    className={`outline-row${flag ? ' warn' : ''}`}
                    data-heading={r.key}
                    data-node={h.nodeId}
                    data-level={h.level}
                    tabIndex={tab}
                    aria-current={isCurrent ? 'true' : undefined}
                    aria-label={`Heading ${h.level}, ${words}${flag ? `. ${flag}` : mainNote ? `. ${mainNote}` : ''}${h.repeated && !r.extraTitle ? '. Shown more than once' : ''}${shellName ? `. ${shellName}` : ''}`}
                    aria-describedby={hintId}
                    // The full words, which a long heading's row clamps; why its level is set elsewhere only where it can be changed.
                    title={why && !held ? `${words}\n${why}` : words}
                    onFocus={() => setFocused(r.key)}
                    onClick={() => select(r)}
                  >
                    <span className="outline-level" aria-hidden="true">
                      H{h.level}
                    </span>
                    <span className="outline-text">
                      <span className={`outline-words${h.text ? '' : ' empty'}`}>{words}</span>
                      {(flag || mainNote) && (
                        <span className={`badge${flag ? ' amber' : ''}`} aria-hidden="true">
                          {flag && <TriangleAlert />}
                          {flag ?? mainNote}
                        </span>
                      )}
                    </span>
                  </button>
                  {!held && (r.fix || hint) && (
                    <div className="outline-next">
                      {hint && (
                        <span className="outline-hint" id={hintId}>
                          {hint}
                        </span>
                      )}
                      {r.fix && (
                        <button className="btn btn-sm" tabIndex={fixTab} aria-label={`Make Heading ${r.fix}: ${words}`} title="Changes the heading’s level in the page outline; it looks the same" onClick={() => setLevel(r, r.fix!)}>
                          Make Heading {r.fix}
                        </button>
                      )}
                      {editable(state, r) && (
                        <button className="btn btn-sm" tabIndex={fixTab} aria-label={`Open its level in the Inspector: ${words}`} onClick={() => editLevel(r)}>
                          Open in Inspector
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {outline.uninspected && <p className="muted outline-note">Headings inside custom code components are not listed here.</p>}
    </div>
  );
}
