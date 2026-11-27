// The app's scripts are kept to characters V8 can hold one byte each (#1043).
//
// V8 holds a script's source for as long as the script lives (functions compile from it on first call), and holds it
// one byte per character only while every character is at most U+00FF: a single curly quote anywhere doubles the
// whole source. The main process's script is about 4 MB and the editor's Welcome script about 1.5 MB, so one stray
// character costs megabytes in each process for the app's lifetime. The build writes every other character as an
// escape (`output.charset: 'ascii'`) and leaves out JSDoc comments (main). What the bundler cannot escape is a
// character in a `String.raw` template, whose raw text is its value: this plugin writes each as a substitution of
// itself (`a…b` becomes `a${"\u2026"}b`, the same string), in the app's scripts only, so the sources, and the exported
// sync script built from them, keep the character as written. Then it fails a build whose scripts still hold one (in
// another tag's template, or a comment the bundler keeps), naming where.
const acorn = require('acorn');

/** Characters above U+00FF: what makes V8 hold a whole script two bytes per character. */
const WIDE = /[^\u0000-\u00ff]/gu;
const hasWide = (code) => /[^\u0000-\u00ff]/u.test(code);

/**
 * Each character of `code` above U+00FF with where it is (line and column, 1-based) and a little of what surrounds it,
 * at most `limit` of them.
 */
function wideCharacters(code, limit = 5) {
  const found = [];
  WIDE.lastIndex = 0;
  for (let m = WIDE.exec(code); m && found.length < limit; m = WIDE.exec(code)) {
    const before = code.slice(0, m.index);
    const line = before.split('\n').length;
    const column = m.index - before.lastIndexOf('\n');
    const codePoint = `U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    found.push({ codePoint, line, column, context: code.slice(Math.max(0, m.index - 40), m.index + 20).replace(/\s+/g, ' ') });
  }
  return found;
}

/** `String.raw` itself, as a template's tag. */
const isStringRaw = (tag) => tag && tag.type === 'MemberExpression' && !tag.computed && !tag.optional && tag.object.type === 'Identifier' && tag.object.name === 'String' && tag.property.type === 'Identifier' && tag.property.name === 'raw';

/** A character as a JavaScript string literal of escapes only. */
const escaped = (ch) => {
  const cp = ch.codePointAt(0);
  return `"${cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`}"`;
};

/**
 * `code` (a module script) with every character above U+00FF in the text of a `String.raw` template written as a
 * substitution of itself: `String.raw` puts a substitution's value where it stands, so the template's value is the
 * same string. Other templates and the rest of the code are left as they are.
 */
function escapeRawTemplates(code) {
  if (!hasWide(code)) return code;
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true });
  const quasis = [];
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'TaggedTemplateExpression' && isStringRaw(node.tag)) for (const q of node.quasi.quasis) if (hasWide(code.slice(q.start, q.end))) quasis.push(q);
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) c && typeof c.type === 'string' && stack.push(c);
      else if (v && typeof v.type === 'string' && key !== 'loc') stack.push(v);
    }
  }
  if (!quasis.length) return code;
  quasis.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const q of quasis) {
    // One escaped by a backslash stays (a substitution after it would be `\${`, text): the check below then names it.
    out += code.slice(at, q.start) + code.slice(q.start, q.end).replace(WIDE, (ch, i, text) => (/(^|[^\\])(\\\\)*\\$/.test(text.slice(0, i)) ? ch : `\${${escaped(ch)}}`));
    at = q.end;
  }
  return out + code.slice(at);
}

/**
 * A build plugin that writes the wide characters of `String.raw` templates as substitutions in every script chunk, and
 * fails the build when any script chunk it emits still holds a character above U+00FF.
 */
function oneByteScriptsPlugin(target) {
  return {
    name: 'siteorigin-one-byte-scripts',
    apply: 'build',
    renderChunk(code) {
      const out = escapeRawTemplates(code);
      return out === code ? null : { code: out, map: null };
    },
    // Last, once every other plugin has had the chunks, so what is checked is what is written.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const problems = [];
        for (const [file, out] of Object.entries(bundle)) {
          if (out.type !== 'chunk') continue;
          const wide = wideCharacters(out.code);
          if (wide.length) problems.push(`${file}: ${wide.map((w) => `${w.codePoint} at ${w.line}:${w.column} (…${w.context}…)`).join('; ')}`);
        }
        if (problems.length)
          this.error(
            `The ${target} build's scripts hold characters above U+00FF, so V8 would keep each whole script two bytes per character. ` +
              `Write each as an escape the bundler can see (in a tagged template, a substitution such as \${'\\u2026'}):\n${problems.join('\n')}`
          );
      }
    }
  };
}

module.exports = { wideCharacters, escapeRawTemplates, oneByteScriptsPlugin };
