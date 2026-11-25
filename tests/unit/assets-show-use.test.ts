// A page's sharing image, shown from the Assets panel, opens that page's settings in the Inspector even while the
// AI tab (the right panel's default view since #696) is showing, and leaves Preview as it was.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import type { ProjectState } from '@shared/types';
import type { ImageUseRow } from '../../src/renderer/src/lib/asset-uses';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => undefined }, platform: 'darwin' }, addEventListener: () => undefined, removeEventListener: () => undefined });
const selected: unknown[][] = [];
vi.mock('../../src/renderer/src/lib/actions', async (original) => ({ ...(await original<object>()), selectPage: (...args: unknown[]) => void selected.push(args) }));

interface Editor {
  rightTab: string;
  dockOpen: boolean;
  mode: string;
}
const load = (path: string) => import(/* @vite-ignore */ path);
let showUse: (state: ProjectState, u: ImageUseRow) => (() => void) | undefined;
let store: { getState: () => Editor; setState: (p: Partial<Editor>) => void };
beforeAll(async () => {
  ({ showUse } = await load('../../src/renderer/src/panels/AssetsPanel'));
  store = await load('../../src/renderer/src/store');
});

describe('showing an image used as a page’s sharing image', () => {
  it('selects that page with the Inspector open, from the AI tab and in Preview', () => {
    const state = createStarterState('business', 'Studio', false);
    const pageId = state.site.pageOrder.find((id) => id !== state.site.homePageId)!;
    store.setState({ rightTab: 'chat', dockOpen: false, mode: 'preview' });
    const row = { key: 'k', icon: 'page', where: state.pages[pageId].title, what: 'Sharing image', setting: { pageId }, target: { kind: 'pageSharing', pageId } } as unknown as ImageUseRow;
    showUse(state, row)!();
    expect(selected).toEqual([[pageId, null]]);
    expect(store.getState()).toMatchObject({ rightTab: 'inspect', dockOpen: true, mode: 'preview' });
  });
});
