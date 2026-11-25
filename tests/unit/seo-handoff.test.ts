// Fix with AI and Optimize with AI (#599): a Search & AI readiness finding, or a page's or post's Search & sharing
// previews, open the AI chat with the request in the message box and the scope it needs: the page it is about, or the
// whole site. Nothing is sent, and a message already being written is never replaced.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementRef, ProjectState } from '@shared/types';
import type { ChatEditScope, ChatMode, ProjectSnapshot } from '@shared/api';
import type { SeoFinding } from '@shared/seo';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { runSeoAudit } from '@engine/seo-audit';
import { withTypedSeo } from '../../src/renderer/src/lib/seo-preview';
import { findingHandoff, previewHandoff, type SeoHandoff } from '../../src/renderer/src/lib/seoHandoff';

const newConversation = vi.fn();
const send = vi.fn();
const saved: unknown[] = [];
vi.stubGlobal('window', { builder: { project: { saveLocalState: async (s: unknown) => void saved.push(s) }, ai: { newConversation, send }, platform: 'darwin' } });

const base = createStarterState('business', 'Studio', false);
const home = base.site.homePageId;
const about = base.site.pageOrder.find((id) => base.pages[id].title === 'About')!;
const contact = base.site.pageOrder.find((id) => base.pages[id].title === 'Contact')!;

const finding = (code: string, destination: SeoFinding['destination'], extra: Partial<SeoFinding> = {}): SeoFinding => ({ code, severity: 'warning', message: code, pillar: 'content', explanation: '', aiFixable: true, destination, ...extra });
const pageSeo = (pageId: string, field: 'title' | 'description' | 'noindex' | 'socialImage') => ({ kind: 'pageSeo' as const, pageId, field });

