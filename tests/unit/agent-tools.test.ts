import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { ElementRef, GraphNode, InstanceNode, LinkValue, ListItem, ProjectState, PropSchema, TableValue } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent, listThemes } from '@catalogue/index';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalItem, CanonicalModelRequest, ModelCapabilities, ModelEvent, ToolDefinition } from '@agent/types';
import { FOCUSED_PAGE_OPERATIONS, PAGE_OPERATIONS, toolsForRun } from '@agent/tools';
import { checkProps, connectPendingLinks, newMacroMemory, runUpsert, upsertToolSchema, withStoredFields } from '@agent/macros';
import { checkAuthority, type Authority } from '@agent/scope';
import type { ToolHost } from '@agent/tools';
import { applyOperations } from '@engine/apply';
import type { EditOperation } from '@shared/ops';
import { compactPropsSchema, hasOpenSchema, propsJsonSchema } from '@agent/propschema';
import { propSchemaSummary } from '@agent/context';
import { P } from '@catalogue/dsl';
import { findForbiddenShapes, toStrictSchema } from '@agent/strict-schema';
import { envelopeInstructions } from '@agent/constrained';
import { selectionTools } from '@agent/selection';
import { applyContextBudget, estimateRequestTokens } from '@agent/budget';
import { findStubPages } from '@agent/completeness';
import { checkExample, retrieveExamples } from '@agent/examples';
import { contrastRatio, derivedBrandTokens } from '@agent/brand';
import { TYPE_SCALE_CHOICES, TYPE_SCALE_ROLES, scaleMetrics } from '@shared/type-scale';
import { ProjectSession } from '../../src/main/project/session';
import { validateState } from '@engine/validate';
import { installComponent, makeInstance } from '@engine/install';
import { compileProject } from '../../src/main/compile';
import { resolveInstanceProps } from '@generator/index';
import { applyOperation } from '@engine/apply';

type Turn = (req: CanonicalModelRequest) => ModelEvent[];
type JsonSchemaLike = { type?: string; description?: string; anyOf?: JsonSchemaLike[]; properties?: Record<string, JsonSchemaLike> };

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private turns: Turn[], private caps: Partial<ModelCapabilities> = {}) {}
  capabilities(): ModelCapabilities {
    return { toolCalling: 'native', streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 200000, maxOutputTokens: 32000, ...this.caps };
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) {
      yield { type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] };
      return;
    }
    yield* turn(req);
  }
}

const calls = (...list: Array<[string, string, unknown]>): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: list.map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })) });
const call = (id: string, name: string, args: unknown) => calls([id, name, args]);
const finish = (text = 'Finished.'): ModelEvent[] => [{ type: 'done', stopReason: 'end', text, toolCalls: [] }];
const lastResult = (req: CanonicalModelRequest) => JSON.parse((req.items.at(-1) as { content: string }).content);

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Place an element on Home inside a layout section, as the page's content is placed. */
function inSection(s: ProjectState, node: GraphNode) {
  const home = s.pages[s.site.homePageId];
  const section = makeInstance(s.components[installComponent(s, 'layout.section')], {});
  section.slots = { content: [node.id] };
  home.nodes[section.id] = section;
  home.nodes[node.id] = node;
  home.rootIds.push(section.id);
}

async function setup(turns: Turn[], caps: Partial<ModelCapabilities> = {}, starter: 'business' | 'blank' = 'business', prepare?: (s: ProjectState) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'so-tools-'));
  dirs.push(dir);
  const initial = createStarterState(starter, 'Test Studio', false);
  prepare?.(initial);
  const session = await ProjectSession.create(dir, initial);
  const adapter = new FakeAdapter(turns, caps);
  const events: AiEvent[] = [];
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: (e) => {
      events.push(e);
      const waiting = e.kind === 'message' ? e.message?.questions?.at(-1) : undefined;
      if (waiting?.id && waiting.answered === undefined) queueMicrotask(() => answers.length && orch.answer(e.runId, waiting.id!, answers.shift()!));
    },
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => undefined
  });
  const answers: Array<string | { assetId: string }> = [];
  const run = async (text: string, selection: ElementRef | null = null, extra: Partial<ChatContext> = {}) => {
    const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection, selectionLabel: selection ? 'the selection' : null, viewport: 1280, ...extra };
    const r = await orch.send(text, ctx);
    expect(r.ok).toBe(true);
    while (orch.busy) await new Promise((res) => setTimeout(res, 5));
    return { runId: r.runId!, result: [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message?.result };
  };
  return { session, adapter, run, answers };
}

const pageAt = (s: ProjectState, route: string) => Object.values(s.pages).find((p) => p.route === route);
const componentsOn = (s: ProjectState, route: string) => {
  const p = pageAt(s, route)!;
  return p.rootIds.map((id) => s.components[(p.nodes[id] as InstanceNode).definitionId]?.componentId);
};
const shellLinks = (s: ProjectState, shell: 'header' | 'footer') => {
  const tree = s.site.shell[shell];
  return (tree.nodes[tree.rootIds[0]] as InstanceNode).props.links as Array<ListItem & { link: LinkValue }>;
};
const shellProps = (s: ProjectState, shell: 'header' | 'footer') => (s.site.shell[shell].nodes[s.site.shell[shell].rootIds[0]] as InstanceNode).props;

const services = {
  slug: 'services',
  title: 'Services',
  addToHeaderNav: true,
  addToFooterNav: true,
  sections: [
    { componentId: 'intro.page', props: { heading: 'What we do', lead: 'Three clear services.' } },
    { componentId: 'features.grid', variant: 'muted', props: { heading: 'Services', items: [{ icon: 'leaf', title: 'Care', description: 'Weekly visits.' }] } },
    { componentId: 'cta.banner', props: { heading: 'Ready?', primaryLabel: 'Call us', primaryLink: '/contact/' } }
  ]
};

