/**
 * Safety checks for authored Svelte code. Every code save passes through these, and code that fails
 * them is never written to the project. The goal is that a novice cannot break their site by saving code.
 *
 * The checks read the compiler's own syntax tree, never the raw text: prose such as "Our process" is
 * never mistaken for code, and an import split over several lines is still an import.
 *
 * Code the assistant writes is held to a stricter policy (`strict`): no network, no Node.js, no dynamic
 * loading, no global-object escapes and no remote or embedded content, in the component itself or in any
 * project component it imports. It is a guard rail for generated code, not a sandbox for hostile code.
 */
import { posix } from 'node:path';
import type { ComponentDefinition } from '@shared/types';

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

/** The authored source saved at each project path, so the strict check can follow imports between components. */
export function componentSources(components: Record<string, ComponentDefinition>): (path: string) => string | undefined {
  const byPath = new Map<string, string>();
  for (const def of Object.values(components)) if (def.kind === 'code' && def.sourcePath && def.source !== undefined) byPath.set(def.sourcePath, def.source);
  return (path) => byPath.get(path);
}

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
/** Attributes whose URL only opens a page; they may point anywhere a script URL does not. */
const NAVIGATING_ATTRS = new Set(['href', 'xlink:href', 'cite']);
/** Element properties that load, submit to or open a URL when assigned. */
const DOM_URL_PROPS = new Set(['src', 'srcset', 'poster', 'action', 'formAction', 'href']);
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

export interface CheckOptions {
  /** Hold the code to the assistant's policy. */
  strict?: boolean;
  /** Where the component is saved (`src/lib/siteorigin/custom/X.svelte`), so importing itself is not followed. */
  filename?: string;
  /**
   * The source of the project component saved at a path, or null when there is none. Strict code may import
   * another project component only when that component passes the strict checks too; without a resolver
   * such an import cannot be checked and is refused.
   */
  resolve?: (path: string) => string | null | undefined;
}

/** Components already checked during one check, and those whose check is under way (an import cycle). */
interface Reach {
  visiting: Set<string>;
  done: Map<string, CodeProblem[]>;
}

export async function checkSvelteSource(source: string, opts: CheckOptions = {}): Promise<CodeProblem[]> {
  return check(source, opts, { visiting: new Set(opts.filename ? [opts.filename] : []), done: new Map() });
}

/** Strict errors of the project component saved at `path`, checked once per top-level check. */
async function siblingErrors(path: string, opts: CheckOptions, reach: Reach): Promise<CodeProblem[] | null> {
  // A component already being checked further up an import cycle reports its own problems there.
  if (reach.visiting.has(path)) return [];
  const known = reach.done.get(path);
  if (known) return known;
  const source = opts.resolve?.(path);
  if (source === null || source === undefined) return null;
  reach.visiting.add(path);
  try {
    const errors = (await check(source, { strict: true, resolve: opts.resolve }, reach)).filter((p) => p.severity === 'error');
    reach.done.set(path, errors);
    return errors;
  } finally {
    reach.visiting.delete(path);
  }
}

