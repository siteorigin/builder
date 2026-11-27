/**
 * Review edition pictures (#1133) in a real headless Chromium: the steps the app's hidden window runs
 * (src/main/review-shot.ts), driven through a DevTools session on a page of a website folder served as the review
 * server serves it, under a base path. A page is pictured whole at the width asked for, lazy images included; a page
 * whose font, background image or picture failed is unavailable at that width rather than pictured with a hole.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { chromium, type Browser, type CDPSession } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticPreviews } from '../../src/main/static-preview';
import { shootReviewPage, type CdpPage } from '../../src/main/review-shot';

const browserInstalled = existsSync(chromium.executablePath());
const FONT = 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2';

let root = '';
let server = '';
let browser: Browser;
const previews = new StaticPreviews();

const page = (title: string, head: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>html,body{margin:0}${head}</style></head><body>${body}</body></html>`;

/** A red band at the very bottom of a page `height` pixels tall, so the picture shows it reached the end. */
const tall = (height: number) => `<div style="height:${height - 40}px;background:#fff">Top</div><div id="end" style="height:40px;background:#f00"></div>`;

async function png(width: number, height: number, color: { r: number; g: number; b: number }) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'so-review-shot-'));
  const put = (rel: string, body: string | Buffer) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  copyFileSync(FONT, (mkdirSync(join(root, 'fonts'), { recursive: true }), join(root, 'fonts/mono.woff2')));
  put('blue.png', await png(40, 40, { r: 0, g: 0, b: 255 }));
  put('corrupt.png', Buffer.from('not a picture at all'));
  put('index.html', page('Home', '', tall(2600)));
  put('narrow/index.html', page('Narrow', '.band{height:300px;background:#f00}@media (max-width: 600px){.band{background:#0f0}}', '<div class="band"></div>'));
  put('font/index.html', page('Font', "@font-face{font-family:Mono;src:url(/client/fonts/mono.woff2) format('woff2');font-display:block}body{font-family:Mono}", '<p>Settled type</p>'));
  put('missing-font/index.html', page('Missing font', "@font-face{font-family:Gone;src:url(/client/fonts/gone.woff2) format('woff2');font-display:block}body{font-family:Gone}", '<p>Never settles</p>'));
  // The phone layout shows a background picture the folder does not have; the desktop layout shows none.
  put('phone/index.html', page('Phone', '.hero{height:200px;background:#fff}@media (max-width: 600px){.hero{background:url(/client/missing-hero.png) #0f0}}', '<div class="hero">Hero</div>'));
  put('broken/index.html', page('Broken', '', '<img src="/client/corrupt.png" width="40" height="40">'));
  put('lazy/index.html', page('Lazy', '', `${tall(3000)}<img id="late" loading="lazy" src="/client/blue.png" width="40" height="40" style="display:block">`));
  server = await previews.serve(root, '/client');
  if (browserInstalled) browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  previews.stopAll();
  rmSync(root, { recursive: true, force: true });
});

/** A fresh page and a DevTools session on it, as the app opens a fresh hidden window for each picture. */
async function session(): Promise<{ cdp: CdpPage; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: null });
  const p = await context.newPage();
  const s: CDPSession = await context.newCDPSession(p);
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  const events = ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Page.loadEventFired'] as const;
  for (const name of events) s.on(name, (params: unknown) => listeners.forEach((l) => l(name, params as Record<string, unknown>)));
  return {
    cdp: {
      send: (method, params) => s.send(method as 'Page.enable', params as never),
      listen: (l) => (listeners.add(l), () => void listeners.delete(l))
    },
    close: () => context.close()
  };
}

async function shoot(path: string, width: number, opts: { timeoutMs?: number; fontMs?: number } = {}) {
  const { cdp, close } = await session();
  try {
    return await shootReviewPage(cdp, new URL(path, server).href, width, opts);
  } finally {
    await close();
  }
}

/** The colour of the picture's pixel at (x, y). */
async function pixel(image: Buffer, x: number, y: number) {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

describe.skipIf(!browserInstalled)('a review page pictured in Chromium', () => {
  it('pictures the whole page at the width asked for, down to its last row', async () => {
    const shot = await shoot('./', 1440);
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    expect(shot.height).toBe(2600);
    expect(await sharp(shot.png).metadata()).toMatchObject({ width: 1440, height: 2600 });
    expect(await pixel(shot.png, 700, 2590)).toEqual([255, 0, 0]);
    expect(await pixel(shot.png, 700, 10)).toEqual([255, 255, 255]);
  });

  it('lays the page out at a phone width', async () => {
    const shot = await shoot('narrow/', 390);
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    // A page shorter than the screen is pictured as the screen shows it.
    expect(await sharp(shot.png).metadata()).toMatchObject({ width: 390, height: 900 });
    expect(await pixel(shot.png, 10, 10)).toEqual([0, 255, 0]);
  });

  it('waits for a web font that arrives', async () => {
    expect(await shoot('font/', 800)).toMatchObject({ ok: true });
  });

  it('loads a lazy image far below the first screen before the picture', async () => {
    const shot = await shoot('lazy/', 800);
    expect(shot.ok).toBe(true);
    if (shot.ok) expect(await pixel(shot.png, 20, 3020)).toEqual([0, 0, 255]);
  });

  it('marks a page whose font failed to load unavailable', async () => {
    const shot = await shoot('missing-font/', 800);
    expect(shot).toMatchObject({ ok: false });
    expect(!shot.ok && ['fonts', 'assets']).toContain(!shot.ok && shot.reason);
    expect(!shot.ok && shot.detail).toMatch(/gone\.woff2|Gone/);
  });

  it('marks only the width whose layout lost a background picture unavailable', async () => {
    const desktop = await shoot('phone/', 1440);
    expect(desktop.ok).toBe(true);
    // The picture is of the desktop layout, not of the one Chromium lays out for a moment while taking it.
    if (desktop.ok) expect(await pixel(desktop.png, 10, 10)).toEqual([255, 255, 255]);
    expect(await shoot('phone/', 390)).toMatchObject({ ok: false, reason: 'assets', detail: expect.stringContaining('/client/missing-hero.png (404)') });
  });

  it('marks a page with a picture that arrived but cannot be shown unavailable', async () => {
    expect(await shoot('broken/', 800)).toMatchObject({ ok: false, reason: 'assets', detail: expect.stringContaining('/client/corrupt.png') });
  });

  it('refuses a page the review server does not have', async () => {
    expect(await shoot('nowhere/', 800)).toMatchObject({ ok: false, reason: 'navigation' });
  });

  it('gives up on a page that never settles in time', async () => {
    // The font never arrives in the time given: its request is still under way, or it has failed; never a picture.
    const shot = await shoot('missing-font/', 800, { timeoutMs: 1, fontMs: 1 });
    expect(shot.ok).toBe(false);
  });
});
