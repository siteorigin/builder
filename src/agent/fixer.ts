/**
 * Code-fixing agent. A small, single-purpose model call that repairs a Svelte component so it passes the
 * application's checks, keeping the author's intent. It has no tools and cannot touch the project; the
 * caller re-checks the result before anything is saved. Kept deliberately simple so a small local model
 * can take this role later.
 */
import type { AgentModelAdapter } from './types';

export interface FixResult {
  ok: boolean;
  source?: string;
  explanation?: string;
  message?: string;
  /** The request was cancelled (for example, the code editor was closed). */
  cancelled?: boolean;
  attempts: number;
}

const SYSTEM = `You repair Svelte 5 components for a website builder used by non-programmers.
Rules:
- Fix only the listed problems. Keep the component's purpose, text, structure and styling.
- Use Svelte 5 runes ($props, $state, $derived, $effect). Do not use export let or on: directives; use onclick.
- Only import from relative paths, "svelte" or "$app/..." modules. No other packages.
- Never use {@html}, eval or new Function.
- Use browser-only objects (window, document, localStorage) only inside onMount or $effect.
- Keep scoped <style>. Prefer the site's CSS variables such as var(--so-color-brand) and var(--so-space-md).
Reply with one short plain sentence describing what you fixed, then the complete corrected component in a single \`\`\`svelte code block.`;

export async function fixComponentSource(
  adapter: AgentModelAdapter,
  model: string,
  source: string,
  check: (src: string) => Promise<Array<{ severity: string; message: string; line?: number }>>,
  signal: AbortSignal,
  maxAttempts = 2
): Promise<FixResult> {
  let current = source;
  let problems = await check(current);
  let explanation = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) return { ok: false, cancelled: true, message: 'Cancelled', attempts: attempt - 1 };
    const list = problems.map((p) => `- ${p.severity}${p.line ? ` (line ${p.line})` : ''}: ${p.message}`).join('\n');
    let text = '';
    let failed: string | null = null;
    let cancelled = false;
    for await (const ev of adapter.streamTurn(
      { model, system: SYSTEM, tools: [], maxOutputTokens: Math.min(adapter.capabilities().maxOutputTokens, 16000), items: [{ kind: 'user', text: `Problems found:\n${list}\n\nComponent:\n\`\`\`svelte\n${current}\n\`\`\`` }] },
      signal
    )) {
      if (ev.type === 'done') text = ev.text;
      if (ev.type === 'error') {
        failed = ev.message;
        cancelled = ev.code === 'cancelled';
      }
    }
    if (signal.aborted || cancelled) return { ok: false, cancelled: true, message: 'Cancelled', attempts: attempt };
    if (failed) return { ok: false, message: failed, attempts: attempt };
    const code = text.match(/```(?:svelte|html)?\s*\n([\s\S]*?)```/)?.[1];
    if (!code) return { ok: false, message: 'The fixer did not return a component.', attempts: attempt };
    explanation = text.slice(0, text.indexOf('```')).trim().split('\n')[0];
    current = code.replace(/\s+$/, '\n');
    problems = await check(current);
    // Closing the editor while the result is being checked still cancels it.
    if (signal.aborted) return { ok: false, cancelled: true, message: 'Cancelled', attempts: attempt };
    if (!problems.some((p) => p.severity === 'error') && !problems.some((p) => p.message.startsWith('Browser-only'))) {
      return { ok: true, source: current, explanation: explanation || 'Fixed the problems.', attempts: attempt };
    }
  }
  return { ok: false, message: `Some problems remain: ${problems.map((p) => p.message).join(' ')}`, attempts: maxAttempts };
}
