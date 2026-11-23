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
  bottom
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
}) {
  const live = forms.filter((f) => f.live);
  /** The form a live test is being confirmed for. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const target = live.find((f) => f.id === confirming) ?? null;
  // A confirmation names one form with the settings it had: once they change, it no longer stands.
  useEffect(() => {
    if (confirming && !target) setConfirming(null);
  }, [confirming, target]);
  // Focus goes to Cancel when the confirmation opens, and back to the button that opened it when it closes.
  const liveButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (target && !wasConfirming.current) cancelButton.current?.focus();
    else if (!target && wasConfirming.current) liveButton.current?.focus();
    wasConfirming.current = !!target;
  }, [!!target]); // eslint-disable-line react-hooks/exhaustive-deps
  const titleId = useId();
  const choose = useId();
  const shown = forms.slice(0, 3);
  return (
    <section className="form-practice" style={{ bottom }} aria-labelledby={titleId}>
      <p className="form-practice-title" id={titleId}>
        <Mail aria-hidden="true" /> <strong>Form sends are simulated in Preview.</strong> Nothing is sent.
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
            <button ref={liveButton} type="button" className="btn btn-sm form-practice-live" disabled={liveBusy} onClick={() => setConfirming(live[0].id)}>
              <Send aria-hidden="true" /> Test live delivery…
            </button>
          )}
        </div>
      ) : (
        <div className="form-practice-confirm" role="group" aria-label="Test live delivery">
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
          <p>
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
