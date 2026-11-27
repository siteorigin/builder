import { useEffect, useId, useRef, useState } from 'react';
import { Check, Mail, Reply, Send, TriangleAlert } from 'lucide-react';
import { Disclosure, DisclosureMark, Segmented, Spinner } from '../components/ui';
import { formDestinationNote, formName, formSendNote, shortDestination, type FormSend, type PracticeResult, type PreviewForm } from '../lib/form-practice';

/**
 * The last send at a glance, in the panel's two words: a practice send, or a real test. They never look alike: a
 * practice send is neutral and marked with the reply glyph; a real test is boxed in its outcome's colour.
 */
function outcomeOf(send: FormSend): { lead: string; /** The lead on the folded line, which has no room for the rest. */ short?: string; tone: 'practice' | 'busy' | 'ok' | 'warn' | 'bad' } {
  if (send.kind === 'practice') {
    if (send.result === 'sending') return { lead: 'Practice send', tone: 'busy' };
    return { lead: 'Practice send', short: `Practice: ${send.result === 'error' ? 'error' : 'success'} reply`, tone: 'practice' };
  }
  switch (send.result) {
    case 'sending':
      return { lead: 'Sending a real test', tone: 'busy' };
    case 'sent':
      return { lead: 'Real test accepted', tone: 'ok' };
    case 'refused':
      return { lead: 'Real test refused', tone: 'bad' };
    case 'unreadable':
      return { lead: 'Real test unconfirmed', tone: 'warn' };
    default:
      return { lead: 'Real test not sent', tone: 'warn' };
  }
}

function OutcomeGlyph({ tone }: { tone: ReturnType<typeof outcomeOf>['tone'] }) {
  if (tone === 'busy') return <Spinner decorative />;
  if (tone === 'ok') return <Check aria-hidden="true" />;
  if (tone === 'practice') return <Reply aria-hidden="true" />;
  return <TriangleAlert aria-hidden="true" />;
}

/**
 * Forms in Preview (issue #193): says before anything is sent that sends are practice, lets the author choose the
 * reply a practice send gets, says what each send did, and offers one real test message after a confirmation that
 * names where it goes. It folds down to one line so the page it describes gets its foot back.
 */
