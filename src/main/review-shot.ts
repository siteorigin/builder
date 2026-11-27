/**
 * One page of a review build photographed at one viewport width (#1133), whole: the page is laid out at the width, every
 * image, stylesheet, script and font it asks for must arrive and every font must settle, and the picture is taken of
 * its full height at one CSS pixel per pixel. A page that cannot be pictured faithfully is reported unavailable, with
 * why, rather than photographed blank or half drawn.
 *
 * It speaks to the page through the Chrome DevTools Protocol only (a session on one page), so the app's hidden window
 * (main/review-capture) and a test's headless Chromium run exactly the same steps.
 */
import type { ReviewCaptureReason } from '@shared/review-edition';

/** A DevTools Protocol session attached to one page. */
export interface CdpPage {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Listen to every event of the session; returns the way to stop. */
  listen(listener: (method: string, params: Record<string, unknown>) => void): () => void;
}

export type ReviewShot = { ok: true; png: Buffer; height: number } | { ok: false; reason: ReviewCaptureReason; detail: string };

export interface ShotOptions {
  /** Ends the photograph under way (the project closed). */
  signal?: AbortSignal;
  /** How long the whole photograph may take. */
  timeoutMs?: number;
  /** How long fonts get to settle once the page has loaded. */
  fontMs?: number;
}

/** The tallest page pictured, in CSS pixels; a taller one is unavailable rather than cut short. */
export const MAX_SHOT_HEIGHT = 16384;
/** The viewport's height while the page is laid out (vh units and the first screen), as a laptop's. */
const VIEW_HEIGHT = 900;
const SHOT_MS = 30000;
const FONT_MS = 10000;
/** How long the page is left quiet after its last request, so a request one starts in response is seen. */
const QUIET_MS = 150;

/** The requests a picture depends on: a missing one leaves a hole, an unstyled page or a fallback font. */
const NEEDED = new Set(['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script']);

/** Every animation and transition at its end at once, as Insert's thumbnails are taken (main/thumb-capture). */
const STILL_CSS = 'html { scroll-behavior: auto !important; } *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition: none !important; }';

/**
 * Run in the page once it has loaded: freezes motion, loads lazy images now, walks down the page a screen at a time
 * so anything waiting to come into view asks for what it needs, comes back to the top, and waits for the fonts.
 */
const SETTLE = (fontMs: number) => `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(STILL_CSS)};
  document.head.append(style);
  for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager';
  const step = Math.max(200, innerHeight);
  for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 200; y += step, i++) {
    scrollTo(0, y);
    await frame();
  }
  scrollTo(0, 0);
  await frame();
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, ${fontMs}))]);
  return true;
})()`;

/**
 * Run in the page just before the picture, and again after it: the images it shows that cannot be drawn (a picture
 * element's chosen source, and every background a shown element or its ::before or ::after paints, which never
 * appear among the page's images), the fonts that failed, and whether every font has settled.
 */
const CHECK = `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const broken = [];
  const decodes = (img) => img.decode().then(() => true, () => false);
  for (const img of document.images) {
    const src = img.currentSrc;
    if (!src) continue;
    // A source changed while it was decoded (a carousel moving on) is decoded again as it is now.
    if (!(await decodes(img)) && (img.currentSrc === src || !(await decodes(img)))) broken.push(img.currentSrc || src);
  }
  const backgrounds = new Set();
  for (const el of document.querySelectorAll('*')) {
    if (!el.getClientRects().length) continue;
    for (const pseudo of [null, '::before', '::after']) {
      const bg = getComputedStyle(el, pseudo).backgroundImage;
      // image-set() offers several pictures and paints one; only that one is fetched, and its request is watched.
      if (!bg || bg === 'none' || bg.includes('image-set(')) continue;
      for (const m of bg.matchAll(/url\\(\\s*(['"]?)(.*?)\\1\\s*\\)/g)) backgrounds.add(new URL(m[2], document.baseURI).href);
    }
  }
  await Promise.all([...backgrounds].map(async (src) => {
    const img = new Image();
    img.src = src;
    if (!(await decodes(img))) broken.push(src);
  }));
  const fontErrors = [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family);
  await frame();
  await frame();
  return { broken, fontErrors, fonts: document.fonts.status };
})()`;

