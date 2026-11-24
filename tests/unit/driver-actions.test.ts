// The test driver's actions (tests/driver/act.ts, shots.ts, issue #493), without launching the app: what an action
// request may say, how key chords are read before any key goes down, what a failure tells the caller, and how a point
// on a screenshot maps into the editor window and stops counting once anything it stands for has changed.
import { describe, expect, it } from 'vitest';
import { ACTION_LIMITS, notActionable, parseAction, parseChord, staleObservation } from '../driver/act.ts';
import { DriverError, errorInfo } from '../driver/protocol.ts';
import { SHOT_TTL_MS, ShotRegistry, fromFrame, imagePoint, intoFrame, looksLikeObservation, sceneChange } from '../driver/shots.ts';
import type { Scene, ShotRecord } from '../driver/shots.ts';

const REF = 'a1b2c3:12';
const POINT = { observation: 'oa1b2c3-4', surface: 'editor', x: 10, y: 20 };

function refused(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DriverError);
    return errorInfo(e);
  }
  throw new Error('accepted');
}

describe('action requests', () => {
  it('reads each action with its defaults', () => {
    expect(parseAction('ui.click', { target: { ref: REF } })).toEqual({ op: 'ui.click', target: { ref: REF }, button: 'left', count: 1, modifiers: [], waitMs: 3000 });
    expect(parseAction('ui.click', { target: { ref: REF, position: { x: 4, y: 2 } }, count: 2, modifiers: ['Shift'], waitMs: 0 })).toMatchObject({ target: { ref: REF, position: { x: 4, y: 2 } }, count: 2, modifiers: ['Shift'], waitMs: 0 });
    expect(parseAction('ui.click', { target: POINT, button: 'right' })).toMatchObject({ target: POINT, button: 'right' });
    expect(parseAction('ui.hover', { target: POINT })).toMatchObject({ op: 'ui.hover', target: POINT });
    expect(parseAction('ui.fill', { target: { ref: REF }, text: '' })).toMatchObject({ op: 'ui.fill', text: '' });
    expect(parseAction('ui.type', { text: 'abc' })).toMatchObject({ op: 'ui.type', target: null, text: 'abc' });
    expect(parseAction('ui.select', { target: { ref: REF }, option: { label: 'Heading 2' } })).toMatchObject({ option: { label: 'Heading 2' } });
    expect(parseAction('ui.select', { target: { ref: REF }, option: { value: 'h2' } })).toMatchObject({ option: { value: 'h2' } });
    expect(parseAction('ui.press', { key: 'Escape' })).toMatchObject({ op: 'ui.press', target: null, chord: { text: 'Escape', modifiers: [], key: 'Escape' } });
    expect(parseAction('ui.scroll', { target: { ref: REF }, deltaY: 300 })).toMatchObject({ deltaX: 0, deltaY: 300 });
    expect(parseAction('ui.drag', { from: { ref: REF }, by: { x: 24, y: 0 } })).toEqual({ op: 'ui.drag', from: { ref: REF }, to: null, by: { x: 24, y: 0 }, steps: 12, waitMs: 3000 });
    expect(parseAction('ui.type', { target: { ref: REF }, text: 'abc' })).toEqual({ op: 'ui.type', target: { ref: REF }, text: 'abc', waitMs: 3000 });
    expect(parseAction('ui.press', { target: { ref: REF }, key: 'F2' })).toEqual({ op: 'ui.press', target: { ref: REF }, chord: { text: 'F2', modifiers: [], key: 'F2' }, waitMs: 3000 });
    expect(parseAction('ui.scroll', { target: { ref: REF }, deltaX: -40 })).toMatchObject({ deltaX: -40, deltaY: 0 });
    // The ends of each range are in it.
    expect(parseAction('ui.click', { target: { ref: REF }, waitMs: 10_000 }).waitMs).toBe(10_000);
    expect(parseAction('ui.drag', { from: { ref: REF }, by: { x: 1, y: 0 }, steps: 1 }).steps).toBe(1);
    expect(parseAction('ui.drag', { from: { ref: REF }, by: { x: 1, y: 0 }, steps: 100 }).steps).toBe(100);
    expect(parseAction('ui.drag', { from: POINT, to: { ...POINT, surface: 'preview' }, steps: 3 })).toMatchObject({ to: { surface: 'preview' }, by: null, steps: 3 });
  });

  it('refuses a request it could not carry out exactly, before anything is looked at', () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['ui.click', { target: { ref: REF }, colour: 'red' }, /does not take "colour"/],
      ['ui.click', {}, /"target" is/],
      ['ui.click', { target: { ref: 'button' } }, /a ref from an observation/],
      ['ui.click', { target: { ref: REF, observation: 'oa1b2c3-4' } }, /not both/],
      ['ui.click', { target: { ref: REF, position: { x: -1, y: 0 } } }, /position\.x/],
      ['ui.click', { target: { ref: REF, position: { x: Number.NaN, y: 0 } } }, /position\.x/],
      ['ui.click', { target: { ref: REF }, count: 3 }, /"count"/],
      ['ui.click', { target: { ref: REF }, button: 'right', count: 2 }, /left button/],
      ['ui.click', { target: { ref: REF }, button: 'middle' }, /"button"/],
      ['ui.click', { target: { ref: REF }, modifiers: ['Shift', 'Shift'] }, /twice/],
      ['ui.click', { target: { ref: REF }, modifiers: ['Hyper'] }, /"modifiers" holds "Hyper"/],
      ['ui.click', { target: { ref: REF }, waitMs: 60_000 }, /"waitMs"/],
      ['ui.click', { target: { ref: REF }, waitMs: -1 }, /"waitMs"/],
      ['ui.click', { target: { ref: REF }, waitMs: 1.5 }, /"waitMs"/],
      // Each modifier by itself: two joined in one entry would pass as a chord and fail half way through dispatch.
      ['ui.click', { target: { ref: REF }, modifiers: ['Control', 'Shift+Alt'] }, /"modifiers" holds "Shift\+Alt"/],
      ['ui.click', { target: { ref: REF }, modifiers: 'Shift' }, /"modifiers" is a list/],
      ['ui.click', { target: { ...POINT, surface: 'canvas' } }, /target\.surface/],
      ['ui.click', { target: { ...POINT, observation: '7' } }, /token a screenshot gave/],
      ['ui.click', { target: { observation: 'oa1b2c3-4', surface: 'editor', x: 1 } }, /\.y/],
      ['ui.hover', { target: { ref: REF }, count: 2 }, /does not take "count"/],
      ['ui.fill', { target: { ref: REF, position: { x: 1, y: 1 } }, text: 'a' }, /does not take "position"/],
      ['ui.fill', { target: { ref: REF } }, /"text" is a string/],
      ['ui.fill', { target: { ref: REF }, text: 'x'.repeat(ACTION_LIMITS.fill + 1) }, /at most/],
      ['ui.type', { text: '' }, /non-empty/],
      ['ui.select', { target: { ref: REF }, option: 'Heading 2' }, /"option"/],
      ['ui.select', { target: { ref: REF }, option: { label: 'a', value: 'b' } }, /"option"/],
      ['ui.press', {}, /key chord/],
      ['ui.scroll', { target: { ref: REF } }, /not both zero/],
      ['ui.scroll', { target: { ref: REF }, deltaY: 1e9 }, /deltaY/],
      ['ui.drag', { from: { ref: REF } }, /exactly one/],
      ['ui.drag', { from: { ref: REF }, to: { ref: REF }, by: { x: 1, y: 0 } }, /exactly one/],
      ['ui.drag', { from: { ref: REF }, by: { x: 0, y: 0 } }, /not \{ "x": 0, "y": 0 \}/],
      ['ui.drag', { from: { ref: REF }, by: { x: 1, y: 0 }, steps: 0 }, /"steps"/],
      ['ui.drag', { from: { ref: REF }, by: { x: 1, y: 0 }, steps: 101 }, /"steps"/]
    ];
    for (const [op, args, message] of cases) {
      const e = refused(() => parseAction(op, args));
      expect([op, e.code], JSON.stringify(args)).toEqual([op, 'BAD_REQUEST']);
      expect(e.message, JSON.stringify(args)).toMatch(message);
    }
    expect(refused(() => parseAction('ui.tap', {})).code).toBe('UNKNOWN_OP');
  });
});

