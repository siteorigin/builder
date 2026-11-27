/**
 * The app's window for review edition pictures (src/main/review-capture.ts, #1133), with Electron stood in for: each
 * picture gets a window of its own that is never shown or focused and is destroyed after it, whose page opens nothing,
 * and whose DevTools session is opened only once the window has a page (a window that has loaded nothing never
 * answers it, so every picture would time out).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ windows: [] as FakeWindow[], steps: [] as string[] }));

interface FakeWindow {
  options: Record<string, unknown>;
  destroyed: boolean;
  openHandler?: () => unknown;
}

vi.mock('electron', () => {
  class BrowserWindow implements FakeWindow {
    destroyed = false;
    openHandler?: () => unknown;
    private attached = false;
    private listeners = new Set<(e: unknown, method: string, params: Record<string, unknown>) => void>();
    webContents = {
      setAudioMuted: () => undefined,
      on: () => undefined,
      setWindowOpenHandler: (h: () => unknown) => void (this.openHandler = h),
      loadURL: async (url: string) => void env.steps.push(`load ${url}`),
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
        on: (_: string, l: (e: unknown, method: string, params: Record<string, unknown>) => void) => void this.listeners.add(l),
        removeListener: (_: string, l: (e: unknown, method: string, params: Record<string, unknown>) => void) => void this.listeners.delete(l),
        sendCommand: async (method: string) => {
          if (!env.steps.includes('load about:blank')) throw new Error('no page');
          env.steps.push(method);
          // Fail at once: the window's part is what is tested, not the picture's steps.
          if (method === 'Page.navigate') return { errorText: 'net::ERR_ABORTED' };
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
          return {};
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
  const ses = { setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined, on: () => undefined };
  return { BrowserWindow, session: { fromPartition: () => ses } };
});

const { createReviewShooter } = await import('../../src/main/review-capture');

beforeEach(() => {
  env.windows.length = 0;
  env.steps.length = 0;
});

describe('the review capture window', () => {
  it('opens a hidden, unfocusable window per picture, gives it a page before speaking to it, and destroys it after', async () => {
    const shooter = createReviewShooter();
    const r = await shooter.shoot('http://127.0.0.1:1/about/', 390);
    expect(r).toMatchObject({ ok: false, reason: 'navigation' });
    expect(env.windows).toHaveLength(1);
    const [w] = env.windows;
    expect(w.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, width: 390, paintWhenInitiallyHidden: true });
    expect(w.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true, backgroundThrottling: false });
    expect(w.openHandler?.()).toEqual({ action: 'deny' });
    expect(env.steps.slice(0, 3)).toEqual(['load about:blank', 'attach', 'Page.enable']);
    expect(env.steps).toContain('Page.navigate');
    expect(env.steps.slice(-2)).toEqual(['detach', 'destroy']);
    // The next picture starts in a window of its own.
    await shooter.shoot('http://127.0.0.1:1/', 1440);
    expect(env.windows).toHaveLength(2);
    expect(env.windows[0].destroyed && env.windows[1].destroyed).toBe(true);
  });

  it('takes no picture once the capture is called off', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await createReviewShooter().shoot('http://127.0.0.1:1/', 1440, stop.signal)).toMatchObject({ ok: false, reason: 'failed' });
    expect(env.windows).toHaveLength(0);
  });
});
