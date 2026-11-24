// Waits, outcome checks and evidence for the test driver (tests/driver/outcomes.ts, evidence.ts, issue #497): how each
// named condition judges what it sees, the independent readers of the project on disk and of exported files, the
// bounded journal and log, and how evidence names host paths.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST_PATH_LABEL, Journal, LogKeeper, clipJson, hideDeep, pathHider } from '../driver/evidence.ts';
import type { Area } from '../driver/desktop.ts';
import { DOC_LIMITS, EXPORT_LIMITS, inspectExport, judgeApp, judgeContext, judgeLocate, judgeTerminal, parseCondition, parseInspectArgs, readProjectDocs, toSessionPath } from '../driver/outcomes.ts';
import type { AppProbe, Checkpoint, Condition } from '../driver/outcomes.ts';
import { errorInfo } from '../driver/protocol.ts';
import { isReplayRecord } from '../driver/replay.ts';
import { Session } from '../driver/session.ts';
import type { UiContext } from '../driver/observe.ts';

const temps: string[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `driver-outcomes-${name}-`)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const refused = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return errorInfo(e);
  }
  throw new Error('accepted');
};

describe('conditions', () => {
  it('reads each named condition with its own parameters, and nothing else', () => {
    expect(parseCondition({ condition: 'preview.ready' })).toEqual({ condition: 'preview.ready' });
    expect(parseCondition({ condition: 'preview.ready', path: '/about/' })).toEqual({ condition: 'preview.ready', path: '/about/' });
    expect(parseCondition({ condition: 'save.settled' })).toEqual({ condition: 'save.settled', changed: true });
    expect(parseCondition({ condition: 'save.settled', changed: false })).toEqual({ condition: 'save.settled', changed: false });
    expect(parseCondition({ condition: 'project.revision', atLeast: 3 })).toEqual({ condition: 'project.revision', atLeast: 3 });
    expect(parseCondition({ condition: 'export.finished' })).toEqual({ condition: 'export.finished' });
    expect(parseCondition({ condition: 'outcome.terminal' })).toEqual({ condition: 'outcome.terminal', since: 'input' });
    expect(parseCondition({ condition: 'ui.context', dialog: null })).toEqual({ condition: 'ui.context', dialog: null });
    expect(parseCondition({ condition: 'ui.present', role: 'button', name: 'Save', region: 'Panels' })).toMatchObject({ condition: 'ui.present', role: 'button', name: 'Save', region: 'Panels' });
    for (const bad of [
      {},
      { condition: 'ui.visible' },
      { condition: 'preview.ready', path: 'about' },
      { condition: 'preview.ready', timeout: 5 },
      { condition: 'save.settled', changed: 'yes' },
      { condition: 'project.revision', atLeast: -1 },
      { condition: 'export.finished', path: 'exports/x' },
      { condition: 'outcome.terminal', since: 'now' },
      { condition: 'ui.context' },
      { condition: 'ui.context', screen: 'settings' },
      { condition: 'ui.present', ref: 'abc123:1' },
      { condition: 'ui.present', name: 'Save' }
    ])
      expect(refused(() => parseCondition(bad)).code, JSON.stringify(bad)).toBe('BAD_REQUEST');
    expect(refused(() => parseCondition({ condition: 'nope' })).details?.conditions).toContain('export.finished');
  });
});

const probe = (o: Partial<AppProbe> = {}): AppProbe => ({
  screen: 'editor',
  opening: 'open-1',
  revision: 5,
  dir: '/x',
  runtime: { state: 'ready' },
  save: { kind: 'saved', text: 'Saved' },
  history: null,
  exports: { count: 0, newest: null },
  exportView: null,
  conflicts: 0,
  readOnly: false,
  ...o
});
const base = (o: Partial<Checkpoint> = {}): Checkpoint => ({ seq: 4, generation: 1, opening: 'open-1', revision: 5, newestExport: null, pageErrors: 0, ...o });
const saved = { condition: 'save.settled', changed: true } as const;

