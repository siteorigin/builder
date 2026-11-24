import { useMemo } from 'react';
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { sameRef } from '@shared/types';
import type { OutlineHeading } from '@generator/checks';
import { applyOps, getState, setState, useStore, type InspectorFocus } from '../store';
import { headingLevelOps, headingTarget, headingWords, pageOutline, type OutlineRow } from '../lib/outline';

const WHERE: Record<string, string> = { header: 'Shared header', footer: 'Shared footer' };

/** "Heading 1 is the page title" and the like, for a row's visible note and its accessible name. */
function rowNote(r: OutlineRow): { text: string; warn: boolean } | null {
  if (r.extraTitle) return { text: r.heading.repeated && !r.fix ? 'Heading 1 shown more than once' : 'Another Heading 1', warn: true };
  if (r.skip) return { text: `Skips Heading ${r.skip.suggest}`, warn: true };
  if (r.title) return { text: 'Main heading', warn: false };
  return null;
}

/** Why a heading's level is not offered for change here. */
function fixedWhy(h: OutlineHeading): string {
  if (h.rich) return 'A subheading inside rich text: change its level in the text.';
  if (h.levelSource) return '';
  return h.owner.kind === 'shell' ? 'Set by the shared header or footer’s design.' : 'Set by the component’s design. Update its theme component, or edit the design everywhere, to choose another level.';
}

/** The next step for a flagged heading that has no one-click fix here. */
function flagHint(r: OutlineRow): string | null {
  const h = r.heading;
  if (r.fix || !(r.extraTitle || r.skip)) return null;
  if (r.extraTitle && h.repeated) return 'It repeats on this page, so it counts as a second title.';
  const level = `Heading ${r.skip?.suggest ?? 2}`;
  if (h.rich) return `Change it to ${level} in the text.`;
  return h.levelSource ? `Change it to ${level} in the Inspector.` : fixedWhy(h);
}

/** Whether a flagged heading's level is changed where the heading is edited, so the row can lead there. */
const editable = (r: OutlineRow) => !r.fix && !!(r.extraTitle || r.skip) && !(r.extraTitle && r.heading.repeated) && (!!r.heading.rich || !!r.heading.levelSource);

/**
 * The current page's headings as visitors' screen readers list them: each with its level and words, indented by
 * level, selectable, and flagged where the page has a second title or skips a level, with a one-step fix that changes
 * the level and never the look.
 */
