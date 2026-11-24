// Waits, outcome checks and evidence for the test driver (tests/driver/outcomes.ts, evidence.ts, issue #497): how each
// named condition judges what it sees, the independent readers of the project on disk and of exported files, the
// bounded journal and log, and how evidence names host paths.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST_PATH_LABEL, Journal, LogKeeper, clipJson, hideDeep, pathHider, scrubAll, scrubText } from '../driver/evidence.ts';
import type { Area } from '../driver/desktop.ts';
import { DOC_LIMITS, EXPORT_LIMITS, WALK_LIMITS, inspectExport, judgeApp, judgeContext, judgeLocate, judgeTerminal, parseCondition, parseInspectArgs, readProjectDocs, toSessionPath } from '../driver/outcomes.ts';
import type { AppProbe, Checkpoint, Condition } from '../driver/outcomes.ts';
import { errorInfo } from '../driver/protocol.ts';
import { isReplayRecord, replay } from '../driver/replay.ts';
import { Session, printableKey } from '../driver/session.ts';
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
const base = (o: Partial<Checkpoint> = {}): Checkpoint => ({ seq: 4, known: true, generation: 1, opening: 'open-1', revision: 5, newestExport: null, exportReport: null, pageErrors: 0, ...o });
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
    // A checkpoint whose revision is unknown, and one that could not be read at all, have nothing to compare with.
    expect(judgeApp(saved, probe({ revision: 9 }), base({ revision: null })).met).toBe(false);
    expect(judgeApp(saved, probe({ revision: 9 }), base({ known: false, revision: null, opening: null }))).toMatchObject({ met: false, pending: expect.stringMatching(/could not be read/) });
    // Lower than before is not past it either.
    expect(judgeApp(saved, probe({ revision: 4 }), base()).met).toBe(false);
    // A snapshot the app could not give says nothing, even for the indicator alone.
    expect(judgeApp({ condition: 'save.settled', changed: false }, probe({ unreadable: true }), null)).toEqual({ met: false, pending: 'the project could not be read' });
  });

  it('waits for a revision past the last input, or at least a given one', () => {
    const rev = (atLeast?: number) => ({ condition: 'project.revision', ...(atLeast !== undefined ? { atLeast } : {}) }) as Extract<Condition, { condition: 'project.revision' }>;
    expect(judgeApp(rev(), probe(), base()).met).toBe(false);
    expect(judgeApp(rev(), probe({ revision: 6 }), base())).toEqual({ met: true, value: { revision: 6, before: 5 } });
    expect(judgeApp(rev(7), probe({ revision: 6 }), null).met).toBe(false);
    expect(judgeApp(rev(6), probe({ revision: 6 }), null).met).toBe(true);
    expect(judgeApp(rev(), probe({ revision: 9 }), base({ opening: 'open-0' })).met).toBe(false);
    expect(judgeApp(rev(), probe({ revision: 9 }), base({ known: false })).met).toBe(false);
    expect(refused(() => parseCondition({ condition: 'project.revision', atLeast: 1.5 })).code).toBe('BAD_REQUEST');
  });
});

