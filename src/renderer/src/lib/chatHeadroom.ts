import { turnQuestions, type ChatMessage } from '@shared/api';
import { DEFAULT_LOCAL_CONTEXT_WINDOW, localContextWindow, type LocalToolMode } from '@shared/local';
import { estimateTokens, FOCUSED_WINDOW_TOKENS } from '@shared/tokens';
import { MAX_REPLAYED_ANSWER, replayedHistory } from '@shared/turn-model';

/**
 * Whether a message, such as a page's copy pasted whole, may be too long for a local model's context, said in the
 * composer before it is sent. The assistant's instructions, its tools and the editor context come first in every
 * request, and building a page from pasted copy repeats the copy in its tool call, so a draft gets at most half the
 * window. Only an estimate: the main process measures the real request, and refuses one that cannot fit.
 */

/**
 * About what the instructions, page tools and editor context take before the messages, by the tools a local model
 * gets: grammar-constrained JSON, or the small native set (a window under FOCUSED_WINDOW_TOKENS). From there up the full
 * native set takes about 17,000 tokens, under half the window, so the half is what counts. Measured on the business
 * starter's Home page and rounded up (tests/unit/chat-headroom.test.ts keeps them honest).
 */
export const LOCAL_OVERHEAD_TOKENS = { constrained: 3584, focused: 10_240 } as const;
/** The smallest reply worth asking for, as the assistant keeps it free (budget.ts MIN_OUTPUT_TOKENS). */
const REPLY_TOKENS = 1024;

export interface HeadroomInput {
  /** The message being written. */
  draft: string;
  /** What a request replays of the conversation before it (see `replayedWords`). */
  history: readonly string[];
  /** The request may build pages (This page or Whole site), so it carries the page tools and the page's sections. */
  pageTools: boolean;
  /** The context size set in Settings, or null to read it from the server. */
  contextWindow: number | null;
  toolMode: LocalToolMode;
}

export interface HeadroomWarning {
  /** What tips it over: the message itself, the conversation it joins, or a window too small for any message. */
  kind: 'draft' | 'history' | 'setup';
  draftTokens: number;
  historyTokens: number;
  /** The tokens the messages may take in all. */
  roomTokens: number;
  windowTokens: number;
  /** No size is set, so the default is assumed; the server may report another. */
  assumed: boolean;
  text: string;
}

/**
 * The share of the window the messages may take: half, or less where the page tools leave less. A request about a
 * selection, a component or a question carries far smaller tools, and gets the half.
 */
export function messageRoom(windowTokens: number, toolMode: LocalToolMode, pageTools = true): number {
  const half = Math.floor(windowTokens / 2);
  if (!pageTools) return half;
  if (toolMode === 'native' && windowTokens >= FOCUSED_WINDOW_TOKENS) return half;
  const overhead = toolMode === 'native' ? LOCAL_OVERHEAD_TOKENS.focused : LOCAL_OVERHEAD_TOKENS.constrained;
  return Math.max(0, Math.min(half, windowTokens - overhead - REPLY_TOKENS));
}

/**
 * The words a request replays of the conversation before it, as the assistant replays them: the last messages, and
 * in each earlier turn the questions it asked with their answers (a long answer cut short) before its reply.
 */
export function replayedWords(messages: readonly ChatMessage[]): string[] {
  return replayedHistory(messages).flatMap((m) => {
    const said = typeof m.text === 'string' ? m.text : '';
    if (m.role === 'user') return [said];
    // A transcript is read back from disk: anything malformed is left out, as the assistant leaves it out.
    const asked = turnQuestions(m).flatMap((q) =>
      typeof q?.text === 'string' ? [q.text, ...(Array.isArray(q.choices) ? q.choices.filter((c) => typeof c === 'string') : []), typeof q.answered === 'string' ? q.answered.slice(0, MAX_REPLAYED_ANSWER) : ''] : []
    );
    return [...asked, said];
  });
}

const n = (t: number) => t.toLocaleString('en-US');

/** Null while the message fits; otherwise what to do about it, for a local model. */
export function headroomWarning(input: HeadroomInput): HeadroomWarning | null {
  if (!input.draft.trim()) return null;
  const set = localContextWindow(input.contextWindow);
  const windowTokens = set ?? DEFAULT_LOCAL_CONTEXT_WINDOW;
  const assumed = set === null;
  const roomTokens = messageRoom(windowTokens, input.toolMode, input.pageTools);
  const draftTokens = estimateTokens(input.draft);
  const historyTokens = input.history.reduce((sum, m) => sum + estimateTokens(m), 0);
  if (draftTokens + historyTokens <= roomTokens) return null;
  const context = `the local model's ${assumed ? 'assumed ' : ''}${n(windowTokens)}-token context`;
  const larger = `load the model with a larger context and ${assumed ? 'set' : 'match'} that size in AI settings`;
  // Less room than a short paragraph: no message fits, however it is split.
  const kind = roomTokens < 256 ? 'setup' : draftTokens > roomTokens ? 'draft' : 'history';
  const text =
    kind === 'setup'
      ? `The assistant's instructions fill most of ${context}, so a request may not fit. To use it, ${larger}.`
      : kind === 'draft'
        ? // No count of the message itself: the note is announced, and would be again at every key typed.
          `This message is longer than ${context} leaves room for (about ${n(roomTokens)} tokens). Send the copy a few sections at a time, or ${larger}.`
        : `With this conversation's earlier messages, this message may not fit ${context}. Start a new conversation and send it there, or send the copy a few sections at a time.`;
  return { kind, draftTokens, historyTokens, roomTokens, windowTokens, assumed, text };
}