describe('the request for a finding', () => {
  it('asks for a page’s missing, repeated or badly sized search title and meta description, on that page alone', () => {
    const page = (text: string, pageId = about): SeoHandoff => ({ mode: 'edit', scope: 'page', pageId, text });
    expect(findingHandoff(base, finding('SEO_DESCRIPTION_MISSING', pageSeo(about, 'description')))).toEqual(page('Write a meta description for the “About” page'));
    expect(findingHandoff(base, finding('SEO_TITLE_MISSING', pageSeo(about, 'title')))).toEqual(page('Write a search title for the “About” page'));
    expect(findingHandoff(base, finding('SEO_TITLE_DUPLICATE', pageSeo(contact, 'title')))).toEqual(page('Give the “Contact” page a search title of its own that no other page shares', contact));
    expect(findingHandoff(base, finding('SEO_TITLE_LENGTH', pageSeo(about, 'title'), { severity: 'info' }))).toEqual(page('Rewrite the search title of the “About” page in 15 to 60 characters'));
    expect(findingHandoff(base, finding('SEO_DESCRIPTION_LENGTH', pageSeo(about, 'description'), { severity: 'info' }))).toEqual(page('Rewrite the meta description of the “About” page in 50 to 160 characters'));
    expect(findingHandoff(base, finding('SEO_HOME_NOINDEX', pageSeo(home, 'noindex'), { pillar: 'technical' }))).toEqual(page('Let search engines list the “Home” page again', home));
    expect(findingHandoff(base, finding('SEO_DESCRIPTION_DUPLICATE', pageSeo(about, 'description')))).toEqual(page('Give the “About” page a meta description of its own that no other page shares'));
    // A listing setting this knows no request for gets none.
    expect(findingHandoff(base, finding('SEO_SOMETHING_ELSE', pageSeo(home, 'noindex')))).toBeNull();
  });

  it('names a page by its address too when another page has the same title', () => {
    const twin = applyOperations(base, [{ type: 'page.create', title: 'About', route: '/team/about/', starter: 'intro' }]);
    const id = twin.results[0].pageId as string;
    expect(findingHandoff(twin.state, finding('SEO_DESCRIPTION_MISSING', pageSeo(id, 'description')))?.text).toBe('Write a meta description for the “About” (/team/about/) page');
  });

  it('asks for llms.txt and robots.txt as changes to the whole site', () => {
    const site = (text: string): SeoHandoff => ({ mode: 'edit', scope: 'site', text });
    expect(findingHandoff(base, finding('SEO_LLMS_TXT_OFF', { kind: 'site', field: 'llmsTxt' }, { severity: 'info', pillar: 'agentic' }))).toEqual(site('Turn on llms.txt so AI agents get an index of the site’s pages'));
    expect(findingHandoff(base, finding('SEO_SEARCH_CRAWLERS_BLOCKED', { kind: 'site', field: 'crawlerPolicy' }))).toEqual(site('Let search engines crawl the whole website again in robots.txt, keeping the other crawler rules'));
    // Whether AI training crawlers are let in is the author's own choice, which the request leaves alone.
    expect(findingHandoff(base, finding('SEO_AI_SEARCH_CRAWLERS_BLOCKED', { kind: 'site', field: 'crawlerPolicy' }))).toEqual(site('Let AI search engines crawl the whole website again in robots.txt, keeping the other crawler rules'));
  });

  it('rewords a link with generic words on its page, or across the site when it is in the shared header', () => {
    const pageNode = base.pages[about].rootIds[0];
    const headerNode = base.site.shell.header.rootIds[0];
    const onPage = finding('SEO_LINK_TEXT_GENERIC', { kind: 'element', owner: { kind: 'page', id: about }, nodeId: pageNode }, { message: 'A link says only “Read more”.', severity: 'info' });
    expect(findingHandoff(base, onPage)).toEqual({ mode: 'edit', scope: 'page', pageId: about, text: 'Reword the “Read more” link on the “About” page so its words say where it leads' });
    const inHeader = finding('SEO_LINK_TEXT_GENERIC', { kind: 'element', owner: { kind: 'shell', id: 'header' }, nodeId: headerNode }, { message: 'A link says only “Click here!” in the shared header.', severity: 'info' });
    expect(findingHandoff(base, inHeader)).toEqual({ mode: 'edit', scope: 'site', text: 'Reword the “Click here!” link in the site header so its words say where it leads' });
    const footerNode = base.site.shell.footer.rootIds[0];
    const inFooter = { ...inHeader, message: 'A link says only “More” in the shared footer.', destination: { kind: 'element' as const, owner: { kind: 'shell' as const, id: 'footer' }, nodeId: footerNode } };
    expect(findingHandoff(base, inFooter)).toEqual({ mode: 'edit', scope: 'site', text: 'Reword the “More” link in the site footer so its words say where it leads' });
    // The element gone since, or a layout's link (which the AI can't change yet), gets none.
    expect(findingHandoff(base, { ...onPage, destination: { kind: 'element', owner: { kind: 'page', id: about }, nodeId: 'n_gone' } })).toBeNull();
    expect(findingHandoff(base, { ...inFooter, destination: { kind: 'element', owner: { kind: 'shell', id: 'footer' }, nodeId: 'n_gone' } })).toBeNull();
    expect(findingHandoff(base, { ...onPage, destination: { kind: 'element', owner: { kind: 'template', id: 'posts' }, nodeId: pageNode } })).toBeNull();
  });

  it('offers none for what the AI can’t fix, what it can’t reach, or what has gone', () => {
    expect(findingHandoff(base, finding('SEO_BASE_URL_MISSING', { kind: 'site', field: 'baseUrl' }, { aiFixable: false }))).toBeNull();
    expect(findingHandoff(base, finding('SEO_DESCRIPTION_MISSING', pageSeo(about, 'description'), { aiFixable: false }))).toBeNull();
    // A post's fields are changed only in the editor, whatever the finding says.
    expect(findingHandoff(base, finding('SEO_DESCRIPTION_MISSING', { kind: 'entry', collectionId: 'posts', entryId: 'en_1', field: 'excerpt' }))).toBeNull();
    expect(findingHandoff(base, finding('SEO_DESCRIPTION_MISSING', pageSeo('pg_gone', 'description')))).toBeNull();
    expect(findingHandoff(base, finding('SEO_SOCIAL_IMAGE_MISSING', pageSeo(about, 'socialImage')))).toBeNull();
    expect(findingHandoff(base, finding('SEO_SOMETHING_NEW', { kind: 'site', field: 'favicon' }))).toBeNull();
    expect(findingHandoff(base, finding('SEO_SOMETHING_NEW', undefined))).toBeNull();
  });

  it('offers none, rather than taking the dialog down, for a project document with something unexpected in it', () => {
    const damaged = structuredClone(base);
    (damaged.pages[contact] as { title?: unknown }).title = undefined;
    expect(() => findingHandoff(damaged, finding('SEO_DESCRIPTION_MISSING', pageSeo(about, 'description')))).not.toThrow();
    expect(findingHandoff(damaged, finding('SEO_DESCRIPTION_MISSING', pageSeo(about, 'description')))).toBeNull();
    expect(previewHandoff(damaged, { kind: 'page', pageId: about })).toBeNull();
  });

  it('turns the audit’s own findings into requests, and a post’s into none', () => {
    const s = structuredClone(base);
    s.site.description = '';
    s.pages[about].seo = { ...s.pages[about].seo, description: '' };
    const missing = runSeoAudit(s).find((f) => f.code === 'SEO_DESCRIPTION_MISSING' && f.owner?.id === about)!;
    expect(missing).toMatchObject({ aiFixable: true, destination: pageSeo(about, 'description') });
    expect(findingHandoff(s, missing)).toEqual({ mode: 'edit', scope: 'page', pageId: about, text: 'Write a meta description for the “About” page' });
    const posted = applyOperations(s, [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring', publishedAt: '2027-03-02', draft: false, excerpt: 'Short.', body: [{ type: 'p', spans: [{ text: 'Classes open.' }] }] },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', seoTitle: 'Spring' }
    ]);
    const entryFindings = runSeoAudit(posted.state).filter((f) => f.owner?.kind === 'entry');
    // Its own search title too short, and its excerpt standing in for a description too short: both the editor's.
    expect(entryFindings.map((f) => f.code)).toEqual(expect.arrayContaining(['SEO_TITLE_LENGTH', 'SEO_DESCRIPTION_LENGTH']));
    for (const f of entryFindings) expect([f.code, f.aiFixable, findingHandoff(posted.state, f)]).toEqual([f.code, false, null]);
  });
});

