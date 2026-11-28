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
import type { ComponentDefinition, ProjectState } from '@shared/types';
import type { CodePropsTaken } from '@shared/api';
import { isCodeMarker, mentionsCodeMarker } from '@shared/code-markers';
import { CODE_TEXT_ATTR, CODE_TEXT_HOOK, codeTextField, parseCodeTextPath } from '@shared/code-text';
import { codeTakesBlocks, effectiveTokens, propKey, slotIdent } from '@generator/index';
import { getTheme } from '@catalogue/index';
import { axesOf } from '@shared/variants';
import { richTextToParagraphs, toRichText } from '@shared/richtext';
import { tokenVar, tokenVarNames } from '@shared/styles';
import { COPYRIGHT_PROP, copyrightYearParts } from '@shared/site-name';

export interface CodeProblem {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  column?: number;
}

/** Where project code components live; relative imports resolve from here and must stay inside src/lib. */
const COMPONENT_DIR = 'src/lib/siteorigin/custom';

const inLib = (p: string) => !p.includes('\0') && (p === 'src/lib' || p.startsWith('src/lib/'));
/** The site's own name for src/lib (`#lib`, `#lib/…`), which its package.json maps there as SvelteKit 3 has it. */
const LIB_ALIAS = /^#lib(?=$|[/?])/;
/** The alias SvelteKit 3 removed, spelled as its build refuses it (`$lib`, `$lib/…`, `$lib?…`). */
const REMOVED_LIB = /^\$lib(?:\/.*|\?.*)?$/;
/** The project path an import names, query and all, or null when it names no project file. */
const resolveSpec = (spec: string): string | null =>
  LIB_ALIAS.test(spec) ? posix.normalize(`src/lib${spec.slice(4)}`) : spec.startsWith('./') || spec.startsWith('../') ? posix.normalize(`${COMPONENT_DIR}/${spec}`) : null;
/** The import without its query or fragment (`./data.js?raw`), which never decides which file it is; `#lib` is no fragment. */
const withoutQuery = (spec: string): string => {
  const from = LIB_ALIAS.test(spec) ? 4 : 0;
  const cut = spec.slice(from).search(/[?#]/);
  return cut < 0 ? spec : spec.slice(0, from + cut);
};

/** The extensions Vite tries after a path without one and in a folder's index, as the site's build resolves them. */
const MODULE_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];
/** TypeScript's sources for a `.js` name (`./calc.js` is `calc.ts`), which Vite finds too. */
const TS_FOR_JS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.ts', '.tsx'] };

/** The files an import of the project path `p` may be, any of which the build would load. */
function moduleFiles(p: string): string[] {
  const ext = posix.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  // A component named without `.svelte` is found as it always was here; a folder's index never is one.
  return [p, ...[...MODULE_EXTENSIONS, '.svelte'].map((e) => p + e), ...MODULE_EXTENSIONS.map((e) => `${p}/index${e}`), ...(TS_FOR_JS[ext] ?? []).map((e) => stem + e)];
}

/** The authored source saved at each project path, so the strict check can follow imports between components. */
export function componentSources(components: Record<string, ComponentDefinition>): (path: string) => string | undefined {
  const byPath = new Map<string, string>();
  for (const def of Object.values(components)) if (def.kind === 'code' && def.sourcePath && def.source !== undefined) byPath.set(def.sourcePath, def.source);
  return (path) => byPath.get(path);
}

/** The `--so-…` variables a stylesheet sets. */
const declaredVars = (css: string): string[] => [...css.matchAll(/(?:^|[^\w-])(--so-[\w-]+)\s*:/g)].map((m) => m[1]);

/** The CSS variables a theme's tokens and base stylesheet define, for CheckOptions.tokens. */
export const themeTokenVars = (tokens: ReadonlyArray<{ id: string; group: string }>, baseCss: string): Set<string> => new Set([...tokenVarNames(tokens), ...declaredVars(baseCss)]);

/** The CSS variables a project's theme and own tokens define, for CheckOptions.tokens. */
export const projectTokenVars = (state: ProjectState): Set<string> => themeTokenVars(effectiveTokens(state), getTheme(state.site.themeId).baseCss);

/** An npm package name: `zod`, `chart.js`, `@scope/name`, and the capitals of an old one (`JSONStream`). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/**
 * The package a bare import names (`zod` for `zod`, `searchsocket` for `searchsocket/svelte`, `@scope/name` for
 * `@scope/name/sub`), or null when the import is no plain import of a package: a path, an alias (`#lib`, `$app`), a URL
 * or a Node.js builtin (`node:fs`), or a package path that climbs out of the package (`zod/../x`).
 */
export function packageOf(spec: string): string | null {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, n).join('/');
  if (parts.length < n || !PACKAGE_NAME.test(name)) return null;
  return parts.slice(n).some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0')) ? null : name;
}

/** The sections of a package.json whose packages npm installs into the project (the website tools include them all). */
export const PACKAGE_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/**
 * The packages a project's package.json declares, which its code components may import (see CheckOptions.packages):
 * only those it names itself, never one that is there only because another needs it.
 */
export function declaredPackages(packageJson: string | null | undefined): Set<string> {
  let pkg: unknown;
  try {
    pkg = packageJson ? JSON.parse(packageJson) : null;
  } catch {
    return new Set();
  }
  const names = new Set<string>();
  if (!pkg || typeof pkg !== 'object') return names;
  for (const field of PACKAGE_SECTIONS) {
    const deps = (pkg as Record<string, unknown>)[field];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) for (const name of Object.keys(deps)) if (PACKAGE_NAME.test(name)) names.add(name);
  }
  return names;
}

/**
 * Is this import specifier available to a project component? `packages` are the npm packages the project declares
 * (declaredPackages): a developer's code may import them, and their subpaths, but code held to the strict policy never.
 */
export function importAllowed(spec: string, strict = false, packages?: ReadonlySet<string>): boolean {
  if (spec === 'svelte' || spec.startsWith('svelte/')) return !strict || !spec.startsWith('svelte/compiler');
  if (spec.startsWith('$app/')) return strict ? ['$app/environment', '$app/state', '$app/navigation', '$app/paths'].includes(spec) : spec !== '$app/server';
  const pkg = packageOf(spec);
  if (pkg !== null) return !strict && !!packages?.has(pkg);
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
   * rendered from the snippet its placements pass (`slot_<name>`), every part marked `data-so-part` is declared, and
   * every text marker (`data-so-text`) is written through the placement's hook and names text the component declares.
   */
  contract?: CodeContract;
  /**
   * The component's manifest, when the props its code takes from $props() are checked against the properties it
   * declares (see manifestProblems): errors under the strict policy, warnings otherwise.
   */
  manifest?: CodeManifest;
  /**
   * The CSS variables the site's theme defines (`--so-color-brand`, see tokenVarNames). When given, every
   * `var(--so-…)` in the component's styles and markup that names none of them, nor a variable the component
   * sets itself or one the generated site sets (see RUNTIME_VARS), is reported with the nearest token as a
   * suggestion: an error in strict mode, a warning otherwise.
   */
  tokens?: ReadonlySet<string>;
  /**
   * The npm packages the project's package.json declares (declaredPackages). A developer's code may import them and
   * their subpaths (`searchsocket/svelte`); code held to the strict policy may import none.
   */
  packages?: ReadonlySet<string>;
}

/**
 * What of a code component's manifest its code is held to: the properties placements pass, and its axes' props.
 * `designFile` is for a design's generated file edited outside the app and converted (`generatedFrom`): its placements
 * pass each property under the key the design's file took it by (see the generator's propKey), with the props a
 * design's file takes for itself, so only a declared property the code no longer takes is reported.
 */
export type CodeManifest = Pick<ComponentDefinition, 'properties' | 'variantAxes'> & { designFile?: boolean };

