/**
 * Video addresses a page can show. Only a documented set of hosts is supported: YouTube and Vimeo. A video is
 * always played by its host's own player, which a visitor's browser loads from that host only when the visitor
 * asks it to play. Nothing here is part of the exported site: the generator resolves an address to the
 * player's address once, and the site renders that.
 */

export type VideoProviderId = 'youtube' | 'vimeo';

export interface VideoProvider {
  id: VideoProviderId;
  /** The host's name, as authors and visitors know it. */
  name: string;
  /** Where a visitor's browser loads the player from when the video plays. */
  playerOrigin: string;
  /** Address forms an author can paste, for the inspector's help. */
  examples: string[];
}

export const VIDEO_PROVIDERS: Record<VideoProviderId, VideoProvider> = {
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    // YouTube's privacy-enhanced player: it sets no cookies until the video plays.
    playerOrigin: 'https://www.youtube-nocookie.com',
    examples: ['https://www.youtube.com/watch?v=…', 'https://youtu.be/…', 'https://www.youtube.com/shorts/…']
  },
  vimeo: {
    id: 'vimeo',
    name: 'Vimeo',
    playerOrigin: 'https://player.vimeo.com',
    examples: ['https://vimeo.com/…', 'https://player.vimeo.com/video/…']
  }
};

/** The hosts' names, for messages: "YouTube or Vimeo". */
export const VIDEO_PROVIDER_NAMES = Object.values(VIDEO_PROVIDERS)
  .map((p) => p.name)
  .join(' or ');

/** A supported video, as its address names it. */
export interface VideoSource {
  provider: VideoProviderId;
  /** The host's ID for the video: 11 characters on YouTube, digits on Vimeo. */
  id: string;
  /** Vimeo's privacy hash, which an unlisted video's address carries. */
  hash?: string;
  /** Where playback starts, in whole seconds, when the address says. */
  start?: number;
}

/** What an author's video address amounts to. */
export type VideoCheck =
  | { status: 'empty' }
  | { status: 'unsupported'; message: string }
  | { status: 'ok'; source: VideoSource };

const MAX_URL = 2048;
const CONTROL = /[\u0000-\u001f\u007f]/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,32}$/i;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'player.vimeo.com']);
/** Paths whose next segment is the video ID on YouTube. */
const YOUTUBE_ID_PATHS = new Set(['embed', 'shorts', 'live', 'v', 'e']);

/** A start time as YouTube and Vimeo write it ("90", "90s", "1m30s", "1h2m3s"), in seconds. */
export function parseStart(raw: string | null | undefined): number | undefined {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) || undefined;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds || undefined;
}

function toUrl(raw: string): URL | null {
  let s = raw.trim();
  // Addresses are often pasted without their scheme: "youtu.be/…", "www.youtube.com/watch?v=…".
  if (s.startsWith('//')) s = 'https:' + s;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.port) return null;
    return u;
  } catch {
    return null;
  }
}

function youtube(u: URL, host: string): VideoSource | null {
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (host === 'youtu.be') id = parts[0];
  else if (parts[0] === 'watch') id = u.searchParams.get('v') ?? undefined;
  else if (parts.length >= 2 && YOUTUBE_ID_PATHS.has(parts[0])) id = parts[1];
  if (!id || !YOUTUBE_ID.test(id)) return null;
  const start = parseStart(u.searchParams.get('t') ?? u.searchParams.get('start'));
  return { provider: 'youtube', id, ...(start ? { start } : {}) };
}

function vimeo(u: URL, host: string): VideoSource | null {
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  let hash: string | undefined;
  if (host === 'player.vimeo.com') {
    if (parts[0] !== 'video' || parts.length !== 2) return null;
    id = parts[1];
    hash = u.searchParams.get('h') ?? undefined;
  } else if (parts[0] === 'channels' && parts.length === 3) {
    id = parts[2];
  } else if (parts[0] === 'groups' && parts[2] === 'videos' && parts.length === 4) {
    id = parts[3];
  } else if (parts.length === 1 || parts.length === 2) {
    // vimeo.com/{id}, or vimeo.com/{id}/{hash} for an unlisted video.
    id = parts[0];
    hash = parts[1] ?? u.searchParams.get('h') ?? undefined;
  }
  if (!id || !VIMEO_ID.test(id)) return null;
  if (hash !== undefined && !VIMEO_HASH.test(hash)) return null;
  const start = parseStart(/^#t=(.+)$/.exec(u.hash)?.[1]);
  return { provider: 'vimeo', id, ...(hash ? { hash: hash.toLowerCase() } : {}), ...(start ? { start } : {}) };
}

/** The supported video an address names, or null for anything else (another host, a channel page, a hostile address). */
export function parseVideoUrl(raw: unknown): VideoSource | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_URL || CONTROL.test(raw.trim())) return null;
  const u = toUrl(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be' || YOUTUBE_HOSTS.has(host)) return youtube(u, host);
  if (VIMEO_HOSTS.has(host)) return vimeo(u, host);
  return null;
}

/** Whether an address is empty, a supported video, or something the page cannot show, with a message that says why. */
export function checkVideoUrl(raw: unknown): VideoCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { status: 'empty' };
  const source = parseVideoUrl(raw);
  if (source) return { status: 'ok', source };
  return { status: 'unsupported', message: `This address isn’t a ${VIDEO_PROVIDER_NAMES} video. Paste the address of a single video from ${VIDEO_PROVIDER_NAMES}.` };
}

/**
 * The player's address. Every parameter is built here from parsed parts, never copied from the author's address.
 * `autoplay` is for a player loaded by the visitor's own click, so one click starts the video.
 */
export function videoEmbedUrl(source: VideoSource, opts: { autoplay?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (source.provider === 'youtube') {
    if (opts.autoplay) params.set('autoplay', '1');
    if (source.start) params.set('start', String(source.start));
    const q = params.toString();
    return `${VIDEO_PROVIDERS.youtube.playerOrigin}/embed/${source.id}${q ? `?${q}` : ''}`;
  }
  if (source.hash) params.set('h', source.hash);
  // Vimeo's player stops tracking the visitor with dnt.
  params.set('dnt', '1');
  if (opts.autoplay) params.set('autoplay', '1');
  return `${VIDEO_PROVIDERS.vimeo.playerOrigin}/video/${source.id}?${params.toString()}${source.start ? `#t=${source.start}s` : ''}`;
}

/** The video's own page on its host, for a visitor who would rather watch it there. */
export function videoWatchUrl(source: VideoSource): string {
  if (source.provider === 'youtube') return `https://www.youtube.com/watch?v=${source.id}${source.start ? `&t=${source.start}s` : ''}`;
  return `https://vimeo.com/${source.id}${source.hash ? `/${source.hash}` : ''}${source.start ? `#t=${source.start}s` : ''}`;
}
