/**
 * The public files a website gets for home screens, bookmarks and installed shortcuts beside its favicon (issue 584):
 * a web app manifest, and PNG icons made from the favicon (or the generated monogram while none is chosen) at the
 * sizes iOS and the manifest ask for. The generator writes the manifest and describes the icons; the editor renders
 * the icons. All of them sit at the site's root (under its sub-path), never an authored page or a version's media.
 */

/** Served path of the web app manifest. */
export const WEB_MANIFEST = 'manifest.webmanifest';

/** Served path of the icon iOS puts on the home screen, which it also looks for at this address by itself. */
export const APPLE_TOUCH_ICON = 'apple-touch-icon.png';

/** The PNG icons made from the favicon, each a square of `size` pixels: iOS's own, then the manifest's two. */
export const APP_ICONS: ReadonlyArray<{ file: string; size: number }> = [
  { file: APPLE_TOUCH_ICON, size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 }
];

/** Every file above, by its served path. */
export const SITE_ICON_FILES: readonly string[] = [WEB_MANIFEST, ...APP_ICONS.map((i) => i.file)];
