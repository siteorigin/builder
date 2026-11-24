import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOUBLE_CLICK_MS, pageClicks } from '../../src/renderer/src/lib/page-clicks';

// Issue #209: double-clicking a page to rename it opened the page on the first click, leaving Edit everywhere and
// moving the preview, even when the rename was then cancelled.
describe('clicks on a page row', () => {
  let log: string[];
  const make = () => pageClicks({ open: (id) => log.push(`open ${id}`), rename: (id) => log.push(`rename ${id}`) });
  beforeEach(() => {
    vi.useFakeTimers();
    log = [];
  });
  afterEach(() => vi.useRealTimers());

  it('opens the page once no second click has come', () => {
    const c = make();
    c.click('about', 1);
    expect(log).toEqual([]);
    expect(c.waiting()).toBe('about');
    vi.advanceTimersByTime(DOUBLE_CLICK_MS - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['open about']);
    expect(c.waiting()).toBeNull();
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 3);
    expect(log).toEqual(['open about']);
  });

  it('renames on a double click without ever opening the page', () => {
    const c = make();
    c.click('about', 1);
    vi.advanceTimersByTime(150);
    c.click('about', 2);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 3);
    expect(log).toEqual(['rename about']);
    // A third click lands on the rename field, not the row; if it reaches the row it does nothing more.
    c.click('about', 3);
    expect(log).toEqual(['rename about']);
  });

  it('still renames on a double click slower than the wait, the page having opened by then', () => {
    const c = make();
    c.click('about', 1);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS + 50);
    c.click('about', 2);
    expect(log).toEqual(['open about', 'rename about']);
  });

  it('opens a page clicked a moment ago before another row’s click starts waiting, and never renames either', () => {
    const c = make();
    c.click('about', 1);
    vi.advanceTimersByTime(100);
    c.click('contact', 1);
    expect(log).toEqual(['open about']);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(log).toEqual(['open about', 'open contact']);
  });

  it('opens the waiting page at once when the author does something else, and only once', () => {
    const c = make();
    c.click('about', 1);
    c.settle();
    expect(log).toEqual(['open about']);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    c.settle();
    expect(log).toEqual(['open about']);
  });

  it('forgets the waiting page without opening it when the list goes', () => {
    const c = make();
    c.click('about', 1);
    c.drop();
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    expect(log).toEqual([]);
  });

  it('opens at once for a click no pointer made', () => {
    const c = make();
    c.click('about', 0);
    expect(log).toEqual(['open about']);
    expect(c.waiting()).toBeNull();
  });
});
