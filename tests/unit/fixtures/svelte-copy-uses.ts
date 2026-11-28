/**
 * How a code component's Svelte source uses one of its properties, read from the parsed source, for the check that
 * the copy Builder lets a live session's Copy Editor change on Foundation's code sections (src/engine/shipped-copy.ts)
 * is copy in the release's own markup. Strict on purpose: any use it does not know is a problem, so a release that
 * starts using a property some other way fails the check until someone looks.
 *
 * A property is copy when every reference to it is one of:
 * - `has(prop)`, the site's runtime test of whether it shows, which a Copy Editor's edit never changes;
 * - `{prop}`, the words of a text element (or of a `<svelte:element>` whose tag is a heading-only choice), outside
 *   any link, button, list (`{#each}`), snippet or component;
 * - the picture of the runtime's `<SoImage image={prop}>`, or the rich text of its `<SoRichText value={prop}>`, under
 *   the same conditions.
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
/** The runtime's own modules, as a shipped component imports them. */
const RUNTIME = { has: /(^|\/)runtime\/util\.js$/, SoImage: /(^|\/)runtime\/Image\.svelte$/, SoRichText: /(^|\/)runtime\/RichText\.svelte$/ };
/** Keys of the parsed source that hold no code. */
const SKIP = new Set(['css', 'comments', 'options', 'metadata', 'loc', 'name_loc', 'start', 'end']);

export interface CopyUses {
  /** What each reference shows, in source order. */
  uses: CopyUse[];
  /** Every reference that is not one of the uses above, and anything else that keeps the check from holding. */
  problems: string[];
}

/** How `source` uses its property `prop`, whose schemas (all of the component's) are `properties`. */
export function copyUses(source: string, prop: string, properties: Record<string, PropSchema>): CopyUses {
  const problems: string[] = [];
  const uses: CopyUse[] = [];
  const root = parse(source, { modern: true }) as unknown as AstNode & { instance?: { content: AstNode & { body: AstNode[] } }; module?: unknown };
  const lineOf = (n: AstNode) => (typeof n.start === 'number' ? source.slice(0, n.start).split('\n').length : '?');
  const body = root.instance?.content.body ?? [];

  // The names the runtime's helpers are imported under.
  const local = { has: undefined as string | undefined, SoImage: undefined as string | undefined, SoRichText: undefined as string | undefined };
  for (const s of body) {
    if (s.type !== 'ImportDeclaration') continue;
    const from = String((s.source as { value: unknown }).value);
    for (const spec of s.specifiers as AstNode[]) {
      const name = (spec.local as { name: string }).name;
      if (spec.type === 'ImportSpecifier' && (spec.imported as { name: string }).name === 'has' && RUNTIME.has.test(from)) local.has = name;
      if (spec.type === 'ImportDefaultSpecifier' && name === 'SoImage' && RUNTIME.SoImage.test(from)) local.SoImage = name;
      if (spec.type === 'ImportDefaultSpecifier' && name === 'SoRichText' && RUNTIME.SoRichText.test(from)) local.SoRichText = name;
    }
  }

  // The property as `$props()` gives it: by its own name, never renamed (a rename is a second name to follow).
  const declared = new Set<unknown>();
  for (const s of body) {
    if (s.type !== 'VariableDeclaration') continue;
    for (const d of s.declarations as AstNode[]) {
      const init = d.init as AstNode | null;
      if (init?.type !== 'CallExpression' || (init.callee as AstNode).type !== 'Identifier' || (init.callee as { name: string }).name !== '$props') continue;
      const pattern = d.id as AstNode;
      if (pattern.type !== 'ObjectPattern') {
        problems.push(`$props() is not destructured, so “${prop}” cannot be followed.`);
        continue;
      }
      for (const p of pattern.properties as AstNode[]) {
        if (p.type !== 'Property' || (p.key as { name?: string }).name !== prop) continue;
        const value = p.value as AstNode;
        const binding = value.type === 'AssignmentPattern' ? (value.left as AstNode) : value;
        if (binding.type !== 'Identifier' || (binding as { name: string }).name !== prop) problems.push(`“${prop}” is taken from $props() under another name.`);
        declared.add(p.key);
        declared.add(binding);
      }
    }
  }
  if (!declared.size) problems.push(`“${prop}” is not taken from $props().`);

  /** Whether everything from `chain[from]` up to the root is layout or text a property may show inside. */
  const placedPlainly = (chain: AstNode[], from: number, what: string, n: AstNode): boolean => {
    for (let i = from; i >= 0; i--) {
      const a = chain[i];
      if (a.type === 'Fragment' || a.type === 'IfBlock' || a.type === 'Root') continue;
      if (a.type === 'RegularElement' && CONTAINERS.has(String(a.name))) continue;
      if (a.type === 'SvelteElement' && headingTag(a)) continue;
      problems.push(`${what} at line ${lineOf(n)} is inside ${a.type === 'RegularElement' || a.type === 'Component' ? `<${String(a.name)}>` : a.type}.`);
      return false;
    }
    return true;
  };
  /** Whether a `<svelte:element>`'s tag is a text element, or a choice of headings and paragraphs. */
  const headingTag = (el: AstNode): boolean => {
    const tag = el.tag as AstNode | string;
    if (typeof tag === 'string') return TEXT_ELEMENTS.has(tag);
    if (tag.type === 'Literal') return TEXT_ELEMENTS.has(String(tag.value));
    if (tag.type !== 'Identifier') return false;
    const schema = Object.hasOwn(properties, String(tag.name)) ? properties[String(tag.name)] : undefined;
    return schema?.type === 'enum' && schema.options.length > 0 && schema.options.every((o) => /^(h[1-6]|p|span|div)$/.test(o.value));
  };

  const reference = (n: AstNode, chain: AstNode[]) => {
    const parent = chain.at(-1)!;
    if (parent.type === 'CallExpression' && local.has && (parent.callee as AstNode).type === 'Identifier' && (parent.callee as { name: string }).name === local.has) {
      if ((parent.arguments as AstNode[]).length === 1 && (parent.arguments as AstNode[])[0] === n) return void uses.push('presence');
    }
    if (parent.type === 'ExpressionTag' && parent.expression === n) {
      const holder = chain.at(-2);
      if (holder?.type === 'Fragment') {
        const el = chain.at(-3);
        const ok = (el?.type === 'RegularElement' && TEXT_ELEMENTS.has(String(el.name))) || (el?.type === 'SvelteElement' && headingTag(el));
        if (ok && placedPlainly(chain, chain.length - 4, `“${prop}”`, n)) return void uses.push('text');
        if (!ok) return void problems.push(`“${prop}” at line ${lineOf(n)} is the words of ${el?.type === 'RegularElement' || el?.type === 'Component' ? `<${String(el.name)}>` : (el?.type ?? 'nothing')}.`);
        return;
      }
      if (holder?.type === 'Attribute') {
        const owner = chain.at(-3);
        const kind = owner?.type === 'Component' && owner.name === local.SoImage && holder.name === 'image' ? 'image' : owner?.type === 'Component' && owner.name === local.SoRichText && holder.name === 'value' ? 'rich' : null;
        if (kind && placedPlainly(chain, chain.length - 4, `“${prop}”`, n)) return void uses.push(kind);
        if (!kind) return void problems.push(`“${prop}” at line ${lineOf(n)} is the ${String(holder.name)} attribute of ${owner?.type === 'RegularElement' || owner?.type === 'Component' ? `<${String(owner.name)}>` : (owner?.type ?? 'nothing')}.`);
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