describe('upsert_page_with_sections', () => {
  it('creates a page as a draft, publishes it, and leaves the flag alone when not asked', async () => {
    const sections = [
      { componentId: 'intro.page', props: { heading: 'Winter stock' } },
      { componentId: 'features.grid', props: { heading: 'Arriving soon', items: [{ icon: 'leaf', title: 'Atlases', description: 'New editions.' }] } }
    ];
    const { session, run } = await setup([
      () => [call('d1', 'upsert_page_with_sections', { slug: 'winter', title: 'Winter stock', draft: true, sections })],
      () => finish(),
      () => [call('d2', 'upsert_page_with_sections', { slug: 'winter', sections: [{ ...sections[0], props: { heading: 'Winter stock, soon' } }] })],
      () => finish(),
      () => [call('d3', 'upsert_page_with_sections', { slug: 'winter', draft: false })],
      () => finish()
    ]);
    await run('Start a winter stock page as a draft');
    expect(pageAt(session.state, '/winter/')?.draft).toBe(true);
    await run('Retitle the winter intro');
    const winterPage = pageAt(session.state, '/winter/')!;
    expect((winterPage.nodes[winterPage.rootIds[0]] as InstanceNode).props.heading).toBe('Winter stock, soon');
    expect(winterPage.draft).toBe(true);
    await run('Publish the winter page');
    expect('draft' in pageAt(session.state, '/winter/')!).toBe(false);
    // The model is told it can ask for this, as an optional yes or no.
    const schema = upsertToolSchema(session.state) as { properties: Record<string, { type?: string }>; required: string[] };
    expect(schema.properties.draft.type).toBe('boolean');
    expect(schema.required).not.toContain('draft');
  });

  it('puts a child page’s header link under its parent’s link, and leaves the footer flat (#169)', async () => {
    const { session, run } = await setup([
      () => [call('c1', 'upsert_page_with_sections', { slug: '/about/team/', title: 'Team', addToHeaderNav: true, addToFooterNav: true, sections: [{ componentId: 'intro.page', props: { heading: 'Our team' } }] })],
      () => finish()
    ]);
    await run('Add a Team page under About, in the menus');
    const team = pageAt(session.state, '/about/team/')!;
    const header = session.state.site.shell.header;
    const footer = session.state.site.shell.footer;
    const rows = (tree: typeof header) => ((tree.nodes[tree.rootIds[0]] as InstanceNode).props.links as Array<{ label: string; sub?: boolean; link: { target?: string } }>).map((i) => `${i.sub ? '  ' : ''}${i.label}`);
    expect(rows(header)).toEqual(['Home', 'About', '  Team', 'Contact']);
    expect(rows(footer)).toEqual(['Home', 'About', 'Contact', 'Team']);
    expect(((header.nodes[header.rootIds[0]] as InstanceNode).props.links as Array<{ link: { target?: string } }>)[2].link.target).toBe(team.id);
    expect(((footer.nodes[footer.rootIds[0]] as InstanceNode).props.links as Array<{ sub?: boolean; link: { target?: string } }>)[3]).toMatchObject({ link: { target: team.id } });
    expect(((footer.nodes[footer.rootIds[0]] as InstanceNode).props.links as Array<{ sub?: boolean }>)[3]).not.toHaveProperty('sub');
  });

  it('writes a page in another language as a translation of an existing one, and unlinks it when asked', async () => {
    const sections = [
      { componentId: 'intro.page', props: { heading: 'À propos du studio' } },
      { componentId: 'features.grid', props: { heading: 'Notre approche', items: [{ icon: 'leaf', title: 'Calme', description: 'Des intérieurs pratiques.' }] } }
    ];
    const { session, adapter, run } = await setup([
      () => [call('l1', 'upsert_page_with_sections', { slug: 'fr/a-propos', title: 'À propos', language: 'fr', translationOf: 'about', sections })],
      () => finish(),
      () => [call('l2', 'upsert_page_with_sections', { slug: 'fr/a-propos', title: 'À propos du studio' })],
      () => finish(),
      () => [call('l3', 'upsert_page_with_sections', { slug: 'fr/a-propos', language: 'French' })],
      () => [call('l4', 'upsert_page_with_sections', { slug: 'fr/a-propos', translationOf: 'nowhere' })],
      () => finish(),
      () => [call('l5', 'upsert_page_with_sections', { slug: 'fr/a-propos', translationOf: '', language: '' })],
      () => finish()
    ]);
    await run('Add a French version of the About page');
    const about = pageAt(session.state, '/about/')!;
    const fr = pageAt(session.state, '/fr/a-propos/')!;
    expect(fr.language).toBe('fr');
    expect(componentsOn(session.state, '/fr/a-propos/')).toEqual(['intro.page', 'features.grid']);
    expect(fr.translationGroup).toBeTruthy();
    expect(about.translationGroup).toBe(fr.translationGroup);
    // A later change that does not mention them leaves the language and the link alone.
    await run('Retitle the French page');
    expect(pageAt(session.state, '/fr/a-propos/')).toMatchObject({ title: 'À propos du studio', language: 'fr', translationGroup: fr.translationGroup });
    // A name instead of a code, or a page that does not exist, changes nothing and says why.
    const before = structuredClone(session.state);
    await run('Make it French, then link it to a page that is not there');
    const refusals = adapter.requests.slice(-2).map(lastResult);
    expect(JSON.stringify(refusals[0])).toMatch(/language code/);
    expect(JSON.stringify(refusals[1])).toMatch(/no page at \/nowhere\//);
    expect(session.state.pages).toEqual(before.pages);
    await run('Unlink it and make it use the site language');
    const after = pageAt(session.state, '/fr/a-propos/')!;
    expect(after.translationGroup).toBeUndefined();
    expect('language' in after).toBe(false);
    expect(pageAt(session.state, '/about/')!.translationGroup).toBeUndefined();
    const schema = upsertToolSchema(session.state) as { properties: Record<string, { type?: string }>; required: string[] };
    expect(schema.properties.language.type).toBe('string');
    expect(schema.properties.translationOf.type).toBe('string');
    expect(schema.required).not.toContain('language');
  });

  it('makes a dated article that opens with its header, and lists it in a News list it never writes items to', async () => {
    const { session, adapter, run } = await setup([
      () => [call('a1', 'upsert_page_with_sections', { slug: 'news/winter-hours', title: 'Winter opening hours', articleDate: '2026-11-14', excerpt: 'Shorter days.', sections: [{ componentId: 'content.text', props: { heading: '', body: 'From December we close at four.' } }] })],
      () => [call('a2', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'content.news', props: { eyebrow: 'Rejected eyebrow', items: [{ title: 'Typed' }] } }] })],
      () => [call('a3', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'content.news', props: { heading: 'Market news', lead: 'From the market office' } }] })],
      () => [call('a4', 'upsert_page_with_sections', { slug: 'news/spring', title: 'Spring makers', articleDate: '2027-03-02', newsHidden: true, sections: [{ componentId: 'content.article', props: { eyebrow: 'Announcement' } }] })],
      () => finish()
    ]);
    await run('Post the winter hours and list news on Home');
    const article = pageAt(session.state, '/news/winter-hours/')!;
    expect(article.article).toEqual({ date: '2026-11-14', excerpt: 'Shorter days.' });
    expect(article.rootIds.map((id) => session.state.components[(article.nodes[id] as InstanceNode).definitionId].componentId)).toEqual(['content.article', 'content.text']);
    const home = pageAt(session.state, '/')!;
    const news = Object.values(home.nodes).find((n) => n.kind === 'instance' && session.state.components[n.definitionId].componentId === 'content.news') as InstanceNode;
    expect(news.props.heading).toBe('Market news');
    expect(news.props.lead).toBe('From the market office');
    // Nothing of the refused call was applied.
    expect(news.props.eyebrow ?? '').toBe('');
    expect(news.props).not.toHaveProperty('items');
    const def = session.state.components[news.definitionId];
    expect((resolveInstanceProps(def, news, { state: session.state, pageId: home.id }).items as Array<{ title: string }>).map((r) => r.title)).toEqual(['Winter opening hours']);
    // An article that places its own header gets no second one, and can be kept out of News lists.
    const spring = pageAt(session.state, '/news/spring/')!;
    expect(spring.rootIds.map((id) => session.state.components[(spring.nodes[id] as InstanceNode).definitionId].componentId)).toEqual(['content.article']);
    expect(spring.article).toEqual({ date: '2027-03-02', hidden: true });
    // Items sent for it are refused with a pointer to the article pages, and nothing of that call is applied.
    const refused = adapter.requests[2].items.find((i) => i.kind === 'tool_result' && i.callId === 'a2') as { content: string; isError: boolean };
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/fills itself from the site's dated articles/);
    // Both sections are offered, with nothing computed to send.
    const schema = upsertToolSchema(session.state) as { properties: { sections: { items: { oneOf: Array<{ properties: { componentId: { enum: string[] }; props: { properties: Record<string, unknown> } } }> } } } };
    const offered = schema.properties.sections.items.oneOf;
    const propsOf = (id: string) => Object.keys(offered.find((o) => o.properties.componentId.enum[0] === id)!.properties.props.properties);
    expect(propsOf('content.news')).not.toContain('items');
    expect(propsOf('content.article')).toEqual(['eyebrow']);
  });

  it('moves a contact link with the address a rewrite changes, unless the rewrite sends the link', async () => {
    const items = [
      { label: 'Email', value: 'bookings@kloof.example' },
      { label: 'Phone', value: '+1 202 555 0142', link: 'tel:+15550134' },
      { label: 'Studio', value: '12 Harbour Lane, Millbrook' },
      { label: 'Hours', value: 'Monday to Friday, 9am – 5pm' }
    ];
    const { session, run } = await setup([() => [call('c1', 'upsert_page_with_sections', { slug: 'contact', sections: [{ componentId: 'contact.details', props: { items } }] })], () => finish()]);
    await run('Our email is now bookings@kloof.example');
    const page = pageAt(session.state, '/contact/')!;
    const section = page.rootIds.map((id) => page.nodes[id] as InstanceNode).find((n) => Array.isArray(n.props.items) && (n.props.items as ListItem[]).some((i) => i.icon === 'mail'))!;
    const stored = section.props.items as Array<ListItem & { link: LinkValue }>;
    expect(stored.find((i) => i.label === 'Email')).toMatchObject({ value: 'bookings@kloof.example', link: { type: 'email', target: 'bookings@kloof.example' } });
    expect(stored.find((i) => i.label === 'Phone')).toMatchObject({ value: '+1 202 555 0142', link: { type: 'tel', target: '+15550134' } });
  });

  it('creates a whole page and wires navigation in one call, as one undo step', async () => {
    const { session, run } = await setup([() => [call('u1', 'upsert_page_with_sections', services)], () => finish()]);
    const before = session.historyInfo().entries.length;
    const { runId, result } = await run('Add a services page');
    expect(result?.status).toBe('completed');
    expect(componentsOn(session.state, '/services/')).toEqual(['intro.page', 'features.grid', 'cta.banner']);
    const page = pageAt(session.state, '/services/')!;
    expect(shellLinks(session.state, 'header').some((l) => l.link.target === page.id)).toBe(true);
    expect(shellLinks(session.state, 'footer').some((l) => l.link.target === page.id)).toBe(true);
    const cta = page.nodes[page.rootIds[2]] as InstanceNode;
    expect((cta.props.primaryLink as LinkValue).type).toBe('page');
    expect(validateState(session.state).filter((d) => d.severity === 'error')).toEqual([]);
    expect(await compileProject(session.state)).toEqual([]);
    expect(session.historyInfo().entries.length).toBe(before + 1);
    await session.undoGroup(runId);
    expect(pageAt(session.state, '/services/')).toBeUndefined();
  });

  it('names the section and field of every error, applies nothing, and repairs one section without the rest', async () => {
    const bad = {
      ...services,
      sections: [
        services.sections[0],
        { componentId: 'features.grid', props: { heading: 'Services', items: [{ icon: 'not-an-icon', title: 'Care' }] } },
        { componentId: 'cta.banner', variant: 'nope', props: { headline: 'Ready?' } }
      ]
    };
    const { session, adapter, run } = await setup([
      () => [call('b1', 'upsert_page_with_sections', bad)],
      (req) => {
        const r = lastResult(req);
        expect(r.fields.map((f: { field: string }) => f.field)).toEqual(['sections[1].props.items[0].icon', 'sections[2].variant', 'sections[2].props.headline']);
        expect(pageAt(session.state, '/services/')).toBeUndefined();
        return [
          call('b2', 'upsert_page_with_sections', {
            slug: 'services',
            repair: true,
            sections: [
              { index: 1, componentId: 'features.grid', props: { heading: 'Services', items: [{ icon: 'leaf', title: 'Care' }] } },
              { index: 2, componentId: 'cta.banner', props: { heading: 'Ready?' } }
            ]
          })
        ];
      },
      () => finish()
    ]);
    const { result } = await run('Add a services page');
    expect(result?.status).toBe('completed');
    expect(componentsOn(session.state, '/services/')).toEqual(['intro.page', 'features.grid', 'cta.banner']);
    // The repair call carried only the two failed sections; the first came from the held draft, as did the navigation.
    const page = pageAt(session.state, '/services/')!;
    expect((page.nodes[page.rootIds[0]] as InstanceNode).props.heading).toBe('What we do');
    expect(shellLinks(session.state, 'header').some((l) => l.link.target === page.id)).toBe(true);
    expect(adapter.requests).toHaveLength(3);
  });

  it('updates matching sections in place and keeps the others unless asked to remove them', async () => {
    let heroId = '';
    const { session, run } = await setup([
      () => {
        const home = pageAt(session.state, '/')!;
        heroId = home.rootIds[0];
        return [call('h1', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'hero.split', props: { heading: 'New headline' } }] })];
      },
      (req) => {
        expect(lastResult(req).keptSections.length).toBeGreaterThan(0);
        return finish();
      }
    ]);
    const count = pageAt(session.state, '/')!.rootIds.length;
    const lead = (pageAt(session.state, '/')!.nodes[pageAt(session.state, '/')!.rootIds[0]] as InstanceNode).props.lead;
    await run('Change the home headline');
    const home = pageAt(session.state, '/')!;
    expect(home.rootIds).toHaveLength(count);
    expect(home.rootIds[0]).toBe(heroId);
    expect((home.nodes[heroId] as InstanceNode).props.heading).toBe('New headline');
    expect((home.nodes[heroId] as InstanceNode).props.lead).toBe(lead);
  });

  it('removes other theme sections when asked, and puts the rest in the requested order', async () => {
    const { session, run } = await setup([
      () => [call('r1', 'upsert_page_with_sections', { slug: 'home', removeOtherSections: true, sections: [{ componentId: 'cta.banner', props: { heading: 'First' } }, { componentId: 'hero.split', props: { heading: 'Second' } }] })],
      () => finish()
    ]);
    await run('Rebuild the home page');
    expect(componentsOn(session.state, '/')).toEqual(['cta.banner', 'hero.split']);
  });

  it('removes forked and custom project sections when asked, but leaves layout that is not an instance', async () => {
    let layoutId = '';
    const { session, run } = await setup(
      [() => [call('r1', 'upsert_page_with_sections', { slug: 'home', removeOtherSections: true, sections: [{ componentId: 'hero.split', props: { heading: 'Only this' } }] })], () => finish()],
      {},
      'business',
      (s) => {
        // Hand-built layout at the page root is not a section the macro can express, so it must survive.
        const home = s.pages[s.site.homePageId];
        layoutId = 'n_layout';
        home.nodes[layoutId] = { id: layoutId, kind: 'text', tag: 'p', text: 'Hand-made note' };
        home.rootIds.push(layoutId);
      }
    );
    const home = () => pageAt(session.state, '/')!;
    const instanceOf = (componentId: string) => home().rootIds.find((id) => session.state.components[(home().nodes[id] as InstanceNode).definitionId]?.componentId === componentId)!;
    const homeOwner = { kind: 'page' as const, id: session.state.site.homePageId };
    const testimonials = (home().nodes[instanceOf('testimonials.grid')] as InstanceNode).definitionId;
    const fork = await session.apply({ operations: [{ type: 'component.fork', definitionId: testimonials }] }, { label: 'Edit everywhere', source: 'user' });
    expect(fork.ok).toBe(true);
    const unique = await session.apply({ operations: [{ type: 'component.makeUnique', owner: homeOwner, nodeId: instanceOf('cta.banner'), name: 'Our banner' }] }, { label: 'Make unique', source: 'user' });
    expect(unique.ok).toBe(true);
    const code = await session.apply({ operations: [{ type: 'component.convertToCode', owner: homeOwner, nodeId: instanceOf('logos.strip'), name: 'Logo code' }] }, { label: 'Convert to code', source: 'user' });
    expect(code.ok).toBe(true);
    const defs = home().rootIds.filter((id) => home().nodes[id].kind === 'instance').map((id) => session.state.components[(home().nodes[id] as InstanceNode).definitionId]);
    expect(defs.filter((d) => d.owner === 'project').map((d) => d.kind).sort()).toEqual(['code', 'managed', 'managed']);

    await run('Rebuild the home page with just a hero');
    expect(home().rootIds.map((id) => (home().nodes[id].kind === 'instance' ? session.state.components[(home().nodes[id] as InstanceNode).definitionId].componentId : id))).toEqual(['hero.split', layoutId]);
    expect(((home().nodes[home().rootIds[0]] as InstanceNode).props.heading as string)).toBe('Only this');
  });

  it('rewrites copy in an existing team without losing the portraits it leaves out', async () => {
    const portraits = ['a_p1', 'a_p2', 'a_p3'];
    const people = [
      { name: 'Hannah Wells', role: 'Founder', bio: 'Hannah leads every project from the first sketch.' },
      { name: 'Marcus Lee', role: 'Project manager', bio: 'Marcus keeps budgets honest.' },
      { name: 'Sofia Alvarez', role: 'Interior designer', bio: 'Sofia chooses every finish.' }
    ];
    const { session, run } = await setup(
      [() => [call('t1', 'upsert_page_with_sections', { slug: 'about', sections: [{ componentId: 'team.grid', props: { people } }] })], () => finish()],
      {},
      'business',
      (s) => {
        for (const id of portraits) s.assets.assets[id] = { id, name: id, file: `static/assets/${id}.jpg`, mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' };
        const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
        const team = about.rootIds.map((id) => about.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'team.grid')!;
        (team.props.people as ListItem[]).forEach((p, i) => (p.portrait = { assetId: portraits[i], alt: `Portrait of ${p.name}` }));
      }
    );
    const team = () => {
      const about = pageAt(session.state, '/about/')!;
      return about.rootIds.map((id) => about.nodes[id] as InstanceNode).find((n) => session.state.components[n.definitionId]?.componentId === 'team.grid')!;
    };
    const ids = (team().props.people as ListItem[]).map((p) => p.id);
    await run('Rewrite the team bios');
    const after = team().props.people as ListItem[];
    expect(after.map((p) => p.bio)).toEqual(people.map((p) => p.bio));
    expect(after.map((p) => p.role)).toEqual(people.map((p) => p.role));
    expect(after.map((p) => p.portrait)).toEqual(portraits.map((assetId, i) => ({ assetId, alt: `Portrait of ${people[i].name}` })));
    expect(after.map((p) => p.id)).toEqual(ids);
  });

  it('matches team members by id or unchanged name, never by position', async () => {
    const portraits = ['a_p1', 'a_p2', 'a_p3'];
    const teamOf = (s: ProjectState) => {
      const about = pageAt(s, '/about/')!;
      return about.rootIds.map((id) => about.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'team.grid')!;
    };
    let ids: string[] = [];
    const { session, run } = await setup(
      [
        () => {
          ids = (teamOf(session.state).props.people as ListItem[]).map((p) => p.id);
          const people = [
            { name: 'Sofia Alvarez', bio: 'Now first.' },
            { id: ids[0], name: 'Hannah Wells-Grant', bio: 'Renamed, with her id.' },
            { name: 'Dana Fox', role: 'Junior designer', bio: 'Joined this year.' }
          ];
          return [call('t1', 'upsert_page_with_sections', { slug: 'about', sections: [{ componentId: 'team.grid', props: { people } }] })];
        },
        () => finish()
      ],
      {},
      'business',
      (s) => {
        for (const id of portraits) s.assets.assets[id] = { id, name: id, file: `static/assets/${id}.jpg`, mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' };
        (teamOf(s).props.people as ListItem[]).forEach((p, i) => (p.portrait = { assetId: portraits[i], alt: `Portrait of ${p.name}` }));
      }
    );
    await run('Reorder the team, rename Hannah and add Dana');
    const people = teamOf(session.state).props.people as Array<ListItem & { portrait: { assetId: string | null } }>;
    expect(people.map((p) => [p.id, p.name, p.role, p.portrait.assetId])).toEqual([
      [ids[2], 'Sofia Alvarez', 'Interior designer', 'a_p3'],
      [ids[0], 'Hannah Wells-Grant', 'Founder & lead designer', 'a_p1'],
      [expect.any(String), 'Dana Fox', 'Junior designer', null]
    ]);
    expect(ids).not.toContain(people[2].id);
  });

  it('updates a fork requested by its definition, not an earlier theme copy of the same section', async () => {
    let forkId = '';
    const { session, run } = await setup([() => [call('f1', 'upsert_page_with_sections', { slug: 'home', removeOtherSections: true, sections: [{ componentId: forkId, props: { heading: 'The fork' } }] })], () => finish()]);
    const homeId = session.state.site.homePageId;
    const home = () => session.state.pages[homeId];
    const ctaId = home().rootIds.find((id) => session.state.components[(home().nodes[id] as InstanceNode).definitionId]?.componentId === 'cta.banner')!;
    const fork = await session.apply({ operations: [{ type: 'component.fork', definitionId: (home().nodes[ctaId] as InstanceNode).definitionId }] }, { label: 'Edit everywhere', source: 'user' });
    forkId = (fork.results?.[0] as { definitionId: string }).definitionId;
    const theme = await session.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: homeId }, index: 0, componentId: 'cta.banner' }] }, { label: 'Add banner', source: 'user' });
    expect(theme.ok).toBe(true);
    expect(session.state.components[(home().nodes[home().rootIds[0]] as InstanceNode).definitionId].owner).toBe('theme');

    await run('Keep only our banner');
    expect(home().rootIds).toEqual([ctaId]);
    expect((home().nodes[ctaId] as InstanceNode).definitionId).toBe(forkId);
    expect((home().nodes[ctaId] as InstanceNode).props.heading).toBe('The fork');
  });

  it('gives a fork to the request that names its definition, even after a catalogue request for the same section', async () => {
    let forkId = '';
    const { session, run } = await setup([
      () => [call('f1', 'upsert_page_with_sections', { slug: 'home', removeOtherSections: true, sections: [{ componentId: 'cta.banner', props: { heading: 'Theme copy' } }, { componentId: forkId, props: { heading: 'The fork' } }] })],
      () => finish()
    ]);
    const homeId = session.state.site.homePageId;
    const home = () => session.state.pages[homeId];
    const ctaId = home().rootIds.find((id) => session.state.components[(home().nodes[id] as InstanceNode).definitionId]?.componentId === 'cta.banner')!;
    const fork = await session.apply({ operations: [{ type: 'component.fork', definitionId: (home().nodes[ctaId] as InstanceNode).definitionId }] }, { label: 'Edit everywhere', source: 'user' });
    forkId = (fork.results?.[0] as { definitionId: string }).definitionId;
    await run('A theme banner, then ours');
    const [first, second] = home().rootIds.map((id) => home().nodes[id] as InstanceNode);
    expect(home().rootIds).toHaveLength(2);
    expect(second.id).toBe(ctaId);
    expect(second.props.heading).toBe('The fork');
    expect(first.props.heading).toBe('Theme copy');
    expect(session.state.components[first.definitionId].owner).toBe('theme');
  });

  it('keeps an omitted portrait whose asset has gone missing instead of rejecting the copy edit', async () => {
    const { session, run } = await setup(
      [
        () => [call('m1', 'upsert_page_with_sections', { slug: 'about', sections: [{ componentId: 'team.grid', props: { people: [{ name: 'Hannah Wells', bio: 'New bio.' }] } }] })],
        (req) => {
          expect(lastResult(req).ok).toBe(true);
          return finish();
        }
      ],
      {},
      'business',
      (s) => {
        const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
        const team = about.rootIds.map((id) => about.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'team.grid')!;
        (team.props.people as ListItem[])[0].portrait = { assetId: 'a_gone', alt: 'Hannah' };
      }
    );
    await run('Rewrite Hannah’s bio');
    const about = pageAt(session.state, '/about/')!;
    const team = about.rootIds.map((id) => about.nodes[id] as InstanceNode).find((n) => session.state.components[n.definitionId]?.componentId === 'team.grid')!;
    expect((team.props.people as ListItem[]).map((p) => [p.name, p.bio, p.portrait])).toEqual([['Hannah Wells', 'New bio.', { assetId: 'a_gone', alt: 'Hannah' }]]);
  });

  it('never fills a link this call cleared, even when its page now has the waiting route', async () => {
    const { session, run } = await setup([
      () => [call('o1', 'upsert_page_with_sections', { slug: 'offers', title: 'Offers', sections: [{ componentId: 'cta.banner', props: { heading: 'Offer', primaryLink: '/booking/' } }] })],
      () => [call('o2', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'page.update', pageId: pageAt(session.state, '/offers/')!.id, route: '/booking/' }] })],
      () => [call('o3', 'upsert_page_with_sections', { slug: 'booking', sections: [{ componentId: 'cta.banner', props: { primaryLink: '' } }] })],
      () => finish()
    ]);
    await run('Make an offers page, move it to booking and clear its link');
    const page = pageAt(session.state, '/booking/')!;
    expect((page.nodes[page.rootIds[0]] as InstanceNode).props.primaryLink).toEqual({ type: 'none', target: '' });
  });

  it('lets a new link value replace one still waiting, and keeps a waiting link an update leaves out', async () => {
    const cta = { componentId: 'cta.banner', props: { heading: 'Book', primaryLink: '/booking/', secondaryLabel: 'Later', secondaryLink: '/later/' } };
    const first = { slug: 'pricing', title: 'Pricing', sections: [{ componentId: 'intro.page', props: { heading: 'Pricing' } }, { componentId: 'pricing.plans', props: { plans: [{ name: 'One', price: '$1', features: 'A', actionLink: '/booking/' }, { name: 'Two', price: '$2', features: 'B', actionLink: '/later/' }] } }, cta] };
    // Reordered rows, a new route for One, an omitted link for Two; the banner's first link is cleared and its second omitted.
    const update = { slug: 'pricing', sections: [{ componentId: 'pricing.plans', props: { plans: [{ name: 'Two', price: '$3' }, { name: 'One', actionLink: '/reserve/' }] } }, { componentId: 'cta.banner', props: { primaryLink: '' } }] };
    const stub = (slug: string) => ({ slug, title: slug, sections: [{ componentId: 'intro.page', props: { heading: slug } }] });
    const { session, run } = await setup([
      () => [call('p1', 'upsert_page_with_sections', first)],
      () => [call('p2', 'upsert_page_with_sections', update)],
      () => [call('p3', 'upsert_page_with_sections', stub('booking'))],
      () => [call('p4', 'upsert_page_with_sections', stub('later'))],
      (req) => {
        expect(lastResult(req).linksWaitingForPages).toEqual(['/reserve/']);
        return [call('p5', 'upsert_page_with_sections', stub('reserve'))];
      },
      () => finish()
    ]);
    await run('Build pricing, change its links, then build the pages');
    const page = pageAt(session.state, '/pricing/')!;
    const nodes = page.rootIds.map((id) => page.nodes[id] as InstanceNode);
    const plans = nodes.find((n) => Array.isArray(n.props.plans))!.props.plans as Array<ListItem & { actionLink: LinkValue }>;
    const target = (route: string) => ({ type: 'page', target: pageAt(session.state, route)!.id });
    expect(plans.map((i) => [i.name, i.price, i.actionLink])).toEqual([
      ['Two', '$3', target('/later/')],
      ['One', '$1', target('/reserve/')]
    ]);
    const banner = nodes.find((n) => n.props.primaryLink !== undefined)!;
    expect([banner.props.primaryLink, banner.props.secondaryLink]).toEqual([{ type: 'none', target: '' }, target('/later/')]);
  });

  it('connects a link to a page built later, including a link inside a list item', async () => {
    const pricing = { slug: 'pricing', title: 'Pricing', sections: [{ componentId: 'intro.page', props: { heading: 'Pricing' } }, { componentId: 'pricing.plans', props: { plans: [{ name: 'One', price: '$1', features: 'A', actionLabel: 'Book', actionLink: '/booking/' }] } }] };
    const { session, run } = await setup([
      () => [call('p1', 'upsert_page_with_sections', pricing)],
      (req) => {
        expect(lastResult(req).linksWaitingForPages).toEqual(['/booking/']);
        return [call('p2', 'upsert_page_with_sections', { slug: 'booking', title: 'Booking', sections: [{ componentId: 'intro.page', props: { heading: 'Book' } }, { componentId: 'contact.form', props: { heading: 'Form' } }] })];
      },
      () => finish()
    ]);
    const { result } = await run('Build pricing and booking pages');
    expect(result?.validation).not.toContainEqual(expect.stringContaining('still'));
    expect(result?.validation).not.toContainEqual(expect.stringContaining('go anywhere'));
    expect(result?.incomplete).toBeUndefined();
    const page = pageAt(session.state, '/pricing/')!;
    const plans = (page.nodes[page.rootIds[1]] as InstanceNode).props.plans as Array<{ actionLink: LinkValue }>;
    expect(plans[0].actionLink).toEqual({ type: 'page', target: pageAt(session.state, '/booking/')!.id });
  });

  it('builds several pages in one turn and treats a replayed call ID as already done', async () => {
    const about = { slug: 'team', title: 'Team', sections: [{ componentId: 'intro.page' }, { componentId: 'team.grid' }] };
    const { session, adapter, run } = await setup([
      () => [calls(['m1', 'upsert_page_with_sections', services], ['m2', 'upsert_page_with_sections', about])],
      () => [call('m1', 'upsert_page_with_sections', services)],
      () => finish()
    ]);
    await run('Add services and team pages');
    expect(pageAt(session.state, '/services/')).toBeDefined();
    expect(pageAt(session.state, '/team/')).toBeDefined();
    expect(Object.values(session.state.pages).filter((p) => p.title === 'Services')).toHaveLength(1);
    expect(adapter.requests[1].items.filter((i) => i.kind === 'tool_result' && !i.isError)).toHaveLength(2);
  });

  it('cannot leave a selection-scoped run', async () => {
    let hero = '';
    const { session, adapter, run } = await setup([() => [call('s1', 'upsert_page_with_sections', services)], () => finish()], { contextWindowTokens: 8000, toolCalling: 'constrained-json', maxOutputTokens: 2000 });
    hero = pageAt(session.state, '/')!.rootIds[0];
    await run('Change this', { owner: { kind: 'page', id: session.state.site.homePageId }, instancePath: [], nodeId: hero });
    expect(pageAt(session.state, '/services/')).toBeUndefined();
    expect(JSON.stringify(adapter.requests[1].items.at(-1))).toContain('Unknown tool');
  });
});

describe('withStoredFields', () => {
  const schema = catalogueComponent('foundation', 'team.grid')!.properties.people as Extract<PropSchema, { type: 'list' }>;
  const person = (id: string, name: string, assetId: string) => ({ id, name, role: `${name}'s role`, bio: '', portrait: { assetId, alt: name } });

  it('lets an id claim its item before a title can, and never matches a repeated or unknown id', () => {
    const stored = [person('i1', 'Hannah', 'a1'), person('i2', 'Marcus', 'a2')];
    const r = withStoredFields(schema, [{ name: 'Hannah', bio: 'title only' }, { id: 'i1', name: 'Hannah W', bio: 'by id' }, { id: 'i1', name: 'Again' }, { id: 'zz', name: 'Marcus' }], stored);
    expect(r.ids).toEqual([undefined, 'i1', undefined, undefined]);
    expect(r.items).toEqual([{ name: 'Hannah', bio: 'title only' }, { ...stored[0], name: 'Hannah W', bio: 'by id' }, { name: 'Again' }, { name: 'Marcus' }]);
  });

  it('matches a title only when it is unique on both sides', () => {
    const stored = [person('i1', 'Ada', 'a1'), person('i2', 'Bea', 'a2'), person('i3', 'Bea', 'a3')];
    const r = withStoredFields(schema, [{ name: 'Ada', bio: 'one' }, { name: 'Ada', bio: 'two' }, { name: 'Bea', bio: 'three' }, { name: '  ', bio: 'blank' }], stored);
    expect(r.ids).toEqual([undefined, undefined, undefined, undefined]);
    expect(withStoredFields(schema, [{ name: 'Ada', bio: 'one' }], stored).ids).toEqual(['i1']);
  });

  it('matches nothing by an id two stored items share, and copies what it inherits', () => {
    const stored = [person('d', 'Ada', 'a1'), person('d', 'Bea', 'a2'), person('i3', 'Cy', 'a3')];
    expect(withStoredFields(schema, [{ id: 'd', name: 'Ada', bio: 'x' }], stored).ids).toEqual([undefined]);
    const r = withStoredFields(schema, [{ name: 'Cy', bio: 'x' }], stored);
    expect(r.ids).toEqual(['i3']);
    expect((r.items[0] as typeof stored[number]).portrait).toEqual(stored[2].portrait);
    expect((r.items[0] as typeof stored[number]).portrait).not.toBe(stored[2].portrait);
  });
});

