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
import { slotIdent } from '@generator/index';

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
/** Attributes whose URL only opens a page (on a link). */
const OPENING_ATTRS = new Set(['href', 'xlink:href', 'cite']);
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
  /** Who wrote code held to the strict policy, as its messages name them. Defaults to the assistant. */
  author?: string;
  /**
   * Files strict code may import besides project code components and the runtime helpers: the exact files the app
   * generates for the project's own designs (`src/lib/siteorigin/generated/…`), which no one hand-writes.
   */
  generated?: (path: string) => boolean;
  /**
   * The project files that exist, when every import of one must name a file that does: an import of anything else in
   * the project is refused, as compiling a component alone never notices it is missing.
   */
  modules?: (path: string) => boolean;
  /**
   * The code component's contract, when its slots and parts are checked against its code: every declared slot is
   * rendered from the snippet its placements pass (`slot_<name>`), and every part marked `data-so-part` is declared.
   */
  contract?: Pick<ComponentDefinition, 'slots' | 'parts'>;
}

/** The props a component passes on to places that load a URL, apply CSS or open a link. */
interface PropSinks {
  load: Set<string>;
  css: Set<string>;
  nav: Set<string>;
}
const noSinks = (): PropSinks => ({ load: new Set(), css: new Set(), nav: new Set() });

/** A project component as the strict check found it. */
interface Checked {
  errors: CodeProblem[];
  sinks: PropSinks;
}

/** Components already checked during one check, and those whose check is under way (an import cycle). */
interface Reach {
  visiting: Set<string>;
  done: Map<string, Checked>;
}

export async function checkSvelteSource(source: string, opts: CheckOptions = {}): Promise<CodeProblem[]> {
  return (await check(source, opts, { visiting: new Set(opts.filename ? [opts.filename] : []), done: new Map() })).problems;
}

/** The project component saved at `path`, checked once per top-level check; null when there is none. */
async function checkSibling(path: string, opts: CheckOptions, reach: Reach): Promise<Checked | null> {
  // A component already being checked further up an import cycle reports its own problems there.
  if (reach.visiting.has(path)) return { errors: [], sinks: noSinks() };
  const known = reach.done.get(path);
  if (known) return known;
  const source = opts.resolve?.(path);
  if (source === null || source === undefined) return null;
  reach.visiting.add(path);
  try {
    const r = await check(source, { strict: true, resolve: opts.resolve, author: opts.author, generated: opts.generated, modules: opts.modules }, reach);
    const checked = { errors: r.problems.filter((p) => p.severity === 'error'), sinks: r.sinks };
    reach.done.set(path, checked);
    return checked;
  } finally {
    reach.visiting.delete(path);
  }
}

