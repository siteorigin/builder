/**
 * Safety checks for authored Svelte code. Every code save passes through these, and code that fails
 * them is never written to the project. The goal is that a novice cannot break their site by saving code.
 *
 * The checks read the compiler's own syntax tree, never the raw text: prose such as "Our process" is
 * never mistaken for code, and an import split over several lines is still an import.
 *
 * Code the assistant writes is held to a stricter policy (`strict`): no network, no Node.js, no dynamic
 * loading, no global-object escapes and no remote or embedded content. It is a guard rail for generated
 * code, not a sandbox for hostile code.
 */
import { posix } from 'node:path';

export interface CodeProblem {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  column?: number;
}

/** Where project code components live; relative imports resolve from here and must stay inside src/lib. */
const COMPONENT_DIR = 'src/lib/siteorigin/custom';

const inLib = (p: string) => !p.includes('\0') && (p === 'src/lib' || p.startsWith('src/lib/'));
const resolveSpec = (spec: string): string | null =>
  spec.startsWith('$lib/') ? posix.normalize(`src/lib/${spec.slice(5)}`) : spec.startsWith('./') || spec.startsWith('../') ? posix.normalize(`${COMPONENT_DIR}/${spec}`) : null;

/** Is this import specifier available to a project component? */
export function importAllowed(spec: string, strict = false): boolean {
  if (spec === 'svelte' || spec.startsWith('svelte/')) return !strict || !spec.startsWith('svelte/compiler');
  if (spec.startsWith('$app/')) return strict ? ['$app/environment', '$app/state', '$app/navigation', '$app/paths'].includes(spec) : spec !== '$app/server';
  const p = resolveSpec(spec);
  if (p === null || !inLib(p)) return false;
  // The assistant may use the generated runtime helpers and other project components, nothing else in the project.
  if (strict) return p.startsWith('src/lib/siteorigin/runtime/') || (p.startsWith(`${COMPONENT_DIR}/`) && p.endsWith('.svelte'));
  return true;
}

