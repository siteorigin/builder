/**
 * The app's windows for the website export's page checks (src/main/page-check-window.ts, #1534), with Electron stood in
 * for: each page is opened in a window of its own that is never shown or focused and is destroyed after it, whose page
 * opens nothing and prints nothing, in a session that no other check under way at the same time shares and that is
 * emptied before each page, so every page is a first visit. The stand-in DevTools session answers as a built page that
 * starts does, so a check reports a page working only when the window's events reach it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ windows: [] as Array<{ options: Record<string, unknown>; destroyed: boolean; openHandler?: () => unknown; steps: string[] }>, cleared: [] as string[], clearFails: false }));

type Listener = (e: unknown, method: string, params: Record<string, unknown>) => void;

vi.mock('electron', () => {
  class BrowserWindow {
    destroyed = false;
    openHandler?: () => unknown;
    steps: string[] = [];
    private attached = false;
    private blank = false;
    private messages = new Set<Listener>();
    webContents = {
      setAudioMuted: () => undefined,
      on: () => undefined,
      once: () => undefined,
      setWindowOpenHandler: (h: () => unknown) => void (this.openHandler = h),
      loadURL: (url: string) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            this.steps.push(`load ${url}`);
            this.blank = true;
            resolve();
          }, 5)
        ),
      debugger: {
        attach: () => {
          this.steps.push('attach');
          this.attached = true;
        },
        isAttached: () => this.attached,
        detach: () => {
          this.steps.push('detach');
          this.attached = false;
        },
        on: (event: string, l: Listener) => void (event === 'message' && this.messages.add(l)),
        removeListener: (_: string, l: Listener) => void this.messages.delete(l),
        sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
          if (!this.blank) throw new Error('no page');
          this.steps.push(method);
          const emit = (m: string, p: Record<string, unknown>) => setTimeout(() => this.messages.forEach((l) => l({}, m, p)), 1);
          switch (method) {
            case 'Page.getFrameTree':
              return { frameTree: { frame: { id: 'main' } } };
            case 'Page.navigate':
              emit('Network.responseReceived', { requestId: 'doc', type: 'Document', frameId: 'main', response: { status: 200, url: params.url } });
              emit('Network.loadingFinished', { requestId: 'doc' });
              return { frameId: 'main' };
            case 'Network.getResponseBody':
              return { body: '<script>__sveltekit_x = {}</script><main id="main"><section>Built</section></main>', base64Encoded: false };
            case 'Runtime.evaluate':
              return { result: { value: String(params.expression).includes('DOMParser') ? { error: '', content: true } : { error: '', empty: false, started: true } } };
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
      this.steps.push('destroy');
      this.destroyed = true;
    };
  }
  const sessions = new Map<string, unknown>();
  const fromPartition = (name: string) => {
    if (!sessions.has(name))
      sessions.set(name, {
        name,
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        on: () => undefined,
        clearStorageData: () => (env.cleared.push(name), env.clearFails ? Promise.reject(new Error('locked')) : Promise.resolve())
      });
    return sessions.get(name);
  };
  return { BrowserWindow, session: { fromPartition } };
});

const { createPageChecker } = await import('../../src/main/page-check-window');

beforeEach(() => {
  env.windows.length = 0;
  env.cleared.length = 0;
  env.clearFails = false;
});

describe('the export’s page check windows', () => {
  it('opens each page in a hidden, unfocusable window of its own that prints nothing, and destroys it after', async () => {
    const checker = createPageChecker();
    expect(await checker.check('http://127.0.0.1:1/')).toEqual({ status: 'working' });
    expect(env.windows).toHaveLength(1);
    const [w] = env.windows;
    expect(w.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, paintWhenInitiallyHidden: true });
    expect(w.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true, backgroundThrottling: false });
    expect(w.openHandler?.()).toEqual({ action: 'deny' });
    expect(w.steps.slice(0, 2)).toEqual(['load about:blank', 'attach']);
    expect(w.steps.indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(w.steps.indexOf('Page.navigate'));
    expect(w.steps.slice(-2)).toEqual(['detach', 'destroy']);
  });

  it('gives checks under way at once sessions of their own, each emptied before its page, and uses them again after', async () => {
    const checker = createPageChecker();
    await Promise.all([checker.check('http://127.0.0.1:1/'), checker.check('http://127.0.0.1:1/about/')]);
    expect(new Set(env.cleared).size).toBe(2);
    await checker.check('http://127.0.0.1:1/contact/');
    expect(env.cleared).toHaveLength(3);
    expect(new Set(env.cleared).size).toBe(2);
    expect(env.windows.every((w) => w.destroyed)).toBe(true);
  });

  it('opens no window for a page whose session could not be emptied, nor for a check called off', async () => {
    env.clearFails = true;
    expect(await createPageChecker().check('http://127.0.0.1:1/')).toMatchObject({ status: 'unchecked', detail: expect.stringContaining('could not be cleared') });
    env.clearFails = false;
    const stop = new AbortController();
    stop.abort();
    expect(await createPageChecker().check('http://127.0.0.1:1/', stop.signal)).toEqual({ status: 'unchecked', detail: 'The check was stopped.' });
    expect(env.windows).toHaveLength(0);
  });
});
