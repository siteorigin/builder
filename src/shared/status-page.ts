/**
 * The small pages SiteOrigin Builder itself answers a browser with when there is nothing else to show: the live
 * session relay turning a guest away (relay/src/pages.ts) and the exported website's local preview when its folder has
 * gone or a page is missing (src/main/static-preview.ts). Each is one self-contained document with a single inline
 * stylesheet and no script, font or file of its own, so it can be answered from anywhere, including a string constant
 * in the main process.
 *
 * They wear the guest viewer's status screen (relay/viewer/viewer.css: `.screen`, `.brand`, `.card`, `.glyph`,
 * `.next`, and `.notice` over the frame): the tokens below are copies of the ones it uses, under the same names and
 * with the same values, which are themselves copies of src/renderer/src/styles/tokens.css. Change a value there and
 * here together. Pure string building with no imports, so both the Worker and the main process can bundle it.
 */

/** The viewer's status glyphs (relay/viewer/viewer.css), as the inside of a 24px Lucide-style stroke icon. */
const ICONS = {
  unlink: "<path d='M9 17H7A5 5 0 0 1 7 7M15 7h2a5 5 0 0 1 4 8M8 12h4M2 2l20 20'/>",
  lock: "<rect x='3' y='11' width='18' height='11' rx='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/>",
  clock: "<circle cx='12' cy='12' r='10'/><path d='M12 6v6l4 2'/>",
  done: "<circle cx='12' cy='12' r='10'/><path d='m9 12 2 2 4-4'/>",
  host: "<rect x='2' y='3' width='20' height='14' rx='2'/><path d='M8 21h8M12 17v4M2 2l20 20'/>",
  alert: "<circle cx='12' cy='12' r='10'/><path d='M12 8v4M12 16h.01'/>"
} as const;

export type StatusIcon = keyof typeof ICONS;
export type StatusTone = 'amber' | 'red';
/** A run of text, with any `{ code }` part set as a literal (a path, an address). */
export type StatusText = string | ReadonlyArray<string | { code: string }>;

export interface StatusPage {
  /** The outcome, for the tab: "Page not found". The product's name is added after it. */
  title: string;
  heading: string;
  /** What happened, in a sentence or two. */
  text: StatusText;
  /** What the reader can do now. */
  next?: StatusText;
  /** A link that is the way on, drawn as the viewer's button. */
  action?: { label: string; href: string };
  icon: StatusIcon;
  tone?: StatusTone;
  /**
   * The line above the card that says whose page this is. `mark` is the address of the app's mark where one is served
   * (the relay's own `/_viewer/mark.svg`); without it the line is the name alone. `label` names the part of the app
   * speaking ("Export preview"). Left out in a frame, where the page around it already names the product.
   */
  brand?: { mark?: string; label?: string };
  /** Drawn as the viewer's notice over its frame, rather than as a page of its own. */
  framed?: boolean;
  /** Markup added to the head as it is: the caller's own, trusted (the relay's reload bridge). */
  head?: string;
}

/** HTML text with its markup characters escaped, for an attribute value or an element's content. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const textHtml = (text: StatusText): string => (typeof text === 'string' ? escapeHtml(text) : text.map((part) => (typeof part === 'string' ? escapeHtml(part) : `<code>${escapeHtml(part.code)}</code>`)).join(''));

const iconUrl = (icon: StatusIcon) =>
  `url("data:image/svg+xml,${`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='#000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${ICONS[icon]}</svg>`.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23')}")`;

/** One page, as a whole document. */
export function statusPage(page: StatusPage): string {
  const brand = page.brand && !page.framed ? `<p class="brand">${page.brand.mark ? `<img src="${escapeHtml(page.brand.mark)}" alt="" width="32" height="32">` : ''}SiteOrigin Builder${page.brand.label ? `<span>${escapeHtml(page.brand.label)}</span>` : ''}</p>` : '';
  const heading = page.framed ? 'h2' : 'h1';
  const card = [
    `<span class="glyph"${page.tone ? ` data-tone="${page.tone}"` : ''} aria-hidden="true"></span>`,
    `<${heading}>${escapeHtml(page.heading)}</${heading}>`,
    `<p>${textHtml(page.text)}</p>`,
    page.next ? `<p class="next">${textHtml(page.next)}</p>` : '',
    page.action ? `<p class="actions"><a class="btn" href="${escapeHtml(page.action.href)}">${escapeHtml(page.action.label)}</a></p>` : ''
  ].join('');
  const body = page.framed ? `<main class="veil"><div class="notice">${card}</div></main>` : `<main class="screen"><div class="screen-inner">${brand}<div class="card">${card}</div></div></main>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.title)} · SiteOrigin Builder</title>
${page.head ?? ''}<style>${STYLE}.glyph::before{-webkit-mask-image:${iconUrl(page.icon)};mask-image:${iconUrl(page.icon)}}</style>
</head>
<body>${body}</body>
</html>
`;
}

