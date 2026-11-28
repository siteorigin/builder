/**
 * One page of a built website opened as a visitor's browser opens it (#1534), to see whether it still shows its content
 * once its script has started. A code component can fail only in the browser (an `$effect` that writes the state it
 * reads never runs while the site is prerendered): SvelteKit then puts the site's error page in place of every section,
 * and nothing in the build says so. The page is opened, SvelteKit says it has started, and the page is watched until
 * its scripts have been quiet a moment: it failed when the site's error page has taken the place of what was built.
 *
 * It speaks to the page through the Chrome DevTools Protocol only (a session on one page), so the app's hidden window
 * (main/page-check-window) and a test's headless Chromium run exactly the same steps.
 */
import { ERROR_SECTION_CLASS } from '@generator/index';
import type { CdpPage } from './review-shot';

export type PageCheck =
  /** The page still shows what was built once it has started. */
  | { status: 'working' }
  /**
   * The site's error page took the place of the page's content: its heading ("Error 500"), the error the browser was
   * told of last before it appeared (null when none was), and the errors it was told of, in order.
   */
  | { status: 'error-page'; heading: string; cause: string | null; logged: string[] }
  /** The page could not be opened, or did not start in time: nothing is known of it. */
  | { status: 'unchecked'; detail: string };

export interface PageCheckOptions {
  /** Ends the check under way (the project closed). */
  signal?: AbortSignal;
  /** How long the whole check may take. */
  timeoutMs?: number;
}

const CHECK_MS = 8000;
/**
 * How long a page that has started is watched, with no script on its way, before it is taken as working: a script it
 * asks for meanwhile starts the wait again, and SvelteKit shows its error page only once its error hook has answered.
 */
const SETTLE_MS = 150;
/** What SvelteKit's start script in a built page names its globals by: a page without it runs no script of SvelteKit's. */
const SVELTEKIT_START = '__sveltekit_';
/** How many errors a check keeps (the latest), and how much of each. */
const LOGGED = 20;
const LOGGED_CHARS = 2000;
/** Run before the page's own scripts: a page that asks to be printed opens no print dialog from the hidden window. */
const NO_PRINT = 'window.print = () => {};';

/**
 * The site's error page (the generated +error.svelte) in place of a page's content: the layout's main element holds
 * its section, with its "Error 500" heading, and nothing else. Its heading when it shows, or ''.
 */
const errorShown = (root: string) => `(() => {
  const main = ${root}.querySelector('main#main');
  const only = main && main.children.length === 1 ? main.firstElementChild : null;
  const heading = only && only.matches('section.${ERROR_SECTION_CLASS}') ? (only.querySelector('h1')?.textContent ?? '').trim() : '';
  return /^Error \\d{3}$/.test(heading) ? heading : '';
})()`;

/** Run in the page: the error page's heading when it shows, whether its main element is empty, and whether SvelteKit says it has started. */
const LOOK = `(() => ({
  error: ${errorShown('document')},
  empty: document.querySelector('main#main')?.children.length === 0,
  started: !!document.getElementById('svelte-announcer')
}))()`;

/** Run in the page: what the HTML the server sent showed before any script ran. */
const BUILT = (html: string) => `(() => {
  const built = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html');
  return { error: ${errorShown('built')}, content: (built.querySelector('main#main')?.children.length ?? 0) > 0 };
})()`;

class Unchecked extends Error {}

/** What the DevTools Protocol says of a value the page logged or threw: its description, as the console prints it. */
function described(arg: unknown): string {
  if (!arg || typeof arg !== 'object') return String(arg);
  const a = arg as { description?: unknown; value?: unknown; unserializableValue?: unknown; type?: unknown };
  if (typeof a.description === 'string') return a.description;
  if (typeof a.value === 'string') return a.value;
  if (a.value !== undefined) return JSON.stringify(a.value);
  if (typeof a.unserializableValue === 'string') return a.unserializableValue;
  return String(a.type ?? '');
}

