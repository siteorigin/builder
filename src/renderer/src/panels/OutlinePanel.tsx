import { useMemo } from 'react';
import { CircleCheck, Heading1, TriangleAlert } from 'lucide-react';
import { sameRef } from '@shared/types';
import type { OutlineHeading } from '@generator/checks';
import { applyOps, getState, setState, useStore } from '../store';
import { headingLevelOps, headingTarget, headingWords, pageOutline, type OutlineRow } from '../lib/outline';

const WHERE: Record<string, string> = { header: 'Shared header', footer: 'Shared footer' };

/** "Heading 1 is the page title" and the like, for a row's visible note and its accessible name. */
function rowNote(r: OutlineRow): { text: string; warn: boolean } | null {
  if (r.extraTitle) return { text: r.heading.repeated && !r.fix ? 'Heading 1 shown more than once' : 'Another Heading 1', warn: true };
  if (r.skip) return { text: `Skips Heading ${r.skip.suggest}`, warn: true };
  if (r.title) return { text: 'Page title', warn: false };
  return null;
}

/** Why a heading's level is not offered for change here. */
function fixedWhy(h: OutlineHeading): string {
  if (h.rich) return 'A subheading inside rich text: change its level in the text.';
  if (h.levelSource) return '';
  return h.owner.kind === 'shell' ? 'Set by the shared header or footer’s design.' : 'Set by the component’s design. Update its theme component, or edit the design everywhere, to choose another level.';
}

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
   * Give a heading another level. Focus stays in the outline, on the same heading's row once it has its new level
   * (changing a level never adds or removes a row), unless the edit did not land or another page is shown by then.
   */
  const setLevel = (h: OutlineHeading, level: number) => {
    const ops = headingLevelOps(h, level);
    const index = rows.findIndex((r) => r.heading === h);
    if (!ops) return;
    void applyOps(ops, `Make “${headingWords(h)}” Heading ${level}`, undefined, revision).then((done) => {
      if (!done || getState().pageId !== pageId) return;
      requestAnimationFrame(() => document.querySelectorAll<HTMLElement>('.outline-list > li .outline-row')[index]?.focus());
    });
  };

  const own = rows.filter((r) => r.heading.owner.kind === 'page');
  const summary = review.missingTitle ? (
    <div className="scope-note site" role="note">
      <TriangleAlert aria-hidden="true" />
      <span className="grow">
        <strong>No page title.</strong> None of this page’s headings is a Heading 1, so screen readers have no title to announce.
        {titleFix && (
          <>
            {' '}
            <button className="link" disabled={readOnly} onClick={() => setLevel(titleFix.heading, 1)}>
              Make “{headingWords(titleFix.heading)}” Heading 1
            </button>
          </>
        )}
      </span>
    </div>
  ) : review.extraTitles || review.skips.length ? (
    <div className="scope-note site" role="note">
      <TriangleAlert aria-hidden="true" />
      <span className="grow">
        {review.extraTitles && <>This page has more than one Heading 1. Keep its title as Heading 1 and make the others Heading 2, unless they are meant to be titles. </>}
        {review.skips.length > 0 && <>{review.skips.length === 1 ? 'A heading skips a level.' : `${review.skips.length} headings skip a level.`} Each level should follow on from the heading before it.</>}
      </span>
    </div>
  ) : own.length ? (
    <div className="scope-note shared" role="note">
      <CircleCheck aria-hidden="true" />
      <span className="grow">One page title, and no skipped levels. Changing a level never changes how a heading looks.</span>
    </div>
  ) : null;

  return (
    <div className="panel-body outline-view" aria-label={`Headings on ${page.title}`} role="region" tabIndex={-1}>
      <div className="outline-summary">{summary}</div>
      {rows.length === 0 ? (
        <div className="layers-empty">
          <p>No headings on this page yet</p>
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
            return (
              <li key={i} className={h.owner.kind === 'shell' ? 'shared' : undefined} style={{ '--level': h.level } as React.CSSProperties}>
                {group && <span className="outline-group">{group}</span>}
                <div className="outline-item">
                  <button
                    className={`outline-row${note?.warn ? ' warn' : ''}`}
                    aria-current={sameRef(selection, target) ? 'true' : undefined}
                    aria-label={`Heading ${h.level}, ${words}${note ? `. ${note.text}` : ''}${h.repeated && !r.extraTitle ? '. Shown more than once' : ''}`}
                    title={why || undefined}
                    onClick={() => select(h)}
                  >
                    <span className="outline-level" aria-hidden="true">
                      H{h.level}
                    </span>
                    <span className={`outline-words${h.text ? '' : ' empty'}`}>{words}</span>
                    {note && (
                      <span className={`badge ${note.warn ? 'amber' : 'green'}`} aria-hidden="true">
                        {note.warn ? <TriangleAlert /> : <Heading1 />}
                        {note.text}
                      </span>
                    )}
                  </button>
                  {r.fix && (
                    <button className="btn btn-sm outline-fix" disabled={readOnly} title="Changes the heading’s level in the page outline; it looks the same" onClick={() => setLevel(h, r.fix!)}>
                      Make Heading {r.fix}
                    </button>
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
