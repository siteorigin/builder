import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { frozen } from '@engine/draft';
import { generateProject } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { ProjectSession } from '../../src/main/project/session';

// What keeps a project state alive once the project has moved on (#1038): nothing of a session or its generation cache
// may, or every save leaves a copy of the project behind for as long as it is open.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** Whether what `ref` pointed to has been collected, after a few collections, each in a turn of its own. */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    // A WeakRef keeps what it was read for to the end of the turn: collected only in the next one.
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  return ref.deref() === undefined;
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const rename = (s: ProjectState, name: string) => frozen(applyOperations(s, [{ type: 'site.update', name }]).state);

describe('what a project keeps of states it has left (#1038)', () => {
  it('keeps no state the generation cache made files from once it has made them from the next', async () => {
    const cache = new GenerationCache();
    const generate = (s: ProjectState) => {
      for (const instrument of [false, true]) generateProject(s, { instrument }, cache);
    };
    // Made in a function of its own, so nothing here holds the first state but the WeakRef.
    const first = (): { ref: WeakRef<ProjectState>; next: ProjectState } => {
      const a = frozen(createStarterState('business', 'Kept', false));
      generate(a);
      const next = rename(a, 'Moved on');
      generate(next);
      return { ref: new WeakRef(a), next };
    };
    const { ref, next } = first();
    expect(await collected(ref)).toBe(true);
    // The cache still serves the state it holds: a change to the next one makes only what it reaches.
    generate(rename(next, 'Again'));
    expect(cache.made.length).toBeGreaterThan(0);
  });

  it('keeps nothing of the state it last made files from between runs', async () => {
    const cache = new GenerationCache();
    // A state generated and dropped, as a save refused after its files were made leaves it: only the WeakRef holds it.
    const made = (): WeakRef<ProjectState> => {
      const a = frozen(createStarterState('business', 'Refused', false));
      for (const instrument of [false, true]) generateProject(a, { instrument }, cache);
      return new WeakRef(a);
    };
    expect(await collected(made())).toBe(true);
  });

  it('compares a field the next state holds unchanged with that state’s own copy, not the copy it first read', async () => {
    const cache = new GenerationCache();
    const generate = (s: ProjectState) => {
      for (const instrument of [false, true]) generateProject(s, { instrument }, cache);
    };
    const first = (): { ref: WeakRef<object>; next: ProjectState } => {
      const a = frozen(createStarterState('business', 'Kept', false));
      const home = a.pages[a.site.homePageId];
      const [edited, other] = home.rootIds.filter((id) => home.nodes[id].kind === 'instance');
      generate(a);
      // An edit of one placement copies its page: the other placements are new objects holding the same values.
      const next = frozen(applyOperations(a, [{ type: 'node.rename', owner: { kind: 'page', id: home.id }, nodeId: edited, name: 'Edited' }]).state);
      expect(next.pages[home.id].nodes[other]).not.toBe(home.nodes[other]);
      generate(next);
      return { ref: new WeakRef((home.nodes[other] as { props: object }).props), next };
    };
    const { ref, next } = first();
    expect(next.site.name).toBe('Kept');
    expect(await collected(ref)).toBe(true);
  });

  it('keeps no state from before a save', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-retention-'));
    dirs.push(dir);
    const s = await ProjectSession.create(dir, createStarterState('business', 'Kept', false));
    const before = new WeakRef(s.state);
    const saved = await s.apply({ operations: [{ type: 'site.update', name: 'Saved' }] }, { label: 'Rename site' });
    expect(saved.ok).toBe(true);
    expect(s.state.site.name).toBe('Saved');
    expect(await collected(before)).toBe(true);
    await s.close();
  });
});
