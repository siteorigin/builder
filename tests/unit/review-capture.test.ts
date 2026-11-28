/**
 * The app's window for review edition pictures (src/main/review-capture.ts, #1133), with Electron stood in for: each
 * picture gets a window of its own that is never shown or focused and is destroyed after it, whose page opens nothing,
 * whose stored state is cleared first, and whose DevTools session is opened only once the window has a page (a window
 * that has loaded nothing never answers it, so every picture would time out). The stand-in session answers as a page
 * does, so a picture is taken only when the window's events reach the capture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ windows: [] as FakeWindow[], steps: [] as string[], cleared: 0, clearing: 0, overlapped: false, clearMs: 5, requests: [] as Array<(details: { resourceType: string; url: string }, done: (r: { cancel: boolean }) => void) => void> }));

interface FakeWindow {
  options: Record<string, unknown>;
  destroyed: boolean;
  openHandler?: () => unknown;
}

type Listener = (e: unknown, method: string, params: Record<string, unknown>) => void;

/** A PNG header for a picture `width` × `height`. */
function png(width: number, height: number): string {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}

vi.mock('electron', () => {
  class BrowserWindow implements FakeWindow {
    destroyed = false;
    openHandler?: () => unknown;
    private attached = false;
    private blank = false;
    private width = 0;
    private messages = new Set<Listener>();
    webContents = {
      setAudioMuted: () => undefined,
      on: () => undefined,
      once: () => undefined,
      setWindowOpenHandler: (h: () => unknown) => void (this.openHandler = h),
      // The blank page arrives a moment later, as a real window's does.
      loadURL: (url: string) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            env.steps.push(`load ${url}`);
            this.blank = true;
            resolve();
          }, 5)
        ),
      debugger: {
        attach: () => {
          env.steps.push('attach');
          this.attached = true;
        },
        isAttached: () => this.attached,
        detach: () => {
          env.steps.push('detach');
          this.attached = false;
        },
        on: (event: string, l: Listener) => void (event === 'message' && this.messages.add(l)),
        removeListener: (_: string, l: Listener) => void this.messages.delete(l),
        sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
          if (!this.blank) throw new Error('no page');
          env.steps.push(method);
          const emit = (m: string, p: Record<string, unknown>) => setTimeout(() => this.messages.forEach((l) => l({}, m, p)), 1);
          switch (method) {
            case 'Emulation.setDeviceMetricsOverride':
              this.width = params.width as number;
              return {};
            case 'Page.getFrameTree':
              return { frameTree: { frame: { id: 'main' } } };
            case 'Page.navigate': {
              const url = params.url as string;
              if (url.includes('/fail/')) return { errorText: 'net::ERR_ABORTED' };
              emit('Network.responseReceived', { requestId: 'doc', type: 'Document', frameId: 'main', response: { status: 200, url } });
              emit('Page.loadEventFired', {});
              return { frameId: 'main' };
            }
            case 'Runtime.evaluate':
              return { result: { value: String(params.expression).includes('backgrounds') ? { broken: [], fontErrors: [], fonts: 'loaded' } : true } };
            case 'Page.getLayoutMetrics':
              return { cssContentSize: { height: 50 }, contentSize: { height: 50 } };
            case 'Page.captureScreenshot':
              return { data: png(this.width, 50) };
            default:
              return {};
          }
        }
      }
    };
    constructor(readonly options: Record<string, unknown>) {
      env.windows.push(this);
    }
    isDestroyed = () => this.destroyed;
    destroy = () => {
      env.steps.push('destroy');
      this.destroyed = true;
    };
  }
  const ses = { setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined, on: () => undefined, webRequest: { onBeforeRequest: (l: (typeof env.requests)[number]) => void env.requests.push(l) }, clearStorageData: () => {
      if (env.clearing) env.overlapped = true;
      env.clearing++;
      return new Promise<void>((r) => setTimeout(() => (env.clearing--, env.cleared++, r()), env.clearMs));
    }
  };
  return { BrowserWindow, session: { fromPartition: () => ses } };
});

