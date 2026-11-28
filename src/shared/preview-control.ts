/**
 * The editor's preview controls as the assistant sets them (#1405): the canvas's width, the palette it previews and
 * Edit or Preview, changed in the editor window as the toolbar changes them. Nothing here is the site's: no revision,
 * no History step.
 */

/** The toolbar's width presets, by name. */
export type PreviewPreset = 'desktop' | 'tablet' | 'phone';
export type PreviewSchemeChoice = 'system' | 'light' | 'dark';
export type PreviewModeChoice = 'edit' | 'preview';

/** What a call asks for: each setting it names, the others left as they are. */
export interface PreviewControlSettings {
  viewport?: PreviewPreset;
  /** A width in CSS px instead of a preset. */
  width?: number;
  scheme?: PreviewSchemeChoice;
  mode?: PreviewModeChoice;
}

/** What the main process asks the editor window to do. */
export interface PreviewControlRequest extends PreviewControlSettings {
  requestId: string;
  /** When the main process stops waiting for an answer (Date.now() time): a request reaching the editor later is not applied. */
  deadline: number;
}

/** One setting the editor could not change, and why, in words the author reads too. */
export interface PreviewControlRefusal {
  setting: 'viewport' | 'width' | 'scheme' | 'mode';
  reason: string;
}

/** What the editor shows once the request is applied, and what it refused. `error`: nothing could be done at all. */
export type PreviewControlResult =
  | {
      /** The controls as they now stand. */
      now: { width: number; preset: PreviewPreset | null; scheme: PreviewSchemeChoice; mode: PreviewModeChoice; darkPalette: boolean };
      /** The settings this request changed (one already as asked is not listed). */
      changed: Array<PreviewControlRefusal['setting']>;
      refused: PreviewControlRefusal[];
    }
  | { error: string };
