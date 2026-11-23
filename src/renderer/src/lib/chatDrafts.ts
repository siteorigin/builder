import type { LocalWorkspaceState } from '@shared/api';

/**
 * Unsent AI messages, one per conversation, so each thread keeps its own composer text. They are saved in the
 * project's workspace state, which belongs to that project alone.
 */
export type ChatDrafts = Record<string, string>;

/** The unsent message for a conversation: '' when it has none, or before any conversation is shown. */
export function draftFor(drafts: ChatDrafts, conversationId: string | null | undefined): string {
  return (conversationId && Object.hasOwn(drafts, conversationId) && drafts[conversationId]) || '';
}

/** The drafts with one conversation's text replaced. Empty text removes its entry; no change returns the same object. */
export function withDraft(drafts: ChatDrafts, conversationId: string, text: string): ChatDrafts {
  if (draftFor(drafts, conversationId) === text) return drafts;
  const next = { ...drafts };
  if (text) next[conversationId] = text;
  else delete next[conversationId];
  return next;
}

/** Clear a sent message from its conversation, unless the draft has changed since it was sent. */
export function afterSend(drafts: ChatDrafts, conversationId: string, sent: string): ChatDrafts {
  return draftFor(drafts, conversationId) === sent ? withDraft(drafts, conversationId, '') : drafts;
}

/** The drafts with one conversation's draft moved to another (a new conversation standing in for an unsaved one). */
export function moveDraft(drafts: ChatDrafts, from: string, to: string): ChatDrafts {
  if (from === to || !draftFor(drafts, from)) return drafts;
  return withDraft(withDraft(drafts, to, draftFor(drafts, from)), from, '');
}

/**
 * Drafts written in a new conversation that was left before anything was sent. Such a conversation is never saved,
 * so these are listed with the earlier conversations, where the draft can be picked up again.
 */
export function unsentDrafts(drafts: ChatDrafts, savedIds: string[], openId: string | null | undefined): Array<{ id: string; text: string }> {
  const saved = new Set(savedIds);
  return Object.entries(drafts)
    .filter(([id, text]) => id !== openId && !saved.has(id) && text.trim())
    .map(([id, text]) => ({ id, text }));
}

/** Drafts read from a workspace file: only non-empty text keyed by a conversation ID survives. */
export function cleanDrafts(raw: unknown): ChatDrafts {
  const out: ChatDrafts = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, text] of Object.entries(raw)) if (/^c_[a-z0-9]+$/.test(id) && typeof text === 'string' && text) out[id] = text;
  return out;
}

/**
 * Which conversation to show when a project opens: the one that was open when it was last used, so its draft comes
 * back with it. A conversation that was never sent to is not saved, so one holding a draft comes back as a new
 * conversation carrying that draft ('fresh'): both are empty, so no other thread's context is involved.
 */
export type RestorePlan = { kind: 'active' } | { kind: 'open'; id: string } | { kind: 'fresh'; from: string };

export function restorePlan(remembered: string | undefined, activeId: string, savedIds: string[], drafts: ChatDrafts): RestorePlan {
  if (!remembered || remembered === activeId) return { kind: 'active' };
  if (savedIds.includes(remembered)) return { kind: 'open', id: remembered };
  if (draftFor(drafts, remembered)) return { kind: 'fresh', from: remembered };
  return { kind: 'active' };
}

export interface ChatPersistState {
  /** The opening of the project (its snapshot's workspaceKey), or null when none is open. */
  key: string | null;
  drafts: ChatDrafts;
  conversationId: string | null;
}

/**
 * What to save after the composer state changed, and for which opening of a project: edits and conversation
 * switches are saved to the project they happened in. Loading a project's own state, or leaving it, saves nothing.
 */
export function chatStatePatch(prev: ChatPersistState, next: ChatPersistState): { key: string; patch: LocalWorkspaceState } | null {
  if (!next.key || next.key !== prev.key) return null;
  const patch: LocalWorkspaceState = {};
  if (next.drafts !== prev.drafts) patch.chatDrafts = next.drafts;
  if (next.conversationId && next.conversationId !== prev.conversationId) patch.chatConversation = next.conversationId;
  return Object.keys(patch).length ? { key: next.key, patch } : null;
}