async function check(source: string, opts: CheckOptions, reach: Reach): Promise<{ problems: CodeProblem[]; sinks: PropSinks }> {
  const strict = !!opts.strict;
  const problems: CodeProblem[] = [];
  const sinks = noSinks();
  if (source.length > 60_000) return { problems: [{ severity: 'error', message: 'This component is too large. Split it into smaller components.' }], sinks };
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
      return { problems, sinks };
    }
  }
  let ast: Node;
  try {
    ast = parse(source, { modern: true }) as unknown as Node;
  } catch (e) {
    return { problems: [...problems, { severity: 'error', message: (e as Error).message.split('\n')[0] }], sinks };
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
  const author = opts.author ?? 'Code written by the assistant';
  const forbid = (what: string, node: Node) => add('error', `${author} may not use ${what}.`, node);
  const generated = (spec: string) => {
    const p = resolveSpec(spec);
    return !!p && !!opts.generated?.(p);
  };
  const missing = (spec: string) => {
    const p = resolveSpec(spec);
    return !!p && !!opts.modules && !['', '.js', '.ts', '.svelte', '/index.js'].some((ext) => opts.modules!(`${p}${ext}`));
  };
  const checkSpec = (spec: unknown, node: Node) => {
    if (typeof spec !== 'string') return;
    if (!importAllowed(spec)) add('error', `"${spec}" is not available in this project. Use relative imports inside src/lib, $lib, svelte or $app modules only.`, node);
    else if (strict && !importAllowed(spec, true) && !generated(spec)) forbid(`"${spec}"`, node);
    else if (missing(spec)) add('error', `It imports "${spec}", which is not a file in this project.`, node);
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
  const body = (ast.instance as { content?: { body?: Node[] } } | null)?.content?.body ?? [];
  for (const st of body) if (st.type === 'ImportDeclaration') for (const sp of st.specifiers as Node[]) imported.add(String((sp.local as Node).name));

  // A project component the assistant imports runs as part of its code, so it is held to the same policy,
  // and what the assistant passes to its props is judged by where the component puts them.
  const componentSinks = new Map<string, PropSinks>();
  if (strict)
    for (const st of body) {
      const spec = st.type === 'ImportDeclaration' ? String((st.source as Node).value) : '';
      const path = spec && importAllowed(spec, true) ? resolveSpec(spec) : null;
      if (!path?.startsWith(`${COMPONENT_DIR}/`)) continue;
      const checked = await checkSibling(path, opts, reach);
      const refuse = (why: string) => add('error', `${author} may not import "${spec}", ${why}.`, st);
      if (checked === null) refuse(opts.resolve ? 'which is not a component in this project' : 'because that component cannot be checked here');
      else if (checked.errors[0]) {
        const first = checked.errors[0];
        const reason = first.message.startsWith(`${author} may not use `) ? first.message.slice(`${author} may not use `.length, -1) : undefined;
        refuse(`which ${reason ? `uses ${reason}` : `has a problem: ${first.message.replace(/\.$/, '')}`}${first.line ? ` (line ${first.line})` : ''}`);
      }
      if (checked) for (const sp of st.specifiers as Node[]) if (sp.type === 'ImportDefaultSpecifier') componentSinks.set(String((sp.local as Node).name), checked.sinks);
    }

  // What names in the code hold, so a URL kept in a variable is judged like one written in place.
  const bindings = collectBindings([ast.instance, ast.fragment]);
  const read = valueReader(bindings);
  /** The strings a value may be, and the component props it comes from. */
  type Seen = { strs: string[]; props: Set<string> };
  const expression = (n: Node | undefined, scope: Node[]): Seen => {
    const r = read(n, scope);
    return { strs: strings(r.vals), props: r.props };
  };
  /** Every string an attribute or style value may join to, as far as the code shows. */
  const fragments = (values: Node[], scope: Node[]): Seen => {
    let strs = [''];
    const props = new Set<string>();
    for (const v of values) {
      if (v.type === 'Text') strs = joinStrings(strs, [String(v.data)]);
      else if (v.type === 'ExpressionTag') {
        const r = expression(v.expression as Node, scope);
        r.props.forEach((p) => props.add(p));
        strs = joinStrings(strs, r.strs);
      } else strs = joinStrings(strs, [HIDDEN]);
    }
    return { strs, props };
  };
  /** URLs that load (or, when `navigates`, only open) a resource. Props that reach them are recorded for importers. */
  const checkUrls = (v: Seen, navigates: boolean, srcset: boolean, node: Node) => {
    v.props.forEach((p) => (navigates ? sinks.nav : sinks.load).add(p));
    const urls = srcset ? v.strs.flatMap((u) => u.split(',').map((c) => c.trim())) : v.strs;
    if (urls.some((u) => SCRIPT_URL.test(u))) forbid('script URLs', node);
    else if (!navigates && urls.some((u) => REMOTE_URL.test(u))) forbid('remote content (use an image from the project)', node);
  };
  const checkCss = (v: Seen, node: Node) => {
    v.props.forEach((p) => sinks.css.add(p));
    if (v.strs.some((t) => CSS_REMOTE.test(t))) forbid('remote stylesheets or images in CSS', node);
  };
  /** Does setting `attr` on this element (named by bind:this) only open a link? Unknown elements get the benefit of the doubt. */
  const opensOnly = (receiver: Node | undefined, attr: string) => {
    const tag = receiver?.type === 'Identifier' ? bindings.elements.get(receiver.name as string) : undefined;
    return attr === 'href' || attr === 'xlink:href' ? tag === undefined || tag === 'a' || tag === 'area' : attr === 'cite';
  };

  let browserWarned = false;
  /**
   * Visit every node. `deferred` counts enclosing functions and browser-only guards (code that does not
   * run while the page renders on the server); `key` is the property of `parent` holding this node; `scope`
   * lists the functions and each blocks it is inside, whose names it can see.
   */
  const visit = (node: unknown, deferred: number, parent: Node | null, key: string, scope: Node[]) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, deferred, parent, key, scope);
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
          if (method === 'setAttribute' && name && URL_ATTRS.has(name)) checkUrls(expression(args[1], scope), opensOnly(callee.object as Node, name), name === 'srcset', n);
          else if (method === 'setAttribute' && name === 'style') checkCss(expression(args[1], scope), n);
          else if (method === 'setProperty' && isStyleObject(callee.object as Node)) checkCss(expression(args[1], scope), n);
        }
        break;
      }
      case 'AssignmentExpression': {
        // img.src = url, el.style.backgroundImage = css (an element reached through bind:this).
        const left = n.left as Node;
        if (!strict || left.type !== 'MemberExpression') break;
        const prop = nameOf(left.property as Node, left.computed);
        // An SVG element's href is an object: image.href.baseVal = url sets it.
        const target = left.object as Node;
        const svgHref = prop === 'baseVal' && target.type === 'MemberExpression' && nameOf(target.property as Node, target.computed) === 'href';
        if (svgHref) checkUrls(expression(n.right as Node, scope), opensOnly(target.object as Node, 'href'), false, n);
        else if (prop && DOM_URL_PROPS.has(prop)) checkUrls(expression(n.right as Node, scope), opensOnly(left.object as Node, prop.toLowerCase()), prop === 'srcset', n);
        else if (prop === 'cssText' || isStyleObject(left.object as Node)) checkCss(expression(n.right as Node, scope), n);
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
        // style:background on its own reads the variable of that name.
        const values = n.value === true ? [{ type: 'ExpressionTag', expression: { type: 'Identifier', name: n.name } }] : Array.isArray(n.value) ? (n.value as Node[]) : [n.value as Node];
        if (strict) checkCss(fragments(values, scope), n);
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
        const full = fragments(values, scope);
        // A prop of an imported project component is judged by where that component puts it; any other
        // attribute by its name.
        const child = parent?.type === 'Component' ? componentSinks.get(String(parent.name)) : undefined;
        if (!child) {
          // srcset lists several URLs; each one counts.
          if (URL_ATTRS.has(attr)) checkUrls(full, navigates, attr === 'srcset', n);
          if (attr === 'style') checkCss(full, n);
        } else {
          const prop = String(n.name);
          const any = (set: Set<string>) => set.has(prop) || set.has('*');
          // The component may wrap a bare URL in url(…) itself, so one headed into its CSS loads too. A prop
          // named like a loading attribute counts as one whatever the component does with it, and any of them
          // may be a srcset list.
          if (any(child.load) || any(child.css) || (URL_ATTRS.has(attr) && !OPENING_ATTRS.has(attr))) checkUrls(full, false, true, n);
          if (any(child.css)) checkCss(full, n);
          if (any(child.nav)) checkUrls(full, true, false, n);
        }
        break;
      }
    }
    for (const k of Object.keys(n)) {
      if (SKIP_KEYS.has(k)) continue;
      visit(n[k], childDeferred + (guarded.has(k) ? 1 : 0), n, k, isScope(n, k) ? [...scope, n] : scope);
    }
  };
  visit(ast.instance, 0, null, 'instance', []);
  visit(ast.fragment, 0, null, 'fragment', []);
  if (opts.contract) for (const p of contractProblems(ast, source, opts.contract)) add(p.severity, p.message, p.node);
  return { problems, sinks };
}