/** A code component's contract as the code check holds its code to it (see contractProblems). */
export interface CodeContract {
  slots?: ComponentDefinition['slots'];
  parts?: ComponentDefinition['parts'];
  /** The declared slots that hold content in some placement: code that stops showing one would hide that content. */
  filled?: string[];
  /** The variant axes, each arriving in the property it names (`prop`), which the code must take from $props(). */
  variantAxes?: ComponentDefinition['variantAxes'];
  /** Its properties, which each text marker must name: without them, only how a marker is written is checked. */
  properties?: ComponentDefinition['properties'];
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

/**
 * The npm packages a component's code imports (`zod` for `import { z } from 'zod'`), however it imports them: an import
 * for its effects alone, a re-export, or `import()` of a fixed name. Svelte is no package here. Code the compiler cannot
 * read is looked through as text, so a broken draft still says which packages it uses.
 */
export async function importedPackages(source: string): Promise<string[]> {
  const specs: string[] = [];
  const { parse } = await import('svelte/compiler');
  try {
    const ast = parse(source, { modern: true }) as unknown as Node;
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      const node = n as Node;
      if (typeof node.type === 'string' && ['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type)) {
        const src = node.source as Node | null | undefined;
        if (src?.type === 'Literal' && typeof src.value === 'string') specs.push(src.value);
      }
      for (const [k, v] of Object.entries(node)) if (k !== 'parent' && v && typeof v === 'object') walk(v);
    };
    walk([ast.instance, ast.module, ast.fragment]);
  } catch {
    for (const m of source.matchAll(/\b(?:from|import)\s*\(?\s*(['"])([^'"\n]+)\1/g)) specs.push(m[2]);
  }
  const names = specs.filter((spec) => spec !== 'svelte' && !spec.startsWith('svelte/')).map(packageOf);
  return [...new Set(names.filter((n): n is string => n !== null))];
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
    const r = await check(source, { strict: true, resolve: opts.resolve, author: opts.author, generated: opts.generated, modules: opts.modules, tokens: opts.tokens, packages: opts.packages }, reach);
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
    // The file is the path before any query or fragment, which never decides which file it is; a query whose own
    // `..` would carry the path elsewhere names no file the other checks looked at.
    const p = resolveSpec(withoutQuery(spec));
    if (p && resolveSpec(spec)?.split(/[?#]/)[0] !== p) return !!opts.modules;
    return !!p && !!opts.modules && !moduleFiles(p).some((f) => opts.modules!(f));
  };
  const checkSpec = (spec: unknown, node: Node) => {
    if (typeof spec !== 'string') return;
    // The npm package it names; Svelte is one too, allowed as it always was (importAllowed).
    const pkg = spec === 'svelte' || spec.startsWith('svelte/') ? null : packageOf(spec);
    // SvelteKit 3's build stops at it, so it is refused here, with the spelling that works.
    if (REMOVED_LIB.test(spec)) add('error', `"$lib" was removed in SvelteKit 3. Use "#lib${spec.slice(4)}" instead.`, node);
    // The assistant's code never brings in a package, installed or not: what a package does is beyond these checks.
    else if (pkg !== null && strict) forbid(`npm packages ("${spec}")`, node);
    else if (pkg !== null && !opts.packages?.has(pkg))
      add('error', `${spec === pkg ? `"${spec}" is` : `"${spec}" is part of "${pkg}", which is`} not a package this project has. Add it under Packages in Project health, then import it.`, node);
    else if (!importAllowed(spec, false, opts.packages)) add('error', `"${spec}" is not available in this project. Use relative imports inside src/lib, #lib, svelte or $app modules, or a package the project has.`, node);
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
  if (opts.contract) for (const p of contractProblems(ast, opts.contract)) add(p.severity, p.message, p.node);
  if (opts.manifest) for (const p of manifestProblems(ast, opts.manifest, strict)) add(p.severity, p.message, p.node);
  if (opts.tokens) for (const p of unknownTokenProblems(source, opts.tokens, strict ? 'error' : 'warning')) add(p.severity, p.message, { type: 'Text', start: p.offset });
  return { problems, sinks };
}

/**
 * Variables the generated site sets itself, beside the theme's tokens: the colours drawn on a dark or brand section,
 * a button's colours, the header's measurements, a form's line colour and the pictures behind a section. A component
 * reads them with a fallback, so none of them are typos.
 */
const RUNTIME_VARS = /^--so-(?:surface-ink(?:-text|-hover)?|btn-(?:bg|fg)(?:-hover)?|header-(?:offset|notice)|form-line|bg-(?:image|size|position|repeat)|bgf-.+)$/;

/** Text with its comments blanked out (same length, so offsets still point into the source). */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

/** The edit distance between two names. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The defined variable closest to a name, when one is close enough to be what was meant. */
export function nearestVar(name: string, known: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const k of known) {
    const d = distance(name, k);
    if (d < bestDistance) (best = k), (bestDistance = d);
  }
  return best !== null && bestDistance <= Math.max(3, Math.ceil(Math.max(name.length, best.length) / 2)) ? best : null;
}

/**
 * Every `var(--so-…)` in the source (styles, inline styles and script strings alike) that names no variable the theme
 * defines. A fallback does not excuse one: `var(--so-color-primry, red)` renders red without a word. A variable the
 * component sets itself (`--so-gap: 1rem`, `style:--so-gap`, `setProperty('--so-gap', …)`) is its own to read.
 */
export function unknownTokenProblems(source: string, tokens: ReadonlySet<string>, severity: CodeProblem['severity']): Array<{ severity: CodeProblem['severity']; message: string; offset: number; line: number }> {
  const text = withoutComments(source);
  const own = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w-])(--so-[\w-]+)\s*:|style:(--so-[\w-]+)|setProperty\(\s*['"`](--so-[\w-]+)/g)) own.add(m[1] ?? m[2] ?? m[3]);
  const out: Array<{ severity: CodeProblem['severity']; message: string; offset: number; line: number }> = [];
  for (const m of text.matchAll(/var\(\s*(--so-[\w-]+)/gi)) {
    const name = m[1];
    if (tokens.has(name) || own.has(name) || RUNTIME_VARS.test(name)) continue;
    const near = nearestVar(name, [...tokens, ...own]);
    out.push({ severity, offset: m.index ?? 0, line: text.slice(0, m.index ?? 0).split('\n').length, message: `${name} is not a token of this theme.${near ? ` Did you mean ${near}?` : ''}` });
  }
  return out;
}

/** What a part a code component's author marks may be called: a declared part's ID. */
const PART_ID = /^[a-z][A-Za-z0-9]{0,39}$/;

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
 * The props a component's script takes from $props(), by prop name: the local it is read through, whether it has a
 * default written there, and whether that default is a fallback that is never missing: a function written in place,
 * or the name of a snippet the markup declares or a function the script declares (never a variable, which may hold
 * undefined). `let { slot_content: body = fallback } = $props()` reads slot_content through `body`.
 */
function propsLocals(ast: Node): Map<string, { local: string; defaulted: boolean; fallback: boolean }> {
  const callable = new Set<string>();
  walkAst(ast.fragment, (n) => {
    if (n.type === 'SnippetBlock' && (n.expression as Node)?.type === 'Identifier') callable.add(String((n.expression as Node).name));
  });
  for (const st of ((ast.instance as { content?: { body?: Node[] } } | null)?.content?.body ?? []) as Node[]) if (st.type === 'FunctionDeclaration' && (st.id as Node)?.type === 'Identifier') callable.add(String((st.id as Node).name));
  const locals = new Map<string, { local: string; defaulted: boolean; fallback: boolean }>();
  walkAst(ast.instance, (n) => {
    if (n.type !== 'VariableDeclarator' || (n.init as Node | null)?.type !== 'CallExpression') return;
    const callee = (n.init as Node).callee as Node;
    if (callee?.type !== 'Identifier' || callee.name !== '$props' || (n.id as Node)?.type !== 'ObjectPattern') return;
    for (const prop of ((n.id as Node).properties as Node[]) ?? []) {
      if (prop.type !== 'Property' || prop.computed) continue;
      const key = prop.key as Node;
      const name = key.type === 'Identifier' ? String(key.name) : key.type === 'Literal' ? String(key.value) : null;
      let value = prop.value as Node;
      let defaulted = false;
      let fallback = false;
      if (value?.type === 'AssignmentPattern') {
        const right = value.right as Node;
        defaulted = !(right?.type === 'Identifier' && right.name === 'undefined') && !(right?.type === 'Literal' && right.value === null);
        fallback = FUNCTION_TYPES.has(String(right?.type)) || (right?.type === 'Identifier' && callable.has(String(right.name)));
        value = value.left as Node;
      }
      if (name && value?.type === 'Identifier') locals.set(name, { local: String(value.name), defaulted, fallback });
    }
  });
  return locals;
}

/**
 * What the script reads of $props() taken as a whole object (`let props = $props()`) or of the rest of them
 * (`let { title, ...rest } = $props()`): the props it reads from that object by name (`props.tone`, `rest['tone']`),
 * and whether it also hands the object on (to a helper, a component, an element's attributes, which styles can match)
 * or reads it by a computed name, where any prop may be read.
 */
function wholePropsReads(ast: Node): { read: Set<string>; handed: boolean } {
  const whole = new Set<string>();
  const rests = new Set<string>();
  walkAst(ast.instance, (n) => {
    if (n.type !== 'VariableDeclarator' || (n.init as Node | null)?.type !== 'CallExpression') return;
    const callee = (n.init as Node).callee as Node;
    if (callee?.type !== 'Identifier' || callee.name !== '$props') return;
    const id = n.id as Node;
    if (id?.type === 'Identifier') whole.add(String(id.name));
    if (id?.type === 'ObjectPattern')
      for (const p of (id.properties as Node[]) ?? []) if (p.type === 'RestElement' && (p.argument as Node)?.type === 'Identifier') rests.add(String((p.argument as Node).name));
  });
  const read = new Set<string>();
  let handed = false;
  if (!whole.size && !rests.size) return { read, handed };
  const visit = (n: Node, around: Node[]) => {
    if (n.type !== 'Identifier' || !(whole.has(String(n.name)) || rests.has(String(n.name)))) return;
    const parent = around[around.length - 1];
    if (parent?.type === 'VariableDeclarator' && parent.id === n) return;
    if (parent?.type === 'RestElement') return;
    if (parent?.type === 'MemberExpression' && parent.object === n) {
      const p = parent.property as Node;
      const name = !parent.computed && p?.type === 'Identifier' ? String(p.name) : parent.computed && p?.type === 'Literal' && typeof p.value === 'string' ? p.value : null;
      if (name !== null) read.add(name);
      else handed = true;
      return;
    }
    handed = true;
  };
  walkAst(ast.instance, visit);
  walkAst(ast.fragment, visit);
  return { read, handed };
}

/**
 * Each variant axis whose property (`prop`) the code does not take from $props(): what placements choose there never
 * reaches the code. Taken by name in the destructuring, or read by name from the whole props object or the rest of
 * them, it is taken. When the code hands the object on (to a helper, say), it may be read there, which the check
 * cannot follow, so it only warns; rest taken and never used pass nothing on.
 */
function axisProblems(ast: Node, variantAxes: ComponentDefinition['variantAxes']): Array<{ severity: CodeProblem['severity']; message: string }> {
  const out: Array<{ severity: CodeProblem['severity']; message: string }> = [];
  const locals = propsLocals(ast);
  const whole = wholePropsReads(ast);
  for (const [axis, a] of axesOf({ variantAxes })) {
    if (typeof a.prop !== 'string' || locals.has(a.prop) || whole.read.has(a.prop)) continue;
    const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim() : axis;
    out.push(
      whole.handed
        ? { severity: 'warning', message: `The “${label}” variant arrives in ${a.prop}, which the code does not take from $props() by name: take it (let { ${a.prop} } = $props()) so the check can see the code reads it.` }
        : { severity: 'error', message: `The “${label}” variant arrives in ${a.prop}, which the code never takes from $props(): take it (let { ${a.prop} } = $props()), or what placements choose there will not show.` }
    );
  }
  return out;
}

/**
 * The variant axes of a code component whose property its code does not take from $props() (see axisProblems), for
 * a change of the axes alone: code that is unchanged passed every other check when it was saved. Null when the code
 * cannot be parsed.
 */
export async function codeAxisPropProblems(source: string, variantAxes: ComponentDefinition['variantAxes']): Promise<CodeProblem[] | null> {
  const { parse } = await import('svelte/compiler');
  try {
    return axisProblems(parse(source, { modern: true }) as unknown as Node, variantAxes);
  } catch {
    return null;
  }
}

/**
 * The props a placement passes a code component besides its declared properties (see the generator's emitInstance):
 * its part classes and root class, its anchor, its content, and what the site's page lists, eager images and forms
 * hand on, and in the editor's preview the hook its marked text is edited through. Its slots arrive as `slot_<name>` and
 * its axes in the props they name.
 */
const EDITOR_PROPS = new Set(['class', 'children', 'so_o', 'so_oi', 'so_id', 'so_webmcp', 'so_pages', 'so_eager', CODE_TEXT_HOOK]);

/** Each prop the script destructures from $props() by name, with the default written for it, if any. */
function propsTaken(ast: Node): Map<string, { node: Node; right?: Node }> {
  const out = new Map<string, { node: Node; right?: Node }>();
  walkAst(ast.instance, (n) => {
    if (n.type !== 'VariableDeclarator' || (n.init as Node | null)?.type !== 'CallExpression') return;
    const callee = (n.init as Node).callee as Node;
    if (callee?.type !== 'Identifier' || callee.name !== '$props' || (n.id as Node)?.type !== 'ObjectPattern') return;
    for (const prop of ((n.id as Node).properties as Node[]) ?? []) {
      if (prop.type !== 'Property' || prop.computed) continue;
      const key = prop.key as Node;
      const name = key.type === 'Identifier' ? String(key.name) : key.type === 'Literal' ? String(key.value) : null;
      const value = prop.value as Node;
      if (name !== null) out.set(name, { node: prop, ...(value?.type === 'AssignmentPattern' ? { right: value.right as Node } : {}) });
    }
  });
  return out;
}

/** A default written as a literal (a string, number, boolean, or an array or object of them); undefined otherwise. */
function literalValue(n: Node | undefined, depth = 0): { value: unknown } | undefined {
  if (!n || depth > 8) return undefined;
  if (n.type === 'Literal' && (typeof n.value === 'string' || typeof n.value === 'number' || typeof n.value === 'boolean' || n.value === null) && !n.regex) return { value: n.value };
  const text = literalText(n);
  if (text !== null) return { value: text };
  if (n.type === 'UnaryExpression' && n.operator === '-' && (n.argument as Node)?.type === 'Literal' && typeof (n.argument as Node).value === 'number') return { value: -((n.argument as Node).value as number) };
  if (n.type === 'ArrayExpression') {
    const items = ((n.elements as Array<Node | null>) ?? []).map((e) => (e ? literalValue(e, depth + 1) : undefined));
    return items.every((i) => i) ? { value: items.map((i) => i!.value) } : undefined;
  }
  if (n.type === 'ObjectExpression') {
    const out: Record<string, unknown> = {};
    for (const p of (n.properties as Node[]) ?? []) {
      if (p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method) return undefined;
      const k = p.key as Node;
      const key = k.type === 'Identifier' ? String(k.name) : k.type === 'Literal' ? String(k.value) : null;
      const v = literalValue(p.value as Node, depth + 1);
      if (key === null || !v) return undefined;
      out[key] = v.value;
    }
    return { value: out };
  }
  return undefined;
}

type PropDef = ComponentDefinition['properties'][string];
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A property's value as its code receives it (see the generator's resolveValue for code), or undefined when that
 * depends on the site it is placed in: a link or picture resolved against the project, a list worked out from its
 * pages or filled from the pages it links to, or a list or object holding any of those.
 */
function codeValue(schema: PropDef, value: unknown, depth = 0): { value: unknown } | undefined {
  if (!isRecord(schema) || value === undefined || depth > 4) return undefined;
  switch (schema.type) {
    case 'string':
    case 'enum':
    case 'icon':
    case 'choices':
    case 'table':
      return { value };
    case 'number':
      return typeof value === 'number' ? { value } : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? { value } : undefined;
    case 'richtext':
      return codeTakesBlocks(schema) ? undefined : { value: richTextToParagraphs(toRichText(value, schema.plainAs)) };
    case 'token':
      return isRecord(value) && typeof value.token === 'string' ? { value: `var(${tokenVar(value.token)})` } : undefined;
    case 'object': {
      if (!isRecord(value) || !isRecord(schema.fields)) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(schema.fields)) {
        const v = codeValue(f, Object.hasOwn(value, k) ? value[k] : f?.default, depth + 1);
        if (!v) return undefined;
        out[k] = v.value;
      }
      return { value: out };
    }
    case 'list': {
      if (schema.feed || schema.pageTeaser || !Array.isArray(value) || !isRecord(schema.fields)) return undefined;
      const items: unknown[] = [];
      for (const item of value) {
        if (!isRecord(item)) return undefined;
        const out: Record<string, unknown> = { id: item.id };
        for (const [k, f] of Object.entries(schema.fields)) {
          const v = codeValue(f, item[k] ?? f?.default, depth + 1);
          if (!v) return undefined;
          out[k] = v.value;
        }
        items.push(out);
      }
      return { value: items };
    }
    default:
      return undefined;
  }
}

/** A property's default as its code receives it (see codeValue); a copyright line that reads the year has none. */
function codeDefault(name: string, schema: PropDef): { value: unknown } | undefined {
  if (name === COPYRIGHT_PROP && typeof schema.default === 'string' && copyrightYearParts(schema.default)) return undefined;
  return codeValue(schema, schema.default);
}

/** Whether two literal values are the same, whatever order an object's keys are written in. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const short = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/**
 * Where a code component's code and its manifest disagree about its properties: a declared property the code never
 * takes from $props() (what placements set there never shows), a prop the code takes that no property declares (no
 * placement can set it), and a default written in the code that is not the manifest's (the inspector shows one, the
 * code the other). A prop counts as taken by name in the destructuring, under a rename (`title: heading`) too, or read
 * by name from the whole props object or the rest of them (`rest.title`). The editor's own props, the slots' and the
 * axes' are never properties. When the code hands the props object or the rest on (to an element's attributes, a
 * helper), a declared property may be read there, which the check cannot follow, so it only warns.
 */
function manifestProblems(ast: Node, manifest: CodeManifest, strict: boolean): Array<{ severity: CodeProblem['severity']; message: string; node?: Node }> {
  const out: Array<{ severity: CodeProblem['severity']; message: string; node?: Node }> = [];
  const severity: CodeProblem['severity'] = strict ? 'error' : 'warning';
  const properties = isRecord(manifest.properties) ? (manifest.properties as ComponentDefinition['properties']) : {};
  const declared = (name: string) => Object.hasOwn(properties, name) && isRecord(properties[name]) && typeof properties[name].type === 'string';
  const labelOf = (name: string) => (typeof properties[name].label === 'string' && properties[name].label.trim() ? properties[name].label.trim() : name);
  const taken = propsTaken(ast);
  const whole = wholePropsReads(ast);
  const axisProps = new Set(axesOf(manifest).flatMap(([, a]) => (typeof a.prop === 'string' ? [a.prop] : [])));
  const editors = (name: string) => EDITOR_PROPS.has(name) || name.startsWith('slot_') || axisProps.has(name);
  // A design's file takes each property by the key the design's file was given it under.
  const keyOf = (name: string) => (manifest.designFile ? propKey({ kind: 'managed', properties } as ComponentDefinition, name) : name);
  for (const name of Object.keys(properties)) {
    const key = keyOf(name);
    if (!declared(name) || taken.has(key) || whole.read.has(key) || (!manifest.designFile && axisProps.has(name))) continue;
    out.push(
      whole.handed
        ? { severity: 'warning', message: `The “${labelOf(name)}” property arrives in ${key}, which the code does not take from $props() by name: take it (let { ${key} } = $props()) so the check can see the code reads it.` }
        : { severity, message: `The “${labelOf(name)}” property arrives in ${key}, which the code never takes from $props(): take it (let { ${key} } = $props()), or remove the property, as what placements set there will not show.` }
    );
  }
  if (manifest.designFile) return out;
  const undeclared = (name: string, node?: Node) =>
    out.push({ severity, message: `The code takes ${name} from $props(), which is not one of the component's properties: declare it, or stop reading it, as no placement can set it.`, ...(node ? { node } : {}) });
  for (const [name, { node }] of taken) if (!declared(name) && !editors(name)) undeclared(name, node);
  for (const name of whole.read) if (!taken.has(name) && !declared(name) && !editors(name)) undeclared(name);
  for (const [name, { right }] of taken) {
    if (!right || !declared(name)) continue;
    // No default, or one the code works out, says nothing against the manifest's; null is a default like any other.
    const written = literalValue(right);
    if (!written) continue;
    let expected: { value: unknown } | undefined;
    try {
      expected = codeDefault(name, properties[name]);
    } catch {
      // A default the code could not be given (a draft the editor has not finished) is not compared.
      expected = undefined;
    }
    if (!expected || sameValue(written.value, expected.value)) continue;
    out.push({ severity, message: `The code's default for ${name} (${short(written.value)}) is not the “${labelOf(name)}” property's default (${short(expected.value)}): write the manifest's default, or none.`, node: right });
  }
  return out;
}

/**
 * The props a code component's code takes from $props() that a property could set (see manifestProblems): by name
 * in the destructuring, in the order written, with the default written for each when it is a literal (`computed` when
 * it is not one), then those it reads by name from the whole props object or the rest of them. The editor's own props, the slots' and the axes'
 * are left out. `handed` says the code hands the props object or the rest on, where any property may be read. Null
 * when the code cannot be parsed, or for a design's file, which takes its properties by other keys.
 */
export async function codePropsTaken(source: string, manifest: Pick<CodeManifest, 'variantAxes' | 'designFile'> = {}): Promise<CodePropsTaken | null> {
  if (manifest.designFile) return null;
  const { parse } = await import('svelte/compiler');
  let ast: Node;
  try {
    ast = parse(source, { modern: true }) as unknown as Node;
  } catch {
    return null;
  }
  const axisProps = new Set(axesOf(manifest).flatMap(([, a]) => (typeof a.prop === 'string' ? [a.prop] : [])));
  const editors = (name: string) => EDITOR_PROPS.has(name) || name.startsWith('slot_') || axisProps.has(name);
  const whole = wholePropsReads(ast);
  const props: CodePropsTaken['props'] = [];
  const seen = new Set<string>();
  for (const [name, { right }] of propsTaken(ast)) {
    if (editors(name)) continue;
    seen.add(name);
    // A bindable prop's default is the one handed to $bindable().
    const callee = right?.type === 'CallExpression' ? (right.callee as Node) : undefined;
    const fallback = callee?.type === 'Identifier' && callee.name === '$bindable' ? ((right!.arguments as Node[]) ?? [])[0] : right;
    const written = literalValue(fallback);
    props.push({ name, ...(written ? { default: written } : fallback ? { computed: true } : {}) });
  }
  for (const name of whole.read) if (!seen.has(name) && !editors(name)) props.push({ name });
  return { props, handed: whole.handed, axes: [...axisProps] };
}

/**
 * Where a code component's code and its manifest's properties disagree (see manifestProblems), for a check of the
 * manifest alone: code that is unchanged passed every other check when it was saved. Null when the code cannot be
 * parsed.
 */
export async function codeManifestProblems(source: string, manifest: CodeManifest, strict = false): Promise<CodeProblem[] | null> {
  const { parse } = await import('svelte/compiler');
  let ast: Node;
  try {
    ast = parse(source, { modern: true }) as unknown as Node;
  } catch {
    return null;
  }
  return manifestProblems(ast, manifest, strict).map((p) => ({ severity: p.severity, message: p.message, ...(typeof p.node?.start === 'number' ? { line: source.slice(0, p.node.start).split('\n').length } : {}) }));
}

/**
 * A pack's code components whose code and manifest disagree (see manifestProblems), held to the strict policy as the
 * assistant's code is: one message for each, naming its problems. Code that cannot be parsed is one of them.
 */
export async function packManifestProblems(components: readonly ComponentDefinition[]): Promise<string[]> {
  const out: string[] = [];
  for (const def of components) {
    if (def.kind !== 'code' || typeof def.source !== 'string') continue;
    const problems = await codeManifestProblems(def.source, def, true);
    const errors = problems === null ? [{ message: 'its code cannot be parsed.' } as CodeProblem] : problems.filter((p) => p.severity === 'error');
    if (errors.length) out.push(`Component ${def.componentId}: ${errors.map((e) => (e.line ? `line ${e.line}: ` : '') + e.message).join(' ')}`);
  }
  return out;
}

/** The part a node of the markup gives its class to through the placement's hook (so_o?.total, so_o["total"]), if any. */
function hookedPart(n: Node): string | null {
  if (n.type !== 'MemberExpression' || (n.object as Node)?.type !== 'Identifier' || (n.object as Node).name !== 'so_o') return null;
  const p = n.property as Node;
  if (!n.computed) return p?.type === 'Identifier' ? String(p.name) : null;
  return p?.type === 'Literal' && typeof p.value === 'string' ? p.value : null;
}

/**
 * The part an item hook names, the expression it reads the item's ID from, and whether it is read so that a missing
 * class reads as none (so_oi?.[plan.id]?.card): the website is given item classes only for the items styled on their
 * own, and none at all while none is.
 */
function itemHookOf(n: Node): { part: string; key: Node; guarded: boolean } | null {
  if (n.type !== 'MemberExpression') return null;
  const inner = n.object as Node;
  if (inner?.type !== 'MemberExpression' || !inner.computed || (inner.object as Node)?.type !== 'Identifier' || (inner.object as Node).name !== 'so_oi') return null;
  const p = n.property as Node;
  const part = !n.computed ? (p?.type === 'Identifier' ? String(p.name) : null) : p?.type === 'Literal' && typeof p.value === 'string' ? p.value : null;
  return part === null ? null : { part, key: inner.property as Node, guarded: !!inner.optional && !!n.optional };
}

/** The variable `expr` reads the `id` of (`plan.id`, `plan["id"]`), or null. */
function idOf(expr: Node | undefined): string | null {
  if (expr?.type !== 'MemberExpression' || (expr.object as Node)?.type !== 'Identifier') return null;
  const p = expr.property as Node;
  const named = !expr.computed ? p?.type === 'Identifier' && p.name === 'id' : p?.type === 'Literal' && p.value === 'id';
  return named ? String((expr.object as Node).name) : null;
}

/** The names a binding pattern binds: `a`, `{ key: a, b = 1 }`, `[a, ...rest]` (never a key, or a default's value). */
function boundNames(pattern: Node | undefined, out = new Set<string>()): Set<string> {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.add(String(pattern.name));
  else if (pattern.type === 'AssignmentPattern') boundNames(pattern.left as Node, out);
  else if (pattern.type === 'RestElement') boundNames(pattern.argument as Node, out);
  else if (pattern.type === 'ArrayPattern') for (const e of (pattern.elements as Node[]) ?? []) boundNames(e ?? undefined, out);
  else if (pattern.type === 'ObjectPattern') for (const p of (pattern.properties as Node[]) ?? []) boundNames(p.type === 'Property' ? (p.value as Node) : p, out);
  return out;
}

/** The names a markup fragment's own {@const} tags declare. */
function constNames(fragment: Node): Set<string> {
  const out = new Set<string>();
  for (const c of ((fragment.nodes as Node[]) ?? []).filter((x) => x.type === 'ConstTag')) for (const d of (((c.declaration as Node)?.declarations as Node[]) ?? [])) boundNames(d.id as Node, out);
  return out;
}

/** Markup that renders its content elsewhere, or as often as it is called: a snippet, or content given to a component. */
const ELSEWHERE = new Set(['SnippetBlock', 'Component', 'SvelteComponent', 'SvelteSelf']);

type ItemHook = { part: string; list: string | null; node: Node; host?: Node; problem?: 'unguarded' | 'unplaced' };

/**
 * Every item hook in the class of an element of a code component's markup (so_oi?.[plan.id]?.card), with the list
 * property it repeats the part over, or null when it says none the editor can rely on. It names one when the element
 * is inside `{#each plans as plan (plan.id)}` (or `plans ?? []`), where `plans` is a property the code takes from
 * $props() and `plan` is the row whose ID it reads, keyed by that ID; inside no other list, no snippet and no content
 * given to a component, between the list and the hook or around them, and with neither name declared again on the way
 * ({@const}): each item of that list then shows the part once, so one item's class lands on one element and moves
 * with it when the list is reordered. A hook anywhere but a class gives no element its class, and says nothing.
 */
function itemHooks(ast: Node): ItemHook[] {
  const locals = propsLocals(ast);
  const propOf = new Map([...locals].map(([prop, { local }]) => [local, prop]));
  const taken = locals.get('so_oi')?.local === 'so_oi';
  const out: ItemHook[] = [];
  walkAst(ast.fragment, (n, around) => {
    const hook = itemHookOf(n);
    if (!hook) return;
    const attr = around.findLastIndex((a) => a.type === 'Attribute');
    if (attr < 0 || around[attr].name !== 'class') return;
    const host = around[attr - 1];
    // A plain read fails the website's build for the items not styled on their own (see unguardedItemReads).
    if (!hook.guarded) return void out.push({ part: hook.part, list: null, node: n, host, problem: 'unguarded' });
    const row = idOf(hook.key);
    // The nearest list around the hook that names its row, the hook inside its body (not its key or its fallback).
    const at = row === null ? -1 : around.findLastIndex((a, i) => a.type === 'EachBlock' && (a.context as Node)?.type === 'Identifier' && (a.context as Node).name === row && around[i + 1] === a.body);
    const each = at >= 0 ? around[at] : undefined;
    let source = each?.expression as Node | undefined;
    if (source?.type === 'LogicalExpression' && (source.operator === '??' || source.operator === '||')) source = source.left as Node;
    const local = source?.type === 'Identifier' ? String(source.name) : undefined;
    const prop = local !== undefined ? propOf.get(local) : undefined;
    const keyed = !!each && idOf(each.key as Node) === row;
    const once = at >= 0 && around.every((a, i) => i === at || (a.type !== 'EachBlock' && !ELSEWHERE.has(String(a.type))));
    // A name declared again on the way reads something else: the list around the loop, the row or the item classes
    // inside it, and the item classes anywhere.
    const shadowed = around.some((a, i) => a.type === 'Fragment' && [...constNames(a)].some((name) => name === 'so_oi' || (i < at ? name === local : name === row)));
    const list = taken && prop && keyed && once && !shadowed && !/^(so|slot)_/.test(prop) ? prop : null;
    out.push({ part: hook.part, list, node: n, host, ...(list ? {} : { problem: 'unplaced' as const }) });
  });
  return out;
}

/**
 * Reads of the placement's item classes (so_oi, taken from $props(), under any name) that fail when a class is
 * missing: the website is given item classes only for the items styled on their own, and none at all while none is,
 * so every step of a read must be optional (so_oi?.[plan.id]?.card, and anything read from that), wherever in the
 * markup it is. Only a list's row or a snippet's parameter of the same name stands for something else there; any other
 * read is held to it, a guarded one too (write it with ?. instead).
 */
function unguardedItemReads(ast: Node): Node[] {
  const map = propsLocals(ast).get('so_oi')?.local;
  if (!map) return [];
  const unwrap = (n: Node | undefined) => (n?.type === 'ChainExpression' ? (n.expression as Node) : n);
  /** The variable a chain of reads starts from. */
  const rootOf = (n: Node | undefined): Node | undefined => {
    for (let at = unwrap(n); at; at = unwrap(at.object as Node)) if (at.type !== 'MemberExpression') return at;
    return undefined;
  };
  const rebinds = (a: Node) =>
    (a.type === 'EachBlock' && (boundNames(a.context as Node).has(map) || a.index === map)) || (a.type === 'SnippetBlock' && ((a.parameters as Node[]) ?? []).some((p) => boundNames(p).has(map)));
  const out: Node[] = [];
  walkAst(ast.fragment, (n, around) => {
    if (n.type !== 'MemberExpression' || n.optional) return;
    const r = rootOf(n.object as Node);
    if (r?.type === 'Identifier' && r.name === map && !around.some(rebinds)) out.push(n);
  });
  return out;
}

/** The list each part is repeated over, by its item hooks: none for a part whose hooks disagree or name none. */
function hookLists(hooks: ItemHook[]): Record<string, string> {
  const seen = new Map<string, string | null>();
  for (const h of hooks) seen.set(h.part, seen.has(h.part) && seen.get(h.part) !== h.list ? null : h.list);
  return Object.fromEntries([...seen].filter((e): e is [string, string] => e[1] !== null));
}

/** A part marker's name when it is written out (data-so-part="total"), or null for one an expression gives. */
function markerName(attr: Node): string | null {
  const values = attr.value === true ? [] : Array.isArray(attr.value) ? (attr.value as Node[]) : [attr.value as Node];
  if (values.length !== 1) return null;
  return values[0].type === 'Text' ? String(values[0].data) : values[0].type === 'ExpressionTag' ? literalText(values[0].expression as Node) : null;
}

/**
 * The parts and slots a code component's code shows, read from its syntax tree: each part its markup marks with a
/**
 * The parts and slots a code component's code shows, read from its syntax tree: each part its markup marks with a
 * written-out data-so-part or gives its class through so_o (or one item's class through so_oi), and each slot_<name>
 * its script takes from $props(); and the list each part repeated once per item is shown over (see itemHooks).
 * `shown` is the slot props (slot_content, as the generator names each slot's snippet) it takes and its markup renders
 * or hands on, so content placed there can reach the page: a slot only taken, or only tested ({#if slot_content}),
 * shows nothing. Comments, strings and a script's own logic declare nothing. Null when the code cannot be parsed.
 */
export async function codeContractNames(source: string): Promise<{ parts: string[]; slots: string[]; shown: string[]; lists: Record<string, string> } | null> {
  const { parse } = await import('svelte/compiler');
  let ast: Node;
  try {
    ast = parse(source, { modern: true }) as unknown as Node;
  } catch {
    return null;
  }
  const parts = new Set<string>();
  for (const { attr } of partMarkers(ast.fragment)) {
    const id = markerName(attr);
    if (id !== null) parts.add(id);
  }
  walkAst(ast.fragment, (n) => {
    const id = hookedPart(n);
    if (id !== null) parts.add(id);
  });
  // A part given one item's class is one of the parts the code shows, repeated over the list that item is in.
  const hooks = itemHooks(ast);
  for (const h of hooks) parts.add(h.part);
  const locals = propsLocals(ast);
  const slots = [...locals.keys()].flatMap((prop) => /^slot_([A-Za-z][A-Za-z0-9]*)$/.exec(prop)?.[1] ?? []);
  const rendered = new Set(snippetRenders(ast).map((r) => r.name));
  const handed = handedNames(ast);
  // Any slot prop counts here, not only the camelCase names saving declares: a theme's slot may be named related_links.
  const shown = [...locals].flatMap(([prop, { local }]) => (prop.startsWith('slot_') && (rendered.has(local) || handed.has(local)) ? [prop] : []));
  return { parts: [...parts], slots, shown, lists: hookLists(hooks) };
}

/** What a code component's markup can give a part's class to, or mark as a part: an element or a component it places. */
const PART_HOSTS = new Set(['RegularElement', 'SvelteElement', 'Component', 'SvelteComponent', 'SvelteSelf']);
/**
 * The Builder's own components that put what they are given on one element where they are placed: their class, their
 * other attributes and their children (Link), or their value (RichText). The rest may show it anywhere, or not at all.
 */
const IN_PLACE = /^(?:\.\.|#lib\/siteorigin)\/runtime\/(?:Link|RichText)\.svelte$/;
const RUNTIME_UTIL = /^(?:\.\.|#lib\/siteorigin)\/runtime\/util\.js$/;

/** What a part's code shows of its text (codePartTexts): the marked paths, and the properties whose presence also decides what shows outside it. */
export interface CodePartText {
  paths: string[];
  /** Properties a change may not empty or fill: whether they have text decides an `{#if}` outside the part. */
  keep: string[];
  /** The lists the part is shown once per item of: their fields are one item's, so only a selection of one item reaches them. */
  perItem: string[];
}

/** A well-formed text marker (`so_text?.('heading')`, `so_text?.('features.title', item.id)`): its path and item argument, or null. */
function markedTextPath(attr: Node, hook: string): { path: string; prop: string; field?: string; item?: Node } | null {
  const values = attr.value === true ? [] : Array.isArray(attr.value) ? (attr.value as Node[]) : [attr.value as Node];
  const chain = values.length === 1 && values[0].type === 'ExpressionTag' ? (values[0].expression as Node) : undefined;
  const call = chain?.type === 'ChainExpression' ? (chain.expression as Node) : undefined;
  const callee = call?.type === 'CallExpression' && call.optional ? (call.callee as Node) : undefined;
  if (callee?.type !== 'Identifier' || callee.name !== hook) return null;
  const args = (call!.arguments as Node[]) ?? [];
  const written = args.some((a) => a.type === 'SpreadElement') ? null : literalText(args[0]);
  const path = written === null ? null : parseCodeTextPath(written);
  if (!path || args.length !== (path.field === undefined ? 1 : 2)) return null;
  return { path: written!, ...path, ...(path.field !== undefined ? { item: args[1] } : {}) };
}

/** Whether an identifier is a name being read, not a property after a dot or an object literal's key. */
function isRead(n: Node, parent: Node | undefined): boolean {
  if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return false;
  return !(parent?.type === 'Property' && parent.key === n && !parent.computed && parent.value !== n);
}

/**
 * Whether a node is a name a pattern binds (`{#each plans as plan}`, `const x = …`, a function's or snippet's
 * parameters, an import), not a read. A default's value and a computed key inside the pattern are read.
 */
function inBinding(n: Node, around: Node[]): boolean {
  for (let i = 0; i < around.length; i++) {
    const a = around[i];
    const next = around[i + 1] ?? n;
    const pattern =
      (a.type === 'EachBlock' && next === a.context) ||
      (a.type === 'VariableDeclarator' && next === a.id) ||
      (a.type === 'SnippetBlock' && (((a.parameters as Node[]) ?? []).includes(next) || next === a.expression)) ||
      (FUNCTION_TYPES.has(a.type) && (((a.params as Node[]) ?? []).includes(next) || next === a.id)) ||
      (a.type === 'AwaitBlock' && (next === a.value || next === a.error)) ||
      (a.type === 'CatchClause' && next === a.param) ||
      a.type === 'ImportSpecifier' ||
      a.type === 'ImportDefaultSpecifier' ||
      a.type === 'ImportNamespaceSpecifier';
    if (!pattern) continue;
    // Inside the pattern, what a default or a computed key reads is read where the pattern is.
    for (let j = i + 1; j < around.length; j++) {
      const b = around[j];
      const inner = around[j + 1] ?? n;
      if ((b.type === 'AssignmentPattern' && inner === b.right) || (b.type === 'Property' && b.computed && inner === b.key)) return false;
    }
    return true;
  }
  return false;
}

/**
 * The text each part of a code component shows, read from its syntax tree (#1416): by part, the path of each text
 * marked for the canvas (`data-so-text`, "heading" or "features.title") on the element that is the part or inside it,
 * so the assistant may change it from a selection of that part, as the author may type over it there.
 *
 * An element is a part only where that is certain, as the preview tells them: a written-out `data-so-part`, or else
 * the one part class its class gives it (`so_o?.actions`); one given a choice of parts, a marker worked out, or a
 * spread of attributes is no part's. A text counts only where everything the markup shows of it is in the part: the
 * code marks it nowhere else, and the markup outside the part reads neither its property (under any name the code
 * takes it by, a `$` store included), a list item's field of it, nor anything the script or a `{@const}` works out
 * from it. Whether it is there at all (`has(label)`, and what is worked out only from that, a `hasActions`) may decide
 * an `{#if}` anywhere, so long as a change keeps it there or not (`keep`); a plain test of it may decide an `{#if}`
 * that shows only the part; and a list may be read where it is repeated over, its items read by the `{#each}`'s own
 * names. A list's field counts only on the item its marker is shown for, and only in a part that list is not read in
 * any other way.
 *
 * Code that changes anything as it runs (an assignment, an `$effect` writing state, a two-way binding) may copy a text
 * anywhere, so none of its parts is given any. Nor is text in a component other than the Builder's own, which may show
 * it anywhere, or in a snippet, which may be rendered anywhere, or a list's field marked in a list repeated inside
 * another, which shows the same items in every outer item. Null when the code cannot be parsed.
 */
export async function codePartTexts(source: string): Promise<Record<string, CodePartText> | null> {
  const { parse } = await import('svelte/compiler');
  let ast: Node;
  try {
    ast = parse(source, { modern: true }) as unknown as Node;
  } catch {
    return null;
  }
  const locals = propsLocals(ast);
  const hook = locals.get(CODE_TEXT_HOOK)?.local;
  if (!hook) return {};
  /** Every name the code takes a property by, `$props()` destructured more than once or under two names included. */
  const propOf = new Map<string, string>();
  /** What each name the code works out reads (see `derived`), starting with a property's default given in `$props()`. */
  const uses = new Map<string, Array<{ name: string; presence: boolean }>>();
  const defaults: Array<{ local: string; right: Node }> = [];
  let whole = false;
  walkAst(ast.instance, (n) => {
    if (n.type !== 'VariableDeclarator' || (n.init as Node | null)?.type !== 'CallExpression' || ((n.init as Node).callee as Node)?.name !== '$props') return;
    if ((n.id as Node)?.type !== 'ObjectPattern') whole = true;
    for (const p of (((n.id as Node)?.properties as Node[]) ?? [])) {
      if (p.type !== 'Property' || p.computed) continue;
      const key = p.key as Node;
      const name = key.type === 'Identifier' ? String(key.name) : key.type === 'Literal' ? String(key.value) : null;
      for (const local of boundNames(p.value as Node)) {
        if (name !== null) propOf.set(local, name);
        if ((p.value as Node)?.type === 'AssignmentPattern') defaults.push({ local, right: (p.value as Node).right as Node });
      }
    }
  });
  // Code that reads its properties as one object, or keeps state in a module of its own, is not read further.
  const moduleCode = ((ast.module as { content?: { body?: Node[] } } | null)?.content?.body ?? []).some((st) => st.type !== 'ImportDeclaration');
  if (whole || moduleCode) return {};
  const script = (ast.instance as { content?: { body?: Node[] } } | null)?.content?.body ?? [];
  // The Builder's own components, and its `has`, by the names the script imports them under.
  const inPlace = new Set<string>();
  let has: string | null = null;
  for (const st of script) {
    if (st.type !== 'ImportDeclaration') continue;
    const from = String((st.source as Node)?.value ?? '');
    for (const sp of (st.specifiers as Node[]) ?? []) {
      const local = String((sp.local as Node)?.name ?? '');
      if (sp.type === 'ImportDefaultSpecifier' && IN_PLACE.test(from)) inPlace.add(local);
      if (sp.type === 'ImportSpecifier' && RUNTIME_UTIL.test(from) && ((sp.imported as Node)?.name ?? (sp.imported as Node)?.value) === 'has') has = local;
    }
  }
  // A name the code binds again for something else is not the Builder's: a `has` then says nothing of presence, and a
  // component named like the Builder's own may show what it is given anywhere.
  const bound = new Set<string>();
  for (const root of [ast.instance, ast.fragment])
    walkAst(root, (n, around) => {
      if (n.type === 'Identifier' && inBinding(n, around) && !around.some((a) => a.type === 'ImportDeclaration')) bound.add(String(n.name));
    });
  if (has !== null && bound.has(has)) has = null;
  for (const name of inPlace) if (bound.has(name)) inPlace.delete(name);
  /** Whether an identifier is the one value `has()` is asked about. */
  const presence = (n: Node, parent: Node | undefined) => !!has && parent?.type === 'CallExpression' && (parent.callee as Node)?.type === 'Identifier' && (parent.callee as Node).name === has && ((parent.arguments as Node[]) ?? []).length === 1 && (parent.arguments as Node[])[0] === n;
  /** The property a name reads: one the code takes, or its store (`$label`). */
  const readsProp = (name: string) => propOf.get(name) ?? (name.startsWith('$') ? propOf.get(name.slice(1)) : undefined);
  /** What a node reads, each name with whether it is only asked whether it is there. */
  const readsOf = (root: unknown) => {
    const used: Array<{ name: string; presence: boolean }> = [];
    walkAst(root, (n, around) => {
      if (n.type === 'Identifier' && isRead(n, around[around.length - 1]) && !inBinding(n, around)) used.push({ name: String(n.name), presence: presence(n, around[around.length - 1]) });
    });
    return used;
  };
  const seen = new Map<string, Set<string>>();
  const addUses = (name: string, used: Array<{ name: string; presence: boolean }>) => {
    const had = seen.get(name) ?? seen.set(name, new Set()).get(name)!;
    const list = uses.get(name) ?? uses.set(name, []).get(name)!;
    // Each read once per name, however many writes repeat it.
    for (const u of used) if (!had.has(`${u.presence}:${u.name}`)) had.add(`${u.presence}:${u.name}`) && list.push(u);
  };
  for (const d of defaults) addUses(d.local, readsOf(d.right));
  /** The name an assignment or a method call changes: `copy` in `copy = …`, `copy.title = …`, `map.set(…)`. */
  const rootName = (n: Node | undefined): string | null => {
    let at = n;
    while (at && (at.type === 'MemberExpression' || at.type === 'ChainExpression')) at = (at.type === 'ChainExpression' ? at.expression : at.object) as Node;
    return at?.type === 'Identifier' ? String(at.name) : null;
  };
  // What the code changes as it runs holds whatever the code that changes it reads: an assignment, or a call that may
  // keep what it is given (`map.set('label', label)`, `Object.assign(copy, …)`), takes everything the function it is in
  // reads (an $effect, an event handler, a helper), conditions included. A call of the code's own function hands what
  // it is given to that function's parameters.
  const functions = new Map<string, Node[]>();
  for (const root of [ast.instance, ast.fragment])
    walkAst(root, (n) => {
      if (n.type === 'FunctionDeclaration' && (n.id as Node)?.type === 'Identifier') functions.set(String((n.id as Node).name), (n.params as Node[]) ?? []);
      if (n.type === 'VariableDeclarator' && (n.id as Node)?.type === 'Identifier' && FUNCTION_TYPES.has(String((n.init as Node)?.type))) functions.set(String((n.id as Node).name), ((n.init as Node).params as Node[]) ?? []);
    });
  const fnReads = new Map<Node, Array<{ name: string; presence: boolean }>>();
  for (const root of [ast.instance, ast.fragment])
    walkAst(root, (n, around) => {
      const scope = () => {
        const fn = [...around].reverse().find((x) => FUNCTION_TYPES.has(x.type)) ?? n;
        // Read once per function, however many writes it holds.
        return fnReads.get(fn) ?? fnReads.set(fn, readsOf(fn)).get(fn)!;
      };
      if (n.type === 'AssignmentExpression') {
        const left = n.left as Node;
        const names = left.type === 'Identifier' || left.type === 'MemberExpression' ? [rootName(left)] : [...boundNames(left)];
        const used = scope();
        for (const name of names) if (name) addUses(name, used);
      }
      if (n.type === 'CallExpression') {
        const callee = (n.callee as Node)?.type === 'ChainExpression' ? ((n.callee as Node).expression as Node) : (n.callee as Node);
        const args = (n.arguments as Node[]) ?? [];
        const targets = [callee?.type === 'MemberExpression' ? rootName(callee.object as Node) : null, ...args.map((x) => rootName(x.type === 'SpreadElement' ? (x.argument as Node) : x))];
        if (callee?.type === 'MemberExpression' && targets.some(Boolean)) {
          const used = scope();
          for (const name of targets) if (name) addUses(name, used);
        }
        const params = callee?.type === 'Identifier' ? functions.get(String(callee.name)) : undefined;
        if (params) {
          const given = readsOf(args);
          for (const param of params) for (const name of boundNames(param)) addUses(name, given);
        }
      }
      // A two-way binding is changed by the visitor, from nothing the placement gives it.
    });
  // What each name the code declares (in the script, a {@const}, or inside a function) is worked out from: by
  // property, its value or only whether it is there. An alias (`const o = copy`) changed later changes what it names.
  for (const root of [ast.instance, ast.fragment])
    walkAst(root, (n) => {
      if (n.type === 'VariableDeclarator') {
        if ((n.init as Node)?.type === 'CallExpression' && ((n.init as Node).callee as Node)?.name === '$props') return;
        const names = [...boundNames(n.id as Node)];
        const used = readsOf(n);
        for (const name of names) addUses(name, used);
        const aliased = rootName(n.init as Node);
        if (aliased) addUses(aliased, names.map((name) => ({ name, presence: false })));
      }
      if (n.type === 'FunctionDeclaration' && (n.id as Node)?.type === 'Identifier') addUses(String((n.id as Node).name), readsOf(n));
    });
  const derived = new Map<string, Map<string, 'value' | 'presence'>>();
  for (let changed = true, guard = 0; changed && guard <= uses.size + 1; guard++) {
    changed = false;
    for (const [name, used] of uses) {
      const from = new Map(derived.get(name) ?? []);
      for (const u of used) {
        const direct = readsProp(u.name);
        const via: Array<[string, 'value' | 'presence']> = direct !== undefined ? [[direct, u.presence ? 'presence' : 'value']] : [...(derived.get(u.name) ?? [])];
        for (const [prop, kind] of via) if (from.get(prop) !== 'value' && from.get(prop) !== kind) from.set(prop, kind);
      }
      if ([...from].some(([p, k]) => derived.get(name)?.get(p) !== k)) {
        derived.set(name, from);
        changed = true;
      }
    }
  }
  /** The {#each} over a list property a name is the item of where it is read (in the loop's body or key), and the field it names. */
  const eachOf = (name: string, around: Node[]) => {
    for (let i = around.length - 1; i >= 0; i--) {
      const a = around[i];
      // Named again on the way out ({@const row = …}, a snippet's or an {#await}'s own name): not the loop's item.
      const consts = a.type === 'Fragment' ? ((a.nodes as Node[]) ?? []).filter((c) => c.type === 'ConstTag') : [];
      if (consts.some((c) => (((c.declaration as Node)?.declarations as Node[]) ?? []).some((d) => boundNames(d.id as Node).has(name)))) return null;
      if (a.type === 'SnippetBlock' && ((a.parameters as Node[]) ?? []).some((p) => boundNames(p).has(name))) return null;
      if (a.type === 'AwaitBlock' && ((around[i + 1] === a.then && boundNames(a.value as Node).has(name)) || (around[i + 1] === a.catch && boundNames(a.error as Node).has(name)))) return null;
      if (a.type !== 'EachBlock' || ((around[i + 1] as Node | undefined) !== a.body && around[i + 1] !== a.key)) continue;
      if (!boundNames(a.context as Node).has(name)) continue;
      const list = (a.expression as Node)?.type === 'Identifier' ? propOf.get(String((a.expression as Node).name)) : undefined;
      return { each: a, list };
    }
    return null;
  };
  /** Each part's elements, with the nodes around each, outermost first. */
  const hosts = new Map<string, Array<{ node: Node; around: Node[] }>>();
  const markers: Array<{ path: string; prop: string; field?: string; item?: Node; around: Node[] }> = [];
  /**
   * What the markup reads: a property (`field` for one field of its items, `null` for all of them), whether only for
   * whether it is there, and whether it is the property itself (not something worked out from it).
   */
  const reads: Array<{ prop: string; field?: string | null; presence: boolean; direct: boolean; node: Node; around: Node[] }> = [];
  const readName = (name: string, n: Node, parent: Node | undefined, around: Node[]) => {
    const prop = readsProp(name);
    if (prop !== undefined) reads.push({ prop, presence: presence(n, parent), direct: true, node: n, around });
    // `$shown` reads the store `shown` holds.
    for (const [p, kind] of [...(derived.get(name) ?? []), ...(name.startsWith('$') ? (derived.get(name.slice(1)) ?? []) : [])]) reads.push({ prop: p, presence: kind === 'presence', direct: false, node: n, around });
    // An item of a list the markup repeats over: one field of it, or the whole item.
    const at = eachOf(name, around);
    if (!at) return;
    const ctx = at.each.context as Node;
    const keyed = ctx.type === 'ObjectPattern' ? ((ctx.properties as Node[]) ?? []).find((p) => p.type === 'Property' && boundNames(p.value as Node).has(name)) : undefined;
    const field: string | null = keyed ? (keyed.computed ? null : String((keyed.key as Node)?.name ?? (keyed.key as Node)?.value)) : ctx.type === 'Identifier' && parent?.type === 'MemberExpression' && parent.object === n && !parent.computed ? String((parent.property as Node)?.name) : null;
    // An item of a list worked out from the properties reads every field of each list it is worked out from.
    const lists = at.list !== undefined ? [at.list] : [...(derived.get(String((at.each.expression as Node)?.name))?.keys() ?? [])];
    for (const list of lists) reads.push({ prop: list, field: at.list !== undefined ? field : null, presence: false, direct: true, node: n, around });
  };
  walkAst(ast.fragment, (n, around) => {
    const parent = around[around.length - 1];
    if (PART_HOSTS.has(n.type) && Array.isArray(n.attributes)) {
      const attrs = n.attributes as Node[];
      const marker = attrs.find((a) => a.type === 'Attribute' && attrName(a, n) === 'data-so-part');
      const hooked = new Set<string>();
      let conditional = false;
      for (const a of attrs)
        if (a.type === 'Attribute' && attrName(a, n) === 'class')
          walkAst(a.value, (x, xs) => {
            const hook = x.type === 'MemberExpression' && (x.object as Node)?.type === 'Identifier' && (x.object as Node).name === 'so_o';
            if (!hook) return;
            const id = hookedPart(x);
            // A part named by an expression, or given only on a condition (a choice, a test, an object's key), is not certain.
            if (id === null || xs.some((y) => y.type === 'ConditionalExpression' || y.type === 'LogicalExpression' || y.type === 'CallExpression' || y.type === 'ObjectExpression')) conditional = true;
            if (id !== null) hooked.add(id);
          });
      // A spread may give the element other classes, or another marker, than the ones written.
      const spread = attrs.some((a) => a.type === 'SpreadAttribute');
      const id = spread ? null : marker ? markerName(marker) : !conditional && hooked.size === 1 ? [...hooked][0] : null;
      if (id !== null) hosts.set(id, [...(hosts.get(id) ?? []), { node: n, around }]);
    }
    // A component's tag reads the name it is called by: one worked out from a text shows something else as it changes.
    if (n.type === 'Component') readName(String(n.name).split('.')[0], n, parent, around);
    // `style:color` with no value reads `color`.
    if (n.type === 'StyleDirective' && n.value === true) readName(String(n.name), n, parent, around);
    if (n.type === 'Attribute' && attrName(n, parent) === CODE_TEXT_ATTR) {
      const path = markedTextPath(n, hook);
      if (path) markers.push({ ...path, around });
      return;
    }
    if (n.type !== 'Identifier' || !isRead(n, parent) || inBinding(n, around)) return;
    readName(String(n.name), n, parent, around);
  });
  /**
   * Whether a node sits in one of the part's elements (or on one), with nothing around it that could show it elsewhere
   * too: a snippet, or a component other than the Builder's own, around the node or around the part itself.
   */
  const opaque = (a: Node) => a.type === 'SnippetBlock' || ((a.type === 'Component' || a.type === 'SvelteComponent' || a.type === 'SvelteSelf') && !(a.type === 'Component' && inPlace.has(String(a.name))));
  const inside = (part: string, around: Node[]) => !around.some(opaque) && (hosts.get(part) ?? []).some(({ node }) => around.includes(node));
  const out: Record<string, CodePartText> = {};
  for (const part of hosts.keys()) {
    const own = new Set((hosts.get(part) ?? []).map((h) => h.node));
    /** A part shown once per item of a list: its elements are inside an {#each}. */
    const repeated = (hosts.get(part) ?? []).some((h) => h.around.some((a) => a.type === 'EachBlock'));
    /** An {#if} that shows the part's element and nothing else: its test decides only whether the part shows. */
    const guardsPart = (r: { node: Node; around: Node[] }) =>
      r.around.some((a, i) => {
        if (a.type !== 'IfBlock' || a.alternate || (r.around[i + 1] ?? r.node) !== a.test) return false;
        const shown = (((a.consequent as Node)?.nodes as Node[]) ?? []).filter((c) => !(c.type === 'Text' && !String(c.data).trim()));
        return shown.length === 1 && own.has(shown[0]);
      });
    /** Whether a read is in an {#if}'s test. */
    const tested = (r: { node: Node; around: Node[] }) => r.around.some((a, i) => a.type === 'IfBlock' && (r.around[i + 1] ?? r.node) === a.test);
    const paths = new Set<string>();
    const outside = new Set<string>();
    const keep = new Set<string>();
    for (const m of markers) {
      const nested = m.field !== undefined && m.around.filter((a) => a.type === 'EachBlock').length > 1;
      // A field's marker names the item of the {#each} it is in, by that item's ID: any other item is shown elsewhere.
      const item = m.field !== undefined && m.item?.type === 'MemberExpression' && !m.item.computed && (m.item.property as Node)?.name === 'id' && (m.item.object as Node)?.type === 'Identifier' ? eachOf(String((m.item.object as Node).name), m.around) : null;
      const ownItem = m.field === undefined || (item !== null && item.list === m.prop && (item.each.context as Node)?.type === 'Identifier');
      if (nested || !ownItem || !inside(part, m.around)) outside.add(m.path);
      else paths.add(m.path);
    }
    for (const r of reads) {
      const within = inside(part, r.around);
      for (const p of paths) {
        const [prop, field] = p.split('.');
        if (prop !== r.prop) continue;
        if (field === undefined) {
          if (r.field !== undefined || within || (r.field === undefined && guardsPart(r))) continue;
          if (r.presence && tested(r)) keep.add(prop);
          else outside.add(p);
          continue;
        }
        // A list's field: its items read by the {#each}'s own names, wherever they are, read that field or all of them.
        if (r.field !== undefined) {
          if (!within && (r.field === null || r.field === field)) outside.add(p);
          continue;
        }
        // The list itself: where it is repeated over, anywhere inside a part that holds the whole list, or asked only
        // whether it has items, which no change to an item's field changes.
        if (r.presence && tested(r)) continue;
        const each = r.around[r.around.length - 1];
        const repeatedOver = r.direct && each?.type === 'EachBlock' && each.expression === r.node && (each.context as Node)?.type === 'Identifier';
        if (!repeatedOver && !(within && !repeated)) outside.add(p);
      }
    }
    const shown = [...paths].filter((p) => !outside.has(p) && locals.has(p.split('.')[0])).sort();
    const perItem = new Set((hosts.get(part) ?? []).flatMap((h) => h.around.flatMap((a) => (a.type === 'EachBlock' && (a.expression as Node)?.type === 'Identifier' && propOf.has(String((a.expression as Node).name)) ? [propOf.get(String((a.expression as Node).name))!] : []))));
    out[part] = { paths: shown, keep: [...keep].filter((p) => shown.includes(p)).sort(), perItem: [...perItem].sort() };
  }
  return out;
}

/**
 * Each snippet the markup renders, by the name it calls, with whether a call there can find it missing: an optional
 * call, or a plain one inside a block shown only while it is given ({#if slot_content}, not its {:else}).
 */
function snippetRenders(ast: Node): Array<{ name: string; node: Node; optional: boolean; guarded: boolean }> {
  const renders: Array<{ name: string; node: Node; optional: boolean; guarded: boolean }> = [];
  walkAst(ast.fragment, (n, around) => {
    if (n.type !== 'RenderTag') return;
    let call = n.expression as Node;
    let optional = !!call?.optional;
    if (call?.type === 'ChainExpression') {
      call = call.expression as Node;
      optional = true;
    }
    const callee = call?.type === 'CallExpression' ? (call.callee as Node) : undefined;
    if (callee?.type !== 'Identifier') return;
    const name = String(callee.name);
    const guarded = around.some((a, i) => a.type === 'IfBlock' && around[i + 1] === a.consequent && truthyTest(a.test as Node, name));
    renders.push({ name, node: n, optional: optional || !!call.optional, guarded });
  });
  return renders;
}

/**
 * The names the markup hands on, to a snippet it renders or a component it places: a slot handed on is shown by
 * whatever it is handed to. Only testing it ({#if slot_content}) shows nothing.
 */
function handedNames(ast: Node): Set<string> {
  const handed = new Set<string>();
  walkAst(ast.fragment, (n, around) => {
    if (n.type !== 'Identifier') return;
    const passed = around.some((a, i) => (a.type === 'RenderTag' && i < around.length - 1) || ((a.type === 'Attribute' || a.type === 'SpreadAttribute') && /^(Component|SvelteComponent|SvelteSelf)$/.test(String(around[i - 1]?.type))));
    if (passed) handed.add(String(n.name));
  });
  return handed;
}

/**
 * Whether a block's test is true only while `name` holds something: `name`, `!!name`, `name != null` (or
 * `!= undefined`), `typeof name === 'function'`, or an `&&` chain with one of them.
 */
function truthyTest(test: Node | undefined, name: string): boolean {
  if (!test) return false;
  const is = (n: Node | undefined) => n?.type === 'Identifier' && n.name === name;
  const nothing = (n: Node | undefined, loose: boolean) => (n?.type === 'Identifier' && n.name === 'undefined') || (loose && n?.type === 'Literal' && n.value === null);
  if (is(test)) return true;
  if (test.type === 'UnaryExpression' && test.operator === '!' && (test.argument as Node)?.type === 'UnaryExpression' && (test.argument as Node).operator === '!') return is((test.argument as Node).argument as Node);
  if (test.type === 'LogicalExpression' && test.operator === '&&') return truthyTest(test.left as Node, name) || truthyTest(test.right as Node, name);
  if (test.type === 'BinaryExpression') {
    const [l, r] = [test.left as Node, test.right as Node];
    // Loosely, so null (a default of null) is ruled out with undefined.
    if (test.operator === '!=') return (is(l) && nothing(r, true)) || (is(r) && nothing(l, true));
    if (test.operator === '===' || test.operator === '==') {
      const typed = (a: Node, b: Node) => a?.type === 'UnaryExpression' && a.operator === 'typeof' && is(a.argument as Node) && b?.type === 'Literal' && b.value === 'function';
      return typed(l, r) || typed(r, l);
    }
  }
  return false;
}

/**
 * Where a code component's code breaks its contract: a declared slot it never renders (which hides content its
 * placements hold there), or renders in a way that fails while a placement leaves it empty (the snippet is then not
 * given, on the server as in the browser); a part it marks under a name it does not declare, by an expression the
 * editor cannot read, or in a spread the website's build cannot take out; a declared part it neither marks nor gives
 * its class, or marks on an element that does not take the part's class (so styles set in the editor cannot reach it).
 */
function contractProblems(ast: Node, contract: CodeContract): Array<{ severity: CodeProblem['severity']; message: string; node?: Node }> {
  const out: Array<{ severity: CodeProblem['severity']; message: string; node?: Node }> = [];
  const locals = propsLocals(ast);
  const renders = snippetRenders(ast);
  const slots = contract.slots ?? {};
  const filled = new Set(contract.filled ?? []);
  const handed = handedNames(ast);
  // Its declared slots, and every slot_<name> it takes from $props(), declared or not yet: each must render safely.
  const taken = [...locals.keys()].flatMap((prop) => /^slot_([A-Za-z][A-Za-z0-9]*)$/.exec(prop)?.[1] ?? []);
  for (const slot of [...new Set([...Object.keys(slots), ...taken])]) {
    const label = Object.hasOwn(slots, slot) && typeof slots[slot]?.label === 'string' && slots[slot].label.trim() ? slots[slot].label.trim() : slot;
    const prop = slotIdent(slot);
    const from = locals.get(prop);
    const local = from?.local ?? prop;
    const shown = renders.filter((r) => r.name === local);
    if (!shown.length && from && handed.has(local)) continue;
    if (!shown.length) {
      // Content placed there already would disappear from the site: the code must show the slot, or the content go first.
      if (filled.has(slot)) out.push({ severity: 'error', message: `The “${label}” slot holds content on the site, but the code does not show it. Keep rendering it with {@render ${local}?.()}, or move that content out of the slot first.` });
      else out.push({ severity: 'warning', message: `The “${label}” slot is never shown: take ${prop} from $props() and render it with {@render ${local}?.()}, or what is placed there will not show.` });
      continue;
    }
    if (!from) {
      out.push({ severity: 'error', message: `${prop} must be taken from $props() (let { ${prop} } = $props()) for the “${label}” slot to show what is placed there.`, node: shown[0].node });
      continue;
    }
    for (const r of shown)
      if (!r.optional && !r.guarded && !from.fallback)
        out.push({ severity: 'error', message: `Render the “${label}” slot with {@render ${local}?.()} or inside {#if ${local}}: a placement with nothing in it gives no snippet, and the page would fail to render.`, node: r.node });
  }
  // Each variant axis arrives in the property the manifest names for it.
  out.push(...axisProblems(ast, contract.variantAxes));
  // Each placement gives the code its part classes, which replace whatever the code gives so_o itself.
  if (locals.get('so_o')?.defaulted) out.push({ severity: 'warning', message: 'Give so_o no default of its own (let { so_o } = $props()): each placement passes its own part classes, which replace it.' });
  const parts = contract.parts ?? {};
  const marked = new Set<string>();
  walkAst(ast.fragment, (n) => void (hookedPart(n) !== null && marked.add(hookedPart(n)!)));
  // One item's class reaches the part only for the list it is shown once per item of, read where the code repeats it.
  const hooks = itemHooks(ast);
  const lists = hookLists(hooks);
  for (const n of unguardedItemReads(ast))
    out.push({ severity: 'error', message: 'Read item classes as so_oi?.[plan.id]?.card, optional at every step: the website is given item classes only for the items styled on their own, so a plain read fails for the rest.', node: n });
  for (const h of hooks) {
    marked.add(h.part);
    if (h.problem === 'unguarded') continue;
    if (h.list === null)
      out.push({
        severity: 'warning',
        message: `Give the “${h.part}” part one item's class inside the list it repeats over, keyed by the item's ID ({#each plans as plan (plan.id)} … class={so_oi?.[plan.id]?.${h.part}}), with the list taken from $props() and inside no other list, snippet or component: otherwise its items are styled together.`,
        node: h.node
      });
    else if (!Object.hasOwn(lists, h.part)) out.push({ severity: 'warning', message: `The “${h.part}” part takes item classes from more than one list, so its items are styled together. Give each list's element a part of its own.`, node: h.node });
    else {
      // The part's shared class names it on the page, so a card can be picked, and carries what every card shares.
      const cls = ((h.host?.attributes as Node[]) ?? []).find((a) => a.type === 'Attribute' && a.name === 'class');
      const shared = new Set<string>();
      if (cls && cls.value !== true) walkAst(cls.value, (v) => void (hookedPart(v) !== null && shared.add(hookedPart(v)!)));
      if (!shared.has(h.part)) out.push({ severity: 'warning', message: `Give the element with the “${h.part}” item class the part's shared class too (class={[so_o?.${h.part}, so_oi?.[…]?.${h.part}]}), so a single item can be picked on the page and every item can be styled together.`, node: h.node });
    }
  }
  // A marker in a spread is set by the code as it runs, where the website's build cannot take it out.
  walkAst(ast.fragment, (n) => {
    const spread = n.type === 'SpreadAttribute' && (n.expression as Node)?.type === 'ObjectExpression' ? (((n.expression as Node).properties as Node[]) ?? []) : [];
    const keyOf = (k: Node | undefined) => (k?.type === 'Identifier' ? k.name : k?.type === 'Literal' ? k.value : null);
    if (spread.some((p) => p.type === 'Property' && isCodeMarker(String(keyOf(p.key as Node))))) out.push({ severity: 'error', message: 'Write data-so-part as an attribute of its own (data-so-part="total"), not in a spread: the published site must not carry it.', node: n });
  });
  for (const { attr, host } of partMarkers(ast.fragment)) {
    const id = markerName(attr);
    if (id === null) {
      out.push({ severity: 'warning', message: 'Mark a part with its name written out (data-so-part="total"): the editor cannot tell which part an expression names.', node: attr });
      continue;
    }
    if (id === 'root') {
      out.push({ severity: 'warning', message: 'The root part is the whole component: mark only the elements inside it with data-so-part.', node: attr });
      continue;
    }
    marked.add(id);
    if (!Object.hasOwn(parts, id)) {
      out.push({ severity: PART_ID.test(id) ? 'warning' : 'error', message: PART_ID.test(id) ? `“${id}” is not one of the component's parts yet. Saving adds it.` : `Part names are camelCase words, such as "total" ("${id}").`, node: attr });
      continue;
    }
    // Styles set in the editor reach a part through the class the placement gives it, read in the class's code.
    const cls = (host.attributes as Node[]).find((a) => a.type === 'Attribute' && a.name === 'class');
    const hooks = new Set<string>();
    if (cls && cls.value !== true) walkAst((Array.isArray(cls.value) ? (cls.value as Node[]) : [cls.value as Node]).filter((v) => v.type === 'ExpressionTag'), (v) => void (hookedPart(v) !== null && hooks.add(hookedPart(v)!)));
    if (!hooks.has(id)) out.push({ severity: 'warning', message: `Give the element marked “${id}” the part's class (class={so_o?.${id}}), or styles set for it in the editor will not show.`, node: attr });
  }
  for (const id of Object.keys(parts)) if (id !== 'root' && !marked.has(id)) out.push({ severity: 'warning', message: `The “${parts[id]?.label ?? id}” part is not in the code: give its element the part's class (class={so_o?.${id}}) so it can be styled and picked on the page.` });
  out.push(...textMarkerProblems(ast, locals, contract.properties));
  return out;
}

/**
 * Where a code component's text markers (see shared/code-text.ts) go wrong: one not written through the placement's
 * hook, or a hook with a default of its own, would be written into the published site; one whose path is not written
 * out cannot be read by the editor; and one naming a property or field the component does not declare, or one that is
 * not text the page can be typed into, offers nothing to type over. Errors all: each is fixed in the code.
 */
function textMarkerProblems(ast: Node, locals: ReturnType<typeof propsLocals>, properties: CodeContract['properties']): Array<{ severity: CodeProblem['severity']; message: string; node?: Node }> {
  const out: Array<{ severity: CodeProblem['severity']; message: string; node?: Node }> = [];
  const hook = locals.get(CODE_TEXT_HOOK);
  const example = `${CODE_TEXT_ATTR}={${hook?.local ?? CODE_TEXT_HOOK}?.('heading')}`;
  // The hook's calls that mark text, which are the only places its name may appear.
  const calls = new Set<Node>();
  if (hook?.defaulted) out.push({ severity: 'error', message: `Give ${CODE_TEXT_HOOK} no default (let { ${CODE_TEXT_HOOK} } = $props()): the published site is given none, so its text carries no marker.` });
  walkAst(ast.fragment, (n, around) => {
    const spread = n.type === 'SpreadAttribute' && (n.expression as Node)?.type === 'ObjectExpression' ? (((n.expression as Node).properties as Node[]) ?? []) : [];
    const keyOf = (k: Node | undefined) => (k?.type === 'Identifier' ? k.name : k?.type === 'Literal' ? k.value : null);
    const element = around[around.length - 1]?.type === 'RegularElement';
    if (spread.some((p) => p.type === 'Property' && (element ? String(keyOf(p.key as Node)).toLowerCase() : keyOf(p.key as Node)) === CODE_TEXT_ATTR)) out.push({ severity: 'error', message: `Write ${CODE_TEXT_ATTR} as an attribute of its own (${example}), not in a spread.`, node: n });
    if (n.type !== 'Attribute' || attrName(n, around[around.length - 1]) !== CODE_TEXT_ATTR) return;
    const values = n.value === true ? [] : Array.isArray(n.value) ? (n.value as Node[]) : [n.value as Node];
    let call = values.length === 1 && values[0].type === 'ExpressionTag' ? (values[0].expression as Node) : undefined;
    let optional = false;
    if (call?.type === 'ChainExpression') {
      call = call.expression as Node;
      optional = true;
    }
    const callee = call?.type === 'CallExpression' ? (call.callee as Node) : undefined;
    if (hook && callee?.type === 'Identifier' && callee.name === hook.local) calls.add(callee);
    if (!hook || callee?.type !== 'Identifier' || callee.name !== hook.local) {
      out.push({ severity: 'error', message: `Mark text through the placement's hook (${example}, with ${CODE_TEXT_HOOK} taken from $props()): any other value would be written into the published site.`, node: n });
      return;
    }
    if (!optional || !call!.optional) {
      out.push({ severity: 'error', message: `Call ${hook.local} with ?. (${example}): the published site is given no hook, and a plain call would fail there.`, node: n });
      return;
    }
    const args = (call!.arguments as Node[]) ?? [];
    const written = args.some((a) => a.type === 'SpreadElement') ? null : literalText(args[0]);
    const path = written === null ? null : parseCodeTextPath(written);
    if (path === null) {
      out.push({ severity: 'error', message: written === null ? `Name the text marked with its property written out (${example}): the editor cannot tell which property an expression names.` : `“${written}” is not a property (“heading”) or a list's field (“features.title”).`, node: n });
      return;
    }
    const none = (a: Node | undefined) => (a?.type === 'Literal' && a.value === null) || (a?.type === 'Identifier' && a.name === 'undefined');
    if (path.field !== undefined && (args.length !== 2 || none(args[1]))) {
      out.push({ severity: 'error', message: `Give the item's ID with a list's field (${hook.local}?.('${written}', item.id)), so the editor knows which item the text is.`, node: n });
      return;
    }
    if (path.field === undefined && args.length !== 1) {
      out.push({ severity: 'error', message: `“${written}” is a property, not a list's field: mark it without an item (${hook.local}?.('${written}')).`, node: n });
      return;
    }
    if (!properties) return;
    const field = codeTextField(properties, path);
    if ('problem' in field) out.push({ severity: 'error', message: `${field.problem} Mark only text the component declares.`, node: n });
  });
  // The hook is the preview's, given to this placement alone. Handed on to a component the code places (by name, in a
  // spread or bound), replaced, or passed to a function or snippet, it could write a marker into the published site,
  // or have that component's text name this one's properties.
  const placed = (a: Node | undefined) => /^(Component|SvelteComponent|SvelteSelf)$/.test(String(a?.type));
  const handOn = `${CODE_TEXT_HOOK} is the editor's hook for this component's own text: use it only to mark text (${example}), never pass it on or replace it.`;
  walkAst(ast.fragment, (n, around) => {
    const host = around[around.length - 1];
    if (!placed(host)) return;
    const named = (n.type === 'Attribute' || n.type === 'BindDirective') && n.name === CODE_TEXT_HOOK;
    const spread = n.type === 'SpreadAttribute' && (n.expression as Node)?.type === 'ObjectExpression' && (((n.expression as Node).properties as Node[]) ?? []).some((p) => p.type === 'Property' && ((p.key as Node)?.type === 'Identifier' ? (p.key as Node).name : (p.key as Node)?.value) === CODE_TEXT_HOOK);
    if (named || spread) out.push({ severity: 'error', message: handOn, node: n });
  });
  if (hook) {
    const props = (a: Node) => a.type === 'VariableDeclarator' && ((a.init as Node | null)?.callee as Node | undefined)?.type === 'Identifier' && ((a.init as Node).callee as Node).name === '$props';
    for (const root of [ast.instance, ast.fragment])
      walkAst(root, (n, around) => {
        if (n.type !== 'Identifier' || n.name !== hook.local || calls.has(n) || around.some(props) || around.some((a) => String(a.type).startsWith('TS'))) return;
        const parent = around[around.length - 1];
        // A property of something else (`config.mark`, `{ mark: 1 }`) only shares the name, and so does a name a
        // function, a list's items or a snippet declares for its own values.
        if ((parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) || (parent?.type === 'Property' && parent.key === n && !parent.computed && parent.value !== n)) return;
        if (around.some((a) => declares(a, hook.local))) return;
        const given = around.some((a, i) => (a.type === 'Attribute' || a.type === 'SpreadAttribute' || a.type === 'BindDirective') && placed(around[i - 1]));
        const replaced = (parent?.type === 'AssignmentExpression' && parent.left === n) || (parent?.type === 'UpdateExpression' && parent.argument === n);
        const passed = (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && ((parent.arguments as Node[]) ?? []).includes(n);
        if (given || replaced || passed) out.push({ severity: 'error', message: handOn, node: n });
      });
  }
  return out;
}

/** Whether a function, an {#each} or a snippet declares `name` for its own values, hiding the one around it. */
function declares(scope: Node, name: string): boolean {
  const patterns: unknown[] =
    scope.type === 'ArrowFunctionExpression' || scope.type === 'FunctionExpression' || scope.type === 'FunctionDeclaration'
      ? (scope.params as Node[])
      : scope.type === 'EachBlock'
        ? [scope.context, scope.index]
        : scope.type === 'SnippetBlock'
          ? (scope.parameters as Node[])
          : [];
  let found = false;
  for (const p of patterns) {
    if (typeof p === 'string') found ||= p === name;
    else walkAst(p, (n) => void (n.type === 'Identifier' && n.name === name && (found = true)));
  }
  return found;
}

/** An attribute's name as it reaches the page: an HTML element's whatever its case, a component's prop as written. */
const attrName = (attr: Node, host: Node | undefined) => (host?.type === 'RegularElement' ? String(attr.name).toLowerCase() : String(attr.name));

/**
 * A code component's source with every editor marker (see shared/code-markers.ts) taken out, as both exports ship it,
 * and the text hook (see shared/code-text.ts) out of its $props() once nothing reads it. The markers and the hook are
 * the editor's, written in the code so the preview can find what it edits; the published site carries neither. Source
 * that cannot be parsed is returned as it is: it does not build either.
 */
export async function withoutCodeMarkers(source: string): Promise<string> {
  if (!mentionsCodeMarker(source) && !source.includes(CODE_TEXT_HOOK)) return source;
  const { parse } = await import('svelte/compiler');
  // The parser reads past a byte order mark, so its offsets count from after it.
  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const body = source.slice(bom);
  let ast: Node;
  try {
    ast = parse(body, { modern: true }) as unknown as Node;
  } catch {
    return source;
  }
  const markers: Node[] = [];
  walkAst(ast.fragment, (n, around) => {
    const host = around[around.length - 1];
    if (n.type === 'Attribute' && isCodeMarker(String(n.name)) && host && Array.isArray(host.attributes)) markers.push(n);
  });
  const cuts = markers.map((attr) => {
    let start = Number(attr.start);
    const end = Number(attr.end);
    // With the space before it when the tag goes on with a space or ends there, so the tag reads as if the
    // attribute was never written; otherwise that space is what parts its neighbours, and stays.
    if (/[\s/>]/.test(body[end] ?? '')) while (start > 0 && /\s/.test(body[start - 1])) start--;
    return { start, end };
  });
  const hook = unreadTextHook(ast, new Set(markers));
  if (hook) cuts.push(...propertyCuts(body, hook.pattern, hook.at));
  let out = body;
  for (const c of cuts.sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + out.slice(c.end);
  return source.slice(0, bom) + out;
}

/** Where the script's $props() pattern takes the text hook, when nothing but the markers reads the name it gives. */
function unreadTextHook(ast: Node, markers: ReadonlySet<Node>): { pattern: Node[]; at: number } | null {
  const prop = propsTaken(ast).get(CODE_TEXT_HOOK)?.node;
  if (!prop) return null;
  let value = prop.value as Node;
  if (value?.type === 'AssignmentPattern') {
    // A default that does something when it is worked out is the code's own.
    const fallback = value.right as Node;
    if (!literalValue(fallback) && !(fallback.type === 'Identifier' && fallback.name === 'undefined')) return null;
    value = value.left as Node;
  }
  if (value?.type !== 'Identifier') return null;
  const local = String(value.name);
  let read = false;
  let found: { pattern: Node[]; at: number } | null = null;
  for (const root of [ast.module, ast.instance, ast.fragment])
    walkAst(root, (n, around) => {
      if (n.type === 'ObjectPattern' && (n.properties as Node[]).includes(prop)) found = { pattern: n.properties as Node[], at: (n.properties as Node[]).indexOf(prop) };
      if (read || n === prop || around.includes(prop) || markers.has(n) || around.some((a) => markers.has(a))) return;
      // A property of something else (`note.so_text`, `{ so_text: 1 }`, a type's member) only shares the name.
      const parent = around[around.length - 1];
      if (parent && !parent.computed && ((parent.type === 'MemberExpression' && parent.property === n) || ((parent.type === 'Property' || parent.type === 'TSPropertySignature') && parent.key === n && parent.value !== n))) return;
      // `use:so_text`, `class:so_text` and `<so_text.Part>` read it by a name written on the node itself.
      const named = n.type === 'Identifier' || n.type === 'Component' || /Directive$/.test(String(n.type));
      // `$so_text` subscribes to it as a store.
      const name = named ? String(n.name).split('.')[0] : null;
      if (name === local || name === `$${local}`) read = true;
    });
  return read ? null : found;
}

/** Where the comma after a property is, past any space and comments; null when the next thing is not one. */
function commaAfter(body: string, from: number): number | null {
  // One token at a time from where the last ended, so a comment is never read into.
  const skip = /\s+|\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*/y;
  let at = from;
  for (skip.lastIndex = at; skip.test(body); ) at = skip.lastIndex;
  return body[at] === ',' ? at : null;
}

/**
 * What to cut so a destructured property reads as never written: its line when it has one to itself, and one comma.
 * Comments around it stay.
 */
function propertyCuts(body: string, pattern: Node[], at: number): Array<{ start: number; end: number }> {
  const start = Number(pattern[at].start);
  const end = Number(pattern[at].end);
  const comma = commaAfter(body, end);
  // A comment between the property and its comma: each goes by itself.
  if (comma !== null && body.slice(end, comma).trim()) return [{ start, end }, { start: comma, end: comma + 1 }];
  const after = comma === null ? end : comma + 1;
  const lineStart = body.lastIndexOf('\n', start - 1) + 1;
  const newline = /^[\t ]*\r?\n/.exec(body.slice(after))?.[0].length;
  const ownLine = newline !== undefined && !body.slice(lineStart, start).trim();
  // The last of the list, with no comma of its own, takes the one that led to it.
  const previous = at > 0 ? Number(pattern[at - 1].end) : null;
  if (comma === null && previous !== null && /^\s*,\s*$/.test(body.slice(previous, start))) {
    const led = body.indexOf(',', previous);
    return ownLine ? [{ start: led, end: led + 1 }, { start: lineStart, end: end + newline }] : [{ start: led, end }];
  }
  if (ownLine) return [{ start: lineStart, end: after + newline }];
  const space = /^[\t ]*/.exec(body.slice(after))![0].length;
  // The only property leaves `{}`.
  if (pattern.length === 1 && body[start - 1] === ' ' && body[after + space] === '}') return [{ start: start - 1, end: after + space }];
  return [{ start, end: after + space }];
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
