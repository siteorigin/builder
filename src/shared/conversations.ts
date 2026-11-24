/**
 * AI conversations as the author finds them again (issue 235): the title each one goes by, what the list shows to
 * tell similar ones apart, the order it lists them in, and the search that finds one by its title or by anything
 * the author asked in it.
 */
import type { ChatMessage, Conversation, ConversationSummary } from './api';

/** A conversation's title before its first message. */
export const NEW_CONVERSATION = 'New conversation';
/** The longest title a conversation takes, whether the author names it or it is taken from the first request. */
export const TITLE_MAX = 80;
/** How much of the first request an unnamed conversation's title shows. */
const AUTO_TITLE_CHARS = 60;
/** The cut the first versions made: the first request's first 60 UTF-16 units, often mid-word. */
const LEGACY_TITLE_CHARS = 60;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The title a conversation takes from its first request: that request on one line, cut at the end of a word with an
 * ellipsis when it is longer than the title shows. A long word running past the cut is kept whole while the title
 * still fits; only a single word longer than any title (a long link, say) is cut inside it.
 */
export function autoTitle(text: string): string {
  const line = oneLine(text);
  const chars = Array.from(line);
  if (chars.length <= AUTO_TITLE_CHARS) return line;
  let end = AUTO_TITLE_CHARS;
  // Back to the last word that ends by the cut, unless that would keep less than half the room.
  const space = chars.lastIndexOf(' ', AUTO_TITLE_CHARS);
  if (space >= AUTO_TITLE_CHARS / 2) end = space;
  else {
    // On to the end of the word the cut falls in, when it ends in time for the ellipsis.
    let next = AUTO_TITLE_CHARS;
    while (next < chars.length && chars[next] !== ' ') next++;
    // Room for the ellipsis, unless the request ends with that word.
    if (next < TITLE_MAX || (next === chars.length && next <= TITLE_MAX)) end = next;
  }
  const cut = chars.slice(0, end).join('').replace(/[\s,;:.!?\-–—]+$/u, '');
  return end < chars.length ? `${cut}…` : cut;
}

/** A title the author typed, on one line, or null when nothing is left of it or it is too long. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = oneLine(raw.normalize('NFC'));
  if (!t || Array.from(t).length > TITLE_MAX) return null;
  return t;
}

/** The requests the author wrote in a conversation, in order, as stored text. */
export function promptsOf(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m?.role === 'user' && typeof m.text === 'string' && m.text.trim()).map((m) => m.text);
}

/**
 * The title a stored conversation goes by. One the author named keeps that name. An unnamed one stored with the old
 * mid-word cut of its first request is shown with that request cut at a word instead, so every list reads the same.
 */
export function storedTitle(c: Pick<Conversation, 'title' | 'named' | 'messages'>): string {
  const title = typeof c.title === 'string' ? c.title : '';
  if (c.named) return title || NEW_CONVERSATION;
  const first = promptsOf(Array.isArray(c.messages) ? c.messages : [])[0];
  if (first !== undefined && (!title || title === NEW_CONVERSATION || title === first.trim().slice(0, LEGACY_TITLE_CHARS))) return autoTitle(first);
  return title || NEW_CONVERSATION;
}

/** When a conversation was last added to: its newest message, or when it was started. */
export function lastActivity(c: Pick<Conversation, 'createdAt' | 'messages'>): string {
  let latest = typeof c.createdAt === 'string' ? c.createdAt : '';
  for (const m of Array.isArray(c.messages) ? c.messages : []) {
    if (typeof m?.time === 'string' && !Number.isNaN(Date.parse(m.time)) && m.time > latest) latest = m.time;
  }
  return latest;
}

/** What the list shows of a stored conversation. */
export function summarize(c: Conversation): ConversationSummary {
  return { id: c.id, title: storedTitle(c), createdAt: c.createdAt, updatedAt: lastActivity(c), prompts: promptsOf(c.messages), ...(c.named ? { named: true } : {}) };
}

/** Newest activity first; two with the same time, the one started later first. */
export function byRecentActivity(a: ConversationSummary, b: ConversationSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Text folded for a search, with where each folded character came from in the original (the start and the end of
 * that character): case and accents never stop a match ("cafe" finds "Café", "ος" finds "ΟΣ"), and a match can
 * still be marked in the text as written, a ligature ("ﬃ") whole.
 */
function fold(text: string): { folded: string; from: number[]; to: number[] } {
  let folded = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');
    for (let k = 0; k < f.length; k++) (from.push(i), to.push(i + ch.length));
    // A mark that folds away (a decomposed accent) belongs to the letter before it, so a match takes it along.
    if (!f && to.length) to[to.length - 1] = i + ch.length;
    folded += f;
    i += ch.length;
  }
  return { folded, from, to };
}

/** The words of a search, folded; empty when there is nothing to search for. */
export function searchWords(query: string): string[] {
  return oneLine(query)
    .split(' ')
    .map((w) => fold(w).folded)
    .filter(Boolean);
}

/** Where a search matched: the text it matched in, and the span to mark, in that text's own characters. */
export interface ConversationMatch {
  /** 'title', or the request it matched in. */
  in: 'title' | 'prompt';
  text: string;
  start: number;
  end: number;
}

/**
 * Whether a conversation answers a search: every word is in its title or in something the author asked in it. The
 * match returned is the first text holding the whole phrase, else the first holding the first word, so the list can
 * show the request that was found when the title alone would not explain it.
 */
export function matchConversation(c: Pick<ConversationSummary, 'title' | 'prompts'>, query: string): ConversationMatch | null {
  const words = searchWords(query);
  if (!words.length) return null;
  const texts: Array<{ in: ConversationMatch['in']; text: string; f: ReturnType<typeof fold> }> = [{ in: 'title', text: c.title, f: fold(c.title) }, ...c.prompts.map((p) => ({ in: 'prompt' as const, text: p, f: fold(p) }))];
  if (!words.every((w) => texts.some((t) => t.f.folded.includes(w)))) return null;
  const phrase = words.join(' ');
  const find = (needle: string) => {
    for (const t of texts) {
      const flat = t.f.folded.replace(/\s/g, ' ');
      const at = flat.indexOf(needle);
      if (at >= 0) return { in: t.in, text: t.text, start: t.f.from[at], end: t.f.to[at + needle.length - 1] };
    }
    return null;
  };
  return find(phrase) ?? find(words[0]);
}
