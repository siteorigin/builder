/**
 * The private project brief (#518): a description and working notes kept in the project's own `siteorigin/brief.json`,
 * edited through `brief.update` like any other change (undo, redo, History), carried by Duplicate project and a copied
 * folder, shown and searched on Welcome, and left out of every export and of everything that builds the website.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => env.userData, isPackaged: false } }));

const { validateOperation } = await import('@shared/ops');
const { BRIEF_FILE, storedBriefDescription } = await import('@shared/brief');
const { TEXT_LIMITS } = await import('@shared/text-limits');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { migrateProject, newestDocumentVersion, MIGRATIONS } = await import('@shared/migrations');
const { isCanonicalPath, newestStoredVersion, readState, stateToDocs, ProjectFormatError } = await import('../../src/main/project/documents');
const { ProjectSession } = await import('../../src/main/project/session');
const { docChanges } = await import('../../src/main/project/turn-review');
const { copyProjectSource, isProjectBrief } = await import('../../src/main/export');
const { createPreviewStage, removePreviewStage, syncPreviewStage } = await import('../../src/main/runtime/stage');
const { previewFsPolicy } = await import('../../src/runtime/policy');
const { matchesFilter, recentGroups } = await import('../../src/renderer/src/lib/recent-places');
const { checkHeld, heldPrompt, placeOf, readFields, shownField, typedText } = await import('../../src/renderer/src/lib/held');

const dirs: string[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-brief-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const fresh = () => createStarterState('business', 'Harbour Pottery', false);
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const DESCRIPTION = 'A brochure site for a family-run pottery studio.';
const NOTES = 'Client: Ana.\nAudience: first-time potters.\n\nGoal: fill the Saturday wheel classes ✨';

describe('the brief.update operation', () => {
  it('takes a description and notes up to their limits, and refuses longer text whole, with its length', () => {
    expect(validateOperation({ type: 'brief.update', description: DESCRIPTION }).ok).toBe(true);
    expect(validateOperation({ type: 'brief.update', notes: 'x'.repeat(TEXT_LIMITS.projectNotes) }).ok).toBe(true);
    expect(validateOperation({ type: 'brief.update', description: 'x'.repeat(TEXT_LIMITS.projectDescription) }).ok).toBe(true);
    const long = validateOperation({ type: 'brief.update', description: 'x'.repeat(TEXT_LIMITS.projectDescription + 1) });
    expect(long).toEqual({ ok: false, message: `description: ${TEXT_LIMITS.projectDescription + 1} characters is longer than the ${TEXT_LIMITS.projectDescription} allowed.` });
    expect(validateOperation({ type: 'brief.update', notes: 'x'.repeat(TEXT_LIMITS.projectNotes + 1) }).ok).toBe(false);
    expect(validateOperation({ type: 'brief.update', notes: 42 }).ok).toBe(false);
  });

  it('changes only the fields it is given, keeps text as typed, and is no document once both are empty', () => {
    const s = fresh();
    expect(s.brief).toBeUndefined();
    const described = apply(s, [{ type: 'brief.update', description: DESCRIPTION }]);
    expect(described.brief).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: '' });
    const noted = apply(described, [{ type: 'brief.update', notes: NOTES }]);
    expect(noted.brief).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES });
    // The input is never changed.
    expect(described.brief?.notes).toBe('');
    const cleared = apply(noted, [{ type: 'brief.update', description: '' }]);
    expect(cleared.brief).toEqual({ schemaVersion: SCHEMA_VERSION, description: '', notes: NOTES });
    // Clearing the last field that held anything leaves no brief at all, as for a project that never had one.
    expect(apply(cleared, [{ type: 'brief.update', notes: '  \n ' }]).brief).toBeUndefined();
    expect(() => apply(s, [{ type: 'brief.update' }])).toThrow(/needs a description or notes/);
    // Nothing else in the project changes.
    const { brief: _brief, ...rest } = noted;
    expect(rest).toEqual(s);
  });
});

describe('the brief on disk', () => {
  it('is a canonical document, written only while it holds something, and read back as it was', async () => {
    expect(isCanonicalPath(BRIEF_FILE)).toBe(true);
    const s = fresh();
    expect(stateToDocs(s).has(BRIEF_FILE)).toBe(false);
    const noted = apply(s, [{ type: 'brief.update', description: DESCRIPTION, notes: NOTES }]);
    const docs = stateToDocs(noted);
    expect(JSON.parse(docs.get(BRIEF_FILE)!)).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES });
    const dir = temp('disk');
    for (const [path, text] of docs) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    expect((await readState(dir)).brief).toEqual(noted.brief);
    // A field left out of the file stays out (it reads as empty); one that is not text stops the read, naming the file.
    writeFileSync(join(dir, BRIEF_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION, notes: NOTES }));
    expect((await readState(dir)).brief).toEqual({ schemaVersion: SCHEMA_VERSION, notes: NOTES });
    // A brief written by a newer editor is seen even before the project is read, like every other document.
    writeFileSync(join(dir, BRIEF_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, notes: NOTES }));
    expect(await newestStoredVersion(dir)).toBe(SCHEMA_VERSION + 1);
    writeFileSync(join(dir, BRIEF_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION, notes: ['not', 'text'] }));
    await expect(readState(dir)).rejects.toThrow(ProjectFormatError);
    await expect(readState(dir)).rejects.toThrow(/siteorigin\/brief\.json has a notes that is not text/);
    writeFileSync(join(dir, BRIEF_FILE), '[]');
    await expect(readState(dir)).rejects.toThrow(/siteorigin\/brief\.json is not a project brief/);
  });

  it('is a document of the project’s format: an older editor is kept from editing a project that has one', () => {
    // The brief's step follows the managed overlays' one; later formats add steps after it.
    expect(MIGRATIONS.findIndex((m) => m.id === 'project-brief')).toBe(MIGRATIONS.findIndex((m) => m.id === 'managed-overlays') + 1);
    const s = apply(fresh(), [{ type: 'brief.update', notes: NOTES }]);
    expect(migrateProject(s)).toBeNull();
    // A brief written by a newer editor makes the project one this editor cannot edit, like any other document.
    s.brief!.schemaVersion = SCHEMA_VERSION + 1;
    expect(newestDocumentVersion(s)).toBe(SCHEMA_VERSION + 1);
    expect(migrateProject(s)).toBeNull();
    // A project from before the brief existed migrates as it did, and gains none.
    const old = fresh();
    // The format the brief's step upgrades from (its place in the list plus one).
    const before = MIGRATIONS.findIndex((m) => m.id === 'project-brief') + 1;
    expect(before).toBe(17);
    for (const doc of [old.manifest, old.site, old.tokens, old.assets, old.themeLock, ...Object.values(old.pages), ...Object.values(old.components)]) doc.schemaVersion = before;
    const migrated = migrateProject(old);
    expect(migrated?.applied).toEqual(['project-brief', 'divider-shapes']);
    expect(migrated?.state.brief).toBeUndefined();
  });
});

describe('the brief in a project session', () => {
  async function session() {
    const dir = temp('session');
    const s = await ProjectSession.create(dir, fresh());
    return { dir, s };
  }
  const onDisk = (dir: string) => (existsSync(join(dir, BRIEF_FILE)) ? JSON.parse(readFileSync(join(dir, BRIEF_FILE), 'utf8')) : null);

  it('saves each edit, survives reopening, and undoes and redoes back to no brief at all', async () => {
    const { dir, s } = await session();
    expect(onDisk(dir)).toBeNull();
    expect((await s.apply({ operations: [{ type: 'brief.update', description: DESCRIPTION }] }, { label: 'Edit project description' })).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'brief.update', notes: NOTES }] }, { label: 'Edit project notes' })).ok).toBe(true);
    expect(onDisk(dir)).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES });
    expect(s.historyInfo().entries.slice(-2).map((e) => e.label)).toEqual(['Edit project description', 'Edit project notes']);
    await s.close();

    const again = await ProjectSession.open(dir, 'test');
    expect(again.state.brief).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES });
    expect((await again.undo()).ok).toBe(true);
    expect(again.state.brief).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: '' });
    expect((await again.undo()).ok).toBe(true);
    // The first edit made the file: undoing it removes the file, rather than keeping the brief that was there.
    expect(again.state.brief).toBeUndefined();
    expect(onDisk(dir)).toBeNull();
    expect((await again.redo()).ok).toBe(true);
    expect((await again.redo()).ok).toBe(true);
    expect(again.state.brief).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES });
    expect(onDisk(dir)).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES });
    await again.close();
  });

  it('edits a brief written by hand with a field left out, without taking it for a change made outside the app', async () => {
    const { dir, s } = await session();
    await s.close();
    writeFileSync(join(dir, BRIEF_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION, notes: NOTES }, null, 2));
    const again = await ProjectSession.open(dir, 'test');
    expect((await again.saveVersion('With hand-written notes')).ok).toBe(true);
    const r = await again.apply({ operations: [{ type: 'brief.update', description: DESCRIPTION }] }, { label: 'Edit project description' });
    expect(r.error).toBeUndefined();
    expect(onDisk(dir)).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES });
    await again.close();
  });

  it('is never written by the AI, however a run asks', async () => {
    const { dir, s } = await session();
    const r = await s.apply({ operations: [{ type: 'brief.update', notes: 'Written by a model' }] }, { label: 'AI', source: 'ai' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SCOPE_MISMATCH');
    expect(s.state.brief).toBeUndefined();
    expect(onDisk(dir)).toBeNull();
    await s.close();
  });

  it('sees a brief written outside the app, and keeps the brief when an earlier saved version is restored', async () => {
    const { dir, s } = await session();
    const saved = await s.saveVersion('Before the brief');
    expect(saved.ok).toBe(true);
    writeFileSync(join(dir, BRIEF_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: '' }));
    expect((await s.reloadFromDisk()).ok).toBe(true);
    expect(s.state.brief?.description).toBe(DESCRIPTION);
    expect((await s.apply({ operations: [{ type: 'brief.update', notes: NOTES }] }, { label: 'Edit project notes' })).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Harbour Ceramics' }] }, { label: 'Rename site' })).ok).toBe(true);
    // The brief says what the project is for, whichever version of its site it holds.
    const restored = await s.restoreVersion(saved.id!, s.revision);
    expect(restored.ok).toBe(true);
    expect(s.state.site.name).toBe('Harbour Pottery');
    expect(s.state.brief).toEqual({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES });
    expect(onDisk(dir)?.notes).toBe(NOTES);
    await s.close();
  });

  it('keeps the brief out of saved versions, and a file its notes name out of what a version holds', async () => {
    const { dir, s } = await session();
    mkdirSync(join(dir, 'static', 'downloads'), { recursive: true });
    writeFileSync(join(dir, 'static', 'downloads', 'proposal.pdf'), '%PDF-1.4 draft');
    expect((await s.apply({ operations: [{ type: 'brief.update', notes: 'Send the client /downloads/proposal.pdf by Friday.' }] }, { label: 'Edit project notes' })).ok).toBe(true);
    const saved = await s.saveVersion('With notes');
    expect(saved.ok).toBe(true);
    const store = (s as unknown as { versions: { versions: Array<{ id: string; docs: Record<string, string>; media: Record<string, unknown> }> } }).versions;
    const v = store.versions.find((x) => x.id === saved.id)!;
    expect(Object.keys(v.docs)).toContain('siteorigin/site.json');
    expect(Object.keys(v.docs)).not.toContain(BRIEF_FILE);
    expect(Object.keys(v.media)).not.toContain('static/downloads/proposal.pdf');
    await s.close();
  });
});

describe('History rows for the brief', () => {
  it('name the field that changed, never what it says', () => {
    const before = JSON.stringify({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: '' });
    const after = JSON.stringify({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES });
    const s = fresh();
    expect(docChanges({ path: BRIEF_FILE, before: JSON.parse(before), after: JSON.parse(after) }, s)).toEqual([{ owner: 'Project brief', property: 'Working notes', change: 'added' }]);
    expect(docChanges({ path: BRIEF_FILE, before: null, after: JSON.parse(before) }, s)).toEqual([{ owner: 'Project brief', property: 'Description', change: 'added' }]);
    expect(docChanges({ path: BRIEF_FILE, before: JSON.parse(after), after: null }, s)).toEqual([
      { owner: 'Project brief', property: 'Description', change: 'removed' },
      { owner: 'Project brief', property: 'Working notes', change: 'removed' }
    ]);
    expect(JSON.stringify(docChanges({ path: BRIEF_FILE, before: JSON.parse(before), after: JSON.parse(after) }, s))).not.toContain('Ana');
  });
});

describe('copies of the project', () => {
  function project(): string {
    const dir = temp('src');
    mkdirSync(join(dir, 'siteorigin'), { recursive: true });
    writeFileSync(join(dir, 'siteorigin.project.json'), '{}');
    writeFileSync(join(dir, 'siteorigin/site.json'), '{}');
    writeFileSync(join(dir, BRIEF_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION, description: DESCRIPTION, notes: NOTES }));
    return dir;
  }

  it('leave the brief out of an export, and keep it in a copy that is the project itself (Duplicate project)', async () => {
    const src = project();
    const exported = join(temp('export'), 'site');
    await copyProjectSource(src, exported);
    expect(existsSync(join(exported, 'siteorigin/site.json'))).toBe(true);
    expect(existsSync(join(exported, BRIEF_FILE))).toBe(false);
    const duplicate = join(temp('dup'), 'site');
    await copyProjectSource(src, duplicate, { keepBrief: true });
    expect(readFileSync(join(duplicate, BRIEF_FILE), 'utf8')).toBe(readFileSync(join(src, BRIEF_FILE), 'utf8'));
  });

  it('know the brief, and copies an editor left beside it, by its path whatever its case, and nothing else by it', () => {
    for (const name of ['brief.json', 'brief.json~', '.brief.json.swp', '#brief.json#', 'brief.json.bak', 'Brief.JSON~', '.Brief.json.SWP']) expect(isProjectBrief('/p', join('/p', 'siteorigin', name)), name).toBe(true);
    expect(isProjectBrief('/p', join('/p', 'SiteOrigin', 'Brief.JSON'))).toBe(true);
    // A file of the author's own that only mentions a brief is not one.
    expect(isProjectBrief('/p', join('/p', 'siteorigin', 'client-brief.json'))).toBe(false);
    expect(isProjectBrief('/p', join('/p', 'siteorigin', 'brief.jsonc'))).toBe(false);
    expect(isProjectBrief('/p', join('/p', 'brief.json'))).toBe(false);
    expect(isProjectBrief('/p', join('/p', 'siteorigin', 'site.json'))).toBe(false);
    expect(isProjectBrief('/p', join('/p', 'siteorigin', 'pages', 'brief.json'))).toBe(false);
    expect(isProjectBrief('/p', join('/p', 'static', 'siteorigin', 'brief.json'))).toBe(false);
  });

  it('leave an editor’s backup of the brief out of an export', async () => {
    const src = project();
    writeFileSync(join(src, 'siteorigin', 'brief.json~'), 'Notes since taken out');
    writeFileSync(join(src, 'siteorigin', 'client-brief.json'), '{}');
    // The editor's own data, history and all, by any spelling of its folder.
    mkdirSync(join(src, '.SiteOrigin', 'history'), { recursive: true });
    writeFileSync(join(src, '.SiteOrigin', 'history', 'blob'), 'Notes since taken out');
    const exported = join(temp('export'), 'site');
    await copyProjectSource(src, exported);
    expect(existsSync(join(exported, 'siteorigin', 'brief.json~'))).toBe(false);
    expect(existsSync(join(exported, '.SiteOrigin'))).toBe(false);
    expect(existsSync(join(exported, 'siteorigin', 'site.json'))).toBe(true);
    expect(existsSync(join(exported, 'siteorigin', 'client-brief.json'))).toBe(true);
  });

  it('keep the brief out of the preview’s copy and of what the preview server serves', async () => {
    const src = project();
    // The preview runs on the project's installed tools, which its copy takes along.
    mkdirSync(join(src, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(src, 'node_modules', 'pkg', 'index.js'), '');
    const stage = await createPreviewStage(src, temp('stages'));
    try {
      expect(existsSync(join(stage, 'siteorigin', 'site.json'))).toBe(true);
      expect(existsSync(join(stage, BRIEF_FILE))).toBe(false);
      // Brought up to date after the project changed, it still leaves the brief out.
      writeFileSync(join(src, BRIEF_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION, notes: 'Changed' }));
      writeFileSync(join(src, 'siteorigin', '.brief.json.swp'), 'Changed');
      writeFileSync(join(src, 'siteorigin', 'site.json'), '{"changed":true}');
      await syncPreviewStage(src, stage);
      expect(readFileSync(join(stage, 'siteorigin', 'site.json'), 'utf8')).toBe('{"changed":true}');
      expect(existsSync(join(stage, BRIEF_FILE))).toBe(false);
      expect(existsSync(join(stage, 'siteorigin', '.brief.json.swp'))).toBe(false);
    } finally {
      await removePreviewStage(stage);
    }
    expect(previewFsPolicy('/p').deny).toEqual(expect.arrayContaining(['**/siteorigin/brief.json*', '**/siteorigin/.brief.json*', '**/siteorigin/#brief.json#']));
  });
});

