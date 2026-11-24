/**
 * Code-fixing agent. A small, single-purpose model call that repairs a Svelte component so it passes the
 * application's checks, keeping the author's intent. It has no tools and cannot touch the project; the
 * caller re-checks the result before anything is saved. Kept deliberately simple so a small local model
 * can take this role later.
 */
import type { AgentModelAdapter, CanonicalItem } from './types';
import { estimateRequestTokens, estimateTokens } from './budget';

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
    const items: CanonicalItem[] = [{ kind: 'user', text: `Problems found:\n${list}\n\nComponent:\n\`\`\`svelte\n${current}\n\`\`\`` }];
    const caps = adapter.capabilities();
    let maxOutputTokens = Math.min(caps.maxOutputTokens, 16000);
    // A model with a known window must hold the component twice: as sent, and as the corrected copy it writes back.
    // A server that cuts an over-long prompt short would otherwise fix only part of the component.
    if (caps.contextWindowKnown) {
      const prompt = estimateRequestTokens(SYSTEM, [], items);
      const needed = prompt + estimateTokens(current) + 256;
      if (needed > caps.contextWindowTokens) {
        const size = Math.ceil(needed / 1024) * 1024;
        return { ok: false, message: `This component is too long to fix with the model's ${caps.contextWindowTokens.toLocaleString('en-US')}-token context: it needs about ${size.toLocaleString('en-US')} tokens for the component, its problems and the corrected copy. ${adapter.contextHelp?.(size) ?? ''}`.trim(), attempts: attempt - 1 };
      }
      maxOutputTokens = Math.min(maxOutputTokens, caps.contextWindowTokens - prompt);
    }
    for await (const ev of adapter.streamTurn({ model, system: SYSTEM, tools: [], maxOutputTokens, items }, signal)) {
      if (ev.type === 'done') {
        text = ev.text;
        // A cut-off reply can still contain a closed code block, but it is not a finished fix.
        if (ev.stopReason !== 'end' || ev.toolCalls.length) failed = 'The fixer did not finish its reply.';
      }
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
