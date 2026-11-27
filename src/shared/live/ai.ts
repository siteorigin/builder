import type { ChatMessage, RunStatus } from '../api';
import { turnQuestions } from '../api';
import type { ElementRef } from '../types';

/**
 * A collaborator's requests to the host's AI (#769), as they travel. The host alone decides whether a collaborator may
 * ask (never by itself: it is off for every guest until the host turns it on) and how many requests it may make; the
 * request runs in the host's own assistant, with the host's provider, model and key, and only what is listed here
 * comes back: the collaborator's own request as it runs, made safe to share. Nothing of the host's AI settings, its
 * other conversations, or its computer is ever in it.
 */

/** What the host lets one collaborator do with its AI now: `turnsLeft` is null when the host set no limit. */
export interface LiveAiAccess {
  allowed: boolean;
  turnsLeft: number | null;
}

/** No AI for this guest: what every guest starts with. */
export const NO_AI_ACCESS: LiveAiAccess = { allowed: false, turnsLeft: null };

/** The limits the host can set on a collaborator's AI requests, for the whole time it is in the session. Null: none. */
export const LIVE_AI_TURN_LIMITS = [1, 3, 5, 10, 25] as const;
/** The most a limit may be. */
export const LIVE_AI_TURN_LIMIT_MAX = 100;

/** The longest request a collaborator may send, in characters. */
export const LIVE_AI_TEXT_MAX = 8000;
/** The longest label a collaborator's selection may carry in its request. */
export const LIVE_AI_LABEL_MAX = 120;

/**
 * What a collaborator's request is about: the page it shows, or the element selected there (on that page, or in the
 * shared header or footer). The host's AI may change only that, and only as a collaborator could by hand.
 */
export interface LiveAiContext {
  scope: 'page' | 'selection';
  pageId: string;
  selection: ElementRef | null;
  selectionLabel?: string | null;
  viewport: number;
}

/** One step of the request, as the collaborator is shown it. */
export interface LiveAiActivity {
  label: string;
  status: 'running' | 'done' | 'error';
}

/** A question the host's AI asked the collaborator, waiting for its answer. */
export interface LiveAiQuestion {
  id: string;
  text: string;
  choices: string[];
}

/** How the request ended. `changes` are what it changed, in plain words. */
export interface LiveAiResult {
  status: RunStatus;
  summary: string;
  changes: string[];
  error?: string;
}

/** A collaborator's own request to the host's AI, as the collaborator sees it. */
export interface LiveAiTurn {
  runId: string;
  request: string;
  reply: string;
  status: RunStatus | null;
  activities: LiveAiActivity[];
  question: LiveAiQuestion | null;
  result: LiveAiResult | null;
}

/**
 * The `ai:turn` event: the request as it stands (everything but the reply's text, which comes whole only when the
 * turn's text was replaced), or a piece of the reply, which follows its first `at` characters.
 */
export type LiveAiTurnEvent = { kind: 'turn'; turn: LiveAiTurn } | { kind: 'text'; runId: string; at: number; text: string };

/** Bounds on what a turn carries, so one always fits a frame (MAX_FRAME_BYTES) with room to spare. */
export const LIVE_AI_REPLY_MAX = 60_000;
const ACTIVITIES_MAX = 40;
const CHANGES_MAX = 40;
const SHORT_MAX = 300;
const SUMMARY_MAX = 4000;
const CHOICES_MAX = 12;

const cut = (text: unknown, max: number): string => (typeof text === 'string' ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : '');

/**
 * Addresses on the host's own computer or network, such as a local AI server's: a guest is never told where the host's
 * AI runs. Public addresses (a page's link, say) are left as they are.
 */
