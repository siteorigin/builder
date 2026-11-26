/**
 * The earlier part of a conversation as the assistant still hears it (issue 745): once a conversation runs past the
 * replayed window, its older exchanges reach the model as a short summary of what was decided, asked, answered and
 * changed, before the recent messages in full. Built from the transcript alone, never by asking a model, so the same
 * messages always give the same summary: the main process stores and extends one with the conversation, and the
 * composer works out the same one from the messages it shows.
 */
import { turnQuestions, type ChatMessage } from './api';
import { MAX_REPLAYED_ANSWER, REPLAYED_MESSAGES } from './turn-model';
import { resultAsSaid, runStanding, withoutKeptClaims, type TurnHistory } from './turns';

/** One earlier exchange as the summary keeps it: the author's words and answers, and what the turn did. */
export interface SummaryTurn {
  /** The index in the conversation of the exchange's first message. */
  from: number;
  /** What the author asked, on one line, shortened when long. */
  asked?: string;
  /** The questions the assistant asked during the turn, with the author's answer; none when it was never answered. */
  answers?: Array<{ q: string; a?: string }>;
  /** What the turn said it did, shortened. */
  said?: string;
  /** The changes it listed. */
  changes?: string[];
  /** The run, so where its change stands is read from History at each request rather than frozen here. */
  runId?: string;
  /** Its result could be undone: it changed the site. */
  changed?: true;
  /** It ended before the request was finished. */
  unfinished?: true;
  /** Undone once, by what an earlier version recorded (see resultAsSaid). */
  undoneOnce?: true;
  /** How it ended, when it did not complete. */
  ended?: 'failed' | 'cancelled' | 'conflicted';
}

/** The summary a conversation stores: the exchanges before its replayed window, oldest first. */
export interface EarlierSummary {
  /** How many of the conversation's first messages it has taken in. */
  covered: number;
  /** The ID of the last of them: a summary never stands for another transcript. */
  throughId: string;
  turns: SummaryTurn[];
  /** Exchanges older than `turns` that it no longer holds, so it stays short. */
  omitted: number;
}

/** The most exchanges a summary holds; older ones are counted, not kept. */
export const SUMMARY_TURNS = 20;
/** How much of each part of an exchange the summary keeps, in characters. */
const ASKED_CHARS = 400;
const QUESTION_CHARS = 200;
const ANSWER_CHARS = 300;
const SAID_CHARS = 300;
const CHANGE_CHARS = 80;
const CHANGES = 8;

/** Text on one line, shortened to `max` characters: its start and its end, since a long paste often ends with the ask. */
function brief(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const line = raw.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  const tail = Math.floor(max / 3);
  return `${chars.slice(0, max - tail - 3).join('').trimEnd()} … ${chars.slice(-tail).join('').trimStart()}`;
}

function attachedNames(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((i) => !!i && typeof i.name === 'string' && i.name.trim()).map((i) => brief(i.name, 60)) : [];
}

/** The author's part of an exchange. */
function askedOf(m: ChatMessage): string {
  const said = brief(m.text, ASKED_CHARS);
  const names = attachedNames(m.images);
  return names.length ? `${said}${said ? ' ' : ''}(attached ${names.join(', ')})` : said;
}

/**
 * An answer as the summary keeps it: never more of it than a replay in full sends (its start), so summarising an
 * exchange sends no words its recipient has not had; and a chosen image by its ID too, since two can share a name.
 */
function answerOf(q: NonNullable<ChatMessage['questions']>[number]): string | undefined {
  if (typeof q.answered !== 'string') return undefined;
  const picked = typeof q.answeredAssetId === 'string' && Array.isArray(q.images) ? q.images.find((i) => i?.assetId === q.answeredAssetId) : undefined;
  if (picked && typeof picked.name === 'string') return `image "${brief(picked.name, 60)}" (assetId: ${picked.assetId})`;
  return brief(q.answered.slice(0, MAX_REPLAYED_ANSWER), ANSWER_CHARS);
}

