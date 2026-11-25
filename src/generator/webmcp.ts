/**
 * WebMCP in the exported website (see shared/webmcp.ts): the contact forms it shows, declared as tools by their markup,
 * and the read-only `search_site` tool a website that searches itself registers in browsers that know WebMCP.
 *
 * A project keeps its own copy of the contact form's code, and with WebMCP off the website must be exactly what it was,
 * so the form's code is never changed. While WebMCP is on, the visitor's website gets a second file beside the form's,
 * the same code with the tool attributes added (`adaptFormSource`), and its placements import that file instead. The
 * editor's preview never does: it shows the form as the author made it.
 */
import type { ComponentDefinition, InstanceNode, NodeTree, ProjectState } from '@shared/types';
import { isWebMcpForm, toolOverrides, uniqueToolNames, WEBMCP_NAME_MAX, WEBMCP_SEARCH_TOOL, webMcpText, webMcpToolName } from '@shared/webmcp';

/** The name a form takes when the author gives it none, or one with nothing usable in it. */
export const DEFAULT_FORM_TOOL = 'contact';

/** The registration of `search_site`, in the runtime folder beside the search code it runs. */
export const WEBMCP_SEARCH_FILE = 'webmcp-search.js';

/**
 * The pieces of the theme's contact form the tool attributes are added at, each exactly as every version of the form
 * with single-choice questions writes it. Code that writes any of them differently (a copy the author changed) is
 * left as it is, and its form declares no tool.
 */
const PROPS_END = "\n\t\tclass: className = ''\n\t} = $props();";
const UID = '\n\tconst uid = $props.id();';
const FORM_OPEN = '\n\t\t<form\n\t\t\tclass="so-form__form"';
const FIELD_LOOP = '{#each fields as field, i (field.id)}';
const FIELD_NAME = /\n(\t+)name=\{names\[i\]\}/g;

const count = (text: string, piece: string) => text.split(piece).length - 1;

/**
 * The form's code with the tool attributes added: `toolname` and `tooldescription` on the form, and on each field the
 * visitor fills in, `toolparamdescription` from its label (a single-choice question's own words on each of its
 * answers, whose labels are only the answers). The attributes read the `so_webmcp` the placement hands the form, and
 * render nothing without it. No `toolautosubmit`: the browser fills the form in, and the visitor checks and sends it.
 *
 * Null when the code is not the theme's form as it is written (see the pieces above), already speaks of WebMCP, or
 * imports a file beside it (the copy is written to another folder, from which that path would lead nowhere).
 */
export function adaptFormSource(source: string): string | null {
  if (/\bso_webmcp\b|\btoolname\b/.test(source) || /\bfrom\s+['"]\.\/|\bimport\s+['"]\.\//.test(source)) return null;
  if (count(source, PROPS_END) !== 1 || count(source, UID) !== 1 || count(source, FORM_OPEN) !== 1 || count(source, FIELD_LOOP) !== 1) return null;
  const fields = source.match(FIELD_NAME)?.length ?? 0;
  if (!fields) return null;
  return source
    .replace(PROPS_END, "\n\t\tclass: className = '',\n\t\tso_webmcp = null\n\t} = $props();")
    .replace(
      UID,
      `${UID}\n\t// The tool the form is to AI agents in the visitor's browser (WebMCP), as its placement names it. A form inside a\n\t// design takes the design's name for it with its own ID added, so every form on a page has a name of its own.\n\tconst so_webmcpName = $derived(so_webmcp?.unique ? so_webmcp.name + '.' + String(uid).replace(/[^A-Za-z0-9_-]/g, '') : so_webmcp?.name);`
    )
    .replace(FORM_OPEN, `${FORM_OPEN}\n\t\t\ttoolname={so_webmcpName}\n\t\t\ttooldescription={so_webmcp?.description}`)
    .replace(FIELD_NAME, (_m, tabs: string) => `\n${tabs}name={names[i]}\n${tabs}toolparamdescription={so_webmcp ? String(field.label ?? '').trim() || undefined : undefined}`);
}

/** Adapted sources by the code they came from: a form placed on every page is adapted once. */
const adapted = new Map<string, string | null>();

/** adaptFormSource, worked out once per source. */
export function adaptedForm(source: string): string | null {
  if (!adapted.has(source)) {
    if (adapted.size > 50) adapted.clear();
    adapted.set(source, adaptFormSource(source));
  }
  return adapted.get(source)!;
}

/** Whether a definition is a contact form whose code takes the tool attributes. */
export function declaresFormTool(def: ComponentDefinition | undefined): def is ComponentDefinition {
  return isWebMcpForm(def) && typeof def.source === 'string' && adaptedForm(def.source) !== null;
}

/**
 * The tool name a placement asks for: its own, as a tool name, else DEFAULT_FORM_TOOL. Never with a ".", which only a
 * form inside a design takes (before its ID), so a name given here can never be one of theirs.
 */
export function formToolBase(node: Pick<InstanceNode, 'webmcp'>): string {
  const own = webMcpToolName(toolOverrides(node).toolName).replace(/\./g, '_').replace(/^[_-]+|[_-]+$/g, '');
  return own || DEFAULT_FORM_TOOL;
}

/**
 * What a placement's form tells agents it does: the author's own words, else what a contact form does, with the
 * heading it shows when that is text of its own (one read from the design is the same for every form, and says nothing).
 */
export function formToolDescription(state: ProjectState, node: Pick<InstanceNode, 'webmcp' | 'props'>): string {
  const own = webMcpText(toolOverrides(node).toolDescription);
  if (own) return own;
  const site = webMcpText(state.site.name, 120);
  const heading = webMcpText(node.props?.heading, 120);
  const does = `Contact ${site || 'this website'}: fills in this form with a message, which the visitor checks and sends.`;
  return heading ? webMcpText(`${heading.replace(/[.:!?]+$/, '')}. ${does}`) : does;
}

/**
 * The contact forms a tree places directly, in the order it shows them: in its sections and containers, never inside a
 * component's design or content area, which can show one more than once. Those take names of their own as the page
 * renders them (see adaptFormSource).
 */
function directForms(state: ProjectState, tree: NodeTree): InstanceNode[] {
  const out: InstanceNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const n = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'instance') {
      const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
      if (declaresFormTool(def)) out.push(n);
    } else if (n.kind === 'element' && Array.isArray(n.children)) for (const c of n.children) visit(c);
  };
  for (const id of Array.isArray(tree.rootIds) ? tree.rootIds : []) visit(id);
  return out;
}