describe('the request for the Search & sharing previews', () => {
  it('asks to improve a page’s search title and meta description, on that page', () => {
    expect(previewHandoff(base, { kind: 'page', pageId: about })).toEqual({ mode: 'edit', scope: 'page', pageId: about, text: 'Read the “About” page and improve its search title and meta description for search results, link previews and AI answers' });
    expect(previewHandoff(base, { kind: 'page', pageId: 'pg_gone' })).toBeNull();
  });

  it('names the page it is about, whichever page that is', () => {
    expect(previewHandoff(base, { kind: 'page', pageId: contact })?.text).toBe('Read the “Contact” page and improve its search title and meta description for search results, link previews and AI answers');
  });

  it('asks a question about a post, with what it holds as typed, since the AI can’t change posts yet', () => {
    const r = applyOperations(base, [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring classes', publishedAt: '2027-03-02', draft: false, excerpt: 'Wheel  classes\nfor beginners.', body: [{ type: 'p', spans: [{ text: 'x'.repeat(700) }] }] }
    ]);
    const subject = { kind: 'entry' as const, collectionId: 'posts', entryId: 'en_spring' };
    // A description typed a moment ago, and not saved yet, is the one asked about.
    const typed = withTypedSeo(r.state, subject, { description: 'Autumn dates' });
    const h = previewHandoff(typed, subject)!;
    expect(h.mode).toBe('ask');
    const lines = h.text.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'Suggest a search title (15 to 60 characters) and a meta description (50 to 160 characters) for my post “Spring classes”, for me to paste into its Search & sharing settings.',
      'Post title: Spring classes',
      'Meta description now: Autumn dates',
      'Excerpt: Wheel classes for beginners.'
    ]);
    // The opening is clipped, and a field with nothing in it is left out.
    expect(lines[4]).toMatch(/^Opening: x{599}…$/);
    expect(lines).toHaveLength(5);
    expect(h.text).not.toContain('Search title now');
    expect(previewHandoff(r.state, { ...subject, entryId: 'en_gone' })).toBeNull();
  });

  it('quotes the post’s own search title, clips by characters as a reader counts them, and survives damaged text', () => {
    const r = applyOperations(base, [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_glaze', title: 'Glazes', publishedAt: '2027-03-02', draft: false, excerpt: `${'a'.repeat(298)}😀 and more`, body: [{ type: 'p', spans: [{ text: 'Kiln days.' }] }] },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_glaze', seoTitle: 'Glaze classes' }
    ]);
    const subject = { kind: 'entry' as const, collectionId: 'posts', entryId: 'en_glaze' };
    const lines = previewHandoff(r.state, subject)!.text.split('\n');
    expect(lines).toContain('Search title now: Glaze classes');
    // Cut after the emoji, never through it.
    expect(lines).toContain(`Excerpt: ${'a'.repeat(298)}😀…`);
    const damaged = structuredClone(r.state);
    (damaged.collections.posts.entries.en_glaze as { body: unknown }).body = [{ type: 'p', spans: 'not spans' }];
    const h = previewHandoff(damaged, subject)!;
    expect(h.mode).toBe('ask');
    expect(h.text).not.toContain('Opening:');
  });
});