/** Take the assistant's part of an exchange into `turn`. */
function takeReply(turn: SummaryTurn, m: ChatMessage) {
  const answers: NonNullable<SummaryTurn['answers']> = [];
  for (const q of turnQuestions(m)) {
    // A transcript is read back from disk: anything malformed is left out.
    if (typeof q?.text !== 'string' || !q.text.trim()) continue;
    const a = answerOf(q);
    answers.push({ q: brief(q.text, QUESTION_CHARS), ...(a !== undefined ? { a } : {}) });
  }
  if (answers.length) turn.answers = answers;
  const raw = m.result && typeof m.result === 'object' ? m.result : null;
  if (raw) {
    const { result, undoneOnce } = resultAsSaid(raw, typeof m.text === 'string' ? m.text : undefined);
    const said = brief(typeof result.summary === 'string' ? withoutKeptClaims(result.summary) : '', SAID_CHARS);
    if (said) turn.said = said;
    const changes = (Array.isArray(result.changes) ? result.changes : []).map((c) => brief(c?.label, CHANGE_CHARS)).filter(Boolean);
    if (changes.length) turn.changes = changes.length > CHANGES ? [...changes.slice(0, CHANGES), `${changes.length - CHANGES} more`] : changes;
    if (result.canUndo === true) turn.changed = true;
    if (result.incomplete) turn.unfinished = true;
    if (undoneOnce) turn.undoneOnce = true;
    if (result.status === 'failed' || result.status === 'cancelled' || result.status === 'conflicted') turn.ended = result.status;
    if (typeof m.runId === 'string' && m.runId) turn.runId = m.runId;
  } else {
    const said = brief(m.text, SAID_CHARS);
    if (said) turn.said = said;
  }
}

const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
const isText = (v: unknown) => typeof v === 'string';

/** A stored exchange the summary can be written from without a check of its own: anything else is not reused. */
function isTurn(t: unknown, covered: number): t is SummaryTurn {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  const x = t as Record<keyof SummaryTurn, unknown>;
  return (
    typeof x.from === 'number' &&
    Number.isInteger(x.from) &&
    x.from >= 0 &&
    x.from < covered &&
    optional(x.asked, isText) &&
    optional(x.said, isText) &&
    optional(x.runId, isText) &&
    optional(x.answers, (v) => Array.isArray(v) && v.every((a) => !!a && typeof a === 'object' && isText(a.q) && optional(a.a, isText))) &&
    optional(x.changes, (v) => Array.isArray(v) && v.every(isText)) &&
    optional(x.changed, (v) => v === true) &&
    optional(x.unfinished, (v) => v === true) &&
    optional(x.undoneOnce, (v) => v === true) &&
    optional(x.ended, (v) => v === 'failed' || v === 'cancelled' || v === 'conflicted')
  );
}

/** A stored summary that still stands for this conversation's opening messages, or null. */
function readSummary(raw: unknown, messages: readonly ChatMessage[]): EarlierSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<EarlierSummary>;
  if (typeof s.covered !== 'number' || !Number.isInteger(s.covered) || s.covered < 1 || s.covered > messages.length) return null;
  if (typeof s.throughId !== 'string' || !s.throughId || messages[s.covered - 1]?.id !== s.throughId) return null;
  if (!Array.isArray(s.turns) || s.turns.length > SUMMARY_TURNS || typeof s.omitted !== 'number' || !Number.isInteger(s.omitted) || s.omitted < 0) return null;
  if (!s.turns.every((t) => isTurn(t, s.covered!))) return null;
  return { covered: s.covered, throughId: s.throughId, turns: s.turns, omitted: s.omitted };
}

/**
 * The summary of a conversation's first `end` messages: `stored` extended by the messages after the ones it covers,
 * or built from the start when it is missing or does not match. Pure: `stored` is never changed, and building from
 * the start gives the same summary as extending, so the composer and the main process agree.
 */
export function summarizeEarlier(messages: readonly ChatMessage[], end: number, stored?: unknown): EarlierSummary | null {
  if (end < 1) return null;
  let s = readSummary(stored, messages);
  if (s && s.covered > end) s = null;
  if (s && s.covered === end) return s;
  const turns = s ? s.turns.map((t) => ({ ...t })) : [];
  let omitted = s?.omitted ?? 0;
  for (let i = s?.covered ?? 0; i < end; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const last = turns.at(-1);
    if (m.role === 'assistant') {
      // The reply to the request just before it; a reply with no request of its own is an exchange by itself.
      if (last && last.from === i - 1 && messages[i - 1]?.role === 'user') takeReply(last, m);
      else {
        const turn: SummaryTurn = { from: i };
        takeReply(turn, m);
        turns.push(turn);
      }
    } else if (m.role === 'user') {
      const asked = askedOf(m);
      turns.push({ from: i, ...(asked ? { asked } : {}) });
    }
  }
  if (turns.length > SUMMARY_TURNS) omitted += turns.splice(0, turns.length - SUMMARY_TURNS).length;
  if (!turns.length && !omitted) return null;
  // A message read back without an ID leaves nothing to match the next time: the summary is then built again.
  const through = messages[end - 1]?.id;
  return { covered: end, throughId: typeof through === 'string' ? through : '', turns, omitted };
}