/** What a part a code component's author marks may be called: a declared part's ID. */
const PART_ID = /^[a-z][A-Za-z0-9]{0,40}$/;

/** Every node of a parsed component with the nodes around it, outermost first. */
function walkAst(root: unknown, visit: (n: Node, around: Node[]) => void, around: Node[] = []): void {
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) {
    for (const child of root) walkAst(child, visit, around);
    return;
  }
  const n = root as Node;
  if (typeof n.type !== 'string') return;
  visit(n, around);
  const inner = [...around, n];
  for (const k of Object.keys(n)) if (!SKIP_KEYS.has(k)) walkAst(n[k], visit, inner);
}

/** The `data-so-part` attributes of a parsed component's markup, with the element or component each is on. */
function partMarkers(fragment: unknown): Array<{ attr: Node; host: Node }> {
  const out: Array<{ attr: Node; host: Node }> = [];
  walkAst(fragment, (n, around) => {
    const host = around[around.length - 1];
    if (n.type === 'Attribute' && n.name === 'data-so-part' && host && Array.isArray(host.attributes)) out.push({ attr: n, host });
  });
  return out;
}

/**
 * Where a code component's code breaks its contract: a declared slot it never renders, or renders in a way that fails
 * while its placement leaves it empty (the snippet is then not given, on the server as in the browser); a part it marks
 * under a name it does not declare, or by an expression the editor cannot read; a declared part it never marks, or
 * marks on an element that does not take the part's classes (so styles set in the editor cannot reach it).
 */
