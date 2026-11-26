import { describe, expect, it } from 'vitest';
import { previewHostLabel } from '@shared/live/crypto';
import { isPreviewTarget } from '@shared/live/preview';
import { checkRelayUrl, DEFAULT_RELAY_URL, formatInviteLink, parseInviteLink, RELAY_URL_ENV, relaySocketUrl, resolveRelayUrl, roomPreviewOrigin, roomSocketPath, HOST_SOCKET_PATH, PREVIEW_ADMISSION_PATH } from '@shared/live/relay-url';

const ROOM = 'abcdefghijkmnpqrstuvwxyz';

describe('relay URL resolution', () => {
  it('reads SITEORIGIN_LIVE_RELAY_URL first, then the setting, then the production relay', () => {
    expect(RELAY_URL_ENV).toBe('SITEORIGIN_LIVE_RELAY_URL');
    expect(resolveRelayUrl({ env: 'http://127.0.0.1:8787', setting: 'https://collaborate.siteorigin.com' })).toEqual({ ok: true, url: 'http://127.0.0.1:8787', source: 'env' });
    expect(resolveRelayUrl({ setting: 'https://collaborate.siteorigin.com' })).toEqual({ ok: true, url: 'https://collaborate.siteorigin.com', source: 'setting' });
    expect(resolveRelayUrl({})).toEqual({ ok: true, url: DEFAULT_RELAY_URL, source: 'default' });
    expect(DEFAULT_RELAY_URL).toBe('https://live.siteorigin.com');
  });

  it('treats a blank value as unset', () => {
    expect(resolveRelayUrl({ env: '  ', setting: '' })).toEqual({ ok: true, url: DEFAULT_RELAY_URL, source: 'default' });
    expect(resolveRelayUrl({ env: null, setting: 'https://live.example.com' })).toMatchObject({ source: 'setting' });
  });

  it('reports an unusable value instead of falling through to another relay', () => {
    expect(resolveRelayUrl({ env: 'ftp://127.0.0.1', setting: 'https://live.example.com' })).toMatchObject({ ok: false, source: 'env' });
    expect(resolveRelayUrl({ setting: 'javascript:alert(1)' })).toMatchObject({ ok: false, source: 'setting' });
  });

  it('trims spaces and trailing slashes', () => {
    expect(checkRelayUrl('  https://live.siteorigin.com/  ')).toEqual({ ok: true, url: 'https://live.siteorigin.com' });
    expect(checkRelayUrl('http://127.0.0.1:8787///')).toEqual({ ok: true, url: 'http://127.0.0.1:8787' });
    expect(checkRelayUrl('HTTPS://Live.SiteOrigin.com')).toEqual({ ok: true, url: 'https://live.siteorigin.com' });
  });

  it('accepts custom domains, ports and IPv6 loopback', () => {
    expect(checkRelayUrl('https://collaborate.siteorigin.com')).toEqual({ ok: true, url: 'https://collaborate.siteorigin.com' });
    expect(checkRelayUrl('https://live.example.com:8443')).toEqual({ ok: true, url: 'https://live.example.com:8443' });
    expect(checkRelayUrl('https://live.example.com:443')).toEqual({ ok: true, url: 'https://live.example.com' });
    expect(checkRelayUrl('http://[::1]:8787')).toEqual({ ok: true, url: 'http://[::1]:8787' });
  });

  it('rejects non-HTTP(S) schemes', () => {
    for (const bad of ['ws://127.0.0.1:8787', 'wss://live.siteorigin.com', 'file:///tmp/relay', 'ftp://live.siteorigin.com', 'javascript:alert(1)', 'data:text/plain,hi'])
      expect(checkRelayUrl(bad)).toMatchObject({ ok: false });
  });

  it('rejects addresses that are not a plain relay base', () => {
    for (const bad of [
      '',
      'live.siteorigin.com',
      'https://user:pw@live.siteorigin.com',
      'https://live.siteorigin.com?x=1',
      'https://live.siteorigin.com/?',
      'https://live.siteorigin.com#top',
      `https://live.siteorigin.com/s/${ROOM}`,
      'https://example.com/live',
      'https://example.com/./',
      'https://live.\nsiteorigin.com',
      'https://live.\tsiteorigin.com',
      'https://live.siteorigin.com/a b',
      'https:\\\\live.siteorigin.com',
      // Matches the address grammar, but a URL parser would read the backslash as a slash.
      'https://relay.example\\extra',
      'https://live%2esiteorigin.com',
      'https://',
      'https://:8787'
    ])
      expect(checkRelayUrl(bad)).toMatchObject({ ok: false });
    expect(checkRelayUrl(42)).toMatchObject({ ok: false });
  });
});

