import './PreviewStatus.css';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Layers, Play, RefreshCcw } from 'lucide-react';
import { REPORT_URL } from '@shared/links';
import type { RuntimeState } from '@shared/api';
import { api, setState, useStore } from '../store';
import { AppMark } from '../components/AppMark';
import { Disclosure, Spinner } from '../components/ui';
import { reportText } from '../components/FailureScreen';

/** The one reassurance every card that stops the page gives, worded the same each time. */
export const WORK_SAFE = 'Your work is safe. You can keep editing in Layers and the Inspector.';
/** The same, for a project that is open read-only here: it can be looked through, not edited. */
export const WORK_SAFE_READ_ONLY = 'Your work is safe. You can look through it in Layers.';

/** After this long, a start that usually takes seconds says it is taking longer. */
const SLOW_START_MS = 15000;
/** Setting up the website tools says the first run takes about a minute; past this it says it is taking longer. */
const SLOW_SETUP_MS = 90000;

/** The messages that only restate the title; the card says nothing more than its title for them. */
const RESTATES_TITLE = /^The preview (server failed to start|process stopped unexpectedly)\.$/;
/** What a stopped preview says it was, in plain words: the manager's own wording where it has one of ours. */
function stoppedText(message: string): string | null {
  if (RESTATES_TITLE.test(message)) return null;
  if (message === 'The preview server did not start in time.') return 'It didn’t start within a minute.';
  return message;
}

/** The reassurance for the project open now: a read-only one can be looked through, not edited. */
function useSafeLine(): string {
  return useStore((s) => (s.snapshot?.readOnly ? WORK_SAFE_READ_ONLY : WORK_SAFE));
}

/** What a stopped preview is called: one that ran and then stopped, or one that never got going. */
export function stoppedTitle(message: string): string {
  return /stopped unexpectedly/.test(message) ? 'The preview stopped' : 'The preview couldn’t start';
}

/** What screen readers hear, at once, when the preview stops. Said beside the canvas's other announcements. */
export function stoppedAnnouncement(runtime: RuntimeState): string {
  return runtime.state === 'error' ? `${stoppedTitle(runtime.message)}. Your work is safe.` : '';
}

/** Move to Layers with the keyboard, as a click on its tab would: focus goes to the tree's current row, or, when the
 * tree is empty, to the first control in the panel. */
export function openLayers() {
  setState({ leftTab: 'layers' });
  requestAnimationFrame(() => {
    const view = document.querySelector<HTMLElement>('.side-panel-view:not([hidden])');
    (view?.querySelector<HTMLElement>('[role="tree"] [tabindex="0"]') ?? view?.querySelector<HTMLElement>('button'))?.focus();
  });
}

/**
 * One card on the canvas while the page cannot be shown: the app's mark, what is happening, whether the work is safe,
 * and the way on, with the one filled button last. Built like the editor's own failure screen (FailureScreen.tsx), so
 * a stopped preview and a stopped editor read as the same kind of event. It is a labelled group, not a live region:
 * the status bar and the canvas say each change once, in their own always-present announcers.
 */
export function StatusCard({ mark, title, children, detail, help, actions, testId }: { mark: ReactNode; title: string; children: ReactNode; detail?: ReactNode; help?: ReactNode; actions?: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <section className="status-card" aria-labelledby={`${id}-title`} data-testid={testId}>
      <div className="status-card-body">
        <div className="status-card-mark">{mark}</div>
        <h3 id={`${id}-title`}>{title}</h3>
        <div className="status-card-text">{children}</div>
        {detail}
      </div>
      {(help || actions) && (
        <div className="status-card-foot">
          {help && <div className="status-card-help">{help}</div>}
          {actions && <div className="status-card-actions">{actions}</div>}
        </div>
      )}
    </section>
  );
}

/** The mark with the progress ring round it, for the states that are on their way. */
function Working() {
  return (
    <span className="starting-mark">
      <AppMark size={36} />
      <Spinner large decorative />
    </span>
  );
}

