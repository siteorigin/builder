import { useEffect, useId, useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import type { ResponsiveScope, ResponsiveStyles, StyleValue } from '@shared/types';
import { FOCUS_CENTER, coverCrop, cropAxis, describeFocus, focusFromPoint, formatFocus, parseFocus, sameFocus, type FocalPoint } from '@shared/focus';
import { DraftInput } from '../components/ui';
import { useStore } from '../store';

type Size = Exclude<ResponsiveScope, 'base'>;
const SIZE_NAME: Record<Size, string> = { phone: 'phone', tablet: 'tablet', desktop: 'desktop' };

/** The picture a focal point is chosen on, and the rules under the element's own styles. */
export interface FocusImage {
  /** Where the preview serves the picture, or null when it cannot be shown. */
  src: string | null;
  /** Its size from the image library, when known. */
  width?: number;
  height?: number;
  /** The style rules under this element's own, in tiers, strongest first (see `cascadedStyle`). */
  below: Array<Array<ResponsiveStyles | undefined>>;
  /** Why there is no picture to show, when there is none. */
  missing?: string;
}

const positive = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** "30", "30%" or "12.5 %" as a percentage between 0 and 100; null for anything else. */
function readPercent(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(text);
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
  /** The box's width over height at that size, or null when the picture keeps its own shape. */
  ratio: number | null;
  /** The image fit at that size. */
  fit: StyleValue | undefined;
  image?: FocusImage;
  onSet: (v: StyleValue | null, expectedRevision?: number) => void;
}) {
  const revision = useStore((s) => s.snapshot?.revision ?? 0);
  const captionId = useId();
  const pad = useRef<HTMLDivElement>(null);
  const src = image?.src ?? null;
  // The picture's own size: from the library when it is recorded, else measured once it loads.
  const [measured, setMeasured] = useState<{ src: string; w: number; h: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const libraryRatio = positive(image?.width) && positive(image?.height) ? image.width / image.height : null;
  const sourceRatio = libraryRatio ?? (measured && measured.src === src ? measured.w / measured.h : null);

  // A drag keeps its point to itself until the pointer is released; then the committed value shows until the
  // project moves on to the revision it made (or refused it).
  const gesture = useRef<{ pointer: number; key: string; revision: number } | null>(null);
  const [draft, setDraft] = useState<FocalPoint | null>(null);
  const [pending, setPending] = useState<{ text: string; revision: number } | null>(null);
  const target = `${scope}|${src ?? ''}|${label}`;
  // Another size, picture or element ends a drag in progress without committing it.
  useEffect(() => {
    gesture.current = null;
    setDraft(null);
    setPending(null);
  }, [target]);

  const stored = parseFocus(value) ?? parseFocus(under) ?? FOCUS_CENTER;
  const committed = pending && pending.revision === revision ? parseFocus(pending.text) : null;
  const point = draft ?? committed ?? stored;
  const cropped = fit !== 'contain' && ratio !== null && sourceRatio !== null ? cropAxis(sourceRatio, ratio) : null;
  const crop = cropped && sourceRatio !== null && ratio !== null ? coverCrop(sourceRatio, ratio, point) : null;

  const pointAt = (e: React.PointerEvent): FocalPoint => {
    const r = pad.current!.getBoundingClientRect();
    const fx = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5;
    const fy = r.height > 0 ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0.5;
    return focusFromPoint(fx, fy);
  };
  const end = () => {
    gesture.current = null;
    setDraft(null);
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!crop || e.button !== 0 || gesture.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { pointer: e.pointerId, key: target, revision };
    setDraft(pointAt(e));
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
    if (g.key !== target || g.revision !== revision) return;
    const text = formatFocus(next);
    if (typeof value === 'string' && parseFocus(value) && sameFocus(parseFocus(value)!, next)) return;
    setPending({ text, revision });
    onSet(text, g.revision);
  };
  const cancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointer === e.pointerId) end();
  };

  const setAxis = (axis: 'x' | 'y') => (text: string) => {
    if (!text.trim()) return undefined;
    const n = readPercent(text);
    if (n === null) return false;
    onSet(formatFocus({ ...stored, [axis]: n }));
  };
  const isCenter = typeof value === 'string' && parseFocus(value) !== null && sameFocus(parseFocus(value)!, FOCUS_CENTER);
  const setHere = value !== undefined;
  const sizeName = SIZE_NAME[size];
  const where = scope === 'base' ? `In the ${sizeName} preview` : `On ${sizeName}`;
  const ratioPct = crop ? Math.round((cropped === 'y' ? crop.h : crop.w) * 100) : 0;

  let caption: string;
  if (!image) caption = '';
  else if (image.missing) caption = image.missing;
  else if (!src || failed === src) caption = 'The picture shows here once the preview is running.';
  else if (sourceRatio === null) caption = '';
  else if (fit === 'contain') caption = `${where}, Image fit shows the whole picture, so nothing is cropped.`;
  else if (!cropped) caption = `${where} the whole picture shows. Choose an aspect ratio to crop it.`;
  else caption = `${where} ${ratioPct}% of the picture’s ${cropped === 'y' ? 'height' : 'width'} shows. Drag to choose what stays in view.`;

  return (
    <div className="focus-editor">
      {image && src && failed !== src && !image.missing && (
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
          {crop && <div className="focus-window" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }} />}
          <div className="focus-mark" style={{ left: `${point.x}%`, top: `${point.y}%` }} />
        </div>
      )}
      {caption && (
        <p className="focus-caption" id={captionId}>
          {caption}
        </p>
      )}
      <div className="focus-fields" role="group" aria-label={`${label} as percentages`}>
        <label className="focus-field">
          <span>Across</span>
          <DraftInput
            className={`input sm style-input${setHere ? ' is-set' : ' is-inherited'}`}
            value={setHere && parseFocus(value) ? String(parseFocus(value)!.x) : ''}
            placeholder={String(stored.x)}
            ariaLabel={`${label} across, percent from the left`}
            aria-describedby={caption ? captionId : undefined}
            onCommit={setAxis('x')}
          />
          <span aria-hidden="true">%</span>
        </label>
        <label className="focus-field">
          <span>Down</span>
          <DraftInput
            className={`input sm style-input${setHere ? ' is-set' : ' is-inherited'}`}
            value={setHere && parseFocus(value) ? String(parseFocus(value)!.y) : ''}
            placeholder={String(stored.y)}
            ariaLabel={`${label} down, percent from the top`}
            aria-describedby={caption ? captionId : undefined}
            onCommit={setAxis('y')}
          />
          <span aria-hidden="true">%</span>
        </label>
        <button type="button" className="btn btn-sm focus-center" disabled={isCenter} onClick={() => onSet(formatFocus(FOCUS_CENTER))} title={`Put the center of the picture in the middle${scope === 'base' ? '' : ` on ${sizeName}`}`}>
          <Crosshair aria-hidden="true" /> Center
        </button>
      </div>
    </div>
  );
}
