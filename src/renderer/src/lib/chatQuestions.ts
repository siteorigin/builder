import { turnQuestions, type ChatMessage, type ChatQuestion, type Conversation, type RunStatus } from '@shared/api';

/** The question the running request is waiting on, which the composer answers. */
export interface WaitingQuestion {
  runId: string;
  messageId: string;
  question: ChatQuestion & { id: string };
}

/** The question the active run is waiting on: the last of its turn, unanswered, while the run awaits input. */
export function waitingQuestion(conversation: Conversation | null | undefined, activeRunId: string | null | undefined, runStatus: RunStatus | null | undefined): WaitingQuestion | null {
  if (runStatus !== 'awaiting-input' || !activeRunId || !conversation) return null;
  const turn = conversation.messages.find((m) => m.role === 'assistant' && m.runId === activeRunId);
  const q = turn && !turn.result ? turnQuestions(turn).at(-1) : undefined;
  if (!turn || !q?.id || q.answered !== undefined) return null;
  return { runId: activeRunId, messageId: turn.id, question: { ...q, id: q.id } };
}

/**
 * A turn's questions as the conversation shows them: each with its answer, or as not answered once the turn is
 * over. The question still waiting is left out; it is shown beside the composer, which answers it.
 */
export function shownQuestions(m: ChatMessage, waiting: WaitingQuestion | null): Array<ChatQuestion & { key: string }> {
  return turnQuestions(m)
    .map((q, i) => (q && typeof q.text === 'string' ? { ...q, key: q.id ?? `${m.id}:${i}` } : null))
    .filter((q): q is ChatQuestion & { key: string } => !!q)
    .filter((q) => q.answered !== undefined || !(waiting?.messageId === m.id && waiting.question.id === q.id));
}

/** How soon after a typed answer an Enter is taken as a second press of the same key, not a new message. */
export const ANSWER_ECHO_MS = 1000;

/**
 * What the composer's Enter does with its text: answer a waiting question, send a new request, keep the text for
 * after the current request, or nothing. An empty box sends nothing, and an Enter that comes right after a typed
 * answer never sends the message the composer shows again once the question is answered.
 */
export function composerAction(opts: { text: string; waiting: boolean; running: boolean; sinceAnswerMs?: number }): 'answer' | 'send' | 'hold' | 'none' {
  if (!opts.text.trim()) return 'none';
  if (opts.waiting) return 'answer';
  if (opts.running) return 'hold';
  return (opts.sinceAnswerMs ?? Infinity) < ANSWER_ECHO_MS ? 'none' : 'send';
}

/**
 * Whether a live turn with nothing to show yet says "Getting started…" with a spinner. A turn that holds the
 * open question is not starting: it waits for the author, so it shows nothing that moves and is not busy.
 */
export function isStarting(m: { text?: string; result?: unknown; activities?: unknown[] }, live: boolean, waitingHere: boolean): boolean {
  return live && !waitingHere && !m.result && !m.text && !(m.activities?.length ?? 0);
}
