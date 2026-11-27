/**
 * Where the editor's measuring frames sit (lib/inspect.ts): in the window, transparent and behind the editor, rather
 * than outside it or `visibility: hidden`. Chromium does not render a frame of another origin that is either (the
 * preview is one), so it gets no animation frames, resize or intersection callbacks: the page would be measured unlike
 * the preview shows it, after waiting out its deadline for frames that never come (#976).
 */
/**
 * How a measuring frame's name (its bridge's session) starts. The frame keeps its name through a reload, so its page's
 * bridge knows from its first moment that it does not speak for the canvas (see `measuring` in bridge.client.js).
 */
export const MEASURING_SESSION_PREFIX = 'so-measure-';

export function measuringFrameStyle(width: number): Record<string, string> {
  return { position: 'fixed', left: '0', top: '0', width: `${width}px`, height: '900px', border: '0', opacity: '0', zIndex: '-1', pointerEvents: 'none' };
}
