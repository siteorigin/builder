/**
 * The Video section (issue #73): found in Insert, placed and edited through the ordinary operations, written into the
 * site with its player, read by the page checks, and played in Preview only through a player frame the editor admits.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { CATEGORY_LABELS, catalogueComponent, catalogueEntries, searchCatalogue } from '@catalogue/index';
import { FOUNDATION_EXAMPLES } from '@catalogue/foundation/ai-examples';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, defFile, generateProject } from '@generator/index';
import { headingOutline, renderedContent } from '@generator/checks';
import { pageText } from '@generator/search';
import { VIDEO_HELPER_FILE, VIDEO_JS, VIDEO_PLAYER_FILE, usesVideo, videoPlayerSvelte } from '@generator/video';
import { isVideoPlayerUrl, parseVideoUrl, videoEmbedUrl, videoFieldNotes, videoWatchUrl, type VideoSource } from '@shared/video';
import { checkSvelteSource } from '../../src/main/codecheck';
import { playerFrameAllowed, type FrameView } from '../../src/main/player-frames';

const YT = 'dQw4w9WgXcQ';
const TOUR = `https://www.youtube.com/watch?v=${YT}`;

/** Addresses both readers must agree on, supported or not. */
const CORPUS = [
  TOUR,
  `https://youtu.be/${YT}?t=90`,
  `https://www.youtube.com/watch?v=${YT}&t=1m30s`,
  `https://youtu.be/${YT}?t=1000000000000000000000`,
  `https://m.youtube.com/watch?v=${YT}`,
  `https://www.youtube.com/embed/${YT}?start=42`,
  `https://www.youtube-nocookie.com/embed/${YT}?autoplay=1&start=42`,
  `https://www.youtube.com/shorts/${YT}`,
  `youtu.be/${YT}`,
  `//youtu.be/${YT}`,
  'https://vimeo.com/76979871',
  'https://vimeo.com/76979871/1A2B3C4D5E',
  'https://vimeo.com/76979871#t=1m5s',
  'https://player.vimeo.com/video/76979871?h=1a2b3c4d5e&dnt=1&autoplay=1#t=65s',
  'https://vimeo.com/channels/staffpicks/76979871?h=1a2b3c4d5e',
  'https://vimeo.com/groups/shortfilms/videos/76979871',
  '',
  '   ',
  'https://www.youtube.com/playlist?list=PL123',
  `https://youtube.com.evil.example/watch?v=${YT}`,
  `https://user:pass@www.youtube.com/watch?v=${YT}`,
  `https://www.youtube.com:8443/watch?v=${YT}`,
  `javascript:alert(1)//youtu.be/${YT}`,
  `https://www.you\ntube.com/watch?v=${YT}`,
  'https://vimeo.com/76979871/not-a-hash!',
  'https://vimeo.com/76979871?h=',
  'https://example.com/tour.mp4'
];

describe('the site’s copy of the address reader', () => {
  let dir: string;
  let site: {
    parseVideoUrl: (u: unknown) => VideoSource | null;
    videoEmbedUrl: (s: VideoSource, o?: { autoplay?: boolean }) => string;
    videoWatchUrl: (s: VideoSource) => string;
    VIDEO_PROVIDERS: Record<string, { name: string; player: string }>;
  };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'so-video-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, VIDEO_HELPER_FILE), VIDEO_JS);
    site = await import(pathToFileURL(join(dir, VIDEO_HELPER_FILE)).href);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(CORPUS)('reads %j exactly as the editor does', (url) => {
    const ours = parseVideoUrl(url);
    expect(site.parseVideoUrl(url)).toEqual(ours);
    if (!ours) return;
    for (const autoplay of [false, true]) expect(site.videoEmbedUrl(ours, { autoplay })).toBe(videoEmbedUrl(ours, { autoplay }));
    expect(site.videoWatchUrl(ours)).toBe(videoWatchUrl(ours));
  });

  it('names the same hosts and players', () => {
    expect(site.VIDEO_PROVIDERS).toEqual({ youtube: { name: 'YouTube', player: 'https://www.youtube-nocookie.com' }, vimeo: { name: 'Vimeo', player: 'https://player.vimeo.com' } });
  });

  it('imports nothing and carries no editor code', () => {
    expect(VIDEO_JS).not.toMatch(/^\s*import\b|data-so-|__so|siteorigin-bridge|builderTest/m);
  });
});

