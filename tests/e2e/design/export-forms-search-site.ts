// The exported site that tests/e2e/design/export-forms-search.mjs captures: the business starter with the Contact
// form, the Signup form card and Site search placed in each tone, generated exactly as an export generates it.
// Run by that script through tsx; writes the generated files over the site folder it is given.
//
//   npx tsx --tsconfig tsconfig.node.json tests/e2e/design/export-forms-search-site.ts /abs/site
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadBundledPacks } from '../../../src/main/packs/installed';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject } from '@generator/index';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';

await loadBundledPacks(resolve(import.meta.dirname, '..', '..', '..'));
const dir = process.argv[2];
if (!dir) throw new Error('usage: export-forms-search-site.ts <site folder>');

/** The address every form sends to. It never resolves: the capture answers each request itself. */
const ENDPOINT = 'https://forms.harbour-lane.test/f/studio';

let s: ProjectState = createStarterState('business', 'Harbour Lane Studio', false);
const apply = (ops: EditOperation[]) => (s = applyOperations(s, ops).state);
const on = (id: string) => ({ kind: 'page' as const, id });

const CHOICES = [{ label: 'A new kitchen' }, { label: 'Built-in joinery' }, { label: 'Restoration of an older piece' }];
const FIELDS = [
  { label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
  { label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
  { label: 'Phone', name: 'phone', type: 'tel', required: false, placeholder: '' },
  { label: 'What is it about?', name: 'topic', type: 'choice', required: true, placeholder: '', options: CHOICES },
  { label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' },
  { label: 'Send me the occasional studio newsletter', name: 'newsletter', type: 'checkbox', required: false, placeholder: '' }
];

// One page per tone of the Contact form, each with only the form on it.
for (const [tone, title] of [
  ['default', 'Form default'],
  ['muted', 'Form muted'],
  ['inverse', 'Form inverse']
] as const) {
  const id = `pg_form${tone}`;
  apply([
    { type: 'page.create', pageId: id, title, route: `/form-${tone}/` },
    { type: 'node.insert', owner: on(id), newNodeId: `n_form${tone}`, componentId: 'contact.form', variants: { tone }, props: { endpoint: ENDPOINT, fields: FIELDS } }
  ]);
}
// The form before it is connected: no endpoint.
apply([
  { type: 'page.create', pageId: 'pg_formoff', title: 'Form offline', route: '/form-offline/' },
  { type: 'node.insert', owner: on('pg_formoff'), componentId: 'contact.form', props: { endpoint: '' } }
]);

// The Signup card in each tone, in the secondary column of a split beside a callout.
apply([{ type: 'page.create', pageId: 'pg_signup', title: 'Signup', route: '/signup/' }]);
for (const tone of ['default', 'muted', 'inverse']) {
  const split = `n_split${tone}`;
  apply([
    { type: 'node.insert', owner: on('pg_signup'), newNodeId: split, componentId: 'layout.split' },
    { type: 'node.insert', owner: on('pg_signup'), parentId: split, slot: 'primary', componentId: 'block.callout', props: { heading: 'Studio notes', text: 'Twice a year we write about the pieces leaving the workshop and the timber we are drying for next season.' } },
    { type: 'node.insert', owner: on('pg_signup'), parentId: split, slot: 'secondary', newNodeId: `n_signup${tone}`, componentId: 'block.signup', variants: { tone }, props: { endpoint: ENDPOINT } }
  ]);
}

// Site search in each tone, over pages with words worth finding.
for (const tone of ['default', 'muted', 'inverse']) {
  const id = `pg_search${tone}`;
  apply([
    { type: 'page.create', pageId: id, title: `Search ${tone}`, route: `/search-${tone}/` },
    { type: 'node.insert', owner: on(id), componentId: 'site.search', variants: { tone }, props: { lead: 'Find a project, a service or an answer.' } }
  ]);
}
const PROJECTS = [
  ['Oak kitchen for a harbour cottage', 'A kitchen in quarter-sawn oak with a linen-finish island, made to fit the cottage’s uneven stone walls.'],
  ['Walnut library shelving', 'Floor-to-ceiling shelving in black walnut, with a rolling ladder and hidden lighting along each oak-lipped shelf.'],
  ['Restoring a Victorian oak dresser', 'We took a water-damaged dresser back to sound oak, remade two drawers and matched the original shellac.'],
  ['Kitchen and joinery services', 'From a single oak worktop to a whole kitchen: how we design, make and fit, and what each stage costs.']
];
PROJECTS.forEach(([title, body], n) => {
  const id = `pg_proj${n}`;
  apply([
    { type: 'page.create', pageId: id, title, route: `/work/project-${n + 1}/` },
    { type: 'node.insert', owner: on(id), componentId: 'content.text', props: { heading: title, body } }
  ]);
});

const files = generateProject(s);
for (const [path, content] of files) {
  const to = join(dir, path);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, content);
}
console.log(`generated ${files.size} files into ${dir}`);
