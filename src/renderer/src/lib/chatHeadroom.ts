import { DEFAULT_LOCAL_CONTEXT_WINDOW, localContextWindow, type LocalToolMode } from '@shared/local';
import { estimateTokens, FOCUSED_WINDOW_TOKENS } from '@shared/tokens';

/**
 * Whether a message, such as a page's copy pasted whole, may be too long for a local model's context, said in the
 * composer before it is sent. The assistant's instructions, its tools and the editor context come first in every
 * request, and building a page from pasted copy repeats the copy in its tool call, so a draft gets at most half the
 * window. Only an estimate: the main process measures the real request, and refuses one that cannot fit.
 */

/**
 * About what the instructions, tools and editor context take before the messages, by the tools a local model gets:
 * grammar-constrained JSON, the small native set (a window under FOCUSED_WINDOW_TOKENS) and the full native set.
 * Measured on the business starter's Home page and rounded up (tests/unit/chat-headroom.test.ts keeps them honest).
 */
export const LOCAL_OVERHEAD_TOKENS = { constrained: 3584, focused: 10_240, general: 17_408 } as const;
/** The smallest reply worth asking for, as the assistant keeps it free (budget.ts MIN_OUTPUT_TOKENS). */
const REPLY_TOKENS = 1024;

export interface HeadroomInput {
  /** The message being written. */
  draft: string;
  /** The earlier messages a request replays with it, oldest first. */
  history: readonly string[];
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

/** The share of the window the messages may take: half, or less where the instructions leave less. */
export function messageRoom(windowTokens: number, toolMode: LocalToolMode): number {
  const overhead = toolMode !== 'native' ? LOCAL_OVERHEAD_TOKENS.constrained : windowTokens < FOCUSED_WINDOW_TOKENS ? LOCAL_OVERHEAD_TOKENS.focused : LOCAL_OVERHEAD_TOKENS.general;
  return Math.max(0, Math.min(Math.floor(windowTokens / 2), windowTokens - overhead - REPLY_TOKENS));
}

const n = (t: number) => t.toLocaleString('en-US');

/** Null while the message fits; otherwise what to do about it, for a local model. */
export function headroomWarning(input: HeadroomInput): HeadroomWarning | null {
  if (!input.draft.trim()) return null;
  const set = localContextWindow(input.contextWindow);
  const windowTokens = set ?? DEFAULT_LOCAL_CONTEXT_WINDOW;
  const assumed = set === null;
  const roomTokens = messageRoom(windowTokens, input.toolMode);
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
