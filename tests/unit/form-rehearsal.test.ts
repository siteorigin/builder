/**
 * Contact forms in the editor's preview (issue #193): the real preview bridge, the submission hold the instrumented
 * layout installs, and the contact form exactly as an export ships it, in a frame of a real headless browser, driven
 * the way the editor drives them. Every request the frame makes to the form service, and every POST to the site
 * itself, is captured and counted here, so nothing ever reaches a real service.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { defFile, generateProject } from '@generator/index';

const browserInstalled = existsSync(chromium.executablePath());
const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const SITE = 'http://site.test';
const SERVICE = 'https://forms.test';
const ENDPOINT = `${SERVICE}/f/abc123`;
const SESSION = 'so-test';
const FIELDS = [
  { id: 'f1', label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
  { id: 'f2', label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
  { id: 'f3', label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' }
];
const SENT = 'Thank you. Your message has been sent.';
const FAILED = 'Sorry, your message could not be sent. Please try again or contact us directly.';
const SENDING = 'Sending your message…';

/** A site with a contact form on its home page: its clean export and its instrumented preview. */
function site() {
  const s = createStarterState('business', 'Test Studio', false);
  const def = s.components[installComponent(s, 'contact.form')];
  const home = s.pages[s.site.homePageId];
  const node = makeInstance(def, { provider: 'endpoint', endpoint: ENDPOINT });
  home.nodes[node.id] = node;
  home.rootIds.push(node.id);
  return { files: generateProject(s), dev: generateProject(s, { instrument: true }), formFile: defFile(def) };
}

/** The exported contact form, compiled for the browser with Svelte's runtime; `window.mountForm(props)` places one. */
async function bundleForm(source: string): Promise<string> {
  const modules: Record<string, string> = {
    '\0entry': `import { flushSync, mount } from 'svelte'; import Form from '\0form';
window.mountForm = (props) => {
	mount(Form, { target: document.getElementById('app').appendChild(document.createElement('div')), props });
	flushSync();
};`,
    '\0form': compile(source, { filename: 'ContactForm.svelte', generate: 'client', css: 'injected', runes: true }).js.code
  };
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{ name: 'contact-form', resolveId: (id) => (id in modules ? id : null), load: (id) => modules[id] ?? null }],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The form did not bundle');
  return chunk.code;
}

/** The submission hold exactly as the instrumented layout installs it, before the page's own code runs. */
function holdFrom(layout: string): string {
  const hold = /\tif \(typeof window !== 'undefined' && !window\.__siteoriginBridge[\s\S]*?\n\t\}/.exec(layout)?.[0];
  if (!hold) throw new Error('The instrumented layout holds no submissions');
  return hold;
}

/**
 * The site's page in the editor's frame: the layout's hold, the form, then the bridge, in the order the preview
 * loads them (the bridge is imported once the page has mounted). `/held/` is the same page before its bridge loads.
 */
const framePage = (hold: string, withBridge: boolean) => `<!doctype html><html><head><meta charset="utf-8"><script>${hold}</script></head><body><main id="app"></main>
<script src="/form.js"></script>${withBridge ? '<script type="module" src="/bridge.js"></script>' : ''}</body></html>`;

/** The editor: it frames the page under the session's name and keeps every bridge message it receives. */
const hostPage = (path: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe name="${SESSION}" src="${path}" style="width:900px;height:900px;border:0"></iframe>
<script>
	window.received = [];
	window.addEventListener('message', (e) => window.received.push(e.data));
	window.toFrame = (type, payload) => document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: '${SESSION}', type, payload }, '*');
