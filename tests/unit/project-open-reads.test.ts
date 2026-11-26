/**
 * Opening a project reads each document file once (#959): the format scan's texts stand in for the open's own read
 * while the files are as they were when scanned, and any file changed, added or removed meanwhile is read as it is now.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, promises as fsp, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';
import { isCanonicalPath } from '../../src/main/project/documents';

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function makeProject(): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-open-reads-')));
  dirs.push(dir);
  await (await ProjectSession.create(dir, createStarterState('business', 'Open Reads', false))).close();
  // A person's files have been left alone a while: their stat can then stand for their bytes (statTrusted).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 60_000);
  return dir;
}

/** How many times each canonical document's file was read while `fn` ran, by project-relative path. */
async function documentReads(dir: string, fn: () => Promise<unknown>): Promise<Map<string, number>> {
  const reads = new Map<string, number>();
  const note = (p: unknown) => {
    const rel = relative(dir, String(p)).split(sep).join('/');
    if (isCanonicalPath(rel)) reads.set(rel, (reads.get(rel) ?? 0) + 1);
  };
  const readFile = fsp.readFile.bind(fsp);
  const open = fsp.open.bind(fsp) as typeof fsp.open;
  vi.spyOn(fsp, 'readFile').mockImplementation(((p: Parameters<typeof fsp.readFile>[0], ...rest: unknown[]) => {
    note(p);
    return (readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
  }) as typeof fsp.readFile);
  // Bytes read through a handle count against the path it was opened on.
  const opened = new Map<number, string>();
  vi.spyOn(fsp, 'open').mockImplementation((async (p: Parameters<typeof fsp.open>[0], ...rest: unknown[]) => {
    const handle = await (open as (...a: unknown[]) => Promise<Awaited<ReturnType<typeof fsp.open>>>)(p, ...rest);
    opened.set(handle.fd, String(p));
    return handle;
  }) as typeof fsp.open);
  const probe = await open(join(dir, 'siteorigin', 'site.json'), 'r');
  const proto = Object.getPrototypeOf(probe) as { readFile: (...a: unknown[]) => Promise<unknown> };
  await probe.close();
  const handleRead = proto.readFile;
  vi.spyOn(proto, 'readFile').mockImplementation(function (this: { fd: number }, ...a: unknown[]) {
    if (opened.has(this.fd)) note(opened.get(this.fd));
    return handleRead.apply(this, a);
  });
  await fn();
  vi.restoreAllMocks();
  return reads;
}

describe('opening a project reads each document once (#959)', () => {
  it('reads every document file exactly once', async () => {
    const dir = await makeProject();
    const pages = readdirSync(join(dir, 'siteorigin/pages')).length;
    const reads = await documentReads(dir, async () => sessions.push(await ProjectSession.open(dir, 'me')));
    const [s] = sessions;
    expect(Object.keys(s.state.pages)).toHaveLength(pages);
    expect(reads.size).toBeGreaterThan(pages);
    // On Windows a handle's stat and a path's differ in form, so the open reads each document again there.
    if (process.platform !== 'win32') expect([...reads].filter(([, n]) => n !== 1)).toEqual([]);
  });

  it('reads a document changed, added or removed after the format scan as it is now', async () => {
    const dir = await makeProject();
    const pageDir = join(dir, 'siteorigin/pages');
    const siteFile = join(dir, 'siteorigin/site.json');
    const site = JSON.parse(readFileSync(siteFile, 'utf8'));
    // Neither is the Home page, which the site cannot do without.
    const [first, second] = readdirSync(pageDir)
      .sort()
      .filter((f) => f !== `${site.homePageId}.json`);
    const changed = join(pageDir, first);
    const before = readFileSync(changed, 'utf8');
    const page = JSON.parse(before);
    // The same length, so only the file's stat tells that it changed.
    const retitled = before.replace(JSON.stringify(page.title), JSON.stringify(page.title.slice(0, -1) + (page.title.endsWith('Z') ? 'Y' : 'Z')));
    expect(retitled.length).toBe(before.length);
    const gone = JSON.parse(readFileSync(join(pageDir, second), 'utf8'));
    const added = { ...gone, id: 'p_added', title: 'Added' };
    // The site's page order follows, so the project stays whole.
    const order = (site.pageOrder as string[]).map((id) => (id === gone.id ? 'p_added' : id));
    // Between the scan and the read: as the lock is taken.
    const proto = ProjectSession.prototype as unknown as { acquireLock: (...a: unknown[]) => Promise<unknown> };
    const acquire = proto.acquireLock;
    vi.spyOn(proto, 'acquireLock').mockImplementation(async function (this: unknown, ...a: unknown[]) {
      writeFileSync(changed, retitled);
      writeFileSync(join(pageDir, 'p_added.json'), JSON.stringify(added, null, 2));
      unlinkSync(join(pageDir, second));
      writeFileSync(siteFile, JSON.stringify({ ...site, pageOrder: order }, null, 2));
      return acquire.apply(this, a);
    });
    const s = await ProjectSession.open(dir, 'me');
    sessions.push(s);
    expect(s.state.pages[page.id].title).toBe(JSON.parse(retitled).title);
    expect(s.state.pages['p_added']?.title).toBe('Added');
    expect(s.state.pages[gone.id]).toBeUndefined();
    expect(s.state.site.pageOrder).toEqual(order);
  });
});

describe('opening a project whose generated files are current (#959)', () => {
  const MANIFEST = 'siteorigin/generated-manifest.json';

  it('leaves the generated manifest as it is, and writes it again once it was changed outside the app', async () => {
    const dir = await makeProject();
    const file = join(dir, MANIFEST);
    const before = readFileSync(file, 'utf8');
    const { ino } = statSync(file);
    const s = await ProjectSession.open(dir, 'me');
    sessions.push(s);
    // Not rewritten: the very same file, holding the very same text (on Windows, where stats cannot be compared so, it is).
    if (process.platform !== 'win32') expect(statSync(file).ino).toBe(ino);
    expect(readFileSync(file, 'utf8')).toBe(before);
    // Changed outside the app (the same length, so only its stat tells), the next publication puts it right.
    writeFileSync(file, before.replace('Hashes of files', 'Hashes of FILES'));
    await (s as unknown as { publishGenerated: (initial: boolean) => Promise<string[]> }).publishGenerated(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('opens a project whose generated manifest is empty, as one with none', async () => {
    const dir = await makeProject();
    const none = join(realpathSync(mkdtempSync(join(tmpdir(), 'so-open-reads-'))), 'none');
    dirs.push(dirname(none));
    cpSync(dir, none, { recursive: true });
    writeFileSync(join(dir, MANIFEST), '');
    unlinkSync(join(none, MANIFEST));
    for (const d of [dir, none]) sessions.push(await ProjectSession.open(d, 'me'));
    const [empty, missing] = sessions;
    expect(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')).files).toEqual(JSON.parse(readFileSync(join(none, MANIFEST), 'utf8')).files);
    expect(empty.conflicts.map((c) => c.path)).toEqual(missing.conflicts.map((c) => c.path));
  });
});
