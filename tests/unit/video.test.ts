import { describe, expect, it } from 'vitest';
import { checkVideoUrl, parseStart, parseVideoUrl, videoEmbedUrl, videoWatchUrl } from '@shared/video';

const YT = 'dQw4w9WgXcQ';

describe('video addresses', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YT}`, YT],
    [`https://youtube.com/watch?v=${YT}&list=PL123&index=2`, YT],
    [`https://m.youtube.com/watch?v=${YT}`, YT],
    [`https://youtu.be/${YT}`, YT],
    [`https://youtu.be/${YT}?si=abc`, YT],
    [`https://www.youtube.com/embed/${YT}`, YT],
    [`https://www.youtube-nocookie.com/embed/${YT}`, YT],
    [`https://www.youtube.com/shorts/${YT}`, YT],
    [`https://www.youtube.com/live/${YT}`, YT],
    [`youtu.be/${YT}`, YT],
    [`www.youtube.com/watch?v=${YT}`, YT],
    [`  https://www.youtube.com/watch?v=${YT}  `, YT]
  ])('reads the YouTube video in %s', (url, id) => {
    expect(parseVideoUrl(url)).toMatchObject({ provider: 'youtube', id });
  });

  it.each([
    ['https://vimeo.com/76979871', { id: '76979871' }],
    ['https://www.vimeo.com/76979871', { id: '76979871' }],
    ['https://vimeo.com/76979871/1a2b3c4d5e', { id: '76979871', hash: '1a2b3c4d5e' }],
    ['https://player.vimeo.com/video/76979871', { id: '76979871' }],
    ['https://player.vimeo.com/video/76979871?h=1a2b3c4d5e', { id: '76979871', hash: '1a2b3c4d5e' }],
    ['https://vimeo.com/channels/staffpicks/76979871', { id: '76979871' }],
    ['https://vimeo.com/groups/shortfilms/videos/76979871', { id: '76979871' }],
    ['vimeo.com/76979871', { id: '76979871' }]
  ])('reads the Vimeo video in %s', (url, want) => {
    const got = parseVideoUrl(url);
    expect(got).toMatchObject({ provider: 'vimeo', ...want });
    if (!('hash' in want)) expect(got?.hash).toBeUndefined();
  });

  it.each([
    '',
    '   ',
    'not a url',
    'https://www.youtube.com/',
    'https://www.youtube.com/@studio',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short',
    `https://www.youtube.com/watch?v=${YT}x`,
    `https://youtube.com.evil.example/watch?v=${YT}`,
    `https://evil.example/youtube.com/watch?v=${YT}`,
    `https://user:pass@www.youtube.com/watch?v=${YT}`,
    `https://www.youtube.com:8443/watch?v=${YT}`,
    `javascript:alert(1)//youtu.be/${YT}`,
    `data:text/html,youtu.be/${YT}`,
    `ftp://youtu.be/${YT}`,
    `https://youtu.be/${YT.slice(0, 10)}"><script>`,
    'https://vimeo.com/',
    'https://vimeo.com/studio',
    'https://vimeo.com/76979871/not-a-hash!',
    'https://player.vimeo.com/video/abc',
    'https://vimeo.com.evil.example/76979871',
    `https://www.you\ntube.com/watch?v=${YT}`,
    `https://example.com/video.mp4`
  ])('refuses %j', (url) => {
    expect(parseVideoUrl(url)).toBeNull();
  });

  it('refuses values that are not text', () => {
    expect(parseVideoUrl(undefined)).toBeNull();
    expect(parseVideoUrl({ url: `https://youtu.be/${YT}` })).toBeNull();
    expect(parseVideoUrl('https://youtu.be/' + 'x'.repeat(3000))).toBeNull();
  });

  it('keeps the start time an address carries', () => {
    expect(parseVideoUrl(`https://youtu.be/${YT}?t=90`)?.start).toBe(90);
    expect(parseVideoUrl(`https://www.youtube.com/watch?v=${YT}&t=1m30s`)?.start).toBe(90);
    expect(parseVideoUrl(`https://www.youtube.com/embed/${YT}?start=42`)?.start).toBe(42);
    expect(parseVideoUrl('https://vimeo.com/76979871#t=1m5s')?.start).toBe(65);
    expect(parseVideoUrl(`https://youtu.be/${YT}?t=0`)?.start).toBeUndefined();
    expect(parseVideoUrl(`https://youtu.be/${YT}?t=soon`)?.start).toBeUndefined();
    expect(parseStart('1h2m3s')).toBe(3723);
    expect(parseStart('m')).toBeUndefined();
  });

  it('builds the player address from the parsed parts only', () => {
    expect(videoEmbedUrl({ provider: 'youtube', id: YT })).toBe(`https://www.youtube-nocookie.com/embed/${YT}`);
    expect(videoEmbedUrl({ provider: 'youtube', id: YT, start: 90 }, { autoplay: true })).toBe(`https://www.youtube-nocookie.com/embed/${YT}?autoplay=1&start=90`);
    expect(videoEmbedUrl({ provider: 'vimeo', id: '76979871' })).toBe('https://player.vimeo.com/video/76979871?dnt=1');
    expect(videoEmbedUrl({ provider: 'vimeo', id: '76979871', hash: '1a2b3c4d5e', start: 65 }, { autoplay: true })).toBe(
      'https://player.vimeo.com/video/76979871?h=1a2b3c4d5e&dnt=1&autoplay=1#t=65s'
    );
    // Other parameters of the pasted address never reach the player.
    const parsed = parseVideoUrl(`https://www.youtube.com/watch?v=${YT}&autoplay=1&mute=0&origin=https://evil.example`)!;
    expect(videoEmbedUrl(parsed)).toBe(`https://www.youtube-nocookie.com/embed/${YT}`);
  });

  it('links to the video on its host', () => {
    expect(videoWatchUrl({ provider: 'youtube', id: YT, start: 5 })).toBe(`https://www.youtube.com/watch?v=${YT}&t=5s`);
    expect(videoWatchUrl({ provider: 'vimeo', id: '76979871', hash: 'abcdef12' })).toBe('https://vimeo.com/76979871/abcdef12');
  });

  it('says whether an address is empty, supported, or not', () => {
    expect(checkVideoUrl('')).toEqual({ status: 'empty' });
    expect(checkVideoUrl(undefined)).toEqual({ status: 'empty' });
    expect(checkVideoUrl(`https://youtu.be/${YT}`)).toMatchObject({ status: 'ok', source: { provider: 'youtube', id: YT } });
    const bad = checkVideoUrl('https://example.com/tour.mp4');
    expect(bad.status).toBe('unsupported');
    expect(bad.status === 'unsupported' && bad.message).toMatch(/YouTube or Vimeo/);
  });
});