const PRIVATE_ADDRESS = /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:.]+\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w-]+\.local)(?::\d+)?[^\s"'<>)]*/gi;
/** `text` with any address on the host's own computer or network taken out. */
export const scrubPrivateAddresses = (text: string) => text.replace(PRIVATE_ADDRESS, '…');
/** What a guest is told when the host's AI could not run because of how it is set up there. */
export const LIVE_AI_SETUP_PROBLEM = 'The host’s AI isn’t set up to take this request right now. Ask the host to check their AI settings.';
/** What a guest is told when the host's AI provider failed the request, in place of the provider's own words. */
export const LIVE_AI_PROVIDER_PROBLEM = 'The host’s AI provider couldn’t finish this request.';
/** A step of the request that is the provider's own trouble (a retry), as a guest is shown it. */
const PROVIDER_STEP = 'Waiting for the host’s AI provider…';
/** The summaries a failed request carries the provider's (or the app's) own error words in. */
const RAW_FAILURE = /^(?:The AI request failed|Something went wrong)\b/;

/**
 * A run's turn as its collaborator is shown it, from the host's own messages: the request it sent, the reply, the steps
 * and checks in plain words, a question still waiting, and how it ended. `scrub` takes the host's paths out of text.
 * Anything technical (operations, the model, the provider and where it runs, usage, diagnostics, error details,
 * recovery files) stays on the host; a request the host's AI setup stopped says only that.
 */
export function liveAiTurn(request: string, message: ChatMessage, status: RunStatus | null, scrub: (text: string) => string): LiveAiTurn {
  const s = (text: unknown, max: number) => cut(scrubPrivateAddresses(scrub(typeof text === 'string' ? text : '')), max);
  const waiting = turnQuestions(message).find((q) => q.id && q.answered === undefined) ?? null;
  const r = message.result;
  return {
    runId: message.runId ?? '',
    request: s(request, LIVE_AI_TEXT_MAX),
    reply: s(message.text, LIVE_AI_REPLY_MAX),
    status: r ? r.status : status,
    activities: (message.activities ?? []).slice(-ACTIVITIES_MAX).map((a) => ({ label: a.tool === 'provider' ? PROVIDER_STEP : s(a.label, SHORT_MAX), status: a.status })),
    question: !r && waiting ? { id: waiting.id!, text: s(waiting.text, SUMMARY_MAX), choices: waiting.choices.slice(0, CHOICES_MAX).map((c) => s(c, SHORT_MAX)) } : null,
    // A summary that only repeats the reply is not sent twice.
    result: r
      ? {
          status: r.status,
          summary: r.repair ? LIVE_AI_SETUP_PROBLEM : r.status === 'failed' && RAW_FAILURE.test(r.summary) ? LIVE_AI_PROVIDER_PROBLEM : r.summary === message.text ? '' : s(r.summary, SUMMARY_MAX),
          changes: r.changes.slice(0, CHANGES_MAX).map((c) => s(c.label, SHORT_MAX))
        }
      : null
  };
}

const RUN_STATUSES: readonly string[] = ['preparing', 'running', 'awaiting-input', 'validating', 'repairing', 'stopping', 'completed', 'partial', 'no-changes', 'cancelled', 'failed', 'conflicted'];
/** The statuses a turn ends with. */
export const LIVE_AI_TERMINAL: readonly RunStatus[] = ['completed', 'partial', 'no-changes', 'cancelled', 'failed', 'conflicted'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isStatus = (v: unknown): v is RunStatus => typeof v === 'string' && RUN_STATUSES.includes(v);

/** An `ai:access` payload as the guest reads it, or null when it is not one. */
export function readAiAccess(value: unknown): LiveAiAccess | null {
  if (!isRecord(value) || typeof value.allowed !== 'boolean') return null;
  const left = value.turnsLeft;
  if (left !== null && !(Number.isSafeInteger(left) && (left as number) >= 0)) return null;
  return { allowed: value.allowed, turnsLeft: left as number | null };
}

/** An `ai:turn` payload as the guest reads it, or null when it is not one. Everything in it is checked, never trusted. */
export function readAiTurnEvent(value: unknown): LiveAiTurnEvent | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'text') {
    if (!isText(value.runId, 128) || !value.runId || !Number.isSafeInteger(value.at) || (value.at as number) < 0 || !isText(value.text, LIVE_AI_REPLY_MAX)) return null;
    return { kind: 'text', runId: value.runId, at: value.at as number, text: value.text };
  }
  if (value.kind !== 'turn' || !isRecord(value.turn)) return null;
  const t = value.turn;
  if (!isText(t.runId, 128) || !t.runId || !isText(t.request, LIVE_AI_TEXT_MAX + 1) || !isText(t.reply, LIVE_AI_REPLY_MAX + 1) || !(t.status === null || isStatus(t.status))) return null;
  if (!Array.isArray(t.activities) || t.activities.length > ACTIVITIES_MAX) return null;
  const activities: LiveAiActivity[] = [];
  for (const a of t.activities) {
    if (!isRecord(a) || !isText(a.label, SHORT_MAX + 1) || (a.status !== 'running' && a.status !== 'done' && a.status !== 'error')) return null;
    activities.push({ label: a.label, status: a.status });
  }
  let question: LiveAiQuestion | null = null;
  if (t.question !== null) {
    const q = t.question;
    if (!isRecord(q) || !isText(q.id, 128) || !q.id || !isText(q.text, SUMMARY_MAX + 1) || !Array.isArray(q.choices) || q.choices.length > CHOICES_MAX || !q.choices.every((c) => isText(c, SHORT_MAX + 1))) return null;
    question = { id: q.id, text: q.text, choices: [...(q.choices as string[])] };
  }
  let result: LiveAiResult | null = null;
  if (t.result !== null) {
    const r = t.result;
    if (!isRecord(r) || !isStatus(r.status) || !isText(r.summary, SUMMARY_MAX + 1) || !Array.isArray(r.changes) || r.changes.length > CHANGES_MAX || !r.changes.every((c) => isText(c, SHORT_MAX + 1))) return null;
    if (r.error !== undefined && !isText(r.error, SHORT_MAX + 1)) return null;
    result = { status: r.status, summary: r.summary, changes: [...(r.changes as string[])], ...(typeof r.error === 'string' ? { error: r.error } : {}) };
  }
  return { kind: 'turn', turn: { runId: t.runId, request: t.request, reply: t.reply, status: t.status as RunStatus | null, activities, question, result } };
}