describe('save and revision', () => {
  it('never takes the "Saved" from before an input for the save of that input', () => {
    // The indicator still says Saved and the revision has not moved: the edit's save has not begun.
    expect(judgeApp(saved, probe(), base())).toMatchObject({ met: false, pending: expect.stringMatching(/revision 5, as it was before the last input/) });
    // The project moved on, but the editor is still saving.
    expect(judgeApp(saved, probe({ revision: 6, save: { kind: 'pending', text: 'Saving…' } }), base())).toMatchObject({ met: false, pending: 'the editor shows "Saving…"' });
    expect(judgeApp(saved, probe({ revision: 6 }), base())).toEqual({ met: true, value: { revision: 6, save: { kind: 'saved', text: 'Saved' } } });
  });

  it('compares only within one opening of the project, and needs an input to compare with', () => {
    expect(judgeApp(saved, probe({ revision: 9 }), base({ opening: 'open-0' }))).toMatchObject({ met: false, pending: 'the project was opened again since the last input' });
    expect(judgeApp(saved, probe({ revision: 9 }), null).met).toBe(false);
    expect(judgeApp({ condition: 'save.settled', changed: false }, probe(), null).met).toBe(true);
    expect(judgeApp({ condition: 'save.settled', changed: false }, probe({ save: { kind: 'pending', text: 'Unsaved change' } }), null).met).toBe(false);
    expect(judgeApp(saved, probe({ screen: 'welcome', opening: null, revision: null }), base())).toMatchObject({ met: false, pending: expect.stringMatching(/no project is open/) });
  });

  it('waits for a revision past the last input, or at least a given one', () => {
    const rev = (atLeast?: number) => ({ condition: 'project.revision', ...(atLeast !== undefined ? { atLeast } : {}) }) as Extract<Condition, { condition: 'project.revision' }>;
    expect(judgeApp(rev(), probe(), base()).met).toBe(false);
    expect(judgeApp(rev(), probe({ revision: 6 }), base())).toEqual({ met: true, value: { revision: 6, before: 5 } });
    expect(judgeApp(rev(7), probe({ revision: 6 }), null).met).toBe(false);
    expect(judgeApp(rev(6), probe({ revision: 6 }), null).met).toBe(true);
  });
});

describe('exports', () => {
  const fin = { condition: 'export.finished' } as const;
  const one = { kind: 'site', format: 'folder', path: '/s/exports/a-site', revision: 5, exportedAt: '2026-01-01T00:00:00.000Z' };
  it('finishes with a new export, or a failure shown since the last input', () => {
    expect(judgeApp(fin, probe(), base())).toMatchObject({ met: false, pending: 'no export has finished since the last input' });
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: one }, exportView: { busy: true, result: null } }), base())).toMatchObject({ met: false, pending: 'the export is still running' });
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: one } }), base())).toMatchObject({ met: true, value: { outcome: 'exported', export: one } });
    expect(judgeApp(fin, probe({ exportView: { busy: false, result: { ok: false, text: 'Choose a location outside the project folder.', fresh: true } } }), base())).toEqual({
      met: true,
      value: { outcome: 'failed', message: 'Choose a location outside the project folder.' }
    });
  });

  it('does not take an export or a failure that was already there at the last input', () => {
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: one } }), base({ newestExport: one })).met).toBe(false);
    // A failure still on screen from before.
    expect(judgeApp(fin, probe({ exportView: { busy: false, result: { ok: false, text: 'Old failure', fresh: false } } }), base()).met).toBe(false);
    // The same destination exported again replaces its row: a newer time is a new export.
    const again = { ...one, exportedAt: '2026-01-01T00:01:00.000Z' };
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: again } }), base({ newestExport: one })).met).toBe(true);
  });
});

describe('terminal outcomes', () => {
  const run = { appExited: false, windowClosed: false, pageErrors: [] as string[], runtime: { state: 'ready' } };
  it('names how the run ended, or that it goes on', () => {
    expect(judgeTerminal(run)).toMatchObject({ met: false });
    expect(judgeTerminal({ ...run, appExited: true })).toEqual({ met: true, value: { outcome: 'app-exited' } });
    expect(judgeTerminal({ ...run, windowClosed: true })).toEqual({ met: true, value: { outcome: 'window-closed' } });
    expect(judgeTerminal({ ...run, pageErrors: ['TypeError: x'] })).toEqual({ met: true, value: { outcome: 'page-error', errors: ['TypeError: x'] } });
    expect(judgeTerminal({ ...run, runtime: { state: 'error', message: 'The preview stopped' } })).toMatchObject({ met: true, value: { outcome: 'runtime-error' } });
    expect(judgeTerminal({ ...run, runtime: { state: 'unavailable', message: 'Newer format' } })).toMatchObject({ met: true, value: { outcome: 'runtime-unavailable' } });
  });
});

