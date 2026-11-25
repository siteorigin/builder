import { ELEMENT_TAGS, TEXT_TAGS } from '@shared/types';

/**
 * What a theme's own stylesheet may decide about the layouts the guardrails read (engine/layout-guardrails): which
 * boxes its layout rules reach, by the classes they name (a design's element, a detached copy of one, a page's
 * element) or by tag, and whether a rule may make the page itself what an absolutely positioned element is placed in.
 * Read once per stylesheet, in passes that each look at every character a bounded number of times, so no stylesheet a
 * theme can ship slows validation down.
 */

/** Properties a theme rule can set that decide what the guardrails read. */
const DECIDING = /^(position|inset|top|bottom|overflow(-x|-y|-block|-inline)?|display|grid(-[a-z-]+)?|transform|translate|rotate|scale|filter|backdrop-filter|-webkit-backdrop-filter|perspective|contain|container(-type)?|will-change|content-visibility)$/;

/**
 * Properties that can make a box what an absolutely positioned element inside it is placed in, each with the values
 * that do not. `initial`, `unset` and `revert` give each its first value, which never does.
 */
const CONTAINING: Record<string, (value: string) => boolean> = {
  position: (v) => v === 'static',
  transform: (v) => v === 'none',
  translate: (v) => v === 'none',
  rotate: (v) => v === 'none',
  scale: (v) => v === 'none',
  filter: (v) => v === 'none',
  'backdrop-filter': (v) => v === 'none',
  '-webkit-backdrop-filter': (v) => v === 'none',
  perspective: (v) => v === 'none',
  contain: (v) => v === 'none',
  'container-type': (v) => v === 'normal',
  // A name alone leaves its type normal; a type comes after a slash.
  container: (v) => v === 'none' || !v.includes('/') || v.split('/')[1].trim() === 'normal',
  'will-change': (v) => v === 'auto',
  'content-visibility': (v) => v === 'visible'
};
const containingDecl = (prop: string, value: string) => {
  const inert = Object.hasOwn(CONTAINING, prop) ? CONTAINING[prop] : undefined;
  const trimmed = value.trim();
  const v = trimmed.endsWith('!important') ? trimmed.slice(0, -'!important'.length).trim() : trimmed;
  return !!inert && !['initial', 'unset', 'revert', 'revert-layer'].includes(v) && !inert(v);
};

/** The most selectors one is read as once its `:is(…)` and `:where(…)` alternatives are apart. */
const MAX_BRANCHES = 32;
/**
 * The longest selector whose alternatives are read apart: each step of that rewrites the whole selector, so a longer
 * one (far longer than any a theme writes by hand) is read as reaching any box.
 */
const MAX_EXPANDED = 1000;
/** The most class rules a box is matched against. */
const MAX_HOOKS = 2000;

/**
 * Walk a text outside quoted strings: `visit` sees each character's index and whether it is quoted (or escaped).
 * Linear.
 */
function scan(text: string, visit: (i: number, quoted: boolean) => void): void {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      visit(i, true);
      if (ch === '\\' && i + 1 < text.length) visit(++i, true);
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      visit(i, true);
    } else visit(i, false);
  }
}

/** Each part of a text between top-level separators, passing over quoted strings, parentheses and brackets. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  scan(text, (i, quoted) => {
    if (quoted) return;
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  });
  out.push(text.slice(start));
  return out;
}

/** A selector without its conditions on other elements (`:has(…)`, `:not(…)`), which never name the box itself. Linear. */
function withoutConditions(selector: string): string {
  let out = '';
  let skipping = 0;
  let depth = 0;
  scan(selector, (i, quoted) => {
    const ch = selector[i];
    if (!quoted && !skipping && ch === ':' && /^:(has|not)\(/i.test(selector.slice(i, i + 5))) {
      skipping = depth + 1;
      return;
    }
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') {
      depth = Math.max(0, depth - 1);
      if (skipping && depth < skipping) return void (skipping = 0);
    }
    if (!skipping) out += ch;
  });
  return out;
}