describe('update_site_brand', () => {
  it('keeps a deliberate footer label and changes only the number behind it', async () => {
    const { session, run } = await setup(
      [() => [call('b1', 'update_site_brand', { contactEmail: 'bookings@kloof.example', contactPhone: '+1 202 555 0142' })], () => finish()],
      {},
      'business',
      (s) => {
        const footer = s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
        const phone = (footer.props.contact as Array<ListItem & { link: LinkValue }>).find((c) => c.link.type === 'tel')!;
        phone.label = 'Call reception';
      }
    );
    await run('Our email is bookings@kloof.example and our number is +1 202 555 0142');
    const contact = shellProps(session.state, 'footer').contact as Array<{ label: string; link: LinkValue }>;
    expect(contact.find((c) => c.link.type === 'tel')).toMatchObject({ label: 'Call reception', link: { type: 'tel', target: '+12025550142' } });
    // A footer label that showed the old address shows the new one.
    expect(contact.find((c) => c.link.type === 'email')).toMatchObject({ label: 'bookings@kloof.example', link: { type: 'email', target: 'bookings@kloof.example' } });
  });

  it('keeps a deliberate footer email label too', async () => {
    const { session, run } = await setup([() => [call('b1', 'update_site_brand', { contactEmail: 'bookings@kloof.example' })], () => finish()], {}, 'business', (s) => {
      const footer = s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
      (footer.props.contact as Array<ListItem & { link: LinkValue }>).find((c) => c.link.type === 'email')!.label = 'Email the studio';
    });
    await run('Our email is bookings@kloof.example');
    const contact = shellProps(session.state, 'footer').contact as Array<{ label: string; link: LinkValue }>;
    expect(contact.find((c) => c.link.type === 'email')).toMatchObject({ label: 'Email the studio', link: { type: 'email', target: 'bookings@kloof.example' } });
  });

  it('updates the site, header, footer and derived color tokens together', async () => {
    const { session, run } = await setup([
      () => [call('b1', 'update_site_brand', { siteName: 'Harbour Plumbing', tagline: 'Fast, honest repairs.', brandColor: '#0b5cad', headingFont: 'Lora', bodyFont: 'DM Sans', contactEmail: 'help@harbour.example', contactPhone: '+1 555 0199' })],
      () => finish()
    ]);
    await run('Rebrand this as Harbour Plumbing');
    const s = session.state;
    expect(s.site.name).toBe('Harbour Plumbing');
    expect(shellProps(s, 'header').siteName).toBe('Harbour Plumbing');
    const footer = shellProps(s, 'footer');
    expect(footer.siteName).toBe('Harbour Plumbing');
    expect(footer.tagline).toBe('Fast, honest repairs.');
    expect(String(footer.copyright)).toContain('Harbour Plumbing');
    expect(String(footer.copyright)).not.toContain('Test Studio');
    const contact = footer.contact as Array<{ label: string; link: LinkValue }>;
    expect(contact.find((c) => c.link.type === 'email')).toMatchObject({ label: 'help@harbour.example', link: { target: 'help@harbour.example' } });
    expect(contact.find((c) => c.link.type === 'tel')).toMatchObject({ label: '+1 555 0199', link: { target: '+15550199' } });
    expect(s.tokens.overrides['color.brand']).toBe('#0b5cad');
    // White on-brand text is already the theme's value, so it needs no override.
    for (const id of ['color.brand-strong', 'color.inverse']) expect(s.tokens.overrides[id]).toBeDefined();
    expect(String(s.tokens.overrides['font.display'])).toContain('Lora Variable');
    expect(String(s.tokens.overrides['font.body'])).toContain('DM Sans Variable');
    expect(await compileProject(s)).toEqual([]);
  });

  it('refuses a font that is not installed, naming the field, and changes nothing', async () => {
    const { session, adapter, run } = await setup([() => [call('f1', 'update_site_brand', { siteName: 'Nope', headingFont: 'Comic Sans', brandColor: 'blue' })], () => finish()]);
    await run('Rebrand');
    const r = JSON.parse((adapter.requests[1].items.at(-1) as { content: string }).content);
    expect(r.fields.map((f: { field: string }) => f.field).sort()).toEqual(['brandColor', 'headingFont']);
    expect(r.message).toContain('not installed');
    expect(session.state.site.name).toBe('Test Studio');
    expect(session.state.tokens.overrides).toEqual({});
  });

  it('sets a type scale with a new heading font in one batch, undone in one step', async () => {
    const { session, adapter, run } = await setup([() => [call('t1', 'update_site_brand', { headingFont: 'Lora', bodyFont: 'DM Sans', typeScale: 'bold-display' })], () => finish()]);
    await run('Use Lora for headings, with big bold headlines');
    const schema = adapter.requests[0].tools.find((t) => t.name === 'update_site_brand')!.parameters as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.typeScale.enum).toEqual([...TYPE_SCALE_CHOICES]);
    const s = session.state;
    expect(String(s.tokens.overrides['font.display'])).toContain('Lora Variable');
    expect(String(s.tokens.overrides['font.body'])).toContain('DM Sans Variable');
    const want = scaleMetrics('bold-display');
    for (const role of TYPE_SCALE_ROLES) expect(s.tokens.overrides[role], role).toMatchObject(want[role]);
    // The styles keep following the fonts, so the new heading font shows in every heading.
    expect(s.tokens.overrides['text.display']).toMatchObject({ family: { token: 'font.display' }, weight: 480 });
    expect(s.tokens.overrides['text.h3']).toMatchObject({ family: { token: 'font.body' }, weight: 600 });
    expect(s.tokens.overrides['text.body']).toMatchObject({ family: { token: 'font.body' } });
    expect(lastResult(adapter.requests[1])).toMatchObject({ ok: true, changed: TYPE_SCALE_ROLES.length + 2 });
    expect(await compileProject(s)).toEqual([]);
    await session.undo();
    expect(session.state.tokens.overrides).toEqual({});
  });

  it('refuses a type scale it does not have, naming the field, and changes nothing', async () => {
    const { session, adapter, run } = await setup([() => [call('t1', 'update_site_brand', { headingFont: 'Lora', typeScale: 'huge' })], () => finish()]);
    await run('Make the type huge');
    const r = lastResult(adapter.requests[1]);
    expect(r.error).toBe('INVALID_ARGUMENT');
    // The message names the field and the scales it can take.
    expect(r.message).toMatch(/^typeScale: .*editorial/);
    expect(session.state.tokens.overrides).toEqual({});
  });

  it('refuses a type scale it cannot apply whole, naming the style, and changes nothing else in the call', async () => {
    const { session, adapter, run } = await setup([() => [call('t1', 'update_site_brand', { siteName: 'Kept Out', headingFont: 'Lora', typeScale: 'compact' })], () => finish()], {}, 'business', (s) => {
      // A letter case the engine refuses, as a hand-edited document could hold.
      s.tokens.overrides['text.h3'] = { family: { token: 'font.body' }, size: '1.2rem', lineHeight: '1.35', weight: 600, tracking: '0em', transform: 'full-width' };
    });
    const before = structuredClone(session.state.tokens);
    await run('Rename the site and tighten the type');
    const r = lastResult(adapter.requests[1]);
    expect(r.error).toBe('VALIDATION_FAILED');
    expect(r.fields).toEqual([expect.objectContaining({ field: 'typeScale' })]);
    expect(r.fields[0].message).toContain('"Heading 3"');
    expect(session.state.site.name).toBe('Test Studio');
    expect(session.state.tokens).toEqual(before);
  });

  it('derives readable colors for both dark and light brand colors', () => {
    const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    for (const brand of ['#0b5cad', '#f5c518', '#1f5a4c', '#ffffff', '#000000', '#e11d48']) {
      const t = derivedBrandTokens(brand, '#f1eee6');
      expect(contrastRatio(hex(t['color.on-brand']), hex(t['color.brand']))).toBeGreaterThanOrEqual(4.5);
      // Inverted button: strong brand text on an on-brand background.
      expect(contrastRatio(hex(t['color.brand-strong']), hex(t['color.on-brand']))).toBeGreaterThanOrEqual(contrastRatio(hex(t['color.brand']), hex(t['color.on-brand'])) - 0.01);
      expect(contrastRatio(hex(t['color.inverse']), hex('#f1eee6'))).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('asking the user (#22)', () => {
  it('tells a focused site run to ask with request_clarification, and lets it finish with advice', async () => {
    const { adapter, run } = await setup([() => finish('Try: Talk to us, whenever suits you.')], { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'native' });
    const { result } = await run('Interview me about the Contact page, then suggest a headline in chat only');
    expect(result?.status).toBe('no-changes');
    expect(result?.summary).toBe('Try: Talk to us, whenever suits you.');
    const { system, tools } = adapter.requests[0];
    expect(tools.map((t) => t.name)).toContain('request_clarification');
    expect(system).toMatch(/request_clarification asks the user one question[^\n]*interview them[^\n]*one question per call/);
    expect(system).toContain('when the user asked only for advice or ideas, with that advice');
  });

  it('gives a constrained site run the same rules beside the tool, once (#364)', async () => {
    const { adapter, run } = await setup([() => finish('Try: Talk to us, whenever suits you.')], { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'constrained-json' });
    await run('Interview me about the Contact page, then suggest a headline in chat only');
    const { system, tools } = adapter.requests[0];
    // What the local model reads: the instructions, then each tool's signature and brief.
    const prompt = system + envelopeInstructions(tools);
    expect(prompt).toMatch(/\n- request_clarification [^\n]*\n  Ask the user one question[^\n]*interview them, ask them something or let them choose[^\n]*short, concrete choices[^\n]*One question per call; then act on the answer\./);
    expect(prompt).toContain('what changed, or the answer or advice asked for');
    expect(prompt).toContain('When the user wants advice or ideas in chat only, give them and change nothing.');
    // Said once, beside the tool, not again in the instructions above it.
    expect(system).not.toContain('request_clarification asks the user one question');
    expect(prompt.match(/interview them/g)).toHaveLength(1);
  });
});

describe('selection tools', () => {
  const heroRef = (s: ProjectState): ElementRef => ({ owner: { kind: 'page', id: s.site.homePageId }, instancePath: [], nodeId: pageAt(s, '/')!.rootIds[0] });
  const focused = { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'constrained-json' as const };
  const nodeAt = (s: ProjectState, i: number) => pageAt(s, '/')!.nodes[pageAt(s, '/')!.rootIds[i]] as InstanceNode;

  it('generates closed, typed schemas from every component contract', () => {
    for (const theme of listThemes()) {
      for (const def of theme.components) expect(hasOpenSchema(propsJsonSchema(def)), def.componentId).toBe(false);
    }
    const state = createStarterState('business', 'Test', false);
    const site = toolsForRun({ state, selection: null, capabilities: { toolCalling: 'constrained-json', contextWindowTokens: 8000 }, codeEnabled: false, definitionOps: false });
    for (const name of ['upsert_page_with_sections', 'update_site_brand']) {
      const parameters = site.tools.find((t) => t.name === name)!.parameters;
      expect(hasOpenSchema(parameters), name).toBe(false);
      // Nothing in these schemas needs the helper's escape hatch for open values.
      const strict = toStrictSchema(parameters);
      expect(findForbiddenShapes(strict), name).toEqual([]);
      expect(JSON.stringify(strict), name).not.toContain('$json');
    }
    const target = { owner: { kind: 'page' as const, id: state.site.homePageId }, nodeId: pageAt(state, '/')!.rootIds[2] };
    for (const tool of selectionTools(state, target)!) {
      expect(hasOpenSchema(tool.parameters), tool.name).toBe(false);
      expect(findForbiddenShapes(toStrictSchema(tool.parameters)), tool.name).toEqual([]);
      expect(JSON.stringify(toStrictSchema(tool.parameters)), tool.name).not.toContain('$json');
    }
    const props = (selectionTools(state, target)![0].parameters.properties as Record<string, Record<string, Record<string, unknown>>>).props.properties;
    expect(Object.keys(props)).toEqual(Object.keys(catalogueComponent('foundation', 'features.grid')!.properties));
  });

  it('writes object and token properties as closed, typed schemas and short signatures (issue #96)', () => {
    const def = {
      properties: {
        primary: P.object('Primary button', { label: P.str('Label', 'Go'), link: P.link('Link') }),
        accent: P.token('Accent', 'color', 'color.brand')
      }
    };
    const full = propsJsonSchema(def) as { properties: Record<string, Record<string, unknown>> };
    expect(hasOpenSchema(full)).toBe(false);
    expect(findForbiddenShapes(toStrictSchema(full))).toEqual([]);
    expect(full.properties.primary).toMatchObject({ type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, link: { type: 'string' } } });
    expect(full.properties.accent).toMatchObject({ type: 'string' });
    expect(String(full.properties.accent.description)).toMatch(/color tokens, such as color\.brand/);
    const compact = compactPropsSchema(def) as { properties: Record<string, Record<string, unknown>> };
    expect(hasOpenSchema(compact)).toBe(false);
    expect(compact.properties.primary).toEqual({ type: 'object', properties: { label: { type: 'string' }, link: { type: 'string' } }, additionalProperties: false });
    expect(propSchemaSummary(def.properties)).toMatchObject({
      primary: { type: 'object', label: 'Primary button', fields: { label: 'string', link: 'link' } },
      accent: { type: 'token', label: 'Accent', tokenGroup: 'color' }
    });
  });

  it('holds an object field linking to a page made later in the run until that page exists (issue #96)', () => {
    const state = createStarterState('business', 'Test', false);
    const def = { name: 'Action', properties: { primary: P.object('Primary button', { label: P.str('Label', 'Go'), link: P.link('Link') }) } } as unknown as Parameters<typeof checkProps>[0];
    const issues: Array<{ field: string; message: string }> = [];
    const r = checkProps(def, { primary: { label: 'See services', link: '/later-services/' } }, state, 'sections[0].props', issues);
    expect(issues).toEqual([]);
    expect(r.props.primary).toEqual({ label: 'See services', link: { type: 'none', target: '' } });
    expect(r.deferred).toEqual([{ route: '/later-services/', prop: 'primary', field: 'link' }]);
    // A field the object does not have is reported at its path.
    checkProps(def, { primary: { colour: 'red' } }, state, 'sections[0].props', issues);
    expect(issues.map((i) => i.field)).toEqual(['sections[0].props.primary']);
  });

  it('chooses tools by task: small sets for local models, the general tools kept for cloud models', () => {
    const state = createStarterState('business', 'Test', false);
    const names = (t: ToolDefinition[]) => t.map((x) => x.name);
    const target = { owner: { kind: 'page' as const, id: state.site.homePageId }, nodeId: pageAt(state, '/')!.rootIds[2] };
    const base = { state, codeEnabled: true, definitionOps: true };
    const local = { toolCalling: 'constrained-json' as const, contextWindowTokens: 16000 };
    const cloud = { toolCalling: 'native' as const, contextWindowTokens: 400000 };
    expect(names(toolsForRun({ ...base, selection: target, capabilities: local }).tools)).toEqual(['update_selected_props', 'edit_selected_list', 'style_selected_element', 'request_wider_scope']);
    // A request that attached library images can look them up and ask which one, whatever is selected (#12).
    expect(names(toolsForRun({ ...base, selection: target, capabilities: local, attachedImages: true }).tools)).toEqual(['update_selected_props', 'edit_selected_list', 'style_selected_element', 'request_wider_scope', 'search_assets', 'request_clarification']);
    const cloudTools = names(toolsForRun({ ...base, selection: target, capabilities: cloud }).tools);
    expect(cloudTools).toEqual(expect.arrayContaining(['update_selected_props', 'apply_operations']));
    const localSite = names(toolsForRun({ ...base, selection: null, capabilities: local }).tools);
    expect(localSite).toEqual(expect.arrayContaining(['upsert_page_with_sections', 'update_site_brand', 'read_page']));
    expect(localSite).not.toContain('apply_operations');
    expect(names(toolsForRun({ ...base, selection: null, capabilities: cloud }).tools)).toEqual(expect.arrayContaining(['upsert_page_with_sections', 'apply_operations']));
    // A definition's own tree is not something the selection tools can edit: a small model gets its definition tools
    // (#360), a cloud model the general ones.
    const def = Object.values(state.components).find((d) => d.tree)!;
    const inside = { selection: { owner: { kind: 'component' as const, id: def.id }, nodeId: def.tree!.rootIds[0] }, definition: true, definitionTarget: { definitionId: def.id, nodeId: def.tree!.rootIds[0] } };
    const inDef = toolsForRun({ ...base, ...inside, capabilities: local });
    expect(inDef.mode).toBe('definition');
    expect(names(inDef.tools)).not.toContain('apply_operations');
    expect(names(inDef.tools)).not.toContain('update_selected_props');
    const cloudDef = toolsForRun({ ...base, ...inside, capabilities: cloud });
    expect(cloudDef.mode).toBe('general');
    expect(names(cloudDef.tools)).toContain('apply_operations');
  });

  it('updates the selected component and reports bad values by field', async () => {
    const { session, adapter, run } = await setup(
      [
        () => [call('p1', 'update_selected_props', { props: { heading: 'A', nope: 1, primaryLink: 'not a link at all' } })],
        () => [call('p2', 'update_selected_props', { props: { heading: 'Sharper headline', primaryLink: '/about/' }, variant: 'muted' })],
        () => finish()
      ],
      focused
    );
    const before = nodeAt(session.state, 1).props;
    const { result } = await run('Tighten this headline', heroRef(session.state));
    expect(result?.status).toBe('completed');
    const first = JSON.parse((adapter.requests[1].items.at(-1) as { content: string }).content);
    expect(first.fields.map((f: { field: string }) => f.field).sort()).toEqual(['props.nope', 'props.primaryLink']);
    const hero = nodeAt(session.state, 0);
    expect(hero.props.heading).toBe('Sharper headline');
    expect((hero.props.primaryLink as LinkValue).type).toBe('page');
    expect(hero.variants?.tone).toBe('muted');
    expect(nodeAt(session.state, 1).props).toEqual(before);
    // The hero has an image, so it can also look up assets and ask which one to use; it has no list.
    expect(adapter.requests[0].tools.map((t) => t.name)).toEqual(['update_selected_props', 'style_selected_element', 'request_wider_scope', 'search_assets', 'request_clarification']);
    // A constrained model reads the image rules beside the tools it uses for them.
    const prompt = adapter.requests[0].system + envelopeInstructions(adapter.requests[0].tools);
    expect(prompt).toContain('An image is set by its assetId');
    expect(prompt).toMatch(/\n- request_clarification [^\n]*assetIds[^\n]*\n  [^\n]*To choose between images, pass assetIds: they see the pictures\./);
    expect(prompt).toMatch(/\n- search_assets [^\n]*\n  [^\n]*\(names can repeat\)\. You cannot see images\./);
  });

  it('still tours the tools for a focused model that calls them natively', async () => {
    const { session, adapter, run } = await setup([() => finish()], { ...focused, toolCalling: 'native' });
    await run('Tighten this headline', heroRef(session.state));
    expect(adapter.requests[0].system).toContain('request_clarification with assetIds lets the user choose between images by sight');
    expect(adapter.requests[0].system).toContain('- update_selected_props changes its content; send only what changes.');
    // The context is as it was for a native model: indented, with the code setting.
    const text = (adapter.requests[0].items.at(-1) as { text: string }).text;
    expect(text).toContain('<editor_context>\n{\n "currentPage"');
    expect(text).toContain('"customCode"');
  });

  it('keeps the operations note for a model with the general tools, and names the selection tools for a constrained one', async () => {
    const part = (s: ProjectState): ElementRef => {
      const inst = nodeAt(s, 0);
      return { owner: { kind: 'page', id: s.site.homePageId }, instancePath: [inst.id], nodeId: s.components[inst.definitionId].parts.heading.nodeId, partId: 'heading' };
    };
    const noteOf = (req: CanonicalModelRequest) => JSON.parse(/<editor_context>\n([\s\S]*)\n<\/editor_context>/.exec((req.items.at(-1) as { text: string }).text)![1]).selection;
    const cloud = await setup([() => finish()]);
    await cloud.run('Tighten this', part(cloud.session.state));
    expect(noteOf(cloud.adapter.requests[0]).note).toMatch(/instance\.setProp/);
    const local = await setup([() => finish()], focused);
    await local.run('Tighten this', part(local.session.state));
    expect(noteOf(local.adapter.requests[0])).not.toHaveProperty('note');
    expect(noteOf(local.adapter.requests[0]).scope).toMatch(/Only this part/);
  });

  it('lets a focused run on the hero offer same-named photos and set the one the author picks (#12)', async () => {
    const photo = (id: string, file: string) => ({ id, name: 'hero', file: `static/assets/${file}.jpg`, mime: 'image/jpeg', bytes: 1000, width: 1536, height: 1024, hash: id, kind: 'image' as const, createdAt: '2026-01-01T00:00:00Z' });
    let offered: string[] = [];
    const { session, adapter, run, answers } = await setup(
      [
        () => [call('s1', 'search_assets', { query: 'hero' })],
        (req) => {
          offered = lastResult(req).assets.map((a: { assetId: string }) => a.assetId);
          return [call('q1', 'request_clarification', { question: 'Which hero photo?', assetIds: offered })];
        },
        (req) => {
          const assetId = /assetId: ([\w-]+)/.exec(lastResult(req).answer)?.[1] ?? null;
          return [call('p1', 'update_selected_props', { props: { image: { assetId, alt: 'Reading nook by the window' } } })];
        },
        () => finish('Set the hero photo.')
      ],
      focused,
      'business',
      (s) => {
        s.assets.assets.a_yca1j3rh = photo('a_yca1j3rh', 'hero-1a2b3c4d');
        s.assets.assets.a_kitchen1 = { ...photo('a_kitchen1', 'kitchen-1a2b3c4d'), name: 'Kitchen' };
        s.assets.assets.a_hodln13r = photo('a_hodln13r', 'hero-5e6f7a8b');
      }
    );
    answers.push({ assetId: 'a_hodln13r' });
    const { result } = await run('Change the hero photo; ask me which one', heroRef(session.state));
    expect(result?.status).toBe('completed');
    expect(offered).toEqual(['a_yca1j3rh', 'a_hodln13r']);
    expect((nodeAt(session.state, 0).props.image as { assetId: string }).assetId).toBe('a_hodln13r');
    // The tool the local model filled in takes up to four asset IDs, optionally.
    const params = adapter.requests[0].tools.find((t) => t.name === 'request_clarification')!.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(params.properties.assetIds).toMatchObject({ type: 'array', items: { type: 'string' }, maxItems: 4 });
    expect(params.required ?? []).not.toContain('assetIds');
  });

  it('edits list items one at a time', async () => {
    let added = '';
    const { session, adapter, run } = await setup(
      [
        (req) => {
          void req;
          return [call('l1', 'edit_selected_list', { prop: 'items', action: 'insert', index: 0, fields: { icon: 'leaf', title: 'New', description: 'Added.' } })];
        },
        (req) => {
          added = lastResult(req).results[0].itemId;
          return [call('l2', 'edit_selected_list', { prop: 'items', action: 'update', itemId: added, fields: { title: 'Renamed' } })];
        },
        () => [call('l3', 'edit_selected_list', { prop: 'items', action: 'move', itemId: added, index: 2 })],
        () => [call('l4', 'edit_selected_list', { prop: 'items', action: 'remove', itemId: original[0] })],
        () => finish()
      ],
      focused
    );
    const original = (nodeAt(session.state, 2).props.items as ListItem[]).map((i) => i.id);
    const ref = { ...heroRef(session.state), nodeId: pageAt(session.state, '/')!.rootIds[2] };
    await run('Update these cards', ref);
    const items = nodeAt(session.state, 2).props.items as Array<ListItem & { title: string; description: string }>;
    expect(items.map((i) => i.id)).toEqual([original[1], added, original[2]]);
    expect(items[1]).toMatchObject({ title: 'Renamed', description: 'Added.' });
    // Without an image to choose, a focused run is not told how to choose one (#12).
    expect(adapter.requests[0].system).not.toContain('assetId');
  });

  it('changes one table cell, row or column by ID, never rewriting the rest (issue #179)', async () => {
    let added = '';
    const tableAt = (st: ProjectState) => nodeAt(st, pageAt(st, '/')!.rootIds.length - 1);
    const { session, adapter, run } = await setup(
      [
        (req) => {
          expect(req.tools.map((t) => t.name)).toContain('edit_selected_table');
          return [call('t1', 'edit_selected_table', { prop: 'table', action: 'setCell', rowId: 'row_2', columnId: 'col_time', value: '19:00' })];
        },
        () => [call('t2', 'edit_selected_table', { prop: 'table', action: 'insertRow', cells: ['Friday', 'Raku', '17:00'] })],
        (req) => {
          added = lastResult(req).rowId;
          return [call('t3', 'edit_selected_table', { prop: 'table', action: 'moveColumn', columnId: 'col_time', index: 0 })];
        },
        () => [call('t4', 'edit_selected_table', { prop: 'table', action: 'removeRow', rowId: 'row_gone' })],
        () => finish()
      ],
      focused,
      'business',
      (s) => {
        const def = s.components[installComponent(s, 'data.table')];
        const node = makeInstance(def);
        const home = s.pages[s.site.homePageId];
        home.nodes[node.id] = node;
        home.rootIds.push(node.id);
      }
    );
    await run('Move the Wednesday class to 7pm and add a Friday raku class', { ...heroRef(session.state), nodeId: tableAt(session.state).id });
    const t = tableAt(session.state).props.table as TableValue;
    expect(added).toMatch(/^row_/);
    expect(t.columns.map((c) => c.id)).toEqual(['col_time', 'col_day', 'col_workshop']);
    expect(t.rows.map((r) => r.id)).toEqual(['row_1', 'row_2', 'row_3', added]);
    expect(t.rows[1].cells).toEqual({ col_day: 'Wednesday', col_workshop: 'Hand building', col_time: '19:00' });
    expect(t.rows[3].cells).toEqual({ col_day: 'Friday', col_workshop: 'Raku', col_time: '17:00' });
    // A step naming a row the table does not have is refused with the reason, and changes nothing.
    expect(JSON.stringify(lastResult(adapter.requests[4]))).toContain('no row has the ID \\"row_gone\\"');
  });

  it('styles one part at one screen size', async () => {
    const { session, run } = await setup([() => [call('s1', 'style_selected_element', { partId: 'root', scope: 'phone', styles: [{ property: 'paddingBlock', value: { token: 'space.lg' } }] })], () => finish()], focused);
    await run('Less padding on mobile', heroRef(session.state));
    expect(nodeAt(session.state, 0).overrides?.root?.phone?.paddingBlock).toEqual({ token: 'space.lg' });
    expect(nodeAt(session.state, 0).overrides?.root?.base).toBeUndefined();
  });

  it('styles one part on hover, and refuses a state value that would move it (#348)', async () => {
    const { session, adapter, run } = await setup(
      [
        () => [call('h1', 'style_selected_element', { partId: 'root', scope: 'base', state: 'hover', styles: [{ property: 'background', value: { token: 'color.brand' } }, { property: 'paddingBlock', value: '8px' }] })],
        () => [call('h2', 'style_selected_element', { partId: 'root', scope: 'phone', state: 'active', styles: [{ property: 'shadow', value: { token: 'shadow.sm' } }] })],
        () => [call('h3', 'style_selected_element', { partId: 'root', scope: 'base', state: 'hover', styles: [{ property: 'background', value: { token: 'color.brand' } }] })],
        () => finish()
      ],
      focused
    );
    await run('Darken it on hover and press', heroRef(session.state));
    const tool = adapter.requests[0].tools.find((t) => t.name === 'style_selected_element');
    expect((tool?.parameters as { properties: Record<string, { enum?: string[] }> }).properties.state?.enum).toEqual(['hover', 'focus', 'active']);
    expect(tool?.description).toContain('Add state "hover", "focus" (keyboard focus) or "active" (while pressed)');
    // Padding on hover would move what is around it: the whole call is refused before anything is applied, naming the field.
    const refused = JSON.stringify(lastResult(adapter.requests[1]));
    expect(refused).toContain('styles[1].property');
    expect(refused).toContain('cannot change on hover, focus or press');
    const root = nodeAt(session.state, 0).overrides?.root;
    expect(root?.['base:hover']).toEqual({ background: { token: 'color.brand' } });
    expect(root?.['phone:active']).toEqual({ shadow: { token: 'shadow.sm' } });
    expect(root?.base).toBeUndefined();
  });

  it('lifts and animates the selection with the typed motion properties (#351)', async () => {
    const styles = [{ property: 'translateY', value: '-4px' }, { property: 'scale', value: 1.03 }, { property: 'transition', value: 'transform' }, { property: 'transitionDuration', value: 250 }];
    const { session, adapter, run } = await setup([() => [call('m1', 'style_selected_element', { partId: 'root', scope: 'base', styles })], () => finish()], focused);
    await run('Lift it a little', heroRef(session.state));
    const tool = adapter.requests[0].tools.find((t) => t.name === 'style_selected_element');
    expect(tool?.description).toContain('translateX and translateY take a length such as "-4px"');
    const schema = JSON.stringify(tool?.parameters);
    for (const id of ['translateX', 'translateY', 'scale', 'rotate', 'transformOrigin', 'transition', 'transitionDuration', 'transitionEasing']) expect(schema, id).toContain(`"${id}"`);
    expect(tool?.description).toContain('(none, colors, shadow, transform, opacity, common)');
    expect(nodeAt(session.state, 0).overrides?.root?.base).toEqual({ translateY: '-4px', scale: 1.03, transition: 'transform', transitionDuration: 250 });
  });

  it('refuses a motion value out of range and changes nothing (#351)', async () => {
    const { session, adapter, run } = await setup([() => [call('m2', 'style_selected_element', { partId: 'root', scope: 'base', styles: [{ property: 'transitionDuration', value: 9000 }] })], () => finish()], focused);
    await run('Make it slow', heroRef(session.state));
    expect(JSON.stringify(lastResult(adapter.requests[1]))).toContain('at most 3000');
    expect(nodeAt(session.state, 0).overrides?.root?.base?.transitionDuration).toBeUndefined();
  });

  it('sets a cropped image’s focal point for one screen size (#166)', async () => {
    const { session, adapter, run } = await setup(
      [() => [call('f1', 'style_selected_element', { partId: 'media', scope: 'phone', styles: [{ property: 'aspectRatio', value: '16/9' }, { property: 'objectPosition', value: '50% 20%' }] })], () => finish()],
      focused
    );
    const hero = nodeAt(session.state, 0);
    await run('Keep her face in view on phones', { ...heroRef(session.state), instancePath: [hero.id], nodeId: 'media', partId: 'media' });
    expect(adapter.requests[0].tools.find((t) => t.name === 'style_selected_element')?.description).toContain('"X% Y%"');
    expect(nodeAt(session.state, 0).overrides?.media).toEqual({ phone: { aspectRatio: '16/9', objectPosition: '50% 20%' } });
  });

  it('styles only the selected card, leaving its siblings on the shared style, then resets it (#81)', async () => {
    let poetry = '';
    let styledAfterFirst: unknown;
    const { session, adapter, run } = await setup(
      [
        (req) => {
          const params = req.tools.find((t) => t.name === 'style_selected_element')!.parameters as { properties: Record<string, { description?: string }> };
          expect(params.properties.itemId?.description).toContain(`"${poetry}"`);
          return [call('c1', 'style_selected_element', { itemId: poetry, scope: 'base', styles: [{ property: 'background', value: '#dbeeff' }, { property: 'radius', value: '0px' }] })];
        },
        () => {
          styledAfterFirst = structuredClone(nodeAt(session.state, 2).itemOverrides);
          return [call('c2', 'style_selected_element', { itemId: poetry, resetItem: true, scope: 'base', styles: [] })];
        },
        () => finish('Poetry evening is back to the shared style.')
      ],
      focused
    );
    const grid = nodeAt(session.state, 2);
    poetry = (grid.props.items as ListItem[])[1].id;
    const def = session.state.components[grid.definitionId];
    const page = pageAt(session.state, '/')!;
    const { result } = await run('Make only this card pale blue', { owner: { kind: 'page', id: page.id }, instancePath: [grid.id], nodeId: def.parts.card.nodeId, partId: 'card', itemPath: [poetry] });
    // Styled, then reset: the run ends where it started, with no error.
    expect(result?.error).toBeUndefined();
    expect(styledAfterFirst).toEqual({ card: { list: 'items', items: { [poetry]: { base: { background: '#dbeeff', radius: '0px' } } } } });
    const after = nodeAt(session.state, 2);
    expect(after.overrides?.card).toBeUndefined();
    // The focused tool's reset returns the card to the shared style at every size.
    expect(after.itemOverrides).toBeUndefined();
    // The model is told, in the selection context, which item is selected and that it can be styled on its own.
    const context = (adapter.requests[0].items.at(-1) as { text: string }).text;
    const reach = context.slice(context.indexOf('"styleReach":'));
    expect(reach).toMatch(/^"styleReach":\s*\{\s*"list":\s*"items"/);
    expect(reach).toMatch(new RegExp(`"itemId":\\s*"${poetry}",\\s*"itemOwnStyles":\\s*null`));
  });

  it('edits a plain text element through the same tool', async () => {
    const { session, run } = await setup([() => [call('t1', 'update_selected_props', { props: { text: 'Hello there' } })], () => finish()], focused, 'blank', (s) => inSection(s, { id: 'n_text', kind: 'text', tag: 'p', text: 'Opening soon' }));
    const home = pageAt(session.state, '/')!;
    const textId = 'n_text';
    await run('Change this', { owner: { kind: 'page', id: home.id }, instancePath: [], nodeId: textId });
    expect((pageAt(session.state, '/')!.nodes[textId] as { text: string }).text).toBe('Hello there');
  });

  it('changes a selected heading’s level and a selected button’s style (#195)', async () => {
    const { session, adapter, run } = await setup(
      [
        (req) => {
          const props = (req.tools[0].parameters.properties as { props: { properties: Record<string, { enum?: string[] }> } }).props.properties;
          // Every plain text tag the engine takes (#189).
          expect(props.tag.enum).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'small', 'strong', 'blockquote', 'div', 'cite', 'dt', 'dd', 'figcaption']);
          return [call('t1', 'update_selected_props', { props: { tag: 'h2' } })];
        },
        () => [call('t2', 'update_selected_props', { props: { tag: 'section' } })],
        () => finish(),
        (req) => {
          const props = (req.tools[0].parameters.properties as { props: { properties: Record<string, { enum?: string[] }> } }).props.properties;
          expect(props.appearance.enum).toEqual(['primary', 'secondary', 'text', 'light', 'link', 'plain']);
          return [call('b1', 'update_selected_props', { props: { appearance: 'secondary', label: 'Book now' } })];
        },
        () => finish()
      ],
      focused,
      'blank',
      (s) => {
        inSection(s, { id: 'n_title', kind: 'text', tag: 'h1', text: 'Welcome' });
        const home = s.pages[s.site.homePageId];
        home.nodes.n_btn = { id: 'n_btn', kind: 'link', link: { type: 'none', target: '' }, label: 'Button', appearance: 'primary' };
        home.rootIds.push('n_btn');
      }
    );
    const home = pageAt(session.state, '/')!;
    const headingId = Object.values(home.nodes).find((n) => n.kind === 'text' && n.tag === 'h1')!.id;
    await run('Make this a subheading', { owner: { kind: 'page', id: home.id }, instancePath: [], nodeId: headingId });
    expect((pageAt(session.state, '/')!.nodes[headingId] as { tag: string }).tag).toBe('h2');
    // A tag the element cannot take is refused by field, before anything is applied.
    expect(JSON.stringify(lastResult(adapter.requests[2]))).toContain('props.tag');
    await run('Make this a secondary button', { owner: { kind: 'page', id: home.id }, instancePath: [], nodeId: 'n_btn' });
    expect(pageAt(session.state, '/')!.nodes.n_btn).toMatchObject({ appearance: 'secondary', label: 'Book now' });
  });

  it('never offers a tag for rich text, or a tag or style a repeated item sets (#195)', () => {
    const state = createStarterState('blank', 'Test', false);
    const home = state.pages[state.site.homePageId];
    home.nodes.n_rich = { id: 'n_rich', kind: 'text', tag: 'div', text: '', rich: true };
    home.nodes.n_boundTag = { id: 'n_boundTag', kind: 'text', tag: { $item: 'level' }, text: 'x' };
    home.nodes.n_boundBtn = { id: 'n_boundBtn', kind: 'link', link: { type: 'none', target: '' }, label: 'Go', appearance: { $item: 'style' } };
    const fieldsOf = (nodeId: string) => Object.keys((selectionTools(state, { owner: { kind: 'page', id: home.id }, nodeId })![0].parameters.properties as { props: { properties: object } }).props.properties);
    expect(fieldsOf('n_rich')).toEqual(['text']);
    expect(fieldsOf('n_boundTag')).toEqual(['text']);
    expect(fieldsOf('n_boundBtn')).toEqual(['label', 'link']);
  });

  it('keeps each list’s own shape for a field name two lists share (#195)', async () => {
    const statsList = { type: 'list', label: 'Stats', itemLabel: 'Stat', fields: { title: { type: 'image', label: 'Value', default: { assetId: null, alt: '' } } }, default: [] } as unknown as PropSchema;
    type List = Extract<PropSchema, { type: 'list' }>;
    let gridDef = '';
    const { session, adapter, run } = await setup(
      [
        // A shape the list's own check would quietly turn into an empty image is refused by field, and nothing
        // is applied.
        () => [call('l0', 'edit_selected_list', { prop: 'stats', action: 'insert', fields: { title: 42 } })],
        () => [call('l1', 'edit_selected_list', { prop: 'stats', action: 'insert', fields: { title: { assetId: null, alt: 'Chart' } } })],
        () => [call('l2', 'edit_selected_list', { prop: 'items', action: 'insert', fields: { icon: 'leaf', title: 'Care', description: 'Weekly.' } })],
        // An update is checked the same way: a list of choices would quietly clear a destination.
        () => [call('l3', 'edit_selected_list', { prop: 'links', action: 'update', itemId: 'it_go', fields: { title: [{ label: 'Email' }] } })],
        () => finish()
      ],
      focused,
      'business',
      (s) => {
        const grid = s.pages[s.site.homePageId].nodes[s.pages[s.site.homePageId].rootIds[2]] as InstanceNode;
        gridDef = grid.definitionId;
        const props = s.components[gridDef].properties;
        props.stats = statsList;
        // The same shape under another label is one shape.
        const items = props.items as List;
        props.notes = { ...items, label: 'Notes', fields: { title: { ...items.fields.title, label: 'Note' } }, default: [] } as PropSchema;
        props.links = { type: 'list', label: 'Links', itemLabel: 'Link', fields: { title: { type: 'link', label: 'Destination', default: { type: 'none', target: '' } } }, default: [{ id: 'it_go', title: { type: 'url', target: 'https://example.com' } }] } as unknown as PropSchema;
      }
    );
    const ref = { ...heroRef(session.state), nodeId: pageAt(session.state, '/')!.rootIds[2] };
    await run('Add a stat and a card', ref);
    const tool = adapter.requests[0].tools.find((t) => t.name === 'edit_selected_list')!;
    const title = ((tool.parameters.properties as Record<string, JsonSchemaLike>).fields.properties as Record<string, JsonSchemaLike>).title;
    expect(title.anyOf?.map((b) => b.type)).toEqual(['string', 'object', 'string']);
    // One shape the lists describe differently keeps each list's description.
    expect(title.anyOf?.slice(0, 2).map((b) => b.description)).toEqual(['When prop is "items": Title. When prop is "notes": Note', 'When prop is "stats": Value']);
    expect(title.anyOf?.[2].description).toMatch(/^When prop is "links": Destination/);
    const strict = toStrictSchema(tool.parameters);
    const strictTitle = ((strict.properties as Record<string, JsonSchemaLike>).fields.properties as Record<string, JsonSchemaLike>).title;
    expect(JSON.stringify(strictTitle)).toMatch(/"type":"string".*"type":"object"/);
    expect(findForbiddenShapes(strict)).toEqual([]);
    expect(JSON.stringify(strict)).not.toContain('$json');
    expect(lastResult(adapter.requests[1]).fields).toEqual([{ field: 'fields.title', message: 'must be an image: an asset ID or { assetId, alt } for "stats"' }]);
    const grid = nodeAt(session.state, 2).props;
    expect((grid.stats as Array<{ title: unknown }>).map((i) => i.title)).toEqual([{ assetId: null, alt: 'Chart' }]);
    expect((grid.items as Array<{ title: string }>).at(-1)?.title).toBe('Care');
    expect(lastResult(adapter.requests[4]).fields).toEqual([{ field: 'fields.title', message: 'must be a link: a route, a URL or { type, target } for "links"' }]);
    expect(grid.links).toBeUndefined();
  });

  it('switches to the site tools once the user allows a wider change', async () => {
    const { session, adapter, run, answers } = await setup(
      [
        (req) => {
          expect(req.tools.map((t) => t.name)).not.toContain('upsert_page_with_sections');
          return [call('w1', 'request_wider_scope', { question: 'This needs a new page. OK?' })];
        },
        (req) => {
          expect(req.tools.map((t) => t.name)).toContain('upsert_page_with_sections');
          return [call('w2', 'upsert_page_with_sections', services)];
        },
        () => finish()
      ],
      // Leave room for the full catalogue after widening. The compact selection budget is tested separately.
      { ...focused, contextWindowTokens: 12_000 }
    );
    answers.push('Yes, allow changes beyond the selection');
    const { result } = await run('Add a services page for this', heroRef(session.state));
    expect(result?.error).toBeUndefined();
    expect(result?.status).toBe('completed');
    expect(pageAt(session.state, '/services/')).toBeDefined();
    expect(adapter.requests).toHaveLength(3);
  });

  it('sends a compact editor context for a selection', async () => {
    const { session, adapter, run } = await setup([() => finish('Nothing to do.')], focused);
    await run('Look at this', heroRef(session.state));
    const text = (adapter.requests[0].items.at(-1) as { text: string }).text;
    expect(text).toContain('"selection"');
    expect(text).not.toContain('"shell"');
    expect(text).not.toContain('Navigation');
    expect(estimateRequestTokens(adapter.requests[0].system, adapter.requests[0].tools, adapter.requests[0].items)).toBeLessThan(3000);
  });
});

describe('context budget', () => {
  const big = (rev: number, id = 'pg_a') => JSON.stringify({ revision: rev, id, title: 'Home', owner: { kind: 'page', id }, sections: [{ id: 'n_1', componentId: 'hero.split', props: { heading: 'x'.repeat(4000) } }, { id: 'n_2', componentId: 'cta.banner' }] });
  const read = (callId: string, args: Record<string, unknown>, content: string, name = 'read_page', extra: object = { providerData: [{ type: 'reasoning', encrypted_content: `sealed-${callId}` }, { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }] }): CanonicalItem[] => [
    { kind: 'assistant', text: '', toolCalls: [{ id: callId, name, arguments: JSON.stringify(args) }], ...extra },
    { kind: 'tool_result', callId, name, content }
  ];
  const opts = (window: number) => ({ system: 'sys', tools: [], capabilities: { contextWindowTokens: window, maxOutputTokens: 500 }, isMutation: (n: string) => n === 'upsert_page_with_sections' });
  const results = (items: CanonicalItem[]) => items.filter((i) => i.kind === 'tool_result') as Array<Extract<CanonicalItem, { kind: 'tool_result' }>>;

  it('collapses a superseded read to one line, keeping IDs and valid provider replay', () => {
    const items: CanonicalItem[] = [{ kind: 'user', text: 'go' }, ...read('a', { pageId: 'pg_a' }, big(1)), ...read('b', { pageId: 'pg_b' }, big(1, 'pg_b')), ...read('c', { pageId: 'pg_a' }, big(2)), ...read('d', { pageId: 'pg_b' }, big(2, 'pg_b'))];
    const assistants = structuredClone(items.filter((i) => i.kind === 'assistant'));
    const r = applyContextBudget(items, opts(6000));
    expect(r.tombstoned).toBe(2);
    const [a, b, c, d] = results(items);
    expect(a.content).toMatch(/^\[Superseded read_page pg_a "Home" at rev 1\. Sections: n_1 hero\.split, n_2 cta\.banner\./);
    expect(a.content).not.toContain('\n');
    expect(b.content).toContain('Superseded');
    expect(c.content).toBe(big(2));
    expect(d.content).toBe(big(2, 'pg_b'));
    // Every call keeps its result, and assistant turns (reasoning included) are untouched.
    expect(items.filter((i) => i.kind === 'assistant')).toEqual(assistants);
    expect(results(items).map((x) => x.callId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps every part of a field read whole, and a read of one field after another (#132)', () => {
    const owner = { kind: 'page', id: 'pg_a' };
    const part = (offset: number, prop = 'body') => JSON.stringify({ revision: 1, owner, nodeId: 'n_1', prop, format: 'markdown', total: 24000, start: offset, end: offset + 8000, next: offset + 8000 < 24000 ? offset + 8000 : null, text: 'x'.repeat(8000) });
    const items: CanonicalItem[] = [
      { kind: 'user', text: 'go' },
      ...read('a', { owner, nodeId: 'n_1', prop: 'body' }, part(0), 'inspect_element'),
      ...read('b', { owner, nodeId: 'n_1', prop: 'body', offset: 8000 }, part(8000), 'inspect_element'),
      ...read('c', { owner, nodeId: 'n_1', prop: 'heading' }, part(0, 'heading'), 'inspect_element'),
      ...read('d', { owner, nodeId: 'n_1', prop: 'body', offset: 16000 }, part(16000), 'inspect_element'),
      ...read('e', { owner, nodeId: 'n_1', prop: 'items', itemId: 'i_a', field: 'text' }, part(0, 'items'), 'inspect_element'),
      ...read('f', { owner, nodeId: 'n_1', prop: 'items', itemId: 'i_b', field: 'text' }, part(0, 'items'), 'inspect_element'),
      ...read('g', { owner, nodeId: 'n_1', prop: 'items', itemId: 'i_b', field: 'note' }, part(0, 'items'), 'inspect_element')
    ];
    applyContextBudget(items, opts(9000));
    // No part stands in for another: each still holds its text.
    expect(results(items).map((r) => r.content.includes('x'.repeat(8000)))).toEqual([true, true, true, true, true, true, true]);
  });

  it('leaves everything alone while there is room', () => {
    const items: CanonicalItem[] = [...read('a', { pageId: 'pg_a' }, big(1)), ...read('b', { pageId: 'pg_a' }, big(2)), ...read('c', { pageId: 'pg_c' }, big(2, 'pg_c'))];
    const copy = structuredClone(items);
    expect(applyContextBudget(items, opts(400000)).tombstoned).toBe(0);
    expect(items).toEqual(copy);
  });

  it('never collapses the results the model has not acted on, or an error', () => {
    const failed: CanonicalItem[] = [{ kind: 'assistant', text: '', toolCalls: [{ id: 'e', name: 'read_page', arguments: '{"pageId":"pg_a"}' }] }, { kind: 'tool_result', callId: 'e', name: 'read_page', content: `{"error":"${'y'.repeat(4000)}"}`, isError: true }];
    const items: CanonicalItem[] = [...failed, ...read('a', { pageId: 'pg_a' }, big(1)), ...read('b', { pageId: 'pg_a' }, big(2))];
    applyContextBudget(items, opts(2400));
    const [e, a, b] = results(items);
    expect(e.content).toContain('yyy');
    expect(a.content).toBe(big(1));
    expect(b.content).toBe(big(2));
  });

  it('under pressure also collapses reads made stale by a later change, and reports overflow when nothing is left', () => {
    const change: CanonicalItem[] = [{ kind: 'assistant', text: '', toolCalls: [{ id: 'm', name: 'upsert_page_with_sections', arguments: '{}' }] }, { kind: 'tool_result', callId: 'm', name: 'upsert_page_with_sections', content: '{"ok":true,"pageId":"pg_a"}' }];
    const items: CanonicalItem[] = [...read('a', { pageId: 'pg_a' }, big(1)), ...change, ...read('x', { pageId: 'pg_x' }, big(2, 'pg_x')), ...read('y', { pageId: 'pg_y' }, big(2, 'pg_y'))];
    const r = applyContextBudget(items, opts(3400));
    expect(results(items)[0].content).toContain('Sections: n_1 hero.split');
    expect(r.tombstoned).toBe(1);
    expect(r.overflow).toBe(false);
    const tight = applyContextBudget([...read('a', { pageId: 'pg_a' }, big(1)), ...read('b', { pageId: 'pg_b' }, big(1, 'pg_b'))], opts(1000));
    expect(tight.overflow).toBe(true);
  });

  describe('code, element, layout and project reads (#195)', () => {
    const pad = 'q'.repeat(4000);
    const src = (def: string, start: number, end: number, hash: string, endLine = end) =>
      JSON.stringify({ definitionId: def, editable: true, hash, totalLines: 900, startLine: start, endLine, source: Array.from({ length: end - start + 1 }, () => 'let x = 1;').join('\n') + pad });
    const element = (id: string, rev = 3) => JSON.stringify({ revision: rev, owner: { kind: 'page', id }, node: { id: 'n_1', kind: 'instance', props: { body: pad } }, displayName: 'Hero', parent: null });
    const layout = (pageId: string, viewport: string, rev?: number) => JSON.stringify({ ...(rev !== undefined ? { revision: rev } : {}), pageId, viewport, width: 390, report: { issues: [], headings: pad } });
    const project = (rev = 3) => JSON.stringify({ revision: rev, homePageId: 'pg_a', pages: [{ id: 'pg_a', route: '/' }, { id: 'pg_b', route: '/about/' }], tokens: pad });
    const filler = (id: string) => read(id, {}, '{"errors":[]}', 'validate_project');
    const at = (items: CanonicalItem[], callId: string) => results(items).find((r) => r.callId === callId)!.content;
    const optsWith = (window: number, extra: Partial<Parameters<typeof applyContextBudget>[1]> = {}) => ({ ...opts(window), isMutation: (n: string) => n === 'apply_source_patch' || n === 'apply_operations', ...extra });

    it('collapses a read another read of the same thing replaced, and nothing it did not', () => {
      const items: CanonicalItem[] = [
        ...read('s1', { definitionId: 'def_a', startLine: 1, endLine: 80 }, src('def_a', 1, 80, 'sha_one'), 'read_source'),
        ...read('s2', { definitionId: 'def_a' }, src('def_a', 1, 400, 'sha_one'), 'read_source'),
        // Other lines of the same source are not a replacement.
        ...read('s3', { definitionId: 'def_a', startLine: 401 }, src('def_a', 401, 800, 'sha_one'), 'read_source'),
        // Fewer lines than an earlier read are not a replacement either.
        ...read('s4', { definitionId: 'def_a', startLine: 1, endLine: 80 }, src('def_a', 1, 80, 'sha_one'), 'read_source'),
        ...read('e1', { owner: { kind: 'page', id: 'pg_a' }, nodeId: 'n_1' }, element('pg_a'), 'inspect_element'),
        ...read('e2', { owner: { kind: 'page', id: 'pg_b' }, nodeId: 'n_1' }, element('pg_b'), 'inspect_element'),
        ...read('e3', { owner: { kind: 'page', id: 'pg_a' }, nodeId: 'n_1' }, element('pg_a'), 'inspect_element'),
        // A route and the page's ID are the same page; another viewport is another measurement.
        ...read('l1', { pageId: '/', viewport: 'phone' }, layout('pg_a', 'phone'), 'inspect_layout'),
        ...read('l2', { pageId: 'pg_a', viewport: 'desktop' }, layout('pg_a', 'desktop'), 'inspect_layout'),
        ...read('l3', { pageId: 'pg_a', viewport: 'phone' }, layout('pg_a', 'phone'), 'inspect_layout'),
        // A project read that includes everything an earlier one did replaces it, whatever order the sections came in.
        ...read('p1', { sections: ['tokens'] }, project(), 'read_project'),
        ...read('p2', { sections: ['catalogue', 'pages'] }, project(), 'read_project'),
        ...read('p3', { sections: ['catalogue', 'tokens'] }, project(), 'read_project'),
        ...read('p4', {}, project(), 'read_project'),
        ...filler('f1'),
        ...filler('f2')
      ];
      const kept = structuredClone(items);
      const r = applyContextBudget(items, optsWith(26000));
      expect(r.tombstoned).toBe(5);
      expect(at(items, 's1')).toBe('[Superseded read_source def_a lines 1–80 of 900. Read it again for the current source and hash.]');
      expect(at(items, 's1')).not.toContain('sha_one');
      expect(at(items, 'e1')).toBe('[Superseded inspect_element n_1 on page pg_a at rev 3. Inspect it again before relying on it.]');
      expect(at(items, 'l1')).toBe('[Superseded inspect_layout pg_a phone. Measure it again if you need it.]');
      expect(at(items, 'p1')).toBe('[Superseded read_project at rev 3 (tokens). Pages: pg_a /, pg_b /about/. Read it again if you need it.]');
      expect(at(items, 'p2')).toContain('[Superseded read_project at rev 3 (catalogue, pages).');
      for (const id of ['s2', 's3', 's4', 'e2', 'e3', 'l2', 'l3', 'p3', 'p4']) expect(at(items, id), id).toBe(at(kept, id));
    });

    it('never lets a read cut short by the size limit replace a complete one', () => {
      const cut = (s: string) => JSON.stringify({ truncated: true, note: 'Result was long', partial: s.slice(0, 3000) });
      const items: CanonicalItem[] = [
        ...read('a', { pageId: 'pg_a' }, big(1)),
        ...read('b', { pageId: 'pg_a' }, cut(big(2))),
        ...read('s1', { definitionId: 'def_a', startLine: 1, endLine: 400 }, cut(src('def_a', 1, 400, 'sha_one')), 'read_source'),
        ...read('s2', { definitionId: 'def_a' }, src('def_a', 1, 400, 'sha_one'), 'read_source'),
        // A cut read does not show every line it asked for, so it replaces nothing, even another cut read.
        ...read('s3', { definitionId: 'def_b', startLine: 200, endLine: 400 }, cut(src('def_b', 200, 400, 'sha_b')), 'read_source'),
        ...read('s4', { definitionId: 'def_b', startLine: 1, endLine: 400 }, cut(src('def_b', 1, 400, 'sha_b')), 'read_source'),
        // An end before the start returns all but the last line: what came back is what counts.
        ...read('s5', { definitionId: 'def_c', endLine: -1 }, src('def_c', 1, 899, 'sha_c', -1), 'read_source'),
        ...read('s6', { definitionId: 'def_c', endLine: 80 }, src('def_c', 1, 80, 'sha_c'), 'read_source'),
        // An empty answer shows no line at all.
        ...read('s7', { definitionId: 'def_e', startLine: 80, endLine: 80 }, src('def_e', 80, 80, 'sha_e'), 'read_source'),
        ...read('s8', { definitionId: 'def_e', startLine: 80, endLine: 79 }, JSON.stringify({ definitionId: 'def_e', editable: true, hash: 'sha_e', totalLines: 900, startLine: 80, endLine: 79, source: '' }), 'read_source'),
        // A cut read that asked for all but the last line may show more than a later read of the first lines.
        ...read('s9', { definitionId: 'def_f', endLine: -1 }, cut(src('def_f', 1, 899, 'sha_f', -1)), 'read_source'),
        ...read('s10', { definitionId: 'def_f', endLine: 80 }, src('def_f', 1, 80, 'sha_f'), 'read_source'),
        ...filler('f1'),
        ...filler('f2')
      ];
      const kept = structuredClone(items);
      applyContextBudget(items, optsWith(16000));
      expect(at(items, 'a')).toBe(big(1));
      // A complete read of the lines the cut one asked for replaces it.
      expect(at(items, 's1')).toBe('[Superseded read_source def_a. Read it again for the current source and hash.]');
      for (const id of ['s3', 's5', 's7', 's9']) expect(at(items, id), id).toBe(at(kept, id));
    });

    it('under pressure collapses what a later change made stale, then sources once anything has changed', () => {
      const patch: CanonicalItem[] = [
        { kind: 'assistant', text: '', toolCalls: [{ id: 'm', name: 'apply_source_patch', arguments: JSON.stringify({ definitionId: 'def_a', expectedHash: 'sha_one', edits: [] }) }] },
        { kind: 'tool_result', callId: 'm', name: 'apply_source_patch', content: '{"ok":true,"revision":4,"hash":"sha_two"}' }
      ];
      const failed: CanonicalItem[] = [
        { kind: 'assistant', text: '', toolCalls: [{ id: 'x', name: 'apply_source_patch', arguments: JSON.stringify({ definitionId: 'def_c', expectedHash: 'h', edits: [] }) }] },
        { kind: 'tool_result', callId: 'x', name: 'apply_source_patch', content: '{"error":"STALE_REVISION"}', isError: true }
      ];
      const history = (): CanonicalItem[] => [
        ...read('c1', { definitionId: 'def_c' }, src('def_c', 1, 400, 'sha_c'), 'read_source'),
        ...failed,
        ...read('s1', { definitionId: 'def_a' }, src('def_a', 1, 400, 'sha_one'), 'read_source'),
        ...read('e1', { owner: { kind: 'page', id: 'pg_a' }, nodeId: 'n_1' }, element('pg_a'), 'inspect_element'),
        ...read('l1', { pageId: 'pg_b', viewport: 'phone' }, layout('pg_b', 'phone'), 'inspect_layout'),
        ...read('p1', {}, project(), 'read_project'),
        ...read('s2', { definitionId: 'def_b' }, src('def_b', 1, 400, 'sha_b'), 'read_source'),
        ...patch,
        ...filler('f1'),
        ...filler('f2')
      ];
      // Enough room once the stale reads are gone: the sources nothing changed are kept.
      const roomy = history();
      applyContextBudget(roomy, optsWith(7400));
      for (const id of ['s1', 'e1', 'l1', 'p1']) expect(at(roomy, id), id).toMatch(/^\[Superseded /);
      for (const id of ['c1', 's2']) expect(at(roomy, id), id).not.toContain('Superseded');
      // Tighter still, a source is given up after a change that need not have named it (a theme switch removes
      // components without naming them), but a failed patch changed nothing.
      const tight = history();
      applyContextBudget(tight, optsWith(3000));
      for (const id of ['c1', 's2']) expect(at(tight, id), id).toMatch(/^\[Superseded read_source/);
      // With no change at all, nothing is stale.
      const quiet = history().filter((i) => !('callId' in i && i.callId === 'm') && !(i.kind === 'assistant' && i.toolCalls[0]?.id === 'm'));
      applyContextBudget(quiet, optsWith(3000));
      for (const id of ['c1', 's1', 'e1', 'l1', 'p1', 's2']) expect(at(quiet, id), id).not.toContain('Superseded');
    });

    it('under pressure collapses a source a later read shows has changed, with no change in between', () => {
      const items: CanonicalItem[] = [
        ...read('d1', { definitionId: 'def_d' }, src('def_d', 1, 400, 'sha_d1'), 'read_source'),
        ...read('d2', { definitionId: 'def_d', startLine: 401 }, src('def_d', 401, 800, 'sha_d2'), 'read_source'),
        ...filler('f1'),
        ...filler('f2')
      ];
      applyContextBudget(items, optsWith(2000));
      expect(at(items, 'd1')).toMatch(/^\[Superseded read_source def_d lines 1–400 of 900\./);
      expect(at(items, 'd2')).toBe(src('def_d', 401, 800, 'sha_d2'));
    });

    it('goes by the revision a read was made at: a change that was not a tool’s result counts, a change that changed nothing does not', () => {
      const noop: CanonicalItem[] = [
        { kind: 'assistant', text: '', toolCalls: [{ id: 'm', name: 'apply_operations', arguments: '{"operations":[]}' }] },
        { kind: 'tool_result', callId: 'm', name: 'apply_operations', content: '{"ok":true,"revision":3}' }
      ];
      const cut = (s: string) => JSON.stringify({ truncated: true, note: 'Result was long', partial: s.slice(0, 3000) });
      const items = (): CanonicalItem[] => [
        ...read('p1', {}, cut(project(3)), 'read_project'),
        ...read('e1', { owner: { kind: 'page', id: 'pg_a' }, nodeId: 'n_1' }, element('pg_a', 3), 'inspect_element'),
        ...read('l1', { pageId: 'pg_a', viewport: 'phone' }, layout('pg_a', 'phone', 3), 'inspect_layout'),
        ...noop,
        ...filler('f1'),
        ...filler('f2')
      ];
      const current = items();
      applyContextBudget(current, optsWith(2000, { revision: 3 }));
      for (const id of ['p1', 'e1', 'l1']) expect(at(current, id), id).not.toContain('Superseded');
      // Links connected when a page was created move the revision without a tool result.
      const moved = items();
      applyContextBudget(moved, optsWith(2000, { revision: 4 }));
      expect(at(moved, 'p1')).toMatch(/^\[Superseded read_project\. /);
      expect(at(moved, 'e1')).toMatch(/^\[Superseded inspect_element n_1/);
      expect(at(moved, 'l1')).toBe('[Superseded inspect_layout pg_a phone. Measure it again if you need it.]');
    });

    it('keeps every collapsed read to one line', () => {
      const titled = JSON.stringify({ revision: 1, id: 'pg_a', title: 'About\nUs\u2028Team', owner: { kind: 'page', id: 'pg_a' }, sections: [{ id: 'n_1', componentId: 'hero.split', props: { heading: pad } }] });
      const items: CanonicalItem[] = [...read('a', { pageId: 'pg_a' }, titled), ...read('b', { pageId: 'pg_a' }, titled), ...filler('f1'), ...filler('f2')];
      applyContextBudget(items, optsWith(2000));
      expect(at(items, 'a')).toMatch(/^\[Superseded read_page pg_a "About Us Team"/);
    });

    it('records the revision a layout check was made at', async () => {
      const { session, adapter, run } = await setup([() => [call('i1', 'inspect_layout', { pageId: '/', viewport: 'phone' })], () => finish()]);
      await run('Check the home page on phones');
      expect(lastResult(adapter.requests[1])).toMatchObject({ revision: session.revision, pageId: session.state.site.homePageId, viewport: 'phone' });
    });
  });

  it('keeps a run inside a small window, then stops with its work kept when it cannot', async () => {
    const page = { slug: 'services', title: 'Services', sections: [{ componentId: 'intro.page' }, { componentId: 'features.grid' }] };
    const flood = 'z'.repeat(120000);
    const { session, run } = await setup(
      [
        () => [call('m', 'upsert_page_with_sections', page)],
        // Something that cannot be collapsed fills the window (the request's own items are the run's history).
        (req) => {
          req.items.push({ kind: 'user', text: flood });
          return [call('v', 'validate_project', {})];
        }
      ],
      { contextWindowTokens: 30000, maxOutputTokens: 4000 }
    );
    const { result } = await run('Add a services page');
    expect(result?.status).toBe('completed');
    expect(result?.incomplete).toBe(true);
    expect(result?.summary).toContain('context limit');
    expect(pageAt(session.state, '/services/')).toBeDefined();
  });
});

describe('completeness check', () => {
  const stub = (slug: string) => ({ slug, title: slug[0].toUpperCase() + slug.slice(1), sections: [{ componentId: 'intro.page', props: { heading: slug } }] });

  it('nudges once for a page left with only an intro, then lets the model finish it', async () => {
    const { session, adapter, run } = await setup([
      () => [calls(['a', 'upsert_page_with_sections', stub('services')], ['b', 'upsert_page_with_sections', { ...stub('pricing'), sections: [{ componentId: 'intro.page' }, { componentId: 'pricing.plans' }] }])],
      () => finish('All built.'),
      (req) => {
        const nudge = (req.items.at(-1) as { text: string }).text;
        expect(nudge).toContain('Services (/services/) has only an opening section');
        expect(nudge).not.toContain('Pricing');
        return [call('c', 'upsert_page_with_sections', { slug: 'services', sections: [{ componentId: 'intro.page' }, { componentId: 'features.grid' }] })];
      },
      () => finish('Now it is all built.')
    ]);
    const { result } = await run('Build a Services page and a Pricing page');
    expect(result?.status).toBe('completed');
    expect(result?.summary).toBe('Now it is all built.');
    expect(result?.incomplete).toBeUndefined();
    expect(componentsOn(session.state, '/services/')).toEqual(['intro.page', 'features.grid']);
    expect(adapter.requests).toHaveLength(4);
  });

  it('does not loop: a model that ignores the nudge finishes, and the result says what is unfinished', async () => {
    const { adapter, run } = await setup([() => [call('a', 'upsert_page_with_sections', stub('services'))], () => finish('Done.'), () => finish('Still done.')]);
    const { result } = await run('Build a Services page');
    expect(adapter.requests).toHaveLength(3);
    expect(result?.status).toBe('completed');
    expect(result?.incomplete).toBe(true);
    expect(result?.validation.join(' ')).toContain('Services still has only an opening section');
  });

  it('does not nudge when a stub is what was asked for, or for a page the request only mentions', () => {
    const before = createStarterState('business', 'Test', false);
    const after = structuredClone(before);
    const id = 'pg_newpage';
    const home = after.pages[after.site.homePageId];
    const hero = home.rootIds[0];
    after.pages[id] = { ...structuredClone(home), id, title: 'Services', route: '/services/', rootIds: [hero], nodes: { [hero]: home.nodes[hero] } };
    after.site.pageOrder.push(id);
    expect(findStubPages(before, after, 'Add a Services page').map((p) => p.pageId)).toEqual([id]);
    expect(findStubPages(before, after, 'Add a blank Services page')).toEqual([]);
    const existing = structuredClone(after);
    expect(findStubPages(existing, after, 'Fix the typo on the Services page')).toEqual([]);
    expect(findStubPages(existing, after, 'Finish the Services page').map((p) => p.pageId)).toEqual([id]);
  });
});

describe('review regressions', () => {
  const pending = { slug: 'offer', title: 'Offer', sections: [{ componentId: 'intro.page' }, { componentId: 'cta.banner', props: { heading: 'Go', primaryLabel: 'Book', primaryLink: '/booking/' } }] };
  const booking = { slug: 'booking', title: 'Booking', sections: [{ componentId: 'intro.page' }, { componentId: 'faq.list' }] };
  const ctaLink = (s: ProjectState) => {
    const p = pageAt(s, '/offer/')!;
    return (p.nodes[p.rootIds[1]] as InstanceNode).props.primaryLink as LinkValue;
  };

  it('never overwrites a newer edit with a link that was waiting for a page', async () => {
    const { session, run } = await setup([
      () => [call('a', 'upsert_page_with_sections', pending)],
      () => [call('b', 'upsert_page_with_sections', { slug: 'offer', sections: [{ componentId: 'intro.page' }, { componentId: 'cta.banner', props: { primaryLink: 'https://example.com/book' } }] })],
      () => [call('c', 'upsert_page_with_sections', booking)],
      () => finish()
    ]);
    await run('Build offer and booking pages');
    expect(ctaLink(session.state)).toEqual({ type: 'url', target: 'https://example.com/book' });
  });

  it('connects a waiting link at finish when the page was made with a general operation', async () => {
    const { session, run } = await setup([
      () => [call('a', 'upsert_page_with_sections', pending)],
      () => [call('b', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'page.create', title: 'Booking', route: '/booking/', starter: 'intro' }, ] })],
      () => finish('Done.'),
      () => finish('Done.')
    ]);
    const { runId } = await run('Build offer and booking pages');
    expect(ctaLink(session.state)).toEqual({ type: 'page', target: pageAt(session.state, '/booking/')!.id });
    await session.undoGroup(runId);
    expect(pageAt(session.state, '/offer/')).toBeUndefined();
  });

  it('replays a call ID without running it again, even after a no-op', async () => {
    const twice = { slug: 'about', addToHeaderNav: true };
    const { session, adapter, run } = await setup([
      () => [call('n1', 'upsert_page_with_sections', twice)],
      () => {
        const about = pageAt(session.state, '/about/')!;
        const header = session.state.site.shell.header;
        const link = (shellLinks(session.state, 'header')).find((l) => l.link.target === about.id)!;
        return [call('n2', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'instance.listRemove', owner: { kind: 'shell', id: 'header' }, nodeId: header.rootIds[0], prop: 'links', itemId: link.id }] })];
      },
      () => [call('n1', 'upsert_page_with_sections', twice)],
      () => finish()
    ]);
    await run('Tidy the menu');
    expect(shellLinks(session.state, 'header').some((l) => l.link.target === pageAt(session.state, '/about/')!.id)).toBe(false);
    expect(adapter.requests).toHaveLength(4);
  });

  it('does not apply a repair to a page that changed after the draft was rejected', async () => {
    const bad = { slug: 'late', title: 'Late', removeOtherSections: true, sections: [{ componentId: 'intro.page' }, { componentId: 'faq.list', props: { nope: 1 } }] };
    const { session, adapter, run } = await setup([
      () => [call('a', 'upsert_page_with_sections', bad)],
      () => [call('b', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'page.create', title: 'Late', route: '/late/', starter: 'intro' }] })],
      () => [call('c', 'upsert_page_with_sections', { slug: 'late', repair: true, sections: [{ index: 1, componentId: 'faq.list' }] })],
      () => finish(),
      () => finish()
    ]);
    await run('Add a blank late page');
    expect(JSON.stringify(adapter.requests[3].items.at(-1))).toContain('changed since that draft');
    expect(pageAt(session.state, '/late/')!.rootIds).toHaveLength(1);
  });

  it('resolves "home" to the current Home page after another page is promoted', async () => {
    const { session, run } = await setup([
      () => [call('p', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'page.setHome', pageId: pageAt(session.state, '/about/')!.id }] })],
      () => [call('h', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'cta.banner', props: { heading: 'On the new home' } }] })],
      () => finish()
    ]);
    const aboutId = pageAt(session.state, '/about/')!.id;
    await run('Update the home page');
    expect(session.state.site.homePageId).toBe(aboutId);
    expect(componentsOn(session.state, '/')).toContain('cta.banner');
  });

  it('rejects a model-supplied page ID', async () => {
    const { session, adapter, run } = await setup([() => [call('x', 'apply_operations', { expectedRevision: 0, operations: [{ type: 'page.create', pageId: 'pg_chosen1', title: 'Chosen' }] })], () => finish()]);
    await run('Add a blank page');
    expect(JSON.stringify(adapter.requests[1].items.at(-1))).toContain('does not take a pageId');
    expect(session.state.pages.pg_chosen1).toBeUndefined();
  });

  it('rejects a model-supplied node ID, and never offers one', async () => {
    let home = '';
    const { session, adapter, run } = await setup([() => [call('x', 'apply_operations', { expectedRevision: 0, operations: [{ type: 'node.insert', owner: { kind: 'page', id: home }, primitive: 'heading' }, { type: 'node.insert', newNodeId: 'n_chosen1', owner: { kind: 'page', id: home }, primitive: 'image' }, { type: 'node.insert', owner: { kind: 'page', id: home }, primitive: 'divider' }] })], () => finish()]);
    home = session.state.site.homePageId;
    await run('Add an image');
    const offered = JSON.stringify(adapter.requests[0].tools.find((t) => t.name === 'apply_operations'));
    expect(offered).toContain('node.insert');
    expect(offered).not.toContain('newNodeId');
    expect(JSON.stringify(adapter.requests[1].items.at(-1))).toContain('does not take a newNodeId');
    expect(session.state.pages[home].nodes.n_chosen1).toBeUndefined();
    // Nothing of the batch was applied.
    expect(session.revision).toBe(0);
  });

  it('rejects a model-supplied place for a duplicate, and never offers one', async () => {
    let home = '';
    let first = '';
    const { session, adapter, run } = await setup([() => [call('x', 'apply_operations', { expectedRevision: 0, operations: [{ type: 'node.duplicate', owner: { kind: 'page', id: home }, nodeId: first, index: 3 }] })], () => finish()]);
    home = session.state.site.homePageId;
    first = session.state.pages[home].rootIds[0];
    await run('Duplicate the first section');
    const tool = adapter.requests[0].tools.find((t) => t.name === 'apply_operations');
    // The node.duplicate variant of the offered operations, found by its type: it has no place to give.
    const variants: Array<{ properties?: Record<string, { const?: unknown }> }> = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== 'object') return;
      const o = v as { properties?: Record<string, { const?: unknown }> };
      if (o.properties?.type?.const === 'node.duplicate') variants.push(o);
      Object.values(o).forEach(walk);
    };
    walk(tool?.parameters);
    expect(variants).toHaveLength(1);
    expect(Object.keys(variants[0].properties!).sort()).toEqual(['nodeId', 'owner', 'type']);
    expect(JSON.stringify(adapter.requests[1].items.at(-1))).toContain('does not take an index');
    expect(session.revision).toBe(0);
  });

  it('keeps a mid-tone brand color readable and only renames a standard copyright line', async () => {
    const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const t = derivedBrandTokens('#777777', '#f1eee6');
    expect(contrastRatio(hex(t['color.on-brand']), hex('#777777'))).toBeGreaterThanOrEqual(4.5);
    const { session, run } = await setup([() => [call('b', 'update_site_brand', { siteName: 'Acme' })], () => finish()]);
    const footer = session.state.site.shell.footer;
    (footer.nodes[footer.rootIds[0]] as InstanceNode).props.copyright = 'All of Test Studio, always.';
    await run('Rename the site to Acme');
    expect(shellProps(session.state, 'footer').copyright).toBe('All of Test Studio, always.');
  });

  it('keeps a header name the author wrote, says so, and keeps a copyright line asked for as it is (#31)', async () => {
    const { session, adapter, run } = await setup([() => [call('b', 'update_site_brand', { siteName: 'Acme', copyright: `© ${new Date().getFullYear()} Test Studio. All rights reserved.` })], () => finish()], {}, 'business', (s) => {
      (s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode).props.siteName = 'TS Journal';
      delete (s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode).props.siteName;
    });
    await run('Rename the site to Acme, keeping the copyright line');
    expect(session.state.site.name).toBe('Acme');
    expect(shellProps(session.state, 'header').siteName).toBe('TS Journal');
    // The footer showed the design's own name ("Studio"), not the site's, so it keeps that, and the reply says so.
    expect(shellProps(session.state, 'footer').siteName).toBeUndefined();
    expect(shellProps(session.state, 'footer').copyright).toBe(`© ${new Date().getFullYear()} Test Studio. All rights reserved.`);
    const reply = JSON.parse((adapter.requests[1].items.at(-1) as { content: string }).content) as { warnings?: string[] };
    expect(reply.warnings?.join(' ')).toContain('The header keeps its own name, “TS Journal”');
    expect(reply.warnings?.join(' ')).toContain('The footer keeps its own name, “Studio”');
  });

  it('puts an asked-for copyright line in every footer, even where the rename could not have grown the old line', async () => {
    // The line asked for names the old site, as the line there does: the rename would grow either past the limit.
    const line = `© ${new Date().getFullYear()} Test Studio. Photos by Ana Lee.`;
    const { session, run } = await setup([() => [call('b', 'update_site_brand', { siteName: 'Acme Studio Group', copyright: line })], () => finish()], {}, 'business', (s) => {
      const tree = s.site.shell.footer;
      const first = tree.nodes[tree.rootIds[0]] as InstanceNode;
      // The footer's line holds at most 40 characters: "© year Acme Studio Group. All rights reserved." would not fit.
      const def = s.components[first.definitionId];
      def.properties.copyright = { ...def.properties.copyright, maxLength: 40 } as typeof def.properties.copyright;
      const second = { ...structuredClone(first), id: 'n_second_footer' };
      tree.nodes[second.id] = second;
      tree.rootIds.push(second.id);
    });
    await run('Rename the site to Acme Studio Group, keeping the copyright line about Test Studio');
    expect(session.state.site.name).toBe('Acme Studio Group');
    const tree = session.state.site.shell.footer;
    expect(tree.rootIds.map((id) => (tree.nodes[id] as InstanceNode).props.copyright)).toEqual([line, line]);
  });

  it('nudges for a page that was rejected and never retried, even with no other change', async () => {
    const { adapter, run } = await setup([
      () => [call('a', 'upsert_page_with_sections', { slug: 'gone', sections: [{ componentId: 'nope' }] })],
      () => finish('All built.'),
      () => finish('I could not build it.')
    ]);
    await run('Build a Gone page');
    expect((adapter.requests[2].items.at(-1) as { text: string }).text).toContain('/gone/ was rejected');
    expect(adapter.requests).toHaveLength(3);
  });

  it('keeps blank and small-edit requests out of the completeness check, clause by clause', () => {
    const before = createStarterState('business', 'Test', false);
    const after = structuredClone(before);
    const home = after.pages[after.site.homePageId];
    const hero = home.rootIds[0];
    for (const [id, title] of [['pg_soon', 'Coming Soon'], ['pg_serv', 'Services']]) {
      after.pages[id] = { ...structuredClone(home), id, title, route: `/${title.toLowerCase().replace(' ', '-')}/`, rootIds: [hero], nodes: { [hero]: home.nodes[hero] } };
      after.site.pageOrder.push(id);
    }
    expect(findStubPages(before, after, 'Add a blank Coming Soon page and build Services').map((p) => p.pageId)).toEqual(['pg_serv']);
    expect(findStubPages(after, after, 'Add a sentence to the Services page')).toEqual([]);
  });

  it('shows the model the current text when a part inside a component is selected', async () => {
    const { session, adapter, run } = await setup([() => finish('Nothing to do.')], { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'constrained-json' });
    const home = pageAt(session.state, '/')!;
    const inst = home.nodes[home.rootIds[0]] as InstanceNode;
    await run('Shorten this', { owner: { kind: 'page', id: home.id }, instancePath: [inst.id], nodeId: 'heading', partId: 'heading' });
    expect((adapter.requests[0].items.at(-1) as { text: string }).text).toContain(String(inst.props.heading));
  });

  it('leaves a part of a nested component to the general tools', () => {
    const state = createStarterState('business', 'Test', false);
    expect(selectionTools(state, { owner: { kind: 'page', id: state.site.homePageId }, nodeId: pageAt(state, '/')!.rootIds[0], partId: 'heading', nested: true })).toBeNull();
  });
});

