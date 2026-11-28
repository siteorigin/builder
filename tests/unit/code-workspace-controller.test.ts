/**
 * The code workspace through the Controller (#1483): it reaches the project's own code only in Developer mode and only
 * in the opening that asked, saves it as an outside editor would (no History step, no new revision), hands files to
 * the developer's editor only from inside the project, and runs the Svelte check and the project's tests.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectCheckRun } from '@shared/code-workspace';

const env = vi.hoisted(() => ({ userData: '', trusted: true, toolsReady: true }));
// The project's setup trusted and its website tools set up, unless a test says otherwise: what a test run waits on.
vi.mock('../../src/main/settings', async (original) => ({ ...(await original<typeof import('../../src/main/settings')>()), isTrusted: async () => env.trusted }));
vi.mock('../../src/main/runtime/manager', async (original) => ({ ...(await original<typeof import('../../src/main/runtime/manager')>()), dependenciesReady: async () => env.toolsReady }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined, openPath: async () => '' },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {},
  utilityProcess: {}
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { updateSettings } = await import('../../src/main/settings');
const { setEditorHandOff } = await import('../../src/main/external-editor');
const { sha } = await import('../../src/main/project/fsutil');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { defFile } = await import('@generator/index');

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-code-ws-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
  env.trusted = true;
  env.toolsReady = true;
});
afterEach(async () => {
  setEditorHandOff(null);
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

type Attaching = { attach(s: unknown, workspace: object, runtime: object): Promise<void> };

/** A project with a code component and files of its own, open in a controller (no preview), Developer mode on. */
async function opened(files: Record<string, string> = {}) {
  const dir = join(temp('project'), 'site');
  const { state } = applyOperations(createStarterState('blank', 'Code', false), [{ type: 'component.createCode', name: 'Greeting', source: '<p>Hello</p>\n' }]);
  await (await ProjectSession.create(dir, state)).close();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const session = await ProjectSession.open(dir, 'this-window');
  const c = new Controller(() => null);
  const sent: Array<[string, unknown]> = [];
  c.send = ((channel: string, payload: unknown) => void sent.push([channel, payload])) as typeof c.send;
  controllers.push(c);
  await (c as unknown as Attaching).attach(session, {}, { state: 'error', message: 'No preview in this test.' });
  await updateSettings({ developerMode: true });
  const def = Object.values(session.state.components).find((d) => d.name === 'Greeting')!;
  return { c, dir, session, opening: c.openingKey!, def, sent };
}

