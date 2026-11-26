// What a person reads in the app, in an export and in sample content is spelled the American way (issue #826).
// Read from the source: string literals, template text and JSX text, the strings a stylesheet draws, and the
// shipped text files. Comments are not read, including those inside code a template writes out.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

/** The British forms that tend to come back, each as a whole word with its endings. */
const BRITISH = new RegExp(
  `\\b(?:${[
    '(?:multi|water)?colou?r(?<=colour)(?:s|ed|ing|ful|less)?',
    '(?:behaviour|flavour|harbour|honour|humour|labour|neighbour|rumour)(?:s|ed|ing|al|ly|hood|able|ably)?',
    'favour(?:s|ed|ing|able|ably|ite|ites)?',
    'licence[ds]?',
    '(?:defence|offence|pretence)s?',
    '(?:apologi|authori|capitali|categori|centrali|customi|finali|initiali|maximi|minimi|normali|optimi|organi|prioriti|recogni|seriali|speciali|summari|synchroni|utili|visuali)(?:se|ses|sed|sing|sable|sation|sations)',
    'analys(?:e|ed|ing)',
    '(?:centre|metre|litre|fibre|theatre)s?',
    'cent(?:red|ring)',
    '(?:cancel|label|model|travel|signal)l(?:ed|ing|er|ers)',
    'enquir(?:e|es|ed|ing|y|ies)',
    'practis(?:e|es|ed|ing)',
    'catalogu(?:e|es|ed|ing)',
    '(?:dialogue)s?',
    'greys?(?:cale)?',
    '(?:artefact|programme|storey|tyre|kerb)s?',
    'judgement(?:s|al)?',
    '(?:whilst|amongst|learnt|spelt|aluminium)'
  ].join('|')})\\b`,
  'gi'
);

/**
 * Spellings that are not text to read: names a contract fixes, and text compared word for word with what is already
 * on disk. Each is taken out of the one file it is allowed in (every file, for `*`) before that file is judged.
 */
const EXEMPT: { file: string; text: RegExp; why: string }[] = [
  { file: '*', text: /^(?:cancelled|CANCELLED)$/, why: 'a run status, outcome or error code' },
  { file: '*', text: /^(?:app:)?catalogue$|\["catalogue"\]|^@catalogue\//, why: 'the catalogue’s name in the tool, channel and module contracts' },
  { file: 'src/main/project/image-variants.ts', text: /^centre$/, why: 'a position name sharp defines' },
  { file: 'src/renderer/src/panels/CommandMenu.tsx', text: /\bcolors colours\b/, why: 'a search word, so either spelling finds the command' },
  { file: 'src/catalogue/foundation/ai-examples.ts', text: /^enquiry$/, why: 'a search word, so either spelling finds the example' },
  { file: 'src/catalogue/foundation/form.ts', text: /^enquiry$/, why: 'a search tag, so either spelling finds the form' },
  { file: 'src/renderer/src/lib/chatSuggestions.ts', text: /^(?:enquiry|enquiries)$/, why: 'words matched in what the author wrote' },
  { file: 'src/renderer/src/lib/gallery-picks.ts', text: /^Studio, Harbour Lane$/, why: 'an earlier sample caption, matched exactly' },
  { file: 'src/main/export.ts', text: /^The Foundation theme is licensed under GPL-3\.0-or-later\. Icons come from Lucide \(ISC licence\)[^]*$/, why: 'an earlier README notice, matched exactly' },
  { file: 'src/main/export.ts', text: /## Notices\n\nThe Foundation theme is licensed under GPL-3\.0-or-later\. Icons come from Lucide \(ISC licence\)\.[^\n]*/, why: 'the earliest README, matched exactly' }
];

/** Text without the comments of the code it may be: CSS, JavaScript and markup. A `//` inside a URL has no space before it. */
const uncommented = (text: string) => text.replace(/\/\*[^]*?\*\/|<!--[^]*?-->/g, ' ').replace(/(^|\s)\/\/(?=\s).*$/gm, '$1');

/** The British words in a piece of text read from `file`. */
export function britishWords(file: string, text: string): string[] {
  const rest = EXEMPT.reduce((t, e) => (e.file === '*' || e.file === file ? t.replace(new RegExp(e.text.source, `${e.text.flags}g`), ' ') : t), uncommented(text));
  return rest.match(BRITISH) ?? [];
}

/** Every piece of text in a script that is not a comment, a type or a module's name. */
export function scriptStrings(file: string, source: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { line: number; text: string }[] = [];
  const add = (node: ts.Node, text: string) => found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
  const named = (node: ts.Node) => {
    const p = node.parent;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p)) return true;
    if (ts.isCallExpression(p) && (p.expression.kind === ts.SyntaxKind.ImportKeyword || p.expression.getText(sf) === 'require')) return true;
    return (ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) && p.name === node;
  };
  const walk = (node: ts.Node) => {
    if (ts.isTemplateExpression(node)) {
      // The text around the substitutions is read as one, so a comment that spans them is still a comment.
      add(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' … '));
      for (const span of node.templateSpans) walk(span.expression);
      return;
    }
    if ((ts.isStringLiteralLike(node) && !named(node)) || ts.isJsxText(node)) add(node, node.text);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

const files = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [relative(ROOT, join(ROOT, dir, e.name))]));

function strings(file: string): { line: number; text: string }[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  if (/\.(?:tsx?|m?jsx?)$/.test(file)) return scriptStrings(file, source);
  // A stylesheet's own words are CSS; what it draws on screen is what `content` holds.
  if (file.endsWith('.css')) return [...uncommented(source).matchAll(/\bcontent\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/g)].map((m) => ({ line: 0, text: m[2] }));
  if (/\.(?:html|md|txt|json|svg)$/.test(file)) return source.split('\n').map((text, i) => ({ line: i + 1, text }));
  return [];
}

describe('American spelling', () => {
  it('finds the British forms and leaves American words and fixed names alone', () => {
    expect(britishWords('a.ts', 'Its colours honour the ISC licence, organised and centred; Cancelled.')).toEqual(['colours', 'honour', 'licence', 'organised', 'centred', 'Cancelled']);
    expect(britishWords('a.ts', 'A color specialist licensed a realistic cancellation, labelledby four hours of promised revisions.')).toEqual([]);
    expect(britishWords('a.ts', '.a { /* the colour */ }\n<!-- grey -->\n  // neighbouring\nhttp://harbor.example')).toEqual([]);
    expect(britishWords('a.ts', 'cancelled')).toEqual([]);
  });

  it('reads strings, templates and JSX text, and not comments, types or module names', () => {
    const source = "import x from './colour';\n// colour\ntype T = 'grey';\nconst a = `one ${'two'} /* ${x} colour */ three`;\nconst b = <p title=\"four\">five</p>;";
    expect(scriptStrings('a.tsx', source).map((s) => s.text)).toEqual(['one  …  /*  …  colour */ three', 'two', 'four', 'five']);
  });

  it('is what the app, its exports and its sample content use', () => {
    const found = ['src', 'relay/src', 'resources/starter-assets']
      .flatMap(files)
      .flatMap((file) => strings(file).flatMap((s) => britishWords(file, s.text).map((word) => `${file}:${s.line} ${word}`)));
    expect(found).toEqual([]);
  });
});
