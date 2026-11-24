import type { ProviderId } from './api';

/**
 * The provider and model that handled one AI turn, frozen when the turn started. Settings may name another model by
 * the time the turn ends; this is what actually received the request.
 */
export interface TurnModel {
  provider: ProviderId;
  /** The model ID the request was sent with. */
  id: string;
  /** The model's name as Settings showed it then (the ID for a local or custom model). */
  label: string;
  /** Settings named no local model, so the server's own model took the request. */
  auto?: true;
  /**
   * The turn ended before the model answered (stopped while it waited, refused, never delivered): it was for this
   * model, which may not have its messages. Absent while the turn runs and once the model has answered.
   */
  unanswered?: true;
}

/**
 * The recipient a message was sent for, as the composer named it: a run that would go elsewhere (Settings changed
 * meanwhile, or the local server now offers another model) is refused before anything is sent. `model` is null when
 * the local server picks and which model it offers was not known.
 */
export interface Recipient {
  provider: ProviderId;
  model: string | null;
}

/** A recipient from the renderer, or null when it cannot be read. */
export function readRecipient(raw: unknown): Recipient | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Partial<Record<keyof Recipient, unknown>>;
  if (typeof r.provider !== 'string' || !Object.hasOwn(PROVIDER_LABELS, r.provider)) return null;
  if (r.model !== null && (typeof r.model !== 'string' || !r.model.trim())) return null;
  return { provider: r.provider as ProviderId, model: r.model };
}

export const PROVIDER_LABELS: Record<ProviderId, string> = { openai: 'OpenAI', anthropic: 'Anthropic', local: 'Local model' };

/** How many earlier messages of a conversation each new request carries to the model. */
export const REPLAYED_MESSAGES = 12;

/** The earlier messages a new request in this conversation sends to the model with it. */
export function replayedHistory<T>(messages: readonly T[]): T[] {
  return messages.slice(-REPLAYED_MESSAGES);
}

/** A turn's model as read back from a transcript: anything malformed reads as unknown rather than shown broken. */
export function readTurnModel(raw: unknown): TurnModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<Record<keyof TurnModel, unknown>>;
  if (typeof m.provider !== 'string' || !Object.hasOwn(PROVIDER_LABELS, m.provider)) return null;
  if (typeof m.id !== 'string' || !m.id.trim()) return null;
  const label = typeof m.label === 'string' && m.label.trim() ? m.label : m.id;
  return { provider: m.provider as ProviderId, id: m.id, label, ...(m.auto === true && m.provider === 'local' ? { auto: true as const } : {}), ...(m.unanswered === true ? { unanswered: true as const } : {}) };
}

/** "Local model · studio-a": the provider, then the model. */
export function turnModelText(t: Pick<TurnModel, 'provider' | 'label'>): string {
  return `${PROVIDER_LABELS[t.provider]} · ${t.label}`;
}
