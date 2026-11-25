/**
 * What a theme's own stylesheet may decide about the layouts the guardrails read (engine/layout-guardrails): which
 * classes its layout rules hook (a design's element, or a detached copy of one, by its class), and whether a rule that
 * names no class at all may make the page itself, or every element of a tag, what an absolutely positioned element is
 * placed in. Read once per stylesheet, in one pass over its text.
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
  const v = value.replace(/\s*!important$/, '').trim();
  return !!inert && !['initial', 'unset', 'revert', 'revert-layer'].includes(v) && !inert(v);
};

/** Each part of a text between top-level separators, passing over quoted strings and parentheses. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Where the parenthesis opened at `open` closes, passing over quoted strings; the text's end if it never does. */
function closing(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return text.length;
}

/** Where a pseudo-class taking a selector list starts outside quoted strings, from `from`; -1 for none. */
function findCall(text: string, names: RegExp, from = 0): { at: number; open: number } | null {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ':') {
      const m = names.exec(text.slice(i));
      if (m) return { at: i, open: i + m[0].length - 1 };
    }
  }
  return null;
}

/** A selector without its conditions on other elements (`:has(…)`, `:not(…)`), which never name the box itself. */
function withoutConditions(selector: string): string {
  let out = selector;
  for (let call = findCall(out, /^:(has|not)\(/); call; call = findCall(out, /^:(has|not)\(/, call.at)) out = out.slice(0, call.at) + out.slice(closing(out, call.open) + 1);
  return out;
}

/** The most selectors one is read as; beyond it, every class it names is read as one that may hook a box. */
const MAX_BRANCHES = 32;

/** A selector as the plain selectors its `:is(…)` and `:where(…)` alternatives make, or null for too many. */
function branches(selector: string, budget = { left: MAX_BRANCHES }): string[] | null {
  const call = findCall(selector, /^:(is|where)\(/);
  if (!call) return --budget.left >= 0 ? [selector] : null;
  const end = closing(selector, call.open);
  const out: string[] = [];
  for (const alt of splitTop(selector.slice(call.open + 1, end), ',')) {
    const more = branches(selector.slice(0, call.at) + alt.trim() + selector.slice(end + 1), budget);
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
const TOKEN = /\[\s*class\s*([$*^]?)=\s*(?:'([^']*)'|"([^"]*)"|([\w-]+))\s*\]|\.(-?[_a-zA-Z][\w-]*)/g;
const tokensOf = (selector: string): Token[] => [...selector.matchAll(TOKEN)].map((t) => (t[5] !== undefined ? { op: '.', value: t[5] } : { op: t[1] || '=', value: (t[2] ?? t[3] ?? t[4]).trim() }));

/** One rule that may decide a layout, by the classes it names: any one element class, and every modifier. */
interface HookRule {
  any: Token[];
  all: Token[];
}

export interface ThemeLayoutRules {
  /** A rule names no class at all (`main`, `li`) yet may make a box something an element is placed in. */
  page: boolean;
  /** Whether a rule may reach a box with these classes, or what is inside it. */
  reaches(classes: string[]): boolean;
}

/** Every rule of a stylesheet with its selector list and declarations, passing over comments and quoted strings. */
function rulesOf(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const open: Array<{ prelude: number; at: number; nested: boolean }> = [];
  let prelude = 0;
  let quote = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else if (ch === '{') {
      if (open.length) open[open.length - 1].nested = true;
      open.push({ prelude, at: i, nested: false });
      prelude = i + 1;
    } else if (ch === '}') {
      const block = open.pop();
      if (block && !block.nested) out.push({ selector: css.slice(block.prelude, block.at).replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: css.slice(block.at + 1, i) });
      prelude = i + 1;
    } else if (ch === ';') prelude = i + 1;
  }
  return out;
}

const cache = new Map<string, ThemeLayoutRules>();

export function themeLayoutRules(css: string): ThemeLayoutRules {
  const cached = cache.get(css);
  if (cached) return cached;
  let page = false;
  const hooks: HookRule[] = [];
  for (const { selector, body } of rulesOf(css)) {
    // An at-rule's own block (a font face), or a keyframe of an animation, styles no element at rest.
    if (!selector || selector.startsWith('@') || splitTop(selector, ',').every((s) => /^(from|to|[\d.]+%)$/.test(s.trim()))) continue;
    const decls = splitTop(body.replace(/\/\*[\s\S]*?\*\//g, ''), ';').flatMap((d) => {
      const colon = d.indexOf(':');
      return colon > 0 ? [{ prop: d.slice(0, colon).trim().toLowerCase(), value: d.slice(colon + 1).trim().toLowerCase() }] : [];
    });
    if (!decls.some((d) => DECIDING.test(d.prop))) continue;
    const containing = decls.some((d) => containingDecl(d.prop, d.value));
    for (const one of splitTop(selector, ',')) {
      const plain = withoutConditions(one);
      const each = branches(plain);
      // Too many alternatives to read apart: every class named may hook a box, and an element named by its tag may be one.
      if (!each) {
        hooks.push({ any: tokensOf(plain), all: [] });
        if (containing) page = true;
        continue;
      }
      for (const branch of each) {
        const tokens = tokensOf(branch);
        if (!tokens.length) {
          if (containing) page = true;
          continue;
        }
        // A modifier (`--layout-sticky-split`) narrows the rule to boxes that carry it; a detached copy's prefix is none.
        const modifier = (t: Token) => t.value.replace(/^so--d-/, '').includes('--');
        hooks.push({ any: tokens.filter((t) => !modifier(t)), all: tokens.filter(modifier) });
      }
    }
  }
  const matches = (classes: string[], t: Token) =>
    t.op === '^' ? classes.join(' ').startsWith(t.value) : classes.some((c) => (t.op === '.' || t.op === '=' ? c === t.value : t.op === '*' ? c.includes(t.value) : c.endsWith(t.value)));
  const rules: ThemeLayoutRules = {
    page,
    reaches: (classes) => classes.length > 0 && hooks.some((r) => (r.any.length === 0 || r.any.some((t) => matches(classes, t))) && r.all.every((t) => matches(classes, t)))
  };
  cache.set(css, rules);
  return rules;
}
