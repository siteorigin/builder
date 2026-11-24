import type { EditorDestination } from '@shared/api';
import type { ElementRef } from '@shared/types';
import { getState, inspectorFocusRequest, setState, toast } from '../store';
import { openSection } from '../components/ui';
import { goToShellPart, openComponentStudio, openLayout, openSiteStyles, selectPage, setMode } from './actions';
import { formDestinationField } from './destinations';

/** The control each Site details field is reached by (see SiteStyles): a site image's card, by its first button. */
const SITE_FIELDS: Record<Extract<EditorDestination, { kind: 'site' }>['field'], string> = {
  baseUrl: '#site-public-url',
  favicon: '#site-favicon button',
  socialImage: '#site-social-image button'
};

/**
 * Take the author to where a Project health finding or an export note is fixed, closing the dialog that named it.
 * A contact form is selected where it is (its page, a page showing the shared header or footer, its collection's
 * layout, or its component in Component Studio) with Content open and the setting it needs focused; a site setting
 * opens Site styles with Site details expanded and its field focused. A form that has gone since is said, and nothing
 * moves.
 */
export function openEditorDestination(dest: EditorDestination) {
  const s = getState();
  const snap = s.snapshot;
  if (!snap) return;
  if (dest.kind === 'site') {
    setState({ modal: null });
    openSiteStyles();
    // Site styles shows once the dock has switched to it: Site details then opens, scrolls to the field and focuses it.
    requestAnimationFrame(() => openSection('site-settings', { focus: SITE_FIELDS[dest.field] }));
    return;
  }
  const field = formDestinationField(snap.state, dest);
  if (!field) return toast('That form is no longer on the site.', 'info');
  const { owner, nodeId } = dest;
  const ref: ElementRef = { owner, instancePath: [], nodeId };
  if (s.mode !== 'edit') setMode('edit');
  if (owner.kind === 'page') selectPage(owner.id, ref);
  else if (owner.kind === 'template') openLayout(owner.id);
  else if (owner.kind === 'component') {
    if (!openComponentStudio(owner.id)) return toast('That form is in a component that can no longer be edited here.', 'info');
  } else if (!goToShellPart(owner.id)) return toast(`No page shows the shared ${owner.id} right now.`, 'info');
  // The Inspector of the form takes the request: it opens Content and focuses the setting once it shows.
  setState({ modal: null, selection: ref, rightTab: 'inspect', dockOpen: true, inspectorFocus: inspectorFocusRequest({ opening: snap.workspaceKey, owner, nodeId, prop: field.prop, label: field.label }) });
}
