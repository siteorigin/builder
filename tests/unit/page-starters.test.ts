// Page starters (#512): Add page offers a blank page, a page introduction, brochure pages (Services, About, Contact,
// Pricing, FAQ) and a dated article, each assembled from the sections the active theme has, in one undo step.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, PageDoc, ProjectState } from '@shared/types';
import type { AuthoredPack, ThemePack } from '@catalogue/pack';
import { P, createPack } from '@catalogue/dsl';
import { catalogueComponent, getTheme, listThemes, registerPacks } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { pageStarterComponents, type PageStarter } from '@engine/page-starters';
import { validateState } from '@engine/validate';
import { toRichText } from '@shared/richtext';
import { validateOperation } from '@shared/ops';
import { SAMPLE_CONTACT } from '@shared/sample-contact';
import { toolDefinitions } from '@agent/tools';
import { buildPack } from '../../src/main/packs/build';
import { metaOf, restorePacks } from './fixtures/packs';
import { ProjectSession } from '../../src/main/project/session';
import { titleOnlyPage } from '../../src/renderer/src/lib/page-start';

const blank = () => createStarterState('blank', 'Starter Studio', false);
const created = (s: ProjectState, starter: PageStarter | undefined, title = 'Our work') => {
  const r = applyOperations(s, [{ type: 'page.create', title, ...(starter ? { starter } : {}) }]);
  const page = r.state.pages[r.results[0].pageId as string];
  return { state: r.state, page };
};
const sections = (s: ProjectState, page: PageDoc) => page.rootIds.map((id) => page.nodes[id] as InstanceNode);
const componentIds = (s: ProjectState, page: PageDoc) => sections(s, page).map((n) => s.components[n.definitionId].componentId);
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');

