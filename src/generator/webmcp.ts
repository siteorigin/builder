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
import { siteShowsCode } from './checks';
import { searchesSite, usesSiteSearch } from './search';

/** The name a form takes when the author gives it none, or one with nothing usable in it. */
export const DEFAULT_FORM_TOOL = 'contact';

/** The registration of `search_site`, in the runtime folder beside the search code it runs. */
export const WEBMCP_SEARCH_FILE = 'webmcp-search.js';

/**
 * The pieces of the theme's contact form the tool attributes are added at, each exactly as every version of the form
 * with its fields' names on lines of their own writes it. Code that writes any of them differently (a copy the author
 * changed, or the very first form) is left as it is, and its form declares no tool.
 */
const PROPS_END = "\n\t\tclass: className = ''\n\t} = $props();";
const UID = '\n\tconst uid = $props.id();';
const STATUS = "\n\tlet status = $state('idle');";
const HONEYPOT = '\n\tconst honeypot = $derived(';
const FORM_OPEN = '\n\t\t<form\n\t\t\tclass="so-form__form"';
const FIELD_LOOP = '\t\t\t{#each fields as field, i (field.id)}';
const FIELD_LOOP_END = '\n\t\t\t{/each}';
const SUBMIT = '\n\tasync function submit(event) {\n\t\tevent.preventDefault();';
const RESET = 'HTMLFormElement.prototype.reset.call(form);';
/** The name each field the visitor fills in is sent under, on a line of its own: today's form, and the first ones. */
const FIELD_NAME = /\n(\t+)(name=\{(?:names\[i\]|fieldName\(field, i\))\})/g;
/** A single-choice question's group, whose description agents read for all of its answers. */
const CHOICES_OPEN = '<fieldset class="so-form__field so-form__field--wide so-form__choices"';
/** The spam trap: off screen, but in the agent's view of the form all the same. */
const TRAP = /name=\{honeypot\}/g;
/** What makes a field read-only, or a question unanswerable, while a message sends. */
const WHILE_SENDING = /(readonly|disabled)=\{status === 'sending'\}/g;