export function OutlinePanel({ pageId }: { pageId: string }) {
  const snap = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const state = snap?.state;
  const outline = useMemo(() => (state && Object.hasOwn(state.pages, pageId) ? pageOutline(state, pageId) : null), [state, pageId]);
  if (!snap || !state || !outline) return null;
  const page = state.pages[pageId];
  const { rows, review, titleFix } = outline;
  const readOnly = !!snap.readOnly;
  const revision = snap.revision;

  const select = (h: OutlineHeading) => setState({ mode: 'edit', selection: headingTarget(state, h), rightTab: 'inspect', dockOpen: true });
  /**
   * Edit a flagged heading's level where it is set: select it, and when a placement's field sets it, open that field in
   * the Inspector with focus on it. A heading in rich text is changed in its text, which the row's hint says.
   */
  const editLevel = (h: OutlineHeading) => {
    const target = headingTarget(state, h);
    const src = h.levelSource;
    const focus: InspectorFocus | undefined =
      src?.kind === 'prop' && target.nodeId === h.nodeId && target.instancePath.length === 0
        ? { seq: Date.now(), at: Date.now(), opening: snap.workspaceKey, owner: h.owner, nodeId: h.nodeId, prop: src.prop, ...(src.itemId !== undefined ? { itemId: src.itemId, field: src.field } : {}), label: 'Heading level' }
      : undefined;
    setState({ mode: 'edit', selection: target, rightTab: 'inspect', dockOpen: true, ...(focus ? { inspectorFocus: focus } : {}) });
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
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`.outline-list .outline-row[data-heading="${CSS.escape(key)}"]`)?.focus());
    });
  };

  const flaggedRows = rows.filter((r) => r.extraTitle || r.skip);
  const flagged = flaggedRows.length;
  // Lead to the first heading to check: select it on the page, and put focus on its row with its next step below.
  const goToFirst = () => {
    const first = flaggedRows[0];
    if (!first) return;
    select(first.heading);
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`.outline-list .outline-row[data-heading="${CSS.escape(first.key)}"]`);
      row?.focus();
      row?.scrollIntoView({ block: 'nearest' });
    });
  };
  const promise = readOnly ? 'This project is read-only, so levels can’t be changed here.' : 'Changing a level never changes how a heading looks.';
  const summary = review.missingTitle ? (
    <div className="scope-note site" role="note">
      <TriangleAlert aria-hidden="true" />
      <span className="grow">
        <strong>No main heading.</strong> Screen readers have no Heading 1 to start from. {promise}
        {!titleFix && !readOnly && rows.length > 0 && ' Select the heading that titles this page, then make it Heading 1 in the Inspector or in its text.'}
        {(!titleFix || readOnly) && flagged > 0 && ` ${flagged === 1 ? 'One heading also skips a level' : `${flagged} headings also skip a level`}.`}
        {titleFix && !readOnly ? (
          <button className="btn btn-sm outline-summary-action" onClick={() => setLevel(titleFix, 1)}>
            Make “{headingWords(titleFix.heading)}” Heading 1
          </button>
        ) : flagged > 0 ? (
          <button className="btn btn-sm outline-summary-action" onClick={goToFirst}>
            {flagged === 1 ? 'Go to it' : 'Go to the first one'}
          </button>
        ) : null}
      </span>
    </div>
  ) : flagged ? (
    <div className="scope-note site" role="note">
      <TriangleAlert aria-hidden="true" />
      <span className="grow">
        <strong>
          {flagged} heading{flagged === 1 ? '' : 's'} to check.
        </strong>{' '}
        {promise}
        <button className="btn btn-sm outline-summary-action" onClick={goToFirst}>
          {flagged === 1 ? 'Go to it' : 'Go to the first one'}
        </button>
      </span>
    </div>
  ) : !review.titles.length && outline.uninspected ? (
    <div className="scope-note instance" role="note">
      <Info aria-hidden="true" />
      <span className="grow">No Heading 1 is listed. Custom code on this page may show one; check the page in Preview.</span>
    </div>
  ) : !review.titles.length && rows.length > 0 && rows.every((r) => r.heading.owner.kind === 'shell') ? (
    <div className="scope-note instance" role="note">
      <Info aria-hidden="true" />
      <span className="grow">This page has no headings of its own.</span>
    </div>
  ) : review.titles.length ? (
    <div className="scope-note shared" role="note">
      <CircleCheck aria-hidden="true" />
      <span className="grow">One main heading, no skipped levels.</span>
    </div>
  ) : null;

  return (
    <div className="panel-body outline-view" aria-label={`Headings on ${page.title}`} role="region" tabIndex={-1}>
      {summary && <div className="outline-summary">{summary}</div>}
      {rows.length === 0 ? (
        <div className="outline-summary">
          <div className="scope-note instance outline-empty" role="note">
            <Info aria-hidden="true" />
            <span className="grow">
              <strong>No headings on this page yet.</strong> A page reads best with one Heading 1 as its title, then Heading 2s for its sections. They’ll be listed here as you add them.
            </span>
          </div>
        </div>
      ) : (
        <ol className="outline-list">
          {rows.map((r, i) => {
            const h = r.heading;
            const note = rowNote(r);
            const target = headingTarget(state, h);
            const prev = rows[i - 1]?.heading.owner;
            const group = h.owner.kind === 'shell' && (prev?.kind !== 'shell' || prev.id !== h.owner.id) ? WHERE[h.owner.id] : null;
            const words = headingWords(h);
            const why = fixedWhy(h);
            // A read-only project says so once, above the list, rather than offering edits on every row.
            const hint = readOnly ? null : flagHint(r);
            const shellName = h.owner.kind === 'shell' ? WHERE[h.owner.id] : null;
            return (
              <li key={i} className={h.owner.kind === 'shell' ? 'shared' : undefined} style={{ '--level': h.level } as React.CSSProperties}>
                {/* Each of its rows says it is shared, so the label is for the eye only. */}
                {group && (
                  <span className="outline-group" aria-hidden="true">
                    {group}
                  </span>
                )}
                <div className="outline-item">
                  <button
                    className={`outline-row${note?.warn ? ' warn' : ''}`}
                    data-heading={r.key}
                    data-node={h.nodeId}
                    data-level={h.level}
                    aria-current={sameRef(selection, target) ? 'true' : undefined}
                    aria-label={`Heading ${h.level}, ${words}${note ? `. ${note.text}` : ''}${h.repeated && !r.extraTitle ? '. Shown more than once' : ''}${hint ? `. ${hint}` : ''}${shellName ? `. ${shellName}` : ''}`}
                    // The full words, which a long heading's row clamps; why its level is set elsewhere only where it can be changed.
                    title={why && !readOnly ? `${words}\n${why}` : words}
                    onClick={() => select(h)}
                  >
                    <span className="outline-level" aria-hidden="true">
                      H{h.level}
                    </span>
                    <span className="outline-text">
                      <span className={`outline-words${h.text ? '' : ' empty'}`}>{words}</span>
                      {note && (
                        <span className={`badge ${note.warn ? 'amber' : 'green'}`} aria-hidden="true">
                          {note.warn ? <TriangleAlert /> : <CircleCheck />}
                          {note.text}
                        </span>
                      )}
                    </span>
                  </button>
                  {!readOnly && (r.fix || hint) && (
                    <div className="outline-next">
                      {hint && <span className="outline-hint">{hint}</span>}
                      {r.fix && (
                        <button className="btn btn-sm" aria-label={`Make Heading ${r.fix}: ${words}`} title="Changes the heading’s level in the page outline; it looks the same" onClick={() => setLevel(r, r.fix!)}>
                          Make Heading {r.fix}
                        </button>
                      )}
                      {editable(r) && (
                        <button className="btn btn-sm" aria-label={`Edit heading: ${words}`} onClick={() => editLevel(h)}>
                          Edit heading
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
