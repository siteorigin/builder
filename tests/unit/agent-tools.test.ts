import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { ElementRef, InstanceNode, LinkValue, ListItem, ProjectState, PropSchema } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent, listThemes } from '@catalogue/index';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalItem, CanonicalModelRequest, ModelCapabilities, ModelEvent, ToolDefinition } from '@agent/types';
import { toolsForRun } from '@agent/tools';
import { withStoredFields } from '@agent/macros';
import { hasOpenSchema, propsJsonSchema } from '@agent/propschema';
import { findForbiddenShapes, toStrictSchema } from '@agent/strict-schema';
import { selectionTools } from '@agent/selection';
import { applyContextBudget, estimateRequestTokens } from '@agent/budget';
import { findStubPages } from '@agent/completeness';
import { checkExample, retrieveExamples } from '@agent/examples';
import { contrastRatio, derivedBrandTokens } from '@agent/brand';
import { ProjectSession } from '../../src/main/project/session';
import { validateState } from '@engine/validate';
import { compileProject } from '../../src/main/compile';

type Turn = (req: CanonicalModelRequest) => ModelEvent[];

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
  const answers: string[] = [];
  const run = async (text: string, selection: ElementRef | null = null) => {
    const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection, selectionLabel: selection ? 'the selection' : null, viewport: 1280 };
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
    const { adapter, run } = await setup([() => finish('Try: Talk to us, whenever suits you.')], { contextWindowTokens: 8000, maxOutputTokens: 2000, toolCalling: 'constrained-json' });
    const { result } = await run('Interview me about the Contact page, then suggest a headline in chat only');
    expect(result?.status).toBe('no-changes');
    const { system, tools } = adapter.requests[0];
    expect(tools.map((t) => t.name)).toContain('request_clarification');
    expect(system).toMatch(/request_clarification asks the user one question[^\n]*interview them[^\n]*one question per call/);
    expect(system).toContain('when the user asked only for advice or ideas, with that advice');
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

  it('chooses tools by task: small sets for local models, the general tools kept for cloud models', () => {
    const state = createStarterState('business', 'Test', false);
    const names = (t: ToolDefinition[]) => t.map((x) => x.name);
    const target = { owner: { kind: 'page' as const, id: state.site.homePageId }, nodeId: pageAt(state, '/')!.rootIds[2] };
    const base = { state, codeEnabled: true, definitionOps: true };
    const local = { toolCalling: 'constrained-json' as const, contextWindowTokens: 16000 };
    const cloud = { toolCalling: 'native' as const, contextWindowTokens: 400000 };
    expect(names(toolsForRun({ ...base, selection: target, capabilities: local }).tools)).toEqual(['update_selected_props', 'edit_selected_list', 'style_selected_element', 'request_wider_scope']);
    const cloudTools = names(toolsForRun({ ...base, selection: target, capabilities: cloud }).tools);
    expect(cloudTools).toEqual(expect.arrayContaining(['update_selected_props', 'apply_operations']));
    const localSite = names(toolsForRun({ ...base, selection: null, capabilities: local }).tools);
    expect(localSite).toEqual(expect.arrayContaining(['upsert_page_with_sections', 'update_site_brand', 'read_page']));
    expect(localSite).not.toContain('apply_operations');
    expect(names(toolsForRun({ ...base, selection: null, capabilities: cloud }).tools)).toEqual(expect.arrayContaining(['upsert_page_with_sections', 'apply_operations']));
    // A definition's own tree is not something the small tools can edit.
    const def = Object.values(state.components).find((d) => d.tree)!;
    const inDef = toolsForRun({ ...base, selection: { owner: { kind: 'component', id: def.id }, nodeId: def.tree!.rootIds[0] }, capabilities: local });
    expect(inDef.mode).toBe('general');
    expect(names(inDef.tools)).toContain('apply_operations');
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
    // The hero has an image, so it can also look up assets; it has no list.
    expect(adapter.requests[0].tools.map((t) => t.name)).toEqual(['update_selected_props', 'style_selected_element', 'request_wider_scope', 'search_assets']);
  });

  it('edits list items one at a time', async () => {
    let added = '';
    const { session, run } = await setup(
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
  });

  it('styles one part at one screen size', async () => {
    const { session, run } = await setup([() => [call('s1', 'style_selected_element', { partId: 'root', scope: 'phone', styles: [{ property: 'paddingBlock', value: { token: 'space.lg' } }] })], () => finish()], focused);
    await run('Less padding on mobile', heroRef(session.state));
    expect(nodeAt(session.state, 0).overrides?.root?.phone?.paddingBlock).toEqual({ token: 'space.lg' });
    expect(nodeAt(session.state, 0).overrides?.root?.base).toBeUndefined();
  });

  it('edits a plain text element through the same tool', async () => {
    const { session, run } = await setup([() => [call('t1', 'update_selected_props', { props: { text: 'Hello there' } })], () => finish()], focused, 'blank');
    const home = pageAt(session.state, '/')!;
    const textId = Object.values(home.nodes).find((n) => n.kind === 'text')!.id;
    await run('Change this', { owner: { kind: 'page', id: home.id }, instancePath: [], nodeId: textId });
    expect((pageAt(session.state, '/')!.nodes[textId] as { text: string }).text).toBe('Hello there');
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
      focused
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
