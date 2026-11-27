import './ColorPick.css';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Link2, Pipette } from 'lucide-react';
import { colorFromPicker, colorWithAlpha, hsvToRgb, paintableColor, retirePicks, rgbToHsv, toHex6, type Hsva, type Rgba, type SentPick } from '@shared/color';
import { resolveCssColor } from '../lib/color';
import { pickGate, type PickGate } from '../lib/pick-gate';
import { getState } from '../store';
import { ColorTextInput } from './ColorTextInput';
import { DraftInput, openMenus } from './ui';

const LANDED_MS = 500; // how long a pick stays in flight after its save succeeds: the saved value arrives meanwhile (a save that changes nothing never sends one)
/** A backstop for a pick whose save never reports back (the owner's `onPick` returns nothing to wait on): the swatch then goes back to the saved color. */
const SAVE_WAIT_MS = 30000;
/** Where a value with nothing to start from opens: mid grey, with no thumb until a colour is chosen. */
const START: Hsva = { h: 0, s: 0, v: 0.5, a: 1 };

/** A site colour the picker offers to copy. */
export interface ColorPreset {
  id: string;
  label: string;
  /** The colour it paints now, as CSS. */
  value: string;
}

const pct = (n: number) => Math.round(n * 100);
/** An opacity as people read it: whole percent, with one decimal where rounding would hide it (55.7%, 99.6%). */
const pctText = (a: number) => String(Math.round(a * 1000) / 10);
const css = (c: Rgba) => `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)}${c.a < 1 ? ` / ${Math.round(c.a * 1000) / 1000}` : ''})`;

/**
 * How a colour is painted in a swatch: as itself over the checker, and when it is see-through, split on the diagonal
 * with its opaque colour, so a colour at 80% still reads as see-through at a glance.
 */
