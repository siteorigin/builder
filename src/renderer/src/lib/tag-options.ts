/** The HTML tags an author can pick for a container or plain text, named and grouped as an author looks for them. */

type TagGroup = { label: string; tags: Array<[tag: string, name: string]> };

/** Every text tag, grouped as an author looks for them. */
export const TEXT_TAG_GROUPS: TagGroup[] = [
  { label: 'Headings', tags: [1, 2, 3, 4, 5, 6].map((n): [string, string] => [`h${n}`, `Heading ${n}`]) },
  { label: 'Text', tags: [['p', 'Paragraph'], ['div', 'Block of text'], ['blockquote', 'Quotation']] },
  { label: 'Inline', tags: [['span', 'Inline text'], ['strong', 'Strong importance'], ['small', 'Small print'], ['cite', 'Citation']] },
  { label: 'Terms and captions', tags: [['dt', 'Term'], ['dd', 'Description'], ['figcaption', 'Figure caption']] }
];

/** Every container tag, grouped as an author looks for them. */
export const ELEMENT_TAG_GROUPS: TagGroup[] = [
  {
    label: 'Containers',
    tags: [
      ['div', 'Container'],
      ['section', 'Section'],
      ['article', 'Article'],
      ['aside', 'Aside'],
      ['header', 'Header'],
      ['footer', 'Footer'],
      ['nav', 'Navigation'],
      ['main', 'Main area'],
      ['address', 'Contact details'],
      ['blockquote', 'Quotation'],
      ['p', 'Paragraph'],
      ['span', 'Inline']
    ]
  },
  { label: 'Lists', tags: [['ul', 'Bulleted list'], ['ol', 'Numbered list'], ['li', 'List item'], ['dl', 'Description list'], ['dt', 'Term'], ['dd', 'Description']] },
  { label: 'Figures and disclosures', tags: [['figure', 'Figure'], ['figcaption', 'Figure caption'], ['details', 'Disclosure'], ['summary', 'Disclosure summary']] }
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

/** Why the tags that don't fit can't be chosen, one line per reason with the tags it rules out, for reading beside the select. */
export function unavailableReasons(groups: ReturnType<typeof tagSelectOptions>['groups']): Array<{ reason: string; names: string[] }> {
  const out = new Map<string, string[]>();
  for (const o of groups.flatMap((g) => g.options)) if (o.problem) out.set(o.problem, [...(out.get(o.problem) ?? []), `${o.name} (${o.tag})`]);
  return [...out].map(([reason, names]) => ({ reason, names }));
}
