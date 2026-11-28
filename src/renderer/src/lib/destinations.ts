import type { Diagnostic, EditorDestination, ExportNote } from '@shared/api';
import type { ComponentDefinition, ListItem, OwnerRef, ProjectState } from '@shared/types';
import { publicUrl } from '@shared/public-url';
import { formFieldsAsSent, formKeyClashes, formServiceSetup, formUnchoosable, isFormContract } from '@shared/form-contract';
import { websiteTrees } from '@engine/validate';
import { publishedState } from '@generator/index';
import { treeFor } from './model';
import { requiredSite } from '@engine/required';

type FormDestination = Extract<EditorDestination, { kind: 'form' }>;

/** The settings a form finding is fixed in, by its code. */
const FORM_SETTINGS: Record<string, FormDestination['setting']> = {
  FORM_UNCONNECTED: 'connection',
  FORM_FIELD_KEYS: 'fieldKeys',
  FORM_NO_CHOICES: 'fieldChoices',
  FORM_NAME_DUPLICATE: 'formName'
};

/** One of the theme's forms (the contact or signup form), or a copy of one: what a form finding is about (as netlifyFormName reads it). */
const isContactForm = (def: ComponentDefinition | undefined) => !!def && def.kind === 'code' && (isFormContract(def.componentId) || isFormContract(def.provenance?.componentId));

/**
 * Where a Project health finding is fixed, when that is a contact form's settings or a field of Site details: the
 * same places an export's notes lead to. Null for any other finding, which keeps its own action (Show on page).
 */
export function destinationForDiagnostic(state: ProjectState, d: Diagnostic): EditorDestination | null {
  // The site's icon and sharing image are set in Site details, not on any page.
  if (!d.owner && (d.site === 'favicon' || d.site === 'socialImage' || d.site === 'logo')) return { kind: 'site', field: d.site };
  // An old address that sends visitors nowhere, or not straight there, is fixed in its row of Redirects.
  if (!d.owner && d.site?.startsWith('redirect:')) return { kind: 'site', field: 'redirects' };
  // A placement missing a value its component requires: its field, in the Inspector.
  if (d.code === 'PROP_REQUIRED_EMPTY' && d.owner && d.nodeId && d.site && ['page', 'shell', 'template', 'component'].includes(d.owner.kind)) {
    const at = requiredSite(d.site, d.owner as OwnerRef, d.nodeId);
    return at ? { kind: 'prop', owner: d.owner as OwnerRef, nodeId: d.nodeId, ...at } : null;
  }
  const setting = Object.hasOwn(FORM_SETTINGS, d.code) ? FORM_SETTINGS[d.code] : null;
  if (!setting || !d.owner || !d.nodeId || !['page', 'shell', 'template', 'archive', 'component'].includes(d.owner.kind)) return null;
  // A field finding names its row (`${nodeId}|fields|${itemId}`): each finding leads to its own.
  const row = d.site?.startsWith(`${d.nodeId}|fields|`) ? d.site.slice(`${d.nodeId}|fields|`.length) : undefined;
  const dest: EditorDestination = { kind: 'form', owner: d.owner as OwnerRef, nodeId: d.nodeId, setting, ...(row ? { itemId: row } : {}) };
  // A clash found at a placement whose design holds the form has no form settings there: it is shown on the page.
  return formDestinationField(state, dest) ? dest : null;
}

/** Where a form destination lands, found in the project as it is now (see formDestinationField). */
export interface FormLanding {
  /** The Content property to focus. */
  prop: string;
  label: string;
  /** A list row to open, and its field to focus. */
  itemId?: string;
  field?: string;
}

/**
 * The Content field a form destination opens, found in the project as it is now: the setting the form's service needs
 * (or the service itself, when none is chosen), its Netlify form name, or the field row with the problem (its name,
 * or its choices), opened. Null when the form, or that setting, is no longer there.
 */