describe('key chords', () => {
  it('reads modifiers and one key, leaving ControlOrMeta for the platform', () => {
    expect(parseChord('Escape')).toEqual({ text: 'Escape', modifiers: [], key: 'Escape' });
    expect(parseChord('Shift+Tab')).toEqual({ text: 'Shift+Tab', modifiers: ['Shift'], key: 'Tab' });
    expect(parseChord('ControlOrMeta+Shift+z')).toEqual({ text: 'ControlOrMeta+Shift+z', modifiers: ['ControlOrMeta', 'Shift'], key: 'z' });
    expect(parseChord('Shift+F10').key).toBe('F10');
    expect(parseChord('ArrowDown').key).toBe('ArrowDown');
    expect(parseChord('KeyA').key).toBe('KeyA');
    // A plus after a separator is the plus key, as Playwright reads it.
    expect(parseChord('Shift++')).toMatchObject({ modifiers: ['Shift'], key: '+' });
    expect(parseChord('+').key).toBe('+');
    expect(parseChord(' ').key).toBe(' ');
    expect(parseChord('Digit1').key).toBe('Digit1');
    expect(parseChord('ControlOrMeta+c').key).toBe('c');
    expect(parseChord('Shift+v').key).toBe('v');
  });

  it('never pastes: the system clipboard belongs to the person running the session', () => {
    for (const chord of ['ControlOrMeta+v', 'Meta+v', 'Control+V', 'Meta+Shift+v', 'ControlOrMeta+KeyV', 'Shift+Insert']) {
      const e = refused(() => parseChord(chord, 'darwin'));
      expect([chord, e.code], chord).toEqual([chord, 'BAD_REQUEST']);
      expect(e.message).toMatch(/system clipboard/);
    }
  });

  it('refuses the whole chord before any key goes down', () => {
    const cases: [unknown, RegExp][] = [
      ['', /key chord/],
      [3, /key chord/],
      ['Shift', /ends in a modifier/],
      ['Shift+', /ends without a key/],
      ['ctrl+z', /did you mean "Control"/],
      ['cmd+z', /did you mean "Meta"/],
      ['Shift+Shift+a', /Shift twice/],
      ['Control+Shift+Control+z', /Control twice/],
      ['Esc', /did you mean "Escape"/],
      ['enter', /did you mean "Enter"/],
      ['é', /not a key/],
      ['Shift+Foo', /not a key/],
      ['a'.repeat(ACTION_LIMITS.key + 1), /at most/]
    ];
    for (const [key, message] of cases) {
      const e = refused(() => parseChord(key));
      expect(e.code, String(key)).toBe('BAD_REQUEST');
      expect(e.message, String(key)).toMatch(message);
    }
  });

  it('counts ControlOrMeta as the modifier it stands for on each platform', () => {
    expect(refused(() => parseChord('Meta+ControlOrMeta+z', 'darwin')).message).toMatch(/Meta twice/);
    expect(refused(() => parseChord('Meta+Shift+ControlOrMeta+z', 'darwin')).message).toMatch(/Meta twice/);
    expect(parseChord('Meta+ControlOrMeta+z', 'linux').modifiers).toEqual(['Meta', 'ControlOrMeta']);
    expect(refused(() => parseChord('Control+ControlOrMeta+z', 'win32')).message).toMatch(/Control twice/);
    expect(parseChord('Control+ControlOrMeta+z', 'darwin').modifiers).toEqual(['Control', 'ControlOrMeta']);
  });
});