interface EditorState {
  snapshot: ProjectSnapshot | null;
  pageId: string | null;
  selection: ElementRef | null;
  rightTab: string;
  dockOpen: boolean;
  modal: unknown;
  mode: 'edit' | 'preview';
  definitionMode: { definitionId: string; returnPageId: string } | null;
  templateMode: { collectionId: string } | null;
  chatMode: ChatMode;
  chatContextEnabled: { page: boolean; scope: ChatEditScope };
  chatFocus: { workspaceKey: string; pageId: string; at: number } | null;
  conversation: { id: string } | null;
  chatDrafts: Record<string, string>;
  chatImages: Record<string, string[]>;
  activeRunId: string | null;
  runStatus: string | null;
  toasts: Array<{ text: string }>;
}
const load = (path: string) => import(/* @vite-ignore */ path);
let actions: { openSeoChat: (h: SeoHandoff) => Promise<boolean> };
let store: { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };

const headerRef: ElementRef = { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: base.site.shell.header.rootIds[0] };
const toAbout: SeoHandoff = { mode: 'edit', scope: 'page', pageId: about, text: 'Write a meta description for the “About” page' };
const toSite: SeoHandoff = { mode: 'edit', scope: 'site', text: 'Turn on llms.txt so AI agents get an index of the site’s pages' };

