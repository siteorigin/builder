import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { askFrame, followed, followReport, newFrameNav, sendsFrame } from '../../src/renderer/src/lib/frame-nav';

const ROUTES: Record<string, string> = { home: '/', about: '/about/', contact: '/contact/', work: '/work/' };
const pageAt = (path: string) => Object.keys(ROUTES).find((id) => ROUTES[id] === path || ROUTES[id] === `${path}/`) ?? null;

/**
 * The editor and its frame as the canvas runs them: the author chooses a page (the store changes at once, the
 * request goes out after the render), the frame reports where it lands, and every page the editor switches to
 * is recorded.
 */
function editor(start = 'home', previewing = true) {
  const nav = newFrameNav();
  let pageId: string | null = start;
  let frameAt: string | null = ROUTES[start];
  askFrame(nav, start, null);
  const shown: string[] = [];
  const sent: Array<{ path: string; navId: number }> = [];
  return {
    nav,
    shown,
    sent,
    page: () => pageId,
    /** A page chosen in the editor: shown at once, asked of the frame by the effect that runs after the render. */
    choose(id: string) {
      pageId = id;
      shown.push(id);
    },
    effect() {
      if (!pageId) return;
      const path = ROUTES[pageId];
      const there = frameAt !== null && pageAt(frameAt) === pageId;
      const id = askFrame(nav, pageId, there ? null : path);
      if (id !== null) {
        frameAt = null;
        sent.push({ path, navId: id });
      }
    },
    report(path: string, navId: number | null = null) {
      if (!followReport(nav, path, navId, pageId, previewing)) return false;
      frameAt = path;
      const at = pageAt(path);
      if (at && at !== pageId) {
        pageId = at;
        shown.push(at);
      }
      followed(nav, pageId);
      return true;
    }
  };
}

describe('following the preview frame between pages', () => {
  it('never switches back to a page the author left while the new one is on its way', () => {
    const e = editor('about');
    e.choose('contact');
    e.effect();
    // About's late report, before and after Contact lands.
    expect(e.report('/about/')).toBe(false);
    expect(e.report('/contact/', e.sent[0].navId)).toBe(true);
    expect(e.report('/about/', e.sent[0].navId - 1)).toBe(false);
    expect(e.shown).toEqual(['contact']);
    expect(e.page()).toBe('contact');
  });

  it('ignores a report that arrives before the request for the chosen page is even sent', () => {
    const e = editor('about');
    e.choose('contact');
    // The frame's report is handled before the effect that asks for Contact has run.
    expect(e.report('/about/')).toBe(false);
    expect(e.page()).toBe('contact');
    e.effect();
    expect(e.report('/contact/', e.sent[0].navId)).toBe(true);
    expect(e.shown).toEqual(['contact']);
  });

  it('settles on the last of several quick choices, also back to the page it started from', () => {
    const e = editor('home');
    for (const id of ['about', 'contact', 'about']) {
      e.choose(id);
      e.effect();
    }
    const [first, second, third] = e.sent.map((s) => s.navId);
    // Each earlier request's own report comes in late: neither the same address nor an older id counts.
    expect(e.report('/about/', first)).toBe(false);
    expect(e.report('/contact/', second)).toBe(false);
    expect(e.report('/about/', third)).toBe(true);
    expect(e.shown).toEqual(['about', 'contact', 'about']);
    expect(e.page()).toBe('about');
  });

  it('follows a visitor’s own links and Back once nothing the editor asked for is on its way', () => {
    const e = editor('home');
    expect(e.report('/work/')).toBe(true);
    expect(e.report('/contact/')).toBe(true);
    // A section jump on the same page, and Back.
    expect(e.report('/contact/')).toBe(true);
    expect(e.report('/work/')).toBe(true);
    expect(e.shown).toEqual(['work', 'contact', 'work']);
    // An address that is not one of the site's pages leaves the page shown, and later links are still followed.
    expect(e.report('/missing/')).toBe(true);
    expect(e.report('/about/')).toBe(true);
    expect(e.page()).toBe('about');
  });

  it('while editing, follows the frame only to where the editor sent it', () => {
    const e = editor('home', false);
    e.choose('about');
    e.effect();
    expect(e.report('/about', e.sent[0].navId)).toBe(true);
    expect(e.report('/contact/')).toBe(false);
    expect(e.report('/about/')).toBe(true);
    expect(e.page()).toBe('about');
  });
});

describe('sending the frame to a page the editor opens', () => {
  it('waits for this computer’s own preview to serve it, and sends a live session guest’s frame unchecked (#1529)', () => {
    // This computer's preview serves the page: the frame goes there.
    expect(sendsFrame(true, false)).toBe(true);
    // Not yet, or no preview up just now (it is restarting): the canvas's recovery opens the page once it is served.
    expect(sendsFrame(false, false)).toBe(false);
    expect(sendsFrame(null, false)).toBe(false);
    // A guest has no preview of its own to ask (the host's is the host's): the frame goes there, as it would on a yes.
    expect(sendsFrame(null, true)).toBe(true);
    expect(sendsFrame(true, true)).toBe(true);
    // A check that failed is no reason to go there, for a guest either.
    expect(sendsFrame(false, true)).toBe(false);
  });

  // No test mounts Canvas, so this holds Canvas to the rule where it opens the page shown.
  it('is the rule Canvas sends the frame on when it opens the page shown, unless a newer request overtook the answer', () => {
    const canvas = readFileSync('src/renderer/src/panels/Canvas.tsx', 'utf8');
    const from = canvas.indexOf('function openShownPage()');
    const open = canvas.slice(from, canvas.indexOf('\n  }\n', from));
    expect(open).toContain('const remote = isRemoteShell(s);');
    expect(open).toContain("if (sendsFrame(canServe, remote)) post('navigate', { path: shown.route, navId, fullReload: true });");
    // A late answer for a page asked for before, or for another frame, sends nothing and starts no recovery.
    expect(open).toMatch(/if \(nav\.current !== asked \|\| asked\.request\?\.id !== navId\) return;\n\s*if \(sendsFrame/);
    // Nothing else in it sends the frame anywhere.
    expect(open.match(/post\('navigate'/g)).toHaveLength(1);
  });
});
