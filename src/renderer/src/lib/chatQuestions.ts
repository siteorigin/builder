import { turnQuestions, type ChatImageRef, type ChatMessage, type ChatQuestion, type Conversation, type RunStatus } from '@shared/api';

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
 * Whether a turn is paused for the author: it holds the question, or it is the live turn of a run that waits.
 * The run's status and its question message arrive separately, so either one is enough.
 */
export function isPaused(asking: WaitingQuestion | null, messageId: string, live: boolean, awaiting: boolean): boolean {
  return asking?.messageId === messageId || (live && awaiting);
}

/**
 * The `aria-busy` of the conversation log and of a live turn: set while the AI works, and cleared while the run
 * waits for the author, so an assistive client reads the chat as ready for an answer rather than as something to
 * wait on. It comes back once the run's status says the work has resumed, not when the answer is recorded.
 */
export function chatBusy(active: boolean, paused: boolean): true | undefined {
  return (active && !paused) || undefined;
}

/**
 * Whether a live turn with nothing to show yet says "Getting started…" with a spinner. A turn that holds the
 * open question is not starting: it waits for the author, so it shows nothing that moves and is not busy.
 */
export function isStarting(m: { text?: string; result?: unknown; activities?: unknown[] }, live: boolean, waitingHere: boolean): boolean {
  return live && !waitingHere && !m.result && !m.text && !(m.activities?.length ?? 0);
}

/**
 * Images shown together, each with the label that tells it apart: its name, and its asset ID as well when another
 * image shown with it, or in the `library`, has the same name (two imports both called "hero"), so the author can
 * match the one they mean.
 */
export function imageLabels<T extends ChatImageRef>(images: T[], library: ChatImageRef[] = []): Array<T & { label: string; sharedName: boolean }> {
  // A hand-edited library can hold a name that is not text: it matches nothing.
  const key = (n: unknown) => (typeof n === 'string' ? n.trim().toLowerCase() : '');
  const ids = new Map<string, Set<string>>();
  for (const i of [...images, ...library]) {
    if (!ids.has(key(i.name))) ids.set(key(i.name), new Set());
    ids.get(key(i.name))!.add(i.assetId);
  }
  return images.map((i) => {
    const sharedName = (ids.get(key(i.name))?.size ?? 0) > 1;
    return { ...i, sharedName: sharedName && !!key(i.name), label: sharedName && key(i.name) ? `${i.name.trim()} (${i.assetId})` : i.name };
  });
}

/** The images a saved question offered, in order: anything malformed in an older transcript is left out. */
export function offeredImages(q: Pick<ChatQuestion, 'images'>): ChatImageRef[] {
  return Array.isArray(q.images) ? q.images.filter((i) => !!i && typeof i.assetId === 'string' && typeof i.name === 'string') : [];
}

/** What the hint under a waiting question says the author can do. */
export function questionHint(q: Pick<ChatQuestion, 'choices' | 'widen' | 'images'>): string {
  if (q.widen) return 'Choose an option, or type a reply below. A typed “yes” or “OK” allows it too.';
  const images = offeredImages(q).length;
  if (images) return `Choose a picture${q.choices.length ? ' or an option' : ''}, or type your own answer below. Select a picture to see it larger first.`;
  return q.choices.length ? 'Choose an option, or type your own answer below.' : 'Type your answer below.';
}
