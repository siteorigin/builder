import type { ChatContext } from '@shared/api';
import type { ProjectState } from '@shared/types';
import type { RunDelegation } from '@agent/orchestrator';
import type { LiveHostAi } from './host';

/** What the bridge needs of the app: the open project, its opening, and the assistant's own calls. */
export interface LiveHostAiDeps {
  /** The open project's documents, or null while none is open. */
  state(): ProjectState | null;
  /** The opening the open project is in (its snapshot's workspaceKey), or null. */
  opening(): string | null;
  /** Send a request to the assistant, with the same checks and limits as the author's own (index.ts sendAi). */
  send(text: string, context: ChatContext, delegation: RunDelegation): Promise<{ ok: boolean; runId?: string; message?: string }>;
  stop(runId: string): Promise<unknown>;
  answer(runId: string, questionId: string, answer: string): boolean;
}

/**
 * The host's assistant as live-session collaborators reach it (#769), for LiveHostManager.ai. A collaborator's request
 * names the page it shows, or the element selected there, and nothing else: the request the assistant is given is an
 * edit of that, made in the project opening the session belongs to, sent to whichever model this computer's Settings
 * choose. The page's title is the host's, read here, never the guest's word for it.
 */
export function liveHostAi(deps: LiveHostAiDeps): LiveHostAi {
  return {
    send: async (opening, text, context, delegation) => {
      const state = deps.state();
      if (!state || deps.opening() !== opening) return { ok: false, message: 'The host’s project is not open.' };
      const page = Object.hasOwn(state.pages, context.pageId) ? state.pages[context.pageId] : undefined;
      if (!page) return { ok: false, message: 'That page is no longer in the site.' };
      const chat: ChatContext = {
        pageId: context.pageId,
        pageTitle: page.title,
        selection: context.selection,
        selectionLabel: context.selectionLabel ?? null,
        viewport: context.viewport,
        mode: 'edit',
        scope: context.scope
      };
      return deps.send(text, chat, delegation);
    },
    stop: (runId) => deps.stop(runId),
    answer: (runId, questionId, answer) => deps.answer(runId, questionId, answer)
  };
}
