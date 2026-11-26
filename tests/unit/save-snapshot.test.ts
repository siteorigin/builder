// What a snapshot taken while a save is still landing shows. A save writes the documents, then every generated file
// the preview reads, then History; on Windows (NTFS and the virus scanner) the generated files can take a second. A
// snapshot read in that time (the editor's own, or a check after the page has changed) must show the new documents
// with the History and revision that go with them: never the new page beside the undo step and revision of the step
// before, which reads as an edit with no step of its own, or one that joined the step before it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-landing-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Landing', false));
  s.settleMs = 0;
  return { dir, s };
}

interface Seen {
  file: string;
  changed: boolean;
  revision: number;
  applied: string[];
}

/**
 * Slow every file replaced outside the documents and the editor's own folder (the generated site), as a slow disk
 * does, and note what the session shows as each one lands.
 */
function watch(dir: string, s: ProjectSession, before: () => unknown) {
  const seen: Seen[] = [];
  const rename = fsp.rename.bind(fsp);
  vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    const file = relative(dir, String(to)).split(sep).join('/');
    if (/^(siteorigin|\.siteorigin)(\/|$)/.test(file)) return;
    await new Promise((r) => setTimeout(r, 20));
    const h = s.historyInfo();
    seen.push({ file, changed: s.state !== before(), revision: s.revision, applied: h.entries.filter((e) => e.applied).map((e) => e.label) });
  });
  return seen;
}

describe('a snapshot taken while a save lands', () => {
  it('shows a new edit with its own step and revision, never the step before', async () => {
    const { dir, s } = await make();
    const about = s.state.site.pageOrder[1];
    const revision = s.revision;
    const applied = s.historyInfo().entries.filter((e) => e.applied).map((e) => e.label);
    const state = s.state;
    const seen = watch(dir, s, () => state);

    const r = await s.apply({ operations: [{ type: 'page.duplicate', pageId: about, title: 'Our team' }] }, { label: 'Duplicate page' });
    expect(r.ok).toBe(true);
    const landing = seen.filter((x) => x.changed);
    // The generated site was written after the documents: the window this is about.
    expect(landing.length).toBeGreaterThan(0);
    for (const x of landing) {
      expect({ file: x.file, revision: x.revision, applied: x.applied }).toEqual({ file: x.file, revision: revision + 1, applied: [...applied, 'Duplicate page'] });
    }
  });

  it('shows an Undo with its step already taken back', async () => {
    const { dir, s } = await make();
    const about = s.state.site.pageOrder[1];
    expect((await s.apply({ operations: [{ type: 'page.duplicate', pageId: about, title: 'Our team' }] }, { label: 'Duplicate page' })).ok).toBe(true);
    const revision = s.revision;
    const state = s.state;
    const seen = watch(dir, s, () => state);

    expect((await s.undo()).ok).toBe(true);
    const landing = seen.filter((x) => x.changed);
    expect(landing.length).toBeGreaterThan(0);
    for (const x of landing) expect({ file: x.file, revision: x.revision, stillApplied: x.applied.includes('Duplicate page') }).toEqual({ file: x.file, revision: revision + 1, stillApplied: false });
  });
});