export function FormPractice({
  forms,
  practice,
  onPractice,
  last,
  liveBusy,
  onLiveTest,
  folded,
  onFold,
  bottom,
  maxHeight,
  onHeight
}: {
  forms: PreviewForm[];
  practice: PracticeResult;
  onPractice: (result: PracticeResult) => void;
  /** The last send the page reported. */
  last: FormSend | null;
  /** A real test is on its way. */
  liveBusy: boolean;
  onLiveTest: (form: PreviewForm) => void;
  /** Folded to its title line and the last result's lead. Kept by the canvas, so it survives a change of page. */
  folded: boolean;
  onFold: (folded: boolean) => void;
  bottom: number;
  /** The most height the panel can take and leave the page clear; past it the panel scrolls. */
  maxHeight: number;
  /** The panel's height, so the preview can keep the page clear of it. */
  onHeight: (height: number) => void;
}) {
  const live = forms.filter((f) => f.live);
  /** The form a real test is being confirmed for; '' while the author has yet to choose one of several. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The forms list stays as the author left it across a confirmation, which takes its place for a moment. */
  const [listOpen, setListOpen] = useState(false);
  const target = live.find((f) => f.id === confirming) ?? null;
  const open = !folded && (confirming === '' ? live.length > 1 : !!target);
  // A confirmation names one form with the settings it had: once they change, it no longer stands.
  useEffect(() => {
    if (confirming !== null && !open) setConfirming(null);
  }, [confirming, open]);
  // Focus goes to the first thing to decide when the confirmation opens (the form to test, when there are several;
  // Cancel otherwise), and back to the button that opened it when it closes, unless the author has moved on (into
  // the page, say) by then.
  const panel = useRef<HTMLElement>(null);
  const liveButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const chooser = useRef<HTMLSelectElement>(null);
  const foldButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    const here = !document.activeElement || document.activeElement === document.body || !!panel.current?.contains(document.activeElement);
    if (open && !wasConfirming.current) (chooser.current ?? cancelButton.current)?.focus();
    else if (!open && wasConfirming.current && here) (liveButton.current ?? foldButton.current)?.focus();
    wasConfirming.current = open;
  }, [open]);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A new report lights the result up for a moment (the folded line's lead, when folded), so a second send that reads
  // like the first still shows it landed. A real test's box rings in its own tone; a practice send is washed in.
  const outcomeBox = useRef<HTMLDivElement>(null);
  const outcomeId = useId();
  const foldedLead = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = folded ? foldedLead.current : outcomeBox.current;
    if (!last || !el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const frames = last.kind === 'live' && !folded ? [{ boxShadow: '0 0 0 3px color-mix(in srgb, var(--tone) 30%, transparent)' }, { boxShadow: '0 0 0 3px transparent' }] : [{ backgroundColor: 'var(--active)' }, { backgroundColor: 'transparent' }];
    el.animate(frames, { duration: 800, easing: 'ease-out' });
  }, [last]); // eslint-disable-line react-hooks/exhaustive-deps
  const titleId = useId();
  const bodyId = useId();
  const choiceLabel = useId();
  const choose = useId();
  const confirmText = useId();
  const outcome = last ? outcomeOf(last) : null;
  /** A form's name for choosing it: forms that would read the same are told apart by their order on the page. */
  const occurrence = (form: PreviewForm) => {
    const same = forms.filter((f) => formName(f) === formName(form));
    return same.length > 1 ? `${same.indexOf(form) + 1} of ${same.length}` : '';
  };
  const choiceName = (form: PreviewForm) => (occurrence(form) ? `${formName(form)} (${occurrence(form)})` : formName(form));
  const only = forms.length === 1 ? forms[0] : null;
  const sentFrom = last ? forms.find((f) => f.id === last.id) : undefined;
  // With one form, a result takes the published address's line rather than adding one, so a send does not move the
  // page (and the form's own reply under its button) up out of view. A real test's result says where it went; a
  // practice send's never left. Only a form with an address of its own swaps, since the confirmation names it again:
  // results that name no address, the warning that a form is not connected, and the pointer to testing a Netlify
  // form on Netlify all keep their line.
  const practiced = !!only && only.service === 'endpoint' && last?.kind === 'practice';
  const repeated = practiced || (!!only && only.service === 'endpoint' && last?.kind === 'live' && last.id === only.id && ['sending', 'sent', 'refused', 'unreadable'].includes(last.result) && shortDestination(last.destination || only.destination) === shortDestination(only.destination));
  return (
    <section
      ref={panel}
      className="form-practice"
      data-folded={folded || undefined}
      style={{ bottom, maxHeight }}
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        // Escape backs out of the confirmation from anywhere in the panel, and only out of it, not the editor's
        // selection as well.
        e.stopPropagation();
        setConfirming(null);
      }}
    >
      <div className="form-practice-head">
        <Mail aria-hidden="true" />
        <p className="form-practice-title" id={titleId}>
          <strong>Form sends are practice in Preview.</strong>
          {!folded && <> {live.length ? 'Only a real test is sent.' : 'Nothing is sent.'}</>}
        </p>
        {folded && outcome && (
          <span ref={foldedLead} className="form-practice-lead" data-tone={outcome.tone} data-kind={last?.kind} aria-hidden="true">
            <OutcomeGlyph tone={outcome.tone} />
            {outcome.short ?? outcome.lead}
          </span>
        )}
        <button
          ref={foldButton}
          type="button"
          className="icon-btn form-practice-fold"
          aria-expanded={!folded}
          aria-controls={bodyId}
          aria-label={folded ? 'Show form practice' : 'Hide form practice'}
          title={folded ? 'Show form practice' : 'Hide form practice'}
          onClick={() => {
            setConfirming(null);
            onFold(!folded);
          }}
        >
          <DisclosureMark />
        </button>
      </div>
      {/* Stays mounted so sends are announced, folded or not. While a confirmation is open the last result steps out
          of view: it is not about the send being decided. */}
      <div ref={outcomeBox} id={outcomeId} className={`form-practice-outcome${open || folded ? ' sr-only' : ''}`} data-tone={outcome?.tone} data-kind={last?.kind} role="status">
        {outcome && last && (
          <>
            <p className="form-practice-lead">
              <OutcomeGlyph tone={outcome.tone} />
              {outcome.lead}
            </p>
            <p className="form-practice-result">{formSendNote(last, sentFrom, sentFrom && forms.length > 1 ? choiceName(sentFrom) : undefined)}</p>
          </>
        )}
      </div>
      <div className="form-practice-body" id={bodyId} hidden={folded}>
        {!open &&
          !repeated &&
          (only ? (
            <p className="form-practice-where">
              {only.service === 'endpoint' ? (
                <>
                  When published, this form sends to <strong className="form-practice-dest">{shortDestination(only.destination)}</strong>.
                </>
              ) : (
                formDestinationNote(only)
              )}
            </p>
          ) : (
            <Disclosure className="form-practice-forms" open={listOpen} onToggle={(e) => setListOpen(e.currentTarget.open)} summary={`Where the ${forms.length} forms on this page send`}>
              <ul>
                {forms.map((f) => (
                  <li key={f.id}>
                    {occurrence(f) && `Form ${occurrence(f)}: `}
                    {formDestinationNote(f)}
                  </li>
                ))}
              </ul>
            </Disclosure>
          ))}
        {!open ? (
          <div className="form-practice-row">
            <div className="form-practice-choice">
              <span className="form-practice-label" id={choiceLabel}>
                Next practice reply
              </span>
              <Segmented
                radio
                labelledBy={choiceLabel}
                value={practice}
                onChange={onPractice}
                options={[
                  { value: 'success', label: 'Success' },
                  { value: 'error', label: 'Error' }
                ]}
              />
            </div>
            {live.length > 0 && (
              // Not disabled while a test is on its way, so focus can stay on it after the confirmation closes.
              <button ref={liveButton} type="button" className="btn btn-sm form-practice-live" aria-disabled={liveBusy || undefined} aria-describedby={liveBusy ? outcomeId : undefined} onClick={() => !liveBusy && setConfirming(live.length > 1 ? '' : live[0].id)}>
                <Send aria-hidden="true" /> Send a real test…
              </button>
            )}
          </div>
        ) : (
          <div className="form-practice-confirm" role="group" aria-label="Send a real test" aria-describedby={confirmText}>
            <p className="form-practice-ask" id={confirmText}>
              <TriangleAlert aria-hidden="true" />
              <span>
                <strong>Send one real test message?</strong>{' '}
                {target ? (
                  <>
                    The answers now in {choiceName(target).replace(/^The form/, 'the form')} go to <strong className="form-practice-dest">{shortDestination(target.destination)}</strong>, as a visitor’s message would.
                  </>
                ) : (
                  'Choose the form to send from. Its answers go to that form’s service, as a visitor’s message would.'
                )}
              </span>
            </p>
            {live.length > 1 && (
              <label className="form-practice-pick" htmlFor={choose}>
                <span className="form-practice-label">Form to test</span>
                <select ref={chooser} id={choose} className="select sm" value={confirming ?? ''} onChange={(e) => setConfirming(e.target.value)}>
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
            {/* Cancel first, as in the app's confirmation dialogs. */}
            <div className="form-practice-actions">
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
      </div>
    </section>
  );
}