/** The viewer's status screen, cut down to what these pages draw. */
const STYLE = `
:root{color-scheme:light dark;--font:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI Variable','Segoe UI',system-ui,sans-serif;--mono:'SF Mono',ui-monospace,'Cascadia Code',Menlo,Consolas,monospace;--bg:#f2f4f7;--canvas:#e4e8ed;--panel-2:#eff2f6;--raised:#ffffff;--active:rgb(28 39 66 / 0.08);--border:rgb(28 39 66 / 0.1);--border-control:#7a859a;--text:#1c2742;--text-2:#4a5670;--focus:#1766c0;--amber:#925600;--amber-soft:rgb(196 122 12 / 0.12);--red-soft:rgb(194 53 46 / 0.09);--red-ink:#b02e28;--shadow-sm:0 1px 2px rgb(28 39 66 / 0.07);--shadow-md:0 8px 24px -8px rgb(28 39 66 / 0.18),0 2px 6px rgb(28 39 66 / 0.06);--card-ring:0 0 0 1px var(--border),0 1px 2px rgb(28 39 66 / 0.06);--r-sm:6px;--r-md:10px;--control-h:30px}
@media (prefers-color-scheme:dark){:root{--bg:#11151c;--canvas:#0e1217;--panel-2:#1d232e;--raised:#242b37;--active:rgb(231 236 244 / 0.1);--border:rgb(231 236 244 / 0.09);--border-strong:rgb(231 236 244 / 0.16);--border-control:#717d96;--text:#e7ecf4;--text-2:#a8b2c3;--focus:#7cbeff;--amber:#f0b45e;--amber-soft:rgb(240 180 94 / 0.13);--red-soft:rgb(255 138 130 / 0.13);--red-ink:#ff8a82;--shadow-sm:0 1px 2px rgb(0 0 0 / 0.3);--shadow-md:0 10px 30px -8px rgb(0 0 0 / 0.6),0 2px 6px rgb(0 0 0 / 0.3);--card-ring:0 0 0 1px var(--border-strong)}}
*,*::before,*::after{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:13px/1.45 var(--font);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
h1,h2,p{margin:0}
p{text-wrap:pretty}
code{font:0.92em var(--mono);overflow-wrap:anywhere}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.screen{min-height:100%;display:grid;place-items:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom))}
.screen-inner{width:100%;min-width:0;max-width:25rem;margin-bottom:6vh}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 14px 2px;color:var(--text-2);font-size:13px;font-weight:600}
.brand img{display:block;flex:none}
.brand span::before{content:'·';margin-right:8px}
.card{background:var(--raised);border-radius:var(--r-md);padding:28px;box-shadow:var(--card-ring),var(--shadow-md)}
.card :is(h1,p){overflow-wrap:anywhere}
.card h1{font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-0.01em}
.card h1+p{margin-top:6px;color:var(--text-2);font-size:14px;line-height:1.5}
.glyph{display:grid;place-items:center;width:40px;height:40px;margin-bottom:16px;border-radius:var(--r-md);background:var(--active);color:var(--text-2)}
.glyph::before{content:'';width:22px;height:22px;background:currentColor;-webkit-mask:center/contain no-repeat;mask:center/contain no-repeat}
.glyph[data-tone='amber']{background:var(--amber-soft);color:var(--amber)}
.glyph[data-tone='red']{background:var(--red-soft);color:var(--red-ink)}
.next{margin-top:14px;padding-top:14px;border-top:1px solid var(--border);color:var(--text-2);font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.btn{display:inline-flex;align-items:center;justify-content:center;height:var(--control-h);padding:0 12px;border-radius:var(--r-sm);border:1px solid var(--border-control);background:var(--raised);color:var(--text);font-weight:500;text-decoration:none;white-space:nowrap;box-shadow:var(--shadow-sm)}
.actions .btn{height:34px;padding:0 14px}
@media (hover:hover){.btn:hover{background:var(--panel-2)}}
.btn:active{background:var(--active);box-shadow:none}
.veil{min-height:100%;display:grid;place-items:center;padding:16px;background:var(--canvas)}
.notice{display:flex;flex-direction:column;align-items:flex-start;width:100%;max-width:22rem;padding:24px;border-radius:var(--r-md);background:var(--raised);box-shadow:var(--card-ring),var(--shadow-md)}
.notice .glyph{margin-bottom:12px}
.notice h2{font-size:15px;font-weight:600}
.notice p{margin-top:4px;color:var(--text-2)}
.notice .next{align-self:stretch;margin-top:12px;padding-top:12px}
.notice .actions{align-self:stretch;margin-top:16px}
@media (pointer:coarse){.actions .btn{height:44px}}
@media (max-width:640px){body{font-size:15px}.card{padding:24px 20px}.card h1{font-size:21px}.card h1+p{font-size:15px}.next{font-size:14px}.actions .btn{height:44px;font-size:15px;flex:1 1 auto}}
`.trim();
