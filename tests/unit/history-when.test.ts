import { describe, expect, it } from 'vitest';
import { clock, dayAndTime, dayKey, dayName, daysAgo } from '../../src/renderer/src/lib/when';
import { savedAt } from '../../src/renderer/src/lib/versions';

// History's times, read against a fixed afternoon so the day boundaries are known.
const now = new Date(2026, 10, 26, 15, 0);
const at = (day: number, h: number, m = 0, month = 10, year = 2026) => new Date(year, month, day, h, m).toISOString();

describe('History times', () => {
  it('names the day a change was made: today, yesterday, else its weekday and date', () => {
    expect(dayName(at(26, 0, 5), now, 'en-US')).toBe('Today');
    expect(dayName(at(25, 23, 59), now, 'en-US')).toBe('Yesterday');
    expect(dayName(at(23, 9), now, 'en-US')).toBe('Monday, Nov 23');
    expect(dayName(at(12, 9), now, 'en-US')).toBe('Thursday, Nov 12');
    expect(dayName(at(12, 9, 0, 10, 2025), now, 'en-US')).toBe('Wednesday, Nov 12, 2025');
    expect(daysAgo(at(25, 23, 59), now)).toBe(1);
  });

  it('groups by local day, and says the time without a leading zero', () => {
    expect(dayKey(at(26, 0, 1))).toBe(dayKey(at(26, 23, 59)));
    expect(dayKey(at(26, 0, 1))).not.toBe(dayKey(at(25, 23, 59)));
    expect(clock(at(26, 7, 58), 'en-US')).toBe('7:58 AM');
  });

  it('says when a version was saved with its day, and the year only when it is another', () => {
    expect(dayAndTime(at(26, 14, 34), now, 'en-US')).toBe('Today, 2:34 PM');
    expect(savedAt(at(25, 7, 34), 'en-US', now)).toBe('Yesterday, 7:34 AM');
    expect(savedAt(at(21, 10, 34), 'en-US', now)).toBe('Nov 21, 10:34 AM');
    expect(savedAt(at(2, 10, 34, 0, 2025), 'en-US', now)).toBe('Jan 2, 2025, 10:34 AM');
  });
});
