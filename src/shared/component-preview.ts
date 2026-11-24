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
}

/** Where the preview server shows a prepared preview: this, then its key, then "/". A page's address never starts with "_". */
export const COMPONENT_PREVIEW_ROUTE = '/__siteorigin/component/';

/** The folder in the dev cache (.siteorigin/cache/dev) that holds each prepared preview's files, a folder per key. */
export const ISOLATED_DIR = 'isolated';

/**
 * The preview's own module, inside its key's folder. Its folder mirrors the project's (src/lib/siteorigin/…), so
 * the generated files it imports keep their relative imports.
 */
export const PREVIEW_MODULE = 'src/lib/siteorigin/preview/Preview.svelte';

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