describe('the header notice (#269)', () => {
  const NOTICE = 'Studio closed on Friday for repairs';

  it('points a notice for every page at the shared header, where one edit reaches every page', async () => {
    const { session, adapter, run } = await setup([
      () => [call('n1', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: session.state.site.shell.header.rootIds[0], prop: 'notice', value: NOTICE }] })],
      () => finish('Added the notice to the header.')
    ]);
    const pages = session.state.site.pageOrder.map((id) => session.state.pages[id].rootIds.length);
    const { result } = await run('Tell visitors on every page that the studio is closed on Friday for repairs');
    expect(result?.status).toBe('completed');
    expect(adapter.requests[0].system).toContain('A notice for every page (a closure, holiday hours, an announcement) is the header\'s "notice" text');
    expect(shellProps(session.state, 'header').notice).toBe(NOTICE);
    expect(session.state.site.pageOrder.map((id) => session.state.pages[id].rootIds.length)).toEqual(pages);
  });

  it('says how to get a notice when the project’s header predates it, instead of naming fields it lacks', async () => {
    const { adapter, run } = await setup([() => finish('Update the theme components first.')], {}, 'business', (s) => {
      const header = s.components[(s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode).definitionId];
      for (const key of ['notice', 'noticeLabel', 'noticeLink']) delete header.properties[key];
    });
    await run('Tell visitors on every page that the studio is closed on Friday');
    expect(adapter.requests[0].system).toContain('This project\'s header has no notice field.');
    expect(adapter.requests[0].system).not.toContain('"noticeLabel"');
    expect(adapter.requests[0].system).toContain('Never add a page section for it');
  });
});