/** The first `:is(` or `:where(` outside quoted strings, and where its parenthesis closes. */
function firstAlternatives(selector: string): { at: number; open: number; close: number } | null {
  let found: { at: number; open: number; close: number } | null = null;
  let depth = 0;
  scan(selector, (i, quoted) => {
    if (quoted || (found && found.close >= 0)) return;
    const ch = selector[i];
    if (!found && ch === ':') {
      const m = /^:(is|where)\(/i.exec(selector.slice(i, i + 7));
      if (m) found = { at: i, open: i + m[0].length - 1, close: -1 };
      return;
    }
    if (!found) return;
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) found.close = i;
  });
  if (!found) return null;
  const f = found as { at: number; open: number; close: number };
  return { ...f, close: f.close < 0 ? selector.length : f.close };
}

/** A selector as the plain selectors its `:is(…)` and `:where(…)` alternatives make, or null for too many to read. */
function branches(selector: string, budget = { calls: MAX_BRANCHES * 4, leaves: MAX_BRANCHES }): string[] | null {
  if (--budget.calls < 0) return null;
  const call = firstAlternatives(selector);
  if (!call) return --budget.leaves >= 0 ? [selector] : null;
  const out: string[] = [];
  for (const alt of splitTop(selector.slice(call.open + 1, call.close), ',')) {
    const more = branches(selector.slice(0, call.at) + alt.trim() + selector.slice(call.close + 1), budget);
    if (!more) return null;
    out.push(...more);
  }
  return out;
}

interface Token {
  /** `.` a class; `=`, `^`, `$` or `*` the class attribute equal to, starting, ending or containing the value. */
  op: string;
  value: string;
}
const TOKEN = /\[\s*class\s*([$*^~]?)=\s*(?:'([^']*)'|"([^"]*)"|([\w-]+))(?:\s+[is])?\s*\]|\.(-?[_a-zA-Z][\w-]*)/g;
const tokensOf = (selector: string): Token[] =>
  [...selector.matchAll(TOKEN)].map((t) => (t[5] !== undefined ? { op: '.', value: t[5] } : { op: t[1] === '~' ? '=' : t[1] || '=', value: (t[2] ?? t[3] ?? t[4]).trim() }));

/** The tags a container or text can render as, for one whose tag a property chooses. */
const ANY_ELEMENT = new Set([...ELEMENT_TAGS, ...TEXT_TAGS, 'a']);

/** Pseudo-elements: a rule for one styles a box of the browser's making, never the element itself. */
const PSEUDO_ELEMENT = /::|:(before|after|first-line|first-letter|marker)\b/i;

/**
 * The element a selector styles, by tag: the tag its last compound names, '*' for any element, or null when it styles
 * a pseudo-element (a box of the browser's making).
 */
function subjectTag(selector: string): string | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  scan(selector, (i, quoted) => {
    if (quoted) return;
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[\s>+~]/.test(ch)) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  });
  parts.push(selector.slice(start));
  const last = parts.map((p) => p.trim()).filter(Boolean).pop() ?? '';
  if (PSEUDO_ELEMENT.test(last)) return null;
  const tag = /^[a-zA-Z][\w-]*/.exec(last)?.[0];
  return tag ? tag.toLowerCase() : '*';
}

/** One rule that may decide a layout, by the classes it names: any one element class, and every modifier. */
interface HookRule {
  any: Token[];
  all: Token[];
}

export interface ThemeLayoutRules {
  /** A rule may make the page itself (`main`, `body`) something an absolutely positioned element is placed in. */
  page: boolean;
  /** Whether a rule may reach a box with these classes and tags it may render as (undefined: any), or what is inside it. */
  reaches(classes: string[], tags?: string[]): boolean;
}

/**
 * Every rule of a stylesheet: its selector list and its own declarations (those of rules nested inside it are their
 * own rules), without comments. One pass, passing over comments and quoted strings.
 */
