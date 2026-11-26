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

/**
 * The preview the editor's canvas shows: the open project's own server once it is ready, or, in another computer's
 * live session this app is a guest in, the host's preview as this computer's loopback server shows it (#766).
 * Null while there is neither.
 */
export function canvasPreviewUrl(dev: { status: { state: string; url?: string } } | null | undefined, remote: { previewAccess: { url: string } | null }): string | null {
  if (dev?.status.state === 'ready' && typeof dev.status.url === 'string') return dev.status.url;
  return remote.previewAccess?.url ?? null;
}

/**
 * Whether a frame inside the editor may navigate to `target`: only to the preview the canvas shows (compared by
 * origin, so http://127.0.0.1:5173 never admits http://127.0.0.1:51730), or to a blank page.
 */
export function previewNavigationAllowed(target: string, previewUrl: string | null): boolean {
  return (!!previewUrl && sameOrigin(target, previewUrl)) || target.startsWith('about:');
}