</script></body></html>`;

interface PreviewForm {
  id: string;
  label: string;
  place: string;
  service: string;
  destination: string;
  live: boolean;
}

describe('the instrumented layout', () => {
  it('holds submissions until the bridge runs, and only in the preview', () => {
    const { files, dev } = site();
    expect(holdFrom(dev.get('src/routes/+layout.svelte')!)).toContain("document.addEventListener('submit', window.__siteoriginHold, true)");
    for (const [path, content] of files) expect(content.includes('__siteorigin'), path).toBe(false);
  });
});

describe.skipIf(!browserInstalled)('contact forms in the preview (issue #193)', () => {
  let browser: Browser;
  let script: string;
  let hold: string;

  beforeAll(async () => {
    const { files, dev, formFile } = site();
    hold = holdFrom(dev.get('src/routes/+layout.svelte')!);
    const [bundled, launched] = await Promise.allSettled([bundleForm(files.get(formFile)!), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** A fresh editor with a contact form placed. The service answers every request it gets with `service.status`. */
  async function withPreview(body: (t: Awaited<ReturnType<typeof open>>) => Promise<void>, props: Record<string, unknown> = {}, path = '/contact/') {
    const context = await browser.newContext();
    try {
      await body(await open(await context.newPage(), props, path));
    } finally {
      await context.close();
    }
  }

  async function open(page: Page, props: Record<string, unknown>, path: string) {
    const service = { requests: [] as Array<{ method: string; url: string; body: string }>, status: 200 };
    const capture = (r: Request) => service.requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? '' });
    await page.route(`${SERVICE}/**`, async (route) => {
      capture(route.request());
      await route.fulfill({ status: service.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: service.status < 400 }) });
    });
    await page.route(`${SITE}/**`, (route) => {
      const request = route.request();
      // A POST to the site itself (Netlify Forms post to their own page) is a send too.
      if (request.method() !== 'GET') {
        capture(request);
        return route.fulfill({ status: 404, body: '' });
      }
      const at = new URL(request.url()).pathname;
      if (at === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (at === '/form.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (at === '/contact/' || at === '/held/') return route.fulfill({ contentType: 'text/html', body: framePage(hold, at === '/contact/') });
      return route.fulfill({ contentType: 'text/html', body: hostPage(path) });
    });
    // The host's load waits for its frame's.
    await page.goto(`${SITE}/`);
    const frame = page.frame({ name: SESSION });
    if (!frame) throw new Error('The editor has no preview frame');
    await frame.evaluate(`window.mountForm(${JSON.stringify({ heading: 'Send us a message', provider: 'endpoint', endpoint: ENDPOINT, fields: FIELDS, ...props })})`);
    const received = () => page.evaluate<Array<{ type: string; payload: Record<string, unknown> }>>('window.received');
    /** Payloads of one type the bridge has sent the editor, in order. */
    const sent = async (type: string) => (await received()).filter((m) => m.type === type).map((m) => m.payload);
    if (path === '/contact/') await expect.poll(async () => (await sent('ready')).length).toBe(1);
    const field = (label: string) => frame.locator('form.so-form__form').getByLabel(label);
    const form = {
      page,
      frame,
      service,
      field,
      sent,
      toFrame: (type: string, payload: Record<string, unknown> = {}) => page.evaluate(`window.toFrame(${JSON.stringify(type)}, ${JSON.stringify(payload)})`),
      button: frame.locator('.so-form__actions button'),
      status: () => frame.locator('.so-form__status[role="status"]').innerText(),
      alert: () => frame.locator('.so-form__status[role="alert"]').innerText(),
      values: () => Promise.all(['Name', 'Email', 'Message'].map((l) => field(l).inputValue())),
      fill: async (email = 'ada@example.com') => {
        await field('Name').fill('Ada');
        await field('Email').fill(email);
        await field('Message').fill('A rehearsal enquiry');
      },
      /** The forms the bridge last listed for the editor. */
      forms: async () => ((await sent('forms')).at(-1)?.forms ?? []) as PreviewForm[],
      /** The id of the form the editor would confirm a live test for, once the bridge has listed it. */
      formId: async () => {
        await expect.poll(async () => (await form.forms()).length).toBe(1);
        return (await form.forms())[0].id;
      },
      /** What the bridge has told the editor about sends, without ids. */
      results: async () => (await sent('formResult')).map(({ id: _id, requestId: _r, ...rest }) => rest),
      preview: async () => {
        await form.toFrame('mode', { mode: 'preview' });
        // Commands arrive in order: once this one is answered, Preview is on.
        await form.toFrame('measure', { requestId: 'mode', descs: [] });
        await expect.poll(async () => (await sent('measured')).length).toBeGreaterThan(0);
      }
    };
    return form;
  }

  it('sends nothing in Edit, however the form is submitted', async () => {
    await withPreview(async ({ frame, fill, field, service, status, values, results }) => {
      await fill();
      await field('Email').press('Enter');
      await frame.evaluate(`document.querySelector('form').requestSubmit()`);
      await frame.waitForTimeout(400);
      expect(service.requests).toHaveLength(0);
      expect(await status()).toBe('');
      expect(await values()).toEqual(['Ada', 'ada@example.com', 'A rehearsal enquiry']);
      expect(await results()).toEqual([]);
    });
  }, 30_000);

  it('lists the form with where it sends when published', async () => {
    await withPreview(async ({ forms }) => {
      await expect.poll(forms).toEqual([{ id: expect.any(String), label: 'Send us a message', place: 'page', service: 'endpoint', destination: ENDPOINT, live: true }]);
    });
  }, 30_000);

  it('practises a send in Preview: the form shows sending, then its sent message, and nothing is sent', async () => {
    await withPreview(async ({ fill, field, service, status, values, button, results, preview }) => {
      await preview();
      // The browser's own checks still run: a form with a required answer missing is never submitted.
      await field('Name').fill('Ada');
      await field('Email').press('Enter');
      await field('Email').fill('not an email');
      await field('Email').press('Enter');
      expect(await status()).toBe('');
      expect(await results()).toEqual([]);

      await fill();
      await field('Email').press('Enter');
      await expect.poll(status).toBe(SENDING);
      expect(await button.innerText()).toBe('Sending…');
      await expect.poll(results).toEqual([{ kind: 'practice', result: 'sending' }]);
      await expect.poll(status, { timeout: 5000 }).toBe(SENT);
      expect(await values()).toEqual(['', '', '']);
      await expect.poll(results).toEqual([
        { kind: 'practice', result: 'sending' },
        { kind: 'practice', result: 'success' }
      ]);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('practises a failed send when the author asks for one, keeping the answers', async () => {
    await withPreview(async ({ fill, field, service, status, alert, values, results, toFrame, preview }) => {
      await preview();
      await toFrame('formPractice', { result: 'error' });
      await fill();
      await field('Message').focus();
      await field('Email').press('Enter');
      await expect.poll(status).toBe(SENDING);
      await expect.poll(alert, { timeout: 5000 }).toBe(FAILED);
      expect(await values()).toEqual(['Ada', 'ada@example.com', 'A rehearsal enquiry']);
      await expect.poll(async () => (await results()).at(-1)).toEqual({ kind: 'practice', result: 'error' });
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('sends exactly one real message for a confirmed live test, and practises again after it', async () => {
    await withPreview(async ({ fill, field, service, status, values, results, toFrame, formId, preview }) => {
      await preview();
      await fill();
      service.status = 202;
      await toFrame('formLiveTest', { id: await formId(), requestId: 'live-1' });
      await expect.poll(() => service.requests.length).toBe(1);
      expect(service.requests[0]).toMatchObject({ method: 'POST', url: ENDPOINT });
      expect(service.requests[0].body).toContain('A rehearsal enquiry');
      await expect.poll(status).toBe(SENT);
      await expect.poll(results).toEqual([
        { kind: 'live', result: 'sending' },
        { kind: 'live', result: 'sent', status: 202 }
      ]);
      expect((await field('Name').inputValue())).toBe('');

      // The next ordinary send is a practice again.
      await fill();
      await field('Email').press('Enter');
      await expect.poll(results, { timeout: 5000 }).toHaveLength(4);
      expect((await results()).slice(2)).toEqual([
        { kind: 'practice', result: 'sending' },
        { kind: 'practice', result: 'success' }
      ]);
      expect(await values()).toEqual(['', '', '']);
      expect(service.requests).toHaveLength(1);
    });
  }, 30_000);

  it('reports what a live test got back when the service refuses it', async () => {
    await withPreview(async ({ fill, service, alert, results, toFrame, formId, preview }) => {
      await preview();
      await fill();
      service.status = 422;
      await toFrame('formLiveTest', { id: await formId(), requestId: 'live-1' });
      await expect.poll(alert).toBe(FAILED);
      await expect.poll(async () => (await results()).at(-1)).toEqual({ kind: 'live', result: 'refused', status: 422 });
      expect(service.requests).toHaveLength(1);
    });
  }, 30_000);

  it('sends nothing for a live test the form cannot pass, or one confirmed for settings that have changed', async () => {
    await withPreview(async ({ frame, fill, field, service, results, toFrame, forms, formId, preview }) => {
      // Not in Preview.
      await fill();
      await toFrame('formLiveTest', { id: await formId(), requestId: 'edit' });
      await expect.poll(results).toEqual([{ kind: 'live', result: 'unavailable' }]);

      await preview();
      await field('Email').fill('not an email');
      await toFrame('formLiveTest', { id: await formId(), requestId: 'invalid' });
      await expect.poll(results).toHaveLength(2);
      expect((await results())[1]).toEqual({ kind: 'live', result: 'invalid' });

      // The author confirmed the test for one destination; the form now sends somewhere else.
      const confirmed = await formId();
      await field('Email').fill('ada@example.com');
      await frame.evaluate(`document.querySelector('form').setAttribute('action', '${SERVICE}/f/other')`);
      await expect.poll(async () => (await forms())[0].id).not.toBe(confirmed);
      await toFrame('formLiveTest', { id: confirmed, requestId: 'stale' });
      await expect.poll(results).toHaveLength(3);
      expect((await results())[2]).toEqual({ kind: 'live', result: 'unavailable' });
      await frame.waitForTimeout(200);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('practises a Netlify form, which posts to its own page, and offers no live test', async () => {
    await withPreview(
      async ({ fill, field, service, status, forms, preview }) => {
        await expect.poll(forms).toEqual([{ id: expect.any(String), label: 'Send us a message', place: 'page', service: 'netlify', destination: '', live: false }]);
        await preview();
        await fill();
        await field('Email').press('Enter');
        await expect.poll(status, { timeout: 5000 }).toBe(SENT);
        expect(service.requests).toHaveLength(0);
      },
      { provider: 'netlify', formName: 'contact' }
    );
  }, 30_000);

  it('practises a form whose own code waits before it sends', async () => {
    await withPreview(async ({ frame, service, preview }) => {
      await preview();
      await frame.evaluate(`(() => {
        document.getElementById('app').insertAdjacentHTML('beforeend', '<form id="custom" method="post" action="${SERVICE}/f/custom"><input name="q" value="Hello"></form>');
        document.getElementById('custom').addEventListener('submit', async (e) => {
          e.preventDefault();
          await new Promise((r) => setTimeout(r, 300));
          const reply = await fetch('${SERVICE}/f/custom?source=contact', { method: 'POST', body: new FormData(e.target) });
          window.customStatus = reply.status;
        });
        document.getElementById('custom').requestSubmit();
      })()`);
      await expect.poll(() => frame.evaluate('window.customStatus'), { timeout: 5000 }).toBe(200);
      expect(service.requests).toHaveLength(0);
    });
  }, 30_000);

  it('leaves a request no form made alone', async () => {
    await withPreview(async ({ frame, service, results, preview }) => {
      await preview();
      expect(await frame.evaluate(`fetch('${SERVICE}/api/search', { method: 'POST', body: 'q=rooms' }).then((r) => r.status)`)).toBe(200);
      expect(service.requests).toMatchObject([{ method: 'POST', url: `${SERVICE}/api/search` }]);
      expect(await results()).toEqual([]);
    });
  }, 30_000);

  it('holds every submission while the page is loading, before the bridge runs', async () => {
    await withPreview(
      async ({ frame, fill, field, service, status }) => {
        await fill();
        await field('Email').press('Enter');
        await frame.evaluate(`document.querySelector('form').requestSubmit()`);
        await frame.waitForTimeout(400);
        expect(await status()).toBe('');
        expect(service.requests).toHaveLength(0);
      },
      {},
      '/held/'
    );
  }, 30_000);
});
