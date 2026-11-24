import { useEffect, useId, useRef, useState } from 'react';
import { Crosshair, Monitor, Smartphone, Tablet } from 'lucide-react';
import type { ResponsiveScope, ResponsiveStyles, StyleValue } from '@shared/types';
import { FOCUS_CENTER, FocusCommits, coverCrop, cropAxis, describeFocus, focusFromPoint, formatFocus, parseFocus, sameFocus, type FocalPoint } from '@shared/focus';
import { DraftInput } from '../components/ui';
import { useStore } from '../store';

type Size = Exclude<ResponsiveScope, 'base'>;
const SIZE_NAME: Record<Size, string> = { phone: 'phone', tablet: 'tablet', desktop: 'desktop' };
const SIZE_ICON: Record<Size, typeof Monitor> = { phone: Smartphone, tablet: Tablet, desktop: Monitor };

/** The picture a focal point is chosen on, and the rules under the element's own styles. */
export interface FocusImage {
  /** Where the preview serves the picture, or null when it cannot be shown. */
  src: string | null;
  /** Its size from the image library, when known. */
  width?: number;
  height?: number;
  /** The style rules under this element's own, in tiers, strongest first (see `cascadedStyle`). */
  below: Array<Array<ResponsiveStyles | undefined>>;
  /** The element's complete styles, when the ones being edited list only its changes (Edit everywhere). */
  own?: ResponsiveStyles;
  /** Said after the caption: why the canvas may show a different crop (a placement with its own). */
  note?: string;
  /** Why there is no picture to show, when there is none. */
  missing?: string;
}

const positive = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** "30", "30%", "30.", ".5" or "12.5 %" as a percentage between 0 and 100; null for anything else. */
function readPercent(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*%?\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 100 ? n : null;
}

/**
 * Choose which part of a cropped picture stays in view: drag on the picture, type how far across and down, or go
 * back to the center. The picture shows the crop the chosen screen size gives (the previewed size under All
 * sizes), so what is cut off can be seen before it is chosen.
 */
