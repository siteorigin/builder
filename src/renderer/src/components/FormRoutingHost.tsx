import { useEffect, useMemo, useRef, useState } from 'react';
import { api, confirmDialog, getState, toast, useStore, withdrawConfirm } from '../store';
import { waitingQuestion } from '../lib/chatQuestions';
import { askRoutingDialog, onRoutingReview, routingAnswered, routingKey, routingQuestion } from '../lib/formRoutingReview';

/**
 * Shows the app's question about an AI change to where contact forms send in the app's own dialog (#1130), whether or
 * not the chat panel is open: mounted with the app, beside ConfirmHost. The dialog is asked once per question, and
 * taken back unanswered once the question stops waiting.
 */
export function FormRoutingHost() {
  const conversation = useStore((s) => s.conversation);
  const runStatus = useStore((s) => s.runStatus);
  const activeRunId = useStore((s) => s.activeRunId);
  const asking = useMemo(() => routingQuestion(waitingQuestion(conversation, activeRunId, runStatus)), [conversation, activeRunId, runStatus]);
  const key = asking ? routingKey(asking) : null;
  // Asked again when the chat card's Review button asks for it, unless its answer was given and is on its way.
  const [asked, setAsked] = useState(0);
  const current = useRef(key);
  current.current = key;
  useEffect(() => onRoutingReview(() => current.current && !routingAnswered(current.current) && setAsked((n) => n + 1)), []);
  // Said once the dialog's answer is sent, as the chat says it for one typed there.
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (!asking) return;
    return askRoutingDialog(asking, {
      confirm: confirmDialog,
      withdraw: withdrawConfirm,
      answer: (runId, questionId, answer) => api.ai.answer(runId, questionId, answer),
      failed: () => {
        const s = getState();
        const still = routingQuestion(waitingQuestion(s.conversation, s.activeRunId, s.runStatus));
        if (still && routingKey(still) === routingKey(asking)) toast('Your answer could not be sent. Choose Review changes to answer again.', 'error');
      },
      // The same words twice in a row are still heard: they alternate a trailing no-break space.
      sent: (answer) => setSaid((prev) => (prev === `${answer}: answer sent. The AI is continuing.` ? `${prev}\u00a0` : `${answer}: answer sent. The AI is continuing.`))
    });
    // Keyed by the question, not the object: the same question rendered again is not asked again.
  }, [key, asked]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {said}
    </span>
  );
}
