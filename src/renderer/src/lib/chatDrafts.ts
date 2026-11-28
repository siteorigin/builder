import type { LocalWorkspaceState } from '@shared/api';
import { plural } from './storage';

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

/**
 * An answer typed to a waiting question and left unsent, kept as the conversation's unsent message when the project is
 * left (the request stops, and the question comes back as not answered): after any message already being written, so
 * neither is lost.
 */
export function keepAnswer(drafts: ChatDrafts, conversationId: string, answer: string): ChatDrafts {
  if (!answer.trim()) return drafts;
  const draft = draftFor(drafts, conversationId);
  return withDraft(drafts, conversationId, draft.trim() ? `${draft.replace(/\s+$/, '')}\n\n${answer}` : answer);
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
export function unsentDrafts(drafts: ChatDrafts, savedIds: string[], openId: string | null | undefined, images: ChatImages = {}): Array<{ id: string; text: string; images?: number }> {
  const saved = new Set(savedIds);
  // A message with only images attached so far is a draft too.
  const ids = [...new Set([...Object.keys(drafts), ...Object.keys(images)])];
  return ids
    .filter((id) => id !== openId && !saved.has(id) && (draftFor(drafts, id).trim() || imagesFor(images, id).length))
    .map((id) => ({ id, text: draftFor(drafts, id), ...(imagesFor(images, id).length ? { images: imagesFor(images, id).length } : {}) }));
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

export function restorePlan(remembered: string | undefined, activeId: string, savedIds: string[], drafts: ChatDrafts, images: ChatImages = {}): RestorePlan {
  if (!remembered || remembered === activeId) return { kind: 'active' };
  if (savedIds.includes(remembered)) return { kind: 'open', id: remembered };
  if (draftFor(drafts, remembered) || imagesFor(images, remembered).length) return { kind: 'fresh', from: remembered };
  return { kind: 'active' };
}

export interface ChatPersistState {
  /** The opening of the project (its snapshot's workspaceKey), or null when none is open. */
  key: string | null;
  drafts: ChatDrafts;
  /** The images attached to those drafts. */
  images?: ChatImages;
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
  if (next.images && next.images !== prev.images) patch.chatImages = next.images;
  if (next.conversationId && next.conversationId !== prev.conversationId) patch.chatConversation = next.conversationId;
  return Object.keys(patch).length ? { key: next.key, patch } : null;
}

/**
 * Library images attached to unsent messages, by asset ID in the order attached, one list per conversation like the
 * drafts they go with. Only the IDs are kept: the pictures stay in the project.
 */
export type ChatImages = Record<string, string[]>;

/** The most images one message can carry (the app checks it again when the message is sent). */
export const MAX_CHAT_IMAGES = 4;

/** One empty list, so a store selector reading a message without images returns the same value each time. */
const NO_IMAGES: string[] = Object.freeze([]) as unknown as string[];

/** The images attached to a conversation's unsent message: none when it has none. */
export function imagesFor(images: ChatImages, conversationId: string | null | undefined): string[] {
  return (conversationId && Object.hasOwn(images, conversationId) && images[conversationId]) || NO_IMAGES;
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** The images with one conversation's list replaced. An empty list removes its entry; no change returns the same object. */
export function withImages(images: ChatImages, conversationId: string, ids: string[]): ChatImages {
  if (sameIds(imagesFor(images, conversationId), ids)) return images;
  const next = { ...images };
  if (ids.length) next[conversationId] = [...ids];
  else delete next[conversationId];
  return next;
}

/** Attach an image to a conversation's unsent message: once, and only while there is room. */
export function attachImage(images: ChatImages, conversationId: string, assetId: string): { images: ChatImages; outcome: 'added' | 'already' | 'full' } {
  const ids = imagesFor(images, conversationId);
  if (ids.includes(assetId)) return { images, outcome: 'already' };
  if (ids.length >= MAX_CHAT_IMAGES) return { images, outcome: 'full' };
  return { images: withImages(images, conversationId, [...ids, assetId]), outcome: 'added' };
}

/**
 * Attach several images at once (files dropped on the composer, once imported), in the order given: each once, while
 * there is room. Says how many were added, were already attached, and did not fit.
 */
export function attachImages(images: ChatImages, conversationId: string, assetIds: string[]): { images: ChatImages; added: string[]; already: number; full: number } {
  let next = images;
  const added: string[] = [];
  let already = 0;
  let full = 0;
  for (const id of new Set(assetIds)) {
    const r = attachImage(next, conversationId, id);
    next = r.images;
    if (r.outcome === 'added') added.push(id);
    else if (r.outcome === 'already') already++;
    else full++;
  }
  return { images: next, added, already, full };
}

/**
 * What ArrowUp in an empty composer brings back (#1410): the text of the last message the author sent in this
 * conversation, to edit and send again. A live-session guest's request is theirs, never brought back as the author's.
 * Null when nothing has been sent in it yet.
 */
export function lastSentText(messages: readonly { role: string; text: string; guest?: unknown }[] | undefined): string | null {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages![i];
    if (m.role === 'user' && !m.guest && typeof m.text === 'string' && m.text.trim()) return m.text;
  }
  return null;
}

/** Whether a drag carries files from the desktop (not text, or an image dragged out of Assets). */
export const isFileDrag = (types: readonly string[]): boolean => types.includes('Files');

/**
 * The pictures a paste into the composer carries (#1410): a screenshot or a copied image. A paste with text keeps to
 * its text, so words copied from a document that also puts a picture of them on the clipboard paste as words.
 */
export function pastedImageFiles<F extends { type: string }>(data: PastedData<F> | null): F[] {
  if (!data || data.getData('text/plain')) return [];
  const files = Array.from(data.files).filter((f) => f.type.startsWith('image/'));
  if (files.length) return files;
  // Some pictures come only as clipboard items, never in the file list.
  return Array.from(data.items).flatMap((i) => {
    const f = i.kind === 'file' && i.type.startsWith('image/') ? i.getAsFile() : null;
    return f ? [f] : [];
  });
}

/** As much of a paste's clipboard data (a DataTransfer) as pastedImageFiles reads. */
export interface PastedData<F> {
  files: ArrayLike<F>;
  items: ArrayLike<{ kind: string; type: string; getAsFile(): F | null }>;
  getData(format: string): string;
}

/** What to say once the dropped images are in Assets: how many were attached, and why any were not. */
export function droppedImagesNote(r: { added: number; already: number; full: number }): string {
  const parts = [
    r.added ? `Attached ${plural(r.added, 'image', 'images')} to your message. ${r.added === 1 ? 'It is' : 'They are'} in Assets too.` : '',
    r.already ? `${plural(r.already, 'image is', 'images are')} already in your message.` : '',
    r.full ? `${plural(r.full, 'image is', 'images are')} in Assets but not in your message: a message carries at most ${MAX_CHAT_IMAGES} images.` : ''
  ];
  return parts.filter(Boolean).join(' ');
}

/** Clear a sent message's images, unless they have changed since it was sent. */
export function afterSendImages(images: ChatImages, conversationId: string, sent: string[]): ChatImages {
  return sameIds(imagesFor(images, conversationId), sent) ? withImages(images, conversationId, []) : images;
}

/** The images with one conversation's list moved to another, as its draft moves (see moveDraft). */
export function moveImages(images: ChatImages, from: string, to: string): ChatImages {
  if (from === to || !imagesFor(images, from).length) return images;
  return withImages(withImages(images, to, imagesFor(images, from)), from, []);
}

/** Images read from a workspace file: distinct asset IDs, at most a message's worth, keyed by a conversation ID. */
export function cleanImages(raw: unknown): ChatImages {
  const out: ChatImages = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, ids] of Object.entries(raw)) {
    if (!/^c_[a-z0-9]+$/.test(id) || !Array.isArray(ids)) continue;
    const clean = [...new Set(ids.filter((x): x is string => typeof x === 'string' && !!x))].slice(0, MAX_CHAT_IMAGES);
    if (clean.length) out[id] = clean;
  }
  return out;
}

/**
 * Clear a sent message from its conversation: the images it carried are taken out (they went with it), and its text
 * is cleared unless it has changed since. Text typed, or images attached, while the request was starting stay for the
 * next message, without the ones already sent.
 */
export function afterSendMessage(drafts: ChatDrafts, images: ChatImages, conversationId: string, text: string, ids: string[]): { drafts: ChatDrafts; images: ChatImages } {
  const sent = new Set(ids);
  return { drafts: afterSend(drafts, conversationId, text), images: withImages(images, conversationId, imagesFor(images, conversationId).filter((id) => !sent.has(id))) };
}