const ctx = (o: Partial<UiContext> = {}): UiContext => ({ screen: 'editor', title: 'x', mode: 'edit', dialog: null, focus: null, preview: { state: 'ready', path: '/', editing: true }, selection: null, ...o });

describe('UI conditions', () => {
  it('judges the preview and the screen from an observation\'s context', () => {
    expect(judgeContext({ condition: 'preview.ready' }, ctx()).met).toBe(true);
    expect(judgeContext({ condition: 'preview.ready' }, ctx({ preview: { state: 'loading', path: null, editing: null } }))).toEqual({ met: false, pending: 'the preview is still loading' });
    expect(judgeContext({ condition: 'preview.ready', path: '/about/' }, ctx())).toEqual({ met: false, pending: 'the preview shows /, not /about/' });
    expect(judgeContext({ condition: 'ui.context', screen: 'welcome' }, ctx())).toMatchObject({ met: false, pending: 'the screen is editor, not welcome' });
    expect(judgeContext({ condition: 'ui.context', dialog: 'Settings' }, ctx())).toMatchObject({ met: false, pending: 'no dialog is open' });
    expect(judgeContext({ condition: 'ui.context', dialog: null }, ctx({ dialog: { scope: 'editor', role: 'dialog', name: 'Settings' } }))).toMatchObject({ met: false, pending: 'the topmost dialog is "Settings"' });
    expect(judgeContext({ condition: 'ui.context', dialog: 'Settings', mode: 'edit' }, ctx({ dialog: { scope: 'editor', role: 'dialog', name: 'Settings' } })).met).toBe(true);
  });

  it('calls something absent only when the whole search could look for it', () => {
    const present = { condition: 'ui.present', role: 'button', name: 'Go' } as const;
    const absent = { condition: 'ui.absent', role: 'button', name: 'Go' } as const;
    const notFound = (preview: string) => ({ ok: false as const, error: { code: 'TARGET_NOT_FOUND' as const, message: 'Nothing', retryable: false, details: { preview } } });
    const located = { ok: true as const, located: { scope: 'editor' as const, region: [], node: { ref: 'a:1', role: 'button', name: 'Go' } as never } };
    expect(judgeLocate(present, located).met).toBe(true);
    expect(judgeLocate(absent, located).met).toBe(false);
    // Several matches: something is there.
    const many = { ok: false as const, error: { code: 'AMBIGUOUS_TARGET' as const, message: '2', retryable: false, details: { count: 2, candidates: [] } } };
    expect(judgeLocate(present, many)).toMatchObject({ met: true, value: { count: 2 } });
    expect(judgeLocate(absent, many).met).toBe(false);
    expect(judgeLocate(present, notFound('ready')).met).toBe(false);
    expect(judgeLocate(absent, notFound('ready'))).toEqual({ met: true, value: { count: 0 } });
    expect(judgeLocate(absent, notFound('absent')).met).toBe(true);
    // The preview has not been searched while it loads, except by a search of the editor alone.
    expect(judgeLocate(absent, notFound('loading'))).toEqual({ met: false, pending: 'the preview is still loading, so it has not been searched' });
    expect(judgeLocate({ ...absent, scope: 'editor' }, notFound('loading')).met).toBe(true);
    // A search that could not place every match proves nothing either way.
    const incomplete = { ok: false as const, error: { code: 'OP_FAILED' as const, message: 'Not every match could be placed', retryable: true } };
    expect(judgeLocate(present, incomplete).met).toBe(false);
    expect(judgeLocate(absent, incomplete).met).toBe(false);
  });
});