describe('exports', () => {
  const fin = { condition: 'export.finished' } as const;
  const one = { kind: 'site', format: 'folder', path: '/s/exports/a-site', revision: 5, exportedAt: '2026-01-01T00:00:00.000Z' };
  it('finishes with a new export, or a failure shown since the last input', () => {
    expect(judgeApp(fin, probe(), base())).toMatchObject({ met: false, pending: 'no export has finished since the last input' });
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: one }, exportView: { busy: true, result: null } }), base())).toMatchObject({ met: false, pending: 'the export is still running' });
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: one } }), base())).toMatchObject({ met: true, value: { outcome: 'exported', export: one } });
    const failure = (report: string | null, busy = false) => probe({ exportView: { busy, result: { ok: false, text: 'Choose a location outside the project folder.', report } } });
    expect(judgeApp(fin, failure('r2'), base({ exportReport: 'r1' }))).toEqual({ met: true, value: { outcome: 'failed', message: 'Choose a location outside the project folder.' } });
    // Still exporting: the report shown is not the outcome yet.
    expect(judgeApp(fin, failure('r2', true), base({ exportReport: 'r1' })).met).toBe(false);
  });

  it('does not take an export or a report that was already there at the last input', () => {
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: one } }), base({ newestExport: one })).met).toBe(false);
    // The failure shown at the last input, drawn again after a cancelled retry: the same report.
    expect(judgeApp(fin, probe({ exportView: { busy: false, result: { ok: false, text: 'Old failure', report: 'r1' } } }), base({ exportReport: 'r1' })).met).toBe(false);
    // A new report with the same words is a new outcome.
    expect(judgeApp(fin, probe({ exportView: { busy: false, result: { ok: false, text: 'Old failure', report: 'r2' } } }), base({ exportReport: 'r1' })).met).toBe(true);
    // A report with no id cannot be told from an old one.
    expect(judgeApp(fin, probe({ exportView: { busy: false, result: { ok: false, text: 'x', report: null } } }), base()).met).toBe(false);
    // The same destination exported again replaces its row: a newer time is a new export; so is another kind.
    const again = { ...one, exportedAt: '2026-01-01T00:01:00.000Z' };
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: again } }), base({ newestExport: one })).met).toBe(true);
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: { ...one, kind: 'source' } } }), base({ newestExport: one })).met).toBe(true);
    // A checkpoint that could not be read is not an empty history: the old export does not count.
    expect(judgeApp(fin, probe({ exports: { count: 1, newest: one } }), base({ known: false }))).toMatchObject({ met: false, pending: expect.stringMatching(/could not be read/) });
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
    // A miss that does not say whether the preview was searched (a region not found anywhere) proves nothing there;
    // a search within an editor ref never looked at the preview, loading or not.
    const unsaid = { ok: false as const, error: { code: 'TARGET_NOT_FOUND' as const, message: 'There is no region "Hero"', retryable: false, details: {} } };
    expect(judgeLocate(absent, unsaid)).toEqual({ met: false, pending: 'the search could not say whether the preview was searched' });
    expect(judgeLocate(absent, notFound('loading'), false).met).toBe(true);
    expect(judgeLocate(absent, notFound('loading'), true).met).toBe(false);
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
      ],
      pagesComplete: true
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

  it('never reads pages through a linked folder, and a document it cannot parse leaves the search incomplete', async () => {
    const dir = project();
    const outside = temp('outside-pages');
    write(outside, 'stolen.json', { id: 'stolen', title: 'Outside', route: '/outside/', heading: 'work beautifully elsewhere' });
    rmSync(join(dir, 'siteorigin', 'pages'), { recursive: true });
    symlinkSync(outside, join(dir, 'siteorigin', 'pages'));
    const linked = await readProjectDocs(dir, { find: 'work beautifully' });
    expect(linked.pages).toEqual([]);
    expect(linked.pagesComplete).toBe(false);
    expect(linked.find?.matches).toEqual([]);
    expect(linked.find?.complete).toBe(false);
    const broken = project();
    write(broken, 'siteorigin/pages/broken.json', '{ not json');
    const r = await readProjectDocs(broken, { find: 'nothing like this' });
    expect(r.find).toMatchObject({ matches: [], complete: false, skipped: ['siteorigin/pages/broken.json (not JSON)'] });
    expect(r.pagesComplete).toBe(false);
  });

  it('says a search is not complete when the manifest is a link it did not follow', async () => {
    const dir = project();
    const outside = temp('outside-manifest');
    write(outside, 'siteorigin.project.json', { name: 'work beautifully' });
    rmSync(join(dir, 'siteorigin.project.json'));
    symlinkSync(join(outside, 'siteorigin.project.json'), join(dir, 'siteorigin.project.json'));
    const r = await readProjectDocs(dir, { find: 'work beautifully' });
    expect(r.name).toBeNull();
    expect(r.find).toMatchObject({ complete: false, skipped: expect.arrayContaining(['siteorigin.project.json (a link)']) });
    expect(r.find?.matches.map((m) => m.file)).toEqual(['siteorigin/pages/home.json']);
  });

  it('finds text inside lists, orders other pages by route, and cuts long titles', async () => {
    const dir = project();
    write(dir, 'siteorigin/pages/a-zebra.json', { id: 'zebra', title: 'Z'.repeat(500), route: '/zebra/', rootIds: [], nodes: {}, items: ['first', 'work beautifully in a list'] });
    const docs = await readProjectDocs(dir, { find: 'in a list' });
    expect(docs.pages.map((p) => p.route)).toEqual(['/', '/about/', '/zebra/']);
    expect(docs.pages[2].title).toBe(`${'Z'.repeat(DOC_LIMITS.text)}…`);
    expect(docs.find?.matches).toEqual([{ file: 'siteorigin/pages/a-zebra.json', pointer: 'items.1', excerpt: 'work beautifully in a list' }]);
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
    expect([r.files, r.complete]).toEqual([3, true]);
    expect(r.find).toEqual({ text: 'work beautifully', matches: [{ file: 'index.html', line: 3, excerpt: '<html> <body> <h1>Rooms that work beautifully</h1> </body></html>' }], more: false, searched: 2, complete: true });
  });

  it('reads one file of a folder, or a file on its own', async () => {
    const { areas } = session();
    const one = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site', file: 'about/index.html', read: true }));
    expect(one).toMatchObject({ path: 'exports/harbour-site/about/index.html', type: 'file', text: '<h1>About us</h1>', bytes: 17 });
    expect(one.sha256).toBe(createHash('sha256').update('<h1>About us</h1>').digest('hex'));
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

  it('never inspects an export through a link on the way to it', async () => {
    const { areas, site } = session();
    // Another export's name for this one, and a folder inside it that is a link to another of its folders.
    symlinkSync(site, join(areas.exports, 'alias'));
    symlinkSync(join(site, 'about'), join(site, 'about-link'));
    await expect(inspectExport(areas, parseInspectArgs({ path: 'exports/alias' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(inspectExport(areas, parseInspectArgs({ path: 'exports/alias/index.html' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site', file: 'about-link/index.html' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const listing = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site' }));
    expect(listing.skipped).toEqual(['about-link (a link)']);
    // A name with two dots in it is a name, not a way up.
    mkdirSync(join(site, 'edition..old'));
    writeFileSync(join(site, 'edition..old', 'index.html'), 'old');
    expect((await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site', file: 'edition..old/index.html', read: true }))).text).toBe('old');
  });

  it('says a listing was not complete when a folder held more than it reads', async () => {
    const { areas, site } = session();
    mkdirSync(join(site, 'many'));
    for (let i = 0; i <= WALK_LIMITS.perFolder; i++) writeFileSync(join(site, 'many', `f${i}.txt`), '');
    const r = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site' }));
    expect(r.complete).toBe(false);
  });

  it('says a search was not complete when a file was too large to read', async () => {
    const { areas, site } = session();
    writeFileSync(join(site, 'big.js'), 'x'.repeat(EXPORT_LIMITS.fileBytes + 1));
    const r = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site', find: 'nothing like this' }));
    expect(r.find).toMatchObject({ matches: [], complete: false, skipped: ['big.js (too large to read)'] });
    const direct = await inspectExport(areas, parseInspectArgs({ path: 'exports/harbour-site/big.js', find: 'x' }));
    expect(direct).toMatchObject({ type: 'file', bytes: EXPORT_LIMITS.fileBytes + 1, find: { complete: false, skipped: ['big.js (too large to read)'] } });
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

  it('says whether it cut anything', () => {
    const cut = { cut: false };
    clipJson({ a: 'short', list: [1, 2] }, undefined, 0, cut);
    expect(cut.cut).toBe(false);
    for (const v of [{ a: 'x'.repeat(301) }, { list: Array.from({ length: 51 }) }, { ['k'.repeat(101)]: 1 }, { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }]) {
      const c = { cut: false };
      clipJson(v, undefined, 0, c);
      expect(c.cut, JSON.stringify(v).slice(0, 40)).toBe(true);
    }
  });

  it('cuts long values, long keys and deep nesting to length', () => {
    expect(clipJson({ a: 'x'.repeat(400), list: Array.from({ length: 60 }, (_, i) => i) })).toEqual({ a: `${'x'.repeat(300)}…`, list: [...Array.from({ length: 50 }, (_, i) => i), '… 10 more'] });
    expect(Object.keys(clipJson({ ['k'.repeat(600)]: 1 }) as object)).toEqual([`${'k'.repeat(100)}…`]);
    expect(clipJson({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })).toEqual({ a: { b: { c: { d: { e: { f: '…' } } } } } });
  });

  it('keeps one oversized entry from taking the journal: what it asked for is left out', () => {
    const j = new Journal(100, 4000);
    const big = j.admit({ id: 'big', op: 'desktop.setAnswers', class: 'setup', t: 0, window: 1, args: { answers: Array.from({ length: 50 }, () => ({ message: 'm'.repeat(250) })) } });
    expect(big.args).toEqual({ leftOut: expect.stringMatching(/too large to keep/) });
    expect(big.unreplayable).toMatch(/too large/);
    expect(j.entries()).toEqual([big]);
    // Finishing alone can take an entry over the size budget.
    const k = new Journal(100, 3000);
    const first = k.admit({ id: 'a', op: 'ui.snapshot', class: 'observation', t: 0, window: 1 });
    const second = k.admit({ id: 'b', op: 'ui.snapshot', class: 'observation', t: 1, window: 1 });
    k.finish(second, { ok: true, summary: { note: 'n'.repeat(280), more: 'n'.repeat(280), and: 'n'.repeat(280) } }, 1);
    k.finish(first, { ok: true, summary: { note: 'n'.repeat(280), more: 'n'.repeat(280), and: 'n'.repeat(280) } }, 1);
    expect(k.read(0, 1).entries).toHaveLength(1);
    expect(k.entries().length + k.dropped).toBe(2);
  });
});

describe('credentials in evidence', () => {
  const KEY = 'sk-PART-SENTINEL-1234';
  it('scrubs a credential whole, and the part of one left where a string was cut', () => {
    expect(scrubText(`a ${KEY} b`, [KEY])).toBe('a [redacted] b');
    expect(scrubText('typed sk-PART-SEN…', [KEY])).toBe('typed [redacted]…');
    expect(scrubText('…NTINEL-1234 then', [KEY])).toBe('…[redacted] then');
    // Too short a piece to be taken for one, and a cut that holds none.
    expect(scrubText('ends sk-…', [KEY])).toBe('ends sk-…');
    expect(scrubText('nothing here…', [KEY])).toBe('nothing here…');
  });

  it('scrubs every key and value a caller sent, whatever the key', () => {
    expect(scrubAll({ token: KEY, ref: `x${KEY}`, [KEY]: ['ok', { role: KEY }] }, [KEY])).toEqual({ token: '[redacted]', ref: 'x[redacted]', '[redacted]': ['ok', { role: '[redacted]' }] });
    expect(scrubAll('plain', [])).toBe('plain');
  });

  it('never keeps a key that types a character: a credential can be typed one key at a time', () => {
    for (const k of ['a', 'Z', '7', 'Shift+A', 'KeyQ', 'Digit4', 'Numpad3', 'Space', '+', 'Shift++']) expect(printableKey(k), k).toBe(true);
    for (const k of ['Tab', 'Enter', 'Escape', 'ArrowDown', 'ControlOrMeta+a', 'Meta+Shift+z', 'Alt+x', 'Shift+Tab', 'F5', 7]) expect(printableKey(k), String(k)).toBe(false);
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
    // Not a folder of the host: a page route (even one named like a Unix folder), a session path, a word after a slash.
    for (const kept of ['/about/', '/home/', '/media/photos/', 'exports/site', 'exports/site/home/index.html', 'Opened /contact/ in the preview', 'and/or', '/Usersettings', 'http://127.0.0.1:5173/about/'])
      expect(hide(kept)).toBe(kept);
    expect(hide(`${session}-other/x`)).toBe(HOST_PATH_LABEL);
    expect(hide('\\\\server\\share\\notes.txt')).toBe(HOST_PATH_LABEL);
    expect(hide('at render (/opt/app/lib/x.js:1:2)')).toBe(`at render (${HOST_PATH_LABEL})`);
    expect(hide('GET http://127.0.0.1:5173/@fs/Users/other/x.js')).toBe(`GET http://127.0.0.1:5173/@fs/${HOST_PATH_LABEL}`);
    expect(hide('/Volumes/Backup/x')).toBe(HOST_PATH_LABEL);
  });

  it('applies to every string of a value, keys included', () => {
    expect(hideDeep({ [`${session}/a`]: [`${session}/b`, 3, null] }, hide)).toEqual({ '<session>/a': ['<session>/b', 3, null] });
    expect(hideDeep(`${session}/c`, hide)).toBe('<session>/c');
  });
});

describe('the app log', () => {
  it('keeps its beginning and its end, and says how much was left out', () => {
    const log = new LogKeeper(10, 10);
    log.write('0123456789');
    log.write('abcdefghij');
    log.write(Buffer.from('KLMNOPQRST'));
    expect(log.text()).toBe('0123456789\n… 10 characters of output left out …\nKLMNOPQRST');
    expect(log.written).toBe(30);
    // Each kept part is cleaned on its own, marked where it was cut.
    expect(log.text((part) => `[${part}]`)).toBe('[0123456789…]\n… 10 characters of output left out …\n[…KLMNOPQRST]');
    const short = new LogKeeper(4, 100);
    short.write('abcdefgh');
    expect(short.text()).toBe('abcdefgh');
  });

  it('picks out the latest lines that read as trouble', () => {
    const log = new LogKeeper(100, 1000);
    log.write('ready\nTypeError: boom\nall fine\nThe preview failed to start\nVITE v7 ready\n');
    expect(log.troubles()).toEqual(['TypeError: boom', 'The preview failed to start']);
    expect(log.troubles(1)).toEqual(['The preview failed to start']);
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

  it('leaves out typed text, printable keys, a caller\'s folder and arguments too long to keep whole', async () => {
    const s = new Session({ appRoot });
    let n = 0;
    const call = (op: string, args?: Record<string, unknown>, extra: Record<string, unknown> = {}) => s.call({ v: 1, id: `w${++n}`, op, ...(args ? { args } : {}), ...extra });
    await call('ui.type', { text: 'hunter2' });
    await call('ui.press', { key: 'h' });
    await call('ui.press', { key: 'Escape' }, { timeoutMs: 5000 });
    await call('session.start', { artifactsDir: '/data/team/private-runs', nonsense: true });
    await call('wait.for', { condition: 'ui.present', role: 'button', name: 'n'.repeat(2500) });
    const { entries } = ((await call('evidence.log')) as unknown as { result: { entries: any[] } }).result; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(entries[0].args).toEqual({ textLeftOut: { length: 7 } });
    expect(entries[1].args).toEqual({ keyLeftOut: { length: 1 } });
    expect(entries[1].unreplayable).toMatch(/printable key/);
    expect([entries[2].args, entries[2].timeoutMs]).toEqual([{ key: 'Escape' }, 5000]);
    expect(entries[3].args.artifactsDir).toBe('<caller folder>');
    expect(entries[4].unreplayable).toMatch(/too long to keep whole/);
    expect(JSON.stringify(entries)).not.toMatch(/hunter2|private-runs/);
    // An argument naming a folder of the host's is shown by its label, and the step says it cannot be replayed as it was.
    await call('ui.locate', { role: 'button', name: join(homedir(), 'secret-plans') });
    const named = ((await call('evidence.log', { after: 5, limit: 2 })) as unknown as { result: { entries: any[] } }).result.entries.find((e) => e.op === 'ui.locate'); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (process.platform !== 'win32') expect(named.args.name).toBe('~/secret-plans');
    expect(named.unreplayable).toMatch(/credential or a host path/);
    // An argument nested deeper than any record keeps is recorded cut, and the request is still answered.
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100_000; i++) deep = { d: deep };
    const answered = await call('ui.click', { target: deep });
    expect(answered.ok).toBe(false);
    const last = ((await call('evidence.log', { after: 8 })) as unknown as { result: { entries: any[] } }).result.entries[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect([last.op, last.unreplayable]).toEqual(['ui.click', expect.stringMatching(/too long to keep whole/)]);
  });

  it('tells a replay record from anything else', () => {
    const good = { kind: 'siteorigin-driver-replay', version: 1, steps: [], complete: true, scenario: { fixture: 'welcome', provider: 'scripted' } };
    expect(isReplayRecord(good)).toBe(true);
    for (const x of [null, {}, { ...good, version: 2 }, { ...good, kind: 'other' }, { ...good, steps: undefined }, { ...good, scenario: undefined }, { ...good, scenario: { fixture: 'welcome', provider: 'paid' } }, { ...good, complete: undefined }]) expect(isReplayRecord(x)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('names this machine\'s home folder as ~', () => {
    expect(pathHider([{ path: homedir(), label: '~' }])(join(homedir(), 'Projects', 'x'))).toBe('~/Projects/x');
  });
});

describe('replay', () => {
  type Frame = { id: string; op: string; args?: Record<string, any>; timeoutMs?: number; expectWindow?: number }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const reply = (f: Frame, result: unknown) => ({ v: 1, id: f.id, op: f.op, ok: true, sessionId: 'fake', window: null, elapsedMs: 0, events: [], result });
  const failure = (f: Frame, code: string, details?: Record<string, unknown>) => ({ v: 1, id: f.id, op: f.op, ok: false, sessionId: 'fake', window: null, elapsedMs: 0, events: [], error: { code, message: code, retryable: false, ...(details ? { details } : {}) } });
  /** A stand-in session that answers each request as `answer` says, remembering what it was sent. */
  const fake = (answer: (f: Frame) => unknown) => {
    const sent: Frame[] = [];
    const session = { sent, call: async (f: Frame) => (sent.push(f), answer(f)), close: async () => ({}) };
    return session as unknown as Session & { sent: Frame[] };
  };
  const step = (seq: number, o: Record<string, unknown>) => ({ seq, id: `s${seq}`, t: seq, window: 1, ...o });
  const record = (steps: unknown[], o: Record<string, unknown> = {}) => ({ kind: 'siteorigin-driver-replay', version: 1, savedAt: '', build: null, platform: { os: 'darwin', arch: 'arm64', electron: null, chrome: null }, scenario: { fixture: 'business-v1', provider: 'scripted' }, steps, dropped: 0, complete: true, evidence: { observation: null, failure: null, pageErrors: { total: 0, latest: [] }, log: [] }, artifacts: [], ...o });
  const layers = { at: 'target', scope: 'editor', role: 'button', name: 'Layers', region: 'Panels', replayable: true };
  const journey = [
    step(1, { op: 'session.start', class: 'session', window: null, outcome: { ok: true } }),
    step(2, { op: 'ui.click', class: 'input', args: { target: { ref: 'old:1' } }, targets: [layers], outcome: { ok: true, summary: { dispatched: 'complete', target: { role: 'button', name: 'Layers' } } } }),
    step(3, { op: 'ui.snapshot', class: 'observation', args: {}, outcome: { ok: true } }),
    step(4, { op: 'wait.for', class: 'observation', args: { condition: 'ui.present', role: 'button', name: 'Missing' }, timeoutMs: 1500, outcome: { ok: false, code: 'TIMEOUT' } }),
    step(5, { op: 'project.summary', class: 'observation', args: { find: 'Harbour' }, outcome: { ok: true, summary: { found: 1, complete: true } } }),
    step(6, { op: 'wait.for', class: 'observation', args: { condition: 'export.finished' }, outcome: { ok: true, summary: { condition: 'export.finished', met: true, outcome: 'failed' } } }),
    step(7, { op: 'ui.click', class: 'input', args: { target: { ref: 'old:2' } }, targets: [layers], outcome: { ok: false, code: 'NOT_ACTIONABLE', dispatched: 'none' } }),
    step(8, { op: 'menu.invoke', class: 'input', window: null, args: { path: ['File', 'Open Project…'] }, outcome: { ok: true, summary: { status: 'dispatched' } } }),
    step(9, { op: 'wait.for', class: 'observation', args: { condition: 'ui.present', role: 'heading' }, outcome: { ok: true, summary: { condition: 'ui.present', met: true, count: 1 } } })
  ];
  const answers = (o: { found?: number; outcome?: string; missing?: boolean; locate?: string; count?: number } = {}) => (f: Frame) => {
    if (f.op === 'wait.for' && f.args?.name === 'Missing') return o.missing ? reply(f, { met: true }) : failure(f, 'TIMEOUT');
    if (f.op === 'wait.for' && f.args?.condition === 'export.finished') return reply(f, { condition: 'export.finished', met: true, outcome: o.outcome ?? 'failed' });
    if (f.op === 'wait.for' && f.args?.role === 'heading') return reply(f, { condition: 'ui.present', met: true, count: o.count ?? 1 });
    if (f.op === 'ui.locate') return o.locate ? failure(f, o.locate, { count: 2 }) : reply(f, { node: { ref: 'new:1' } });
    if (f.op === 'project.summary') return reply(f, { project: { find: { matches: Array.from({ length: o.found ?? 1 }), complete: true } } });
    if (f.op === 'ui.click') return reply(f, { dispatched: 'complete', target: { role: 'button', name: 'Layers' } });
    return reply(f, {});
  };

  it('repeats the inputs on targets found again, and the waits and checks with their deadlines', async () => {
    const s = fake(answers());
    const r = await replay(record(journey), { make: () => s });
    expect(r.ok, JSON.stringify(r.divergence)).toBe(true);
    expect(r.steps.map((x) => [x.seq, x.status])).toEqual([
      [1, 'skipped'],
      [2, 'replayed'],
      [3, 'skipped'],
      [4, 'replayed'],
      [5, 'replayed'],
      [6, 'replayed'],
      [7, 'skipped'],
      [8, 'replayed'],
      [9, 'replayed']
    ]);
    const click = s.sent.find((f) => f.op === 'ui.click')!;
    expect(click.args).toEqual({ target: { ref: 'new:1' } });
    expect(s.sent.find((f) => f.op === 'ui.locate')!.args).toEqual({ role: 'button', name: 'Layers', region: 'Panels', scope: 'editor' });
    expect(s.sent.find((f) => f.args?.name === 'Missing')!.timeoutMs).toBe(1500);
    // A menu chosen with no window in the recording is chosen with none named.
    const menu = s.sent.find((f) => f.op === 'menu.invoke')!;
    expect(menu.expectWindow).toBeUndefined();
    expect(click.expectWindow).toBe(1);
  });

  it('stops where a check finds otherwise, an export ends otherwise, or a missing control is there', async () => {
    for (const [o, seq, reason] of [
      [{ found: 2 }, 5, /found is 2 where the recording had 1/],
      [{ outcome: 'exported' }, 6, /outcome is exported where the recording had failed/],
      [{ missing: true }, 4, /succeeded where the recording failed with TIMEOUT/],
      [{ locate: 'AMBIGUOUS_TARGET' }, 2, /was not found as one element/],
      [{ count: 3 }, 9, /count is 3 where the recording had 1/]
    ] as const) {
      const r = await replay(record(journey), { make: () => fake(answers(o)) });
      expect(r.ok).toBe(false);
      expect([r.divergence?.seq, r.divergence?.reason]).toEqual([seq, expect.stringMatching(reason)]);
    }
  });

  it('does not repeat an input that may have sent something before it failed, or a record that lost its start', async () => {
    const unsure = [journey[0], step(2, { op: 'ui.click', class: 'input', args: { target: { ref: 'old:1' } }, targets: [layers], outcome: { ok: false, code: 'OP_FAILED' } })];
    const r = await replay(record(unsure), { make: () => fake(answers()) });
    expect([r.ok, r.divergence?.seq, r.divergence?.reason]).toEqual([false, 2, expect.stringMatching(/may have sent input/)]);
    const partial = [journey[0], step(2, { op: 'ui.drag', class: 'input', args: {}, targets: [layers], outcome: { ok: false, code: 'NOT_ACTIONABLE', dispatched: 'partial' } })];
    expect((await replay(record(partial), { make: () => fake(answers()) })).divergence?.seq).toBe(2);
    const s = fake(answers());
    const lost = await replay(record(journey, { complete: false, dropped: 3 }), { make: () => s });
    expect([lost.ok, lost.divergence?.reason]).toEqual([false, expect.stringMatching(/lost its first 3 steps/)]);
    expect(s.sent).toEqual([]);
    const typed = [journey[0], step(2, { op: 'ui.fill', class: 'input', args: { textLeftOut: { length: 7 } }, targets: [layers], unreplayable: 'its typed text was left out of the record', outcome: { ok: true } })];
    expect((await replay(record(typed), { make: () => fake(answers()) })).divergence?.reason).toMatch(/typed text was left out/);
    // A step whose arguments the session scrubbed or hid is not sent with what stands in for them.
    const hidden = [journey[0], step(2, { op: 'project.summary', class: 'observation', args: { find: '[redacted]' }, unreplayable: 'its arguments held a credential or a host path, which the record leaves out', outcome: { ok: true, summary: { found: 0, complete: true } } })];
    const s2 = fake(answers());
    const r2 = await replay(record(hidden), { make: () => s2 });
    expect([r2.divergence?.seq, r2.divergence?.reason]).toEqual([2, expect.stringMatching(/held a credential or a host path/)]);
    expect(s2.sent.map((f) => f.op)).toEqual(['session.start']);
    // Text a person typed that only looks like a stand-in is sent as it was.
    const literal = [journey[0], step(2, { op: 'project.summary', class: 'observation', args: { find: 'a [redacted] word' }, outcome: { ok: true, summary: { found: 1, complete: true } } })];
    const s3 = fake(answers());
    expect((await replay(record(literal), { make: () => s3 })).ok).toBe(true);
    expect(s3.sent.find((f) => f.op === 'project.summary')!.args).toEqual({ find: 'a [redacted] word' });
  });
});