export function formDestinationField(state: ProjectState, dest: FormDestination): FormLanding | null {
  const tree = treeFor(state, dest.owner);
  const node = tree && Object.hasOwn(tree.nodes, dest.nodeId) ? tree.nodes[dest.nodeId] : undefined;
  const def = node?.kind === 'instance' && Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
  if (!node || node.kind !== 'instance' || !def || !isContactForm(def)) return null;
  if (dest.setting === 'connection') {
    const prop = formServiceSetup(def, node.props)?.prop ?? 'provider';
    const schema = Object.hasOwn(def.properties, prop) ? def.properties[prop] : undefined;
    return schema ? { prop, label: schema.label } : null;
  }
  const prop = dest.setting === 'formName' ? 'formName' : 'fields';
  const schema = Object.hasOwn(def.properties, prop) ? def.properties[prop] : undefined;
  if (!schema) return null;
  if (prop !== 'fields') return { prop, label: schema.label };
  // The row to open: the finding's own while it is still there, else the first with that problem (the second of two
  // fields sent under one name, the one to rename; or a question with no choices). With none, the list itself.
  const items = Array.isArray(node.props.fields) ? (node.props.fields as ListItem[]) : undefined;
  const sent = formFieldsAsSent(def, node.props.fields);
  const at = dest.setting === 'fieldKeys' ? formKeyClashes(sent)[0]?.indexes[1] : formUnchoosable(sent)[0];
  const itemId = dest.itemId && items?.some((it) => it?.id === dest.itemId) ? dest.itemId : at === undefined ? undefined : items?.[at]?.id;
  return itemId ? { prop, label: schema.label, itemId, field: dest.setting === 'fieldKeys' ? 'name' : 'options' } : { prop, label: schema.label };
}

/** What a destination's button says. */
export function destinationLabel(dest: EditorDestination): string {
  switch (dest.kind) {
    case 'form':
      return 'Go to form';
    case 'site':
      return { name: 'Go to Site name', description: 'Go to Default description', baseUrl: 'Go to Public URL', favicon: 'Go to site icon', socialImage: 'Go to sharing image', identity: 'Go to Published by', publisherUrl: 'Go to publisher’s web address', logo: 'Go to logo', sameAs: 'Go to profiles', llmsTxt: 'Go to AI agents', webmcp: 'Go to WebMCP', crawlerPolicy: 'Go to Crawlers', redirects: 'Go to Redirects' }[dest.field];
    case 'pageSeo':
      return dest.field === 'structuredData' ? 'Go to Structured data' : dest.field === 'pageTitle' ? 'Go to page title' : dest.field === 'canonical' ? 'Go to canonical URL' : 'Go to Search & sharing';
    case 'entry':
      return dest.field === 'body' && dest.picture ? 'Go to picture' : dest.field === 'canonical' ? 'Go to canonical URL' : 'Open post';
    case 'element':
      return 'Show on page';
    case 'prop':
      return 'Go to field';
  }
}

/**
 * Whether what an export note describes still holds in the project as it is now: `open` while it does, `fixed` once it
 * was put right after the export, `gone` when the form it names is no longer on the website (removed, or on a page
 * now kept as a draft). Null for a note with nothing to fix. `forms` are the notes for the website's forms visitors
 * cannot send now (websiteFormNotes), and `trees` what the website shows now (websiteTrees of the published state),
 * passed in when several notes are read against one project.
 */
export function noteState(state: ProjectState, note: ExportNote, forms: ExportNote[], trees?: ReturnType<typeof websiteTrees>): 'open' | 'fixed' | 'gone' | null {
  const dest = note.destination;
  if (!dest) return null;
  if (dest.kind === 'site') return dest.field !== 'baseUrl' ? null : publicUrl(state.site) ? 'fixed' : 'open';
  // Only an SEO finding leads to a page's settings, a post or an element; an export note never does.
  if (dest.kind !== 'form') return null;
  const { owner, nodeId } = dest;
  // Off the website first: a form on a page made a draft since is not one visitors can send, connected or not.
  const shown = (trees ?? websiteTrees(publishedState(state))).find((t) => t.owner.kind === owner.kind && t.owner.id === owner.id);
  if (!shown || !Object.hasOwn(shown.tree?.nodes ?? {}, nodeId)) return 'gone';
  return forms.some(({ destination: f }) => f?.kind === 'form' && f.owner.kind === owner.kind && f.owner.id === owner.id && f.nodeId === nodeId) ? 'open' : 'fixed';
}