describe('ai-profile examples', () => {
  it('are valid against every theme and cover every section family', () => {
    const state = createStarterState('business', 'Test', false);
    for (const theme of listThemes()) {
      const scoped = { ...state, site: { ...state.site, themeId: theme.id } };
      const examples = theme.aiProfile.examples ?? [];
      for (const ex of examples) expect(checkExample(scoped, ex), `${theme.id}/${ex.id}`).toEqual([]);
      const covered = new Set(examples.map((e) => e.componentId));
      for (const c of theme.components) if (c.category !== 'shell' && c.componentId !== 'layout.section') expect(covered.has(c.componentId), `${theme.id} is missing an example for ${c.componentId}`).toBe(true);
      expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
    }
  });

  it('notices an example that has gone stale', () => {
    const state = createStarterState('business', 'Test', false);
    const issues = checkExample(state, { id: 'x', componentId: 'cta.banner', keywords: [], description: '', variant: 'gone', props: { headline: 'Old prop' } });
    expect(issues.map((i) => i.field)).toEqual(['variant', 'props.headline']);
  });

  it('retrieves by keyword, one per component', () => {
    const state = createStarterState('business', 'Test', false);
    expect(retrieveExamples(state, 'Add a pricing page with three plans')[0].componentId).toBe('pricing.plans');
    expect(retrieveExamples(state, 'Add our team and some FAQs').map((e) => e.componentId)).toEqual(expect.arrayContaining(['team.grid', 'faq.list']));
    expect(retrieveExamples(state, 'zzz qqq')).toEqual([]);
    const ids = retrieveExamples(state, 'home hero landing site website services', 5).map((e) => e.componentId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('read_component and installed theme components', () => {
  it('describes a theme component as the project has it installed, so an older copy offers no heading level', async () => {
    const { executeTool } = await import('@agent/tools');
    const s = createStarterState('business', 'Test Studio', false);
    const host = { state: () => s, revision: () => 1 } as unknown as Parameters<typeof executeTool>[2];
    const read = async () => JSON.stringify((await executeTool('read_component', JSON.stringify({ componentId: 'hero.centered' }), host, 'c1')).content);
    // Not installed yet: the theme's own definition, which a placement would install.
    expect(await read()).toContain('headingLevel');
    const old = structuredClone(catalogueComponent('foundation', 'hero.centered')!);
    delete old.properties.headingLevel;
    old.tree!.nodes.heading = { ...old.tree!.nodes.heading, tag: 'h1' } as never;
    s.components[old.id] = old;
    expect(await read()).not.toContain('headingLevel');
  });
});

describe('tone and layout in one call (#132)', () => {
  const focused = { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'constrained-json' as const };
  const gridOn = (s: ProjectState, route: string) => {
    const p = pageAt(s, route)!;
    return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'features.grid')!;
  };
  const items = [{ icon: 'leaf', title: 'Care', description: 'Weekly visits.' }];

  it('places and updates a section with tone and layout set together by the page tool', async () => {
    const { session, adapter, run } = await setup([
      () => [call('v1', 'upsert_page_with_sections', { slug: 'care', title: 'Care', sections: [{ componentId: 'features.grid', variants: { tone: 'muted', layout: 'two-columns' }, props: { heading: 'Care', items } }] })],
      (req) => {
        expect(lastResult(req).ok).toBe(true);
        // The one call set both axes as it placed the section.
        expect(gridOn(session.state, '/care/').variants).toEqual({ tone: 'muted', layout: 'two-columns' });
        return [call('v2', 'upsert_page_with_sections', { slug: 'care', sections: [{ componentId: 'features.grid', variants: { layout: 'four-columns' } }] })];
      },
      (req) => {
        expect(lastResult(req).ok).toBe(true);
        // A variant on one axis and a different choice for the same axis are refused together, before anything lands.
        return [call('v3', 'upsert_page_with_sections', { slug: 'care', sections: [{ componentId: 'features.grid', variant: 'inverse', variants: { tone: 'muted', layout: 'six-columns' } }] })];
      },
      () => finish()
    ]);
    await run('Add a Care page with a muted two-column grid, then make it four columns');
    expect(gridOn(session.state, '/care/').variants).toEqual({ tone: 'muted', layout: 'four-columns' });
    const refused = lastResult(adapter.requests[3]);
    expect(refused.error).toBe('VALIDATION_FAILED');
    expect(refused.fields.map((f: { field: string }) => f.field)).toEqual(['sections[0].variants.tone', 'sections[0].variants.layout']);
    // The tool offers one closed choice per axis.
    const schema = upsertToolSchema(session.state) as { properties: { sections: { items: { oneOf: Array<{ properties: Record<string, { properties?: Record<string, { enum?: string[] }>; additionalProperties?: boolean }> }> } } } };
    const grid = schema.properties.sections.items.oneOf.find((o) => JSON.stringify(o.properties.componentId).includes('"features.grid"'))!;
    expect(grid.properties.variants.additionalProperties).toBe(false);
    expect(grid.properties.variants.properties!.layout.enum).toEqual(['default', 'two-columns', 'four-columns']);
    expect(grid.properties.variants.properties!.tone.enum).toContain('muted');
  });

  it('sets tone and layout of the selected section in one selection call', async () => {
    const { session, adapter, run } = await setup([() => [call('s1', 'update_selected_props', { variants: { tone: 'inverse', layout: 'two-columns' } })], () => finish()], focused);
    const grid = gridOn(session.state, '/');
    const page = pageAt(session.state, '/')!;
    await run('Make this dark with two columns', { owner: { kind: 'page', id: page.id }, instancePath: [], nodeId: grid.id });
    expect(gridOn(session.state, '/').variants).toEqual({ tone: 'inverse', layout: 'two-columns' });
    const tool = adapter.requests[0].tools.find((t) => t.name === 'update_selected_props')!.parameters as { properties: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
    expect(Object.keys(tool.properties.variants.properties!)).toEqual(['tone', 'layout']);
  });
});

describe('unchanged legacy values (#132)', () => {
  const focused = { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'constrained-json' as const };
  const gridOn = (s: ProjectState) => {
    const p = pageAt(s, '/')!;
    return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'features.grid')!;
  };
  const retire = (s: ProjectState) => {
    (gridOn(s).props.items as ListItem[])[0].icon = 'flux-capacitor';
  };

  it('resends a page with an icon saved under older rules unchanged, and still refuses a new unknown one', async () => {
    let sent: Array<Record<string, unknown>> = [];
    const { session, adapter, run } = await setup(
      [
        () => {
          sent = (gridOn(session.state).props.items as ListItem[]).map((i) => ({ id: i.id, icon: i.icon, title: i.title }));
          sent[0] = { ...sent[0], title: 'Renamed' };
          return [call('l1', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'features.grid', props: { heading: 'What we do', items: sent } }] })];
        },
        // Matched by its title rather than its id, the item is still the stored one.
        () => [call('l2', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'features.grid', props: { items: sent.map(({ id: _id, ...rest }, i) => (i === 0 ? { ...rest, description: 'By title.' } : rest)) } }] })],
        () => [call('l3', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'features.grid', props: { items: sent.map((x, i) => (i === 0 ? { ...x, icon: 'warp-drive' } : x)) } }] })],
        () => [call('l4', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'features.grid', props: { items: [...sent, { icon: 'flux-capacitor', title: 'New card' }] } }] })],
        () => finish()
      ],
      {},
      'business',
      retire
    );
    await run('Rename the first card');
    expect(lastResult(adapter.requests[1]).ok).toBe(true);
    expect(lastResult(adapter.requests[2]).ok).toBe(true);
    const third = lastResult(adapter.requests[3]);
    expect(third.error).toBe('VALIDATION_FAILED');
    expect(third.fields.map((f: { field: string }) => f.field)).toEqual(['sections[0].props.items[0].icon']);
    // A new item has nothing stored, so an unknown icon on it is refused.
    const fourth = lastResult(adapter.requests[4]);
    expect(fourth.fields.map((f: { field: string }) => f.field)).toEqual([`sections[0].props.items[${sent.length}].icon`]);
    const first = (gridOn(session.state).props.items as ListItem[])[0];
    expect(first).toMatchObject({ id: sent[0].id, title: 'Renamed', icon: 'flux-capacitor', description: 'By title.' });
  });

  it('updates the selected card with its retired icon sent back unchanged', async () => {
    let id = '';
    const { session, adapter, run } = await setup(
      [
        () => [call('e1', 'edit_selected_list', { prop: 'items', action: 'update', itemId: id, fields: { icon: 'flux-capacitor', title: 'Renamed' } })],
        () => [call('e2', 'update_selected_props', { props: { items: (gridOn(session.state).props.items as ListItem[]).map((i) => ({ ...i })) } })],
        () => finish()
      ],
      focused,
      'business',
      retire
    );
    const grid = gridOn(session.state);
    id = (grid.props.items as ListItem[])[0].id;
    const page = pageAt(session.state, '/')!;
    await run('Rename this card', { owner: { kind: 'page', id: page.id }, instancePath: [], nodeId: grid.id });
    expect(lastResult(adapter.requests[1]).ok).toBe(true);
    expect(lastResult(adapter.requests[2]).ok).toBe(true);
    expect((gridOn(session.state).props.items as ListItem[])[0]).toMatchObject({ id, title: 'Renamed', icon: 'flux-capacitor' });
  });
});

