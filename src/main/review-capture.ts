/**
 * Review edition pictures (#1133) taken in the app: each page at each width in a window of its own that is never
 * shown or focused (tests and people never see it), opened for the one picture and destroyed after it, so nothing of
 * one page (a late request, a timer, a crashed renderer) reaches the next. Its page may go nowhere of its own accord,
 * open nothing, ask for nothing and download nothing, as Insert's thumbnails are taken (main/thumb-capture). The
 * steps of the picture are main/review-shot's, spoken through the window's DevTools session.
 */
import { BrowserWindow, session as electronSession } from 'electron';
import { shootReviewPage, type CdpPage, type ReviewShot } from './review-shot';

/** The windows' own session: in memory, shared with nothing else. */
const PARTITION = 'siteorigin-review-capture';

let guarded = false;
function guardSession() {
  const ses = electronSession.fromPartition(PARTITION);
  if (guarded) return ses;
  guarded = true;
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  return ses;
}

export interface ReviewShooter {
  /** Photograph the page at `url` laid out `width` CSS pixels wide. */
  shoot(url: string, width: number, signal?: AbortSignal): Promise<ReviewShot>;
  /** Destroy every window still taking a picture. */
  dispose(): void;
}

export function createReviewShooter(): ReviewShooter {
  const open = new Set<BrowserWindow>();

  const shoot = async (url: string, width: number, signal?: AbortSignal): Promise<ReviewShot> => {
    if (signal?.aborted) return { ok: false, reason: 'failed', detail: 'The capture was stopped.' };
    const w = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      useContentSize: true,
      width,
      height: 900,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        session: guardSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        disableDialogs: true,
        // Hidden for good, so timers and painting must not wait for it to be seen.
        backgroundThrottling: false
      }
    });
    open.add(w);
    const wc = w.webContents;
    wc.setAudioMuted(true);
    // Only the capture opens the page; the page itself goes nowhere and opens nothing.
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const gone = new AbortController();
    wc.on('render-process-gone', () => gone.abort());
    const stop = () => gone.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
    const onMessage = (_e: unknown, method: string, params: Record<string, unknown>) => listeners.forEach((l) => l(method, params));
    try {
      wc.debugger.attach('1.3');
      wc.debugger.on('message', onMessage);
      const page: CdpPage = {
        send: (method, params) => wc.debugger.sendCommand(method, params),
        listen: (l) => (listeners.add(l), () => void listeners.delete(l))
      };
      const shot = await shootReviewPage(page, url, width, { signal: gone.signal });
      if (!shot.ok && gone.signal.aborted && !signal?.aborted) return { ok: false, reason: 'failed', detail: 'The page stopped responding.' };
      return shot;
    } catch (e) {
      return { ok: false, reason: 'failed', detail: `The page could not be captured: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      signal?.removeEventListener('abort', stop);
      open.delete(w);
      if (!w.isDestroyed()) {
        wc.debugger.removeListener('message', onMessage);
        if (wc.debugger.isAttached()) wc.debugger.detach();
        w.destroy();
      }
    }
  };

  return {
    shoot,
    dispose() {
      for (const w of open) if (!w.isDestroyed()) w.destroy();
      open.clear();
    }
  };
}
