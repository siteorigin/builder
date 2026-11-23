import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { canOpen, changeTarget, checksOf } from '../../src/renderer/src/lib/result';

describe('AI result card', () => {
  it('counts only passing checks as passed, keeping unchecked ones apart from site problems', () => {
    const r = checksOf({
      validation: [],
      checks: [
        { status: 'pass', text: 'Fits the screen at phone width.' },
        { status: 'issue', text: 'An image failed to load at phone width (gone.jpg).' },
        { status: 'unverified', text: "Couldn't confirm that an image loaded at desktop width." },
        { status: 'pass', text: 'All components build without errors.' }
      ]
    });
    expect(r.passes).toHaveLength(2);
    expect(r.issues).toEqual(['An image failed to load at phone width (gone.jpg).']);
    expect(r.unverified).toEqual(["Couldn't confirm that an image loaded at desktop width."]);
  });

  it('still reads results stored before checks had a status from their wording', () => {
    const r = checksOf({ validation: ['Fits the screen at phone width.', 'Content is wider than the screen at tablet width.', "Couldn't check the layout at desktop width.", '2 pre-existing issues remain.'] });
    expect(r.passes).toEqual(['Fits the screen at phone width.']);
    expect(r.issues).toHaveLength(3);
    expect(r.unverified).toEqual([]);
  });

  it('opens page elements, shared header elements on a page that shows them, and says when one is gone', () => {
    let state = createStarterState('business', 'Test', false);
    const [home, about] = state.site.pageOrder;
    state = applyOperations(state, [{ type: 'page.update', pageId: about, shell: 'none' }]).state;
    const hero = state.pages[home].rootIds[0];
    const nav = state.site.shell.header.rootIds[0];
    const header = { kind: 'shell' as const, id: 'header' };

    expect(changeTarget(state, about, { label: 'x', pageId: home, nodeId: hero })).toEqual({ pageId: home, selection: { owner: { kind: 'page', id: home }, instancePath: [], nodeId: hero } });
    // The page on screen has no header, so the header is shown on the first page that has one.
    expect(changeTarget(state, about, { label: 'x', owner: header, nodeId: nav })).toEqual({ pageId: home, selection: { owner: header, instancePath: [], nodeId: nav } });
    expect(changeTarget(state, home, { label: 'x', pageId: home, nodeId: 'gone' })).toMatchObject({ pageId: home, selection: null, note: expect.stringMatching(/no longer on Home/) });
    expect(changeTarget(state, home, { label: 'x', pageId: 'pg_missing' })).toEqual({ error: 'That page is no longer in the site.' });
    expect(changeTarget(state, home, { label: 'Changed the site style “Brand”' })).toBeNull();

    expect(canOpen({ label: 'x', owner: header, nodeId: nav })).toBe(true);
    expect(canOpen({ label: 'x', owner: { kind: 'component', id: 'c' }, definitionId: 'c', nodeId: 'n' })).toBe(false);
  });
});