/** An address as a note names it: the path on the review server, the whole address elsewhere. */
function shortUrl(url: string, origin: string): string {
  try {
    const u = new URL(url);
    return (u.origin === origin ? u.pathname : `${u.origin}${u.pathname}`).slice(0, 300);
  } catch {
    return url.slice(0, 300);
  }
}

/** A PNG's width and height from its header, or null when the bytes are not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.toString('latin1', 1, 4) !== 'PNG' || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

class Stop extends Error {
  constructor(
    readonly reason: ReviewCaptureReason,
    message: string
  ) {
    super(message);
  }
}

/** Photograph the page at `url` laid out `width` CSS pixels wide, through the DevTools session `page`. */
export async function shootReviewPage(page: CdpPage, url: string, width: number, opts: ShotOptions = {}): Promise<ReviewShot> {
  const origin = new URL(url).origin;
  /** The requests under way, by ID, with their addresses. */
  const pending = new Map<string, string>();
  /** What failed to arrive, as the notes name it, in order. */
  const failed: string[] = [];
  let lastActivity = Date.now();
  let mainFrame = '';
  let document: { status: number; url: string } | null = null;
  let documentFailed: string | null = null;
  let loaded = false;
  /**
   * Set while the picture is taken: Chromium lays the page out again for a picture beyond the first screen (at a
   * moment's size of its own), and what that layout asks for is not what the picture shows.
   */
  let capturing = false;
  const ignored = new Set<string>();
  let wake: (() => void) | null = null;
  const poke = () => {
    lastActivity = Date.now();
    wake?.();
  };

  const stopListening = page.listen((method, p) => {
    const id = String(p.requestId);
    const needed = NEEDED.has(String(p.type));
    switch (method) {
      case 'Network.requestWillBeSent': {
        // A redirect is the same request going on: one under way before the picture stays watched.
        if (pending.has(id)) {
          pending.set(id, String((p.request as { url?: string })?.url ?? ''));
          break;
        }
        if (capturing) ignored.add(id);
        if (!needed || capturing) return;
        pending.set(id, String((p.request as { url?: string })?.url ?? ''));
        break;
      }
      case 'Network.responseReceived': {
        if (ignored.has(id) || !needed) return;
        const response = p.response as { status: number; url: string };
        if (p.type === 'Document' && p.frameId === mainFrame) document = { status: response.status, url: response.url };
        else if (response.status >= 400) failed.push(`${shortUrl(response.url, origin)} (${response.status})`);
        break;
      }
      case 'Network.loadingFinished':
        if (!pending.delete(id)) return;
        break;
      case 'Network.loadingFailed': {
        const at = pending.get(id);
        if (!pending.delete(id)) return;
        // A request the page called off itself (a responsive image it chose another size of) took nothing away.
        if (p.canceled === true) break;
        const what = `${shortUrl(at ?? '', origin)} (${String(p.errorText ?? 'failed')})`;
        if (p.type === 'Document' && !document) documentFailed = what;
        else failed.push(what);
        break;
      }
      case 'Page.loadEventFired':
        loaded = true;
        break;
      default:
        return;
    }
    // Only what the picture waits for moves its clock: a page polling for something else still settles.
    poke();
  });

  const deadline = Date.now() + (opts.timeoutMs ?? SHOT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const ended = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Stop('timeout', 'The page took too long to load and settle.')), Math.max(0, deadline - Date.now()));
    onAbort = () => reject(new Stop('failed', 'The capture was stopped.'));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  ended.catch(() => undefined);
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, ended]);
  /** Wait until `ready` holds, looking again on every event of the page and every 50 ms. */
  const until = async (ready: () => boolean) => {
    let tick: ReturnType<typeof setInterval> | undefined;
    try {
      await race(
        new Promise<void>((resolve) => {
          const look = () => void (ready() && resolve());
          tick = setInterval(look, 50);
          wake = look;
          look();
        })
      );
    } finally {
      clearInterval(tick);
      wake = null;
    }
  };
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = (await race(page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Stop('failed', `The page could not be measured: ${r.exceptionDetails.text ?? 'it threw an error'}.`);
    return r.result?.value as T;
  };
  /** Whether everything the page shows can be drawn and its fonts have settled (CHECK). */
  const shown = async () => {
    const check = await evaluate<{ broken: string[]; fontErrors: string[]; fonts: string }>(CHECK);
    if (check.broken.length) throw new Stop('assets', `Some images could not be shown: ${check.broken.slice(0, 5).map((u) => shortUrl(u, origin)).join(', ')}.`);
    if (check.fontErrors.length) throw new Stop('fonts', `Some fonts failed to load: ${[...new Set(check.fontErrors)].join(', ')}.`);
    if (check.fonts !== 'loaded') throw new Stop('fonts', 'The page’s fonts had not finished loading.');
  };
  const assetsOk = () => {
    if (failed.length) throw new Stop('assets', `Not everything on the page loaded: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ` and ${failed.length - 5} more` : ''}.`);
  };

  try {
    await race(page.send('Page.enable'));
    await race(page.send('Network.enable'));
    await race(page.send('Network.setCacheDisabled', { cacheDisabled: true }));
    await race(page.send('Emulation.setDeviceMetricsOverride', { width, height: VIEW_HEIGHT, deviceScaleFactor: 1, mobile: false }));
    await race(page.send('Emulation.setScrollbarsHidden', { hidden: true }));
    const tree = (await race(page.send('Page.getFrameTree'))) as { frameTree: { frame: { id: string } } };
    mainFrame = tree.frameTree.frame.id;
    const nav = (await race(page.send('Page.navigate', { url }))) as { errorText?: string };
    if (nav.errorText) throw new Stop('navigation', `The page could not be opened (${nav.errorText}).`);
    await until(() => loaded || !!documentFailed);
    if (documentFailed) throw new Stop('navigation', `The page could not be opened: ${documentFailed}.`);
    const doc = document as { status: number; url: string } | null;
    if (!doc || doc.status < 200 || doc.status >= 300) throw new Stop('navigation', `The review server answered ${doc ? doc.status : 'nothing'} for this page.`);
    // A redirect to another page would picture that page under this one's name.
    if (doc.url !== url) throw new Stop('navigation', `The page led to ${shortUrl(doc.url, origin)} instead.`);
    await evaluate<boolean>(SETTLE(opts.fontMs ?? FONT_MS));
    await until(() => pending.size === 0 && Date.now() - lastActivity >= QUIET_MS);
    assetsOk();
    await shown();
    assetsOk();
    const metrics = (await race(page.send('Page.getLayoutMetrics'))) as { cssContentSize?: { height: number }; contentSize: { height: number } };
    const height = Math.ceil((metrics.cssContentSize ?? metrics.contentSize).height);
    if (height > MAX_SHOT_HEIGHT) throw new Stop('too-tall', `The page is ${height} px tall at this width, more than the ${MAX_SHOT_HEIGHT} px a capture can hold.`);
    if (height < 1) throw new Stop('failed', 'The page shows nothing to capture.');
    capturing = true;
    const shot = (await race(page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width, height, scale: 1 } }))) as { data: string };
    const png = Buffer.from(shot.data, 'base64');
    const size = pngSize(png);
    if (!size || size.width !== width || size.height !== height) throw new Stop('failed', `The picture came out ${size ? `${size.width} × ${size.height}` : 'unreadable'} instead of ${width} × ${height}.`);
    // A request of the page's own that failed while the picture was being taken is missing from it, and so is an
    // image the page put in place meanwhile (a timer of its own) that cannot be drawn.
    assetsOk();
    await shown();
    assetsOk();
    // Something the page asked for before the picture and is still waiting for may be missing from it.
    if (pending.size) throw new Stop('assets', `The page was still loading: ${[...pending.values()].slice(0, 5).map((u) => shortUrl(u, origin)).join(', ')}.`);
    return { ok: true, png, height };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: e.reason, detail: e.message };
    return { ok: false, reason: 'failed', detail: `The page could not be captured: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    wake = null;
    stopListening();
  }
}
