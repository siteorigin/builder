/**
 * What a first visit to a built page downloads and shows (#1488), measured while the export's page check
 * (main/page-check.ts) has the page open, through the same DevTools session: every file the page's own frame asks for,
 * by kind and size and whether its head preloads it; each picture it shows, with the space it shows in, the width of
 * the file the browser chose and the width its `sizes` asked for; and the largest thing its first screen paints. The
 * page is opened at one window size, one device pixel to each CSS pixel, with nothing cached, so pages measure alike.
 * It never decides whether the page works: a measurement that does not finish only says so.
 */
import { PERFORMANCE_VIEWPORT, type PageSample, type PerformanceKind, type SampledImage, type SampledLcp, type SampledResource } from '@shared/performance';
import type { CdpPage } from './review-shot';

/** How long after the page works its files are waited for, at most: a picture from a host that never answers holds up nothing. */
export const SAMPLE_MS = 2000;
/** How long the page's pictures may take to be read, at most, and setting the page up to be measured. */
const READ_MS = 1000;
/** How long a page with every file in is watched for another, before it is measured. */
const QUIET_MS = 200;
/** Where the page keeps what it was told of its largest paint, out of the way of any name of the site's. */
const LCP_GLOBAL = '__siteoriginLcp';

/** Run before the page's own scripts: keep the latest Largest Contentful Paint the browser reports. */
export const LCP_OBSERVER = `(() => {
  try {
    new PerformanceObserver((list) => {
      const all = list.getEntries();
      const e = all[all.length - 1];
      if (e) Object.defineProperty(window, '${LCP_GLOBAL}', { value: { url: e.url || '', size: e.size || 0 }, configurable: true });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
})();`;

/**
 * Run in the page once its files are in: each picture it shows (loaded, with a box), and its largest paint. The space a
 * picture's `sizes` asks for is read as the browser reads it: the first entry whose media condition holds, its length
 * measured in a box laid out at the window's size.
 */
