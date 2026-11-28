/**
 * #1433: Open project on a folder that is not a project names the project beside it (the one it is inside, or the one
 * it holds) and offers it, says an exported website is one, and otherwise never names the manifest file.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FOLDER_DENIED, NOT_A_PROJECT, WEBSITE_FOLDER, notAProject } from '../../src/main/near-project';

const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-near-')));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const project = (dir: string, manifest: string | object = { name: 'Fynbos and Fern' }) => {
  mkdirSync(join(dir, 'siteorigin', 'pages'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'siteorigin.project.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return dir;
};

describe('notAProject', () => {
  it('names and offers the one project a folder holds', async () => {
    const websites = tmp();
    const p = project(join(websites, 'fynbos-and-fern'));
    mkdirSync(join(websites, 'notes'));
    expect(await notAProject(websites)).toEqual({ message: `That folder holds the project “Fynbos and Fern”, in ${p}.`, nearby: { dir: p, name: 'Fynbos and Fern' } });
  });

  it('names and offers the project a folder is inside, however deep', async () => {
    const p = project(join(tmp(), 'fynbos-and-fern'));
    for (const inner of [join(p, 'siteorigin'), join(p, 'src'), join(p, 'siteorigin', 'pages')]) {
      expect(await notAProject(inner)).toEqual({ message: `That folder is inside the project “Fynbos and Fern”, whose folder is ${p}.`, nearby: { dir: p, name: 'Fynbos and Fern' } });
    }
  });

  it('takes a file chosen in the picker for the folder it is in', async () => {
    const p = project(join(tmp(), 'cafe'), { name: 'Cafe' });
    const page = join(p, 'siteorigin', 'pages', 'home.json');
    writeFileSync(page, '{}');
    expect((await notAProject(page)).nearby).toEqual({ dir: p, name: 'Cafe' });
  });

  it('takes a file picked beside the manifest for the project it is in', async () => {
    const p = project(join(tmp(), 'cafe'), { name: 'Cafe' });
    writeFileSync(join(p, 'package.json'), '{}');
    expect(await notAProject(join(p, 'package.json'))).toEqual({ message: `That file is part of the project “Cafe”, in ${p}.`, nearby: { dir: p, name: 'Cafe' } });
  });

  it('names a project as Recent projects does: its working copy name, else its site name', async () => {
    const holder = tmp();
    const p = project(join(holder, 'cafe'), { name: 'Cafe' });
    writeFileSync(join(p, 'siteorigin', 'site.json'), JSON.stringify({ name: 'Bistro' }));
    expect((await notAProject(holder)).nearby).toEqual({ dir: p, name: 'Bistro' });
    writeFileSync(join(p, 'siteorigin.project.json'), JSON.stringify({ name: 'Cafe', workingCopyName: 'Bistro (draft)' }));
    expect((await notAProject(join(p, 'src'))).nearby).toEqual({ dir: p, name: 'Bistro (draft)' });
  });

  it('never waits on a pipe where a project file should be', async () => {
    if (process.platform === 'win32') return;
    const holder = tmp();
    const p = project(join(holder, 'cafe'), { name: 'Cafe' });
    execFileSync('mkfifo', [join(p, 'siteorigin', 'site.json')]);
    expect((await notAProject(holder)).nearby).toEqual({ dir: p, name: 'Cafe' });
    const piped = join(holder, 'piped');
    mkdirSync(piped);
    execFileSync('mkfifo', [join(piped, 'siteorigin.project.json')]);
    // A pipe for a manifest is no project, so the one beside it is still the only one.
    expect((await notAProject(holder)).nearby).toEqual({ dir: p, name: 'Cafe' });
  });

  it('names a project by its folder when its manifest has no name or cannot be read', async () => {
    const holder = tmp();
    const p = project(join(holder, 'half-a-site'), '{"name": "Half');
    expect((await notAProject(holder)).nearby).toEqual({ dir: p, name: 'half-a-site' });
  });

  it('lists several projects a folder holds, offering none of them', async () => {
    const holder = tmp();
    for (const [f, name] of [['b', 'Bakery'], ['a', 'Atelier'], ['c', 'Cafe']]) project(join(holder, f), { name });
    expect(await notAProject(holder)).toEqual({ message: 'That folder holds 3 projects: “Atelier”, “Bakery” and “Cafe”. Choose the folder of the one to open.' });
    for (const [f, name] of [['d', 'Deli'], ['e', 'Eatery']]) project(join(holder, f), { name });
    expect((await notAProject(holder)).message).toBe('That folder holds 5 projects: “Atelier”, “Bakery”, “Cafe” and 2 more. Choose the folder of the one to open.');
  });

  it('looks only one level down, never into hidden folders, and follows a linked folder', async () => {
    const holder = tmp();
    project(join(holder, 'clients', 'deep'));
    project(join(holder, '.cache'));
    expect(await notAProject(holder)).toEqual({ message: NOT_A_PROJECT });
    const elsewhere = project(join(tmp(), 'linked'), { name: 'Linked' });
    symlinkSync(elsewhere, join(holder, 'shortcut'));
    // Offered where the link leads, so the offer opens what it names.
    expect((await notAProject(holder)).nearby).toEqual({ dir: elsewhere, name: 'Linked' });
    // A link beside the folder it leads to is the same project, not a second one.
    const beside = tmp();
    const cafe = project(join(beside, 'cafe'), { name: 'Cafe' });
    symlinkSync(cafe, join(beside, 'cafe-shortcut'));
    expect((await notAProject(beside)).nearby).toEqual({ dir: cafe, name: 'Cafe' });
    // Chosen by another name for the same folder, the link and its folder are still one project.
    const alias = join(tmp(), 'alias');
    symlinkSync(beside, alias);
    expect((await notAProject(alias)).nearby).toEqual({ dir: cafe, name: 'Cafe' });
  });

  it('says an exported website folder is one, and points to its project', async () => {
    const site = tmp();
    writeFileSync(join(site, 'index.html'), '<!doctype html>');
    mkdirSync(join(site, '_app'));
    mkdirSync(join(site, 'assets'));
    expect(await notAProject(site)).toEqual({ message: WEBSITE_FOLDER });
    expect(WEBSITE_FOLDER).toMatch(/exported website/);
    expect(WEBSITE_FOLDER).toMatch(/project it was exported from/);
    // Kept inside another project, or beside one, a website still says nothing of which project it came from.
    const p = project(join(tmp(), 'cafe'), { name: 'Cafe' });
    const kept = join(p, 'exports', 'bakery');
    mkdirSync(join(kept, '_app'), { recursive: true });
    writeFileSync(join(kept, 'index.html'), '');
    project(join(kept, 'stray'));
    expect(await notAProject(kept)).toEqual({ message: WEBSITE_FOLDER });
  });

  it('looks through 500 entries of a folder, and no more', async () => {
    const holder = tmp();
    project(join(holder, 'aaa-project'), { name: 'Atelier' });
    for (let i = 0; i < 499; i++) writeFileSync(join(holder, `note-${i}.txt`), '');
    expect((await notAProject(holder)).nearby).toEqual({ dir: join(holder, 'aaa-project'), name: 'Atelier' });
    writeFileSync(join(holder, 'note-499.txt'), '');
    expect((await notAProject(holder)).nearby).toBeUndefined();
  });

  it('offers no project from a folder too large to look through whole', async () => {
    const holder = tmp();
    project(join(holder, 'aaa-project'), { name: 'Atelier' });
    for (let i = 0; i < 520; i++) writeFileSync(join(holder, `note-${i}.txt`), '');
    const r = await notAProject(holder);
    // Wherever the folder lists it, the one project seen is never offered as the only one.
    expect(r.nearby).toBeUndefined();
    expect([NOT_A_PROJECT, 'That folder holds the project “Atelier”, but not all of the folder could be looked through for others. Choose the folder of the project to open.']).toContain(r.message);
  });

  it('says plainly that an unrelated or unreadable folder is not a project, without the manifest file name', async () => {
    const plain = tmp();
    writeFileSync(join(plain, 'index.html'), '');
    expect(await notAProject(plain)).toEqual({ message: NOT_A_PROJECT });
    expect(NOT_A_PROJECT).not.toMatch(/siteorigin\.project\.json/);
    expect(await notAProject(join(plain, 'gone'))).toEqual({ message: NOT_A_PROJECT });
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const locked = join(plain, 'locked');
      mkdirSync(locked);
      project(join(locked, 'inside'));
      // Inside a project whose manifest cannot be read, no project further up is offered in its place.
      const outer = project(join(plain, 'outer'), { name: 'Outer' });
      const inner = project(join(outer, 'inner'), { name: 'Inner' });
      chmodSync(join(inner, 'siteorigin.project.json'), 0o000);
      try {
        expect((await notAProject(join(inner, 'src'))).nearby).toBeUndefined();
      } finally {
        chmodSync(join(inner, 'siteorigin.project.json'), 0o644);
      }
      chmodSync(locked, 0o000);
      try {
        expect(await notAProject(locked)).toEqual({ message: FOLDER_DENIED });
      } finally {
        chmodSync(locked, 0o755);
      }
      // A project one level down whose manifest cannot be read leaves the one that can be read unoffered.
      const holder = tmp();
      project(join(holder, 'cafe'), { name: 'Cafe' });
      const hidden = project(join(holder, 'deli'), { name: 'Deli' });
      chmodSync(join(hidden, 'siteorigin.project.json'), 0o000);
      try {
        expect(await notAProject(holder)).toEqual({ message: 'That folder holds the project “Cafe”, but not all of the folder could be looked through for others. Choose the folder of the project to open.' });
      } finally {
        chmodSync(join(hidden, 'siteorigin.project.json'), 0o644);
      }
    }
  });
});