function contractProblems(ast: Node, source: string, contract: Pick<ComponentDefinition, 'slots' | 'parts'>): Array<{ severity: CodeProblem['severity']; message: string; node?: Node }> {
  const out: Array<{ severity: CodeProblem['severity']; message: string; node?: Node }> = [];
  const text = (n: Node) => source.slice(Number(n.start), Number(n.end));
  // The names the script takes from $props(), by prop: `let { slot_content: content } = $props()` renders `content`.
  const locals = new Map<string, string>();
  walkAst(ast.instance, (n) => {
    if (n.type !== 'VariableDeclarator' || (n.init as Node | null)?.type !== 'CallExpression') return;
    const callee = (n.init as Node).callee as Node;
    if (callee?.type !== 'Identifier' || callee.name !== '$props' || (n.id as Node)?.type !== 'ObjectPattern') return;
    for (const prop of ((n.id as Node).properties as Node[]) ?? []) {
      if (prop.type !== 'Property') continue;
      const key = prop.key as Node;
      const name = key.type === 'Identifier' ? String(key.name) : key.type === 'Literal' ? String(key.value) : null;
      let value = prop.value as Node;
      if (value?.type === 'AssignmentPattern') value = value.left as Node;
      if (name && value?.type === 'Identifier') locals.set(name, String(value.name));
    }
  });
  // Each snippet the markup renders, by the name it calls, with whether a call there can find it missing.
  const renders: Array<{ name: string; node: Node; safe: boolean }> = [];
  walkAst(ast.fragment, (n, around) => {
    if (n.type !== 'RenderTag') return;
    let call = n.expression as Node;
    const optional = call?.type === 'ChainExpression' || !!call?.optional;
    if (call?.type === 'ChainExpression') call = call.expression as Node;
    const callee = call?.type === 'CallExpression' ? (call.callee as Node) : undefined;
    if (callee?.type !== 'Identifier') return;
    const name = String(callee.name);
    // A plain call is safe only inside a block that shows it when the snippet is given ({#if slot_content}).
    const word = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}([^\\w$]|$)`);
    const guarded = around.some((a) => a.type === 'IfBlock' && word.test(text(a.test as Node)));
    renders.push({ name, node: n, safe: optional || guarded || !!(call as Node).optional });
  });
  const slots = contract.slots ?? {};
  for (const slot of Object.keys(slots)) {
    const label = typeof slots[slot]?.label === 'string' && slots[slot].label.trim() ? slots[slot].label.trim() : slot;
    const prop = slotIdent(slot);
    const local = locals.get(prop);
    const shown = renders.filter((r) => r.name === (local ?? prop));
    if (!shown.length) {
      out.push({ severity: 'warning', message: `The “${label}” slot is never shown: take ${prop} from $props() and render it with {@render ${local ?? prop}?.()}, or what is placed there will not show.` });
      continue;
    }
    if (!local) {
      out.push({ severity: 'error', message: `${prop} must be taken from $props() (let { ${prop} } = $props()) for the “${label}” slot to show what is placed there.`, node: shown[0].node });
      continue;
    }
    for (const r of shown) if (!r.safe) out.push({ severity: 'error', message: `Render the “${label}” slot with {@render ${local}?.()} or inside {#if ${local}}: a placement with nothing in it gives no snippet, and the page would fail to render.`, node: r.node });
  }
  const parts = contract.parts ?? {};
  const marked = new Set<string>();
  for (const { attr, host } of partMarkers(ast.fragment)) {
    const values = attr.value === true ? [] : Array.isArray(attr.value) ? (attr.value as Node[]) : [attr.value as Node];
    const literal = values.length === 1 ? (values[0].type === 'Text' ? String(values[0].data) : values[0].type === 'ExpressionTag' ? literalText(values[0].expression as Node) : null) : null;
    if (literal === null) {
      out.push({ severity: 'warning', message: 'Mark a part with its name written out (data-so-part="total"): the editor cannot tell which part an expression names.', node: attr });
      continue;
    }
    const id = literal.trim();
    if (id === 'root') {
      out.push({ severity: 'warning', message: 'The root part is the whole component: mark only the elements inside it with data-so-part.', node: attr });
      continue;
    }
    if (!Object.hasOwn(parts, id)) {
      out.push({ severity: PART_ID.test(id) ? 'warning' : 'error', message: PART_ID.test(id) ? `“${id}” is not one of the component's parts yet. Saving adds it.` : `Part names are camelCase words, such as "total" ("${id}").`, node: attr });
      continue;
    }
    marked.add(id);
    // Styles set in the editor reach a part through the class the placement gives it: so_o?.total, or so_o?.["total"].
    const cls = (host.attributes as Node[]).find((a) => a.type === 'Attribute' && a.name === 'class');
    const hook = new RegExp(`so_o\\s*(?:\\?\\.|\\.)?\\s*(?:${id}\\b|\\[\\s*(["'\`])${id}\\1\\s*\\])`);
    if (!cls || !hook.test(text(cls))) out.push({ severity: 'warning', message: `Give the element marked “${id}” the part's class (class={so_o?.${id}}), or styles set for it in the editor will not show.`, node: attr });
  }
  for (const id of Object.keys(parts)) if (id !== 'root' && !marked.has(id)) out.push({ severity: 'warning', message: `The “${parts[id]?.label ?? id}” part is not marked in the code: add data-so-part="${id}" to its element so it can be picked on the page.` });
  return out;
}

/**
 * A code component's source with every part marker (`data-so-part`) taken out, as the website's build ships it. The
 * markers are the editor's, written in the code so the preview can find each part; the published site carries none.
 * Source that cannot be parsed is returned as it is: it does not build either.
 */
export async function withoutPartMarkers(source: string): Promise<string> {
  if (!source.includes('data-so-part')) return source;
  const { parse } = await import('svelte/compiler');
  let ast: Node;
  try {
    ast = parse(source, { modern: true }) as unknown as Node;
  } catch {
    return source;
  }
  const cuts = partMarkers(ast.fragment)
    .map(({ attr }) => {
      // With the space before it, so the tag reads as if the attribute was never written.
      let start = Number(attr.start);
      while (start > 0 && /\s/.test(source[start - 1])) start--;
      return { start, end: Number(attr.end) };
    })
    .sort((a, b) => b.start - a.start);
  let out = source;
  for (const c of cuts) out = out.slice(0, c.start) + out.slice(c.end);
  return out;
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
 * (a function's result, a prop). Unknown values are allowed: the check judges only what the code spells out.
 * Arrays and objects are read lazily, at the depth of whoever reads them.
 */
type Val =
  | { kind: 'str'; s: string }
  | { kind: 'arr'; items: (depth: number) => Val[]; at: (i: number, depth: number) => Val[] }
  | { kind: 'obj'; get: (key: string | null, depth: number) => Val[] }
  | { kind: 'unknown' };
/**
 * Where a name's value comes from: an expression (read in the scopes around it), a function (declared in the
 * scopes given), a property or an element of another source.
 */
type Src = { expr: Node; scope: Node[] } | { fn: Node; scope: Node[] } | { member: Src; key: string | null } | { element: Src; index?: number } | 'unknown';

interface Bindings {
  /** Names given values outside every function and each block. */
  names: Map<string, Src[]>;
  /** Names a function (its parameters and locals) or an each block (its items) gives values, seen only inside it. */
  scopes: Map<Node, Map<string, Src[]>>;
  /** Variables holding an element through bind:this, with the element's tag. */
  elements: Map<string, string>;
}

const UNKNOWN: Val = { kind: 'unknown' };
/** Stands for text the code does not show, so a URL is judged only by the part that is written out. */
const HIDDEN = '\u0001';
/** Values followed per expression; enough for any real component, and a bound on contrived ones. */
const MAX_VALUES = 64;
const MAX_DEPTH = 32;
/** Steps one value read may take before the rest of it counts as unknown. */
const MAX_STEPS = 20_000;
/** Values worth keeping past the cap: they may be, or hold, the remote URL the cap would otherwise hide. */
const SUSPICIOUS = /\/\/|script:|url\(|@import/i;
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const SKIP_KEYS = new Set(['type', 'loc', 'metadata', 'parent', 'start', 'end']);
/** Array methods whose callback's first parameter is an element of the array. */
const ELEMENT_CALLBACKS = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'findLast', 'findIndex', 'some', 'every', 'reduce']);
/** Methods that return some of the same array's elements, in an order the check does not follow. */
const SAME_ARRAY = new Set(['filter', 'slice', 'toSorted', 'toReversed', 'reverse', 'sort', 'toSpliced', 'flat', 'concat']);
const ONE_ELEMENT = new Set(['find', 'findLast', 'at', 'pop', 'shift', 'join']);
/** Calls that return their argument, or a string much like it. */
const PASS_THROUGH = new Set(['$state', '$derived', 'String', 'encodeURI', 'decodeURI', 'structuredClone']);
const STRING_METHODS = new Set(['trim', 'trimStart', 'trimEnd', 'toString', 'toLowerCase', 'toUpperCase', 'valueOf', 'normalize', 'concat']);

/** Text followed per value: a URL or a style is judged by far less, and joined values cannot grow without end. */
const MAX_TEXT = 1024;
const strings = (vals: Val[]): string[] => vals.map((v) => (v.kind === 'str' ? v.s : HIDDEN));
/** The first values, and every one past them that may matter (the step budget bounds how many there are). */
const keep = <T>(all: T[], matters: (v: T) => boolean): T[] => (all.length <= MAX_VALUES ? all : [...all.slice(0, MAX_VALUES), ...all.slice(MAX_VALUES).filter(matters)]);
/** Lists and objects are always kept: one of them may hold the remote URL. */
/** Each value once: the same list reached two ways is one list, however often a chain of names doubles it. */
function distinct(vals: Val[]): Val[] {
  const seen = new Set<unknown>();
  return vals.filter((v) => {
    const key = v.kind === 'str' ? `s:${v.s}` : v.kind === 'unknown' ? 'unknown' : v;
    return !seen.has(key) && !!seen.add(key);
  });
}
const capped = (vals: Val[]) => keep(distinct(vals), (v) => v.kind === 'arr' || v.kind === 'obj' || (v.kind === 'str' && SUSPICIOUS.test(v.s)));
/** At most MAX_VALUES strings, the ones that may matter first. */
function fewest(xs: string[]): string[] {
  const unique = [...new Set(xs)];
  return unique.length <= MAX_VALUES ? unique : [...unique.filter((v) => SUSPICIOUS.test(v)), ...unique.filter((v) => !SUSPICIOUS.test(v))].slice(0, MAX_VALUES);
}
/** Every way two values join (bounded: at most MAX_VALUES of each, and of the result, text clipped to MAX_TEXT). */
function joinStrings(a: string[], b: string[]): string[] {
  const out = new Set<string>();
  for (const x of fewest(a)) for (const y of fewest(b)) out.add(x.length >= MAX_TEXT ? x.slice(0, MAX_TEXT) : x + y.slice(0, MAX_TEXT - x.length));
  return fewest([...out]);
}
/** Scopes inside `scope` are those of functions and each blocks; a function's own scope covers its parameters and body. */
const isScope = (n: Node, key: string) => (FUNCTION_TYPES.has(n.type) && (key === 'params' || key === 'body')) || (n.type === 'EachBlock' && (key === 'body' || key === 'key'));

function lookupIn(b: Bindings, name: string, scope: Node[]): Src[] | undefined {
  for (let i = scope.length - 1; i >= 0; i--) {
    const own = b.scopes.get(scope[i])?.get(name);
    if (own) return own;
  }
  return b.names.get(name);
}
/** The function a binding holds, with the scopes it was written in. */
function functionOf(s: Src): { fn: Node; scope: Node[] } | null {
  if (s === 'unknown') return null;
  if ('fn' in s) return s;
  return 'expr' in s && FUNCTION_TYPES.has(s.expr.type) ? { fn: s.expr, scope: s.scope } : null;
}

/** Bind the names in a pattern to `src` in `into`; a default value is one more source. */
function bindPattern(into: Map<string, Src[]>, pattern: Node | null | undefined, src: Src, scope: Node[]) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    const list = into.get(pattern.name as string);
    if (!list) into.set(pattern.name as string, [src]);
    else if (list.length < MAX_VALUES) list.push(src);
  } else if (pattern.type === 'ObjectPattern')
    for (const p of pattern.properties as Node[]) bindPattern(into, p.type === 'RestElement' ? (p.argument as Node) : (p.value as Node), p.type === 'RestElement' ? src : { member: src, key: nameOf(p.key as Node, p.computed) }, scope);
  else if (pattern.type === 'ArrayPattern')
    (pattern.elements as Array<Node | null>).forEach((el, index) => bindPattern(into, el?.type === 'RestElement' ? (el.argument as Node) : el, el?.type === 'RestElement' ? src : { element: src, index }, scope));
  else if (pattern.type === 'AssignmentPattern') {
    bindPattern(into, pattern.left as Node, src, scope);
    bindPattern(into, pattern.left as Node, { expr: pattern.right as Node, scope }, scope);
  } else if (pattern.type === 'RestElement') bindPattern(into, pattern.argument as Node, src, scope);
}

