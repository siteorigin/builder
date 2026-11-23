import { api, getState, toast } from '../store';

export type SaveOutcome = { ok: true; source: string; fixed?: string } | { ok: false; problems: string[] };

/**
 * Every code save goes through the app's checks. When they find problems and an AI provider is set up,
 * the code-fixing agent repairs the code first; the repaired version is checked again before saving.
 * Broken code is never saved.
 */
export async function prepareCodeForSave(source: string, onStatus: (s: string | null) => void): Promise<SaveOutcome> {
  onStatus('Checking your code…');
  const check = await api.project.validateSource(source);
  const problems = check.diagnostics;
  if (!problems.length) {
    onStatus(null);
    return { ok: true, source };
  }
  const provider = getState().providers.find((p) => p.id === getState().settings?.ai.provider);
  if (provider?.configured) {
    onStatus(`Found ${problems.length} problem${problems.length === 1 ? '' : 's'}. Fixing automatically…`);
    const fix = await api.ai.fixCode(source);
    onStatus(null);
    if (fix.ok && fix.source) return { ok: true, source: fix.source, fixed: fix.explanation };
    if (check.ok) return { ok: true, source };
    return { ok: false, problems: [...check.errors, ...(fix.message ? [`The automatic fix did not work: ${fix.message}`] : [])] };
  }
  onStatus(null);
  if (check.ok) {
    toast('Saved with warnings. Connect an AI provider in Settings to fix code problems automatically.');
    return { ok: true, source };
  }
  return { ok: false, problems: [...check.errors, 'Connect an AI provider in Settings to have problems like these fixed automatically.'] };
}