describe('player addresses the preview admits', () => {
  it('admits exactly the addresses the player writes, with and without autoplay', () => {
    for (const url of CORPUS) {
      const source = parseVideoUrl(url);
      if (!source) continue;
      expect(isVideoPlayerUrl(videoEmbedUrl(source))).toBe(true);
      expect(isVideoPlayerUrl(videoEmbedUrl(source, { autoplay: true }))).toBe(true);
    }
  });

  it.each([
    `https://www.youtube-nocookie.com/embed/${YT}?autoplay=1&mute=1`,
    `https://www.youtube-nocookie.com/embed/${YT}?start=42&autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${YT}/`,
    `https://www.youtube-nocookie.com/embed/${YT}#x`,
    `https://www.youtube.com/embed/${YT}`,
    `http://www.youtube-nocookie.com/embed/${YT}`,
    `https://www.youtube-nocookie.com/embed/videoseries?list=PL123`,
    `https://www.youtube-nocookie.com.evil.example/embed/${YT}`,
    'https://player.vimeo.com/video/76979871',
    'https://player.vimeo.com/video/76979871?dnt=1&h=1a2b3c4d5e',
    'https://player.vimeo.com/video/76979871?dnt=1&autoplay=1&api=1',
    'https://vimeo.com/76979871',
    'https://accounts.google.com/',
    'about:blank',
    ''
  ])('refuses %j', (url) => {
    expect(isVideoPlayerUrl(url)).toBe(false);
  });
});

describe('frames that may load a player', () => {
  const DEV = 'http://127.0.0.1:5173/';
  const PLAYER = `https://www.youtube-nocookie.com/embed/${YT}?autoplay=1`;
  const frame = (url: string, parent: FrameView | null, extra: Partial<FrameView> = {}): FrameView => ({ url, parent, ...extra });
  const editor = frame('app://editor/index.html', null);
  const preview = frame('http://127.0.0.1:5173/contact/', editor);
  const slot = frame('', preview);

  it('admits a player frame placed directly in the previewed page', () => {
    expect(playerFrameAllowed(PLAYER, slot, editor, DEV)).toBe(true);
    expect(playerFrameAllowed('https://player.vimeo.com/video/76979871?dnt=1&autoplay=1', slot, editor, DEV)).toBe(true);
  });

  it('refuses anything else', () => {
    // Another address, or the same host's other pages.
    expect(playerFrameAllowed('https://example.com/', slot, editor, DEV)).toBe(false);
    expect(playerFrameAllowed(`https://www.youtube-nocookie.com/embed/${YT}?autoplay=1&mute=1`, slot, editor, DEV)).toBe(false);
    // No preview running, or a page of another server.
    expect(playerFrameAllowed(PLAYER, slot, editor, null)).toBe(false);
    expect(playerFrameAllowed(PLAYER, slot, editor, 'http://127.0.0.1:51730/')).toBe(false);
    expect(playerFrameAllowed(PLAYER, frame('', frame('http://127.0.0.1:51730/', editor)), editor, DEV)).toBe(false);
    // A frame directly in the editor, one nested inside a player, or one under another window.
    expect(playerFrameAllowed(PLAYER, frame('', editor), editor, DEV)).toBe(false);
    expect(playerFrameAllowed(PLAYER, frame('', frame(PLAYER, preview)), editor, DEV)).toBe(false);
    expect(playerFrameAllowed(PLAYER, frame('', frame(DEV, frame('app://editor/', null))), editor, DEV)).toBe(false);
    // A frame that is gone, or that cannot be read.
    expect(playerFrameAllowed(PLAYER, null, editor, DEV)).toBe(false);
    expect(playerFrameAllowed(PLAYER, frame('', preview, { detached: true }), editor, DEV)).toBe(false);
    expect(playerFrameAllowed(PLAYER, frame('', preview, { isDestroyed: () => true }), editor, DEV)).toBe(false);
    expect(playerFrameAllowed(PLAYER, frame('', frame(DEV, editor, { detached: true })), editor, DEV)).toBe(false);
    const broken = { url: '', get parent(): FrameView { throw new Error('Frame disposed'); } };
    expect(playerFrameAllowed(PLAYER, broken, editor, DEV)).toBe(false);
  });
});

