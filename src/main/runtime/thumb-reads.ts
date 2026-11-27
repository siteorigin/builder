/**
 * Which of the site's custom properties a component's thumbnail can show (see main/runtime/component-thumbs): read
 * from its isolated preview page in the hidden window, just before and just after it is photographed. Nothing here
 * depends on Electron, so the same script runs in the browser tests.
 *
 * A page's pixels depend on a custom property only through the stylesheets and attributes that name it: a declaration
 * of a rule that applies to something on the page, a condition (a style query), an animation, an attribute, or the
 * value of another custom property that is itself read. The script follows those from what the page shows now, and
 * gives every property any of them reaches. It errs towards naming too many: every rule nested in another or in a
 * scope, every rule whose selector it cannot test, and every highlight rule while anything could be highlighted counts
 * as applying, and a pseudo-element counts wherever its element is; a rule whose declarations the browser cannot
 * write back as they were (a shorthand naming a property, then one of its parts) counts every name in its stylesheet.
 * What it cannot read (a stylesheet of another origin, a shadow root, a frame, a canvas, an SVG `<use>`, a name with
 * an escape) makes the answer unknown.
 */

/** Every animation and transition at its end at once, so nothing is photographed half way (main/thumb-capture). */
export const STILL_CSS = 'html { scroll-behavior: auto !important; } *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition: none !important; }';

/** The isolated world the script runs in: the page's own scripts can neither see nor change its functions. */
export const THUMB_READS_WORLD = 1972;

/** Longest list of names a page's answer may carry, and longest name. */
const MAX_READS = 5000;
const MAX_NAME = 200;

/** A custom property's name as the script reads one (and as a hint on disk must name one): no escapes, no spaces. */
const NAME = /^--(?:[A-Za-z0-9_-]|[^\x00-\x7f])+$/;

/**
 * Runs in the preview's page (in THUMB_READS_WORLD). Answers `{ reads: string[] }`, the custom properties its pixels
 * can depend on, sorted, or `{ reads: null, why }` when that cannot be told. Read `before` a photograph, it starts
 * watching the page; read `after` it, it answers null if anything on the page changed in between (an element, an
 * attribute, a text), since the photograph may then show what neither read saw.
 */