async function check(source: string, opts: CheckOptions, reach: Reach): Promise<CodeProblem[]> {
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
  /** Project components the strict code imports, checked once the walk is done. */
  const siblings: Array<{ spec: string; path: string; node: Node }> = [];
  const checkSpec = (spec: unknown, node: Node) => {
    if (typeof spec !== 'string') return;
    if (!importAllowed(spec)) add('error', `"${spec}" is not available in this project. Use relative imports inside src/lib, $lib, svelte or $app modules only.`, node);
    else if (strict && !importAllowed(spec, true)) forbid(`"${spec}"`, node);
    else if (strict) {
      const path = resolveSpec(spec);
      if (path?.startsWith(`${COMPONENT_DIR}/`)) siblings.push({ spec, path, node });
    }
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
  // <svelte:options customElement={{ extend }}> carries code the compiler emits as is.
  if (strict && (ast.options as { customElement?: unknown } | null)?.customElement) forbid('custom element options', ast.options as Node);
  // Styles cannot pull in remote stylesheets, fonts or images.
  const css = (ast.css as { content?: { styles?: string } } | null)?.content?.styles ?? '';
  if (strict && CSS_REMOTE.test(css)) forbid('remote stylesheets or images in CSS', ast.css as Node);

  /** Names the component imports: an imported Image component is not the browser's Image loader. */
  const imported = new Set<string>();
  for (const st of ((ast.instance as { content?: { body?: Node[] } } | null)?.content?.body ?? []))
    if (st.type === 'ImportDeclaration') for (const sp of st.specifiers as Node[]) imported.add(String((sp.local as Node).name));

  // What names in the code hold, so a URL kept in a variable is judged like one written in place.
  const read = valueReader(collectBindings([ast.instance, ast.fragment]));
  /** Every string an attribute or style value may be, as far as the code shows. */
  const valueStrings = (values: Node[]): string[] =>
    values.reduce<string[]>((acc, v) => joinStrings(acc, v.type === 'Text' ? [String(v.data)] : v.type === 'ExpressionTag' ? strings(read(v.expression as Node)) : [HIDDEN]), ['']);
  /** URLs that load (or, when `navigates`, only open) a resource. */
  const checkUrls = (urls: string[], navigates: boolean, node: Node) => {
    if (urls.some((u) => SCRIPT_URL.test(u))) forbid('script URLs', node);
    else if (!navigates && urls.some((u) => REMOTE_URL.test(u))) forbid('remote content (use an image from the project)', node);
  };
  const checkCss = (texts: string[], node: Node) => {
    if (texts.some((t) => CSS_REMOTE.test(t))) forbid('remote stylesheets or images in CSS', node);
  };
  const splitSrcset = (urls: string[]) => urls.flatMap((u) => u.split(',').map((c) => c.trim()));

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
        // el.setAttribute('src', url) and el.style.setProperty('background', css) reach the same places as markup.
        if (strict && callee.type === 'MemberExpression') {
          const method = nameOf(callee.property as Node, callee.computed);
          const name = literalText(args[0])?.toLowerCase();
          if (method === 'setAttribute' && name && URL_ATTRS.has(name)) {
            const urls = strings(read(args[1]));
            checkUrls(name === 'srcset' ? splitSrcset(urls) : urls, NAVIGATING_ATTRS.has(name), n);
          } else if (method === 'setAttribute' && name === 'style') checkCss(strings(read(args[1])), n);
          else if (method === 'setProperty' && isStyleObject(callee.object as Node)) checkCss(strings(read(args[1])), n);
        }
        break;
      }
      case 'AssignmentExpression': {
        // img.src = url, el.style.backgroundImage = css (an element reached through bind:this).
        const left = n.left as Node;
        if (!strict || left.type !== 'MemberExpression') break;
        const prop = nameOf(left.property as Node, left.computed);
        if (prop && DOM_URL_PROPS.has(prop)) {
          const urls = strings(read(n.right as Node));
          checkUrls(prop === 'srcset' ? splitSrcset(urls) : urls, prop === 'href', n);
        } else if (prop === 'cssText' || isStyleObject(left.object as Node)) checkCss(strings(read(n.right as Node)), n);
        break;
      }
      case 'MemberExpression': {
        const obj = n.object as Node;
        const propName = nameOf(n.property as Node, n.computed);
        // [].constructor.constructor('…') reaches Function without naming it.
        if (propName === 'constructor' && obj.type === 'MemberExpression' && nameOf(obj.property as Node, obj.computed) === 'constructor') add('error', 'eval and Function are not allowed.', n);
        const onGlobal = obj.type === 'Identifier' && GLOBAL_OBJECTS.has(obj.name as string);
        // window.eval and globalThis.Function are eval and Function under another name.
        if (onGlobal && (propName === 'eval' || propName === 'Function')) add('error', 'eval and Function are not allowed.', n);
        if (strict && onGlobal && propName && LOADERS.has(propName)) forbid('network requests', n);
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
      case 'StyleDirective': {
        const values = n.value === true ? [] : Array.isArray(n.value) ? (n.value as Node[]) : [n.value as Node];
        if (strict) checkCss(valueStrings(values), n);
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
        const host = parent?.type === 'RegularElement' ? String(parent.name) : parent?.type === 'SvelteElement' ? (typeof parent.tag === 'string' ? parent.tag : String((parent.tag as Node)?.value ?? '')) : '';
        const navigates = attr === 'href' && ['a', 'area'].includes(host.toLowerCase());
        if (attr.startsWith('on') && texts.some((t) => t !== null)) forbid('event handlers written as text', n);
        // Every value the attribute may take counts, including URLs held in variables, arrays and objects.
        const full = valueStrings(values);
        // srcset lists several URLs; each one counts.
        if (URL_ATTRS.has(attr)) checkUrls(attr === 'srcset' ? splitSrcset(full) : full, navigates, n);
        if (attr === 'style') checkCss(full, n);
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

  // A project component the assistant imports runs as part of its code, so it is held to the same policy.
  for (const { spec, path, node } of siblings) {
    const errors = await siblingErrors(path, opts, reach);
    const refuse = (why: string) => add('error', `Code written by the assistant may not import "${spec}", ${why}.`, node);
    if (errors === null) refuse(opts.resolve ? 'which is not a component in this project' : 'because that component cannot be checked here');
    else if (errors[0]) {
      const reason = errors[0].message.match(/^Code written by the assistant may not use (.*)\.$/)?.[1];
      refuse(`which ${reason ? `uses ${reason}` : `has a problem: ${errors[0].message.replace(/\.$/, '')}`}${errors[0].line ? ` (line ${errors[0].line})` : ''}`);
    }
  }
  return problems;
}

/** The text of a string literal or a template literal without expressions; null for anything computed. */
function literalText(n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && (n.expressions as Node[]).length === 0) return String(((n.quasis as Node[])[0]?.value as { cooked?: string })?.cooked ?? '');
  return null;
}

/** `el.style` or `document.body.style`: the object whose properties are CSS. */
function isStyleObject(n: Node | undefined): boolean {
  return n?.type === 'MemberExpression' && nameOf(n.property as Node, n.computed) === 'style';
}

// ---------------------------------------------------------------------------
// What a value may be
// ---------------------------------------------------------------------------

/**
 * A value as far as the code shows it: a string, an array or object written out in the code, or unknown
 * (a prop, a function's result). Unknown values are allowed: the check judges only what the code itself spells out.
 */
type Val = { kind: 'str'; s: string } | { kind: 'arr'; items: () => Val[] } | { kind: 'obj'; get: (key: string | null) => Val[] } | { kind: 'unknown' };
/** Where a name's value comes from: an expression, a function, a property or an element of another source. */
type Src = { expr: Node } | { fn: Node } | { member: Src; key: string | null } | { element: Src } | 'unknown';

const UNKNOWN: Val = { kind: 'unknown' };
/** Stands for text the code does not show, so a URL is judged only by the part that is written out. */
const HIDDEN = '\u0001';
/** Values followed per expression; enough for any real component, and a bound on contrived ones. */
const MAX_VALUES = 64;
const MAX_DEPTH = 12;
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const SKIP_KEYS = new Set(['type', 'loc', 'metadata', 'parent', 'start', 'end']);
/** Array methods whose callback's first parameter is an element of the array. */
const ELEMENT_CALLBACKS = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'findLast', 'findIndex', 'some', 'every', 'reduce']);
/** Methods that return (part of) the same array, or one of its elements. */
const SAME_ARRAY = new Set(['filter', 'slice', 'toSorted', 'toReversed', 'reverse', 'sort', 'toSpliced', 'flat']);
const ONE_ELEMENT = new Set(['find', 'findLast', 'at', 'pop', 'shift', 'join']);
/** Calls that return their argument, or a string much like it. */
const PASS_THROUGH = new Set(['$state', '$derived', 'String', 'encodeURI', 'decodeURI', 'structuredClone']);
const STRING_METHODS = new Set(['trim', 'trimStart', 'trimEnd', 'toString', 'toLowerCase', 'toUpperCase', 'valueOf', 'normalize', 'concat']);

