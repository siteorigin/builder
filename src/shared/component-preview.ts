/**
 * The editor's isolated component preview: one component definition shown on its own by the preview server, with
 * variants and property values the caller chooses, whether or not any page places it. Everything it needs is written
 * under the editor's dev cache and served from there by the dev server alone; the project's source, its exports and
 * its production build never contain any of it. No imports, so the preview server's plugin can read it too.
 */

/** What to show: exactly one of `definitionId` and `componentId`. */
export interface ComponentPreviewSpec {
  /** A component definition of the project, by its ID. */
  definitionId?: string;
  /** Or a component of the site's theme catalogue, by its catalogue ID: the project's copy, when it has one. */
  componentId?: string;
  /** The option to show on each variant axis, by axis ID; an axis left out shows its default. */
  variants?: Record<string, string>;
  /** Sample property values, by property name, in place of the definition's defaults. */
  props?: Record<string, unknown>;
  /**
   * The value each named UI state variable starts at, in place of the one the design declares (a hidden tab chosen, a
   * drawer open), by state name: a dialog or drawer open in it shows in place while editing.
   */
  states?: Record<string, boolean | string | number>;
}

/** Where the preview server shows a prepared preview: this, then its key, then "/". A page's address never starts with "_". */
export const COMPONENT_PREVIEW_ROUTE = '/__siteorigin/component/';

/** The ID of the one instance a preview shows. */
export const PREVIEW_NODE_ID = 'preview';

/** The identity context of a preview's markup (`data-so-ctx`), told apart from a page's ("page:…") and the shell's. */
export const previewCtx = (definitionId: string) => `preview:${definitionId}`;

/** The folder in the dev cache (.siteorigin/cache/dev) that holds each prepared preview's files, a folder per key. */
export const ISOLATED_DIR = 'isolated';

/**
 * The preview's own module, inside its key's folder. Its folder mirrors the project's (src/lib/siteorigin/…), so
 * the generated files it imports keep their relative imports.
 */
export const PREVIEW_MODULE = 'src/lib/siteorigin/preview/Preview.svelte';

/** What the preview's page needs to know of the site (its language), inside its key's folder. */
export const PREVIEW_META = 'preview.json';

/** The project stylesheets every preview loads from the project itself, as the site's layout does. */
export const PREVIEW_PROJECT_STYLES = ['src/lib/siteorigin/styles/tokens.css', 'src/lib/siteorigin/styles/theme.css'];
/** The component stylesheet, from the preview's own folder: it also has the rules of a catalogue component the project does not have. */
export const PREVIEW_COMPONENT_STYLES = 'src/lib/siteorigin/styles/components.css';

/** A preview's key: made by the editor, letters and digits only, so it is always one safe path segment. */
export const PREVIEW_KEY = /^[a-z0-9]{16,64}$/;

/** The key in a request for a preview's page, or null for any other address. */
export function previewKeyOf(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split(/[?#]/)[0];
  if (!path.startsWith(COMPONENT_PREVIEW_ROUTE)) return null;
  const rest = path.slice(COMPONENT_PREVIEW_ROUTE.length);
  const key = rest.endsWith('/') ? rest.slice(0, -1) : rest;
  return PREVIEW_KEY.test(key) ? key : null;
}

/** A preview prepared by the editor for the preview server running now. */
export type PreparedComponentPreview = { ok: true; key: string; path: string; definitionId: string } | { ok: false; message: string };

/** One request to a component preview frame: show `spec` at `width` CSS pixels wide. */
export interface ComponentPreviewStep {
  spec: ComponentPreviewSpec;
  width: number;
  /** Which of a request's frames shows it (0 to 3), so several can be open at once. Default 0. */
  frame?: number;
}

/** How a batch of component previews is measured, when not as Insert's thumbnails are (see the AI's inspect_component). */
export interface ComponentPreviewMeasure {
  /** Also run the readability checks a page gets: contrast, overlaps, clipped text and tap targets. */
  readability?: boolean;
  /** Also report the space between stacked elements, to compare a preview with content left empty against it shown. */
  gaps?: boolean;
  /** Start no step after this many milliseconds: the results end with the last step started. */
  budgetMs?: number;
}

/** What a component preview frame reports once it has shown a request, or why it could not. */
export interface ComponentPreviewResult {
  state: 'ready' | 'error';
  error?: string;
  /** The definition shown: for a catalogue component, the ID it has in the project or would be given there. */
  definitionId?: string;
  width: number;
  /** The component's box on the preview page in CSS pixels, or null when it renders nothing that takes up room. */
  bounds?: { x: number; y: number; width: number; height: number } | null;
  /** The text it shows, as a reader would read it (at most about 1000 characters). */
  text?: string;
  /** The bridge's inspection of the preview page: viewport and document size, layout and image findings, errors. */
  report?: unknown;
}
