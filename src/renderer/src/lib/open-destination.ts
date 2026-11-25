import type { EditorDestination } from '@shared/api';
import type { ElementRef, ProjectState } from '@shared/types';
import { getState, inspectorFocusRequest, setState, toast } from '../store';
import { openSection } from '../components/ui';
import { pageShowing } from '@shared/page-shell';
import { siteEntries } from '@generator/index';
import { openComponentStudio, openLayout, openPost, openSiteStyles, selectPage, setMode } from './actions';
import { formDestinationField } from './destinations';
import { treeFor } from './model';

/** The section of Site styles each site field is in, and the control it is reached by (see SiteStyles): a site image's card, by its first button. */
const SITE_FIELDS: Record<Extract<EditorDestination, { kind: 'site' }>['field'], { section: string; focus: string }> = {
  baseUrl: { section: 'site-settings', focus: '#site-public-url' },
  favicon: { section: 'site-settings', focus: '#site-favicon button' },
  socialImage: { section: 'site-settings', focus: '#site-social-image button' },
  identity: { section: 'site-settings', focus: '#site-identity-kind' },
  logo: { section: 'site-settings', focus: '#site-identity-logo button' },
  sameAs: { section: 'site-settings', focus: '#site-identity-profiles' },
  llmsTxt: { section: 'site-agents', focus: '#site-llms-txt' },
  webmcp: { section: 'site-agents', focus: '#site-webmcp' },
  crawlerPolicy: { section: 'site-crawlers', focus: '#site-crawler-preset' },
  // The first redirect with a problem, by its Edit button.
  redirects: { section: 'site-redirects', focus: '.so-redirect.has-problem .so-redirect-edit' }
};

/** The control each Search & sharing field of a page is reached by (see the page Inspector). */
const PAGE_SEO_FIELDS: Record<Extract<EditorDestination, { kind: 'pageSeo' }>['field'], string> = {
  title: '#page-seo-title',
  description: '#page-seo-description',
  noindex: '#page-seo-noindex',
  socialImage: '[data-seo-field="socialImage"] button',
  structuredData: '#page-structured-type',
  pageTitle: '[data-seo-field="pageTitle"] input'
};

/**
 * Take the author to where a Project health finding, an SEO finding or an export note is fixed, closing the dialog that named it.
 * A contact form is selected where it is (its page, a page showing the shared header or footer, its collection's
 * layout, or its component in Component Studio) with Content open and the setting it needs focused; a site setting
 * opens Site styles with its section expanded and its field focused. A form that has gone since is said, and nothing
 * moves.
 */
export function openEditorDestination(dest: EditorDestination) {
  const s = getState();
  const snap = s.snapshot;
  if (!snap) return;
  if (dest.kind === 'site') {
    setState({ modal: null });
    openSiteStyles();
    // Site styles shows once the dock has switched to it: the field's section then opens, scrolls to the field and focuses it.
    const { section, focus } = SITE_FIELDS[dest.field];
    requestAnimationFrame(() => openSection(section, { focus }));
    return;
  }
  if (dest.kind === 'pageSeo') {
    if (!Object.hasOwn(snap.state.pages, dest.pageId)) return toast('That page is no longer on the site.', 'info');
    if (s.mode !== 'edit') setMode('edit');
    // The page itself is selected, so the Inspector shows its settings, with Search & sharing (or Structured data, for
    // what the page is) opened at the field.
    selectPage(dest.pageId, null);
    setState({ modal: null, rightTab: 'inspect', dockOpen: true });
    const section = dest.field === 'structuredData' ? 'page-structured-data' : dest.field === 'pageTitle' ? 'page-basic' : 'page-seo';
    return revealWhenShown(section, PAGE_SEO_FIELDS[dest.field]);
  }
  if (dest.kind === 'entry') {
    const collection = Object.hasOwn(snap.state.collections ?? {}, dest.collectionId) ? snap.state.collections[dest.collectionId] : undefined;
    if (!collection || !Object.hasOwn(collection.entries, dest.entryId)) return toast('That post is no longer on the site.', 'info');
    // The writer shows the post, at the picture when one is named; its title or excerpt is focused once it shows.
    const writer = dest.field !== 'body' && Object.hasOwn(POST_FIELDS, dest.field) ? POST_FIELDS[dest.field] : undefined;
    return void openPost(dest.collectionId, dest.entryId, dest.field === 'body' ? dest.picture : undefined).then(() => {
      if (writer && getState().post?.entryId === dest.entryId) revealInWriter(writer);
    });
  }
  if (dest.kind === 'element') return showElement(snap.state, dest);
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
    // A setting read from each entry is fixed on the entry that cannot send: its own field, in the post writer, when
    // the writer edits that field. Otherwise the layout shows that entry, with the choice of what it reads focused.
    const writer = field.entryId && field.entryField && Object.hasOwn(POST_FIELDS, field.entryField) ? POST_FIELDS[field.entryField] : undefined;
    if (owner.kind === 'template' && writer) return void openPost(owner.id, field.entryId!).then(() => revealInWriter(writer));
    setState({ modal: null, selection: ref, rightTab: 'inspect', dockOpen: true });
    return revealWhenShown('entry-fields', `#${CSS.escape(`entry-field-${nodeId}-${field.prop}`)}`);
  }
  // The Inspector of the form takes the request: it opens Content (and a field's row) and focuses the setting once it shows.
  const at = field.itemId ? { itemId: field.itemId, field: field.field } : {};
  setState({ modal: null, selection: ref, rightTab: 'inspect', dockOpen: true, inspectorFocus: inspectorFocusRequest({ opening: snap.workspaceKey, owner, nodeId, prop: field.prop, ...at, label: field.label }) });
}

