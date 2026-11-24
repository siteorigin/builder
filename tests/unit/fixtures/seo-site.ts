/**
 * A small site set up the way the SEO audit (#580) asks: a public URL with a sub-path, a site icon and sharing image,
 * Home and Services with titles and descriptions of their own linked from the header, and a published post with a
 * described picture, a decorative one and headings in order. The audit finds nothing on it; each test changes one
 * thing to see one finding.
 */
import type { AssetRecord, PageDoc, ProjectState, RichText } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

export const image = (id: string, extra: Partial<AssetRecord> = {}): AssetRecord => ({
  id,
  name: `Photo ${id}`,
  file: `static/assets/${id}-1a2b3c4d.png`,
  mime: 'image/png',
  bytes: 10,
  hash: `hash-${id}`,
  kind: 'image',
  createdAt: '2026-01-01T00:00:00.000Z',
  width: 1200,
  height: 630,
  ...extra
});

export const run = (s: ProjectState, ...ops: EditOperation[]): ProjectState => applyOperations(s, ops).state;

export const POST_BODY: RichText = [
  { type: 'p', spans: [{ text: 'Our spring classes open for bookings this week.' }] },
  { type: 'h2', spans: [{ text: 'What you will make' }] },
  { type: 'image', assetId: 'img_bowls', alt: 'Three glazed bowls on a shelf', caption: '' },
  { type: 'h3', spans: [{ text: 'Bowls and cups' }] },
  { type: 'p', spans: [{ text: 'Every student leaves with a set.' }] },
  { type: 'image', assetId: 'img_texture', alt: '', decorative: true },
  { type: 'h2', spans: [{ text: 'When' }] }
];

export function seoSite() {
  let s = createStarterState('blank', 'Riverside Studio', false);
  for (const a of [image('img_icon', { width: 512, height: 512 }), image('img_share', { altSuggestion: 'The studio from the river' }), image('img_bowls'), image('img_texture')]) s.assets.assets[a.id] = a;
  const home = s.site.homePageId;
  s = run(
    s,
    { type: 'site.update', baseUrl: 'https://example.com/studio', language: 'en', description: 'A pottery studio by the river, with classes for beginners and a shop of handmade work.', favicon: 'img_icon', socialImage: 'img_share' },
    { type: 'page.update', pageId: home, seoTitle: 'Riverside Studio · Pottery classes and handmade work', description: 'Pottery classes for beginners and a shop of handmade bowls, cups and plates, by the river in town.' },
    { type: 'page.create', pageId: 'pg_services', title: 'Services', route: '/services/', addToNavigation: true },
    { type: 'page.update', pageId: 'pg_services', seoTitle: 'Classes and commissions · Riverside Studio', description: 'Weekly wheel classes, private lessons and commissioned tableware made to order in the studio.' },
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring pottery classes', publishedAt: '2027-03-02', draft: false, excerpt: 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.', body: POST_BODY }
  );
  const page = (id: string) => s.pages[id] as PageDoc;
  return { state: s, home, services: 'pg_services', entry: 'en_spring', page };
}

/** A deep copy to change by hand, as a document edited outside the app would be. */
export const copy = (s: ProjectState): ProjectState => structuredClone(s);
