/**
 * The project as a live session's guests are given it (#765): the documents, with nothing of the host's computer in
 * them and nothing the author keeps to themselves.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord, ComponentDefinition, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { HOST_PATH_PLACEHOLDER as P, liveSnapshot, scrubHostPaths } from '../../src/shared/live/snapshot';

const DIR = '/Users/ann/Sites/acme';
const HOME = '/Users/ann';
const PUBLIC = 'Visit /about/ or https://example.com/Users/ann-co/ or https://example.org/Users/ann/profile';

/** A project holding a sentinel in every place a guest must not see, and ordinary content that must survive. */
function project(): ProjectState {
  const state = createStarterState('blank', 'Acme', false);
  const home = state.pages[state.site.homePageId];
  home.title = `Notes in ${DIR}/notes.txt and ${HOME}/Desktop, by /Users/anna`;
  home.navLabel = PUBLIC;
  state.manifest.workingCopyName = 'SECRET-working-copy';
  state.brief = { schemaVersion: 1, purpose: 'SECRET-brief' } as never;
  state.sources = { crm: { schemaVersion: 1, id: 'crm', name: 'CRM', adapter: 'rest', collectionId: 'leads', config: { url: 'https://crm.internal/SECRET-source', token: { $secret: 'SECRET-name' } } as never } };
  state.collections = {
    leads: {
      settings: { schemaVersion: 1, id: 'leads', name: 'Leads', sourceId: 'crm' } as never,
      entries: { e1: { id: 'e1', title: 'Lead 17', draft: false, terms: {}, values: { files: [`${DIR}/static/a.pdf`, 'plain'] }, body: [], source: { externalId: 'file:///Volumes/ClientIntake/SECRET-lead-17.json' } } as never }
    }
  };
  const authored = { id: 'cmp_mine', name: 'Mine', kind: 'code', owner: 'project', source: '<p>SECRET-authored-code</p>', sourcePath: 'src/lib/components/custom/Mine.svelte', properties: {} } as unknown as ComponentDefinition;
  // A theme's component, whose code in the project the author may have changed.
  const themed = { id: 'theme_form', name: 'Form', kind: 'code', owner: 'theme', source: '<form><!-- SECRET-edited --></form>', sourcePath: 'theme/Form.svelte', properties: {} } as unknown as ComponentDefinition;
  state.components[authored.id] = authored;
  state.components[themed.id] = themed;
  const photo: AssetRecord = { id: 'a1', name: 'Shop front', file: 'static/assets/a1.jpg', mime: 'image/jpeg', bytes: 1, hash: 'h', kind: 'image', originalName: 'SECRET-IMG_4821.HEIC', createdAt: '2026-01-01T00:00:00.000Z' };
  state.assets.assets[photo.id] = photo;
  // A host path as a key, which no document should have but one edited by hand might.
  (state.site as unknown as Record<string, unknown>)[`${DIR}/note`] = 'x';
  return state;
}

const share = (state = project(), hostPaths = [DIR, HOME]) => liveSnapshot({ state, revision: 7, readOnly: true, aiBusy: true, runtime: 'starting' }, hostPaths);

describe('the project as guests are given it', () => {
  it('holds only the documents and whether they can be edited now', () => {
    const snap = share();
    expect(Object.keys(snap).sort()).toEqual(['aiBusy', 'readOnly', 'revision', 'runtime', 'state']);
    expect(snap).toMatchObject({ revision: 7, readOnly: true, aiBusy: true, runtime: { state: 'starting' } });
    expect(Object.keys(snap.state).sort()).toEqual(['assets', 'collections', 'components', 'manifest', 'pages', 'site', 'themeLock', 'tokens'].sort());
  });

  it('leaves out what stays the author’s: the brief, sources, their working copy’s name, code, file names and where entries came from', () => {
    const snap = share();
    expect(JSON.stringify(snap)).not.toMatch(/SECRET/);
    for (const id of ['cmp_mine', 'theme_form']) {
      expect(snap.state.components[id]).not.toHaveProperty('source');
      expect(snap.state.components[id]).not.toHaveProperty('sourcePath');
    }
    expect(snap.state.assets.assets.a1).toMatchObject({ name: 'Shop front', file: 'static/assets/a1.jpg' });
    expect(snap.state.assets.assets.a1).not.toHaveProperty('originalName');
    expect(snap.state.collections.leads.entries.e1).toMatchObject({ title: 'Lead 17' });
    expect(snap.state.collections.leads.entries.e1).not.toHaveProperty('source');
    expect(snap.state.manifest).not.toHaveProperty('workingCopyName');
  });

  it('replaces the host’s folders wherever text names them, keys and lists included', () => {
    const snap = share();
    expect(snap.state.pages[snap.state.site.homePageId].title).toBe(`Notes in ${P}/notes.txt and ${P}/Desktop, by /Users/anna`);
    expect((snap.state.collections.leads.entries.e1 as unknown as { values: { files: string[] } }).values.files).toEqual([`${P}/static/a.pdf`, 'plain']);
    expect(Object.keys(snap.state.site)).toContain(`${P}/note`);
    expect(JSON.stringify(snap).toLowerCase()).not.toContain(`${DIR}`.toLowerCase());
  });

  it('leaves web addresses and other people’s folders as they are', () => {
    const snap = share();
    expect(snap.state.pages[snap.state.site.homePageId].navLabel).toBe(PUBLIC);
    expect(scrubHostPaths('See https://example.org/Users/ann/profile and /Users/anna and /Users/ann.backup', [HOME])).toBe('See https://example.org/Users/ann/profile and /Users/anna and /Users/ann.backup');
  });

  it('finds a host folder at a sentence’s end, in any case, in a file address, and with either slash', () => {
    expect(scrubHostPaths(`Files are in ${HOME}. Or /users/ANN/Desktop! Or file://${DIR}/a.html`, [DIR, HOME])).toBe(`Files are in ${P}. Or ${P}/Desktop! Or file://${P}/a.html`);
    expect(scrubHostPaths('At C:\\Users\\ann\\Sites\\acme and C:/Users/ann/Desktop', ['C:\\Users\\ann\\Sites\\acme', 'C:\\Users\\ann'])).toBe(`At ${P} and ${P}/Desktop`);
  });

  it('never takes a folder too short to tell from ordinary text', () => {
    expect(scrubHostPaths('Visit /ab/c and / here', ['/', '', '/ab'])).toBe('Visit /ab/c and / here');
  });

  it('leaves the host’s project as it was', () => {
    const state = project();
    const before = JSON.stringify(state);
    share(state);
    expect(JSON.stringify(state)).toBe(before);
  });
});
