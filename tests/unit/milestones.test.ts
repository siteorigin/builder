/**
 * Automatic versions at a project's milestones (#1156): a "Starting version" for a project that has never had a version
 * saved, and "Before changing theme" before a theme switch, which a failure to save stops. Ordinary edits, undo and
 * redo save none. Each runs with Git snapshots off (the plain store) and on (the project's versions repository).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { BEFORE_THEME, ProjectSession, STARTING_VERSION } from '../../src/main/project/session';
import { VersionStore, type SavedVersion } from '../../src/main/project/versions';
import { inProcessGit, useTestGit } from './fixtures/git-in-process';

const git = inProcessGit();
let stopGit: () => void = () => undefined;
beforeAll(() => {
  stopGit = useTestGit(git);
});
afterAll(() => stopGit());
beforeEach(() => {
  git.enabled = false;
});

type Mode = 'objects' | 'git';
/** Run with Git snapshots off and on; every listed version is checked to be in the store its run used. */
const both = (name: string, fn: (mode: Mode) => Promise<void>) =>
  it.each<Mode>(['objects', 'git'])(
    `${name} [%s]`,
    async (mode) => {
      git.enabled = mode === 'git';
      await fn(mode);
      for (const d of dirs) for (const v of rows(d)) expect(!!v.git, `${v.name} is in ${mode === 'git' ? 'Git' : 'the plain store'}`).toBe(mode === 'git');
    },
    30_000
  );

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function rows(dir: string): SavedVersion[] {
  try {
    return JSON.parse(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).versions;
  } catch {
    return [];
  }
}
async function make(name = 'Milestones') {
  const dir = mkdtempSync(join(tmpdir(), 'so-milestones-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', name, false));
  open.push(s);
  return { dir, s };
}
async function reopen(dir: string, prior?: ProjectSession) {
  if (prior) await prior.close();
  const s = await ProjectSession.open(dir, 'test');
  open.push(s);
  return s;
}
const names = (s: ProjectSession) => s.versionsInfo().list.map((v) => [v.name, v.auto]);
const siteName = (s: ProjectSession, name: string) => s.apply({ operations: [{ type: 'site.update', name }] }, { label: 'Rename', source: 'user' });
const switchTheme = (s: ProjectSession, themeId: string) => s.apply({ operations: [{ type: 'theme.apply', themeId }] }, { label: 'Switch theme', source: 'user' });

describe('the starting version', () => {
  both('is saved once for a new project, and never again on reopening', async (mode) => {
    const { dir, s } = await make();
    expect(await s.recordStartingVersion()).toBe(true);
    expect(names(s)).toEqual([[STARTING_VERSION, true]]);
    // The plain store makes no versions repository.
    expect(existsSync(join(dir, '.siteorigin/versions.git'))).toBe(mode === 'git');
    // Asked again, in this opening or the next, it adds nothing.
    expect(await s.recordStartingVersion()).toBe(false);
    const again = await reopen(dir, s);
    expect(await again.recordStartingVersion()).toBe(false);
    expect(names(again)).toEqual([[STARTING_VERSION, true]]);
  });

  both('holds the project as it was opened, ahead of an edit asked for at once', async () => {
    const { dir, s } = await make('First name');
    const starting = s.recordStartingVersion();
    const edit = siteName(s, 'Second name');
    expect(await starting).toBe(true);
    expect((await edit).ok).toBe(true);
    const again = await reopen(dir, s);
    const v = again.versionsInfo().list[0];
    const review = await again.reviewVersion(v.id);
    expect(review.review?.site).toBe(true);
    const back = await again.restoreVersion(v.id, again.revision, { files: review.review!.files, replaced: review.review!.replaced });
    expect(back.ok).toBe(true);
    expect(again.state.site.name).toBe('First name');
  });

  both('is saved on the first writable opening of a project without one', async () => {
    const { dir, s } = await make();
    const again = await reopen(dir, s);
    expect(again.versionsInfo().list).toEqual([]);
    expect(await again.recordStartingVersion()).toBe(true);
    expect(names(again)).toEqual([[STARTING_VERSION, true]]);
  });

  both('is not saved again once every version was deleted', async () => {
    const { dir, s } = await make();
    await s.recordStartingVersion();
    expect((await s.deleteVersion(s.versionsInfo().list[0].id)).ok).toBe(true);
    const again = await reopen(dir, s);
    expect(await again.recordStartingVersion()).toBe(false);
    expect(again.versionsInfo().list).toEqual([]);
  });

  it('is never saved for a project opened read-only, which is left as it is', async () => {
    const { dir, s } = await make();
    await s.close();
    const ro = await ProjectSession.openReadOnly(dir, { reason: 'Open elsewhere.', canUnlock: false });
    open.push(ro);
    expect(await ro.recordStartingVersion()).toBe(false);
    expect(existsSync(join(dir, '.siteorigin/versions/versions.json'))).toBe(false);
  });

  it('is never saved while the list of versions is unreadable', async () => {
    const { dir, s } = await make();
    await s.close();
    mkdirSync(join(dir, '.siteorigin/versions'), { recursive: true });
    writeFileSync(join(dir, '.siteorigin/versions/versions.json'), '{ not json');
    const again = await reopen(dir);
    const stored = vi.spyOn(VersionStore.prototype, 'putText');
    expect(await again.recordStartingVersion()).toBe(false);
    expect(stored).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, '.siteorigin/versions/versions.json'), 'utf8')).toBe('{ not json');
  });

  both('that fails leaves the project usable, says so, and is tried again on the next opening', async () => {
    const { dir, s } = await make();
    const add = vi.spyOn(VersionStore.prototype, 'add').mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    expect(await s.recordStartingVersion()).toBe(false);
    expect(s.recoveryNotes.join(' ')).toMatch(/starting version of this project could not be saved.*ENOSPC/);
    expect(s.versionsInfo().list).toEqual([]);
    // The project is as usable as ever.
    expect((await siteName(s, 'Still editable')).ok).toBe(true);
    add.mockRestore();
    const again = await reopen(dir, s);
    expect(await again.recordStartingVersion()).toBe(true);
    expect(names(again)).toEqual([[STARTING_VERSION, true]]);
  });

  both('stops at once when the project closes, listing nothing', async () => {
    const { dir, s } = await make();
    // Held once it has begun, as a large library would hold it, while the project closes.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const check = VersionStore.prototype.checkFolders;
    const begun = vi.spyOn(VersionStore.prototype, 'checkFolders').mockImplementation(async function (this: VersionStore, objects?: boolean) {
      await held;
      return check.call(this, objects);
    });
    const stored = vi.spyOn(VersionStore.prototype, 'putText');
    const starting = s.recordStartingVersion();
    await vi.waitFor(() => expect(begun).toHaveBeenCalled());
    const closing = s.close();
    const calls = git.calls.length;
    release();
    await closing;
    expect(await starting).toBe(false);
    // Nothing more was stored once the project began closing: no document, and nothing sent to Git.
    expect(stored).not.toHaveBeenCalled();
    expect(git.calls.length).toBe(calls);
    expect(rows(dir)).toEqual([]);
    expect(s.recoveryNotes).toEqual([]);
  });
});

