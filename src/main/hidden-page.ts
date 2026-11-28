/**
 * A page in a window of its own that is never shown or focused (tests and people never see it), opened for one job and
 * destroyed after it, so nothing of one page (a late request, a timer, a crashed renderer) reaches the next. Its page
 * may go nowhere of its own accord, open nothing, ask for nothing and download nothing, as Insert's thumbnails are
 * taken (main/thumb-capture). The job speaks to the page through the window's DevTools session only, so a test's
 * headless Chromium can run exactly the same steps (main/review-shot, main/page-check).
 */
import { BrowserWindow, session as electronSession, type Session } from 'electron';
import type { CdpPage } from './review-shot';

/** How long a new window gets to open its blank page. */
export const OPEN_MS = 10000;

const guarded = new Set<string>();

/** The in-memory session of `partition`, shared with nothing else, that grants no permission and downloads nothing. */
export function guardedSession(partition: string): Session {
  const ses = electronSession.fromPartition(partition);
  if (guarded.has(partition)) return ses;
  guarded.add(partition);
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  return ses;
}

/** `p`, or `fallback` once OPEN_MS have passed. */
export function within<T>(p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), OPEN_MS)))]).finally(() => clearTimeout(timer));
}

export interface HiddenPageOptions {
  session: Session;
  /** The window's width and height, in CSS pixels. */
  width: number;
  height?: number;
  /** Ends the job under way: its window is destroyed. */
  signal?: AbortSignal;
  /** Where the window is kept while it is open, so its owner can destroy it. */
  open?: Set<BrowserWindow>;
}

/**
 * What became of a job: its value, and whether the window was lost (its renderer, the window itself, or its DevTools
 * session) while it ran; or that the window never opened its blank page (`ended` when it was lost or called off
 * meanwhile, rather than slow), or that the job threw.
 */
export type HiddenPageOutcome<T> = { ok: true; value: T; lost: boolean } | { ok: false; why: 'not-opened'; ended: boolean } | { ok: false; why: 'threw'; error: unknown };

/**
 * Run `job` on a page of a hidden window, given the page's DevTools session and a signal that ends once the window is
 * lost or `opts.signal` ends. The window is destroyed after the job, whatever became of it.
 */
export async function inHiddenPage<T>(opts: HiddenPageOptions, job: (page: CdpPage, gone: AbortSignal) => Promise<T>): Promise<HiddenPageOutcome<T>> {
  const { signal } = opts;
  const w = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    useContentSize: true,
    width: opts.width,
    height: opts.height ?? 900,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: opts.session,
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
  opts.open?.add(w);
  const wc = w.webContents;
  wc.setAudioMuted(true);
  // Only the job opens the page; the page itself goes nowhere and opens nothing.
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The window lost (its renderer, the window itself, or its DevTools session) ends the job at once.
  const gone = new AbortController();
  let lost = false;
  const lose = () => {
    lost = true;
    gone.abort();
  };
  wc.on('render-process-gone', lose);
  wc.once('destroyed', lose);
  wc.debugger.on('detach', lose);
  const stop = () => gone.abort();
  // Called off while the window was being made: an abort listened for only now would never be heard.
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  const onMessage = (_e: unknown, method: string, params: Record<string, unknown>) => listeners.forEach((l) => l(method, params));
  try {
    // A window that has loaded nothing has no page to speak to yet: its DevTools session would never answer.
    let ready: ReturnType<typeof setTimeout> | undefined;
    const opened = await Promise.race([
      wc.loadURL('about:blank').then(
        () => true,
        () => false
      ),
      new Promise<false>((resolve) => {
        ready = setTimeout(() => resolve(false), OPEN_MS);
        if (gone.signal.aborted) resolve(false);
        else gone.signal.addEventListener('abort', () => resolve(false), { once: true });
      })
    ]).finally(() => clearTimeout(ready));
    if (!opened) return { ok: false, why: 'not-opened', ended: gone.signal.aborted };
    wc.debugger.attach('1.3');
    wc.debugger.on('message', onMessage);
    const page: CdpPage = {
      send: (method, params) => wc.debugger.sendCommand(method, params),
      listen: (l) => (listeners.add(l), () => void listeners.delete(l))
    };
    const value = await job(page, gone.signal);
    return { ok: true, value, lost };
  } catch (error) {
    return { ok: false, why: 'threw', error };
  } finally {
    signal?.removeEventListener('abort', stop);
    opts.open?.delete(w);
    if (!w.isDestroyed()) {
      wc.debugger.removeListener('message', onMessage);
      if (wc.debugger.isAttached()) wc.debugger.detach();
      w.destroy();
    }
  }
}
