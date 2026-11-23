/**
 * Safety checks for authored Svelte code. Every code save passes through these, and code that fails
 * them is never written to the project. The goal is that a novice cannot break their site by saving code.
 */
export interface CodeProblem {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  column?: number;
}

const ALLOWED_IMPORT = /^(\.{1,2}\/|svelte(\/|$)|\$app\/)/;

export async function checkSvelteSource(source: string): Promise<CodeProblem[]> {
  const problems: CodeProblem[] = [];
  if (source.length > 60_000) return [{ severity: 'error', message: 'This component is too large. Split it into smaller components.' }];
  const { compile } = await import('svelte/compiler');
  for (const generate of ['client', 'server'] as const) {
    try {
      const r = compile(source, { filename: 'Component.svelte', generate, runes: true });
      if (generate === 'client')
        for (const w of r.warnings.slice(0, 10)) problems.push({ severity: 'warning', message: w.message.split('\n')[0], line: w.start?.line, column: w.start?.column });
    } catch (e) {
      const err = e as { message: string; start?: { line: number; column: number } };
      problems.push({ severity: 'error', message: err.message.split('\n')[0], line: err.start?.line, column: err.start?.column });
      break;
    }
  }
  const lines = source.split('\n');
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/(?:import\s[^'"]*from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      if (!ALLOWED_IMPORT.test(m[1])) problems.push({ severity: 'error', message: `"${m[1]}" is not available in this project. Use relative imports, svelte or $app modules only.`, line: i + 1 });
    }
    if (/\{@html\b/.test(text)) problems.push({ severity: 'error', message: 'Raw HTML ({@html}) is not allowed because it can break the page or let unsafe content in. Use normal text and elements instead.', line: i + 1 });
    if (/<script[^>]*\scontext=["']module["']|<script[^>]*\smodule\b/.test(text)) problems.push({ severity: 'error', message: 'Module scripts are not supported in project components.', line: i + 1 });
    if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) problems.push({ severity: 'error', message: 'eval and new Function are not allowed.', line: i + 1 });
  });
  // Browser-only globals at the top of a component break prerendering.
  const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
  if (/\b(window|document|localStorage|sessionStorage|navigator)\b/.test(script) && !/\b(onMount|\$effect|typeof window|browser)\b/.test(script)) {
    problems.push({ severity: 'warning', message: 'Browser-only objects (window, document, localStorage) must be used inside onMount or $effect, or the page cannot be prerendered.' });
  }
  return problems;
}
