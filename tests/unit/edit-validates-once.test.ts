/**
 * An edit checks the project it makes once (#966): the save gate works out what it checks of the new state, and the
 * snapshot after it adds only the advice Project health shows, never the save gate's checks again. The state the edit
 * starts from was checked when it was shown, so the gate takes its problems from that.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';

const cored: ProjectState[] = [];
const advised: ProjectState[] = [];
vi.mock('@engine/validate', async (load) => {
  const real = await load<typeof import('@engine/validate')>();
  return {
    ...real,
    coreValidation: (state: ProjectState, ...rest: unknown[]) => {
      cored.push(state);
      return real.coreValidation(state, ...(rest as []));
    },
    adviceValidation: (state: ProjectState, ...rest: unknown[]) => {
      advised.push(state);
      return real.adviceValidation(state, ...(rest as []));
    }
  };
});

const updated: ProjectState[] = [];
vi.mock('@engine/theme-updates', async (load) => {
  const real = await load<typeof import('@engine/theme-updates')>();
  return {
    ...real,
    themeUpdates: (state: ProjectState) => {
      updated.push(state);
      return real.themeUpdates(state);
    }
  };
});

const { createStarterState } = await import('@catalogue/starters');
const { header } = await import('@catalogue/foundation/shell');
const { definitionHash } = await import('@shared/migrations');
const { ProjectSession } = await import('../../src/main/project/session');
const { adviceValidation, validateState } = await import('@engine/validate');
const { applyOperations } = await import('@engine/apply');
const { themeUpdates } = await import('@engine/theme-updates');

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function opened(state = createStarterState('business', 'Checks', false)) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-edit-checks-')));
  dirs.push(dir);
  await (await ProjectSession.create(dir, state)).close();
  const s = await ProjectSession.open(dir, 'me');
  // The editor's first snapshot.
  s.diagnostics();
  s.themeUpdates();
  cored.length = 0;
  advised.length = 0;
  updated.length = 0;
  return s;
}

/** A project whose installed header is the theme's older version, without its Action style: an update is available. */
function olderHeader() {
  const s = structuredClone(createStarterState('business', 'Older', false));
  const installed = s.components[header.id];
  delete (installed.properties as Record<string, unknown>).ctaStyle;
  const placed = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as { props: Record<string, unknown> };
  delete placed.props.ctaStyle;
  s.themeLock.components[header.id].hash = definitionHash(installed);
  return s;
}

const browserTitle = (s: InstanceType<typeof ProjectSession>, seoTitle: string) => s.apply({ operations: [{ type: 'page.update', pageId: s.state.site.homePageId, seoTitle }] }, { label: 'Edit browser title' });

const times = (list: ProjectState[], state: ProjectState) => list.filter((st) => st === state).length;

