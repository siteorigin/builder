import { useEffect, useMemo, useState } from 'react';
import { api, confirmDialog, getState, toast, useStore, withdrawConfirm } from '../store';
import { waitingQuestion } from '../lib/chatQuestions';
import { askRoutingDialog, onRoutingReview, routingKey, routingQuestion } from '../lib/formRoutingReview';

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
  // Asked again when the chat card's Review button asks for it, after an answer that could not be sent.
  const [asked, setAsked] = useState(0);
  useEffect(() => onRoutingReview(() => setAsked((n) => n + 1)), []);
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
      }
    });
    // Keyed by the question, not the object: the same question rendered again is not asked again.
  }, [key, asked]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
