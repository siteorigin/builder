/**
 * The site's name where the shared header and footer show it (#31). A brand label that says the site's name follows
 * it when the site is renamed, and so does the footer's copyright line while the holder it names right after the ©
 * and year is the site. A label or line that says something else is the author's own, and a rename keeps it.
 *
 * What a placement shows says whether it follows, so the editor can say so beside the field, and the engine applies
 * the rule to every rename alike, made by hand or by the AI. The one case the text cannot tell is the author's own
 * label that a rename makes equal to the site's name (a masthead the site is then named after): the placement keeps
 * that label through later renames (`InstanceNode.keepsText`) until the author edits it.
 */
import type { ComponentDefinition, InstanceNode, ProjectState } from './types';
import type { ShellPart } from './page-shell';

/** The property a shared header or footer shows the site's name in. */
export const BRAND_PROP = 'siteName';
/** The footer property that holds its copyright line. */
export const COPYRIGHT_PROP = 'copyright';
/** The properties that follow the site's name. */
const BRAND_TEXT = [BRAND_PROP, COPYRIGHT_PROP] as const;

/** A property that holds plain text in this design. */
const textProp = (def: ComponentDefinition, prop: string) => Object.hasOwn(def.properties, prop) && def.properties[prop].type === 'string';

/** The text a placement shows for a property: its own, or the design's default. */
function shown(def: ComponentDefinition, node: InstanceNode, prop: string): string | undefined {
  const v = Object.hasOwn(node.props, prop) ? node.props[prop] : def.properties[prop].default;
  return typeof v === 'string' ? v : undefined;
}

/** The shared header and footer themselves: each one's top-level placement whose design shows the site's name. */
export function brandPlacements(state: ProjectState): Array<{ part: ShellPart; node: InstanceNode; def: ComponentDefinition }> {
  const out: Array<{ part: ShellPart; node: InstanceNode; def: ComponentDefinition }> = [];
  for (const part of ['header', 'footer'] as const) {
    const tree = state.site.shell[part];
    for (const id of tree?.rootIds ?? []) {
      const node = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
      if (node?.kind !== 'instance') continue;
      const def = Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
      if (def && textProp(def, BRAND_PROP)) out.push({ part, node, def });
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The copyright line with `next` in place of `previous`, when the line gives `previous` as its holder: right after
 * the © and the year (or years), and ending there or at a full stop. Null for any other line, such as one naming
 * "Acme, Inc." or "Acme Photography" for a site called Acme.
 */
export function renamedCopyright(line: string, previous: string, next: string): string | null {
  if (!previous) return null;
  const m = line.match(new RegExp(`^(©\\s*\\d{4}(?:\\s*[-–—]\\s*\\d{4})?\\s+)${escape(previous)}(?=$|\\.(?:\\s|$))`));
  return m ? `${m[1]}${next}${line.slice(m[0].length)}` : null;
}

/** Whether a property's text says the site's name `name`: the whole brand label, or the copyright line's holder. */
function says(prop: string, text: string, name: string): boolean {
  return prop === BRAND_PROP ? text.trim() === name : renamedCopyright(text, name, name) !== null;
}

/** The brand properties a placement keeps through renames (see InstanceNode.keepsText). */
const kept = (node: InstanceNode): string[] => (Array.isArray(node.keepsText) ? node.keepsText.filter((p): p is string => typeof p === 'string') : []);

function setKept(node: InstanceNode, props: Iterable<string>) {
  const list = [...props];
  if (list.length) node.keepsText = list;
  else delete node.keepsText;
}

/** An edit of a property makes its text the author's choice again: it follows the site's name if it says it. */
export function releaseKept(node: InstanceNode, prop: string): void {
  if (kept(node).includes(prop)) setKept(node, kept(node).filter((p) => p !== prop));
}

/**
 * Whether a placement's property follows the site's name: `true` or `false` for the brand label and the copyright
 * line of the shared header or footer, `undefined` for any other property or placement.
 */
export function followsSiteName(state: ProjectState, node: InstanceNode, prop: string): boolean | undefined {
  const placed = brandPlacements(state).find((p) => p.node === node);
  if (!placed || !(BRAND_TEXT as readonly string[]).includes(prop) || !textProp(placed.def, prop)) return undefined;
  const text = shown(placed.def, node, prop);
  return text !== undefined && !kept(node).includes(prop) && says(prop, text, state.site.name);
}

/**
 * Carries a rename from `previous` to `next` into the shared header and footer: each brand label that says the old
 * name, and each copyright line that gives it as its holder, now says the new one. Everything else is kept, and an
 * author's label the new name happens to match is marked to stay as it is.
 */
export function carrySiteName(state: ProjectState, previous: string, next: string): void {
  if (previous === next) return;
  for (const { node, def } of brandPlacements(state)) {
    const keep = new Set(kept(node));
    for (const prop of BRAND_TEXT) {
      if (!textProp(def, prop)) continue;
      const text = shown(def, node, prop);
      // Kept until now: it keeps its text, which differs from the site's name from here on.
      const wasKept = keep.delete(prop);
      if (text === undefined) continue;
      if (!wasKept && says(prop, text, previous)) node.props[prop] = prop === BRAND_PROP ? next : renamedCopyright(text, previous, next)!;
      else if (says(prop, text, next)) keep.add(prop);
    }
    setKept(node, keep);
  }
}
