/**
 * An external model's transcript (Codex's `exec --json` events), as the model-driven smoke test keeps and audits it
 * (scripts/model-smoke.mjs, issue #498).
 */
import { hideDeep } from '../driver/evidence.ts';

/** Shapes of credentials a transcript could carry: provider keys, GitHub and Slack tokens, AWS key ids, JWTs, bearer headers. */
const CREDENTIAL = /\b(sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9._-]{12,})/g;
/** Image data written inline in text. */
const DATA_URL = /data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/gi;

/** The user's name wherever it stands on its own (a path the app draws one folder at a time escapes path hiding). */
function userName(user: string): RegExp | null {
  return user.length >= 3 ? new RegExp(`(?<![A-Za-z0-9_-])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'g') : null;
}

/** Text as it is kept: host paths named by `hide`, the user's name, credentials and inline image data taken out. */
export function redactText(text: string, hide: (s: string) => string, user: string): string {
  const name = userName(user);
  const out = hide(text.replace(DATA_URL, '[image data left out]').replace(CREDENTIAL, '[redacted]'));
  return name ? out.replace(name, '<user>') : out;
}

/** An event as it is kept: every string as redactText keeps it, and image blocks without their data. */
export function redactEvent<T>(event: T, hide: (s: string) => string, user: string): T {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'image' && typeof o.data === 'string') return { type: 'image', mimeType: o.mimeType, bytes: Math.floor((o.data.length * 3) / 4), data: '[image data left out]' };
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, strip(x)]));
    }
    return v;
  };
  return hideDeep(strip(event), (s) => redactText(s, hide, user)) as T;
}

/**
 * Transcript items that are the model talking, thinking or keeping its plan (Codex's own plan tool, which reads and
 * changes nothing outside the conversation), not using a tool.
 */
const TALK = new Set(['agent_message', 'reasoning', 'todo_list', 'error']);

export interface Audit {
  /** The calls of the allowed server's tools that finished, in order. */
  calls: { tool: string; ok: boolean }[];
  /** How many of the allowed server's calls started, finished or not. */
  started: number;
  /** Every other tool the model used or tried, once each. */
  foreign: string[];
  /** Events the audit could not read: a transcript it cannot read whole is not one it can vouch for. */
  unreadable: number;
}

/** Every tool the model used or tried: only `server`'s count as calls; anything else, even an attempt, is foreign. */
export function auditTranscript(events: unknown[], server: string): Audit {
  const calls: Audit['calls'] = [];
  const foreign = new Set<string>();
  let unreadable = 0;
  let started = 0;
  for (const e of events as { type?: string; item?: Record<string, unknown> }[]) {
    if (e.type === 'unparsed' || typeof e.type !== 'string') unreadable++;
    if (e.type !== 'item.completed' && e.type !== 'item.started' && e.type !== 'item.updated') continue;
    const item = e.item ?? {};
    if (TALK.has(String(item.type))) continue;
    if (item.type === 'mcp_tool_call' && item.server === server) {
      if (e.type === 'item.started') started++;
      if (e.type === 'item.completed') calls.push({ tool: String(item.tool), ok: item.status !== 'failed' && !item.error });
      continue;
    }
    foreign.add(`${String(item.type)}${item.server ? ` ${String(item.server)}` : ''}${item.tool ? ` ${String(item.tool)}` : ''}${item.command ? `: ${String(item.command).slice(0, 80)}` : ''}`);
  }
  return { calls, started, foreign: [...foreign], unreadable };
}
