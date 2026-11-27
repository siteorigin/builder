/**
 * The WordPress export the `postsImport` scenario reads (#1047): a site's Tools → Export → All content of 1,000 posts,
 * as WordPress writes it, with a copy of its uploads folder beside it. Drawn here from a seed, so every run reads the
 * same file. Each post is block-editor prose of about 11,000 characters (paragraphs with bold, italic and links, two
 * headings, a list, a quote and a picture), written with the curly quotes and dashes WordPress stores, filed under a
 * category or two and a few tags, with its old address, two comments and the post meta an export carries; every
 * fourth has a featured picture, every 20th is a draft, and some link to other posts of the export. Beside them, the
 * attachments of the 10 pictures (small JPEGs in `uploads/`), a few pages and menu items, which the import leaves out.
 * Made once per machine, keyed by this recipe and the encoder's version, under `.tmp/perf/wordpress/`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures';

/** How many posts the export holds, and of those drafts (every DRAFT_EVERY-th). */
export const WP_POSTS = 1000;
export const WP_DRAFT_EVERY = 20;
export const WP_DRAFTS = Math.floor(WP_POSTS / WP_DRAFT_EVERY);
/** The pictures in its uploads folder, each shown in the text of every WP_PICTURES-th post. */
export const WP_PICTURES = 10;
/** Pages and menu items the export holds besides its posts: the import counts them and leaves them out. */
export const WP_PAGES = 5;
export const WP_MENU_ITEMS = 12;
/** The old site's address. */
export const WP_SITE = 'https://harbour-notes.example';
/** Bumped when the recipe below changes, so an export made by an older one is never reused. */
const RECIPE = 1;

/** A seeded xorshift32 stream. */
function stream(seed: number) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}

const WORDS = (
  'the harbour boats morning tide light weather market fish bread coffee walk path cliff garden village street ' +
  'season winter summer spring autumn rain wind sun evening night week year friends family neighbours visitors ' +
  'local small quiet busy old new long short bright grey warm cold early late simple careful slow quick open ' +
  'closed little great good better best first last next every other some many few most each both whole half ' +
  'shop café bakery school library church hall square bridge river shore beach sand stone wall gate door window ' +
  'table chair kitchen oven loaf cake tart jam honey apple pear plum berry cheese butter salt pepper herbs ' +
  'make bake cook build mend paint draw write read sing play learn teach share meet visit return remember ' +
  'notice listen watch wait hope plan try finish begin keep bring carry find follow lead leave stay change ' +
  'story picture note letter list map plan idea question answer reason detail moment memory surprise lesson ' +
  'because although while after before until since during between across through around along beside behind ' +
  'really almost always often sometimes never still already again together alone outside inside nearby'
).split(' ');
const CATEGORIES = ['News', 'Events', 'Recipes', 'Walks', 'History', 'People', 'Gardens', 'Boats', 'Weather', 'Markets', 'Workshops', 'Notes'];
const TAGS = Array.from({ length: 60 }, (_, i) => `${WORDS[(i * 7 + 3) % WORDS.length]} ${WORDS[(i * 11 + 5) % WORDS.length]}`.replace(/^\w/, (c) => c.toUpperCase()));
const AUTHORS = [
  ['morgan', 'Morgan Reed'],
  ['priya', 'Priya Shah'],
  ['tomas', 'Tomás Ortega']
] as const;

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const slugOf = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

