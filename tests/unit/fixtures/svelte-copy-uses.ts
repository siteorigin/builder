/**
 * How a code component's Svelte source uses one of its properties, read from the parsed source, for the check that
 * the copy Builder lets a live session's Copy Editor change on Foundation's code sections (src/engine/shipped-copy.ts)
 * is copy in the release's own markup. Strict on purpose: any use it does not know is a problem, so a release that
 * starts using a property some other way fails the check until someone looks.
 *
 * A property is copy when every reference to it is one of:
 * - `has(prop)`, the site's runtime test of whether it shows, which a Copy Editor's edit never changes: read only
 *   through operators on true and false into an `{#if}`, a markup expression or a top-level `$derived(…)`, never where
 *   a function, an effect or another call could run again when it is reworded;
 * - `{prop}`, the words of a text element (or of a `<svelte:element>` whose tag is a property choosing only headings
 *   and paragraphs);
 * - the picture of the runtime's `<SoImage image={prop}>`, or the rich text of its `<SoRichText value={prop}>`, given
 *   nothing else that changes how they show it.
 * Each shown outside any link, button, control, list (`{#each}`), snippet or other component, and in no element that
 * acts (a role, a tab stop, an event handler) or that something else may name by its ID.
 */
import { parse } from 'svelte/compiler';
import type { PropSchema } from '@shared/types';

/** What a use shows: words, rich text, a picture; or only whether it is set. */
export type CopyUse = 'presence' | 'text' | 'rich' | 'image';

type AstNode = { type: string; start?: number; [key: string]: unknown };