describe('the brief on Welcome', () => {
  const recent = (dir: string, name: string, description?: string) => ({ dir, name, openedAt: '2026-01-01T00:00:00.000Z', ...(description ? { description } : {}) });

  it('reads each listed project’s description from its folder, never keeping it in the settings', async () => {
    const settings = await import('../../src/main/settings');
    const sites = temp('sites');
    const make = (folder: string, brief?: string) => {
      const dir = join(sites, folder);
      mkdirSync(join(dir, 'siteorigin'), { recursive: true });
      writeFileSync(join(dir, 'siteorigin.project.json'), '{}');
      if (brief !== undefined) writeFileSync(join(dir, BRIEF_FILE), brief);
      return dir;
    };
    const described = make('pottery', JSON.stringify({ schemaVersion: SCHEMA_VERSION, description: `  ${DESCRIPTION}\n`, notes: NOTES }));
    const none = make('bakery');
    const broken = make('florist', '{ not json');
    for (const [dir, name] of [
      [described, 'Harbour Pottery'],
      [none, 'Bakery'],
      [broken, 'Florist']
    ])
      await settings.addRecent(dir, name, name.toLowerCase().replace(/\W/g, ''));
    const byDir = new Map((await settings.recents()).map((r) => [r.dir, r]));
    expect(byDir.get(described)?.description).toBe(DESCRIPTION);
    expect(byDir.get(none)).not.toHaveProperty('description');
    expect(byDir.get(broken)).not.toHaveProperty('description');
    // The notes never reach Welcome, and nothing of the brief is kept with the list.
    expect(JSON.stringify([...byDir.values()])).not.toContain('first-time potters');
    expect(readFileSync(join(env.userData, 'settings.json'), 'utf8')).not.toContain('pottery studio');
    // A change to the brief shows the next time the list is asked for.
    writeFileSync(join(described, BRIEF_FILE), JSON.stringify({ schemaVersion: SCHEMA_VERSION, description: 'Now a ceramics school.', notes: '' }));
    expect((await settings.recents()).find((r) => r.dir === described)?.description).toBe('Now a ceramics school.');
  });

  it('reads a stored description defensively', () => {
    expect(storedBriefDescription(null)).toBe('');
    expect(storedBriefDescription('nope')).toBe('');
    expect(storedBriefDescription('[1]')).toBe('');
    expect(storedBriefDescription('{"description": 4}')).toBe('');
    expect(storedBriefDescription('{"description": " Pots "}')).toBe('Pots');
  });

  it('finds a project by its description, all of it, as well as by its name and folder', () => {
    const long = `${'A studio site. '.repeat(20)}Saturday wheel classes`;
    const all = [recent('/Users/ana/Websites/client-a', 'Client A', long), recent('/Users/ana/Websites/client-b', 'Client B'), recent('/Users/ana/Websites/wheel', 'Wheel')];
    expect(matchesFilter(all[0], 'saturday wheel')).toBe(true);
    expect(recentGroups(all, 'saturday wheel').recent.map((r) => r.name)).toEqual(['Client A']);
    expect(recentGroups(all, 'wheel').recent.map((r) => r.name)).toEqual(['Client A', 'Wheel']);
    expect(recentGroups(all, 'client-b').recent.map((r) => r.name)).toEqual(['Client B']);
  });
});