/** Where the replayed window starts: everything before it reaches the model through the summary. */
export function replayStart(messages: readonly unknown[]): number {
  return Math.max(0, messages.length - REPLAYED_MESSAGES);
}

/** What a request carries of the conversation before it: a summary of the older messages, and the recent ones in full. */
export interface Replay {
  summary: EarlierSummary | null;
  recent: ChatMessage[];
}

/** Replays worked out from the messages alone, for the composer, which asks again at every key typed. */
const planned = new WeakMap<readonly ChatMessage[], Replay>();

/** The replay of a conversation as it stands, extending a stored summary when there is one. */
export function planReplay(messages: readonly ChatMessage[], stored?: unknown): Replay {
  const cached = stored === undefined ? planned.get(messages) : undefined;
  if (cached) return cached;
  const start = replayStart(messages);
  const plan = { summary: summarizeEarlier(messages, start, stored), recent: messages.slice(start) };
  if (stored === undefined) planned.set(messages, plan);
  return plan;
}

/**
 * The messages whose words reach the model in a request: those the summary still holds and the recent ones. An
 * exchange the summary only counts is not among them.
 */
export function sentMessages(messages: readonly ChatMessage[], replay: Replay = planReplay(messages)): ChatMessage[] {
  const start = replayStart(messages);
  const from = replay.summary?.turns[0]?.from ?? start;
  return messages.slice(Math.min(from, start));
}

/** Where an earlier turn's change stands, in words, read from History now. */
function standingText(t: SummaryTurn, history: TurnHistory | null | undefined): string {
  // A file changed outside the app while it ran: some of its changes may have been rolled back, others left to review.
  if (t.ended === 'conflicted') return 'It ran into a file changed outside the app, so which of its changes remain is not known.';
  const how = t.ended === 'failed' ? 'It failed' : t.ended === 'cancelled' ? 'It was stopped' : t.unfinished ? 'It stopped before it was finished' : '';
  if (!t.changed) return how ? `${how}, and changed nothing.` : t.said || t.changes ? 'It changed nothing.' : '';
  const standing = runStanding(t.runId, history);
  const where =
    standing === 'applied'
      ? 'its changes are still in the site'
      : standing === 'undone'
        ? 'its changes were undone afterwards'
        : t.undoneOnce
          ? 'its changes were undone afterwards, and may have been redone since'
          : 'whether its changes are still in the site is not known';
  return how ? `${how}; ${where}.` : `${where[0].toUpperCase()}${where.slice(1)}.`;
}

/** The label the summary goes out under, so the model can tell it from the messages that follow. */
export const SUMMARY_LABEL = 'Summary of the earlier conversation';

/**
 * The summary as the model reads it: one labelled message, an exchange per line group, each change's standing read
 * from `history` now (a turn undone after it was summarised says so).
 */
export function summaryText(summary: EarlierSummary, history?: TurnHistory | null): string {
  const lines = [`[${SUMMARY_LABEL}: its older messages, shortened. The recent messages follow in full.]`];
  if (summary.omitted) lines.push(`(${summary.omitted} earlier ${summary.omitted === 1 ? 'exchange is' : 'exchanges are'} no longer summarized.)`);
  summary.turns.forEach((t, i) => {
    const parts: string[] = [];
    if (t.asked) parts.push(`The author asked: "${t.asked}"`);
    for (const a of t.answers ?? []) parts.push(a.a !== undefined ? `Asked "${a.q}"; the author answered "${a.a}".` : `Asked "${a.q}"; it was never answered.`);
    if (t.said) parts.push(`Reply: ${t.said}`);
    if (t.changes?.length) parts.push(`Changes: ${t.changes.join('; ')}.`);
    const standing = standingText(t, history);
    if (standing) parts.push(standing);
    if (parts.length) lines.push(`${i + 1}. ${parts.join(' ')}`);
  });
  return lines.join('\n');
}