describe('opening the chat with the request', () => {
  beforeEach(async () => {
    saved.length = 0;
    newConversation.mockReset();
    send.mockReset();
    vi.resetModules();
    actions = await load('../../src/renderer/src/lib/actions');
    store = await load('../../src/renderer/src/store');
    store.setState({
      snapshot: { state: base, revision: 1, workspaceKey: 'opening#1' } as unknown as ProjectSnapshot,
      pageId: home,
      selection: headerRef,
      rightTab: 'inspect',
      dockOpen: false,
      modal: { kind: 'health', section: 'seo' },
      mode: 'edit',
      chatMode: 'ask',
      chatContextEnabled: { page: false, scope: 'selection' },
      conversation: { id: 'c_1' },
      chatDrafts: {},
      chatImages: {}
    });
  });

  it('opens the page a finding is about, with the request in the box and the page as its scope, and sends nothing', async () => {
    // From a visitor's view too: the request is an edit, made in Edit.
    store.setState({ mode: 'preview' });
    expect(await actions.openSeoChat(toAbout)).toBe(true);
    const s = store.getState();
    expect(s.mode).toBe('edit');
    expect([s.pageId, s.selection, s.modal]).toEqual([about, null, null]);
    expect([s.rightTab, s.dockOpen, s.chatMode]).toEqual(['chat', true, 'edit']);
    expect(s.chatContextEnabled).toEqual({ page: true, scope: 'page' });
    expect(s.chatDrafts).toEqual({ c_1: toAbout.text });
    expect(s.chatFocus).toEqual({ workspaceKey: 'opening#1', pageId: about, at: expect.any(Number) });
    expect(send).not.toHaveBeenCalled();
    expect(newConversation).not.toHaveBeenCalled();
    expect(saved).toContainEqual({ chatMode: 'edit' });
  });

  it('asks for a change to the whole site from the page on screen, leaving what is selected there', async () => {
    expect(await actions.openSeoChat(toSite)).toBe(true);
    const s = store.getState();
    expect([s.pageId, s.selection, s.modal, s.chatMode]).toEqual([home, headerRef, null, 'edit']);
    expect(s.chatContextEnabled).toEqual({ page: true, scope: 'site' });
    expect(s.chatDrafts).toEqual({ c_1: toSite.text });
  });

  it('leaves a component edited everywhere for its page, so the request is not about the component', async () => {
    store.setState({ definitionMode: { definitionId: Object.keys(base.components)[0], returnPageId: contact } });
    expect(await actions.openSeoChat(toSite)).toBe(true);
    const s = store.getState();
    expect([s.definitionMode, s.pageId]).toEqual([null, contact]);
    expect(s.chatContextEnabled.scope).toBe('site');
    // A collection's layout too.
    store.setState({ templateMode: { collectionId: 'posts' }, chatDrafts: {} });
    expect(await actions.openSeoChat(toSite)).toBe(true);
    expect(store.getState().templateMode).toBeNull();
  });

  it('asks a question without moving anything or changing the scope', async () => {
    const ask: SeoHandoff = { mode: 'ask', text: 'Suggest a search title' };
    store.setState({ chatMode: 'edit' });
    expect(await actions.openSeoChat(ask)).toBe(true);
    const s = store.getState();
    expect([s.pageId, s.selection, s.chatMode]).toEqual([home, headerRef, 'ask']);
    expect(s.chatContextEnabled).toEqual({ page: false, scope: 'selection' });
    expect(s.chatDrafts).toEqual({ c_1: ask.text });
  });

  it('opens a new conversation rather than replace a message being written, which stays with its own', async () => {
    for (const unsent of [{ chatDrafts: { c_1: 'My own words' } }, { chatImages: { c_1: ['a_photo'] } }]) {
      newConversation.mockReset().mockResolvedValue({ id: 'c_2' });
      store.setState({ conversation: { id: 'c_1' }, chatDrafts: {}, chatImages: {}, ...unsent });
      expect(await actions.openSeoChat(toAbout)).toBe(true);
      const s = store.getState();
      expect(newConversation).toHaveBeenCalledTimes(1);
      expect(s.conversation).toEqual({ id: 'c_2' });
      expect(s.chatDrafts).toEqual({ ...(unsent.chatDrafts ?? {}), c_2: toAbout.text });
      expect(s.chatImages).toEqual(unsent.chatImages ?? {});
      expect(s.chatContextEnabled).toEqual({ page: true, scope: 'page' });
    }
    // Spaces alone are no message: the request takes their place in the same conversation.
    newConversation.mockReset();
    store.setState({ conversation: { id: 'c_2' }, chatDrafts: { c_2: '   ' }, chatImages: {} });
    expect(await actions.openSeoChat(toAbout)).toBe(true);
    expect(newConversation).not.toHaveBeenCalled();
    expect(store.getState().chatDrafts).toEqual({ c_2: toAbout.text });
  });

  it('does nothing when the project changed, or the page went, while the new conversation opened', async () => {
    store.setState({ chatDrafts: { c_1: 'Mine' } });
    let open!: (c: { id: string }) => void;
    newConversation.mockReturnValue(new Promise((r) => (open = r)));
    const pending = actions.openSeoChat(toAbout);
    // A second click meanwhile opens no second conversation.
    expect(await actions.openSeoChat(toAbout)).toBe(false);
    store.setState({ snapshot: { state: base, revision: 1, workspaceKey: 'opening#2' } as unknown as ProjectSnapshot });
    open({ id: 'c_2' });
    expect(await pending).toBe(false);
    expect(newConversation).toHaveBeenCalledTimes(1);
    expect(store.getState().conversation).toEqual({ id: 'c_1' });
    expect(store.getState().modal).toEqual({ kind: 'health', section: 'seo' });

    const gone: ProjectState = structuredClone(base);
    delete gone.pages[about];
    gone.site.pageOrder = gone.site.pageOrder.filter((id) => id !== about);
    newConversation.mockResolvedValue({ id: 'c_3' });
    const later = actions.openSeoChat(toAbout);
    store.setState({ snapshot: { state: gone, revision: 2, workspaceKey: 'opening#2' } as unknown as ProjectSnapshot });
    expect(await later).toBe(false);
    expect(newConversation).toHaveBeenCalledTimes(2);
    // The AI writes to the new conversation now, so the chat shows it; the message being written stays with its own.
    expect(store.getState().conversation).toEqual({ id: 'c_3' });
    expect(store.getState().pageId).toBe(home);
    expect(store.getState().chatDrafts).toEqual({ c_1: 'Mine' });
    expect(store.getState().toasts.map((t) => t.text)).toContain('That page is no longer on the site.');
    // Gone before it is asked for: nothing opens at all.
    newConversation.mockReset();
    expect(await actions.openSeoChat(toAbout)).toBe(false);
    expect(newConversation).not.toHaveBeenCalled();
  });

  it('waits while the AI works on another request, or while the conversation loads', async () => {
    store.setState({ activeRunId: 'run_1', runStatus: 'running' });
    expect(await actions.openSeoChat(toAbout)).toBe(false);
    store.setState({ activeRunId: null, runStatus: null, conversation: null });
    expect(await actions.openSeoChat(toAbout)).toBe(false);
    const s = store.getState();
    expect([s.pageId, s.rightTab, s.chatDrafts]).toEqual([home, 'inspect', {}]);
    expect(s.toasts.map((t) => t.text)).toEqual(['The AI is still working on a request. Try again once it has finished.', 'The AI conversation is still loading. Try again in a moment.']);
  });

  it('opens once the last request has ended, though the chat still names that run', async () => {
    // A finished run's last message sets its ID again after its status has cleared (store's applyAiEvent).
    store.setState({ activeRunId: 'run_1', runStatus: null });
    expect(await actions.openSeoChat(toAbout)).toBe(true);
    expect(store.getState().chatDrafts).toEqual({ c_1: toAbout.text });
  });
});