/** Tool names for the forms trees place directly, by node ID, each its own and none of `taken`. */
function allocate(state: ProjectState, trees: NodeTree[], taken: readonly string[]): Map<string, string> {
  const forms = trees.flatMap((t) => directForms(state, t));
  const names = uniqueToolNames(
    forms.map((n) => formToolBase(n).slice(0, WEBMCP_NAME_MAX)),
    [WEBMCP_SEARCH_TOOL, ...taken]
  );
  return new Map(forms.map((n, i) => [n.id, names[i]]));
}

/** The names of the forms the shared header and footer place directly, which every page leaves them. */
export function shellToolNames(state: ProjectState): Map<string, string> {
  return allocate(state, [state.site.shell.header, state.site.shell.footer], []);
}

/** The names of the forms a page's (or an entry's page's) own tree places directly, around the shared header's and footer's. */
export function pageToolNames(state: ProjectState, tree: NodeTree, shell: ReadonlyMap<string, string>): Map<string, string> {
  return allocate(state, [tree], [...shell.values()]);
}

/** What a placement hands its form: the tool's name (or, inside a design, the start of it) and what it does. */
export function formTool(state: ProjectState, node: InstanceNode, name: string | undefined): { name: string; description: string; unique?: true } {
  const description = formToolDescription(state, node);
  return name ? { name, description } : { name: formToolBase(node), description, unique: true };
}

/**
 * The registration of `search_site`, started by the website's layout. Plain JavaScript beside the search code. In a
 * browser without WebMCP it does nothing and loads nothing. Otherwise it registers the tool once (another registration
 * of the name is left alone), and a search loads the site's index as the Site search component does, giving back the
 * pages found with their full addresses. `resolveRoute` is SvelteKit's `resolve`, so a website published under a
 * sub-path links to its pages there.
 */
export function webMcpSearchJs(): string {
  return `// Generated by SiteOrigin Builder. Offers this website's search to AI agents in the visitor's browser (WebMCP).
// Browsers that don't know WebMCP never run any of it, and never load the search index for it.
import { loadPages, searchPages, SHOWN } from './site-search.js';

/** The page parts search gives back (words, with the words searched for marked), as plain text. */
const plain = (parts) => (Array.isArray(parts) ? parts.map((p) => String(p?.text ?? '')).join('') : '');

/**
 * Register the ${WEBMCP_SEARCH_TOOL} tool, while the browser offers WebMCP. Returns what stops offering it again.
 * \`resolveRoute\` turns a page's address into the one it has where the website is published.
 */
export function offerSearch(resolveRoute) {
	const context = (typeof document !== 'undefined' && document.modelContext) || (typeof navigator !== 'undefined' && 'modelContext' in navigator ? navigator.modelContext : null);
	if (!context || typeof context.registerTool !== 'function') return () => {};
	const controller = new AbortController();
	const tool = {
		name: '${WEBMCP_SEARCH_TOOL}',
		description: 'Search this website for pages and posts about something. Gives back the best matches, each with its title, a passage of its text and its full address.',
		inputSchema: {
			type: 'object',
			properties: { query: { type: 'string', description: 'The words to search for.' } },
			required: ['query']
		},
		annotations: { readOnlyHint: true },
		async execute(input) {
			const query = typeof input?.query === 'string' ? input.query.trim() : '';
			if (!query) return { error: 'Give the words to search for as "query".' };
			let pages;
			try {
				pages = await loadPages();
			} catch {
				return { error: 'The search index could not be loaded. Try again.' };
			}
			const { total, results } = searchPages(pages, query, SHOWN);
			return {
				total,
				results: results.map((r) => ({ title: plain(r.title), excerpt: plain(r.excerpt), url: new URL(resolveRoute(r.route), document.baseURI).href }))
			};
		}
	};
	try {
		const done = context.registerTool(tool, { signal: controller.signal });
		// A name already offered (by another script, or a registration not yet stopped) is left as it is.
		if (done && typeof done.catch === 'function') done.catch(() => {});
	} catch {
		// The same: this page offers the tool already, or the browser refused it.
	}
	return () => controller.abort();
}
`;
}
