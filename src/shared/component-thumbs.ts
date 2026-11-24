/**
 * A thumbnail of a project component for Insert → Your components, photographed from its isolated preview (see
 * @shared/component-preview) and kept in the editor's cache (main/runtime/component-thumbs).
 *
 * - `ready`: the picture, as a data URL, under its key; the URL is left out when the editor said it shows that key.
 * - `failed`: this version of the component cannot be pictured (it throws, or shows nothing); not tried again until
 *   it, or the site's brand, changes.
 * - `unavailable`: not now (the preview is not running, the component changed meanwhile, or the project did); the
 *   editor keeps what it shows and asks again when something changes.
 */
export type ComponentThumb = { state: 'ready'; key: string; url?: string } | { state: 'failed'; key: string; message: string } | { state: 'unavailable' };
