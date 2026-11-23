/**
 * A Foundation page printed as a handout, in real headless browsers. The generated layout and contact page (contact
 * details, FAQ, pricing and a contact form) are compiled for the client and mounted with the theme CSS exactly as an
 * exported site ships it. Chromium prints it to an A4 PDF, as its print dialog does, and the test reads the text on
 * each sheet. WebKit, which cannot print to PDF here, is checked under print media instead.
 */
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceNode, ListItem } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject, pageFile } from '@generator/index';
import { pdfPages, squash } from './pdf-text';

const ORIGIN = 'https://site.test';
const ENGINES = ([['chromium', chromium], ['webkit', webkit]] as Array<[string, BrowserType]>).filter(([, engine]) => existsSync(engine.executablePath()));
const CAN_PRINT = ENGINES.some(([name]) => name === 'chromium');

const QUESTIONS = [
  ['How long does a typical project take?', 'Most design projects take six to ten weeks from the first meeting to final drawings. We agree a schedule with you at the start.'],
  ['Do you work outside the local area?', 'Yes. We regularly work across the region and can arrange remote consultations for early planning.'],
  ['How are your fees calculated?', 'We quote a fixed fee for each stage once we understand the scope, so you always know the cost before work begins.'],
  ['Can you recommend builders?', 'We work with a small group of trusted contractors and are happy to introduce them, or to work with your own builder.']
] as const;
const PLANS = [
  { name: 'Consultation', description: 'A focused session to explore ideas and priorities.', features: ['Two-hour site visit', 'Written summary', 'Budget guidance'], action: 'Book a session' },
  { name: 'Design', description: 'A complete design package ready for builders to quote.', features: ['Concept and detailed design', 'Materials and finishes', 'Drawings for tender', 'Three review meetings'], action: 'Start a project' },
  { name: 'Full service', description: 'Design plus coordination through to handover.', features: ['Everything in Design', 'Contractor coordination', 'Weekly site reports'], action: 'Talk to us' }
];
const FORM_HEADING = 'Send us a message';
const FIELDS = ['Your full name', 'Your email address', 'Best phone number', 'How can we help?'];
const SUBMIT = 'Send the enquiry';
const CONTACT_VALUES = ['hello@example.com', '+1 555 0134', '12 Harbour Lane, Millbrook', 'Monday to Friday, 9am – 5pm'];
/** Each section heading, with the first thing it introduces. */
const HEADINGS: Array<[string, string]> = [
  ['Frequently asked questions', QUESTIONS[0][0]],
  ['Clear packages, no surprises', PLANS[0].description],
  [FORM_HEADING, FIELDS[0]]
];

/** The exported contact page: contact details and the FAQ from the starter, then pricing and a contact form. */
function exportedSite() {
  const s = createStarterState('business', 'Test Studio', false);
  const contact = s.pages[s.site.pageOrder[2]];
  if (contact.route !== '/contact/') throw new Error(`Expected the starter's contact page, got ${contact.route}`);
  const add = (componentId: string, props: Record<string, unknown>) => {
    const node: InstanceNode = makeInstance(s.components[installComponent(s, componentId)], props);
    contact.nodes[node.id] = node;
    contact.rootIds.push(node.id);
    return node;
  };
  const pricing = add('pricing.plans', {});
  // Each plan's action goes somewhere, so it is shown (a button without a destination is left out).
  pricing.props.plans = (pricing.props.plans as ListItem[]).map((plan) => ({ ...plan, actionLink: { type: 'email', target: 'hello@example.com' } }));
  add('contact.form', {
    provider: 'netlify',
    submitLabel: SUBMIT,
    fields: FIELDS.map((label, i) => ({ id: `f${i}`, label, name: '', type: i === 3 ? 'textarea' : 'text', required: i < 2, placeholder: '' }))
  });
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  return { files, css, pageFile: pageFile(contact) };
}

