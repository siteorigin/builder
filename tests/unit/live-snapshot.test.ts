/**
 * The project as a live session's guests are given it (#765): the documents, with nothing of the host's computer in
 * them and nothing the author keeps to themselves.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { HOST_PATH_PLACEHOLDER, liveSnapshot } from '../../src/shared/live/snapshot';

const DIR = '/Users/ann/Sites/acme';
const HOME = '/Users/ann';

/** A project holding a sentinel in every place a guest must not see, and ordinary content that must survive. */
function project(): ProjectState {
  const state = createStarterState('blank', 'Acme', false);
  const home = state.pages[state.site.homePageId];
  home.title = `Notes in ${DIR}/notes.txt and ${HOME}/Desktop, by /Users/anna, at C:\\Users\\ann\\Sites\\acme`;
  home.description = 'Visit /about/ or https://example.com/Users/ann-co/';
  state.manifest.workingCopyName = 'SECRET-working-copy';
  state.brief = { schemaVersion: 1, purpose: 'SECRET-brief' } as never;
  state.sources = { crm: { schemaVersion: 1, id: 'crm', name: 'CRM', adapter: 'rest', collectionId: 'leads', config: { url: 'https://crm.internal/SECRET-source', token: { $secret: 'SECRET-name' } } as never } };
  state.collections = {
    leads: {
      settings: { schemaVersion: 1, id: 'leads', name: 'Leads', sourceId: 'crm' } as never,
      entries: { e1: { id: 'e1', title: 'Lead 17', draft: false, terms: {}, values: {}, body: [], source: { externalId: 'file:///Volumes/ClientIntake/SECRET-lead-17.json' } } as never }
    }
  };
  const authored = { id: 'cmp_mine', name: 'Mine', kind: 'code', owner: 'project', source: '<p>SECRET-authored-code</p>', sourcePath: 'src/lib/components/custom/Mine.svelte', properties: {} } as unknown as ComponentDefinition;
  const shipped = { id: 'theme_form', name: 'Form', kind: 'code', owner: 'theme', source: '<form>theme code</form>', sourcePath: 'theme/Form.svelte', properties: {} } as unknown as ComponentDefinition;
  state.components[authored.id] = authored;
  state.components[shipped.id] = shipped;
  return state;
}

const share = (state = project(), hostPaths = [DIR, HOME]) => liveSnapshot({ state, revision: 7, readOnly: true, aiBusy: false, runtime: 'ready' }, hostPaths);

describe('the project as guests are given it', () => {
  it('holds only the documents and whether they can be edited now', () => {
    const snap = share();
    expect(Object.keys(snap).sort()).toEqual(['aiBusy', 'readOnly', 'revision', 'runtime', 'state']);
    expect(snap).toMatchObject({ revision: 7, readOnly: true, aiBusy: false, runtime: { state: 'ready' } });
    expect(Object.keys(snap.state).sort()).toEqual(['assets', 'collections', 'components', 'manifest', 'pages', 'site', 'themeLock', 'tokens'].sort());
  });

  it('leaves out what stays the author’s: the brief, sources, their working copy’s name, their code and where entries were synced from', () => {
    const text = JSON.stringify(share());
    expect(text).not.toMatch(/SECRET/);
    expect(text).not.toContain('sourcePath');
    const snap = share();
    // A theme's own code ships with the app, so it stays.
    expect(snap.state.components.theme_form).toMatchObject({ source: '<form>theme code</form>' });
    expect(snap.state.components.cmp_mine).not.toHaveProperty('source');
    expect(snap.state.collections.leads.entries.e1).toMatchObject({ title: 'Lead 17' });
  });

  it('replaces the host’s folders wherever text names them, and nothing that only looks like them', () => {
    const snap = share();
    const home = snap.state.pages[snap.state.site.homePageId];
    // Written with either slash: a path the host's system would also read.
    expect(home.title).toBe(`Notes in ${HOST_PATH_PLACEHOLDER}/notes.txt and ${HOST_PATH_PLACEHOLDER}/Desktop, by /Users/anna, at C:${HOST_PATH_PLACEHOLDER}`);
    expect(home.description).toBe('Visit /about/ or https://example.com/Users/ann-co/');
    expect(JSON.stringify(snap)).not.toContain(DIR);
    // A Windows host's folders, with either slash.
    const windows = share(project(), ['C:\\Users\\ann\\Sites\\acme', 'C:\\Users\\ann']);
    expect(windows.state.pages[windows.state.site.homePageId].title).toContain(`at ${HOST_PATH_PLACEHOLDER}`);
  });

  it('never takes a folder too short to tell from ordinary text', () => {
    const snap = share(project(), ['/', '']);
    expect(snap.state.pages[snap.state.site.homePageId].description).toBe('Visit /about/ or https://example.com/Users/ann-co/');
  });

  it('leaves the host’s project as it was', () => {
    const state = project();
    const before = JSON.stringify(state);
    share(state);
    expect(JSON.stringify(state)).toBe(before);
  });
});