/** Network access the assistant's code may not reach, as globals or as properties (window.fetch). */
const NETWORK = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'WebTransport', 'RTCPeerConnection', 'serviceWorker']);
/** Constructors that load remote resources or run other scripts. */
const LOADERS = new Set(['Image', 'Audio', 'Worker', 'SharedWorker']);
/** Node.js names: server-side rendering runs in Node, so these must never appear in the assistant's code. */
const NODE = new Set(['process', 'require', '__dirname', '__filename', 'Buffer', 'global']);
/** Ways out of the component's scope or into code evaluation. */
const GLOBAL_ESCAPE = new Set(['globalThis', 'Function', 'eval', 'Reflect', 'Proxy', 'constructor', '__proto__', 'prototype']);
/** DOM APIs that create elements or markup outside the template, where the element checks cannot see them. */
const MARKUP_ESCAPE = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc']);
/** Document and window methods that do the same. */
const DOM_ESCAPE = new Set(['createElement', 'createElementNS', 'write', 'writeln', 'open']);
/** Global objects: the assistant may read their properties (window.innerWidth) but not pass them around or index them. */
const GLOBAL_OBJECTS = new Set(['window', 'self', 'top', 'parent', 'frames', 'document', 'globalThis', 'navigator', 'global']);
/** Browser-only objects that break prerendering when touched while the page is rendered on the server. */
const BROWSER_ONLY = new Set(['window', 'document', 'localStorage', 'sessionStorage', 'navigator']);
/** Elements that embed external content, run scripts or change how the page loads. */
const EMBEDS = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'script', 'base', 'link', 'meta']);
/** Attributes that load or submit to a URL. A link's href only navigates, so it may point anywhere safe. */
const URL_ATTRS = new Set(['src', 'srcset', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'data', 'background', 'ping', 'cite']);
const SCRIPT_URL = /^\s*(javascript|vbscript|data:text\/html)/i;
const REMOTE_URL = /^\s*(https?:)?\/\//i;
const CSS_REMOTE = /@import|url\(\s*['"]?\s*(https?:)?\/\//i;

type Node = { type: string; start?: number; end?: number; [k: string]: unknown };

const nameOf = (n: Node | undefined, computed: unknown): string | null =>
  !n ? null : n.type === 'Identifier' && !computed ? (n.name as string) : n.type === 'Literal' ? String(n.value) : null;

/** `browser`, `typeof window !== 'undefined'` and similar tests mean the guarded code only runs in the browser. */
function isBrowserGuard(test: Node | undefined): boolean {
  if (!test) return false;
  if (test.type === 'Identifier') return test.name === 'browser';
  if (test.type === 'LogicalExpression' && test.operator === '&&') return isBrowserGuard(test.left as Node) || isBrowserGuard(test.right as Node);
  if (test.type === 'BinaryExpression' && (test.operator === '!==' || test.operator === '!=')) {
    const side = (x: Node) => x.type === 'UnaryExpression' && x.operator === 'typeof' && BROWSER_ONLY.has(String((x.argument as Node).name));
    return side(test.left as Node) || side(test.right as Node);
  }
  return false;
}

export async function checkSvelteSource(source: string, opts: { strict?: boolean } = {}): Promise<CodeProblem[]> {
  const strict = !!opts.strict;
  const problems: CodeProblem[] = [];
  if (source.length > 60_000) return [{ severity: 'error', message: 'This component is too large. Split it into smaller components.' }];
  const { compile, parse } = await import('svelte/compiler');
  // Both outputs must compile: pages are prerendered on the server and hydrated in the browser.
  for (const generate of ['client', 'server'] as const) {
    try {
      const r = compile(source, { filename: 'Component.svelte', generate, runes: true });
      if (generate === 'client')
        for (const w of r.warnings.slice(0, 10)) problems.push({ severity: 'warning', message: w.message.split('\n')[0], line: w.start?.line, column: w.start?.column });
    } catch (e) {
      const err = e as { message: string; start?: { line: number; column: number } };
      problems.push({ severity: 'error', message: err.message.split('\n')[0], line: err.start?.line, column: err.start?.column });
      return problems;
    }
  }
  let ast: Node;
  try {
    ast = parse(source, { modern: true }) as unknown as Node;
  } catch (e) {
    return [...problems, { severity: 'error', message: (e as Error).message.split('\n')[0] }];
  }
  const lineAt = (offset: number | undefined) => (offset === undefined ? undefined : source.slice(0, offset).split('\n').length);
  const seen = new Set<string>();
  const add = (severity: CodeProblem['severity'], message: string, node?: Node) => {
    const line = lineAt(node?.start);
    const key = `${severity}|${message}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ severity, message, ...(line ? { line } : {}) });
  };
  const forbid = (what: string, node: Node) => add('error', `Code written by the assistant may not use ${what}.`, node);
  const checkSpec = (spec: unknown, node: Node) => {
    if (typeof spec !== 'string') return;
    if (!importAllowed(spec)) add('error', `"${spec}" is not available in this project. Use relative imports inside src/lib, $lib, svelte or $app modules only.`, node);
    else if (strict && !importAllowed(spec, true)) forbid(`"${spec}"`, node);
  };
  /** Capability names reached as a property (obj.fetch) or by destructuring ({ fetch } = window). */
  const checkCapability = (name: string, node: Node, onGlobal: boolean, called: boolean) => {
    if (!strict) return;
    if (GLOBAL_ESCAPE.has(name)) forbid('global object access', node);
    else if (NODE.has(name) && onGlobal) forbid('Node.js features', node);
    else if (NETWORK.has(name) && (onGlobal || called)) forbid('network requests', node);
    else if (MARKUP_ESCAPE.has(name) || (DOM_ESCAPE.has(name) && onGlobal)) forbid('markup created outside the template', node);
  };

  if (ast.module) add('error', 'Module scripts are not supported in project components.', ast.module as Node);
  // Styles cannot pull in remote stylesheets, fonts or images.
  const css = (ast.css as { content?: { styles?: string } } | null)?.content?.styles ?? '';
  if (strict && CSS_REMOTE.test(css)) forbid('remote stylesheets or images in CSS', ast.css as Node);

  /** Names the component imports: an imported Image component is not the browser's Image loader. */
  const imported = new Set<string>();
  for (const st of ((ast.instance as { content?: { body?: Node[] } } | null)?.content?.body ?? []))
    if (st.type === 'ImportDeclaration') for (const sp of st.specifiers as Node[]) imported.add(String((sp.local as Node).name));

  let browserWarned = false;
  /**
   * Visit every node. `deferred` counts enclosing functions and browser-only guards (code that does not
   * run while the page renders on the server); `key` is the property of `parent` holding this node.
   */
  const visit = (node: unknown, deferred: number, parent: Node | null, key: string) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, deferred, parent, key);
      return;
    }
    const n = node as Node;
    if (typeof n.type !== 'string') return;
    const childDeferred = deferred + (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' ? 1 : 0);
    // Children whose code runs only in the browser.
    const guarded = new Set<string>();
    switch (n.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
        checkSpec((n.source as Node | null)?.value, n);
        break;
      case 'ImportExpression': {
        const src = n.source as Node;
        if (strict) forbid('dynamic imports', n);
        else if (src.type === 'Literal') checkSpec(src.value, n);
        else add('error', 'Imports must name a fixed module. Use a static import instead.', n);
        break;
      }
      case 'HtmlTag':
        add('error', 'Raw HTML ({@html}) is not allowed because it can break the page or let unsafe content in. Use normal text and elements instead.', n);
        break;
      case 'IfStatement':
      case 'ConditionalExpression':
      case 'IfBlock':
        if (isBrowserGuard(n.test as Node)) guarded.add('consequent');
        break;
      case 'LogicalExpression':
        if (n.operator === '&&' && isBrowserGuard(n.left as Node)) guarded.add('right');
        break;
      case 'CallExpression':
      case 'NewExpression': {
        const callee = n.callee as Node;
        if (callee.type === 'Identifier' && (callee.name === 'eval' || callee.name === 'Function')) add('error', 'eval and Function are not allowed.', n);
        if (strict && n.type === 'NewExpression' && callee.type === 'Identifier' && LOADERS.has(callee.name as string) && !imported.has(callee.name as string)) forbid('network requests', n);
        const args = n.arguments as Node[];
        if (callee.type === 'Identifier' && (callee.name === 'setTimeout' || callee.name === 'setInterval') && args[0] && (args[0].type === 'Literal' || args[0].type === 'TemplateLiteral'))
          add('error', `${callee.name} must be given a function, not a string of code.`, n);
        break;
      }
      case 'MemberExpression': {
        const obj = n.object as Node;
        const propName = nameOf(n.property as Node, n.computed);
        // [].constructor.constructor('…') reaches Function without naming it.
        if (propName === 'constructor' && obj.type === 'MemberExpression' && nameOf(obj.property as Node, obj.computed) === 'constructor') add('error', 'eval and Function are not allowed.', n);
        const onGlobal = obj.type === 'Identifier' && GLOBAL_OBJECTS.has(obj.name as string);
        if (propName) checkCapability(propName, n, onGlobal, parent?.type === 'CallExpression' && key === 'callee');
        else if (strict && onGlobal) forbid('global object access', n);
        break;
      }
      case 'ObjectPattern':
        // const { constructor: C } = [] reaches the same escapes as [].constructor. (Destructuring a global
        // object itself is caught where the object is named.)
        for (const p of n.properties as Node[]) if (strict && p.type === 'Property' && GLOBAL_ESCAPE.has(nameOf(p.key as Node, p.computed) ?? '')) forbid('global object access', p);
        break;
      case 'MetaProperty':
        if (strict) forbid('import.meta', n);
        break;
      case 'Identifier': {
        const name = n.name as string;
        const notRef =
          (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
          ((parent?.type === 'Property' || parent?.type === 'PropertyDefinition' || parent?.type === 'MethodDefinition') && key === 'key' && !parent.computed) ||
          ((parent?.type === 'LabeledStatement' || parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement') && key === 'label');
        if (notRef) break;
        if (strict) {
          if (NETWORK.has(name)) forbid('network requests', n);
          else if (NODE.has(name)) forbid('Node.js features', n);
          else if (GLOBAL_ESCAPE.has(name)) forbid('global object access', n);
          // window.innerWidth is fine; passing window itself around (const w = window) hides what it reaches.
          else if (GLOBAL_OBJECTS.has(name) && !(parent?.type === 'MemberExpression' && key === 'object') && !(parent?.type === 'UnaryExpression' && parent.operator === 'typeof'))
            forbid('global object access', n);
        }
        // Touching window or document while the page renders breaks prerendering (typeof checks are fine).
        if (!browserWarned && deferred === 0 && BROWSER_ONLY.has(name) && !(parent?.type === 'UnaryExpression' && parent.operator === 'typeof')) {
          browserWarned = true;
          add('warning', 'Browser-only objects (window, document, localStorage) must be used inside onMount or $effect, or the page cannot be prerendered.', n);
        }
        break;
      }
      case 'RegularElement':
        if (strict && EMBEDS.has(String(n.name).toLowerCase())) forbid('embedded external content', n);
        break;
      case 'SvelteElement': {
        const tag = n.tag as Node | string;
        const literal = typeof tag === 'string' ? tag : tag.type === 'Literal' ? String(tag.value) : null;
        // A computed tag could spell out any element ('ifr' + 'ame'), so the assistant must name it.
        if (strict && literal === null) forbid('elements whose tag is computed', n);
        else if (strict && literal !== null && EMBEDS.has(literal.toLowerCase())) forbid('embedded external content', n);
        break;
      }
      case 'SpreadAttribute':
        // Spread attributes could carry src, href or event handlers the checks cannot see.
        if (strict) forbid('spread attributes', n);
        break;
      case 'Attribute': {
        if (!strict) break;
        const attr = String(n.name).toLowerCase();
        const values = n.value === true ? [] : Array.isArray(n.value) ? (n.value as Node[]) : [n.value as Node];
        const texts = values.map((v) => (v.type === 'Text' ? String(v.data) : v.type === 'ExpressionTag' ? literalText(v.expression as Node) : null));
        const navigates = attr === 'href' && parent?.type === 'RegularElement' && ['a', 'area'].includes(String(parent.name).toLowerCase());
        if (attr.startsWith('on') && texts.some((t) => t !== null)) forbid('event handlers written as text', n);
        if (URL_ATTRS.has(attr)) {
          const first = texts[0];
          if (first !== null && first !== undefined && SCRIPT_URL.test(first)) forbid('script URLs', n);
          else if (!navigates && first !== null && first !== undefined && REMOTE_URL.test(first)) forbid('remote content (use an image from the project)', n);
        }
        if (attr === 'style' && texts.some((t) => t !== null && CSS_REMOTE.test(t))) forbid('remote stylesheets or images in CSS', n);
        break;
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'loc' || k === 'metadata' || k === 'parent' || k === 'start' || k === 'end') continue;
      visit(n[k], childDeferred + (guarded.has(k) ? 1 : 0), n, k);
    }
  };
  visit(ast.instance, 0, null, 'instance');
  visit(ast.fragment, 0, null, 'fragment');
  return problems;
}

/** The text of a string literal or a template literal without expressions; null for anything computed. */
function literalText(n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && (n.expressions as Node[]).length === 0) return String(((n.quasis as Node[])[0]?.value as { cooked?: string })?.cooked ?? '');
  return null;
}