describe('a target a person could not act on', () => {
  it('says why, whether anything was sent, and whether the same request may work later', () => {
    const covered = errorInfo(notActionable('obscured', { waitedMs: 3000, target: { surface: 'preview', ref: REF, role: 'heading', name: 'Welcome' }, blocker: { surface: 'editor', tag: 'div', role: 'toolbar', name: 'Split hero actions' } }));
    expect(covered).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: true, details: { reason: 'obscured', dispatched: 'none', waitedMs: 3000, blocker: { role: 'toolbar', name: 'Split hero actions' } } });
    expect(covered.message).toMatch(/heading "Welcome" is covered at the point by toolbar "Split hero actions"\. Nothing was sent\./);
    expect(covered.details!.hint).toMatch(/blocker/);
    const behind = errorInfo(notActionable('inert', { dialog: 'Settings', target: { surface: 'editor', role: 'button', name: 'Layers' } }));
    expect(behind.message).toMatch(/behind the dialog "Settings"/);
    expect(behind.details).toMatchObject({ dialog: 'Settings' });
    // Input already went out: never retried blindly.
    expect(errorInfo(notActionable('obscured', { dispatched: 'partial' }))).toMatchObject({ retryable: false, details: { dispatched: 'partial' } });
    expect(errorInfo(notActionable('obscured', { dispatched: 'partial' })).message).toMatch(/Some input was sent/);
    // A gesture that does not fit the target cannot work later either.
    for (const reason of ['not-a-select', 'option-ambiguous', 'position-outside', 'outside-window', 'no-movement'] as const) expect(errorInfo(notActionable(reason)).retryable, reason).toBe(false);
    // Scrolled into view before it failed: said so, with the target.
    expect(errorInfo(notActionable('offscreen', { scrolled: true, target: { surface: 'editor', ref: REF, role: 'treeitem' } })).details).toMatchObject({ scrolled: true, target: { ref: REF, role: 'treeitem' } });
    for (const reason of ['hidden', 'disabled', 'offscreen', 'unstable', 'not-editable'] as const) expect(errorInfo(notActionable(reason)).retryable, reason).toBe(true);
  });
});

