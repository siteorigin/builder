/**
 * An external model's transcript (Codex's `exec --json` events), as the model-driven smoke test keeps and audits it
 * (scripts/model-smoke.mjs, issue #498).
 */
import { hideDeep } from '../driver/evidence.ts';

const CREDENTIAL = /\b(sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;

/**
 * An event as it is kept: host paths named by `hide`, the user's name wherever it shows on its own (a path the app
 * draws one folder at a time escapes `hide`), anything like a credential taken out, and image data left out.
 */
export function redactEvent<T>(event: T, hide: (s: string) => string, user: string): T {
  const name = user.length >= 3 ? new RegExp(`(?<![A-Za-z0-9_-])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'g') : null;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'image' && typeof o.data === 'string') return { type: 'image', mimeType: o.mimeType, bytes: Math.floor((o.data.length * 3) / 4), data: '[image data left out]' };
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, strip(x)]));
    }
    return typeof v === 'string' ? v.replace(CREDENTIAL, '[redacted]') : v;
  };
  const hidden = hideDeep(strip(event), hide);
  return name ? hideDeep(hidden, (s) => s.replace(name, '<user>')) : hidden;
}

/** Transcript items that are the model talking or thinking, not using a tool. */
const TALK = new Set(['agent_message', 'reasoning', 'todo_list', 'error']);

export interface Audit {
  /** The calls of the allowed server's tools that finished, in order. */
  calls: { tool: string; ok: boolean }[];
  /** Every other tool the model used or tried, once each. */
  foreign: string[];
}

/** Every tool the model used or tried: only `server`'s count as calls; anything else, even an attempt, is foreign. */
export function auditTranscript(events: unknown[], server: string): Audit {
  const calls: Audit['calls'] = [];
  const foreign = new Set<string>();
  for (const e of events as { type?: string; item?: Record<string, unknown> }[]) {
    if (e.type !== 'item.completed' && e.type !== 'item.started') continue;
    const item = e.item ?? {};
    if (TALK.has(String(item.type))) continue;
    if (item.type === 'mcp_tool_call' && item.server === server) {
      if (e.type === 'item.completed') calls.push({ tool: String(item.tool), ok: item.status !== 'failed' && !item.error });
      continue;
    }
    foreign.add(`${String(item.type)}${item.server ? ` ${String(item.server)}` : ''}${item.tool ? ` ${String(item.tool)}` : ''}${item.command ? `: ${String(item.command).slice(0, 80)}` : ''}`);
  }
  return { calls, foreign: [...foreign] };
}