describe('reading long rich text whole (#132)', () => {
  const focused = { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'constrained-json' as const };
  /** Paragraphs with bold, italic and a page link, at least `chars` long, ending in a word found nowhere else. */
  const longBody = (chars: number) => {
    const out: string[] = [];
    for (let i = 0; out.join('\n\n').length < chars; i++) out.push(`Paragraph ${i} keeps the studio's story going with **bold ${i}**, *quiet ${i}* and a [visit to About](/about/) in the middle of it.`);
    out.push('The very last line ends with the unique tail TAILWORD.');
    return out.join('\n\n');
  };
  const place = async (session: ProjectSession, body: string) => {
    const home = pageAt(session.state, '/')!;
    const r = await session.apply({ operations: [{ type: 'node.insert', owner: { kind: 'page', id: home.id }, componentId: 'content.text', props: { heading: 'Our story', body } }] }, { label: 'Add story', source: 'user' });
    expect(r.ok).toBe(true);
    const page = pageAt(session.state, '/')!;
    return page.rootIds.map((id) => page.nodes[id] as InstanceNode).find((n) => session.state.components[n.definitionId]?.componentId === 'content.text')!;
  };

  it('edits a 5,000-character field near its end without losing anything else (#132)', async () => {
    let text = '';
    let node = { id: '' } as InstanceNode;
    let owner = { kind: 'page' as const, id: '' };
    // Reads every part the tool returns, in order, then writes the whole value back with one word changed.
    const step = (req: CanonicalModelRequest): ModelEvent[] => {
      const last = req.items.at(-1);
      if (last?.kind === 'tool_result' && last.name === 'update_selected_props') return finish('Changed the last word.');
      if (last?.kind === 'tool_result' && last.name === 'inspect_element') {
        const part = JSON.parse(last.content);
        expect(part.start).toBe(text.length);
        text += part.text;
        if (part.next !== null) return [call(`r${part.next}`, 'inspect_element', { owner, nodeId: node.id, prop: 'body', offset: part.next })];
        return [call('w', 'update_selected_props', { props: { body: text.replace('TAILWORD', 'CHANGED') } })];
      }
      return [call('r0', 'inspect_element', { owner, nodeId: node.id, prop: 'body' })];
    };
    const { session, adapter, run } = await setup(Array.from({ length: 6 }, () => step), focused);
    const body = longBody(5000);
    node = await place(session, body);
    owner = { kind: 'page', id: pageAt(session.state, '/')!.id };
    const before = structuredClone(node.props.body) as Array<{ type: string; spans: Array<{ text: string }> }>;
    expect(JSON.stringify(before).length).toBeGreaterThan(5000);
    const { result } = await run('Change the last word of this text', { owner, instancePath: [], nodeId: node.id });
    expect(result?.status).toBe('completed');
    // The selection shows only a preview of the body, and the run is offered the read that returns it whole.
    expect(adapter.requests[0].tools.map((t) => t.name)).toContain('inspect_element');
    expect((adapter.requests[0].items.at(-1) as { text: string }).text).toMatch(/"truncated":\s*true/);
    expect((adapter.requests[0].items.at(-1) as { text: string }).text).toContain('Read it whole with inspect_element');
    const expected = structuredClone(before);
    const tail = expected.at(-1)!.spans.at(-1)!;
    tail.text = tail.text.replace('TAILWORD', 'CHANGED');
    const after = (pageAt(session.state, '/')!.nodes[node.id] as InstanceNode).props.body;
    expect(after).toEqual(expected);
  });

  it('reads a field longer than one part in parts that join to the whole value, and refuses a bad item or field', async () => {
    const { executeTool } = await import('@agent/tools');
    const { session } = await setup([]);
    const body = longBody(18000);
    const node = await place(session, body);
    const owner = { kind: 'page' as const, id: pageAt(session.state, '/')!.id };
    const host = { state: () => session.state, revision: () => session.revision } as unknown as Parameters<typeof executeTool>[2];
    const read = async (args: Record<string, unknown>) => executeTool('inspect_element', JSON.stringify({ owner, nodeId: node.id, ...args }), host, 'c');
    let text = '';
    let offset: number | null = 0;
    let parts = 0;
    while (offset !== null) {
      const r = await read({ prop: 'body', offset });
      expect(r.ok).toBe(true);
      const c = r.content as { text: string; next: number | null; total: number; format: string };
      expect(c.format).toBe('markdown');
      expect(JSON.stringify(c).length).toBeLessThan(24000);
      text += c.text;
      offset = c.next;
      parts++;
    }
    expect(parts).toBeGreaterThan(1);
    // The parts are the same Markdown the tools accept: written back, it is the stored text exactly.
    const { normalizeRichText } = await import('@engine/values');
    expect(normalizeRichText(text, session.state, 'Text')).toEqual((pageAt(session.state, '/')!.nodes[node.id] as InstanceNode).props.body);
    expect((await read({ prop: 'nope' })).ok).toBe(false);
    expect((await read({ prop: 'heading', itemId: 'x', field: 'y' })).ok).toBe(false);
    expect((await read({ itemId: 'x' })).ok).toBe(false);
    expect(((await read({ prop: 'heading' })).content as { text: string }).text).toBe('Our story');
  });
});