/** A function's parameters as one call gives them: its arguments, or the defaults where it gives none. */
function callFrame(fn: Node, fnScope: Node[], args: Node[], callScope: Node[]): Map<string, Src[]> {
  const frame = new Map<string, Src[]>();
  const inner = [...fnScope, fn];
  (fn.params as Node[]).forEach((p, i) => {
    const arg = args[i];
    const given: Src = arg && arg.type !== 'SpreadElement' ? { expr: arg, scope: callScope } : 'unknown';
    // A default only applies when the argument is missing.
    if (p.type === 'AssignmentPattern' && !arg) bindPattern(frame, p.left as Node, { expr: p.right as Node, scope: inner }, inner);
    else bindPattern(frame, p.type === 'AssignmentPattern' ? (p.left as Node) : p, given, inner);
  });
  return frame;
}

function collectBindings(roots: unknown[]): Bindings {
  const b: Bindings = { names: new Map(), scopes: new Map(), elements: new Map() };
  const later: Array<{ n: Node; scope: Node[] }> = [];
  const own = (owner: Node | undefined) => {
    if (!owner) return b.names;
    let m = b.scopes.get(owner);
    if (!m) b.scopes.set(owner, (m = new Map()));
    return m;
  };
  const add = (into: Map<string, Src[]>, name: string, src: Src) => {
    const list = into.get(name);
    if (!list) into.set(name, [src]);
    else if (list.length < MAX_VALUES) list.push(src);
  };
  /** Bind the names in a pattern into `into`, or (into null) into wherever each name is declared. */
  const bind = (into: Map<string, Src[]> | null, pattern: Node | null | undefined, src: Src, scope: Node[]) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      const name = pattern.name as string;
      if (into) add(into, name, src);
      else {
        const declared = lookupIn(b, name, scope);
        if (declared) {
          if (declared.length < MAX_VALUES) declared.push(src);
        } else add(b.names, name, src);
      }
    } else if (pattern.type === 'ObjectPattern')
      for (const p of pattern.properties as Node[]) bind(into, p.type === 'RestElement' ? (p.argument as Node) : (p.value as Node), p.type === 'RestElement' ? src : { member: src, key: nameOf(p.key as Node, p.computed) }, scope);
    else if (pattern.type === 'ArrayPattern')
      (pattern.elements as Array<Node | null>).forEach((el, index) => bind(into, el?.type === 'RestElement' ? (el.argument as Node) : el, el?.type === 'RestElement' ? src : { element: src, index }, scope));
    else if (pattern.type === 'AssignmentPattern') {
      bind(into, pattern.left as Node, src, scope);
      bind(into, pattern.left as Node, { expr: pattern.right as Node, scope }, scope);
    } else if (pattern.type === 'RestElement') bind(into, pattern.argument as Node, src, scope);
  };
  /** The innermost function around a point: where its var, let and const declarations live. */
  const fnOwner = (scope: Node[]) => [...scope].reverse().find((s) => FUNCTION_TYPES.has(s.type));
  // First every declaration, so assignments and calls can find the binding they change.
  const go = (node: unknown, scope: Node[]) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) go(child, scope);
      return;
    }
    const n = node as Node;
    if (typeof n.type !== 'string') return;
    if (n.type === 'FunctionDeclaration' && n.id) add(own(fnOwner(scope)), String((n.id as Node).name), { fn: n, scope });
    if (FUNCTION_TYPES.has(n.type)) for (const p of n.params as Node[]) bind(own(n), p, 'unknown', [...scope, n]);
    else if (n.type === 'VariableDeclarator') bind(own(fnOwner(scope)), n.id as Node, n.init ? { expr: n.init as Node, scope } : 'unknown', scope);
    else if (n.type === 'EachBlock') bind(own(n), n.context as Node, { element: { expr: n.expression as Node, scope } }, scope);
    else if (n.type === 'AssignmentExpression' || n.type === 'CallExpression') later.push({ n, scope });
    else if (n.type === 'RegularElement' || n.type === 'SvelteElement') {
      const tag = n.type === 'RegularElement' ? String(n.name) : typeof n.tag === 'string' ? n.tag : String((n.tag as Node)?.value ?? '');
      for (const a of n.attributes as Node[]) if (a.type === 'BindDirective' && a.name === 'this' && (a.expression as Node)?.type === 'Identifier') b.elements.set(String((a.expression as Node).name), tag.toLowerCase());
    }
    for (const k of Object.keys(n)) if (!SKIP_KEYS.has(k)) go(n[k], isScope(n, k) ? [...scope, n] : scope);
  };
  go(roots, []);
  // Assignments first, wherever they are written, so a call reaches a function assigned further down.
  for (const { n, scope } of later)
    if (n.type === 'AssignmentExpression' && ['=', '+=', '||=', '??='].includes(String(n.operator))) bind(null, n.left as Node, { expr: n.right as Node, scope }, scope);
  for (const { n, scope } of later) {
    if (n.type !== 'CallExpression') continue;
    const callee = n.callee as Node;
    const args = n.arguments as Node[];
    // items.map((item) => …) or items.forEach(show): the callback's first parameter is an element of the
    // array (reduce's second).
    const method = callee.type === 'MemberExpression' ? nameOf(callee.property as Node, callee.computed) : null;
    if (method && ELEMENT_CALLBACKS.has(method) && args[0]) {
      const callbacks = FUNCTION_TYPES.has(args[0].type) ? [{ fn: args[0], scope }] : args[0].type === 'Identifier' ? (lookupIn(b, args[0].name as string, scope) ?? []).map(functionOf) : [];
      for (const cb of callbacks) if (cb) bind(own(cb.fn), (cb.fn.params as Node[])[method === 'reduce' ? 1 : 0], { element: { expr: callee.object as Node, scope } }, [...cb.scope, cb.fn]);
    }
    // What a local function is called with is what its parameters hold, for code inside it.
    const targets = callee.type === 'Identifier' ? (lookupIn(b, callee.name as string, scope) ?? []).map(functionOf) : FUNCTION_TYPES.has(callee.type) ? [{ fn: callee, scope }] : [];
    for (const t of targets) {
      if (!t) continue;
      args.forEach((arg, i) => {
        if (arg.type !== 'SpreadElement') bind(own(t.fn), (t.fn.params as Node[])[i], { expr: arg, scope }, [...t.scope, t.fn]);
      });
    }
  }
  return b;
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