/** The layout and contact page as one script that defines `window.mountSite()`. */
async function bundleSite(files: Map<string, string>, page: string): Promise<string> {
  const src = new Map<string, string>();
  for (const [path, text] of files) src.set(`\0site/${path}`, text);
  src.set('\0site/Entry.svelte', `<script>import Layout from './src/routes/+layout.svelte'; import Page from './${page}';</script><Layout><Page /></Layout>`);
  const entry = [
    "import { flushSync, mount } from 'svelte';",
    "import Entry from '\0site/Entry.svelte';",
    "window.mountSite = () => { mount(Entry, { target: document.getElementById('app') }); flushSync(); };"
  ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'exported-site',
        resolveId(id, importer) {
          if (id === '\0entry') return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          // Stylesheets are inlined in the page; fonts fall back to the system stack.
          if (id.startsWith('@fontsource') || id.endsWith('.css')) return '\0empty';
          if (importer?.startsWith('\0site/') && id.startsWith('.')) {
            const path = `\0${posix.join(posix.dirname(importer.slice(1)), id)}`;
            if (src.has(path)) return path;
          }
          return src.has(id) ? id : null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0empty') return '';
          if (id === '\0$app/paths') return 'export const base = ""; export const resolve = (p) => p; export const asset = (p) => "/" + p;';
          if (id === '\0$app/state') return 'export const page = { route: { id: "/contact" }, url: new URL("https://site.test/contact/") };';
          if (id === '\0$app/navigation') return 'export function afterNavigate() {} export function beforeNavigate() {} export function snapshot() {}';
          const text = src.get(id);
          if (text === undefined) return null;
          return id.endsWith('.svelte') ? compile(text, { filename: id.slice(1), generate: 'client', css: 'injected' }).js.code : text;
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The exported site did not bundle');
  return chunk.code;
}

const site = exportedSite();
let script: Promise<string> | undefined;
const bundled = () => (script ??= bundleSite(site.files, site.pageFile));

/** Opens the mounted contact page with these FAQ questions (by position) opened as a visitor opens them. */
async function openSite(browser: Browser, open: number[]): Promise<Page> {
  const code = await bundled();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    if (new URL(route.request().url()).pathname === '/site.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: code });
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${site.css}</style></head><body><div id="app" style="display: contents"></div><script src="/site.js"></script><script>mountSite()</script></body></html>`
    });
  });
  await page.goto(`${ORIGIN}/contact/`);
  await page.waitForSelector('details summary');
  for (const i of open) await page.locator('details > summary').nth(i).click();
  return page;
}

const openStates = (page: Page) => page.evaluate<boolean[]>("[...document.querySelectorAll('details')].map((d) => d.open)");
const expected = (open: number[]) => QUESTIONS.map((_, i) => open.includes(i));

/** Prints the page as Chrome's A4 print does (its default 0.4 inch margins), and returns each sheet's text. */
async function print(page: Page): Promise<string[]> {
  const pdf = await page.pdf({ format: 'A4', margin: { top: '0.4in', right: '0.4in', bottom: '0.4in', left: '0.4in' } });
  return pdfPages(pdf);
}

/** The sheets (by number) whose text holds this phrase, ignoring how it wrapped. */
const sheetsWith = (sheets: string[], phrase: string) => sheets.flatMap((text, i) => (squash(text).includes(squash(phrase)) ? [i] : []));

if (!CAN_PRINT) describe.skip('printing a Foundation page (needs Chromium)', () => it('prints in a browser', () => {}));

describe.runIf(CAN_PRINT)('printing a Foundation page as a handout in chromium', () => {
  let browser: Browser;

  beforeAll(async () => {
    const [code, launched] = await Promise.allSettled([bundled(), chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 30_000 })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (code.status === 'rejected') throw code.reason;
    if (launched.status === 'rejected') throw launched.reason;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    ['every question closed', []],
    ['only the first question open', [0]],
    ['every question open', [0, 1, 2, 3]]
  ] as Array<[string, number[]]>)('prints every FAQ answer with %s, and leaves the questions as the visitor left them', async (_label, open) => {
    const page = await openSite(browser, open);
    try {
      expect(await openStates(page)).toEqual(expected(open));
      const sheets = await print(page);
      for (const [question, answer] of QUESTIONS) {
        expect(sheetsWith(sheets, question), question).toHaveLength(1);
        expect(sheetsWith(sheets, answer), answer).toEqual(sheetsWith(sheets, question));
      }
      // Printing (and so closing the print dialog, printed or cancelled) changes no question's open state.
      expect(await openStates(page)).toEqual(expected(open));
      // Nor does the print preview switching to print media and back.
      await page.emulateMedia({ media: 'print' });
      await page.emulateMedia({ media: 'screen' });
      expect(await openStates(page)).toEqual(expected(open));
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('keeps the contact details and leaves out controls that only work on screen', async () => {
    const page = await openSite(browser, []);
    try {
      const text = squash((await print(page)).join('\n'));
      for (const value of CONTACT_VALUES) expect(text, value).toContain(squash(value));
      for (const field of FIELDS) expect(text, field).toContain(squash(field));
      for (const plan of PLANS) expect(text, plan.action).toContain(squash(plan.action));
      for (const control of [SUBMIT, 'Open menu', 'Skip to content', 'This form is not connected to a form service yet']) expect(text, control).not.toContain(squash(control));
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('keeps each plan, the contact form and each heading on one sheet wherever the page breaks fall', async () => {
    const page = await openSite(browser, []);
    try {
      // Pushes the content down in steps, so a sheet boundary crosses each plan, the form and each heading in turn.
      for (let shift = 0; shift < 1040; shift += 80) {
        await page.evaluate(`(() => {
          let spacer = document.getElementById('print-shift');
          if (!spacer) { spacer = document.createElement('div'); spacer.id = 'print-shift'; document.querySelector('main').prepend(spacer); }
          spacer.style.height = '${shift}px';
        })()`);
        const sheets = await print(page);
        for (const plan of PLANS) {
          const parts = [plan.description, ...plan.features, plan.action];
          const where = parts.map((part) => sheetsWith(sheets, part));
          expect(where, `${plan.name} shifted ${shift}px`).toEqual(parts.map(() => where[0]));
          expect(where[0], `${plan.name} shifted ${shift}px`).toHaveLength(1);
        }
        const form = [FORM_HEADING, ...FIELDS].map((part) => sheetsWith(sheets, part));
        expect(form, `the form shifted ${shift}px`).toEqual(form.map(() => form[0]));
        expect(form[0], `the form shifted ${shift}px`).toHaveLength(1);
        for (const [question, answer] of QUESTIONS) expect(sheetsWith(sheets, answer), `${question} shifted ${shift}px`).toEqual(sheetsWith(sheets, question));
        for (const [heading, first] of HEADINGS) expect(sheetsWith(sheets, first), `${heading} shifted ${shift}px`).toEqual(sheetsWith(sheets, heading));
      }
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe.each(ENGINES.filter(([name]) => name === 'webkit'))('printing a Foundation page in %s', (_name, engine) => {
  let browser: Browser;

  beforeAll(async () => {
    const [code, launched] = await Promise.allSettled([bundled(), engine.launch({ headless: true, executablePath: engine.executablePath(), timeout: 30_000 })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (code.status === 'rejected') throw code.reason;
    if (launched.status === 'rejected') throw launched.reason;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('shows every FAQ answer under print media with only the first question open, and keeps that state', async () => {
    const page = await openSite(browser, [0]);
    try {
      const visible = () => page.evaluate<boolean[]>("[...document.querySelectorAll('details > p')].map((p) => p.checkVisibility() && p.getBoundingClientRect().height > 0)");
      expect(await visible()).toEqual(expected([0]));
      await page.emulateMedia({ media: 'print' });
      expect(await visible()).toEqual(QUESTIONS.map(() => true));
      await page.emulateMedia({ media: 'screen' });
      expect(await visible()).toEqual(expected([0]));
      expect(await openStates(page)).toEqual(expected([0]));
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