export const thumbReads = (phase: 'before' | 'after'): string => `(() => {
  const PHASE = ${JSON.stringify(phase)};
  const WATCH = '__soThumbReadsWatch';
  let moved = false;
  if (PHASE === 'before') {
    if (window[WATCH]) window[WATCH].observer.disconnect();
    const watch = { changed: false, observer: new MutationObserver(() => (watch.changed = true)) };
    watch.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    window[WATCH] = watch;
  } else {
    const watch = window[WATCH];
    moved = !watch || watch.changed || watch.observer.takeRecords().length > 0;
    if (watch) watch.observer.disconnect();
    window[WATCH] = null;
  }
  const NAME = /--(?:[A-Za-z0-9_-]|[^\\x00-\\x7f])+/g;
  const uses = new Set();
  const edges = new Map();
  let unknown = '';
  const names = (text) => {
    if (!text || text.indexOf('--') < 0) return [];
    if (/--(?:[A-Za-z0-9_-]|[^\\x00-\\x7f])*\\\\/.test(text)) unknown = 'a custom property named with an escape';
    return text.match(NAME) || [];
  };
  const use = (text) => {
    for (const n of names(text)) uses.add(n);
  };
  const edge = (name, value) => {
    let to = edges.get(name);
    if (!to) edges.set(name, (to = new Set()));
    for (const n of names(value)) to.add(n);
  };
  // A highlight (the selection, a target's text, a registered highlight) paints only while there is one, and a
  // focused element may hold a selection of its own.
  const focused = document.activeElement;
  const selection = getSelection();
  const highlighted = (!!selection && selection.rangeCount > 0 && !selection.isCollapsed) || (!!focused && focused !== document.body && focused !== document.documentElement) || (typeof CSS !== 'undefined' && !!CSS.highlights && CSS.highlights.size > 0) || location.hash.indexOf(':~:') >= 0;
  const HIGHLIGHT = /::(?:selection|target-text|spelling-error|grammar-error|search-text|highlight\\()/i;
  const ELEMENTS = /::[A-Za-z-]|:(?:before|after|first-line|first-letter)(?![A-Za-z0-9_-])/i;
  // Matched in ways a query cannot tell (history, a shadow tree, a scope, nesting): taken to apply.
  const UNTESTED = /:visited|:host|::slotted|::part|:scope|&/i;
  const PSEUDO_ELEMENT = /::[A-Za-z-]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?|:(?:before|after|first-line|first-letter)(?![A-Za-z0-9_-])/gi;
  const parts = (list) => {
    const out = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      if (ch === '\\\\') {
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(list.slice(start, i));
        start = i + 1;
      }
    }
    out.push(list.slice(start));
    return out.map((p) => p.trim()).filter(Boolean);
  };
  const applies = (selector) =>
    parts(selector).some((part) => {
      // A pseudo-element's name in quotes is an attribute's value, not a pseudo-element: told apart by nothing here.
      if (UNTESTED.test(part) || (/["']/.test(part) && ELEMENTS.test(part))) return true;
      if (HIGHLIGHT.test(part) && !highlighted) return false;
      try {
        return !!document.querySelector(part.replace(PSEUDO_ELEMENT, ':is(*)'));
      } catch {
        return true;
      }
    });
  const scratch = document.createElement('div').style;
  const scope = typeof CSSScopeRule === 'undefined' ? null : CSSScopeRule;
  const visit = (rules, all) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const style = rule.style;
        let custom = false;
        let plain = false;
        for (let i = 0; i < style.length; i++) {
          const p = style[i];
          if (p.startsWith('--')) {
            custom = true;
            edge(p, style.getPropertyValue(p));
          } else plain = true;
        }
        const nested = !!rule.cssRules && rule.cssRules.length > 0;
        if (plain) {
          // The rule's own declarations as written (a shorthand that names a property stays whole), less its custom ones.
          // A shorthand that names a property, with one of its parts declared again after it, is written out part by
          // part, each with no value: what it named is then only in the stylesheet's own text.
          let text = style.cssText;
          const lost = /:\\s*(;|$)/.test(text);
          if (custom && !lost) {
            scratch.cssText = text;
            for (let i = scratch.length - 1; i >= 0; i--) if (scratch[i].startsWith('--')) scratch.removeProperty(scratch[i]);
            text = scratch.cssText;
          }
          if ((lost || text.indexOf('--') >= 0) && (all || nested || applies(rule.selectorText))) {
            if (!lost) use(text);
            else {
              const node = rule.parentStyleSheet && rule.parentStyleSheet.ownerNode;
              if (node && typeof node.textContent === 'string' && node.localName === 'style') use(node.textContent);
              else unknown = 'a declaration it cannot read';
            }
          }
        }
        if (nested) visit(rule.cssRules, true);
      } else if (rule instanceof CSSImportRule) {
        use(rule.cssText);
        let inner = null;
        try {
          inner = rule.styleSheet ? rule.styleSheet.cssRules : null;
        } catch {
          unknown = 'a stylesheet it cannot read';
        }
        if (inner) visit(inner, all);
      } else if (rule.cssRules && !(rule instanceof CSSKeyframesRule)) {
        // A rule that holds rules (@media, @supports, @container, @layer, @scope, @starting-style…): what its
        // condition names, then every rule in it, whether the condition holds now or not.
        const text = rule.cssText;
        use(text.slice(0, Math.max(0, text.indexOf('{'))));
        visit(rule.cssRules, all || (!!scope && rule instanceof scope));
      } else use(rule.cssText);
    }
  };
  for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch {
      unknown = 'a stylesheet it cannot read';
    }
    if (rules) visit(rules, false);
  }
  for (const el of document.querySelectorAll('*')) {
    if (el.shadowRoot) unknown = 'a shadow root';
    const tag = el.localName;
    if (tag === 'canvas' || tag === 'iframe' || tag === 'frame' || tag === 'object' || tag === 'embed' || tag === 'use' || tag === 'portal') unknown = '<' + tag + '>';
    for (const a of el.attributes) use(a.value);
  }
  if (moved) return { reads: null, why: 'the page changed while it was photographed' };
  if (unknown) return { reads: null, why: unknown };
  const reads = new Set();
  const queue = [...uses];
  while (queue.length) {
    const n = queue.pop();
    if (reads.has(n)) continue;
    reads.add(n);
    const to = edges.get(n);
    if (to) for (const m of to) if (!reads.has(m)) queue.push(m);
  }
  return { reads: [...reads].sort() };
})()`;

/** A page's answer, when it is one the script gives: the names, sorted and each once, or null. */
export function parseReads(v: unknown): string[] | null {
  const reads = v && typeof v === 'object' ? (v as { reads?: unknown }).reads : undefined;
  if (!Array.isArray(reads) || reads.length > MAX_READS) return null;
  const out: string[] = [];
  for (const n of reads) {
    if (typeof n !== 'string' || n.length > MAX_NAME || !NAME.test(n)) return null;
    if (out.length && out[out.length - 1] >= n) return null;
    out.push(n);
  }
  return out;
}
