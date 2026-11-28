import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Conversation } from '@shared/api';
import { api, confirmDialog, getConfirm, getState, onConfirmChange, toast, useStore, withdrawConfirm } from '../store';
import { waitingQuestion } from '../lib/chatQuestions';
import { askRoutingDialog, onRoutingReview, routingAnswered, routingKey, routingQuestion, routingReviewShown } from '../lib/formRoutingReview';

const subscribe = (fn: () => void) => {
  const off = onConfirmChange(fn);
  return () => void off();
};
/** Whether the form-routing review is the dialog on screen (#1322), so other prompts for its question can step back. */
export const useRoutingReviewShown = () => useSyncExternalStore(subscribe, () => routingReviewShown(getConfirm()));

/**
 * Shows the app's question about an AI change to where contact forms send in the app's own dialog (#1130), whether or
 * not the chat panel is open: mounted with the app, beside ConfirmHost. The dialog is asked once per question, and
 * taken back unanswered once the question stops waiting.
 */
export function FormRoutingHost() {
  const shown = useStore((s) => s.conversation);
  const runStatus = useStore((s) => s.runStatus);
  const activeRunId = useStore((s) => s.activeRunId);
  // A request waiting in another thread than the one on screen (#1125): its question is read from main, as it is
  // there, so the dialog opens wherever the chat is, and stays while the author switches threads.
  const away = useStore((s) => (s.runStatus === 'awaiting-input' && s.runConversationId && s.conversation?.id !== s.runConversationId ? s.runConversationId : null));
  const [elsewhere, setElsewhere] = useState<Conversation | null>(null);
  useEffect(() => {
    setElsewhere(null);
    if (!away) return;
    const opening = getState().snapshot?.workspaceKey ?? '';
    let live = true;
    void Promise.resolve()
      .then(() => api.ai.readConversation(away, opening))
      .then(
        (r) => live && r?.conversation?.id === away && (getState().snapshot?.workspaceKey ?? '') === opening && setElsewhere(r.conversation),
        () => undefined
      );
    return () => {
      live = false;
    };
  }, [away, activeRunId]);
  const conversation = away ? elsewhere : shown;
  const waitsIn = useRef(conversation);
  waitsIn.current = conversation;
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
        // Read from the thread it waits in, whichever is on screen.
        const still = routingQuestion(waitingQuestion(waitsIn.current, s.activeRunId, s.runStatus));
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