export const MEASURE_PAGE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:0;top:0;height:0;padding:0;border:0;margin:0;visibility:hidden;pointer-events:none';
  document.documentElement.append(probe);
  const length = (v) => {
    probe.style.width = '';
    probe.style.width = v;
    return probe.style.width ? probe.getBoundingClientRect().width : null;
  };
  /** The entries of a sizes list, split at the commas outside brackets. */
  const entries = (sizes) => {
    const out = [];
    let depth = 0, from = 0;
    for (let i = 0; i < sizes.length; i++) {
      const c = sizes[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ',' && depth === 0) { out.push(sizes.slice(from, i)); from = i + 1; }
    }
    out.push(sizes.slice(from));
    return out.map((e) => e.trim()).filter(Boolean);
  };
  /** The width sizes gives an image shown \`own\` CSS pixels wide: "auto" is that width, as the browser takes it for a lazy image. */
  const slot = (sizes, own) => {
    for (const entry of entries(sizes)) {
      const m = /^(\\(.*\\))\\s+([^()\\s][\\s\\S]*)$/.exec(entry);
      const value = m ? m[2].trim() : entry;
      if (m) {
        try { if (!matchMedia(m[1]).matches) continue; } catch { return null; }
      }
      return value === 'auto' ? own : length(value);
    }
    return null;
  };
  const applies = (media) => { try { return !media || matchMedia(media).matches; } catch { return false; } };
  /** A srcset's candidates with their widths; null when any has none (a density, or none at all). */
  const widths = (srcset) => {
    const list = srcset.split(',').map((c) => c.trim()).filter(Boolean).map((c) => {
      const [url, d] = c.split(/\\s+/);
      const w = /^(\\d+)w$/.exec(d || '');
      return { url: new URL(url, document.baseURI).href, w: w ? Number(w[1]) : null };
    });
    return list.length && list.every((c) => c.w) ? list : null;
  };
  const images = [];
  /** Every file a picture of the page shows, a drawing's included. */
  const used = [];
  for (const img of document.images) {
    const src = img.currentSrc;
    if (src) used.push(src);
    if (!src || !img.complete || !img.naturalWidth || !img.naturalHeight || /\\.svg(?:[?#]|$)/i.test(src)) continue;
    const r = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    const edge = (side) => (parseFloat(cs['padding' + side]) || 0) + (parseFloat(cs['border' + side + 'Width']) || 0);
    const w = r.width - edge('Left') - edge('Right');
    const h = r.height - edge('Top') - edge('Bottom');
    if (w < 1 || h < 1 || cs.visibility === 'hidden') continue;
    // The <source> of its <picture> the browser took its file from, or its own srcset.
    let srcset = img.getAttribute('srcset') || '';
    let sizes = img.getAttribute('sizes');
    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    // Only a source whose media holds can be the one chosen, and the first such that lists the file is.
    if (picture) for (const s of picture.querySelectorAll(':scope > source')) {
      const set = widths(s.getAttribute('srcset') || '');
      if (applies(s.getAttribute('media')) && set && set.some((c) => c.url === src)) { srcset = s.getAttribute('srcset') || ''; sizes = s.getAttribute('sizes') ?? sizes; break; }
    }
    const set = widths(srcset);
    const chosen = set && set.find((c) => c.url === src);
    const aspect = img.naturalWidth / img.naturalHeight;
    const fit = cs.objectFit;
    // Cropped to cover its box it needs more than the box's width; fitted inside it, less; shown at its own size, its own.
    const contained = Math.min(w, h * aspect);
    const needed = fit === 'cover' ? Math.max(w, h * aspect) : fit === 'contain' ? contained : fit === 'scale-down' ? Math.min(contained, img.naturalWidth) : fit === 'none' ? img.naturalWidth : w;
    images.push({
      url: src,
      renderedWidth: w,
      renderedHeight: h,
      neededWidth: needed,
      // A plain file's own width; a srcset's chosen candidate's. A density-described set says neither.
      fileWidth: chosen ? chosen.w : srcset.trim() ? null : img.naturalWidth,
      slotWidth: set ? slot(sizes || '100vw', w) : null,
      sizes: set ? sizes : null,
      inView: r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0,
      area: Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
    });
  }
  probe.remove();
  const told = window.${LCP_GLOBAL};
  let lcp = null;
  if (told) lcp = told.url ? { kind: 'image', url: told.url, from: 'browser' } : { kind: 'text' };
  else {
    // No paint reported (a window the browser does not paint for): the largest picture on the first screen, when it
    // takes a good part of it.
    const big = images.filter((i) => i.inView && i.area >= vw * vh * 0.05).sort((a, b) => b.area - a.area)[0];
    if (big) lcp = { kind: 'image', url: big.url, from: 'estimate' };
  }
  if (lcp && lcp.kind === 'image') used.push(lcp.url);
  return { images: images.map(({ area, ...i }) => i), lcp, used };
})()`;

/** What `p` gives within `ms` (or before `signal` calls it off), or undefined: its timer and listener go either way. */
async function within<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const ended = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    onAbort = () => resolve(undefined);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([p, ended]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** A file the page asked for, as the sampler follows it. */
interface Request {
  url: string;
  type: string;
  mime: string;
  preloaded: boolean;
  length: number | null;
  received: number;
  encoded: number;
  done: boolean;
}

/** What a response's type and the DevTools resource type say a file is. */
export function kindOf(type: string, mime: string, document: boolean): PerformanceKind {
  const m = mime.toLowerCase();
  if (document) return 'html';
  if (/javascript|ecmascript/.test(m) || type === 'Script') return 'js';
  if (m === 'text/css' || type === 'Stylesheet') return 'css';
  if (m.startsWith('font/') || /font-woff|font-ttf|opentype/.test(m) || type === 'Font') return 'fonts';
  if (m.startsWith('image/') || type === 'Image') return 'images';
  return 'other';
}

export interface PageSampler {
  /** Every DevTools event of the page, as the check hears it. */
  hear(method: string, params: Record<string, unknown>): void;
  /** Set the page up to be measured, before it is navigated to and by `until`: false when it could not be, in time or at all. */
  prepare(page: CdpPage, until: number): Promise<boolean>;
  /**
   * Measure it, once it works: wait (until `deadline`, at most SAMPLE_MS) for the website's own files to arrive, then
   * read its pictures and largest paint (in what is left of `deadline`, at most READ_MS). Never throws, and never waits
   * past its deadline or a call-off: a page that cannot be read is measured as far as it got.
   */
  collect(page: CdpPage, opts: { deadline: number; signal?: AbortSignal }): Promise<PageSample>;
}

/**
 * A sampler for one visit to `url`, the page's own frame being the one `mainFrame()` names once it is known. Files
 * are named from the site's root (`origin` taken off) when the website serves them, by their whole address otherwise.
 */
export function createPageSampler(url: string, mainFrame: () => string): PageSampler {
  const origin = new URL(url).origin;
  const requests = new Map<string, Request>();
  let documentId = '';
  let loaded = false;
  let lastEvent = Date.now();
  // Its query kept, so two copies asked for by query are two files: the report shows less (see shared/performance).
  const address = (at: string) => {
    const bare = at.split('#')[0];
    return bare.startsWith(`${origin}/`) ? bare.slice(origin.length) : bare;
  };
  const isOwn = (at: string) => at.startsWith(`${origin}/`);

  return {
    hear(method, p) {
      const id = String(p.requestId ?? '');
      switch (method) {
        case 'Network.requestWillBeSent': {
          if (p.frameId !== mainFrame()) return;
          const request = p.request as { url?: string; isLinkPreload?: boolean } | undefined;
          const at = String(request?.url ?? '');
          if (!/^https?:/.test(at)) return;
          // A redirect keeps the request's ID, and its file is named as the page asked for it (as its picture's
          // currentSrc and its preload are), whatever address the bytes come from in the end.
          if (!requests.has(id))
            requests.set(id, { url: at, type: String(p.type ?? ''), mime: '', preloaded: !!request?.isLinkPreload, length: null, received: 0, encoded: 0, done: false });
          if (p.type === 'Document' && !documentId) documentId = id;
          break;
        }
        case 'Network.responseReceived': {
          const r = requests.get(id);
          if (!r) return;
          const response = p.response as { mimeType?: string; headers?: Record<string, string> } | undefined;
          r.mime = String(response?.mimeType ?? '');
          if (p.type) r.type = String(p.type);
          const header = Object.entries(response?.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-length')?.[1];
          const n = Number(header);
          r.length = header !== undefined && Number.isFinite(n) && n >= 0 ? n : null;
          break;
        }
        case 'Network.dataReceived': {
          const r = requests.get(id);
          if (r) r.received += Number(p.dataLength ?? 0) || 0;
          break;
        }
        case 'Network.loadingFinished': {
          const r = requests.get(id);
          if (!r) return;
          r.done = true;
          r.encoded = Number(p.encodedDataLength ?? 0) || 0;
          break;
        }
        case 'Network.loadingFailed':
          // Nothing arrived to count: a file that failed is no part of what the visit downloaded.
          requests.delete(id);
          break;
        case 'Page.loadEventFired':
          loaded = true;
          break;
        default:
          return;
      }
      lastEvent = Date.now();
    },

    async prepare(page, until) {
      const room = Math.min(READ_MS, until - Date.now());
      if (room <= 0) return false;
      const steps = (async () => {
        await page.send('Emulation.setDeviceMetricsOverride', { width: PERFORMANCE_VIEWPORT.width, height: PERFORMANCE_VIEWPORT.height, deviceScaleFactor: PERFORMANCE_VIEWPORT.deviceScaleFactor, mobile: false });
        await page.send('Network.setCacheDisabled', { cacheDisabled: true });
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: LCP_OBSERVER });
        return true;
      })().catch(() => false);
      return (await within(steps, room)) ?? false;
    },

    async collect(page, { deadline, signal }) {
      const until = Math.min(deadline, Date.now() + SAMPLE_MS);
      // The website's own files: another host's, however slow, are not waited for.
      const pending = () => [...requests.values()].some((r) => !r.done && isOwn(r.url));
      const settled = () => !pending() && Date.now() - lastEvent >= QUIET_MS;
      // Nothing of its own on its way, and has not been a moment: whatever it asks for next is not its first visit.
      while (!signal?.aborted && Date.now() < until && !settled()) await new Promise((r) => setTimeout(r, 25));
      const arrived = loaded && ![...requests.values()].some((r) => !r.done);
      let images: SampledImage[] = [];
      let lcp: SampledLcp = null;
      let used: string[] | undefined;
      const room = Math.min(deadline - Date.now(), READ_MS);
      if (!signal?.aborted && room > 0) {
        const reading = page.send('Runtime.evaluate', { expression: MEASURE_PAGE, returnByValue: true }).catch(() => null) as Promise<{ result?: { value?: { images?: SampledImage[]; lcp?: SampledLcp; used?: string[] } } } | null>;
        // A page that cannot be read in time (it navigated away, or the window went) keeps what its files said.
        const value = (await within(reading, room, signal))?.result?.value;
        if (value && Array.isArray(value.images) && Array.isArray(value.used)) {
          images = value.images.map((i) => ({ ...i, url: address(i.url) }));
          lcp = value.lcp?.kind === 'image' ? { ...value.lcp, url: address(value.lcp.url) } : (value.lcp ?? null);
          used = value.used.map(address);
        }
      }
      const resources: SampledResource[] = [...requests.entries()]
        .filter(([, r]) => r.done)
        .map(([id, r]) => {
          // The body as it arrived, before any host's compression was undone, is what came; what the server said it
          // would send stands in for an empty one (or none heard), and all that came, headers too, for neither.
          const bytes = r.received || (r.length ?? r.encoded);
          return { url: address(r.url), kind: kindOf(r.type, r.mime, id === documentId), bytes, preloaded: r.preloaded, own: isOwn(r.url) };
        });
      // Complete only once its files are in and its pictures were read: either missing, it was measured in part.
      return { complete: arrived && !!used, resources, images, lcp, ...(used ? { used } : {}) };
    }
  };
}
