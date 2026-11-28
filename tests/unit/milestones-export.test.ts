/**
 * Milestones the editor records as a project is opened and exported (#1156): the starting version of a project that
 * has never had one, saved once it is open and never again on reopening (a duplicate gets one of its own), and the
 * version an export was staged from, listed under the export's name only once the export is delivered.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inProcessGit, useTestGit } from './fixtures/git-in-process';

const env = vi.hoisted(() => ({ userData: '', fail: false }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  utilityProcess: { fork: () => undefined }
}));

const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')).sort() : [];

// The website build without SvelteKit, as in review-build.test.ts.
vi.mock('../../src/main/runtime/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/manager')>()),
  // The project's website tools are set up, so the website is built (#1395).
  dependenciesReady: async () => true,
  buildProject: async (dir: string) => {
    if (env.fail) return { ok: false, logs: ['Error: the build failed'] };
    const out = join(dir, 'build');
    if (existsSync(join(dir, 'static'))) cpSync(join(dir, 'static'), out, { recursive: true });
    for (const f of filesIn(join(dir, 'src/routes')).filter((f) => f.endsWith('+page.svelte'))) {
      const html = dirname(f).endsWith('.html') ? join(out, dirname(f)) : join(out, dirname(f), 'index.html');
      mkdirSync(dirname(html), { recursive: true });
      const source = readFileSync(join(dir, 'src/routes', f), 'utf8');
      const shown = [...source.matchAll(/^\s*import NotFound from '(\.[^']+\/NotFound\.svelte)';$/gm)].map((m) => readFileSync(join(dir, 'src/routes', dirname(f), m[1]), 'utf8'));
      writeFileSync(html, [source, ...shown].join('\n'));
    }
    return { ok: true, logs: [] };
  }
}));
vi.mock('../../src/main/runtime/stage', async (original) => ({ ...(await original<typeof import('../../src/main/runtime/stage')>()), KeptTools: class { take = async () => ({ keep: async () => undefined }); } }));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');

const git = inProcessGit();
let stopGit: () => void = () => undefined;
beforeAll(() => {
  stopGit = useTestGit(git);
});
afterAll(() => stopGit());

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-milestone-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
  env.fail = false;
  git.enabled = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function open(dir: string) {
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  await c.startingVersion;
  return c;
}
async function project(name = 'Bookshop', saved?: string) {
  const dir = temp('project');
  const s = await ProjectSession.create(dir, createStarterState('business', name, false));
  if (saved) expect((await s.saveVersion(saved)).ok).toBe(true);
  await s.close();
  return dir;
}
const listed = (c: InstanceType<typeof Controller>) => c.snapshot()!.versions!.list.map((v) => v.name);
/** Export the website to a new folder, and show why if it fails. */
async function exported(c: InstanceType<typeof Controller>) {
  const r = await c.buildStaticTo(join(temp('out'), 'site'));
  expect(r.ok ? 'ok' : r.message).toBe('ok');
  return r;
}
const rename = (c: InstanceType<typeof Controller>, name: string) => c.apply({ operations: [{ type: 'site.update', name }] });

describe('the starting version, as a project opens', () => {
  it.each(['objects', 'git'])('is saved on the first opening and never again [%s]', async (mode) => {
    git.enabled = mode === 'git';
    const dir = await project();
    const c = await open(dir);
    expect(listed(c)).toEqual(['Starting version']);
    expect(existsSync(join(dir, '.siteorigin/versions.git'))).toBe(mode === 'git');
    await c.close();
    const again = await open(dir);
    expect(await again.startingVersion).toBe(false);
    expect(listed(again)).toEqual(['Starting version']);
  });

  it('is not saved for a project that has versions already', async () => {
    const c = await open(await project('Bookshop', 'Approved'));
    expect(await c.startingVersion).toBe(false);
    expect(listed(c)).toEqual(['Approved']);
  });

  it('is saved afresh for a duplicate, which inherits none of the original’s versions', async () => {
    const dir = await project();
    const c = await open(dir);
    expect((await c.saveVersion('Approved', c.openingKey!)).ok).toBe(true);
    const sites = temp('sites');
    const dup = await c.duplicate({ name: 'Fall Campaign', parentDir: sites, opening: c.openingKey! });
    expect(dup.ok).toBe(true);
    await c.close();
    const copy = await open((dup as { dir: string }).dir);
    expect(listed(copy)).toEqual(['Starting version']);
  });
});