/** Open the page at `url` through the DevTools session `page` and say whether it still shows what was built once started. */
export async function checkBuiltPage(page: CdpPage, url: string, opts: PageCheckOptions = {}): Promise<PageCheck> {
  /** The scripts on their way, by request ID. */
  const pending = new Set<string>();
  /** The latest errors the page logged or threw, with when. */
  const logged: Array<{ at: number; text: string }> = [];
  let lastScript = 0;
  let mainFrame = '';
  let document: { requestId: string; status: number; url: string } | null = null;
  let documentFailed: string | null = null;
  let documentLoaded = false;
  let wake: (() => void) | null = null;
  const tell = (text: string) => {
    if (logged.length >= LOGGED) logged.shift();
    logged.push({ at: Date.now(), text: text.slice(0, LOGGED_CHARS) });
  };

  const stopListening = page.listen((method, p) => {
    const id = String(p.requestId);
    switch (method) {
      case 'Network.requestWillBeSent':
        if (p.type !== 'Script') return;
        pending.add(id);
        lastScript = Date.now();
        break;
      case 'Network.responseReceived': {
        const response = p.response as { status: number; url: string };
        if (p.type === 'Document' && p.frameId === mainFrame && !document) document = { requestId: id, status: response.status, url: response.url };
        break;
      }
      case 'Network.loadingFinished':
        if (document?.requestId === id) documentLoaded = true;
        if (pending.delete(id)) lastScript = Date.now();
        break;
      case 'Network.loadingFailed':
        if (p.type === 'Document' && !document) documentFailed = String(p.errorText ?? 'failed');
        if (pending.delete(id)) lastScript = Date.now();
        break;
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'assert') tell(((p.args as unknown[] | undefined) ?? []).map(described).join(' '));
        return;
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails as { text?: string; exception?: unknown } | undefined;
        tell(d?.exception ? described(d.exception) : String(d?.text ?? 'Uncaught error'));
        return;
      }
      default:
        return;
    }
    wake?.();
  });

  const deadline = Date.now() + (opts.timeoutMs ?? CHECK_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const ended = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Unchecked('The page did not finish starting in time.')), Math.max(0, deadline - Date.now()));
    onAbort = () => reject(new Unchecked('The check was stopped.'));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  ended.catch(() => undefined);
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, ended]);
  /** Wait until `ready` holds, looking again on every event of the page and every 50 ms, one look at a time. */
  const until = async (ready: () => boolean | Promise<boolean>) => {
    let tick: ReturnType<typeof setInterval> | undefined;
    let looking = false;
    try {
      await race(
        new Promise<void>((resolve, reject) => {
          const look = () => {
            if (looking) return;
            looking = true;
            Promise.resolve()
              .then(ready)
              .then((yes) => {
                looking = false;
                if (yes) resolve();
              }, reject);
          };
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
    const r = (await race(page.send('Runtime.evaluate', { expression, returnByValue: true }))) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Unchecked(`The page could not be read: ${r.exceptionDetails.text ?? 'it threw an error'}.`);
    return r.result?.value as T;
  };

  try {
    await race(page.send('Page.enable'));
    await race(page.send('Runtime.enable'));
    await race(page.send('Network.enable'));
    await race(page.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_PRINT }));
    const tree = (await race(page.send('Page.getFrameTree'))) as { frameTree: { frame: { id: string } } };
    mainFrame = tree.frameTree.frame.id;
    const nav = (await race(page.send('Page.navigate', { url }))) as { errorText?: string };
    if (nav.errorText) throw new Unchecked(`The page could not be opened (${nav.errorText}).`);
    // The page itself, not what it shows: an image still on its way (a slow host's) holds up nothing.
    await until(() => documentLoaded || !!documentFailed);
    if (documentFailed) throw new Unchecked(`The page could not be opened (${documentFailed}).`);
    const doc = document as { requestId: string; status: number; url: string } | null;
    if (!doc || doc.status < 200 || doc.status >= 300) throw new Unchecked(`The website’s preview answered ${doc ? doc.status : 'nothing'} for this page.`);
    if (doc.url !== url) throw new Unchecked('The page led to another address.');
    const body = (await race(page.send('Network.getResponseBody', { requestId: doc.requestId }))) as { body: string; base64Encoded: boolean };
    const html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
    // A page built without SvelteKit's script (a project's own `csr = false`) never starts: nothing of it runs to fail.
    if (!html.includes(SVELTEKIT_START)) return { status: 'working' };
    const built = await evaluate<{ error: string; content: boolean }>(BUILT(html));
    // A page whose own content is the error page, as it was built, cannot be told from one that failed.
    if (built.error) return { status: 'working' };
    let seen = null as { heading: string; at: number } | null;
    let startedAt = 0;
    await until(async () => {
      const now = await evaluate<{ error: string; empty: boolean; started: boolean }>(LOOK);
      if (now.error) {
        seen = { heading: now.error, at: Date.now() };
        return true;
      }
      if (!now.started) return false;
      startedAt ||= Date.now();
      // SvelteKit takes away what failed before an awaited error hook answers: a page built with content that shows
      // none is failing still, until the error page comes or the check runs out of time.
      if (built.content && now.empty) return false;
      return pending.size === 0 && Date.now() - Math.max(startedAt, lastScript) >= SETTLE_MS;
    });
    if (!seen) return { status: 'working' };
    const { heading, at } = seen as { heading: string; at: number };
    const before = logged.filter((l) => l.at <= at);
    return { status: 'error-page', heading, cause: before.length ? before[before.length - 1].text : null, logged: logged.map((l) => l.text) };
  } catch (e) {
    if (e instanceof Unchecked) return { status: 'unchecked', detail: e.message };
    return { status: 'unchecked', detail: `The page could not be checked: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    wake = null;
    stopListening();
  }
}