/** What post `i` (from 1) is: its id, title, slug, date, old address, status, terms and the posts it links to. */
export function wpPost(i: number) {
  const next = stream(createHash('sha256').update(`siteorigin-perf-wp:${RECIPE}:${i}`).digest().readUInt32LE(0));
  const pick = <T>(list: readonly T[]) => list[next() % list.length];
  const words = (n: number) => Array.from({ length: n }, () => pick(WORDS));
  const head = words(3 + (next() % 4));
  const title = `${head[0].replace(/^\w/, (c) => c.toUpperCase())} ${head.slice(1).join(' ')}: notes from week ${(i % 52) + 1}`;
  const day = 1 + (i % 28);
  const month = 1 + (Math.floor(i / 28) % 12);
  const year = 2015 + Math.floor(i / 336);
  const date = `${year}-${pad(month, 2)}-${pad(day, 2)}`;
  const slug = `${slugOf(head.join(' '))}-${pad(i, 4)}`;
  const categories = [...new Set([pick(CATEGORIES), ...(next() % 3 === 0 ? [pick(CATEGORIES)] : [])])];
  const tags = [...new Set(Array.from({ length: 2 + (next() % 3) }, () => pick(TAGS)))];
  return {
    id: 100 + i * 3,
    title,
    slug,
    date,
    path: `/${year}/${pad(month, 2)}/${slug}/`,
    draft: i % WP_DRAFT_EVERY === 0,
    author: AUTHORS[i % AUTHORS.length],
    categories,
    tags,
    featured: i % 4 === 0 ? 1 + (i % WP_PICTURES) : null,
    picture: 1 + (i % WP_PICTURES),
    // A post links to one written before it, as a series does.
    links: i > 10 && i % 3 === 0 ? [i - 1 - (next() % 10)] : [],
    seed: next()
  };
}

/** A sentence of the post's prose: words, with the punctuation and curly quotes WordPress keeps. */
function sentence(next: () => number): string {
  const pick = <T>(list: readonly T[]) => list[next() % list.length];
  const n = 9 + (next() % 12);
  const w = Array.from({ length: n }, () => pick(WORDS));
  w[0] = w[0].replace(/^\w/, (c) => c.toUpperCase());
  const r = next() % 10;
  if (r === 0) w.splice(3, 0, '—');
  if (r === 1) {
    w[2] = `“${w[2]}`;
    w[5] = `${w[5]}”`;
  }
  if (r === 2) w[1] = `${w[1]}’s`;
  if (r === 3) w.splice(4, 0, 'don’t');
  return `${w.join(' ')}${r === 4 ? '…' : '.'}`;
}

/** A paragraph of a few sentences, some words made bold, italic or a link. */
function paragraph(next: () => number, links: string[]): string {
  const parts = Array.from({ length: 4 + (next() % 4) }, () => sentence(next));
  let html = parts.join(' ');
  const words = html.split(' ');
  if (words.length > 12) {
    const a = 3 + (next() % 5);
    words[a] = `<strong>${words[a]}</strong>`;
    const b = a + 3 + (next() % 4);
    words[b] = `<em>${words[b]}</em>`;
    if (links.length) {
      const c = b + 2;
      words[c] = `<a href="${links.shift()}">${words[c]}</a>`;
    } else if (next() % 5 === 0) {
      const c = b + 2;
      words[c] = `<a href="https://example.org/${WORDS[next() % WORDS.length]}">${words[c]}</a>`;
    }
    html = words.join(' ');
  }
  return html;
}

const picturePath = (n: number) => `2020/${pad(1 + (n % 12), 2)}/harbour-${pad(n, 2)}.jpg`;
const attachmentId = (n: number) => 10 + n;

/** Post `i`'s text as the block editor saves it: about 11,000 characters. */
export function wpContent(i: number): string {
  const p = wpPost(i);
  const next = stream(p.seed);
  const links = p.links.map((j) => `${WP_SITE}${wpPost(j).path}`);
  const blocks: string[] = [];
  const para = () => blocks.push(`<!-- wp:paragraph -->\n<p>${paragraph(next, links)}</p>\n<!-- /wp:paragraph -->`);
  for (let k = 0; k < 6; k++) para();
  blocks.push(`<!-- wp:heading -->\n<h2 class="wp-block-heading">${sentence(next).slice(0, 40).replace(/[.…]$/, '')}</h2>\n<!-- /wp:heading -->`);
  for (let k = 0; k < 5; k++) para();
  const items = Array.from({ length: 4 + (next() % 3) }, () => `<li>${sentence(next)}</li>`).join('');
  blocks.push(`<!-- wp:list -->\n<ul class="wp-block-list">${items}</ul>\n<!-- /wp:list -->`);
  const pic = p.picture;
  blocks.push(
    `<!-- wp:image {"id":${attachmentId(pic)},"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${WP_SITE}/wp-content/uploads/${picturePath(pic).replace(/\.jpg$/, '-1024x768.jpg')}" alt="The harbour, picture ${pic}" class="wp-image-${attachmentId(pic)}"/><figcaption class="wp-element-caption">${sentence(next)}</figcaption></figure>\n<!-- /wp:image -->`
  );
  for (let k = 0; k < 5; k++) para();
  blocks.push(`<!-- wp:quote -->\n<blockquote class="wp-block-quote"><!-- wp:paragraph -->\n<p>${sentence(next)} ${sentence(next)}</p>\n<!-- /wp:paragraph --></blockquote>\n<!-- /wp:quote -->`);
  blocks.push(`<!-- wp:heading -->\n<h2 class="wp-block-heading">${sentence(next).slice(0, 32).replace(/[.…]$/, '')}</h2>\n<!-- /wp:heading -->`);
  for (let k = 0; k < 4; k++) para();
  return blocks.join('\n\n');
}