/** Copy details and Report a problem, as the failure screen has them: copied text goes with the build it came from. */
function StoppedHelp({ title, detail, onFallback }: { title: string; detail: string; onFallback: (f: Fallback | null) => void }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copied === 'idle') return;
    const t = setTimeout(() => setCopied('idle'), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    const text = await reportText(title, detail, undefined);
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
      onFallback(null);
    } catch {
      setCopied('failed');
      onFallback({ kind: 'copy', text });
    }
  };
  const report = async () => {
    try {
      await window.builder.app.openExternal(REPORT_URL);
    } catch {
      onFallback({ kind: 'report' });
    }
  };
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
        {copied === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : 'Copy details'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void report()}>
        Report a problem
      </button>
      <span className="sr-only" role="status">
        {copied === 'copied' ? 'Details copied' : ''}
      </span>
    </>
  );
}

/** A help action that did not work, with what to do by hand instead: the text to copy, or where to report. */
type Fallback = { kind: 'copy'; text: string } | { kind: 'report' };

/** The preview stopped: what happened in plain words, what is safe, the technical text folded away, and the way back. */
function Stopped({ message, detail }: { message: string; detail?: string }) {
  const safe = useSafeLine();
  // A read-only project without its website tools: Try again meets the same refusal (controller.ts), so the way on is
  // Project health, where the project can be unlocked. Any other stop in a read-only project is retried as usual.
  const refused = useStore((s) => !!s.snapshot?.readOnly) && /read-only, because its website tools are not set up/.test(message);
  const title = stoppedTitle(message);
  const report = useRef<HTMLTextAreaElement>(null);
  const said = stoppedText(message);
  const [fallback, setFallback] = useState<Fallback | null>(null);
  // Copying failed: the full report is put in a field of its own, focused and selected, so the next keystroke copies it.
  useEffect(() => {
    if (fallback?.kind !== 'copy') return;
    report.current?.focus({ preventScroll: true });
    report.current?.select();
    report.current?.scrollIntoView({ block: 'nearest' });
  }, [fallback]);
  const text = detail?.trim() ? detail : message;
  return (
    <StatusCard
      testId="preview-stopped"
      mark={<AppMark size={36} />}
      title={title}
      detail={
        <>
          {/* Closed while the report to copy by hand is showing, so the trace is shown once. */}
          <Disclosure className="status-card-details" summary="Technical details" open={fallback?.kind === 'copy' ? false : undefined}>
            <pre>{text}</pre>
          </Disclosure>
          {/* Always there, so a screen reader hears it when it fills; said where the person is looking. The report
              itself sits after it, outside, so only the sentence is read out. */}
          <div className="status-card-note" role="status">
            {fallback?.kind === 'copy' && <p>The details couldn’t be copied automatically. They’re selected below: press {/Mac/.test(navigator.platform) ? '⌘C' : 'Ctrl+C'} to copy them.</p>}
            {fallback?.kind === 'report' && (
              <p>
                The report page couldn’t be opened. You can report the problem at <span className="status-card-path">{REPORT_URL.replace(/^https:\/\//, '')}</span>
              </p>
            )}
          </div>
          {fallback?.kind === 'copy' && <textarea ref={report} className="status-card-report" readOnly aria-label="Details to copy" value={fallback.text} />}
        </>
      }
      help={<StoppedHelp title={title} detail={text} onFallback={setFallback} />}
      actions={
        // Read-only, the tools can't be set up and Try again meets the same refusal: Project health, where the project
        // can be unlocked, is the way on.
        refused ? (
          <>
            <button className="btn btn-sm" onClick={() => void api.project.retryPreview()}>
              <RefreshCcw aria-hidden="true" /> Try again
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => setState({ modal: { kind: 'health' } })}>
              Project health
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'health' } })}>
              Project health
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => void api.project.retryPreview()}>
              <RefreshCcw aria-hidden="true" /> Try again
            </button>
          </>
        )
      }
    >
      {said && <p>{said}</p>}
      <p className="status-card-safe">{safe}</p>
    </StatusCard>
  );
}

/**
 * Whether the preview's wait (setting up the tools, or starting) has run past what it usually takes. Timed from when
 * that kind of wait began, so the canvas can keep its outline over a start until it runs long, and the card that takes
 * over then says so at once.
 */
export function useSlowWait(runtime: RuntimeState): boolean {
  // A preview not started yet and one starting are one wait, timed as one: one that never gets going hands back to its
  // card in time. Setting up the website tools is timed on its own.
  const waiting = runtime.state === 'preparing' ? 'preparing' : runtime.state === 'starting' || runtime.state === 'idle' ? 'starting' : null;
  const [slowFor, setSlowFor] = useState<typeof waiting>(null);
  useEffect(() => {
    setSlowFor(null);
    if (!waiting) return;
    const t = setTimeout(() => setSlowFor(waiting), waiting === 'preparing' ? SLOW_SETUP_MS : SLOW_START_MS);
    return () => clearTimeout(t);
  }, [waiting]);
  return waiting !== null && slowFor === waiting;
}