const scene = (over: { editor?: Partial<Scene['editor']>; frame?: Partial<NonNullable<Scene['frame']>> | null; preview?: Partial<NonNullable<Scene['preview']>> | null } = {}): Scene => ({
  editor: { doc: 'e1', opening: 'p1', viewport: { width: 1440, height: 900 }, dpr: 2, scroll: { x: 0, y: 0 }, ...over.editor },
  frame: over.frame === null ? null : { x: 336, y: 94, width: 736, height: 750, offsetWidth: 1280, offsetHeight: 1304, origin: { x: 336, y: 94 }, scale: { x: 0.575, y: 0.575 }, ...over.frame },
  preview: over.preview === null ? null : { doc: 'p-doc', viewport: { width: 1280, height: 1304 }, scroll: { x: 0, y: 0 }, ...over.preview }
});

describe('screenshot points', () => {
  it('that no longer hold say why, and are never retried as they are', () => {
    expect(errorInfo(staleObservation('zoom', 'oa1b2c3-4'))).toMatchObject({ code: 'STALE_OBSERVATION', retryable: false, details: { observation: 'oa1b2c3-4', reason: 'zoom', hint: expect.stringMatching(/screenshot/) } });
  });

  it('stop counting once anything they stand for changes, naming what', () => {
    const was = scene();
    expect(sceneChange(was, scene())).toBeNull();
    expect(sceneChange(was, scene({ editor: { opening: 'p2' } }))).toBe('project');
    expect(sceneChange(was, scene({ editor: { doc: 'e2' } }))).toBe('document');
    expect(sceneChange(was, scene({ preview: { doc: 'p-doc-2' } }))).toBe('document');
    expect(sceneChange(was, scene({ preview: null }))).toBe('document');
    expect(sceneChange(was, scene({ editor: { viewport: { width: 1100, height: 900 } } }))).toBe('viewport');
    expect(sceneChange(was, scene({ editor: { dpr: 1 } }))).toBe('viewport');
    expect(sceneChange(was, scene({ frame: { scale: { x: 0.5, y: 0.5 } } }))).toBe('zoom');
    expect(sceneChange(was, scene({ frame: { scale: { x: 0.575, y: 0.6 } } }))).toBe('zoom');
    expect(sceneChange(was, scene({ frame: { offsetHeight: 900 } }))).toBe('zoom');
    expect(sceneChange(was, scene({ frame: { origin: { x: 336, y: 120 } } }))).toBe('moved');
    expect(sceneChange(was, scene({ preview: { scroll: { x: 30, y: 0 } } }))).toBe('scrolled');
    expect(sceneChange(was, scene({ frame: { offsetWidth: 834 } }))).toBe('zoom');
    expect(sceneChange(was, scene({ frame: { origin: { x: 300, y: 94 } } }))).toBe('moved');
    expect(sceneChange(was, scene({ editor: { scroll: { x: 0, y: 40 } } }))).toBe('moved');
    expect(sceneChange(was, scene({ preview: { scroll: { x: 0, y: 120 } } }))).toBe('scrolled');
    // Sub-pixel noise is not a change.
    expect(sceneChange(was, scene({ frame: { origin: { x: 336.2, y: 94 } } }))).toBeNull();
  });

  it('map a pixel of either image into the editor window and the page, through the frame’s zoom', () => {
    const record = { editor: { width: 1440, height: 900 }, preview: { clip: { x: 336, y: 94, width: 736, height: 750 } } } as ShotRecord;
    expect(imagePoint(record, 'editor', 0, 0)).toEqual({ x: 0, y: 0 });
    expect(imagePoint(record, 'editor', 1439.5, 899)).toEqual({ x: 1439.5, y: 899 });
    // Half-open: the image's own width and height are past its last pixel.
    expect(imagePoint(record, 'editor', 1440, 10)).toBeNull();
    expect(imagePoint(record, 'editor', 10, 900)).toBeNull();
    // A preview image pixel is already zoomed: it is offset by the clip, never scaled again.
    expect(imagePoint(record, 'preview', 185, 207)).toEqual({ x: 521, y: 301 });
    expect(imagePoint(record, 'preview', 736, 0)).toBeNull();
    expect(imagePoint({ ...record, preview: null }, 'preview', 1, 1)).toBeNull();
    const frame = { origin: { x: 336, y: 94 }, scale: { x: 0.575, y: 0.575 } };
    // The heading's middle in the page (322, 454) is where the editor shows it, and back.
    const shown = fromFrame(frame, { x: 322, y: 454 });
    expect(shown.x).toBeCloseTo(521.15);
    expect(shown.y).toBeCloseTo(355.05);
    const back = intoFrame(frame, shown);
    expect(back.x).toBeCloseTo(322);
    expect(back.y).toBeCloseTo(454);
    // Each axis by its own scale.
    const squashed = { origin: { x: 10, y: 20 }, scale: { x: 0.5, y: 0.25 } };
    expect(fromFrame(squashed, { x: 100, y: 100 })).toEqual({ x: 60, y: 45 });
    expect(intoFrame(squashed, { x: 60, y: 45 })).toEqual({ x: 100, y: 100 });
    expect(imagePoint(record, 'preview', 10, 749)).toEqual({ x: 346, y: 843 });
    expect(imagePoint(record, 'preview', 10, 750)).toBeNull();
    expect(imagePoint(record, 'preview', -1, 10)).toBeNull();
  });

  it('keep only the latest screenshot, until an action uses it up or it expires', () => {
    const shots = new ShotRegistry();
    const record = (token: string, at = 0): ShotRecord => ({ token, at, generation: 1, scene: scene(), editor: { width: 1440, height: 900 }, preview: null });
    const first = shots.next();
    expect(looksLikeObservation(first)).toBe(true);
    shots.issue(record(first));
    expect(shots.get(first, 10)).toMatchObject({ token: first });
    // A newer screenshot replaces it, even one that gives no points.
    const second = shots.next();
    expect(shots.get(first, 10)).toBe('superseded');
    shots.issue(record(second));
    expect(shots.get(second, 10)).toMatchObject({ token: second });
    shots.consume();
    expect(shots.get(second, 10)).toBe('acted');
    const third = shots.next();
    shots.issue(record(third, 100));
    expect(shots.get(third, 100 + SHOT_TTL_MS)).toMatchObject({ token: third });
    expect(shots.get(third, 101 + SHOT_TTL_MS)).toBe('expired');
    // Another session's token, or one never given out.
    expect(shots.get('offffff-1')).toBe('unknown');
    const other = new ShotRegistry();
    const theirs = other.next();
    other.issue(record(theirs));
    expect(shots.get(theirs)).toBe('unknown');
    expect(other.get(third)).toBe('unknown');
    expect(shots.get(third.replace(/-\d+$/, '-99'))).toBe('unknown');
  });
});