const { createReviewShooter } = await import('../../src/main/review-capture');

beforeEach(() => {
  env.windows.length = 0;
  env.steps.length = 0;
  env.cleared = 0;
  env.clearing = 0;
  env.overlapped = false;
  env.clearMs = 5;
});

describe('the review capture window', () => {
  it('pictures the page in a hidden, unfocusable window of its own, given a page before it is spoken to, and destroys it after', async () => {
    const shooter = createReviewShooter();
    const r = await shooter.shoot('http://127.0.0.1:1/about/', 390);
    expect(r).toMatchObject({ ok: true, height: 50 });
    expect(env.windows).toHaveLength(1);
    const [w] = env.windows;
    expect(w.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, width: 390, paintWhenInitiallyHidden: true });
    expect(w.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true, backgroundThrottling: false });
    expect(w.openHandler?.()).toEqual({ action: 'deny' });
    expect(env.steps.slice(0, 3)).toEqual(['load about:blank', 'attach', 'Page.enable']);
    expect(env.steps).toContain('Page.captureScreenshot');
    expect(env.steps.slice(-2)).toEqual(['detach', 'destroy']);
    expect(env.cleared).toBe(1);
    // Picturing the published website is never a visit to its analytics: Fathom's script and beacons are left out (#1485).
    const answer = (resourceType: string, url: string) => new Promise<boolean>((r) => env.requests.at(-1)!({ resourceType, url }, ({ cancel }) => r(cancel)));
    expect(await answer('script', 'https://cdn.usefathom.com/script.js')).toBe(true);
    expect(await answer('ping', 'https://www.google-analytics.com/g/collect')).toBe(true);
    expect(await answer('script', 'https://cdn.example/widget.js')).toBe(false);
    expect(await answer('stylesheet', 'http://127.0.0.1:1/_app/immutable/assets/0.css')).toBe(false);
    // The next picture starts in a window of its own, as a first visit.
    expect(await shooter.shoot('http://127.0.0.1:1/fail/', 1440)).toMatchObject({ ok: false, reason: 'navigation' });
    expect(env.windows).toHaveLength(2);
    expect(env.windows[0].destroyed && env.windows[1].destroyed).toBe(true);
    expect(env.cleared).toBe(2);
  });

  it('takes no picture once the capture is called off', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await createReviewShooter().shoot('http://127.0.0.1:1/', 1440, stop.signal)).toMatchObject({ ok: false, reason: 'failed' });
    expect(env.windows).toHaveLength(0);
  });

  it('opens no window for a picture whose windows were disposed of while its stored state was cleared', async () => {
    const shooter = createReviewShooter();
    const shooting = shooter.shoot('http://127.0.0.1:1/', 1440);
    shooter.dispose();
    expect(await shooting).toMatchObject({ ok: false, reason: 'failed', detail: 'The capture was stopped.' });
    expect(env.windows).toHaveLength(0);
  });

  it('starts the next picture’s clear of stored state only once a called-off one has finished', async () => {
    env.clearMs = 50;
    const shooter = createReviewShooter();
    const first = shooter.shoot('http://127.0.0.1:1/', 1440);
    shooter.dispose();
    const next = shooter.shoot('http://127.0.0.1:1/', 390);
    expect(await first).toMatchObject({ ok: false });
    expect(await next).toMatchObject({ ok: true });
    expect(env.cleared).toBe(2);
    expect(env.overlapped).toBe(false);
  });

  it('ends a picture under way when the capture is called off, and destroys its window', async () => {
    const stop = new AbortController();
    const shooting = createReviewShooter().shoot('http://127.0.0.1:1/', 1440, stop.signal);
    // Once the window is there, on its way to its blank page.
    await vi.waitFor(() => expect(env.windows).toHaveLength(1));
    stop.abort();
    expect(await shooting).toMatchObject({ ok: false, reason: 'failed', detail: 'The capture was stopped.' });
    expect(env.windows[0].destroyed).toBe(true);
    expect(env.steps).not.toContain('Page.captureScreenshot');
  });
});
