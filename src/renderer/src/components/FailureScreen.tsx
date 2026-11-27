import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { REPORT_URL } from '@shared/links';
import { AppMark } from './AppMark';
import './FailureScreen.css';

interface Props {
  /** What happened, in the same words wherever the same event is shown. */
  title: string;
  /** What happened and what stays safe, then what to do. */
  children: ReactNode;
  /** The technical message, shown folded away under Technical details and copied with the build details. */
  detail?: string;
  /** Open Technical details from the start. */
  detailOpen?: boolean;
  /** What Copy details copies when it is more than the technical message (the themes that could not be loaded). */
  report?: string;
  /** The way back, in order: the safe choice first, the primary (the one filled button) last, on the trailing edge. */
  actions: ReactNode;
}

/** What is copied for a report: the event, the technical message and, when the app can say, which build it was. Also
 * what the canvas copies when its preview stops (PreviewStatus.tsx). */
export async function reportText(title: string, detail: string | undefined, report: string | undefined): Promise<string> {
  let build = '';
  try {
    build = (await window.builder?.app.buildDetails?.()) ?? '';
  } catch {
    // The report still has the error itself.
  }
  return [title, report, detail, build].filter(Boolean).join('\n\n');
}

/**
 * The window when the editor cannot carry on: the editor failed while showing a screen (RenderFailure), or it could
 * not start (StartupFailure). One layout for all of them: the app's mark, what happened, whether the work is safe,
 * the way back, and, folded away, the technical details with a way to copy them and report the problem. It takes the
 * whole window, so focus moves to its heading when it appears: that is what a screen reader announces.
 */
export function FailureScreen({ title, children, detail, detailOpen = false, report, actions }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  /** A help action that did not work, with what to do by hand instead: the text to copy, or where to report. */
  const [fallback, setFallback] = useState<{ kind: 'copy'; text: string } | { kind: 'report' } | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (copied === 'idle') return;
    const t = setTimeout(() => setCopied('idle'), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    const text = await reportText(title, detail, report);
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      setCopied('failed');
      setFallback({ kind: 'copy', text });
    }
  };
  const openReport = async () => {
    try {
      await window.builder.app.openExternal(REPORT_URL);
    } catch {
      setFallback({ kind: 'report' });
    }
  };
  return (
    <main className="fatal failure" aria-labelledby={`${id}-title`}>
      <div className="failure-card">
        <div className="failure-body">
          <AppMark size={40} className="failure-mark" />
          <h1 id={`${id}-title`} ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <div className="failure-text">{children}</div>
          {detail && (
            <details className="failure-details" open={detailOpen || undefined}>
              <summary>
                <ChevronRight aria-hidden="true" />
                Technical details
              </summary>
              <pre className="failure-detail">{detail}</pre>
            </details>
          )}
          {/* Always there, so a screen reader hears it when it fills. */}
          <div className="failure-note" role="status">
            {fallback?.kind === 'copy' && (
              <>
                <p>The details could not be copied. Select them here and copy them yourself:</p>
                <pre className="failure-detail">{fallback.text}</pre>
              </>
            )}
            {fallback?.kind === 'report' && (
              <p>
                The report page could not be opened. You can report the problem at <span className="failure-path">{REPORT_URL.replace(/^https:\/\//, '')}</span>
              </p>
            )}
          </div>
        </div>
        <div className="failure-foot">
          <div className="failure-help">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
              {copied === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy details'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openReport()}>
              Report a problem
            </button>
            <span className="sr-only" role="status">
              {copied === 'copied' ? 'Details copied' : ''}
            </span>
          </div>
          <div className="failure-actions">{actions}</div>
        </div>
      </div>
    </main>
  );
}
