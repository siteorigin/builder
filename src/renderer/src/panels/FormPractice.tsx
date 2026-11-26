import { useEffect, useId, useRef, useState } from 'react';
import { Check, Mail, Send, TriangleAlert } from 'lucide-react';
import { Spinner } from '../components/ui';
import { formDestinationNote, formName, formSendNote, shortDestination, type FormSend, type PracticeResult, type PreviewForm } from '../lib/form-practice';

/** The last send at a glance: practice and real sends never look alike, and neither do their outcomes. */
function outcomeOf(send: FormSend): { lead: string; tone: 'practice' | 'busy' | 'ok' | 'warn' | 'bad' } {
  if (send.kind === 'practice') return send.result === 'sending' ? { lead: 'Practicing', tone: 'busy' } : { lead: 'Practice only', tone: 'practice' };
  switch (send.result) {
    case 'sending':
      return { lead: 'Sending a real message', tone: 'busy' };
    case 'sent':
      return { lead: 'Service accepted it', tone: 'ok' };
    case 'refused':
      return { lead: 'Service refused it', tone: 'bad' };
    case 'unreadable':
      return { lead: 'Delivery unconfirmed', tone: 'warn' };
    default:
      return { lead: 'Not sent', tone: 'warn' };
  }
}

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
  maxHeight,
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
  /** The most height the panel can take and leave the page clear; past it the panel scrolls. */
  maxHeight: number;
  /** The panel's height, so the preview can keep the page clear of it. */
  onHeight: (height: number) => void;
}) {
  const live = forms.filter((f) => f.live);
  /** The form a live test is being confirmed for; '' while the author has yet to choose one of several. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const target = live.find((f) => f.id === confirming) ?? null;
  const open = confirming === '' ? live.length > 1 : !!target;
  // A confirmation names one form with the settings it had: once they change, it no longer stands.
  useEffect(() => {
    if (confirming !== null && !open) setConfirming(null);
  }, [confirming, open]);
  // Focus goes to Cancel when the confirmation opens, and back to the button that opened it when it closes, unless
  // the author has moved on (into the page, say) by then.
  const panel = useRef<HTMLElement>(null);
  const liveButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    const here = !document.activeElement || document.activeElement === document.body || !!panel.current?.contains(document.activeElement);
    if (open && !wasConfirming.current) cancelButton.current?.focus();
    else if (!open && wasConfirming.current && here) liveButton.current?.focus();
    wasConfirming.current = open;
  }, [open]);
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
  const outcome = last ? outcomeOf(last) : null;
  /** A form's name for choosing it: forms that would read the same are told apart by their order on the page. */
  const occurrence = (form: PreviewForm) => {
    const same = forms.filter((f) => formName(f) === formName(form));
    return same.length > 1 ? `${same.indexOf(form) + 1} of ${same.length}` : '';
  };
  const choiceName = (form: PreviewForm) => (occurrence(form) ? `${formName(form)} (${occurrence(form)})` : formName(form));
  return (
    <section ref={panel} className="form-practice" style={{ bottom, maxHeight }} aria-labelledby={titleId}>
      <p className="form-practice-title" id={titleId}>
        <Mail aria-hidden="true" /> <strong>Form sends are simulated in Preview.</strong> {live.length ? 'Nothing is sent unless you test live delivery.' : 'Nothing is sent.'}
      </p>
      {!open &&
        (forms.length === 1 ? (
          <p className="form-practice-where">{formDestinationNote(forms[0])}</p>
        ) : (
          <details className="form-practice-forms">
            <summary>This page has {forms.length} forms. See where each one sends</summary>
            <ul>
              {forms.map((f) => (
                <li key={f.id}>
                  {occurrence(f) && `Form ${occurrence(f)}: `}
                  {formDestinationNote(f)}
                </li>
              ))}
            </ul>
          </details>
        ))}
      {!open ? (
        <div className="form-practice-row">
          <span className="form-practice-label">Next practice send</span>
          <div className="segmented" role="group" aria-label="Next practice send">
            <button type="button" aria-pressed={practice === 'success'} onClick={() => onPractice('success')}>
              {practice === 'success' && <Check aria-hidden="true" />}
              Success
            </button>
            <button type="button" aria-pressed={practice === 'error'} onClick={() => onPractice('error')}>
              {practice === 'error' && <Check aria-hidden="true" />}
              Error
            </button>
          </div>
          {live.length > 0 && (
            // Not disabled while a test is on its way, so focus can stay on it after the confirmation closes.
            <button ref={liveButton} type="button" className="btn btn-sm form-practice-live" aria-disabled={liveBusy || undefined} onClick={() => !liveBusy && setConfirming(live.length > 1 ? '' : live[0].id)}>
              <Send aria-hidden="true" /> Test live delivery…
            </button>
          )}
        </div>
      ) : (
        <div
          className="form-practice-confirm"
          role="group"
          aria-label="Test live delivery"
          aria-describedby={confirmText}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // Escape backs out of this confirmation only, not the editor's selection as well.
            e.stopPropagation();
            setConfirming(null);
          }}
        >
          {live.length > 1 && (
            <label className="form-practice-row" htmlFor={choose}>
              <span className="form-practice-label">Form to test</span>
              <select id={choose} className="select sm" value={confirming ?? ''} onChange={(e) => setConfirming(e.target.value)}>
                <option value="" disabled>
                  Choose a form…
                </option>
                {live.map((f) => (
                  <option key={f.id} value={f.id}>
                    {choiceName(f)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p id={confirmText}>
            <strong>Send one real test message?</strong>{' '}
            {target ? (
              <>
                The answers now in {choiceName(target).replace(/^The form/, 'the form')} go to <strong className="form-practice-dest">{shortDestination(target.destination)}</strong>, as a visitor’s message would.
              </>
            ) : (
              'Choose the form to send from. Its answers go to that form’s service, as a visitor’s message would.'
            )}
          </p>
          {/* Cancel first, as in the app's confirmation dialogs, and where focus lands. */}
          <div className="form-practice-row">
            <button ref={cancelButton} type="button" className="btn btn-sm" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              aria-disabled={!target || undefined}
              aria-describedby={confirmText}
              onClick={() => {
                if (!target) return;
                setConfirming(null);
                onLiveTest(target);
              }}
            >
              <Send aria-hidden="true" /> Send one real test message
            </button>
          </div>
        </div>
      )}
      {/* Stays mounted so sends are announced. While a confirmation is open the last result steps out of view: it is
          not about the send being decided. */}
      <div className={`form-practice-outcome${open ? ' sr-only' : ''}`} data-tone={outcome?.tone} data-kind={last?.kind}>
        {outcome && (
          <span className="form-practice-lead" aria-hidden="true">
            {outcome.tone === 'busy' ? <Spinner decorative /> : outcome.tone === 'ok' ? <Check /> : outcome.tone === 'practice' ? null : <TriangleAlert />}
            {outcome.lead}
          </span>
        )}
        <p className="form-practice-result" role="status">
          {last ? formSendNote(last, forms.find((f) => f.id === last.id)) : ''}
        </p>
      </div>
    </section>
  );
}