export function swatchPaint(value: string): CSSProperties | undefined {
  if (!paintableColor(value)) return undefined;
  // A gradient (a background) paints as itself.
  if (/gradient\(/i.test(value)) return { '--paint': value } as CSSProperties;
  const c = resolveCssColor(value);
  if (!c || c.a >= 1) return { '--paint': `linear-gradient(${value}, ${value})` } as CSSProperties;
  return { '--paint': `linear-gradient(to bottom right, ${css({ ...c, a: 1 })} 50%, transparent 50%), linear-gradient(${value}, ${value})` } as CSSProperties;
}

/** The well's fill: the colour itself as its background colour (over the well's checker), split with its opaque colour when it is see-through. */
function wellPaint(value: string): CSSProperties | undefined {
  if (!paintableColor(value)) return undefined;
  if (/gradient\(/i.test(value)) return { backgroundImage: value };
  const c = resolveCssColor(value);
  return c && c.a < 1 ? { backgroundColor: value, backgroundImage: `linear-gradient(to bottom right, ${css({ ...c, a: 1 })} 50%, transparent 50%)` } : { backgroundColor: value };
}

/** How see-through a colour is, in words, or nothing for an opaque one: "55% opacity". */
export function opacityWords(value: string): string | null {
  const c = resolveCssColor(value);
  return c && c.a < 1 ? `${pctText(c.a)}% opacity` : null;
}

/** A small round chip of a colour, for a value shown inside another control (a select, a list). */
export function ColorChip({ color, className = '' }: { color: string; className?: string }) {
  const paint = swatchPaint(color);
  return <span className={`color-chip${paint ? '' : ' unpainted'}${className ? ` ${className}` : ''}`} style={paint} aria-hidden="true" />;
}

/**
 * The colour swatch: the saved CSS colour as it renders (over the checker, split with its opaque colour when it is
 * see-through, wide-gamut colours as the browser paints them). Given `onPick` it is a button that opens the editor's
 * own picker under it: a colour area, hue and opacity, the value as text, the screen's eyedropper and the site's own
 * colours to copy. The picker starts from the colour in effect. A value it cannot read (`currentcolor`, a gradient,
 * one that depends on a project variable) says so in it, and choosing a colour replaces it.
 *
 * A colour that follows another (`follows`) shows a link mark; its picker says what it follows, with `onFollowed`
 * to go to that colour and `onOwn` to give this one a colour of its own. Without either it is a chip.
 *
 * A drag reports many colours, and a save takes a moment to come back. So the swatch and picker show what was last
 * picked while saves are in flight, and each pick is worked out from the last one taken: dragging from red to blue and
 * back to red before the first save lands ends on red. Only one of the swatch's saves is on its way at a time
 * (lib/pick-gate): steps picked meanwhile wait, and only the newest is saved once that save has been answered, even
 * if the picker has closed by then. A save that lands mid-drag only retires the picks up to it. A pick the owner
 * reports as not saved (its `onPick` returns a promise that resolves to null or false, or rejects) is dropped, and
 * with nothing left in flight the swatch goes back to the saved color.
 */
export function ColorPick({
  value,
  onPick,
  follows,
  onFollowed,
  onOwn,
  presets,
  propId,
  label = 'Color',
  title,
  className = ''
}: {
  /** The colour in effect, as CSS: a token reference already followed. */
  value: string;
  /** Receives the CSS to save. May return a promise that resolves to null or false (or rejects) when the save did not happen. Without it the swatch is a read-only chip. */
  onPick?: (next: string) => unknown;
  /** The name of the colour this one follows: shown with a link mark, and not edited here. */
  follows?: string | null;
  /** For a colour that follows another: go to the one it follows. */
  onFollowed?: () => unknown;
  /** For a colour that follows another: give it a colour of its own (the one it shows now). */
  onOwn?: () => unknown;
  /** The site's colours, offered to copy (their value now, opacity included). */
  presets?: ColorPreset[];
  /** The style property the colour is for, so the picker's text field takes what the property takes ('background' also takes a gradient). */
  propId?: string;
  /** What the colour is for, such as "Brand color": the swatch and the picker are named after it. */
  label?: string;
  title?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const rgba = resolveCssColor(value);
  const empty = !shown.trim();
  const linked = !!follows;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  /** What this swatch has taken that has not come back as the saved value yet, oldest first. */
  const inflight = useRef<SentPick[]>([]);
  const gate = useRef<PickGate | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = () => {
    clearTimeout(timer.current);
    inflight.current = [];
    setDraft(null);
  };
  useEffect(() => {
    inflight.current = retirePicks(inflight.current, value);
    if (!inflight.current.length) settle();
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Nothing to edit any more (it now follows another colour, or became read-only): the picker closes.
  const canOpen = linked ? !!(onOwn || onFollowed) : !!onPick;
  useEffect(() => {
    if (!canOpen || (linked && open && !onOwn && !onFollowed)) setOpen(false);
  }, [canOpen, linked, open, onOwn, onFollowed]);

  /** Send a colour, worked out from the last one sent (or the saved value) so a drag never snaps back. */
  const pick = (next: Hsva | string, withAlpha = false) => {
    if (!onPick) return;
    const last = inflight.current[inflight.current.length - 1]?.text;
    const base = last ?? value;
    const was = last === undefined ? rgba : resolveCssColor(last);
    // The opacity goes with the pick only when the pick changed it, so a hue or a sample never rewrites 0.555 as 0.56.
    const alpha = typeof next === 'string' || (!withAlpha && was && Math.abs(was.a - next.a) < 1e-6) ? undefined : next.a;
    // Only the opacity moved: the colour is kept exactly as written (a wide-gamut oklch() stays itself).
    const alphaOnly = typeof next !== 'string' && alpha !== undefined && !!was && toHex6(hsvToRgb(next)) === toHex6(was);
    const text = typeof next === 'string' ? next : ((alphaOnly && colorWithAlpha(base, alpha!)) || colorFromPicker(base, toHex6(hsvToRgb(next)), last === undefined ? rgba : undefined, alpha));
    if (text === base) return;
    setDraft(text);
    const mine = { text };
    inflight.current.push(mine);
    clearTimeout(timer.current);
    timer.current = setTimeout(settle, SAVE_WAIT_MS);
    const retire = () => {
      inflight.current = inflight.current.filter((p) => p !== mine);
      if (!inflight.current.length) settle();
    };
    // Saved where it was picked for (this render's `onPick`), when the swatch's save before it has been answered: in
    // the opening of the project it was picked in, or nowhere.
    const opening = getState().snapshot?.workspaceKey;
    (gate.current ??= pickGate()).pick(() => {
      if (getState().snapshot?.workspaceKey !== opening) return void retire();
      const saved = Promise.resolve(onPick(text));
      saved.then((r) => (r === null || r === false ? retire() : void setTimeout(retire, LANDED_MS)), retire);
      return saved;
    }, retire);
  };

  const opacity = opacityWords(shown);
  const named = `${label}, ${linked ? `same as ${follows}${empty ? '' : `, ${shown}`}` : empty ? 'not set' : shown}${opacity ? `, ${opacity}` : ''}`;
  const paint = swatchPaint(shown);
  const state = `${linked ? ' linked' : ''}${!paint && !empty ? ' unpainted' : ''}${open ? ' open' : ''}`;
  const fill = <span key={shown} className="color-pick-fill" style={wellPaint(shown)} aria-hidden="true" />;
  const mark = linked && (
    <span className="color-pick-link" aria-hidden="true">
      <Link2 />
    </span>
  );
  if (!canOpen)
    return (
      <span className={`color-pick${state}${className ? ` ${className}` : ''}`} title={title ?? (linked ? `Same as ${follows}` : undefined)} data-color-pick>
        {fill}
        {mark}
      </span>
    );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`color-pick${state}${className ? ` ${className}` : ''}`}
        title={title ?? (linked ? `Same as ${follows}` : opacity ? `${shown}, ${opacity}` : undefined)}
        aria-label={named}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-color-pick
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !open) return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }}
      >
        {fill}
        {mark}
      </button>
      {open && trigger.current && (
        <ColorPopover
          anchor={trigger.current}
          value={value}
          shown={shown}
          label={label}
          follows={follows ?? null}
          onFollowed={onFollowed}
          onOwn={onOwn}
          presets={presets}
          propId={propId}
          pick={pick}
          busy={() => inflight.current.length > 0}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** `transparent` names no colour of its own: the picker treats it as nothing placed, not as black at 0%. */
const isTransparent = (text: string) => /^\s*transparent\s*$/i.test(text);
const sameHsv = (a: Hsva, b: Hsva) => a.h === b.h && a.s === b.s && a.v === b.v && a.a === b.a;

/** The picker over a swatch: non-modal, it closes on Escape (focus back to the swatch), a press outside, or focus leaving it. */
function ColorPopover({
  anchor,
  value,
  shown,
  label,
  follows,
  onFollowed,
  onOwn,
  presets,
  propId,
  pick,
  busy,
  onClose
}: {
  anchor: HTMLElement;
  /** The saved value. */
  value: string;
  /** What the swatch shows: the last pick while saves are in flight, else the saved value. */
  shown: string;
  label: string;
  follows: string | null;
  onFollowed?: () => unknown;
  onOwn?: () => unknown;
  presets?: ColorPreset[];
  propId?: string;
  pick: (next: Hsva | string, withAlpha?: boolean) => void;
  busy: () => boolean;
  onClose: (refocus: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  /**
   * Leaving the picker (a press outside, focus going elsewhere, the page preview taking the window's focus): a field
   * being typed in commits first, as leaving any field does, and text it refuses keeps the picker open, with focus
   * back on that field and its reason beside it. Otherwise it closes.
   */
  const leave = useRef(() => {});
  leave.current = () => {
    const el = document.activeElement;
    const typing = el instanceof HTMLInputElement && el.type !== 'range' && box.current?.contains(el) ? el : null;
    if (typing) flushSync(() => typing.blur());
    const refused = box.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (refused) return void requestAnimationFrame(() => refused.focus({ preventScroll: true }));
    flush();
    close.current(false);
  };
  const rgba = resolveCssColor(shown);
  const unreadable = !rgba && !!shown.trim();
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // `transparent` names no colour: like a value it cannot read, it opens with nothing placed, at full opacity, so the
  // first colour chosen over it is opaque and stays so.
  const keyword = isTransparent(shown);
  const [hsv, setHsv] = useState<Hsva>(() => (rgba && !keyword ? rgbToHsv(rgba) : START));
  // A value with nothing to start from shows no thumb until a colour is chosen: nothing claims it is grey.
  const [placed, setPlaced] = useState(!!rgba && !keyword);
  const now = useRef(hsv);
  now.current = hsv;
  const frame = useRef(0);
  const pending = useRef<Hsva | null>(null);
  const sampling = useRef(false);
  const [alphaProblem, setAlphaProblem] = useState<string | null>(null);
  const alphaErrorId = useId();

  // The colour moving under the picker (an undo, the AI, a pick refused and taken back): with nothing of ours in
  // flight, show it, keeping the hue (and saturation) a grey or black has no say in.
  useEffect(() => {
    if (busy() || pending.current) return;
    const c = resolveCssColor(shown);
    // Nothing to place (currentcolor, a gradient, transparent): no thumb claims a colour, until the next pick sets one.
    if (!c || keyword) {
      if (keyword) setHsv((h) => ({ ...h, a: 1 }));
      if (keyword) now.current = { ...now.current, a: 1 };
      return void (shown.trim() && setPlaced(false));
    }
    const cur = now.current;
    setPlaced(true);
    if (toHex6(hsvToRgb(cur)) === toHex6(c) && Math.abs(cur.a - c.a) < 0.0005) return;
    const next = rgbToHsv(c);
    setHsv({ ...next, h: next.s === 0 || next.v === 0 ? cur.h : next.h, s: next.v === 0 ? cur.s : next.s });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  // Global shortcuts stand aside while it is open, as for a menu.
  useEffect(() => {
    openMenus.count++;
    return () => {
      openMenus.count--;
      cancelAnimationFrame(frame.current);
    };
  }, []);

  // Under the swatch, flipped above when the window has no room below, kept 8px inside it, and following the swatch as its panel scrolls.
  useLayoutEffect(() => {
    const place = () => {
      const el = box.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      if (!anchor.isConnected || (!a.width && !a.height)) return close.current(false);
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const below = a.bottom + 6;
      const fitsBelow = below + h <= innerHeight - 8;
      const fitsAbove = a.top - 6 - h >= 8;
      let top = fitsBelow ? below : fitsAbove ? a.top - 6 - h : Math.max(8, Math.min(a.top - 12, innerHeight - 8 - h));
      let left = Math.max(8, Math.min(a.left, innerWidth - 8 - w));
      // Neither below nor above: beside it (to its left in the right-hand dock), so the swatch stays in sight.
      if (!fitsBelow && !fitsAbove) {
        if (a.left - 8 - w >= 8) left = a.left - 8 - w;
        else if (a.right + 8 + w <= innerWidth - 8) left = a.right + 8;
        else top = Math.max(8, Math.min(below, innerHeight - 8 - h));
      }
      setAt((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  });

  // A press outside it and its swatch closes it, and so does the window losing focus (a click in the page preview).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.contains(t)) return;
      leave.current();
    };
    const blur = () => !sampling.current && leave.current();
    // Focus let go to the page (a field that committed on Enter): Escape still closes the picker.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (document.activeElement && document.activeElement !== document.body)) return;
      e.preventDefault();
      close.current(true);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', escape);
    };
  }, [anchor]);

  // Focus moves in once it is placed (hidden while it is measured, it cannot take focus): to the colour area, or
  // for a linked colour to its first action.
  const placedAt = !!at;
  useEffect(() => {
    if (placedAt) box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [placedAt, follows]);

  const flush = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const p = pending.current;
    pending.current = null;
    if (p) pick(p);
  };
  /**
   * Show a colour at once; send it at most once a frame while a drag runs. A key that moves nothing changes nothing,
   * even over a value with no colour placed (End on an opacity already at 100%); a press or a typed number is a
   * choice, so it places the colour where it is.
   */
  const change = (next: Hsva, how: 'key' | 'press' | 'typed' = 'key') => {
    if (sameHsv(next, now.current) && (placed || how === 'key')) return;
    setPlaced(true);
    setHsv(next);
    now.current = next;
    pending.current = next;
    if (how === 'typed') return flush();
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  };
  /** Take a colour given as CSS (a site colour, a sample), opacity included. */
  const take = (text: string) => {
    flush();
    // What the picker cannot place (currentcolor, a gradient) is still saved: it only leaves the controls where they are.
    const c = isTransparent(text) ? null : resolveCssColor(text);
    if (c) {
      const next = rgbToHsv(c);
      setHsv(next);
      now.current = next;
    } else if (isTransparent(text)) {
      // Like opening on it: nothing placed, at full opacity, so the next colour chosen is opaque.
      now.current = { ...now.current, a: 1 };
      setHsv(now.current);
    }
    setPlaced(!!c);
    pick(text);
  };

  const hueCss = toHex6(hsvToRgb({ h: hsv.h, s: 1, v: 1, a: 1 }));
  const solid = toHex6(hsvToRgb({ ...hsv, a: 1 }));
  const eyedropper = typeof window !== 'undefined' && 'EyeDropper' in window;
  const sample = async () => {
    sampling.current = true;
    try {
      const Dropper = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const { sRGBHex } = await new Dropper().open();
      const c = resolveCssColor(sRGBHex);
      // A sample keeps the opacity the colour has, even none at all.
      if (c) {
        flush();
        const next = { ...rgbToHsv(c), a: now.current.a };
        setHsv(next);
        now.current = next;
        setPlaced(true);
        pick(next, true);
      }
    } catch {
      // Escape, or the screen could not be read: nothing changes.
    } finally {
      sampling.current = false;
      box.current?.querySelector<HTMLElement>('.color-pop-dropper')?.focus();
    }
  };

  return createPortal(
    <div
      ref={box}
      className="color-pop"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={at ? { left: at.left, top: at.top } : { visibility: 'hidden', left: 0, top: 0 }}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          // Tabbing past either end leaves the picker for its swatch, so the place in the panel is kept.
          const stops = [...(box.current?.querySelectorAll<HTMLElement>('input, button, [tabindex]') ?? [])].filter((n) => n.tabIndex >= 0 && !(n as HTMLButtonElement).disabled && n.offsetParent);
          const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
          if (edge && document.activeElement !== edge) return;
          e.preventDefault();
          flush();
          close.current(true);
          return;
        }
        if (e.key !== 'Escape') return;
        // A field holding refused text takes the first Escape itself, to put the saved value back.
        if ((e.target as HTMLElement).getAttribute('aria-invalid') === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        flush();
        close.current(true);
      }}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to && !box.current?.contains(to) && !anchor.contains(to)) {
          leave.current();
        } else if (!to) {
          // A field that commits on Enter lets go of focus: it stays in the picker, so Escape and Tab still work here.
          // Before the next key arrives: an Escape straight after Enter must still reach the picker.
          queueMicrotask(() => {
            // A refused field keeps focus, so its first Escape puts its value back rather than closing the picker.
            if (box.current && (document.activeElement === document.body || !document.activeElement)) (box.current.querySelector<HTMLElement>('[aria-invalid="true"]') ?? box.current).focus({ preventScroll: true });
          });
        }
      }}
    >
      <div className="color-pop-head" id={titleId}>
        {label}
      </div>
      {follows ? (
        <div className="color-pop-follows">
          <p className="color-pop-note">
            <Link2 aria-hidden="true" />
            <span>
              Same as <strong>{follows}</strong>, and changes when it does.
            </span>
          </p>
          <div className="color-pop-actions">
            {onOwn && (
              <button type="button" className="btn btn-sm" data-autofocus onClick={() => void onOwn()}>
                Use its own color
              </button>
            )}
            {onFollowed && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                data-autofocus={onOwn ? undefined : true}
                onClick={() => {
                  close.current(false);
                  void onFollowed();
                }}
              >
                Go to {follows}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {unreadable && (
            <p className="color-pop-note">
              <span>
                The picker can’t show <bdi className="mono">{shown}</bdi>. Choosing a color here replaces it.
              </span>
            </p>
          )}
          <Area hsv={hsv} hueCss={hueCss} placed={placed} onChange={change} onEnd={flush} />
          <div className="color-pop-controls">
            <Track kind="hue" value={hsv.h} max={360} label="Hue" text={`Hue ${Math.round(hsv.h)} degrees`} placed={placed} onChange={(h, how) => change({ ...hsv, h }, how)} onEnd={flush} />
            {eyedropper ? (
              <button type="button" className="icon-btn color-pop-dropper" title="Pick a color from the screen" aria-label="Pick a color from the screen" onClick={() => void sample()}>
                <Pipette aria-hidden="true" />
              </button>
            ) : (
              <span />
            )}
            <Track kind="alpha" value={hsv.a * 100} max={100} label="Opacity" text={`Opacity ${pctText(hsv.a)}%`} placed={placed} style={{ '--solid': solid } as CSSProperties} onChange={(a, how) => change({ ...hsv, a: a / 100 }, how)} onEnd={flush} />
            <span className="color-pop-alpha">
              <DraftInput
                className="input sm color-pop-alpha-input"
                value={placed ? pctText(hsv.a) : ''}
                ariaLabel={`${label} opacity, 0 to 100%`}
                aria-invalid={alphaProblem ? true : undefined}
                aria-describedby={alphaProblem ? alphaErrorId : undefined}
                check={(t) => (/^\s*(\d{1,3}(\.\d+)?|\.\d+)\s*%?\s*$/.test(t) && Number(t.replace('%', '')) <= 100 ? null : { message: 'Opacity is a number from 0 to 100.' })}
                onProblem={(p) => setAlphaProblem(p?.message ?? null)}
                onCommit={(t) => change({ ...now.current, a: Number(t.replace('%', '').trim()) / 100 }, 'typed')}
              />
              <span className="color-pop-unit" aria-hidden="true">
                %
              </span>
            </span>
          </div>
          {alphaProblem && (
            <div className="field-error color-pop-error" id={alphaErrorId} role="alert">
              {alphaProblem} Not saved.
            </div>
          )}
          <ColorTextInput propId={propId} className="input sm mono color-pop-hex" errorClassName="color-pop-error" value={shown} ariaLabel={`${label} value`} onSave={(v) => take(v)} />
          {!!presets?.length && <Presets presets={presets} onChoose={take} />}
        </>
      )}
    </div>,
    document.body
  );
}

/** Arrow-key steps for a slider: 1, or 10 with Shift or Page Up/Down; Home and End jump to the ends. */
function stepOf(e: ReactKeyboardEvent, max: number): ((v: number) => number) | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const big = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return (v) => Math.min(max, Math.floor(v + 1e-9) + big);
    case 'ArrowLeft':
    case 'ArrowDown':
      return (v) => Math.max(0, Math.ceil(v - 1e-9) - big);
    case 'PageUp':
      return (v) => Math.min(max, Math.floor(v + 1e-9) + 10);
    case 'PageDown':
      return (v) => Math.max(0, Math.ceil(v - 1e-9) - 10);
    case 'Home':
      return () => 0;
    case 'End':
      return () => max;
  }
  return null;
}

/** Follow a pointer from a press on `el` until it is released, reporting where it is inside `el` (0-1 each way). A press alone jumps there. */
function drag(e: ReactPointerEvent<HTMLElement>, onMove: (x: number, y: number) => void, onEnd: () => void, focus?: string) {
  if (e.button !== 0) return;
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  ((focus && el.querySelector<HTMLElement>(focus)) || el).focus({ preventScroll: true });
  const at = (ev: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    onMove(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height));
  };
  at(e);
  const move = (ev: PointerEvent) => at(ev);
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    onEnd();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  e.preventDefault();
}

