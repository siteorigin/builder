/**
 * WebMCP: what the website declares to AI agents running in a visitor's browser, so they act on it through named tools
 * rather than by reading its markup (https://github.com/webmachinelearning/webmcp). Off unless the author turns it on
 * (`SiteDoc.webmcp`). While it is on, each contact form the website shows is a tool of its own, declared by its
 * markup (`toolname` and `tooldescription` on the form, `toolparamdescription` on each field), and a website that
 * searches itself offers a read-only `search_site` tool, registered in browsers that know WebMCP. Browsers that don't
 * ignore all of it. The form is never sent on an agent's say-so: the browser fills it in and the visitor sends it.
 */
import type { ComponentDefinition, InstanceNode, SiteDoc } from './types';
import { isFormDefinition } from './form-contract';

/** The read-only tool a website that searches itself registers. No form takes its name. */
export const WEBMCP_SEARCH_TOOL = 'search_site';

/**
 * The most characters a tool name keeps. WebMCP allows 128; agents show them, and shorter names read better there.
 */
export const WEBMCP_NAME_MAX = 64;
/** The most characters a tool's or a field's description keeps. */
export const WEBMCP_DESCRIPTION_MAX = 500;

/** Whether the website declares its tools: only while the author turned it on (a hand-edited value of another kind is off). */
export function webMcpOn(site: Pick<SiteDoc, 'webmcp'>): boolean {
  return site.webmcp === true;
}

/**
 * Text as a tool name: letters without their accents, digits, "_", "-" and ".", with every run of anything else one
 * "_", and none at either end, cut to WEBMCP_NAME_MAX. Empty when nothing of it is left. The case is kept.
 */
export function webMcpToolName(text: unknown): string {
  if (typeof text !== 'string') return '';
  const name = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
  return name.slice(0, WEBMCP_NAME_MAX).replace(/[_.-]+$/, '');
}

/** Text as a description: on one line, trimmed, and cut at a word to WEBMCP_DESCRIPTION_MAX with "…". Empty for anything that isn't text. */
export function webMcpText(text: unknown, max = WEBMCP_DESCRIPTION_MAX): string {
  if (typeof text !== 'string') return '';
  const line = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  const chars = [...line];
  if (chars.length <= max) return line;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The names in order, each its own: a name taken already (by `taken`, or by one before it) gets the first free number
 * after it ("contact", "contact_2", "contact_3"), still within WEBMCP_NAME_MAX. Names are told apart whatever their case.
 */
export function uniqueToolNames(names: readonly string[], taken: Iterable<string> = [WEBMCP_SEARCH_TOOL]): string[] {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  return names.map((wanted) => {
    let name = wanted;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const suffix = `_${i}`;
      name = `${wanted.slice(0, WEBMCP_NAME_MAX - suffix.length).replace(/[_.-]+$/, '')}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * Whether a definition is one of the theme's forms (the Contact form or the Signup form) or a copy of one (whose
 * provenance still names it), the forms a placement can name as a tool. Whether its code takes the tool attributes is
 * the generator's to tell (generator/webmcp.ts).
 */
export function isWebMcpForm(def: ComponentDefinition | undefined): def is ComponentDefinition {
  return !!def && def.kind === 'code' && isFormDefinition(def);
}

/** The most characters a placement's own tool name keeps, as typed. */
export const WEBMCP_TYPED_NAME_MAX = 128;

/** A placement's own tool name and description, as typed; empty for one it has not given (or a hand-edited value of another kind). */
export function toolOverrides(node: Pick<InstanceNode, 'webmcp'>): { toolName: string; toolDescription: string } {
  const own = node.webmcp && typeof node.webmcp === 'object' ? node.webmcp : {};
  return { toolName: typeof own.toolName === 'string' ? own.toolName : '', toolDescription: typeof own.toolDescription === 'string' ? own.toolDescription : '' };
}