describe('the project on disk', () => {
  const write = (dir: string, rel: string, v: unknown) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), typeof v === 'string' ? v : JSON.stringify(v));
  };
  const project = () => {
    const dir = temp('project');
    write(dir, 'siteorigin.project.json', { name: 'Harbour', projectId: 'p1' });
    write(dir, 'siteorigin/site.json', { name: 'Harbour Lane', language: 'en', homePageId: 'home' });
    write(dir, 'siteorigin/pages/home.json', { id: 'home', title: 'Home', route: '/', rootIds: ['n1'], nodes: { n1: { kind: 'instance', props: { heading: 'Rooms that work beautifully' } } } });
    write(dir, 'siteorigin/pages/about.json', { id: 'about', title: 'About', route: '/about/', draft: true, rootIds: [], nodes: {} });
    return dir;
  };

  it('lists the site and its pages, home first, from the documents', async () => {
    const docs = await readProjectDocs(project());
    expect(docs).toEqual({
      name: 'Harbour',
      site: { name: 'Harbour Lane', language: 'en', homePageId: 'home' },
      pages: [
        { id: 'home', title: 'Home', route: '/', home: true, draft: false },
        { id: 'about', title: 'About', route: '/about/', home: false, draft: true }
      ]
    });
  });

  it('finds text in the documents with the file and JSON path it is at', async () => {
    const docs = await readProjectDocs(project(), { find: 'work beautifully' });
    expect(docs.find).toEqual({
      text: 'work beautifully',
      matches: [{ file: 'siteorigin/pages/home.json', pointer: 'nodes.n1.props.heading', excerpt: 'Rooms that work beautifully' }],
      more: false,
      files: 4,
      complete: true
    });
    expect((await readProjectDocs(project(), { find: 'not anywhere' })).find).toMatchObject({ matches: [], complete: true });
  });

  it('does not follow links, and says when it could not read everything', async () => {
    const dir = project();
    const outside = temp('outside');
    write(outside, 'secret.json', { heading: 'work beautifully elsewhere' });
    symlinkSync(join(outside, 'secret.json'), join(dir, 'siteorigin', 'pages', 'linked.json'));
    write(dir, 'siteorigin/pages/huge.json', `{"x":"${'a'.repeat(DOC_LIMITS.fileBytes)}"}`);
    const docs = await readProjectDocs(dir, { find: 'work beautifully' });
    expect(docs.find?.matches.map((m) => m.file)).toEqual(['siteorigin/pages/home.json']);
    expect(docs.find?.complete).toBe(false);
    expect(docs.find?.skipped).toEqual(expect.arrayContaining(['siteorigin/pages/linked.json (a link)', 'siteorigin/pages/huge.json (too large to read)']));
  });
});

