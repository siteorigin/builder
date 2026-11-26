/**
 * The chat log's words clear its scrollbar (issue #889), in a real browser with the real Chat.css: a scrolled log of
 * full-width lines and cards, with an always-shown scrollbar, which takes a gutter, and with none, as an overlay
 * scrollbar reserves (macOS draws its thumb over the content, up to 14px wide under the pointer).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Read, not imported: Vitest hands a stylesheet's ?raw import over empty.
const css = readFileSync(resolve('src/renderer/src/panels/Chat.css'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());
/** How wide macOS's overlay thumb gets under the pointer. */
const OVERLAY = 14;

const line = 'A full line of words that wraps right across the panel to its edge. '.repeat(4);
const page = (overlay: boolean) => `<!doctype html><style>${css}
  body { margin: 0; font: 13px/1.5 sans-serif; }
  .chat { width: 320px; height: 240px; }
  ${
    overlay
      ? '.chat-log { scrollbar-width: none; }'
      : // A classic scrollbar that takes its gutter whatever the system shows (macOS draws overlays even headless).
        '.chat-log { scrollbar-width: auto; } .chat-log::-webkit-scrollbar { width: 11px; } .chat-log::-webkit-scrollbar-thumb { background: #888; }'
  }
</style>
<div class="chat"><div class="chat-body"><div class="chat-log">
  ${`<div class="msg-user">${line}</div><div class="msg-ai"><div class="text">${line}</div><div class="reply"><div class="reply-details">${line}</div></div></div>`.repeat(6)}
</div></div></div>`;

describe.skipIf(!browserInstalled)('chat log and its scrollbar, in a browser', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Headless Chromium hides scrollbars by default; the always-shown case needs one with its gutter.
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ['--hide-scrollbars'] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const overlay of [false, true])
    it(`keeps every line and card ${OVERLAY}px clear of the ${overlay ? 'overlay' : 'always-shown'} scrollbar`, async () => {
      const tab = await browser.newPage();
      try {
        await tab.setContent(page(overlay));
        const room = await tab.evaluate<{ scrolls: boolean; gutter: number; clear: number }>(`(() => {
          const log = document.querySelector('.chat-log');
          log.scrollTop = log.scrollHeight;
          // Where the scrollbar starts: the gutter's edge, or the box's own edge when nothing is reserved.
          const edge = log.getBoundingClientRect().left + log.clientLeft + log.clientWidth;
          const rights = [...log.querySelectorAll('.msg-user, .text, .reply-details')].map((el) => el.getBoundingClientRect().right);
          return { scrolls: log.scrollHeight > log.clientHeight, gutter: log.offsetWidth - log.clientWidth, clear: edge - Math.max(...rights) };
        })()`);
        expect(room.scrolls).toBe(true);
        if (overlay) expect(room.gutter).toBe(0);
        else expect(room.gutter).toBeGreaterThan(0);
        expect(room.clear).toBeGreaterThanOrEqual(OVERLAY);
      } finally {
        await tab.close();
      }
    });
});
