import type { EditorDestination } from '@shared/api';
import type { ElementRef } from '@shared/types';
import { getState, inspectorFocusRequest, setState, toast } from '../store';
import { openSection } from '../components/ui';
import { pageShowing } from '@shared/page-shell';
import { siteEntries } from '@generator/index';
import { openComponentStudio, openLayout, openSiteStyles, selectPage, setMode } from './actions';
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
  else if (owner.kind === 'template') openLayout(owner.id, field.entryId);
  else if (owner.kind === 'component') {
    if (!openComponentStudio(owner.id)) return toast('That form is in a component that can no longer be edited here.', 'info');
  } else {
    // The page on screen when it shows the shared part, else the first that does; else an entry, whose page shows both.
    const pageId = pageShowing(snap.state, owner.id, s.definitionMode?.returnPageId ?? s.pageId);
    const entry = pageId ? undefined : siteEntries(snap.state)[0];
    // Chosen even when it is the page already open, so a collection layout or a component being edited closes.
    if (pageId) selectPage(pageId, ref);
    else if (entry) openLayout(entry.collection.settings.id, entry.entry.id);
    else return toast(`No page shows the shared ${owner.id} right now.`, 'info');
  }
  if (field.entryBound) {
    // A layout's setting read from each entry is chosen in Entry content: that choice is focused once it shows.
    setState({ modal: null, selection: ref, rightTab: 'inspect', dockOpen: true });
    return revealWhenShown('entry-fields', `#${CSS.escape(`entry-field-${nodeId}-${field.prop}`)}`);
  }
  // The Inspector of the form takes the request: it opens Content (and a field's row) and focuses the setting once it shows.
  const at = field.itemId ? { itemId: field.itemId, field: field.field } : {};
  setState({ modal: null, selection: ref, rightTab: 'inspect', dockOpen: true, inspectorFocus: inspectorFocusRequest({ opening: snap.workspaceKey, owner, nodeId, prop: field.prop, ...at, label: field.label }) });
}

/** Frames to wait for the Inspector of a new selection to show a control, before giving up quietly. */
const REVEAL_FRAMES = 60;

/**
 * Open a section of the Inspector once the new selection's Inspector shows it, then scroll to and focus one control
 * in it. Nothing happens when it never shows (the selection changed again, say).
 */
function revealWhenShown(section: string, control: string) {
  let frames = 0;
  const step = () => {
    if (document.querySelector(`#dock-panel-inspect ${control}`)) return openSection(section, { focus: control });
    // Opened while waiting: a section closed before shows its controls only once it is open.
    openSection(section, { scroll: false });
    if (++frames < REVEAL_FRAMES) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
