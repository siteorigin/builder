/**
 * Photographs of isolated component previews, for the thumbnails in Insert (see main/runtime/component-thumbs). A
 * preview is loaded in a window of its own that is never shown or focused (tests and people never see it), whose
 * page may go nowhere else, open nothing, ask for nothing and download nothing. The bridge in a preview opened this
 * way shows it as visitors see it and offers one call that waits for its fonts and images and measures it; the
 * window photographs the top of what it measured and scales that down.
 */
import { BrowserWindow, session as electronSession } from 'electron';
import { THUMB_SIZE, THUMB_VIEW, thumbCrop, type Box, type CaptureResult } from './runtime/component-thumbs';
import { sameOrigin } from './player-frames';
import { previewKeyOf } from '@shared/component-preview';

/** How long a preview gets to load, mount, settle and be measured; one that takes longer is not pictured. */
const CAPTURE_MS = 20000;
/** How long the window is kept after its last photograph, for the next one. */
const IDLE_MS = 30000;
/** The window's own session: in memory, shared with nothing else. */
const PARTITION = 'siteorigin-thumbs';

/** What the bridge measured: which preview, whether the component mounted, why not, and the box it fills. */
interface Measured {
  key?: unknown;
  mounted?: unknown;
  /** Whether its fonts and images had all arrived. */
  loaded?: unknown;
  error?: unknown;
  bounds?: Box | null;
  /** Where it paints something to see. */
  ink?: Box | null;
}

/**
 * Waits for the preview's module to mount the component and for the bridge to arrive (or for the mount to fail),
 * then asks the bridge to settle and measure. Runs in the preview's page.
 */
const MEASURE = `(async () => {
  for (let i = 0; i < 150; i++) {
    if (typeof window.__siteoriginThumb === 'function') return await window.__siteoriginThumb();
    await new Promise((r) => setTimeout(r, 100));
  }
  const p = window.__siteoriginPreview;
  return p && typeof p === 'object' ? { key: String(p.key || ''), mounted: p.mounted === true, error: p.error ? String(p.error) : undefined } : null;
})()`;

/** Every animation and transition at its end at once, so nothing is photographed half way. */
const STILL_CSS = 'html { scroll-behavior: auto !important; } *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition: none !important; }';

export interface ThumbCapturer {
  /** Photograph the prepared preview at `path` on the preview server at `server`. */
  capture(server: string, path: string): Promise<CaptureResult>;
  /** Close the window, ending a photograph under way. */
  dispose(): void;
}

let guarded = false;
/**
 * The window's session refuses every permission and download, whatever a page asks, and its pages are sandboxed as
 * the editor's preview frame is: scripts run, but nothing opens a dialog (a print, an alert), a window or a worker.
 */
function guardSession() {
  const ses = electronSession.fromPartition(PARTITION);
  if (guarded) return ses;
  guarded = true;
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  ses.webRequest.onHeadersReceived((details, done) => {
    if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return done({});
    const headers = { ...(details.responseHeaders ?? {}) };
    const name = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy';
    // No worker either: a service worker could answer a later preview's page without these headers.
    headers[name] = [...(headers[name] ?? []), "sandbox allow-scripts allow-same-origin; worker-src 'none'"];
    done({ responseHeaders: headers });
  });
  return ses;
}

export function createThumbCapturer(): ThumbCapturer {
  let win: BrowserWindow | null = null;
  /** The origin the window's page may load from: the preview server's, set for each photograph. */
  let allowed: string | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  /** Ends the photograph under way, when the window is closed under it. */
  let abort: ((message: string) => void) | null = null;

  const close = () => {
    if (idle) clearTimeout(idle);
    idle = null;
    const w = win;
    win = null;
    if (w && !w.isDestroyed()) w.destroy();
  };

  const open = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win;
    const w = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      useContentSize: true,
      width: THUMB_VIEW.width,
      height: THUMB_VIEW.height,
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
    w.webContents.setAudioMuted(true);
    // Its page goes nowhere and opens nothing; only the editor loads it. Frames inside it stay on the preview server.
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.on('will-frame-navigate', (e) => {
      if (!e.isMainFrame && !(allowed && sameOrigin(e.url, allowed))) e.preventDefault();
    });
    w.webContents.on('will-redirect', (e) => {
      if (!(allowed && sameOrigin(e.url, allowed))) e.preventDefault();
    });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('render-process-gone', () => {
      abort?.('The component preview stopped responding.');
      if (win === w) close();
    });
    w.on('closed', () => {
      if (win === w) win = null;
    });
    win = w;
    return w;
  };

  const capture = async (server: string, path: string): Promise<CaptureResult> => {
    let url: string;
    let origin: string;
    try {
      origin = new URL(server).origin;
      url = new URL(path, server).href;
    } catch {
      return { ok: false, message: 'The component preview is not on the preview server.' };
    }
    if (!path.startsWith('/') || !sameOrigin(url, origin)) return { ok: false, message: 'The component preview is not on the preview server.' };
    if (idle) clearTimeout(idle);
    idle = null;
    allowed = origin;
    const w = open();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = new Promise<CaptureResult>((resolve) => {
      abort = (message) => resolve({ ok: false, message, transient: true });
      timer = setTimeout(() => resolve({ ok: false, message: 'Timed out drawing the component.', transient: true }), CAPTURE_MS);
    });
    const shoot = async (): Promise<CaptureResult> => {
      await w.loadURL(url);
      await w.webContents.insertCSS(STILL_CSS);
      const measured = (await w.webContents.executeJavaScript(MEASURE, false)) as Measured | null;
      // Neither the component nor the bridge arrived: the preview server did not serve the page as it should.
      if (!measured) return { ok: false, message: 'The component preview did not load.', transient: true };
      // Another preview answered (a redirect the server made): not this component.
      if (measured.key !== previewKeyOf(path)) return { ok: false, message: 'The preview server showed another component.', transient: true };
      if (measured.mounted !== true) {
        const why = typeof measured.error === 'string' ? measured.error.slice(0, 500) : '';
        return { ok: false, message: why ? `The component could not be shown: ${why}` : 'The component could not be shown.' };
      }
      // A font or image still on its way would be pictured missing, and kept so.
      if (measured.loaded !== true) return { ok: false, message: 'The component was still loading.', transient: true };
      const crop = thumbCrop(measured.bounds ?? null, measured.ink ?? null);
      if (!crop) return { ok: false, message: 'The component shows nothing to picture.' };
      const image = await w.webContents.capturePage(crop, { stayHidden: true });
      if (image.isEmpty()) return { ok: false, message: 'The component could not be pictured.', transient: true };
      return { ok: true, png: image.resize({ ...THUMB_SIZE, quality: 'best' }).toPNG() };
    };
    try {
      const result = await Promise.race([shoot().catch((e: unknown): CaptureResult => ({ ok: false, message: `The component could not be pictured: ${e instanceof Error ? e.message : String(e)}`, transient: true })), ended]);
      // A page that never answered (a component stuck in a loop) takes its window with it; the next one starts afresh.
      if (!result.ok && win === w) close();
      return result;
    } finally {
      clearTimeout(timer);
      abort = null;
      allowed = null;
      if (win === w && !w.isDestroyed()) {
        // Nothing of the preview stays loaded: its server may stop, and its files are released.
        void w.loadURL('about:blank').catch(() => undefined);
        idle = setTimeout(close, IDLE_MS);
      }
    }
  };

  return {
    capture,
    dispose() {
      abort?.('The component preview was closed.');
      close();
    }
  };
}