describe('an edit (#966)', () => {
  it('checks the state it makes once for the save gate and the snapshot, and the one it starts from not again', async () => {
    const s = await opened();
    try {
      const before = s.state;
      const home = s.state.pages[s.state.site.homePageId];
      const r = await s.apply({ operations: [{ type: 'page.update', pageId: home.id, seoTitle: 'Checked once' }] }, { label: 'Edit browser title' });
      expect(r.ok).toBe(true);
      expect(s.state).not.toBe(before);
      // The save gate has checked the new state; the snapshot adds the advice to it.
      expect(times(cored, s.state)).toBe(1);
      expect(times(advised, s.state)).toBe(0);
      const shown = s.diagnostics();
      expect(times(cored, s.state)).toBe(1);
      expect(times(advised, s.state)).toBe(1);
      expect(times(cored, before)).toBe(0);
      expect(times(advised, before)).toBe(0);
      // What Project health shows is the whole check, in its order.
      expect(shown).toEqual(validateState(s.state));
    } finally {
      await s.close();
    }
  });

  it('shows the advice in its place among the other findings, as the whole check orders them', async () => {
    const s = await opened();
    try {
      const owner = { kind: 'page' as const, id: s.state.site.homePageId };
      // A plan whose button goes to a section the page does not have: advice, which never stops the save.
      const plans = [{ id: 'i_0', name: 'Plan', price: '$1', actionLabel: 'Details', actionLink: '#missing' }];
      const r = await s.apply({ operations: [{ type: 'node.insert', owner, componentId: 'pricing.plans', newNodeId: 'n_plans', props: { plans } }] }, { label: 'Add plans' });
      expect(r.ok).toBe(true);
      const shown = s.diagnostics();
      expect(shown.some((d) => d.code === 'LINK_SECTION_MISSING')).toBe(true);
      expect(shown).toEqual(validateState(s.state));
      expect(times(cored, s.state)).toBe(1);
      expect(times(advised, s.state)).toBe(1);
    } finally {
      await s.close();
    }
  });

  it('keeps the theme updates while there are none and it changed only a page', async () => {
    const s = await opened();
    try {
      expect((await browserTitle(s, 'Kept')).ok).toBe(true);
      const kept = s.themeUpdates();
      expect(times(updated, s.state)).toBe(0);
      expect(kept).toEqual({ available: [], kept: [] });
      expect(kept).toEqual(themeUpdates(s.state));
    } finally {
      await s.close();
    }
  });

  it('keeps them through a change to the site document that names the same theme', async () => {
    const s = await opened();
    try {
      expect((await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' })).ok).toBe(true);
      const kept = s.themeUpdates();
      expect(times(updated, s.state)).toBe(0);
      expect(kept).toEqual(themeUpdates(s.state));
    } finally {
      await s.close();
    }
  });

  it('works the theme updates out again after a change beyond pages, entries and the site, or while there are some', async () => {
    const s = await opened();
    try {
      expect((await s.apply({ operations: [{ type: 'token.create', group: 'color', label: 'Teal', value: '#008080' }] }, { label: 'Add style' })).ok).toBe(true);
      s.themeUpdates();
      expect(times(updated, s.state)).toBe(1);
    } finally {
      await s.close();
    }
    const older = await opened(olderHeader());
    try {
      expect(older.themeUpdates().available.map((a) => a.id)).toEqual([header.id]);
      expect((await browserTitle(older, 'Still offered')).ok).toBe(true);
      expect(older.themeUpdates().available.map((a) => a.id)).toEqual([header.id]);
      expect(times(updated, older.state)).toBe(1);
    } finally {
      await older.close();
    }
  });

  it('undoes with the checks the state it leaves was given, and works out those of the one it restores once', async () => {
    const s = await opened();
    try {
      expect((await browserTitle(s, 'To undo')).ok).toBe(true);
      s.diagnostics();
      const edited = s.state;
      cored.length = 0;
      advised.length = 0;
      expect((await s.undo()).ok).toBe(true);
      expect(s.state).not.toBe(edited);
      expect(times(cored, edited)).toBe(0);
      expect(times(cored, s.state)).toBe(1);
      expect(s.diagnostics()).toEqual(validateState(s.state));
      expect(times(cored, s.state)).toBe(1);
      expect(times(advised, s.state)).toBe(1);
    } finally {
      await s.close();
    }
  });
});

describe('the whole check (#966)', () => {
  it('puts each part of the advice where the single pass put it among the other findings', () => {
    const s = structuredClone(createStarterState('business', 'Order', false));
    const home = s.site.homePageId;
    // Before the section links: a page whose language is not a language code.
    s.pages[home].language = 'not a language';
    // Between the section links and the rest of the advice: a site icon that is not a picture.
    s.assets.assets.a_doc = { id: 'a_doc', name: 'Price list', kind: 'document', file: 'static/assets/price-list.pdf', mime: 'application/pdf', bytes: 100, hash: 'h', createdAt: '2026-01-01T00:00:00.000Z' } as (typeof s.assets.assets)[string];
    s.site.favicon = 'a_doc';
    // After all of the advice: an image too large for a page.
    s.assets.assets.a_big = { id: 'a_big', name: 'Huge photo', kind: 'image', file: 'static/assets/huge.png', mime: 'image/png', bytes: 2_000_000, hash: 'h2', createdAt: '2026-01-01T00:00:00.000Z' } as (typeof s.assets.assets)[string];
    // A section link that goes nowhere, and a second Heading 1 on the page (the rest of the advice).
    const plans = [{ id: 'i_0', name: 'Plan', price: '$1', actionLabel: 'Details', actionLink: '#missing' }];
    const hero = (s.pages[home].nodes[s.pages[home].rootIds[0]] as InstanceNode).definitionId;
    const state = applyOperations(s, [
      { type: 'node.insert', owner: { kind: 'page', id: home }, componentId: 'pricing.plans', newNodeId: 'n_plans', props: { plans } },
      { type: 'node.insert', owner: { kind: 'page', id: home }, parentId: null, index: 0, definitionId: hero }
    ]).state;
    const all = validateState(state);
    const [links, rest] = adviceValidation(state);
    expect(links.length).toBeGreaterThan(0);
    expect(rest.length).toBeGreaterThan(0);
    const at = (pick: (d: (typeof all)[number]) => boolean) => {
      const i = all.findIndex(pick);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const same = (x: (typeof all)[number]) => (d: (typeof all)[number]) => d.code === x.code && d.message === x.message;
    const order = [
      at((d) => d.code === 'LANGUAGE_INVALID'),
      at((d) => d.code === 'LINK_SECTION_MISSING'),
      at((d) => d.code === 'ASSET_NOT_IMAGE' && d.site === 'favicon'),
      at((d) => d.code === 'HEADING_MULTIPLE_H1'),
      at(same(rest[0])),
      at(same(rest[rest.length - 1])),
      at((d) => d.code === 'ASSET_LARGE')
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // And the save gate's check is the same findings without the advice, in the same order.
    const advice = [...links, ...rest].map((d) => JSON.stringify(d));
    expect(validateState(state, { sectionLinks: false })).toEqual(all.filter((d) => !advice.includes(JSON.stringify(d))));
  });
});
