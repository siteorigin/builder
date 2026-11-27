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
/** How long a new window gets to open its blank page. */
const OPEN_MS = 10000;

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

/** `p`, or `fallback` once OPEN_MS have passed. */
function within<T>(p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), OPEN_MS)))]).finally(() => clearTimeout(timer));
}

export function createReviewShooter(): ReviewShooter {
  const open = new Set<BrowserWindow>();
  /** How many times the windows were disposed of: a picture that began before the last one opens none. */
  let disposals = 0;
  /** The last clear of the windows' stored state, finished or not. */
  let lastClear: Promise<unknown> = Promise.resolve();

  const shoot = async (url: string, width: number, signal?: AbortSignal): Promise<ReviewShot> => {
    if (signal?.aborted) return { ok: false, reason: 'failed', detail: 'The capture was stopped.' };
    const ses = guardSession();
    const generation = disposals;
    // Each picture starts as a first visit: nothing a page stored, and no worker it registered, at another width.
    // One clear at a time, each after the last (chained before anything is awaited): an earlier one still running,
    // its picture called off, would wipe this one's page.
    const prior = lastClear;
    const clear = within(prior.then(() => true), false).then((free) => (free ? ses.clearStorageData().then(() => true, () => false) : false));
    // The next waits for this clear and for every earlier one still running, even one this picture gave up waiting for.
    lastClear = Promise.all([prior, clear]);
    const cleared = await within(clear, false);
    // Called off, or the windows disposed of, meanwhile: no window is made for it.
    if (signal?.aborted || generation !== disposals) return { ok: false, reason: 'failed', detail: 'The capture was stopped.' };
    if (!cleared) return { ok: false, reason: 'failed', detail: 'What an earlier page stored could not be cleared, so the page would not be shown as a first visit.' };
    const w = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      useContentSize: true,
      width,
      height: 900,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        session: ses,
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
    // The window lost (its renderer, the window itself, or its DevTools session) ends the picture at once.
    const gone = new AbortController();
    wc.on('render-process-gone', () => gone.abort());
    wc.once('destroyed', () => gone.abort());
    wc.debugger.on('detach', () => gone.abort());
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
        wc.loadURL('about:blank').then(() => true, () => false),
        new Promise<false>((resolve) => {
          ready = setTimeout(() => resolve(false), OPEN_MS);
          if (gone.signal.aborted) resolve(false);
          else gone.signal.addEventListener('abort', () => resolve(false), { once: true });
        })
      ]).finally(() => clearTimeout(ready));
      if (!opened) return { ok: false, reason: gone.signal.aborted ? 'failed' : 'timeout', detail: signal?.aborted ? 'The capture was stopped.' : 'The capture window did not open.' };
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
      disposals++;
      for (const w of open) if (!w.isDestroyed()) w.destroy();
      open.clear();
    }
  };
}