const count = (text: string, piece: string) => text.split(piece).length - 1;
const LABEL = "so_webmcp ? String(field.label ?? '').trim() || undefined : undefined";
/** Every module path the code imports, statically or not. */
const SPECIFIERS = /\b(?:from|import)\s*\(?\s*(['"`])((?:(?!\1)[^\n])*)\1/g;

/**
 * The form's code with the tool attributes added: `toolname` and `tooldescription` on the form; on each field the
 * visitor fills in, `toolparamdescription` from its label (a single-choice question's own words on its group and on each
 * of its answers, whose labels are only the answers); and on the spam trap, a description that tells agents to leave it
 * empty. The service's own hidden fields get none, which keeps them out of what agents may fill in. The attributes read
 * the `so_webmcp` the placement hands the form, and render nothing without it.
 *
 * No `toolautosubmit`: the browser fills the form in, and the visitor checks and sends it. Once they do, the agent is
 * told whether the message was sent (`respondWith`). While it waits, the fields stay as they are (a field the browser
 * sees change would change the tool under it), and the form is emptied only once the agent has its answer, since
 * emptying it first would tell the agent its request was cancelled.
 *
 * Null when the code is not the theme's form as it is written (see the pieces above); already speaks of WebMCP, or
 * spreads attributes from elsewhere that might (an existing `toolautosubmit` would send without the visitor); or
 * imports a module beside it, or one named in any but the plainest way (the copy is written to another folder, from
 * which a path beside the form would lead nowhere).
 */
export function adaptFormSource(source: string): string | null {
  if (/\bso_(?:webmcp|send|reset|told|answering)|\btool(?:name|description|autosubmit|param\w*)\b|\{\s*\.\.\./i.test(source) || /['"`]\.\//.test(source)) return null;
  if ([...source.matchAll(SPECIFIERS)].some((m) => m[2].includes('\\') || m[2].startsWith('./') || m[2] === '.')) return null;
  if ([PROPS_END, UID, STATUS, HONEYPOT, FORM_OPEN, FIELD_LOOP, SUBMIT].some((piece) => count(source, piece) !== 1) || !source.includes(RESET)) return null;
  // Every field the loop places names itself on a line of its own, so none is left without its description.
  const at = source.indexOf(FIELD_LOOP);
  const loop = source.slice(at, source.indexOf(FIELD_LOOP_END, at));
  const fields = loop.match(FIELD_NAME)?.length ?? 0;
  if (!fields || fields !== (loop.match(/\bname=/g)?.length ?? 0)) return null;
  return source
    // First, so the emptying the agent's answer waits for is not itself made to wait.
    .replaceAll(RESET, 'so_reset(form);')
    .replace(PROPS_END, "\n\t\tclass: className = '',\n\t\tso_webmcp = null\n\t} = $props();")
    .replace(
      UID,
      `${UID}\n\t// The tool the form is to AI agents in the visitor's browser (WebMCP), as its placement names it. A form inside a\n\t// design takes the design's name for it with its own ID added, so every form on a page has a name of its own.\n\tconst so_webmcpName = $derived(so_webmcp?.unique ? so_webmcp.name + '.' + String(uid).replace(/[^A-Za-z0-9_-]/g, '') : so_webmcp?.name);`
    )
    .replace(
      SUBMIT,
      `\n\t// An agent in the visitor's browser that filled the form in (WebMCP) waits to hear whether the message was sent. It is
\t// told once sending ends (respondWith, claimed while the browser still asks). Meanwhile the fields stay as they are,
\t// and the form is emptied only once the agent has its answer.
\tlet so_told = null;
\tlet so_answering = $state(false);
\tfunction so_reset(form) {
\t\tconst reset = () => HTMLFormElement.prototype.reset.call(form);
\t\t// After the browser has taken the answer in, never before.
\t\tif (so_told) so_told.then(() => setTimeout(reset));
\t\telse reset();
\t}

\tfunction submit(event) {
\t\tif (!so_webmcp || !event.agentInvoked || typeof event.respondWith !== 'function') return so_send(event);
\t\t// A message already on its way answers for itself; this request is told so and sends nothing.
\t\tif (status === 'sending') {
\t\t\tconst busy = so_send(event);
\t\t\tevent.respondWith(busy.then(() => ({ sent: false, message: 'The form is already sending a message.' })));
\t\t\treturn;
\t\t}
\t\tlet tell;
\t\tconst told = new Promise((resolve) => (tell = resolve));
\t\tso_told = told;
\t\tso_answering = true;
\t\tlet trapped = false;
\t\ttry {
\t\t\ttrapped = !!new FormData(event.currentTarget).get(honeypot);
\t\t} catch {
\t\t\t// Read as not filled in.
\t\t}
\t\tconst answer = () => {
\t\t\tif (trapped) return { sent: false, message: 'The message was discarded: the spam trap was filled in.' };
\t\t\tif (status === 'sent') return { sent: true, message: 'The message was sent.' };
\t\t\treturn { sent: false, message: status === 'error' ? 'The message could not be sent. The visitor can try again.' : 'The form cannot be sent yet.' };
\t\t};
\t\tconst done = () => {
\t\t\tso_answering = false;
\t\t\ttell(answer());
\t\t};
\t\tso_send(event).then(done, done);
\t\tevent.respondWith(told);
\t\ttold.then(() => {
\t\t\tif (so_told === told) so_told = null;
\t\t});
\t}

\tasync function so_send(event) {
\t\tevent.preventDefault();`
    )
    .replace(FORM_OPEN, `${FORM_OPEN}\n\t\t\ttoolname={so_webmcpName}\n\t\t\ttooldescription={so_webmcp?.description}`)
    .replace(FIELD_NAME, (_m, tabs: string, name: string) => `\n${tabs}${name}\n${tabs}toolparamdescription={${LABEL}}`)
    .replace(CHOICES_OPEN, `${CHOICES_OPEN} toolparamdescription={${LABEL}}`)
    .replace(TRAP, (name) => `${name} toolparamdescription={so_webmcp ? 'A spam trap: always leave it empty. Filling it in discards the message.' : undefined}`)
    .replace(WHILE_SENDING, (_m, attr: string) => `${attr}={status === 'sending' && !so_answering}`);
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

/**
 * Whether the published website shows Site search: the site writes the search code, and a published page (or the shell
 * or an entry's page it shows) places a component that searches, directly or inside code converted from a design.
 */
export function showsSiteSearch(state: ProjectState): boolean {
  return usesSiteSearch(state) && siteShowsCode(state, searchesSite, { throughCode: true });
}

/** Whether the published website shows a contact form that declares a tool while WebMCP is on. */
export function showsFormTool(state: ProjectState): boolean {
  return siteShowsCode(state, declaresFormTool);
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

/**
 * Tool names for the forms trees place directly, one map of node IDs to names per tree (two trees can use one node
 * ID), each name its own and none of `taken`.
 */
function allocate(state: ProjectState, trees: NodeTree[], taken: readonly string[]): Array<Map<string, string>> {
  const forms = trees.map((t) => directForms(state, t));
  const names = uniqueToolNames(
    forms.flat().map((n) => formToolBase(n).slice(0, WEBMCP_NAME_MAX)),
    [WEBMCP_SEARCH_TOOL, ...taken]
  );
  let at = 0;
  return forms.map((list) => new Map(list.map((n) => [n.id, names[at++]])));
}

/** The names of the forms the shared header and footer place directly, as `[header, footer]` lists of [node ID, name]. */
export function shellToolNames(state: ProjectState): [Array<[string, string]>, Array<[string, string]>] {
  const [header, footer] = allocate(state, [state.site.shell.header, state.site.shell.footer], []);
  return [[...header], [...footer]];
}

/** The names of the forms a page's (or an entry's page's) own tree places directly, around the shared header's and footer's. */
export function pageToolNames(state: ProjectState, tree: NodeTree, shell: readonly string[]): Map<string, string> {
  return allocate(state, [tree], shell)[0];
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
	// Whether the tool offered is this registration's, which only then is stopped here.
	let ours = false;
	try {
		const done = context.registerTool(tool, { signal: controller.signal });
		ours = true;
		// A name already offered (by another script, or a registration not yet stopped) is left as it is.
		if (done && typeof done.then === 'function') done.then(() => {}, () => (ours = false));
	} catch {
		// The same: this page offers the tool already, or the browser refused it.
	}
	return () => {
		controller.abort();
		// The first browsers to offer WebMCP took no signal, and stopped a tool by its name.
		if (ours && typeof context.unregisterTool === 'function') {
			try {
				context.unregisterTool(tool.name);
			} catch {
				// Gone already.
			}
		}
	};
}
`;
}
