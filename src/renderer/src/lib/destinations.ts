import type { Diagnostic, EditorDestination, ExportNote } from '@shared/api';
import type { ComponentDefinition, ListItem, OwnerRef, ProjectState } from '@shared/types';
import { publicUrl } from '@shared/public-url';
import { formFieldsAsSent, formKeyClashes, formServiceSetup, formUnchoosable } from '@catalogue/foundation/form';
import { websiteTrees } from '@engine/validate';
import { publishedState } from '@generator/index';
import { treeFor } from './model';

type FormDestination = Extract<EditorDestination, { kind: 'form' }>;

/** The settings a form finding is fixed in, by its code. */
const FORM_SETTINGS: Record<string, FormDestination['setting']> = {
  FORM_UNCONNECTED: 'connection',
  FORM_FIELD_KEYS: 'fieldKeys',
  FORM_NO_CHOICES: 'fieldChoices',
  FORM_NAME_DUPLICATE: 'formName'
};

/** The theme's contact form, or a copy of it: what a form finding is about (as netlifyFormName reads it). */
const isContactForm = (def: ComponentDefinition | undefined) => !!def && def.kind === 'code' && (def.componentId === 'contact.form' || def.provenance?.componentId === 'contact.form');

/**
 * Where a Project health finding is fixed, when that is a contact form's settings or a field of Site details: the
 * same places an export's notes lead to. Null for any other finding, which keeps its own action (Show on page).
 */
export function destinationForDiagnostic(state: ProjectState, d: Diagnostic): EditorDestination | null {
  // The site's icon and sharing image are set in Site details, not on any page.
  if (!d.owner && (d.site === 'favicon' || d.site === 'socialImage')) return { kind: 'site', field: d.site };
  const setting = Object.hasOwn(FORM_SETTINGS, d.code) ? FORM_SETTINGS[d.code] : null;
  if (!setting || !d.owner || !d.nodeId || !['page', 'shell', 'template', 'component'].includes(d.owner.kind)) return null;
  const dest: EditorDestination = { kind: 'form', owner: d.owner as OwnerRef, nodeId: d.nodeId, setting };
  // A clash found at a placement whose design holds the form has no form settings there: it is shown on the page.
  return formDestinationField(state, dest) ? dest : null;
}

/**
 * The Content field a form destination opens, found in the project as it is now: the setting the form's service needs
 * (or the service itself, when none is chosen), its Netlify form name, or the first of its fields with the problem
 * (that field's name, or its choices), its row opened. Null when the form, or that setting, is no longer there.
 */
export function formDestinationField(state: ProjectState, dest: FormDestination): { prop: string; label: string; itemId?: string; field?: string } | null {
  const tree = treeFor(state, dest.owner);
  const node = tree && Object.hasOwn(tree.nodes, dest.nodeId) ? tree.nodes[dest.nodeId] : undefined;
  const def = node?.kind === 'instance' && Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
  if (!node || node.kind !== 'instance' || !isContactForm(def)) return null;
  const prop = dest.setting === 'fieldKeys' || dest.setting === 'fieldChoices' ? 'fields' : dest.setting === 'formName' ? 'formName' : (formServiceSetup(def, node.props)?.prop ?? 'provider');
  const schema = Object.hasOwn(def!.properties, prop) ? def!.properties[prop] : undefined;
  if (!schema) return null;
  if (prop !== 'fields') return { prop, label: schema.label };
  // The row to open: the second of two fields sent under one name (the one to rename), or a question with no choices.
  const items = Array.isArray(node.props.fields) ? (node.props.fields as ListItem[]) : undefined;
  const sent = formFieldsAsSent(def!, node.props.fields);
  const at = dest.setting === 'fieldKeys' ? formKeyClashes(sent)[0]?.indexes[1] : formUnchoosable(sent)[0];
  const itemId = at === undefined ? undefined : items?.[at]?.id;
  return itemId ? { prop, label: schema.label, itemId, field: dest.setting === 'fieldKeys' ? 'name' : 'options' } : { prop, label: schema.label };
}

/** What a destination's button says. */
export function destinationLabel(dest: EditorDestination): string {
  if (dest.kind === 'form') return 'Go to form';
  return dest.field === 'baseUrl' ? 'Go to Public URL' : dest.field === 'favicon' ? 'Go to site icon' : 'Go to sharing image';
}

/**
 * Whether what an export note describes still holds in the project as it is now: `open` while it does, `fixed` once it
 * was put right after the export, `gone` when the form it names is no longer on the website (removed, or on a page
 * now kept as a draft). Null for a note with nothing to fix. `forms` are the notes for the website's forms visitors
 * cannot send now (websiteFormNotes).
 */
export function noteState(state: ProjectState, note: ExportNote, forms: ExportNote[]): 'open' | 'fixed' | 'gone' | null {
  const dest = note.destination;
  if (!dest) return null;
  if (dest.kind === 'site') return dest.field !== 'baseUrl' ? null : publicUrl(state.site) ? 'fixed' : 'open';
  const { owner, nodeId } = dest;
  // Off the website first: a form on a page made a draft since is not one visitors can send, connected or not.
  const shown = websiteTrees(publishedState(state)).find((t) => t.owner.kind === owner.kind && t.owner.id === owner.id);
  if (!shown || !Object.hasOwn(shown.tree?.nodes ?? {}, nodeId)) return 'gone';
  return forms.some(({ destination: f }) => f?.kind === 'form' && f.owner.kind === owner.kind && f.owner.id === owner.id && f.nodeId === nodeId) ? 'open' : 'fixed';
}
