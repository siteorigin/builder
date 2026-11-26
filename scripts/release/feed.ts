import { pathToFileURL } from 'node:url';

// The update feed the release workflows publish to: where it lives, which platforms have one, what each platform's
// metadata file is called, and the release channels. Every release script reads these from here.

/** Where installers and update metadata are served from: the R2 bucket's custom domain, `releases/` prefix. */
export const PUBLISH_URL = 'https://downloads.siteorigin.com/releases/';

/** The platforms with a feed of their own, in the order the gates report them. */
export const PLATFORMS = ['mac', 'linux', 'win'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Release channels: a stable version is `latest`; `v1.2.0-rc.1` is `rc` and `v1.2.0-beta.1` is `beta`. */
export const CHANNELS = ['latest', 'rc', 'beta'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * The channel a version (or a `v`-prefixed tag) publishes to. A prerelease's channel is its first identifier, as
 * electron-updater reads it on the client, so `1.2.0-alpha.1` or `1.2.0-rc1` would poll a feed that isn't published:
 * those throw. The same rule as the resolve-update-metadata-prefix action.
 */
export function channelOf(version: string): Channel {
  const v = version.replace(/^v/, '').replace(/\+.*$/, '');
  const dash = v.indexOf('-');
  if (dash === -1) return 'latest';
  const channel = v.slice(dash + 1).split('.')[0];
  if (channel === 'rc' || channel === 'beta') return channel;
  throw new Error(`${version} is a prerelease on the '${channel}' channel; only rc and beta prereleases can be published`);
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

/**
 * `url` with a query string that makes the CDN fetch it from the bucket rather than serve a copy it cached: a feed
 * file checked before a publish (a 404) or the previous version's would otherwise be what a check sees.
 */
export function uncached(url: string, now = Date.now()): string {
  return `${url}${url.includes('?') ? '&' : '?'}t=${now}`;
}

/** Whether the module at `metaUrl` is the script node was started with, rather than one a test imported. */
export function isMain(metaUrl: string): boolean {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}
