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