/** On its way: setting up the tools, then starting. A wait that runs past what it usually takes says so, once. While a
 *  project's first page is outlined on the canvas (Canvas), a start that has not run long shows nothing of its own. */
function Waiting({ runtime, slow, outlined }: { runtime: Extract<RuntimeState, { state: 'preparing' | 'starting' }>; slow: boolean; outlined: boolean }) {
  const preparing = runtime.state === 'preparing';
  const safe = useSafeLine();
  const later = 'This is taking longer than usual.';
  // Setting up is installing the website tools, or, for a project open read-only, copying it to preview it unchanged.
  const copying = preparing && /^Copying/.test(runtime.message);
  // Under the outline a start that has not run long shows nothing; its slow word is said by PreviewStatus.
  if (outlined && !preparing && !slow) return null;
  return (
      <StatusCard
      testId={preparing ? 'preview-preparing' : 'preview-starting'}
      mark={<Working />}
      title={copying ? 'Preparing the preview' : preparing ? 'Setting up website tools' : 'Starting preview'}
      actions={
        slow && (
          <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'health' } })}>
            Project health
          </button>
        )
      }
    >
      <p>{preparing ? runtime.message : slow ? later : 'Opening your site. This usually takes a few seconds.'}</p>
      {preparing && slow && <p>{later}</p>}
      {slow && <p className="status-card-safe">{safe}</p>}
      </StatusCard>
  );
}

/** What the canvas shows instead of the page while the preview is not running, or nothing when it is. `slow` is
 *  useSlowWait's answer for this runtime; `outlined`, that the canvas is showing the project's first page as an outline,
 *  which a start or a preview not started yet leave in place. */
export function PreviewStatus({ runtime, slow, outlined = false }: { runtime: RuntimeState; slow: boolean; outlined?: boolean }) {
  const preparing = runtime.state === 'preparing';
  const copying = runtime.state === 'preparing' && /^Copying/.test(runtime.message);
  return (
    <>
      <PreviewCard runtime={runtime} slow={slow} outlined={outlined} />
      {/* Mounted with the status whatever it shows (the outline, a card, nothing yet), so a wait running long is
          announced when it does, from a preview not started yet, a start, or setting up the tools. */}
      <p className="sr-only" role="status">
        {slow && (preparing || runtime.state === 'starting') ? `${copying ? 'Preparing the preview' : preparing ? 'Setting up website tools' : 'Starting the preview'} is taking longer than usual.` : ''}
      </p>
    </>
  );
}

function PreviewCard({ runtime, slow, outlined }: { runtime: RuntimeState; slow: boolean; outlined: boolean }) {
  const safe = useSafeLine();
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  if (runtime.state === 'ready') return null;
  if (runtime.state === 'error') return <Stopped key={runtime.message} message={runtime.message} detail={runtime.detail} />;
  if (runtime.state === 'unavailable')
    return (
      <StatusCard
        testId="preview-unavailable"
        mark={<AppMark size={36} />}
        title="Preview unavailable"
        actions={
          <button className="btn btn-sm btn-primary" onClick={openLayers}>
            <Layers aria-hidden="true" /> Open Layers
          </button>
        }
      >
        <p>{runtime.message}</p>
        {/* A project only a newer version can open is read-only here: it can be looked through, not edited. */}
        <p className="status-card-safe">{WORK_SAFE_READ_ONLY}</p>
      </StatusCard>
    );
  if (runtime.state === 'idle' && outlined) return null;
  if (runtime.state === 'idle')
    return (
      <StatusCard
        testId="preview-paused"
        mark={<AppMark size={36} />}
        title="Preview is paused"
        actions={
          <button className="btn btn-sm btn-primary" onClick={() => void api.project.retryPreview()}>
            <Play aria-hidden="true" /> Start preview
          </button>
        }
      >
        <p>{readOnly ? 'Start it to see your site on the page.' : 'Start it to see and edit your site on the page.'}</p>
        <p className="status-card-safe">{safe}</p>
      </StatusCard>
    );
  return <Waiting runtime={runtime} slow={slow} outlined={outlined} />;
}