/** The check's run once it has ended, as the last update sent for it says. */
async function ended(sent: Array<[string, unknown]>, runId: string): Promise<ProjectCheckRun> {
  for (let i = 0; i < 400; i++) {
    const last = sent.filter(([ch, p]) => ch === 'project-check:update' && (p as ProjectCheckRun).runId === runId).at(-1)?.[1] as ProjectCheckRun | undefined;
    if (last && last.status !== 'running') return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the check never ended');
}

describe('the code workspace in the controller', () => {
  it('lists, reads and saves the project’s own code in Developer mode, in the opening that asked, outside History', async () => {
    const { c, dir, session, opening } = await opened({ 'src/lib/util.js': 'export const a = 1;\n' });
    const listed = await c.codeFiles(opening);
    expect(listed).toMatchObject({ ok: true, readOnly: null });
    const paths = listed.ok ? listed.files.map((f) => f.path) : [];
    expect(paths).toContain('src/lib/util.js');
    // Generated pages, the app's folder and the code component's file are the app's.
    expect(paths.some((p) => p.startsWith('src/lib/siteorigin/') || p === 'src/routes/+page.svelte')).toBe(false);
    expect(await c.codeFiles('another-opening')).toMatchObject({ ok: false });
    const read = await c.readCodeFile(opening, 'src/lib/util.js');
    expect(read).toMatchObject({ ok: true, text: 'export const a = 1;\n', hash: sha(Buffer.from('export const a = 1;\n')) });
    const revision = session.revision;
    const saved = await c.saveCodeFile(opening, 'src/lib/util.js', 'export const a = 2;\n', read.ok ? read.hash : '');
    expect(saved).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'src/lib/util.js'), 'utf8')).toBe('export const a = 2;\n');
    expect(session.revision).toBe(revision);
    expect(await c.saveCodeFile(opening, 'src/routes/+page.svelte', '<p>mine</p>', 'x')).toMatchObject({ ok: false, reason: 'claimed' });
    // Developer mode off: nothing of the project's code is reached.
    await updateSettings({ developerMode: false });
    expect(await c.codeFiles(opening)).toMatchObject({ ok: false, message: expect.stringContaining('Developer mode') });
    expect(await c.saveCodeFile(opening, 'src/lib/util.js', 'x', sha(Buffer.from('export const a = 2;\n')))).toMatchObject({ ok: false });
    expect(readFileSync(join(dir, 'src/lib/util.js'), 'utf8')).toBe('export const a = 2;\n');
  });

  it('hands only files inside the project to the developer’s editor', async () => {
    const { c, dir, opening, def } = await opened({ 'src/lib/util.js': 'x\n' });
    const handed: string[] = [];
    setEditorHandOff({ openPath: async (p) => (handed.push(p), ''), reveal: () => undefined, launch: async () => undefined });
    expect(await c.openInEditor(opening, { kind: 'file', path: 'src/lib/util.js' })).toEqual({ ok: true });
    expect(await c.openInEditor(opening, { kind: 'component', definitionId: def.id })).toEqual({ ok: true });
    expect(await c.openInEditor(opening, { kind: 'project' })).toEqual({ ok: true });
    expect(handed).toEqual([join(dir, 'src/lib/util.js'), join(dir, ...defFile(def).split('/')), dir]);
    for (const target of [{ kind: 'file', path: '../outside.js' }, { kind: 'file', path: 'src/routes/+page.svelte' }, { kind: 'component', definitionId: 'nope' }, { kind: 'shell', command: 'rm' }, null])
      expect(await c.openInEditor(opening, target), JSON.stringify(target)).toMatchObject({ ok: false });
    expect(await c.openInEditor('another-opening', { kind: 'project' })).toMatchObject({ ok: false });
    expect(handed).toHaveLength(3);
  });

  it('compiles every Svelte file, the project’s own included, and says which did not compile', async () => {
    const { c, opening, sent } = await opened({ 'src/lib/Card.svelte': '<p>{#if}</p>\n', 'src/lib/Fine.svelte': '<p>fine</p>\n' });
    const started = await c.runProjectCheck(opening, 'svelte');
    expect(started).toMatchObject({ ok: true, run: { task: 'svelte', status: 'running' } });
    const run = await ended(sent, started.ok ? started.run.runId : '');
    expect(run.status).toBe('failed');
    expect(run.problems).toEqual([expect.objectContaining({ file: 'src/lib/Card.svelte', line: 1 })]);
    expect(run.files).toBeGreaterThan(2);
    expect((await c.projectChecks(opening))[0]).toMatchObject({ runId: run.runId, status: 'failed' });
    expect(await c.runProjectCheck(opening, 'lint')).toMatchObject({ ok: false });
  });

  it('compiles exactly the website’s Svelte files and the project’s own, in the workers', async () => {
    const { c, opening, sent } = await opened({ 'src/lib/Card.svelte': '<p>card</p>\n', 'src/lib/util.js': 'export {};\n' });
    let seen: string[] = [];
    c.compileSvelte = async (files) => {
      seen = files.map(([p]) => p);
      return { outcomes: files.map(([p]) => (p === 'src/routes/+page.svelte' ? { message: 'Unexpected token\nmore', start: { line: 2 } } : null)), runs: files.length };
    };
    const started = await c.runProjectCheck(opening, 'svelte');
    const run = await ended(sent, started.ok ? started.run.runId : '');
    expect(seen).toContain('src/routes/+page.svelte');
    expect(seen).toContain('src/lib/Card.svelte');
    expect(seen.every((p) => p.endsWith('.svelte'))).toBe(true);
    expect(run).toMatchObject({ status: 'failed', files: seen.length, problems: [{ file: 'src/routes/+page.svelte', line: 2, message: 'Unexpected token' }] });
  });

  it('runs a declared test once, gives back the run already going, and stops it, waiting, when the project closes', async () => {
    const { c, opening, sent } = await opened({ 'package.json': JSON.stringify({ name: 'site', scripts: { test: 'vitest run' } }) });
    const seen = { started: 0, aborted: false, ended: false };
    c.projectTestRunner = async (opts) => {
      seen.started++;
      opts.onOutput(['RUN  v4']);
      await new Promise((r) => opts.signal.addEventListener('abort', r));
      seen.aborted = true;
      await new Promise((r) => setTimeout(r, 200));
      seen.ended = true;
      return { status: 'cancelled', exitCode: null, summary: 'Stopped.' };
    };
    const first = await c.runProjectCheck(opening, 'test');
    expect(first.ok).toBe(true);
    const runId = first.ok ? first.run.runId : '';
    for (let i = 0; i < 100 && !seen.started; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen.started).toBe(1);
    expect(await c.runProjectCheck(opening, 'test')).toMatchObject({ ok: true, run: { runId } });
    expect(seen.started).toBe(1);
    // A Stop from another opening stops nothing.
    await c.stopProjectCheck('another-opening', runId);
    expect(seen.aborted).toBe(false);
    expect(sent.some(([ch, p]) => ch === 'project-check:update' && (p as ProjectCheckRun).lines.includes('RUN  v4'))).toBe(true);
    const updates = sent.length;
    await c.close();
    // The close stopped it and waited for it to end before letting the project go; nothing more was told.
    expect(seen).toEqual({ started: 1, aborted: true, ended: true });
    expect(sent.slice(updates).some(([ch]) => ch === 'project-check:update')).toBe(false);
  });

  it('says a run stopped from outside (a takeover, Developer mode off) is stopped, and tells nothing more of it', async () => {
    const { c, opening, sent } = await opened({ 'package.json': JSON.stringify({ name: 'site', scripts: { test: 'vitest run' } }) });
    let release: (() => void) | null = null;
    c.projectTestRunner = async (opts) => {
      await new Promise<void>((r) => opts.signal.addEventListener('abort', () => (release = r)));
      opts.onOutput(['after the stop']);
      return { status: 'cancelled', exitCode: null, summary: 'Stopped.' };
    };
    const started = await c.runProjectCheck(opening, 'test');
    const runId = started.ok ? started.run.runId : '';
    await new Promise((r) => setTimeout(r, 20));
    const stopping = c.stopProjectChecks();
    const last = sent.filter(([ch, p]) => ch === 'project-check:update' && (p as ProjectCheckRun).runId === runId).at(-1)?.[1] as ProjectCheckRun;
    expect(last).toMatchObject({ status: 'cancelled', summary: 'Stopped.' });
    const told = sent.length;
    (release as unknown as () => void)();
    await stopping;
    expect(sent.slice(told).some(([ch]) => ch === 'project-check:update')).toBe(false);
  });

  it('starts no test of a project whose setup changed since it was trusted, or whose tools are not set up', async () => {
    const { c, opening, sent } = await opened({ 'package.json': JSON.stringify({ name: 'site', scripts: { test: 'vitest run' } }) });
    let runs = 0;
    c.projectTestRunner = async () => (runs++, { status: 'passed', exitCode: 0, summary: 'The tests passed.' });
    env.trusted = false;
    const untrusted = await c.runProjectCheck(opening, 'test');
    expect(await ended(sent, untrusted.ok ? untrusted.run.runId : '')).toMatchObject({ status: 'not-started', summary: expect.stringContaining('trust') });
    env.trusted = true;
    env.toolsReady = false;
    const unready = await c.runProjectCheck(opening, 'test');
    expect(await ended(sent, unready.ok ? unready.run.runId : '')).toMatchObject({ status: 'not-started', summary: expect.stringContaining('website tools') });
    expect(runs).toBe(0);
    env.toolsReady = true;
    const ready = await c.runProjectCheck(opening, 'test');
    expect(await ended(sent, ready.ok ? ready.run.runId : '')).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(runs).toBe(1);
  });

  it('hands nothing over and runs nothing with Developer mode off', async () => {
    const { c, opening } = await opened({ 'package.json': JSON.stringify({ name: 'site', scripts: { test: 'vitest run' } }) });
    const handed: string[] = [];
    setEditorHandOff({ openPath: async (p) => (handed.push(p), ''), reveal: (p) => void handed.push(p), launch: async (_e, t) => void handed.push(t) });
    let runs = 0;
    c.projectTestRunner = async () => (runs++, { status: 'passed', exitCode: 0, summary: '' });
    await updateSettings({ developerMode: false });
    expect(await c.openInEditor(opening, { kind: 'project' })).toMatchObject({ ok: false });
    expect(await c.runProjectCheck(opening, 'svelte')).toMatchObject({ ok: false });
    expect(await c.runProjectCheck(opening, 'test')).toMatchObject({ ok: false });
    expect(await c.readCodeFile(opening, 'package.json')).toMatchObject({ ok: false });
    expect(handed).toEqual([]);
    expect(runs).toBe(0);
  });

  it('runs no tests the project does not declare', async () => {
    const { c, opening, sent } = await opened({ 'package.json': JSON.stringify({ name: 'site', scripts: { dev: 'vite dev' } }) });
    const started = await c.runProjectCheck(opening, 'test');
    const run = await ended(sent, started.ok ? started.run.runId : '');
    expect(run).toMatchObject({ status: 'not-started', summary: expect.stringContaining('no test script') });
  });
});