describe('a selected part or placement scopes the run (#132)', () => {
  const focused = { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'constrained-json' as const };
  const home = (s: ProjectState) => pageAt(s, '/')!;
  const nodeAt = (s: ProjectState, i: number) => home(s).nodes[home(s).rootIds[i]] as InstanceNode;

  it('changes only the selected heading of a section, and asks before anything else in it', async () => {
    const asked: string[] = [];
    const { session, adapter, run, answers } = await setup(
      [
        () => [call('h1', 'update_selected_props', { props: { heading: 'A sharper headline' } })],
        () => [call('h2', 'update_selected_props', { props: { heading: 'Never this', lead: 'Outside the heading' } })],
        () => [call('h3', 'style_selected_element', { partId: 'root', scope: 'base', styles: [{ property: 'paddingBlock', value: '1rem' }] })],
        () => [call('h4', 'update_selected_props', { variant: 'muted' })],
        (req) => {
          asked.push(lastResult(req).error?.message ?? '');
          return [call('h5', 'request_wider_scope', { question: 'This needs the whole section. OK?' })];
        },
        // After the user's no, the run is still limited to the heading.
        () => [call('h6', 'update_selected_props', { props: { lead: 'Still outside the heading' } })],
        () => finish('Changed the headline; the rest stays as it is.')
      ],
      focused
    );
    answers.push('No, only change the selection');
    const hero = nodeAt(session.state, 0);
    const before = structuredClone(hero);
    const { result } = await run('Rewrite this headline and make the section muted', { owner: { kind: 'page', id: home(session.state).id }, instancePath: [hero.id], nodeId: 'heading', partId: 'heading' });
    expect(result?.status).toBe('completed');
    // The small tool offers only what the heading shows.
    const tool = adapter.requests[0].tools.find((t) => t.name === 'update_selected_props')!.parameters as { properties: { props: { properties: Record<string, unknown> }; variant?: unknown } };
    expect(Object.keys(tool.properties.props.properties)).toContain('heading');
    expect(Object.keys(tool.properties.props.properties)).not.toContain('lead');
    expect(tool.properties.variant).toBeUndefined();
    expect((tool.properties as Record<string, unknown>).variants).toBeUndefined();
    // The model asked to widen, and the user's no kept the run on the heading.
    expect(answers).toHaveLength(0);
    for (const i of [2, 3, 4, 6]) {
      const r = lastResult(adapter.requests[i]);
      expect(r.error?.code, `call ${i}`).toBe('SCOPE_MISMATCH');
      expect(r.error?.message, `call ${i}`).toContain('request_wider_scope');
    }
    expect(asked[0]).toMatch(/changes more of the selection than the selected part/);
    const after = nodeAt(session.state, 0);
    expect(after.props.heading).toBe('A sharper headline');
    expect({ ...after.props, heading: before.props.heading }).toEqual(before.props);
    expect(after.variants).toEqual(before.variants);
    expect(after.overrides).toEqual(before.overrides);
  });

  it('changes only the selected card: its own fields and its style, never another card, in one batch or after', async () => {
    let poetry = '';
    let other = '';
    let afterRefused: { revision: number; grid: InstanceNode } | null = null;
    const owner = () => ({ kind: 'page', id: home(session.state).id });
    const gridId = () => nodeAt(session.state, 2).id;
    const { session, adapter, run } = await setup([
      // A valid style for the selected card and a title for another card: neither lands.
      () => [
        call('c1', 'apply_operations', {
          expectedRevision: session.revision,
          operations: [
            { type: 'node.setStyle', owner: owner(), nodeId: gridId(), partId: 'card', itemId: poetry, scope: 'base', property: 'background', value: '#dbeeff' },
            { type: 'instance.setProp', owner: owner(), nodeId: gridId(), prop: 'items', itemId: other, field: 'title', value: 'Not this one' }
          ]
        })
      ],
      () => {
        afterRefused = { revision: session.revision, grid: structuredClone(nodeAt(session.state, 2)) };
        return [call('c2', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'node.setStyle', owner: owner(), nodeId: gridId(), partId: 'card', itemId: other, scope: 'base', property: 'background', value: '#ffeedd' }] })];
      },
      () => [call('c3', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'instance.listInsert', owner: owner(), nodeId: gridId(), prop: 'items' }] })],
      // An empty item ID would replace the whole list.
      () => [call('c4', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'instance.setProp', owner: owner(), nodeId: gridId(), prop: 'items', itemId: '', value: [] }] })],
      () => [
        call('c5', 'apply_operations', {
          expectedRevision: session.revision,
          operations: [
            { type: 'instance.setProp', owner: owner(), nodeId: gridId(), prop: 'items', itemId: poetry, field: 'title', value: 'Poetry night' },
            { type: 'node.setStyle', owner: owner(), nodeId: gridId(), partId: 'card', itemId: poetry, scope: 'base', property: 'background', value: '#dbeeff' }
          ]
        })
      ],
      // The style every card shares is not the selected card's alone.
      () => [call('c6', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'node.setStyle', owner: owner(), nodeId: gridId(), partId: 'card', scope: 'base', property: 'radius', value: '0px' }] })],
      () => finish('Renamed and coloured this card.')
    ]);
    const grid = nodeAt(session.state, 2);
    const items = grid.props.items as ListItem[];
    poetry = items[1].id;
    other = items[0].id;
    const def = session.state.components[grid.definitionId];
    const before = structuredClone(grid);
    const revision = session.revision;
    await run('Rename this card and make it pale blue', { owner: { kind: 'page', id: home(session.state).id }, instancePath: [grid.id], nodeId: def.parts.card.nodeId, partId: 'card', itemPath: [poetry] });
    for (const i of [1, 2, 3, 4, 6]) expect(lastResult(adapter.requests[i]).error?.code, `call ${i}`).toBe('SCOPE_MISMATCH');
    // Nothing of the refused batch landed, not even its allowed first operation.
    expect(afterRefused).toEqual({ revision, grid: before });
    expect(lastResult(adapter.requests[5]).ok).toBe(true);
    const after = nodeAt(session.state, 2);
    const afterItems = after.props.items as ListItem[];
    expect(afterItems).toHaveLength(items.length);
    expect(afterItems[0]).toEqual(items[0]);
    expect(afterItems[1].title).toBe('Poetry night');
    expect(after.overrides).toEqual(before.overrides);
    expect(after.itemOverrides).toEqual({ card: { list: 'items', items: { [poetry]: { base: { background: '#dbeeff' } } } } });
  });

  it('asks before an edit inside a definition changes a default that other placements show', async () => {
    let defId = '';
    let defaultWhenAsked: unknown;
    const { session, adapter, run, answers } = await setup(
      [
        () => [call('d1', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'node.setContent', owner: { kind: 'component', id: defId }, nodeId: 'heading', field: 'text', value: 'A new default' }] })],
        (req) => {
          expect(lastResult(req).error?.code).toBe('SCOPE_MISMATCH');
          defaultWhenAsked = (session.state.components[defId].properties.heading as { default: unknown }).default;
          return [call('d2', 'request_clarification', { question: 'This changes the heading every placement without its own shows. OK?', widenScope: true })];
        },
        () => [call('d3', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'node.setContent', owner: { kind: 'component', id: defId }, nodeId: 'heading', field: 'text', value: 'A new default' }] })],
        () => finish('Changed the default heading.')
      ],
      {},
      'business',
      (s) => {
        // A project copy of the hero, placed twice: once with its own heading, once showing the default.
        const page = s.pages[s.site.homePageId];
        const hero = page.nodes[page.rootIds[0]] as InstanceNode;
        defId = (applyOperation(s, { type: 'component.makeUnique', owner: { kind: 'page', id: page.id }, nodeId: hero.id }) as { definitionId: string }).definitionId;
        const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
        const { nodeId } = applyOperation(s, { type: 'node.insert', owner: { kind: 'page', id: about.id }, definitionId: defId, index: 0 }) as { nodeId: string };
        delete (about.nodes[nodeId] as InstanceNode).props.heading;
      }
    );
    const def = () => session.state.components[defId];
    const before = (def().properties.heading as { default: unknown }).default;
    const ownHeading = (pageAt(session.state, '/')!.nodes[pageAt(session.state, '/')!.rootIds[0]] as InstanceNode).props.heading;
    answers.push('Yes, allow changes beyond the selection');
    await run('Change the default heading', { owner: { kind: 'component', id: defId }, instancePath: [], nodeId: 'heading' });
    expect(lastResult(adapter.requests[1]).error?.message).toMatch(/changes the default of the "heading" property/);
    expect(defaultWhenAsked).toBe(before);
    expect(lastResult(adapter.requests[3]).ok).toBe(true);
    expect((def().properties.heading as { default: unknown }).default).toBe('A new default');
    // The placement with its own heading keeps it; the one showing the default shows the new one.
    const placements = Object.values(session.state.pages).flatMap((p) => Object.values(p.nodes)).filter((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === defId);
    expect(placements).toHaveLength(2);
    expect(placements.filter((n) => Object.hasOwn(n.props, 'heading')).map((n) => n.props.heading)).toHaveLength(1);
    expect(placements.find((n) => Object.hasOwn(n.props, 'heading'))!.props.heading).toBe(ownHeading);
    expect(defaultWhenAsked).not.toBe('A new default');
  });
});