/**
 * Reads what an expression may evaluate to, following names to where they are given values, and which of the
 * component's props it comes from. Every read is bounded: a cycle, a very deep chain or a very large value
 * stops being followed and counts as unknown, and only reads that were followed to the end are remembered.
 */
function valueReader(b: Bindings): (n: Node | undefined, scope: Node[]) => { vals: Val[]; props: Set<string> } {
  const memo = new Map<Src[], { vals: Val[]; props: Set<string> }>();
  const active = new Set<unknown>();
  /** The calls being followed: inside each, the function's parameters are that call's arguments. */
  const frames = new Map<Node, Array<Map<string, Src[]>>>();
  /** Where a name is bound from this point; `local` when that depends on the call being followed. */
  const find = (name: string, scope: Node[]): { srcs: Src[]; local: boolean } | undefined => {
    for (let i = scope.length - 1; i >= 0; i--) {
      const calls = frames.get(scope[i]);
      const frame = calls?.[calls.length - 1]?.get(name);
      if (frame) return { srcs: frame, local: true };
      const own = b.scopes.get(scope[i])?.get(name);
      // Anything read inside a function whose call is being followed may depend on that call's arguments.
      if (own) return { srcs: own, local: scope.some((s) => !!frames.get(s)?.length) };
    }
    const global = b.names.get(name);
    return global && { srcs: global, local: false };
  };
  let steps = 0;
  let truncated = false;
  let touched = new Set<string>();
  const cut = (): Val[] => ((truncated = true), [UNKNOWN]);
  /** Evaluate `f` unless `key` is already being evaluated (a value defined in terms of itself). */
  const once = (key: unknown, f: () => Val[]): Val[] => {
    if (active.has(key)) return cut();
    active.add(key);
    try {
      return f();
    } finally {
      active.delete(key);
    }
  };
  const prop = (v: Val, key: string | null, d: number): Val[] =>
    v.kind === 'obj' ? v.get(key, d) : v.kind === 'arr' ? (key === null ? v.items(d) : /^\d+$/.test(key) ? v.at(Number(key), d) : [UNKNOWN]) : v.kind === 'str' && key === 'href' ? [v] : [UNKNOWN];
  const elementsOf = (v: Val, d: number, index?: number): Val[] => (v.kind !== 'arr' ? [UNKNOWN] : index === undefined ? v.items(d) : v.at(index, d));
  /** The same elements, with positions no longer known. */
  const unordered = (vals: Val[]): Val[] => vals.map((v) => (v.kind === 'arr' ? { kind: 'arr', items: v.items, at: (_i, d) => v.items(d) } : v));
  const fromSrc = (src: Src, depth: number): Val[] =>
    src === 'unknown' || 'fn' in src
      ? [UNKNOWN]
      : 'expr' in src
        ? evaluate(src.expr, depth, src.scope)
        : 'member' in src
          ? capped(fromSrc(src.member, depth + 1).flatMap((v) => prop(v, src.key, depth + 1)))
          : capped(fromSrc(src.element, depth + 1).flatMap((v) => elementsOf(v, depth + 1, src.index)));
  /**
   * What the functions an expression names may return, read in the scopes they were written in. Given the
   * call's arguments, the parameters are those arguments alone, not every call's.
   */
  const returned = (fn: Node | undefined, depth: number, scope: Node[], args?: Node[]): Val[] => {
    const fns = !fn ? [] : FUNCTION_TYPES.has(fn.type) ? [{ fn, scope }] : fn.type === 'Identifier' ? (lookupIn(b, fn.name as string, scope) ?? []).map(functionOf).filter((f): f is { fn: Node; scope: Node[] } => !!f) : [];
    if (!fns.length) return [UNKNOWN];
    return capped(
      fns.flatMap((f) =>
        once(f.fn, () => {
          const calls = frames.get(f.fn) ?? [];
          if (args) frames.set(f.fn, [...calls, callFrame(f.fn, f.scope, args, scope)]);
          try {
            return returnsOf(f.fn).flatMap((r) => evaluate(r, depth, [...f.scope, f.fn]));
          } finally {
            if (args) frames.set(f.fn, calls);
          }
        })
      )
    );
  };
  const evaluate = (n: Node | undefined, depth: number, scope: Node[]): Val[] => {
    if (!n) return [UNKNOWN];
    if (depth > MAX_DEPTH || ++steps > MAX_STEPS) return cut();
    const d = depth + 1;
    switch (n.type) {
      case 'Literal':
        return n.value === null || ['string', 'number', 'boolean'].includes(typeof n.value) ? [{ kind: 'str', s: String(n.value).slice(0, MAX_TEXT) }] : [UNKNOWN];
      case 'TemplateLiteral': {
        const exprs = n.expressions as Node[];
        let out = [''];
        (n.quasis as Node[]).forEach((q, i) => {
          out = joinStrings(out, [String((q.value as { cooked?: string }).cooked ?? '')]);
          if (exprs[i]) out = joinStrings(out, strings(evaluate(exprs[i], d, scope)));
        });
        return out.map((s) => ({ kind: 'str', s }));
      }
      case 'BinaryExpression':
        return n.operator === '+' ? joinStrings(strings(evaluate(n.left as Node, d, scope)), strings(evaluate(n.right as Node, d, scope))).map((s) => ({ kind: 'str', s })) : [UNKNOWN];
      case 'ConditionalExpression':
        return capped([...evaluate(n.consequent as Node, d, scope), ...evaluate(n.alternate as Node, d, scope)]);
      case 'LogicalExpression':
        return capped([...evaluate(n.left as Node, d, scope), ...evaluate(n.right as Node, d, scope)]);
      case 'SequenceExpression':
        return evaluate((n.expressions as Node[]).at(-1), d, scope);
      case 'AssignmentExpression':
        return evaluate(n.right as Node, d, scope);
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'ParenthesizedExpression':
      case 'ChainExpression':
      case 'AwaitExpression':
        return evaluate((n.expression ?? n.argument) as Node, d, scope);
      case 'ArrayExpression': {
        const els = n.elements as Array<Node | null>;
        const one = (el: Node | null, at: number): Val[] => (!el ? [] : el.type === 'SpreadElement' ? evaluate(el.argument as Node, at, scope).flatMap((v) => elementsOf(v, at + 1)) : evaluate(el, at, scope));
        // Every element is read (the step budget bounds a huge list): a cap here could hide the one remote URL.
        const all = (at: number) => once(n, () => els.flatMap((el) => one(el, at)));
        return [
          {
            kind: 'arr',
            items: all,
            // A written-out position is that element alone, unless a spread before it shifts the positions.
            at: (i, at) => (els.slice(0, i + 1).some((e) => e?.type === 'SpreadElement') ? all(at) : els[i] ? once(n, () => evaluate(els[i]!, at, scope)) : [UNKNOWN])
          }
        ];
      }
      case 'ObjectExpression':
        return [
          {
            kind: 'obj',
            get: (key, at) =>
              once(n, () => {
                const out: Val[] = [];
                for (const p of n.properties as Node[]) {
                  if (p.type === 'SpreadElement') for (const v of evaluate(p.argument as Node, at, scope)) for (const w of prop(v, key, at + 1)) out.push(w);
                  else {
                    const k = nameOf(p.key as Node, p.computed);
                    if (key === null || k === null || k === key) for (const v of p.kind === 'init' && !p.method ? evaluate(p.value as Node, at, scope) : [UNKNOWN]) out.push(v);
                  }
                }
                return out.length ? capped(out) : [UNKNOWN];
              })
          }
        ];
      case 'Identifier': {
        const found = find(n.name as string, scope);
        if (!found) return [UNKNOWN];
        const { srcs, local } = found;
        // Inside a call being followed, a name may hold that call's arguments: never remembered across calls.
        const known = local ? undefined : memo.get(srcs);
        if (known) {
          known.props.forEach((p) => touched.add(p));
          return known.vals;
        }
        const [outerTruncated, outerTouched] = [truncated, touched];
        truncated = false;
        touched = new Set();
        const vals = once(srcs, () => capped(srcs.flatMap((src) => fromSrc(src, d))));
        const props = touched;
        if (!truncated && !local) memo.set(srcs, { vals, props });
        truncated ||= outerTruncated;
        touched = outerTouched;
        props.forEach((p) => touched.add(p));
        return vals;
      }
      case 'MemberExpression':
        return capped(evaluate(n.object as Node, d, scope).flatMap((v) => prop(v, nameOf(n.property as Node, n.computed), d)));
      case 'NewExpression':
        // new URL(path, base) is the base, or the path when that is a full URL.
        return (n.callee as Node).type === 'Identifier' && (n.callee as Node).name === 'URL' ? capped((n.arguments as Node[]).flatMap((a) => evaluate(a, d, scope))) : [UNKNOWN];
      case 'CallExpression': {
        const callee = n.callee as Node;
        const args = n.arguments as Node[];
        if (callee.type === 'Identifier') {
          const name = callee.name as string;
          // The component's props: whoever uses the component decides them.
          if (name === '$props')
            return [
              {
                kind: 'obj',
                get: (key) => {
                  touched.add(key ?? '*');
                  return [UNKNOWN];
                }
              }
            ];
          return PASS_THROUGH.has(name) ? evaluate(args[0], d, scope) : returned(callee, d, scope, args);
        }
        if (FUNCTION_TYPES.has(callee.type)) return returned(callee, d, scope, args);
        if (callee.type !== 'MemberExpression') return [UNKNOWN];
        const method = nameOf(callee.property as Node, callee.computed);
        const obj = callee.object as Node;
        // $state.raw(x), $derived.by(() => x)
        if (obj.type === 'Identifier' && (obj.name === '$state' || obj.name === '$derived')) return method === 'by' ? returned(args[0], d, scope) : evaluate(args[0], d, scope);
        if (method === 'map' || method === 'flatMap') {
          const all = (at: number) => returned(args[0], at, scope);
          return [{ kind: 'arr', items: all, at: (_i, at) => all(at) }];
        }
        const base = evaluate(obj, d, scope);
        // slice(start, end) with written-out bounds keeps positions, shifted by start.
        const bounds = method === 'slice' ? args.map((a) => (a.type === 'Literal' && Number.isInteger(a.value) && (a.value as number) >= 0 ? (a.value as number) : null)) : [];
        if (method === 'slice' && bounds.every((x) => x !== null)) {
          const [start = 0, end = Infinity] = bounds as number[];
          return base.map((v): Val => (v.kind === 'arr' ? { kind: 'arr', items: v.items, at: (i, at) => (start + i < end ? v.at(start + i, at) : []) } : v));
        }
        if (method && SAME_ARRAY.has(method) && base.some((v) => v.kind === 'arr'))
          return unordered(capped([...base, ...(method === 'concat' ? args.flatMap((a) => evaluate(a, d, scope).map((v) => (v.kind === 'arr' ? v : { kind: 'arr' as const, items: () => [v], at: () => [v] }))) : [])]));
        if (method && ONE_ELEMENT.has(method)) return capped(base.flatMap((v) => (v.kind === 'arr' ? v.items(d) : [v])));
        if (method && STRING_METHODS.has(method)) return capped([...base, ...args.flatMap((a) => evaluate(a, d, scope))]);
        return [UNKNOWN];
      }
      default:
        return [UNKNOWN];
    }
  };
  return (n, scope) => {
    steps = 0;
    truncated = false;
    touched = new Set();
    const vals = evaluate(n, 0, scope);
    return { vals, props: touched };
  };
}