describe('before changing theme', () => {
  both('saves the site as it was first, which a restore brings back', async () => {
    const { s } = await make();
    const before = s.state.site.themeId;
    expect(before).not.toBe('foundation-alt');
    expect((await switchTheme(s, 'foundation-alt')).ok).toBe(true);
    expect(s.state.site.themeId).toBe('foundation-alt');
    expect(names(s)).toEqual([[BEFORE_THEME, true]]);
    const v = s.versionsInfo().list[0];
    const review = (await s.reviewVersion(v.id)).review!;
    expect((await s.restoreVersion(v.id, s.revision, { files: review.files, replaced: review.replaced })).ok).toBe(true);
    expect(s.state.site.themeId).toBe(before);
  });

  both('reuses a version that already holds exactly the site as it is', async () => {
    const { s } = await make();
    expect(await s.recordStartingVersion()).toBe(true);
    expect((await switchTheme(s, 'foundation-alt')).ok).toBe(true);
    // Nothing changed since the starting version: it stands for the site before the switch.
    expect(names(s)).toEqual([[STARTING_VERSION, true]]);
    // Switching back saves the site as it is now, on the other theme.
    expect((await switchTheme(s, 'foundation')).ok).toBe(true);
    expect(names(s)).toEqual([
      [BEFORE_THEME, true],
      [STARTING_VERSION, true]
    ]);
  });

  both('that fails leaves the theme, the documents and the revision as they were', async () => {
    const { dir, s } = await make();
    const site = readFileSync(join(dir, 'siteorigin/site.json'), 'utf8');
    const revision = s.revision;
    vi.spyOn(VersionStore.prototype, 'add').mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    const r = await switchTheme(s, 'foundation-alt');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/could not be saved first, so the theme was not changed.*ENOSPC/);
    expect(s.state.site.themeId).toBe('foundation');
    expect(s.revision).toBe(revision);
    expect(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8')).toBe(site);
    expect(s.versionsInfo().list).toEqual([]);
  });

  it('saves nothing for an AI request’s own switch, whose stop takes it back', async () => {
    const { s } = await make();
    expect(await s.beginRun('run_theme')).toBeNull();
    const ai = { label: 'AI', source: 'ai' as const, runId: 'run_theme', history: false };
    expect((await s.apply({ operations: [{ type: 'page.create', title: 'Provisional' }] }, ai)).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation-alt' }] }, ai)).ok).toBe(true);
    expect(s.versionsInfo().list).toEqual([]);
    await s.abortRun();
    expect(s.state.site.themeId).toBe('foundation');
    expect(s.versionsInfo().list).toEqual([]);
  });

  both('saves nothing for ordinary edits, a switch to the same theme, undo or redo', async () => {
    const { s } = await make();
    const calls = git.calls.length;
    expect((await siteName(s, 'Renamed')).ok).toBe(true);
    expect((await switchTheme(s, 'foundation')).ok).toBe(true);
    expect(s.versionsInfo().list).toEqual([]);
    expect((await switchTheme(s, 'foundation-alt')).ok).toBe(true);
    expect(s.versionsInfo().list).toHaveLength(1);
    const after = git.calls.length;
    expect((await s.undo()).ok).toBe(true);
    expect((await s.redo()).ok).toBe(true);
    expect((await siteName(s, 'Renamed again')).ok).toBe(true);
    expect(s.versionsInfo().list).toHaveLength(1);
    // Only the switch reached Git.
    expect(git.calls.length).toBe(after);
    if (!git.enabled) expect(after).toBe(calls);
  });
});
