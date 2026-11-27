import type { SourceManifest } from '@shared/api';
import { api, getState } from '../store';

export type SaveOutcome = { ok: true; source: string; fixed?: string; warnings?: string[] } | { ok: false; problems: string[] };

/**
 * Every code save goes through the app's checks. When they find problems and an AI provider is set up,
 * the code-fixing agent repairs the code first; the repaired version is checked again before saving.
 * Broken code is never saved, and nothing is saved once `alive()` says the editor was closed.
 */
export async function prepareCodeForSave(source: string, onStatus: (s: string | null) => void, alive: () => boolean = () => true, manifest?: SourceManifest): Promise<SaveOutcome> {
  onStatus('Checking your code…');
  const check = await api.project.validateSource(source, manifest);
  // The editor was closed while checking: start nothing more.
  if (!alive()) return { ok: false, problems: [] };
  const problems = check.diagnostics;
  if (!problems.length) {
    onStatus(null);
    return { ok: true, source };
  }
  // Warnings alone never send the code to the assistant: the user's code is saved exactly as written.
  if (check.ok) {
    onStatus(null);
    return { ok: true, source, warnings: problems.map((p) => (p.line ? `Line ${p.line}: ` : '') + p.message) };
  }
  const provider = getState().providers.find((p) => p.id === getState().settings?.ai.provider);
  if (provider?.configured) {
    onStatus(`Found ${check.errors.length} problem${check.errors.length === 1 ? '' : 's'}. Fixing automatically…`);
    const fix = await api.ai.fixCode(source);
    onStatus(null);
    // Closing the editor cancels the fix; nothing is saved for a request the user walked away from.
    if (fix.cancelled || !alive()) return { ok: false, problems: [] };
    if (fix.ok && fix.source) return { ok: true, source: fix.source, fixed: fix.explanation };
    return { ok: false, problems: [...check.errors, ...(fix.message ? [`The automatic fix did not work: ${fix.message}`] : [])] };
  }
  onStatus(null);
  return { ok: false, problems: [...check.errors, 'Connect an AI provider in Settings to have problems like these fixed automatically.'] };
}
