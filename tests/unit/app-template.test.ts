import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepPageThroughAppTemplate, templateBesidesLanguage } from '@runtime/app-template';

const TEMPLATE = (lang: string, dir: string, head = '') => `<!doctype html>\n<html lang="${lang}" dir="${dir}">\n\t<head>${head}\n\t\t%sveltekit.head%\n\t</head>\n\t<body>%sveltekit.body%</body>\n</html>\n`;
const WHOLE = { type: 'full-reload' };

let root: string;
let file: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'so-app-template-')));
  mkdirSync(join(root, 'src'));
  file = join(root, 'src', 'app.html');
  writeFileSync(file, TEMPLATE('en', 'ltr'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * A dev server as SvelteKit's dev plugin uses it: a change to the app template is answered at once with a reload of
 * every page (no path), and Vite's own answer for an HTML file names it.
 */
function devServer(templates: string[]) {
  const watcher = new EventEmitter();
  const sent: unknown[] = [];
  const hot = { send: (payload: unknown) => void sent.push(payload) };
  const server = { watcher, ws: hot, environments: { client: { hot } } };
  keepPageThroughAppTemplate(server, templates);
  watcher.on('change', (path: string) => {
    if (path.endsWith('app.html')) server.ws.send(WHOLE);
  });
  const change = (path: string, text?: string) => {
    if (text !== undefined) writeFileSync(file, text);
    watcher.emit('change', path);
    server.environments.client.hot.send({ type: 'full-reload', path: '/src/app.html' });
  };
  return { sent, change, send: (p: unknown) => server.ws.send(p) };
}

describe('the canvas through a change to src/app.html (#1335)', () => {
  it('keeps the page when the template names only another language or direction', () => {
    const { sent, change } = devServer([file]);
    change(file, TEMPLATE('en', 'rtl'));
    change(file, TEMPLATE('ar', 'rtl'));
    // Vite's own answer names the file, which no page is: it reloads nothing.
    expect(sent).toEqual([
      { type: 'full-reload', path: '/src/app.html' },
      { type: 'full-reload', path: '/src/app.html' }
    ]);
  });

  it('reloads the page for any other change to the template, and for anything else', () => {
    const { sent, change, send } = devServer([file]);
    change(file, TEMPLATE('en', 'ltr', '\n\t\t<meta name="robots" content="noindex" />'));
    expect(sent).toContainEqual(WHOLE);
    sent.length = 0;
    // A value that merely mentions lang= is not the language.
    writeFileSync(file, TEMPLATE('en', 'ltr').replace('<html', '<html data-note="sample lang=one"'));
    change(file);
    sent.length = 0;
    change(file, TEMPLATE('en', 'ltr').replace('<html', '<html data-note="sample lang=two"'));
    expect(sent).toContainEqual(WHOLE);
    sent.length = 0;
    send(WHOLE);
    expect(sent).toEqual([WHOLE]);
  });

  it('knows the template by either of its names, with one record of it', () => {
    const link = join(realpathSync(tmpdir()), `so-app-template-link-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(root, link);
    try {
      const { sent, change } = devServer([join(link, 'src', 'app.html'), file]);
      change(join(link, 'src', 'app.html'), TEMPLATE('en', 'ltr', '\n\t\t<meta name="robots" content="noindex" />'));
      expect(sent).toContainEqual(WHOLE);
      sent.length = 0;
      // Put back under the other name: that is a change too, not a repeat of what was last seen.
      change(file, TEMPLATE('en', 'ltr'));
      expect(sent).toContainEqual(WHOLE);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('reads only the opening tag’s own language and direction', () => {
    expect(templateBesidesLanguage(TEMPLATE('ar', 'rtl'))).toBe(templateBesidesLanguage(TEMPLATE('en', 'ltr')));
    expect(templateBesidesLanguage('<!doctype html>\n<html data-x="lang=a" lang=fr>')).toBe('<!doctype html>\n<html data-x="lang=a">');
  });
});
