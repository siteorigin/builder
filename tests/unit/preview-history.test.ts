import { describe, expect, it } from 'vitest';
import { addressPath, frameEntry, NO_HISTORY, observe, siteAddresses, startJourney, stepTarget, type FrameEntry, type VisitorHistory } from '../../src/renderer/src/lib/preview-history';
import { forwardedVisitorStep, forwardedKeyRuns, type HistoryContext } from '../../src/renderer/src/lib/history';
import { visitorStepKey, type KeyChord } from '../../src/shared/preview-keys';

/** A frame history as the page reports it: the entries' keys in order, and the index it is on. */
function frame(keys: string[], at: number, address = `/${keys[at]}/`): FrameEntry {
  return { address, key: keys[at], back: keys[at - 1] ?? null, forward: keys[at + 1] ?? null };
}
/** Report each frame position in turn, previewing or not. */
const walk = (h: VisitorHistory, previewing: boolean, ...at: FrameEntry[]) => at.reduce((acc, e) => observe(acc, e, previewing), h);
const steps = (h: VisitorHistory) => ({ back: stepTarget(h, 'back'), forward: stepTarget(h, 'forward') });
const SITE = siteAddresses(['/', '/about/', '/contact/']);
/** Preview entered, on a settled frame, on the usual site. */
const enter = (h: VisitorHistory) => startJourney(h, SITE);

describe('a visitor’s journey in Preview', () => {
  it('steps back and forward through the pages visited, a section jump included', () => {
    // Home → About → /contact/#studio-hours → /contact/#form, all visited while previewing.
    const keys = ['home', 'about', 'hours', 'form'];
    let h = enter(walk(NO_HISTORY, false, frame(['home'], 0)));
    h = walk(h, true, frame(keys.slice(0, 2), 1), frame(keys.slice(0, 3), 2, '/contact/#studio-hours'), frame(keys, 3, '/contact/#form'));
    expect(h.at?.address).toBe('/contact/#form');
    // The section jump stayed on Contact: Back goes to the studio hours, then About.
    expect(steps(h)).toEqual({ back: 'hours', forward: null });
    h = observe(h, frame(keys, 2, '/contact/#studio-hours'), true);
    expect(steps(h)).toEqual({ back: 'about', forward: 'form' });
    h = observe(h, frame(keys, 1), true);
    expect(steps(h)).toEqual({ back: 'home', forward: 'hours' });
    // Forward again.
    h = observe(h, frame(keys, 2, '/contact/#studio-hours'), true);
    expect(steps(h)).toEqual({ back: 'about', forward: 'form' });
  });

  it('drops Forward when a new link is followed after Back, and counts each entry once', () => {
    let h = enter(walk(NO_HISTORY, false, frame(['home'], 0)));
    h = walk(h, true, frame(['home', 'about'], 1), frame(['home', 'about', 'contact'], 2), frame(['home', 'about', 'contact'], 1));
    expect(steps(h).forward).toBe('contact');
    expect(h.visited.filter((k) => k === 'about')).toHaveLength(1);
    // The frame's own history drops the entries ahead when a link is followed.
    h = observe(h, frame(['home', 'about', 'services'], 2), true);
    expect(steps(h)).toEqual({ back: 'about', forward: null });
  });

  it('never steps to pages the author opened while editing, behind or ahead', () => {
    // Edit: Home, then About from the page picker. Preview starts on About.
    let h = walk(NO_HISTORY, false, frame(['home'], 0), frame(['home', 'about'], 1));
    h = enter(h);
    expect(steps(h)).toEqual({ back: null, forward: null });
    h = observe(h, frame(['home', 'about', 'contact'], 2), true);
    expect(steps(h)).toEqual({ back: 'about', forward: null });
    h = observe(h, frame(['home', 'about', 'contact'], 1), true);
    expect(steps(h)).toEqual({ back: null, forward: 'contact' });
    // An entry ahead that only Edit mode visited is not a step either.
    const edited = enter(walk(NO_HISTORY, false, frame(['home', 'about'], 1), frame(['home', 'about'], 0)));
    expect(steps(edited)).toEqual({ back: null, forward: null });
  });

  it('starts once a page the editor is still opening is there, not on the page it leaves', () => {
    // Edit: Home shown, About picked. Preview is entered before the frame has confirmed About.
    let h = startJourney(walk(NO_HISTORY, false, frame(['home'], 0)), SITE, false);
    expect(h.visited).toEqual([]);
    h = observe(h, frame(['home', 'about'], 1), true);
    h = observe(h, frame(['home', 'about', 'contact'], 2), true);
    expect(steps(observe(h, frame(['home', 'about', 'contact'], 1), true))).toEqual({ back: null, forward: 'contact' });
  });

  it('carries on after a visit to Edit that opened and moved no page, and starts again after one that did', () => {
    let h = enter(walk(NO_HISTORY, false, frame(['home'], 0)));
    h = walk(h, true, frame(['home', 'about', 'contact'], 1), frame(['home', 'about', 'contact'], 2), frame(['home', 'about', 'contact'], 1));
    // Back to editing (some text changed) and straight back to Preview, on About: both directions are still there.
    h = enter(h);
    expect(steps(h)).toEqual({ back: 'home', forward: 'contact' });
    // A page was deleted or moved meanwhile: a step could lead to a page that is gone, so a new journey starts.
    expect(steps(startJourney(h, siteAddresses(['/', '/about/'])))).toEqual({ back: null, forward: null });
    expect(steps(startJourney(h, siteAddresses(['/', '/about-us/', '/contact/'])))).toEqual({ back: null, forward: null });
    // Edit again, and open Contact from the page picker: a new journey starts there.
    h = observe(h, frame(['home', 'about', 'contact2'], 2), false);
    h = enter(h);
    expect(steps(h)).toEqual({ back: null, forward: null });
  });

  it('keeps a section jump the site re-stamps (same entry key) as one visit', () => {
    let h = enter(walk(NO_HISTORY, false, frame(['about'], 0)));
    h = walk(h, true, frame(['about', 'team'], 1, '/about/#team'), frame(['about', 'team'], 1, '/about/#team'), frame(['about', 'team'], 0));
    expect(h.visited).toEqual(['team', 'about']);
    expect(steps(h)).toEqual({ back: null, forward: 'team' });
  });

  it('keeps the entries still reachable however many are left behind', () => {
    // Home → About, Back, About again: each new About replaces the last one ahead of Home.
    let h = enter(walk(NO_HISTORY, false, frame(['home'], 0)));
    for (let i = 0; i < 1500; i++) h = walk(h, true, frame(['home', `about${i}`], 1), frame(['home', `about${i}`], 0));
    h = observe(h, frame(['home', 'last'], 1), true);
    expect(steps(h).back).toBe('home');
    expect(h.visited.length).toBeLessThanOrEqual(1000);
  });

  it('starts empty without keys, and refuses anything that is not a site address', () => {
    const noKeys = enter(observe(NO_HISTORY, { address: '/', key: null, back: null, forward: null }, false));
    const later = observe(noKeys, { address: '/about/', key: null, back: null, forward: null }, true);
    expect(later.visited).toEqual([]);
    expect(steps(later)).toEqual({ back: null, forward: null });
    expect(frameEntry({ address: '/contact/#studio-hours', key: 'k2', back: 'k1', forward: 7 })).toEqual({ address: '/contact/#studio-hours', key: 'k2', back: 'k1', forward: null });
    for (const address of ['https://example.com/', '//example.com/', 'about', 3, undefined]) expect(frameEntry({ address, key: 'k' })).toBeNull();
    expect(addressPath('/contact/?q=1#studio-hours')).toBe('/contact/');
  });
});

