/**
 * Publishing a future-dated post (#1115): nothing holds it back until its day, so Publish asks first, naming the date,
 * and offers keeping it as a draft. A post dated today or earlier publishes without a question.
 */
import { describe, expect, it } from 'vitest';
import { todayArticleDate } from '@shared/articles';
import { futurePublishChoice, futurePublishQuestion } from '../../src/renderer/src/lib/posts';

const today = '2026-11-27';
const ask = (date: unknown) => futurePublishQuestion(date, 'post', 'en-GB', today);

describe('publishing a future-dated post', () => {
  it('asks nothing for a post dated yesterday', () => {
    expect(ask('2026-11-26')).toBeNull();
  });

  it('asks nothing for a post dated today', () => {
    expect(ask(today)).toBeNull();
  });

  it('asks before publishing a post dated tomorrow, naming the date and both choices', () => {
    const q = ask('2026-11-28');
    expect(q).not.toBeNull();
    expect(q!.title).toBe('Publish this post dated 28 November 2026?');
    expect(q!.subject).toBe('28 November 2026');
    expect(q!.body).toContain('next export');
    expect(q!.confirmLabel).toBe('Publish now');
    expect(q!.cancelLabel).toBe('Keep as draft');
  });

  it('asks for a date years ahead, across a year and a month boundary', () => {
    expect(ask('2099-01-01')?.subject).toBe('1 January 2099');
    expect(futurePublishQuestion('2027-01-01', 'post', 'en-GB', '2026-12-31')?.subject).toBe('1 January 2027');
    expect(futurePublishQuestion('2026-12-01', 'post', 'en-GB', '2026-11-30')).not.toBeNull();
    expect(futurePublishQuestion('2026-11-30', 'post', 'en-GB', '2026-12-01')).toBeNull();
  });

  it('names the collection’s own noun and writes the date in the site’s language', () => {
    const q = futurePublishQuestion('2026-11-28', 'event', 'en-US', today);
    expect(q!.title).toBe('Publish this event dated November 28, 2026?');
    expect(q!.body).toContain('This event');
  });

  it('asks nothing for a post without a valid date', () => {
    expect(ask(undefined)).toBeNull();
    expect(ask('')).toBeNull();
    expect(ask('2026-02-30')).toBeNull();
  });

  it('compares calendar days on this computer: today is the local day, not the UTC one', () => {
    // 23:30 local time on the 27th is still the 27th, whatever UTC says.
    const late = new Date(2026, 10, 27, 23, 30);
    expect(todayArticleDate(late)).toBe('2026-11-27');
    expect(futurePublishQuestion('2026-11-27', 'post', 'en', todayArticleDate(late))).toBeNull();
    expect(futurePublishQuestion('2026-11-28', 'post', 'en', todayArticleDate(late))).not.toBeNull();
  });

  it('publishes on Publish now, keeps the draft on Keep as draft, and does nothing when the question is dismissed', () => {
    expect(futurePublishChoice(true)).toBe('publish');
    expect(futurePublishChoice(false)).toBe('keep-draft');
    expect(futurePublishChoice(null)).toBe('stay');
  });
});
