/**
 * What the editor puts in front of its page: the SEO view (#700) or the Posts workspace (#578), each over the canvas,
 * which stays loaded underneath. Plain functions over the editor's state, so every reader asks the same question.
 */
import { postWorkspace, type PostRef } from './posts';

/**
 * seo: the SEO view, over the canvas whatever it shows (a page, a post's preview), while the sidebar shows its list.
 * write / preview: the Posts workspace (see postWorkspace). Null while the editor shows its page.
 */
export type Workspace = 'seo' | 'write' | 'preview' | null;

export function activeWorkspace(s: { leftTab: string | null; postView: 'write' | 'preview'; mode: 'edit' | 'preview'; post: PostRef | null }): Workspace {
  return s.leftTab === 'seo' ? 'seo' : postWorkspace(s);
}

/**
 * Whether the canvas is out of sight under a workspace: nothing on it is selected, changed, copied or stepped through
 * by a key until it shows again. A post's preview is on the canvas, so it is not.
 */
export const canvasCovered = (w: Workspace): boolean => w === 'seo' || w === 'write';

/**
 * Whether a change asked of the AI now has nothing to be about: the SEO view is in front with no page or post chosen
 * (or the one chosen has gone), so it would reach the page out of sight under the view. A question changes nothing.
 */
export const changeWithoutDocument = (w: Workspace, chosen: boolean, ask: boolean): boolean => w === 'seo' && !chosen && !ask;

/** The sidebar panel showing before the SEO view opened, which leaving it brings back. */
let panelBeforeSeo: string = 'pages';
export const rememberPanelBeforeSeo = (from: string | null | undefined) => {
  if (from && from !== 'seo') panelBeforeSeo = from;
};
export const panelAfterSeo = () => panelBeforeSeo;