describe('Back and Forward keys in Preview', () => {
  const chord = (key: string, mods: Partial<KeyChord> = {}): KeyChord => ({ key, meta: false, ctrl: false, alt: false, shift: false, ...mods });

  it('are Cmd+[ and Cmd+] on macOS, Alt+Left and Alt+Right elsewhere, and nothing else', () => {
    expect(visitorStepKey(chord('[', { meta: true }), true)).toBe('back');
    expect(visitorStepKey(chord(']', { meta: true }), true)).toBe('forward');
    expect(visitorStepKey(chord('ArrowLeft', { alt: true }), false)).toBe('back');
    expect(visitorStepKey(chord('ArrowRight', { alt: true }), false)).toBe('forward');
    // Other platforms' chords, extra modifiers and plain keys stay the page's.
    for (const [k, mac] of [
      [chord('ArrowLeft', { alt: true }), true],
      [chord('[', { meta: true }), false],
      [chord('[', { ctrl: true }), true],
      [chord('[', { meta: true, ctrl: true }), true],
      [chord('[', { meta: true, shift: true }), true],
      [chord('[', { meta: true, alt: true }), true],
      [chord('ArrowLeft', { alt: true, ctrl: true }), false],
      [chord('ArrowLeft', { alt: true, meta: true }), false],
      [chord('ArrowLeft', { alt: true, shift: true }), false],
      [chord('ArrowLeft'), false],
      [chord('['), true]
    ] as const)
      expect(visitorStepKey(k, mac)).toBeNull();
  });

  const ctx = (over: Partial<HistoryContext> = {}): HistoryContext => ({ editor: true, mode: 'preview', inlineEdit: false, frameText: false, overlay: false, focus: 'canvas', ...over });
  const back = chord('[', { meta: true });

  it('step the journey from the preview frame only while previewing, with nothing open over it', () => {
    expect(forwardedVisitorStep(ctx(), back, true)).toBe('back');
    expect(forwardedVisitorStep(ctx(), chord(']', { meta: true }), true)).toBe('forward');
    expect(forwardedVisitorStep(ctx(), chord('ArrowRight', { alt: true }), false)).toBe('forward');
    // A field on the visitor's page keeps the browser's behaviour: the keys still go back.
    expect(forwardedVisitorStep(ctx({ frameText: true }), back, true)).toBe('back');
    for (const c of [ctx({ mode: 'edit' }), ctx({ overlay: true }), ctx({ focus: 'other' }), ctx({ focus: 'text' }), ctx({ editor: false })]) expect(forwardedVisitorStep(c, back, true)).toBeNull();
  });

  it('leave project Undo, and the editor-wide shortcuts, where they were', () => {
    // Undo and Redo from the visitor's page still never reach the project.
    for (const key of ['z', 'y']) expect(forwardedKeyRuns(ctx(), key, true)).toBe(false);
    expect(forwardedVisitorStep(ctx(), chord('z', { meta: true }), true)).toBeNull();
    // Save still works from the page.
    expect(forwardedKeyRuns(ctx(), 's', true)).toBe(true);
    expect(forwardedVisitorStep(ctx(), chord('s', { meta: true }), true)).toBeNull();
  });
});
