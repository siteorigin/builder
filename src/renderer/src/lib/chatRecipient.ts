import type { ChatMessage, ProviderId, ProviderStatus } from '@shared/api';
import { readTurnModel, turnModelText, type TurnModel } from '@shared/turn-model';
import { sentMessages } from '@shared/earlier-summary';

/**
 * Where the next message goes, as Settings choose it now. It is never the model of a turn already running: that one
 * is fixed on the turn (`TurnModel`). `id` is null when Settings name no local model and the server picks its own.
 */
export interface NextRecipient {
  provider: ProviderId;
  id: string | null;
  label: string;
}

/**
 * The next message's recipient from the chosen provider and the models chosen in Settings. With no local model
 * chosen, `serverModel` is the one the server offers first now (what the main process sends to), when it is known.
 */
export function nextRecipient(provider: Pick<ProviderStatus, 'id' | 'models'> | undefined, models: Partial<Record<ProviderId, string>> | undefined, serverModel?: string | null): NextRecipient | null {
  if (!provider) return null;
  const chosen = models?.[provider.id];
  const id = typeof chosen === 'string' && chosen.trim() ? chosen : null;
  if (!id && provider.id === 'local' && serverModel?.trim()) return { provider: 'local', id: serverModel, label: serverModel };
  if (!id) return { provider: provider.id, id: null, label: provider.id === 'local' ? "server's model" : 'default model' };
  return { provider: provider.id, id, label: provider.models.find((m) => m.id === id)?.label ?? id };
}

/** "OpenAI · GPT-6.2 Sol", or "Local model · server's model" when the server picks. */
export function recipientText(r: Pick<NextRecipient, 'provider' | 'label'>): string {
  return turnModelText(r);
}

/** The model a turn went to, or null for a user message, a turn that never reached a model, or an old transcript. */
export function turnRecipient(m: ChatMessage | null | undefined): TurnModel | null {
  return m?.role === 'assistant' ? readTurnModel(m.model) : null;
}

/**
 * Whether the next message goes where this turn went, by model ID. While the server's own model is not known yet, a
 * turn the server picked matches (the turn shows which model that was) and one chosen by name does not.
 */
export function sameRecipient(turn: TurnModel, next: NextRecipient): boolean {
  if (turn.provider !== next.provider) return false;
  return next.id === null ? turn.auto === true : turn.id === next.id;
}

/**
 * The assistant turns whose model is said under them, by message ID. A thread usually stays with one model, which the
 * composer already names for the next message, so it is said only where the thread moves to another model: on its first
 * turn when that is not the composer's model, on a turn that went elsewhere than the one before, and on a turn that never
 * got an answer. Every turn keeps its model in its details.
 */
export function modelLines(messages: readonly ChatMessage[], next: NextRecipient | null): Set<string> {
  const shown = new Set<string>();
  let last: TurnModel | null = null;
  for (const m of messages) {
    const model = turnRecipient(m);
    if (!model) continue;
    const moved = last ? model.provider !== last.provider || model.id !== last.id : !next || !sameRecipient(model, next);
    if (moved || model.unanswered) shown.add(m.id);
    if (!model.unanswered) last = model;
  }
  return shown;
}

/** What the composer says before a message goes to a model that has not seen this conversation's recent messages. */
export interface SwitchNotice {
  next: NextRecipient;
  /** The other models those messages were for, newest first. */
  earlier: TurnModel[];
  /** Some of them name no model: stored before turns did, or never sent to one. */
  unknown: boolean;
  /** They would go to a hosted provider, and may have been for a local server or for no model yet. */
  leavesComputer: boolean;
}

/**
 * The notice for the next message, or null when its recipient already has this conversation's recent messages.
 * Each request carries the replayed window and a summary of the turns before it (`sentMessages`), so the recipient has
 * seen every turn in them up to the newest one it answered: only turns after that are new to it. A summarised turn
 * counts like a recent one, since what it said goes out too. A turn it never answered (stopped, refused) does not
 * count, and a turn that names no model may have been for anyone, so both keep the notice.
 */
export function switchNotice(messages: readonly ChatMessage[], next: NextRecipient | null): SwitchNotice | null {
  if (!next) return null;
  const earlier: TurnModel[] = [];
  let unknown = false;
  for (const m of [...sentMessages(messages)].reverse()) {
    if (m.role !== 'assistant') continue;
    const turn = turnRecipient(m);
    if (!turn) {
      unknown = true;
      continue;
    }
    const same = sameRecipient(turn, next);
    if (same && !turn.unanswered) break;
    if (!same && !earlier.some((t) => t.provider === turn.provider && t.id === turn.id)) earlier.push(turn);
  }
  if (!earlier.length && !unknown) return null;
  return { next, earlier, unknown, leavesComputer: next.provider !== 'local' && (unknown || earlier.some((t) => t.provider === 'local')) };
}

/** "A", "A and B", "A, B and C". */
function names(list: string[]): string {
  return list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/** The notice in plain words: who gets what, and which models the conversation was with until now. */
export function switchNoticeText(n: SwitchNotice): string {
  const withWhom = n.earlier.length ? ` with ${names(n.earlier.map(turnModelText))}` : '';
  const leaves = n.leavesComputer ? ' Those messages leave this computer.' : '';
  return `Your next message goes to ${recipientText(n.next)} with recent messages from your conversation${withWhom}.${leaves}`;
}
