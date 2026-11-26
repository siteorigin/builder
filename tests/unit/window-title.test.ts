import { describe, expect, it } from 'vitest';
import { projectDisplayName, windowTitle } from '../../src/shared/project-name';

describe('windowTitle (#811)', () => {
  it('names the open project before the app', () => {
    expect(windowTitle('Tide & Timber')).toBe('Tide & Timber — SiteOrigin Builder');
  });

  it('is the app’s name alone with no project open, or with nothing to name it by', () => {
    expect(windowTitle(null)).toBe('SiteOrigin Builder');
    expect(windowTitle('   ')).toBe('SiteOrigin Builder');
  });

  it('names a working copy by its own name, whatever its site is called', () => {
    const state = { manifest: { workingCopyName: 'Tide & Timber (client draft)' }, site: { name: 'Tide & Timber' } };
    expect(windowTitle(projectDisplayName(state))).toBe('Tide & Timber (client draft) — SiteOrigin Builder');
  });
});
