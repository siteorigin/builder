import type { ReactEventHandler, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * The house disclosure mark: a chevron that points right while closed and turns down as its fold opens, as a
 * Section's does. It leads the label. Inside a summary or a button with aria-expanded, the shared rule turns it;
 * a whole-row fold (a list item, a document, a style row) puts it first in its own toggle and keeps its row layout.
 */
export const DisclosureMark = () => <ChevronRight className="disclosure-mark" aria-hidden="true" focusable="false" />;

/**
 * A fold (WAI-ARIA APG disclosure) on a native details: a summary led by the house mark, then what it holds. Inline
 * folds sit in running content (Technical details, a counted list); `row` makes the summary a whole header row in a
 * card (Advanced server options, a source record), in its container's type and full ink, with focus drawn inside.
 * `className` is for the fold's own layout only: spacing and its body.
 */
export function Disclosure({ summary, children, className, row, open, onToggle, summaryId, summaryLabel, testId }: { summary: ReactNode; children: ReactNode; className?: string; row?: boolean; /** Controlled, with onToggle; `undefined` leaves it to the person. */ open?: boolean; onToggle?: ReactEventHandler<HTMLDetailsElement>; summaryId?: string; summaryLabel?: string; testId?: string }) {
  return (
    <details className={`disclosure${row ? ' disclosure-row' : ''}${className ? ` ${className}` : ''}`} open={open} onToggle={onToggle} data-testid={testId}>
      {/* A Tab stop the dialogs' focus trap counts (it finds [tabindex], not summary). */}
      <summary className="disclosure-trigger" id={summaryId} aria-label={summaryLabel} tabIndex={0}>
        <DisclosureMark />
        {summary}
      </summary>
      {children}
    </details>
  );
}