export function FocusEditor({
  label,
  value,
  under,
  scope,
  size,
  previewed,
  unreached,
  uncertain,
  custom,
  ratio,
  fit,
  image,
  onSet
}: {
  label: string;
  /** The value set at the size being edited. */
  value: StyleValue | undefined;
  /** The value that shows through when none is set here. */
  under: StyleValue | undefined;
  scope: ResponsiveScope;
  /** The size whose crop is shown. */
  size: Size;
  /** Whether the canvas is showing that size. */
  previewed: boolean;
  /** Under All sizes: every size keeps its own focus, so the all-sizes one shows nowhere. */
  unreached?: boolean;
  /** A height may crop the picture, but how can't be worked out here. */
  uncertain?: boolean;
  /** Custom CSS on these rules sets the crop too, so the site may not match the picture here. */
  custom?: boolean;
  /** The box's width over height at that size, or null when the picture keeps its own shape. */
  ratio: number | null;
  /** The image fit at that size. */
  fit: StyleValue | undefined;
  image?: FocusImage;
  /**
   * May return the change's promise: settling to the result (with the revision the change made), or to null
   * when the project refused it.
   */
  onSet: (v: StyleValue | null, expectedRevision?: number) => unknown;
}) {
  const revision = useStore((s) => s.snapshot?.revision ?? 0);
  const captionId = useId();
  const hintId = useId();
  const errorId = useId();
  const fieldId = useId();
  const pad = useRef<HTMLDivElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  const lastSend = useRef<Promise<{ text: string; made?: number }> | null>(null);
  const src = image?.src ?? null;
  // The picture's own size: from the library when it is recorded, else measured once it loads.
  const [measured, setMeasured] = useState<{ src: string; w: number; h: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const libraryRatio = positive(image?.width) && positive(image?.height) ? image.width / image.height : null;
  const sourceRatio = libraryRatio ?? (measured && measured.src === src ? measured.w / measured.h : null);

  // A drag keeps its point to itself until the pointer is released; then a committed value shows (and is what
  // a typed coordinate builds on) until the snapshot reaches the revision the change made, or it is refused.
  // Other changes landing meanwhile don't end it.
  const gesture = useRef<{ pointer: number; key: string; revision: number; flushing: boolean } | null>(null);
  const [draft, setDraft] = useState<FocalPoint | null>(null);
  const [pending, setPending] = useState<{ text: string; until?: number } | null>(null);
  // Coordinates that could not be used, by axis: what was typed, kept in its field and said under the fields until
  // that field is typed in again or Escaped, or a whole point (Center, a pick) lands.
  const [bad, setBad] = useState<{ x?: string; y?: string }>({});
  // Set while Enter is committing a coordinate, so only Enter (never a click elsewhere) brings focus back to it.
  const entered = useRef<'x' | 'y' | null>(null);
  // Escape cancels a drag: the pad never has focus, so it listens on the window for the drag's lifetime.
  const escape = useRef<((e: KeyboardEvent) => void) | null>(null);
  const stopEscape = () => {
    if (escape.current) window.removeEventListener('keydown', escape.current, true);
    escape.current = null;
  };
  const end = () => {
    gesture.current = null;
    setDraft(null);
    stopEscape();
  };
  const stored = parseFocus(value) ?? parseFocus(under) ?? FOCUS_CENTER;
  // Changes go out one at a time, each built on what the project holds when its turn comes.
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const newCommits = (t: string) => new FocusCommits(() => (targetRef.current === t ? { point: storedRef.current, revision: revisionRef.current } : null));
  const commits = useRef<FocusCommits | null>(null);
  const target = `${scope}|${src ?? ''}|${label}`;
  const targetRef = useRef(target);
  targetRef.current = target;
  commits.current ??= newCommits(target);
  // Another size, picture or element ends a drag in progress without committing it, and starts afresh.
  useEffect(() => {
    end();
    setPending(null);
    setBad({});
    commits.current = newCommits(target);
  }, [target]);
  useEffect(() => stopEscape, []);
  useEffect(() => {
    if (pending?.until !== undefined && revision >= pending.until) setPending(null);
  }, [pending, revision]);

  const committed = pending && (pending.until === undefined || revision < pending.until) ? parseFocus(pending.text) : null;
  const latest = committed ?? stored;
  const point = draft ?? latest;
  // Only a picture that is really showing can be cropped here.
  const showing = !!image && !!src && failed !== src && !image.missing;
  const cropped = showing && !unreached && fit !== 'contain' && ratio !== null && sourceRatio !== null ? cropAxis(sourceRatio, ratio) : null;
  const crop = cropped && sourceRatio !== null && ratio !== null ? coverCrop(sourceRatio, ratio, point) : null;

  const pointAt = (e: React.PointerEvent): FocalPoint => {
    const r = pad.current!.getBoundingClientRect();
    const fx = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5;
    const fy = r.height > 0 ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0.5;
    return focusFromPoint(fx, fy);
  };
  /**
   * Commit a value built from the point it goes on top of (see FocusCommits for `guard`). While it is on its way
   * it shows here; a refusal puts the saved value back.
   */
  const commit = (make: (base: FocalPoint) => string, guard?: 'base' | number, axis?: 'x' | 'y') => {
    // Saving one coordinate repairs only its own refused entry; a whole point (Center, a pick) replaces both.
    setBad((b) => (axis ? { ...b, [axis]: undefined } : {}));
    const mine: { text: string; until?: number } = { text: make(latest) };
    setPending(mine);
    const sent = commits.current!.send(make, onSet, guard);
    lastSend.current = sent;
    void sent.then(({ text, made }) => {
      if (lastSend.current === sent) lastSend.current = null;
      setPending((p) => (p !== mine ? p : made === undefined ? null : { text, until: made }));
    });
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!crop || e.button !== 0 || gesture.current) return;
    e.preventDefault();
    // A coordinate still being typed is saved now, through its own commit, so it can't land on top of this pick later.
    // The pick then builds on that save, or on one already on its way.
    entered.current = null;
    // A refused entry stays until the pick lands (its commit clears it); a drag cancelled with Escape leaves it as it was.
    if (document.activeElement instanceof HTMLElement && fields.current?.contains(document.activeElement)) document.activeElement.blur();
    const flushed = lastSend.current;
    // Keys typed into the preview never reach this window: take focus out of it, so Escape can cancel the drag.
    if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
    const el = e.currentTarget;
    const id = e.pointerId;
    el.setPointerCapture(id);
    const started = { pointer: id, key: target, revision, flushing: !!flushed };
    gesture.current = started;
    void flushed?.then(({ made }) => {
      started.flushing = false;
      if (made !== undefined) started.revision = made;
    });
    setDraft(pointAt(e));
    stopEscape();
    escape.current = (k) => {
      if (k.key !== 'Escape') return;
      k.preventDefault();
      k.stopPropagation();
      // Cleared first, so the capture's release finds no drag, and the pointer's release commits nothing.
      end();
      if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    };
    window.addEventListener('keydown', escape.current, true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointer !== e.pointerId) return;
    setDraft(pointAt(e));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (g?.pointer !== e.pointerId) return;
    const next = pointAt(e);
    // Cleared first, so the capture's release that follows finds no drag to cancel.
    end();
    // The element, size or project changed under the drag (an Undo, say): the drag no longer applies.
    if (g.key !== target || (!g.flushing && revision > g.revision)) return;
    // Nothing to do when the point is already the one held here, judged against any change still landing.
    const held = committed ?? (typeof value === 'string' ? parseFocus(value) : null);
    if (!g.flushing && held && sameFocus(held, next)) return;
    commit(() => formatFocus(next), g.flushing ? 'base' : g.revision);
  };
  const cancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointer === e.pointerId) end();
  };

  const setAxis = (axis: 'x' | 'y') => (text: string) => {
    if (!text.trim()) return undefined;
    const n = readPercent(text);
    if (n === null) {
      setBad((b) => ({ ...b, [axis]: text.trim() }));
      // Left with Enter: back into the field to correct it. Left any other way, the field keeps showing what was
      // typed beside its message (see fieldText) until it is corrected, Escaped or replaced by a pick.
      if (entered.current === axis)
        setTimeout(() => {
          const active = document.activeElement;
          if (!active || active === document.body) document.getElementById(`${fieldId}-${axis}`)?.focus();
        });
      entered.current = null;
      return false;
    }
    // Built on the value before it once that has answered, and applied only if the project still holds that
    // value, so Across then Down typed quickly keeps both and never keeps a refused one.
    commit((base) => formatFocus({ ...base, [axis]: n }), 'base', axis);
  };
  const isCenter = sameFocus(latest, FOCUS_CENTER);
  const setHere = value !== undefined;
  // The fields read the point the picture shows: the one being dragged, then one on its way, then the saved one.
  const live = draft ?? committed;
  const fieldText = (axis: 'x' | 'y') => {
    // A refused entry stays in its field, beside its message (a drag shows its live point over it); the unit is drawn
    // after it, so a typed % is dropped.
    const refused = bad[axis];
    if (refused !== undefined && !draft) return refused.replace(/\s*%$/, '');
    const saved = setHere ? parseFocus(value) : null;
    return live ? String(live[axis]) : saved ? String(saved[axis]) : '';
  };
  const fieldClass = `input sm style-input${setHere || live ? ' is-set' : ' is-inherited'}`;
  const sizeName = SIZE_NAME[size];
  const where = scope === 'base' && previewed ? `In the ${sizeName} preview` : `On ${sizeName}`;
  const ratioPct = crop ? Math.round((cropped === 'y' ? crop.h : crop.w) * 100) : 0;

  let caption: string;
  if (!image) caption = '';
  else if (image.missing) caption = image.missing;
  else if (!src) caption = 'The picture shows here once the preview is running.';
  else if (failed === src) caption = 'The picture couldn’t load, so its crop can’t be shown here.';
  else if (sourceRatio === null) caption = '';
  else if (unreached) caption = `Phone, tablet and desktop each keep their own ${label.toLowerCase()}, so this one shows at no size.`;
  else if (fit === 'contain')
    caption = `${where}, Fit (no crop) shows the whole picture. ${ratio === null ? 'Choose Fill (crop) and an aspect ratio' : sourceRatio !== null && cropAxis(sourceRatio, ratio) === null ? 'Choose Fill (crop) and a different aspect ratio' : 'Set Image fit to Fill (crop)'} to crop it.`;
  else if (!cropped && uncertain) caption = `${where}, its height is set, so the site may crop it. Choose an aspect ratio to see and control the crop.`;
  else if (!cropped && ratio !== null) caption = `${where}, the aspect ratio matches the picture, so the whole picture shows. Choose a different one to crop it.`;
  else if (!cropped) caption = `${where}, the whole picture shows. Choose an aspect ratio to crop it.`;
  // Which way the crop can move, so it is clear which of Across and Down changes it here.
  else caption = `${where}, ${ratioPct}% of the picture’s ${cropped === 'y' ? 'height shows, so Down moves the crop' : 'width shows, so Across moves the crop'}.`;
  // Under All sizes, a previewed size that keeps its own focus is why another size's crop is shown.
  if (caption && scope === 'base' && !previewed && !unreached && !image?.missing) caption += ' The size in the preview keeps its own.';
  if (caption && custom) caption += ' Custom CSS also sets the crop, so the site may differ.';
  if (caption && image?.note) caption += ` ${image.note}`;

  const SizeIcon = SIZE_ICON[size];
  const captionLine = caption && (
    <p className="focus-caption" id={captionId}>
      {crop && <SizeIcon aria-hidden="true" />}
      <span>{caption}</span>
    </p>
  );
  // Where a pick lands, said where it is made; while dragging, how to finish or abandon it.
  const scopeName = scope === 'base' ? 'All sizes' : `${sizeName} only`;
  const hint = crop && (
    <p className="focus-hint" id={hintId}>
      {draft ? (
        <>
          Release to set {scope === 'base' ? 'for' : 'on'} <strong>{scopeName}</strong>. Esc cancels.
        </>
      ) : (
        <>
          Click or drag to set the focus {scope === 'base' ? 'for' : 'on'} <strong>{scopeName}</strong>.
        </>
      )}
    </p>
  );
  const described = (axis: 'x' | 'y') => [caption ? captionId : '', hintId, bad[axis] !== undefined ? `${errorId}-${axis}` : ''].filter(Boolean).join(' ');
  // Set at this size (or being placed): a solid point. Shown through from elsewhere, or the default: a hollow one.
  const markSet = setHere || !!live;
  const stage = showing && (
    <div className="focus-stage">
      <div
        ref={pad}
        className={`focus-pad${crop ? ' is-cropped' : ''}${draft ? ' is-dragging' : ''}`}
        style={sourceRatio ? { aspectRatio: String(sourceRatio) } : undefined}
        role="img"
        aria-label={[caption, `${label}: ${describeFocus(point)}.`].filter(Boolean).join(' ')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
      >
        {/* The picture and its crop are clipped to its shape; the point is not, so it stays whole at an edge. */}
        <div className="focus-clip">
          <img
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) setMeasured({ src, w: el.naturalWidth, h: el.naturalHeight });
            }}
            onError={() => setFailed(src)}
          />
          {/* What stays in view, in full colour over the dimmed picture. */}
          {crop && (
            <div className="focus-window" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}>
              <img src={src} alt="" draggable={false} style={{ left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%`, width: `${100 / crop.w}%`, height: `${100 / crop.h}%` }} />
            </div>
          )}
        </div>
        {crop && <div className={`focus-mark${markSet ? ' is-set' : ''}`} style={{ left: `${point.x}%`, top: `${point.y}%` }} />}
      </div>
    </div>
  );
  const field = (axis: 'x' | 'y', name: string, aria: string) => (
    <label
      className="focus-field"
      onKeyDownCapture={(e) => {
        // Escape puts the saved value back, so the message about what was typed goes with it.
        if (e.key === 'Escape' && bad[axis] !== undefined) setBad((b) => ({ ...b, [axis]: undefined }));
        entered.current = e.key === 'Enter' ? axis : null;
      }}
    >
      <span>{name}</span>
      <span className="focus-number">
        <DraftInput
          id={`${fieldId}-${axis}`}
          className={fieldClass}
          value={fieldText(axis)}
          placeholder={String(stored[axis])}
          ariaLabel={`${label} ${aria}`}
          aria-describedby={described(axis)}
          aria-invalid={bad[axis] !== undefined ? true : undefined}
          // Typing again in the field that was refused takes its message away.
          onLive={bad[axis] !== undefined ? () => setBad((b) => ({ ...b, [axis]: undefined })) : undefined}
          onCommit={setAxis(axis)}
        />
        <span className="focus-unit" aria-hidden="true">
          %
        </span>
      </span>
    </label>
  );
  return (
    <div className={`focus-editor${crop ? ' is-cropping' : ' is-idle'}`}>
      {crop ? (
        <>
          {captionLine}
          {stage}
          {hint}
        </>
      ) : (
        // With nothing to choose, the picture is a small reference beside the reason.
        <div className={`focus-idle${stage ? ' has-picture' : ''}`}>
          {stage}
          {captionLine}
        </div>
      )}
      <div ref={fields} className="focus-fields" role="group" aria-label={`${label} as percentages`}>
        {!crop && (
          <span className="focus-saved" id={hintId}>
            {unreached ? (
              <>
                A size uses this point once its own <strong>{label.toLowerCase()}</strong> is reset.
              </>
            ) : (
              <>
                If cropped, this point stays in view {scope === 'base' ? 'for' : 'on'} <strong>{scopeName}</strong>.
              </>
            )}
          </span>
        )}
        {field('x', 'Across', 'across, percent from the left')}
        {field('y', 'Down', 'down, percent from the top')}
        <button type="button" className="btn btn-sm focus-center" disabled={isCenter} onClick={() => commit(() => formatFocus(FOCUS_CENTER))} title={`Put the center of the picture in the middle${scope === 'base' ? '' : ` on ${sizeName}`}`}>
          <Crosshair aria-hidden="true" /> Center
        </button>
      </div>
      {(['x', 'y'] as const).map((axis) => {
        const text = bad[axis];
        if (text === undefined) return null;
        // A number the parser can read but that lies outside 0-100, or something that isn't a number at all.
        const number = /^-?(\d+\.?\d*|\.\d+)\s*%?$/.test(text);
        const both = bad.x !== undefined && bad.y !== undefined;
        return (
          <p key={axis} className="field-error focus-error" id={`${errorId}-${axis}`} role="alert">
            {both ? `${axis === 'x' ? 'Across' : 'Down'}: ` : ''}
            {number ? `“${text}” is outside the picture.` : `“${text}” isn’t a number.`} Enter a percentage from 0 to 100.
          </p>
        );
      })}
    </div>
  );
}
