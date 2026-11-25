import { describe, expect, it } from 'vitest';
import { checkRelayUrl, DEFAULT_RELAY_URL, formatInviteLink, parseInviteLink, RELAY_URL_ENV, resolveRelayUrl } from '@shared/live/relay-url';

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
    expect(checkRelayUrl('https://example.com/live/')).toEqual({ ok: true, url: 'https://example.com/live' });
    expect(checkRelayUrl('HTTPS://Live.SiteOrigin.com')).toEqual({ ok: true, url: 'https://live.siteorigin.com' });
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
      'https://live.\nsiteorigin.com',
      'https://live.siteorigin.com/a b'
    ])
      expect(checkRelayUrl(bad)).toMatchObject({ ok: false });
    expect(checkRelayUrl(42)).toMatchObject({ ok: false });
  });
});

describe('invite links', () => {
  it('formats /s/<roomId> under the relay', () => {
    expect(formatInviteLink('https://live.siteorigin.com/', ROOM)).toBe(`https://live.siteorigin.com/s/${ROOM}`);
    expect(formatInviteLink('http://127.0.0.1:8787', ROOM)).toBe(`http://127.0.0.1:8787/s/${ROOM}`);
    expect(formatInviteLink('https://example.com/live', ROOM)).toBe(`https://example.com/live/s/${ROOM}`);
    expect(() => formatInviteLink('https://live.siteorigin.com', 'Bad Room')).toThrow();
    expect(() => formatInviteLink('ws://127.0.0.1', ROOM)).toThrow();
  });

  it('parses what it formats', () => {
    for (const relay of ['https://live.siteorigin.com', 'http://127.0.0.1:8787', 'https://collaborate.siteorigin.com', 'https://example.com/live'])
      expect(parseInviteLink(formatInviteLink(relay, ROOM))).toEqual({ relayUrl: relay, roomId: ROOM });
  });

  it('ignores surrounding spaces, one trailing slash, and an added query or fragment', () => {
    expect(parseInviteLink(`  https://live.siteorigin.com/s/${ROOM}/  `)).toEqual({ relayUrl: 'https://live.siteorigin.com', roomId: ROOM });
    expect(parseInviteLink(`https://live.siteorigin.com/s/${ROOM}?utm_source=chat#x`)).toEqual({ relayUrl: 'https://live.siteorigin.com', roomId: ROOM });
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
      ''
    ])
      expect(parseInviteLink(bad)).toBeNull();
    expect(parseInviteLink(undefined)).toBeNull();
  });
});