describe('values sent back as they were read (#132)', () => {
  const focused = { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'constrained-json' as const };
  const onHome = (s: ProjectState, componentId: string) => {
    const p = pageAt(s, '/')!;
    return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
  };

  it('matches rows by id, not position, and gives an id sent twice to its first row only', async () => {
    let sent: Array<Record<string, unknown>> = [];
    const { session, adapter, run } = await setup(
      [
        () => {
          sent = (onHome(session.state, 'features.grid').props.items as ListItem[]).map((i) => ({ id: i.id, icon: i.icon, title: i.title }));
          // Reordered, each retired icon sent back with its own row.
          return [call('r1', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'features.grid', props: { items: [sent[1], sent[0], ...sent.slice(2)] } }] })];
        },
        () => [call('r2', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'features.grid', props: { items: [sent[0], { ...sent[0], title: 'Copy' }, ...sent.slice(1)] } }] })],
        () => finish()
      ],
      {},
      'business',
      (s) => {
        const items = onHome(s, 'features.grid').props.items as ListItem[];
        items[0].icon = 'flux-capacitor';
        items[1].icon = 'warp-drive';
      }
    );
    await run('Swap the first two cards');
    expect(lastResult(adapter.requests[1]).ok).toBe(true);
    const order = (onHome(session.state, 'features.grid').props.items as ListItem[]).map((i) => [i.id, i.icon]);
    expect(order.slice(0, 2)).toEqual([[sent[1].id, 'warp-drive'], [sent[0].id, 'flux-capacitor']]);
    // The second row reusing the first row's id is a new card: its retired icon is refused by its own field.
    expect(lastResult(adapter.requests[2]).fields.map((f: { field: string }) => f.field)).toEqual(['sections[0].props.items[1].icon']);
  });

  it('keeps a link to a removed page and a picture whose file is gone when a string-typed tool sends them back', async () => {
    const { session, adapter, run } = await setup(
      [
        () => {
          const hero = onHome(session.state, 'hero.split') ?? (pageAt(session.state, '/')!.nodes[pageAt(session.state, '/')!.rootIds[0]] as InstanceNode);
          const image = hero.props.image as { assetId: string; alt: string };
          return [call('k1', 'update_selected_props', { props: { heading: 'New headline', primaryLink: 'pg_gone', image: { assetId: image.assetId, alt: image.alt } } })];
        },
        // An explicit setting is what the sender means: it is not swapped for the stored one.
        () => [call('k2', 'update_selected_props', { props: { image: { assetId: 'a_gone', alt: 'Kitchen', decorative: false } } })],
        () => finish()
      ],
      focused,
      'business',
      (s) => {
        const p = s.pages[s.site.homePageId];
        const hero = p.nodes[p.rootIds[0]] as InstanceNode;
        hero.props.primaryLink = { type: 'page', target: 'pg_gone' };
        hero.props.image = { assetId: 'a_gone', alt: 'Kitchen', decorative: true };
      }
    );
    const home = pageAt(session.state, '/')!;
    await run('Sharpen the headline', { owner: { kind: 'page', id: home.id }, instancePath: [], nodeId: home.rootIds[0] });
    expect(lastResult(adapter.requests[1]).ok).toBe(true);
    const hero = pageAt(session.state, '/')!.nodes[home.rootIds[0]] as InstanceNode;
    expect(hero.props).toMatchObject({ heading: 'New headline', primaryLink: { type: 'page', target: 'pg_gone' }, image: { assetId: 'a_gone', alt: 'Kitchen', decorative: true } });
    expect(lastResult(adapter.requests[2]).fields?.map((f: { field: string }) => f.field)).toEqual(['props.image']);
  });

  it('checks a page-list card sent with a route against the card the write merges it with', async () => {
    let aboutId = '';
    const { session, adapter, run } = await setup(
      [() => [call('p1', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'content.pages', props: { items: [{ pageLink: '/about/', title: 'About the studio', image: { assetId: 'a_gone', alt: 'Team' } }] } }] })], () => finish()],
      {},
      'business',
      (s) => {
        const page = s.pages[s.site.homePageId];
        aboutId = Object.values(s.pages).find((p) => p.route === '/about/')!.id;
        const { nodeId } = applyOperation(s, { type: 'node.insert', owner: { kind: 'page', id: page.id }, componentId: 'content.pages', props: { items: [{ pageLink: { type: 'page', target: aboutId }, title: '' }] } }) as { nodeId: string };
        ((page.nodes[nodeId] as InstanceNode).props.items as ListItem[])[0].image = { assetId: 'a_gone', alt: 'Team' };
      }
    );
    await run('Retitle the About card');
    expect(lastResult(adapter.requests[1]).ok).toBe(true);
    const card = (onHome(session.state, 'content.pages').props.items as ListItem[])[0];
    expect(card).toMatchObject({ title: 'About the studio', pageLink: { type: 'page', target: aboutId }, image: { assetId: 'a_gone', alt: 'Team' } });
  });

  it('sets a variant on the fork a catalogue component was matched to, by the fork’s own axes', async () => {
    const { session, adapter, run } = await setup(
      [() => [call('f1', 'upsert_page_with_sections', { slug: 'home', sections: [{ componentId: 'features.grid', variant: 'muted' }] })], () => finish()],
      {},
      'business',
      (s) => {
        const grid = onHome(s, 'features.grid');
        const { definitionId } = applyOperation(s, { type: 'component.fork', definitionId: grid.definitionId }) as { definitionId: string };
        // The fork offers "muted" as a layout rather than a tone.
        const axes = s.components[definitionId].variantAxes!;
        delete axes.tone.options.muted;
        axes.layout.options.muted = { label: 'Muted' };
      }
    );
    await run('Make the grid muted');
    expect(lastResult(adapter.requests[1]).ok).toBe(true);
    expect(onHome(session.state, 'features.grid').variants?.layout).toBe('muted');
  });

  it('offers the whole-field read for long text a placement inherits from its definition', async () => {
    const { session, adapter, run } = await setup(
      [() => finish('Read it.')],
      focused,
      'business',
      (s) => {
        const page = s.pages[s.site.homePageId];
        const { nodeId } = applyOperation(s, { type: 'node.insert', owner: { kind: 'page', id: page.id }, componentId: 'content.text' }) as { nodeId: string };
        const node = page.nodes[nodeId] as InstanceNode;
        delete node.props.body;
        (s.components[node.definitionId].properties.body as { default: unknown }).default = Array.from({ length: 20 }, (_, i) => ({ type: 'p', spans: [{ text: `Paragraph ${i} `.repeat(12) }] }));
      }
    );
    const page = pageAt(session.state, '/')!;
    const text = onHome(session.state, 'content.text');
    await run('Shorten this text', { owner: { kind: 'page', id: page.id }, instancePath: [], nodeId: text.id });
    expect(adapter.requests[0].tools.map((t) => t.name)).toContain('inspect_element');
  });

  it('reads an empty rich text as empty, never splits a character, and shows one variant pick as a variant', async () => {
    const { executeTool } = await import('@agent/tools');
    const { exampleSection } = await import('@agent/examples');
    const s = createStarterState('business', 'Test', false);
    const page = s.pages[s.site.homePageId];
    const { nodeId } = applyOperation(s, { type: 'node.insert', owner: { kind: 'page', id: page.id }, componentId: 'content.text', props: { heading: '😀a', body: '' } }) as { nodeId: string };
    const host = { state: () => s, revision: () => 1 } as unknown as Parameters<typeof executeTool>[2];
    const read = async (args: Record<string, unknown>) => (await executeTool('inspect_element', JSON.stringify({ owner: { kind: 'page', id: page.id }, nodeId, ...args }), host, 'c')).content as { text: string; start: number };
    expect((await read({ prop: 'body' })).text).toBe('');
    // An offset inside the emoji starts at the whole emoji.
    expect(await read({ prop: 'heading', offset: 1 })).toMatchObject({ start: 0, text: '😀a' });
    const ex = { id: 'x', componentId: 'stats.row', keywords: [], description: 'd', variants: { tone: 'inverse' }, props: {} };
    expect(exampleSection(ex).section).toEqual({ componentId: 'stats.row', variant: 'inverse', props: {} });
    expect(exampleSection({ ...ex, variants: { tone: 'inverse', layout: 'two-columns' } }).section).toMatchObject({ variants: { tone: 'inverse', layout: 'two-columns' } });
  });
});

describe('a selected card styles itself until the user widens the run (#132)', () => {
  // Constrained decoding is a focused run at any window; this one has room for the site tools once widened.
  const focused = { contextWindowTokens: 32000, maxOutputTokens: 2000, toolCalling: 'constrained-json' as const };
  const grid = (s: ProjectState) => pageAt(s, '/')!.nodes[pageAt(s, '/')!.rootIds[2]] as InstanceNode;

  it('styles only the selected card when no item is named, and every card once the user allows it', async () => {
    let poetry = '';
    let afterFirst: unknown;
    const { session, adapter, run, answers } = await setup(
      [
        () => [call('s1', 'style_selected_element', { scope: 'base', styles: [{ property: 'background', value: '#dbeeff' }] })],
        () => {
          afterFirst = structuredClone({ overrides: grid(session.state).overrides ?? null, items: grid(session.state).itemOverrides ?? null });
          return [call('s2', 'request_wider_scope', { question: 'Style every card?' })];
        },
        (req) => {
          // Widened, a small model keeps the style tool for the selected element, for every part of it again.
          const style = req.tools.find((t) => t.name === 'style_selected_element');
          expect((style?.parameters as { properties: { partId: { enum: string[] } } }).properties.partId.enum).toEqual(expect.arrayContaining(['root', 'card', 'heading']));
          return [call('s3', 'style_selected_element', { scope: 'base', styles: [{ property: 'radius', value: '0px' }] })];
        },
        () => finish('Styled the cards.')
      ],
      focused
    );
    answers.push('Yes, allow changes beyond the selection');
    const g = grid(session.state);
    poetry = (g.props.items as ListItem[])[1].id;
    const def = session.state.components[g.definitionId];
    const before = structuredClone(g.overrides ?? null);
    await run('Make this card pale blue, then round every card', { owner: { kind: 'page', id: pageAt(session.state, '/')!.id }, instancePath: [g.id], nodeId: def.parts.card.nodeId, partId: 'card', itemPath: [poetry] });
    expect(adapter.requests[0].tools.find((t) => t.name === 'style_selected_element')!.description).toBeDefined();
    expect(afterFirst).toEqual({ overrides: before, items: { card: { list: 'items', items: { [poetry]: { base: { background: '#dbeeff' } } } } } });
    expect(lastResult(adapter.requests[3]).ok).toBe(true);
    expect(grid(session.state).overrides?.card?.base).toMatchObject({ radius: '0px' });
  });
});

describe('rich text links read and written whole (#132)', () => {
  it('writes back a link whose address has spaces as the same link', async () => {
    const { normalizeRichText } = await import('@engine/values');
    const { richTextToMarkdown } = await import('@shared/richtext');
    const s = createStarterState('business', 'Test', false);
    const blocks = normalizeRichText([{ type: 'p', spans: [{ text: 'Call ' }, { text: 'the studio', link: { type: 'tel', target: '+1 555 0100' } }, { text: ' today.' }] }], s, 'Text');
    const text = richTextToMarkdown(blocks, s.pages);
    expect(text).toContain('<tel:+1 555 0100>');
    expect(normalizeRichText(text, s, 'Text')).toEqual(blocks);
  });
});

describe('validate_project and components that are not reusable yet (#363)', () => {
  it('lists their findings apart, capped, with the component and node, however many other warnings come first', async () => {
    const { executeTool } = await import('@agent/tools');
    const s = createStarterState('business', 'Test Studio', false);
    // Enough other warnings to fill the plain list on their own, reported before any component's.
    for (let i = 0; i < 25; i++) {
      const home = s.pages[s.site.homePageId];
      home.language = 'not a language';
      s.pages[`pg_x${i}`] = { ...structuredClone(home), id: `pg_x${i}`, route: `/x${i}/`, title: `X${i}` };
      s.site.pageOrder.push(`pg_x${i}`);
    }
    const hero = structuredClone(catalogueComponent('foundation', 'hero.centered')!);
    const def = { ...hero, id: 'proj.hero', owner: 'project' as const };
    const root = def.tree!.rootIds[0];
    for (let i = 0; i < 10; i++) {
      def.tree!.nodes[`fixed${i}`] = { id: `fixed${i}`, kind: 'text', tag: 'h2', text: `Spring offers ${i}` };
      (def.tree!.nodes[root] as { children: string[] }).children.push(`fixed${i}`);
    }
    s.components[def.id] = def;
    const diags = validateState(s);
    expect(diags.findIndex((d) => d.code === 'COMPONENT_UNBOUND_CONTENT')).toBeGreaterThan(20);
    const host = { state: () => s, revision: () => 1, diagnostics: () => diags, compileAll: async () => [] } as unknown as Parameters<typeof executeTool>[2];
    const content = (await executeTool('validate_project', '{}', host, 'v1')).content as { warnings: string[]; componentWarnings?: Array<{ code: string; definitionId: string; nodeId?: string }>; omittedComponentWarnings?: number };
    expect(content.warnings).toHaveLength(20);
    expect(content.warnings.some((w) => w.includes('Spring offers'))).toBe(false);
    expect(content.componentWarnings).toHaveLength(8);
    expect(content.componentWarnings![0]).toEqual(expect.objectContaining({ code: 'COMPONENT_UNBOUND_CONTENT', definitionId: 'proj.hero', nodeId: 'fixed0' }));
    expect(content.omittedComponentWarnings).toBe(2);
  });
});

describe('a run limited to one page (#513)', () => {
  const names = (t: ToolDefinition[]) => t.map((x) => x.name);

  it("offers the page tool for that page, without the site's brand, code edits or wider operations", () => {
    const state = createStarterState('business', 'Test', false);
    const base = { state, selection: null, codeEnabled: true, definitionOps: false, page: { route: '/about/' } };
    const cloud = toolsForRun({ ...base, capabilities: { toolCalling: 'native', contextWindowTokens: 400000 } });
    expect(cloud.mode).toBe('page');
    expect(names(cloud.tools)).toEqual(expect.arrayContaining(['upsert_page_with_sections', 'apply_operations', 'read_page', 'inspect_layout', 'request_clarification']));
    expect(names(cloud.tools)).not.toEqual(expect.arrayContaining(['update_site_brand']));
    expect(names(cloud.tools)).not.toContain('apply_source_patch');
    // Operations for the page's sections and its own settings only, and the settings without a new route or translation.
    const offered = (tools: ToolDefinition[]) => {
      const params = tools.find((t) => t.name === 'apply_operations')!.parameters as { properties: { operations: { items: { oneOf?: JsonSchemaLike[]; anyOf?: JsonSchemaLike[] } } } };
      const items = params.properties.operations.items;
      return (items.oneOf ?? items.anyOf ?? []).map((o) => o.properties as Record<string, JsonSchemaLike>);
    };
    const types = (tools: ToolDefinition[]) => offered(tools).map((o) => (o.type as { const: string }).const).sort();
    // Nothing beyond the page's own (the editor's clipboard, UI state and bindings are never offered here).
    expect(types(cloud.tools).filter((t) => !PAGE_OPERATIONS.has(t as never))).toEqual([]);
    for (const t of ['page.create', 'page.remove', 'page.reorder', 'page.setHome', 'page.duplicate', 'token.set', 'site.update', 'theme.apply', 'asset.update', 'component.makeUnique', 'component.convertToCode', 'component.createFromNode', 'component.setPropSchema', 'node.paste'])
      expect(PAGE_OPERATIONS.has(t as never), t).toBe(false);
    for (const t of ['node.insert', 'node.move', 'node.remove', 'node.copy', 'node.setStyle', 'instance.setProp', 'instance.listInsert', 'page.update', 'component.detachInstance']) expect(types(cloud.tools), t).toContain(t);
    const pageUpdate = offered(cloud.tools).find((o) => (o.type as { const: string }).const === 'page.update')!;
    expect(Object.keys(pageUpdate)).toEqual(expect.arrayContaining(['title', 'navLabel', 'description', 'showHeader', 'showFooter', 'draft']));
    expect(Object.keys(pageUpdate)).not.toContain('route');
    expect(Object.keys(pageUpdate)).not.toContain('linkTranslationTo');
    // The page tool names the page it may build, and cannot join it to a translation.
    const upsert = cloud.tools.find((t) => t.name === 'upsert_page_with_sections')!.parameters as { properties: Record<string, { description?: string }> };
    expect(upsert.properties.slug.description).toBe('This request may build only the page at /about/: use "/about/".');
    expect(upsert.properties).not.toHaveProperty('translationOf');
    // A small model gets the page tool, its reads, and the few operations that address one section by its ID.
    const local = toolsForRun({ ...base, capabilities: { toolCalling: 'constrained-json', contextWindowTokens: 8000 } });
    expect([local.mode, local.focused]).toEqual(['page', true]);
    expect(names(local.tools)).toEqual(expect.arrayContaining(['upsert_page_with_sections', 'apply_operations', 'read_page']));
    expect(names(local.tools)).not.toContain('update_site_brand');
    expect(types(local.tools)).toEqual(['node.move', 'node.remove', 'page.update']);
    expect([...FOCUSED_PAGE_OPERATIONS].sort()).toEqual(['node.move', 'node.remove', 'page.update']);
    expect(Object.keys(offered(local.tools).find((o) => (o.type as { const: string }).const === 'page.update')!)).not.toContain('route');
    // Once widened, the run is a site run again.
    expect(toolsForRun({ ...base, page: null, definitionOps: true, capabilities: { toolCalling: 'native', contextWindowTokens: 400000 } }).mode).toBe('site');
  });

  it('adds the menu link it asked for, and refuses the same link sent as a raw operation', async () => {
    const team = 'pg_team0001';
    const rawLink = (shell: 'header' | 'footer') => ({ type: 'instance.listInsert', owner: { kind: 'shell', id: shell }, nodeId: session.state.site.shell[shell].rootIds[0], prop: 'links', item: { label: 'Team', link: { type: 'page', target: team } } });
    const { session, adapter, run } = await setup(
      [
        // The header link the page tool would add, sent by hand.
        () => [call('t0', 'apply_operations', { expectedRevision: session.revision, operations: [rawLink('header')] })],
        (req) => {
          expect(JSON.stringify(req.items.at(-1))).toMatch(/SCOPE_MISMATCH.*instance\.listInsert changes something outside the Team page/);
          return [call('t1', 'upsert_page_with_sections', { slug: '/team/', addToHeaderNav: true, sections: [{ componentId: 'intro.page', props: { heading: 'Our team' } }] })];
        },
        (req) => {
          expect(lastResult(req)).toMatchObject({ ok: true, navigation: { header: 'added' } });
          return [call('t2', 'apply_operations', { expectedRevision: session.revision, operations: [rawLink('footer')] })];
        },
        () => finish()
      ],
      {},
      'business',
      (s) => applyOperation(s, { type: 'page.create', pageId: team, title: 'Team', route: '/team/' })
    );
    const links = (shell: 'header' | 'footer') => ((session.state.site.shell[shell].nodes[session.state.site.shell[shell].rootIds[0]] as InstanceNode).props.links as ListItem[] | undefined) ?? [];
    const toTeam = (items: ListItem[]) => items.some((i) => (i.link as LinkValue | undefined)?.target === team);
    expect(toTeam(links('header'))).toBe(false);
    const { result } = await run('Build this page and add it to the menu', null, { pageId: team, pageTitle: 'Team', scope: 'page' });
    expect(result?.status).toBe('completed');
    expect(toTeam(links('header'))).toBe(true);
    expect(toTeam(links('footer'))).toBe(false);
    expect(JSON.stringify(adapter.requests[3].items.at(-1))).toMatch(/SCOPE_MISMATCH.*instance\.listInsert changes something outside the Team page/);
  });

  /** A project session's apply, for one authority, without the rest of a run. */
  const hostFor = (start: ProjectState, authority: Extract<Authority, { kind: 'page' }> | { kind: 'site' }) => {
    let state = start;
    let revision = 0;
    const applied: EditOperation[][] = [];
    const host: ToolHost = {
      state: () => state,
      revision: () => revision,
      diagnostics: () => [],
      apply: async (ops, _rev, _label, _key, grants) => {
        const denied = checkAuthority(state, ops, authority, grants);
        if (denied) return { ok: false, revision, error: { code: 'SCOPE_MISMATCH', message: denied } };
        const r = applyOperations(state, ops);
        state = r.state;
        applied.push(ops);
        return { ok: true, revision: ++revision, results: r.results };
      },
      compileAll: async () => [],
      inspectLayout: async () => ({}),
      ask: async () => '',
      pageLimit: () => (authority.kind === 'page' ? { pageId: authority.pageId, label: authority.label } : null)
    };
    return { host, state: () => state, applied };
  };

  it('leaves a link waiting on another page for a run that may change that page', async () => {
    let state = createStarterState('business', 'Test', false);
    state = applyOperations(state, [{ type: 'page.create', pageId: 'pg_services1', title: 'Services', route: '/services/' }]).state;
    const about = pageAt(state, '/about/')!;
    const banner = about.rootIds.at(-1)!;
    state = applyOperations(state, [{ type: 'instance.setProp', owner: { kind: 'page', id: about.id }, nodeId: banner, prop: 'primaryLink', value: { type: 'none', target: '' } }]).state;
    const memory = newMacroMemory();
    // From an earlier request that reached the whole site: About's button waits for /services/.
    memory.pendingLinks.push({ route: '/services/', pageId: about.id, nodeId: banner, prop: 'primaryLink' });
    const { host, state: now } = hostFor(state, { kind: 'page', pageId: 'pg_services1', label: 'the Services page' });
    const out = await runUpsert({ slug: 'services', sections: [{ componentId: 'intro.page', props: { heading: 'Services' } }] }, host, 'c1', memory);
    expect(out.ok).toBe(true);
    expect((now().pages[about.id].nodes[banner] as InstanceNode).props.primaryLink).toEqual({ type: 'none', target: '' });
    expect(memory.pendingLinks).toEqual([{ route: '/services/', pageId: about.id, nodeId: banner, prop: 'primaryLink' }]);
    // Never another page, nor a new one: refused before anything is compiled or kept for a repair.
    const other = await runUpsert({ slug: '/pricing/', sections: [{ componentId: 'intro.page' }] }, host, 'c2', memory);
    expect(other.content).toMatchObject({ error: { code: 'SCOPE_MISMATCH', message: expect.stringMatching(/limited to the Services page \(\/services\/\).*not \/pricing\//) } });
    expect(memory.drafts.size).toBe(0);
    expect(pageAt(now(), '/pricing/')).toBeUndefined();
  });

  it('leaves a link waiting on another page at the finish too, without calling its page missing', async () => {
    let state = createStarterState('business', 'Test', false);
    state = applyOperations(state, [{ type: 'page.create', pageId: 'pg_services1', title: 'Services', route: '/services/' }]).state;
    const about = pageAt(state, '/about/')!;
    const services = pageAt(state, '/services/')!;
    const aboutBanner = about.rootIds.at(-1)!;
    state = applyOperations(state, [
      { type: 'instance.setProp', owner: { kind: 'page', id: about.id }, nodeId: aboutBanner, prop: 'primaryLink', value: { type: 'none', target: '' } },
      { type: 'node.insert', owner: { kind: 'page', id: services.id }, newNodeId: 'n_cta00001', componentId: 'cta.banner', props: { primaryLink: { type: 'none', target: '' } } }
    ]).state;
    const memory = newMacroMemory();
    // Carried from an earlier request: About's button and the Services banner both wait for /contact/, which exists.
    memory.pendingLinks.push({ route: '/contact/', pageId: about.id, nodeId: aboutBanner, prop: 'primaryLink' }, { route: '/contact/', pageId: services.id, nodeId: 'n_cta00001', prop: 'primaryLink' });
    const { host, state: now } = hostFor(state, { kind: 'page', pageId: services.id, label: 'the Services page' });
    const done = await connectPendingLinks(host, memory, 'k1');
    const contact = pageAt(state, '/contact/')!.id;
    // The link on the page is connected; the one on About keeps waiting, and /contact/ is not missing.
    expect((now().pages[services.id].nodes['n_cta00001'] as InstanceNode).props.primaryLink).toEqual({ type: 'page', target: contact });
    expect((now().pages[about.id].nodes[aboutBanner] as InstanceNode).props.primaryLink).toEqual({ type: 'none', target: '' });
    expect(done.missing).toEqual([]);
    expect(done.deferred).toEqual(['/contact/']);
    expect(memory.pendingLinks).toEqual([{ route: '/contact/', pageId: about.id, nodeId: aboutBanner, prop: 'primaryLink' }]);
  });
});
