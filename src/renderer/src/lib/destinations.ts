import type { Diagnostic, EditorDestination, ExportNote } from '@shared/api';
import type { OwnerRef, ProjectState } from '@shared/types';
import { publicUrl } from '@shared/public-url';
import { formServiceSetup } from '@catalogue/foundation/form';
import { formConnectionDiagnostic } from '@engine/validate';
import { treeFor } from './model';

/**
 * Where a Project health finding is fixed, when that is a contact form's settings or a field of Site details: the
 * same places an export's notes lead to. Null for any other finding, which keeps its own action (Show on page).
 */
export function destinationForDiagnostic(state: ProjectState, d: Diagnostic): EditorDestination | null {
  // The site's icon and sharing image are set in Site details, not on any page.
  if (!d.owner && (d.site === 'favicon' || d.site === 'socialImage')) return { kind: 'site', field: d.site };
  const setting = d.code === 'FORM_UNCONNECTED' ? 'connection' : d.code === 'FORM_FIELD_KEYS' || d.code === 'FORM_NO_CHOICES' ? 'fields' : d.code === 'FORM_NAME_DUPLICATE' ? 'formName' : null;
  if (!setting || !d.owner || !d.nodeId || !['page', 'shell', 'template', 'component'].includes(d.owner.kind)) return null;
  const dest: EditorDestination = { kind: 'form', owner: d.owner as OwnerRef, nodeId: d.nodeId, setting };
  // A clash found at a placement whose design holds the form has no form settings there: it is shown on the page.
  return formDestinationField(state, dest) ? dest : null;
}

/**
 * The Content field a form destination opens, found in the project as it is now: the setting the form's service needs
 * (or the service itself, when none is chosen), its list of fields, or its Netlify form name. Null when the form, or
 * that setting, is no longer there.
 */
export function formDestinationField(state: ProjectState, dest: Extract<EditorDestination, { kind: 'form' }>): { prop: string; label: string } | null {
  const tree = treeFor(state, dest.owner);
  const node = tree && Object.hasOwn(tree.nodes, dest.nodeId) ? tree.nodes[dest.nodeId] : undefined;
  const def = node?.kind === 'instance' && Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
  if (!node || node.kind !== 'instance' || !def) return null;
  const prop = dest.setting === 'fields' ? 'fields' : dest.setting === 'formName' ? 'formName' : (formServiceSetup(def, node.props)?.prop ?? 'provider');
  const schema = Object.hasOwn(def.properties, prop) ? def.properties[prop] : undefined;
  return schema ? { prop, label: schema.label } : null;
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
  if (forms.some(({ destination: f }) => f?.kind === 'form' && f.owner.kind === owner.kind && f.owner.id === owner.id && f.nodeId === nodeId)) return 'open';
  const tree = treeFor(state, owner);
  const node = tree && Object.hasOwn(tree.nodes, nodeId) ? tree.nodes[nodeId] : undefined;
  // Still unconnected, but not among the website's forms: its page (or shared part, or layout) is no longer published.
  return !node || formConnectionDiagnostic(state, owner, '', node) ? 'gone' : 'fixed';
}