function rulesOf(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  // Each open block: its selector, and the statements written directly inside it.
  const open: Array<{ selector: string; text: string }> = [];
  // The statement being read: a declaration once a semicolon or the block's end closes it, a selector once a brace opens.
  let pending = '';
  let quote = '';
  const flush = () => {
    if (open.length) open[open.length - 1].text += pending;
    pending = '';
  };
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      pending += ch;
      if (ch === '\\' && i + 1 < css.length) pending += css[++i];
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      pending += ch;
    } else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else if (ch === '{') {
      open.push({ selector: pending.trim(), text: '' });
      pending = '';
    } else if (ch === '}') {
      flush();
      const block = open.pop();
      if (block) out.push({ selector: block.selector, body: block.text });
    } else {
      pending += ch;
      if (ch === ';') flush();
    }
  }
  return out;
}

const cache = new Map<string, ThemeLayoutRules>();

export function themeLayoutRules(css: string): ThemeLayoutRules {
  const cached = cache.get(css);
  if (cached) return cached;
  let page = false;
  /** Tags a rule naming no class may lay out ('*' for any element). */
  const tags = new Set<string>();
  const hooks: HookRule[] = [];
  for (const { selector, body } of rulesOf(css)) {
    // An at-rule's own block (a font face, a media query's wrapper), or a keyframe of an animation, styles no element.
    if (!selector || selector.startsWith('@') || splitTop(selector, ',').every((s) => /^(from|to|[\d.]+%)$/.test(s.trim()))) continue;
    const decls = splitTop(body, ';').flatMap((d) => {
      const colon = d.indexOf(':');
      return colon > 0 ? [{ prop: d.slice(0, colon).trim().toLowerCase(), value: d.slice(colon + 1).trim().toLowerCase() }] : [];
    });
    if (!decls.some((d) => DECIDING.test(d.prop))) continue;
    const containing = decls.some((d) => containingDecl(d.prop, d.value));
    for (const one of splitTop(selector, ',')) {
      // Too many alternatives to read apart: it may reach any box, and the page.
      const plain = withoutConditions(one);
      const each = plain.length > MAX_EXPANDED ? null : branches(plain);
      if (!each) {
        tags.add('*');
        if (containing) page = true;
        continue;
      }
      for (const branch of each) {
        const tokens = tokensOf(branch);
        if (tokens.length) {
          // A modifier (`--layout-sticky-split`) narrows the rule to boxes that carry it; a detached copy's prefix is none.
          const modifier = (t: Token) => t.value.replace(/^so--d-/, '').includes('--');
          hooks.push({ any: tokens.filter((t) => !modifier(t)), all: tokens.filter(modifier) });
          continue;
        }
        const tag = subjectTag(branch);
        if (tag === null) continue;
        // The site's own wrappers are these (its app root is a div): positioning one may position the page.
        if (tag === 'html' || tag === 'body' || tag === 'main' || tag === 'div' || tag === '*' || /#main\b/.test(branch)) page ||= containing;
        if (tag !== 'html' && tag !== 'body') tags.add(tag);
      }
    }
  }
  // So many class rules that matching each box against them all would slow every validation: read as reaching any box.
  if (hooks.length > MAX_HOOKS) tags.add('*');
  const matches = (classes: string[], t: Token) =>
    t.op === '^' ? classes.join(' ').startsWith(t.value) : classes.some((c) => (t.op === '.' || t.op === '=' ? c === t.value : t.op === '*' ? c.includes(t.value) : c.endsWith(t.value)));
  const rules: ThemeLayoutRules = {
    page,
    reaches: (classes, as) =>
      tags.has('*') ||
      (as === undefined ? [...tags].some((t) => ANY_ELEMENT.has(t)) : as.some((t) => tags.has(t.toLowerCase()))) ||
      (classes.length > 0 && hooks.some((r) => (r.any.length === 0 || r.any.some((t) => matches(classes, t))) && r.all.every((t) => matches(classes, t))))
  };
  cache.set(css, rules);
  return rules;
}
