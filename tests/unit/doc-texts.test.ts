import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { stateToDocs } from '../../src/main/project/documents';
import { frozen } from '@engine/draft';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSession } from '../../src/main/project/session';

describe('serializing the canonical documents', () => {
  it('writes a document that is the very object it was as the text it had, and a changed one afresh', () => {
    const s = createStarterState('business', 'Texts', false);
    const id = s.site.pageOrder[1];
    let reads = 0;
    const title = s.pages[id].title;
    // The page's title counts its reads.
    const watched = Object.defineProperty({ ...s.pages[id] }, 'title', { get: () => (reads++, title), enumerable: true, configurable: true });
    const s1: ProjectState = frozen({ ...s, pages: { ...s.pages, [id]: watched } });
    reads = 0;
    const first = stateToDocs(s1);
    expect(reads).toBe(1);
    // A later state holding the very same page: its text is the one it had, not read again.
    const homeId = s.site.homePageId;
    const hero = Object.values(s1.pages[homeId].nodes).find((n) => n.kind === 'instance' && typeof n.props.heading === 'string')!;
    const s2 = applyOperations(s1, [{ type: 'instance.setProp', owner: { kind: 'page', id: homeId }, nodeId: hero.id, prop: 'heading', value: 'Changed' } as EditOperation]).state;
    expect(s2.pages[id]).toBe(watched);
    frozen(s2);
    reads = 0;
    const second = stateToDocs(s2);
    expect(reads).toBe(0);
    expect(second.get(`siteorigin/pages/${id}.json`)).toBe(first.get(`siteorigin/pages/${id}.json`));
    // The page the edit changed is a new object, written afresh: the same documents as a full copy gives.
    expect(second.get(`siteorigin/pages/${homeId}.json`)).toContain('"heading": "Changed"');
    expect([...second]).toEqual([...stateToDocs(structuredClone(s2))]);
  });

  it('keeps a code component’s text, which leaves its source out, apart from the component itself', () => {
    const s = createStarterState('business', 'Texts', false);
    const def = { id: 'c_code', name: 'Code', owner: 'project', kind: 'code', source: '<p>hi</p>', sourcePath: 'src/lib/components/Code.svelte', properties: {} } as unknown as ProjectState['components'][string];
    const docs = stateToDocs({ ...s, components: { ...s.components, c_code: def } });
    expect(docs.get('siteorigin/components/c_code/component.json')).not.toContain('<p>hi</p>');
    expect(docs.get('src/lib/components/Code.svelte')).toBe('<p>hi</p>');
  });

  it('writes a document that is not frozen afresh every time, since it could have changed', () => {
    const s = createStarterState('business', 'Texts', false);
    const id = s.site.pageOrder[1];
    expect(stateToDocs(s).get(`siteorigin/pages/${id}.json`)).toContain(`"title": "${s.pages[id].title}"`);
    s.pages[id].title = 'Changed in place';
    expect(stateToDocs(s).get(`siteorigin/pages/${id}.json`)).toContain('"title": "Changed in place"');
  });

  it('holds the project frozen, so no one can change a state the session has or had in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-texts-'));
    try {
      const given = createStarterState('business', 'Texts', false);
      const session = await ProjectSession.create(dir, given);
      // The caller's own object stays its own.
      expect(Object.isFrozen(given)).toBe(false);
      const before = session.state;
      const id = before.site.pageOrder[1];
      expect(() => {
        before.pages[id].title = 'Changed in place';
      }).toThrow(TypeError);
      const homeId = before.site.homePageId;
      const hero = Object.values(before.pages[homeId].nodes).find((n) => n.kind === 'instance' && typeof n.props.heading === 'string')!;
      expect((await session.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: homeId }, nodeId: hero.id, prop: 'heading', value: 'Changed' } as EditOperation] }, { label: 'Edit' })).ok).toBe(true);
      // The new state shares the page the edit did not change, frozen still.
      expect(session.state.pages[id]).toBe(before.pages[id]);
      expect(Object.isFrozen(session.state.pages[homeId].nodes[hero.id])).toBe(true);
      expect(() => {
        session.state.pages[id].title = 'Changed in place';
      }).toThrow(TypeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
