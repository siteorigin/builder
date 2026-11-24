import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOUBLE_CLICK_MS, listPageClicks, pageClicks, settlePageClick } from '../../src/renderer/src/lib/page-clicks';

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

  it('waits 400 ms, short of the usual 500 ms double-click time, so an ordinary click is not held long', () => {
    expect(DOUBLE_CLICK_MS).toBe(400);
  });

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
    // Contact waits its own full time from its click, not what was left of About's.
    vi.advanceTimersByTime(DOUBLE_CLICK_MS - 1);
    expect(log).toEqual(['open about']);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['open about', 'open contact']);
  });

  it('opens a page still waiting before renaming another row double-clicked', () => {
    const c = make();
    c.click('about', 1);
    c.click('contact', 2);
    expect(log).toEqual(['open about', 'rename contact']);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    expect(log).toEqual(['open about', 'rename contact']);
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
    expect(c.waiting()).toBeNull();
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    c.settle();
    expect(log).toEqual([]);
    // Its clock goes with it: a click made after it waits its own full time.
    c.click('contact', 1);
    vi.advanceTimersByTime(300);
    c.drop();
    c.click('home', 1);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['open home']);
  });

  it('holds a page while its row is pressed, whatever the clock says, until the press turns out to be a click or not', () => {
    const c = make();
    c.click('about', 1);
    expect(c.held()).toBe(false);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS - 10);
    c.hold();
    expect(c.held()).toBe(true);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    expect(log).toEqual([]);
    expect(c.waiting()).toBe('about');
    // Released as a second click: a rename, never an open.
    c.click('about', 2);
    expect(log).toEqual(['rename about']);
    // Released as no click on the row: the page opens.
    c.click('contact', 1);
    c.hold();
    c.settle();
    expect(log).toEqual(['rename about', 'open contact']);
  });

  it('opens at once for a click no pointer made', () => {
    const c = make();
    c.click('about', 0);
    expect(log).toEqual(['open about']);
    expect(c.waiting()).toBeNull();
    // A page still waiting opens first, so the later choice is the one left open.
    c.click('contact', 1);
    c.click('home', 0);
    expect(log).toEqual(['open about', 'open contact', 'open home']);
    // On the row waiting, the page opens once.
    c.click('about', 1);
    c.click('about', 0);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    expect(log).toEqual(['open about', 'open contact', 'open home', 'open about']);
  });

  it('lets the canvas open a page waiting before it acts on a pick, and tells it there was one', () => {
    const c = make();
    expect(settlePageClick()).toBe(false);
    const unlist = listPageClicks(c);
    expect(settlePageClick()).toBe(false);
    c.click('about', 1);
    expect(settlePageClick()).toBe(true);
    expect(log).toEqual(['open about']);
    expect(settlePageClick()).toBe(false);
    // Once the list has gone, a newer list's clicks are not let go by the old one.
    const newer = make();
    const unlistNewer = listPageClicks(newer);
    unlist();
    newer.click('contact', 1);
    expect(settlePageClick()).toBe(true);
    unlistNewer();
    newer.click('home', 1);
    expect(settlePageClick()).toBe(false);
  });

  it('never lets the canvas open a page whose row is being pressed, which may be a double click', () => {
    const c = make();
    const unlist = listPageClicks(c);
    c.click('about', 1);
    c.hold();
    expect(settlePageClick()).toBe(false);
    c.click('about', 2);
    expect(log).toEqual(['rename about']);
    unlist();
  });
});