describe('invite links', () => {
  it('formats /s/<roomId> under the relay', () => {
    expect(formatInviteLink('https://live.siteorigin.com/', ROOM)).toBe(`https://live.siteorigin.com/s/${ROOM}`);
    expect(formatInviteLink('http://127.0.0.1:8787', ROOM)).toBe(`http://127.0.0.1:8787/s/${ROOM}`);
    expect(() => formatInviteLink('https://live.siteorigin.com', 'Bad Room')).toThrow();
    expect(() => formatInviteLink('ws://127.0.0.1', ROOM)).toThrow();
  });

  it('parses what it formats', () => {
    for (const relay of ['https://live.siteorigin.com', 'http://127.0.0.1:8787', 'https://collaborate.siteorigin.com', 'http://[::1]:8787'])
      expect(parseInviteLink(formatInviteLink(relay, ROOM))).toEqual({ relayUrl: relay, roomId: ROOM });
  });

  it('allows surrounding spaces and one trailing slash, and normalizes the relay', () => {
    expect(parseInviteLink(`  https://live.siteorigin.com/s/${ROOM}/  `)).toEqual({ relayUrl: 'https://live.siteorigin.com', roomId: ROOM });
    expect(parseInviteLink(`HTTPS://LIVE.siteorigin.com:443/s/${ROOM}`)).toEqual({ relayUrl: 'https://live.siteorigin.com', roomId: ROOM });
  });

  it('rejects anything that is not exactly an invite link', () => {
    for (const bad of [
      ROOM,
      `live.siteorigin.com/s/${ROOM}`,
      `wss://live.siteorigin.com/s/${ROOM}`,
      `javascript://live.siteorigin.com/s/${ROOM}`,
      `https://user@live.siteorigin.com/s/${ROOM}`,
      `https://live.siteorigin.com/s/${ROOM}/preview/`,
      `https://live.siteorigin.com/s/${ROOM}//`,
      `https://live.siteorigin.com/s/${ROOM.toUpperCase()}`,
      `https://live.siteorigin.com/s/${ROOM.slice(1)}`,
      `https://live.siteorigin.com/x/${ROOM}`,
      `https://live.siteorigin.com/s/other/s/${ROOM}`,
      `https://live.siteorigin.com/s/${ROOM} extra`,
      `https://live.siteorigin.com/s/${ROOM}?utm_source=chat`,
      `https://live.siteorigin.com/s/${ROOM}#x`,
      `https://live.siteorigin.com/s/${ROOM}?`,
      `https://example.com/live/s/${ROOM}`,
      // Only valid once a URL parser has normalized it.
      `https://live.siteorigin.com/x/../s/${ROOM}`,
      `https://live.siteorigin.com/./s/${ROOM}`,
      `https://live.siteorigin.com\\s\\${ROOM}`,
      `https://live.siteorigin.com/s/%61${ROOM.slice(1)}`,
      `https://live.siteorigin.com/%73/${ROOM}`,
      `https://live.siteorigin.com/S/${ROOM}`,
      ''
    ])
      expect(parseInviteLink(bad)).toBeNull();
    expect(parseInviteLink(undefined)).toBeNull();
  });
});

describe('relay routes', () => {
  it('names the sockets and preview under each room, on ws:// or wss:// to match the relay', () => {
    expect(relaySocketUrl('https://live.siteorigin.com', HOST_SOCKET_PATH)).toBe('wss://live.siteorigin.com/ws/host');
    expect(relaySocketUrl('http://127.0.0.1:8787/', roomSocketPath(ROOM))).toBe(`ws://127.0.0.1:8787/s/${ROOM}/ws`);
    expect(() => relaySocketUrl('ftp://x', HOST_SOCKET_PATH)).toThrow();
    // Only the relay's own sockets: never a path glued onto the host name, or a room that is not one.
    for (const bad of ['ws/host', '', '/ws/host/', `/s/${ROOM}/ws/x`, '/s/BAD/ws', `/s/${ROOM}`, `/S/${ROOM}/ws`, `/s/${ROOM}/WS`, '/WS/HOST']) expect(() => relaySocketUrl('https://relay.example', bad), bad).toThrow();
  });
});

describe('room preview origins', () => {
  it('gives each room its own origin under the relay’s host, named by a digest of the room ID, never the ID itself', async () => {
    const origin = await roomPreviewOrigin('https://live.siteorigin.com', ROOM);
    expect(origin).toMatch(/^https:\/\/p-[23456789abcdefghijkmnpqrstuvwxyz]{32}\.live\.siteorigin\.com$/);
    expect(origin).not.toContain(ROOM);
    // The same for every side that works it out, and different for every room.
    expect(await roomPreviewOrigin('https://Live.SiteOrigin.com/', ROOM)).toBe(origin);
    expect(await roomPreviewOrigin('https://live.siteorigin.com', 'bcdefghijkmnpqrstuvwxyz2')).not.toBe(origin);
    expect(await previewHostLabel(ROOM)).toBe(origin.slice('https://'.length, origin.indexOf('.')));
    // A fixed vector: the label names each room's Durable Object, so a change to how it is made moves every room.
    expect(await previewHostLabel(ROOM)).toBe('p-sdg4ge463rrxek2zpgjsdcfk2gg3kebv');
  });

  it('keeps the relay’s scheme and port, and refuses a relay on an IP address, which has no subdomains', async () => {
    expect(await roomPreviewOrigin('http://relay.localhost:8787', ROOM)).toBe(`http://${await previewHostLabel(ROOM)}.relay.localhost:8787`);
    // `p-….localhost` and `localhost` are different sites, so the viewer's cookie would never reach the preview.
    await expect(roomPreviewOrigin('http://localhost:8787', ROOM)).rejects.toThrow(/with a dot/);
    await expect(roomPreviewOrigin('http://127.0.0.1:8787', ROOM)).rejects.toThrow(/IP address/);
    await expect(roomPreviewOrigin('http://[::1]:8787', ROOM)).rejects.toThrow(/IP address/);
    await expect(roomPreviewOrigin('https://live.siteorigin.com', 'BAD')).rejects.toThrow();
  });

  it('keeps ticket redemption at a path no page of the host’s site can have', () => {
    expect(PREVIEW_ADMISSION_PATH).toBe('/__siteorigin/admission');
    expect(isPreviewTarget(PREVIEW_ADMISSION_PATH)).toBe(false);
  });
});