const strings = (vals: Val[]): string[] => vals.map((v) => (v.kind === 'str' ? v.s : HIDDEN));
const joinStrings = (a: string[], b: string[]): string[] => a.flatMap((x) => b.map((y) => x + y)).slice(0, MAX_VALUES);
const capped = (vals: Val[]) => vals.slice(0, MAX_VALUES);

function walk(node: unknown, visit: (n: Node) => void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as Node;
  if (typeof n.type !== 'string') return;
  visit(n);
  for (const k of Object.keys(n)) if (!SKIP_KEYS.has(k)) walk(n[k], visit);
}

/** Every place a name is given a value, by name: scopes are merged, so a name reused for a remote URL counts everywhere. */
function collectBindings(roots: unknown[]): Map<string, Src[]> {
  const bindings = new Map<string, Src[]>();
  const add = (name: string, src: Src) => {
    const list = bindings.get(name);
    if (!list) bindings.set(name, [src]);
    else if (list.length < MAX_VALUES) list.push(src);
  };
  const bind = (pattern: Node | null | undefined, src: Src) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') add(pattern.name as string, src);
    else if (pattern.type === 'ObjectPattern')
      for (const p of pattern.properties as Node[]) bind(p.type === 'RestElement' ? (p.argument as Node) : (p.value as Node), p.type === 'RestElement' ? src : { member: src, key: nameOf(p.key as Node, p.computed) });
    else if (pattern.type === 'ArrayPattern')
      for (const el of pattern.elements as Array<Node | null>) bind(el?.type === 'RestElement' ? (el.argument as Node) : el, el?.type === 'RestElement' ? src : { element: src });
    else if (pattern.type === 'AssignmentPattern') {
      bind(pattern.left as Node, src);
      bind(pattern.left as Node, { expr: pattern.right as Node });
    } else if (pattern.type === 'RestElement') bind(pattern.argument as Node, src);
  };
  walk(roots, (n) => {
    if (n.type === 'VariableDeclarator') bind(n.id as Node, n.init ? { expr: n.init as Node } : 'unknown');
    else if (n.type === 'AssignmentExpression' && ['=', '+=', '||=', '??='].includes(String(n.operator))) bind(n.left as Node, { expr: n.right as Node });
    else if (n.type === 'FunctionDeclaration' && n.id) add(String((n.id as Node).name), { fn: n });
    else if (n.type === 'EachBlock') bind(n.context as Node, { element: { expr: n.expression as Node } });
    else if (n.type === 'CallExpression') {
      // items.map((item) => …): the callback's first parameter is an element of the array (reduce's second).
      const callee = n.callee as Node;
      const method = callee.type === 'MemberExpression' ? nameOf(callee.property as Node, callee.computed) : null;
      const fn = (n.arguments as Node[])[0];
      if (method && ELEMENT_CALLBACKS.has(method) && fn && FUNCTION_TYPES.has(fn.type)) bind((fn.params as Node[])[method === 'reduce' ? 1 : 0], { element: { expr: callee.object as Node } });
    }
  });
  return bindings;
}