describe('exported files', () => {
  const session = () => {
    const root = temp('session');
    const areas: Record<Area, string> = { imports: join(root, 'imports'), exports: join(root, 'exports'), workspace: join(root, 'workspace') };
    for (const d of Object.values(areas)) mkdirSync(d, { recursive: true });
    const site = join(areas.exports, 'harbour-site');
    mkdirSync(join(site, 'about'), { recursive: true });
    writeFileSync(join(site, 'index.html'), '<html>\n<body>\n<h1>Rooms that work beautifully</h1>\n</body></html>');
    writeFileSync(join(site, 'about', 'index.html'), '<h1>About us</h1>');
    writeFileSync(join(site, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    return { root, areas, site };
  };

  it('lists a folder and finds text in its text files, by file and line', async () => {
    const { areas } = session();
    const r = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site', find: 'work beautifully' }));
    expect(r.type).toBe('folder');
    expect(r.path).toBe('exports/harbour-site');
    expect(r.listed?.map((f) => f.file)).toEqual(['about/index.html', 'index.html', 'logo.png']);
    expect(r.find).toEqual({ text: 'work beautifully', matches: [{ file: 'index.html', line: 3, excerpt: '<html> <body> <h1>Rooms that work beautifully</h1> </body></html>' }], more: false, searched: 2, complete: true });
  });

  it('reads one file of a folder, or a file on its own', async () => {
    const { areas } = session();
    const one = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site', file: 'about/index.html', read: true }));
    expect(one).toMatchObject({ path: 'exports/harbour-site/about/index.html', type: 'file', text: '<h1>About us</h1>', bytes: 17 });
    expect(one.sha256).toMatch(/^[0-9a-f]{64}$/);
    const png = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site/logo.png', find: 'x' }));
    expect(png.find).toMatchObject({ searched: 0, complete: false, skipped: ['logo.png (not text)'] });
  });

  it('stays inside the exports folder and never follows a link', async () => {
    const { areas, site, root } = session();
    writeFileSync(join(areas.workspace, 'notes.html'), 'work beautifully in the workspace');
    symlinkSync(join(areas.workspace, 'notes.html'), join(site, 'notes.html'));
    const r = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site', find: 'work beautifully' }));
    expect(r.find?.matches.map((m) => m.file)).toEqual(['index.html']);
    expect(r.find?.skipped).toEqual(['notes.html (a link)']);
    for (const path of ['workspace/notes.html', 'exports/../workspace/notes.html', join(root, 'workspace', 'notes.html')]) expect((await inspectExport(areas, { path }).catch((e) => errorInfo(e))) as { code: string }).toMatchObject({ code: 'BAD_REQUEST' });
    await expect(inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site', file: 'notes.html' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(inspectExport(areas, parseInspectArgs({ path: 'exports/missing' }))).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    for (const bad of [{}, { path: 'exports/x', file: '../y' }, { path: 'exports/x', find: '' }, { path: 'exports/x', depth: 2 }]) expect(refused(() => parseInspectArgs(bad)).code).toBe('BAD_REQUEST');
  });

  it('says a search was not complete when a file was too large to read', async () => {
    const { areas, site } = session();
    writeFileSync(join(site, 'big.js'), 'x'.repeat(EXPORT_LIMITS.fileBytes + 1));
    const r = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site', find: 'nothing like this' }));
    expect(r.find).toMatchObject({ matches: [], complete: false, skipped: ['big.js (too large to read)'] });
  });

  it('names a path in the session\'s folders as a session path', () => {
    const { areas, site } = session();
    expect(toSessionPath(areas, join(site, 'index.html'))).toBe('exports/harbour-site/index.html');
    expect(toSessionPath(areas, areas.workspace)).toBe('workspace');
    expect(toSessionPath(areas, '/elsewhere/x')).toBeNull();
  });
});

describe('the journal', () => {
  it('numbers entries in order and lets the oldest go past its limits, saying how many went', () => {
    const j = new Journal(3, 10_000);
    for (let i = 0; i < 5; i++) j.admit({ id: `r${i}`, op: 'ui.snapshot', class: 'observation', t: i, window: 1 });
    expect(j.entries().map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(j.dropped).toBe(2);
    expect(j.read(3, 10)).toMatchObject({ entries: [{ seq: 4 }, { seq: 5 }], next: 5, dropped: 2, first: 3, last: 5 });
    expect(j.read(5)).toMatchObject({ entries: [], next: 5 });
  });

  it('is bounded by size too, counting an entry again when it is finished', () => {
    const j = new Journal(100, 2000);
    const e = j.admit({ id: 'a', op: 'ui.click', class: 'input', t: 0, window: 1 });
    j.finish(e, { ok: false, code: 'NOT_ACTIONABLE', message: 'x'.repeat(5000) }, 3);
    expect(e.outcome?.message?.length).toBeLessThan(400);
    for (let i = 0; i < 40; i++) j.admit({ id: `b${i}`, op: 'ui.snapshot', class: 'observation', t: i, window: 1, args: { note: 'y'.repeat(200) } });
    expect(JSON.stringify(j.entries()).length).toBeLessThanOrEqual(2000 + 400);
    expect(j.dropped).toBeGreaterThan(0);
  });

  it('cuts long values to length', () => {
    expect(clipJson({ a: 'x'.repeat(400), list: Array.from({ length: 60 }, (_, i) => i) })).toEqual({ a: `${'x'.repeat(300)}…`, list: [...Array.from({ length: 50 }, (_, i) => i), '… 10 more'] });
  });
});

describe('host paths in evidence', () => {
  const session = '/private/var/folders/ab/T/so-session-x1';
  const hide = pathHider([
    { path: session, label: '<session>' },
    { path: '/Users/someone/code/builder', label: '<repo>' },
    { path: '/Users/someone', label: '~' }
  ]);
  it('names the session, the checkout and the home folder, and hides any other host path', () => {
    expect(hide(`${session}/exports/site/index.html`)).toBe('<session>/exports/site/index.html');
    expect(hide('/var/folders/ab/T/so-session-x1/profile')).toBe('<session>/profile');
    expect(hide('file:///Users/someone/code/builder/out/renderer/index.js:3:9')).toBe('<repo>/out/renderer/index.js:3:9');
    expect(hide('see /Users/someone/Documents/notes.txt')).toBe('see ~/Documents/notes.txt');
    expect(hide('/Users/other/private.txt and /home/x/y and C:\\Users\\x\\y.txt')).toBe(`${HOST_PATH_LABEL} and ${HOST_PATH_LABEL} and ${HOST_PATH_LABEL}`);
    // Not a folder of the host: a page route, a session path, a short word after a slash.
    for (const kept of ['/about/', 'exports/site', 'Opened /contact/ in the preview', 'and/or', '/Usersettings']) expect(hide(kept)).toBe(kept);
    expect(hide(`${session}-other/x`)).toBe(HOST_PATH_LABEL);
  });

  it('applies to every string of a value, keys included', () => {
    expect(hideDeep({ [`${session}/a`]: [`${session}/b`, 3, null] }, hide)).toEqual({ '<session>/a': ['<session>/b', 3, null] });
  });
});

describe('the app log', () => {
  it('keeps its beginning and its end, and says how much was left out', () => {
    const log = new LogKeeper(10, 10);
    log.write('0123456789');
    log.write('abcdefghij');
    log.write(Buffer.from('KLMNOPQRST'));
    expect(log.text()).toBe('0123456789\n… 10 characters of output left out …\nKLMNOPQRST');
  });

  it('picks out the latest lines that read as trouble', () => {
    const log = new LogKeeper(100, 1000);
    log.write('ready\nTypeError: boom\nall fine\nThe preview failed to start\nVITE v7 ready\n');
    expect(log.troubles()).toEqual(['TypeError: boom', 'The preview failed to start']);
  });
});

describe('the session\'s record', () => {
  const appRoot = temp('app');
  it('numbers every request with its class, and keeps typed text out until it is known not to be a credential', async () => {
    const s = new Session({ appRoot });
    let n = 0;
    const call = (op: string, args?: Record<string, unknown>) => s.call({ v: 1, id: `q${++n}`, op, ...(args ? { args } : {}) });
    await call('session.describe');
    // An input refused before it ran: what was typed is not kept, and the step cannot be replayed.
    expect((await call('ui.fill', { target: { ref: 'abc123:1' }, text: 'sk-live-0123456789' })).ok).toBe(false);
    await call('files.stageImport', { sample: 'x.jpg' });
    await call('no.such');
    const log = await call('evidence.log', { after: 0 });
    expect(log.ok).toBe(true);
    const { entries, dropped } = (log as { result: { entries: any[]; dropped: number } }).result; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(dropped).toBe(0);
    expect(entries.map((e) => [e.seq, e.op, e.class, e.outcome.ok, e.outcome.code ?? null])).toEqual([
      [1, 'session.describe', 'session', true, null],
      [2, 'ui.fill', 'input', false, 'NOT_STARTED'],
      [3, 'files.stageImport', 'setup', false, 'NOT_STARTED']
    ]);
    expect(entries[1].args).toEqual({ target: { ref: 'abc123:1' }, textLeftOut: { length: 18 } });
    expect(entries[1].unreplayable).toMatch(/typed text was left out/);
    expect(JSON.stringify(entries)).not.toContain('sk-live');
    // The log reads itself back too, as an observation.
    const again = (await call('evidence.log', { after: 3, limit: 1 })) as { result: { entries: any[]; last: number } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(again.result.entries.map((e) => [e.seq, e.op, e.class])).toEqual([[4, 'evidence.log', 'observation']]);
    expect(again.result.last).toBe(5);
    expect((await call('evidence.log', { after: -1 })).ok).toBe(false);
    expect((await call('wait.for', { condition: 'preview.ready' })) as { error: { code: string } }).toMatchObject({ error: { code: 'NOT_STARTED' } });
    expect((await call('evidence.save')) as { error: { code: string } }).toMatchObject({ error: { code: 'NOT_STARTED' } });
  });

  it('tells a replay record from anything else', () => {
    expect(isReplayRecord({ kind: 'siteorigin-driver-replay', version: 1, steps: [], scenario: { fixture: 'welcome', provider: 'scripted' } })).toBe(true);
    for (const x of [null, {}, { kind: 'siteorigin-driver-replay', version: 2, steps: [], scenario: {} }, { kind: 'other', version: 1, steps: [], scenario: {} }]) expect(isReplayRecord(x)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('names this machine\'s home folder as ~', () => {
    expect(pathHider([{ path: homedir(), label: '~' }])(join(homedir(), 'Projects', 'x'))).toBe('~/Projects/x');
  });
});