/** Elements whose words a property may be. */
const TEXT_ELEMENTS = new Set(['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'div', 'strong', 'em', 'small', 'dt', 'dd', 'li', 'blockquote', 'cite']);
/** Elements a shown property may sit inside: layout and text, never a link, a button, a control or a label. */
const CONTAINERS = new Set([...TEXT_ELEMENTS, 'section', 'header', 'footer', 'figure', 'article', 'aside', 'main', 'hgroup', 'ul', 'ol', 'dl']);
/** The runtime's own modules, exactly as a shipped component imports them. */
const RUNTIME = { has: '../runtime/util.js', SoImage: '../runtime/Image.svelte', SoRichText: '../runtime/RichText.svelte' };
/** What else each runtime component may be given beside the property it shows: none of it changes how it shows it. */
const HELPER_ATTRIBUTES: Record<'image' | 'rich', Set<string>> = { image: new Set(['image', 'eager', 'class', 'sizes', 'fallbackAlt']), rich: new Set(['value', 'class', 'data-so-text']) };
/** Keys of the parsed source that hold no code. */
const SKIP = new Set(['css', 'comments', 'options', 'metadata', 'loc', 'name_loc', 'start', 'end']);

export interface CopyUses {
  /** What each reference shows. */
  uses: CopyUse[];
  /** Every reference that is not one of the uses above, and anything else that keeps the check from holding. */
  problems: string[];
}

/** The names a pattern (`a`, `{ a, b: c }`, `[a, ...b]`, `a = 1`) binds. */
function boundBy(pattern: unknown): string[] {
  const p = pattern as AstNode | null;
  if (!p) return [];
  if (p.type === 'Identifier') return [String(p.name)];
  if (p.type === 'ObjectPattern') return (p.properties as AstNode[]).flatMap((q) => boundBy(q.type === 'RestElement' ? q.argument : q.value));
  if (p.type === 'ArrayPattern') return (p.elements as unknown[]).flatMap(boundBy);
  if (p.type === 'AssignmentPattern') return boundBy(p.left);
  if (p.type === 'RestElement') return boundBy(p.argument);
  return [];
}

/** How `source` uses its property `prop`, whose schemas (all of the component's) are `properties`. */
export function copyUses(source: string, prop: string, properties: Record<string, PropSchema>): CopyUses {
  const problems: string[] = [];
  const uses: CopyUse[] = [];
  const root = parse(source, { modern: true }) as unknown as AstNode & { fragment: AstNode; instance?: { content: AstNode & { body: AstNode[] } } };
  const lineOf = (n: AstNode) => (typeof n.start === 'number' ? source.slice(0, n.start).split('\n').length : '?');
  const body = root.instance?.content.body ?? [];
  const named = (n: AstNode | undefined) => (n?.type === 'RegularElement' || n?.type === 'Component' ? `<${String(n.name)}>` : (n?.type ?? 'nothing'));

  // The names the runtime's helpers are imported under, from the runtime itself.
  const local = { has: undefined as string | undefined, SoImage: undefined as string | undefined, SoRichText: undefined as string | undefined };
  for (const s of body) {
    if (s.type !== 'ImportDeclaration') continue;
    const from = String((s.source as { value: unknown }).value);
    for (const spec of s.specifiers as AstNode[]) {
      const name = String((spec.local as AstNode).name);
      if (spec.type === 'ImportSpecifier' && (spec.imported as AstNode).name === 'has' && from === RUNTIME.has) local.has = name;
      if (spec.type === 'ImportDefaultSpecifier' && name === 'SoImage' && from === RUNTIME.SoImage) local.SoImage = name;
      if (spec.type === 'ImportDefaultSpecifier' && name === 'SoRichText' && from === RUNTIME.SoRichText) local.SoRichText = name;
    }
  }

  // The properties as `$props()` gives them, each by its own name (a rename is a second name to follow).
  const declared = new Set<unknown>();
  const propNames = new Set<string>();
  let propsCalls = 0;
  const propsDeclarators = new Set<unknown>();
  for (const s of body) {
    if (s.type !== 'VariableDeclaration') continue;
    for (const d of s.declarations as AstNode[]) {
      const init = d.init as AstNode | null;
      if (init?.type !== 'CallExpression' || (init.callee as AstNode).type !== 'Identifier' || (init.callee as AstNode).name !== '$props') continue;
      propsCalls++;
      propsDeclarators.add(d);
      const pattern = d.id as AstNode;
      if (pattern.type !== 'ObjectPattern') {
        problems.push(`$props() is not destructured, so “${prop}” cannot be followed.`);
        continue;
      }
      for (const p of pattern.properties as AstNode[]) {
        if (p.type !== 'Property') continue;
        const key = String((p.key as AstNode).name ?? '');
        const value = p.value as AstNode;
        const binding = value.type === 'AssignmentPattern' ? (value.left as AstNode) : value;
        if (binding.type === 'Identifier' && binding.name === key) propNames.add(key);
        if (key !== prop) continue;
        if (binding.type !== 'Identifier' || binding.name !== prop) problems.push(`“${prop}” is taken from $props() under another name.`);
        declared.add(p.key);
        declared.add(binding);
      }
    }
  }
  if (propsCalls > 1) problems.push('$props() is called more than once.');
  if (!declared.size) problems.push(`“${prop}” is not taken from $props().`);

  // Every other name the source binds: a variable, a parameter, a list's item, a snippet's, a `let:` or `{@const}`.
  const rebound = new Set<string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(collect);
    const n = value as AstNode;
    if (typeof n.type !== 'string') return;
    if (n.type === 'VariableDeclarator' && !propsDeclarators.has(n)) boundBy(n.id).forEach((x) => rebound.add(x));
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      boundBy(n.id).forEach((x) => rebound.add(x));
      ((n.params as unknown[] | undefined) ?? []).flatMap(boundBy).forEach((x) => rebound.add(x));
    }
    if (n.type === 'CatchClause') boundBy(n.param).forEach((x) => rebound.add(x));
    if (n.type === 'EachBlock') boundBy(n.context).forEach((x) => rebound.add(x));
    if (n.type === 'EachBlock' && typeof n.index === 'string') rebound.add(n.index);
    if (n.type === 'SnippetBlock') (n.parameters as unknown[]).flatMap(boundBy).forEach((x) => rebound.add(x));
    if (n.type === 'LetDirective') [String(n.name), ...boundBy(n.expression)].forEach((x) => rebound.add(x));
    if (n.type === 'AwaitBlock') [...boundBy(n.value), ...boundBy(n.error)].forEach((x) => rebound.add(x));
    if (n.type === 'ClassDeclaration') boundBy(n.id).forEach((x) => rebound.add(x));
    for (const [k, v] of Object.entries(n)) if (!SKIP.has(k)) collect(v);
  };
  collect(root);
  for (const [helper, name] of Object.entries(local)) if (name && rebound.has(name)) problems.push(`“${name}” is bound again, so it may not be the runtime’s ${helper}.`);
  if (rebound.has(prop)) problems.push(`“${prop}” is bound again besides $props().`);

  /** Why an element acts, or may be named by its ID, so that words inside it are more than copy; null when neither. */
  const acts = (el: AstNode): string | null => {
    for (const a of (el.attributes as AstNode[] | undefined) ?? []) {
      if (a.type === 'SpreadAttribute') return 'is given attributes it spreads';
      if (a.type === 'OnDirective') return 'handles events';
      if (a.type !== 'Attribute') continue;
      const name = String(a.name).toLowerCase();
      if (name === 'role' || name === 'tabindex' || name === 'contenteditable' || name.startsWith('on')) return `has ${name}`;
      // The section's own anchor is the only ID: any other may name a landmark, a control or a description.
      const value = a.value as AstNode | true;
      if (name === 'id' && !(value !== true && !Array.isArray(value) && value.type === 'ExpressionTag' && (value.expression as AstNode).type === 'Identifier' && (value.expression as AstNode).name === 'so_id')) return 'has an ID';
    }
    return null;
  };
  /** Whether everything from `chain[from]` up to the root is layout or text a property may show inside. */
  const placedPlainly = (chain: AstNode[], from: number, n: AstNode): boolean => {
    for (let i = from; i >= 0; i--) {
      const a = chain[i];
      if (a.type === 'Fragment' || a.type === 'IfBlock' || a.type === 'Root') continue;
      const element = (a.type === 'RegularElement' && CONTAINERS.has(String(a.name))) || (a.type === 'SvelteElement' && headingTag(a));
      const why = element ? acts(a) : null;
      if (element && !why) continue;
      problems.push(`“${prop}” at line ${lineOf(n)} is inside ${named(a)}${why ? `, which ${why}` : ''}.`);
      return false;
    }
    return true;
  };
  /** Whether a `<svelte:element>`'s tag is a text element, or a property choosing only headings and paragraphs. */
  const headingTag = (el: AstNode): boolean => {
    const tag = el.tag as AstNode | string;
    if (typeof tag === 'string') return TEXT_ELEMENTS.has(tag);
    if (tag.type === 'Literal') return TEXT_ELEMENTS.has(String(tag.value));
    const name = String(tag.name);
    if (tag.type !== 'Identifier' || !propNames.has(name) || rebound.has(name)) return false;
    const schema = Object.hasOwn(properties, name) ? properties[name] : undefined;
    return schema?.type === 'enum' && schema.options.length > 0 && schema.options.every((o) => /^(h[1-6]|p|span|div)$/.test(o.value));
  };
  /**
   * Whether a presence test (`chain` ends at the `has()` call) is read again with nothing running again: only through
   * operators on true and false, into an `{#if}`, a markup expression, or a `$derived(…)` the script declares at its
   * top. Anything else (a function, an effect, another call) could do more each time the words change.
   */
  const PURE = new Set(['LogicalExpression', 'UnaryExpression', 'ConditionalExpression', 'BinaryExpression']);
  const settled = (chain: AstNode[]): boolean => {
    let i = chain.length - 1;
    while (i > 0 && PURE.has(chain[i - 1].type)) i--;
    const into = chain[i - 1];
    if (into?.type === 'IfBlock' && into.test === chain[i]) return true;
    if (into?.type === 'ExpressionTag' && chain.includes(root.fragment)) return true;
    const derived = into?.type === 'CallExpression' && (into.callee as AstNode).type === 'Identifier' && (into.callee as AstNode).name === '$derived';
    return derived && chain[i - 2]?.type === 'VariableDeclarator' && chain[i - 3]?.type === 'VariableDeclaration' && chain[i - 4] === root.instance?.content;
  };

  const reference = (n: AstNode, chain: AstNode[]) => {
    const parent = chain.at(-1)!;
    const args = parent.arguments as AstNode[] | undefined;
    if (parent.type === 'CallExpression' && local.has && (parent.callee as AstNode).type === 'Identifier' && (parent.callee as AstNode).name === local.has && args?.length === 1 && args[0] === n) {
      if (!settled(chain)) return void problems.push(`“${prop}” at line ${lineOf(n)} is tested for being set where more than the test may run again.`);
      return void uses.push('presence');
    }
    if (parent.type === 'ExpressionTag' && parent.expression === n) {
      const holder = chain.at(-2);
      if (holder?.type === 'Fragment') {
        const el = chain.at(-3);
        const text = (el?.type === 'RegularElement' && TEXT_ELEMENTS.has(String(el.name))) || (el?.type === 'SvelteElement' && headingTag(el));
        if (!text) return void problems.push(`“${prop}” at line ${lineOf(n)} is the words of ${named(el)}.`);
        if (placedPlainly(chain, chain.length - 3, n)) uses.push('text');
        return;
      }
      if (holder?.type === 'Attribute') {
        const owner = chain.at(-3);
        const kind = owner?.type === 'Component' && owner.name === local.SoImage && holder.name === 'image' ? 'image' : owner?.type === 'Component' && owner.name === local.SoRichText && holder.name === 'value' ? 'rich' : null;
        if (!kind) return void problems.push(`“${prop}” at line ${lineOf(n)} is the ${String(holder.name)} attribute of ${named(owner)}.`);
        // The whole value, and nothing beside it that changes how the runtime shows it.
        const others = (owner!.attributes as AstNode[]).filter((a) => a !== holder);
        const extra = others.find((a) => a.type !== 'Attribute' || !HELPER_ATTRIBUTES[kind].has(String(a.name)) || a.name === holder.name);
        if (holder.value !== parent) return void problems.push(`“${prop}” at line ${lineOf(n)} is part of the ${String(holder.name)} given to ${named(owner)}.`);
        if (extra) return void problems.push(`“${prop}” at line ${lineOf(n)} is shown by ${named(owner)} given ${extra.type === 'Attribute' ? `“${String(extra.name)}”` : extra.type}.`);
        if (placedPlainly(chain, chain.length - 4, n)) uses.push(kind);
        return;
      }
    }
    problems.push(`“${prop}” at line ${lineOf(n)} is used in a ${parent.type}${chain.at(-2) ? ` inside a ${chain.at(-2)!.type}` : ''}.`);
  };

  const walk = (value: unknown, chain: AstNode[]) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach((v) => walk(v, chain));
    const n = value as AstNode;
    if (typeof n.type !== 'string') return;
    // A directive named by the property (`style:heading`, `class:heading`) reads it with no identifier to follow.
    if (n.type.endsWith('Directive') && n.name === prop) problems.push(`“${prop}” at line ${lineOf(n)} names a ${n.type}.`);
    if (n.type === 'Identifier' && n.name === prop && !declared.has(n)) {
      const parent = chain.at(-1);
      // A property of something else (`so_o?.heading`), or an object's key, is not the property.
      const member = parent?.type === 'MemberExpression' && parent.property === n && !parent.computed;
      const key = parent?.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand;
      if (!member && !key) reference(n, chain);
    }
    for (const [k, v] of Object.entries(n)) if (!SKIP.has(k)) walk(v, [...chain, n]);
  };
  walk(root, []);
  return { uses, problems };
}