describe('the player helper', () => {
  it('compiles for the browser and the server, for visitors and for the editor', () => {
    for (const instrument of [false, true])
      for (const generate of ['client', 'server'] as const) expect(() => compile(videoPlayerSvelte(instrument), { filename: VIDEO_PLAYER_FILE, generate, runes: true })).not.toThrow();
  });

  it('keeps editor code out of the visitors’ copy', () => {
    const clean = videoPlayerSvelte(false);
    expect(clean).not.toMatch(/data-so-|__siteoriginBridge|MutationObserver|siteorigin/);
    const dev = videoPlayerSvelte(true);
    // Edit and the moment before the editor takes over the page never play; Edit drops a playing video.
    expect(dev).toMatch(/if \(!window\.__siteoriginBridge \|\| document\.documentElement\.hasAttribute\('data-so-editing'\)\) return;/);
    expect(dev).toMatch(/attributeFilter: \['data-so-editing'\]/);
    expect(dev).toMatch(/return \(\) => watch\.disconnect\(\);/);
    expect(dev).toContain('data-so-editor-only=""');
  });

  it('loads the player only from the address it builds, with focus moved into it', () => {
    const clean = videoPlayerSvelte(false);
    expect(clean).toMatch(/const src = \$derived\(video \? videoEmbedUrl\(video, \{ autoplay: true \}\) : ''\)/);
    expect(clean).toMatch(/<iframe[\s\S]*bind:this=\{frame\}[\s\S]*\{src\}[\s\S]*title=\{name\}/);
    expect(clean).toContain('frame?.focus()');
    // Only a press of Play shows the player; another address shows its own button again.
    expect(clean).toMatch(/\{#if playing && playing === src\}/);
  });
});

describe('the Video section', () => {
  const fresh = () => createStarterState('business', 'Kloof', false);
  const contact = (s: ProjectState) => Object.values(s.pages).find((p) => p.route === '/contact/')!;

  /** The section inserted on the Contact page after its first section, as Insert does, with these properties. */
  function placed(props: Record<string, unknown> = {}) {
    const s0 = fresh();
    const page = contact(s0);
    const owner = { kind: 'page' as const, id: page.id };
    const r = applyOperations(s0, [{ type: 'node.insert', owner, componentId: 'media.video', index: 1, ...(Object.keys(props).length ? { props } : {}) }]);
    const nodeId = r.results[0].nodeId as string;
    return { s: r.state, owner, nodeId, node: r.state.pages[page.id].nodes[nodeId] as InstanceNode };
  }

  it('is found in Insert by the words authors search for, under Media', () => {
    const entry = catalogueEntries('foundation').find((e) => e.componentId === 'media.video')!;
    expect(entry).toBeDefined();
    expect(CATEGORY_LABELS[entry.category]).toBe('Media');
    // Insert keeps a section when every word of the search is in its name, description, tags or category.
    const hay = `${entry.name} ${entry.description} ${entry.tags.join(' ')} ${CATEGORY_LABELS[entry.category]} section`.toLowerCase();
    for (const q of ['video', 'YouTube', 'embed', 'Vimeo', 'studio tour']) {
      expect(q.toLowerCase().split(/\s+/).every((w) => hay.includes(w)), q).toBe(true);
      expect(searchCatalogue('foundation', q).map((e) => e.componentId), q).toContain('media.video');
    }
    expect(catalogueEntries('foundation-alt').some((e) => e.componentId === 'media.video')).toBe(true);
  });

  it('says which hosts it plays from and where a visitor’s browser loads the player', () => {
    const def = catalogueComponent('foundation', 'media.video')!;
    expect(def.description).toMatch(/YouTube or Vimeo/);
    expect(def.description).toMatch(/only when they press it/);
    expect((def.properties.url as { description?: string }).description).toMatch(/YouTube or Vimeo.*load the player from that site when they press Play/);
  });

  it('is placed after the chosen section with an empty title and address, and each is edited on its own', () => {
    const { s, owner, nodeId, node } = placed();
    expect(contact(s).rootIds.indexOf(nodeId)).toBe(1);
    expect(node.props).toMatchObject({ heading: 'Take a look around', title: '', url: '' });
    const titled = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'title', value: 'Tour of our studio' }]).state;
    const both = applyOperations(titled, [{ type: 'instance.setProp', owner, nodeId, prop: 'url', value: TOUR }]).state;
    expect((both.pages[owner.id].nodes[nodeId] as InstanceNode).props).toMatchObject({ heading: 'Take a look around', title: 'Tour of our studio', url: TOUR });
  });

  it('keeps an address it cannot play, so the author can correct it', () => {
    const { s, owner, nodeId } = placed();
    const odd = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'url', value: 'https://example.com/tour.mp4' }]).state;
    expect((odd.pages[owner.id].nodes[nodeId] as InstanceNode).props.url).toBe('https://example.com/tour.mp4');
  });

  it('keeps its title and address when the theme is switched', () => {
    const { s, owner, nodeId } = placed({ title: 'Tour of our studio', url: TOUR });
    const alt = applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state;
    const node = alt.pages[owner.id].nodes[nodeId] as InstanceNode;
    expect(alt.components[node.definitionId].provenance?.pack).toBe('foundation-alt');
    expect(node.props).toMatchObject({ title: 'Tour of our studio', url: TOUR });
    expect(usesVideo(alt)).toBe(true);
  });

  it('writes the player into a site that shows a video, and only then', () => {
    expect(usesVideo(fresh())).toBe(false);
    const plain = generateProject(fresh());
    expect([...plain.keys()].some((f) => /VideoPlayer|runtime\/video\.js/.test(f))).toBe(false);
    const { s, node } = placed({ title: 'Tour of our studio', url: TOUR });
    const clean = generateProject(s);
    const dev = generateProject(s, { instrument: true });
    expect(clean.get(`${RUNTIME_DIR}/${VIDEO_HELPER_FILE}`)).toBe(VIDEO_JS);
    expect(clean.get(`${RUNTIME_DIR}/${VIDEO_PLAYER_FILE}`)).toBe(videoPlayerSvelte(false));
    expect(dev.get(`${RUNTIME_DIR}/${VIDEO_PLAYER_FILE}`)).toBe(videoPlayerSvelte(true));
    // The section's code imports the player from where the site has it.
    const source = clean.get(defFile(s.components[node.definitionId]))!;
    expect(source).toContain("import VideoPlayer from '../runtime/VideoPlayer.svelte';");
    expect(defFile(s.components[node.definitionId])).toMatch(/^src\/lib\/siteorigin\/generated\/[^/]+\.svelte$/);
    // Written before the section that imports it, so a preview never loads the section without its player.
    const order = [...clean.keys()];
    expect(order.indexOf(`${RUNTIME_DIR}/${VIDEO_PLAYER_FILE}`)).toBeLessThan(order.indexOf(defFile(s.components[node.definitionId])));
  });

  it('counts its heading in the page outline, and the video’s title as page text only when the video can play', () => {
    const { s, owner, nodeId } = placed({ heading: 'Take a tour', title: 'Tour of our studio', url: TOUR });
    expect(headingOutline(s, owner.id).some((h) => h.level === 2 && h.text === 'Take a tour' && h.nodeId === nodeId)).toBe(true);
    const text = pageText(s, contact(s));
    expect(text).toContain('Take a tour');
    expect(text).toContain('Tour of our studio');
    expect(text).not.toContain('youtube');
    const shown = renderedContent(s, contact(s)).filter((c) => c.nodeId === nodeId);
    expect(shown.map((c) => c.source && 'prop' in c.source && c.source.prop)).toEqual(expect.arrayContaining(['heading', 'title']));
    expect(shown.some((c) => c.source && 'prop' in c.source && c.source.prop === 'url')).toBe(false);
    expect(shown.every((c) => !c.custom)).toBe(true);
    // An address it cannot play shows no Play button, so its title is not on the page.
    const odd = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'url', value: 'https://example.com/tour.mp4' }]).state;
    expect(pageText(odd, contact(odd))).not.toContain('Tour of our studio');
  });

  it('has a worked example the assistant can follow', () => {
    const example = FOUNDATION_EXAMPLES.find((e) => e.componentId === 'media.video')!;
    expect(example.keywords).toEqual(expect.arrayContaining(['video', 'youtube', 'vimeo', 'embed']));
    expect(parseVideoUrl(example.props.url)).not.toBeNull();
  });

  it('passes the code checks a developer’s copy of it would face', async () => {
    const def = catalogueComponent('foundation', 'media.video')!;
    const errors = (await checkSvelteSource(def.source!)).filter((p) => p.severity === 'error');
    expect(errors).toEqual([]);
  });
});

describe('what the inspector says at a video’s fields', () => {
  it('says nothing more while the address is empty', () => {
    expect(videoFieldNotes({})).toEqual({});
    expect(videoFieldNotes({ url: '  ', title: '' })).toEqual({});
  });

  it('says an address it cannot play is not a YouTube or Vimeo video, and that visitors see none', () => {
    const notes = videoFieldNotes({ url: 'https://example.com/tour.mp4', title: 'Tour' });
    expect(notes.url?.error).toMatch(/isn’t a YouTube or Vimeo video.*Visitors see no video until then/);
    expect(notes.title).toBeUndefined();
  });

  it('says where a playable video loads from, and asks for a title when it has none', () => {
    expect(videoFieldNotes({ url: TOUR, title: 'Tour' })).toEqual({ url: { hint: expect.stringMatching(/A YouTube video\..*from www\.youtube-nocookie\.com only when they press Play/) } });
    const vimeo = videoFieldNotes({ url: 'https://vimeo.com/76979871', title: ' ' });
    expect(vimeo.url?.hint).toMatch(/A Vimeo video\..*from player\.vimeo\.com/);
    expect(vimeo.title?.error).toMatch(/Add a title.*“Video from Vimeo”/);
  });
});