describe('typing in the brief while the AI works', () => {
  it('is held as an edit of its own field, and applies unless that field changed meanwhile', () => {
    const s = apply(fresh(), [{ type: 'brief.update', description: DESCRIPTION }]);
    const op: EditOperation = { type: 'brief.update', notes: NOTES };
    const reads = readFields(s, [op]);
    expect(reads).toEqual([{ found: true, value: { notes: '' } }]);
    expect(typedText(op)).toBe(NOTES);
    expect(shownField(op, { notes: 'Earlier notes' })).toBe('Earlier notes');
    expect(placeOf(s, op)).toBe('Project brief');
    const base = reads!.map((r) => (r.found ? r.value : undefined));
    // A change to the description meanwhile is another field's.
    expect(checkHeld(apply(s, [{ type: 'brief.update', description: 'Changed' }]), [op], base)).toEqual({ kind: 'apply' });
    expect(checkHeld(apply(s, [{ type: 'brief.update', notes: 'Changed elsewhere' }]), [op], base).kind).toBe('changed');
  });

  it('quotes long notes cut short in the held edit’s status, which is read out', () => {
    const long = `${'Notes about the client. '.repeat(40)}END`;
    const { message } = heldPrompt({ phase: 'changed', text: long, currentText: long }, false);
    expect(message).not.toContain('END');
    expect(message).toMatch(/…”/);
    expect(message.length).toBeLessThan(260);
    expect(heldPrompt({ phase: 'changed', text: 'x', currentText: 'Short notes' }, false).message).toContain('“Short notes”');
  });
});