/**
 * Select an element where it is: its page, a page showing the shared header or footer, or its collection's layout
 * (on the entry named, else the first). One no longer there is said, and nothing moves.
 */
function showElement(state: ProjectState, dest: Extract<EditorDestination, { kind: 'element' }>) {
  const s = getState();
  const { owner, nodeId } = dest;
  const tree = treeFor(state, owner);
  if (!tree || !Object.hasOwn(tree.nodes, nodeId)) return toast('That element is no longer on the site.', 'info');
  const ref: ElementRef = { owner, instancePath: [], nodeId };
  if (s.mode !== 'edit') setMode('edit');
  if (owner.kind === 'page') selectPage(owner.id, ref);
  else if (owner.kind === 'template') openLayout(owner.id, dest.entryId);
  else if (owner.kind === 'component') {
    if (!openComponentStudio(owner.id)) return toast('That element is in a component that can no longer be edited here.', 'info');
  } else {
    // A page showing the shared part, else a post's page, else a collection's layout, whose index shows it too.
    const pageId = pageShowing(state, owner.id, s.definitionMode?.returnPageId ?? s.pageId);
    const entry = pageId ? undefined : siteEntries(state)[0];
    const collectionId = pageId || entry ? undefined : Object.keys(state.collections ?? {}).sort()[0];
    if (pageId) selectPage(pageId, ref);
    else if (entry) openLayout(entry.collection.settings.id, entry.entry.id);
    else if (collectionId) openLayout(collectionId);
    else return toast(`No page shows the shared ${owner.id} right now.`, 'info');
  }
  // Opened from the post writer or the SEO view, Layers takes its place, so the canvas shows the element where it is.
  setState({ modal: null, selection: ref, rightTab: 'inspect', dockOpen: true, ...(getState().leftTab === 'posts' || getState().leftTab === 'seo' ? { leftTab: 'layers' as const } : {}) });
}

/** Frames to wait for the Inspector of a new selection (or the post writer) to show a control, before giving up quietly. */
const REVEAL_FRAMES = 60;

/** An entry's fields the post writer edits, by the control that edits each (see PostWriter). */
const POST_FIELDS: Record<string, string> = {
  title: '.post-title-input',
  author: '[data-entry-field="author"] input',
  excerpt: '[data-entry-field="excerpt"] textarea',
  seoTitle: '[data-entry-field="seoTitle"] input',
  seoDescription: '[data-entry-field="seoDescription"] textarea'
};

/** Focus a field of the open post once the writer shows it, its details opened first when it is one of them. */
function revealInWriter(control: string) {
  let frames = 0;
  const step = () => {
    const el = document.querySelector<HTMLElement>(`.post-writer-holder:not([hidden]) ${control}`);
    if (!el) return void (++frames < REVEAL_FRAMES && requestAnimationFrame(step));
    const details = el.closest('details');
    if (details && !details.open) details.open = true;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  };
  requestAnimationFrame(step);
}

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
