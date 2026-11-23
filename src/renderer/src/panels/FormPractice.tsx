import { useEffect, useId, useRef, useState } from 'react';
import { Mail, Send } from 'lucide-react';
import { formDestinationNote, formName, formSendNote, shortDestination, type FormSend, type PracticeResult, type PreviewForm } from '../lib/form-practice';

/**
 * Forms in Preview (issue #193): says before anything is sent that sends are practice runs, lets the author choose the
 * reply a practice send gets, says what each send did, and offers one real test message after a confirmation that
 * names where it goes.
 */
export function FormPractice({
  forms,
  practice,
  onPractice,
  last,
  liveBusy,
  onLiveTest,
  bottom,
  onHeight
}: {
  forms: PreviewForm[];
  practice: PracticeResult;
  onPractice: (result: PracticeResult) => void;
  /** The last send the page reported. */
  last: FormSend | null;
  /** A live test is on its way. */
  liveBusy: boolean;
  onLiveTest: (form: PreviewForm) => void;
  bottom: number;
  /** The panel's height, so the preview can keep the page clear of it. */
  onHeight: (height: number) => void;
}) {
  const live = forms.filter((f) => f.live);
  /** The form a live test is being confirmed for. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const target = live.find((f) => f.id === confirming) ?? null;
  // A confirmation names one form with the settings it had: once they change, it no longer stands.
  useEffect(() => {
    if (confirming && !target) setConfirming(null);
  }, [confirming, target]);
  // Focus goes to Cancel when the confirmation opens, and back to the button that opened it when it closes, unless
  // the author has moved on (into the page, say) by then.
  const panel = useRef<HTMLElement>(null);
  const liveButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    const here = !document.activeElement || document.activeElement === document.body || !!panel.current?.contains(document.activeElement);
    if (target && !wasConfirming.current) cancelButton.current?.focus();
    else if (!target && wasConfirming.current && here) liveButton.current?.focus();
    wasConfirming.current = !!target;
  }, [!!target]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const titleId = useId();
  const choose = useId();
  const confirmText = useId();
  const shown = forms.slice(0, 3);
  return (
    <section ref={panel} className="form-practice" style={{ bottom }} aria-labelledby={titleId}>
      <p className="form-practice-title" id={titleId}>
        <Mail aria-hidden="true" /> <strong>Form sends are simulated in Preview.</strong> {live.length ? 'Nothing is sent unless you test live delivery.' : 'Nothing is sent.'}
      </p>
      {shown.map((f) => (
        <p key={f.id} className="form-practice-where">
          {formDestinationNote(f)}
        </p>
      ))}
      {forms.length > shown.length && <p className="form-practice-where">This page has {forms.length - shown.length} more {forms.length - shown.length === 1 ? 'form' : 'forms'}.</p>}
      {!target ? (
        <div className="form-practice-row">
          <span className="form-practice-label">Practice result</span>
          <div className="segmented" role="group" aria-label="Practice result">
            <button type="button" aria-pressed={practice === 'success'} onClick={() => onPractice('success')}>
              Success
            </button>
            <button type="button" aria-pressed={practice === 'error'} onClick={() => onPractice('error')}>
              Error
            </button>
          </div>
          {live.length > 0 && (
            // Not disabled while a test is on its way, so focus can stay on it after the confirmation closes.
            <button ref={liveButton} type="button" className="btn btn-sm form-practice-live" aria-disabled={liveBusy || undefined} onClick={() => !liveBusy && setConfirming(live[0].id)}>
              <Send aria-hidden="true" /> Test live delivery…
            </button>
          )}
        </div>
      ) : (
        <div className="form-practice-confirm" role="group" aria-label="Test live delivery" aria-describedby={confirmText}>
          {live.length > 1 && (
            <label className="form-practice-row" htmlFor={choose}>
              <span className="form-practice-label">Form</span>
              <select id={choose} value={target.id} onChange={(e) => setConfirming(e.target.value)}>
                {live.map((f) => (
                  <option key={f.id} value={f.id}>
                    {formName(f)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p id={confirmText}>
            <strong>Send one real test message?</strong> The answers now in {formName(target).replace(/^The form/, 'the form')} go to {shortDestination(target.destination)}, as a visitor’s message would.
          </p>
          <div className="form-practice-row">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setConfirming(null);
                onLiveTest(target);
              }}
            >
              Send one real test message
            </button>
            <button ref={cancelButton} type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <p className="form-practice-result" role="status">
        {last ? formSendNote(last, forms.find((f) => f.id === last.id)) : ''}
      </p>
    </section>
  );
}
