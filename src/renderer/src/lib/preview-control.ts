/**
 * The assistant's set_preview (#1405): the canvas's width, preview colors and Edit or Preview, changed as the toolbar
 * changes them and held to what the toolbar allows now. The answer says what the controls show afterwards, so the
 * assistant reports what happened rather than what it asked for.
 */
import { hasDarkPalette } from '@shared/color-scheme';
import type { PreviewControlRefusal, PreviewControlRequest, PreviewControlResult, PreviewPreset } from '@shared/preview-control';
import { VIEWPORT_PRESETS } from '@shared/styles';
import { api, getState, setState, setViewport } from '../store';
import { setMode } from './actions';
import { VIEWPORT_LIMITS } from './layout';
import { activeWorkspace, canvasCovered } from './workspace';

const presetOf = (width: number): PreviewPreset | null => (Object.entries(VIEWPORT_PRESETS) as Array<[PreviewPreset, number]>).find(([, w]) => w === width)?.[0] ?? null;

/** Apply what `req` asks to the editor as it is now, and say what it shows. */
export function applyPreviewControl(req: Omit<PreviewControlRequest, 'requestId' | 'deadline'>): PreviewControlResult {
  const s = getState();
  if (s.screen !== 'editor' || !s.snapshot) return { error: 'No project is open in the editor.' };
  if (s.leaving) return { error: 'The project is closing.' };
  const workspace = activeWorkspace(s);
  const covered = canvasCovered(workspace);
  const seo = workspace === 'seo';
  const dark = hasDarkPalette(s.snapshot.state.tokens);
  const refused: PreviewControlRefusal[] = [];
  const changed: PreviewControlRefusal['setting'][] = [];
  const width = req.width ?? (req.viewport ? VIEWPORT_PRESETS[req.viewport] : undefined);
  const widthSetting = req.width !== undefined ? 'width' : 'viewport';
  if (width !== undefined) {
    if (!Number.isInteger(width) || width < VIEWPORT_LIMITS.min || width > VIEWPORT_LIMITS.max) refused.push({ setting: widthSetting, reason: `The preview width is a whole number from ${VIEWPORT_LIMITS.min} to ${VIEWPORT_LIMITS.max} px.` });
    else if (covered) refused.push({ setting: widthSetting, reason: seo ? 'The SEO view covers the canvas. Close the SEO view (Esc) to see the page at another width.' : 'The post writer covers the canvas. Preview in site shows the post at another width.' });
    else if (width !== s.viewport) {
      setViewport(width);
      changed.push(widthSetting);
    }
  }
  if (req.scheme !== undefined) {
    // A site with one palette looks the same in either: the toolbar offers the choice only beside a dark one.
    if (!dark) refused.push({ setting: 'scheme', reason: 'This site has a single color palette, so it has no dark colors to preview. Adding a dark palette in Site styles would give it one.' });
    else if (seo) refused.push({ setting: 'scheme', reason: 'The SEO view covers the canvas. Close the SEO view (Esc) to preview the page in other colors.' });
    else if (req.scheme !== getState().previewScheme) {
      setState({ previewScheme: req.scheme });
      changed.push('scheme');
    }
  }
  if (req.mode !== undefined) {
    if (seo) refused.push({ setting: 'mode', reason: 'The SEO view covers the canvas. Close the SEO view (Esc) to edit or preview the page.' });
    // The writer saves the post before its preview opens, and may stay open: what the controls would show is not known yet.
    // A Preview already chosen there may still be waiting for that save, and is not known to open either.
    else if (covered && (req.mode === 'preview' || req.mode !== getState().mode)) refused.push({ setting: 'mode', reason: 'The post writer is open. Preview in the toolbar saves the post and shows it in the site.' });
    else if (req.mode !== getState().mode) {
      setMode(req.mode);
      changed.push('mode');
    }
  }
  const now = getState();
  // The palette the canvas shows: a single-palette site shows its one palette, whatever was chosen while it had two.
  return { now: { width: now.viewport, preset: presetOf(now.viewport), scheme: dark ? now.previewScheme : 'system', mode: now.mode, darkPalette: dark }, changed, refused };
}

/** Answer the main process's request (see App's preview-control:request), whatever happens. */
export function runPreviewControl(req: PreviewControlRequest) {
  let result: PreviewControlResult;
  try {
    const { requestId: _id, deadline, ...settings } = req;
    // Arrived after the main process stopped waiting (the editor was still loading): the request was answered already.
    result = Date.now() > deadline ? { error: 'The editor answered too late.' } : applyPreviewControl(settings);
  } catch (e) {
    result = { error: e instanceof Error ? e.message : String(e) };
  }
  api.previewControlResult(req.requestId, result);
}
