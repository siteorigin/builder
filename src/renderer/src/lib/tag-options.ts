/** The HTML tags an author can pick for a container or plain text, named and grouped as an author looks for them. */

type TagGroup = { label: string; tags: Array<[tag: string, name: string]> };

/** Every text tag, grouped as an author looks for them. */
export const TEXT_TAG_GROUPS: TagGroup[] = [
  { label: 'Headings', tags: [1, 2, 3, 4, 5, 6].map((n): [string, string] => [`h${n}`, `Heading ${n}`]) },
  { label: 'Text', tags: [['p', 'Paragraph'], ['div', 'Block of text'], ['blockquote', 'Quotation']] },
  { label: 'Inline', tags: [['span', 'Inline text'], ['strong', 'Important text'], ['small', 'Small print'], ['cite', 'Citation']] },
  { label: 'Terms and captions', tags: [['dt', 'Term'], ['dd', 'Description'], ['figcaption', 'Figure caption']] }
];

/** Every container tag, grouped as an author looks for them. */
export const ELEMENT_TAG_GROUPS: TagGroup[] = [
  { label: 'Containers', tags: [['div', 'Container'], ['p', 'Paragraph'], ['span', 'Inline container'], ['blockquote', 'Quotation'], ['address', 'Contact details']] },
  { label: 'Page regions', tags: [['section', 'Section'], ['article', 'Article'], ['aside', 'Aside'], ['header', 'Header'], ['footer', 'Footer'], ['nav', 'Navigation'], ['main', 'Main area']] },
  { label: 'Lists', tags: [['ul', 'Bulleted list'], ['ol', 'Numbered list'], ['li', 'List item'], ['dl', 'Description list'], ['dt', 'Term'], ['dd', 'Description']] },
  { label: 'Figures and expandable sections', tags: [['figure', 'Figure'], ['figcaption', 'Figure caption'], ['details', 'Expandable section'], ['summary', 'Expandable section title']] }
];

/** The choices a tag select shows: each tag with its name, and whether it fits where the node sits. */
export function tagSelectOptions(kind: 'text' | 'element', current: unknown, fits: ReadonlyMap<string, string | null>): { value: string; unknown: string | null; groups: Array<{ label: string; options: Array<{ tag: string; name: string; problem: string | null }> }> } {
  const groups = (kind === 'text' ? TEXT_TAG_GROUPS : ELEMENT_TAG_GROUPS).map((g) => ({
    label: g.label,
    options: g.tags.map(([tag, name]) => ({ tag, name, problem: fits.get(tag) ?? null }))
  }));
  // A tag this version doesn't offer (from a hand-edited document) still shows as the one the node has.
  const value = typeof current === 'string' ? current : '';
  const unknown = groups.some((g) => g.options.some((o) => o.tag === value)) ? null : value;
  return { value, unknown, groups };
}

/** A tag's own placement rules, as the nesting check words them, and as the fold says them: where the tag goes. */
const RULES: Array<{ tags: readonly string[]; said: RegExp; reason: string }> = [
  { tags: ['li'], said: /is a list item, so it goes directly inside a list/, reason: 'Only goes directly inside a bulleted or numbered list.' },
  { tags: ['dt', 'dd'], said: /is a term or description, so it goes inside a description list/, reason: 'Only goes inside a description list.' },
  { tags: ['figcaption'], said: /is a caption, so it goes directly inside a figure/, reason: 'Only goes directly inside a figure.' },
  { tags: ['summary'], said: /is a summary, so it goes directly inside a details element/, reason: 'Only goes directly inside an expandable section.' },
  { tags: ['main'], said: /can’t be a main area/, reason: 'Every page already has one, around its sections.' },
  { tags: ['header', 'footer'], said: /can’t be a header or footer inside another header or footer/, reason: 'Can’t go inside another header or footer.' }
];
/** Rules any tag can break where the node sits, with the container named as the menu names it: for text, what it has to be. */
const AROUND: Array<{ said: RegExp; text: string; container: string }> = [
  { said: /can’t go inside a paragraph container/, text: 'Text inside a paragraph container has to be inline text.', container: 'Can’t go inside a paragraph container, which holds only inline text, buttons, links and icons.' },
  { said: /can’t go inside a span container/, text: 'Text inside an inline container has to be inline text.', container: 'Can’t go inside an inline container, which holds only inline text, buttons, links and icons.' }
];
/** Tags that only go inside a parent of their own, which a paragraph or inline container never is. */
const PARENTED = new Set(['li', 'dt', 'dd', 'figcaption', 'summary']);
/** A linked card's refusal of a disclosure, in the menu's words. */
const CARD = /can’t go inside a linked card/;

/**
 * A tag's problem as a standing rule, for the fold beside the select and the option's title. The nesting check words its
 * messages for the moment an edit is refused ("A heading is a caption, so it goes directly inside a figure."), which
 * beside a select read as a claim about the node; the node's own placement rule is said as where the tag goes. Where the
 * check stops first at a rule any tag breaks (inside a paragraph container) but the tag also has a parent of its own, the
 * tag's own rule is the one that says what would make it available. A problem the tag would make for something else (a
 * child it strands, a placement in another page) is kept as the check words it, since it names what breaks.
 */
export function standingReason(tag: string, problem: string, self: boolean, kind: 'text' | 'element' = 'text'): string {
  if (!self) return problem;
  const own = RULES.find((r) => r.tags.includes(tag));
  if (own?.said.test(problem)) return own.reason;
  const around = AROUND.find((r) => r.said.test(problem));
  if (around) return own && PARENTED.has(tag) ? own.reason : kind === 'text' ? around.text : around.container;
  if (CARD.test(problem)) return 'Can’t go inside a linked card, which can hold nothing interactive.';
  return problem;
}

/**
 * Why the tags that don't fit can't be chosen, one line per reason with the tags it rules out, for reading beside the
 * select. A group every one of whose tags a reason rules out is named as the group ("Headings (h1–h6)").
 */
export function unavailableReasons(groups: ReturnType<typeof tagSelectOptions>['groups']): Array<{ reason: string; names: string[] }> {
  const out = new Map<string, string[]>();
  const add = (reason: string, name: string) => out.set(reason, [...(out.get(reason) ?? []), name]);
  for (const g of groups) {
    const reason = g.options[0]?.problem;
    if (reason && g.options.length > 2 && g.options.every((o) => o.problem === reason)) {
      const tags = g.options.map((o) => o.tag);
      add(reason, `${g.label} (${tags.every((t) => /^h[1-6]$/.test(t)) ? `${tags[0]}–${tags[tags.length - 1]}` : tags.join(', ')})`);
    } else for (const o of g.options) if (o.problem) add(o.problem, `${o.name} (${o.tag})`);
  }
  return [...out].map(([reason, names]) => ({ reason, names }));
}
