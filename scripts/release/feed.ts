import { pathToFileURL } from 'node:url';

// The update feed the release workflows publish to: where it lives, which platforms have one, what each platform's
// metadata file is called, and the release channels. Every release script reads these from here.

/** Where installers and update metadata are served from: the R2 bucket's custom domain, `releases/` prefix. */
export const PUBLISH_URL = 'https://downloads.siteorigin.com/releases/';

/** The platforms with a feed of their own, in the order the gates report them. */
export const PLATFORMS = ['mac', 'linux', 'win'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Release channels, from the tag: `v1.2.0-rc.1` is `rc`, `v1.2.0-beta.1` is `beta`, anything else `latest`. */
export const CHANNELS = ['latest', 'rc', 'beta'] as const;
export type Channel = (typeof CHANNELS)[number];

/** The channel a version (or a `v`-prefixed tag) publishes to. */
export function channelOf(version: string): Channel {
  const v = version.replace(/^v/, '');
  if (v.includes('-rc')) return 'rc';
  if (v.includes('-beta')) return 'beta';
  return 'latest';
}

/**
 * The metadata file electron-updater fetches for a platform on a channel. Windows has no suffix: electron-updater's
 * `Provider.getChannelFilePrefix()` returns "" for win32, so Windows clients poll `<channel>.yml`.
 */
export function metadataFilename(channel: string, platform: Platform): string {
  return platform === 'win' ? `${channel}.yml` : `${channel}-${platform}.yml`;
}

/** The suffix each platform's metadata file carries after the channel: `-mac`, `-linux`, or none for Windows. */
export const METADATA_SUFFIXES: Record<Platform, string> = { mac: '-mac', linux: '-linux', win: '' };

/** `url` joined onto `base`, unless it is already absolute. */
export function publishedUrl(base: string, url: string): string {
  if (!base) throw new Error('base is required');
  if (!url) throw new Error('url is required');
  if (/^https?:\/\//i.test(url)) return url;
  return `${base.endsWith('/') ? base : `${base}/`}${url}`;
}

/** Whether the module at `metaUrl` is the script node was started with, rather than one a test imported. */
export function isMain(metaUrl: string): boolean {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}