/**
 * Saturation across, brightness up. Two ranges behind one area, so assistive software reads and sets each on its own;
 * the area is one tab stop (saturation), and its arrows work both: Left and Right saturation, Up and Down brightness.
 */
function Area({ hsv, hueCss, placed, onChange, onEnd }: { hsv: Hsva; hueCss: string; placed: boolean; onChange: (h: Hsva, how?: 'key' | 'press') => void; onEnd: () => void }) {
  const keys = (e: ReactKeyboardEvent<HTMLInputElement>, own: 's' | 'v') => {
    const step = stepOf(e, 100);
    if (!step) return;
    e.preventDefault();
    const axis = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown' ? 'v' : e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? 's' : own;
    onChange({ ...hsv, [axis]: step(hsv[axis] * 100) / 100 });
  };
  const none = placed ? undefined : 'No color chosen';
  return (
    <div className="color-pop-area" style={{ '--hue': hueCss } as CSSProperties} onPointerDown={(e) => drag(e, (x, y) => onChange({ ...hsv, s: x, v: 1 - y }, 'press'), onEnd, 'input')}>
      <input
        type="range"
        className="sr-only"
        data-autofocus
        aria-label="Saturation"
        min={0}
        max={100}
        step={1}
        value={Math.round(hsv.s * 100)}
        aria-valuetext={none ?? `Saturation ${pct(hsv.s)}%, brightness ${pct(hsv.v)}%`}
        onChange={(e) => onChange({ ...hsv, s: Number(e.target.value) / 100 })}
        onKeyDown={(e) => keys(e, 's')}
        onKeyUp={onEnd}
      />
      <input
        type="range"
        className="sr-only"
        tabIndex={-1}
        aria-label="Brightness"
        min={0}
        max={100}
        step={1}
        value={Math.round(hsv.v * 100)}
        aria-valuetext={none ?? `Brightness ${pct(hsv.v)}%`}
        onChange={(e) => onChange({ ...hsv, v: Number(e.target.value) / 100 })}
        onKeyDown={(e) => keys(e, 'v')}
        onKeyUp={onEnd}
      />
      {placed && <span className="color-pop-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} aria-hidden="true" />}
    </div>
  );
}

function Track({ kind, value, max, label, text, placed, style, onChange, onEnd }: { kind: 'hue' | 'alpha'; value: number; max: number; label: string; text: string; placed: boolean; style?: CSSProperties; onChange: (v: number, how: 'key' | 'press') => void; onEnd: () => void }) {
  return (
    <div
      className={`color-pop-track ${kind}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={placed ? text : 'No color chosen'}
      style={style}
      onPointerDown={(e) => drag(e, (x) => onChange(Math.round(x * max), 'press'), onEnd)}
      onKeyDown={(e) => {
        const step = stepOf(e, max);
        if (!step) return;
        e.preventDefault();
        onChange(step(value), 'key');
      }}
      onKeyUp={onEnd}
    >
      {placed && <span className="color-pop-thumb" style={{ left: `${(value / max) * 100}%` }} aria-hidden="true" />}
    </div>
  );
}

/** The site's colours to copy, named: one tab stop, Up and Down move between them, Enter or a click copies one. */
function Presets({ presets, onChoose }: { presets: ColorPreset[]; onChoose: (value: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const headId = useId();
  const [focus, setFocus] = useState(0);
  const go = (i: number) => {
    const n = Math.max(0, Math.min(presets.length - 1, i));
    setFocus(n);
    list.current?.querySelectorAll<HTMLElement>('button')[n]?.focus();
  };
  return (
    <div className="color-pop-presets">
      <div className="color-pop-label" id={headId}>
        Copy a site color
      </div>
      <div
        ref={list}
        className="color-pop-swatches"
        role="toolbar"
        aria-orientation="vertical"
        aria-labelledby={headId}
        onKeyDown={(e) => {
          const to = { ArrowDown: focus + 1, ArrowUp: focus - 1, Home: 0, End: presets.length - 1 }[e.key];
          if (to === undefined) return;
          e.preventDefault();
          go(to);
        }}
      >
        {presets.map((p, i) => (
          <button key={p.id} type="button" className="color-pop-preset" tabIndex={i === focus ? 0 : -1} title={`${p.label}, ${p.value}`} onFocus={() => setFocus(i)} onClick={() => onChoose(p.value)}>
            <ColorChip color={p.value} className="wide" />
            <span className="color-pop-preset-name">{p.label}</span>
            <span className="sr-only">, {p.value}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
