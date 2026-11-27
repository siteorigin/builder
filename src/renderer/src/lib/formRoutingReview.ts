/**
 * The app's own dialog for an AI change to where contact forms send (#1130). When the running request waits on the
 * question the app asks before such a change (agent/orchestrator.ts approveRouting, the only question that carries
 * `formRouting`), the editor shows it in its confirm dialog, wherever the chat panel is: each affected form, and where
 * it sends before and after. Allow answers with the question's allow choice, which has the main process grant exactly
 * that batch; Keep, Escape, × and the backdrop all answer with its keep choice, so the turn goes on without it.
 */
import type { FormRoutingPrompt } from '@shared/api';
import type { WaitingQuestion } from './chatQuestions';

/** What the dialog is asked with: the store's confirmDialog request (store.ts ConfirmRequest), as this question fills it. */
export interface RoutingDialogRequest {
  key: string;
  title: string;
  body: string;
  icon: 'email';
  confirmLabel: string;
  cancelLabel: string;
  formRouting: FormRoutingPrompt;
  details: Array<{ kind: 'risk' | 'keep'; text: string }>;
}

export type RoutingQuestion = WaitingQuestion & { question: { formRouting: FormRoutingPrompt } };

/** The waiting question, when it is the app's question about where forms send. */
export function routingQuestion(q: WaitingQuestion | null): RoutingQuestion | null {
  const prompt = q?.question.formRouting;
  return q && prompt && Array.isArray(prompt.forms) && q.question.choices.length === 2 ? (q as RoutingQuestion) : null;
}

/** Names the dialog for one question of one run, so it is asked once and taken back once that question is gone. */
export const routingKey = (q: WaitingQuestion) => `form-routing:${q.runId}:${q.question.id}`;

/** The dialog for the question: its review, its two answers as the question words them, and what each one does. */
export function routingDialog(q: RoutingQuestion): RoutingDialogRequest {
  const [keep, allow] = q.question.choices;
  const many = q.question.formRouting.forms.length > 1;
  const details: RoutingDialogRequest['details'] = [
    { kind: 'risk', text: 'Whoever owns an address below receives what visitors write. Allow only addresses you recognise.' },
    { kind: 'keep', text: `${keep}: nothing in this change is applied, and the AI carries on without it.` }
  ];
  return {
    key: routingKey(q),
    title: many ? 'Change where your forms send?' : 'Change where your form sends?',
    body: `The AI wants to change where ${many ? 'these contact forms send' : 'this contact form sends'} visitors’ messages. Nothing changes unless you allow it.`,
    icon: 'email',
    confirmLabel: allow,
    cancelLabel: keep,
    formRouting: q.question.formRouting,
    details
  };
}

/** The answer a closed dialog gives: Allow only for the allow button, Keep for anything else. */
export const routingAnswer = (q: WaitingQuestion, ok: boolean | null): string => (ok === true ? q.question.choices[1] : q.question.choices[0]);

/** Questions whose answer the dialog has given and that are not known to have failed: never asked again. */
const answered = new Set<string>();
/** Whether the dialog has answered the question (`routingKey`), its answer sent or on its way. */
export const routingAnswered = (key: string) => answered.has(key);

const reviewListeners = new Set<() => void>();
/** Show the waiting question's dialog again (the chat card's Review button), after an answer that could not be sent. */
export function requestRoutingReview() {
  for (const fn of reviewListeners) fn();
}
export function onRoutingReview(fn: () => void): () => void {
  reviewListeners.add(fn);
  return () => void reviewListeners.delete(fn);
}

/**
 * Ask the question in the dialog and send its answer. Returns a function that takes the dialog back unanswered, for
 * when the question no longer waits (answered in the composer, the request stopped, the project closed): the dialog
 * then sends nothing.
 */
export function askRoutingDialog(
  q: RoutingQuestion,
  deps: {
    confirm: (req: RoutingDialogRequest) => Promise<boolean | null>;
    withdraw: (key: string) => void;
    answer: (runId: string, questionId: string, answer: string) => Promise<boolean>;
    /** The answer could not be sent: the question may be asked again. */
    failed: () => void;
    /** The answer was sent. */
    sent?: (answer: string) => void;
  }
): () => void {
  let live = true;
  const key = routingKey(q);
  void deps.confirm(routingDialog(q)).then(async (ok) => {
    if (!live) return;
    live = false;
    // Answered: a Review asked for while the answer is on its way opens nothing.
    answered.add(key);
    const text = routingAnswer(q, ok);
    const sent = await deps.answer(q.runId, q.question.id, text).catch(() => false);
    if (sent) return deps.sent?.(text);
    answered.delete(key);
    deps.failed();
  });
  return () => {
    if (!live) return;
    live = false;
    deps.withdraw(key);
  };
}
