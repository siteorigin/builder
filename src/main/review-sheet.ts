/**
 * A review edition's offline sheet (#1134): one HTML file a client can open from Downloads by double-clicking it, with
 * no Builder, no server and no network. A static build needs HTTP to route between its pages, and a live preview stops
 * when the author's laptop closes; the sheet needs neither. It holds every picture of the edition in the file itself,
 * each page's title and address, the name and width of each picture, and the edition's ID and digest, so a client's
 * reply can name exactly what they saw. It is a set of pictures: the note at its top says that links, menus and forms
 * only work in a live preview.
 *
 * The file runs no script and loads nothing: its content policy allows only its own styles and the pictures it embeds.
 */
import { escapeHtml } from '@shared/status-page';
import type { ReviewCapture, ReviewCaptureReason, ReviewEditionManifest } from '@shared/review-edition';

export interface ReviewSheetInput {
  manifest: ReviewEditionManifest;
  /** Each captured picture's PNG bytes, by its file in the edition (ReviewCapture.file), as read and checked (readReviewEdition). */
  images: ReadonlyMap<string, Buffer>;
}

/** What the sheet says about pictures and live pages, at its top. */
export const REVIEW_SHEET_NOTE = 'These are pictures of each page. Links, menus, forms and anything else that moves or responds only work in a live preview of the website.';

const REASON_WORDS: Record<ReviewCaptureReason, string> = {
  navigation: 'The page did not open.',
  fonts: 'A font did not load.',
  assets: 'An image, stylesheet or other file did not load.',
  'too-tall': 'The page is too tall to picture.',
  timeout: 'The page took too long to load.',
  failed: 'The page could not be pictured.'
};


/** When the edition was made, said the same way wherever the sheet is opened (UTC). */
function madeAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date}, ${time} UTC`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--ink:#1d1d1b;--soft:#5d5d58;--line:#dedcd6;--note:#fff6dc;--note-line:#e8cf7a;--miss:#f1efea}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201e;--ink:#ecebe6;--soft:#a9a8a1;--line:#3a3935;--note:#3a3220;--note-line:#7d6a33;--miss:#2a2a27}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1520px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:28px;line-height:1.2;margin:0 0 4px}
h2{font-size:21px;margin:0}
.meta{color:var(--soft);margin:0 0 16px}
.meta code,.ident code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.note{background:var(--note);border:1px solid var(--note-line);border-radius:8px;padding:12px 16px;margin:0 0 24px}
.note strong{display:block}
nav ol{margin:0 0 32px;padding-left:24px}
nav a{color:inherit}
.page{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:0 0 32px}
.page-head{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;margin:0 0 16px}
.route{color:var(--soft);font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.shots{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
figure{margin:0;flex:0 1 auto;max-width:100%}
figcaption{font-weight:600;margin:0 0 8px}
figcaption span{color:var(--soft);font-weight:400}
figure img{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:4px;background:#fff}
.missing{background:var(--miss);border:1px dashed var(--line);border-radius:4px;padding:24px 16px;color:var(--soft);max-width:100%}
.ident{color:var(--soft);border-top:1px solid var(--line);padding-top:16px;font-size:13px}
`;

/** One page at one width: its picture, scaled to fit, or what kept it from being taken. */
function figure(c: ReviewCapture, label: string, title: string, images: ReadonlyMap<string, Buffer>): string {
  const caption = `<figcaption>${escapeHtml(label)} <span>· ${c.width} px</span></figcaption>`;
  if (c.status === 'captured') {
    const png = images.get(c.file);
    if (!png) throw new Error(`The picture ${c.file} is missing from the edition.`);
    // Shown no wider than it was taken, so a phone picture reads as a phone.
    return `<figure style="width:${c.width}px">${caption}<img src="data:image/png;base64,${png.toString('base64')}" width="${c.width}" height="${c.height}" alt="${escapeHtml(`${title}, ${label}, ${c.width} pixels wide`)}"></figure>`;
  }
  return `<figure style="width:${Math.min(c.width, 480)}px">${caption}<div class="missing">Not pictured. ${escapeHtml(REASON_WORDS[c.reason] ?? REASON_WORDS.failed)}</div></figure>`;
}

/** The sheet's HTML, titled with the site's name when the edition was made. Every captured picture must be in `images`. */
export function reviewSheetHtml({ manifest: m, images }: ReviewSheetInput): string {
  const name = m.siteName.trim() || 'Website';
  const shots = m.captures.filter((c) => c.status === 'captured').length;
  // The captures run page by page, each page at every width in order (the manifest is checked to say so).
  const n = m.widths.length;
  const pages = m.routes.map((p, i) => {
    const title = p.title || p.route;
    const figures = m.widths.map((w, j) => figure(m.captures[i * n + j], w.label, title, images)).join('');
    return `<section class="page" id="page-${i + 1}"><div class="page-head"><h2>${escapeHtml(title)}</h2><span class="route">${escapeHtml(p.route)}</span></div><div class="shots">${figures}</div></section>`;
  });
  const toc = m.routes.length > 1 ? `<nav aria-label="Pages"><ol>${m.routes.map((p, i) => `<li><a href="#page-${i + 1}">${escapeHtml(p.title || p.route)}</a></li>`).join('')}</ol></nav>` : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="siteorigin-review-edition" content="${escapeHtml(m.editionId)}">`,
    `<title>${escapeHtml(`${name} – review ${m.editionId}`)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(name)}</h1>`,
    `<p class="meta">Review edition <code>${escapeHtml(m.editionId)}</code> · made ${escapeHtml(madeAt(m.createdAt))} · ${m.routes.length} ${m.routes.length === 1 ? 'page' : 'pages'}, ${shots} ${shots === 1 ? 'picture' : 'pictures'}</p>`,
    `<div class="note" role="note"><strong>Pictures, not the live website</strong>${escapeHtml(REVIEW_SHEET_NOTE)}</div>`,
    toc,
    ...pages,
    `<p class="ident">Edition <code>${escapeHtml(m.editionId)}</code> · revision ${m.revision} · content digest <code>${escapeHtml(m.contentDigest)}</code>. Quote the edition ID when you reply, so your notes are matched to exactly these pictures.</p>`,
    '</main>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
}
