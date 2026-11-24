import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdtempSync, promises as fsp, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject, pageFile } from '@generator/index';
import { ProjectSession, statTrusted, type SessionEvent } from '../../src/main/project/session';
import { stateToAuthoredSources } from '../../src/main/project/documents';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** An 18-page site, open in a session that trusts a file's stat as soon as it has been read once. */
async function make() {
  let state = createStarterState('business', 'Publish', false);
  const [, about, contact] = state.site.pageOrder;
  for (let i = 0; i < 15; i++) state = applyOperations(state, [{ type: 'page.duplicate', pageId: i % 2 ? about : contact, title: `Service ${i}` }]).state;
  const dir = mkdtempSync(join(tmpdir(), 'so-publish-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, state);
  // Files here were all written moments ago; waiting seconds for them to settle would only slow the test down.
  s.settleMs = 0;
  return { dir, s, about, contact };
}

const page = (id: string) => ({ kind: 'page' as const, id });
function headingEdit(s: ProjectState, pageId: string, value: string): EditOperation {
  const inst = Object.values(s.pages[pageId].nodes).find((n) => n.kind === 'instance' && Object.values(s.components[n.definitionId].properties).some((p) => p.type === 'string')) as InstanceNode;
  const prop = Object.entries(s.components[inst.definitionId].properties).find(([, p]) => p.type === 'string')![0];
  return { type: 'instance.setProp', owner: page(pageId), nodeId: inst.id, prop, value };
}

/** What `fn` reads and replaces among generated files, as project-relative paths (dev variants under `dev:`). */
async function watchFiles(dir: string, fn: () => Promise<unknown>) {
  const devRoot = join(dir, '.siteorigin', 'cache', 'dev');
  const name = (p: unknown) => {
    const abs = String(p);
    if (abs.startsWith(devRoot)) return 'dev:' + relative(devRoot, abs);
    return relative(dir, abs);
  };
  const reads: string[] = [];
  const replaced: string[] = [];
  const readFile = fsp.readFile.bind(fsp);
  const open = fsp.open.bind(fsp) as typeof fsp.open;
  const rename = fsp.rename.bind(fsp);
  vi.spyOn(fsp, 'readFile').mockImplementation(((p: Parameters<typeof fsp.readFile>[0], ...rest: unknown[]) => {
    reads.push(name(p));
    return (readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
  }) as typeof fsp.readFile);
  // Bytes read through a handle count against the path it was opened on; a handle only asked for its stat does not.
  const opened = new Map<number, string>();
  vi.spyOn(fsp, 'open').mockImplementation((async (p: Parameters<typeof fsp.open>[0], ...rest: unknown[]) => {
    const handle = await (open as (...a: unknown[]) => Promise<Awaited<ReturnType<typeof fsp.open>>>)(p, ...rest);
    opened.set(handle.fd, name(p));
    return handle;
  }) as typeof fsp.open);
  const probe = await open(join(dir, 'siteorigin', 'site.json'), 'r');
  const handleProto = Object.getPrototypeOf(probe) as { readFile: (...a: unknown[]) => Promise<unknown> };
  await probe.close();
  const handleRead = handleProto.readFile;
  vi.spyOn(handleProto, 'readFile').mockImplementation(function (this: { fd: number }, ...a: unknown[]) {
    reads.push(opened.get(this.fd) ?? '?');
    return handleRead.apply(this, a);
  });
  vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    replaced.push(name(to));
    return rename(from, to);
  });
  await fn();
  vi.restoreAllMocks();
  return { reads, replaced };
}

/** Every generated file on disk is what a full generation of the session's state gives. */
function expectFullOutput(dir: string, s: ProjectSession) {
  const authored = new Set(stateToAuthoredSources(s.state).keys());
  for (const [path, content] of generateProject(s.state)) if (!authored.has(path)) expect(readFileSync(join(dir, path), 'utf8'), path).toBe(content);
  for (const [path, content] of generateProject(s.state, { instrument: true }))
    if (!authored.has(path)) expect(readFileSync(join(dir, '.siteorigin', 'cache', 'dev', path), 'utf8'), path).toBe(content);
}

describe('publishing only what an edit changes (#183)', () => {
  it('reads, writes and reports only the edited page among the generated files', async () => {
    const { dir, s, about } = await make();
    // The first edits after opening look at every file once.
    for (const v of ['Warm one', 'Warm two']) expect((await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v })).ok).toBe(true);
    const generated = new Set([...generateProject(s.state).keys()].flatMap((p) => [p, 'dev:' + p]));
    let event: SessionEvent | undefined;
    s.on('changed', (e: SessionEvent) => (event = e));
    const { reads, replaced } = await watchFiles(dir, () => s.apply({ operations: [headingEdit(s.state, about, 'A new heading')] }, { label: 'Edit heading' }));
    const aboutFile = pageFile(s.state.pages[about]);
    // The edited page is read once, to be sure no one else changed it before it is replaced; nothing else is.
    expect(reads.filter((p) => generated.has(p))).toEqual([aboutFile]);
    expect(replaced.filter((p) => generated.has(p)).sort()).toEqual([aboutFile, 'dev:' + aboutFile].sort());
    expect(event?.changedFiles).toEqual([aboutFile]);
    expectFullOutput(dir, s);
  });

  it('still keeps and reports an untouched route edited outside the app', async () => {
    const { dir, s, about, contact } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[contact]);
    const file = join(dir, rel);
    // The same length, so only the file's times tell it changed.
    const external = readFileSync(file, 'utf8').replace('Generated', 'Hand-made');
    expect(external.length).toBe(readFileSync(file, 'utf8').length);
    writeFileSync(file, external);
    await s.apply({ operations: [headingEdit(s.state, about, 'After the outside edit')] }, { label: 'Edit heading' });
    expect(readFileSync(file, 'utf8')).toBe(external);
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
    // The preview shows the external version, as the exported site would.
    expect(existsSync(join(dir, '.siteorigin', 'cache', 'dev', rel))).toBe(false);
    // Reported on every later save too, and restored on request.
    await s.apply({ operations: [headingEdit(s.state, about, 'Later')] }, { label: 'Edit heading' });
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
    await s.restoreGeneratedFile(rel);
    expect(s.conflicts.some((c) => c.path === rel)).toBe(false);
    expectFullOutput(dir, s);
  });

  it('notices a file replaced outside the app even when its size and times match', async () => {
    const { dir, s, about, contact } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[contact]);
    const file = join(dir, rel);
    const before = await fsp.stat(file);
    // Saved by an editor that writes a new file and renames it into place, keeping the old times.
    const external = readFileSync(file, 'utf8').replace('Generated', 'Hand-made');
    writeFileSync(file + '.new', external);
    await fsp.utimes(file + '.new', before.atime, before.mtime);
    await fsp.rename(file + '.new', file);
    await s.apply({ operations: [headingEdit(s.state, about, 'After the swap')] }, { label: 'Edit heading' });
    expect(readFileSync(file, 'utf8')).toBe(external);
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
  });

  it('puts back a generated file that was deleted, and a deleted preview variant', async () => {
    const { dir, s, about, contact } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[contact]);
    rmSync(join(dir, rel));
    rmSync(join(dir, '.siteorigin', 'cache', 'dev', rel));
    let event: SessionEvent | undefined;
    s.on('changed', (e: SessionEvent) => (event = e));
    await s.apply({ operations: [headingEdit(s.state, about, 'After the delete')] }, { label: 'Edit heading' });
    expect(event?.changedFiles).toContain(rel);
    expectFullOutput(dir, s);
  });

  it('reads a file before replacing or removing it, whatever its stat says', async () => {
    const { dir, s, about } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const [edited, removed] = s.state.site.pageOrder.slice(3, 5);
    const files = [edited, removed].map((id) => join(dir, pageFile(s.state.pages[id])));
    // Changed outside the app by something that leaves the stat as it was (a clock set back, a remote disk).
    const stats = new Map(await Promise.all(files.map(async (f) => [f, await fsp.stat(f, { bigint: true })] as const)));
    const external = files.map((f) => readFileSync(f, 'utf8').replace('Generated', 'Hand-made'));
    files.forEach((f, i) => writeFileSync(f, external[i]));
    const stat = fsp.stat.bind(fsp);
    vi.spyOn(fsp, 'stat').mockImplementation(((p: string, ...rest: unknown[]) => (stats.has(p) ? Promise.resolve(stats.get(p)) : (stat as (...a: unknown[]) => unknown)(p, ...rest))) as typeof fsp.stat);
    // Its page changes, so its file would be replaced; the other page goes, so its file would be removed.
    await s.apply({ operations: [headingEdit(s.state, edited, 'Replaced?')] }, { label: 'Edit heading' });
    await s.apply({ operations: [{ type: 'page.remove', pageId: removed, replacementPageId: about } as EditOperation] }, { label: 'Remove page' });
    vi.restoreAllMocks();
    files.forEach((f, i) => expect(readFileSync(f, 'utf8')).toBe(external[i]));
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: relative(dir, files[0]), kind: 'generated' }));
  });

  it('reads a file whose generated bytes change, even when its stat says it already holds them', async () => {
    const { dir, s, about, contact } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[contact]);
    const file = join(dir, rel);
    // Someone writes exactly what the next edit will generate; it is reported, and read (and remembered) as theirs.
    const next = applyOperations(s.state, [headingEdit(s.state, contact, 'Later')]).state;
    writeFileSync(file, generateProject(next).get(rel)!);
    // Left alone long enough for its stat to stand for its bytes once read.
    await new Promise((r) => setTimeout(r, 20));
    await s.apply({ operations: [headingEdit(s.state, about, 'Read it')] }, { label: 'Edit heading' });
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel }));
    // Keeping it touches it once, for the preview; the next save reads it again and remembers it.
    await new Promise((r) => setTimeout(r, 20));
    await s.apply({ operations: [headingEdit(s.state, about, 'Read it again')] }, { label: 'Edit heading' });
    const remembered = await fsp.stat(file, { bigint: true });
    // Then changes it again, leaving its stat as it was.
    const external = readFileSync(file, 'utf8').replace('Generated', 'Hand-made');
    writeFileSync(file, external);
    const stat = fsp.stat.bind(fsp);
    vi.spyOn(fsp, 'stat').mockImplementation(((p: string, ...rest: unknown[]) => (p === file ? Promise.resolve(remembered) : (stat as (...a: unknown[]) => unknown)(p, ...rest))) as typeof fsp.stat);
    // The edit that generates those first bytes still looks at the file, and finds it changed.
    await s.apply({ operations: [headingEdit(s.state, contact, 'Later')] }, { label: 'Edit heading' });
    vi.restoreAllMocks();
    expect(readFileSync(file, 'utf8')).toBe(external);
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
  });

  /** Runs `during` while the new version of `file` is being written, before it takes the path. */
  function whileWriting(file: string, during: () => void) {
    const open = fsp.open.bind(fsp) as (...a: unknown[]) => Promise<unknown>;
    let fired = false;
    vi.spyOn(fsp, 'open').mockImplementation((async (p: string, flags?: unknown, ...rest: unknown[]) => {
      if (!fired && flags === 'wx' && dirname(String(p)) === dirname(file) && String(p).endsWith('.tmp')) {
        fired = true;
        during();
      }
      return open(p, flags, ...rest);
    }) as typeof fsp.open);
    return () => fired;
  }

  it('keeps a save made while its replacement was being written', async () => {
    const { dir, s, about } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[about]);
    const file = join(dir, rel);
    const saved = readFileSync(file, 'utf8').replace('Generated', 'Hand-made');
    const fired = whileWriting(file, () => writeFileSync(file, saved));
    await s.apply({ operations: [headingEdit(s.state, about, 'Mine?')] }, { label: 'Edit heading' });
    vi.restoreAllMocks();
    expect(fired()).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(saved);
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
    expect(existsSync(join(dir, '.siteorigin', 'cache', 'dev', rel))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('keeps a link put in place of a file while its replacement was being written', async () => {
    const { dir, s, about } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[about]);
    const file = join(dir, rel);
    const fired = whileWriting(file, () => {
      rmSync(file);
      symlinkSync(join(dir, 'nowhere.svelte'), file);
    });
    await s.apply({ operations: [headingEdit(s.state, about, 'Linked?')] }, { label: 'Edit heading' });
    vi.restoreAllMocks();
    expect(fired()).toBe(true);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
  });

  it('keeps a file put in place of a generated folder, and still saves', async () => {
    const { dir, s, about } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[about]);
    const folder = dirname(join(dir, rel));
    // While the claim on the new files is being written, the page's folder becomes a file.
    const fired = whileWriting(join(dir, 'siteorigin', 'generated-manifest.json'), () => {
      rmSync(folder, { recursive: true });
      writeFileSync(folder, 'in the way');
    });
    expect((await s.apply({ operations: [headingEdit(s.state, about, 'Blocked?')] }, { label: 'Edit heading' })).ok).toBe(true);
    vi.restoreAllMocks();
    expect(fired()).toBe(true);
    expect(readFileSync(folder, 'utf8')).toBe('in the way');
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
  });

  it('still replaces a file that was only touched meanwhile', async () => {
    const { dir, s, about } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[about]);
    const file = join(dir, rel);
    const later = new Date(Date.now() + 5000);
    const fired = whileWriting(file, () => utimesSync(file, later, later));
    await s.apply({ operations: [headingEdit(s.state, about, 'Touched')] }, { label: 'Edit heading' });
    vi.restoreAllMocks();
    expect(fired()).toBe(true);
    expect(s.conflicts.some((c) => c.path === rel)).toBe(false);
    expectFullOutput(dir, s);
  });

  it.skipIf(process.platform === 'win32')('leaves a pipe at a generated path alone instead of waiting on it', async () => {
    const { dir, s, about, contact } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[contact]);
    rmSync(join(dir, rel));
    execFileSync('mkfifo', [join(dir, rel)]);
    expect((await s.apply({ operations: [headingEdit(s.state, contact, 'Piped')] }, { label: 'Edit heading' })).ok).toBe(true);
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
    await expect(s.restoreGeneratedFile(rel)).rejects.toThrow(/could not be read/);
  }, 10_000);

  it('compares the bytes on disk, not the text they decode to', async () => {
    const { dir, s, about, contact } = await make();
    // A heading holding the replacement character, which invalid bytes also decode to.
    await s.apply({ operations: [headingEdit(s.state, contact, 'Before \uFFFD after')] }, { label: 'Odd heading' });
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const rel = pageFile(s.state.pages[contact]);
    const file = join(dir, rel);
    const bytes = readFileSync(file);
    const at = bytes.indexOf(Buffer.from('\uFFFD'));
    expect(at).toBeGreaterThan(0);
    const external = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff, 0xfe, 0xfd]), bytes.subarray(at + 3)]);
    expect(external.toString('utf8')).toBe(bytes.toString('utf8').replace('\uFFFD', '\uFFFD\uFFFD\uFFFD'));
    const sameText = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)]);
    expect(sameText.toString('utf8')).toBe(bytes.toString('utf8'));
    writeFileSync(file, sameText);
    await s.apply({ operations: [headingEdit(s.state, about, 'After the bytes')] }, { label: 'Edit heading' });
    expect(readFileSync(file).equals(sameText)).toBe(true);
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('leaves a file it cannot read as it is, reported, and never restores over it', async () => {
    const { dir, s, about, contact } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const [, , , other] = s.state.site.pageOrder;
    const rels = [contact, other].map((id) => pageFile(s.state.pages[id]));
    const before = rels.map((r) => readFileSync(join(dir, r), 'utf8'));
    rels.forEach((r) => chmodSync(join(dir, r), 0o000));
    try {
      // One page changes; the other goes. Neither file is read, replaced or removed, and the save still succeeds.
      expect((await s.apply({ operations: [headingEdit(s.state, contact, 'Unreadable')] }, { label: 'Edit heading' })).ok).toBe(true);
      expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rels[0], kind: 'generated', reason: expect.stringMatching(/could not be read/) }));
      expect((await s.apply({ operations: [{ type: 'page.remove', pageId: other, replacementPageId: about } as EditOperation] }, { label: 'Remove page' })).ok).toBe(true);
      expect(existsSync(join(dir, rels[1]))).toBe(true);
      await expect(s.restoreGeneratedFile(rels[0])).rejects.toThrow(/could not be read/);
    } finally {
      rels.forEach((r) => chmodSync(join(dir, r), 0o644));
    }
    rels.forEach((r, i) => expect(readFileSync(join(dir, r), 'utf8')).toBe(before[i]));
  });

  it('reads a file again when anything in its stat differs, its inode included', async () => {
    const { dir, s, about, contact } = await make();
    for (const v of ['Warm one', 'Warm two']) await s.apply({ operations: [headingEdit(s.state, about, v)] }, { label: v });
    const file = join(dir, pageFile(s.state.pages[contact]));
    const warmed = await fsp.stat(file, { bigint: true });
    const external = readFileSync(file, 'utf8').replace('Generated', 'Hand-made');
    writeFileSync(file, external);
    // A different file now, with the same size and times as the one read before.
    const swapped = { dev: warmed.dev, ino: warmed.ino + 1n, size: warmed.size, mtimeNs: warmed.mtimeNs, ctimeNs: warmed.ctimeNs };
    const stat = fsp.stat.bind(fsp);
    vi.spyOn(fsp, 'stat').mockImplementation(((p: string, ...rest: unknown[]) => (p === file ? Promise.resolve(swapped) : (stat as (...a: unknown[]) => unknown)(p, ...rest))) as typeof fsp.stat);
    await s.apply({ operations: [headingEdit(s.state, about, 'After the swap')] }, { label: 'Edit heading' });
    vi.restoreAllMocks();
    expect(readFileSync(file, 'utf8')).toBe(external);
    expect(s.conflicts).toContainEqual(expect.objectContaining({ path: relative(dir, file), kind: 'generated' }));
  });

  it('trusts a stat only once the file has settled, and never one without a change time of its own', () => {
    const now = Date.parse('2026-11-24T10:00:00Z');
    const ns = (ms: number, extra = 0) => BigInt(ms) * 1_000_000n + BigInt(extra);
    expect(statTrusted({ mtimeNs: ns(now - 10_000, 123), ctimeNs: ns(now - 9_000, 456) }, now, 3000)).toBe(true);
    // Changed moments ago: a later change could share its timestamps.
    expect(statTrusted({ mtimeNs: ns(now - 10_000, 123), ctimeNs: ns(now - 1_000, 456) }, now, 3000)).toBe(false);
    expect(statTrusted({ mtimeNs: ns(now - 1_000, 123), ctimeNs: ns(now - 10_000, 456) }, now, 3000)).toBe(false);
    // Times ahead of this clock (another machine's disk) are never trusted.
    expect(statTrusted({ mtimeNs: ns(now + 60_000), ctimeNs: ns(now + 60_000, 1) }, now, 3000)).toBe(false);
    // Exactly at the threshold is not past it.
    expect(statTrusted({ mtimeNs: ns(now - 3000, 1), ctimeNs: ns(now - 3000, 2) }, now, 3000)).toBe(false);
    // SSHFS and FAT report the modification time as the change time, in whole seconds.
    expect(statTrusted({ mtimeNs: ns(now - 60_000), ctimeNs: ns(now - 60_000) }, now, 3000)).toBe(false);
    expect(statTrusted({ mtimeNs: ns(now - 60_000), ctimeNs: ns(now - 59_000) }, now, 3000)).toBe(true);
  });

  it('works out the checks a snapshot shows once per state, and again for a new one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-publish-'));
    dirs.push(dir);
    const pictured = await ProjectSession.create(dir, createStarterState('business', 'Pictures', true));
    const usages = pictured.assetUsages();
    const [assetId, count] = Object.entries(usages).find(([, n]) => n > 0)!;
    const home = pictured.state.pages[pictured.state.site.homePageId];
    const user = Object.values(home.nodes).find((n) => JSON.stringify(n).includes(`"${assetId}"`))!;
    expect((await pictured.apply({ operations: [{ type: 'node.remove', owner: page(home.id), nodeId: user.id }] }, { label: 'Remove section' })).ok).toBe(true);
    expect(pictured.assetUsages()[assetId] ?? 0).toBeLessThan(count);
  });

  it('works out the checks a snapshot shows once per state', async () => {
    const { s, about } = await make();
    const diagnostics = s.diagnostics();
    const usages = s.assetUsages();
    const updates = s.themeUpdates();
    expect(s.diagnostics()).toBe(diagnostics);
    expect(s.assetUsages()).toBe(usages);
    expect(s.themeUpdates()).toBe(updates);
    await s.apply({ operations: [headingEdit(s.state, about, 'Changed')] }, { label: 'Edit heading' });
    expect(s.diagnostics()).not.toBe(diagnostics);
    expect(s.diagnostics()).toEqual(diagnostics);
    expect(s.assetUsages()).not.toBe(usages);
    expect(s.themeUpdates()).not.toBe(updates);
  });
});