const cdata = (s: string) => `<![CDATA[${s}]]>`;
const rfc822 = (date: string) => {
  const d = new Date(`${date}T09:30:00Z`);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]}, ${pad(d.getUTCDate(), 2)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()} 09:30:00 +0000`;
};

/** The whole export, as WordPress 6 writes Tools → Export → All content. */
export function wpExport(): string {
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8" ?>
<!-- This is a WordPress eXtended RSS file generated by WordPress as an export of your site. -->
<rss version="2.0"
	xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:wfw="http://wellformedweb.org/CommentAPI/"
	xmlns:dc="http://purl.org/dc/elements/1.1/"
	xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
	<title>Harbour Notes</title>
	<link>${WP_SITE}</link>
	<description>Notes from a small harbour town</description>
	<pubDate>Mon, 02 Mar 2026 09:00:00 +0000</pubDate>
	<language>en-GB</language>
	<wp:wxr_version>1.2</wp:wxr_version>
	<wp:base_site_url>${WP_SITE}</wp:base_site_url>
	<wp:base_blog_url>${WP_SITE}</wp:base_blog_url>
`);
  for (const [n, [login, name]] of AUTHORS.entries())
    out.push(`	<wp:author><wp:author_id>${n + 1}</wp:author_id><wp:author_login>${cdata(login)}</wp:author_login><wp:author_email>${cdata(`${login}@harbour-notes.example`)}</wp:author_email><wp:author_display_name>${cdata(name)}</wp:author_display_name><wp:author_first_name>${cdata(name.split(' ')[0])}</wp:author_first_name><wp:author_last_name>${cdata(name.split(' ')[1])}</wp:author_last_name></wp:author>\n`);
  for (const [n, c] of CATEGORIES.entries()) out.push(`	<wp:category><wp:term_id>${n + 2}</wp:term_id><wp:category_nicename>${cdata(slugOf(c))}</wp:category_nicename><wp:category_parent>${cdata('')}</wp:category_parent><wp:cat_name>${cdata(c)}</wp:cat_name></wp:category>\n`);
  for (const [n, t] of TAGS.entries()) out.push(`	<wp:tag><wp:term_id>${n + 40}</wp:term_id><wp:tag_slug>${cdata(slugOf(t))}</wp:tag_slug><wp:tag_name>${cdata(t)}</wp:tag_name></wp:tag>\n`);
  out.push(`	<generator>https://wordpress.org/?v=6.7.1</generator>\n`);
  for (let n = 1; n <= WP_PICTURES; n++) {
    const file = picturePath(n);
    out.push(`
	<item>
		<title>${cdata(`harbour-${pad(n, 2)}`)}</title>
		<link>${WP_SITE}/harbour-${pad(n, 2)}/</link>
		<pubDate>Wed, 01 Jan 2020 09:00:00 +0000</pubDate>
		<dc:creator>${cdata('morgan')}</dc:creator>
		<guid isPermaLink="false">${WP_SITE}/wp-content/uploads/${file}</guid>
		<description></description>
		<content:encoded>${cdata('')}</content:encoded>
		<excerpt:encoded>${cdata('')}</excerpt:encoded>
		<wp:post_id>${attachmentId(n)}</wp:post_id>
		<wp:post_date>${cdata('2020-01-01 09:00:00')}</wp:post_date>
		<wp:post_date_gmt>${cdata('2020-01-01 09:00:00')}</wp:post_date_gmt>
		<wp:post_name>${cdata(`harbour-${pad(n, 2)}`)}</wp:post_name>
		<wp:status>${cdata('inherit')}</wp:status>
		<wp:post_parent>0</wp:post_parent>
		<wp:post_type>${cdata('attachment')}</wp:post_type>
		<wp:attachment_url>${cdata(`${WP_SITE}/wp-content/uploads/${file}`)}</wp:attachment_url>
		<wp:postmeta><wp:meta_key>${cdata('_wp_attached_file')}</wp:meta_key><wp:meta_value>${cdata(file)}</wp:meta_value></wp:postmeta>
	</item>`);
  }
  for (let n = 1; n <= WP_PAGES; n++)
    out.push(`
	<item>
		<title>${cdata(['About us', 'Contact', 'Visiting', 'Tide times', 'Archive'][n - 1])}</title>
		<link>${WP_SITE}/page-${n}/</link>
		<dc:creator>${cdata('morgan')}</dc:creator>
		<content:encoded>${cdata(`<!-- wp:paragraph -->\n<p>A page of the old site.</p>\n<!-- /wp:paragraph -->`)}</content:encoded>
		<wp:post_id>${n + 1}</wp:post_id>
		<wp:post_date>${cdata('2015-01-01 09:00:00')}</wp:post_date>
		<wp:post_name>${cdata(`page-${n}`)}</wp:post_name>
		<wp:status>${cdata('publish')}</wp:status>
		<wp:post_type>${cdata('page')}</wp:post_type>
	</item>`);
  for (let n = 1; n <= WP_MENU_ITEMS; n++)
    out.push(`
	<item>
		<title>${cdata('')}</title>
		<link>${WP_SITE}/?p=${5000 + n}</link>
		<wp:post_id>${5000 + n}</wp:post_id>
		<wp:status>${cdata('publish')}</wp:status>
		<wp:post_type>${cdata('nav_menu_item')}</wp:post_type>
		<wp:postmeta><wp:meta_key>${cdata('_menu_item_type')}</wp:meta_key><wp:meta_value>${cdata('post_type')}</wp:meta_value></wp:postmeta>
	</item>`);
  for (let i = 1; i <= WP_POSTS; i++) {
    const p = wpPost(i);
    const next = stream(p.seed ^ 0x5bd1e995);
    const excerpt = i % 2 ? sentence(next) : '';
    const terms = [...p.categories.map((c) => `		<category domain="category" nicename="${slugOf(c)}">${cdata(c)}</category>`), ...p.tags.map((t) => `		<category domain="post_tag" nicename="${slugOf(t)}">${cdata(t)}</category>`)].join('\n');
    const comments = [1, 2]
      .map(
        (c) => `		<wp:comment>
			<wp:comment_id>${i * 10 + c}</wp:comment_id>
			<wp:comment_author>${cdata(['Ana', 'Ben', 'Chloé', 'Dev'][(i + c) % 4])}</wp:comment_author>
			<wp:comment_author_email>${cdata('reader@example.org')}</wp:comment_author_email>
			<wp:comment_author_url>https://example.org</wp:comment_author_url>
			<wp:comment_author_IP>${cdata('192.0.2.1')}</wp:comment_author_IP>
			<wp:comment_date>${cdata(`${p.date} 12:0${c}:00`)}</wp:comment_date>
			<wp:comment_date_gmt>${cdata(`${p.date} 12:0${c}:00`)}</wp:comment_date_gmt>
			<wp:comment_content>${cdata(`${sentence(next)} ${sentence(next)}`)}</wp:comment_content>
			<wp:comment_approved>${cdata('1')}</wp:comment_approved>
			<wp:comment_type>${cdata('comment')}</wp:comment_type>
			<wp:comment_parent>0</wp:comment_parent>
			<wp:comment_user_id>0</wp:comment_user_id>
		</wp:comment>`
      )
      .join('\n');
    out.push(`
	<item>
		<title>${cdata(p.title)}</title>
		<link>${WP_SITE}${p.path}</link>
		<pubDate>${rfc822(p.date)}</pubDate>
		<dc:creator>${cdata(p.author[0])}</dc:creator>
		<guid isPermaLink="false">${WP_SITE}/?p=${p.id}</guid>
		<description></description>
		<content:encoded>${cdata(wpContent(i))}</content:encoded>
		<excerpt:encoded>${cdata(excerpt)}</excerpt:encoded>
		<wp:post_id>${p.id}</wp:post_id>
		<wp:post_date>${cdata(`${p.date} 09:30:00`)}</wp:post_date>
		<wp:post_date_gmt>${cdata(`${p.date} 09:30:00`)}</wp:post_date_gmt>
		<wp:post_modified>${cdata(`${p.date} 10:00:00`)}</wp:post_modified>
		<wp:post_modified_gmt>${cdata(`${p.date} 10:00:00`)}</wp:post_modified_gmt>
		<wp:comment_status>${cdata('open')}</wp:comment_status>
		<wp:ping_status>${cdata('open')}</wp:ping_status>
		<wp:post_name>${cdata(p.slug)}</wp:post_name>
		<wp:status>${cdata(p.draft ? 'draft' : 'publish')}</wp:status>
		<wp:post_parent>0</wp:post_parent>
		<wp:menu_order>0</wp:menu_order>
		<wp:post_type>${cdata('post')}</wp:post_type>
		<wp:post_password>${cdata('')}</wp:post_password>
		<wp:is_sticky>0</wp:is_sticky>
${terms}
		<wp:postmeta><wp:meta_key>${cdata('_edit_last')}</wp:meta_key><wp:meta_value>${cdata('1')}</wp:meta_value></wp:postmeta>
${p.featured ? `		<wp:postmeta><wp:meta_key>${cdata('_thumbnail_id')}</wp:meta_key><wp:meta_value>${cdata(String(attachmentId(p.featured)))}</wp:meta_value></wp:postmeta>\n` : ''}${comments}
	</item>`);
  }
  out.push('\n</channel>\n</rss>\n');
  return out.join('');
}