/** The expressions a function may return, not counting functions nested inside it. */
function returnsOf(fn: Node): Node[] {
  const body = fn.body as Node | undefined;
  if (!body) return [];
  if (body.type !== 'BlockStatement') return [body];
  const out: Node[] = [];
  const go = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(go);
    const n = node as Node;
    if (typeof n.type !== 'string' || FUNCTION_TYPES.has(n.type)) return;
    if (n.type === 'ReturnStatement') {
      if (n.argument) out.push(n.argument as Node);
      return;
    }
    for (const k of Object.keys(n)) if (!SKIP_KEYS.has(k)) go(n[k]);
  };
  go(body);
  return out;
}

/** Reads what an expression may evaluate to, following names to where they are given values. */
function valueReader(bindings: Map<string, Src[]>): (n: Node | undefined) => Val[] {
  const memo = new Map<string, Val[]>();
  const active = new Set<string>();
  const prop = (v: Val, key: string | null): Val[] =>
    v.kind === 'obj' ? v.get(key) : v.kind === 'arr' ? (key === null || /^\d+$/.test(key) ? v.items() : [UNKNOWN]) : v.kind === 'str' && key === 'href' ? [v] : [UNKNOWN];
  const elements = (v: Val): Val[] => (v.kind === 'arr' ? v.items() : [UNKNOWN]);
  const fromSrc = (src: Src, depth: number): Val[] =>
    src === 'unknown' || 'fn' in src
      ? [UNKNOWN]
      : 'expr' in src
        ? evaluate(src.expr, depth)
        : 'member' in src
          ? capped(fromSrc(src.member, depth + 1).flatMap((v) => prop(v, src.key)))
          : capped(fromSrc(src.element, depth + 1).flatMap(elements));
  /** The functions an expression names: written in place, or declared or assigned to a name. */
  const functionsOf = (n: Node | undefined): Node[] =>
    !n
      ? []
      : FUNCTION_TYPES.has(n.type)
        ? [n]
        : n.type === 'Identifier'
          ? (bindings.get(n.name as string) ?? []).flatMap((s) => (s === 'unknown' ? [] : 'fn' in s ? [s.fn] : 'expr' in s && FUNCTION_TYPES.has(s.expr.type) ? [s.expr] : []))
          : [];
  const returned = (fn: Node | undefined, depth: number): Val[] => {
    const fns = functionsOf(fn);
    const key = fn?.type === 'Identifier' ? `call:${fn.name}` : null;
    if (!fns.length || (key && active.has(key))) return [UNKNOWN];
    if (key) active.add(key);
    try {
      return capped(fns.flatMap((f) => returnsOf(f).flatMap((r) => evaluate(r, depth))));
    } finally {
      if (key) active.delete(key);
    }
  };
  const evaluate = (n: Node | undefined, depth: number): Val[] => {
    if (!n || depth > MAX_DEPTH) return [UNKNOWN];
    const d = depth + 1;
    switch (n.type) {
      case 'Literal':
        return n.value === null || ['string', 'number', 'boolean'].includes(typeof n.value) ? [{ kind: 'str', s: String(n.value) }] : [UNKNOWN];
      case 'TemplateLiteral': {
        const exprs = n.expressions as Node[];
        let out = [''];
        (n.quasis as Node[]).forEach((q, i) => {
          out = joinStrings(out, [String((q.value as { cooked?: string }).cooked ?? '')]);
          if (exprs[i]) out = joinStrings(out, strings(evaluate(exprs[i], d)));
        });
        return out.map((s) => ({ kind: 'str', s }));
      }
      case 'BinaryExpression':
        return n.operator === '+' ? joinStrings(strings(evaluate(n.left as Node, d)), strings(evaluate(n.right as Node, d))).map((s) => ({ kind: 'str', s })) : [UNKNOWN];
      case 'ConditionalExpression':
        return capped([...evaluate(n.consequent as Node, d), ...evaluate(n.alternate as Node, d)]);
      case 'LogicalExpression':
        return capped([...evaluate(n.left as Node, d), ...evaluate(n.right as Node, d)]);
      case 'SequenceExpression':
        return evaluate((n.expressions as Node[]).at(-1), d);
      case 'AssignmentExpression':
        return evaluate(n.right as Node, d);
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'ParenthesizedExpression':
      case 'ChainExpression':
      case 'AwaitExpression':
        return evaluate((n.expression ?? n.argument) as Node, d);
      case 'ArrayExpression':
        return [{ kind: 'arr', items: () => capped((n.elements as Array<Node | null>).flatMap((el) => (!el ? [] : el.type === 'SpreadElement' ? evaluate(el.argument as Node, d).flatMap(elements) : evaluate(el, d)))) }];
      case 'ObjectExpression':
        return [
          {
            kind: 'obj',
            get: (key) => {
              const out: Val[] = [];
              for (const p of n.properties as Node[]) {
                if (p.type === 'SpreadElement') out.push(...evaluate(p.argument as Node, d).flatMap((v) => prop(v, key)));
                else {
                  const k = nameOf(p.key as Node, p.computed);
                  if (key === null || k === null || k === key) out.push(...(p.kind === 'init' && !p.method ? evaluate(p.value as Node, d) : [UNKNOWN]));
                }
              }
              return out.length ? capped(out) : [UNKNOWN];
            }
          }
        ];
      case 'Identifier': {
        const name = n.name as string;
        const known = memo.get(name);
        if (known) return known;
        const srcs = bindings.get(name);
        if (!srcs || active.has(name)) return [UNKNOWN];
        active.add(name);
        try {
          const out = capped(srcs.flatMap((src) => fromSrc(src, d)));
          memo.set(name, out);
          return out;
        } finally {
          active.delete(name);
        }
      }
      case 'MemberExpression':
        return capped(evaluate(n.object as Node, d).flatMap((v) => prop(v, nameOf(n.property as Node, n.computed))));
      case 'NewExpression':
        // new URL(path, base) is the base, or the path when that is a full URL.
        return (n.callee as Node).type === 'Identifier' && (n.callee as Node).name === 'URL' ? capped((n.arguments as Node[]).flatMap((a) => evaluate(a, d))) : [UNKNOWN];
      case 'CallExpression': {
        const callee = n.callee as Node;
        const args = n.arguments as Node[];
        if (callee.type === 'Identifier') return PASS_THROUGH.has(callee.name as string) ? evaluate(args[0], d) : returned(callee, d);
        if (FUNCTION_TYPES.has(callee.type)) return returned(callee, d);
        if (callee.type !== 'MemberExpression') return [UNKNOWN];
        const method = nameOf(callee.property as Node, callee.computed);
        const obj = callee.object as Node;
        // $state.raw(x), $derived.by(() => x)
        if (obj.type === 'Identifier' && (obj.name === '$state' || obj.name === '$derived')) return method === 'by' ? returned(args[0], d) : evaluate(args[0], d);
        if (method === 'map' || method === 'flatMap') return [{ kind: 'arr', items: () => returned(args[0], d) }];
        const base = evaluate(obj, d);
        if (method && SAME_ARRAY.has(method)) return base;
        if (method && ONE_ELEMENT.has(method)) return capped(base.flatMap((v) => (v.kind === 'arr' ? v.items() : [v])));
        if (method && STRING_METHODS.has(method)) return capped([...base, ...args.flatMap((a) => evaluate(a, d))]);
        return [UNKNOWN];
      }
      default:
        return [UNKNOWN];
    }
  };
  return (n) => evaluate(n, 0);
}
