// A page's sharing image, shown from the Assets panel, opens the Inspector at the field even while the AI tab (the
// right panel's default view since #696) is showing.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import type { ImageUseRow } from '../../src/renderer/src/lib/asset-uses';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => undefined }, platform: 'darwin' }, addEventListener: () => undefined, removeEventListener: () => undefined });
const opened: unknown[] = [];
vi.mock('../../src/renderer/src/lib/open-destination', () => ({ openEditorDestination: (d: unknown) => void opened.push(d) }));

let showUse: (typeof import('../../src/renderer/src/panels/AssetsPanel'))['showUse'];
beforeAll(async () => {
  ({ showUse } = await import('../../src/renderer/src/panels/AssetsPanel'));
});

describe('showing an image used as a page’s sharing image', () => {
  it('opens that page’s Search & sharing at the image', () => {
    const state = createStarterState('business', 'Studio', false);
    const pageId = state.site.homePageId;
    const row = { key: 'k', icon: 'page', where: 'Home', what: 'Sharing image', setting: { pageId }, target: { kind: 'pageSharing', pageId } } as unknown as ImageUseRow;
    showUse(state, row)!();
    expect(opened).toEqual([{ kind: 'pageSeo', pageId, field: 'socialImage' }]);
  });
});