/**
 * The folder holding the export (`export.xml`) and its uploads (`uploads/2020/…`), made the first time on this machine.
 * Every file is written whole before the folder takes its name, so a run that stops half way never leaves it short.
 */
export async function wordpressExport(): Promise<{ dir: string; file: string; bytes: number; hash: string }> {
  const sharp = (await import('sharp')).default;
  const key = createHash('sha256').update(`${RECIPE}:${WP_POSTS}:${WP_PICTURES}:${sharp.versions.vips}:${sharp.versions.sharp ?? ''}`).digest('hex').slice(0, 12);
  const dir = join(ROOT, '.tmp', 'perf', 'wordpress', key);
  const file = join(dir, 'export.xml');
  if (!existsSync(file)) {
    const part = `${dir}.part-${process.pid}`;
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    for (let n = 1; n <= WP_PICTURES; n++) {
      const width = 640;
      const height = 480;
      const px = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px.set([(x * 255) / width, (y * 255) / height, (n * 23) % 256], (y * width + x) * 3);
      const target = join(part, 'uploads', picturePath(n));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, await sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 80 }).toBuffer());
    }
    writeFileSync(join(part, 'export.xml'), wpExport());
    rmSync(dir, { recursive: true, force: true });
    renameSync(part, dir);
  }
  const bytes = readFileSync(file);
  const hash = createHash('sha256');
  hash.update(bytes);
  for (let n = 1; n <= WP_PICTURES; n++) hash.update('\0').update(readFileSync(join(dir, 'uploads', picturePath(n))));
  return { dir, file, bytes: bytes.length, hash: hash.digest('hex').slice(0, 16) };
}
