/**
 * How Earlier conversations and the conversation manager word what they list (issue 235).
 */
import type { ConversationMatch } from '@shared/conversations';

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When a conversation was last added to, short enough for a menu: the time of day for today (so a day's threads
 * read apart), Yesterday, the date this year, and the date with its year before that.
 */
/** What a conversation's list row says when it owns the active background request, else null. */
export function runLabel(id: string, run: { status: string | null; conversationId: string | null }): string | null {
  if (!run.status || run.conversationId !== id) return null;
  return run.status === 'awaiting-input' ? 'Needs your answer' : run.status === 'stopping' ? 'Stopping' : 'Working';
}

export function activityHint(iso: string, now = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (days === 0) return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(locale, d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The same, said in full for a list row: “today at 2:40 pm”, “yesterday”, “on 20 Nov”. */
export function activityPhrase(iso: string, now = new Date(), locale?: string): string {
  const hint = activityHint(iso, now, locale);
  if (!hint) return '';
  const days = Math.round((dayStart(now) - dayStart(new Date(iso))) / 86400000);
  return days === 0 ? `today at ${hint}` : days === 1 ? 'yesterday' : `on ${hint}`;
}

/**
 * The part of a matched request worth showing: the match with some words either side, on one line, with an ellipsis
 * where the request goes on. A match deep in a long request is shown where it is, never cut off by a clamp.
 */
export function matchExcerpt(m: Pick<ConversationMatch, 'text' | 'start' | 'end'>, around = 48): { before: string; hit: string; after: string } {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  let from = Math.max(0, m.start - around);
  let to = Math.min(m.text.length, m.end + around);
  // Start and end at a word, when there is one close by.
  if (from > 0) {
    const space = m.text.indexOf(' ', from);
    if (space >= 0 && space < m.start) from = space + 1;
  }
  if (to < m.text.length) {
    const space = m.text.lastIndexOf(' ', to);
    if (space > m.end) to = space;
  }
  return {
    before: `${from > 0 ? '…' : ''}${flat(m.text.slice(from, m.start)).trimStart()}`,
    hit: flat(m.text.slice(m.start, m.end)),
    after: `${flat(m.text.slice(m.end, to)).trimEnd()}${to < m.text.length ? '…' : ''}`
  };
}