describe('page.create starters', () => {
  it('makes a blank page, with or without naming the starter, and installs nothing', () => {
    const s = blank();
    for (const starter of ['empty', undefined] as const) {
      const { state, page } = created(s, starter);
      expect(page.rootIds).toEqual([]);
      expect(page.nodes).toEqual({});
      expect(Object.keys(state.components).sort()).toEqual(Object.keys(s.components).sort());
      expect(errors(state)).toEqual([]);
    }
  });

  it('keeps the page introduction showing the page title', () => {
    const { state, page } = created(blank(), 'intro', '  Visit us ');
    expect(componentIds(state, page)).toEqual(['intro.page']);
    expect(sections(state, page)[0].props).toMatchObject({ eyebrow: '', heading: 'Visit us', lead: '' });
  });

  it('builds each brochure starter in order, from the theme’s own sections', () => {
    const expected: Record<string, string[]> = {
      services: ['intro.page', 'features.grid', 'content.text'],
      about: ['intro.page', 'content.media', 'team.grid'],
      contact: ['intro.page', 'contact.details', 'contact.form'],
      pricing: ['intro.page', 'pricing.plans', 'faq.list'],
      faq: ['intro.page', 'faq.list']
    };
    for (const [starter, ids] of Object.entries(expected)) {
      expect(validateOperation({ type: 'page.create', title: 'Page', starter }).ok).toBe(true);
      const { state, page } = created(blank(), starter as PageStarter, 'Page');
      expect(componentIds(state, page), starter).toEqual(ids);
      expect(sections(state, page)[0].props.heading, starter).toBe('Page');
      expect(pageStarterComponents(blank(), starter as PageStarter)).toEqual(ids);
      expect(errors(state), starter).toEqual([]);
    }
  });

  it('fits each section to the page: alternating tones, no repeated eyebrows, the theme’s sample content', () => {
    const contact = created(blank(), 'contact', 'Contact');
    const [, details, form] = sections(contact.state, contact.page);
    expect([details.variants?.tone, form.variants?.tone]).toEqual([undefined, 'muted']);
    expect([details.props.eyebrow, form.props.eyebrow]).toEqual(['', '']);
    // The contact rows are the theme's samples, which the export reviews before the website goes out.
    const rows = details.props.items as Array<{ label: string; value: string; link: { type: string; target: string } }>;
    expect(rows.map((i) => i.label)).toEqual(['Email', 'Phone', 'Studio', 'Hours']);
    expect([rows[0].value, rows[0].link]).toEqual([SAMPLE_CONTACT.email, { type: 'email', target: SAMPLE_CONTACT.email }]);
    expect([form.props.endpoint, form.props.accessKey]).toEqual(['', '']);
    const about = created(blank(), 'about', 'About');
    const story = sections(about.state, about.page)[1];
    expect(story.variants).toEqual({ layout: 'media-end' });
    expect(story.props).toMatchObject({ eyebrow: 'Our story', actionLabel: '' });
    const pricing = created(blank(), 'pricing', 'Pricing');
    expect(sections(pricing.state, pricing.page)[2].props).toMatchObject({ eyebrow: '', heading: 'Questions about pricing' });
  });

  it('gives two placements of the same starter list items of their own', () => {
    const one = created(blank(), 'services', 'Design');
    const two = created(one.state, 'services', 'Build');
    const ids = (p: PageDoc) => (sections(two.state, p)[1].props.items as Array<{ id: string }>).map((i) => i.id);
    const first = ids(two.state.pages[one.page.id]);
    const second = ids(two.page);
    // Each has every one of the theme's default items, under IDs of its own.
    const defaults = (catalogueComponent('foundation', 'features.grid')!.properties.items.default as unknown[]).length;
    expect(defaults).toBeGreaterThan(1);
    expect([first.length, second.length]).toEqual([defaults, defaults]);
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
  });

  it('keeps the dated article as it was: a header and a text body ready to write', () => {
    const { state, page } = created(blank(), 'article', 'Opening day');
    expect(componentIds(state, page)).toEqual(['content.article', 'content.text']);
    const [header, body] = sections(state, page);
    expect(header.props.eyebrow).toBe('');
    expect(body.props).toMatchObject({ heading: '', body: toRichText(['Write the article here.']) });
    expect(page.article?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses a starter it does not know', () => {
    expect(validateOperation({ type: 'page.create', title: 'Page', starter: 'gallery' }).ok).toBe(false);
  });

  it('offers the AI only the starters it fills in itself, never a page of sample text', () => {
    const find = (v: unknown): Record<string, unknown> | undefined => {
      if (!v || typeof v !== 'object') return undefined;
      const o = v as Record<string, unknown>;
      if ((o.properties as Record<string, { const?: unknown }> | undefined)?.type?.const === 'page.create') return o;
      for (const x of Object.values(o)) {
        const hit = find(x);
        if (hit) return hit;
      }
      return undefined;
    };
    const create = find(toolDefinitions().find((t) => t.name === 'apply_operations')!.parameters)!;
    expect((create.properties as Record<string, { enum?: string[] }>).starter.enum).toEqual(['empty', 'intro', 'article']);
  });
});

describe('a page with only its title', () => {
  it('is one the starter made, until the author changes its introduction or adds to the page', () => {
    const { state, page } = created(blank(), 'intro', 'Our ovens');
    expect(titleOnlyPage(state, page)).toBe(true);
    const intro = sections(state, page)[0];
    const owner = { kind: 'page' as const, id: page.id };
    for (const [prop, value] of [['lead', 'Wood-fired since 1998.'], ['eyebrow', 'Bakery'], ['heading', 'Ovens']]) {
      const s = applyOperations(state, [{ type: 'instance.setProp', owner, nodeId: intro.id, prop, value }]).state;
      expect(titleOnlyPage(s, s.pages[page.id]), prop).toBe(false);
    }
    const more = applyOperations(state, [{ type: 'node.insert', owner, componentId: 'faq.list' }]).state;
    expect(titleOnlyPage(more, more.pages[page.id])).toBe(false);
    const services = created(blank(), 'services', 'Our ovens');
    expect(titleOnlyPage(services.state, services.page)).toBe(false);
    const empty = created(blank(), 'empty', 'Our ovens');
    expect(titleOnlyPage(empty.state, empty.page)).toBe(false);
  });
});

describe('a theme without some of a starter’s sections', () => {
  afterEach(() => restorePacks());

  /** Foundation, installed as "lean", without the components named, and with a form that sends to its author. */
  function lean(without: string[], fixedEndpoint = false): ThemePack {
    const foundation = getTheme('foundation');
    const components = foundation.components;
    const author = createPack(metaOf(foundation, { id: 'lean', name: 'Lean', version: '1.0.0', license: 'MIT', devOnly: undefined }));
    const adopt = (c: (typeof components)[number]) => {
      if (c.componentId !== 'contact.form') return author.adopt(c);
      const form = structuredClone(c);
      (form.properties.endpoint as { default: unknown }).default = 'https://formspree.io/f/theirs';
      (form.properties.accessKey as { default: unknown }).default = 'their-key';
      // A destination the author can only choose among the theme's own.
      if (fixedEndpoint) form.properties.endpoint = P.choice('Form endpoint URL', 'https://formspree.io/f/theirs', [['https://formspree.io/f/theirs', 'Theirs']]);
      return author.adopt(form);
    };
    const pack: AuthoredPack = author.define(components.filter((c) => !without.includes(c.componentId)).map(adopt));
    const built: ThemePack = { ...buildPack(pack).pack, source: 'user', digest: 'lean1' };
    registerPacks([...listThemes(), built]);
    return built;
  }

  it('leaves out what the theme lacks, places the rest from the active theme, and still makes the page', () => {
    lean(['intro.page', 'contact.form', 'faq.list']);
    const s = applyOperations(blank(), [{ type: 'theme.apply', themeId: 'lean' }]).state;
    const contact = created(s, 'contact', 'Contact');
    expect(componentIds(contact.state, contact.page)).toEqual(['contact.details']);
    expect(contact.state.components[sections(contact.state, contact.page)[0].definitionId].id).toBe('lean.contact.details');
    expect(pageStarterComponents(s, 'contact')).toEqual(['contact.details']);
    // Every section of a starter missing: a blank page, not a refused one.
    const faq = created(s, 'faq', 'Questions');
    expect(faq.page.rootIds).toEqual([]);
    const intro = created(s, 'intro', 'Hello');
    expect(intro.page.rootIds).toEqual([]);
    expect(errors(faq.state)).toEqual([]);
  });

  it('never connects a Contact page’s form to the theme’s own form service', () => {
    lean([]);
    const s = applyOperations(blank(), [{ type: 'theme.apply', themeId: 'lean' }]).state;
    expect(created(s, 'empty').state.components['lean.contact.form']).toBeUndefined();
    const contact = created(s, 'contact', 'Contact');
    const form = sections(contact.state, contact.page)[2];
    expect(contact.state.components[form.definitionId].properties.endpoint.default).toBe('https://formspree.io/f/theirs');
    expect([form.props.endpoint, form.props.accessKey]).toEqual(['', '']);
  });

  it('clears the destination of the form the project already has, even where the theme’s newer form has none', () => {
    lean([]);
    const s = applyOperations(blank(), [{ type: 'theme.apply', themeId: 'lean' }]).state;
    // An older copy of the theme's form, installed before: it still sends to the theme author.
    const theme = catalogueComponent('lean', 'contact.form')!;
    const older = structuredClone(theme);
    delete (theme.properties as Record<string, unknown>).endpoint;
    s.components[older.id] = older;
    const contact = created(s, 'contact', 'Contact');
    const form = sections(contact.state, contact.page)[2];
    expect(contact.state.components[form.definitionId].properties.endpoint.default).toBe('https://formspree.io/f/theirs');
    expect(form.props.endpoint).toBe('');
  });

  it('leaves the form out when its destination cannot be cleared', () => {
    lean([], true);
    const s = applyOperations(blank(), [{ type: 'theme.apply', themeId: 'lean' }]).state;
    const contact = created(s, 'contact', 'Contact');
    expect(componentIds(contact.state, contact.page)).toEqual(['intro.page', 'contact.details']);
    expect(pageStarterComponents(s, 'contact')).toEqual(['intro.page', 'contact.details']);
    expect(contact.state.components['lean.contact.form']).toBeUndefined();
    expect(errors(contact.state)).toEqual([]);
  });
});

describe('a starter in a saved project', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  for (const starter of ['services', 'contact'] as const) {
    it(`adds the whole ${starter} page, with its menu link, in one undo step`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'so-page-starter-'));
      dirs.push(dir);
      const s = await ProjectSession.create(dir, blank());
      const before = structuredClone(s.state);
      const r = await s.apply({ operations: [{ type: 'page.create', title: 'Our page', starter, addToNavigation: true }] }, { label: 'Add page Our page' });
      const pageId = r.results![0].pageId as string;
      const after = structuredClone(s.state);
      expect(after.pages[pageId].rootIds.length).toBeGreaterThan(1);
      const header = after.site.shell.header;
      const links = (header.nodes[header.rootIds[0]] as InstanceNode).props.links as Array<{ label: string; link: { target: string } }>;
      expect(links.at(-1)).toMatchObject({ label: 'Our page', link: { type: 'page', target: pageId } });
      expect(Object.keys(after.components).length).toBeGreaterThan(Object.keys(before.components).length);
      expect(s.historyInfo().undoLabel).toBe('Add page Our page');
      await s.undo();
      expect(s.state.pages).toEqual(before.pages);
      expect(s.state.site).toEqual(before.site);
      expect(s.state.components).toEqual(before.components);
      expect(s.state.themeLock).toEqual(before.themeLock);
      expect(s.historyInfo().canUndo).toBe(false);
      await s.redo();
      expect(s.state.pages).toEqual(after.pages);
      expect(s.state.site).toEqual(after.site);
      await s.close();
    });
  }
});

describe('page starters and project health (#873)', () => {
  const STARTERS: PageStarter[] = ['intro', 'services', 'about', 'contact', 'pricing', 'faq', 'article'];
  // The Contact starter's form is left unconnected on purpose until the author adds a form service (see its section).
  const counted = (s: ProjectState) => validateState(s).filter((d) => d.severity !== 'info' && d.code !== 'FORM_UNCONNECTED');
  const codes = (s: ProjectState) => counted(s).map((d) => d.code).sort();

  for (const project of ['business', 'blank'] as const) {
    it(`adds no warnings of its own to a ${project} project, in any theme`, async () => {
      for (const themeId of (await restorePacks()).map((p) => p.id)) {
        const base = applyOperations(createStarterState(project, 'Starter Studio', false), [{ type: 'theme.apply', themeId }]).state;
        const before = codes(base);
        for (const starter of STARTERS) {
          const { state, page } = created(base, starter);
          const added = counted(state).filter((d) => d.owner?.kind === 'page' && d.owner.id === page.id);
          expect(added.map((d) => d.message), `${themeId} / ${starter}`).toEqual([]);
          expect(codes(state), `${themeId} / ${starter}`).toEqual(before);
        }
      }
    });
  }
});
