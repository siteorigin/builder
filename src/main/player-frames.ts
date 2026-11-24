/**
 * Which frames inside the previewed site may load a video player. Kept apart from the window code so it can be
 * tested without Electron.
 */
import { isVideoPlayerUrl } from '@shared/video';

/** What the check reads of a frame: Electron's WebFrameMain, or a stand-in in tests. */
export interface FrameView {
  readonly url: string;
  readonly parent: FrameView | null;
  readonly detached?: boolean;
  isDestroyed?(): boolean;
}

/** Whether two addresses are web pages of the same origin. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    return (ua.protocol === 'http:' || ua.protocol === 'https:') && ua.origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** A frame still in the page: a destroyed or detached frame (or one that cannot be read) authorises nothing. */
function live(frame: FrameView | null | undefined): frame is FrameView {
  try {
    return !!frame && !frame.detached && !frame.isDestroyed?.();
  } catch {
    return false;
  }
}

/**
 * Whether a frame may open `url`: only a player address the builder itself writes for a YouTube or Vimeo video
 * (see isVideoPlayerUrl), and only in a frame placed directly in a page of the project that the editor window
 * frames, the preview. The previewed site could already load anything from the web as an image or a request;
 * what it may never do is take a frame to any other page.
 */
export function playerFrameAllowed(url: string, frame: FrameView | null | undefined, editor: FrameView, devUrl: string | null): boolean {
  if (!devUrl || !isVideoPlayerUrl(url) || !live(frame)) return false;
  try {
    const page = frame.parent;
    return live(page) && page.parent === editor && sameOrigin(page.url, devUrl);
  } catch {
    return false;
  }
}