describe('the milestone of an export (#1156)', () => {
  it.each(['objects', 'git'])('lists the website as exported once it is delivered, once for the same site [%s]', async (mode) => {
    git.enabled = mode === 'git';
    const c = await open(await project('Bookshop', 'Approved'));
    await exported(c);
    expect(listed(c)).toEqual(['Exported website', 'Approved']);
    // The same site again: the version there stands for it. A Git snapshot is of the whole folder, the record of the
    // addresses the first export published included, so there the second export's site is not yet the first's.
    await exported(c);
    const settled = listed(c);
    expect(settled).toEqual(mode === 'git' ? ['Exported website', 'Exported website', 'Approved'] : ['Exported website', 'Approved']);
    await exported(c);
    expect(listed(c)).toEqual(settled);
    // Changed since: delivered again, it is listed again.
    expect((await rename(c, 'Bookshop & Café')).ok).toBe(true);
    await exported(c);
    expect(listed(c)).toEqual(['Exported website', ...settled]);
  });

  it('lists the source project as exported', async () => {
    const c = await open(await project('Bookshop', 'Approved'));
    const r = await c.exportSourceTo(join(temp('out'), 'source'));
    expect(r.ok).toBe(true);
    expect(listed(c)).toEqual(['Exported source project', 'Approved']);
  });

  it.each(['objects', 'git'])('holds the site as it was staged, not as it was edited while being delivered [%s]', async (mode) => {
    git.enabled = mode === 'git';
    const c = await open(await project('Staged name', 'Approved'));
    const internals = c as unknown as { publish: (...args: unknown[]) => Promise<string | null> };
    const deliver = internals.publish.bind(c);
    vi.spyOn(internals, 'publish').mockImplementation(async (...args: unknown[]) => {
      expect((await rename(c, 'Edited meanwhile')).ok).toBe(true);
      return deliver(...args);
    });
    await exported(c);
    const s = c.session!;
    const v = s.versionsInfo().list.find((x) => x.name === 'Exported website')!;
    const review = (await s.reviewVersion(v.id)).review!;
    expect(review.site).toBe(true);
    expect((await s.restoreVersion(v.id, s.revision, { files: review.files, replaced: review.replaced })).ok).toBe(true);
    expect(s.state.site.name).toBe('Staged name');
  });

  it('lists nothing for an export that fails, is refused, or is only a review', async () => {
    const dir = await project('Bookshop', 'Approved');
    const c = await open(dir);
    env.fail = true;
    expect((await c.buildStaticTo(join(temp('out'), 'site'))).ok).toBe(false);
    env.fail = false;
    expect((await c.buildStaticTo(temp('taken'))).ok).toBe(false);
    expect((await c.exportSourceTo(join(dir, 'inside'))).ok).toBe(false);
    expect((await c.stageReviewBuild(join(temp('out'), 'review'))).ok).toBe(true);
    // Captured, then not delivered: the folder could not be put in place.
    const internals = c as unknown as { publish: () => Promise<string | null> };
    vi.spyOn(internals, 'publish').mockResolvedValueOnce('Your disk is full.');
    expect(await c.exportSourceTo(join(temp('out'), 'source'))).toMatchObject({ ok: false, message: 'Your disk is full.' });
    expect(listed(c)).toEqual(['Approved']);
  });

  it('keeps an export that was delivered a success when its milestone can’t be listed', async () => {
    const c = await open(await project('Bookshop', 'Approved'));
    vi.spyOn(ProjectSession.prototype, 'listExported').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    const dest = join(temp('out'), 'site');
    const r = await c.buildStaticTo(dest);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dest, 'index.html'))).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/export is complete, but it couldn’t be added to Saved versions as “Exported website”: ENOSPC/);
    expect(listed(c)).toEqual(['Approved']);
  });

  it('still exports when the milestone can’t be saved, and says so', async () => {
    const c = await open(await project('Bookshop', 'Approved'));
    vi.spyOn(ProjectSession.prototype, 'captureExported').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    for (const r of [await c.exportSourceTo(join(temp('out'), 'source')), await exported(c)]) {
      expect(r.ok).toBe(true);
      expect(r.warnings.join(' ')).toMatch(/couldn’t be saved in Saved versions as “Exported (source project|website)”: ENOSPC/);
    }
    expect(listed(c)).toEqual(['Approved']);
  });

  it('exports a project whose manifest is laid out other than the app writes it', async () => {
    git.enabled = true;
    const dir = await project('Bookshop', 'Approved');
    const manifest = join(dir, 'siteorigin.project.json');
    writeFileSync(manifest, JSON.stringify(JSON.parse(readFileSync(manifest, 'utf8'))) + '\n');
    const c = await open(dir);
    expect((await c.exportSourceTo(join(temp('out'), 'source'))).ok).toBe(true);
    expect(listed(c)).toEqual(['Exported source project', 'Approved']);
  });

  it('still exports when the list of versions can’t be used, and says so', async () => {
    const dir = await project('Bookshop', 'Approved');
    writeFileSync(join(dir, '.siteorigin/versions/versions.json'), '{ not json');
    const c = await open(dir);
    const dest = join(temp('out'), 'source');
    const r = await c.exportSourceTo(dest);
    expect(r.ok).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/couldn’t be saved in Saved versions as “Exported source project”: The list of saved versions could not be read/);
    expect(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).toBe('{ not json');
  });

  it('waits for a document changed outside the app and not loaded yet', async () => {
    const dir = await project('Bookshop', 'Approved');
    const c = await open(dir);
    const capture = ProjectSession.prototype.captureExported;
    vi.spyOn(ProjectSession.prototype, 'captureExported').mockImplementationOnce(async function (this: InstanceType<typeof ProjectSession>, name: string) {
      const site = JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8'));
      writeFileSync(join(dir, 'siteorigin/site.json'), JSON.stringify({ ...site, name: 'Changed outside' }, null, 2) + '\n');
      return capture.call(this, name);
    });
    const dest = join(temp('out'), 'source');
    const r = await c.exportSourceTo(dest);
    expect(r).toMatchObject({ ok: false, message: 'siteorigin/site.json changed outside the app. Export again in a moment.' });
    expect(existsSync(dest)).toBe(false);
    expect(listed(c)).toEqual(['Approved']);
  });

  /** A setup file changed as the export's milestone was being saved to Git, before the project was copied. */
  it.each<[string, (dir: string) => void]>([
    ['replaced', (dir) => writeFileSync(join(dir, 'README.md'), '# Changed meanwhile\n')],
    ['removed', (dir) => rmSync(join(dir, 'README.md'))],
    ['added', (dir) => writeFileSync(join(dir, 'NOTICE.md'), 'Added meanwhile\n')],
    // The developer's own setup files and tests, which a snapshot holds too (#1484).
    ['replaced (tsconfig.json)', (dir) => writeFileSync(join(dir, 'tsconfig.json'), '{"changed":true}\n')],
    ['added (wrangler.toml)', (dir) => writeFileSync(join(dir, 'wrangler.toml'), 'name = "bookshop"\n')],
    ['replaced (a test)', (dir) => writeFileSync(join(dir, 'tests/api.test.js'), '// changed meanwhile\n')],
    ['removed (a test)', (dir) => rmSync(join(dir, 'tests/api.test.js'))],
    ['added (a test)', (dir) => writeFileSync(join(dir, 'tests/e2e/new.spec.js'), '// added meanwhile\n')]
  ])('stops a source export whose setup file was %s while its milestone was saved', async (_, change) => {
    git.enabled = true;
    const dir = await project('Bookshop', 'Approved');
    // The README a new project is made with, and setup files and tests of the developer's own.
    writeFileSync(join(dir, 'README.md'), '# Bookshop\n');
    writeFileSync(join(dir, 'tsconfig.json'), '{}\n');
    mkdirSync(join(dir, 'tests/e2e'), { recursive: true });
    writeFileSync(join(dir, 'tests/api.test.js'), '// a test\n');
    const c = await open(dir);
    const capture = ProjectSession.prototype.captureExported;
    vi.spyOn(ProjectSession.prototype, 'captureExported').mockImplementationOnce(async function (this: InstanceType<typeof ProjectSession>, name: string) {
      const captured = await capture.call(this, name);
      change(dir);
      return captured;
    });
    const dest = join(temp('out'), 'source');
    expect(await c.exportSourceTo(dest)).toMatchObject({ ok: false, message: 'The project changed on disk while it was being exported. Export again.' });
    expect(existsSync(dest)).toBe(false);
    expect(listed(c)).toEqual(['Approved']);
    // Left alone, the same export goes through.
    expect((await c.exportSourceTo(join(temp('out'), 'source'))).ok).toBe(true);
    expect(listed(c)).toEqual(['Exported source project', 'Approved']);
  });

  it('exports a project whose tests hold another repository, and whose test run left a report meanwhile (#1484)', async () => {
    git.enabled = true;
    const dir = await project('Bookshop', 'Approved');
    mkdirSync(join(dir, 'tests/fixtures/repo'), { recursive: true });
    writeFileSync(join(dir, 'tests/api.test.js'), '// a test\n');
    // A fixture checkout, which no snapshot reads, though the export copies it.
    writeFileSync(join(dir, 'tests/fixtures/repo/.git'), 'gitdir: ../../../.git/modules/repo\n');
    writeFileSync(join(dir, 'tests/fixtures/repo/index.js'), '// theirs\n');
    // One whose marker is a link, which the export's copy leaves out.
    if (process.platform !== 'win32') {
      mkdirSync(join(dir, 'tests/fixtures/linked'), { recursive: true });
      symlinkSync(join(dir, 'tests/fixtures/repo/.git'), join(dir, 'tests/fixtures/linked/.git'));
      writeFileSync(join(dir, 'tests/fixtures/linked/index.js'), '// theirs too\n');
    }
    const c = await open(dir);
    const capture = ProjectSession.prototype.captureExported;
    vi.spyOn(ProjectSession.prototype, 'captureExported').mockImplementationOnce(async function (this: InstanceType<typeof ProjectSession>, name: string) {
      const captured = await capture.call(this, name);
      mkdirSync(join(dir, 'tests/playwright-report'), { recursive: true });
      writeFileSync(join(dir, 'tests/playwright-report/index.html'), '<p>report</p>\n');
      return captured;
    });
    const dest = join(temp('out'), 'source');
    const r = await c.exportSourceTo(dest);
    expect(r.ok ? 'ok' : r.message).toBe('ok');
    expect(readFileSync(join(dest, 'tests/api.test.js'), 'utf8')).toBe('// a test\n');
    expect(listed(c)).toEqual(['Exported source project', 'Approved']);
  });
});
